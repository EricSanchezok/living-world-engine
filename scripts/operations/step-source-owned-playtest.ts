import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareSourceOwnedProbe } from "../experiments/step-source-owned-probe";
import { contentHash } from "../../src/engine/models/model-audit";
import { runStepEfficiencyPlaytest, type StepEfficiencyVariant } from "./step-efficiency-playtest";

async function main() {
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || !/^(trajectory|confirmation)-e2-\d{2}$/u.test(trialId) || extra.length) {
    throw new Error("usage: step-source-owned-playtest.ts prepare|run trajectory-e2-NN|confirmation-e2-NN");
  }
  await runStepEfficiencyPlaytest(await prepareSourceOwnedPlaytestVariant(trialId));
}

export async function prepareSourceOwnedPlaytestVariant(trialId: string): Promise<StepEfficiencyVariant> {
  if (!/^(trajectory|confirmation)-e2-\d{2}$/u.test(trialId)) throw new Error("invalid fresh trajectory identity");
  const prepared = await prepareSourceOwnedProbe();
  const { design, manifest, registry } = prepared;
  registry.stopBackgroundRefresh();
  const report = JSON.parse(readFileSync(path.join(design.root, "runs", manifest.trialId, "report.json"), "utf8"));
  const frozen = Object.fromEntries(Object.keys(manifest).map((key) => [key, report[key]]));
  if (contentHash(frozen) !== contentHash(manifest) || report.status !== "completed" || report.rows.length !== 5 ||
    report.rows.some((row: { diagnosticPassed: boolean; sourceTextPreserved: boolean; stateUnchanged: boolean; plans: unknown[] }) =>
      !row.diagnosticPassed || !row.sourceTextPreserved || !row.stateUnchanged || row.plans.length !== 12)) {
    throw new Error("current source-owned choice compilation has not passed its frozen diagnostic");
  }
  return { dataRoot: path.join(design.variant, "game-data", trialId),
    catalogPath: path.join(design.variant, "model-catalog.json"), worldsRoot: path.join(design.variant, "worlds"),
    manifestHash: contentHash(design.manifest), groundingProfileId: "truth-deepseek", nonthinkingBaseline: true, sourceInventory: true,
    compilation: "source-owned-visible-choice-v1",
    admissionEvidence: { trialId: manifest.trialId, reportHash: contentHash(report), preflightHash: contentHash(manifest) },
    label: "Full48-Agent finite-goal candidate with AT, exact source-owned descriptions, root-pinned retrieval, exact physical cardinality and visible profile choice evidence; all thinking disabled. Compiler diagnostic is limited evidence; actual world effects require independent review after each commit." };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch((error: unknown) => {
  console.error(error);process.exitCode = 1;
});
