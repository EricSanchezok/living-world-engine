import type { SimulationState, WorldDeltaOperation } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { ProgramResources } from "../programs/definition";
import type { JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { quantityId } from "../runtime/runtime-id";
import type { ProgramActivity } from "./activities";

export type ReadSet = Record<string, { version: number; hash: string }>;

export function programWorldResources(state: Readonly<SimulationState>, definition: WorldRuntimeContract, activities: ProgramActivity[], previous: ProgramResources) {
  const physical = { ...state, executionState: { producerHash: state.executionState?.producerHash ?? "prepared",
    data: { kind: "decision-event", activities: activities as unknown as JsonValue } } } as SimulationState;
  return worldResources(physical, definition, previous);
}

/** This index contains canonical physical truth, never any Agent's private cognition or programs. */
export function worldResources(state: Readonly<SimulationState>, definition: WorldRuntimeContract, previous: ProgramResources = {}): ProgramResources {
  const truth = state.truth;
  const values: Record<string, unknown> = { clock: truth.elapsedSeconds, rng: truth.rng, laws: definition.laws,
    mechanics: truth.mechanics, distributions: definition.randomDistributions,
    entities: truth.entities, placements: truth.placements, facts: truth.facts, meters: truth.meters,
    quantities: truth.quantities, ratings: truth.ratings, conditions: truth.conditions,
    activities: truth.activities, programActivities: state.executionState?.data.kind === "decision-event" ? state.executionState.data.activities ?? [] : [],
    pools: truth.sharedActivityResourcePools, timers: truth.timers,
    events: truth.events, tombstones: truth.factTombstones,
    agentRoster: Object.fromEntries(Object.values(state.agents).map(agent => [agent.id, { entityId: agent.entityId, modelProfiles: agent.modelProfiles }])) };
  for (const [prefix, entries] of Object.entries({ entity: truth.entities, placement: truth.placements, fact: truth.facts,
    meter: truth.meters, quantity: truth.quantities, rating: truth.ratings, condition: truth.conditions,
    activity: truth.activities, pool: truth.sharedActivityResourcePools, timer: truth.timers })) {
    for (const [id, value] of Object.entries(entries)) values[`${prefix}:${id}`] = value;
  }
  for (const law of definition.laws) values[`law:${law.id}`] = law;
  const programActivities = values.programActivities as ProgramActivity[];
  for (const agent of Object.values(state.agents)) values[`program-actor:${agent.entityId}`] = programActivities.filter(activity => activity.actorId === agent.id && activity.status === "active");
  for (const pool of Object.values(truth.sharedActivityResourcePools)) values[`program-pool:${pool.id}`] = programActivities.filter(activity =>
    activity.status === "active" && activity.sharedClaims.some(claim => claim.poolId === pool.id));
  for (const profile of Object.values(truth.mechanics.temporalProfiles)) values[`temporal:${profile.id}`] = profile;
  for (const definitionId of Object.keys(truth.mechanics.quantities)) for (const entityId of Object.keys(truth.entities)) {
    const id = quantityId(state.worldHash, definitionId, entityId); values[`quantity:${id}`] ??= null;
  }
  // Missing individual resources remain versioned tombstones, so absence reads can invalidate.
  for (const key of Object.keys(previous)) if (!Object.hasOwn(values, key)) values[key] = null;
  return Object.fromEntries(Object.entries(values).map(([key, raw]) => {
    const value = JSON.parse(JSON.stringify(raw)) as JsonValue, prior = previous[key];
    return [key, { value, version: prior ? prior.version + Number(contentHash(prior.value) !== contentHash(value)) : 0 }];
  }));
}

export function captureReads(resources: ProgramResources, keys: readonly string[]): ReadSet {
  return Object.fromEntries([...new Set(keys)].sort().map(key => {
    const resource = resources[key]; if (!resource) throw new Error(`undeclared world resource ${key}`);
    return [key, { version: resource.version, hash: contentHash(resource.value) }];
  }));
}

export function validateReads(resources: ProgramResources, reads: ReadSet): void {
  for (const [key, read] of Object.entries(reads)) {
    if (!resources[key] || resources[key].version !== read.version || contentHash(resources[key].value) !== read.hash) {
      throw new Error(`stale world read ${key}`);
    }
  }
}

export function worldProgramSources(definition: WorldRuntimeContract, state: Readonly<SimulationState>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify({ world: { id: definition.id, description: definition.description, contentHash: definition.contentHash },
    mechanics: { packages: definition.rulePackages, catalog: state.truth.mechanics, randomDistributions: definition.randomDistributions },
    ...Object.fromEntries(definition.laws.map(law => [`law:${law.id}`, law])),
    ...Object.fromEntries(Object.values((state.historyBase?.truth ?? state.truth).facts).filter(fact => fact.provenance.some(source => source.kind === "world_seed"))
      .map(fact => [`fact:${fact.id}`, fact])),
  })) as Record<string, JsonValue>;
}

/** Additional mechanical reads cannot be omitted by a generated declaration. */
export function worldOperationReads(state: Readonly<SimulationState>, operation: WorldDeltaOperation): string[] {
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


/** Conservative writes include implicit lifecycle/threshold effects of trusted meters. */
export function worldOperationWrites(state: Readonly<SimulationState>, operation: WorldDeltaOperation): string[] {
  switch (operation.kind) {
    case "create_entity": return [`entity:${operation.entity.id}`, `placement:${operation.entity.id}`];
    case "retire_entity": return [`entity:${operation.entityId}`, "agentRoster", "facts", "conditions", "placements", "activities"];
    case "place_entity": return [`placement:${operation.entityId}`];
    case "set_fact": return [`fact:${operation.fact.id}`, "tombstones"];
    case "remove_fact": return [`fact:${operation.factId}`, "tombstones"];
    case "set_meter": return [`meter:${operation.meter.id}`, `entity:${operation.meter.entityId}`, "facts", "agentRoster"];
    case "adjust_meter": {
      const meter = state.truth.meters[operation.meterId], thresholds = meter && state.truth.mechanics.meters[meter.definitionId]?.thresholds;
      return [`meter:${operation.meterId}`, ...(thresholds?.length ? [`entity:${meter!.entityId}`, "facts", "agentRoster"] : [])];
    }
    case "set_quantity": return [`quantity:${operation.quantity.id}`];
    case "transfer_quantity": return [operation.fromHolderId, operation.toHolderId].map(holder => `quantity:${quantityId(state.worldHash, operation.definitionId, holder)}`);
    case "produce_quantity": case "consume_quantity": return [`quantity:${quantityId(state.worldHash, operation.definitionId, operation.holderId)}`];
    case "set_rating": return [`rating:${operation.rating.id}`];
    case "set_condition": return [`condition:${operation.condition.id}`];
    case "remove_condition": return [`condition:${operation.conditionId}`];
    case "set_shared_activity_resource_capacity": return [`pool:${operation.poolId}`];
    case "create_agent": case "remove_agent": return ["agentRoster"];
    case "advance_time": throw new Error("world programs cannot write the clock");
  }
}
