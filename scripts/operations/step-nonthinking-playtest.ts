import path from "node:path";
import { prepareNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runStepEfficiencyPlaytest } from "./step-efficiency-playtest";

async function main() {
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || !/^(discovery|trajectory|confirmation)-e2-\d{2}$/u.test(trialId) || extra.length) throw new Error("usage: step-nonthinking-playtest.ts prepare|run trajectory-e2-NN");
  const variantRoot = path.resolve(STEP_E2_PROTOCOL.root, "variants/nonthinking-current");
  const variant = prepareNonthinkingWorld(variantRoot);
  await runStepEfficiencyPlaytest({ ...variant, nonthinkingBaseline: true,
    dataRoot: path.join(variantRoot, "game-data", trialId), groundingProfileId: "truth-deepseek", sourceInventory: true,
    label: "Full 48-Agent current production foundation, all thinking disabled, with source-faithful shortlist evidence, bounded duration evidence and early causal/effect validation. Independent source review required after each commit." });
}

void main().catch((error: unknown) => { console.error(error);process.exitCode = 1; });
