import type { SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import type { JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { ActionFrame, DirectLocalView } from "./contracts";
import { captureDependencies, orderedValues } from "./state";

export function privateActionView(state: Readonly<SimulationState>, agentId: string, causeActionId?: string | null): DirectLocalView {
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
  const causeEvents = causeActionId ? new Set(state.history.flatMap(step => step.events.filter(event =>
    event.causes.some(cause => cause.kind === "action" && cause.id === causeActionId)).map(event => event.id))) : null;
  const view = { agentId: perspective.agentId, elapsedSeconds: perspective.elapsedSeconds, self: perspective.self, mechanics: perspective.mechanics,
    knowledge: perspective.knowledge, character: perspective.character,
    respondingTo: causeEvents ? privateInteractions(state, agentId, entities, causeEvents).at(-1) ?? null : null,
    interactions: privateInteractions(state, agentId, entities) };
  // Delivered evidence remains memory after the observation cursor advances.
  return { state: view as unknown as JsonValue,
    reads: captureDependencies(state, keys), entities };
}

/** Dialogue comes from delivered, retained observations, never another subject's prose or truth. */
function privateInteractions(state: Readonly<SimulationState>, agentId: string, entities: Record<string, string>, eventIds?: ReadonlySet<string>) {
  const agent = state.agents[agentId]!;
  const retained = new Set(Object.values(agent.belief.evidence).map(evidence => evidence.sourceId));
  const self = new Set(Object.entries(entities).filter(([, id]) => id === agent.entityId).map(([id]) => id));
  return state.history.flatMap(step => step.observations.filter(observation => observation.observerId === agentId &&
    retained.has(observation.id) && observation.scene && (!eventIds || observation.sourceEventIds.some(id => eventIds.has(id)))).map(observation => {
    const scene = observation.scene!;
    return { step: observation.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds,
      latest: observation.step === agent.observationCursorStep,
      actor: { localEntityId: scene.actorLocalId ?? null, label: scene.actor },
      relation: scene.actorLocalId && self.has(scene.actorLocalId) ? "self" : scene.action?.target && self.has(scene.action.target.localEntityId)
        ? "addressed_to_self" : scene.action?.addressing === "broadcast" ? "broadcast_heard" : "observed_other_interaction",
      action: scene.action, operation: scene.actionKind, status: scene.status,
      utterance: scene.speech?.utterance ?? null,
      result: scene.actionKind === "speak" ? null : scene.outcome,
      observedDetails: scene.details };
  })).slice(-18);
}

export function localWorldView(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frames: ActionFrame[]): DirectLocalView {
  const ids = new Set(frames.flatMap(frame => [frame.actorEntityId, frame.targetEntityId, frame.toolEntityId].filter((id): id is string => id !== null)));
  for (const frame of frames) if (frame.utterance || ["speak", "transfer", "use", "change", "move"].includes(frame.kind)) {
    for (const agent of Object.values(state.agents)) if (state.truth.placements[agent.entityId] === state.truth.placements[frame.actorEntityId]) ids.add(agent.entityId);
  }
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
