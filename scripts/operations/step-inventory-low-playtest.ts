import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { STEP_E1_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { prepareLowGroundingVariant } from "../experiments/step-low-grounding-variant";
import { runStepEfficiencyPlaytest } from "./step-efficiency-playtest";

const trialId = "probes-e1-inventory-low-01";
const toolHash = "8444a76266c485ce005714b834ebf064c1b36f3cfbd24b6f049ad12c1d3f60d3";
const preflightHash = "9ee06b2f016cf3f47edd11d25f5c48898a9b77fbf7bba2a9c970c3e7a92cf059";
const assignment = z.object({ source: z.string(), repeat: z.number().int().min(0).max(1), arm: z.enum(["B", "L"]) });
const usage = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheHit: z.number().int().nonnegative() });
const designSchema = z.object({ trialId: z.literal(trialId), toolHash: z.literal(toolHash),
  order: z.array(assignment).length(24), sources: z.array(z.object({ id: z.string() }).passthrough()).length(6) });

/** Evaluate the prospectively frozen mechanical gate; this cannot certify open semantics. */
export function assertInventoryLowAdmission(reportValue: unknown, designValue: unknown) {
  const design = designSchema.parse(designValue);
  const report = designSchema.extend({ status: z.literal("completed"), rows: z.array(assignment.extend({
    usage, rawJson: z.boolean(), formatCoverageAndBoundary: z.boolean(), inferenceValid: z.literal(true),
  })).length(24) }).parse(reportValue);
  if (contentHash(report.sources) !== contentHash(design.sources) || contentHash(report.order) !== contentHash(design.order) ||
    contentHash(report.rows.map(row => assignment.parse(row))) !== contentHash(design.order)) throw new Error("probe assignment or evidence binding changed");
  const sources = design.sources.map(source => source.id);
  if (new Set(sources).size !== 6 || report.rows.some(row => row.usage.cacheHit > row.usage.input)) throw new Error("invalid probe sources or usage");
  for (const source of sources) for (const arm of ["B", "L"] as const) {
    const rows = report.rows.filter(row => row.source === source && row.arm === arm);
    if (rows.length !== 2 || new Set(rows.map(row => row.repeat)).size !== 2) throw new Error("probe pair coverage changed");
  }
  const baseline = report.rows.filter(row => row.arm === "B"), candidate = report.rows.filter(row => row.arm === "L");
  const pass = (rows: typeof baseline) => rows.filter(row => row.formatCoverageAndBoundary).length;
  const tokens = (rows: typeof baseline) => rows.reduce((sum, row) => sum + row.usage.input + row.usage.output, 0);
  if (!candidate.every(row => row.rawJson) || pass(candidate) < 9 || pass(candidate) <= pass(baseline) ||
    sources.some(source => !candidate.some(row => row.source === source && row.formatCoverageAndBoundary)) ||
    tokens(candidate) * 100 > tokens(baseline) * 105) throw new Error("combined inventory/low candidate did not meet its frozen admission gate");
  return { baselinePass: pass(baseline), candidatePass: pass(candidate), baselineTokens: tokens(baseline), candidateTokens: tokens(candidate) };
}

async function main() {
  const root = path.resolve(STEP_E1_PROTOCOL.root);
  const preflight = readFileSync(path.join(root, "inventory-low-probe-preflight.json"));
  if (createHash("sha256").update(preflight).digest("hex") !== preflightHash) throw new Error("frozen probe preflight changed");
  const report = readFileSync(path.join(root, "runs", trialId, "report.json"));
  assertInventoryLowAdmission(JSON.parse(report.toString("utf8")), JSON.parse(preflight.toString("utf8")));
  const variantRoot = path.join(root, "variants/low-grounding-transition-resolution-direct-dns-v5");
  const variant = prepareLowGroundingVariant(variantRoot, { dnsEndpoint: "https://1.1.1.1/dns-query", socketConnectAttempts: 2,
    transitionThinkingLow: true, resolutionThinkingLow: true });
  await runStepEfficiencyPlaytest({ dataRoot: path.join(variantRoot, "game-data"), catalogPath: variant.catalogPath,
    worldsRoot: variant.worldsRoot, manifestHash: variant.manifestHash, groundingProfileId: variant.profileId,
    directTruthContext: true, sourceInventory: true,
    continuation: { id: "STEP-E1-C1", authorization: "User explicitly requests continued optimization on 2026-09-07 after the original window",
      deadlineUtc: "2026-09-07T05:00:00.000Z" },
    admissionEvidence: { trialId, reportHash: createHash("sha256").update(report).digest("hex"), preflightHash },
    label: "Full-world diagnostic of the prospectively gated direct resolution source-inventory/low-thinking combination; no isolated ingredient or gameplay gain is established by the probe." });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
