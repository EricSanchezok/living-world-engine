import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer } from "../../engine/testing/direct-provider";
import { DEFAULT_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { replayThroughAlgorithm } from "../../../scripts/operations/execution-command";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { DirectWorldAlgorithm } from "../../engine/direct/algorithm";
import { SimulationEngine } from "../../engine/runtime/simulation";
import { readDirectState } from "../../engine/direct/state";

describe("direct world through persistent WorldHost", () => {
  it("continues one compound player intent and returns a delivered NPC refusal to the player", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-dialogue-")); let playerDecisions = 0;
    const f = directTestProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string }; actions?: Array<{ kind: string }> };
      if (context.perspective?.agentId === "player") playerDecisions++;
      const player = context.perspective?.agentId === "player";
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let choice = id.includes("outcome") ? "succeeded" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged"
          : id.includes("delivery") ? "delivered" : id.includes("visible") || id.includes("entity") ? "visible" : id.includes("fact") ? "unchanged" : "none";
        if (id === "operation") choice = player && playerDecisions === 1 ? "observe" : "speak";
        if (id === "target") choice = !player ? "traveler" : playerDecisions === 1 ? "self" : q.type === "choice"
          ? Object.entries(q.criteria).find(([, value]) => (value as { name?: string })?.name === "附近的人")?.[0] ?? "none" : "none";
        if (id === "speech") choice = "compose";
        if (id === "dialogue") choice = player ? "ask_price" : "refuse";
        if (id === "tool") choice = "copper-key";
        if (id === "timing") choice = "default";
        if (id.includes("request_progress")) choice = context.actions?.[0]?.kind === "observe" ? "continue" : "wait";
        return [id, nativeAnswer(q, choice)];
      }));
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "find-and-ask", text: "先观察附近的人，再向在场的人询问铜钥匙的价格。" });
      for (let i = 0; i < 300 && database.readInstance(id).document.state.revision < 3; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const document = database.readInstance(id).document, state = document.state;
      expect(state.history.map(step => step.actions[0]?.actorId)).toEqual(["player", "player", "keeper"]);
      expect(state.history[0]!.directEvent!.control.completedSubmissionIds).not.toContain("find-and-ask");
      expect(state.history.at(-1)!.observations.find(packet => packet.observerId === "player")?.summary).toContain("不接受");
      expect(Object.values(document.runs).find(run => run.rootIntents.some(intent => intent.submissionId === "find-and-ask"))?.status).toBe("completed");
      expect(document.actionWindow?.requiredAgentIds).toContain("player");
      expect(state.truth.quantities).toEqual(world.initialState.truth.quantities);
      expect(f.transport).toHaveBeenCalledTimes(6); expect(replaySimulationState(state)).toEqual(state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("admits the full Blackmarsh 49 subjects without calls and runs their private queued decisions", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-full49-"));
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id,
      nativeAnswer(q, id === "operation" ? "wait" : id.includes("goal_status") || id.includes("belief_status") ? "unchanged" : "none")])));
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed: 17, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const repository = new MemoryWorldRepository({ [world.id]: world });
      const host = new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
      const created = await host.createInstance({ worldId: world.id, start: { kind: "origin", originId: world.participation!.origins[0]!.id,
        displayName: "测试旅人", appearance: "旅人装束。", motivation: "观察周围环境。" } });
      const document = database.readInstance(created.summary.id).document;
      expect(Object.keys(document.state.agents)).toHaveLength(49); expect(f.transport).not.toHaveBeenCalled();
      const pinned = repository.loadVersion(document.world.id, document.world.contentHash, document.state.historyBase!.truth.rng.seed, f.catalog);
      const engine = new SimulationEngine(pinned, new DirectWorldAlgorithm(f.gateway), document.state);
      const result = await engine.step(document.policyBindings, { expectedRevision: document.state.revision, trigger: "manual", externalActions: [] });
      const control = readDirectState(result.state.executionState!, result.state);
      expect(Object.values(control.intents).filter(intent => intent.status === "failed")).toEqual([]);
      expect(f.transport).toHaveBeenCalledTimes(48);
      expect(result.modelAudits.every(audit => audit.protocol === "typesafe-systemone")).toBe(true);
      expect(replaySimulationState(result.state)).toEqual(result.state);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
  it("creates and enters the ordinary default without generation, then commits natural language and recovers it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-default-"));
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const values: Record<string, string> = { operation: "observe", target: "self", tool: "none", amount: "unknown", resource: "none", speech: "none", timing: "default", goal: "none" };
      const choice = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("belief_status") ? "unchanged" : "unknown");
      return [id, nativeAnswer(q, choice)];
    })));
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
    try {
      let host = makeHost();
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
      const id = created.summary.id;
      expect(database.readInstance(id).document).toMatchObject({ schemaVersion: 25, executionAlgorithm: DEFAULT_ALGORITHM_REF,
        state: { schemaVersion: 18, executionState: { data: { kind: "direct-world" } } } });
      expect(f.transport).not.toHaveBeenCalled();
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      expect(f.transport).not.toHaveBeenCalled();
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "observe-self", text: "检查自己的情况" });
      for (let i = 0; i < 100 && database.readInstance(id).document.state.revision === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
      const saved = database.readInstance(id).document.state;
      expect(saved.revision).toBe(1); expect(saved.truth.elapsedSeconds).toBe(1);
      expect(saved.history[0]!.actions[0]!.rawText).toBe("检查自己的情况");
      expect(host.inspectorStep(id, 1).directRuntime!.actions[0]!.kind).toBe("observe");
      expect(replaySimulationState(saved)).toEqual(saved);
      expect(f.transport).toHaveBeenCalledTimes(2);
      const executionId = saved.history[0]!.executionRef!.executionId;
      const replay = await replayThroughAlgorithm(database, database.execution(executionId)!, database.executionEvents(executionId));
      const candidate = (execution: string) => database.executionEvents(execution).find(event => event.event === "execution.candidate.persisted")?.payload;
      expect(candidate(replay.replayExecutionId)).toEqual(candidate(executionId));
      expect(replay.replayStatus).toBe("succeeded"); expect(replay.stateHash).toBe(database.execution(executionId)!.stateHash);
      expect(f.transport).toHaveBeenCalledTimes(2);
      database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      expect(host.instance(id).summary.revision).toBe(saved.revision);
      expect(database.readInstance(id).document.state).toEqual(saved);
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "observe-self", text: "检查自己的情况" });
      expect(database.readInstance(id).document.state).toEqual(saved); expect(f.transport).toHaveBeenCalledTimes(2);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
