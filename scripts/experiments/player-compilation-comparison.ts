import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { actionCompilationPassagesForState } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup";
import { discoverLocalEncoderModelDirectory, livingWorldCacheRoot, loadLocalEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { relationalRrfEncoderFingerprint, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import type { ActionCompilationResult } from "../../src/engine/algorithms/roles";
import type { FirstPassCallEvidence } from "../../src/engine/benchmarks/action-compilation/first-pass-runner";
import { integratedPlayerAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/integrated-player-algorithm";
import { compilationReferenceUses, compilationReferenceUsesRequest, COMPILATION_REFERENCE_USES } from "../../src/engine/benchmarks/step-efficiency/compilation-reference-uses";
import type { SimulationState } from "../../src/engine/contracts/model";
import { contentHash } from "../../src/engine/models/model-audit";
import { completeDeepSeekJsonStream } from "../../src/engine/models/deepseek-json-stream";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../src/engine/runtime/observability";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { buildWorldDefinition, loadWorldTemplate } from "../../src/script/world-loader";
import { loadOfficialSourceShard } from "./refresh-action-compilation-reference";
import { finiteWorkWorldTemplate } from "./step-finite-work-world";
import { finiteWorkCompilationState } from "./finite-work-compilation-state";

const finiteWorkProtocol = { id: "finite-work-compilation-v1", sourceExecution: "14c18986-48ed-40ce-9bc8-0f3caf542273",
  seed: 20260911, orderedBatchSizes: [12, 12, 12, 5, 8], maxHttp: 10, maxDispatchMs: 600_000,
  model: "deepseek-flash", thinking: "disabled", repairs: 0, transportRetries: 0,
  retrievalCache: "warm passage cache; independent cold query cache per physical batch, matching all five historical first retrievals",
  interpretation: "Counterfactual compiler input only. Preserve all 49 original actions and imported bootstrap cognition. B retains the original incomplete world; C adds only the established finite-work profile/calibration through a separately hashed world definition. Freeze both complete requests per original batch before dispatch; alternate B/C order. Offline B replays the original complete response with exact historical request bytes and slot validation. Offline C captures only, never reuses B aliases. Use the real R5 retrieval, compiler and gateway in both arms. Record changed catalogs/shortlists, all responses and usage, accepted and rejected source semantics. No repair, retry, redraw, world commit, player latency or reliability claim. Missing usage or transport/configuration failure stops later dispatch." } as const;
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (root: string, file: string, value: unknown) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
const errorValue = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
const sourceHashes = () => Object.fromEntries([
  "scripts/experiments/player-compilation-comparison.ts", "scripts/experiments/finite-work-compilation-state.ts",
  "scripts/experiments/step-finite-work-world.ts", "scripts/experiments/world-fragments/finite-work-goal.yaml",
  "src/engine/algorithms/eager-reference/represented-action-compiler.ts",
  "src/engine/benchmarks/step-efficiency/integrated-player-algorithm.ts",
  "src/engine/benchmarks/step-efficiency/compilation-reference-uses.ts", "src/engine/prompts/shared/compilation-reference-uses.md",
].map(file => [file, contentHash(readFileSync(file, "utf8"))]));

export async function playerCompilationComparison(mode: "prepare" | "run", root: string, sourceRoot: string, captureRoot: string, referenceUsesBaseline?: string) {
  const protocol = referenceUsesBaseline ? { ...finiteWorkProtocol, id: "compilation-reference-uses-v1", candidate: COMPILATION_REFERENCE_USES,
    interpretation: "Both arms use the complete finite-work counterfactual world and all 49 original actions in the original five physical batches. B exactly reconstructs the sealed preceding finite-work C requests. C adds only action-local declared reference-use links and interpretation instructions after the unchanged R5 retrieval and alias encoding. Freeze ten complete ordered requests on a clean committed producer. Replay every original response in both offline arms through unchanged output dictionaries, schema and materialization, retaining all original acceptance/rejection. One new primary per source/arm, alternating order, no repair/retry/redraw. Preserve every response, physical audit, usage, formal and source-semantic error. This is compilation evidence, not a gameplay source, successful full player action or reliability estimate." } : finiteWorkProtocol;
  const ledger: RuntimeEvent[] = read(path.join(sourceRoot, "run/ledger-events.json"));
  const eventFor = (invocation: string, event: string) => {
    const found = ledger.filter(entry => entry.event === event && entry.correlation?.modelInvocationId === invocation);
    if (found.length !== 1) throw new Error(`Missing unique historical event: ${event}`);
    return found[0]!;
  };
  const sources = loadOfficialSourceShard(captureRoot).sort((a, b) =>
    eventFor(a.sourceInvocationId, "model.context.serialized").sequence - eventFor(b.sourceInvocationId, "model.context.serialized").sequence);
  if (JSON.stringify(sources.map(source => source.actions.length)) !== JSON.stringify(protocol.orderedBatchSizes) ||
    sources.some(source => source.sourceExecutionId !== protocol.sourceExecution || source.modelId !== protocol.model) ||
    new Set(sources.flatMap(source => source.actionIds)).size !== 49) throw new Error("Complete original five-batch 49-action source required");
  const catalog = loadModelCatalog(path.join(sourceRoot, "models.yaml"));
  const registry = new ModelRegistry(catalog, path.join(sourceRoot, "data"));
  const original = read(path.join(sourceRoot, "run/initial-instance.json")).state as SimulationState;
  if (sources.some(source => source.stateHash !== contentHash(original) || source.modelCatalogHash !== catalog.hash)) throw new Error("Original source state or catalog differs");
  for (const source of sources) registry.snapshot(source.registrySnapshotHash);
  const template = loadWorldTemplate(path.join(sourceRoot, "worlds/blackmarsh/world"));
  const before = buildWorldDefinition(template, { seed: protocol.seed, modelCatalog: catalog });
  const after = buildWorldDefinition(finiteWorkWorldTemplate(template), { seed: protocol.seed, modelCatalog: catalog });
  const overlay = finiteWorkCompilationState(original, before, after), foundation = integratedPlayerAlgorithmRef();
  const algorithm = referenceUsesBaseline ? defineAlgorithmRef({ ...foundation, id: "compilation-reference-uses-diagnostic", version: "1",
    config: { ...foundation.config, comparison: COMPILATION_REFERENCE_USES } }) : foundation;
  const baselineState = referenceUsesBaseline ? overlay.state : original;
  const prior = referenceUsesBaseline ? {
    manifest: read(path.join(referenceUsesBaseline, "manifest.json")), terminal: read(path.join(referenceUsesBaseline, "run/terminal.json")),
    states: read(path.join(referenceUsesBaseline, "preflight/states.json")),
    rows: sources.map((_, index) => {
      const prefix = path.join(referenceUsesBaseline, "run", `source-${index}-C`);
      return { request: read(path.join(prefix, "request.json")), response: read(path.join(prefix, "response.json")),
        retrieval: read(path.join(prefix, "retrieval-1.json")), evidence: read(path.join(prefix, "evidence.json")) };
    }),
  } : undefined;
  if (prior && (prior.manifest.binding.protocol.id !== finiteWorkProtocol.id || !prior.terminal.complete || prior.terminal.totalHttp !== 10 ||
    prior.manifest.binding.sourceHash !== contentHash(sources) || prior.manifest.binding.catalogHash !== catalog.hash ||
    contentHash(prior.manifest.binding.overlay) !== contentHash(overlay.provenance) ||
    JSON.stringify(prior.states.C) !== JSON.stringify(overlay.state) || prior.rows.some((row, index) =>
      row.evidence.mode !== "run" || row.evidence.actualHttp !== 1 || !row.evidence.stateUnchanged || row.evidence.arm !== "C" ||
      row.evidence.sourceIndex !== index || contentHash(row.evidence.actionIds) !== contentHash(sources[index]!.actionIds) ||
      row.request.orderedBodyHash !== contentHash(row.request.orderedBody) || !row.evidence.calls[0]?.audit))) {
    throw new Error("Reference-use comparison requires the complete sealed finite-work C evidence");
  }
  const binding = { protocol, sourceCodeHashes: sourceHashes(), algorithm, sourceHash: contentHash(sources), catalogHash: catalog.hash,
    originalStateOrderHash: contentHash(JSON.stringify(original)), overlay: overlay.provenance,
    ...(prior ? { baseline: { kind: "preceding-counterfactual-compilation-C", manifestHash: contentHash(prior.manifest),
      terminalHash: contentHash(prior.terminal), rowHashes: prior.rows.map(row => contentHash(row)) } } : {}) };
  const frozenManifest = mode === "run" ? read(path.join(root, "manifest.json")) : undefined;
  if (mode === "run" && (git("status", "--porcelain") || frozenManifest.codeRevision !== git("rev-parse", "HEAD") ||
    contentHash(frozenManifest.binding) !== contentHash(binding))) {
    throw new Error("Commit checked code and retain the complete frozen probe before live calls");
  }
  mkdirSync(root, { recursive: true });
  const directory = path.join(root, mode === "prepare" ? "preflight" : "run");
  mkdirSync(directory, { recursive: false });
  save(directory, "binding.json", { binding, codeRevision: git("rev-parse", "HEAD"), mode });
  save(directory, "states.json", { B: baselineState, C: overlay.state });
  save(directory, "sources.json", sources);
  const cacheRoot = livingWorldCacheRoot();
  const encoder = await loadLocalEncoder({ modelDirectory: discoverLocalEncoderModelDirectory(cacheRoot, MULTILINGUAL_E5_BASE_ASSET.name),
    modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256 });
  const fingerprint = relationalRrfEncoderFingerprint(encoder, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION);
  if (fingerprint !== MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint) throw new Error("Encoder fingerprint drift");
  const cache = new CachedPassageEncoder(encoder, fingerprint, cacheRoot);
  const resources = createActionCompilationRetrievalRuntimeProvider({ cacheRoot, encoder });
  const network = createModelFetchResolver(process.env);
  let totalHttp = 0, stopped: string | undefined;
  const rows: Array<Record<string, unknown>> = [], started = performance.now();
  const stop = () => { stopped ??= "Operator stopped later dispatch"; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (const [arm, state] of Object.entries({ B: baselineState, C: overlay.state })) {
      const warmed = await cache.encodePassages({ worldContentHash: state.worldHash,
        passages: actionCompilationPassagesForState(state), allowWrite: mode === "prepare" });
      save(directory, `cache-${arm}.json`, { hits: warmed.hits, misses: warmed.misses });
      await resources.preflight(algorithm, { worldContentHash: state.worldHash, state });
    }
    for (const [sourceIndex, source] of sources.entries()) {
      const preceding = prior?.rows[sourceIndex];
      const oldRequest = preceding ? { body: preceding.request.orderedBody } : eventFor(source.sourceInvocationId, "model.transport.request.raw").payload as { body: string };
      const oldResponse = preceding ? preceding.response as { body: string; status: number } : eventFor(source.sourceInvocationId, "model.transport.response.raw").payload as { body: string; status: number };
      const expectedRetrieval = preceding ? preceding.retrieval.selected as { fullContextHash: string; modelContextHash: string; shortlistHash: string } : source;
      for (const arm of sourceIndex % 2 ? ["C", "B"] : ["B", "C"]) {
        if (stopped) throw new Error(stopped);
        const id = `source-${sourceIndex}-${arm}`, trialDirectory = path.join(directory, id);
        mkdirSync(trialDirectory, { recursive: false });
        const state = structuredClone(arm === "B" ? baselineState : overlay.state), stateHash = contentHash(state);
        const observer = new RecordingRuntimeObserver({ mode: "full" });
        // Do not let an earlier counterfactual populate the baseline query cache.
        const retrieval = createActionCompilationRetrievalRuntimeProvider({ cacheRoot, encoder }).runtime(algorithm);
        if (!retrieval) throw new Error("Missing current retrieval runtime");
        const calls: FirstPassCallEvidence[] = [];
        let sends = 0, actualHttp = 0, captureOnly = false, retrievalCalls = 0;
        let transportUsage: ReturnType<typeof completeDeepSeekJsonStream>["usage"] | undefined;
        const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
          registry: { catalog, capture: async hash => registry.snapshot(hash ?? source.registrySnapshotHash),
            refresh: async () => { throw new ModelConfigurationError("Frozen registry refresh disabled"); }, status: () => registry.status() },
          fetchForAccount: (accountId, account) => {
            const send = network(accountId, account) ?? fetch;
            return async (input, init) => {
              const request = new Request(input, init), body = await request.clone().text(), parsed = JSON.parse(body);
              if (++sends !== 1 || accountId !== "deepseek-api" || parsed.model !== protocol.model || parsed.thinking?.type !== "disabled") throw new ModelConfigurationError("Primary-only model binding drift");
              save(trialDirectory, "request.json", { url: request.url, body: parsed, orderedBody: body, orderedBodyHash: contentHash(body) });
              if (mode === "prepare") {
                if (arm === "B" || preceding) {
                  if (arm === "B" && body !== oldRequest.body) throw new ModelConfigurationError("Historical B request bytes differ");
                  transportUsage = completeDeepSeekJsonStream(oldResponse.body, protocol.model).usage;
                  return new Response(oldResponse.body, { status: oldResponse.status, headers: { "content-type": "text/event-stream" } });
                }
                captureOnly = true;
                throw new ModelConfigurationError("Offline C request captured; no historical aliases replayed");
              }
              const frozen = read(path.join(root, "preflight", id, "request.json"));
              if (frozen.orderedBodyHash !== contentHash(body) || frozen.url !== request.url) throw new ModelConfigurationError("Frozen request bytes or URL differ");
              if (stopped || totalHttp >= protocol.maxHttp || performance.now() - started >= protocol.maxDispatchMs) throw new ModelConfigurationError("Dispatch ceiling reached");
              totalHttp++; actualHttp++;
              save(trialDirectory, "dispatch.json", { ordinal: totalHttp, at: new Date().toISOString(), historical: false });
              const transportStart = performance.now();
              try {
                const response = await send(input, init), raw = await response.clone().text();
                save(trialDirectory, "response.json", { body: raw, status: response.status, elapsedMs: performance.now() - transportStart });
                if (!response.ok) throw new ModelConfigurationError(`HTTP ${response.status}`);
                transportUsage = completeDeepSeekJsonStream(raw, protocol.model).usage;
                return response;
              } catch (error) {
                stopped = errorValue(error).message;
                save(trialDirectory, "transport-error.json", { error: errorValue(error), elapsedMs: performance.now() - transportStart });
                throw error;
              }
            };
          } });
        const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
          assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), async generateStructured(request) {
            const call: FirstPassCallEvidence = { ordinal: calls.length, invocationId: request.modelInvocationId ?? null,
              semanticRepairAttempt: request.correlation?.semanticRepairAttempt ?? 0, parentInvocationId: request.correlation?.parentInvocationId ?? null,
              promptVersion: request.promptVersion, schemaName: request.schemaName, context: request.context };
            calls.push(call);
            if (calls.length !== 1 || call.semanticRepairAttempt !== 0) {
              save(trialDirectory, `blocked-${calls.length}.json`, call);
              throw new ModelConfigurationError("Primary-only screen blocks repair before HTTP");
            }
            if (request.profileId !== source.profileId || request.modelRegistrySnapshotHash !== source.registrySnapshotHash) throw new ModelConfigurationError("Captured profile/registry pin lost");
            try {
              const adapted = preceding && arm === "C" ? compilationReferenceUsesRequest(request) : request;
              if (adapted !== request) {
                save(trialDirectory, "reference-use-projection.json", compilationReferenceUses(request.context).proof);
                if (adapted.schema !== request.schema || adapted.wireJsonSchema !== request.wireJsonSchema) throw new ModelConfigurationError("Reference-use view changed output schema");
              }
              call.context = adapted.context; call.promptVersion = adapted.promptVersion;
              const generated = await gateway.generateStructured(adapted);
              call.value = generated.value; call.audit = generated.audit;
              return generated;
            } catch (error) {
              call.error = errorValue(error);
              if (error instanceof ModelOutputError) { call.value = error.rawValue; call.audit = error.audit; }
              throw error;
            }
          } };
        const execution = source.fullContext.execution as { instanceId: string; advanceId: string };
        const trialStart = performance.now();
        let result: ActionCompilationResult | undefined, error: ReturnType<typeof errorValue> | undefined;
        try {
          result = await representedActionCompiler("AT", true, true, true)(provider, state, source.actions, {
            workloadId: execution.instanceId, batchId: execution.advanceId,
            correlation: { executionId: `${protocol.id}:${id}`, revision: state.revision }, observer,
            runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
            modelRegistrySnapshotHash: source.registrySnapshotHash, executionAlgorithmRef: algorithm,
            actionCompilationRetrieval: { ...retrieval, retrieveBatch: async request => {
              const ordinal = ++retrievalCalls;
              if (ordinal === 1 && (request.slotIndices.length !== source.actions.length ||
                ((arm === "B" || preceding) && contentHash(request.fullContext) !== expectedRetrieval.fullContextHash))) throw new ModelConfigurationError("Initial context/cardinality differs");
              const selected = await retrieval.retrieveBatch(request);
              save(trialDirectory, `retrieval-${ordinal}.json`, { request, selected: { ...selected, selectedKeysBySlot: [...selected.selectedKeysBySlot] } });
              if (ordinal === 1 && selected.diagnostics.cache?.queryHits !== 0) throw new ModelConfigurationError("Initial cold query-cache binding differs");
              if (ordinal === 1 && (arm === "B" || preceding) && (selected.modelContextHash !== expectedRetrieval.modelContextHash || selected.shortlistHash !== expectedRetrieval.shortlistHash)) throw new ModelConfigurationError("Historical R5 shortlist differs");
              return selected;
            } },
          }, source.profileId, source.actions.length);
        } catch (caught) { error = errorValue(caught); }
        const evidence = { id, arm, sourceIndex, sourceInvocationId: source.sourceInvocationId, actionIds: source.actionIds,
          mode, compilerAccepted: Boolean(result), result, error, calls, events: observer.events, captureOnly,
          stateUnchanged: contentHash(state) === stateHash, wallMs: performance.now() - trialStart, actualHttp,
          transportUsage, usageOrigin: mode === "run" ? "new-inference" : (arm === "B" || preceding) ? "historical-replay" : "none",
          semanticVerdict: "pending-source-review", gameplayCommit: false };
        save(trialDirectory, "evidence.json", evidence);
        rows.push({ id, arm, sourceIndex, slots: source.actions.length, accepted: Boolean(result), captureOnly, actualHttp,
          wallMs: evidence.wallMs, usage: transportUsage, repairAttemptsBlocked: Math.max(0, calls.length - 1), error });
        process.stdout.write(`${JSON.stringify(rows.at(-1))}\n`);
        if (!evidence.stateUnchanged || sends !== 1 || calls[0]?.schemaName !== "action_compilation_at_eligible_source_choice_v1") throw new Error("Source, request or schema invariant failed");
        if (mode === "prepare" && arm === "C" && !preceding) {
          if (!captureOnly || calls.length !== 1 || result) throw new Error("C preparation must capture only");
          continue;
        }
        const audit = calls[0]?.audit;
        const invocation = audit?.invocations[0];
        if (!audit || audit.invocations.length !== 1 || !invocation || !transportUsage || audit.modelId !== source.modelId || audit.profileId !== source.profileId ||
          audit.modelCatalogHash !== catalog.hash || audit.registrySnapshotHash !== source.registrySnapshotHash ||
          audit.structuredOutputMode !== "json-object-zod" || invocation.tokenUsage.input !== transportUsage.prompt_tokens ||
          invocation.tokenUsage.output !== transportUsage.completion_tokens || invocation.tokenUsage.cacheRead !== transportUsage.prompt_cache_hit_tokens ||
          invocation.tokenUsage.reasoning !== 0) throw new Error("Complete first-response audit and nonthinking usage required; later dispatch stopped");
        if (mode === "prepare") {
          const historicalInvocation = preceding?.evidence.calls[0].invocationId ?? source.sourceInvocationId;
          const historicalEvents: RuntimeEvent[] = preceding?.evidence.events ?? ledger;
          const validations = (events: RuntimeEvent[], invocationId: string | null | undefined) => events.filter(entry =>
            entry.event === "model.action_compilation.slots.validated" && entry.correlation?.modelInvocationId === invocationId).map(entry => entry.payload);
          const previousValidations = validations(historicalEvents, historicalInvocation);
          if (previousValidations.length !== 1 || contentHash(previousValidations) !== contentHash(validations(observer.events, calls[0]?.invocationId))) throw new Error("Historical slot validation/rejection differs");
          const normalized = historicalEvents.filter(entry => entry.event === "model.output.normalized" && entry.correlation?.modelInvocationId === historicalInvocation).at(-1);
          const persisted = preceding?.evidence.calls[0].audit ?? eventFor(source.sourceInvocationId, "model.audit.persisted").payload as { invocations: Array<{ normalizedOutputHash?: string | null }> };
          if ((normalized?.hashes?.normalizedOutput ?? persisted.invocations[0]?.normalizedOutputHash) !== invocation.normalizedOutputHash) throw new Error("Historical normalization differs");
        }
      }
    }
    if (mode === "prepare") save(root, "manifest.json", { binding, codeRevision: git("rev-parse", "HEAD"), rows, newHttp: 0 });
  } catch (error) {
    stopped ??= errorValue(error).message;
    throw error;
  } finally {
    save(directory, "terminal.json", { rows, totalHttp, stopped: stopped ?? null, complete: rows.length === 10 && !stopped,
      playerLatencyMeasured: false, elapsedMs: performance.now() - started });
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    cache.close(); await encoder.dispose?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, root, sourceRoot, captureRoot, flag, baseline] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "run") || !root || !sourceRoot || !captureRoot || (flag && (flag !== "--reference-uses-baseline" || !baseline)) || process.argv.length > 8) throw new Error("usage: player-compilation-comparison.ts <prepare|run> <output> <integrated-player-source> <official-capture> [--reference-uses-baseline <sealed-finite-work-comparison>]");
  playerCompilationComparison(mode, path.resolve(root), path.resolve(sourceRoot), path.resolve(captureRoot), baseline ? path.resolve(baseline) : undefined)
    .catch(error => { process.stderr.write(`${JSON.stringify(errorValue(error))}\n`); process.exitCode = 1; });
}
