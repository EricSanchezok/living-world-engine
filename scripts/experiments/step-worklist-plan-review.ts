import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { reviewAdmittedResolutionRequests } from "../../src/engine/benchmarks/step-efficiency/resolution-admission-review";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { resolveModelProfile } from "../../src/engine/models/model-registry";
import { prepareVisibleTargetProbe } from "./step-visible-target-probe";
import { restoreCapturedPlanVerifier } from "./step-plan-evidence-review";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { runAdmittedPlanReview } from "./step-admitted-plan-review";

const sourceTrial = "probes-e2-worklist-recovery-01";
const sourceManifestHash = "841394c253c236c77c22ba627a576743f0274310e46dec7838b1bf57963dc9bb";
const resultHashes = { "041": "582c00ebbd498a8cce7f692313ff43263345724451110da891f4767a5d4ae0b6",
  "007": "bc7660fc69f6b6958c0b138cfd0b387274c48f0484371caa1d7503dcbf9c4c14" };

export async function prepareWorklistPlanReview(rootId: "041" | "007") {
  const trialId = `review-e2-worklist-${rootId}`;
  const root = path.resolve(STEP_E2_PROTOCOL.root), directory = path.join(root, "runs", sourceTrial);
  const sourceManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"));
  const admitted = JSON.parse(gunzipSync(readFileSync(path.join(directory, `${rootId}-result.json.gz`))).toString());
  if (contentHash(sourceManifest) !== sourceManifestHash || contentHash(admitted) !== resultHashes[rootId] ||
    report.status !== "completed" || report.decision !== "eligible-for-source-semantic-review" || !admitted.result.complete) throw new Error("frozen source admission did not pass or changed");
  const prepared = await prepareVisibleTargetProbe();
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
    acceptance: "Review the complete original root using exact logical requests captured at the actual TruthEngine verifier boundary. All source/result/schema/context hashes and slot/plan identities must match. Retain full state, original actions, explicit temporal execution evidence and fixed admitted plans. The source first-call worklist trial failed; its separately frozen recovery retained 40/41 first plans and repaired only the failed slot with one new HTTP. Do not recast that as first-call success. Check the full meaning of every action including means evidence, future conditions, audience and interval limits; automatic/null effect alone proves neither safety nor fidelity. Existing runtime verifier prompt/schema/batch policy, disabled-thinking Flash, no generation of new plans, no plan-meaning repair, no transport retry, RNG or commit. At most three actual HTTP including structural repair; every call and unknown billing remains in E2. Any reject or unknown blocks promotion. Both 041 and 007 reviews must pass before a separately frozen full-world diagnostic. Source-bound same-family uncalibrated reviewer is limited evidence, not independent semantic proof or gameplay acceptance. Historical results remain intact; no reviewer tuning against captured plans.",
  };
  return { ...prepared, requests, manifest };
}

async function main() {
  const [rootId, ...args] = process.argv.slice(2);
  if (rootId !== "041" && rootId !== "007") throw new Error("usage: step-worklist-plan-review.ts 041|007 [prepare]");
  const trialId = `review-e2-worklist-${rootId}`;
  if (existsSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", trialId))) throw new Error("frozen review cannot restart");
  await runAdmittedPlanReview({ trialId, prepare: async () => {
    const prepared = await prepareWorklistPlanReview(rootId);
    if (args[0] === "prepare") prepared.registry.stopBackgroundRefresh();
    return prepared;
  } }, args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
