import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { resolutionPlanDraftSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { createTestModelCatalog, deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { SimulationEngine } from "../../runtime/simulation";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { replaySimulationState } from "../../runtime/transaction";
import { inspectResolutionPlanDrafts, type ResolutionPlanMaterializationInput } from "../truth-engine";

it("uses the real materializer to diagnose every plan with unchanged joint scope and no state writes", () => {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: createTestModelCatalog() });
  const state = structuredClone(definition.initialState);
  const actions = ["player", "keeper"].map(actorId => ({ id: `act-${actorId}`, actorId, baseRevision: state.revision,
    rawText: "Watch the courtyard and speak to the other person.", goal: "Exchange observations", means: null, targetIds: [] }));
  const drafts = actions.map(action => resolutionPlanDraftSchema.parse({ proposalKey: `plan-${action.actorId}`,
    actionRef: `ref:action:${action.id}`, targetRefs: [], means: [], mode: "automatic", difficulty: null,
    actorRatingRef: null, factors: [], risk: "safe", baseEffect: "none", primaryEffect: null,
    secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: `ref:action:${action.id}` }] }));
  // A same-batch action cause must remain available during every plan's check.
  drafts[0] = resolutionPlanDraftSchema.parse({ ...drafts[0], causes: [...drafts[0]!.causes, { kind: "action", ref: "ref:action:act-keeper" }] });
  const input: ResolutionPlanMaterializationInput = { state, definition, actions, drafts, identityOwner: "inspection-test",
    groundings: actions.map(action => ({ kind: "action", id: action.id, actorId: action.actorId,
      reads: [], writes: [], audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false })),
    allowedCauses: { action: new Set(actions.map(action => action.id)), check: new Set(), random: new Set(), event: new Set(),
      fact: new Set(Object.keys(state.truth.facts)), law: new Set(definition.laws.map(law => law.id)), mechanic: new Set() } };
  const originalHash = contentHash({ state, actions, drafts, groundings: input.groundings });
  expect(inspectResolutionPlanDrafts(input)).toEqual({ valid: true, issues: [] });
  expect(contentHash({ state, actions, drafts, groundings: input.groundings })).toBe(originalHash);
  const malformed = structuredClone(drafts);
  malformed[0] = resolutionPlanDraftSchema.parse({ ...malformed[0], mode: "check", difficulty: { kind: "environment", band: "easy", source: { kind: "action", ref: "ref:action:act-player" } },
    means: [{ description: "The attempted conversation", source: { kind: "action", ref: "ref:action:act-player" } }] });
  malformed[1] = resolutionPlanDraftSchema.parse({ ...malformed[1], targetRefs: ["ref:entity:missing"] });
  const result = inspectResolutionPlanDrafts({ ...input, drafts: malformed });
  expect(result.valid).toBe(false);
  expect(result.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "resolution_check_primary_effect", path: ["plans", 0, "primaryEffect"], originalValue: null, message: expect.stringContaining("non-none primary effect") }),
    expect.objectContaining({ code: "resolution_check_threatened_effect", path: ["plans", 0, "threatenedEffect"], originalValue: null, message: expect.stringContaining("no failure threat") }),
    expect.objectContaining({ path: expect.arrayContaining(["plans", 1]) }),
  ]));
  expect(contentHash({ state, actions, drafts, groundings: input.groundings })).toBe(originalHash);
  expect(inspectResolutionPlanDrafts({ ...input, drafts: drafts.slice(0, 1) }).valid).toBe(false);

  const durationRef = `ref:mechanic:${Object.keys(state.truth.mechanics.durationProfiles)[0]}`;
  const effect = { kind: "condition", proposalKey: "observed", targetRef: "ref:entity:keeper",
    channel: "attention", label: "observed", description: "The keeper is under observation.",
    sourceRefs: [{ kind: "action", ref: "ref:action:act-player" }], conditionRef: { proposalKey: "under-observation" },
    conditionProfileRef: null, durationProfileRef: durationRef, access: { kind: "public" }, magnitude: "standard" };
  const effects = structuredClone(drafts);
  effects[0] = resolutionPlanDraftSchema.parse({ ...effects[0], targetRefs: ["ref:entity:player"],
    means: [{ description: "Watch the keeper", source: { kind: "action", ref: "ref:action:act-player" } }],
    baseEffect: "standard", primaryEffect: effect, secondaryEffect: { ...effect, proposalKey: "secondary", magnitude: "minor" },
    threatenedEffect: { ...Object.fromEntries(Object.entries(effect).filter(([key]) => key !== "magnitude")), proposalKey: "threat" } });
  const before = contentHash({ ...input, drafts: effects });
  const mismatched = inspectResolutionPlanDrafts({ ...input, drafts: effects });
  expect(mismatched.valid).toBe(false);
  expect(mismatched.issues).toHaveLength(3);
  for (const [index, field] of ["primaryEffect", "secondaryEffect", "threatenedEffect"].entries()) {
    expect(mismatched.issues[index]).toMatchObject({ code: "reference.outside_plan_targets", class: "reference",
      path: ["plans", 0, field, "targetRef"], originalValue: "ref:entity:keeper", allowedHandles: ["ref:entity:player"],
      message: expect.stringContaining("resolves to an existing entity but is absent from this plan's targetRefs") });
  }
  expect(contentHash({ ...input, drafts: effects })).toBe(before);
  // The model can explicitly declare an evidence-supported subject; the gate
  // cannot add it or redirect its effects to an already declared subject.
  const corrected = structuredClone(effects);
  corrected[0] = resolutionPlanDraftSchema.parse({ ...corrected[0], targetRefs: ["ref:entity:player", "ref:entity:keeper"] });
  corrected[0]!.secondaryEffect = null;
  corrected[0]!.threatenedEffect = null;
  expect(inspectResolutionPlanDrafts({ ...input, drafts: corrected })).toEqual({ valid: true, issues: [] });

  // Every mechanic handle resolves, but its authored family and paired duration
  // must still be checked at the original effect field, without changing it.
  for (const [conditionProfileRef, durationProfileRef, expectedField, allowedHandles] of [
    ["ref:mechanic:brief", "ref:mechanic:brief", "conditionProfileRef", ["ref:condition_profile:obscured-vision", "ref:mechanic:obscured-vision"]],
    [null, "ref:mechanic:obscured-vision", "durationProfileRef", ["ref:duration_profile:brief", "ref:duration_profile:ongoing", "ref:mechanic:brief", "ref:mechanic:ongoing"]],
    ["ref:mechanic:obscured-vision", "ref:mechanic:ongoing", "durationProfileRef", ["ref:duration_profile:brief", "ref:mechanic:brief"]],
  ] as const) {
    const invalid = structuredClone(corrected);
    const profileEffect = { ...effect, conditionProfileRef, durationProfileRef };
    invalid[0] = resolutionPlanDraftSchema.parse({ ...invalid[0], primaryEffect: profileEffect,
      factors: [{ source: { kind: "action", ref: "ref:action:act-keeper" }, role: "secondary", authority: "semantic",
        direction: "neutral", steps: 0, channel: null, explanation: "The keeper's separate observation supports the secondary effect." }],
      secondaryEffect: { ...profileEffect, proposalKey: "secondary", magnitude: "minor",
        sourceRefs: [{ kind: "action", ref: "ref:action:act-keeper" }] },
      threatenedEffect: Object.fromEntries(Object.entries({ ...profileEffect, proposalKey: "threat" }).filter(([key]) => key !== "magnitude")) });
    const hash = contentHash({ ...input, drafts: invalid });
    const result = inspectResolutionPlanDrafts({ ...input, drafts: invalid });
    expect(result.valid).toBe(false);
    expect(result.issues, JSON.stringify(result.issues)).toHaveLength(3);
    for (const [index, field] of ["primaryEffect", "secondaryEffect", "threatenedEffect"].entries()) {
      expect(result.issues[index]).toMatchObject({ code: "reference.invalid_effect_profile", class: "reference",
        path: ["plans", 0, field, expectedField], originalValue: profileEffect[expectedField],
        allowedHandles: [...allowedHandles], message: expect.stringContaining("do not change the action or effect meaning") });
    }
    if (expectedField === "conditionProfileRef") expect(result.issues[0]!.message).toContain("null is also legal");
    expect(contentHash({ ...input, drafts: invalid })).toBe(hash);
  }
});

it("repairs two independently invalid plans together before one atomic step and replay", async () => {
  const catalog = createTestModelCatalog();
  let planAttempts = 0;
  let rejectedCandidate: unknown;
  let repairContextSeen: unknown;
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    const output = deterministicModelOutput(profileId, context);
    if (role !== "truth-resolution") return output;
    const directive = output as { kind: string; plans?: Array<Record<string, unknown>> };
    if (directive.kind !== "commit_plans") return output;
    planAttempts += 1;
    expect(directive.plans).toHaveLength(2);
    const input = context as { state: { committedResolutionPlans: unknown[] }; repair?: {
      previousOutput: unknown; previousOutputAvailable: boolean; candidateBinding: { sourceContextHash: string; canonicalOutputHash: string; schemaName: string };
      issues: Array<{ path: Array<string | number>; reason: string }> } };
    expect(input.state.committedResolutionPlans).toEqual([]);
    if (planAttempts === 1) {
      expect(input.repair).toBeNull();
      const first = directive.plans![0]!;
      first.mode = "check";
      first.means = [{ description: "Observe the courtyard", source: { kind: "action", ref: first.actionRef } }];
      first.difficulty = { kind: "environment", band: "easy", source: { kind: "action", ref: first.actionRef } };
      directive.plans![1]!.mode = "blocked";
      directive.plans![1]!.baseEffect = "minor";
      rejectedCandidate = structuredClone(directive);
      return directive;
    }
    repairContextSeen = structuredClone(context);
    return output;
  }, catalog, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step({
    player: { kind: "external", agentId: "player", participantId: "player-test" },
    keeper: { kind: "external", agentId: "keeper", participantId: "keeper-test" },
  }, {
    expectedRevision: source.revision, trigger: "participant_action",
    externalActions: ["player", "keeper"].map(agentId => ({ submissionId: `watch-${agentId}`, agentId,
      rawText: "Observe the courtyard.", goal: "Observe the courtyard", means: null, targetIds: [] })),
  });
  const originalContextHash = contentHash(provider.requests.find(request => request.schemaName === "truth_resolution_plan_commit")!.context);
  const input = repairContextSeen as { repair: { previousOutput: unknown; candidateBinding: unknown; issues: unknown[] } };
  expect(input.repair).toMatchObject({ previousOutputAvailable: true, previousOutput: rejectedCandidate,
    candidateBinding: { sourceContextHash: originalContextHash, canonicalOutputHash: contentHash(rejectedCandidate),
      schemaName: "truth_resolution_plan_commit" } });
  expect(input.repair?.issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ path: ["plans", 0, "primaryEffect"], reason: expect.stringContaining("non-none primary effect") }),
    expect.objectContaining({ path: ["plans", 0, "threatenedEffect"], reason: expect.stringContaining("no failure threat") }),
    expect.objectContaining({ path: ["plans", 1], reason: expect.stringContaining("cannot carry effects") }),
  ]));
  expect(planAttempts).toBe(2);
  expect(result.committed.resolutionPlans).toHaveLength(2);
  expect(result.committed.resolutionReceipts).toHaveLength(2);
  expect(result.state.revision).toBe(source.revision + 1);
  expect(result.state.truth.elapsedSeconds).toBeGreaterThan(source.truth.elapsedSeconds);
  expect(replaySimulationState(result.state)).toEqual(result.state);
});
