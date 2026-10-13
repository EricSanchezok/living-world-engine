import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { createJevLiveBudget, JEV_BUDGET_POLICY, JEV_PLANNING_NANO_CNY } from "../../src/engine/benchmarks/jev/live-budget";
import { JEV_QUALIFICATION_PROTOCOL, assertQualificationClock, semanticWorldHash, qualificationCatalogDocument, type JevArm } from "./jev-qualification-protocol";
import type { StructuredModelProvider } from "../../src/engine/models/model-provider";

const script = fileURLToPath(import.meta.url);
const implementationRoot = path.resolve(path.dirname(script), "../..");
const args = process.argv.slice(2);
const option = (name: string, fallback?: string): string => {
  const index = args.indexOf(`--${name}`), value = index < 0 ? fallback : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing --${name}`);
  return value;
};
const save = (file: string, data: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { flag: "wx", flush: true });
};
function cleanHead(root: string) {
  if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) throw new Error(`uncommitted producer: ${root}`);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}
const importAt = (root: string, relative: string) => import(pathToFileURL(path.join(root, relative)).href);
type Binding = { head: string; worldHash: string; semanticHash: string; catalogHash: string; agents: number; algorithm: unknown; conditionCadence: unknown };
type Manifest = { protocol: typeof JEV_QUALIFICATION_PROTOCOL; sources: Record<JevArm, string>; roots: Record<JevArm, string>;
  bindings: Record<JevArm, Binding>; budgetRoot: string; budgetPolicy: typeof JEV_BUDGET_POLICY; planningNanoCny: number; cacheRoot: string };

async function child(mode: string, root: string, engineRoot: string, arm: JevArm, trial?: string) {
  return new Promise<number>((resolve, reject) => {
    const childArgs = ["--import", "tsx", script, "--worker", mode, "--root", root, "--engine-root", engineRoot, "--arm", arm];
    if (trial) childArgs.push("--trial", trial);
    const process = spawn(globalThis.process.execPath, childArgs, { cwd: engineRoot, stdio: "inherit", env: globalThis.process.env });
    process.once("error", reject); process.once("exit", code => resolve(code ?? 1));
  });
}

/** Each worker imports the selected producer's own loader, prompts, gateway, host and replay. */
async function worker(mode: string) {
  const root = path.resolve(option("root")), engineRoot = path.resolve(option("engine-root")), arm = option("arm") as JevArm;
  if (!["A", "B", "C"].includes(arm) || process.cwd() !== engineRoot) throw new Error("invalid arm or producer working directory");
  const head = cleanHead(engineRoot);
  const catalogModule = await importAt(engineRoot, "src/engine/models/model-catalog.ts") as typeof import("../../src/engine/models/model-catalog");
  const catalog = catalogModule.parseModelCatalog(qualificationCatalogDocument(catalogModule.loadModelCatalog(path.join(engineRoot, "config/models.yaml")), arm));
  const loader = await importAt(engineRoot, "src/script/world-loader.ts") as typeof import("../../src/script/world-loader");
  const builder = await importAt(engineRoot, "scripts/experiments/player-integrated-world.ts") as typeof import("./player-integrated-world");
  const source = loader.loadWorldTemplate(path.join(engineRoot, "worlds/blackmarsh/world"));
  const manifest = mode === "binding" ? undefined : JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8")) as Manifest;
  const trial = manifest?.protocol.trials.find(value => value.id === option("trial"));
  if (mode !== "binding" && !trial) throw new Error("unknown frozen trial");
  const built = builder.buildIntegratedPlayerWorld(source, trial?.seed ?? 20260922, catalog);
  const registryModule = await importAt(engineRoot, "src/engine/algorithms/registry.ts") as typeof import("../../src/engine/algorithms/registry");
  const native = arm === "A" ? undefined : await importAt(engineRoot, "src/engine/events/algorithm.ts") as typeof import("../../src/engine/events/algorithm");
  const algorithm = native ? native.decisionEventAlgorithmRef({ ...native.JEV_EVENT_CONFIG,
    decision: arm === "B" ? "decision-deepseek" : "decision-jev" }) : registryModule.DEFAULT_ALGORITHM_REF;
  const binding: Binding = { head, worldHash: built.world.contentHash, semanticHash: semanticWorldHash(built.candidate), catalogHash: catalog.hash,
    agents: Object.keys(built.world.initialState.agents).length, algorithm,
    conditionCadence: built.candidate.mechanics.condition_profiles.map(value => ({ id: value.id, seconds: value.recurring_interval_seconds ?? null })) };
  if (mode === "binding") { save(path.join(root, `binding-${arm}.json`), binding); return; }
  if (!manifest || !trial || manifest.sources[arm] !== head || binding.semanticHash !== manifest.bindings[arm].semanticHash ||
    binding.catalogHash !== manifest.bindings[arm].catalogHash || contentHash(binding.conditionCadence) !== contentHash(manifest.bindings[arm].conditionCadence) ||
    contentHash(algorithm) !== contentHash(manifest.bindings[arm].algorithm)) throw new Error("frozen producer or world changed");
  const directory = path.join(root, trial.id, arm);
  if (existsSync(directory)) throw new Error("trial exists; never redraw a partially executed arm");
  mkdirSync(directory, { recursive: true });
  let stopped: string | undefined, deadline = Infinity;
  const reason = () => stopped ?? (performance.now() >= deadline ? "dispatch deadline exceeded" : undefined);
  const live = createJevLiveBudget(manifest.budgetRoot, reason), calls = new Set<Promise<unknown>>();
  const registryClass = await importAt(engineRoot, "src/engine/models/model-registry.ts") as typeof import("../../src/engine/models/model-registry");
  const modelRegistry = new registryClass.ModelRegistry(catalog, directory);
  const gatewayClass = await importAt(engineRoot, "src/engine/models/model-gateway.ts") as typeof import("../../src/engine/models/model-gateway");
  const network = await importAt(engineRoot, "src/engine/models/model-network.ts") as typeof import("../../src/engine/models/model-network");
  const resolver = network.createModelFetchResolver(process.env);
  const gateway = new gatewayClass.ModelGateway(catalog, process.env, { registry: modelRegistry, maxTransportAttempts: 1,
    fetchForAccount: (id, account) => live.transport(id, resolver(id, account) ?? fetch) });
  const provider = new Proxy(gateway, { get(target, property) {
    const value = Reflect.get(target, property);
    if (typeof value !== "function") return value;
    if (!["generateStructured", "decide"].includes(String(property))) return value.bind(target);
    return (...parameters: unknown[]) => {
      if (reason()) return Promise.reject(new Error(reason()));
      const pending = Reflect.apply(value, target, parameters) as Promise<unknown>;
      calls.add(pending); void pending.finally(() => calls.delete(pending)).catch(() => undefined); return pending;
    };
  } }) as StructuredModelProvider;
  const databaseClass = await importAt(engineRoot, "src/server/local-database.ts") as typeof import("../../src/server/local-database");
  const database = new databaseClass.LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
  const hostClass = await importAt(engineRoot, "src/server/world-host.ts") as typeof import("../../src/server/world-host");
  const repositoryClass = await importAt(engineRoot, "src/script/world-repository.ts") as typeof import("../../src/script/world-repository");
  const transaction = await importAt(engineRoot, "src/engine/runtime/transaction.ts") as typeof import("../../src/engine/runtime/transaction");
  let retrieval: import("../../src/server/action-compilation-retrieval-runtime").ActionCompilationRetrievalRuntimeProvider | undefined;
  let encoder: import("../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder").LocalEncoderRuntime | undefined;
  const report: Record<string, unknown> = { arm, trial, binding, beforeBudget: live.budget.summary, quality: "pending-semantic-review", actions: [] };
  const drain = async () => { while (calls.size) await Promise.allSettled([...calls]); await live.drain(); };
  const timer = setInterval(() => console.log(JSON.stringify({ arm, trial: trial.id, stage: report.stage,
    costCny: (live.budget.summary.estimatedPeakNanoCny + JEV_PLANNING_NANO_CNY) / 1e9, inFlight: live.budget.summary.inFlight.length })), 15_000);
  const stop = () => { stopped = "operator stopped dispatch"; };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    if (arm === "A") {
      report.stage = "local-retrieval-preflight";
      const moduleRoot = "src/engine/algorithms/eager-reference/candidate-retrieval/";
      const local = await importAt(engineRoot, `${moduleRoot}local-encoder.ts`) as typeof import("../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder");
      const assets = await importAt(engineRoot, `${moduleRoot}model-assets.ts`) as typeof import("../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets");
      const asset = assets.MULTILINGUAL_E5_BASE_ASSET;
      encoder = await local.loadLocalEncoder({ modelDirectory: local.discoverLocalEncoderModelDirectory(manifest.cacheRoot, asset.name),
        modelId: asset.modelId, expectedHash: asset.directorySha256 });
      const cacheModule = await importAt(engineRoot, `${moduleRoot}embedding-cache.ts`) as typeof import("../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache");
      const warmup = await importAt(engineRoot, `${moduleRoot}warmup.ts`) as typeof import("../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup");
      const cache = new cacheModule.CachedPassageEncoder(encoder, asset.encoderFingerprint, manifest.cacheRoot);
      try { await cache.encodePassages({ worldContentHash: built.world.contentHash, passages: warmup.actionCompilationPassagesForState(built.world.initialState), allowWrite: true }); }
      finally { cache.close(); }
      const retrievalModule = await importAt(engineRoot, "src/server/action-compilation-retrieval-runtime.ts") as typeof import("../../src/server/action-compilation-retrieval-runtime");
      retrieval = retrievalModule.createActionCompilationRetrievalRuntimeProvider({ cacheRoot: manifest.cacheRoot, encoder });
      await retrieval.preflight(algorithm, { worldContentHash: built.world.contentHash, state: built.world.initialState });
    }
    const host = new hostClass.WorldHost({ repository: new repositoryClass.MemoryWorldRepository({ [built.world.id]: built.world }),
      store: database, ledger: database, provider, defaultAlgorithmRef: algorithm, actionCompilationRetrievalProvider: retrieval,
      runLeaseMaxCommits: manifest.protocol.limits.maxCommitsPerLease });
    report.stage = "cold-initialization"; deadline = performance.now() + manifest.protocol.limits.maxDispatchMs;
    live.beginTrial(`${trial.id}-${arm}-cold`);
    const started = performance.now(), beforeCold = live.budget.summary;
    const created = await host.createInstance({ worldId: built.world.id, seed: trial.seed, title: `Jev ${trial.id} ${arm}`,
      start: { kind: "origin", originId: "harbor-wayfarer", displayName: "eric", appearance: "衣着朴素，背着旅行包，刚从客船下岸。",
        motivation: "依据真实见闻在黑沼港区探索并采取行动。" } });
    await drain();
    const instanceId = created.summary.id, read = () => database.readInstance(instanceId).document;
    const initial = read(); report.instanceId = instanceId;
    if (Object.keys(initial.state.agents).length !== 49 || initial.state.revision !== 0) throw new Error("full49 initialization cardinality changed");
    save(path.join(directory, "initial.json"), initial);
    report.initialization = { elapsedMs: performance.now() - started, beforeBudget: beforeCold, afterBudget: live.budget.summary,
      stateHash: contentHash(initial.state), coverage: initial.state.bootstrapDecisionEvent?.control.coverage };
    const participant = Object.values(initial.participants).find(value => value.status === "active");
    if (!participant) throw new Error("missing test participant");
    for (const [index, text] of manifest.protocol.tasks[trial.category]!.inputs.entries()) {
      report.stage = `input-${index + 1}`; deadline = performance.now() + manifest.protocol.limits.maxDispatchMs;
      live.beginTrial(`${trial.id}-${arm}-input-${index + 1}`);
      const before = read(), started = performance.now(), submissionId = `jev-${trial.id}-${arm}-${index + 1}`;
      const row: Record<string, unknown> = { index, text, submissionId, beforeBudget: live.budget.summary, baseRevision: before.state.revision,
        phase: index === 0 ? "first-expansion" : "continuation", feedback: [], quality: "pending-semantic-review" };
      let previous = before.state;
      try {
        await host.submitAction(instanceId, participant.id, { submissionId, expectedRevision: previous.revision, text });
        for (;;) {
          const document = read(), detail = host.instance(instanceId), elapsedMs = performance.now() - started;
          const intent = document.participantIntents.find(value => value.submissionId === submissionId);
          const run = intent && document.runs[intent.runId];
          if (!run) throw new Error("submitted action has no persistent run");
          const turn = detail.conversation?.turns.find(value => value.action?.submissionId === submissionId);
          for (const committed of document.state.history.filter(value => value.revision > previous.revision)) {
            const checkpoint = transaction.replaySimulationState(document.state, committed.revision);
            assertQualificationClock({ ...previous, elapsedSeconds: previous.truth.elapsedSeconds },
              { ...checkpoint, elapsedSeconds: checkpoint.truth.elapsedSeconds }, committed.operations.flatMap(value => value.kind === "advance_time" ? [value.seconds] : []));
            const response = turn?.responses?.find(value => value.revision === committed.revision);
            const observations = committed.observations.filter(value => value.observerId === intent!.agentId);
            (row.feedback as unknown[]).push({ revision: committed.revision, elapsedMs, stateHash: contentHash(checkpoint), response, observations });
            if (response?.text.trim() && observations.length) row.firstCandidateFeedbackMs ??= elapsedMs;
            previous = checkpoint;
          }
          if (contentHash(transaction.replaySimulationState(document.state)) !== contentHash(document.state)) throw new Error("durable replay differs");
          if (run.status === "awaiting-reaction" && !reason()) {
            const window = document.actionWindow;
            if (!window || window.kind !== "reaction" || window.status !== "open") throw new Error("reaction window unavailable");
            await host.submitReaction(instanceId, participant.id, { submissionId: `${submissionId}-keep-${window.generation}`,
              windowId: window.id, generation: window.generation, preparedStepId: window.preparedStepId, expectedRevision: document.state.revision, kind: "keep" });
          } else if (!["queued", "running", "pausing"].includes(run.status)) {
            row.run = run; row.censored = !!reason() || /budget|ceiling|reservation/iu.test(run.error ?? ""); break;
          }
          await new Promise(resolve => setTimeout(resolve, manifest.protocol.limits.pollMs));
        }
      } catch (error) { row.failure = error instanceof Error ? error.message : String(error); stopped = String(row.failure); }
      await drain();
      const final = read();
      Object.assign(row, { endedElapsedMs: performance.now() - started, afterBudget: live.budget.summary,
        revision: final.state.revision, elapsedSeconds: final.state.truth.elapsedSeconds, stateHash: contentHash(final.state) });
      save(path.join(directory, `input-${index + 1}.json`), row);
      (report.actions as unknown[]).push(row);
      if (reason() || live.budget.summary.blockingUnknown.length) break;
    }
    const final = read(), beforeReplay = contentHash(live.budget.summary);
    const replayEqual = contentHash(transaction.replaySimulationState(final.state)) === contentHash(final.state);
    const replayCalls = beforeReplay !== contentHash(live.budget.summary);
    report.replay = { equal: replayEqual, modelCalls: replayCalls ? "unexpected" : 0 };
    report.final = { stateHash: contentHash(final.state), revision: final.state.revision, elapsedSeconds: final.state.truth.elapsedSeconds };
    report.unexecutedInputs = 3 - (report.actions as unknown[]).length;
    report.doctor = database.debugDoctor();
    save(path.join(directory, "final.json"), final);
  } catch (error) {
    report.failure = error instanceof Error ? { message: error.message, stack: error.stack,
      causes: error instanceof AggregateError ? error.errors.map(value => String(value)) : [] } : String(error);
    report.unexecutedInputs = 3 - (report.actions as unknown[]).length;
  } finally {
    stopped ??= "arm finished"; await drain(); clearInterval(timer);
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    report.afterBudget = live.budget.summary;
    save(path.join(directory, "result.json"), report);
    database.close(); modelRegistry.stopBackgroundRefresh(); await encoder?.dispose?.(); live.close();
    console.log(JSON.stringify({ arm, trial: trial.id, result: path.join(directory, "result.json"), failure: report.failure }));
  }
}

async function main() {
  if (args.includes("--worker")) { await worker(option("worker")); return; }
  const root = path.resolve(option("root")), mode = option("mode"), manifestFile = path.join(root, "manifest.json");
  if (mode === "prepare") {
    if (existsSync(root)) throw new Error("qualification root already exists");
    const baseline = path.resolve(option("baseline-root")), budgetRoot = path.resolve(option("budget-root"));
    const roots = { A: baseline, B: implementationRoot, C: implementationRoot };
    const sources = { A: cleanHead(baseline), B: cleanHead(implementationRoot), C: cleanHead(implementationRoot) };
    mkdirSync(root, { recursive: true });
    for (const arm of ["A", "B", "C"] as const) if (await child("binding", root, roots[arm], arm)) throw new Error(`binding failed: ${arm}`);
    const bindings = Object.fromEntries((["A", "B", "C"] as const).map(arm => [arm, JSON.parse(readFileSync(path.join(root, `binding-${arm}.json`), "utf8"))])) as Record<JevArm, Binding>;
    if (new Set(Object.values(bindings).map(value => value.semanticHash)).size !== 1 || Object.values(bindings).some(value => value.agents !== 48)) throw new Error("cross-arm world semantics differ");
    save(manifestFile, { protocol: JEV_QUALIFICATION_PROTOCOL, sources, roots, bindings, budgetRoot,
      budgetPolicy: JEV_BUDGET_POLICY, planningNanoCny: JEV_PLANNING_NANO_CNY, cacheRoot: path.resolve(option("cache-root")) } satisfies Manifest);
    console.log(JSON.stringify({ manifest: manifestFile, sources, semanticHash: bindings.A.semanticHash })); return;
  }
  if (!["canary", "confirmation"].includes(mode)) throw new Error("unknown qualification mode");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  if (contentHash(manifest.protocol) !== contentHash(JEV_QUALIFICATION_PROTOCOL)) throw new Error("qualification protocol changed");
  for (const arm of ["A", "B", "C"] as const) if (cleanHead(manifest.roots[arm]) !== manifest.sources[arm]) throw new Error("qualification source changed");
  if (mode === "confirmation" && !existsSync(path.join(root, "canary-accounting.json"))) throw new Error("canary accounting must finish before confirmation");
  const results: unknown[] = [];
  for (const trial of manifest.protocol.trials.filter(value => value.phase === mode)) for (const arm of trial.order) {
    const file = path.join(root, trial.id, arm, "result.json");
    if (!existsSync(file) && await child("run", root, manifest.roots[arm], arm, trial.id)) throw new Error(`worker failed: ${trial.id} ${arm}`);
    results.push(JSON.parse(readFileSync(file, "utf8")));
  }
  save(path.join(root, `${mode}-accounting.json`), { results, quality: "pending-independent-semantic-review", qualified: false });
}
void main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
