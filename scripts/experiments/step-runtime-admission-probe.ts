import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { deepSeekExperimentUsage, ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { bindResolutionAdmission, runResolutionAdmission, type ResolutionAdmissionSource } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { recordedContext } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";

const TRIAL = "probes-e2-runtime-admission-01";
const SOURCE_HASH = "e3bce6a1e01dc77a7341cce12cd947a831173c4274cd6eba31aa98216564c752";
const PREPARATION_HASH = "f14bbd67795c5979cf529ef87e0c6766a818087bdbfacfdb6a7bf6fa6acbee33";
const INPUT_HASH = "80e17a2146b35a4d5113251258f33695a919da115afb9f8d80f1ed7ecb709381";
const root = path.resolve(STEP_E2_PROTOCOL.root);

type AdmissionArm = { arm: string; complete: boolean; httpCalls: number; totalTokens: number | null };
export function admissionDecision(rows: AdmissionArm[], integrityFailed: boolean) {
  const baseline = rows.find(row => row.arm === "B"), candidate = rows.find(row => row.arm === "C");
  if (integrityFailed || !baseline || !candidate || rows.some(row => row.totalTokens === null)) return "inconclusive";
  if (!candidate.complete) return "failed";
  return !baseline.complete || (candidate.httpCalls <= baseline.httpCalls && candidate.totalTokens! <= baseline.totalTokens! * 0.9)
    ? "eligible-for-source-semantic-review" : "failed";
}

function observedUsage(first: number, last: number) {
  let input = 0, output = 0, cacheHit = 0, unknown = 0, documentedNanoCny = 0;
  for (let ordinal = first; ordinal <= last; ordinal++) {
    try {
      const directory = path.join(root, "http", `${TRIAL}-http-${String(ordinal).padStart(3, "0")}`);
      const request = JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8"));
      const response = JSON.parse(readFileSync(path.join(directory, "response.json"), "utf8"));
      const usage = deepSeekExperimentUsage(JSON.parse(response.raw));
      input += usage.input; output += usage.output; cacheHit += usage.cacheHit;
      documentedNanoCny += documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny;
    } catch { unknown++; }
  }
  return { knownUsage: { input, output, cacheHit }, unknownUsageRequests: unknown,
    totalTokens: unknown ? null : input + output, documentedKnownNanoCny: documentedNanoCny, providerBilledNanoCny: null };
}

export function admissionRequestEvidence(request: StructuredModelRequest<unknown>) {
  return { profileId: request.profileId, role: request.role, subjectId: request.subjectId, schemaName: request.schemaName,
    promptVersion: request.promptVersion, system: request.system, userPrompt: request.userPrompt, context: request.context,
    schema: z.toJSONSchema(request.schema, { target: "draft-07" }), wireJsonSchema: request.wireJsonSchema ?? null,
    jsonExamplePolicy: request.jsonExamplePolicy ?? null, repairContextPlacement: request.repairContextPlacement ?? null,
    ...(request.jsonSyntaxRecovery ? { jsonSyntaxRecovery: request.jsonSyntaxRecovery } : {}),
    ...(request.contextLayout ? { contextLayout: request.contextLayout } : {}),
    modelRegistrySnapshotHash: request.modelRegistrySnapshotHash ?? null };
}

/** Normalize only unordered inventories for comparison, never for a request. */
export function admissionContextEvidence(context: unknown) {
  const result = structuredClone(context) as {
    referenceCatalog: { candidates: Array<{ handle: string }>; hash: string };
    state: { actors: Array<{ boundCanonicalEntityRefs: string[] }>;
      actionSet: { assigned: Array<{ allowedMeansSources?: unknown[] }> } };
  };
  result.referenceCatalog.candidates.sort((a, b) => a.handle.localeCompare(b.handle));
  result.referenceCatalog.hash = contentHash(result.referenceCatalog.candidates);
  result.state.actors.forEach(actor => actor.boundCanonicalEntityRefs.sort());
  result.state.actionSet.assigned.forEach(action => action.allowedMeansSources?.sort((a, b) => contentHash(a).localeCompare(contentHash(b))));
  return contentHash(result);
}

export async function prepareRuntimeAdmission() {
  const artifact = (hash: string) => {
    const record = JSON.parse(readFileSync(path.join(root, "evidence/coupled-repair-01/ledger-artifacts", `${hash}.json`), "utf8"));
    if (record.hash !== hash || contentHash(record.value) !== hash) throw new Error("original Ledger artifact mismatch");
    return record.value;
  };
  const input = artifact(INPUT_HASH), prepared = artifact(PREPARATION_HASH);
  const payload = prepared.payload as { planningState: ResolutionAdmissionSource["state"]; newActions: ResolutionAdmissionSource["actions"];
    dependencyResults: Array<{ dependency: ResolutionAdmissionSource["groundings"][number] }> };
  const request = JSON.parse(readFileSync(path.join(root, "http/trajectory-e2-02-http-020/request.json"), "utf8"));
  if (request.bodyHash !== SOURCE_HASH || contentHash(request.body) !== SOURCE_HASH) throw new Error("original HTTP request mismatch");
  const contexts = expandSharedBatchContexts(recordedContext(request.body.messages[1].content).value.state as SharedBatchContext);
  const source: ResolutionAdmissionSource = { definition: input.definition, state: payload.planningState, actions: payload.newActions,
    groundings: payload.dependencyResults.map(entry => entry.dependency), contexts };
  const bindings = bindResolutionAdmission(source);
  if (bindings.length !== 12 || bindings.reduce((sum, binding) => sum + binding.actions.length, 0) !== 43) throw new Error("original root cardinality changed");
  const catalog = loadModelCatalog(path.join(root, "variants/nonthinking-current/model-catalog.json"));
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-02/manifest.json"), "utf8"));
  if (catalog.hash !== history.catalogHash) throw new Error("catalog mismatch");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const profileId = source.definition.modelProfiles.resolution;
  const profile = resolveModelProfile(catalog, snapshot, profileId);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled" ||
    profile.profile.max_output_tokens !== STEP_E2_PROTOCOL.outputTokenCeiling) throw new Error("nonthinking model binding mismatch");
  const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline admission capture"); } };
  const initial: Record<string, ReturnType<typeof admissionRequestEvidence>> = {};
  for (const arm of ["B", "C"]) {
    const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
    await runResolutionAdmission(source, offline, { candidate: arm === "C", maxPhysicalRequests: 1,
      scope: { modelRegistrySnapshotHash: snapshot.hash }, onPhysicalRequest: value => captures.push(admissionRequestEvidence(value)) });
    if (captures.length !== 1) throw new Error("initial request did not retain one physical root batch");
    initial[arm] = captures[0]!;
    const projected = expandSharedBatchContexts((initial[arm]!.context as { state: SharedBatchContext }).state);
    if (projected.some((value, index) => admissionContextEvidence(value) !== admissionContextEvidence(contexts[index]))) throw new Error("runtime lost original contextual information");
  }
  if (contentHash(initial.B!.context) !== contentHash(initial.C!.context)) throw new Error("arms changed input context");
  const order = ["B", "C"].sort((a, b) => contentHash({ seed: 20260908, arm: a }).localeCompare(contentHash({ seed: 20260908, arm: b })));
  const maximumRunNanoCny = 6 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken);
  const manifest = { trialId: TRIAL, seed: 20260908, order, maximumRunNanoCny, maxHttp: 6, perArmMaxPhysicalRequests: 3,
    sourceRequestHash: SOURCE_HASH, preparationArtifact: PREPARATION_HASH, inputArtifact: INPUT_HASH,
    sourceHash: contentHash(source), stateHash: contentHash(source.state), catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash,
    profileId, model: profile.modelId, inference: profile.profile.inference, maxOutputTokens: profile.profile.max_output_tokens,
    initialRequestHashes: Object.fromEntries(Object.entries(initial).map(([arm, value]) => [arm, contentHash(value)])),
    contextHash: contentHash(initial.B!.context), slots: 12, actions: 43, availableActions: source.actions.length,
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    acceptance: "One development root, not a population estimate. B=current source-inventory context with repaired runtime and physical contract; C=the dependent-field wire candidate with identical context and generation. Use actual TruthEngine and batch coordinator, preserve valid logical slots, existing two structural/two semantic repair ceilings; stop each arm before its fourth physical request. At most six HTTP total, no transport retry or new critic. Stop each admitted component at the semantic-verifier boundary before any verifier call or RNG. C must admit all 43 plans within its ceiling and beat B in complete admission, or if both complete use no more HTTP and at least 10% fewer total tokens. Passing admits source-bound semantic review only, never gameplay or open-semantic proof. Incomplete short outputs do not establish efficiency. Run both arms in the frozen order unless interrupted or billing/model integrity fails. A failed ceiling is a bounded diagnostic outcome, not proof that all runtime recovery would fail. Freeze candidate and independently review source action meaning before any fresh full-world diagnostic.",
  };
  return { source, catalog, registry, snapshot, initial, manifest };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-runtime-admission-probe.ts [prepare]");
  const prepared = await prepareRuntimeAdmission();
  const { source, catalog, registry, snapshot, initial, manifest } = prepared;
  if (args[0] === "prepare") { console.log(JSON.stringify(manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid admission");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("a frozen trial cannot restart");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined;
  const rows: AdmissionArm[] = [], connections: unknown[] = [];
  let status = "preparing", failure: string | undefined, dispatches = 0, armDispatches = 0, stopped = false;
  const stop = () => { stopped = true; };
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, rows,
    decision: admissionDecision(rows, status !== "completed"),
    dispatches, updatedAt: new Date().toISOString(), budget: budget?.summary, connections }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    mkdirSync(directory, { recursive: true });
    const ledger = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    budget = ledger;
    const phase = budget.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || used + budget.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete trial budget or unknown billing blocks dispatch");
    const account = catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured DeepSeek credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(ledger, { root, baseUrl: account.base_url,
      fetch: async (input, init) => { dispatches++; armDispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-runtime-admission-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const provider = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
        refresh: options => registry.refresh(options), status: () => registry.status() },
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches >= 6 || armDispatches >= 3) throw new ModelConfigurationError("admission HTTP gate stopped dispatch");
        try {
          const response = await transport.fetch(input, init);
          const value = await response.clone().json();
          if (value.model !== STEP_E2_PROTOCOL.model) throw new ModelConfigurationError("provider response model changed");
          return response;
        } catch (error) {
          stopped = true; failure = error instanceof Error ? error.message : String(error); throw error;
        }
      },
    });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: budget.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "initial-requests.json.gz"), gzipSync(JSON.stringify(initial)), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    for (const arm of manifest.order) {
      if (stopped || budget.summary.blockingUnknown.length) throw new Error("interruption or unresolved billing stops next arm");
      const observer = new RecordingRuntimeObserver({ mode: "full" });
      armDispatches = 0; let logicalPhysicalCount = 0;
      const before = budget.summary.estimatedPeakNanoCny, started = performance.now(), firstHttp = dispatches + 1;
      const result = await runResolutionAdmission(source, provider, { candidate: arm === "C", maxPhysicalRequests: 3,
        scope: { modelRegistrySnapshotHash: snapshot.hash, observer }, onPhysicalRequest: request => {
          if (stopped || request.profileId !== manifest.profileId || request.role !== "truth-resolution") throw new ModelConfigurationError("admission request scope stopped or changed");
          const evidence = admissionRequestEvidence(request);
          if (logicalPhysicalCount++ === 0 && contentHash(evidence) !== manifest.initialRequestHashes[arm]) throw new ModelConfigurationError("frozen initial request changed");
          writeFileSync(path.join(directory, `${arm}-request-${logicalPhysicalCount}.json.gz`), gzipSync(JSON.stringify(evidence)), { flag: "wx" });
        } });
      const row = { arm, complete: result.complete, firstHttpComplete: result.firstHttpComplete,
        firstHttpAdmittedActions: result.rows.filter(value => value.admittedFromPhysicalRequest === 1).reduce((sum, value) => sum + value.actions, 0),
        admittedSlots: result.rows.filter(value => value.admitted).length,
        admittedActions: result.rows.filter(value => value.admitted).reduce((sum, value) => sum + value.actions, 0),
        physicalRequests: result.physicalRequests, httpCalls: armDispatches, elapsedMs: performance.now() - started,
        peakNanoCny: budget.summary.estimatedPeakNanoCny - before, ...observedUsage(firstHttp, dispatches),
        semanticVerdict: result.semanticVerdict, stepCommitted: false };
      writeFileSync(path.join(directory, `${arm}-result.json.gz`), gzipSync(JSON.stringify({ row, result, events: observer.events })), { flag: "wx" });
      rows.push(row); report(); console.log(JSON.stringify(row));
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error(failure ?? "provider or billing integrity stopped the trial");
    }
    status = "completed";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, dispatches, budgetCny: budget ? budget.summary.estimatedPeakNanoCny / 1e9 : null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
