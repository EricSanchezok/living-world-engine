import { RESOLUTION_SOURCE_ROLE_CONTRACT, resolutionSourceRoleRequest } from "./resolution-source-role-contract";
import { contentHash } from "../models/model-audit";
import type { StructuredModelProvider } from "../models/model-provider";
import { loadPromptAsset, promptBundle } from "../prompts";
import { SOURCE_INDEXED_PLANNING, sourceIndexedPlanningProvider } from "./source-indexed-planning";
import { WORKLIST_PLANNING_PROMPT_VERSION, worklistPlanningProvider } from "./worklist-planning-pipeline";

import { SOURCE_INDEXED_TRANSITION, indexedTransitionProvider } from "./source-indexed-transition";
import { CANONICAL_TRANSITION_EVIDENCE, TRANSITION_EVIDENCE_WORKLIST, transitionEvidenceWorklistProvider } from "./transition-evidence-worklist";
import { SHARED_CATALOG_PREFIX_CODEC } from "./shared-catalog-prefix";
import { SHARED_CATALOG_RECORDS_CODEC } from "./shared-catalog-records";
import { CANONICAL_SPARSE_ARRAYS, canonicalSparseArraysRequest } from "./canonical-sparse-arrays";
import { eventOutcomeSummaryRequest } from "./event-outcome-summaries";
import { boundaryClockWitnessRequest } from "./boundary-clock-witness";
import { planningContractTailRequest } from "./planning-contract-tail";
import { sourceIndexedPlanCausesRequest } from "./source-indexed-plan-causes";
import { planningRelationChoicesRequest } from "./planning-relation-choices";
import { compactPlanningRecordsRequest } from "./compact-planning-records";

export const INDEXED_REVIEWED_PLANNING_PIPELINE = "source-indexed-reviewed-v5";
export const INDEXED_REVIEWED_PLANNING_PROMPT_VERSION = contentHash({
  sourceRoles: RESOLUTION_SOURCE_ROLE_CONTRACT,
  worklist: WORKLIST_PLANNING_PROMPT_VERSION, indexing: SOURCE_INDEXED_PLANNING,
  verifier: promptBundle("resolution-plan-verifier").version,
  transition: { prompt: promptBundle("truth-transition").version, indexing: SOURCE_INDEXED_TRANSITION,
    worklist: TRANSITION_EVIDENCE_WORKLIST, canonical: CANONICAL_TRANSITION_EVIDENCE, sparse: CANONICAL_SPARSE_ARRAYS, catalogPrefix: SHARED_CATALOG_PREFIX_CODEC, catalogRecords: SHARED_CATALOG_RECORDS_CODEC },
  instructions: ["shared/resolution-source-role-exclusivity.md", "shared/source-indexed-planning.md", "shared/plan-review-source-intent.md", "shared/source-indexed-transition.md", "shared/transition-evidence-worklist.md", "shared/canonical-transition-evidence.md", "shared/canonical-sparse-arrays.md"].map(asset => loadPromptAsset(asset)),
});

/** Indexed planning and mechanical transition codecs retain the existing logical verification and repair path. */
export function indexedReviewedPlanningProvider(inner: StructuredModelProvider, eventOutcomeSummaries = false, boundaryClockWitness = false, planCauseChoices = false, planMeansChoices = false, planningContractTail = false, planningRelationChoices = false, compactPlanningRecords = false): StructuredModelProvider {
  const sparse: StructuredModelProvider = {
    catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    generateStructured: request => {
      const adapted = canonicalSparseArraysRequest(planCauseChoices ? sourceIndexedPlanCausesRequest(request) : request);
      const narrated = eventOutcomeSummaries ? eventOutcomeSummaryRequest(adapted) : adapted;
      const timed = boundaryClockWitness ? boundaryClockWitnessRequest(narrated) : narrated;
      const tailed = planningContractTail ? planningContractTailRequest(timed) : timed;
      const related = planningRelationChoices ? planningRelationChoicesRequest(tailed) : tailed;
      return inner.generateStructured(compactPlanningRecords ? compactPlanningRecordsRequest(related) : related);
    },
  };
  const provider = worklistPlanningProvider(sourceIndexedPlanningProvider(indexedTransitionProvider(transitionEvidenceWorklistProvider(sparse)), planMeansChoices));
  return {
    catalog: provider.catalog, availableProfileSummaries: role => provider.availableProfileSummaries(role),
    assertProfilesAvailable: ids => provider.assertProfilesAvailable(ids),
    generateStructured: request => provider.generateStructured(resolutionSourceRoleRequest(request)),
  };
}
