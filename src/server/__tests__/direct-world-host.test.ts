import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeChoice } from "../../engine/testing/direct-provider";
import { DEFAULT_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { replayThroughAlgorithm } from "../../../scripts/operations/execution-command";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

describe("direct world through persistent WorldHost", () => {
  it("creates and enters the ordinary default without generation, then commits natural language and recovers it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-direct-default-"));
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const values: Record<string, string> = { operation: "observe", target: "self", tool: "none", amount: "unknown", resource: "none", speech: "none", timing: "default", goal: "none" };
      const choice = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("belief_status") ? "unchanged" : "unknown");
      return [id, nativeChoice(q, choice)];
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
