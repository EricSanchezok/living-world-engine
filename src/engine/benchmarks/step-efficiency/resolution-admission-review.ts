import { resolutionPlanVerificationSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../models/model-provider";
import { SHARED_BATCH_CONTEXT_CODEC } from "../../mechanics/shared-batch-context";
import { TRUTH_BATCH_REQUEST_CONTRACT, TruthBatchCoordinator } from "../../mechanics/truth-batch-provider";

/** Review the exact requests captured at the actual TruthEngine verifier
 * boundary. No plan generation, repair of plan meaning, RNG, or commit occurs. */
export async function reviewAdmittedResolutionRequests(requests: readonly StructuredModelRequest<unknown>[],
  provider: StructuredModelProvider, options: { maxPhysicalRequests: number;
    onPhysicalRequest?: (request: StructuredModelRequest<unknown>) => void }) {
  if (!requests.length || requests.length > 12 || !Number.isSafeInteger(options.maxPhysicalRequests) || options.maxPhysicalRequests < 1) {
    throw new Error("invalid admission review bounds");
  }
  const plans = requests.map(request => {
    if (request.role !== "causal-verifier" || request.schemaName !== "resolution_plan_verification") throw new Error("unexpected review stage");
    const context = request.context as { state: { candidateResolutionPlans: Array<{ planRef: string; actionRef: string }> } };
    const entries = context.state.candidateResolutionPlans;
    if (!entries.length || entries.some(plan => typeof plan.planRef !== "string" || !plan.planRef.startsWith("ref:plan:") || typeof plan.actionRef !== "string")) throw new Error("invalid admitted plan identities");
    return entries.map(plan => ({ planRef: plan.planRef, actionRef: plan.actionRef }));
  });
  const identities = plans.flat().map(plan => plan.planRef);
  if (new Set(identities).size !== identities.length) throw new Error("duplicate admitted plan identity");
  const before = requests.map(request => contentHash(request.context));
  let physicalRequests = 0;
  const bounded: StructuredModelProvider = { catalog: provider.catalog,
    availableProfileSummaries: role => provider.availableProfileSummaries(role),
    assertProfilesAvailable: ids => provider.assertProfilesAvailable(ids),
    generateStructured: request => {
      if (physicalRequests >= options.maxPhysicalRequests) throw new ModelConfigurationError("admission review physical request ceiling reached");
      physicalRequests++; options.onPhysicalRequest?.(request);
      return provider.generateStructured(request);
    } };
  const coordinator = new TruthBatchCoordinator(bounded, 12, 2, SHARED_BATCH_CONTEXT_CODEC, TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const results = await Promise.allSettled(requests.map(async (request, slot) => {
    const generated = await coordinator.generateStructured(request);
    const review = resolutionPlanVerificationSchema.parse(generated.value);
    const allowed = new Set(plans[slot]!.map(plan => plan.planRef));
    for (const finding of review.findings) {
      if (typeof finding.planRef !== "string" || !allowed.has(finding.planRef)) throw new Error("review finding targets an unassigned plan");
    }
    return { review, audit: generated.audit };
  }));
  if (requests.some((request, slot) => contentHash(request.context) !== before[slot])) throw new Error("review changed bound input");
  const rows = results.map((result, slot) => ({ slot, plans: plans[slot]!, contextHash: before[slot],
    verdict: result.status === "fulfilled" ? result.value.review.verdict : "unknown",
    review: result.status === "fulfilled" ? result.value.review : null,
    audit: result.status === "fulfilled" ? result.value.audit : null,
    error: result.status === "rejected" ? String(result.reason) : null }));
  return { physicalRequests, rows, verdict: rows.some(row => row.verdict === "reject") ? "reject"
    : rows.every(row => row.verdict === "accept") ? "accept" : "unknown", stepCommitted: false,
    limitation: "Existing same-family semantic reviewer, not independent calibrated semantic proof; acceptance only permits a fresh full-world diagnostic." };
}
