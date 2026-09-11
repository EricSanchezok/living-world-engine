import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { reviewAdmittedResolutionRequests } from "../../src/engine/benchmarks/step-efficiency/resolution-admission-review";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { resolveModelProfile } from "../../src/engine/models/model-registry";
import { prepareIndexedPlanningProbe } from "./step-indexed-planning-probe";
import { restoreCapturedPlanVerifier } from "./step-plan-evidence-review";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { runAdmittedPlanReview } from "./step-admitted-plan-review";

const sourceTrial = "probes-e2-indexed-planning-01";
const sourceManifestHash = "75ed9b7ffcdcdd4d24efd508e3f161375c120f1e5ee1cec3ca2f805da8786742";
const resultHashes = { "045": "194040c2fda78f25c45649728f7aa8adf952d17d6272925e2b8e53647c8e0dde",
  "003": "90d1c28fd3c46709dc95bb42f8c110f1ba619588a14b802b77bc385cfeba29e2" };

export async function prepareIndexedPlanReview(rootId: "045" | "003") {
  const trialId = `review-e2-indexed-${rootId}`;
  const root = path.resolve(STEP_E2_PROTOCOL.root), directory = path.join(root, "runs", sourceTrial);
  const sourceManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"));
  const admitted = JSON.parse(gunzipSync(readFileSync(path.join(directory, `${rootId}-I-result.json.gz`))).toString());
  if (contentHash(sourceManifest) !== sourceManifestHash || contentHash(admitted) !== resultHashes[rootId] ||
    report.status !== "completed" || report.decision !== "eligible-for-source-semantic-review-no-comparative-claim" || !admitted.result.complete) throw new Error("frozen source admission did not pass or changed");
  const prepared = await prepareIndexedPlanningProbe();
  const selected = prepared.cases.find(value => value.id === rootId)!;
  if (admitted.result.sourceHash !== contentHash(selected.source) || sourceManifest.catalogHash !== prepared.catalog.hash ||
    sourceManifest.registrySnapshotHash !== prepared.snapshot.hash) throw new Error("source snapshot or registry mismatch");
  const captures = (admitted.verifierRequests as Array<{ slot: number; request: ReturnType<typeof admissionRequestEvidence> }>).toSorted((a, b) => a.slot - b.slot);
  if (captures.length !== selected.slots || captures.some((value, slot) => value.slot !== slot ||
    contentHash(value.request.context) !== contentHash(admitted.result.rows[slot].verifierContext))) throw new Error("verifier capture scope changed");
  const requests = captures.map(value => restoreCapturedPlanVerifier(value.request));
  const plans = requests.flatMap(request => (request.context as { state: { candidateResolutionPlans: unknown[] } }).state.candidateResolutionPlans);
  if (plans.length !== selected.assigned) throw new Error("verifier plan cardinality changed");
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
    slots: selected.slots, actions: selected.assigned, maxHttp: 3,
    maximumRunNanoCny: 3 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    requestHashes: requests.map(request => contentHash(admissionRequestEvidence(request))), initialPhysicalRequestHash: contentHash(physical[0]),
    acceptance: "Review the complete latest 045/003 source roots using exact requests captured at the actual TruthEngine verifier boundary. All source/result/schema/context hashes and slot/plan identities must match. Retain full state, original actions, temporal evidence and fixed admitted plans. The045 first call admitted43/45; one bounded repair recovered the other2. The003 first call admitted3/3. Preserve those failures and costs separately. All48 plans are automatic with null effects; this is not itself semantic success. Check original meaning, supported means, conditions, audience, target alignment and temporal boundaries using the unchanged existing verifier prompt and schema. No new planning, plan-meaning repair, prompt tuning, transport retry, RNG or world commit. Disabled-thinking Flash and original review batching remain fixed. At most3 actual HTTP per root including structural repair; all billing enters E2. Any reject or unknown blocks promotion. Both reviews must pass before a separate fresh full-world diagnostic. Same-family uncalibrated acceptance is limited evidence and cannot certify gameplay or prove that ongoing actions make real progress; committed trajectories require source-bound behavioral checks.",
  };
  return { ...prepared, requests, manifest };
}

async function main() {
  const [rootId, ...args] = process.argv.slice(2);
  if (rootId !== "045" && rootId !== "003") throw new Error("usage: step-indexed-plan-review.ts 045|003 [prepare]");
  const trialId = `review-e2-indexed-${rootId}`;
  if (existsSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", trialId))) throw new Error("frozen review cannot restart");
  await runAdmittedPlanReview({ trialId, prepare: async () => {
    const prepared = await prepareIndexedPlanReview(rootId);
    if (args[0] === "prepare") prepared.registry.stopBackgroundRefresh();
    return prepared;
  } }, args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
