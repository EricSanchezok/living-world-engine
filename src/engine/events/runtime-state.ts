import { z } from "zod";
import type { SimulationState } from "../contracts/model";
import type { ModelExecutionAudit } from "../contracts/model";
import type { ProgramResources } from "../programs/definition";
import { programHash } from "../programs/definition";
import { ProgramLibrary, type GoalProgramCoverage } from "../programs/library";
import { ProgramInterpreter, type ProgramInstance, type ProgramReceipt } from "../programs/interpreter";
import { privateProgramEntityIds, privateProgramResources, type PrivateResourceSnapshot } from "../programs/private-resources";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { contentHash } from "../models/model-audit";
import { assertJsonValue, type JsonObject } from "../runtime/json";
import type { AlgorithmExecutionState } from "../runtime/execution-state";
import { EventScheduler } from "./scheduler";
import { WorldProgramLibrary } from "./library";
import type { BoundWorldProgram, WorldAttempt } from "./adjudication";
import type { CommitReceipt } from "./kernel";
import { worldProgramBoundary } from "./adjudication";
import { worldRecoverySchema, type WorldAttemptRecovery } from "./world-recovery";
import { programActivitySchema, validateProgramActivities, type ProgramActivity } from "./activities";
import { validateRandomReservation, type WorldRandomReservation } from "./randomness";
import type { DecisionUse } from "../programs/decision-runtime";

export interface DecisionEventModels { decision: string; creation: string; fallback: string }
export interface PendingProgramAttempt {
  attempt: WorldAttempt;
  bound: BoundWorldProgram | null;
  atSeconds: number | null;
  dependencyHash: string;
  failure: string | null;
  recovery: WorldAttemptRecovery | null;
}
export interface AgentProgramState {
  resources: PrivateResourceSnapshot;
  instances: Array<{ snapshot: ProgramInstance; entityIds: string[] }>;
  activeInstanceId: string | null;
  lastEvidenceIds: string[];
  planning: { inputHash: string; attempts: number; waitReason: string | null } | null;
}
export interface ProgramRuntimeFailure {
  ownerId: string; phase: "goal" | "program" | "utterance" | "world-rule" | "adjudication" | "activity";
  inputHash: string; reason: string; recoverable: true;
}
export interface DecisionEventState {
  kind: "decision-event"; version: 5; hash: string; worldHash: string; modelCatalogHash: string; registryHash: string;
  models: DecisionEventModels; privateLibrary: ReturnType<ProgramLibrary["snapshot"]>; worldLibrary: ReturnType<WorldProgramLibrary["snapshot"]>;
  policyKinds: Record<string, "model" | "external" | "idle" | "replay">;
  agents: Record<string, AgentProgramState>; worldResources: ProgramResources;
  scheduler: ReturnType<EventScheduler["snapshot"]>; decisionCache: JsonObject | null;
  modelOrdinals: { revision: number; subjects: Record<string, number> };
  pending: PendingProgramAttempt[]; receipts: CommitReceipt[]; coverage: GoalProgramCoverage[]; failures: ProgramRuntimeFailure[];
  activities: ProgramActivity[];
  randomReservation: WorldRandomReservation | null;
}
const stateSchema = z.object({ kind: z.literal("decision-event"), version: z.literal(5), hash: programHash,
  worldHash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), modelCatalogHash: z.string().min(1), registryHash: z.string().min(1),
  models: z.object({ decision: z.string().min(1), creation: z.string().min(1), fallback: z.string().min(1) }).strict(),
  policyKinds: z.record(z.string(), z.enum(["model", "external", "idle", "replay"])),
  privateLibrary: z.unknown(), worldLibrary: z.unknown(), agents: z.record(z.string(), z.unknown()), worldResources: z.record(z.string(), z.unknown()),
  scheduler: z.unknown(), decisionCache: z.unknown(), randomReservation: z.unknown(),
  modelOrdinals: z.object({ revision: z.number().int().nonnegative(), subjects: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
  pending: z.array(z.unknown()), receipts: z.array(z.unknown()), activities: z.array(programActivitySchema),
  coverage: z.array(z.unknown()), failures: z.array(z.unknown()) }).strict();

export function sealDecisionEventState(input: Omit<DecisionEventState, "hash"> | DecisionEventState): DecisionEventState {
  const body: Record<string, unknown> = { ...Object.fromEntries(Object.entries(input).filter(([key]) => key !== "hash")),
    failures: input.failures.slice().sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.inputHash.localeCompare(b.inputHash) ||
      a.phase.localeCompare(b.phase) || a.reason.localeCompare(b.reason)) };
  assertJsonValue(body, "decision event state");
  return structuredClone({ ...body, hash: contentHash(body) }) as unknown as DecisionEventState;
}
export function initialDecisionEventState(state: Readonly<SimulationState>, models: DecisionEventModels, catalogHash: string, registryHash: string): DecisionEventState {
  const scheduler = new EventScheduler(state.truth.elapsedSeconds);
  for (const agentId of Object.keys(state.agents).sort()) scheduler.schedule({ atSeconds: state.truth.elapsedSeconds, subjectId: agentId,
    kind: "control", inputHash: contentHash({ bootstrap: agentId, worldHash: state.worldHash }), payload: { reason: "initial-goal-coverage" } });
  return sealDecisionEventState({ kind: "decision-event", version: 5, worldHash: state.worldHash, modelCatalogHash: catalogHash, registryHash,
    models, policyKinds: Object.fromEntries(Object.keys(state.agents).map(id => [id, "model" as const])),
    privateLibrary: new ProgramLibrary().snapshot(), worldLibrary: new WorldProgramLibrary().snapshot(),
    agents: Object.fromEntries(Object.values(state.agents).map(agent => [agent.id, {
      resources: privateProgramResources(projectAgentPerspective(state as SimulationState, agent)),
      instances: [], activeInstanceId: null, planning: null, lastEvidenceIds: Object.keys(agent.belief.evidence).sort(),
    }])), worldResources: {}, scheduler: scheduler.snapshot(), decisionCache: null,
    modelOrdinals: { revision: state.revision, subjects: {} }, pending: [], activities: [], randomReservation: null, receipts: [], coverage: [], failures: [] });
}
export function programReceiptIndex(value: Pick<DecisionEventState, "receipts">): Map<string, ProgramReceipt> {
  const receipts = new Map<string, ProgramReceipt>();
  for (const event of value.receipts) {
    const { id, ...body } = event; if (id !== contentHash(body)) throw new Error("stored event receipt checksum mismatch");
    for (const receipt of event.programReceipts) {
      const prior = receipts.get(receipt.id);
      if (prior && contentHash(prior) !== contentHash(receipt)) throw new Error("conflicting canonical program receipts");
      receipts.set(receipt.id, receipt);
    }
  }
  return receipts;
}
export function readDecisionEventState(executionState: AlgorithmExecutionState, state: Readonly<SimulationState>): DecisionEventState {
  assertJsonValue(executionState.data, "program execution state");
  const parsed = stateSchema.parse(executionState.data), { hash, ...body } = parsed;
  if (hash !== contentHash(body) || parsed.worldHash !== state.worldHash) throw new Error("program runtime checksum or world mismatch");
  const value = structuredClone(parsed) as unknown as DecisionEventState;
  if (value.randomReservation === undefined) throw new Error("missing random reservation state");
  if (value.randomReservation) validateRandomReservation(value.randomReservation);
  const library = new ProgramLibrary(value.privateLibrary); new WorldProgramLibrary(value.worldLibrary);
  new EventScheduler(state.truth.elapsedSeconds, value.scheduler);
  const receipts = programReceiptIndex(value), instances = new Set<string>();
  for (const [id, owner] of Object.entries(value.agents)) {
    if (owner.planning !== null && (!/^[a-f0-9]{64}$/u.test(owner.planning.inputHash) ||
      !Number.isSafeInteger(owner.planning.attempts) || owner.planning.attempts < 0 || owner.planning.attempts > 2 ||
      owner.planning.waitReason !== null && typeof owner.planning.waitReason !== "string")) throw new Error("invalid program expansion budget");
    if (owner.resources.ownerId !== id) throw new Error("private program state changed owner");
    for (const entry of owner.instances) {
      const definition = library.forOwner(id).find(item => item.program.hash === entry.snapshot.definitionHash);
      if (!definition || instances.has(entry.snapshot.instanceId)) throw new Error("program instance definition or identity mismatch");
      ProgramInterpreter.restore(entry.snapshot, definition.program, new Set(entry.entityIds), receipts);
      instances.add(entry.snapshot.instanceId);
    }
    if (owner.activeInstanceId !== null && !owner.instances.some(entry => entry.snapshot.instanceId === owner.activeInstanceId)) throw new Error("active program instance is absent");
  }
  for (const pending of value.pending) {
    if (pending.recovery !== null) worldRecoverySchema.parse(pending.recovery);
    if (pending.failure && !pending.recovery) throw new Error("failed world attempt has no recovery dependencies");
    const program = pending.attempt.program;
    if (program && (!instances.has(program.instanceId) || !value.agents[pending.attempt.actorId]?.instances.some(entry =>
      entry.snapshot.instanceId === program.instanceId && entry.snapshot.definitionHash === program.definitionHash))) throw new Error("pending attempt has no private program");
    if (pending.bound && contentHash(pending.bound.attempt) !== contentHash(pending.attempt)) throw new Error("pending attempt changed its bound rule");
    const activity = value.activities.find(item => item.attemptId === pending.attempt.id && item.programHash === pending.bound?.program.hash);
    if (pending.bound && !pending.failure && (pending.atSeconds === null ? activity?.status !== "queued" :
      activity?.status !== "active" || pending.atSeconds !== activity.dueAtSeconds || pending.attempt.startedAtSeconds !== activity.startedAtSeconds ||
      pending.atSeconds !== worldProgramBoundary(pending.bound, value.worldResources))) {
      throw new Error("pending attempt execution boundary changed");
    }
  }
  for (const event of value.scheduler.pending) {
    if (event.kind === "world" && !value.pending.some(pending => pending.attempt.id === (event.payload as { attemptId: string }).attemptId &&
      pending.bound && !pending.failure && pending.atSeconds === event.atSeconds)) throw new Error("world queue item has no executable pending attempt");
    if (event.kind === "deadline") {
      const owner = event.subjectId && value.agents[event.subjectId];
      const active = owner && restoreOwnerPrograms(value, event.subjectId!).find(program => program.instanceId === owner.activeInstanceId);
      if (!active || active.subscriptions(owner!.resources.resources, state.truth.elapsedSeconds).deadline !== event.atSeconds) {
        throw new Error("private deadline is not derived from the active program");
      }
    }
  }
  validateProgramActivities(state, value.activities, value.pending, value.worldResources);
  return value;
}
export function restoreOwnerPrograms(value: DecisionEventState, ownerId: string) {
  const library = new ProgramLibrary(value.privateLibrary), receipts = programReceiptIndex(value);
  return (value.agents[ownerId]?.instances ?? []).map(entry => {
    const definition = library.forOwner(ownerId).find(item => item.program.hash === entry.snapshot.definitionHash);
    if (!definition) throw new Error("private definition is absent");
    return ProgramInterpreter.restore(entry.snapshot, definition.program, new Set(entry.entityIds), receipts);
  });
}
export function ownedProgramEntityIds(state: Readonly<SimulationState>, ownerId: string): string[] {
  const agent = state.agents[ownerId]; if (!agent) throw new Error("program owner has retired");
  return privateProgramEntityIds(projectAgentPerspective(state as SimulationState, agent));
}
export function collectDecisionAudits(audits: ModelExecutionAudit[]): ModelExecutionAudit[] {
  const unique = new Map<string, ModelExecutionAudit>();
  for (const audit of audits) {
    const key = audit.invocations.map(invocation => invocation.id).join(":");
    const prior = unique.get(key);
    if (prior && contentHash(prior) !== contentHash(audit)) throw new Error("conflicting physical model invocation evidence");
    if (!prior) unique.set(key, audit);
  }
  return [...unique.values()].sort((a, b) => a.invocations[0]!.id.localeCompare(b.invocations[0]!.id));
}
export function collectDecisionUses(uses: DecisionUse[]): DecisionUse[] {
  return uses.map(use => ({ use, hash: contentHash(use) })).sort((a, b) => a.hash.localeCompare(b.hash)).map(entry => entry.use);
}

export function invocationAllocator(value: DecisionEventState, revision: number) {
  const ordinals = value.modelOrdinals.revision === revision ? structuredClone(value.modelOrdinals) : { revision, subjects: {} as Record<string, number> };
  return { ordinals, next(subjectId: string, slots = 1) {
    if (!Number.isSafeInteger(slots) || slots < 1) throw new Error("invalid model invocation reservation");
    const next = (ordinals.subjects[subjectId] ?? 0) + 1; ordinals.subjects[subjectId] = next + slots - 1; return next;
  } };
}
