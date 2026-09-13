import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { buildIntegratedPlayerWorld, INTEGRATED_PLAYER_WORLD_RECIPE } from "./player-integrated-world";
import { assertFiniteWorkWorld } from "./step-finite-work-world";
import { integratedPlayerAlgorithmRef, registerIntegratedPlayerAlgorithm } from "../../src/engine/benchmarks/step-efficiency/integrated-player-algorithm";
import { standardEagerReferenceAlgorithmRef } from "../../src/engine/algorithms/standard-composition";
import { globalMeansPoolRequest } from "../../src/engine/benchmarks/step-efficiency/global-means-pool";
import { assertNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";
import { loadWorldScript, loadWorldTemplate } from "../../src/script/world-loader";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { installBundledWorlds } from "../../src/server/bundled-worlds";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { runPlayerFeedbackAction, type PlayerFeedbackResult } from "../operations/player-feedback-playtest";
import { CachedPassageEncoder } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { actionCompilationPassagesForState } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/warmup";
import { loadLocalEncoder, livingWorldCacheRoot, discoverLocalEncoderModelDirectory } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { relationalRrfEncoderFingerprint, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";

const protocol = { id: "integrated-player-goal-diagnostic-v5", worldRecipe: INTEGRATED_PLAYER_WORLD_RECIPE, seed: 20260911, maxHttp: 120,
  purpose: "unqualified-full-player-failure-localization", priorSourceQualification: "failed", promotionEligible: false,
  knownCounterexamples: ["observer-source-role-confusion", "unsupported-barrier-identity", "unsupported-negative-assertions"],
  maxDispatchMs: 600_000, maxCommitsPerLease: 6, model: "deepseek-flash", thinking: "disabled",
  action: "向码头边靠着的领航人或搬运工打听哪里有便宜又安全的下榻处。",
  interpretation: "One isolated full player action through WorldHost and persisted state, with all 48 original Agents plus the external participant. Prior source counterexamples remain failed qualification. This explicitly unqualified combined diagnostic locates actual critical-path and semantic failures; it neither promotes adapters nor changes prior source gates. Review actual source semantics before another action. No historical preparations or model outputs are imported. Timing and repairs include every new inference call; bootstrap is reported separately from submission-to-completion latency." } as const;
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (root: string, file: string, value: unknown) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const checkedCodeRevision = () => {
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked code before preparing or running live gameplay");
  return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
};
const selectedAlgorithm = (selection: unknown) => {
  if (selection === "standard" || selection === "standard-pooled") return standardEagerReferenceAlgorithmRef();
  if (selection === "integrated") return integratedPlayerAlgorithmRef();
  throw new Error("Expected explicit standard, standard-pooled or integrated composition selection");
};
const sourceHashes = () => Object.fromEntries(["scripts/experiments/player-integrated-playtest.ts",
  "scripts/experiments/player-integrated-world.ts", "scripts/experiments/step-finite-work-world.ts",
  "scripts/experiments/step-checkpoint-world.ts", "scripts/experiments/world-fragments/finite-work-goal.yaml",
  "scripts/operations/player-feedback-playtest.ts",
  "src/engine/benchmarks/step-efficiency/integrated-player-algorithm.ts",
  "src/engine/algorithms/standard-composition.ts",
  "src/engine/benchmarks/step-efficiency/global-means-pool.ts",
  "src/engine/prompts/shared/global-means-pool.md",
  "src/engine/mechanics/plan-source-selectors.ts",
  "src/engine/benchmarks/step-efficiency/agent-action-text.ts", "src/engine/prompts/shared/agent-action-text.md",
  "src/engine/prompts/shared/agent-action-text-raw.md", "src/engine/models/unmatched-closer-recovery.ts",
  "src/engine/models/json-duplicate-keys.ts", "src/engine/models/terminal-root-closer-recovery.ts",
  "src/engine/benchmarks/step-efficiency/perception-law-context.ts",
  "src/engine/benchmarks/step-efficiency/perception-report-domains.ts",
  "src/engine/models/model-adapter.ts", "src/engine/algorithms/eager-reference/agent-mind.ts",
].map(file => [file, contentHash(readFileSync(file, "utf8"))]));

export async function prepareIntegratedPlayer(root: string, registryRoot: string, snapshotHash: string, algorithmSelection = "integrated") {
  const codeRevision = checkedCodeRevision();
  const algorithm = selectedAlgorithm(algorithmSelection);
  mkdirSync(root, { recursive: false });
  const catalog = loadModelCatalog("config/models.yaml");
  const source = loadWorldTemplate("worlds/blackmarsh/world");
  const { candidate, baseline, world } = buildIntegratedPlayerWorld(source, protocol.seed, catalog);
  const profileIds = assertNonthinkingWorld(world, catalog, protocol.model);
  const snapshot = new ModelRegistry(catalog, registryRoot).snapshot(snapshotHash);
  const profileBindings = profileIds.map(id => {
    const binding = resolveModelProfile(catalog, snapshot, id);
    if (binding.modelId !== protocol.model || binding.profile.inference.thinking !== "disabled") throw new Error("Model binding drift");
    return { id, accountId: binding.accountId, modelId: binding.modelId, metadataHash: binding.modelMetadataHash,
      inference: binding.profile.inference };
  });
  const worldsRoot = path.join(root, "worlds"), destination = path.join(worldsRoot, "blackmarsh/world");
  cpSync("worlds/blackmarsh/world", destination, { recursive: true, filter: file => {
    if (/^\.env(?:\.|$)/u.test(path.basename(file))) throw new Error("World snapshot refuses secret files");
    return true;
  } });
  writeFileSync(path.join(destination, "mechanics.yaml"), stringify(candidate.mechanics));
  assertFiniteWorkWorld(loadWorldTemplate(destination));
  cpSync("config/models.yaml", path.join(root, "models.yaml"), { errorOnExist: true, force: false });
  const dataRoot = path.join(root, "data"), snapshots = path.join(dataRoot, "model-registry/snapshots");
  mkdirSync(snapshots, { recursive: true });
  save(snapshots, `${snapshotHash}.json`, snapshot.document);
  const persisted = loadWorldScript(destination, { seed: protocol.seed, modelCatalog: catalog });
  if (contentHash(persisted) !== contentHash(world)) throw new Error("World asset round trip changed source");
  const cacheRoot = livingWorldCacheRoot();
  const encoder = await loadLocalEncoder({ modelDirectory: discoverLocalEncoderModelDirectory(cacheRoot, MULTILINGUAL_E5_BASE_ASSET.name),
    modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, expectedHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256 });
  const fingerprint = relationalRrfEncoderFingerprint(encoder, R5_RELATIONAL_PASSAGE_SCHEMA_VERSION);
  if (fingerprint !== MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint) throw new Error("Local encoder fingerprint drift");
  const cache = new CachedPassageEncoder(encoder, fingerprint, cacheRoot);
  let cachePreparation;
  try {
    cachePreparation = await cache.encodePassages({ worldContentHash: world.contentHash,
      passages: actionCompilationPassagesForState(world.initialState), allowWrite: true });
    const retrieval = createActionCompilationRetrievalRuntimeProvider({ cacheRoot, encoder });
    await retrieval.preflight(algorithm, { worldContentHash: world.contentHash, state: world.initialState });
  } finally { cache.close(); await encoder.dispose?.(); }
  const manifest = { protocol, codeRevision, sourceCodeHashes: sourceHashes(), algorithmSelection, algorithm, catalogHash: catalog.hash,
    registrySnapshotHash: snapshotHash, profileBindings, sourceTemplateHash: contentHash(source), templateHash: contentHash(candidate),
    sourceWorldHash: baseline.contentHash, worldHash: world.contentHash, initialStateHash: contentHash(world.initialState),
    originalAgentIds: Object.keys(world.initialState.agents).sort(), originalEntityCount: Object.keys(world.initialState.truth.entities).length,
    changedProfiles: ["momentary-action", "brief-action"], addedProfiles: ["work-until-objective"],
    addedTemporalCoverage: ["finite-work"], addedTemporalCalibrations: ["finite-work-objective-time"],
    cachePreparation: { hits: cachePreparation.hits, misses: cachePreparation.misses },
    newHttp: 0, runtimePromoted: false };
  save(root, "manifest.json", manifest);
  return manifest;
}

export async function runIntegratedPlayer(root: string) {
  const codeRevision = checkedCodeRevision();
  const manifest = read(path.join(root, "manifest.json"));
  if (manifest.codeRevision !== codeRevision || contentHash(manifest.protocol) !== contentHash(protocol) || contentHash(manifest.sourceCodeHashes) !== contentHash(sourceHashes()) ||
    contentHash(manifest.algorithm) !== contentHash(selectedAlgorithm(manifest.algorithmSelection))) throw new Error("Prepared diagnostic drift");
  const directory = path.join(root, "run"); mkdirSync(directory, { recursive: false });
  const catalog = loadModelCatalog(path.join(root, "models.yaml"));
  assertFiniteWorkWorld(loadWorldTemplate(path.join(root, "worlds/blackmarsh/world")));
  const world = loadWorldScript(path.join(root, "worlds/blackmarsh/world"), { seed: protocol.seed, modelCatalog: catalog });
  if (catalog.hash !== manifest.catalogHash || world.contentHash !== manifest.worldHash || contentHash(world.initialState) !== manifest.initialStateHash) throw new Error("Frozen world or catalog drift");
  const dataRoot = path.join(root, "data"), registry = new ModelRegistry(catalog, dataRoot);
  registry.snapshot(manifest.registrySnapshotHash);
  const retrieval = createActionCompilationRetrievalRuntimeProvider();
  await retrieval.preflight(manifest.algorithm, { worldContentHash: world.contentHash, state: world.initialState });
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const pending = new Set<Promise<unknown>>();
  const network = createModelFetchResolver(process.env);
  const started = performance.now();
  let http = 0, stopReason: string | undefined, status = "creating", failure: string | undefined;
  let instanceId: string | undefined, player: PlayerFeedbackResult | undefined;
  const report = () => {
    const row = { status, instanceId, elapsedMs: performance.now() - started, http, pendingCalls: pending.size,
      stopReason, failure, player };
    writeFileSync(path.join(directory, "progress.json"), JSON.stringify(row, null, 2));
    process.stdout.write(`${JSON.stringify({ ...row, player: player && { status: player.status, firstFeedbackElapsedMs: player.firstFeedbackElapsedMs,
      completedElapsedMs: player.completedElapsedMs, endedElapsedMs: player.endedElapsedMs,
      feedbackCount: player.feedback.length, failure: player.failure } })}\n`);
  };
  const stop = () => { stopReason ??= "Operator stopped later dispatch"; };
  const deadline = setTimeout(() => { stopReason ??= "Ten-minute dispatch ceiling reached"; }, protocol.maxDispatchMs);
  const timer = setInterval(report, 10_000);
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
    registry: { catalog, capture: async hash => registry.snapshot(hash ?? manifest.registrySnapshotHash),
      refresh: async () => { throw new ModelConfigurationError("Frozen registry refresh disabled"); }, status: () => registry.status() },
    fetchForAccount: (id, account) => {
      const send = network(id, account) ?? fetch;
      return async (input, init) => {
        const request = new Request(input, init), body = await request.clone().json();
        if (stopReason || http >= protocol.maxHttp || id !== "deepseek-api" || body.model !== protocol.model || body.thinking?.type !== "disabled") {
          stopReason ??= "HTTP ceiling or inference configuration drift";
          throw new ModelConfigurationError(stopReason);
        }
        const ordinal = ++http;
        save(directory, `http-${ordinal}-request.json`, { url: request.url, body, elapsedMs: performance.now() - started });
        return send(input, init);
      };
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: profiles => gateway.assertProfilesAvailable(profiles), generateStructured: async request => {
      if (stopReason) throw new ModelConfigurationError(stopReason);
      const physical = manifest.algorithmSelection === "standard-pooled" ? globalMeansPoolRequest(request) : request;
      const call = gateway.generateStructured({ ...physical, modelRegistrySnapshotHash: manifest.registrySnapshotHash });
      pending.add(call);
      try { return await call; } finally { pending.delete(call); }
    } };
  const database = new LocalDatabase(path.join(dataRoot, "livingworld.sqlite"));
  try {
    save(directory, "binding.json", { codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      preparationHash: contentHash(manifest), sourceCodeHashes: sourceHashes(), protocol, algorithm: manifest.algorithm });
    installBundledWorlds(database, catalog, path.join(root, "worlds"));
    if (database.load("blackmarsh", protocol.seed, catalog).contentHash !== manifest.worldHash) throw new Error("Persisted catalog drift");
    const host = new WorldHost({ repository: database, store: database, ledger: database, provider, observer,
      algorithmRegistry: registerIntegratedPlayerAlgorithm(), defaultAlgorithmRef: manifest.algorithm,
      actionCompilationRetrievalProvider: retrieval, runLeaseMaxCommits: protocol.maxCommitsPerLease,
      runLeaseMaxWallTimeMs: protocol.maxDispatchMs });
    const created = await host.createInstance({ worldId: "blackmarsh", seed: protocol.seed, title: "玩家行动效率测试",
      start: { kind: "origin", originId: "harbor-wayfarer", displayName: "eric", appearance: "衣着朴素，背着旅行包，刚从客船下岸。",
        motivation: "在风暴来临前找到便宜且安全的住处。" } }, "local", manifest.algorithm);
    instanceId = created.summary.id;
    const initial = database.readInstance(instanceId).document;
    if (created.participants.length !== 1 || Object.keys(initial.state.agents).length !== 49 ||
      manifest.originalAgentIds.some((id: string) => !initial.state.agents[id])) throw new Error("Complete 48 plus external participant cohort required");
    save(directory, "initial-instance.json", initial);
    status = "running"; report();
    player = await runPlayerFeedbackAction({ host, instanceId, participantId: created.participants[0]!.id,
      submissionId: "lodging-inquiry-1", text: protocol.action, read: () => database.readInstance(instanceId!).document,
      stopReason: () => stopReason, onStop: reason => { stopReason ??= reason; },
      onUpdate: result => { player = structuredClone(result); report(); },
      onCheckpoint: (evidence, observedElapsedMs) => save(directory, `step-${evidence.committed.step}-evidence.json`, { ...evidence, observedElapsedMs }),
    });
    status = player.status === "completed" || player.status === "awaiting-decision" ? "awaiting-source-review" : "stopped";
    failure = player.failure;
  } catch (error) { failure = String(error); stopReason ??= failure; status = "stopped"; }
  finally {
    while (pending.size) await Promise.allSettled([...pending]);
    clearTimeout(deadline); clearInterval(timer); process.off("SIGINT", stop); process.off("SIGTERM", stop);
    save(directory, "events.json", observer.snapshot());
    const executions = database.executions(instanceId ? { instanceId } : {});
    save(directory, "executions.json", executions);
    save(directory, "ledger-events.json", executions.flatMap(execution => database.executionEvents(execution.id)));
    if (instanceId) save(directory, "final-instance.json", database.readInstance(instanceId).document);
    save(directory, "doctor.json", database.debugDoctor());
    save(directory, "result.json", { status, failure, stopReason, newHttp: http, pendingCalls: pending.size,
      elapsedMs: performance.now() - started, player, semanticQualification: "unassessed; requires source review", wholeGoalAchieved: false });
    database.close(); report();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, directory, registryRoot, snapshotHash, algorithmSelection = "integrated", ...extra] = process.argv.slice(2);
  if (!directory || extra.length || mode === "prepare" && (!registryRoot || !snapshotHash) || mode === "run" && registryRoot || !["prepare", "run"].includes(mode)) {
    throw new Error("Expected prepare output-directory registry-data-root snapshot-hash [standard|standard-pooled|integrated] | run prepared-directory");
  }
  (mode === "prepare" ? prepareIntegratedPlayer(path.resolve(directory), registryRoot!, snapshotHash!, algorithmSelection) : runIntegratedPlayer(path.resolve(directory)))
    .then(result => { if (result) process.stdout.write(`${JSON.stringify({ prepared: true, worldHash: result.worldHash, newHttp: 0 })}\n`); })
    .catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
