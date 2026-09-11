import { ACTIVITY_TEMPORAL_EVIDENCE, ACTIVITY_TEMPORAL_NOTICE } from "../contracts/activity-temporal-evidence";
import { contentHash } from "../models/model-audit";
import type { StructuredModelProvider } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { flatPlanBatchProvider, FLAT_RESOLUTION_PLAN_BATCH } from "./flat-resolution-plan-batch";
import { physicalPlanningWorklistProvider, PHYSICAL_PLANNING_WORKLIST } from "./physical-planning-worklist";
import { planSelectorProvider, PLAN_SOURCE_SELECTORS } from "./plan-source-selectors";
import { factorTypesProvider, RESOLUTION_FACTOR_TYPES } from "./resolution-factor-types";
import { sourceBoundPlanChoicesProvider, SOURCE_BOUND_PLAN_CHOICES } from "./source-bound-plan-choices";

export const WORKLIST_PLANNING_PIPELINE = "source-bound-worklist-v1";
export const WORKLIST_PLANNING_PROMPT_VERSION = contentHash({
  order: [RESOLUTION_FACTOR_TYPES, PLAN_SOURCE_SELECTORS, FLAT_RESOLUTION_PLAN_BATCH, SOURCE_BOUND_PLAN_CHOICES, PHYSICAL_PLANNING_WORKLIST],
  temporal: { contract: ACTIVITY_TEMPORAL_EVIDENCE, instruction: ACTIVITY_TEMPORAL_NOTICE },
  instructions: ["shared/resolution-factor-types.md", "shared/plan-source-selectors.md", "shared/flat-resolution-plan-batch.md",
    "shared/source-bound-plan-choices.md", "shared/physical-planning-worklist.md"].map(asset => loadPromptAsset(asset)),
});

/** Physical planning only; dependent-field encoding remains the outer representation. */
export function worklistPlanningProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return factorTypesProvider(planSelectorProvider(flatPlanBatchProvider(sourceBoundPlanChoicesProvider(physicalPlanningWorklistProvider(inner)))));
}
