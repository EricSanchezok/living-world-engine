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
import { SHARED_BATCH_ORDER_CODEC, expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { UNMATCHED_CLOSER_RECOVERY } from "../../src/engine/models/unmatched-closer-recovery";
import { SHARED_STATE_FIRST_LAYOUT, serializeModelContext } from "../../src/engine/prompts/context-layout";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { prepareCatalogOrderProbe } from "./step-catalog-order-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";

const TRIAL = "probes-e2-state-prefix-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const namespace = contentHash({ trial: TRIAL, purpose: "common cold prefix isolation", version: 1 });
const layoutFor = (arm: string) => arm === "L" ? SHARED_STATE_FIRST_LAYOUT : undefined;
export type ProbeRow = { rootId: string; arm: string; complete: boolean; initialAdmittedActions: number; httpCalls: number;
  totalTokens: number | null; documentedKnownNanoCny: number | null };

export function statePrefixDecision(rows: ProbeRow[], incomplete: boolean) {
  if (incomplete || rows.length !== 4 || rows.some(row => row.totalTokens === null || row.documentedKnownNanoCny === null) ||
    ["016", "017"].some(rootId => ["B", "L"].some(arm => rows.filter(row => row.rootId === rootId && row.arm === arm).length !== 1))) return "inconclusive";
  const b = rows.filter(row => row.arm === "B"), l = rows.filter(row => row.arm === "L");
  const sum = (values: ProbeRow[], key: "initialAdmittedActions" | "httpCalls" | "totalTokens" | "documentedKnownNanoCny") => values.reduce((sum, row) => sum + row[key]!, 0);
  if (l.some(row => !row.complete) || sum(l, "initialAdmittedActions") < sum(b, "initialAdmittedActions")) return "failed";
  return sum(l, "httpCalls") <= sum(b, "httpCalls") && sum(l, "totalTokens") <= sum(b, "totalTokens") &&
    sum(l, "documentedKnownNanoCny") <= sum(b, "documentedKnownNanoCny") ? "eligible-for-source-semantic-review" : "failed";
}

export function cacheNamespaceRequest<T>(request: StructuredModelRequest<T>, id: string): StructuredModelRequest<T> {
  if (!/^[a-f0-9]{64}$/u.test(id) || request.system.includes("[Transport cache namespace:")) throw new ModelConfigurationError("invalid or repeated experiment cache namespace");
  return { ...request, system: `[Transport cache namespace: ${id}; this identifier carries no world facts or action instructions.]\n\n${request.system}`,
    promptVersion: `${request.promptVersion}/cache-namespace-${id}` };
}

function namespacedProvider(inner: StructuredModelProvider, onRequest: (request: StructuredModelRequest<unknown>) => void, namespaceId = namespace): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role), assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    generateStructured: request => { const selected = cacheNamespaceRequest(request, namespaceId); onRequest(selected); return inner.generateStructured(selected); } };
}

export async function prepareStatePrefixProbe() {
  const prepared = await prepareCatalogOrderProbe();
  const { catalog, snapshot } = prepared;
  const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline prefix capture"); } };
  const cases = [];
  for (const original of prepared.cases) {
    const initial: Record<string, ReturnType<typeof admissionRequestEvidence>> = {};
    for (const arm of ["B", "L"]) {
      const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
      await runResolutionAdmission(original.source, namespacedProvider(offline, request => captures.push(admissionRequestEvidence(request))), {
        candidate: true, contextCodec: SHARED_BATCH_ORDER_CODEC, jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY,
        contextLayout: layoutFor(arm), maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash },
      });
      if (captures.length !== 1) throw new Error("initial root cardinality changed");
      initial[arm] = captures[0]!;
      const context = initial[arm]!.context as { state: SharedBatchContext };
      if (contentHash(expandSharedBatchContexts(context.state)) !== contentHash(expandSharedBatchContexts((original.initial.D!.context as { state: SharedBatchContext }).state))) throw new Error("prefix layout lost original logical context");
      if (contentHash(JSON.parse(serializeModelContext(context, layoutFor(arm)))) !== contentHash(context)) throw new Error("prefix layout changed context values");
    }
    const independent = (arm: string) => Object.fromEntries(Object.entries(initial[arm]!).filter(([key]) => key !== "contextLayout"));
    if (contentHash(independent("B")) !== contentHash(independent("L"))) throw new Error("arms differ beyond context layout");
    cases.push({ ...original, initial });
  }
  const order = cases.flatMap(value => ["B", "L"].sort((a, b) => contentHash({ seed: 20260908, rootId: value.id, arm: a }).localeCompare(contentHash({ seed: 20260908, rootId: value.id, arm: b }))).map(arm => ({ rootId: value.id, arm })));
  const manifest = { trialId: TRIAL, seed: 20260908, order, maxHttp: 12, perArmRootMaxPhysicalRequests: 3, cacheNamespace: namespace,
    maximumRunNanoCny: 12 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: prepared.manifest.model, inference: prepared.manifest.inference,
    maxOutputTokens: prepared.manifest.maxOutputTokens, protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    sharedFoundation: { codec: SHARED_BATCH_ORDER_CODEC, parser: UNMATCHED_CLOSER_RECOVERY, nestedDiscriminatorDiagnostics: "cac04ae" },
    cases: cases.map(value => ({ rootId: value.id, sourceHash: contentHash(value.source), stateHash: contentHash(value.source.state), slots: value.slots,
      assignedActions: value.actions, availableActions: value.source.actions.length,
      initialRequestHashes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, contentHash(request)])) })),
    acceptance: "Fresh paired original roots, not new independent worlds. B and L share dependent fields, shared-json-v3, restricted closer recovery, corrected nested diagnostics, full 12/8 slots, 38/10 assigned actions, all 48 available actions and generation settings. Only L selects shared-state-first-v1 for shared physical envelopes; singleton rendering remains unchanged. Both arms have the same new, task-neutral system cache namespace so historical requests do not intentionally prewarm only B; no extra warmup call, all actual requests count. Provider caching remains best-effort: record actual hits, order, request start/completion, latency and cold-start costs. No replayed model responses. At most three HTTP per cell (initial plus up to two repairs), twelve total, no transport retries, verifier, RNG or world commit. Complete the fixed order unless interrupted or request/model/billing integrity fails. L must fully admit both roots, retain at least as many initial actions as B, and use no more total HTTP, total tokens or documented tariff cost than B. Missing usage/incomplete pairs are inconclusive. Report complete first-HTTP roots separately; the corrected diagnostics are a shared foundation, not a layout benefit. Passing only permits source-bound semantic review; it is neither a gameplay nor general reliability claim. No response-dependent prompt, parameter or source changes.",
  };
  return { ...prepared, cases, manifest };
}

function observedUsage(trialId: string, first: number, last: number) {
  let input = 0, output = 0, cacheHit = 0, documentedKnownNanoCny = 0, unknown = 0;
  for (let ordinal = first; ordinal <= last; ordinal++) try {
    const directory = path.join(root, "http", `${trialId}-http-${String(ordinal).padStart(3, "0")}`);
    const request = JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8"));
    const response = JSON.parse(readFileSync(path.join(directory, "response.json"), "utf8"));
    const usage = deepSeekExperimentUsage(JSON.parse(response.raw)); input += usage.input; output += usage.output; cacheHit += usage.cacheHit;
    documentedKnownNanoCny += documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny;
  } catch { unknown++; }
  return { knownUsage: { input, output, cacheHit }, totalTokens: unknown ? null : input + output, unknownUsageRequests: unknown,
    documentedKnownNanoCny: unknown ? null : documentedKnownNanoCny, providerBilledNanoCny: null };
}
export async function runSourceAdmissionProbe(spec: {
  trialId: string;
  prepare: () => Promise<Pick<Awaited<ReturnType<typeof prepareStatePrefixProbe>>, "catalog" | "registry" | "snapshot"> & {
    cases: Array<Pick<Awaited<ReturnType<typeof prepareStatePrefixProbe>>["cases"][number], "id" | "source" | "initial">>;
    manifest: Pick<Awaited<ReturnType<typeof prepareStatePrefixProbe>>["manifest"], "trialId" | "order" | "maxHttp" | "perArmRootMaxPhysicalRequests" | "maximumRunNanoCny" | "cacheNamespace"> & Record<string, unknown>;
  }>;
  decision: (rows: ProbeRow[], incomplete: boolean) => string;
  layoutFor: (arm: string) => StructuredModelRequest<unknown>["contextLayout"];
  adaptPhysicalProvider?: (arm: string, provider: StructuredModelProvider) => StructuredModelProvider;
  activityTemporalEvidenceFor?: (arm: string) => boolean;
} = { trialId: TRIAL, prepare: prepareStatePrefixProbe, decision: statePrefixDecision, layoutFor }) {
  const trialId = spec.trialId;
  if (!/^[a-z0-9-]+$/u.test(trialId)) throw new Error("invalid trial identifier");
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-state-prefix-probe.ts [prepare]");
  if (existsSync(path.join(root, "runs", trialId))) throw new Error("a frozen trial cannot restart or be re-prepared");
  const { catalog, registry, snapshot, cases, manifest } = await spec.prepare();
  if (manifest.trialId !== trialId) throw new Error("prepared trial identity mismatch");
  if (args[0] === "prepare") { console.log(JSON.stringify(manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const directory = path.join(root, "runs", trialId);
  if (existsSync(directory)) throw new Error("a frozen trial cannot restart");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined;
  const rows: ProbeRow[] = [], connections: unknown[] = [];
  let status = "preparing", failure: string | undefined, dispatches = 0, cellDispatches = 0, stopped = false;
  const stop = () => { stopped = true; };
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, rows,
    decision: spec.decision(rows, status !== "completed"), dispatches, updatedAt: new Date().toISOString(), budget: budget?.summary, connections }, null, 2));
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
      endpointPaths: ["/chat/completions"], trialPattern: new RegExp(`^${trialId}$`, "u"), requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const provider = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; }, refresh: options => registry.refresh(options), status: () => registry.status() },
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches >= manifest.maxHttp || cellDispatches >= manifest.perArmRootMaxPhysicalRequests) throw new ModelConfigurationError("probe HTTP gate stopped dispatch");
        try {
          const response = await transport.fetch(input, init), value = await response.clone().json();
          if (value.model !== STEP_E2_PROTOCOL.model) throw new ModelConfigurationError("provider response model changed");
          return response;
        } catch (error) { stopped = true; failure = error instanceof Error ? error.message : String(error); throw error; }
      },
    });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "initial-requests.json.gz"), gzipSync(JSON.stringify(cases.map(value => ({ rootId: value.id, initial: value.initial })))), { flag: "wx" });
    transport.beginTrial(trialId, "probes"); status = "running"; report();
    for (const cell of manifest.order) {
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error("interruption or unresolved billing stops next cell");
      const selected = cases.find(value => value.id === cell.rootId)!;
      const observer = new RecordingRuntimeObserver({ mode: "full" });
      cellDispatches = 0;
      const beforeHttp = dispatches, before = ledger.summary.estimatedPeakNanoCny, started = performance.now();
      let physical = 0;
      const verifierRequests: Array<{ slot: number; request: ReturnType<typeof admissionRequestEvidence> }> = [];
      const selectedProvider = namespacedProvider(provider, request => {
        const evidence = admissionRequestEvidence(request); physical++;
        if (stopped || (physical === 1 && contentHash(evidence) !== contentHash(selected.initial[cell.arm]))) {
          stopped = true; throw new ModelConfigurationError("frozen initial request changed");
        }
        writeFileSync(path.join(directory, `${cell.rootId}-${cell.arm}-request-${physical}.json.gz`), gzipSync(JSON.stringify(evidence)), { flag: "wx" });
      }, manifest.cacheNamespace);
      const result = await runResolutionAdmission(selected.source, spec.adaptPhysicalProvider?.(cell.arm, selectedProvider) ?? selectedProvider, { candidate: true, contextCodec: SHARED_BATCH_ORDER_CODEC,
        includeActivityTemporalEvidence: spec.activityTemporalEvidenceFor?.(cell.arm),
        jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY, contextLayout: spec.layoutFor(cell.arm), maxPhysicalRequests: manifest.perArmRootMaxPhysicalRequests,
        onVerifierRequest: (request, slot) => verifierRequests.push({ slot, request: admissionRequestEvidence(request) }),
        scope: { modelRegistrySnapshotHash: snapshot.hash, observer } });
      const row = { ...cell, complete: result.complete, initialAdmittedActions: result.rows.filter(row => row.admittedFromPhysicalRequest === 1).reduce((sum, row) => sum + row.actions, 0), firstHttpComplete: result.firstHttpComplete, admittedSlots: result.rows.filter(value => value.admitted).length,
        admittedActions: result.rows.filter(value => value.admitted).reduce((sum, value) => sum + value.actions, 0),
        httpCalls: cellDispatches, physicalRequests: result.physicalRequests, elapsedMs: performance.now() - started,
        peakNanoCny: ledger.summary.estimatedPeakNanoCny - before, ...observedUsage(trialId, beforeHttp + 1, dispatches),
        semanticVerdict: result.semanticVerdict, stepCommitted: false };
      writeFileSync(path.join(directory, `${cell.rootId}-${cell.arm}-result.json.gz`), gzipSync(JSON.stringify({ row, result, verifierRequests, events: observer.events })), { flag: "wx" });
      rows.push(row); report(); console.log(JSON.stringify(row));
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error(failure ?? "provider or billing integrity stopped the probe");
    }
    status = "completed";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId, status, failure, dispatches, budgetCny: budget ? budget.summary.estimatedPeakNanoCny / 1e9 : null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe().catch(error => { console.error(error); process.exitCode = 1; });
