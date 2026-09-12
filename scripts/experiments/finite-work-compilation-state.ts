import type { SimulationState } from "../../src/engine/contracts/model";
import type { WorldDefinition } from "../../src/engine/runtime/world-definition";
import { contentHash } from "../../src/engine/models/model-audit";

/** Counterfactual compiler input only; never persisted or resumed as a gameplay instance. */
export function finiteWorkCompilationState(source: SimulationState, before: WorldDefinition, after: WorldDefinition) {
  if (source.worldHash !== before.contentHash || source.worldId !== after.id || before.id !== after.id ||
    source.step !== 0 || source.history.length !== 0 || source.truth.elapsedSeconds !== 0 || !source.historyBase) {
    throw new Error("finite-work comparison requires the original first-action state and world");
  }
  const oldMechanics = before.initialState.truth.mechanics;
  const nextMechanics = after.initialState.truth.mechanics;
  const profileId = "work-until-objective", calibrationId = "finite-work-objective-time";
  const profile = nextMechanics.temporalProfiles[profileId];
  const calibration = nextMechanics.temporalCalibrations.find(value => value.id === calibrationId);
  if (oldMechanics.temporalProfiles[profileId] || oldMechanics.temporalCalibrations.some(value => value.id === calibrationId) ||
    profile?.kind !== "goal" || profile.checkEverySeconds !== 300 || !calibration || calibration.profileId !== profileId) {
    throw new Error("finite-work comparison lost its declared additions");
  }
  const reversed = structuredClone(nextMechanics);
  delete reversed.temporalProfiles[profileId];
  reversed.temporalCalibrations = reversed.temporalCalibrations.filter(value => value.id !== calibrationId);
  if (contentHash(reversed) !== contentHash(oldMechanics)) throw new Error("candidate changed unrelated mechanics");
  const state = structuredClone(source);
  for (const truth of [state.truth, state.historyBase!.truth]) {
    if (contentHash(truth.mechanics) !== contentHash(oldMechanics)) throw new Error("source mechanics differ from captured definition");
    // Append only the additions, retaining original object and array order.
    truth.mechanics.temporalProfiles[profileId] = structuredClone(profile);
    truth.mechanics.temporalCalibrations.push(structuredClone(calibration));
  }
  state.worldHash = after.contentHash;
  const restored = structuredClone(state);
  restored.worldHash = source.worldHash;
  for (const truth of [restored.truth, restored.historyBase!.truth]) {
    delete truth.mechanics.temporalProfiles[profileId];
    truth.mechanics.temporalCalibrations = truth.mechanics.temporalCalibrations.filter(value => value.id !== calibrationId);
  }
  if (JSON.stringify(restored) !== JSON.stringify(source)) throw new Error("finite-work overlay changed original ordered source");
  return { state, provenance: { kind: "counterfactual-first-action-compilation" as const,
    sourceStateHash: contentHash(source), stateHash: contentHash(state), sourceRevision: source.revision, sourceWorldHash: before.contentHash,
    worldHash: after.contentHash, importedBootstrapCommits: source.bootstrapAgentCommits.length,
    historicalCostsIncludedInLatency: false, gameplayCommit: false } };
}
