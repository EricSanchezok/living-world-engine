import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { bindResolutionAdmission, runResolutionAdmission, type ResolutionAdmissionSource } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { recordedContext } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { expandSharedBatchContexts, SHARED_BATCH_CONTEXT_CODEC, SHARED_BATCH_ORDER_CODEC, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { admissionContextEvidence, admissionRequestEvidence } from "./step-runtime-admission-probe";

const TRIAL = "probes-e2-direct-order-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const INPUT_HASH = "5e606b19a800d8ca172baa13f502f679162ab56ee1aa0b5af2390e04823693de";
const PREPARATION_HASH = "249d7b231bfacfd04907f4c706483de99f7e847506d6fc6de386ba956f315fd6";
const ROOTS = [
  { id: "016", hash: "cd585fb32fcc78c7e9813ed75eef57ba32904c3f1d50cda7dfe12aea86cc3e0e", slots: 12, actions: 38 },
  { id: "017", hash: "c0448adc2803b82fcabfda7df602ca4e31381eddcc73acf76434f3c3dedf6dbe", slots: 8, actions: 10 },
];
const codecFor = (arm: string) => arm === "D" ? SHARED_BATCH_ORDER_CODEC : SHARED_BATCH_CONTEXT_CODEC;
type ProbeRow = { rootId: string; arm: string; firstHttpComplete: boolean; httpCalls: number; totalTokens: number | null };
export function catalogOrderDecision(rows: ProbeRow[], integrityFailed: boolean) {
  if (integrityFailed || rows.length !== 4 || rows.some(row => row.totalTokens === null || row.httpCalls !== 1) ||
    ROOTS.some(source => ["B", "D"].some(arm => rows.filter(row => row.rootId === source.id && row.arm === arm).length !== 1))) return "inconclusive";
  const baseline = rows.filter(row => row.arm === "B"), candidate = rows.filter(row => row.arm === "D");
  if (candidate.some(row => !row.firstHttpComplete)) return "failed";
  const sum = (values: ProbeRow[]) => values.reduce((total, row) => total + row.totalTokens!, 0);
  return sum(candidate) <= sum(baseline) * .8 ? "eligible-for-source-semantic-review" : "failed";
}

export async function prepareCatalogOrderProbe() {
  const artifact = (hash: string) => {
    const record = JSON.parse(readFileSync(path.join(root, "evidence/trajectory-e2-04/ledger-artifacts", `${hash}.json`), "utf8"));
    if (record.hash !== hash || contentHash(record.value) !== hash) throw new Error("original Ledger artifact mismatch");
    return record.value;
  };
  const input = artifact(INPUT_HASH), payload = artifact(PREPARATION_HASH).payload as {
    planningState: ResolutionAdmissionSource["state"]; newActions: ResolutionAdmissionSource["actions"];
    dependencyResults: Array<{ dependency: ResolutionAdmissionSource["groundings"][number] }>;
  };
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-04/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/finite-work-goal-02/model-catalog.json"));
  if (catalog.hash !== history.catalogHash) throw new Error("catalog mismatch");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const profileId = input.definition.modelProfiles.resolution;
  const profile = resolveModelProfile(catalog, snapshot, profileId);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled" ||
    profile.profile.max_output_tokens !== STEP_E2_PROTOCOL.outputTokenCeiling) throw new Error("nonthinking model binding mismatch");
  const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline layout capture"); } };
  const cases = [];
  for (const original of ROOTS) {
    const request = JSON.parse(readFileSync(path.join(root, `http/trajectory-e2-04-http-${original.id}/request.json`), "utf8"));
    if (request.bodyHash !== original.hash || contentHash(request.body) !== original.hash) throw new Error("original HTTP request mismatch");
    const contexts = expandSharedBatchContexts(recordedContext(request.body.messages[1].content).value.state as SharedBatchContext);
    const source: ResolutionAdmissionSource = { definition: input.definition, state: payload.planningState, actions: payload.newActions,
      groundings: payload.dependencyResults.map(entry => entry.dependency), contexts };
    const bindings = bindResolutionAdmission(source);
    if (bindings.length !== original.slots || bindings.reduce((sum, binding) => sum + binding.actions.length, 0) !== original.actions || source.actions.length !== 48) throw new Error("original root cardinality changed");
    const initial: Record<string, ReturnType<typeof admissionRequestEvidence>> = {};
    for (const arm of ["B", "D"]) {
      const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
      await runResolutionAdmission(source, offline, { candidate: true, maxPhysicalRequests: 1, contextCodec: codecFor(arm),
        scope: { modelRegistrySnapshotHash: snapshot.hash }, onPhysicalRequest: request => captures.push(admissionRequestEvidence(request)) });
      if (captures.length !== 1) throw new Error("initial request lost physical root cardinality");
      initial[arm] = captures[0]!;
      const projected = expandSharedBatchContexts((initial[arm]!.context as { state: SharedBatchContext }).state);
      if (projected.length !== contexts.length || projected.some((value, index) => admissionContextEvidence(value) !== admissionContextEvidence(contexts[index]))) throw new Error("runtime lost original contextual information");
    }
    const expand = (arm: string) => expandSharedBatchContexts((initial[arm]!.context as { state: SharedBatchContext }).state);
    if (contentHash(expand("B")) !== contentHash(expand("D"))) throw new Error("arms changed original logical information");
    const independent = (arm: string) => Object.fromEntries(Object.entries(initial[arm]!)
      .filter(([key]) => !["context", "promptVersion", "userPrompt"].includes(key)));
    if (contentHash(independent("B")) !== contentHash(independent("D"))) throw new Error("arms changed independent request settings");
    cases.push({ ...original, source, initial });
  }
  const order = ROOTS.flatMap(source => ["B", "D"].sort((a, b) => contentHash({ seed: 20260908, rootId: source.id, arm: a }).localeCompare(contentHash({ seed: 20260908, rootId: source.id, arm: b }))).map(arm => ({ rootId: source.id, arm })));
  const manifest = { trialId: TRIAL, seed: 20260908, order, maxHttp: 4, perArmRootMaxPhysicalRequests: 1,
    maximumRunNanoCny: 4 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    inputArtifact: INPUT_HASH, preparationArtifact: PREPARATION_HASH, stateHash: contentHash(payload.planningState),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, profileId, model: profile.modelId,
    inference: profile.profile.inference, maxOutputTokens: profile.profile.max_output_tokens,
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    cases: cases.map(value => ({ rootId: value.id, sourceRequestHash: value.hash, slots: value.slots, actions: value.actions,
      availableActions: value.source.actions.length, sourceHash: contentHash(value.source),
      initialRequestHashes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, contentHash(request)])),
      initialContextBytes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, Buffer.byteLength(JSON.stringify(request.context))])) })),
    acceptance: "Two failed original physical roots from trajectory-e2-04, not new independent worlds. Both arms use the dependent-field output codec, source inventory, physical cardinality and tail contract; only exact catalog-order factoring and its lookup instruction differ. Retain all original 12/8 slots, 38/10 assigned actions, all 48 available actions and full canonical state. Exactly one actual HTTP per arm/root; no repair, split, verifier, RNG or step commit. Run all four requests in frozen order unless interrupted or provider/billing integrity fails. D must fully admit both roots on the first HTTP and use at least 20% fewer aggregate total tokens than B, with no HTTP increase. Report each root and first-HTTP success difference; if B also passes both, do not claim a reliability improvement. Missing usage is inconclusive. Passing only permits source-bound review, never proves semantics or gameplay. No prompt adjustment or root replacement after observation.",
  };
  return { catalog, registry, snapshot, cases, manifest };
}

function observedUsage(ordinal: number) {
  try {
    const directory = path.join(root, "http", `${TRIAL}-http-${String(ordinal).padStart(3, "0")}`);
    const request = JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8"));
    const response = JSON.parse(readFileSync(path.join(directory, "response.json"), "utf8"));
    const usage = deepSeekExperimentUsage(JSON.parse(response.raw));
    return { knownUsage: usage, totalTokens: usage.input + usage.output, unknownUsageRequests: 0,
      documentedKnownNanoCny: documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny, providerBilledNanoCny: null };
  } catch { return { totalTokens: null, unknownUsageRequests: 1, providerBilledNanoCny: null }; }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-catalog-order-probe.ts [prepare]");
  if (existsSync(path.join(root, "runs", TRIAL))) throw new Error("a frozen trial cannot restart or be re-prepared");
  const { catalog, registry, snapshot, cases, manifest } = await prepareCatalogOrderProbe();
  if (args[0] === "prepare") { console.log(JSON.stringify(manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("a frozen trial cannot restart");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined;
  const rows: ProbeRow[] = [], connections: unknown[] = [];
  let status = "preparing", failure: string | undefined, dispatches = 0, cellDispatches = 0, stopped = false;
  const stop = () => { stopped = true; };
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, rows,
    decision: catalogOrderDecision(rows, status !== "completed"), dispatches, updatedAt: new Date().toISOString(), budget: budget?.summary, connections }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    mkdirSync(directory, { recursive: true });
    const ledger = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET); budget = ledger;
    const phase = ledger.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny, 0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete probe budget or unknown billing blocks dispatch");
    const account = catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured DeepSeek credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(ledger, { root, baseUrl: account.base_url,
      fetch: async (input, init) => { dispatches++; cellDispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-direct-order-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const provider = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; }, refresh: options => registry.refresh(options), status: () => registry.status() },
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches >= 4 || cellDispatches >= 1) throw new ModelConfigurationError("probe HTTP gate stopped dispatch");
        try {
          const response = await transport.fetch(input, init), value = await response.clone().json();
          if (value.model !== STEP_E2_PROTOCOL.model) throw new ModelConfigurationError("provider response model changed");
          return response;
        } catch (error) { stopped = true; failure = error instanceof Error ? error.message : String(error); throw error; }
      },
    });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "initial-requests.json.gz"), gzipSync(JSON.stringify(cases.map(value => ({ rootId: value.id, initial: value.initial })))), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    for (const cell of manifest.order) {
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error("interruption or unresolved billing stops next cell");
      const selected = cases.find(value => value.id === cell.rootId)!;
      const observer = new RecordingRuntimeObserver({ mode: "full" });
      cellDispatches = 0;
      const before = ledger.summary.estimatedPeakNanoCny, started = performance.now();
      const result = await runResolutionAdmission(selected.source, provider, { candidate: true, contextCodec: codecFor(cell.arm), maxPhysicalRequests: 1,
        scope: { modelRegistrySnapshotHash: snapshot.hash, observer }, onPhysicalRequest: request => {
          if (stopped || contentHash(admissionRequestEvidence(request)) !== contentHash(selected.initial[cell.arm])) throw new ModelConfigurationError("frozen initial request changed");
        } });
      const row = { ...cell, firstHttpComplete: result.firstHttpComplete, admittedSlots: result.rows.filter(value => value.admitted).length,
        admittedActions: result.rows.filter(value => value.admitted).reduce((sum, value) => sum + value.actions, 0),
        httpCalls: cellDispatches, physicalRequests: result.physicalRequests, elapsedMs: performance.now() - started,
        peakNanoCny: ledger.summary.estimatedPeakNanoCny - before, ...(cellDispatches === 1 ? observedUsage(dispatches) : { totalTokens: null, unknownUsageRequests: cellDispatches }),
        semanticVerdict: result.semanticVerdict, stepCommitted: false };
      writeFileSync(path.join(directory, `${cell.rootId}-${cell.arm}-result.json.gz`), gzipSync(JSON.stringify({ row, result, events: observer.events })), { flag: "wx" });
      rows.push(row); report(); console.log(JSON.stringify(row));
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error(failure ?? "provider or billing integrity stopped the probe");
    }
    status = "completed";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, dispatches, budgetCny: budget ? budget.summary.estimatedPeakNanoCny / 1e9 : null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
