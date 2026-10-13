import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { JEV_BUDGET_POLICY, JEV_PLANNING_NANO_CNY } from "../../src/engine/benchmarks/jev/live-budget";
import { JEV_QUALIFICATION_PROTOCOL, type JevArm } from "./jev-qualification-protocol";
import { analyzeJevQualification, type QualificationResult, type QualificationReview } from "./jev-qualification-analysis";

const args = process.argv.slice(2);
function option(name: string, fallback?: string) {
  const index = args.indexOf(`--${name}`), value = index < 0 ? fallback : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const root = path.resolve(option("root")), phase = option("phase", "canary");
if (!["canary", "confirmation"].includes(phase)) throw new Error("invalid qualification phase");
const manifest = read(path.join(root, "manifest.json")) as { protocol: typeof JEV_QUALIFICATION_PROTOCOL; budgetRoot: string; sources: Record<JevArm, string> };
if (contentHash(manifest.protocol) !== contentHash(JEV_QUALIFICATION_PROTOCOL)) throw new Error("qualification protocol differs");
if (existsSync(path.join(manifest.budgetRoot, "budget.lock"))) throw new Error("wait for paid workers to close before publishing accounting");
const journalFile = path.join(manifest.budgetRoot, "budget.jsonl");
const budget = new ExperimentBudget(journalFile, JEV_BUDGET_POLICY);
const journal = readFileSync(journalFile, "utf8").trimEnd().split("\n").filter(Boolean).map(value => JSON.parse(value).entry);
const trials = manifest.protocol.trials.filter(value => value.phase === phase);
const results: QualificationResult[] = [];
for (const trial of trials) for (const arm of trial.order) {
  const directory = path.join(root, trial.id, arm), original = path.join(directory, "result.json");
  const recovery = path.join(directory, "arrival-recovery", "result.json");
  const file = existsSync(recovery) ? recovery : original;
  if (!existsSync(file)) continue;
  const result = read(file) as QualificationResult;
  if (result.binding.head !== manifest.sources[arm] || result.arm !== arm || contentHash(result.trial) !== contentHash(trial)) {
    throw new Error("result producer or task differs from manifest");
  }
  results.push(result);
}
const reviews = args.includes("--reviews") ? read(path.resolve(option("reviews"))) as QualificationReview[] : [];
const output = { protocol: manifest.protocol.id, phase, sources: manifest.sources, resultHashes: results.map(value => ({
  trial: value.trial.id, arm: value.arm, hash: contentHash(value) })),
  cumulativeCny: (budget.summary.estimatedPeakNanoCny + JEV_PLANNING_NANO_CNY) / 1e9,
  cumulativeReservedCny: budget.summary.reservedNanoCny / 1e9,
  ...analyzeJevQualification(trials, results, reviews, journal) };
if (args.includes("--output")) writeFileSync(path.resolve(option("output")), `${JSON.stringify(output, null, 2)}\n`, { flag: "wx", flush: true });
console.log(JSON.stringify(output, null, 2));
