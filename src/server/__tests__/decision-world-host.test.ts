import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nativeProgramFixture, nativeProgramTestConfig } from "../../engine/testing/native-program-world";
import { decisionEventAlgorithmRef } from "../../engine/events/algorithm";
import { readDecisionEventState } from "../../engine/events/runtime-state";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { historyReplayBaseHash } from "../../engine/runtime/history-replay";
import { MemoryWorldRepository } from "../../script/world-repository";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

describe("decision programs through the persistent WorldHost", () => {
  it("sleeps with no fabricated time, revision, failure or recurring model work", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-native-sleep-"));
    const fixture = nativeProgramFixture();
    for (const agent of Object.values(fixture.world.initialState.agents)) agent.character.goals = {};
    fixture.world.historyBaseHash = historyReplayBaseHash(fixture.world.initialState);
    await fixture.configured.registry.capture();
    const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    const host = new WorldHost({ repository: new MemoryWorldRepository({ [fixture.world.id]: fixture.world }),
      store: database, ledger: database, provider: fixture.configured.gateway,
      defaultAlgorithmRef: decisionEventAlgorithmRef(nativeProgramTestConfig) });
    try {
      const created = await host.createInstance({ worldId: fixture.world.id, start: { kind: "observer" } });
      const id = created.summary.id, calls = fixture.configured.transport.mock.calls.length;
      await host.advance(id, { expectedRevision: 0, trigger: "batch", steps: 1 });
      for (let i = 0; i < 200 && host.instance(id).run?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      const detail = host.instance(id);
      expect(detail.run).toMatchObject({ status: "paused", stopReason: "waiting-for-event" });
      expect(detail.summary.revision).toBe(0);
      const saved = database.readInstance(id).document;
      expect(saved.state.truth.elapsedSeconds).toBe(0);
      expect(saved.state.history).toEqual([]);
      expect(fixture.configured.transport).toHaveBeenCalledTimes(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("persists the native producer, actual speech and sleeping program, then reopens and replays without model calls", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-native-host-"));
    const filename = path.join(root, "livingworld.sqlite");
    const fixture = nativeProgramFixture();
    await fixture.configured.registry.capture();
    let database = new LocalDatabase(filename, { heartbeat: false });
    const repository = new MemoryWorldRepository({ [fixture.world.id]: fixture.world });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: fixture.configured.gateway,
      defaultAlgorithmRef: decisionEventAlgorithmRef(nativeProgramTestConfig) });
    try {
      const host = makeHost();
      const created = await host.createInstance({ worldId: fixture.world.id, start: { kind: "observer" } });
      const id = created.summary.id;
      expect(database.readInstance(id).document.state.bootstrapDecisionEvent).toBeDefined();
      await host.advance(id, { expectedRevision: 0, trigger: "batch", steps: 1 });
      for (let i = 0; i < 200 && host.instance(id).run?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      const detail = host.instance(id);
      expect(detail.run?.status).toBe("completed");
      const saved = database.readInstance(id).document;
      expect(saved.state.truth.elapsedSeconds).toBe(5);
      expect(saved.state.step).toBe(1);
      expect(saved.state.history[0]!.observations.some(observation => observation.observerId === "player")).toBe(true);
      expect(readDecisionEventState(saved.state.executionState!, saved.state).pending).toEqual([]);
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
      const inspected = host.inspectorStep(id, 1);
      expect(inspected.committed.decisionEvent).toBeDefined();
      expect(inspected.programs!.programs[0]).toMatchObject({ ownerId: "keeper", status: "ended",
        completion: { executionEnded: true, goals: {} } });
      expect(inspected.programs!.decisions.length).toBeGreaterThan(0);
      expect(inspected.programs!.cost.unknownInvocations).toBeGreaterThan(0);
      const calls = fixture.configured.transport.mock.calls.length;
      database.close();
      database = new LocalDatabase(filename, { heartbeat: false });
      const reopened = makeHost();
      expect(reopened.instance(id).summary.revision).toBe(1);
      expect(replaySimulationState(database.readInstance(id).document.state)).toEqual(saved.state);
      expect(fixture.configured.transport).toHaveBeenCalledTimes(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
