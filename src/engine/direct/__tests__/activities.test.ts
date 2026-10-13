import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { quantityId } from "../../runtime/runtime-id";
import type { PolicyBinding } from "../../runtime/execution";
import type { DecisionQuestionV2 } from "../../models/decision-v2";
import { readDirectState } from "../state";
import { privateActionView } from "../views";
import { settlePreparedActions } from "../settlement";

function option(question: DecisionQuestionV2, predicate: (value: unknown) => boolean) {
  return question.type === "choice" ? Object.entries(question.criteria).find(([, value]) => predicate(value))?.[0] ?? "unchanged" : "none";
}
async function fixture(mode: "repair" | "test" | "extend" | "extend-world" | "ongoing" | "wait" = "repair", deadline = 120) {
  let extensionUsed = false;
  const f = directTestProvider(wire => {
    if (!wire.questions) return { description: "临时隔振", applicability: "用现有缓冲材料隔离设备振动", effectDescription: "设备获得可观察的临时隔振状态",
      effects: [{ kind: "fact", subject: "target", predicate: "vibration-isolation", value: "temporary", description: "缓冲材料使振动暂时隔离。" }] };
    const context = wire.state as { perspective?: { agentId: string }; actions?: Array<{ proposal: { rawText: string } }> };
    const values: Record<string, string> = { operation: mode === "wait" ? "wait" : mode === "extend" && !extensionUsed ? "expand" : "use",
      target: "pump", tool: "none", amount: "n0", resource: "none", speech: "none", timing: mode === "ongoing" ? "ongoing-action" : "default", goal: "none" };
    if (context.perspective && mode === "extend") extensionUsed = true;
    return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const info = (q.instructions as { task?: { data?: { fact?: { id: string }; resource?: string } } }).task?.data;
      let answer = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("goal_status") ? "partial" : id.includes("belief_status") ? "unchanged"
        : id.includes("delivery") ? "delivered" : id.includes("visible") ? (info?.fact?.id === "pump-code" ? "hidden" : "visible")
        : id.includes("duration") ? "planned" : id.includes("pool") ? "claim" : id.includes("fact") ? "unchanged" : "none");
      if (id.includes("duration") && mode === "repair") answer = "s30";
      if (id.includes("duration") && mode === "test") answer = "s10";
      if (id.includes("resource") && mode === "repair") answer = info?.resource === "密封组件" ? "n1" : info?.resource === "冷却剂" ? "n2" : "none";
      if (id.endsWith("_applies")) answer = mode === "repair" ? "apply" : "none";
      if (id.includes("fact") && mode === "repair" && info?.fact?.id === "pump-seal") answer = option(q, value => (value as { value?: string })?.value === "sealed");
      if (id.includes("_random")) answer = mode !== "test" ? "none" : id.includes("_target")
        ? option(q, value => (value as { property?: string })?.property === "pressure") : "apply";
      if (id.includes("capability")) answer = context.perspective ? option(q, value => typeof value === "object") : "apply";
      if (id.endsWith("_expression")) answer = mode === "extend-world" ? "expand" : "existing";
      return [id, nativeAnswer(q, answer)];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 17, modelCatalog: f.catalog });
  world.initialState.truth.timers["repair-window-end"]!.dueAtSeconds = deadline;
  const kit = quantityId(world.initialState.worldHash, "seal-kit", "engineer");
  world.initialState.truth.quantities[kit] = { id: kit, definitionId: "seal-kit", holderId: "engineer", amount: 1 };
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: mode === "extend" || mode === "extend-world" });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.keys(world.initialState.agents).map(id => [id,
    { kind: "external", agentId: id, participantId: "human" }]));
  await engine.bootstrapAgents();
  const act = async (text: string, owner = "engineer") => {
    const result = await engine.step(roster, { expectedRevision: engine.snapshot.revision, trigger: "participant_action",
      externalActions: [{ agentId: owner, submissionId: `submission-${engine.snapshot.revision}`, rawText: text, goal: text, means: null, targetIds: [] }] });
    const failure = readDirectState(result.state.executionState!, result.state).intents[owner]!.failure;
    if (failure) throw new Error(failure.message);
    return result;
  };
  const advance = () => engine.step(roster, { expectedRevision: engine.snapshot.revision, trigger: "manual", externalActions: [] });
  return { ...f, engine, world, algorithm, roster, act, advance, kit };
}

describe("direct activities use code-owned mechanics", () => {
  it("repairs with exact consumables, partial goal evidence and rule duration with creation disabled", async () => {
    const f = await fixture(); const result = await f.act("使用密封组件和冷却剂维修冷却泵");
    expect(result.state.truth.elapsedSeconds).toBe(30);
    expect(result.state.truth.facts["pump-seal"]!.value).toEqual({ kind: "text", value: "sealed" });
    expect(result.state.truth.facts["pump-seal"]!.description).not.toContain("泄漏");
    expect(result.committed.observations.find(packet => packet.observerId === "engineer")?.summary).toContain("已封闭");
    expect(result.state.truth.facts["pump-pressure"]!.value).toEqual({ kind: "text", value: "untested" });
    expect(result.state.truth.quantities[f.kit]!.amount).toBe(0);
    expect(result.state.truth.quantities[quantityId(result.state.worldHash, "coolant", "engineer")]!.amount).toBe(0);
    expect(result.state.agents.engineer!.character.goals["repair-and-test"]!.status).toBe("active");
    expect(readDirectState(result.state.executionState!, result.state).intents.engineer!.goalProgress["repair-and-test"]).toBe("partial");
    expect(JSON.stringify(result.state.agents.engineer!.belief)).not.toContain("ORBIT-7");
    expect(JSON.stringify(privateActionView(result.state, "inspector").state)).toContain("ORBIT-7");
    expect(result.state.agents.inspector!.observationCursorStep).toBeGreaterThan(0);
    expect(f.transport).toHaveBeenCalledTimes(2); expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("persists random stakes before drawing, survives restart and never repeats the test draw", async () => {
    const f = await fixture("test"); const admitted = await f.act("运行压力测试10秒");
    expect(admitted.state.truth.elapsedSeconds).toBe(0); expect(admitted.state.truth.rng.draws).toBe(0);
    expect(Object.values(readDirectState(admitted.state.executionState!, admitted.state).prepared)[0]!.randomRequests).toHaveLength(1);
    const restarted = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(admitted.state)));
    const settled = await restarted.step(f.roster, { expectedRevision: 1, trigger: "manual", externalActions: [] });
    expect(settled.state.truth.elapsedSeconds).toBe(10); expect(settled.state.truth.rng.draws).toBeGreaterThan(0);
    expect(settled.committed.randomResults).toHaveLength(1);
    expect(["stable", "unstable"]).toContain((settled.state.truth.facts["pump-pressure"]!.value as { value: string }).value);
    expect(settled.state.truth.facts["pump-pressure"]!.description).not.toContain("尚未");
    expect(f.transport).toHaveBeenCalledTimes(2); expect(replaySimulationState(settled.state)).toEqual(settled.state);
  });
  it("records NPC waits before an unrelated future deadline advances physical time", async () => {
    const f = await fixture("wait");
    for (const id of Object.keys(f.roster)) f.roster[id] = { kind: "model", agentId: id, profiles: f.world.initialState.agents[id]!.modelProfiles };
    const first = await f.advance();
    expect(first.state.truth.elapsedSeconds).toBe(0);
    expect(first.state.truth.timers["repair-window-end"]!.status).toBe("scheduled");
    const next = await f.advance();
    expect(next.state.truth.elapsedSeconds).toBe(120);
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(replaySimulationState(next.state)).toEqual(next.state);
  });
  it("keeps shared random provenance immutable when one draw has several recorded bindings", async () => {
    const f = await fixture("test"); const admitted = await f.act("运行压力测试10秒");
    const control = readDirectState(admitted.state.executionState!, admitted.state), frame = control.activities[0]!;
    const prepared = control.prepared[frame.id]!, first = prepared.operations.find(op => op.kind === "set_fact")!;
    if (first.kind !== "set_fact") throw new Error("missing fixture effect");
    prepared.operations.push({ ...first, fact: { ...first.fact, id: "pump-seal", predicate: "seal" } });
    prepared.randomBindings.push({ ...prepared.randomBindings[0]!, factId: "pump-seal" });
    const saved = structuredClone(control);
    const result = settlePreparedActions(admitted.state, control, [frame]);
    expect(result.settlements[0]!.outcome.status).toBe("succeeded");
    expect(result.rng.draws).toBe(1); expect(control).toEqual(saved);
    expect(result.settlements[0]!.operations.filter(op => op.kind === "set_fact").every(op => op.causes.filter(cause => cause.kind === "random").length === 1)).toBe(true);
  });
  it("creates one small capability and lets an observing appropriate actor reuse it", async () => {
    const f = await fixture("extend"); const first = await f.act("用缓冲材料临时隔离设备振动");
    const control = readDirectState(first.state.executionState!, first.state);
    expect(control.capabilities).toHaveLength(1); expect(control.capabilities[0]!.knownToAgentIds).toContain("inspector");
    expect(Object.values(first.state.truth.facts)).toContainEqual(expect.objectContaining({ predicate: "vibration-isolation", value: { kind: "text", value: "temporary" } }));
    expect(first.committed.observations.find(packet => packet.observerId === "engineer")?.summary).toContain("振动暂时隔离");
    expect(first.committed.observations.find(packet => packet.observerId === "inspector")?.summary).toContain("振动暂时隔离");
    const second = await f.act("使用刚才观察到的临时隔振方法", "inspector");
    expect(readDirectState(second.state.executionState!, second.state).capabilities).toHaveLength(1);
    expect(f.transport.mock.calls.filter(([, init]) => !JSON.parse(String(init?.body)).questions)).toHaveLength(1);
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("retains continuous work across a deadline without another model request and allows interruption", async () => {
    const f = await fixture("ongoing"); const first = await f.act("持续监控冷却泵");
    const active = readDirectState(first.state.executionState!, first.state).activities[0]!;
    expect(active.dueAtSeconds).toBeNull(); expect(active.progressSeconds).toBe(60);
    const next = await f.advance(); expect(next.state.truth.elapsedSeconds).toBe(120);
    expect(next.state.truth.timers["repair-window-end"]!.status).toBe("fired");
    expect(f.transport).toHaveBeenCalledTimes(2);
    await f.act("停止监控，改为再次查看冷却泵");
    expect(readDirectState(f.engine.snapshot.executionState!, f.engine.snapshot).activities).toHaveLength(1);
    expect(replaySimulationState(f.engine.snapshot)).toEqual(f.engine.snapshot);
  });
  it("extends a missing world effect after ordinary action selection and reuses it without regeneration", async () => {
    const f = await fixture("extend-world"); const first = await f.act("用缓冲材料临时隔离设备振动");
    expect(readDirectState(first.state.executionState!, first.state).capabilities).toHaveLength(1);
    expect(first.committed.observations.find(packet => packet.observerId === "inspector")?.summary).toContain("振动暂时隔离");
    expect(f.transport).toHaveBeenCalledTimes(4);
    const second = await f.act("复用工程师实际演示的隔振方法", "inspector");
    expect(f.transport).toHaveBeenCalledTimes(6);
    expect(f.transport.mock.calls.filter(([, init]) => !JSON.parse(String(init?.body)).questions)).toHaveLength(1);
    expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("queues shared console contention and grants capacity only after the earlier action settles", async () => {
    const f = await fixture("ongoing");
    const first = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: ["engineer", "inspector"].map(agentId =>
      ({ agentId, submissionId: `shared-${agentId}`, rawText: "操作冷却泵面板10秒", goal: "完成本次操作", means: null, targetIds: [] })) });
    expect(first.state.truth.elapsedSeconds).toBe(10); expect(first.committed.outcomes).toHaveLength(1);
    const pending = readDirectState(first.state.executionState!, first.state).activities;
    expect(pending).toHaveLength(1); expect(pending[0]!.activityStatus).toBe("queued");
    const calls = f.transport.mock.calls.length;
    const second = await f.advance(); expect(second.state.truth.elapsedSeconds).toBe(20); expect(second.committed.outcomes).toHaveLength(1);
    // The first action delivered new evidence to the queued actor. Its affected adjudication is refreshed once.
    expect(f.transport).toHaveBeenCalledTimes(calls + 1); expect(replaySimulationState(second.state)).toEqual(second.state);
  });
  it("stops at an earlier timer, then executes saved effects without model polling", async () => {
    const f = await fixture("repair", 5); const first = await f.act("维修冷却泵");
    expect(first.state.truth.elapsedSeconds).toBe(5); expect(first.committed.outcomes).toHaveLength(0);
    expect(first.state.truth.quantities[f.kit]!.amount).toBe(1);
    const next = await f.advance(); expect(next.state.truth.elapsedSeconds).toBe(30);
    expect(next.state.truth.quantities[f.kit]!.amount).toBe(0);
    expect(f.transport).toHaveBeenCalledTimes(2); expect(replaySimulationState(next.state)).toEqual(next.state);
  });
});
