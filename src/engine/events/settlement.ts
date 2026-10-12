import type { SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { privateProgramResources } from "../programs/private-resources";
import { contentHash } from "../models/model-audit";
import type { JsonObject } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { applyEventBeliefs, type BeliefRevision } from "./cognition";
import { applyProgramGoalEvidence } from "./goal-completion";
import { commitWorldEvent, type WorldEventCandidate } from "./kernel";
import { projectEventPerception } from "./perception";
import { nextWorldClockBoundary } from "./clock-boundary";
import { programWorldResources } from "./resources";
import { EventScheduler } from "./scheduler";
import { programReceiptIndex, readDecisionEventState, restoreOwnerPrograms, sealDecisionEventState, type DecisionEventState } from "./runtime-state";
import { settleProgramActivities } from "./activities";

/** One deterministic implementation is shared by speculative preparation, canonical commit and replay. */
export function settleProgramWorldEvent(source: Readonly<SimulationState>, prepared: DecisionEventState,
  event: WorldEventCandidate, definition: WorldRuntimeContract, producerHash: string, beliefs: BeliefRevision[] = []) {
  const physicalSource = structuredClone(source) as SimulationState;
  physicalSource.executionState = { producerHash, data: structuredClone(prepared) as unknown as JsonObject };
  readDecisionEventState(physicalSource.executionState, physicalSource);
  const scheduler = new EventScheduler(source.truth.elapsedSeconds, prepared.scheduler);
  const dueAttempts = prepared.pending.filter(pending => pending.atSeconds === event.atSeconds && pending.bound && !pending.failure)
    .map(pending => pending.bound!).sort((a, b) => a.attempt.id.localeCompare(b.attempt.id));
  if (contentHash(dueAttempts) !== contentHash(event.programs.slice().sort((a, b) => a.attempt.id.localeCompare(b.attempt.id)))) {
    throw new Error("world event differs from the persisted pending frontier");
  }
  const boundaries = [scheduler.nextTime, nextWorldClockBoundary(physicalSource)].filter((value): value is number => value !== null);
  if (!boundaries.length) throw new Error("world event has no persisted execution boundary");
  const committed = commitWorldEvent(physicalSource, definition, prepared.worldResources, event, {
    earliestPendingSeconds: Math.min(...boundaries), receipts: new Map(prepared.receipts.map(receipt => [receipt.candidateId, receipt])),
  });
  if (committed.replayed) throw new Error("a completed event cannot create another canonical revision");
  const perception = projectEventPerception(committed.state, event, committed.receipt), state = committed.state;
  state.agents = perception.agents;
  const goals = applyProgramGoalEvidence(state, prepared, source.revision);
  if (new Set(beliefs.map(revision => revision.agentId)).size !== beliefs.length) throw new Error("duplicate Agent belief revision");
  for (const revision of beliefs) {
    const delivered = perception.beliefPatches.find(patch => patch.agentId === revision.agentId)?.operations
      .flatMap(operation => operation.kind === "upsert_evidence" ? [operation.evidence.id] : []) ?? [];
    if (contentHash(delivered.slice().sort()) !== contentHash(revision.evidenceIds.slice().sort())) throw new Error("belief revision does not bind this Agent's actual deliveries");
    state.agents[revision.agentId] = applyEventBeliefs(state, revision, prepared.agents[revision.agentId]?.resources);
  }
  const control = structuredClone(prepared);
  control.activities = settleProgramActivities(control.activities, event.programs.map(bound => bound.attempt.id), [], event.atSeconds);
  control.receipts.push(committed.receipt);
  const canonicalReceipts = programReceiptIndex(control);
  const due = scheduler.nextTime === event.atSeconds ? scheduler.frontier() : [];
  if (due.length) scheduler.acknowledge(due.map(value => value.id), event.atSeconds);
  else scheduler.advanceBoundary(event.atSeconds);
  const completed = new Set(event.programs.map(bound => bound.attempt.id));
  const retired = new Set(Object.keys(control.agents).filter(id => !state.agents[id]));
  control.pending = control.pending.filter(pending => !completed.has(pending.attempt.id) && !retired.has(pending.attempt.actorId));
  const pendingIds = new Set(control.pending.map(pending => pending.attempt.id));
  for (const queued of scheduler.snapshot().pending) if (queued.kind === "world" &&
    !pendingIds.has((queued.payload as { attemptId: string }).attemptId)) scheduler.cancel(queued.id);
  for (const ownerId of retired) scheduler.unsubscribe(ownerId);
  for (const agent of Object.values(state.agents)) {
    const owner = control.agents[agent.id]; if (!owner) continue;
    owner.resources = privateProgramResources(projectAgentPerspective(state, agent), owner.resources);
    const programs = restoreOwnerPrograms(control, agent.id);
    for (const receipt of committed.receipt.programReceipts) {
      const program = programs.find(value => value.instanceId === receipt.instanceId); if (!program) continue;
      program.settle(receipt.id, canonicalReceipts, owner.resources.resources);
      scheduler.receipt(agent.id, receipt.workId, receipt.id);
    }
    for (const program of programs) owner.instances.find(entry => entry.snapshot.instanceId === program.instanceId)!.snapshot = program.snapshot();
    scheduler.notify(agent.id, owner.resources.resources);
  }
  for (const agentId of [...new Set([...event.clockBoundary.timers.flatMap(timer => timer.wakeAgentIds),
    ...event.clockBoundary.programDeadlines.map(deadline => deadline.agentId)])].sort()) {
    if (state.agents[agentId]) scheduler.schedule({ atSeconds: event.atSeconds, subjectId: agentId, kind: "control",
      inputHash: contentHash({ eventId: event.id, agentId }), payload: { reason: "deadline" } });
  }
  for (const agentId of [...new Set(perception.observations.map(packet => packet.observerId))].sort()) {
    scheduler.schedule({ atSeconds: event.atSeconds, subjectId: agentId, kind: "observation",
      inputHash: contentHash(perception.observations.filter(packet => packet.observerId === agentId)),
      payload: { observationIds: perception.observations.filter(packet => packet.observerId === agentId).map(packet => packet.id) } });
  }
  control.worldResources = programWorldResources(state, definition, control.activities, committed.resources); control.scheduler = scheduler.snapshot();
  const sealed = sealDecisionEventState(control);
  state.executionState = { producerHash, data: sealed as unknown as JsonObject };
  return { state, control: sealed, receipt: committed.receipt, observations: perception.observations,
    perceptionBeliefPatches: perception.beliefPatches,
    beliefPatches: [...perception.beliefPatches, ...beliefs.map(revision => revision.patch), ...goals.beliefPatches], characterPatches: goals.characterPatches };
}
