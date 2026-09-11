import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { promptBundle } from "../../src/engine/prompts";
import { contentHash } from "../../src/engine/models/model-audit";
import { STEP_E1_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { prepareLowGroundingVariant } from "../experiments/step-low-grounding-variant";
import { runStepEfficiencyPlaytest } from "./step-efficiency-playtest";

const assignment = z.object({ repeat: z.number().int().min(0).max(1), arm: z.enum(["B", "L", "S"]), sources: z.array(z.string()).min(1).max(6) });
const designSchema = z.object({ trialId: z.string(), toolHash: z.string(), treatmentHash: z.string(), preparationHash: z.string(),
  sourceHashes: z.array(z.object({ id: z.string() }).passthrough()).length(6), order: z.array(assignment) });
const rowSchema = assignment.extend({ rawJson: z.boolean(), envelopeValid: z.boolean(), inferenceValid: z.literal(true),
  logical: z.array(z.object({ source: z.string(), formatCoverageAndBoundary: z.boolean() })),
  usage: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheHit: z.number().int().nonnegative() }),
  elapsedMs: z.number().finite().nonnegative() });

function boundProbe(reportValue: unknown, designValue: unknown, kind: "observation" | "inventory") {
  const design = designSchema.parse(designValue);
  const report = designSchema.extend({ status: z.literal("completed"), rows: z.array(rowSchema) }).parse(reportValue);
  if (contentHash(designSchema.parse(report)) !== contentHash(design) ||
    contentHash(report.rows.map(row => assignment.parse(row))) !== contentHash(design.order)) throw new Error("probe evidence binding changed");
  const ids = design.sourceHashes.map(source => source.id), arms = kind === "observation" ? ["B", "L"] : ["B", "S"];
  if (new Set(ids).size !== 6 || report.rows.length !== (kind === "observation" ? 4 : 14) ||
    report.rows.some(row => !arms.includes(row.arm) || row.usage.cacheHit > row.usage.input ||
      contentHash(row.logical.map(slot => slot.source)) !== contentHash(row.sources) ||
      row.sources.some(source => !ids.includes(source)) || new Set(row.sources).size !== row.sources.length ||
      row.sources.length !== (kind === "inventory" && row.arm === "B" ? 1 : 6))) throw new Error("probe slot or request coverage changed");
  for (const arm of arms) for (const source of ids) for (const repeat of [0, 1]) {
    if (report.rows.filter(row => row.arm === arm && row.repeat === repeat && row.sources.includes(source)).length !== 1)
      throw new Error("probe pair coverage changed");
  }
  return { ids, rows: report.rows };
}

function metrics(rows: z.infer<typeof rowSchema>[]) {
  return { passed: rows.flatMap(row => row.logical).filter(slot => slot.formatCoverageAndBoundary).length,
    tokens: rows.reduce((sum, row) => sum + row.usage.input + row.usage.output, 0),
    latencyMs: rows.reduce((sum, row) => sum + row.elapsedMs, 0) };
}

/** Frozen finite development gates only; admission does not establish gameplay success. */
export function assertSharedInventoryAdmission(report: unknown, design: unknown) {
  const { ids, rows } = boundProbe(report, design, "inventory");
  const baseline = metrics(rows.filter(row => row.arm === "B")), selected = rows.filter(row => row.arm === "S"), candidate = metrics(selected);
  if (!selected.every(row => row.rawJson && row.envelopeValid) || candidate.passed < 11 || candidate.passed < baseline.passed ||
    candidate.tokens * 2 > baseline.tokens || ids.some(id => !selected.some(row => row.logical.some(slot => slot.source === id && slot.formatCoverageAndBoundary))))
    throw new Error("shared inventory admission gate failed");
  return { baseline, candidate };
}

const semanticCase = z.object({ source: z.string(), repeat: z.number().int().min(0).max(1),
  sourceContextHash: z.string(), outputHash: z.string(), verdict: z.enum(["pass", "fail", "unknown"]), reason: z.string().min(10) });
const reviewSchema = z.object({ trialId: z.string(), reportHash: z.string(), preflightHash: z.string(),
  method: z.literal("source-bound-assistant-review"), cases: z.array(semanticCase).length(12) });

/** Source-bound inspection can veto a mechanical pass; it is not a calibrated semantic judge. */
export function assertPerspectiveObservationAdmission(report: unknown, design: unknown, reviewValue: unknown,
  expected: { trialId: string; reportHash: string; preflightHash: string; cases: Array<{ source: string; repeat: number; sourceContextHash: string; outputHash: string }> }) {
  const { rows } = boundProbe(report, design, "observation");
  const review = reviewSchema.parse(reviewValue);
  if (review.trialId !== expected.trialId || review.reportHash !== expected.reportHash || review.preflightHash !== expected.preflightHash ||
    contentHash(review.cases.map(({ source, repeat, sourceContextHash, outputHash }) => ({ source, repeat, sourceContextHash, outputHash }))) !== contentHash(expected.cases) ||
    review.cases.some(entry => entry.verdict !== "pass")) throw new Error("source-bound semantic review is missing, mismatched or vetoed");
  const selected = rows.filter(row => row.arm === "L"), candidate = metrics(selected), baseline = metrics(rows.filter(row => row.arm === "B"));
  const assignments = selected.flatMap(row => row.sources.map(source => ({ source, repeat: row.repeat })));
  if (contentHash(expected.cases.map(({ source, repeat }) => ({ source, repeat }))) !== contentHash(assignments) ||
    !selected.every(row => row.rawJson && row.envelopeValid) || candidate.passed !== 12 || candidate.tokens * 100 > baseline.tokens * 110)
    throw new Error("perspective observation admission gate failed");
  return { arm: "L" as const, ...candidate };
}

async function main() {
  const root = path.resolve(STEP_E1_PROTOCOL.root);
  const read = (trial: string, preflightFile: string, hash: string) => {
    const preflight = readFileSync(path.join(root, preflightFile));
    if (createHash("sha256").update(preflight).digest("hex") !== hash) throw new Error("frozen preflight changed");
    const report = readFileSync(path.join(root, "runs", trial, "report.json"));
    return { report: JSON.parse(report.toString("utf8")), design: JSON.parse(preflight.toString("utf8")),
      trialId: trial, reportHash: createHash("sha256").update(report).digest("hex"), preflightHash: hash };
  };
  const inventory = read("probes-e1-shared-inventory-01", "shared-inventory-probe-preflight.json", "80dd4d848dced914e152e987c4483f7e18ac8fbb4c228896ca5d34fb36349d22");
  const observation = read("probes-e1-shared-observation-reference-01", "shared-observation-reference-probe-preflight.json", "a96c9e3b896ca662173eb8e00e71eef553517e43cfb1e5dcf6cb7287164f3eea");
  assertSharedInventoryAdmission(inventory.report, inventory.design);
  const preparationText = readFileSync(path.join(root, "shared-observation-reference-access-preparation.json"), "utf8");
  const preparation = JSON.parse(preparationText), bundle = promptBundle("observation-renderer");
  if (contentHash(preparationText) !== observation.design.preparationHash || preparation.treatment.body.messages[0].content !== bundle.system ||
    !preparation.treatment.body.messages[1].content.startsWith(`${bundle.userPrompt}\n\n`)) throw new Error("observation prompt differs from admitted probe");
  const parsed = boundProbe(observation.report, observation.design, "observation");
  const cases = parsed.rows.flatMap((row, index) => {
    if (row.arm !== "L") return [];
    const response = JSON.parse(readFileSync(path.join(root, "http", `${observation.trialId}-http-${String(index + 1).padStart(3, "0")}`, "response.json"), "utf8"));
    const output = JSON.parse(JSON.parse(response.raw).choices[0].message.content);
    return row.sources.map((source, slot) => ({ source, repeat: row.repeat,
      sourceContextHash: preparation.sources.find((entry: { id: string }) => entry.id === source).contextHash,
      outputHash: contentHash(output.slots.find((entry: { slot: number }) => entry.slot === slot).result) }));
  });
  const reviewText = readFileSync(path.join(root, "reference-source-review.json"), "utf8");
  const selected = assertPerspectiveObservationAdmission(observation.report, observation.design, JSON.parse(reviewText), { ...observation, cases });
  const variantRoot = path.join(root, "variants/shared-inventory-observation-v6");
  const variant = prepareLowGroundingVariant(variantRoot, { dnsEndpoint: "https://1.1.1.1/dns-query", socketConnectAttempts: 2,
    transitionThinkingLow: true, resolutionThinkingLow: true, ...(selected.arm === "L" ? { observationThinkingLow: true } : {}) });
  await runStepEfficiencyPlaytest({ dataRoot: path.join(variantRoot, "game-data"), catalogPath: variant.catalogPath,
    worldsRoot: variant.worldsRoot, manifestHash: variant.manifestHash, groundingProfileId: variant.profileId, sourceInventory: true,
    continuation: { id: "STEP-E1-C3", authorization: "Continued optimization under the renewed user instruction and unchanged original CNY1000 ledger; prospective work block after closed C2 trials",
      deadlineUtc: "2026-09-07T08:30:00.000Z" },
    admissionEvidence: { trialId: `${inventory.trialId}+${observation.trialId}`,
      reportHash: contentHash([inventory.reportHash, observation.reportHash, contentHash(reviewText)]), preflightHash: contentHash([inventory.preflightHash, observation.preflightHash]) },
    label: `Full-world diagnostic of shared inventory/low resolution and source-reviewed perspective observation prompt; observation arm ${selected.arm}. Finite development gates do not establish a whole-game gain.` });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
