import type { RulePackageRegistry } from "../mechanics/rule-package";
import type { MechanicInvocation, MechanicResult, SimulationState, WorldDeltaOperation, WorldEvent } from "../contracts/model";
import { deriveConditionAdvance } from "../mechanics/condition-time";
import { evaluateCausalAssertion } from "../mechanics/causality";
import { contentHash } from "../models/model-audit";
import type { ProgramReceipt } from "../programs/interpreter";
import type { ProgramResources } from "../programs/definition";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";
import { runtimeId, quantityId } from "../runtime/runtime-id";
import { applyWorldDeltaOperation, validateSimulationState } from "../runtime/transaction";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { makeWorldDecisionBatch, mechanicalWorldCondition, validateWorldEvidence, validateWorldBranchContract, worldProgramBoundary, worldProgramTiming, worldProvenance, worldQuestionWork,
  selectableWorldBranches, worldProgramComponents, worldDecisionParticipants,
  type BoundWorldProgram, type WorldAdjudication, type WorldConditionRecord } from "./adjudication";
import { captureReads, worldOperationReads, validateReads, worldProgramSources, worldResources, type ReadSet } from "./resources";
import { admitWorldProgram, bindWorldProgram, renderWorldText } from "./world-program";
import { materializeWorldMechanics, type WorldMechanicsContext } from "./mechanics";
import { activeRandomReservation, validateWorldRandomness, type WorldRandomCommitment } from "./randomness";
import { worldClockBoundary, type WorldClockBoundary } from "./clock-boundary";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { privateProgramResources } from "../programs/private-resources";
import type { ResolutionPlan, ResolutionReceipt } from "../mechanics/resolution";

export interface WorldDelivery { attemptId: string; recipientEntityId: string; kind: "speech" | "observation"; text: string }
export interface WorldEventCandidate {
  version: 1;
  unresolved: boolean;
  continuingAttemptIds: string[];
  components: string[][];
  id: string;
  atSeconds: number;
  programs: BoundWorldProgram[];
  selections: Array<{ attemptId: string; branchId: string }>;
  adjudication: Omit<WorldAdjudication, "calls">;
  reads: ReadSet;
  effects: WorldDeltaOperation[];
  mechanicInvocations: MechanicInvocation[];
  mechanicResults: MechanicResult[];
  resolutionPlans: ResolutionPlan[];
  resolutionReceipts: ResolutionReceipt[];
  deliveries: WorldDelivery[];
  randomness: WorldRandomCommitment | null;
  clockBoundary: WorldClockBoundary;
  clockEffects: WorldDeltaOperation[];
}
export interface CommitReceipt {
  version: 1; id: string; candidateId: string; beforeHash: string; afterHash: string;
  atSeconds: number; revision: number; step: number; reads: ReadSet; writes: string[];
  eventIds: string[]; effectHash: string; programReceipts: ProgramReceipt[];
}

/** A supported semantic branch can still overdraw a jointly contested quantity. */
export class WorldResourceConflictError extends Error {
  constructor(readonly attemptIds: string[], readonly resourceId: string, readonly requested: number, readonly available: number, cause: Error) {
    super(`insufficient quantity in joint world effects: ${resourceId}; requested ${requested}, available ${available}`, { cause });
    this.name = "WorldResourceConflictError";
  }
}

function projectCandidateEffects(source: Readonly<SimulationState>, effects: WorldDeltaOperation[]): SimulationState {
  const projected = structuredClone(source) as SimulationState;
  for (const operation of effects) {
    try { applyWorldDeltaOperation(projected, operation); }
    catch (error) {
      if (error instanceof Error && error.message === "insufficient quantity" &&
        (operation.kind === "transfer_quantity" || operation.kind === "consume_quantity")) {
        const holder = operation.kind === "transfer_quantity" ? operation.fromHolderId : operation.holderId;
        const id = quantityId(source.worldHash, operation.definitionId, holder);
        throw new WorldResourceConflictError(operation.causes.flatMap(cause => cause.kind === "action" ? [cause.id] : []),
          `quantity:${id}`, operation.amount, projected.truth.quantities[id]?.amount ?? 0, error);
      }
      throw error;
    }
  }
  return projected;
}

function conditionKey(record: Pick<WorldConditionRecord, "attemptHash" | "ruleHash" | "conditionId">) {
  return contentHash([record.attemptHash, record.ruleHash, record.conditionId]);
}
function verifyAdjudication(programs: BoundWorldProgram[], adjudication: Omit<WorldAdjudication, "calls">,
  resources: ProgramResources, sources: Record<string, JsonValue>, context: WorldMechanicsContext): Map<string, WorldConditionRecord> {
  const records = new Map(adjudication.records.map(record => [conditionKey(record), record]));
  if (records.size !== adjudication.records.length) throw new Error("duplicate world condition record");
  const components = worldProgramComponents(programs, resources, context);
  const expected = programs.flatMap(bound => worldQuestionWork(bound, resources, context));
  const claimed = new Set<string>();
  const evidenceHashes = new Set<string>();
  for (const evidence of adjudication.evidence) {
    validateWorldEvidence(evidence);
    if (evidenceHashes.has(evidence.hash)) throw new Error("duplicate world decision evidence"); evidenceHashes.add(evidence.hash);
    const work = Object.keys(evidence.batch.questions).map((id, index) => {
      if (id !== `q${index}`) throw new Error("world question order changed");
      const matches = adjudication.records.filter(record => record.evidenceHash === evidence.hash && record.questionId === id);
      if (matches.length !== 1) throw new Error("decision question does not bind exactly one world condition");
      const record = matches[0]!, key = conditionKey(record);
      if (claimed.has(key)) throw new Error("world condition evidence reused for another condition"); claimed.add(key);
      const question = expected.find(value => value.bound.program.hash === record.ruleHash && contentHash(value.bound.attempt) === record.attemptHash && value.id === record.conditionId);
      if (!question || record.verdict !== evidence.result.answers[id]?.choice ||
        contentHash(record.readSet) !== contentHash(captureReads(resources, Object.keys(evidence.batch.dependencies)))) throw new Error("world condition does not match its decision");
      validateReads(resources, record.readSet); return question;
    });
    const canonical = makeWorldDecisionBatch(work, worldDecisionParticipants(components, work), resources, sources);
    if (contentHash(canonical) !== contentHash(evidence.batch)) throw new Error("world decision used different sources, effects, attempts, or resources");
  }
  for (const bound of programs) for (const predicate of bound.program.definition.predicates) {
    const verdict = mechanicalWorldCondition(bound, predicate.id, resources);
    if (verdict === null) continue;
    const key = conditionKey({ ruleHash: bound.program.hash, attemptHash: contentHash(bound.attempt), conditionId: predicate.id });
    const record = records.get(key); if (!record || record.verdict !== verdict || record.questionId !== null) throw new Error("mechanical world condition mismatch");
    const { evidenceHash, ...body } = record;
    if (contentHash(record.readSet) !== contentHash(captureReads(resources, predicate.reads.map(key => renderWorldText(key, bound.parameters)))) ||
      evidenceHash !== contentHash({ evaluator: "world-mechanical-v1", ...body })) throw new Error("mechanical world evidence mismatch");
    claimed.add(key);
  }
  if (claimed.size !== records.size || expected.some(work => !records.has(conditionKey({
    ruleHash: work.bound.program.hash, attemptHash: contentHash(work.bound.attempt), conditionId: work.id })))) throw new Error("incomplete world condition evidence");
  return records;
}


function materialize(programs: BoundWorldProgram[], records: Map<string, WorldConditionRecord>, resources: ProgramResources, context: WorldMechanicsContext) {
  const selections: WorldEventCandidate["selections"] = [], effects: WorldDeltaOperation[] = [], deliveries: WorldDelivery[] = [];
  const mechanicInvocations: MechanicInvocation[] = [], mechanicResults: MechanicResult[] = [];
  const resolutionPlans: ResolutionPlan[] = [], resolutionReceipts: ResolutionReceipt[] = [];
  for (const bound of programs) {
    const branches = selectableWorldBranches(bound, [...records.values()]);
    if (branches.length !== 1) throw new Error(branches.length ? "ambiguous world branches require expansion" : "world rule awaits evidence or expansion");
    const branch = branches[0]!;
    validateWorldBranchContract(bound, branch, resources);
    selections.push({ attemptId: bound.attempt.id, branchId: branch.id });
    const mechanical = materializeWorldMechanics(bound, branch.id, resources, context);
    effects.push(...mechanical.operations);
    mechanicInvocations.push(...mechanical.mechanics.invocations); mechanicResults.push(...mechanical.mechanics.results);
    resolutionPlans.push(...mechanical.resolutionPlans); resolutionReceipts.push(...mechanical.resolutionReceipts);
    for (const delivery of branch.deliveries) {
      const recipient = bound.parameters[delivery.recipientParameter]; if (typeof recipient !== "string") throw new Error("invalid delivery recipient");
      const text = renderWorldText(delivery.text, bound.parameters);
      // Speech is the exact authored pre-action utterance. The world cannot silently rewrite testimony.
      if (delivery.kind === "speech" && text !== bound.attempt.utterance) throw new Error("speech delivery differs from the pre-action utterance");
      deliveries.push({ attemptId: bound.attempt.id, recipientEntityId: recipient, text, kind: delivery.kind });
    }
  }
  return { selections, effects, deliveries, mechanicInvocations, mechanicResults, resolutionPlans, resolutionReceipts };
}

export function createWorldEventCandidate(state: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  programs: BoundWorldProgram[], adjudication: WorldAdjudication, atSeconds: number, randomness: WorldRandomCommitment | null = null, rulePackages?: RulePackageRegistry): WorldEventCandidate {
  resources = validateWorldRandomness(state, definition, resources, programs, randomness);
  const sources = worldProgramSources(definition, state), entityIds = new Set(Object.keys(state.truth.entities));
  const clockBoundary = worldClockBoundary(state, atSeconds);
  if ((!programs.length && !clockBoundary.timers.length && !clockBoundary.conditions.length && !clockBoundary.impacts.length && !clockBoundary.programDeadlines.length) ||
    new Set(programs.map(bound => bound.attempt.id)).size !== programs.length) throw new Error("event requires distinct attempts or an actual clock boundary");
  for (const bound of programs) {
    const admitted = admitWorldProgram(bound.program.definition, sources);
    if (admitted.hash !== bound.program.hash) throw new Error("world program sources changed");
    bindWorldProgram(bound.program, bound.parameters, entityIds);
    if (bound.parameters.actor !== bound.attempt.actorEntityId || state.agents[bound.attempt.actorId]?.entityId !== bound.attempt.actorEntityId ||
      !bound.attempt.intent.trim() || !Number.isSafeInteger(bound.attempt.startedAtSeconds) || bound.attempt.startedAtSeconds < 0 ||
      bound.attempt.startedAtSeconds > state.truth.elapsedSeconds || bound.attempt.targetEntityIds.some(id => !entityIds.has(id))) throw new Error("world attempt ownership or parameters are invalid");
    if (atSeconds < worldProgramBoundary(bound, resources)) throw new Error("world effects precede their execution duration");
  }
  if (!Number.isSafeInteger(atSeconds) || atSeconds <= state.truth.elapsedSeconds) throw new Error("physical world event must advance time");
  if (programs.length && atSeconds !== Math.max(...programs.map(bound => worldProgramBoundary(bound, resources)))) throw new Error("world event time differs from its execution boundary");
  const proof = { records: adjudication.records, evidence: adjudication.evidence };
  const context = { state, definition, randomness, rulePackages };
  const records = verifyAdjudication(programs, proof, resources, sources, context);
  // A persisted draw cannot be repaired into different stakes after its result is known.
  // An unresolved joint frontier ends with blocked receipts and no fabricated effects.
  const empty = { selections: [], effects: [], deliveries: [], mechanicInvocations: [], mechanicResults: [], resolutionPlans: [], resolutionReceipts: [] };
  let unresolved = Boolean(activeRandomReservation(state) && programs.some(bound => selectableWorldBranches(bound, [...records.values()]).length !== 1));
  let value = unresolved ? empty : materialize(programs, records, resources, context);
  let projected: SimulationState;
  try { projected = projectCandidateEffects(state, value.effects); }
  catch (error) {
    if (!(error instanceof WorldResourceConflictError) || !activeRandomReservation(state)) throw error;
    // The draw has already fixed the stakes. Close the whole reservation with
    // blocked receipts instead of revising a losing result or drawing again.
    unresolved = true; value = empty; projected = structuredClone(state) as SimulationState;
  }
  const continuingAttemptIds = unresolved ? [] : programs.filter(bound => worldProgramTiming(bound, resources).completionAtSeconds === null &&
    bound.program.definition.branches.find(branch => branch.id === value.selections.find(selection => selection.attemptId === bound.attempt.id)!.branchId)!.outcome === "partial")
    .map(bound => bound.attempt.id);
  const clockEffects = (() => {
    if (!clockBoundary.impacts.length && !clockBoundary.conditions.length) return [];
    return deriveConditionAdvance({ state: projected, endElapsedSeconds: atSeconds });
  })();
  const reads = captureReads(resources, [...new Set([
    ...proof.records.flatMap(record => Object.keys(record.readSet)),
    ...programs.flatMap(bound => [ `entity:${bound.attempt.actorEntityId}`, ...bound.program.definition.reads.map(key => renderWorldText(key, bound.parameters)) ]),
    ...[...value.effects, ...clockEffects].flatMap(operation => worldOperationReads(state, operation)),
    ...Object.keys(randomness?.plan.reads ?? {}),
    ...programs.map(bound => `program-actor:${bound.attempt.actorEntityId}`).filter(key => resources[key]),
    ...clockBoundary.timers.map(timer => `timer:${timer.id}`), ...[...clockBoundary.conditions, ...clockBoundary.impacts].map(id => `condition:${id}`),
    ...clockBoundary.impacts.flatMap(id => {
      const condition = state.truth.conditions[id]!, profile = condition.conditionProfileId && state.truth.mechanics.conditionProfiles[condition.conditionProfileId];
      const impact = profile && profile.recurringImpactProfileId && state.truth.mechanics.impactProfiles[profile.recurringImpactProfileId];
      return ["mechanics", ...Object.values(state.truth.meters).filter(meter => impact && meter.entityId === condition.subjectId &&
        meter.definitionId === impact.meterDefinitionId).map(meter => `meter:${meter.id}`)];
    }),
  ])]);
  const components = worldProgramComponents(programs, resources, context).map(component => component.map(bound => bound.attempt.id));
  const body = { version: 1 as const, unresolved, continuingAttemptIds, components, atSeconds, programs, adjudication: proof, ...value, reads, randomness, clockBoundary, clockEffects };
  return frozenClone({ ...body, id: contentHash(body) });
}

const collectionFor: Record<string, string> = { entity: "entities", placement: "placements", fact: "facts", meter: "meters", quantity: "quantities",
  rating: "ratings", condition: "conditions", activity: "activities", pool: "pools", timer: "timers", "program-actor": "agentRoster" };

function privatePhysicalHash(state: Readonly<SimulationState>, agentId: string): string {
  const agent = state.agents[agentId]; if (!agent) return contentHash(null);
  const resources = privateProgramResources(projectAgentPerspective(state as SimulationState, agent)).resources;
  return contentHash(Object.fromEntries(Object.entries(resources).filter(([key]) => key !== "clock").map(([key, resource]) => [key, resource.value])));
}

/** Atomic deterministic commit. Semantic evidence is replayed, never replaced with a causal-verifier call token. */
export function commitWorldEvent(source: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  candidate: WorldEventCandidate, options: { earliestPendingSeconds: number; receipts: ReadonlyMap<string, CommitReceipt>; rulePackages?: RulePackageRegistry }) {
  assertJsonValue(candidate as unknown, "world event candidate");
  const { id, ...body } = candidate;
  if (id !== contentHash(body)) throw new Error("world event candidate checksum mismatch");
  const existing = options.receipts.get(id);
  if (existing) return { state: structuredClone(source) as SimulationState, resources, receipt: structuredClone(existing), replayed: true };
  if (candidate.atSeconds !== options.earliestPendingSeconds) throw new Error("cannot commit past an unsettled earlier world event");
  const physicalResources = worldResources(source, definition, Object.fromEntries(Object.entries(resources).filter(([key]) => !/^(random|check):/u.test(key))));
  resources = validateWorldRandomness(source, definition, physicalResources, candidate.programs, candidate.randomness);
  validateReads(resources, candidate.reads);
  const canonical = createWorldEventCandidate(source, definition, resources, candidate.programs, { ...candidate.adjudication, calls: [] }, candidate.atSeconds, candidate.randomness, options.rulePackages);
  if (contentHash(canonical) !== contentHash(candidate)) throw new Error("world candidate effects differ from the admitted program");
  const next = structuredClone(source) as SimulationState;
  if (candidate.randomness) next.truth.rng = structuredClone(candidate.randomness.after);
  // All programs in this component were jointly adjudicated. Resource competition is still checked against the evolving transaction clone.
  const randomResults = new Map(candidate.randomness?.results.map(result => [result.requestId, result]) ?? []);
  const checks = new Map(candidate.randomness?.checks.map(result => [result.requestId, result]) ?? []);
  for (const operation of candidate.effects) {
    for (const assertion of operation.assertions) if (!evaluateCausalAssertion(source, assertion, checks, randomResults).passed) throw new Error("world effect causal assertion failed");
    applyWorldDeltaOperation(next, operation);
  }
  // Transfers cannot create resources. Production/consumption require the existing code-owned quantity laws.
  for (const quantity of Object.values(next.truth.quantities)) {
    if (quantity.id !== quantityId(next.worldHash, quantity.definitionId, quantity.holderId) || quantity.amount < 0) throw new Error("world quantity invariant failed");
  }
  const declared = new Set(candidate.programs.flatMap(bound => bound.program.definition.writes.map(key => renderWorldText(key, bound.parameters))));
  const programOnly = worldResources(next, definition, physicalResources);
  for (const write of Object.keys(programOnly).filter(key => (key.includes(":") || key === "agentRoster") &&
    contentHash(programOnly[key]?.value) !== contentHash(physicalResources[key]?.value ?? null))) {
    const collection = collectionFor[write.slice(0, write.indexOf(":"))];
    if (!declared.has(write) && !declared.has(collection!)) throw new Error(`world program wrote an undeclared resource ${write}`);
  }
  for (const operation of candidate.clockEffects) {
    for (const assertion of operation.assertions) if (!evaluateCausalAssertion(next, assertion).passed) throw new Error("condition clock assertion failed");
    applyWorldDeltaOperation(next, operation);
  }
  next.truth.elapsedSeconds = candidate.atSeconds;
  for (const timer of candidate.clockBoundary.timers) next.truth.timers[timer.id]!.status = timer.status;
  next.revision += 1; next.step += 1;
  for (const [agentId, agent] of Object.entries(next.agents)) {
    if (next.truth.entities[agent.entityId]?.lifecycle !== "active") delete next.agents[agentId]; else agent.nextAction = null;
  }
  const events: WorldEvent[] = candidate.programs.map((bound, ordinal) => {
    const selected = candidate.selections.find(selection => selection.attemptId === bound.attempt.id);
    const branch = bound.program.definition.branches.find(branch => branch.id === selected?.branchId);
    return { id: runtimeId({ worldHash: next.worldHash, revision: source.revision, kind: "event", stage: "world-program", owner: bound.attempt.id, round: 0, ordinal }),
      step: next.step, description: candidate.unresolved ? "The attempt produced no confirmed outcome." : renderWorldText(branch!.description, bound.parameters), impact: "ordinary", ...worldProvenance(bound) };
  });
  for (const [ordinal, timer] of candidate.clockBoundary.timers.entries()) {
    const sourceTimer = source.truth.timers[timer.id]!;
    events.push({ id: runtimeId({ worldHash: next.worldHash, revision: source.revision, kind: "event", stage: "world-timer",
      owner: timer.id, round: 0, ordinal }), step: next.step, impact: "ordinary",
      description: timer.status === "fired" ? sourceTimer.description : `Timer cancelled because its preconditions no longer hold: ${sourceTimer.description}`,
      causes: structuredClone(sourceTimer.causes), assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: candidate.atSeconds }] });
  }
  next.truth.events.push(...events);
  validateSimulationState(next, false);
  const updated = worldResources(next, definition, physicalResources);
  const writes = Object.keys(updated).filter(key => (key.includes(":") || key === "agentRoster" || key === "rng") &&
    contentHash(updated[key]?.value) !== contentHash(physicalResources[key]?.value ?? null));
  const effectHash = contentHash({ operations: [...candidate.effects, ...candidate.clockEffects], deliveries: candidate.deliveries, randomness: candidate.randomness?.hash ?? null });
  const programReceipts: ProgramReceipt[] = candidate.programs.flatMap((bound, ordinal) => {
    if (!bound.attempt.program) return [];
    const branch = bound.program.definition.branches.find(value => value.id === candidate.selections.find(value => value.attemptId === bound.attempt.id)?.branchId);
    const value = { instanceId: bound.attempt.program.instanceId, workId: bound.attempt.program.workId, requestHash: bound.attempt.program.requestHash,
      // An executed attempt does not reveal an unobserved hit, failure, delivery, or secret state change.
      status: candidate.unresolved ? "blocked" as const : candidate.continuingAttemptIds.includes(bound.attempt.id) ? "continuing" as const :
        branch!.acknowledgement === "observed-outcome" ? branch!.outcome : "succeeded" as const,
      atSeconds: candidate.atSeconds, eventIds: [events[ordinal]!.id],
      effectHash: contentHash({ candidateId: id, attemptId: bound.attempt.id }),
      madeProgress: privatePhysicalHash(source, bound.attempt.actorId) !== privatePhysicalHash(next, bound.attempt.actorId) ||
        Boolean(branch?.deliveries.some(delivery => bound.parameters[delivery.recipientParameter] === bound.attempt.actorEntityId)) };
    return [{ ...value, id: contentHash(value) }];
  });
  const value = { version: 1 as const, candidateId: id, beforeHash: contentHash(source), afterHash: contentHash(next),
    atSeconds: candidate.atSeconds, revision: next.revision, step: next.step, reads: candidate.reads, writes,
    eventIds: events.map(event => event.id), effectHash, programReceipts };
  return { state: next, resources: updated, receipt: frozenClone({ ...value, id: contentHash(value) }), replayed: false };
}
