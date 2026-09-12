import { buildWorldDefinition, type NormalizedWorldTemplate } from "../../src/script/world-loader";
import type { ModelCatalog } from "../../src/engine/models/model-catalog";
import { contentHash } from "../../src/engine/models/model-audit";
import { checkpointWorldTemplate } from "./step-checkpoint-world";
import { assertFiniteWorkWorld, finiteWorkWorldTemplate } from "./step-finite-work-world";

export const INTEGRATED_PLAYER_WORLD_RECIPE = "finite-work-then-short-checkpoints-v1";

/** Shared by preparation and its real loader regression; no model or persisted save mutation. */
export function buildIntegratedPlayerWorld(source: NormalizedWorldTemplate, seed: number, modelCatalog: ModelCatalog) {
  const candidate = checkpointWorldTemplate(finiteWorkWorldTemplate(source));
  assertFiniteWorkWorld(candidate);
  const baseline = buildWorldDefinition(source, { seed, modelCatalog });
  const world = buildWorldDefinition(candidate, { seed, modelCatalog });
  if (Object.keys(world.initialState.agents).length !== 48 ||
    contentHash(world.initialState.agents) !== contentHash(baseline.initialState.agents)) throw new Error("Source Agent set changed");
  return { candidate, baseline, world };
}
