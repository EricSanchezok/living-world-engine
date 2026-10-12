import type { SimulationState, WorldDeltaOperation, WorldEvent } from "../contracts/model";
import { evaluateCausalAssertion } from "../mechanics/causality";
import { contentHash } from "../models/model-audit";
import type { ProgramReceipt } from "../programs/interpreter";
import type { ProgramResources } from "../programs/definition";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";
import { runtimeId, quantityId } from "../runtime/runtime-id";
import { applyWorldDeltaOperation, validateSimulationState } from "../runtime/transaction";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { makeWorldDecisionBatch, mechanicalWorldCondition, validateWorldEvidence, worldProgramDuration, worldProvenance, worldQuestionWork,
  type BoundWorldProgram, type WorldAdjudication, type WorldConditionRecord } from "./adjudication";
import { captureReads, validateReads, worldProgramSources, worldResources, type ReadSet } from "./resources";
import { admitWorldProgram, bindWorldProgram, materializeWorldBranch, renderWorldText } from "./world-program";

export interface WorldDelivery { attemptId: string; recipientEntityId: string; kind: "speech" | "observation"; text: string }
export interface WorldEventCandidate {
  version: 1;
  id: string;
  atSeconds: number;
  programs: BoundWorldProgram[];
  selections: Array<{ attemptId: string; branchId: string }>;
  adjudication: Omit<WorldAdjudication, "calls">;
  reads: ReadSet;
  effects: WorldDeltaOperation[];
  deliveries: WorldDelivery[];
}
export interface CommitReceipt {
  version: 1; id: string; candidateId: string; beforeHash: string; afterHash: string;
  atSeconds: number; revision: number; step: number; reads: ReadSet; writes: string[];
  eventIds: string[]; effectHash: string; programReceipts: ProgramReceipt[];
}

function conditionKey(record: Pick<WorldConditionRecord, "attemptHash" | "ruleHash" | "conditionId">) {
  return contentHash([record.attemptHash, record.ruleHash, record.conditionId]);
}
function verifyAdjudication(programs: BoundWorldProgram[], adjudication: Omit<WorldAdjudication, "calls">,
  resources: ProgramResources, sources: Record<string, JsonValue>): Map<string, WorldConditionRecord> {
  const records = new Map(adjudication.records.map(record => [conditionKey(record), record]));
  if (records.size !== adjudication.records.length) throw new Error("duplicate world condition record");
  const expected = programs.flatMap(bound => worldQuestionWork(bound, resources));
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
    const canonical = makeWorldDecisionBatch(work, programs.map(program => program.attempt), resources, sources);
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

/** Additional mechanical reads cannot be omitted by a generated declaration. */
function operationReads(state: Readonly<SimulationState>, operation: WorldDeltaOperation): string[] {
  const keys = ["mechanics"];
  switch (operation.kind) {
    case "create_entity": return [...keys, "entities", "placements"];
    case "retire_entity": return [...keys, `entity:${operation.entityId}`];
    case "place_entity": return [...keys, `entity:${operation.entityId}`, "placements", ...(operation.placementId ? [`entity:${operation.placementId}`] : [])];
    case "set_fact": return [...keys, "facts", "tombstones", `entity:${operation.fact.subjectId}`, ...(operation.fact.value.kind === "entity" ? [`entity:${operation.fact.value.entityId}`] : [])];
    case "remove_fact": return [...keys, `fact:${operation.factId}`, "tombstones"];
    case "set_meter": return [...keys, "meters", `entity:${operation.meter.entityId}`, "facts"];
    case "adjust_meter": return [...keys, `meter:${operation.meterId}`, "facts", "entities"];
    case "transfer_quantity": return [...keys, `entity:${operation.fromHolderId}`, `entity:${operation.toHolderId}`,
      ...[operation.fromHolderId, operation.toHolderId].map(holder => `quantity:${quantityId(state.worldHash, operation.definitionId, holder)}`)];
    case "produce_quantity": case "consume_quantity": return [...keys, `entity:${operation.holderId}`,
      `quantity:${quantityId(state.worldHash, operation.definitionId, operation.holderId)}`, `law:${operation.lawId}`];
    case "set_quantity": return [...keys, "quantities", `entity:${operation.quantity.holderId}`];
    case "set_rating": return [...keys, "ratings", `entity:${operation.rating.entityId}`];
    case "set_condition": return [...keys, "conditions", `entity:${operation.condition.subjectId}`];
    case "remove_condition": return [...keys, `condition:${operation.conditionId}`];
    case "set_shared_activity_resource_capacity": return [...keys, `pool:${operation.poolId}`, "activities"];
    case "create_agent": case "remove_agent": return [...keys, "entities", "agentRoster"];
    case "advance_time": throw new Error("world program cannot own time advancement");
  }
}

function materialize(programs: BoundWorldProgram[], records: Map<string, WorldConditionRecord>, resources: ProgramResources) {
  const selections: WorldEventCandidate["selections"] = [], effects: WorldDeltaOperation[] = [], deliveries: WorldDelivery[] = [];
  for (const bound of programs) {
    const verdict = (id: string) => records.get(conditionKey({ ruleHash: bound.program.hash, attemptHash: contentHash(bound.attempt), conditionId: id }))?.verdict;
    const branches = bound.program.definition.branches.filter(branch => branch.when.every(condition => verdict(condition.predicateId) === condition.equals) && verdict(`effect:${branch.id}`) === "yes");
    if (branches.length !== 1) throw new Error(branches.length ? "ambiguous world branches require expansion" : "world rule awaits evidence or expansion");
    const branch = branches[0]!;
    selections.push({ attemptId: bound.attempt.id, branchId: branch.id });
    effects.push(...materializeWorldBranch(bound.program, branch.id, bound.parameters, resources, worldProvenance(bound)));
    for (const delivery of branch.deliveries) {
      const recipient = bound.parameters[delivery.recipientParameter]; if (typeof recipient !== "string") throw new Error("invalid delivery recipient");
      const text = renderWorldText(delivery.text, bound.parameters);
      // Speech is the exact authored pre-action utterance. The world cannot silently rewrite testimony.
      if (delivery.kind === "speech" && text !== bound.attempt.utterance) throw new Error("speech delivery differs from the pre-action utterance");
      deliveries.push({ attemptId: bound.attempt.id, recipientEntityId: recipient, text, kind: delivery.kind });
    }
  }
  return { selections, effects, deliveries };
}

export function createWorldEventCandidate(state: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  programs: BoundWorldProgram[], adjudication: WorldAdjudication, atSeconds: number): WorldEventCandidate {
  const sources = worldProgramSources(definition, state), entityIds = new Set(Object.keys(state.truth.entities));
  if (!programs.length || new Set(programs.map(bound => bound.attempt.id)).size !== programs.length) throw new Error("event requires distinct attempts");
  for (const bound of programs) {
    const admitted = admitWorldProgram(bound.program.definition, sources);
    if (admitted.hash !== bound.program.hash) throw new Error("world program sources changed");
    bindWorldProgram(bound.program, bound.parameters, entityIds);
    if (bound.parameters.actor !== bound.attempt.actorEntityId || state.agents[bound.attempt.actorId]?.entityId !== bound.attempt.actorEntityId ||
      !bound.attempt.intent.trim() || !Number.isSafeInteger(bound.attempt.startedAtSeconds) || bound.attempt.startedAtSeconds < 0 ||
      bound.attempt.startedAtSeconds > state.truth.elapsedSeconds || bound.attempt.targetEntityIds.some(id => !entityIds.has(id))) throw new Error("world attempt ownership or parameters are invalid");
    if (atSeconds < bound.attempt.startedAtSeconds + worldProgramDuration(bound, resources)) throw new Error("world effects precede their execution duration");
  }
  if (!Number.isSafeInteger(atSeconds) || atSeconds <= state.truth.elapsedSeconds) throw new Error("physical world event must advance time");
  if (atSeconds !== Math.max(...programs.map(bound => bound.attempt.startedAtSeconds + worldProgramDuration(bound, resources)))) throw new Error("world event time differs from its execution boundary");
  const proof = { records: adjudication.records, evidence: adjudication.evidence };
  const records = verifyAdjudication(programs, proof, resources, sources);
  const value = materialize(programs, records, resources);
  const reads = captureReads(resources, [...new Set([
    ...proof.records.flatMap(record => Object.keys(record.readSet)),
    ...programs.flatMap(bound => [ `entity:${bound.attempt.actorEntityId}`, ...bound.program.definition.reads.map(key => renderWorldText(key, bound.parameters)) ]),
    ...value.effects.flatMap(operation => operationReads(state, operation)),
  ])]);
  const body = { version: 1 as const, atSeconds, programs, adjudication: proof, ...value, reads };
  return frozenClone({ ...body, id: contentHash(body) });
}

const collectionFor: Record<string, string> = { entity: "entities", placement: "placements", fact: "facts", meter: "meters", quantity: "quantities",
  rating: "ratings", condition: "conditions", activity: "activities", pool: "pools", timer: "timers" };

function physicalProgressHash(state: SimulationState): string {
  const truth = structuredClone(state.truth);
  truth.events = []; truth.elapsedSeconds = 0;
  for (const fact of Object.values(truth.facts)) fact.provenance = [];
  for (const condition of Object.values(truth.conditions)) condition.provenance = [];
  return contentHash({ truth, agentIds: Object.keys(state.agents).sort() });
}

/** Atomic deterministic commit. Semantic evidence is replayed, never replaced with a causal-verifier call token. */
export function commitWorldEvent(source: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  candidate: WorldEventCandidate, options: { earliestPendingSeconds: number; receipts: ReadonlyMap<string, CommitReceipt> }) {
  assertJsonValue(candidate as unknown, "world event candidate");
  const { id, ...body } = candidate;
  if (id !== contentHash(body)) throw new Error("world event candidate checksum mismatch");
  const existing = options.receipts.get(id);
  if (existing) return { state: structuredClone(source) as SimulationState, resources, receipt: structuredClone(existing), replayed: true };
  if (candidate.atSeconds !== options.earliestPendingSeconds) throw new Error("cannot commit past an unsettled earlier world event");
  resources = worldResources(source, definition, resources);
  validateReads(resources, candidate.reads);
  const canonical = createWorldEventCandidate(source, definition, resources, candidate.programs, { ...candidate.adjudication, calls: [] }, candidate.atSeconds);
  if (contentHash(canonical) !== contentHash(candidate)) throw new Error("world candidate effects differ from the admitted program");
  const next = structuredClone(source) as SimulationState;
  const progress = new Set<string>();
  // All programs in this component were jointly adjudicated. Resource competition is still checked against the evolving transaction clone.
  for (const operation of candidate.effects) {
    for (const assertion of operation.assertions) if (!evaluateCausalAssertion(source, assertion).passed) throw new Error("world effect causal assertion failed");
    const before = physicalProgressHash(next); applyWorldDeltaOperation(next, operation);
    if (before !== physicalProgressHash(next)) for (const cause of operation.causes) if (cause.kind === "action") progress.add(cause.id);
  }
  // Transfers cannot create resources. Production/consumption require the existing code-owned quantity laws.
  for (const quantity of Object.values(next.truth.quantities)) {
    if (quantity.id !== quantityId(next.worldHash, quantity.definitionId, quantity.holderId) || quantity.amount < 0) throw new Error("world quantity invariant failed");
  }
  next.truth.elapsedSeconds = candidate.atSeconds;
  const expired = new Set<string>();
  for (const [conditionId, condition] of Object.entries(next.truth.conditions)) if (condition.expiresAtElapsedSeconds !== null && condition.expiresAtElapsedSeconds <= candidate.atSeconds) {
    expired.add(`condition:${conditionId}`); delete next.truth.conditions[conditionId];
  }
  next.revision += 1; next.step += 1;
  for (const [agentId, agent] of Object.entries(next.agents)) {
    if (next.truth.entities[agent.entityId]?.lifecycle !== "active") delete next.agents[agentId]; else agent.nextAction = null;
  }
  const events: WorldEvent[] = candidate.programs.map((bound, ordinal) => {
    const selected = candidate.selections.find(selection => selection.attemptId === bound.attempt.id)!;
    const branch = bound.program.definition.branches.find(branch => branch.id === selected.branchId)!;
    return { id: runtimeId({ worldHash: next.worldHash, revision: source.revision, kind: "event", stage: "world-program", owner: bound.attempt.id, round: 0, ordinal }),
      step: next.step, description: renderWorldText(branch.description, bound.parameters), impact: "ordinary", ...worldProvenance(bound) };
  });
  next.truth.events.push(...events);
  validateSimulationState(next, false);
  const updated = worldResources(next, definition, resources);
  const writes = Object.keys(updated).filter(key => (key.includes(":") || key === "agentRoster") && contentHash(updated[key]?.value) !== contentHash(resources[key]?.value ?? null));
  const declared = new Set(candidate.programs.flatMap(bound => bound.program.definition.writes.map(key => renderWorldText(key, bound.parameters))));
  for (const write of writes) {
    const collection = collectionFor[write.slice(0, write.indexOf(":"))];
    if (!declared.has(write) && !declared.has(collection!) && !expired.has(write)) {
      throw new Error(`world program wrote an undeclared resource ${write}`);
    }
  }
  const effectHash = contentHash({ operations: candidate.effects, deliveries: candidate.deliveries });
  const programReceipts: ProgramReceipt[] = candidate.programs.flatMap((bound, ordinal) => {
    if (!bound.attempt.program) return [];
    const branch = bound.program.definition.branches.find(value => value.id === candidate.selections.find(value => value.attemptId === bound.attempt.id)!.branchId)!;
    const value = { ...bound.attempt.program, status: branch.outcome, atSeconds: candidate.atSeconds, eventIds: [events[ordinal]!.id],
      effectHash: contentHash({ candidateId: id, attemptId: bound.attempt.id }),
      madeProgress: progress.has(bound.attempt.id) || branch.deliveries.length > 0 };
    return [{ ...value, id: contentHash(value) }];
  });
  const value = { version: 1 as const, candidateId: id, beforeHash: contentHash(source), afterHash: contentHash(next),
    atSeconds: candidate.atSeconds, revision: next.revision, step: next.step, reads: candidate.reads, writes,
    eventIds: events.map(event => event.id), effectHash, programReceipts };
  return { state: next, resources: updated, receipt: frozenClone({ ...value, id: contentHash(value) }), replayed: false };
}
