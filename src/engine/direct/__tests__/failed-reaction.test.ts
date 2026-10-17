import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { PolicyBinding } from "../../runtime/execution";
import { WorldQuiescentError } from "../../runtime/execution";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { directCreationContext, directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import type { ActionFrame } from "../contracts";
import { participantReactionIds } from "../foreground";
import { readDirectState } from "../state";
import type { PrivateInteraction } from "../views";

const request = "请转给我一枚灵石；若转不了，告诉我结果。";
const explanation = "刚才没能转出灵石，你还没有收到。";

async function fixture(options: { outcome?: "failed" | "blocked"; progress?: "continue" | "complete"; repeat?: boolean; failedExplanation?: boolean } = {}) {
  const f = directTestProvider(wire => {
    const context = wire.state as { actions?: ActionFrame[]; submittedAction?: { rawText: string };
      perspective?: { agentId: string; respondingTo: string | null; interactions: PrivateInteraction[] } };
    const self = context.perspective?.agentId;
    const prior = context.perspective?.interactions.findLast(item => item.relation === "self" && item.operation === "transfer");
    const operation = self === "player" ? "speak" : !context.perspective?.respondingTo ? "wait"
      : prior && !options.repeat ? "speak" : "transfer";
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      const index = /^a(\d+)_/u.exec(id)?.[1];
      const action = index === undefined ? undefined : context.actions?.[Number(index)];
      const failedAttempt = action?.actorId === "keeper" && (action.kind === "transfer" || action.kind === "speak" && options.failedExplanation);
      const choices: Record<string, string> = { operation, recipient: self === "player" ? "guard" : "traveler", target: "none",
        resource: operation === "transfer" ? "spirit-stone" : "none", amount: "n1", speech: "create", timing: "default",
        interaction: "world_action", transfer_authority: "give" };
      let value = choices[id] ?? "none";
      if (id.startsWith("resource_amount_")) value = "n1";
      if (id.endsWith("_player_authorization")) value = "authorized";
      if (id.endsWith("_outcome")) value = failedAttempt ? options.outcome === "blocked" ? "unknown" : "failed" : "succeeded";
      if (id.endsWith("_duration")) value = "s1";
      if (id.includes("_visible") || id.includes("_entity")) value = "hidden";
      if (id.includes("_delivery")) value = "delivered";
      if (id.includes("_fact") || id.endsWith("_expression")) value = "unchanged";
      if (id.startsWith("progress_") || id.endsWith("_request_progress")) value = failedAttempt ? options.progress ?? "continue" : "complete";
      return [id, nativeAnswer(question, id === "expression" ? 0 : value)];
    }));
  }, wire => {
    const context = directCreationContext(wire);
    if (context.playerControlled) return { attempt: request, utterance: request, manner: null };
    const perspective = context.perspective as { interactions: PrivateInteraction[] };
    expect(perspective.interactions).toContainEqual(expect.objectContaining({ relation: "self", operation: "transfer", status: options.outcome ?? "failed" }));
    return { attempt: "说明刚才转账未成的实际结果", utterance: explanation, manner: null };
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
  world.initialState.agents.player!.belief.localEntities.guard = { id: "guard", name: "守门人", description: "眼前的守门人", status: "observed" };
  world.initialState.agents.player!.bindings.guard = { localEntityId: "guard", canonicalEntityIds: ["keeper"] };
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const engine = new SimulationEngine(world, new DirectWorldAlgorithm(f.gateway, {
    decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true,
  }));
  const roster: Record<string, PolicyBinding> = { player: { kind: "external", agentId: "player", participantId: "human" },
    keeper: { kind: "model", agentId: "keeper", profiles: world.initialState.agents.keeper!.modelProfiles } };
  await engine.bootstrapAgents();
  const first = await engine.step(roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [
    { submissionId: "request-transfer", agentId: "player", rawText: request, goal: request, means: null, targetIds: [] },
  ] });
  const cause = first.committed.directEvent.frames.find(frame => frame.submissionId === "request-transfer")!.id;
  const advance = () => engine.step(roster, { expectedRevision: engine.snapshot.revision, trigger: "batch", externalActions: [] });
  return { ...f, world, engine, advance, cause };
}

describe("failed NPC response continuation through real model HTTP and simulation", () => {
  it.each(["failed", "blocked"] as const)("delivers an evidence-based explanation after a %s response", async outcome => {
    const f = await fixture({ outcome });
    const failed = await f.advance();
    const control = readDirectState(failed.state.executionState!, failed.state);
    expect(failed.committed.outcomes).toMatchObject([{ status: outcome }]);
    expect(control.intents.keeper).toMatchObject({ status: "ready", causeActionId: f.cause, noProgressCount: 1 });
    expect(participantReactionIds(failed.state, control, ["player"])).toEqual(new Set(["keeper"]));
    expect(failed.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    const reported = await f.advance();
    expect(reported.committed.directEvent.frames).toMatchObject([{ actorId: "keeper", kind: "speak", causeActionId: f.cause, utterance: explanation }]);
    expect(reported.committed.observations).toContainEqual(expect.objectContaining({ observerId: "player",
      scene: expect.objectContaining({ speech: expect.objectContaining({ utterance: explanation }) }) }));
    expect(reported.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    expect(participantReactionIds(reported.state, readDirectState(reported.state.executionState!, reported.state), ["player"])).toEqual(new Set());
    expect(replaySimulationState(reported.state)).toEqual(reported.state);
  });

  it("ends repeated failed attempts after the existing no-progress allowance", async () => {
    const f = await fixture({ repeat: true });
    await f.advance();
    const repeated = await f.advance();
    expect(repeated.state.history.flatMap(step => step.directEvent?.frames ?? []).filter(frame => frame.kind === "transfer")).toHaveLength(2);
    expect(readDirectState(repeated.state.executionState!, repeated.state).intents.keeper).toMatchObject({
      status: "waiting", causeActionId: null, noProgressCount: 2, wait: { reason: "no-progress" },
    });
    expect(repeated.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
    const calls = f.transport.mock.calls.length;
    await expect(f.advance()).rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(repeated.state)).toEqual(repeated.state);
  });

  it("does not retain a failed response whose world verdict closes the request", async () => {
    const f = await fixture({ progress: "complete" });
    const failed = await f.advance();
    const control = readDirectState(failed.state.executionState!, failed.state);
    expect(control.intents.keeper!.causeActionId).toBeNull();
    expect(participantReactionIds(failed.state, control, ["player"])).toEqual(new Set());
    expect(failed.state.truth.quantities).toEqual(f.world.initialState.truth.quantities);
  });

  it("does not count a differently expressed failed explanation as progress", async () => {
    const f = await fixture({ failedExplanation: true });
    await f.advance();
    const failed = await f.advance();
    expect(failed.committed.directEvent.frames).toMatchObject([{ kind: "speak", causeActionId: f.cause, utterance: explanation }]);
    expect(failed.committed.outcomes).toMatchObject([{ status: "failed" }]);
    expect(failed.committed.observations.some(observation => observation.observerId === "player" && observation.scene?.speech)).toBe(false);
    expect(readDirectState(failed.state.executionState!, failed.state).intents.keeper).toMatchObject({
      status: "waiting", causeActionId: null, noProgressCount: 2, wait: { reason: "no-progress" },
    });
    const calls = f.transport.mock.calls.length;
    await expect(f.advance()).rejects.toThrow(WorldQuiescentError);
    expect(f.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(failed.state)).toEqual(failed.state);
  });
});
