import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { contentHash } from "../../src/engine/models/model-audit";
import { preparePlanEvidenceReview } from "../experiments/step-plan-evidence-review";
import { prepareSourceOwnedPlaytestVariant } from "./step-source-owned-playtest";
import { runStepEfficiencyPlaytest, type StepEfficiencyVariant } from "./step-efficiency-playtest";

export function assertReviewedTruthRoot(report: Record<string, unknown>, manifest: Record<string, unknown>) {
  const rows = report.rows as Array<{ slot: number; verdict: string; plans: Array<{ planRef: string; actionRef: string }> }> | undefined;
  const frozen = Object.fromEntries(Object.keys(manifest).map(key => [key, report[key]]));
  if (contentHash(frozen) !== contentHash(manifest) || report.status !== "completed" || report.verdict !== "accept" ||
    !rows || rows.length !== manifest.slots || rows.some((row, slot) => row.slot !== slot || row.verdict !== "accept") ||
    rows.reduce((sum, row) => sum + row.plans.length, 0) !== manifest.actions ||
    new Set(rows.flatMap(row => row.plans.map(plan => plan.planRef))).size !== manifest.actions ||
    new Set(rows.flatMap(row => row.plans.map(plan => plan.actionRef))).size !== manifest.actions) throw new Error("complete frozen source review has not passed");
}

export async function prepareReviewedTruthVariant(trialId: string): Promise<StepEfficiencyVariant> {
  if (!/^(trajectory|confirmation)-e2-\d{2}$/u.test(trialId)) throw new Error("invalid fresh trajectory identity");
  if (existsSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", trialId))) throw new Error("frozen trajectory cannot restart");
  const variant = await prepareSourceOwnedPlaytestVariant(trialId);
  const truthTransportReviews = [];
  for (const rootId of ["016", "017"] as const) {
    const review = await preparePlanEvidenceReview(rootId);
    review.registry.stopBackgroundRefresh();
    const report = JSON.parse(readFileSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", review.manifest.trialId, "report.json"), "utf8"));
    assertReviewedTruthRoot(report, review.manifest);
    truthTransportReviews.push({ trialId: review.manifest.trialId, reportHash: contentHash(report), preflightHash: contentHash(review.manifest) });
  }
  return { ...variant, resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1", truthTransportReviews,
    label: `${variant.label} Fresh full-world diagnostic with the registered shared-state-first truth transport: shared-json-v3, dependent plan fields, restricted unmatched-closer recovery, complete physical cardinality and tail repair. Both original full planning roots passed initial materialization and existing same-family source review; this is limited development evidence. All Truth coordinator stages use the selected shared transport, while singleton member ordering and other role Compositions remain unchanged. Automatic/no-numeric-effect plans require actual source-action behavior checks after committed steps; no gameplay or broad semantic claim follows from admission.` };
}

async function main() {
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || extra.length) throw new Error("usage: step-reviewed-truth-playtest.ts prepare|run trajectory-e2-NN|confirmation-e2-NN");
  await runStepEfficiencyPlaytest(await prepareReviewedTruthVariant(trialId));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
