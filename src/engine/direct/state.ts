import type { SimulationState } from "../contracts/model";
import type { AlgorithmExecutionState } from "../runtime/execution-state";
import { assertJsonValue } from "../runtime/json";
import { contentHash } from "../models/model-audit";
import type { AgentIntentState, DirectRuntimeState } from "./contracts";

export function orderedValues<T extends { id: string }>(record: Readonly<Record<string, T>>): T[] {
  return Object.values(record).sort((left, right) => left.id.localeCompare(right.id));
}

export function readyIntent(reason = "initial-decision"): AgentIntentState {
  return { goalId: null, status: "ready", wakeReasons: [reason], activityId: null, causeActionId: null,
    wait: null, lastInputHash: null, lastActionHash: null, recentOutcomeIds: [], failure: null, urgency: 0, noProgressCount: 0, goalProgress: {}, dependencies: {}, activeSubmission: null };
}
export function sealDirectState(value: Omit<DirectRuntimeState, "hash"> | DirectRuntimeState): DirectRuntimeState {
  const body = { ...value, hash: "" };
  const hash = contentHash(body);
  assertJsonValue(body, "direct runtime state");
  return Object.assign(structuredClone(body), { hash }) as DirectRuntimeState;
}
export function readDirectState(value: AlgorithmExecutionState, state: Readonly<SimulationState>): DirectRuntimeState {
  const data = value.data as unknown as DirectRuntimeState;
  if (data.kind !== "direct-world" || data.version !== 1 || data.worldHash !== state.worldHash ||
    data.hash !== contentHash({ ...data, hash: "" })) throw new Error("invalid direct runtime state");
  return structuredClone(data);
}
export function readDependency(state: Readonly<SimulationState>, key: string): unknown {
  const [domain, ...parts] = key.split(":"); const id = parts.join(":");
  if (domain === "catalog" && id === "entities") return establishedEntityDirectory(state);
  if (domain === "agent") return state.agents[id] ?? null;
  if (domain === "evidence") return state.agents[id] ? orderedValues(state.agents[id]!.belief.evidence) : null;
  if (domain === "clock") return state.truth.elapsedSeconds;
  if (domain === "collections") return {
    facts: Object.values(state.truth.facts).filter(value => value.subjectId === id).map(value => value.id).sort(),
    quantities: Object.values(state.truth.quantities).filter(value => value.holderId === id).map(value => value.id).sort(),
    conditions: Object.values(state.truth.conditions).filter(value => value.subjectId === id).map(value => value.id).sort(),
  };
  if (domain === "members") {
    // Membership of a local scene is itself a dependency, including previously empty space.
    return Object.keys(state.truth.placements).filter(entityId => state.truth.placements[entityId] === id).sort();
  }
  const table = { entity: state.truth.entities, placement: state.truth.placements, fact: state.truth.facts,
    meter: state.truth.meters, quantity: state.truth.quantities, rating: state.truth.ratings,
    condition: state.truth.conditions, timer: state.truth.timers, pool: state.truth.sharedActivityResourcePools }[domain];
  if (!table) throw new Error(`unknown dependency domain ${domain}`);
  return table[id as keyof typeof table] ?? null;
}
/** World creation's continuity directory, never an Agent or player projection. */
export function establishedEntityDirectory(state: Readonly<SimulationState>) {
  return orderedValues(state.truth.entities).map(entity => ({ id: entity.id, name: entity.name, kind: entity.kind,
    lifecycle: entity.lifecycle, placementId: state.truth.placements[entity.id] ?? null }));
}
export function captureDependencies(state: Readonly<SimulationState>, keys: Iterable<string>): Record<string, string> {
  return Object.fromEntries([...new Set(keys)].sort().map(key => [key, contentHash(readDependency(state, key))]));
}
export function dependencyVersions(control: DirectRuntimeState, reads: Record<string, string>) {
  return Object.fromEntries(Object.entries(reads).map(([key, hash]) => {
    const prior = control.dependencies[key];
    const version = prior ? prior.version + Number(prior.hash !== hash) : 0;
    control.dependencies[key] = { version, hash }; return [key, version];
  }));
}
export function wakeIntent(control: DirectRuntimeState, agentId: string, reason: string, causeActionId: string | null = null) {
  const intent = control.intents[agentId] ??= readyIntent(reason);
  if (intent.status === "active") { if (!intent.wakeReasons.includes(reason)) intent.wakeReasons.push(reason); return; }
  intent.status = "ready"; intent.wait = null; intent.causeActionId = causeActionId;
  if (!intent.wakeReasons.includes(reason)) intent.wakeReasons.push(reason);
}
