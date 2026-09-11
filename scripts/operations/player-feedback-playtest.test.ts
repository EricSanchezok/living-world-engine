import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FULL_CATALOG_ALGORITHM_REF } from "../../src/engine/algorithms/registry";
import { createTestModelCatalog, DeterministicModelProvider } from "../../src/engine/testing/model-provider";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { runPlayerFeedbackAction, type PlayerFeedbackResult } from "./player-feedback-playtest";

it.each([false, true])("measures actual persisted player feedback and preserves terminal failure=%s", async fail => {
  const root = mkdtempSync(path.join(tmpdir(), "player-feedback-"));
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const provider = new DeterministicModelProvider(createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const repository = new MemoryWorldRepository({ [definition.id]: definition });
  const options = { repository, store: database, ledger: database, provider, defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF };
  const host = new WorldHost(options);
  try {
    const created = await host.createInstance({ worldId: definition.id, start: { kind: "origin", originId: "courtyard-wanderer",
      displayName: "旅人", appearance: "背着旅行包。", motivation: "了解庭院。" } });
    const generate = provider.generateStructured.bind(provider);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.generateStructured = async request => {
      entered(); await gate;
      if (fail) throw new ModelConfigurationError("injected unavailable model");
      return generate(request);
    };
    const updates: PlayerFeedbackResult[] = [];
    const checkpoints: number[] = [];
    let stopped: string | undefined;
    const promise = runPlayerFeedbackAction({ host, instanceId: created.summary.id, participantId: created.participants[0]!.id,
      submissionId: "watch-courtyard", text: "我观察石门和守门人。", read: () => database.readInstance(created.summary.id).document,
      onUpdate: result => updates.push(structuredClone(result)), onCheckpoint: value => checkpoints.push(value.checkpoint.revision),
      stopReason: () => stopped, onStop: reason => { stopped = reason; }, pollMs: 5 });
    await waiting;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "running", firstFeedbackElapsedMs: null, completedElapsedMs: null, feedback: [] });
    expect(host.instance(created.summary.id).summary.revision).toBe(created.summary.revision);
    release();
    const result = await promise;
    if (fail) {
      expect(result).toMatchObject({ status: "stopped", firstFeedbackElapsedMs: null, completedElapsedMs: null, feedback: [] });
      expect(result.failure).toBeTruthy();
      expect(checkpoints).toEqual([]);
      expect(host.instance(created.summary.id).summary.revision).toBe(created.summary.revision);
    } else {
      expect(result.status).toBe("completed");
      expect(result.feedback).toHaveLength(1);
      expect(checkpoints).toEqual([created.summary.revision + 1]);
      expect(result.firstFeedbackElapsedMs).toBeGreaterThan(0);
      expect(result.completedElapsedMs).toBeGreaterThanOrEqual(result.firstFeedbackElapsedMs!);
      expect(result.feedback[0]!.observationCount).toBeGreaterThan(0);
      const refreshed = new WorldHost(options).instance(created.summary.id);
      expect(refreshed.conversation!.turns[1]!.response).toEqual(result.feedback[0]!.response);
      expect(refreshed.conversation!.turns[1]!.action!.submissionId).toBe(result.submissionId);
    }
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
