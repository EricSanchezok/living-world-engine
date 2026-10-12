import type { SimulationState } from "../contracts/model";
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
