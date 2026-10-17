import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState } from "../../runtime/transaction";
import { refreshPeriodicFacts } from "../../mechanics/periodic-properties";
import { periodicDeadlineCandidates, periodicDeadlineSeconds } from "../periodic-deadlines";
import { readDirectState } from "../state";
import type { PolicyBinding } from "../../runtime/execution";

async function fixture(options: { period?: number; initial?: number; occurrence?: number; reference?: { basis: string; count: number }; targetPhase?: "bright" | "dark"; restricted?: boolean; call?: boolean; prelude?: boolean; ordinaryLook?: boolean } = {}) {
  const f = directTestProvider(wire => {
    const context = wire.state as { perspective?: { agentId: string }; currentRequestReceipts?: unknown[] };
    const player = context.perspective?.agentId === "player";
    const prelude = player && options.prelude && !context.currentRequestReceipts?.length;
    const values: Record<string, string> = { operation: player ? prelude || options.ordinaryLook ? "observe" : "wait" : "speak",
      target: "none", observation_scope: "surroundings", recipient: "traveler", tool: "none", resource: "none", amount: "unknown",
      timing: "default", duration: "default", interruption: player && options.call ? "request" : "none", goal: "none", speech: "q0",
      progress_next: prelude ? "continue" : "complete", interaction: "world_action" };
    const result = Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      let value = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("visible") ? "visible"
        : id.includes("delivery") ? "delivered" : id.includes("belief_status") ? "unchanged" : id.includes("goal_status") ? "partial"
          : id.includes("fact") ? "unchanged" : id.includes("duration") ? "s1" : id.includes("_interrupt") ? "stop" : "none");
      if (id === "duration" && question.type === "choice") value = !player ? "d0" : prelude || options.ordinaryLook ? "default"
        : Object.entries(question.criteria).find(([, candidate]) => candidate && typeof candidate === "object" && !Array.isArray(candidate) &&
          candidate.transition && typeof candidate.transition === "object" && "to" in candidate.transition &&
          candidate.transition.to === `The ${options.targetPhase ?? "bright"} phase is active.`)?.[0] ?? "unresolved";
      return [id, nativeAnswer(question, id === "expression" ? 0 : value)];
    }));
    const phase = result.duration as { choice?: string } | undefined;
    return { ...result, ...(phase?.choice?.startsWith("phase") ? { durationReference: options.reference ?? { basis: "phase_occurrence", count: options.occurrence ?? 1 } } : {}) };
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 19, modelCatalog: f.catalog });
  world.initialState.truth.timers = {};
  world.initialState.truth.mechanics.periodicProperties = { light: { id: "light", subjectId: "courtyard", predicate: "cycle-light",
    access: { kind: options.restricted ? "private" : "public" }, periodSeconds: options.period ?? 86400,
    initialPhaseSeconds: options.initial ?? 54000,
    phases: [{ startsAtSeconds: 0, value: { kind: "text", value: "bright" }, description: "The bright phase is active." },
      { startsAtSeconds: (options.period ?? 86400) / 2, value: { kind: "text", value: "dark" }, description: "The dark phase is active." }] } };
  refreshPeriodicFacts(world.initialState.truth);
  if (options.restricted) {
    const agent = world.initialState.agents.player!;
    agent.belief.localEntities["observed-place"] = { id: "observed-place", name: "Courtyard", description: "The observed surroundings.", status: "observed" };
    agent.bindings["observed-place"] = { localEntityId: "observed-place", canonicalEntityIds: ["courtyard"] };
    agent.belief.evidence["present-dark"] = { id: "present-dark", kind: "observation", description: "The current dark state was observed.", sourceId: null, step: 0 };
    agent.belief.claims["current-dark"] = { id: "current-dark", subjectId: "observed-place", predicate: "cycle-light", value: { kind: "text", value: "dark" },
      confidence: 1, stance: "believed", description: "The dark phase was observed.", evidenceIds: ["present-dark"] };
  }
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.keys(world.initialState.agents).map(agentId =>
    [agentId, { kind: "external", agentId, participantId: "operator" }]));
  await engine.bootstrapAgents();
  const actions = [{ agentId: "player", submissionId: "phase-rest", rawText: options.ordinaryLook ? "观察四周"
    : `Rest until occurrence ${options.occurrence ?? 1} of the next ${options.targetPhase ?? "bright"} phase; stop if directly called.`, goal: "Rest", means: null, targetIds: [] },
    ...(options.call ? [{ agentId: "keeper", submissionId: "call", rawText: 'Spend 60 seconds saying "Please stop."', goal: "Call", means: null, targetIds: [] }] : [])];
  return { ...f, world, engine, algorithm, roster, actions };
}

describe("periodic activity endpoints", () => {
  it.each([{ period: 86400, initial: 54000, expected: 32400 }, { period: 345600, initial: 194400, expected: 151200 }])(
    "waits to the authored phase in a $period-second local cycle", async options => {
      const f = await fixture(options);
      const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
      expect(result.state.truth.elapsedSeconds).toBe(options.expected);
      expect(result.committed.directEvent.frames.find(frame => frame.actorId === "player")).toMatchObject({ durationSource: "explicit", durationSeconds: options.expected });
      expect(result.state.truth.facts.light!.value).toEqual({ kind: "text", value: "bright" });
      expect(f.transport).toHaveBeenCalledTimes(2);
      expect(replaySimulationState(result.state)).toEqual(result.state);
    });

  it("keeps the following phase occurrence through intervening boundaries and restart", async () => {
    const f = await fixture({ occurrence: 2 });
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(32400);
    expect(readDirectState(result.state.executionState!, result.state).activities[0]!.dueAtSeconds).toBe(118800);
    const restarted = new SimulationEngine(f.world, f.algorithm, structuredClone(result.state));
    while (readDirectState(result.state.executionState!, result.state).activities.length) result = await restarted.step(f.roster,
      { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(118800);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("distinguishes exiting the present phase from its next and following entries", async () => {
    const f = await fixture({ initial: 10, targetPhase: "dark", occurrence: 2 });
    const candidates = periodicDeadlineCandidates(f.world.initialState, "player", 0, [1, 2]);
    expect(candidates.map(candidate => ({ transition: { from: candidate.transition.from, to: candidate.transition.to }, occurrence: candidate.occurrence,
      currentPhase: candidate.currentPhase, seconds: candidate.seconds }))).toEqual([
      { transition: { from: "The dark phase is active.", to: "The bright phase is active." }, occurrence: 1, currentPhase: "The bright phase is active.", seconds: 86390 },
      { transition: { from: "The dark phase is active.", to: "The bright phase is active." }, occurrence: 2, currentPhase: "The bright phase is active.", seconds: 172790 },
      { transition: { from: "The bright phase is active.", to: "The dark phase is active." }, occurrence: 1, currentPhase: "The bright phase is active.", seconds: 43190 },
      { transition: { from: "The bright phase is active.", to: "The dark phase is active." }, occurrence: 2, currentPhase: "The bright phase is active.", seconds: 129590 },
    ]);
    expect(candidates.map(candidate => candidate.endpointCycle.offsetFromRequestCycle)).toEqual([1, 2, 0, 1]);
    expect(periodicDeadlineSeconds(candidates[2], { basis: "relative_cycle", count: 1 }, 0, 0)).toBe(129590);
    expect(periodicDeadlineSeconds(candidates[2], { basis: "relative_cycle", count: 0 }, 0, 50000)).toBeNull();
    expect(periodicDeadlineSeconds(candidates[2], { basis: "relative_cycle", count: Number.MAX_SAFE_INTEGER }, 0, 0)).toBeNull();
    expect(candidates[0]!.requestCycle).toEqual({ index: 0, positionSeconds: 10, beginsWith: "The bright phase is active." });
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    while (readDirectState(result.state.executionState!, result.state).activities.length) result = await f.engine.step(f.roster,
      { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(129590);
    expect(result.state.truth.facts.light!.value).toEqual({ kind: "text", value: "dark" });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("computes the following cycle's dark entry independently of its next occurrence", async () => {
    const f = await fixture({ initial: 10, targetPhase: "dark", reference: { basis: "relative_cycle", count: 1 } });
    let result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(readDirectState(result.state.executionState!, result.state).activities[0]).toMatchObject({ kind: "wait", dueAtSeconds: 129590 });
    while (readDirectState(result.state.executionState!, result.state).activities.length) result = await f.engine.step(f.roster,
      { expectedRevision: result.state.revision, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(129590);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("anchors a deadline before a prerequisite without repeating elapsed work", async () => {
    const f = await fixture({ prelude: true });
    const first = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(first.state.truth.elapsedSeconds).toBe(1);
    const final = await f.engine.step(f.roster, { expectedRevision: first.state.revision, trigger: "manual", externalActions: [] });
    expect(final.state.truth.elapsedSeconds).toBe(32400);
    expect(final.committed.directEvent.frames[0]!.durationSeconds).toBe(32399);
    expect(replaySimulationState(final.state)).toEqual(final.state);
  });

  it("does not reveal a restricted future cycle from its present observation", async () => {
    const f = await fixture({ restricted: true });
    expect(periodicDeadlineCandidates(f.world.initialState, "player", 0, [1, 2])).toEqual([]);
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(0);
    expect(result.committed.directEvent.frames).toEqual([]);
    expect(result.committed.directEvent.presentation?.[0]?.kind).toBe("clarification");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it("allows an actual delivered call to interrupt before the periodic endpoint", async () => {
    const f = await fixture({ call: true });
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(60);
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.wait?.reason).toBe("conditional-interruption");
    expect(result.committed.directEvent.frames.find(frame => frame.actorId === "player")).toMatchObject({ durationSeconds: 60, interruptedByEventIds: expect.any(Array) });
    expect(result.state.truth.facts.light!.value).toEqual({ kind: "text", value: "dark" });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("retains a large ordinal, rejects overflow and distinguishes a passed endpoint", async () => {
    const f = await fixture();
    const [next, distant, overflow] = periodicDeadlineCandidates(f.world.initialState, "player", 0, [1, 1000000, Number.MAX_SAFE_INTEGER]);
    expect(next?.seconds).toBe(32400); expect(distant?.seconds).toBe(32400 + 999999 * 86400);
    expect(overflow?.seconds).toBeNull(); expect(overflow?.availability).toBe("outside exact clock range");
    const later = structuredClone(f.world.initialState); later.truth.elapsedSeconds = 40000;
    expect(periodicDeadlineCandidates(later, "player", 0, [1])[0]).toMatchObject({ seconds: null, deadlineAtSeconds: 32400, availability: "already reached during this request" });
  });

  it("keeps an incidental numeral in an ordinary observation from becoming a wait", async () => {
    const f = await fixture({ ordinaryLook: true });
    const result = await f.engine.step(f.roster, { expectedRevision: 0, trigger: "participant_action", externalActions: f.actions });
    expect(result.state.truth.elapsedSeconds).toBe(1);
    expect(result.committed.directEvent.frames[0]!.kind).toBe("observe");
  });
});
