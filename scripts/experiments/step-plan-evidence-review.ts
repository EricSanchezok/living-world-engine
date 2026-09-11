import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { resolutionPlanVerificationSchema } from "../../src/engine/contracts/llm-schemas";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { reviewAdmittedResolutionRequests } from "../../src/engine/benchmarks/step-efficiency/resolution-admission-review";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { resolveModelProfile } from "../../src/engine/models/model-registry";
import { prepareCatalogOrderProbe } from "./step-catalog-order-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { runAdmittedPlanReview } from "./step-admitted-plan-review";

const sourceTrial = "probes-e2-plan-evidence-01";
const sourceManifestHash = "aac4ac662a691863229e97b5b06b27bb6cb8500b11c1700eb54aa9a6f72bc3b0";
const resultHashes = { "016": "fe5cbe472be10d82ae0e1f99dd459dbc6285033a9483e51acc0c3b22bbcf70c0",
  "017": "afa172924fe7ada4521c6a7f4e13fb66ded164826a932ca3c1ced2f362d52696" };

export function restoreCapturedPlanVerifier(evidence: ReturnType<typeof admissionRequestEvidence>): StructuredModelRequest<unknown> {
  if (evidence.role !== "causal-verifier" || evidence.schemaName !== "resolution_plan_verification" ||
    contentHash(evidence.schema) !== contentHash(z.toJSONSchema(resolutionPlanVerificationSchema, { target: "draft-07" }))) throw new Error("captured verifier stage or schema changed");
  const execution = z.object({ instanceId: z.string().min(1), advanceId: z.string().min(1) }).parse((evidence.context as { execution?: unknown }).execution);
  const request: StructuredModelRequest<unknown> = { workloadId: execution.instanceId, batchId: execution.advanceId,
    profileId: evidence.profileId, role: evidence.role, subjectId: evidence.subjectId, schemaName: evidence.schemaName,
    promptVersion: evidence.promptVersion, system: evidence.system, userPrompt: evidence.userPrompt, context: structuredClone(evidence.context),
    schema: resolutionPlanVerificationSchema, ...(evidence.modelRegistrySnapshotHash ? { modelRegistrySnapshotHash: evidence.modelRegistrySnapshotHash } : {}) };
  // The capture must be the actual logical verifier contract, without a
  // transport transformation, parser, or invented example policy added here.
  if (contentHash(admissionRequestEvidence(request)) !== contentHash(evidence)) throw new Error("captured verifier request cannot be restored losslessly");
  return request;
}

export async function preparePlanEvidenceReview(rootId: "016" | "017") {
  const trialId = `review-e2-plan-evidence-${rootId}`;
  const root = path.resolve(STEP_E2_PROTOCOL.root), directory = path.join(root, "runs", sourceTrial);
  const sourceManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"));
  const admitted = JSON.parse(gunzipSync(readFileSync(path.join(directory, `${rootId}-C-result.json.gz`))).toString());
  if (contentHash(sourceManifest) !== sourceManifestHash || contentHash(admitted) !== resultHashes[rootId] ||
    report.status !== "completed" || report.decision !== "eligible-for-source-semantic-review" || !admitted.result.firstHttpComplete) throw new Error("frozen source admission did not pass or changed");
  const prepared = await prepareCatalogOrderProbe();
  const selected = prepared.cases.find(value => value.id === rootId)!;
  if (admitted.result.sourceHash !== contentHash(selected.source) || sourceManifest.catalogHash !== prepared.catalog.hash ||
    sourceManifest.registrySnapshotHash !== prepared.snapshot.hash) throw new Error("source snapshot or registry mismatch");
  const captures = (admitted.verifierRequests as Array<{ slot: number; request: ReturnType<typeof admissionRequestEvidence> }>).toSorted((a, b) => a.slot - b.slot);
  if (captures.length !== selected.slots || captures.some((value, slot) => value.slot !== slot ||
    contentHash(value.request.context) !== contentHash(admitted.result.rows[slot].verifierContext))) throw new Error("verifier capture scope changed");
  const requests = captures.map(value => restoreCapturedPlanVerifier(value.request));
  const plans = requests.flatMap(request => (request.context as { state: { candidateResolutionPlans: unknown[] } }).state.candidateResolutionPlans);
  if (plans.length !== selected.actions) throw new Error("verifier plan cardinality changed");
  const profile = resolveModelProfile(prepared.catalog, prepared.snapshot, selected.source.definition.modelProfiles.causalVerifier);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled" ||
    profile.profile.max_output_tokens !== STEP_E2_PROTOCOL.outputTokenCeiling || requests.some(request => request.profileId !== profile.profileId)) throw new Error("review model binding changed");
  const physical: ReturnType<typeof admissionRequestEvidence>[] = [];
  await reviewAdmittedResolutionRequests(requests, { catalog: prepared.catalog, availableProfileSummaries: role => prepared.catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline review capture"); } },
  { maxPhysicalRequests: 1, onPhysicalRequest: request => physical.push(admissionRequestEvidence(request)) });
  if (physical.length !== 1) throw new Error("original review root batch changed");
  const manifest = { trialId, sourceTrialId: sourceTrial, sourceManifestHash, sourceResultHash: resultHashes[rootId],
    sourceHash: contentHash(selected.source), stateHash: contentHash(selected.source.state), catalogHash: prepared.catalog.hash,
    registrySnapshotHash: prepared.snapshot.hash, profileId: profile.profileId, model: profile.modelId, inference: profile.profile.inference,
    slots: selected.slots, actions: selected.actions, maxHttp: 3,
    maximumRunNanoCny: 3 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    requestHashes: requests.map(request => contentHash(admissionRequestEvidence(request))), initialPhysicalRequestHash: contentHash(physical[0]),
    acceptance: "Review the complete original root using exact logical requests captured at the actual TruthEngine verifier boundary. All source/result/schema/context hashes and slot/plan identities must match. Retain full state, original actions and fixed admitted plans. Existing runtime verifier prompt/schema/batch policy, disabled-thinking Flash, no generation of new plans, no plan-meaning repair, no transport retry, RNG or commit. At most three actual HTTP including structural repair; every call and unknown billing remains in E2. Any reject or unknown blocks promotion. Both 016 and 017 reviews must pass before a separately frozen full-world diagnostic. Source-bound same-family uncalibrated reviewer is limited evidence, not independent semantic proof or gameplay acceptance. Historical results remain intact; no reviewer tuning against captured plans.",
  };
  return { ...prepared, requests, manifest };
}

async function main() {
  const [rootId, ...args] = process.argv.slice(2);
  if (rootId !== "016" && rootId !== "017") throw new Error("usage: step-plan-evidence-review.ts 016|017 [prepare]");
  const trialId = `review-e2-plan-evidence-${rootId}`;
  if (existsSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", trialId))) throw new Error("frozen review cannot restart");
  await runAdmittedPlanReview({ trialId, prepare: () => preparePlanEvidenceReview(rootId) }, args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
