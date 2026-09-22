import { cpSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { executableActionCompiler, executablePlayerAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/executable-interaction-algorithm";
import type { BoundInteractionProgram } from "../../src/engine/benchmarks/step-efficiency/executable-interaction";
import { incrementalPlayerAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/incremental-player-algorithm";
import { registerIntegratedPlayerAlgorithm } from "../../src/engine/benchmarks/step-efficiency/integrated-player-algorithm";
import type { AgentActionProposal, SimulationState } from "../../src/engine/contracts/model";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { actionCompilationPassagesForState } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup";
import { discoverLocalEncoderModelDirectory, livingWorldCacheRoot, loadLocalEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { LocalDatabase } from "../../src/server/local-database";
import { E3_PHASES, E3_PRICE, E3_SNAPSHOT, cleanRevision, e3Environment, json, save } from "./step-e3-runtime";

interface Source { label: string; directory: string; batches: Array<{ actions: AgentActionProposal[]; stateSnapshot: SimulationState;
  sourceInvocationId: string; profileId: string; stateHash: string }> }
export function extractE3Sources(base: string): Source[] {
  return [["34", "recursive-player-02"], ["51", "incremental-player-02"], ["53", "incremental-player-04"]].map(([label, directory]) => {
    const events = json<Array<{ event: string; payload: Source["batches"][number] }>>(path.join(base, directory!, "run/ledger-events.json"));
    const seen = new Set<string>(), batches: Source["batches"] = [];
    for (const event of events.filter(e => e.event === "model.action_compilation.context.captured")) {
      const batch = event.payload;
      if (batch.actions.every(a => seen.has(a.actorId))) continue;
      if (batch.actions.some(a => seen.has(a.actorId))) throw new Error("Initial source batch overlaps a previous batch");
      batch.actions.forEach(a => seen.add(a.actorId));
      if (contentHash(batch.stateSnapshot) !== batch.stateHash || Object.keys(batch.stateSnapshot.agents).length !== 49) throw new Error("Incomplete or changed source snapshot");
      batches.push({ actions: batch.actions, stateSnapshot: batch.stateSnapshot, sourceInvocationId: batch.sourceInvocationId,
        profileId: batch.profileId, stateHash: batch.stateHash });
      if (seen.size === 49) break;
    }
    if (seen.size !== 49) throw new Error("Every source must retain all 49 subjects");
    return { label: label!, directory: directory!, batches };
  });
}

export async function e3Compilation(mode: "prepare" | "run", root: string, sourceRoot: string) {
  const revision = cleanRevision();
  const sources = extractE3Sources(sourceRoot);
  const binding = { revision, sourceHash: contentHash(sources), B: incrementalPlayerAlgorithmRef(), C: executablePlayerAlgorithmRef(),
    protocol: "step-e3-complete-source-first-response-v1", prices: E3_PRICE, ceilings: E3_PHASES.P1,
    order: sources.flatMap((s, i) => (i % 2 ? ["C", "B"] : ["B", "C"]).flatMap(arm => s.batches.map((_, batch) => ({ source: s.label, arm, batch })))) };
  if (mode === "prepare") {
    mkdirSync(root, { recursive: false });
    cpSync(path.join(sourceRoot, "incremental-player-02/models.yaml"), path.join(root, "models.yaml"));
    const snapshot = path.join("data/model-registry/snapshots", `${E3_SNAPSHOT}.json`);
    mkdirSync(path.dirname(path.join(root, snapshot)), { recursive: true });
    cpSync(path.join(sourceRoot, "incremental-player-02", snapshot), path.join(root, snapshot));
    save(path.join(root, "sources.json"), sources); save(path.join(root, "P1-manifest.json"), binding);
  } else if (contentHash(json(path.join(root, "P1-manifest.json"))) !== contentHash(binding)) throw new Error("Frozen P1 binding drift");
  const directory = path.join(root, mode === "prepare" ? "P1-preflight" : "P1-run"); mkdirSync(directory);
  const env = e3Environment(root, "P1", { beforeSend: async (request, body, trial) => {
    const file = path.join(root, "P1-preflight", trial, "request.json");
    const value = { url: request.url, body, hash: contentHash(body) };
    if (mode === "prepare") { save(file, value); throw new ModelConfigurationError("Offline request captured; no HTTP"); }
    if (contentHash(json(file)) !== contentHash(value)) throw new ModelConfigurationError("P1 rendered request differs from frozen request");
  } });
  const cacheRoot = livingWorldCacheRoot(), encoder = await loadLocalEncoder({ modelDirectory: discoverLocalEncoderModelDirectory(cacheRoot, MULTILINGUAL_E5_BASE_ASSET.name),
    modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256 });
  const cache = new CachedPassageEncoder(encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, cacheRoot);
  const db = new LocalDatabase(path.join(directory, "ledger.sqlite"), { heartbeat: false });
  const rows: unknown[] = [];
  try {
    for (const source of sources) for (const batch of source.batches) await cache.encodePassages({
      worldContentHash: batch.stateSnapshot.worldHash, passages: actionCompilationPassagesForState(batch.stateSnapshot), allowWrite: mode === "prepare" });
    for (const item of binding.order) {
      const source = sources.find(s => s.label === item.source)!, batch = source.batches[item.batch]!;
      const id = `discovery-${source.label}-${item.arm}-${item.batch}`, ref = item.arm === "B" ? binding.B : binding.C;
      const trial = path.join(directory, id); mkdirSync(trial, { recursive: true });
      env.beginTrial(id);
      const beforeHttp = env.budget.summary.phases.discovery.httpRequests;
      const resources = createActionCompilationRetrievalRuntimeProvider({ cacheRoot, encoder });
      const retrieval = resources.runtime(ref)!;
      const algorithm = registerIntegratedPlayerAlgorithm().create(ref, { provider: env.provider, resources: {
        resolve: <T,>(kind: string) => kind === "candidate-selection-runtime" ? retrieval as T : undefined,
      } });
      const trace = db.beginExecution({ id, kind: "diagnostic", manifest: algorithm.manifest, worldHash: batch.stateSnapshot.worldHash,
        codeRevision: revision, codeDirty: false, modelCatalogHash: env.catalog.hash, seed: 20260911, runtimeConfig: binding });
      let calls = 0;
      const provider: StructuredModelProvider = { ...env.provider, generateStructured: async request => {
        if (++calls > 1 || (request.correlation?.semanticRepairAttempt ?? 0) !== 0) throw new ModelConfigurationError("First-output screen blocks repair before HTTP");
        try {
          const result = await env.provider.generateStructured(request); save(path.join(trial, "output.json"), result); return result;
        } catch (error) {
          if (error instanceof ModelOutputError) save(path.join(trial, "rejected-output.json"), { audit: error.audit, value: error.rawValue, error: error.message });
          throw error;
        }
      } };
      const programs: Record<string, BoundInteractionProgram> = {};
      const base = representedActionCompiler("AT", true, true, true), compile = item.arm === "C" ? executableActionCompiler(base, () => programs) : base;
      const started = performance.now(); let result: unknown, error: string | undefined;
      try {
        result = await compile(provider, structuredClone(batch.stateSnapshot), batch.actions, {
          workloadId: `e3-source-${source.label}`, batchId: id, observer: trace, correlation: { executionId: id },
          runtimeIdentity: { worldHash: batch.stateSnapshot.worldHash, revision: batch.stateSnapshot.revision },
          actionCompilationRetrieval: retrieval, executionAlgorithmRef: ref, modelRegistrySnapshotHash: E3_SNAPSHOT,
        }, batch.profileId, batch.actions.length, { maxRepairs: 0, exhaustion: "fail-step", splitAt: n => Math.ceil(n / 2) });
      } catch (caught) { error = String(caught); }
      await env.drain(); trace.flush();
      const evidence = { ...item, id, sourceInvocationId: batch.sourceInvocationId, sourceHash: contentHash(batch),
        actionIds: batch.actions.map(a => a.id), accepted: Boolean(result), result, error, calls,
        programs, elapsedMs: performance.now() - started, mode,
        paidHttp: env.budget.summary.phases.discovery.httpRequests - beforeHttp };
      save(path.join(trial, "evidence.json"), evidence);
      db.finishExecution(id, { status: result ? "succeeded" : "failed", ...(error ? { error } : {}) });
      rows.push({ ...item, id, accepted: Boolean(result), error, elapsedMs: evidence.elapsedMs, programs: Object.keys(programs).length });
      process.stdout.write(`${JSON.stringify(rows.at(-1))}\n`);
      if (mode === "prepare" && !existsSync(path.join(trial, "request.json"))) throw new Error("Offline primary request not captured");
      if (env.stopReason()) throw new Error(env.stopReason());
    }
    env.checkpoint(`${mode === "prepare" ? "P1-preflight" : "P1-run"}/result.json`, { complete: true, rows });
  } finally {
    await env.drain(); save(path.join(directory, "doctor.json"), db.debugDoctor()); db.close(); cache.close(); await encoder.dispose?.();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, root, sources = ".livingworld-benchmarks/step-e2"] = process.argv.slice(2);
  if (!root || mode !== "prepare" && mode !== "run") throw new Error("Usage: step-e3-compilation.ts prepare|run ROOT [STEP-E2-ROOT]");
  e3Compilation(mode, path.resolve(root), path.resolve(sources)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
