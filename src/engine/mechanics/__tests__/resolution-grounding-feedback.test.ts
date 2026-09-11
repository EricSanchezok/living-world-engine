import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { contentHash } from "../../models/model-audit";
import { referenceHandleFor } from "../../contracts/model-context";
import { deterministicActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";

it.each(["grounding", "proposal-cause", "effect-target", "condition-profile"])("preserves exact %s failure evidence through real runtime repair and replay", async (failureKind) => {
  let attempts = 0;
  let issue: { code: string; path: unknown[]; reason: string; originalValue: unknown; allowedHandles: string[] } | undefined;
  let actionRef = "";
  let targetIssues: NonNullable<typeof issue>[] = [];
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (draft) => {
      draft.interactionDependency.stateDependencies.requiredExistingRefs = [referenceHandleFor("entity", "player")];
      draft.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs = [referenceHandleFor("entity", "player")];
    });
    if (role === "truth-resolution") {
      const input = context as { state: { committedResolutionPlans: unknown[]; actionSet: { assigned: Array<{ actionRef: string }> } }; repair: { issues: NonNullable<typeof issue>[] } };
      if (input.state.committedResolutionPlans.length > 0) return { kind: "done" };
      attempts += 1;
      actionRef = input.state.actionSet.assigned[0]!.actionRef;
      if (attempts === 2) { issue = input.repair.issues[0]; targetIssues = input.repair.issues; }
      const effect = failureKind === "condition-profile" || (attempts === 1 && failureKind === "effect-target") ? {
        kind: "condition", proposalKey: "observed", targetRef: failureKind === "condition-profile" ? "ref:entity:player" : "ref:entity:keeper", channel: "attention",
        label: "observing", description: "The selected subject is observing the courtyard.", sourceRefs: [{ kind: "action", id: actionRef }],
        conditionRef: { proposalKey: "observed" }, conditionProfileRef: attempts === 1 && failureKind === "condition-profile" ? "ref:mechanic:brief" : null,
        durationProfileRef: "ref:mechanic:brief", access: { kind: "public" },
      } : null;
      return { kind: "commit_plans", plans: [{
        proposalKey: "observe-courtyard", actionRef, targetRefs: ["ref:entity:player"],
        means: [{ description: "Look around the courtyard", source: attempts === 1 && failureKind === "grounding"
          ? { kind: "entity", ref: "ref:entity:keeper" } : { kind: "action", ref: actionRef } }],
        mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", baseEffect: effect ? "standard" : "none",
        primaryEffect: effect ? { ...effect, magnitude: "standard" } : null, secondaryEffect: null,
        threatenedEffect: effect && failureKind !== "condition-profile" ? { ...effect, proposalKey: "threat", conditionRef: { proposalKey: "threat" } } : null, visibility: "full",
        causes: [{ kind: "action", ref: attempts === 1 && failureKind === "proposal-cause" ? { proposalKey: "observe-courtyard" } : actionRef }],
      }] };
    }
    return deterministicModelOutput(profileId, context);
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step({
    player: { kind: "external", agentId: "player", participantId: "test-player" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
  }, { expectedRevision: source.revision, trigger: "participant_action", externalActions: [{
    submissionId: "inspect-courtyard", agentId: "player", rawText: "观察庭院", goal: "确认庭院状况", means: null, targetIds: [],
  }] });
  if (failureKind !== "condition-profile") expect(attempts).toBe(2);
  expect(provider.requests.filter(request => request.schemaName === "truth_resolution_plan_commit" &&
    (request.context as { repair?: unknown }).repair)).toHaveLength(1);
  if (failureKind === "grounding") {
    expect(issue).toMatchObject({ code: "reference.outside_action_grounding", path: ["plans", 0, "means", 0, "source", "ref"], originalValue: "ref:entity:keeper" });
    expect(issue!.reason).toContain(actionRef);
    expect(issue!.reason).toContain("observe-courtyard");
    expect(issue!.allowedHandles).toContain(actionRef);
    expect(issue!.allowedHandles).toContain("ref:entity:player");
    expect(issue!.allowedHandles).not.toContain("ref:entity:keeper");
  } else if (failureKind === "effect-target") {
    expect(targetIssues).toHaveLength(2);
    for (const [index, field] of ["primaryEffect", "threatenedEffect"].entries()) {
      expect(targetIssues[index]).toMatchObject({ code: "reference.outside_plan_targets",
        path: ["plans", 0, field, "targetRef"], originalValue: "ref:entity:keeper", allowedHandles: ["ref:entity:player"] });
      expect(targetIssues[index]!.reason).toContain("this plan's targetRefs");
      expect(targetIssues[index]!.reason).toContain(actionRef);
    }
    expect(result.committed.resolutionPlans[0]!.targetIds).toEqual(["player"]);
    expect(result.committed.resolutionPlans[0]!.primaryEffect).toBeNull();
  } else if (failureKind === "condition-profile") {
    expect(targetIssues).toHaveLength(1);
    expect(issue).toMatchObject({ code: "reference.invalid_effect_profile", path: ["plans", 0, "primaryEffect", "conditionProfileRef"],
      originalValue: "ref:mechanic:brief", allowedHandles: ["ref:condition_profile:obscured-vision", "ref:mechanic:obscured-vision"] });
    expect(issue!.reason).toContain("null is also legal");
    expect(issue!.reason).toContain(actionRef);
    expect(result.committed.resolutionPlans[0]!.primaryEffect).toMatchObject({ kind: "condition", targetId: "player",
      conditionProfileId: null, durationProfileId: "brief", description: "The selected subject is observing the courtyard." });
    expect(Object.values(result.state.truth.conditions)).toEqual(expect.arrayContaining([
      expect.objectContaining({ subjectId: "player", description: "The selected subject is observing the courtyard." }),
    ]));
  } else {
    expect(issue).toMatchObject({ code: "invalid_type", path: ["plans", 0, "causes", 0, "ref"], originalValue: { proposalKey: "observe-courtyard" } });
    expect(issue!.reason).toContain("string");
    expect(actionRef.startsWith("ref:action:")).toBe(true);
  }
  expect(result.state.revision).toBe(source.revision + 1);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
