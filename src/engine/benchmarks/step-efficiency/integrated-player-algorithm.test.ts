import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ScriptedModelProvider, deterministicModelOutput, createTestModelCatalog } from "../../testing/model-provider";
import { loadWorldScript } from "../../../script/world-loader";
import { MemoryWorldRepository } from "../../../script/world-repository";
import { LocalDatabase } from "../../../server/local-database";
import { WorldHost } from "../../../server/world-host";
import { createActionCompilationRetrievalRuntimeProvider } from "../../../server/action-compilation-retrieval-runtime";
import { runPlayerFeedbackAction } from "../../../../scripts/operations/player-feedback-playtest";
import { integratedPlayerAlgorithmRef, registerIntegratedPlayerAlgorithm } from "./integrated-player-algorithm";
import { ACTION_DICTIONARY_CODEC, expandObservationActions } from "./observation-action-dictionary";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../algorithms/eager-reference/candidate-retrieval/model-assets";
import { CachedPassageEncoder } from "../../algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { actionCompilationPassagesForState } from "../../algorithms/eager-reference/candidate-retrieval/warmup";
import { RecordingRuntimeObserver } from "../../runtime/observability";

it("pins the diagnostic producer through actual player submission, persistence and a reopened host", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "integrated-player-"));
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const provider = new ScriptedModelProvider(request => request.role === "arrival-generator"
    ? { title: "庭院", scene: "你站在庭院里。", possibleNextActions: ["观察四周"] }
    : deterministicModelOutput(request.profileId, request.context), createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const ref = integratedPlayerAlgorithmRef();
  const encoder = { modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, modelHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
    dimensions: 2, encodeBatch: async (texts: readonly string[]) => texts.map(text => [text.length % 7, 1]) };
  const cache = new CachedPassageEncoder(encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, root);
  await cache.encodePassages({ worldContentHash: definition.contentHash, passages: actionCompilationPassagesForState(definition.initialState), allowWrite: true });
  cache.close();
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => {
    const context = request.context as { state?: { codec?: string } };
    // This persistence test replaces the structured provider boundary, which
    // returns canonical values. Each wire adapter has its own codec tests.
    return generate({ ...request, wireJsonSchema: undefined, preprocessOutput: value => {
      const fillFixtureDefaults = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(fillFixtureDefaults); return; }
        const row = node as Record<string, unknown>;
        if (row.kind === "commit_plans" && Array.isArray(row.plans)) {
          for (const plan of row.plans) plan.additionalRandomness ??= "none";
        }
        Object.values(row).forEach(fillFixtureDefaults);
      };
      fillFixtureDefaults(value);
      return { value, symbolRepairs: [] };
    },
      context: context.state?.codec === ACTION_DICTIONARY_CODEC
        ? { ...context, state: expandObservationActions(context.state) } : request.context });
  };
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const options = { repository: new MemoryWorldRepository({ [definition.id]: definition }), store: database, ledger: database, observer,
    provider, algorithmRegistry: registerIntegratedPlayerAlgorithm(), defaultAlgorithmRef: ref,
    actionCompilationRetrievalProvider: createActionCompilationRetrievalRuntimeProvider({ cacheRoot: root,
      encoder,
      fingerprint: () => MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint,
    }) };
  try {
    const host = new WorldHost(options);
    const created = await host.createInstance({ worldId: definition.id, start: { kind: "origin", originId: "courtyard-wanderer",
      displayName: "旅人", appearance: "背着旅行包。", motivation: "了解庭院。" } });
    const result = await runPlayerFeedbackAction({ host, instanceId: created.summary.id, participantId: created.participants[0]!.id,
      submissionId: "observe-courtyard", text: "我观察石门和守门人。", read: () => database.readInstance(created.summary.id).document,
      onUpdate: () => {}, onCheckpoint: () => {}, stopReason: () => undefined, onStop: () => {}, pollMs: 5 });
    const errors = database.executions({ instanceId: created.summary.id }).flatMap(execution => database.executionEvents(execution.id))
      .filter(event => event.error).map(event => ({ event: event.event, error: JSON.stringify(event.error).slice(0, 300) }));
    expect(result.failure, JSON.stringify(errors)).toBeUndefined();
    expect(result).toMatchObject({ status: "completed", feedback: [{ revision: created.summary.revision + 1 }] });
    expect(result.completedElapsedMs).toBeGreaterThan(0);
    const document = database.readInstance(created.summary.id).document;
    expect(document.executionAlgorithm).toEqual(ref);
    const executions = database.executions({ instanceId: created.summary.id });
    const algorithmExecutions = executions.filter(execution => execution.manifest.kind === "algorithm");
    expect(algorithmExecutions).toHaveLength(2);
    expect(algorithmExecutions.every(execution => execution.manifest.hash === ref.manifestHash)).toBe(true);
    expect(executions.some(execution => execution.manifest.kind === "engine-operation" && execution.manifest.id === "arrival-generator")).toBe(true);
    expect(new WorldHost(options).instance(created.summary.id).conversation!.turns[1]!.action!.submissionId).toBe(result.submissionId);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
