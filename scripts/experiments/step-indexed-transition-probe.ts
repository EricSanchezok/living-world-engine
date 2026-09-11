import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { truthTransitionBatchSchema } from "../../src/engine/contracts/llm-schemas";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { scoreRepairTail } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { SourceIndexedTransitionCodec, indexedTransitionRequest } from "../../src/engine/mechanics/source-indexed-transition";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { bindTruthBatchCardinality, SHARED_SLOT_RESULT_INSTRUCTION } from "../../src/engine/mechanics/truth-batch-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, modelInvocationIdentity, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { promptBundle } from "../../src/engine/prompts";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { probeInferenceEvidence } from "./step-json-probe";
import { cacheNamespaceRequest } from "./step-state-prefix-probe";

const TRIAL = "probes-e2-indexed-transition-02";
const SOURCE_HASH = "94449d84514493f039d659e9dd5c72cf589ac2acc29e7e9f7e9f116b1de13934";
const root = path.resolve(STEP_E2_PROTOCOL.root);
type Row = { repeat: number; complete: boolean; http: number; tokens: number | null; rawJson: boolean };
export function indexedTransitionDecision(rows: Row[], integrityFailed: boolean) {
  if (integrityFailed || rows.some(row => row.http !== 1 || row.tokens === null)) return "inconclusive";
  if (rows.some(row => !row.complete || !row.rawJson)) return "failed-full-root-admission";
  return rows.length === 2 && rows.every((row, index) => row.repeat === index)
    ? "eligible-for-source-semantic-review-no-gameplay-claim" : "inconclusive";
}

export function requireProbeDispatch(count: number, error?: string): void {
  if (count !== 1) throw new ModelConfigurationError(error ?? `expected one HTTP dispatch, observed ${count}`);
}

export function loadFrozenTransitionSource() {
  const source = JSON.parse(readFileSync(path.join(root, "evidence/indexed-checkpoint-09/context-987.json"), "utf8"));
  if (contentHash(source) !== SOURCE_HASH || source.schemaName !== "truth_transition_batch" || source.resolvedInference.thinking !== "disabled") throw new Error("frozen transition source changed");
  const codec = new SourceIndexedTransitionCodec(source.context);
  if (codec.base.count !== 12 || codec.actions.length !== 43) throw new Error("complete original root changed");
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-09/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/short-action-checkpoints-01/model-catalog.json"));
  if (catalog.hash !== history.catalogHash || history.commit !== "9faf7869dcd5807344532e522eee0cf435b0bb3f") throw new Error("model foundation changed");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash), profile = resolveModelProfile(catalog, snapshot, source.profileId);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || contentHash(profile.profile) !== contentHash(source.profile)) throw new Error("profile or generation settings changed");
  const runtimeIdentity = { worldHash: "sha256:7ecd5071b319d79c7765fb8983ef545a2d7cad4e8f2c70dffbca832c4d4e146d", revision: source.context.execution.revision as number };
  if (runtimeIdentity.revision !== 0) throw new Error("frozen runtime revision changed");
  return { source, codec, catalog, registry, snapshot, profile, runtimeIdentity, sourceHash: SOURCE_HASH,
    contexts: expandSharedBatchContexts(source.context.state as SharedBatchContext) };
}

export function prepareIndexedTransitionProbe() {
  const { source, codec, catalog, registry, snapshot, profile, runtimeIdentity } = loadFrozenTransitionSource();
  const prompt = promptBundle("truth-transition"), marker = source.userPrompt.indexOf(SHARED_SLOT_RESULT_INSTRUCTION);
  if (marker < 0 || source.userPrompt.split(SHARED_SLOT_RESULT_INSTRUCTION).length !== 2) throw new Error("original batch instruction drift");
  const canonical: StructuredModelRequest<unknown> = { profileId: source.profileId, role: "truth-transition", subjectId: "frozen-twelve-slot-transition",
    workloadId: TRIAL, batchId: TRIAL,
    runtimeIdentity,
    promptVersion: prompt.version, system: prompt.system,
    userPrompt: prompt.userPrompt + "\n\n" + source.userPrompt.slice(marker), context: source.context,
    schemaName: "truth_transition_batch", schema: bindTruthBatchCardinality(truthTransitionBatchSchema, 12),
    modelRegistrySnapshotHash: snapshot.hash, jsonExamplePolicy: "omit", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1" };
  if (canonical.runtimeIdentity!.revision !== 0) throw new Error("frozen runtime revision changed");
  modelInvocationIdentity(canonical, canonical.role, canonical.subjectId, 1);
  const request = cacheNamespaceRequest(indexedTransitionRequest(canonical), contentHash({ trial: TRIAL, version: 1 }));
  const evidence = admissionRequestEvidence(request);
  const manifest = { trialId: TRIAL, sourceTrialId: "trajectory-e2-09", sourceSequence: 987, sourceHash: SOURCE_HASH,
    sourceContextHash: codec.sourceHash, runtimeIdentity: canonical.runtimeIdentity, slots: 12, actions: 43, repeats: 2, maxHttp: 2,
    maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: profile.modelId, profile: profile.profile,
    protocolHash: contentHash(STEP_E2_PROTOCOL), initialRequestHash: contentHash(evidence),
    acceptance: "Two fresh initial requests on the same complete12-slot/43-action frozen transition source, not two independent worlds. Keep all source context and candidate domains, disabled-thinking Flash and generation parameters. Only the corrected assertion contract and source-indexed flat transition representation change. No examples, warmup, repair, transport retry, redraw, semantic verifier,RNG or commit. Stop on first strict-JSON/schema/complete-action/reference-scope failure or model/billing uncertainty; preserve partial evidence. Both roots must pass and every action undergo independent source-state semantic inspection before a new gameplay diagnostic can be considered. Record cache hits, latency, token volume, conservative budget and documented CNY tariff separately. No historical comparison establishes improvement; no formal result establishes world effects or gameplay.",
  };
  return { catalog, registry, snapshot, request, evidence, manifest, contexts: expandSharedBatchContexts(source.context.state as SharedBatchContext) };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-indexed-transition-probe.ts [prepare]");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("frozen trial cannot restart or be re-prepared");
  const design = prepareIndexedTransitionProbe();
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(design.manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, dispatches = 0, cellDispatchLimit = 0;
  const rows: Row[] = [], connections: unknown[] = [], stop = () => { stopped = true; };
  mkdirSync(directory, { recursive: true });
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest, status, failure, dispatches,
    rows, connections, decision: indexedTransitionDecision(rows, status !== "completed" && !rows.some(row => !row.complete)), budget: budget?.summary, updatedAt: new Date().toISOString() }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const ledger = budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET), phase = ledger.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny, 0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete trial budget or unknown billing blocks dispatch");
    const account = design.catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured DeepSeek credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(ledger, { root, baseUrl: account.base_url, fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-indexed-transition-02$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const gateway = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog: design.catalog, capture: async hash => { if (hash && hash !== design.snapshot.hash) throw new ModelConfigurationError("registry drift"); return design.snapshot; },
        refresh: options => design.registry.refresh(options), status: () => design.registry.status() },
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches >= 2 || dispatches >= cellDispatchLimit) throw new ModelConfigurationError("probe HTTP gate stopped dispatch");
        return transport.fetch(input, init);
      } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "initial-request.json.gz"), gzipSync(JSON.stringify(design.evidence)), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    for (let repeat = 0; repeat < 2; repeat++) {
      if (stopped || ledger.summary.blockingUnknown.length || contentHash(admissionRequestEvidence(design.request)) !== design.manifest.initialRequestHash) throw new Error("interruption, billing or request drift");
      const observer = new RecordingRuntimeObserver({ mode: "full" }), before = dispatches, started = performance.now();
      cellDispatchLimit = before + 1;
      let value: unknown, error: string | undefined;
      try { value = (await gateway.generateStructured({ ...design.request, batchId: `${TRIAL}/${repeat}`, observer })).value; }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      writeFileSync(path.join(directory, `repeat-${repeat}-attempt.json.gz`), gzipSync(JSON.stringify({ error, dispatches: dispatches - before, value, events: observer.events })), { flag: "wx" });
      requireProbeDispatch(dispatches - before, error);
      const httpDirectory = path.join(root, "http", `${TRIAL}-http-${String(dispatches).padStart(3, "0")}`);
      const request = JSON.parse(readFileSync(path.join(httpDirectory, "request.json"), "utf8"));
      const response = JSON.parse(readFileSync(path.join(httpDirectory, "response.json"), "utf8")), raw = JSON.parse(response.raw), usage = deepSeekExperimentUsage(raw);
      const inference = probeInferenceEvidence(raw, "B");
      if (!inference.inferenceValid) throw new Error(inference.inferenceError ?? "model inference response drift");
      let rawJson = true; try { JSON.parse(raw.choices[0].message.content); } catch { rawJson = false; }
      const score = scoreRepairTail(JSON.stringify(value ?? null), "transition", design.contexts);
      const row = { repeat, complete: value !== undefined && score.schemaCoverageReferences && rawJson, rawJson, http: dispatches - before,
        tokens: usage.input + usage.output, usage, inference, elapsedMs: performance.now() - started,
        documentedNanoCny: documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny,
        error: error ?? score.error, semantics: "unassessed", stepCommitted: false };
      rows.push(row); writeFileSync(path.join(directory, `repeat-${repeat}.json.gz`), gzipSync(JSON.stringify({ row, value, events: observer.events })), { flag: "wx" }); report();
      console.log(JSON.stringify({ ...row, error: row.error?.slice(0, 400) }));
      if (!row.complete) throw new Error("first failed root makes the frozen gate unattainable");
    }
    status = "completed";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); design.registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, dispatches, budgetCny: budget ? budget.summary.estimatedPeakNanoCny / 1e9 : null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
