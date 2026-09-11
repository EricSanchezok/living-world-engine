import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { WORKLIST_PLANNING_PIPELINE } from "../../src/engine/mechanics/worklist-planning-pipeline";
import { contentHash } from "../../src/engine/models/model-audit";
import { prepareWorklistPlanReview } from "../experiments/step-worklist-plan-review";
import { runStepEfficiencyPlaytest, type StepEfficiencyVariant } from "./step-efficiency-playtest";
import { assertReviewedTruthRoot } from "./step-reviewed-truth-playtest";
import { prepareSourceOwnedPlaytestVariant } from "./step-source-owned-playtest";

export async function prepareWorklistPlaytestVariant(trialId: string): Promise<StepEfficiencyVariant> {
  if (!/^(trajectory|confirmation)-e2-\d{2}$/u.test(trialId)) throw new Error("invalid fresh trajectory identity");
  if (existsSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", trialId))) throw new Error("frozen trajectory cannot restart");
  const truthTransportReviews = [];
  for (const rootId of ["041", "007"] as const) {
    const review = await prepareWorklistPlanReview(rootId);
    review.registry.stopBackgroundRefresh();
    const report = JSON.parse(readFileSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", review.manifest.trialId, "report.json"), "utf8"));
    assertReviewedTruthRoot(report, review.manifest);
    truthTransportReviews.push({ trialId: review.manifest.trialId, reportHash: contentHash(report), preflightHash: contentHash(review.manifest) });
  }
  const variant = await prepareSourceOwnedPlaytestVariant(trialId);
  return { ...variant, resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1",
    planningPipeline: WORKLIST_PLANNING_PIPELINE, truthTransportReviews,
    label: `${variant.label} Fresh full-world worklist candidate with the exact registered planning pipeline, explicit temporal evidence, full cardinality and targeted repair. Original roots required one repair and then passed the existing same-family source reviewer; this is limited evidence, not first-call success. Inspect every actual action and temporal boundary after each commit, including future objective completion, unsupported harm and player choice preservation. Three credible steps and fresh confirmation remain required.` };
}

async function main() {
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || extra.length) throw new Error("usage: step-worklist-playtest.ts prepare|run trajectory-e2-NN|confirmation-e2-NN");
  await runStepEfficiencyPlaytest(await prepareWorklistPlaytestVariant(trialId));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
