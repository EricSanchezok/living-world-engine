import type { SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import type { JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { ActionFrame, DirectLocalView } from "./contracts";
import { captureDependencies, orderedValues } from "./state";

export function privateActionView(state: Readonly<SimulationState>, agentId: string): DirectLocalView {
  const agent = state.agents[agentId]; if (!agent) throw new Error("unknown decision owner");
  const perspective = projectAgentPerspective(state, agent);
  const entities = Object.fromEntries(Object.values(agent.bindings).sort((a, b) => a.localEntityId.localeCompare(b.localEntityId)).filter(binding => binding.canonicalEntityIds.length === 1 &&
    agent.belief.localEntities[binding.localEntityId]).map(binding => [binding.localEntityId, binding.canonicalEntityIds[0]!]));
  const keys = ["clock", `agent:${agentId}`, `entity:${agent.entityId}`, `placement:${agent.entityId}`, `collections:${agent.entityId}`,
    ...Object.values(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId).map(quantity => `quantity:${quantity.id}`),
    ...Object.values(state.truth.meters).filter(meter => meter.entityId === agent.entityId).map(meter => `meter:${meter.id}`),
    ...Object.values(state.truth.ratings).filter(rating => rating.entityId === agent.entityId).map(rating => `rating:${rating.id}`),
    ...Object.values(state.truth.facts).filter(fact => Object.values(entities).includes(fact.subjectId) &&
      (fact.access.kind === "public" || fact.access.kind === "agents" && fact.access.agentIds.includes(agentId))).map(fact => `fact:${fact.id}`)];
  const view = { agentId: perspective.agentId, elapsedSeconds: perspective.elapsedSeconds, self: perspective.self, mechanics: perspective.mechanics,
    knowledge: perspective.knowledge, character: perspective.character };
  // Delivered evidence remains memory after the observation cursor advances.
  return { state: view as unknown as JsonValue,
    reads: captureDependencies(state, keys), entities };
}

export function localWorldView(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frames: ActionFrame[]): DirectLocalView {
  const ids = new Set(frames.flatMap(frame => [frame.actorEntityId, frame.targetEntityId, frame.toolEntityId].filter((id): id is string => id !== null)));
  for (const frame of frames.filter(frame => frame.kind === "observe" && frame.observationScope !== "inventory")) {
    const focus = frame.targetEntityId && frame.targetEntityId !== frame.actorEntityId ? frame.targetEntityId : state.truth.placements[frame.actorEntityId];
    if (focus) for (const [id, placement] of Object.entries(state.truth.placements).sort(([a], [b]) => a.localeCompare(b))) if (placement === focus) ids.add(id);
  }
  for (const id of [...ids]) {
    let parent = state.truth.placements[id]; const seen = new Set<string>();
    while (parent && !seen.has(parent)) { ids.add(parent); seen.add(parent); parent = state.truth.placements[parent]; }
  }
  const facts = orderedValues(state.truth.facts).filter(fact => ids.has(fact.subjectId) || fact.value.kind === "entity" && ids.has(fact.value.entityId));
  const quantities = orderedValues(state.truth.quantities).filter(quantity => ids.has(quantity.holderId));
  const meters = orderedValues(state.truth.meters).filter(meter => ids.has(meter.entityId));
  const ratings = orderedValues(state.truth.ratings).filter(rating => ids.has(rating.entityId));
  const conditions = orderedValues(state.truth.conditions).filter(condition => ids.has(condition.subjectId));
  const keys = [...frames.map(frame => `evidence:${frame.actorId}`), ...[...ids].flatMap(id => [`entity:${id}`, `placement:${id}`, `members:${id}`, `collections:${id}`]),
    ...facts.map(fact => `fact:${fact.id}`), ...quantities.map(quantity => `quantity:${quantity.id}`),
    ...meters.map(meter => `meter:${meter.id}`), ...ratings.map(rating => `rating:${rating.id}`), ...conditions.map(condition => `condition:${condition.id}`)];
  return { state: { world: { name: definition.name, description: definition.description, laws: definition.laws },
    actions: frames, deliveredEvidence: Object.fromEntries(frames.map(frame => [frame.actorId, orderedValues(state.agents[frame.actorId]!.belief.evidence)])),
    entities: [...ids].map(id => state.truth.entities[id]), placements: Object.fromEntries([...ids].map(id => [id, state.truth.placements[id]])),
    facts, quantities, meters, ratings, conditions } as unknown as JsonValue,
    reads: captureDependencies(state, keys), entities: Object.fromEntries([...ids].map(id => [id, id])) };
}
