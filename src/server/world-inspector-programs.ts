import type { CommittedStep, SimulationState } from "../engine/contracts/model";
import { programExecutionCoverage, restoreOwnerPrograms } from "../engine/events/runtime-state";
import { estimateModelCost } from "../engine/models/model-cost";
import { restoreDecisionEventStep } from "../engine/events/journal";

/** Trusted local Inspector projection; never used by public perspectives or model prompts. */
export function inspectDecisionPrograms(before: SimulationState, step: CommittedStep) {
  if (!step.decisionEvent) return undefined;
  const proof = restoreDecisionEventStep(before, step.decisionEvent);
  const control = proof.finalControl;
  const prior = before.executionState?.data.kind === "decision-event"
    ? before.executionState.data as unknown as typeof control : before.bootstrapDecisionEvent?.control;
  const acknowledged = new Set(proof.preparedControl.scheduler.completed);
  const wakes = (prior?.scheduler.pending ?? []).filter(event => acknowledged.has(event.id));
  const programs = Object.entries(control.agents).flatMap(([ownerId, owner]) => restoreOwnerPrograms(control, ownerId).map(program => ({
    ownerId, instanceId: program.instanceId, definitionHash: program.program.hash, name: program.program.definition.name,
    active: owner.activeInstanceId === program.instanceId, status: program.status, position: program.position,
    completion: program.completion, wait: program.subscriptions(owner.resources.resources, proof.event?.atSeconds ?? before.truth.elapsedSeconds),
    planning: owner.planning,
  })));
  const decisions = proof.decisions.flatMap(use => Object.entries(use.result.answers).map(([questionId, answer]) => ({
    subjectId: use.batch.view.kind === "agent" ? use.batch.view.agentId : "world", questionId,
    instructions: use.batch.questions[questionId]!.instructions, criteria: use.batch.questions[questionId]!.criteria,
    choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence,
    model: use.result.audit.modelId, reused: use.reused, fallback: use.result.fallback, evidenceHash: use.evidenceHash,
  })));
  const calls = proof.modelAudits.map(audit => ({ subjectId: audit.subjectId, role: audit.role, model: audit.modelId,
    invocations: audit.invocations.map(invocation => ({ id: invocation.id, disposition: invocation.outputDisposition,
      usage: invocation.tokenUsage, transports: invocation.transports.length, cost: estimateModelCost(audit, invocation) })) }));
  const costs = calls.flatMap(call => call.invocations.map(invocation => invocation.cost));
  return { models: control.models, coverage: control.coverage, worldCoverage: programExecutionCoverage(control),
    programs, wakes, activities: control.activities, pending: control.pending.map(pending => ({
    actorId: pending.attempt.actorId, intent: pending.attempt.intent, atSeconds: pending.atSeconds, failure: pending.failure,
    ruleHash: pending.bound?.program.hash ?? null,
  })), decisions, calls, failures: control.failures, cost: {
    knownEstimateCny: costs.reduce((sum, cost) => sum + (cost.estimateCny ?? 0), 0),
    unknownInvocations: costs.filter(cost => cost.estimateCny === null || cost.unknownTransportUsage).length,
  } };
}
