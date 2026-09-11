import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STEP_E1_BUDGET, STEP_E1_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { executeCompilationTrial } from "../../src/engine/benchmarks/action-compilation/first-pass-runner";
import { firstPassAlgorithmRef } from "../../src/engine/benchmarks/action-compilation/first-pass-protocol";
import { readActionCompilationCapturedSources, validateActionCompilationCapturedSource, type RawBenchmarkSource } from "../../src/engine/benchmarks/source-capture";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { compileActions } from "../../src/engine/algorithms/eager-reference/action-compiler";
import type { CandidateSelectionResult } from "../../src/engine/algorithms/roles";
import type { SimulationState } from "../../src/engine/contracts/model";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { LocalDatabase } from "../../src/server/local-database";
import { probeInferenceEvidence } from "./step-json-probe";

const TRIAL = "probes-e1-eligible-01";
const EXECUTION = "4bb7be12-0720-4158-b401-13e9616ef056";
const INPUT_CEILING = 300_000;
const MAX_HTTP = 48;
const ACCEPTANCE = "E final 8/8, first successes >= B (strictly better unless both 8/8), HTTP <= B, total tokens <=1.05 B, no new determined semantic violation in source-bound inspection. This is a targeted engineering gate, not semantic certification or full-step acceptance.";

export function eligibilityProbeOrder(sourceIds: readonly string[]) {
  return sourceIds.flatMap((sourceId, sourceIndex) => Array.from({ length: 2 }, (_, repetition) =>
    (["B", "E"] as const).map((arm) => ({ id: `${sourceId}-${repetition}-${arm}`, sourceId, sourceIndex, repetition, arm,
      phase: "discovery" as const })).sort((a, b) => contentHash({ seed: STEP_E1_PROTOCOL.seed, ...a }).localeCompare(contentHash({ seed: STEP_E1_PROTOCOL.seed, ...b }))))).flat();
}

export async function loadStepCompilationProbeSources() {
  const dataRoot = path.resolve(".livingworld-v23");
  const database = new LocalDatabase(path.join(dataRoot, "livingworld.sqlite"), { readOnly: true });
  const events = database.executionEvents(EXECUTION);
  database.close();
  const sources = readActionCompilationCapturedSources(events);
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  if (sources.some((source) => source.modelCatalogHash !== catalog.hash)) throw new Error("source model catalog drift");
  const registry = new ModelRegistry(catalog, dataRoot, { fetch: async () => { throw new Error("probe cannot refresh model metadata"); } });
  const resources = createActionCompilationRetrievalRuntimeProvider();
  const boundary: StructuredModelProvider = { catalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => undefined,
    generateStructured: async () => { throw new ModelConfigurationError("offline probe boundary"); } };
  // A schema-rejected root has no post-generation capture event. Reconstruct
  // it from the same frozen state and exact audited action identities, then
  // require byte-canonical equality with its actual serialized model context.
  const missing = events.filter((event) => event.event === "model.context.serialized" &&
    event.correlation?.modelRole === "action-compilation" && (event.correlation.semanticRepairAttempt ?? 0) === 0 &&
    !sources.some((source) => source.sourceInvocationId === event.correlation?.modelInvocationId));
  for (const event of missing) {
    const base = sources[0];
    if (!base) throw new Error("no captured state for rejected source reconstruction");
    const state = base.stateSnapshot as SimulationState;
    const audit = events.find((entry) => entry.event === "model.action_compilation.references" &&
      entry.correlation?.modelInvocationId === event.correlation?.modelInvocationId)?.payload as { slots: Array<{ actionId: string; actor: { agentId: string } }> };
    const actions = audit.slots.map((slot) => {
      const action = state.agents[slot.actor.agentId]?.nextAction;
      if (!action || action.id !== slot.actionId) throw new Error("rejected source action binding mismatch");
      return action;
    });
    const execution = base.fullContext.execution as { instanceId: string; advanceId: string };
    const runtime = resources.runtime(base.captureAlgorithmRef)!;
    let fullContext: unknown, selected: CandidateSelectionResult | undefined;
    try {
      await compileActions(boundary, state, actions, { workloadId: execution.instanceId, batchId: execution.advanceId,
        runtimeIdentity: { worldHash: state.worldHash, revision: state.revision }, actionCompilationRetrieval: { ...runtime,
          retrieveBatch: async (request) => { fullContext = request.fullContext; selected = await runtime.retrieveBatch(request); return selected; } } }, base.profileId, actions.length);
    } catch (error) { if (!(error instanceof ModelConfigurationError) || error.message !== "offline probe boundary") throw error; }
    const actual = event.payload as { context: unknown; promptVersion: string };
    if (!selected || contentHash(actual.context) !== selected.modelContextHash || contentHash(state) !== base.stateHash) throw new Error("rejected source context/state reconstruction differs from recorded request");
    const source: RawBenchmarkSource = { ...base, sourceInvocationId: event.correlation!.modelInvocationId!,
      logicalInvocationId: event.correlation?.logicalInvocationId, actions, actionIds: actions.map((action) => action.id), slotIndices: actions.map((_, index) => index),
      fullContext: fullContext as Record<string, unknown>, fullContextHash: contentHash(fullContext),
      modelContextHash: selected.modelContextHash, shortlistHash: selected.shortlistHash,
      candidateCatalogHash: (fullContext as { referenceCatalog: { hash: string } }).referenceCatalog.hash, promptVersion: actual.promptVersion };
    // These optional producer diagnostics belong to the captured sibling,
    // not to this reconstruction; never inherit its output or cache evidence.
    for (const key of ["selectedKeysBySlot", "perSlotSelectedCount", "batchBudget", "batchShortlistRatio", "cache",
      "outputDisposition", "rawOutputHash", "normalizedOutputHash", "repairCount"]) delete (source as unknown as Record<string, unknown>)[key];
    sources.push(validateActionCompilationCapturedSource(source));
  }
  sources.sort((a, b) => a.sourceInvocationId.localeCompare(b.sourceInvocationId));
  if (sources.length !== 4 || sources.some((source) => source.actions.length !== 12)) throw new Error("expected the four complete trajectory-e1-01 root batches");
  return { sources, catalog, registry, resources, boundary,
    reconstructedInvocationIds: missing.map((event) => event.correlation?.modelInvocationId) };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-eligibility-probe.ts [prepare]");
  const root = path.resolve(STEP_E1_PROTOCOL.root), directory = path.join(root, "runs", TRIAL);
  const { sources, catalog, registry, resources, boundary, reconstructedInvocationIds } = await loadStepCompilationProbeSources();
  const order = eligibilityProbeOrder(sources.map((_, index) => `P0${index + 1}`));
  const manifest = { trialId: TRIAL, sourceExecution: EXECUTION, order, acceptance: ACCEPTANCE,
    protocolHash: contentHash(STEP_E1_PROTOCOL), budgetHash: contentHash(STEP_E1_BUDGET), catalogHash: catalog.hash,
    inputReservationCeiling: INPUT_CEILING, maxHttp: MAX_HTTP,
    sources: sources.map((source, index) => ({ id: `P0${index + 1}`, hash: contentHash(source), stateHash: source.stateHash,
      reconstructedFromLedger: reconstructedInvocationIds.includes(source.sourceInvocationId),
      modelContextHash: source.modelContextHash, fullContextHash: source.fullContextHash, shortlistHash: source.shortlistHash })) };
  for (const [index, source] of sources.entries()) {
    registry.snapshot(source.registrySnapshotHash);
    const trial = order.find((entry) => entry.sourceIndex === index && entry.arm === "E")!;
    const result = await executeCompilationTrial({ trial, source, provider: boundary, retrieval: resources.runtime(source.captureAlgorithmRef)!,
      compiler: representedActionCompiler("T", true), algorithmRef: firstPassAlgorithmRef(source.captureAlgorithmRef, "T", true),
      executionPrefix: TRIAL, expectedCatalogHash: catalog.hash, expectedOutputMode: "json-object-zod" });
    if (result.calls.length !== 1 || result.error?.message !== "offline probe boundary" ||
      contentHash(result.calls[0]!.context) !== source.modelContextHash) throw new Error(`offline source drift: ${JSON.stringify(result.error)}`);
  }
  if (process.argv[2] === "prepare") { console.log(JSON.stringify({ ...manifest, providerRequests: 0, contextChecks: 4 })); return; }
  if (existsSync(path.join(directory, "manifest.json"))) throw new Error("frozen probe cannot restart");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before probe freeze");
  mkdirSync(directory, { recursive: true });
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E1_BUDGET);
  const lock = path.join(root, "writer.lock");closeSync(openSync(lock, "wx"));
  let status = "preparing", failure: string | undefined, interrupted = false;
  const stop = () => { interrupted = true; };
  const rows: unknown[] = [];
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ trialId: TRIAL, status, failure,
    updatedAt: new Date().toISOString(), rows, budget: budget.summary }, null, 2));
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  try {
    if (Date.now() >= Date.parse(STEP_E1_PROTOCOL.deadlineUtc) || budget.summary.blockingUnknown.length) throw new Error("deadline or unsettled usage blocks probe");
    const used = budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny;
    const worstCase = MAX_HTTP * (INPUT_CEILING * 3520 + STEP_E1_PROTOCOL.outputTokenCeiling * 10560);
    if (used + worstCase > STEP_E1_BUDGET.maximumNanoCny) throw new Error("full probe exceeds remaining global budget");
    const probeGroup = STEP_E1_BUDGET.phaseBudgets!.find((group) => group.phases.includes("probes"))!;
    const groupKnown = probeGroup.phases.reduce((sum, phase) => sum + budget.summary.phases[phase].estimatedPeakNanoCny, 0);
    // Including ALL unresolved exposure is deliberately conservative here.
    if (groupKnown + budget.summary.reservedNanoCny + worstCase > probeGroup.maximumNanoCny) throw new Error("full probe exceeds remaining probes allocation");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, worstCaseNanoCny: worstCase,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2), { flag: "wx" });
    const account = catalog.account("deepseek-api");
    const accountFetch = createModelFetchResolver(process.env)("deepseek-api", account) ?? fetch;
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: accountFetch,
      inputTokenCeiling: INPUT_CEILING, outputTokenCeiling: STEP_E1_PROTOCOL.outputTokenCeiling,
      trialPattern: /^probes-e1-eligible-01$/u, priceBinding: { accountId: "deepseek-api", modelId: STEP_E1_PROTOCOL.model, priceId: "flash" } });
    transport.beginTrial(TRIAL, "probes");
    let httpCount = 0;
    const provider = createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
      fetchForAccount: (id) => async (input, init) => {
        if (id !== "deepseek-api" || interrupted || Date.now() >= Date.parse(STEP_E1_PROTOCOL.deadlineUtc) || ++httpCount > MAX_HTTP) throw new Error("probe stop boundary");
        return transport.fetch(input, init);
      } });
    status = "running";report();
    for (const trial of order) {
      if (interrupted || Date.now() >= Date.parse(STEP_E1_PROTOCOL.deadlineUtc)) throw new Error("probe interrupted or deadline reached");
      const source = sources[trial.sourceIndex]!;
      const before = httpCount;
      const result = await executeCompilationTrial({ trial, source, provider, retrieval: resources.runtime(source.captureAlgorithmRef)!,
        compiler: representedActionCompiler("T", trial.arm === "E"),
        algorithmRef: firstPassAlgorithmRef(source.captureAlgorithmRef, "T", trial.arm === "E"),
        executionPrefix: TRIAL, expectedCatalogHash: catalog.hash, expectedOutputMode: "json-object-zod" });
      writeFileSync(path.join(directory, `${trial.id}.json`), JSON.stringify(result), { flag: "wx" });
      const http = readdirSync(path.join(root, "http")).filter((id) => id.startsWith(`${TRIAL}-http-`)).sort().slice(before).map((id) => {
        const response = JSON.parse(readFileSync(path.join(root, "http", id, "response.json"), "utf8"));
        const raw = JSON.parse(response.raw);
        return { id, usage: deepSeekExperimentUsage(raw), ...probeInferenceEvidence(raw, "B") };
      });
      const first = result.events.find((event) => event.event === "model.action_compilation.slots.validated" && (event.correlation?.semanticRepairAttempt ?? 0) === 0);
      const row = { trial, accepted: result.compilerAccepted, initialAccepted: first?.counts?.accepted ?? 0,
        initialRejected: first?.counts?.rejected ?? 12, http, wallMs: result.wallMs, stateUnchanged: result.stateUnchanged,
        evidenceHash: contentHash(result), error: result.error?.message };
      rows.push(row);report();console.log(JSON.stringify({ ...row, http: http.length, error: row.error?.slice(0, 400) }));
      if (!http.length || http.some((entry) => !entry.inferenceValid) || budget.summary.blockingUnknown.length) throw new Error("probe model controls or billing failure");
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { report();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, completed: rows.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
