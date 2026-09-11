import path from "node:path";
import { expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate } from "../../../../script/world-loader";
import { referenceHandleFor } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import { SimulationEngine } from "../../../runtime/simulation";
import { CanonicalCommitter } from "../../../runtime/canonical-committer";
import type { WorldExecutionAlgorithm, WorldStepCandidate } from "../../../runtime/execution";
import { replaySimulationState } from "../../../runtime/transaction";
import { pauseActivity } from "../../../mechanics/temporal";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../eager-reference";

it.each([1, 10])("uses a current interaction, not retained context, to interrupt (other checkpoint %s)", async otherCheckpoint => {
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") {
      return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
        compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile",
          action.actorId === "keeper" ? "ongoing-action" : "brief-action");
        compilation.interactionDependency = deterministicInteractionDependency({
          reads: [{ kind: "global", id: "world" }], writes: [{ kind: "global", id: "world" }],
          audienceAgentIds: action.actorId === "keeper" ? ["keeper", "player"] : ["player"],
        });
      });
    }
    if (role === "action-grounding") {
      const action = (context as { state: { action: { actorId?: string; actorRef?: string } } }).state.action;
      const keeper = (action.actorId ?? action.actorRef) === "ref:agent:keeper" || action.actorId === "keeper";
      return deterministicInteractionDependency({
        reads: [{ kind: "global", id: "world" }], writes: [{ kind: "global", id: "world" }],
        audienceAgentIds: keeper ? ["keeper", "player"] : ["player"],
      });
    }
    return deterministicModelOutput(profileId, context);
  });
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  template.mechanics.temporal_profiles = template.mechanics.temporal_profiles.map(profile => {
    if (profile.id === "ongoing-action" && profile.kind === "ongoing") {
      return { ...profile, checkpoint_seconds: otherCheckpoint };
    }
    if (profile.id !== "brief-action" || profile.kind !== "fixed") return profile;
    const { duration_seconds, checkpoint_seconds, ...common } = profile;
    expect(duration_seconds).toBe(checkpoint_seconds);
    return { ...common, kind: "goal", check_every_seconds: 1 };
  });
  const definition = buildWorldDefinition(template, { seed: 47, modelCatalog: provider.catalog });
  const delegate = new EagerReferenceAlgorithm(provider);
  let candidate: WorldStepCandidate | undefined;
  const algorithm: WorldExecutionAlgorithm = {
    manifest: delegate.manifest,
    bootstrap: (input, context) => delegate.bootstrap(input, context),
    prepareStep: (input, context) => delegate.prepareStep(input, context),
    completeStep: async (input, preparation, reactions, context) => {
      candidate = await delegate.completeStep(input, preparation, reactions, context);
      return candidate;
    },
  };
  const engine = new SimulationEngine(definition, algorithm);
  await engine.bootstrapAgents();
  const roster = Object.fromEntries(Object.values(engine.snapshot.agents).map(agent => [agent.id, {
    kind: "model" as const, agentId: agent.id, profiles: structuredClone(agent.modelProfiles),
  }]));
  const first = await engine.step(roster, { expectedRevision: engine.snapshot.revision, trigger: "manual", externalActions: [] });
  const firstPlayer = Object.values(first.state.truth.activities).find(activity => activity.actorId === "player")!;
  const firstKeeper = Object.values(first.state.truth.activities).find(activity => activity.actorId === "keeper")!;
  expect(firstPlayer.status).toBe("active");
  expect(firstKeeper).toMatchObject({ status: "active", nextBoundaryAtSeconds: otherCheckpoint === 1 ? 2 : 10 });
  expect(firstKeeper.interactionFootprint.audienceAgentIds).toContain("player");
  const requestCount = provider.requests.length;
  const second = await engine.step(roster, { expectedRevision: first.state.revision, trigger: "batch", externalActions: [] });
  const player = second.state.truth.activities[firstPlayer.id]!;
  expect(second.state.truth.elapsedSeconds).toBe(2);
  if (otherCheckpoint === 10) {
    expect(second.committed.actions.map(action => action.actorId)).toEqual(["player"]);
    expect(second.committed.outcomes).toHaveLength(1);
    expect(player).toMatchObject({ status: "active", nextBoundaryAtSeconds: 3, sourceActionId: firstPlayer.sourceActionId });
    expect(second.state.truth.activities[firstKeeper.id]).toMatchObject({ status: "active", nextBoundaryAtSeconds: 10 });
    expect(second.committed.decisionPoints).toEqual([]);
    expect(provider.requests.slice(requestCount).filter(request =>
      request.role === "agent-mind" || request.role === "agent-reaction" || request.role === "action-compilation")).toEqual([]);
    expect(candidate!.interactionDependencies).toContainEqual(expect.objectContaining({
      kind: "activity", id: firstKeeper.id, audienceAgentIds: expect.arrayContaining(["player"]),
    }));
    const forged = structuredClone(candidate!);
    const activePlayer = forged.temporalState.activities[firstPlayer.id]!;
    if (activePlayer.status !== "active") throw new Error("The player Activity must be active");
    const paused = pauseActivity(activePlayer, 2);
    forged.temporalState.activities[firstPlayer.id] = paused.activity;
    const transitionIndex = forged.activityTransitions.findIndex(transition => transition.activityId === firstPlayer.id);
    if (transitionIndex < 0) forged.activityTransitions.push(paused.transition);
    else forged.activityTransitions[transitionIndex] = paused.transition;
    const disposition = forged.activityDispositions.find(value => value.activityId === firstPlayer.id)!;
    disposition.kind = "pause";
    disposition.reason = "relevant_committed_observation";
    forged.decisionPoints.push({ agentId: "player", reason: "activity_interrupted", activityId: firstPlayer.id, timerId: null });
    const before = contentHash(first.state);
    expect(() => new CanonicalCommitter().step(first.state, forged, roster, definition.runtimeDefaults.maxAutonomousSpanSeconds))
      .toThrow("candidate temporal transitions do not match the trusted boundary result");
    expect(contentHash(first.state)).toBe(before);
    const changedContext = structuredClone(candidate!);
    changedContext.interactionDependencies.find(dependency => dependency.id === firstKeeper.id)!.audienceAgentIds = ["keeper"];
    expect(() => new CanonicalCommitter().step(first.state, changedContext, roster, definition.runtimeDefaults.maxAutonomousSpanSeconds))
      .toThrow(`candidate changes the persisted footprint of Activity ${firstKeeper.id}`);
  } else {
    expect(second.committed.actions.map(action => action.actorId).sort()).toEqual(["keeper", "player"]);
    expect(player.status).toBe("paused");
    expect(second.committed.decisionPoints).toContainEqual(expect.objectContaining({ agentId: "player", reason: "activity_interrupted" }));
  }
  expect(contentHash(replaySimulationState(second.state, second.state.revision))).toBe(contentHash(second.state));
}, 30_000);
