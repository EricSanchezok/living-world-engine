import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { transitionProposalSchema } from "../../src/engine/contracts/llm-schemas";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { scoreRepairTail } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { indexedTransitionRequest } from "../../src/engine/mechanics/source-indexed-transition";
import { transitionIntervalWorklistRequest } from "../../src/engine/mechanics/transition-evidence-worklist";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { promptBundle } from "../../src/engine/prompts";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest } from "./step-state-prefix-probe";
import { loadFrozenTransitionSource } from "./step-indexed-transition-probe";
import { probeInferenceEvidence } from "./step-json-probe";
import { countDeepSeekContext } from "./deepseek-context-admission";

const TRIAL = "probes-e2-transition-worklist-10", root = path.resolve(STEP_E2_PROTOCOL.root);
type Source = ReturnType<typeof loadFrozenTransitionSource>;
type Outcome = { complete: boolean; admittedSlots: number; admittedActions: number; http: number; tokens: number | null };
export function transitionWorklistDecision(row: Outcome | null, integrityFailed: boolean) {
  if (integrityFailed || !row || ![1, 2].includes(row.http) || row.tokens === null || !Number.isFinite(row.tokens) || row.tokens <= 0) return "inconclusive";
  return row.complete && row.admittedSlots === 12 && row.admittedActions === 43
    ? "eligible-for-source-semantic-review-no-gameplay-claim" : "failed-full-root-admission";
}

export async function runTransitionWorklistSource(source: Source, inner: StructuredModelProvider,
  capture: (request: StructuredModelRequest<unknown>, ordinal: number) => void, observer?: RecordingRuntimeObserver) {
  let physical = 0;
  const guarded: StructuredModelProvider = { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids), generateStructured: request => {
      const context = structuredClone(request.context) as Record<string, unknown>; delete context.batchRepair;
      if (request.schemaName !== "truth_transition_batch" || physical >= 2 || contentHash(context) !== source.codec.sourceHash) throw new ModelConfigurationError("full source root split, drift or physical limit");
      const adapted = cacheNamespaceRequest(transitionIntervalWorklistRequest(indexedTransitionRequest(request)), contentHash({ trial: TRIAL, version: 1 }));
      capture(adapted, ++physical);
      return inner.generateStructured(adapted);
    } };
  const coordinator = new TruthBatchCoordinator(guarded, 12, 1, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const prompt = promptBundle("truth-transition");
  const results = await Promise.allSettled(source.contexts.map((context, slot) => coordinator.generateStructured({
    role: "truth-transition", profileId: source.source.profileId, subjectId: `source-slot-${String(slot).padStart(2, "0")}`,
    workloadId: TRIAL, batchId: TRIAL, runtimeIdentity: source.runtimeIdentity, modelRegistrySnapshotHash: source.snapshot.hash,
    promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt, context, schema: transitionProposalSchema,
    schemaName: "truth_transition", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1", observer,
  })));
  return { physical, slots: results.map((result, slot) => result.status === "fulfilled"
    ? { slot, admitted: true, value: result.value.value, audit: result.value.audit }
    : { slot, admitted: false, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }) };
}

export async function prepareTransitionWorklistProbe() {
  const source = loadFrozenTransitionSource(), captured: ReturnType<typeof admissionRequestEvidence>[] = [];
  let capturedRequest: StructuredModelRequest<unknown> | undefined;
  const offline: StructuredModelProvider = { catalog: source.catalog, availableProfileSummaries: role => source.catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline complete-root capture"); } };
  await runTransitionWorklistSource(source, offline, request => { captured.push(admissionRequestEvidence(request)); capturedRequest = request; });
  if (captured.length !== 1 || !capturedRequest) throw new Error("complete original source failed offline capture");
  let contextBudget: Awaited<ReturnType<typeof countDeepSeekContext>> | undefined, preflightError: unknown;
  const offlineGateway = createModelGateway(source.catalog, { [source.catalog.account("deepseek-api").api_key_env]: "offline-preflight-only" }, {
    maxTransportAttempts: 1, registry: { catalog: source.catalog, capture: async hash => {
      if (hash && hash !== source.snapshot.hash) throw new ModelConfigurationError("offline registry drift"); return source.snapshot;
    }, refresh: options => source.registry.refresh(options), status: () => source.registry.status() },
    fetchForAccount: () => async (_input, init) => {
      contextBudget = await countDeepSeekContext(JSON.parse(String(init?.body)));
      throw new ModelConfigurationError("offline context admission completed without network");
    },
  });
  try { await offlineGateway.generateStructured(capturedRequest); } catch (error) { preflightError = error; }
  if (!contextBudget) throw preflightError ?? new ModelConfigurationError("complete HTTP body did not reach offline context admission");
  const manifest = { trialId: TRIAL, sourceTrialId: "trajectory-e2-09", sourceSequence: 987, sourceHash: source.sourceHash,
    sourceContextHash: source.codec.sourceHash, runtimeIdentity: source.runtimeIdentity, slots: 12, actions: 43, maxHttp: 2,
    maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: source.catalog.hash, registrySnapshotHash: source.snapshot.hash, model: source.profile.modelId, profile: source.profile.profile,
    protocolHash: contentHash(STEP_E2_PROTOCOL), initialRequestHash: contentHash(captured[0]), contextBudget,
    acceptance: "One fresh complete12-slot/43-action source through the real batch coordinator; at most one structural repair and two HTTP. Preserve all original logical state/actions/refs and disabled-thinking Flash settings. Source-indexed output with model-authored firstAssertion/additionalAssertions replaces the required nonempty outcome list; Exact evidence joins now include all plan-participant entity records, subject facts and placement ancestry; all original shared context, reference scope and the provisional receipt contract remain. Permission is not evidence of satisfied physical/timing/audience prerequisites. Repeated assertion schemas use exact local draft07 references; expansion restores all original constraints. Complete actual messages are checked with a pinned public tokenizer plus1024protocol tokens and the unchanged output limit before any reservation/HTTP, including repair. Catalog orders now use an exact common prefix plus original per-order suffixes, restoring every candidate and rank; no source information is removed. Equal fields in shared candidate records are now template encoded; original handle/label/statePath fields and all other fields reconstruct exactly before slot deltas and source-hash validation. Output references and schemas remain unchanged. The wire summary is now intervalAssessment: model-authored gates selecting ordered lossless source segment indices and evidencePointers selecting existing source values, currentWork and pendingSourceRanges selecting exact original unfinished text. Pointer validity is not proof of relevance; source range validity is not proof of completeness. There is no regenerated pending-work prose or copied observed value. Original actor identities and delegation remain binding. Three generic synthetic input/output demonstrations clarify waiting, local work, remote contact and retained conditional branches; their state is not real game evidence. currentWork restores the canonical summary verbatim; evidence fidelity is not semantic certification. No assertion is synthesized; all variants and canonical validation remain. No splitting, transport retry, warmup, critic,RNG,commit or redraw. Retain already valid slots when canonical field validation rejects a neighbor. Initial and final complete roots are separate metrics. Final12/12slots,43/43actions,original schema and slot references plus known usage only permit independent source-state semantic review, not gameplay or comparative improvement. Earlier no-repair and empty-output trials remain failed. Stop on any integrity or budget issue; never silently release unknown billing.",
  };
  return { ...source, manifest, initial: captured[0]! };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-transition-worklist-probe.ts [prepare]");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("frozen trial cannot restart");
  const design = await prepareTransitionWorklistProbe();
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(design.manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx")); mkdirSync(directory, { recursive: true });
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, dispatches = 0, row: Outcome | null = null;
  const connections: unknown[] = [], stop = () => { stopped = true; }, report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({
    ...design.manifest, status, failure, row, dispatches, connections, budget: budget?.summary, updatedAt: new Date().toISOString(),
    decision: transitionWorklistDecision(row, status !== "completed") }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const ledger = budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET), phase = ledger.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny, 0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete trial budget or unknown billing blocks dispatch");
    const account = design.catalog.account("deepseek-api"); if (!process.env[account.api_key_env]) throw new Error("configured DeepSeek credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(ledger, { root, baseUrl: account.base_url, fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, endpointPaths: ["/chat/completions"],
      trialPattern: /^probes-e2-transition-worklist-10$/u, requireThinkingDisabled: true, priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const gateway = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog: design.catalog, capture: async hash => { if (hash && hash !== design.snapshot.hash) throw new ModelConfigurationError("registry drift"); return design.snapshot; },
        refresh: options => design.registry.refresh(options), status: () => design.registry.status() }, fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches >= 2) throw new ModelConfigurationError("HTTP gate stopped dispatch");
        try {
          const contextBudget = await countDeepSeekContext(JSON.parse(String(init?.body)));
          if (contextBudget.counterHash !== design.manifest.contextBudget.counterHash ||
            (dispatches === 0 && contextBudget.bodyHash !== design.manifest.contextBudget.bodyHash)) throw new ModelConfigurationError("frozen tokenizer or complete body drift");
          writeFileSync(path.join(directory, `http-context-${dispatches + 1}.json`), JSON.stringify(contextBudget, null, 2), { flag: "wx" });
          const response = await transport.fetch(input, init), inference = probeInferenceEvidence(await response.clone().json(), "B");
          if (!inference.inferenceValid) throw new ModelConfigurationError(inference.inferenceError ?? "inference drift"); return response;
        } catch (error) {
          stopped = true;
          throw new ModelConfigurationError(error instanceof Error ? error.message : String(error), { cause: error });
        }
      } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    const observer = new RecordingRuntimeObserver({ mode: "full" }), started = performance.now();
    const result = await runTransitionWorklistSource(design, gateway, (request, ordinal) => {
      const evidence = admissionRequestEvidence(request);
      if (stopped || (ordinal === 1 && contentHash(evidence) !== design.manifest.initialRequestHash)) throw new ModelConfigurationError("frozen request drift or interruption");
      writeFileSync(path.join(directory, `request-${ordinal}.json.gz`), gzipSync(JSON.stringify(evidence)), { flag: "wx" });
    }, observer);
    writeFileSync(path.join(directory, "result.json.gz"), gzipSync(JSON.stringify({ result, events: observer.events })), { flag: "wx" });
    let input = 0, output = 0, cacheHit = 0, unknown = 0, documentedNanoCny = 0;
    const formats: boolean[] = [];
    for (let ordinal = 1; ordinal <= dispatches; ordinal++) try {
      const httpRoot = path.join(root, "http", `${TRIAL}-http-${String(ordinal).padStart(3, "0")}`), request = JSON.parse(readFileSync(path.join(httpRoot, "request.json"), "utf8"));
      const response = JSON.parse(readFileSync(path.join(httpRoot, "response.json"), "utf8")), raw = JSON.parse(response.raw), usage = deepSeekExperimentUsage(raw);
      input += usage.input; output += usage.output; cacheHit += usage.cacheHit; documentedNanoCny += documentedFlashCost(usage, request.startedAt, response.completedAt).dispatchEstimateNanoCny;
      try { JSON.parse(raw.choices[0].message.content); formats.push(true); } catch { formats.push(false); }
    } catch { unknown++; }
    const slots = result.slots.filter(slot => slot.admitted).map(slot => ({ slot: slot.slot, result: slot.value }));
    const score = scoreRepairTail(JSON.stringify({ slots }), "transition", design.contexts);
    row = { complete: score.schemaCoverageReferences, admittedSlots: slots.length,
      admittedActions: slots.reduce((sum, slot) => sum + (slot.result?.outcomes.length ?? 0), 0), http: dispatches, tokens: unknown ? null : input + output };
    const detail = { ...row, firstHttpComplete: dispatches === 1 && row.complete, physical: result.physical, usage: { input, output, cacheHit }, unknown,
      documentedNanoCny, rawJsonByHttp: formats, elapsedMs: performance.now() - started, semantics: "unassessed", stepCommitted: false,
      errors: result.slots.filter(slot => !slot.admitted).map(slot => ({ slot: slot.slot, error: slot.error })), score };
    writeFileSync(path.join(directory, "metrics.json"), JSON.stringify(detail, null, 2));
    console.log(JSON.stringify({ ...detail, errors: detail.errors.map(error => ({ ...error, error: error.error?.slice(0, 200) })) }));
    if (stopped || unknown || ledger.summary.blockingUnknown.length) throw new Error("request integrity, interruption or billing uncertainty stopped trial");
    status = "completed";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); design.registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, dispatches, budgetCny: budget ? budget.summary.estimatedPeakNanoCny / 1e9 : null }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
