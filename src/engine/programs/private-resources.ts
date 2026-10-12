import type { AgentPerspectiveView } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";
import type { ProgramResources, VersionedResource } from "./definition";

export interface PrivateResourceSnapshot { ownerId: string; resources: Record<string, VersionedResource> }
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

/** Only an already authorized perspective enters this boundary. Global revision changes do not invalidate local facts. */
export function privateProgramResources(view: AgentPerspectiveView, previous?: PrivateResourceSnapshot): PrivateResourceSnapshot {
  if (previous && previous.ownerId !== view.agentId) throw new Error("private resources cannot change owner");
  const values: Record<string, JsonValue> = {
    self: json(view.self), clock: view.elapsedSeconds, mechanics: json(view.mechanics),
    entities: json(view.knowledge.entities), containment: json(view.knowledge.containment), facts: json(view.knowledge.exactFacts),
    claims: json(view.knowledge.claims), evidence: json(view.knowledge.evidence), persona: json(view.character.persona),
    traits: json(view.character.traits), values: json(view.character.values), emotions: json(view.character.emotions),
    attitudes: json(view.character.attitudes), goals: json(view.character.goals), commitments: json(view.character.commitments),
    observations: json(view.history.filter(turn => turn.ownAction !== null || turn.observations.length || turn.resolutions.length)),
  };
  for (const entity of view.knowledge.entities) values[`entity:${entity.localEntityId ?? entity.ref}`] = json(entity);
  for (const claim of view.knowledge.claims) values[`claim:${claim.id}`] = json(claim);
  for (const evidence of view.knowledge.evidence) values[`evidence:${evidence.id}`] = json(evidence);
  for (const goal of Object.values(view.character.goals)) values[`goal:${goal.id}`] = json(goal);
  for (const collection of ["traits", "values", "emotions", "attitudes", "commitments"] as const) {
    for (const [id, value] of Object.entries(view.character[collection])) values[`${collection}:${id}`] = json(value);
  }
  const resources: Record<string, VersionedResource> = {};
  for (const key of new Set([...Object.keys(previous?.resources ?? {}), ...Object.keys(values)])) {
    const value = values[key] ?? null, old = previous?.resources[key];
    resources[key] = { value, version: old ? old.version + (contentHash(old.value) === contentHash(value) ? 0 : 1) : 0 };
  }
  return { ownerId: view.agentId, resources };
}

export function resourceValues(resources: ProgramResources): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(resources).map(([key, resource]) => [key, resource.value]));
}

export function privateProgramSources(view: AgentPerspectiveView): Record<string, JsonValue> {
  return { persona: json(view.character.persona),
    ...Object.fromEntries(Object.values(view.character.goals).map(goal => [`goal:${goal.id}`, json(goal)])),
    ...Object.fromEntries(view.knowledge.evidence.map(evidence => [`evidence:${evidence.id}`, json(evidence)])),
    ...Object.fromEntries((["traits", "values", "emotions", "attitudes", "commitments"] as const)
      .flatMap(collection => Object.entries(view.character[collection]).map(([id, value]) => [`${collection}:${id}`, json(value)]))),
  };
}

export function privateProgramEntityIds(view: AgentPerspectiveView): string[] {
  return view.knowledge.entities.flatMap(entity => entity.targetable && entity.localEntityId ? [entity.localEntityId] : []);
}
