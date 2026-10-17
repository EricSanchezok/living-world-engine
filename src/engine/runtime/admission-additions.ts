import type { AdmissionAdditions, SimulationState } from "../contracts/model";
import { agentStateSchema, beliefStateSchema, entitySchema, factSchema, meterSchema, quantityStateSchema, ratingSchema, semanticIdSchema, sharedActivityResourcePoolSchema } from "../contracts/state-schemas";
import { z } from "zod";
import { assertExactKeys } from "./json";
import { quantityId, sharedActivityResourcePoolId } from "./runtime-id";

const bindingSchema = z.record(semanticIdSchema, z.strictObject({
  localEntityId: semanticIdSchema,
  canonicalEntityIds: z.array(semanticIdSchema),
}));

export const admissionAdditionsSchema = z.strictObject({
  entities: z.array(z.strictObject({ entity: entitySchema, placementId: semanticIdSchema.nullable() })),
  agents: z.array(agentStateSchema),
  facts: z.array(factSchema),
  meters: z.array(meterSchema),
  quantities: z.array(quantityStateSchema),
  ratings: z.array(ratingSchema),
  cognition: z.array(z.strictObject({ agentId: semanticIdSchema, belief: beliefStateSchema, bindings: bindingSchema })),
  sharedActivityResourcePools: z.array(sharedActivityResourcePoolSchema),
});

export function emptyAdmissionAdditions(): AdmissionAdditions {
  return { entities: [], agents: [], facts: [], meters: [], quantities: [], ratings: [], cognition: [], sharedActivityResourcePools: [] };
}

function insert<T>(target: Record<string, T>, id: string, value: T, label: string): void {
  semanticIdSchema.parse(id);
  if (Object.hasOwn(target, id)) throw new Error(`admission ${label} collides with ${id}`);
  target[id] = structuredClone(value);
}

/** Apply only to a staged state. Full graph validation belongs to the commit boundary. */
export function applyAdmissionAdditions(state: SimulationState, input: AdmissionAdditions, entrantEntityId: string): void {
  const additions = admissionAdditionsSchema.parse(input);
  const newEntityIds = new Set([entrantEntityId]);
  for (const { entity, placementId } of additions.entities) {
    if (entity.createdAtStep !== state.step || entity.lifecycle !== "active") throw new Error("admission entity must start active at the current step");
    insert(state.truth.entities, entity.id, entity, "entity");
    state.truth.placements[entity.id] = placementId;
    newEntityIds.add(entity.id);
  }
  for (const agent of additions.agents) {
    if (!newEntityIds.has(agent.entityId) || agent.nextAction !== null ||
      Object.values(state.agents).some(existing => existing.entityId === agent.entityId)) throw new Error("admission Agent must uniquely bind a new entity without an action");
    insert(state.agents, agent.id, agent, "Agent");
  }
  for (const fact of additions.facts) insert(state.truth.facts, fact.id, fact, "fact");
  for (const meter of additions.meters) {
    if (!newEntityIds.has(meter.entityId)) throw new Error("admission cannot seed an existing entity's meter");
    insert(state.truth.meters, meter.id, meter, "meter");
  }
  for (const quantity of additions.quantities) {
    if (!newEntityIds.has(quantity.holderId) || quantity.id !== quantityId(state.worldHash, quantity.definitionId, quantity.holderId)) throw new Error("admission quantity must belong to a new entity");
    if (Object.hasOwn(state.truth.quantities, quantity.id)) throw new Error(`admission quantity collides with ${quantity.id}`);
    state.truth.quantities[quantity.id] = structuredClone(quantity);
  }
  for (const rating of additions.ratings) {
    if (!newEntityIds.has(rating.entityId)) throw new Error("admission cannot seed an existing entity's rating");
    insert(state.truth.ratings, rating.id, rating, "rating");
  }
  for (const pool of additions.sharedActivityResourcePools) {
    if (!newEntityIds.has(pool.entityId) || pool.id !== sharedActivityResourcePoolId(state.worldHash, pool.definitionId, pool.entityId) || Object.hasOwn(state.truth.sharedActivityResourcePools, pool.id)) throw new Error("admission shared capacity must belong to a new entity");
    state.truth.sharedActivityResourcePools[pool.id] = structuredClone(pool);
  }
  const recipients = new Set<string>();
  for (const seed of additions.cognition) {
    const agent = state.agents[seed.agentId];
    if (!agent || recipients.has(seed.agentId)) throw new Error(`admission cognition has unknown or repeated Agent ${seed.agentId}`);
    recipients.add(seed.agentId);
    for (const key of ["localEntities", "claims", "evidence"] as const) {
      for (const [id, value] of Object.entries(seed.belief[key])) {
        if (id !== value.id) throw new Error(`admission cognition key differs from identity ${id}`);
        insert(agent.belief[key] as Record<string, unknown>, id, value, `cognition ${key}`);
      }
    }
    for (const [id, binding] of Object.entries(seed.bindings)) {
      assertExactKeys(binding, ["localEntityId", "canonicalEntityIds"], [], "admission binding");
      if (id !== binding.localEntityId) throw new Error(`admission binding key differs from identity ${id}`);
      insert(agent.bindings, id, binding, "binding");
    }
  }
}
