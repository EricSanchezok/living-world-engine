import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { contentHash } from "../../src/engine/models/model-audit";
import { immutableExperimentJson, immutableExperimentText, lockExperiment } from "../../src/engine/benchmarks/action-compilation/experiment-artifacts";
import { readConstrainedFirstPassSources, readConstrainedHistoricalReviews } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-sources";
import { AC_FP2_PROTOCOL, constrainedFirstPassProtocolHash } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-protocol";
import { auditSemanticObservability } from "../../src/engine/benchmarks/action-compilation/semantic-observability-audit";

function resolveDestination(directory: string): string {
  const absolute = path.resolve(directory);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = path.dirname(absolute);
  if (parent === absolute) throw new Error("cannot resolve audit destination");
  return path.join(resolveDestination(parent), path.basename(absolute));
}

/** Offline diagnostic only. No gateway, credentials, model requests or game writes. */
export function writeSemanticObservabilityAudit(sourceRoot: string, outputRoot: string) {
  const source = realpathSync(sourceRoot);
  const output = resolveDestination(outputRoot);
  if (output === source || output.startsWith(`${source}${path.sep}`) || source.startsWith(`${output}${path.sep}`)) {
    throw new Error("semantic audit destination overlaps immutable historical evidence");
  }
  const frozen = readConstrainedFirstPassSources(source);
  const reviews = readConstrainedHistoricalReviews(source, frozen);
  const audit = auditSemanticObservability(frozen.oracle, reviews.entries);
  const codeFiles = [
    "scripts/experiments/audit-action-compilation-semantics.ts",
    "src/engine/benchmarks/action-compilation/constrained-first-pass-sources.ts",
    "src/engine/benchmarks/action-compilation/constrained-first-pass-protocol.ts",
    "src/engine/benchmarks/action-compilation/semantic-observability-audit.ts",
    "src/engine/benchmarks/action-compilation/semantic-observability-audit.test.ts",
  ];
  const code = codeFiles.map((file) => ({ file, hash: contentHash(readFileSync(file, "utf8")) }));
  const report = { protocolHash: constrainedFirstPassProtocolHash(), sourceManifestHash: AC_FP2_PROTOCOL.sourceManifestHash,
    sourceScoreHash: AC_FP2_PROTOCOL.sourceScoreHash, historicalReviewPackHash: reviews.packHash,
    historicalTrialsVerified: reviews.validatedTrials, code, codeHash: contentHash(code),
    status: "HISTORICAL_DETERMINISTIC_OBSERVABILITY_DIAGNOSTIC", providerRequests: 0, newCostCny: 0, ...audit };
  // Join provenance only after blind evaluation; arm/call order never reach the evaluator.
  const provenance = { historicalRoot: source, origins: reviews.origins };
  const hash = contentHash(report);
  const directory = path.join(output, "readiness", "semantic-observability", hash);
  const failures = report.rows.filter((row) => row.verdict === "fail");
  const markdown = ["# AC-FP2 semantic readiness audit", "",
    "This is a historical observability diagnostic, not a completed experiment, treatment comparison, or protocol-2 readiness gate.", "",
    `Verified historical roots: ${reviews.validatedTrials}. Unique accepted outputs: ${report.total}.`,
    `Determinate failures: ${report.counts.fail}; independently certified passes: ${report.counts.pass}; unresolved: ${report.counts.unresolved}.`,
    `Available determinate fraction: ${report.adjudicableFraction}; the original 0.95 deterministic-only readiness threshold was superseded by approved protocol-2.`,
    "Mandatory action-specific predicates, alternatives and counterfactual coverage are not complete. No discovery or confirmation runs were made by this command. New HTTP: 0; new cost: CNY 0.", "",
    "## Evidence boundary", "",
    "A real-compiler regression fixture accepts an interview-first description, an invented completed trial/recommendation, and an immediate award. All retain the same original proposal and identical typed schedule/dependencies. The descriptions differ and are consumed by activity/reaction contexts; original-action retention and formal acceptance cannot adjudicate their meaning.", "",
    "This counterexample demonstrates insufficient evidence, not that all natural-language intent checks are impossible. Completing this protocol needs independent executable meaning/relationship rules or adjudication for the open text and downstream obligations. Neither keyword matching, a scripted Truth answer, nor implementer/model opinion may be labelled independent semantic gold.", "",
    "## Determinate historical violations", "",
    "The existing frozen oracle forbids medical treatment for these nonmedical actions. Selecting another profile is not automatically a semantic pass.", "",
    "| Review ID | Source | Actor | Profile |", "| --- | --- | --- | --- |",
    ...failures.map((row) => `| ${row.reviewId} | ${row.sourceId} | ${row.actor} | ${row.profileId} |`), "",
    "## Missing evidence", "", ...report.missingEvidence.map((item) => `- ${item}`), "",
    "## Provenance", "", `Audit hash: ${hash}.`, `Protocol hash: ${report.protocolHash}.`,
    `Historical manifest: ${report.sourceManifestHash}.`, `Historical score: ${report.sourceScoreHash}.`,
    `Historical review pack: ${report.historicalReviewPackHash}.`, `Audit code hash: ${report.codeHash}.`, "",
    "Every result and unresolved obligation is in audit.json, bound to its exact action/state/canonical output. This report never overwrites AC-FP1 artifacts. C/F adapters, Responses capability probes, full v2 orchestration and D/C execution are not certified by this audit.", "",
  ].join("\n");
  const release = lockExperiment(output);
  try {
    immutableExperimentJson(path.join(directory, "audit.json"), report);
    immutableExperimentJson(path.join(directory, "origins.json"), provenance);
    immutableExperimentText(path.join(directory, "report.md"), markdown);
    immutableExperimentJson(path.join(directory, "checksums.json"), { audit: hash, report: contentHash(markdown), origins: contentHash(provenance) });
  } finally { release(); }
  return { directory, hash, status: report.status, counts: report.counts, total: report.total,
    adjudicableFraction: report.adjudicableFraction, providerRequests: 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: {
    "source-root": { type: "string", default: ".livingworld-benchmarks/experiments/ac-fp1/v1" },
    output: { type: "string", default: ".livingworld-benchmarks/experiments/ac-fp2/v1" },
  } });
  try { process.stdout.write(`${JSON.stringify(writeSemanticObservabilityAudit(values["source-root"]!, values.output!), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
