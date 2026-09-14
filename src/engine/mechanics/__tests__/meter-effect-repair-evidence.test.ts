import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { contentHash } from "../../models/model-audit";
import { deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";

it.each(["owner", "profile", "meterless"] as const)("repairs %s with exact meter evidence without transferring the consequence", async kind => {
  type Issue = { code: string; path: Array<string | number>; reason: string; originalValue: unknown; allowedHandles: string[] };
  let attempts = 0;
  let issues: Issue[] = [];
  const targetRef = kind === "meterless" ? "ref:entity:gate" : "ref:entity:player";
  const description = kind === "meterless" ? "The stone gate is under sustained physical pressure." : "Physical exertion causes minor strain to the traveler.";
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
    if (role !== "truth-resolution") return deterministicModelOutput(profileId, context);
    const input = context as { state: { committedResolutionPlans: unknown[]; actionSet: { assigned: Array<{ actionRef: string }> } };
      repair: { issues: Issue[] } };
    if (input.state.committedResolutionPlans.length) return { kind: "done" };
    attempts++;
    if (attempts === 2) issues = structuredClone(input.repair.issues);
    const actionRef = input.state.actionSet.assigned[0]!.actionRef;
    const common = { proposalKey: "exertion", targetRef, channel: "physical-harm", label: "Physical strain", description,
      sourceRefs: [{ kind: "action", id: actionRef }], magnitude: "minor" };
    const effect = kind === "meterless" && attempts > 1
      ? { ...common, kind: "condition", conditionRef: { proposalKey: "exertion" }, conditionProfileRef: null,
        durationProfileRef: "ref:mechanic:brief", access: { kind: "public" } }
      : { ...common, kind: "meter", meterRef: kind === "owner" && attempts === 1 ? "ref:meter:health:keeper" : "ref:meter:health:player",
        impactProfileRef: kind === "profile" && attempts === 1 ? "ref:mechanic:brief" : "ref:mechanic:harm" };
    return { kind: "commit_plans", plans: [{ proposalKey: "physical-exertion", actionRef, targetRefs: [targetRef],
      means: [{ description: "Apply physical effort", source: { kind: "action", ref: actionRef } }],
      factors: [], mode: "automatic", difficulty: null, actorRatingRef: null, risk: "safe", baseEffect: "minor",
      primaryEffect: effect, secondaryEffect: null, threatenedEffect: null, visibility: "full",
      causes: [{ kind: "action", ref: actionRef }] }] };
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const text = kind === "meterless" ? "倚靠石门练习发力，持续给石门施加压力。" : "在庭院进行负重训练，承受轻微的体力损耗。";
  const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "test-player" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, {
    expectedRevision: source.revision, trigger: "participant_action", externalActions: [{ submissionId: "exertion", agentId: "player",
      rawText: text, goal: text, means: null, targetIds: [] }],
  });
  expect(attempts).toBe(2);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ code: kind === "profile" ? "reference.invalid_meter_profile" : "reference.invalid_meter_ownership",
    path: ["plans", 0, "primaryEffect", kind === "profile" ? "impactProfileRef" : "meterRef"],
    originalValue: kind === "profile" ? "ref:mechanic:brief" : kind === "owner" ? "ref:meter:health:keeper" : "ref:meter:health:player" });
  expect(issues[0]!.reason).toContain(targetRef);
  expect(issues[0]!.reason).toContain("physical-exertion");
  expect(issues[0]!.reason).toContain("Do not transfer");
  if (kind === "profile") {
    expect(issues[0]!.allowedHandles).toContain("ref:mechanic:harm");
    expect(issues[0]!.allowedHandles).not.toContain("ref:mechanic:brief");
  } else {
    expect(issues[0]!.allowedHandles).toEqual(kind === "meterless" ? [] : ["ref:meter:health:player"]);
    expect(issues[0]!.reason).toContain(kind === "owner" ? "ref:entity:keeper" : "no meter");
  }
  const plan = result.committed.resolutionPlans[0]!;
  expect(result.committed.actions[0]!.rawText).toBe(text);
  expect(plan.primaryEffect).toMatchObject({ kind: kind === "meterless" ? "condition" : "meter",
    targetId: kind === "meterless" ? "gate" : "player", description });
  expect(result.state.truth.meters["health:keeper"]).toEqual(source.truth.meters["health:keeper"]);
  if (kind === "meterless") {
    expect(result.state.truth.meters["health:player"]).toEqual(source.truth.meters["health:player"]);
    expect(Object.values(result.state.truth.conditions)).toContainEqual(expect.objectContaining({ subjectId: "gate", description }));
  } else expect(result.state.truth.meters["health:player"]!.current).toBeLessThan(source.truth.meters["health:player"]!.current);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
