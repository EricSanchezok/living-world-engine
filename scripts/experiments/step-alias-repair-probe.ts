import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { AgentActionProposal, SimulationState } from "../../src/engine/contracts/model";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { ActionCompilationCodec, actionCompilationProfileKinds } from "../../src/engine/algorithms/eager-reference/action-compilation-representation";
import { shortlistEvidenceContext } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/shortlist-evidence";
import { actionCompilationMandatoryKeys } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import type { CandidateSelectionResult } from "../../src/engine/algorithms/roles";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, ModelSemanticRepairError, type ModelExecutionScope, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { seededResponseFetch } from "./step-syntax-recovery-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";

const TRIAL = "probes-e2-alias-repair-02";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const CAPTURE = "4989d202a97ba2046757ab007e77b8fcde622f024f15ea8fc304d96e1dc98bfc";
const REQUEST = "f7dae4a5cddce3f47d6f326dadcc516e84891b1d99721b4e8b4ea7be7de3afaf";
const SOURCE_HTTP = "trajectory-e2-05-http-010";
const compiler = representedActionCompiler("AT", true, true, true);
type Capture = { stateSnapshot: SimulationState; actions: AgentActionProposal[]; stateHash: string; fullContextHash: string; modelContextHash: string;
  fullContext: Record<string, unknown>; selectedKeysBySlot: Array<[number, string[]]>; batchBudget: number; batchShortlistRatio: number;
  shortlistHash: string; slotIndices: number[]; profileId: string; captureAlgorithmRef: ModelExecutionScope["executionAlgorithmRef"] };

export function aliasRepairDecision(complete: boolean, sourcePreserved: boolean, unknown: number, newHttp: number) {
  if (unknown || newHttp < 1 || newHttp > 2) return "inconclusive";
  return complete && sourcePreserved ? "eligible-for-source-review" : "failed";
}

export async function prepareAliasRepairProbe() {
  const artifact = (hash: string) => {
    const value = JSON.parse(readFileSync(path.join(root, "evidence/alias-repair-01/ledger-artifacts", `${hash}.json`), "utf8"));
    if (value.hash !== hash || contentHash(value.value) !== hash) throw new Error("source Ledger artifact changed");
    return value.value;
  };
  const source = artifact(CAPTURE) as Capture;
  // The failed instance retained the exact source snapshot and its member
  // insertion order. The Ledger copy proves values; persistence restores order
  // used by reference-handle allocation and embedded profile descriptions.
  const persistedState = JSON.parse(readFileSync(path.join(root, "evidence/alias-repair-01/persisted-state.json"), "utf8")) as SimulationState;
  if (contentHash(persistedState) !== source.stateHash) throw new Error("persisted source state changed");
  source.stateSnapshot = persistedState;
  const original = artifact(REQUEST) as { workloadId: string; batchId: string; registrySnapshotHash: string; modelCatalogHash: string; context: unknown; schema: unknown };
  const catalog = loadModelCatalog(path.join(root, "variants/finite-work-goal-02/model-catalog.json"));
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-05/manifest.json"), "utf8"));
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(original.registrySnapshotHash);
  if (catalog.hash !== original.modelCatalogHash || source.actions.length !== 12 || source.slotIndices.some((slot, index) => slot !== index) ||
    contentHash(source.stateSnapshot) !== source.stateHash || contentHash(source.fullContext) !== source.fullContextHash) throw new Error("original root binding changed");
  const candidates = (source.fullContext.referenceCatalog as { candidates: Array<{ candidateKey: string }> }).candidates;
  const keys = new Set(source.selectedKeysBySlot.flatMap(([, values]) => values));
  const modelContext = shortlistEvidenceContext(source.fullContext, candidates.map(value => value.candidateKey).filter(key => keys.has(key))).context;
  if (contentHash(modelContext) !== source.modelContextHash) throw new Error("original shortlist projection changed");
  // Ledger JSON canonicalizes object member order. Profile-choice descriptions
  // are JSON *strings*, so recover their original ordering from the recorded
  // schema while requiring identical candidate values and identifiers.
  const codec = new ActionCompilationCodec("AT", modelContext, source.fullContext, actionCompilationProfileKinds(source.stateSnapshot));
  const visible = (modelContext.referenceCatalog as { candidates: Array<{ candidateKey: string; kind: string; label: string; details: unknown }> }).candidates;
  function restoreOrdering(value: unknown) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(restoreOrdering); return; }
    const node = value as Record<string, unknown>;
    if (typeof node.const === "string" && /^r[0-9]+$/u.test(node.const) && typeof node.description === "string") {
      const candidate = visible.find(candidate => candidate.candidateKey === codec.inverseAliases.get(String(node.const)));
      const evidence = JSON.parse(node.description);
      if (!candidate || candidate.kind !== "temporal_profile" || candidate.label !== evidence.label || contentHash(candidate.details) !== contentHash(evidence.details)) throw new Error("recorded profile evidence differs from source");
      candidate.details = evidence.details;
    }
    Object.values(node).forEach(restoreOrdering);
  }
  restoreOrdering(original.schema);
  if (contentHash(modelContext) !== source.modelContextHash) throw new Error("profile ordering changed source meaning");
  const profile = resolveModelProfile(catalog, snapshot, source.profileId);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled") throw new Error("source model drift");
  const account = catalog.account("deepseek-api");
  const request = JSON.parse(readFileSync(path.join(root, "http", SOURCE_HTTP, "request.json"), "utf8"));
  const response = JSON.parse(readFileSync(path.join(root, "http", SOURCE_HTTP, "response.json"), "utf8"));
  if (contentHash(request.body) !== request.bodyHash || request.bodyHash !== "876c7390af945abd4babd138d42f69d33c4d67d012be4f46d5f995619836df63" ||
    contentHash(response.raw) !== response.rawHash) throw new Error("original HTTP evidence changed");
  const scope: ModelExecutionScope = { workloadId: original.workloadId, batchId: original.batchId,
    runtimeIdentity: { worldHash: source.stateSnapshot.worldHash, revision: source.stateSnapshot.revision },
    executionAlgorithmRef: source.captureAlgorithmRef, modelRegistrySnapshotHash: snapshot.hash,
    actionCompilationRetrieval: { version: "frozen-alias-repair-root-v1", role: "candidate-selection", retrieveBatch: async input => {
      if (contentHash(input.fullContext) !== source.fullContextHash || input.slotIndices.length !== 12) throw new ModelConfigurationError("original root retrieval changed");
      return { modelContext: structuredClone(modelContext), selectedKeysBySlot: new Map(source.selectedKeysBySlot),
        fullContextHash: source.fullContextHash, modelContextHash: source.modelContextHash, shortlistHash: source.shortlistHash,
        diagnostics: { selectedCount: keys.size, visibleCount: candidates.length, batchBudget: source.batchBudget, batchShortlistRatio: source.batchShortlistRatio,
          prunedReferenceCount: 0, budgetExceeded: false,
          anchorCount: new Set(source.slotIndices.flatMap(slot => actionCompilationMandatoryKeys(source.fullContext, slot))).size,
          perSlotSelectedCount: Object.fromEntries(source.selectedKeysBySlot.map(([slot, keys]) => [String(slot), keys.length])),
          cache: { passageHits: 0, passageMisses: 0, queryHits: 0, queryMisses: 0, readMs: 0, passageEncodeMs: 0, queryEncodeMs: 0, queryBatchSize: 0 } },
      } satisfies CandidateSelectionResult;
    } } };
  const replay = { bodyHash: request.bodyHash, response };
  const requests: ReturnType<typeof admissionRequestEvidence>[] = [];
  const offlineReplay = seededResponseFetch(replay, 0, async () => { throw new Error("offline replay cannot send"); });
  const gateway = createModelGateway(catalog, { [account.api_key_env]: "offline-preflight" }, { maxTransportAttempts: 1,
    registry: { catalog, capture: async () => snapshot, refresh: async () => { throw new Error("offline registry"); }, status: () => registry.status() },
    fetch: async (input, init) => {
      writeFileSync(path.join(root, "evidence/alias-repair-01/offline-body.json"), String(init?.body));
      return offlineReplay(input, init);
    } });
  const capture: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
    generateStructured: request => { requests.push(admissionRequestEvidence(request));
      if (requests.length > 1) throw new ModelConfigurationError("offline repair capture"); return gateway.generateStructured(request); } };
  try { await compiler(capture, source.stateSnapshot, source.actions, scope, source.profileId, 12); }
  catch (error) { if (!(error instanceof ModelConfigurationError) || error.message !== "offline repair capture") throw error; }
  if (requests.length !== 2 || contentHash(requests[0]!.context) !== contentHash(original.context)) throw new Error("replay did not expose the exact source and next repair");
  const oldRepair = JSON.parse(readFileSync(path.join(root, "evidence/alias-repair-01/original-first-repair.json"), "utf8"));
  const oldRepairHash = "9d04cec335089a12f09ca6e7016c0ecaca0c9ce08c2fea6adc088c0009bb04ff";
  if (contentHash(oldRepair) !== oldRepairHash) throw new Error("historical first repair changed");
  const corrected = structuredClone(oldRepair.context);
  let correctedValues = 0;
  for (const slot of corrected.task.slots) {
    const value = slot.issue?.originalValue;
    const alias = typeof value === "string" ? codec.aliases.get(value) : undefined;
    if (alias) { slot.issue.originalValue = alias; correctedValues++; }
  }
  const firstRepair = requests[1]!;
  for (const field of ["profileId", "role", "subjectId", "schemaName", "promptVersion", "system", "userPrompt", "schema"] as const) {
    if (contentHash(firstRepair[field]) !== contentHash(oldRepair[field])) throw new Error(`historical repair ${field} drift`);
  }
  if (correctedValues !== 6 || contentHash(corrected) !== contentHash(firstRepair.context) ||
    firstRepair.modelRegistrySnapshotHash !== oldRepair.registrySnapshotHash || firstRepair.wireJsonSchema != null ||
    firstRepair.jsonExamplePolicy != null || firstRepair.repairContextPlacement != null) throw new Error("repair changed beyond the six rejected reference aliases");
  const manifest = { trialId: TRIAL, sourceTrialId: "trajectory-e2-05", sourceHttp: SOURCE_HTTP, captureHash: CAPTURE, requestArtifactHash: REQUEST,
    historicalFirstRepairHash: oldRepairHash, correctedValues,
    sourceRequestHash: replay.bodyHash, sourceResponseHash: response.rawHash, stateHash: source.stateHash, actionsHash: contentHash(source.actions),
    fullContextHash: source.fullContextHash, modelContextHash: source.modelContextHash, selectedKeysHash: contentHash(source.selectedKeysBySlot),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: profile.modelId, inference: profile.profile.inference,
    initialRequestHash: contentHash(requests[0]), firstRepairRequestHash: contentHash(requests[1]), originalActions: 12,
    maxNewHttp: 2, maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    seededUsage: deepSeekExperimentUsage(JSON.parse(response.raw)),
    acceptance: "Frozen-response repair feasibility, not a fresh first-pass or paired effectiveness estimate. Reconstruct the original complete 12-action root, state, scoped shortlist and source-owned AT compiler. Replay only its immutable first HTTP response locally after actual request-body hash verification; historical usage is not recharged. The only correction is schema-bound alias encoding of repair originalValue; existing root identities, actions, prompts, schemas, full context and generation settings remain intact. Permit at most two new repair HTTP, no transport retries, automatic redraw, added planner or stronger thinking. All 12 original actions must compile through real reference/temporal validation with exact source descriptions and unchanged source state. Preserve valid slots and assess final plans against original actions before a new whole-world trial. Unknown billing, drift or incomplete output cannot pass. No game commit or calibrated semantic claim. Record initial replay evidence separately from actual paid requests, cache and latency.",
  };
  return { catalog, registry, snapshot, source, scope, replay, manifest, requests };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-alias-repair-probe.ts [prepare]");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("frozen alias probe cannot restart");
  const { catalog, registry, snapshot, source, scope, replay, manifest, requests } = await prepareAliasRepairProbe();
  if (args[0] === "prepare") {
    writeFileSync(path.join(root, "evidence/alias-repair-01/offline-requests.json.gz"), gzipSync(JSON.stringify(requests)));
    registry.stopBackgroundRefresh(); console.log(JSON.stringify(manifest, null, 2)); return;
  }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx"));
  const observer = new RecordingRuntimeObserver({ mode: "full" }), connections: unknown[] = [];
  let status = "preparing", failure: string | undefined, stopped = false, newHttp = 0, physical = 0;
  let budget: ExperimentBudget | undefined, result: Awaited<ReturnType<typeof compiler>> | undefined;
  let costs: Array<{ usage: ReturnType<typeof deepSeekExperimentUsage>; documentedNanoCny: number }> = [], unknown = 0;
  const stop = () => { stopped = true; };
  const sourcePreserved = () => contentHash(source.stateSnapshot) === source.stateHash && !!result && result.compilations.length === 12 &&
    result.compilations.every(value => { const action = source.actions.find(action => action.id === value.plan.actionId);
      return !!action && contentHash(value.activity.sourceAction) === contentHash(action) && value.plan.description === action.rawText; });
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, newHttp, physical,
    complete: !!result && result.compilations.length === 12, sourcePreserved: sourcePreserved(),
    decision: status === "completed" ? aliasRepairDecision(!!result, sourcePreserved(), unknown, newHttp) : "inconclusive",
    costs, unknownUsageRequests: unknown, budget: budget?.summary, connections, updatedAt: new Date().toISOString() }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    mkdirSync(directory, { recursive: true });
    const ledger = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET); budget = ledger;
    const phase = ledger.summary.phaseBudgets.find(value => value.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny, 0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete repair budget or unknown billing blocks dispatch");
    const account = catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured DeepSeek credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account) ?? fetch;
    const transport = new FirstPassExperimentTransport(ledger, { root, baseUrl: account.base_url,
      fetch: async (input, init) => { newHttp++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-alias-repair-02$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const seeded = seededResponseFetch(replay, 2, async (input, init) => {
      if (stopped || ledger.summary.blockingUnknown.length) throw new ModelConfigurationError("repair probe stopped before dispatch");
      const timeout = AbortSignal.timeout(300_000);
      const response = await transport.fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout });
      if ((await response.clone().json()).model !== STEP_E2_PROTOCOL.model) throw new ModelConfigurationError("response model drift");
      return response;
    });
    const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; }, refresh: options => registry.refresh(options), status: () => registry.status() },
      // Gate actual dispatch, not registration of unused catalog accounts.
      fetchForAccount: id => id === "deepseek-api" ? seeded : async () => { throw new ModelConfigurationError("unapproved account dispatch"); } });
    const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
      generateStructured: request => {
        const evidence = admissionRequestEvidence(request); physical++;
        if (stopped || (physical <= 2 && contentHash(evidence) !== contentHash(requests[physical - 1]))) throw new ModelConfigurationError("frozen source or first repair changed");
        writeFileSync(path.join(directory, `request-${physical}.json.gz`), gzipSync(JSON.stringify(evidence)), { flag: "wx" });
        return gateway.generateStructured(request);
      } };
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    result = await compiler(provider, source.stateSnapshot, source.actions, { ...scope, observer }, source.profileId, 12);
    if (stopped || ledger.summary.blockingUnknown.length) throw new Error("interruption or unresolved billing");
    status = "completed";
  } catch (error) { status = error instanceof ModelSemanticRepairError ? "completed" : "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally {
    costs = []; unknown = 0;
    for (let i = 1; i <= newHttp; i++) try {
      const http = path.join(root, "http", `${TRIAL}-http-${String(i).padStart(3, "0")}`);
      const request = JSON.parse(readFileSync(path.join(http, "request.json"), "utf8")), response = JSON.parse(readFileSync(path.join(http, "response.json"), "utf8"));
      const usage = deepSeekExperimentUsage(JSON.parse(response.raw)); costs.push({ usage, documentedNanoCny: documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny });
    } catch { unknown++; }
    writeFileSync(path.join(directory, "result.json.gz"), gzipSync(JSON.stringify({ result, events: observer.events })), { flag: "wx" });
    report(); registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock);
  }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, newHttp, complete: !!result, sourcePreserved: sourcePreserved(),
    decision: status === "completed" ? aliasRepairDecision(!!result, sourcePreserved(), unknown, newHttp) : "inconclusive" }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
