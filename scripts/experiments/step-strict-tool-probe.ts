import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { strictToolDesign, scoreStrictTool } from "../../src/engine/benchmarks/step-efficiency/strict-tool-capability";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelFetchResolver } from "../../src/engine/models/model-network";

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== "prepare")) throw new Error("usage: step-strict-tool-probe.ts [prepare]");
  const design = strictToolDesign(), trialId = "probes-e2-strict-tool-capability-01";
  const manifest = { trialId, version: 1, model: STEP_E2_PROTOCOL.model, thinking: "disabled", endpoint: "/beta/chat/completions",
    inputCeiling: 4096, outputCeiling: 2048, maxHttp: design.order.length, order: design.order,
    requestHashes: design.bodies.map(contentHash), budgetHash: contentHash(STEP_E2_BUDGET),
    maximumRunNanoCny: design.order.length * (4096 * 3520 + 2048 * 10560),
    sources: ["https://api-docs.deepseek.com/guides/tool_calls/", "https://api-docs.deepseek.com/api/create-chat-completion/"],
    acceptance: "Synthetic capability canaries only, two schema feature groups, B(strict false)/P(strict true), three paired repetitions per group, seed20260907, max12 HTTP. Identical messages deliberately request constraint violations; only strict flag differs within pair. Both explicitly disable thinking. P must pass all six exact tool-call, raw argument JSON and local schema checks. Any P failure or unresolved billing stops further sends. If B also passes all six, strict enforcement is inconclusive; do not claim a causal effect. Smaller output cap is for synthetic capability probes only, not a gameplay parameter change. These probes do not cover all engine schema features, full batch correctness or semantics; full actual schema compatibility and source-bound gameplay tests remain mandatory. No tool is executed, no retry and no automatic quarantine or billing assumption." };
  if (args[0] === "prepare") { console.log(JSON.stringify(manifest, null, 2));return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const root = path.resolve(STEP_E2_PROTOCOL.root), directory = path.join(root, "runs", trialId);
  if (existsSync(directory)) throw new Error("frozen trial cannot restart");
  const catalog = loadModelCatalog(path.join(root, "variants/nonthinking-current/model-catalog.json"));
  const account = catalog.account("deepseek-api"), credential = process.env[account.api_key_env];
  if (!credential) throw new Error("configured DeepSeek credential unavailable");
  const connectionEvents: unknown[] = [];
  const send = createModelFetchResolver(process.env, { onConnectionEvent: (event) => connectionEvents.push(event) })("deepseek-api", account)!;
  const lock = path.join(root, "writer.lock");closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false;
  const rows: Array<{ arm: string; passed: boolean; [key: string]: unknown }> = [];
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure,
    updatedAt: new Date().toISOString(), rows, connectionEvents, budget: budget?.summary }, null, 2));
  try {
    mkdirSync(directory, { recursive: true });
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = STEP_E2_BUDGET.phaseBudgets!.find((group) => group.phases.includes("probes"))!;
    const prior = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || prior + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      manifest.maximumRunNanoCny + budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("full trial reservation or unresolved billing blocks probe");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), accountCatalogHash: catalog.hash }, null, 2), { flag: "wx" });
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: send,
      inputTokenCeiling: manifest.inputCeiling, outputTokenCeiling: manifest.outputCeiling,
      endpointPaths: [manifest.endpoint], trialPattern: /^probes-e2-strict-tool-capability-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    transport.beginTrial(trialId, "probes");status = "running";report();
    for (const [index, row] of design.order.entries()) {
      if (stopped) throw new Error("interrupted; no next request");
      if (rows.some((r) => r.arm === "P" && !r.passed)) throw new Error("strict capability gate failed; no next request");
      const started = performance.now();
      const response = await transport.fetch(`${account.base_url.replace(/\/$/u, "")}${manifest.endpoint}`, { method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(design.bodies[index]), signal: AbortSignal.timeout(120_000) });
      const raw = await response.json(), usage = deepSeekExperimentUsage(raw), score = scoreStrictTool(raw, row.caseId);
      const result = { ...row, ...score, usage, elapsedMs: performance.now() - started,
        peakNanoCny: (usage.input - usage.cacheHit) * 3520 + usage.cacheHit * 112 + usage.output * 10560 };
      rows.push(result);report();console.log(JSON.stringify({ ...result, error: result.error?.slice(0, 300) }));
    }
    status = rows.some((r) => r.arm === "P" && !r.passed) ? "failed" : rows.every((r) => r.passed) ? "inconclusive-no-control-violations" : "limited-capabilities-passed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { report();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId, status, failure, completed: rows.length }));
}
void main();
