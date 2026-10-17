import type { AdmissionAdditions, AgentCharacterState, AgentState, SimulationState } from "../contracts/model";
import type { WorldCreatedOrigin } from "./world-definition";
import { emptyAdmissionAdditions } from "./admission-additions";
import type { AdmissionCandidateState } from "./admission-impact";
import { quantityId } from "./runtime-id";

export const ORIGIN_PARTICIPANT = "$participant";

export function originAdmissionCandidate(
  state: Readonly<SimulationState>, origin: WorldCreatedOrigin,
  customization: { displayName: string; appearance: string; motivation: string },
): AdmissionCandidateState {
  let ordinal = 1;
  let id: string;
  do id = `${origin.id}-${ordinal++}`; while (state.agents[id] || state.truth.entities[id]);
  const { displayName, appearance, motivation } = customization;
  const agent = agentStateFromOrigin(state, origin, id, displayName, appearance, motivation);
  agent.character = originCharacter(origin, agent.character);
  const profile = state.truth.mechanics.entityMechanicsProfiles[origin.mechanicsProfileId];
  if (!profile) throw new Error(`origin ${origin.id} has no mechanics profile`);
  return {
    entity: { id, kind: origin.entityKind, name: displayName,
      description: appearance ? `${origin.description}\n外观：${appearance}` : origin.description,
      lifecycle: "active", createdAtStep: state.step },
    placementId: origin.spawnEntityId,
    agent,
    meters: profile.meters.map(entry => ({ id: `${id}-${entry.definitionId}`, definitionId: entry.definitionId,
      entityId: id, current: entry.current, firedThresholdIds: [] })),
    quantities: profile.quantities.map(entry => ({ id: quantityId(state.worldHash, entry.definitionId, id),
      definitionId: entry.definitionId, holderId: id, amount: entry.amount })),
    ratings: profile.ratings.map(entry => ({ id: `${id}-${entry.definitionId}`, definitionId: entry.definitionId,
      entityId: id, value: entry.value })),
    conditions: [],
    additions: originAdmissionAdditions(origin, id),
  };
}

/** Substitute typed canonical references, never prose or subject-local identities. */
export function originAdmissionAdditions(origin: WorldCreatedOrigin, participantId: string): AdmissionAdditions {
  const additions = structuredClone(origin.initialization?.additions ?? emptyAdmissionAdditions());
  const resolve = (id: string) => id === ORIGIN_PARTICIPANT ? participantId : id;
  const bindings = (value: AgentState["bindings"]) => {
    for (const binding of Object.values(value)) binding.canonicalEntityIds = binding.canonicalEntityIds.map(resolve);
  };
  for (const entry of additions.entities) {
    if (entry.entity.id === ORIGIN_PARTICIPANT) throw new Error("origin cannot replace its participant entity");
    if (entry.placementId) entry.placementId = resolve(entry.placementId);
  }
  for (const fact of additions.facts) {
    fact.subjectId = resolve(fact.subjectId);
    if (fact.value.kind === "entity") fact.value.entityId = resolve(fact.value.entityId);
    if (fact.access.kind === "agents") fact.access.agentIds = fact.access.agentIds.map(resolve);
  }
  for (const agent of additions.agents) bindings(agent.bindings);
  for (const cognition of additions.cognition) {
    cognition.agentId = resolve(cognition.agentId);
    bindings(cognition.bindings);
  }
  return additions;
}

export function originCharacter(origin: WorldCreatedOrigin, base: AgentCharacterState): AgentCharacterState {
  const character = structuredClone(base);
  for (const field of ["traits", "values", "emotions", "attitudes", "goals", "commitments"] as const) {
    const entries = origin.initialization?.character?.[field];
    for (const [id, value] of Object.entries(entries ?? {})) {
      if (Object.hasOwn(character[field], id)) throw new Error(`origin character collides with ${field}:${id}`);
      (character[field] as Record<string, unknown>)[id] = structuredClone(value);
    }
  }
  return character;
}

export function agentStateFromOrigin(
  state: Readonly<SimulationState>,
  origin: WorldCreatedOrigin,
  agentId: string,
  displayName: string,
  appearance: string,
  motivation: string,
): AgentState {
  const selfId = "self";
  const locationId = "location";
  return {
    id: agentId,
    entityId: agentId,
    modelProfiles: structuredClone(origin.modelProfiles),
    character: {
      persona: {
        summary: appearance ? `${origin.persona}\n外观：${appearance}` : origin.persona,
        voice: "",
        updatedAtStep: state.step,
        evidenceIds: [],
      },
      traits: {},
      values: {},
      emotions: {},
      attitudes: {},
      goals: {
        [`${agentId}-motivation`]: {
          id: `${agentId}-motivation`,
          description: motivation || origin.defaultGoal,
          priority: 0.8,
          progress: 0,
          targetIds: [],
          motivatedByIds: [],
          status: "active",
          createdAtStep: state.step,
          updatedAtStep: state.step,
          evidenceIds: [],
        },
      },
      commitments: {},
    },
    belief: {
      localEntities: {
        [selfId]: {
          id: selfId,
          name: displayName,
          description: appearance || origin.persona,
          status: "observed",
        },
        [locationId]: {
          id: locationId,
          name: state.truth.entities[origin.spawnEntityId].name,
          description: state.truth.entities[origin.spawnEntityId].description,
          status: "observed",
        },
      },
      claims: {},
      evidence: {},
    },
    bindings: {
      [selfId]: { localEntityId: selfId, canonicalEntityIds: [agentId] },
      [locationId]: { localEntityId: locationId, canonicalEntityIds: [origin.spawnEntityId] },
    },
    observationCursorStep: state.step,
    nextAction: null,
  };
}
