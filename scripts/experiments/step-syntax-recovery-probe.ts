import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { SHARED_BATCH_ORDER_CODEC } from "../../src/engine/mechanics/shared-batch-context";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { UNMATCHED_CLOSER_RECOVERY } from "../../src/engine/models/unmatched-closer-recovery";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { prepareCatalogOrderProbe } from "./step-catalog-order-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";

const TRIAL = "probes-e2-syntax-recovery-01";
const SOURCE_TRIAL = "probes-e2-direct-order-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const policyFor = (arm: string) => arm === "P" ? UNMATCHED_CLOSER_RECOVERY : undefined;
type Row = { rootId: string; arm: string; complete: boolean; initialAdmittedActions: number;
  newHttp: number; newTotalTokens: number | null };
export function syntaxRecoveryDecision(rows: Row[], integrityFailed: boolean) {
  if (integrityFailed || rows.length !== 4 || rows.some(row => row.newTotalTokens === null) ||
    ["016", "017"].some(rootId => ["B", "P"].some(arm => rows.filter(row => row.rootId === rootId && row.arm === arm).length !== 1))) return "inconclusive";
  const b = rows.filter(row => row.arm === "B"), p = rows.filter(row => row.arm === "P");
  const sum = (values: Row[], field: "newHttp" | "newTotalTokens" | "initialAdmittedActions") => values.reduce((total, row) => total + row[field]!, 0);
  if (p.some(row => !row.complete) || rows.filter(row => row.rootId === "016").some(row => !row.complete || row.newHttp !== 0)) return "failed";
  return sum(p, "initialAdmittedActions") > sum(b, "initialAdmittedActions") && sum(p, "newHttp") <= sum(b, "newHttp") &&
    sum(p, "newTotalTokens") <= sum(b, "newTotalTokens") ? "eligible-for-source-semantic-review" : "failed";
}

/** Replay one immutable response locally. Only subsequent requests may reach
 * the supplied paid boundary; the historical response is never recharged. */
export function seededResponseFetch(source: { bodyHash: string; response: { raw: string; rawHash: string; status: number } },
  maxNewRequests: number, send: typeof fetch): typeof fetch {
  if (contentHash(source.response.raw) !== source.response.rawHash || !Number.isSafeInteger(maxNewRequests) || maxNewRequests < 0) throw new Error("invalid seeded response evidence or bound");
  let seeded = false, newRequests = 0;
  return async (input, init) => {
    if (!seeded) {
      if (contentHash(JSON.parse(String(init?.body))) !== source.bodyHash) throw new ModelConfigurationError("seeded request differs from its historical model-visible source");
      seeded = true;
      return new Response(source.response.raw, { status: source.response.status, headers: { "Content-Type": "application/json" } });
    }
    if (newRequests >= maxNewRequests) throw new ModelConfigurationError("seeded recovery new-request ceiling reached");
    newRequests++;
    return send(input, init);
  };
}

export async function prepareSyntaxRecoveryProbe() {
  const prepared = await prepareCatalogOrderProbe();
  const { catalog, snapshot, registry } = prepared;
  const account = catalog.account("deepseek-api");
  const cases = [];
  for (const selected of prepared.cases) {
    const sourceHttp = `${SOURCE_TRIAL}-http-${selected.id === "016" ? "001" : "003"}`;
    const request = JSON.parse(readFileSync(path.join(root, "http", sourceHttp, "request.json"), "utf8"));
    const response = JSON.parse(readFileSync(path.join(root, "http", sourceHttp, "response.json"), "utf8"));
    if (contentHash(request.body) !== request.bodyHash || contentHash(response.raw) !== response.rawHash ||
      JSON.parse(response.raw).model !== STEP_E2_PROTOCOL.model) throw new Error("immutable source HTTP evidence changed");
    const source = { bodyHash: request.bodyHash, response };
    const arms: Record<string, { initialRequestHash: string; firstRepairRequestHash: string | null; initialAdmittedActions: number; initialComplete: boolean }> = {};
    for (const arm of ["B", "P"]) {
      const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
      const gateway = createModelGateway(catalog, { [account.api_key_env]: "offline-preflight" }, { maxTransportAttempts: 1,
        registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
          refresh: async () => { throw new Error("offline registry"); }, status: () => registry.status() },
        fetch: seededResponseFetch(source, 0, async () => { throw new Error("preflight cannot send"); }),
      });
      const result = await runResolutionAdmission(selected.source, gateway, { candidate: true, contextCodec: SHARED_BATCH_ORDER_CODEC,
        jsonSyntaxRecovery: policyFor(arm), maxPhysicalRequests: 3, scope: { modelRegistrySnapshotHash: snapshot.hash },
        onPhysicalRequest: request => { captures.push(admissionRequestEvidence(request)); if (captures.length > 1) throw new ModelConfigurationError("offline repair capture"); } });
      if (!captures.length || result.physicalFailures.some(failure => failure.message.includes("differs from its historical"))) throw new Error("source request did not replay exactly");
      arms[arm] = { initialRequestHash: contentHash(captures[0]), firstRepairRequestHash: captures[1] ? contentHash(captures[1]) : null,
        initialAdmittedActions: result.rows.filter(row => row.admitted).reduce((sum, row) => sum + row.actions, 0), initialComplete: result.firstHttpComplete };
      if (selected.id === "016" && (!result.firstHttpComplete || captures.length !== 1)) throw new Error("valid control regressed before paid dispatch");
      if (selected.id === "017" && !captures[1]) throw new Error("failed source did not expose its next recovery request");
    }
    cases.push({ rootId: selected.id, source: selected.source, sourceHttp, replay: source, arms, seededUsage: deepSeekExperimentUsage(JSON.parse(response.raw)) });
  }
  const order = cases.flatMap(value => ["B", "P"].sort((a, b) => contentHash({ seed: 20260908, rootId: value.rootId, arm: a }).localeCompare(contentHash({ seed: 20260908, rootId: value.rootId, arm: b }))).map(arm => ({ rootId: value.rootId, arm })));
  const manifest = { trialId: TRIAL, sourceTrialId: SOURCE_TRIAL, seed: 20260908, order, maxNewHttp: 4,
    physicalCeilingPerCell: 3, newHttpCeilings: { "016": 0, "017": 2 },
    maximumRunNanoCny: 4 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: prepared.manifest.model, inference: prepared.manifest.inference,
    maxOutputTokens: prepared.manifest.maxOutputTokens, protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    cases: cases.map(value => ({ rootId: value.rootId, sourceHttp: value.sourceHttp, sourceHash: contentHash(value.source), stateHash: contentHash(value.source.state),
      sourceRequestHash: value.replay.bodyHash, sourceResponseHash: value.replay.response.rawHash, arms: value.arms, seededUsage: value.seededUsage })),
    acceptance: "Frozen-response recovery experiment, not a prospective first-call success-rate estimate. Reuse the same immutable original response locally in both arms after verifying the actual model-visible request body hash. No source response is re-sent, recharged or newly sampled. Both arms retain dependent fields, shared-json-v3, full 12/8 original slots, 38/10 assigned actions and all 48 available actions. B uses existing parsing; P only selects unmatched-closers-v1. Original valid root016 is a zero-new-HTTP control. Root017 allows at most two new repair HTTP per arm, four total; canonical, reference, source and semantic-repair rules remain unchanged. Preserve accepted logical slots and stop before semantic verification/RNG/commit. Complete the frozen order unless interrupted, a control regresses, or model/billing/request integrity fails. P must completely admit both sources, preserve the valid control, retain more actions from the fixed first response, and use no more new HTTP or new total tokens than B. Missing usage or incomplete pairs are inconclusive. Passing only permits source-bound semantic review. Report replayed usage separately from newly charged usage; historical initial-response latency and cache must not be claimed as current-game savings. Report measured repair cost/cache/latency separately; no population, full-game cost or open-semantics claim.",
  };
  return { ...prepared, cases, manifest };
}

function newUsage(first: number, last: number) {
  let input = 0, output = 0, cacheHit = 0, unknown = 0, documentedNanoCny = 0;
  for (let i = first; i <= last; i++) try {
    const directory = path.join(root, "http", `${TRIAL}-http-${String(i).padStart(3, "0")}`);
    const request = JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8"));
    const response = JSON.parse(readFileSync(path.join(directory, "response.json"), "utf8"));
    const usage = deepSeekExperimentUsage(JSON.parse(response.raw)); input += usage.input; output += usage.output; cacheHit += usage.cacheHit;
    documentedNanoCny += documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny;
  } catch { unknown++; }
  return { newKnownUsage: { input, output, cacheHit }, newTotalTokens: unknown ? null : input + output,
    unknownUsageRequests: unknown, documentedNewNanoCny: documentedNanoCny, providerBilledNanoCny: null };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-syntax-recovery-probe.ts [prepare]");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("a frozen trial cannot restart");
  const { catalog, registry, snapshot, cases, manifest } = await prepareSyntaxRecoveryProbe();
  if (args[0] === "prepare") { console.log(JSON.stringify(manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid repair");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, dispatches = 0;
  const rows: Row[] = [], connections: unknown[] = [];
  const stop = () => { stopped = true; };
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, rows,
    decision: syntaxRecoveryDecision(rows, status !== "completed"), newDispatches: dispatches, budget: budget?.summary, connections, updatedAt: new Date().toISOString() }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    mkdirSync(directory, { recursive: true });
    const ledger = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET); budget = ledger;
    const phase = ledger.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, phase) => sum + ledger.summary.phases[phase].estimatedPeakNanoCny, 0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete recovery budget or unknown billing blocks dispatch");
    const account = catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(ledger, { root, baseUrl: account.base_url,
      fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-syntax-recovery-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    for (const cell of manifest.order) {
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error("interruption or unknown billing stops next cell");
      const selected = cases.find(value => value.rootId === cell.rootId)!, frozen = selected.arms[cell.arm]!;
      const observer = new RecordingRuntimeObserver({ mode: "full" });
      const beforeHttp = dispatches, beforeCost = ledger.summary.estimatedPeakNanoCny, started = performance.now();
      let physical = 0;
      const cellFetch = seededResponseFetch(selected.replay, cell.rootId === "016" ? 0 : 2, async (input, init) => {
        if (stopped || dispatches >= 4) throw new ModelConfigurationError("recovery dispatch gate stopped");
        try { const response = await transport.fetch(input, init), value = await response.clone().json();
          if (value.model !== STEP_E2_PROTOCOL.model) throw new ModelConfigurationError("response model changed"); return response;
        } catch (error) { stopped = true; failure = String(error); throw error; }
      });
      const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
        registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
          refresh: options => registry.refresh(options), status: () => registry.status() },
        fetchForAccount: id => {
          if (id !== "deepseek-api") return async () => { throw new ModelConfigurationError("unexpected recovery account"); };
          return cellFetch;
        },
      });
      const result = await runResolutionAdmission(selected.source, gateway, { candidate: true, contextCodec: SHARED_BATCH_ORDER_CODEC,
        jsonSyntaxRecovery: policyFor(cell.arm), maxPhysicalRequests: 3, scope: { modelRegistrySnapshotHash: snapshot.hash, observer },
        onPhysicalRequest: request => {
          const evidence = admissionRequestEvidence(request); physical++;
          const expected = physical === 1 ? frozen.initialRequestHash : physical === 2 ? frozen.firstRepairRequestHash : undefined;
          if (stopped || (physical <= 2 && contentHash(evidence) !== expected)) { stopped = true; throw new ModelConfigurationError("frozen initial or first repair request changed"); }
          writeFileSync(path.join(directory, `${cell.rootId}-${cell.arm}-request-${physical}.json.gz`), gzipSync(JSON.stringify(evidence)), { flag: "wx" });
        } });
      const row = { ...cell, complete: result.complete, initialAdmittedActions: result.rows.filter(row => row.admittedFromPhysicalRequest === 1).reduce((sum, row) => sum + row.actions, 0),
        admittedSlots: result.rows.filter(row => row.admitted).length, admittedActions: result.rows.filter(row => row.admitted).reduce((sum, row) => sum + row.actions, 0),
        newHttp: dispatches - beforeHttp, localInitialResponseReplays: 1, modeledPipelineCalls: 1 + dispatches - beforeHttp,
        seededUsage: selected.seededUsage, physicalRequests: result.physicalRequests, elapsedReplayAndRepairMs: performance.now() - started,
        newPeakNanoCny: ledger.summary.estimatedPeakNanoCny - beforeCost, ...newUsage(beforeHttp + 1, dispatches), semanticVerdict: result.semanticVerdict, stepCommitted: false };
      writeFileSync(path.join(directory, `${cell.rootId}-${cell.arm}-result.json.gz`), gzipSync(JSON.stringify({ row, result, events: observer.events })), { flag: "wx" });
      rows.push(row); report(); console.log(JSON.stringify(row));
      if (stopped || ledger.summary.blockingUnknown.length || row.initialAdmittedActions !== frozen.initialAdmittedActions ||
        (cell.rootId === "016" && (!row.complete || row.newHttp !== 0))) throw new Error(failure ?? "control, initial evidence or billing integrity failed");
    }
    status = "completed";
  } catch (error) { status = "stopped"; failure = String(error); }
  finally { report(); registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, newHttp: dispatches, decision: syntaxRecoveryDecision(rows, status !== "completed") }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
