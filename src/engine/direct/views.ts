import type { SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import type { JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { ActionFrame, DirectLocalView } from "./contracts";
import { captureDependencies } from "./state";

export function privateActionView(state: Readonly<SimulationState>, agentId: string): DirectLocalView {
  const agent = state.agents[agentId]; if (!agent) throw new Error("unknown decision owner");
  const perspective = projectAgentPerspective(state, agent);
  const evidenceIds = new Set([
    ...Object.values(agent.character.goals).filter(goal => goal.status === "active").flatMap(goal => goal.evidenceIds),
    ...Object.values(agent.character.commitments).filter(commitment => commitment.status === "active").flatMap(commitment => commitment.evidenceIds),
    ...Object.values(agent.belief.claims).flatMap(claim => claim.evidenceIds),
    ...Object.values(agent.belief.evidence).filter(evidence => evidence.step >= agent.observationCursorStep).map(evidence => evidence.id),
  ]);
  const entities = Object.fromEntries(Object.values(agent.bindings).filter(binding => binding.canonicalEntityIds.length === 1 &&
    agent.belief.localEntities[binding.localEntityId]).map(binding => [binding.localEntityId, binding.canonicalEntityIds[0]!]));
  const keys = [`agent:${agentId}`, `entity:${agent.entityId}`, `placement:${agent.entityId}`,
    ...Object.values(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId).map(quantity => `quantity:${quantity.id}`),
    ...Object.values(state.truth.meters).filter(meter => meter.entityId === agent.entityId).map(meter => `meter:${meter.id}`),
    ...Object.values(state.truth.ratings).filter(rating => rating.entityId === agent.entityId).map(rating => `rating:${rating.id}`),
    ...Object.values(state.truth.facts).filter(fact => Object.values(entities).includes(fact.subjectId) &&
      (fact.access.kind === "public" || fact.access.kind === "agents" && fact.access.agentIds.includes(agentId))).map(fact => `fact:${fact.id}`)];
  const view = { agentId: perspective.agentId, self: perspective.self, mechanics: perspective.mechanics,
    knowledge: perspective.knowledge, character: perspective.character };
  return { state: { ...view, knowledge: { ...view.knowledge, evidence: view.knowledge.evidence.filter(evidence => evidenceIds.has(evidence.id)) } } as unknown as JsonValue,
    reads: captureDependencies(state, keys), entities };
}

export function localWorldView(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frames: ActionFrame[]): DirectLocalView {
  const ids = new Set(frames.flatMap(frame => [frame.actorEntityId, frame.targetEntityId, frame.toolEntityId].filter((id): id is string => id !== null)));
  for (const id of [...ids]) {
    let parent = state.truth.placements[id]; const seen = new Set<string>();
    while (parent && !seen.has(parent)) { ids.add(parent); seen.add(parent); parent = state.truth.placements[parent]; }
  }
  const facts = Object.values(state.truth.facts).filter(fact => ids.has(fact.subjectId) || fact.value.kind === "entity" && ids.has(fact.value.entityId));
  const quantities = Object.values(state.truth.quantities).filter(quantity => ids.has(quantity.holderId));
  const meters = Object.values(state.truth.meters).filter(meter => ids.has(meter.entityId));
  const ratings = Object.values(state.truth.ratings).filter(rating => ids.has(rating.entityId));
  const conditions = Object.values(state.truth.conditions).filter(condition => ids.has(condition.subjectId));
  const keys = [...[...ids].flatMap(id => [`entity:${id}`, `placement:${id}`, `members:${id}`]),
    ...facts.map(fact => `fact:${fact.id}`), ...quantities.map(quantity => `quantity:${quantity.id}`),
    ...meters.map(meter => `meter:${meter.id}`), ...ratings.map(rating => `rating:${rating.id}`), ...conditions.map(condition => `condition:${condition.id}`)];
  return { state: { world: { name: definition.name, description: definition.description, laws: definition.laws },
    actions: frames, entities: [...ids].map(id => state.truth.entities[id]), placements: Object.fromEntries([...ids].map(id => [id, state.truth.placements[id]])),
    facts, quantities, meters, ratings, conditions } as unknown as JsonValue,
    reads: captureDependencies(state, keys), entities: Object.fromEntries([...ids].map(id => [id, id])) };
}
