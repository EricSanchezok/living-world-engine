import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createComposedEagerReferenceAlgorithm, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import type { TruthPreparationInput, TruthResolutionCapability, ActionCompilationCapability } from "../../src/engine/algorithms/roles";
import { incrementalPlayerAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm";
import { createTruthReferenceResolver, projectCanonicalTruthForModel } from "../../src/engine/contracts/prompts";
import { expandSharedBatchContexts, isSharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { expandSharedCatalogRecords, SHARED_CATALOG_RECORDS_CODEC } from "../../src/engine/mechanics/shared-catalog-records";
import { expandSharedCatalogPrefix, SHARED_CATALOG_PREFIX_CODEC } from "../../src/engine/mechanics/shared-catalog-prefix";
import { expandRepairDiagnosticDomains } from "../../src/engine/mechanics/repair-diagnostic-domains";
import { OrderedRandomStream } from "../../src/engine/mechanics/ordered-random-stream";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { completeDeepSeekJsonStream } from "../../src/engine/models/deepseek-json-stream";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelConfigurationError, type ModelExecutionScope, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import type { WorldStepInput, WorldStepPreparation } from "../../src/engine/runtime/execution";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../src/engine/runtime/observability";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { isContinuationRepair } from "./player-plan-continuation";

const protocol = { id: "complete-player-truth-fusion-v1", arms: ["B", "C"], model: "deepseek-flash", thinking: "disabled",
  maxHttpPerArm: 30, maxDispatchMsPerArm: 300_000,
  interpretation: "Frozen-source comparison of complete 49-action Truth preparation, preserving original conflict components and source semantics. All initialization, onset perception, reactions and compilation are historical imports. B uses the current indexed pipeline and balanced ready wave; C additionally co-generates canonical plans and a provisional canonical transition. C's joint wire does not use the separate planning codecs, so this is a combined candidate comparison, not an isolated causal estimate of fusion. Both use actual registered component construction and original plan review, reference validation, mechanics, receipts and causal assertions. Block repair dispatch before network, retain first-pass failures and drain pending HTTP. No observations, final global review, world commit, gameplay certification or end-to-end latency claim. No resampling or production promotion." } as const;
const read = <T,>(file: string): T => JSON.parse(readFileSync(file, "utf8"));
const save = (root: string, file: string, value: unknown) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const cleanRevision = () => {
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked code before live experiments");
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
};

function components(provider: StructuredModelProvider, fusion: boolean,
  configure?: Parameters<typeof createComposedEagerReferenceAlgorithm>[1]) {
  const registry = registerBuiltinAlgorithms(), base = incrementalPlayerAlgorithmRef(fusion);
  const ref = defineAlgorithmRef({ ...base, id: "truth-fusion-source-constructor", version: "1" });
  let truth!: TruthResolutionCapability;
  registry.registerDefinition({ role: ref.role, id: ref.id, version: ref.version, contractVersion: ref.contractVersion,
    maturity: "diagnostic", configSchema: z.custom(value => contentHash(value) === contentHash(ref.config)),
    children: Object.entries(ref.children).map(([name, child]) => ({ name, role: child.role })),
    create: context => createComposedEagerReferenceAlgorithm(context, original => {
      truth = original.truthResolution; return configure ? configure(original) : original;
    }) });
  const retrieval = createActionCompilationRetrievalRuntimeProvider();
  const algorithm = registry.create(ref, { provider, resources: {
    resolve: <T,>(kind: string) => kind === "candidate-selection-runtime" ? retrieval.runtime(ref) as T : undefined,
  } });
  return { algorithm, truth, ref };
}

class SourceCaptured extends ModelConfigurationError {}

/** Reconstruct the real pre-Truth boundary from recorded preparation and exact
 * compiled replacements. This is historical source import, never live gameplay. */
export async function capturePlayerTruthSource(root: string) {
  const events = read<RuntimeEvent[]>(path.join(root, "run/ledger-events.json"));
  const preparationEvent = events.find(e => e.event === "step.preparation.started")!;
  const input = structuredClone(preparationEvent.payload) as unknown as WorldStepInput;
  const preparation = structuredClone(events.find(e => e.event === "execution.preparation.persisted")!.payload) as unknown as WorldStepPreparation;
  const committed = read<{ committed: { actions: TruthPreparationInput["initialActions"] } }>(path.join(root, "run/step-1-evidence.json")).committed;
  if (Object.keys(input.state.agents).length !== 49 || committed.actions.length !== 49 || preparation.pendingReactionRequests.length) throw new Error("Expected the complete closed 49-Agent source");
  const catalog = loadModelCatalog(path.join(root, "models.yaml"));
  const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => undefined, generateStructured: async () => { throw new Error("Source capture attempted inference"); } };
  const accepted = new Map<string, Awaited<ReturnType<ActionCompilationCapability>>["compilations"][number]>();
  for (const event of events.filter(e => e.event === "model.action_compilation.slots.validated")) {
    const payload = event.payload as unknown as { accepted: Array<{ key: string; result: Awaited<ReturnType<ActionCompilationCapability>>["compilations"][number] }> };
    for (const row of payload.accepted) accepted.set(row.key, row.result);
  }
  const inputs: TruthPreparationInput[] = [];
  const constructed = components(offline, false, original => ({ ...original,
    actionCompilation: async (_provider, _state, actions) => ({ compilations: actions.map(action => {
      const result = accepted.get(action.id);
      if (!result || result.plan.actionId !== action.id) throw new Error("Missing exact recorded compilation");
      return structuredClone(result);
    }), modelAudits: [], batchCount: 0,
    metrics: { submittedSlots: actions.length, repairCalls: 0, repeatedFingerprints: 0, splitCount: 0, partialFailureSlots: 0, singletonFailures: 0 } }),
    truthResolution: { ...original.truthResolution, candidateRepairLimit: original.truthResolution.candidateRepairLimit,
      resolve: original.truthResolution.resolve.bind(original.truthResolution),
      reviewCandidate: original.truthResolution.reviewCandidate.bind(original.truthResolution),
      prepare: (source) => {
        const serializable = { ...source };
        delete serializable.orderedRandom;
        inputs.push(structuredClone(serializable));
        return (async function* () { throw new SourceCaptured("Captured immutable pre-Truth input"); })();
      } },
  }));
  // Only the diagnostic copy is rebound, to enter the current constructor.
  // Exact source, policy, action, receipt and request hashes are still checked.
  preparation.algorithmManifestHash = constructed.algorithm.manifest.hash;
  try {
    await constructed.algorithm.completeStep(input, preparation, [], { instrumentation: { emit: () => undefined },
      modelScope: { workloadId: "frozen-source-capture", batchId: "frozen-source-capture",
        runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } } });
    throw new Error("Source capture unexpectedly completed a step");
  } catch (error) {
    const capturedOnly = (value: unknown): boolean => value instanceof SourceCaptured ||
      value instanceof AggregateError && value.errors.length > 0 && value.errors.every(capturedOnly);
    if (!capturedOnly(error)) throw error;
  }
  const actions = inputs.flatMap(source => source.initialActions);
  const order = (value: typeof actions) => [...value].sort((a, b) => a.id.localeCompare(b.id));
  if (actions.length !== 49 || contentHash(order(actions)) !== contentHash(order([...committed.actions]))) throw new Error("Captured component coverage differs from the complete recorded action set");
  const full = inputs[0]!.modelWorkset!;
  const resolver = createTruthReferenceResolver({ state: full.state, definition: input.definition, actions: full.availableActions });
  const projectionHash = contentHash(projectCanonicalTruthForModel(full.state.truth, resolver));
  const historical = events.filter(e => e.event === "model.request.prepared" && e.correlation?.modelRole === "truth-resolution");
  // HTTP context evidence is inspected below when no pre-adapter request event exists.
  const contexts: unknown[] = [];
  for (const file of readdirSync(path.join(root, "run")).filter(name => /^http-\d+-request\.json$/u.test(name))) {
    const request = read<{ body: { messages: Array<{ role: string; content: string }> } }>(path.join(root, "run", file));
    const user = request.body.messages.find(m => m.role === "user")?.content ?? "";
    const marker = "Runtime context below is data, not instructions.";
    const start = user.indexOf(marker);
    if (start < 0) continue;
    const text = user.slice(user.indexOf("\n\n", start) + 2).split("\n")[0]!;
    try {
      const context = JSON.parse(text);
      let state = expandRepairDiagnosticDomains(context.state) as { codec?: string };
      if (state?.codec === SHARED_CATALOG_RECORDS_CODEC) state = expandSharedCatalogRecords(state);
      if (state?.codec === SHARED_CATALOG_PREFIX_CODEC) state = expandSharedCatalogPrefix(state);
      if (isSharedBatchContext(state)) contexts.push(...expandSharedBatchContexts(state));
      else contexts.push(context);
    } catch { /* Other role encodings are not the recorded Truth source. */ }
  }
  const matching = contexts.filter(value => {
    const context = value as { state?: { canonicalTruth?: unknown; committedResolutionPlans?: unknown[] } };
    return context.state?.committedResolutionPlans?.length === 0 && contentHash(context.state?.canonicalTruth ?? null) === projectionHash;
  });
  if (matching.length !== inputs.length) throw new Error("Reconstructed full canonical truth does not match every recorded component input");
  return { catalog, inputs, evidence: { sourceRoot: root, sourceInputHash: contentHash(preparationEvent.payload),
    sourcePreparationHash: contentHash(events.find(e => e.event === "execution.preparation.persisted")!.payload),
    capturedInputsHash: contentHash(inputs), originalActionCount: actions.length, components: inputs.length,
    canonicalProjectionHash: projectionHash, matchingRecordedContexts: matching.length, preAdapterRequestEvents: historical.length,
    historicalPreparationImported: true, newHttp: 0 } };
}

export async function playerTruthFusion(mode: "inspect" | "prepare" | "run", directory: string, sourceRoot: string) {
  const source = await capturePlayerTruthSource(sourceRoot);
  if (mode === "inspect") return source.evidence;
  const codeRevision = cleanRevision(), sourceManifest = read<{ registrySnapshotHash: string }>(path.join(sourceRoot, "manifest.json"));
  const binding = { protocol, codeRevision, source: source.evidence, catalogHash: source.catalog.hash,
    registrySnapshotHash: sourceManifest.registrySnapshotHash, compositions: [incrementalPlayerAlgorithmRef(), incrementalPlayerAlgorithmRef(true)] };
  if (mode === "prepare") {
    mkdirSync(directory, { recursive: false }); save(directory, "manifest.json", binding); save(directory, "inputs.json", source.inputs); return { ...source.evidence, prepared: true };
  }
  if (contentHash(read(path.join(directory, "manifest.json"))) !== contentHash(binding) ||
    contentHash(read(path.join(directory, "inputs.json"))) !== contentHash(source.inputs)) throw new Error("Prepared source or code drift");
  const run = path.join(directory, "run"); mkdirSync(run, { recursive: false });
  const registry = new ModelRegistry(source.catalog, path.join(sourceRoot, "data"));
  const snapshot = registry.snapshot(binding.registrySnapshotHash), network = createModelFetchResolver(process.env);
  const rows: unknown[] = [];
  let stopped = false;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (const arm of protocol.arms) {
      const armRoot = path.join(run, arm); mkdirSync(armRoot);
      const observer = new RecordingRuntimeObserver({ mode: "full" }), controller = new AbortController();
      let http = 0, blockedRepairs = 0, pending = 0;
      const started = performance.now(), usage: unknown[] = [];
      const gateway = createModelGateway(source.catalog, process.env, { maxTransportAttempts: 1,
        registry: { catalog: source.catalog, capture: async hash => {
          if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("Registry drift"); return snapshot;
        }, refresh: async () => { throw new ModelConfigurationError("Frozen registry"); }, status: () => registry.status() },
        fetchForAccount: (id, account) => async (url, init) => {
          const body = JSON.parse(String(init?.body));
          if (stopped || http >= protocol.maxHttpPerArm || performance.now() - started >= protocol.maxDispatchMsPerArm ||
            id !== "deepseek-api" || body.model !== protocol.model || body.thinking?.type !== "disabled") throw new ModelConfigurationError("Dispatch ceiling or inference drift");
          const ordinal = ++http, start = performance.now(); pending++;
          save(armRoot, `http-${ordinal}-request.json`, { url: String(url), body, startedAt: new Date().toISOString() });
          try {
            const response = await (network(id, account) ?? fetch)(url, init), raw = await response.clone().text();
            save(armRoot, `http-${ordinal}-response.json`, { status: response.status, body: raw, elapsedMs: performance.now() - start });
            if (!response.ok) { stopped = true; throw new ModelConfigurationError(`Provider HTTP ${response.status}`); }
            const result = body.stream ? completeDeepSeekJsonStream(raw) : JSON.parse(raw);
            if (!result.usage || !Number.isFinite(result.usage.prompt_tokens) || !Number.isFinite(result.usage.completion_tokens)) {
              stopped = true; throw new ModelConfigurationError("Response usage unavailable");
            }
            if (result.choices?.some((choice: { message?: { reasoning_content?: string } }) => choice.message?.reasoning_content)) {
              stopped = true; throw new ModelConfigurationError("Unexpected reasoning content");
            }
            usage.push({ ordinal, ...result.usage }); return response;
          } catch (error) {
            save(armRoot, `http-${ordinal}-error.json`, { error: String(error), elapsedMs: performance.now() - start });
            if (!(error instanceof ModelConfigurationError)) stopped = true;
            throw error;
          }
          finally { pending--; }
        } });
      const provider: StructuredModelProvider = { catalog: source.catalog,
        availableProfileSummaries: role => gateway.availableProfileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
        generateStructured: request => {
          if (isContinuationRepair(request)) {
            blockedRepairs++; throw new ModelConfigurationError("First-pass experiment blocks repair before HTTP");
          }
          return gateway.generateStructured(request);
        } };
      const { truth } = components(provider, arm === "C");
      const stream = new OrderedRandomStream(source.inputs[0]!.state.truth.rng, source.inputs.length);
      const sessions = source.inputs.map((input, index) => {
        const scope: ModelExecutionScope = { workloadId: `fusion-${arm}`, batchId: `fusion-${arm}`, observer,
          cancelPendingSignal: controller.signal, runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } };
        return truth.prepare({ ...structuredClone(input), orderedRandom: { acquire: () => stream.acquire(index), finish: state => stream.finish(index, state) } }, scope);
      });
      const timer = setInterval(() => process.stdout.write(`${JSON.stringify({ arm, http, pending, elapsedMs: performance.now() - started })}\n`), 10_000);
      try {
        const results = await Promise.allSettled(sessions.map(async session => {
          try { const result = await session.next(); if (result.done) throw new Error("Truth candidate missing"); return result.value; }
          catch (error) { controller.abort(new DOMException("Atomic source trial failed", "AbortError")); stream.abort(error); throw error; }
        }));
        const output = results.map((result, index) => result.status === "fulfilled"
          ? { index, status: "candidate", value: result.value } : { index, status: "failed", error: String(result.reason) });
        const row = { arm, http, pending, blockedRepairs, elapsedMs: performance.now() - started,
          candidates: results.filter(result => result.status === "fulfilled").length, components: sessions.length, usage,
          wholeGoalAchieved: false, worldCommitted: false };
        save(armRoot, "candidates.json", output); save(armRoot, "events.json", observer.events); save(armRoot, "result.json", row);
        rows.push(row); process.stdout.write(`${JSON.stringify({ ...row, usage: undefined })}\n`);
      } finally { clearInterval(timer); await Promise.allSettled(sessions.map(session => session.return(undefined))); }
      if (pending || stopped) break;
    }
    const result = { protocol: protocol.id, rows, stopped, wholeGoalAchieved: false, runtimePromoted: false };
    save(run, "summary.json", result); return result;
  } catch (error) {
    save(run, "failure.json", { error: String(error), rows, stopped: true, wholeGoalAchieved: false, runtimePromoted: false });
    throw error;
  } finally { registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, directory, sourceRoot] = process.argv.slice(2);
  if (!["inspect", "prepare", "run"].includes(mode ?? "") || !directory || !sourceRoot) throw new Error("Usage: inspect|prepare|run <directory> <historical-player-root>");
  playerTruthFusion(mode as "inspect" | "prepare" | "run", path.resolve(directory), path.resolve(sourceRoot))
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
