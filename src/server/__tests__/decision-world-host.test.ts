import { z } from "zod";
import { coreResolutionRulePackage, RulePackageRegistry } from "../../engine/mechanics/rule-package";
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
  it("recovers an explicitly selected program reference without a retrieval asset", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-native-default-"));
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository: new MemoryWorldRepository({ [f.world.id]: f.world }),
      store: database, ledger: database, provider: f.configured.gateway, defaultAlgorithmRef: decisionEventAlgorithmRef() });
    try {
      const host = makeHost(), created = await host.createInstance({ worldId: f.world.id, start: { kind: "observer" } });
      const stored = database.readInstance(created.summary.id).document;
      expect(stored.executionAlgorithm).toEqual(decisionEventAlgorithmRef());
      expect(stored.state.bootstrapDecisionEvent!.control.models).toEqual(f.world.modelProfiles);
      expect(host.inspectorWindow(stored.id, { limit: 1 }).algorithmComposition.root).toEqual(decisionEventAlgorithmRef());
      const calls = f.configured.transport.mock.calls.length;
      expect(makeHost().instance(stored.id).summary).toEqual(created.summary);
      expect(f.configured.transport).toHaveBeenCalledTimes(calls);
      await host.advance(stored.id, { expectedRevision: 0, trigger: "batch", steps: 1 });
      for (let i = 0; i < 200 && host.instance(stored.id).run?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(host.instance(stored.id).run?.status).toBe("completed");
      const state = database.readInstance(stored.id).document.state;
      expect(state.truth.elapsedSeconds).toBe(5);
      expect(replaySimulationState(state)).toEqual(state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("uses the same injected trusted rules for native compilation, commits, recovery and offline replay", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-native-rules-")), filename = path.join(root, "livingworld.sqlite");
    const f = nativeProgramFixture();
    const rulePackages = new RulePackageRegistry([coreResolutionRulePackage, {
      id: "test-rules", version: "1.0.0", configSchema: z.strictObject({}), adjudication: "Record this test action.",
      rules: [{ id: "record", description: "Record that an admitted question was asked.", inputSchema: z.strictObject({}),
        resolve: (_context, _config, _input, invocation) => ({ code: "recorded", data: {}, operations: [{
          kind: "set_fact", fact: { id: "question-recorded", subjectId: "keeper", predicate: "asked",
            value: { kind: "boolean", value: true }, description: "The question occurred.", access: { kind: "private" },
            provenance: invocation.causes }, causes: invocation.causes, assertions: invocation.assertions,
        }] }) }],
    }]);
    f.world.rulePackages = rulePackages.validate([...f.world.rulePackages, { id: "test-rules", version: "1.0.0", config: {} }]);
    f.rule.sourceIds.push("mechanics"); f.rule.writes = ["facts"];
    f.rule.branches[0]!.mechanics = [{ id: "record", packageId: "test-rules", ruleId: "record", input: {} }];
    await f.configured.registry.capture();
    let database = new LocalDatabase(filename, { heartbeat: false, rulePackages });
    const repository = new MemoryWorldRepository({ [f.world.id]: f.world }, rulePackages);
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.configured.gateway,
      defaultAlgorithmRef: decisionEventAlgorithmRef(nativeProgramTestConfig) });
    try {
      const host = makeHost(), created = await host.createInstance({ worldId: f.world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.advance(id, { expectedRevision: 0, trigger: "batch", steps: 1 });
      for (let i = 0; i < 200 && host.instance(id).run?.status === "running"; i++) await new Promise(resolve => setTimeout(resolve, 5));
      expect(host.instance(id).run?.status, JSON.stringify(database.executions({ instanceId: id }).map(record => ({ id: record.id, status: record.status, error: record.errorArtifactHash ? database.artifact(record.errorArtifactHash)?.value : null })))).toBe("completed");
      const state = database.readInstance(id).document.state;
      expect(state.truth.facts["question-recorded"]!.value).toEqual({ kind: "boolean", value: true });
      expect(state.history[0]!.mechanicResults[0]).toMatchObject({ packageId: "test-rules", code: "recorded" });
      expect(replaySimulationState(state, state.revision, rulePackages)).toEqual(state);
      expect(() => replaySimulationState(state)).toThrow("test-rules@1.0.0");
      expect(host.inspectorStep(id, 1).committed.mechanicResults[0]!.code).toBe("recorded");
      const calls = f.configured.transport.mock.calls.length;
      const recordedInput = database.executionEvents(state.history[0]!.executionRef!.executionId).find(event => event.event === "step.started")!.payload as { state: typeof state };
      expect(recordedInput.state).toEqual(replaySimulationState(state, 0, rulePackages));
      for (const executionId of [state.bootstrapExecutionRef!.executionId, state.history[0]!.executionRef!.executionId]) {
        const replay = await replayThroughAlgorithm(database, database.execution(executionId)!, database.executionEvents(executionId));
        expect(replay.replayStatus).toBe("succeeded"); expect(replay.stateHash).toBe(database.execution(executionId)!.stateHash);
      }
      database.close(); database = new LocalDatabase(filename, { heartbeat: false, rulePackages });
      expect(makeHost().instance(id).summary.revision).toBe(1);
      expect(database.readInstance(id).document.state).toEqual(state);
      expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
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
