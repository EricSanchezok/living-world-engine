import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { createPlanReviewControls } from "../../src/engine/benchmarks/step-efficiency/plan-review-controls";
import { sourceIntentReviewRequest } from "../../src/engine/mechanics/plan-review-ownership";
import { reviewAdmittedResolutionRequests } from "../../src/engine/benchmarks/step-efficiency/resolution-admission-review";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelConfigurationError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { runAdmittedPlanReview } from "./step-admitted-plan-review";

const root = path.resolve(STEP_E2_PROTOCOL.root);
const trialId = (arm: "B" | "C") => `review-e2-source-intent-${arm.toLowerCase()}-01`;
const perArmMaximum = 3 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken +
  STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken);

export async function prepareOwnershipReview(arm: "B" | "C") {
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-07/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/finite-work-goal-02/model-catalog.json"));
  if (catalog.hash !== history.catalogHash) throw new Error("review catalog changed");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("registry refresh forbidden"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const controls = createPlanReviewControls(catalog);
  const profile = resolveModelProfile(catalog, snapshot, controls[0]!.request.profileId);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled" ||
    profile.profile.max_output_tokens !== STEP_E2_PROTOCOL.outputTokenCeiling) throw new Error("review inference binding changed");
  const requests = controls.map(control => ({ ...(arm === "C" ? sourceIntentReviewRequest(control.request) : control.request),
    modelRegistrySnapshotHash: snapshot.hash }));
  const physical: StructuredModelRequest<unknown>[] = [];
  await reviewAdmittedResolutionRequests(requests, { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline request capture"); } },
  { maxPhysicalRequests: 1, onPhysicalRequest: request => physical.push(request) });
  if (physical.length !== 1) throw new Error("twelve control slots did not form one physical request");
  const labels = controls.map(({ id, expected, violation, stateHash, sourceHash }) => ({ id, expected, violation, stateHash, sourceHash }));
  const manifest = { trialId: trialId(arm), arm, profileId: profile.profileId, model: profile.modelId, inference: profile.profile.inference,
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, labels, sourceHash: contentHash(labels),
    requestHashes: requests.map(request => contentHash(admissionRequestEvidence(request))), initialPhysicalRequestHash: contentHash(admissionRequestEvidence(physical[0]!)),
    maximumRunNanoCny: perArmMaximum, pairedMaximumNanoCny: 2 * perArmMaximum, maxHttp: 3, slots: 12, actions: 12,
    acceptance: "Fixed B then C order; twelve independent full fixture worlds each, six permitted initial attempts and six unsupported conclusive claims (three effect claims,three means-text claims with null effects). Goals are copied desired intent. Gold labels follow explicit current facts and authored law; model labels are never gold. Same controls and state/schema per arm, with only C's source-intent instruction appended. Labels and arms absent from model input. Existing Flash with thinking disabled, no transport retry, at most3 HTTP/arm for structural recovery only. Both semantic reject results are expected: score per-slot label accuracy, not aggregate accept verdict. C requires6/6 positive and6/6 negative recognition on its first HTTP, with correct finding targets; any repair, unknown or classification failure disqualifies. Development diagnosis only: no frozen indexed source re-review, runtime promotion or game commit. Preserve every result and actual cost; no causal efficiency claim from fixed order." };
  return { catalog, registry, snapshot, requests, manifest, physicalRequest: physical[0]! };
}

export function scoreOwnershipReview(labels: Array<{ expected: "accept" | "reject" }>, report: { status: string; dispatches: number;
  rows?: Array<{ slot: number; verdict: string; error: string | null }> }) {
  const rows = report.rows ?? [];
  const intact = labels.length === 12 && rows.length === 12 && new Set(rows.map(row => row.slot)).size === 12 &&
    rows.every(row => Number.isInteger(row.slot) && row.slot >= 0 && row.slot < 12);
  const positiveCorrect = intact ? rows.filter(row => labels[row.slot]!.expected === "accept" && row.verdict === "accept" && !row.error).length : 0;
  const negativeCorrect = intact ? rows.filter(row => labels[row.slot]!.expected === "reject" && row.verdict === "reject" && !row.error).length : 0;
  return { intact, positiveCorrect, negativeCorrect, eligible: intact && report.status === "completed" && report.dispatches === 1 && positiveCorrect === 6 && negativeCorrect === 6 };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "score" && args.length === 0) {
    const reports = (["B", "C"] as const).map(arm => {
      const file = path.join(root, "runs", trialId(arm), "report.json"), report = JSON.parse(readFileSync(file, "utf8"));
      return { arm, reportHash: contentHash(report), sourceHash: report.sourceHash,
        ...scoreOwnershipReview(report.labels, report), failures: report.rows?.filter((row: { slot: number; verdict: string }) => row.verdict !== report.labels[row.slot]?.expected) };
    });
    if (reports[0]!.sourceHash !== reports[1]!.sourceHash) throw new Error("paired sources differ");
    const scored = { reports, decision: reports[1]!.eligible ? "development-controls-passed-no-promotion" : "review-diagnostic-failed",
      limitations: "Twelve authored development cases; same model family. No source-trial override, held-out semantic certification, efficiency claim or accepted gameplay step." };
    const file = path.join(root, "runs", trialId("C"), "classification.json");
    if (existsSync(file) && readFileSync(file, "utf8") !== JSON.stringify(scored, null, 2)) throw new Error("frozen classification changed");
    if (!existsSync(file)) writeFileSync(file, JSON.stringify(scored, null, 2), { flag: "wx" });
    console.log(JSON.stringify(scored, null, 2)); return;
  }
  if ((command !== "B" && command !== "C") || args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-plan-review-ownership-probe.ts B|C [prepare] | score");
  if (!args.length) {
    const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET).summary;
    const forecast = command === "B" ? 2 * perArmMaximum : perArmMaximum;
    const phase = budget.phaseBudgets.find(value => value.phases.includes("review"))!;
    if (budget.blockingUnknown.length || budget.phases.review.estimatedPeakNanoCny + budget.reservedNanoCny + forecast > phase.maximumNanoCny ||
      budget.estimatedPeakNanoCny + budget.reservedNanoCny + forecast > STEP_E2_BUDGET.maximumNanoCny) throw new Error("whole diagnostic budget unavailable");
    if (command === "C") {
      const prior = JSON.parse(readFileSync(path.join(root, "runs", trialId("B"), "report.json"), "utf8"));
      if (prior.status !== "completed") throw new Error("B must complete before C; unknown dispatches cannot be silently replaced");
    }
  }
  await runAdmittedPlanReview({ trialId: trialId(command), prepare: () => prepareOwnershipReview(command) }, args);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
