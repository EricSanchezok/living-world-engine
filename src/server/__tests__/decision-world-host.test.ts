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
import { replayThroughAlgorithm } from "../../../scripts/operations/execution-command";

describe("decision programs through the persistent WorldHost", () => {
  it("persists a queued parallel instruction and starts it after restart without consuming time while queued", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-native-queue-")), filename = path.join(root, "livingworld.sqlite");
    const fixture = nativeProgramFixture(), attempt = fixture.program.nodes[0]!;
    fixture.program.entry = "parallel";
    fixture.program.nodes = [{ id: "parallel", kind: "parallel", children: ["ask-a", "ask-b"] },
      { ...attempt, id: "ask-a" }, { ...attempt, id: "ask-b" }];
    await fixture.configured.registry.capture();
    let database = new LocalDatabase(filename, { heartbeat: false });
    const repository = new MemoryWorldRepository({ [fixture.world.id]: fixture.world });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: fixture.configured.gateway,
      defaultAlgorithmRef: decisionEventAlgorithmRef(nativeProgramTestConfig) });
    try {
      let host = makeHost();
      const created = await host.createInstance({ worldId: fixture.world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.advance(id, { expectedRevision: 0, trigger: "batch", steps: 1 });
      for (let i = 0; i < 200 && host.instance(id).run?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(host.instance(id).run?.status).toBe("completed");
      const first = database.readInstance(id).document.state;
      const control = readDecisionEventState(first.executionState!, first);
      expect(first.truth.elapsedSeconds).toBe(5);
      expect(control.activities.map(activity => activity.status).sort()).toEqual(["completed", "queued"]);
      expect(control.pending[0]!.atSeconds).toBeNull();
      expect(replaySimulationState(first)).toEqual(first);
      database.close(); database = new LocalDatabase(filename, { heartbeat: false }); host = makeHost();
      await host.advance(id, { expectedRevision: first.revision, trigger: "batch", steps: 1 });
      for (let i = 0; i < 200 && host.instance(id).run?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(host.instance(id).run?.status).toBe("completed");
      const final = database.readInstance(id).document.state;
      const completed = readDecisionEventState(final.executionState!, final);
      expect(final.truth.elapsedSeconds).toBe(10);
      expect(completed.activities.map(activity => activity.status)).toEqual(["completed", "completed"]);
      expect(completed.activities.map(activity => activity.startedAtSeconds).sort()).toEqual([0, 5]);
      expect(completed.pending).toEqual([]);
      expect(final.history[1]!.decisionEvent!.modelAudits.filter(audit => audit.role === "creation")).toEqual([]);
      expect(host.inspectorStep(id, 2).programs!.activities).toEqual(completed.activities);
      expect(replaySimulationState(final)).toEqual(final);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
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
  it.each([false, true])("persists the native producer and replays without model calls after out-of-order responses (two actors: %s)", async bothActors => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-native-host-"));
    const filename = path.join(root, "livingworld.sqlite");
    const fixture = nativeProgramFixture({ bothActors });
    const transport = fixture.configured.transport.getMockImplementation()!; let requestOrdinal = 0;
    fixture.configured.transport.mockImplementation(async (...args) => {
      const ordinal = ++requestOrdinal, result = await transport(...args);
      if (ordinal % 2) await new Promise(resolve => setTimeout(resolve, 20));
      return result;
    });
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
      for (const executionId of [saved.state.bootstrapExecutionRef!.executionId, saved.state.history[0]!.executionRef!.executionId]) {
        const original = database.execution(executionId)!;
        const replayed = await replayThroughAlgorithm(database, original, database.executionEvents(executionId));
        expect(replayed.replayStatus).toBe("succeeded");
        const candidate = (id: string) => database.executionEvents(id).find(event => event.event === "execution.candidate.persisted")?.payload;
        expect(candidate(replayed.replayExecutionId)).toEqual(candidate(executionId));
        expect(replayed.stateHash).toBe(original.stateHash);
      }
      expect(fixture.configured.transport).toHaveBeenCalledTimes(calls);
      database.close();
      database = new LocalDatabase(filename, { heartbeat: false });
      const reopened = makeHost();
      expect(reopened.instance(id).summary.revision).toBe(1);
      expect(replaySimulationState(database.readInstance(id).document.state)).toEqual(saved.state);
      expect(fixture.configured.transport).toHaveBeenCalledTimes(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
