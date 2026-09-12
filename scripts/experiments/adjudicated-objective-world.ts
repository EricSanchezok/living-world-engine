import type { SimulationState } from "../../src/engine/contracts/model";
import type { WorldDefinition } from "../../src/engine/runtime/world-definition";
import { contentHash } from "../../src/engine/models/model-audit";
import { parseWorldTemplate, type NormalizedWorldTemplate } from "../../src/script/world-loader";

export const ADJUDICATED_OBJECTIVE_PROFILES = ["wait-until", "travel-until-arrival"] as const;

/** Explicit world experiment: preserve every field except the selected authored kind. */
export function adjudicatedObjectiveWorld(source: NormalizedWorldTemplate, ids: readonly string[]): NormalizedWorldTemplate {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("unique objective profile selection required");
  const candidate = structuredClone(source);
  for (const id of ids) {
    const index = candidate.mechanics.temporal_profiles.findIndex(row => row.id === id);
    const profile = candidate.mechanics.temporal_profiles[index];
    if (!profile || profile.kind !== "conditional") throw new Error(`objective profile must be conditional: ${id}`);
    candidate.mechanics.temporal_profiles[index] = { ...profile, kind: "goal" };
  }
  const validated = parseWorldTemplate(candidate), reversed = structuredClone(validated);
  for (const profile of reversed.mechanics.temporal_profiles) if (ids.includes(profile.id)) profile.kind = "conditional";
  if (JSON.stringify(reversed) !== JSON.stringify(source)) throw new Error("objective world changed unrelated ordered fields");
  return validated;
}

/** A compiler counterfactual, never a save migration or a gameplay resume. */
export function adjudicatedObjectiveState(source: SimulationState, before: WorldDefinition, after: WorldDefinition, ids: readonly string[]) {
  if (source.worldHash !== before.contentHash || source.worldId !== after.id || before.id !== after.id ||
    source.step !== 0 || source.history.length !== 0 || source.truth.elapsedSeconds !== 0 || !source.historyBase ||
    !ids.length || new Set(ids).size !== ids.length) throw new Error("objective comparison requires the original first-action state");
  const oldMechanics = before.initialState.truth.mechanics, nextMechanics = after.initialState.truth.mechanics;
  const reversed = structuredClone(nextMechanics);
  for (const id of ids) {
    if (oldMechanics.temporalProfiles[id]?.kind !== "conditional" || nextMechanics.temporalProfiles[id]?.kind !== "goal") {
      throw new Error(`objective kind binding differs: ${id}`);
    }
    (reversed.temporalProfiles[id] as { kind: string }).kind = "conditional";
  }
  if (contentHash(reversed) !== contentHash(oldMechanics)) throw new Error("objective world changed unrelated mechanics");
  const state = structuredClone(source);
  for (const truth of [state.truth, state.historyBase!.truth]) {
    if (contentHash(truth.mechanics) !== contentHash(oldMechanics)) throw new Error("source mechanics differ from bound world");
    for (const id of ids) (truth.mechanics.temporalProfiles[id] as { kind: string }).kind = "goal";
  }
  state.worldHash = after.contentHash;
  const restored = structuredClone(state);
  restored.worldHash = source.worldHash;
  for (const truth of [restored.truth, restored.historyBase!.truth]) {
    for (const id of ids) (truth.mechanics.temporalProfiles[id] as { kind: string }).kind = "conditional";
  }
  if (JSON.stringify(restored) !== JSON.stringify(source)) throw new Error("objective overlay changed unrelated ordered source");
  return { state, provenance: { kind: "counterfactual-adjudicated-objectives", profileIds: [...ids],
    sourceStateHash: contentHash(source), stateHash: contentHash(state), sourceWorldHash: before.contentHash,
    worldHash: after.contentHash, importedBootstrapCommits: source.bootstrapAgentCommits.length,
    gameplayCommit: false, savedStateMigration: false } };
}
