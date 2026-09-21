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
import { MULTILINGUAL_E5_BASE_ASSET } from "../../algorithms/eager-reference/candidate-retrieval/model-assets";
import { CachedPassageEncoder } from "../../algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { actionCompilationPassagesForState } from "../../algorithms/eager-reference/candidate-retrieval/warmup";
import { contentHash } from "../../models/model-audit";
import { replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { SimulationEngine } from "../../runtime/simulation";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { registerIntegratedPlayerAlgorithm } from "./integrated-player-algorithm";
import { incrementalPlayerAlgorithmRef } from "./incremental-player-algorithm";
import { AGENT_INTENT_CONTROL } from "./agent-intent-control";
import { readIntentMemory, reconcileIntentMemory } from "./incremental-intent-execution";
import { IntentExecutionCursor } from "./intent-execution-cursor";

it("runs parallel work, survives failed guard preparation and resumes the saved program through WorldHost", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "incremental-player-"));
  let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  let failGuard = false, guardCalls = 0;
  const provider = new ScriptedModelProvider(request => {
    if (request.role === "arrival-generator") return { title: "庭院", scene: "你站在庭院里。", possibleNextActions: ["观察四周", "查看石门", "询问守门人"] };
    if (request.schemaName === "intent_guard_batch") {
      guardCalls++;
      if (failGuard) throw new Error("controlled guard inference failure");
      const context = request.context as { slots: Array<{ slot: number; perspective: { agentId: string } }> };
      expect(context.slots.every(slot => ["player", "keeper"].includes(slot.perspective.agentId))).toBe(true);
      expect(JSON.stringify(context)).not.toContain("canonicalEntityIds");
      return { slots: context.slots.map(slot => ({ slot: slot.slot, verdict: "true", evidence: "控制模型根据本角色的观察判定条件满足。" })) };
    }
    const output = deterministicModelOutput(request.profileId, request.context);
    if (request.promptVersion.includes(AGENT_INTENT_CONTROL)) {
      type PrivateSlot = { slot: number; agentState?: { intention?: { canContinue: boolean } }; state?: { intention?: { canContinue: boolean } } };
      const slots = (request.context as { slots: PrivateSlot[] }).slots;
      const minds = output as { slots: Array<{ slot: number; nextActionIntent: unknown }> };
      for (const slot of minds.slots) {
        const context = slots.find(source => source.slot === slot.slot)!;
        const intention = context.agentState?.intention ?? context.state?.intention;
        slot.nextActionIntent = intention?.canContinue ? { kind: "continue" } : {
          kind: "replace", program: { kind: "sequence", children: [
            { kind: "parallel", children: [
              { kind: "attempt", text: "观察自己的衣物。", targetHandles: ["ref:local_entity:self"] },
              { kind: "attempt", text: "同时留意周围声音。", targetHandles: ["ref:local_entity:self"] },
            ] },
            { kind: "await", condition: "我已获得刚才观察的结果。", targetHandles: ["ref:local_entity:self"] },
            { kind: "attempt", text: "随后整理刚才得到的信息。", targetHandles: ["ref:local_entity:self"] },
          ] } };
      }
    }
    return output;
  }, createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  // Other diagnostic codecs already have their own wire tests; canonical
  // fixtures replace those model outputs while this test exercises control wire.
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => {
    if (request.promptVersion.includes(AGENT_INTENT_CONTROL) || request.schemaName === "intent_guard_batch") return generate(request);
    return generate({ ...request, wireJsonSchema: undefined, preprocessOutput: value => {
      const fill = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(fill); return; }
        const row = node as Record<string, unknown>;
        if (row.kind === "commit_plans" && Array.isArray(row.plans)) {
          for (const plan of row.plans as Array<Record<string, unknown>>) plan.additionalRandomness ??= "none";
        }
        Object.values(row).forEach(fill);
      };
      fill(value); return { value, symbolRepairs: [] };
    } });
  };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const ref = incrementalPlayerAlgorithmRef();
  const encoder = { modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, modelHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
    dimensions: 2, encodeBatch: async (texts: readonly string[]) => texts.map(text => [text.length % 7, 1]) };
  const cache = new CachedPassageEncoder(encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, root);
  await cache.encodePassages({ worldContentHash: definition.contentHash, passages: actionCompilationPassagesForState(definition.initialState), allowWrite: true });
  cache.close();
  const options = () => ({ repository: new MemoryWorldRepository({ [definition.id]: definition }), store: database, ledger: database,
    provider, algorithmRegistry: registerIntegratedPlayerAlgorithm(), defaultAlgorithmRef: ref,
    actionCompilationRetrievalProvider: createActionCompilationRetrievalRuntimeProvider({ cacheRoot: root,
      encoder, fingerprint: () => MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint }) });
  try {
    let host = new WorldHost(options());
    const created = await host.createInstance({ worldId: definition.id, start: { kind: "origin", originId: "courtyard-wanderer",
      displayName: "旅人", appearance: "背着旅行包。", motivation: "了解庭院。" } });
    const run = (submissionId: string) => runPlayerFeedbackAction({ host, instanceId: created.summary.id,
      participantId: created.participants[0]!.id, submissionId, text: "我观察石门和守门人。",
      read: () => database.readInstance(created.summary.id).document,
      onUpdate: () => {}, onCheckpoint: () => {}, stopReason: () => undefined, onStop: () => {}, pollMs: 5 });
    const first = await run("first-look");
    expect(first.failure).toBeUndefined(); expect(first.status).toBe("completed"); expect(first.feedback.length).toBeGreaterThan(0);
    const saved = database.readInstance(created.summary.id).document;
    const initialMemory = readIntentMemory(saved.state.executionState, ref.manifestHash);
    expect(Object.keys(initialMemory.active).sort()).toEqual(["keeper", "player"]);
    expect(saved.state.history.at(-1)!.initialActions.filter(action => ["player", "keeper"].includes(action.actorId))
      .every(action => action.rawText.startsWith("CURRENT_PARALLEL_ATTEMPTS_V1"))).toBe(true);
    const stateHash = contentHash(saved.state);
    const tampered = structuredClone(saved.state); tampered.executionState = null;
    expect(() => validateSimulationState(tampered, false, true)).toThrow("replayed history");
    expect(() => new SimulationEngine(definition, new EagerReferenceAlgorithm(provider), saved.state)).toThrow("another Composition");
    failGuard = true;
    const failed = await run("failed-look");
    expect(failed.failure).toBeDefined(); expect(guardCalls).toBeGreaterThan(0);
    expect(contentHash(database.readInstance(created.summary.id).document.state)).toBe(stateHash);
    database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    host = new WorldHost(options()); failGuard = false;
    const resumed = await run("resumed-look");
    expect(resumed.failure).toBeUndefined(); expect(resumed.status).toBe("completed");
    const final = database.readInstance(created.summary.id).document;
    expect(contentHash(replaySimulationState(final.state))).toBe(contentHash(final.state));
    expect(final.state.history.at(-1)!.initialActions.filter(action => ["player", "keeper"].includes(action.actorId))
      .map(action => action.rawText)).toEqual(["随后整理刚才得到的信息。", "随后整理刚才得到的信息。"]);
    const finalMemory = readIntentMemory(final.state.executionState, ref.manifestHash);
    reconcileIntentMemory(finalMemory, final.state);
    for (const [id, snapshot] of Object.entries(finalMemory.active)) {
      expect(snapshot.source).toEqual(initialMemory.active[id]!.source);
      expect(IntentExecutionCursor.restore(snapshot).status).toBe("completed");
    }
    expect(final.executionAlgorithm).toEqual(ref);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
