import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { RESOLUTION_DEPENDENT_FIELDS_CODEC } from "../../src/engine/mechanics/resolution-dependent-fields-codec";
import { contentHash } from "../../src/engine/models/model-audit";
import { prepareAdmittedPlanReview } from "../experiments/step-admitted-plan-review";
import { prepareSourceOwnedPlaytestVariant } from "./step-source-owned-playtest";
import { runStepEfficiencyPlaytest } from "./step-efficiency-playtest";

export function assertCompletedPlanReview(report: Record<string, unknown>, manifest: Record<string, unknown>) {
  const frozen = Object.fromEntries(Object.keys(manifest).map(key => [key, report[key]]));
  const rows = report.rows as Array<{ slot: number; verdict: string; plans: unknown[] }> | undefined;
  if (contentHash(frozen) !== contentHash(manifest) || report.status !== "completed" || report.verdict !== "accept" ||
    !rows || rows.length !== 12 || rows.some((row, slot) => row.slot !== slot || row.verdict !== "accept") ||
    rows.reduce((sum, row) => sum + row.plans.length, 0) !== 43) throw new Error("frozen resolution semantic review has not passed");
}

async function main() {
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || !/^(trajectory|confirmation)-e2-\d{2}$/u.test(trialId) || extra.length) {
    throw new Error("usage: step-dependent-resolution-playtest.ts prepare|run trajectory-e2-NN|confirmation-e2-NN");
  }
  const variant = await prepareSourceOwnedPlaytestVariant(trialId);
  const reviewed = await prepareAdmittedPlanReview();
  reviewed.registry.stopBackgroundRefresh();
  const report = JSON.parse(readFileSync(path.resolve(STEP_E2_PROTOCOL.root, "runs", reviewed.manifest.trialId, "report.json"), "utf8"));
  assertCompletedPlanReview(report, reviewed.manifest);
  await runStepEfficiencyPlaytest({ ...variant, resolutionRepresentation: RESOLUTION_DEPENDENT_FIELDS_CODEC,
    resolutionAdmissionEvidence: { trialId: reviewed.manifest.trialId, reportHash: contentHash(report), preflightHash: contentHash(reviewed.manifest) },
    label: `${variant.label} Resolution uses the independently frozen dependent-fields representation with complete source inventory and its tested physical cardinality/no-example contract and tail repair placement. The shared coordinator applies that physical contract across truth stages; its complete-world impact remains under test. One development root passed real materialization and the existing uncalibrated same-family semantic reviewer; fresh actual world effects, source review after every commit, replay and confirmation remain required.` });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
