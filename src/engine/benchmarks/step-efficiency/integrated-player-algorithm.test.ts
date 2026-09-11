import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ScriptedModelProvider, deterministicModelOutput, deterministicActionCompilationBatch,
  createTestModelCatalog, createTestModelRegistry, deterministicOnsetReports } from "../../testing/model-provider";
import type { ExistingReferenceHandle } from "../../contracts/model-context";
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
import { createModelGateway } from "../../models/model-gateway";
import { TERMINAL_ROOT_CLOSER_RECOVERY } from "../../models/terminal-root-closer-recovery";
import { PERCEPTION_REPORT_DOMAINS } from "./perception-report-domains";

it.each([false, true])("pins the diagnostic producer through persistence with external reaction=%s", async externalReaction => {
  const root = mkdtempSync(path.join(tmpdir(), "integrated-player-"));
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const provider = new ScriptedModelProvider(request => {
    if (request.role === "arrival-generator") return { title: "庭院", scene: "你站在庭院里。", possibleNextActions: ["观察四周", "查看石门", "询问守门人"] };
    if (externalReaction && request.role === "action-compilation") return deterministicActionCompilationBatch(request.profileId, request.context,
      (compilation, _slot, context) => {
        const candidates = (context as { referenceCatalog: { candidates: Array<{ kind: string; label: string; candidateKey: string }> } }).referenceCatalog.candidates;
        const player = candidates.find(candidate => candidate.kind === "agent" && candidate.label === "courtyard-wanderer-1");
        if (!player) throw new Error("reaction fixture requires the external player candidate");
        compilation.interactionDependency.audienceAgentRefs = [player.candidateKey as ExistingReferenceHandle];
      });
    return deterministicModelOutput(request.profileId, request.context);
  }, createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const ref = integratedPlayerAlgorithmRef();
  const encoder = { modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, modelHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
    dimensions: 2, encodeBatch: async (texts: readonly string[]) => texts.map(text => [text.length % 7, 1]) };
  const cache = new CachedPassageEncoder(encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, root);
  await cache.encodePassages({ worldContentHash: definition.contentHash, passages: actionCompilationPassagesForState(definition.initialState), allowWrite: true });
  cache.close();
  let perceptionCalls = 0, perceptionContext: unknown;
  const gateway = createModelGateway(provider.catalog, { TEST_MODEL_API_KEY: "fixture-key" }, {
    registry: createTestModelRegistry(provider.catalog), maxTransportAttempts: 1, fetch: async (_url, init) => {
      perceptionCalls++;
      const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain("Identity binding only");
      expect(body.messages[1].content).toContain("perception_entity_assertion");
      const content = JSON.stringify({ kind: "done", reports: deterministicOnsetReports(perceptionContext) }) + "}";
      return Response.json({ id: "perception-fixture", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } });
    },
  });
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => {
    if (request.role === "truth-perception") {
      expect(request.jsonSyntaxRecovery).toBe(TERMINAL_ROOT_CLOSER_RECOVERY);
      expect(request.promptVersion).toContain(PERCEPTION_REPORT_DOMAINS);
      perceptionContext = request.context;
      return gateway.generateStructured(request);
    }
    const context = request.context as { state?: { codec?: string } };
    // Other model roles return canonical fixture values; perception uses the
    // actual registered request, gateway, parser and materializer above.
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
    expect(ref.version).toBe("9");
    if (externalReaction) expect(perceptionCalls).toBeGreaterThan(0);
    const executions = database.executions({ instanceId: created.summary.id });
    const algorithmExecutions = executions.filter(execution => execution.manifest.kind === "algorithm");
    expect(algorithmExecutions).toHaveLength(externalReaction ? 3 : 2);
    expect(result.reactions).toHaveLength(externalReaction ? 1 : 0);
    expect(algorithmExecutions.every(execution => execution.manifest.hash === ref.manifestHash)).toBe(true);
    expect(executions.some(execution => execution.manifest.kind === "engine-operation" && execution.manifest.id === "arrival-generator")).toBe(true);
    expect(new WorldHost(options).instance(created.summary.id).conversation!.turns[1]!.action!.submissionId).toBe(result.submissionId);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
