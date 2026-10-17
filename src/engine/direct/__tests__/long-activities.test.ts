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
import { readDirectState } from "../state";
import { durationSpans, literalDurations } from "../actions";
import { resolveDurationUnits, validateDurationUnits } from "../../mechanics/duration-units";

async function fixture(mode: "addressed" | "unrelated" | "unheard" | "quiet", interruptible = true) {
  const f = directTestProvider(wire => {
    if (!wire.questions) return { attempt: "按要求维修冷却泵", utterance: null, manner: null };
    const context = wire.state as { perspective?: { agentId: string }; actions?: Array<{ actorId: string }> };
    const engineer = context.perspective?.agentId === "engineer";
    const values: Record<string, string> = { operation: engineer ? "use" : "speak", target: "pump", recipient: "repair", tool: "none",
      resource: "none", amount: "unknown", timing: interruptible ? "default" : "explicit-duration", duration: "d0", interruption: engineer ? "request" : "none",
      goal: "none", speech: "q0", progress_next: "complete", interaction: "world_action" };
    return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
      const info = (q.instructions as { task?: { data?: { fact?: { id: string }; resource?: string; actionId?: string } } }).task?.data;
      let value = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("belief_status") ? "unchanged"
        : id.includes("goal_status") ? "partial" : id.includes("delivery") ? mode === "unheard" ? "unavailable" : "delivered"
        : id.includes("visible") ? "hidden" : id.includes("fact") ? "unchanged" : id.includes("duration") ? "planned" : "none");
      if (id.includes("_interrupt")) value = mode === "unrelated" ? "continue" : "stop";
      if (id.includes("_resource")) value = info?.resource === "密封组件" ? "n1" : "none";
      if (id.endsWith("_applies")) value = info?.resource === "密封组件" ? "apply" : "none";
      if (id.endsWith("_expression")) value = "existing";
      if (id.includes("_fact") && info?.fact?.id === "pump-seal" && q.type === "choice") value = Object.entries(q.criteria)
        .find(([, candidate]) => candidate !== null && typeof candidate === "object" && !Array.isArray(candidate) && candidate.value === "sealed")?.[0] ?? "unchanged";
      return [id, nativeAnswer(q, id === "expression" ? 0 : value)];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 17, modelCatalog: f.catalog });
  world.initialState.truth.timers = {};
  world.initialState.truth.mechanics.temporalProfiles["explicit-duration"]!.interruptible = interruptible;
  const kit = quantityId(world.initialState.worldHash, "seal-kit", "engineer");
  world.initialState.truth.quantities[kit] = { id: kit, definitionId: "seal-kit", holderId: "engineer", amount: 1 };
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.keys(world.initialState.agents).map(agentId =>
    [agentId, { kind: "external", agentId, participantId: "operator" }]));
  await engine.bootstrapAgents();
  const actions = [{ agentId: "engineer", submissionId: "long-repair", rawText: "维修冷却泵八小时；如果检查员当面叫我就停下。", goal: "完成维修", means: null, targetIds: [] },
    ...(mode === "quiet" ? [] : [{ agentId: "inspector", submissionId: "call", rawText: "用60秒对工程师说：“请停下手头的工作。”", goal: "叫停维修", means: null, targetIds: [] }])];
  return { ...f, engine, world, algorithm, roster, kit, actions };
}

describe("long activity boundaries", () => {
  it("stops an eight-hour activity at an actual addressed call and cancels its unperformed material debit", async () => {
    const f = await fixture("addressed");
    const first = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(first.state.truth.elapsedSeconds).toBe(60);
    const control = readDirectState(first.state.executionState!, first.state);
    expect(control.activities).toHaveLength(0);
    expect(control.intents.engineer!.wait?.reason).toBe("conditional-interruption");
    const stopped = first.committed.outcomes.find(outcome => first.committed.directEvent.frames.find(frame => frame.id === outcome.proposalId)?.actorId === "engineer")!;
    expect(stopped.status).toBe("partial"); expect(stopped.summary).toContain("60秒");
    expect(first.state.truth.quantities[f.kit]!.amount).toBe(1);
    expect(first.state.truth.facts["pump-seal"]!.value).toEqual(f.world.initialState.truth.facts["pump-seal"]!.value);
    expect(first.committed.directEvent.frames.find(frame => frame.actorId === "engineer")?.utterance).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(3);
    expect(replaySimulationState(first.state)).toEqual(first.state);
  });
  it.each(["unrelated", "unheard"] as const)("retains the full duration when an interruption is %s", async mode => {
    const f = await fixture(mode);
    const first = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    const control = readDirectState(first.state.executionState!, first.state);
    expect(first.state.truth.elapsedSeconds).toBe(60); expect(control.activities).toHaveLength(1);
    expect(control.activities[0]!.dueAtSeconds).toBe(28800);
    expect(first.state.truth.quantities[f.kit]!.amount).toBe(1);
    const restarted = new SimulationEngine(f.world, f.algorithm, JSON.parse(JSON.stringify(first.state)));
    const next = await restarted.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(next.state.truth.elapsedSeconds).toBe(28800);
    expect(next.state.truth.quantities[f.kit]!.amount).toBe(0);
    expect(replaySimulationState(next.state)).toEqual(next.state);
  });
  it("matches a retained pending call against an activity admitted after that call was prepared", async () => {
    const f = await fixture("addressed");
    const first = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [f.actions[1]!], autonomousUntilSeconds: 0 });
    expect(first.state.truth.elapsedSeconds).toBe(0);
    const control = readDirectState(first.state.executionState!, first.state);
    expect(control.activities).toHaveLength(1);
    expect(control.prepared[control.activities[0]!.id]!.interruptionCandidateIds).toEqual([]);
    const next = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "participant_action", externalActions: [f.actions[0]!] });
    expect(next.state.truth.elapsedSeconds).toBe(60);
    expect(readDirectState(next.state.executionState!, next.state).intents.engineer!.wait?.reason).toBe("conditional-interruption");
    expect(next.state.truth.quantities[f.kit]!.amount).toBe(1);
    expect(replaySimulationState(next.state)).toEqual(next.state);
  });
  it("executes an uneventful eight-hour interval without checkpoint polling", async () => {
    const f = await fixture("quiet");
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(28800);
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("clarifies an undefined month without starting a short substitute activity", async () => {
    const f = await fixture("quiet");
    f.actions[0]!.rawText = "维修冷却泵一个月";
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(0);
    expect(result.committed.directEvent.frames).toHaveLength(0);
    expect(result.committed.directEvent.presentation?.[0]).toMatchObject({ kind: "clarification", reason: expect.stringContaining("undefined") });
    expect(result.state.truth.quantities[f.kit]!.amount).toBe(1);
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("does not silently discard a stopping condition for a noninterruptible activity", async () => {
    const f = await fixture("quiet", false);
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(0);
    expect(result.committed.directEvent.frames).toHaveLength(0);
    expect(result.committed.directEvent.presentation?.[0]).toMatchObject({ kind: "clarification", reason: expect.stringContaining("cannot be interrupted") });
    expect(result.state.truth.quantities[f.kit]!.amount).toBe(1);
  });
  it("does not interrupt a completed activity when the matching call arrives later", async () => {
    const f = await fixture("addressed");
    f.actions[0]!.rawText = "维修冷却泵20秒；如果检查员当面叫我就停下。";
    const first = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(first.state.truth.elapsedSeconds).toBe(20); expect(first.state.truth.quantities[f.kit]!.amount).toBe(0);
    const next = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(next.state.truth.elapsedSeconds).toBe(60); expect(next.state.truth.quantities[f.kit]!.amount).toBe(0);
    expect(next.committed.directEvent.frames.every(frame => !frame.interruptedByEventIds)).toBe(true);
    expect(replaySimulationState(next.state)).toEqual(next.state);
  });
  it("resolves local days and global age units while preserving undefined calendar spans", () => {
    const units = { day: { id: "day", terms: ["天"], seconds: 86400, locationIds: [] },
      local: { id: "local", terms: ["天"], seconds: 345600, locationIds: ["realm"] },
      month: { id: "month", terms: ["月"], seconds: 2592000, locationIds: [] } };
    validateDurationUnits(units, new Set(["realm"]));
    const resolved = resolveDurationUnits(units, { player: "room", room: "city", city: "realm", realm: null }, "player");
    expect(literalDurations("静坐两天又三小时", resolved)).toEqual([{ text: "两天又三小时", seconds: 702000 }]);
    expect(literalDurations("修炼一个月", resolved)).toEqual([{ text: "一个月", seconds: 2592000 }]);
    expect(durationSpans("修炼一年", resolved)).toEqual([{ text: "一年", seconds: null }]);
    expect(durationSpans("buy 1 daylight lamp")).toEqual([]);
    expect(durationSpans("9007199254740991秒又1秒")).toEqual([{ text: "9007199254740991秒又1秒", seconds: null }]);
    expect(() => validateDurationUnits({ ...units, conflict: { id: "conflict", terms: ["天"], seconds: 2, locationIds: ["realm"] } })).toThrow("conflicting");
    expect(() => validateDurationUnits(units, new Set())).toThrow("unknown location");
    expect(() => validateDurationUnits({ ...units, invalid: { ...units.month, id: "invalid", surprise: true } } as typeof units)).toThrow("unexpected");
    expect(() => validateDurationUnits({ " invalid identity": { ...units.month, id: " invalid identity" } })).toThrow();
  });
});
