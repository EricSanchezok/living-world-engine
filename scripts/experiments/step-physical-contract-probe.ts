import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { parseLosslessExperimentJson } from "../../src/engine/benchmarks/action-compilation/lossless-json";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { physicalRequestContract } from "../../src/engine/benchmarks/step-efficiency/physical-request-contract";
import { scoreRepairTail, type RepairTailKind } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { temporalProbeBodySchema } from "../../src/engine/benchmarks/step-efficiency/temporal-diagnostic";
import { TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { focusedTruthOutput, FOCUSED_TRUTH_VERSION } from "../../src/engine/benchmarks/step-efficiency/focused-truth-output";
import { scoreWrappedTruthOutput } from "../../src/engine/benchmarks/step-efficiency/yaml-truth-output";

export function physicalContractDesign(mode: "physical" | "focus" = "physical") {
  const sources = [
    { id: "trajectory-e2-03-http-018", kind: "plan" as RepairTailKind, expectedHash: "a30c830a5fc1db7a3a25bf41a009963c47a1b5564dbca27357f426e3028c94eb" },
    { id: "trajectory-e2-02-http-026", kind: "transition" as RepairTailKind, expectedHash: "a859e993668a60b7a4e12fac0f73ad13db69df33d988eae479246cbcb46e8148" },
  ].map((source) => {
    const recorded = JSON.parse(readFileSync(path.join(STEP_E2_PROTOCOL.root, "http", source.id, "request.json"), "utf8"));
    const base = temporalProbeBodySchema.parse(recorded.body);
    if (contentHash(base) !== source.expectedHash || recorded.bodyHash !== source.expectedHash) throw new Error("source hash mismatch");
    return { ...source, base, treatment: mode === "focus" ? focusedTruthOutput(base, source.kind) : physicalRequestContract(base, source.kind) };
  });
  const order = sources.flatMap((source) => [0, 1].flatMap((repetition) => (["B", "C"] as const)
    .map((arm) => ({ source: source.id, repetition, arm }))
    .sort((a, b) => contentHash({ seed: 20260908, ...a }).localeCompare(contentHash({ seed: 20260908, ...b })))));
  const bodies = order.map((row) => {
    const source = sources.find((s) => s.id === row.source)!;
    return row.arm === "B" ? source.base : source.treatment.body;
  });
  const manifest = { trialId: mode === "focus" ? "probes-e2-focused-truth-01" : "probes-e2-physical-contract-01", version: mode === "focus" ? FOCUSED_TRUTH_VERSION : TRUTH_BATCH_REQUEST_CONTRACT, seed: 20260908, order,
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET), maxHttp: order.length,
    maximumRunNanoCny: order.length * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    sources: sources.map(({ id, kind, expectedHash, treatment }) => ({ id, kind, requestHash: expectedHash, slots: treatment.expanded.length,
      contextHash: treatment.contextHash, originalSchemaHash: treatment.originalSchemaHash, wireSchemaHash: treatment.wireSchemaHash,
      ...("recordsHash" in treatment ? { recordsHash: treatment.recordsHash, actionCount: treatment.actionCount } : {}) })),
    requestHashes: bodies.map(contentHash),
    acceptance: "Two complete initial physical sources: plan018 with12 slots/40 actions; transition026 with5 slots/5 actions. B original request; C only actual-cardinality/ordinal schema and omission of the generated empty-slots example, using the runtime implementation. Full original context, actions, logical schema, candidate scope and model settings remain identical, thinking disabled. Both arms use the same lossless whole-document JSON wrapper recovery and original schema/action coverage/reference checks. Each source B/C twice, source-blocked seeded pair order20260908, maximum8HTTP; no added primes, critic, repair or resampling. C requires>=3/4 complete formal passes, >=1/2 each source, greater than B, input tokens<=1.01B and equal HTTP. Stop after second C failure. Report raw/recovered format separately, valid/invalid lengths, output/total tokens, latency, actual cache and all costs; no gain inferred from invalid short outputs or cache order. Admission only to independent semantic and full-world diagnostic, never proof of gameplay or complete open semantics.",
  };
  if (mode === "focus") manifest.acceptance = "New exploratory composite, not retrospective admission of failed trials. Same original plan018 (12 slots/40 actions) and transition026 (5 slots/5 actions). B unchanged JSON. C plans source-owned action-keyed YAML with only schema-fixed factor constants mechanically restored; transition C flat column YAML. Both C forms omit generated empty output examples and repeat the exact complete assigned action records at the end, retaining full original context, candidates, scope, rules, output meaning and thinking-disabled settings. Whole-document wrapper recovery applies equally, then strict JSON/YAML, deterministic inverse, original schema, complete action coverage and reference membership. Unknown/duplicate keys, unsupported source kinds and contradictory constants fail; no semantic or syntax edits. B/C each source twice, source-blocked order C,B,B,C with seed20260908; max8HTTP, no prime, repair, extra critic or resampling. C requires>=3/4 complete passes, >=1/2 each source, greater than B, input tokens<=1.10B, equal HTTP. Stop on second C failure. This prospective input allowance covers source repetition and does not change historical thresholds. Report full token/output/latency/cache costs and valid/invalid output lengths; no cost improvement inferred from short failures or warmed cache. Passing only admits independent source/state review and a separate full-world diagnostic; no semantic or gameplay proof.";
  return { sources, order, bodies, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 2 || new Set(args).size !== args.length || args.some((a) => !["prepare", "focus"].includes(a))) throw new Error("usage: step-physical-contract-probe.ts [focus] [prepare]");
  const design = physicalContractDesign(args.includes("focus") ? "focus" : "physical");
  if (args.includes("prepare")) { console.log(JSON.stringify(design.manifest, null, 2));return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const root = path.resolve(STEP_E2_PROTOCOL.root), trialId = design.manifest.trialId, directory = path.join(root, "runs", trialId);
  if (existsSync(directory)) throw new Error("frozen trial cannot restart");
  const catalog = loadModelCatalog(path.join(root, "variants/nonthinking-current/model-catalog.json"));
  const account = catalog.account("deepseek-api"), credential = process.env[account.api_key_env];
  if (!credential) throw new Error("configured DeepSeek credential unavailable");
  const connectionEvents: unknown[] = [];
  const send = createModelFetchResolver(process.env, { onConnectionEvent: (event) => connectionEvents.push(event) })("deepseek-api", account)!;
  const lock = path.join(root, "writer.lock");closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, candidateFailures = 0;
  const rows: unknown[] = [], stop = () => { stopped = true; };
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest, status, failure,
    updatedAt: new Date().toISOString(), rows, connectionEvents, budget: budget?.summary }, null, 2));
  try {
    mkdirSync(directory, { recursive: true });
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = budget.summary.phaseBudgets.find((group) => group.phases.includes("probes"))!;
    const prior = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || prior + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      design.manifest.maximumRunNanoCny + budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("full trial reservation or unresolved billing blocks probe");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), accountCatalogHash: catalog.hash,
      phaseBudgetHash: budget.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: send,
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-(physical-contract|focused-truth)-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    transport.beginTrial(trialId, "probes");status = "running";report();
    for (const [index, row] of design.order.entries()) {
      if (stopped) throw new Error("interrupted; no next request");
      if (candidateFailures > 1) throw new Error("frozen admission gate unattainable; no next request");
      const source = design.sources.find((s) => s.id === row.source)!;
      const started = performance.now();
      const response = await transport.fetch(`${account.base_url}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(design.bodies[index]), signal: AbortSignal.timeout(300_000) });
      const raw = await response.json(), usage = deepSeekExperimentUsage(raw), output = raw.choices?.[0]?.message?.content;
      const focused = "codec" in source.treatment ? source.treatment : undefined;
      const score = focused ? scoreWrappedTruthOutput(typeof output === "string" ? output : "", row.arm === "C" ? "yaml" : "json", source.kind, source.treatment.expanded,
        row.arm === "C" ? value => focused.codec.decode(value) : undefined) : scoreRepairTail(typeof output === "string" ? output : "", source.kind, source.treatment.expanded);
      let recoveredJson = false;
      try { parseLosslessExperimentJson(typeof output === "string" ? output : "");recoveredJson = true; } catch { /* Preserve parse failure as evidence. */ }
      const finishReason = raw.choices?.[0]?.finish_reason ?? null;
      if (finishReason === "length") { score.schemaCoverageReferences = false;score.error = "provider output token limit reached"; }
      if (row.arm === "C" && !score.schemaCoverageReferences) candidateFailures++;
      const result = { ...row, usage, elapsedMs: performance.now() - started, recoveredJson, finishReason, ...score };
      rows.push(result);report();console.log(JSON.stringify({ ...result, error: result.error?.slice(0, 300) }));
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { report();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId, status, failure, completed: rows.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
