import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { resolutionPlanDraftSchema, resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import type { SemanticRepairContext } from "../../models/semantic-repair";
import { ModelConfigurationError, type StructuredModelProvider } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { defineAlgorithmRef } from "../../algorithms/composition";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../algorithms/registry";
import { TRUTH_RESOLUTION_CONTRACT_VERSION } from "../../algorithms/roles";
import { RESOLUTION_SOURCE_INVENTORY } from "../../contracts/resolution-source-inventory";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { bindMechanicalPlanRepairContext, MECHANICAL_PLAN_REPAIR, selectMechanicalPlanRepair } from "../mechanical-plan-repair";
import { ORDERED_RANDOM_SCHEDULING } from "../ordered-random-stream";
import { TruthEngine } from "../truth-engine";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { dependentFieldsProvider } from "../resolution-dependent-fields-codec";
import { indexedReviewedPlanningProvider } from "../indexed-reviewed-planning-pipeline";
import { SHARED_BATCH_CONTEXT_CODEC } from "../shared-batch-context";
import { LOGICAL_CANDIDATE_REPAIR_NOTICE } from "../../prompts/logical-repair-context";
import { declaredRandomPlanSchema } from "../plan-random-completion";

function draft(actionRef: string, actor = "player") {
  return resolutionPlanDraftSchema.parse({ proposalKey: `plan-${actor}`, actionRef, targetRefs: [`ref:entity:${actor}`],
    means: [{ description: "Remain alert while watching the courtyard", source: { kind: "action", ref: actionRef } }],
    mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", baseEffect: "standard",
    primaryEffect: { kind: "condition", proposalKey: `effect-${actor}`, targetRef: `ref:entity:${actor}`, channel: "attention",
      label: "Watching", description: `${actor} remains alert while watching the courtyard.`, magnitude: "standard",
      sourceRefs: [{ kind: "action", ref: actionRef }], conditionRef: { proposalKey: `effect-${actor}` },
      conditionProfileRef: null, durationProfileRef: "ref:mechanic:brief", access: { kind: "public" } },
    secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] });
}

it("keeps retained drafts in original order, checks replacement identities and binds the snapshot", () => {
  const previous = resolutionPlanCommitDirectiveSchema.parse({ kind: "commit_plans", plans: [draft("ref:action:a"), draft("ref:action:b", "keeper")] });
  let source = "snapshot-a";
  const repair: SemanticRepairContext = { attempt: 1, scope: "component", targetIds: ["a", "b"], previousOutput: previous,
    issues: [{ code: "reference.invalid_effect_profile", class: "reference", path: ["plans", 1, "primaryEffect"], message: "invalid" }] };
  const options = { repair, schema: resolutionPlanCommitDirectiveSchema, actionIds: ["a", "b"],
    actionIdFor: (plan: Pick<ReturnType<typeof draft>, "actionRef">) => String(plan.actionRef).slice("ref:action:".length), sourceHash: () => source, expectedSourceHash: source };
  const selection = selectMechanicalPlanRepair(options)!;
  expect(selection.selectedActionIds).toEqual(["b"]);
  const replacement = { kind: "commit_plans" as const, plans: [draft("ref:action:b", "keeper")] };
  replacement.plans[0] = resolutionPlanDraftSchema.parse({ ...replacement.plans[0], proposalKey: "repaired-keeper" });
  const reconstructed = selection.merge(replacement);
  expect(reconstructed).toEqual({ kind: "commit_plans", plans: [previous.plans[0], replacement.plans[0]] });
  expect(previous.plans[1]!.proposalKey).toBe("plan-keeper");
  expect(() => selection.merge({ ...replacement, plans: [previous.plans[0]!] })).toThrow("assigned action identity");
  expect(() => selection.merge(previous)).toThrow("exactly its assigned actions");
  const bound = bindMechanicalPlanRepairContext({ task: { constraints: [LOGICAL_CANDIDATE_REPAIR_NOTICE] }, repair: { previousOutput: previous } },
    selection.binding, { task: { constraints: ["source constraint"] }, state: { allActions: ["a", "b"] } });
  expect(bound.repair).toMatchObject({ previousOutput: previous });
  expect(bound.task.constraints).not.toContain(LOGICAL_CANDIDATE_REPAIR_NOTICE);
  source = "snapshot-b";
  expect(() => selection.merge(replacement)).toThrow("source snapshot changed");
  expect(() => selectMechanicalPlanRepair(options)).toThrow("source snapshot changed");
  source = "snapshot-a";
  for (const altered of [
    { ...repair, previousOutput: undefined }, { ...repair, previousOutput: replacement },
    { ...repair, issues: [{ ...repair.issues[0]!, path: [] }] },
    { ...repair, issues: [{ ...repair.issues[0]!, path: ["plans", 4] }] },
    { ...repair, issues: [0, 1].map(index => ({ ...repair.issues[0]!, path: ["plans", index] })) },
    { ...repair, previousOutput: { ...previous, plans: [previous.plans[0], previous.plans[0]] } },
  ]) expect(selectMechanicalPlanRepair({ ...options, repair: altered })).toBeUndefined();
  const coupled = structuredClone(previous);
  coupled.plans[0] = resolutionPlanDraftSchema.parse({ ...coupled.plans[0], primaryEffect: {
    ...coupled.plans[0]!.primaryEffect, conditionRef: { proposalKey: "effect-keeper" } } });
  expect(selectMechanicalPlanRepair({ ...options, repair: { ...repair, previousOutput: coupled,
    issues: [{ ...repair.issues[0]!, path: ["plans", 0, "primaryEffect"] }] } })).toBeUndefined();
});

it("isolates malformed source selections in a complete 49-plan candidate and preserves every retained draft", () => {
  const plans = Array.from({ length: 49 }, (_, i) => ({ ...draft(`ref:action:a-${i}`, `npc-${i}`), additionalRandomness: "none" as const }));
  const previous = { kind: "commit_plans" as const, plans: plans.map((plan, i) => i === 26
    ? { ...plan, causes: [{ kind: "invalid_cause_selection", ref: "unresolved-index:691" }], invalidCauseSelection: { rejectedIndex: 691 } }
    : i === 13 ? { ...plan, factors: [{ role: "invalid-factor" }] } : plan) };
  const repair: SemanticRepairContext = { attempt: 1, scope: "component", targetIds: plans.map(plan => String(plan.actionRef)), previousOutput: previous,
    issues: [{ code: "schema.invalid_union", class: "structure", path: ["plans", 26, "causes", 0, "kind"], message: "invalid source index" }] };
  const options = { repair, schema: declaredRandomPlanSchema, actionIds: plans.map(plan => String(plan.actionRef)),
    actionIdFor: (plan: Pick<ReturnType<typeof draft>, "actionRef">) => String(plan.actionRef), sourceHash: () => "source", expectedSourceHash: "source" };
  const selection = selectMechanicalPlanRepair(options)!;
  expect(selection.binding.originalOrdinals).toEqual([13, 26]);
  expect(selection.binding.retainedPlanCount).toBe(47);
  expect(selection.binding.previousOutputHash).toBe(contentHash(previous));
  const replacements = { kind: "commit_plans" as const, plans: [plans[26]!, plans[13]!] };
  const complete = selection.merge(replacements);
  expect(complete).toEqual({ kind: "commit_plans", plans });
  if (complete.kind !== "commit_plans") throw new Error("wrong reconstructed kind");
  complete.plans.forEach((plan, index) => {
    if (index !== 13 && index !== 26) expect(contentHash(plan)).toBe(contentHash(previous.plans[index]));
  });
  expect(() => selection.merge({ ...replacements, plans: replacements.plans.map(plan => {
    const malformed: Record<string, unknown> = { ...plan }; delete malformed.additionalRandomness; return malformed as ReturnType<typeof draft>;
  }) })).toThrow();
  expect(contentHash(previous)).toBe(selection.binding.previousOutputHash);
  for (const previousOutput of [
    { ...previous, inventedRoot: true },
    { ...previous, plans: previous.plans.map((plan, i) => i === 26 ? { ...plan, actionRef: "unresolved-index:691" } : plan) },
    { ...previous, plans: previous.plans.map((plan, i) => i === 26 ? { ...plan, proposalKey: plans[0]!.proposalKey } : plan) },
  ]) expect(selectMechanicalPlanRepair({ ...options, repair: { ...repair, previousOutput } })).toBeUndefined();
  const globalSchema = declaredRandomPlanSchema.superRefine((_value, context) => context.addIssue({ code: "custom", path: [], message: "joint failure" }));
  expect(selectMechanicalPlanRepair({ ...options, schema: globalSchema, repair: { ...repair, previousOutput: { kind: "commit_plans", plans } } })).toBeUndefined();
});

it("includes declaration owners and consumers when the selected owner is malformed", () => {
  const plans = [draft("ref:action:a", "a"), draft("ref:action:b", "b"), draft("ref:action:c", "c")];
  const previous = { kind: "commit_plans" as const, plans: [
    { ...plans[0], causes: [{ kind: "invalid_cause_selection", ref: "unresolved-index:691" }] },
    { ...plans[1], primaryEffect: { ...plans[1]!.primaryEffect, conditionRef: { proposalKey: "effect-a" } } }, plans[2],
  ] };
  const selection = selectMechanicalPlanRepair({ schema: resolutionPlanCommitDirectiveSchema,
    repair: { attempt: 1, scope: "component", targetIds: ["a", "b", "c"], previousOutput: previous,
      issues: [{ code: "schema.invalid_union", class: "structure", path: ["plans", 0, "causes"], message: "invalid source" }] },
    actionIds: plans.map(plan => String(plan.actionRef)), actionIdFor: plan => String(plan.actionRef), sourceHash: () => "source", expectedSourceHash: "source" })!;
  expect(selection.binding.originalOrdinals).toEqual([0, 1]);
  expect(selection.merge({ kind: "commit_plans", plans: plans.slice(0, 2) })).toEqual({ kind: "commit_plans", plans });
});

it.each(["baseline", "valid", "malformed-baseline", "malformed-valid", "wrong-owner-then-valid", "conflict-then-valid", "conflict-exhausted"])("repairs a subset and revalidates every plan before real atomic execution: %s", async mode => {
  const baseline = mode.endsWith("baseline");
  const twoCalls = ["valid", "baseline", "malformed-valid", "malformed-baseline"].includes(mode);
  let attempts = 0;
  const contexts: unknown[] = [];
  const outputs: ReturnType<typeof resolutionPlanCommitDirectiveSchema.parse>[] = [];
  const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
    if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    if (schemaName !== "truth_resolution_plan_commit") return deterministicModelOutput(profileId, context);
    attempts++; contexts.push(structuredClone(context));
    const input = context as { state: { actionSet: { assigned: Array<{ actionRef: string; actorRef: string }>; available: unknown[] }; canonicalTruth: unknown }; repair?: unknown };
    const plans = input.state.actionSet.assigned.map(action => draft(action.actionRef, action.actorRef.replace("ref:agent:", "")))
      .sort((left, right) => String(right.proposalKey).localeCompare(String(left.proposalKey)));
    const keeperIndex = plans.findIndex(plan => plan.proposalKey === "plan-keeper");
    const keeper = plans[keeperIndex]!;
    if (attempts === 1) plans[keeperIndex] = resolutionPlanDraftSchema.parse({ ...keeper,
      primaryEffect: { ...keeper.primaryEffect, conditionProfileRef: "ref:mechanic:brief" } });
    if (attempts > 1 && mode.startsWith("conflict") && (mode === "conflict-exhausted" || attempts === 2)) {
      plans[keeperIndex] = resolutionPlanDraftSchema.parse({ ...keeper, primaryEffect: { ...keeper.primaryEffect,
        proposalKey: "effect-player", conditionRef: { proposalKey: "effect-player" } } });
    }
    if (mode === "wrong-owner-then-valid" && attempts === 2) {
      const prior = (input.repair as { previousOutput: { plans: ReturnType<typeof draft>[] } }).previousOutput;
      plans[0] = structuredClone(prior.plans.find(plan => plan.proposalKey === "plan-player")!);
    }
    const output = { kind: "commit_plans" as const, plans };
    outputs.push(structuredClone(output));
    if (attempts === 1 && mode.startsWith("malformed")) return { ...output, plans: output.plans.map((plan, i) => i === keeperIndex
      ? { ...plan, causes: [{ kind: "invalid_cause_selection", ref: "unresolved-index:691" }], invalidCauseSelection: { rejectedIndex: 691 } } : plan) };
    return output;
  }, undefined, false);
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => generate(request.schemaName === "truth_resolution_plan_commit"
    ? { ...request, wireJsonSchema: z.toJSONSchema(request.schema, { target: "draft-07" }) } : request);
  const base = FULL_CATALOG_ALGORITHM_REF;
  const truth = defineAlgorithmRef({ role: "truth-resolution", id: "source-inventory-truth-resolution", version: "1", contractVersion: TRUTH_RESOLUTION_CONTRACT_VERSION,
    config: { randomScheduling: ORDERED_RANDOM_SCHEDULING, sourceInventory: RESOLUTION_SOURCE_INVENTORY,
      ...(baseline ? {} : { mechanicalPlanRepair: MECHANICAL_PLAN_REPAIR }) }, children: base.children.truthResolution!.children });
  const ref = defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution: truth } });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, registerBuiltinAlgorithms().create(ref, { provider }));
  await engine.bootstrapAgents(); const before = engine.snapshot;
  const result = engine.step({ player: { kind: "external", agentId: "player", participantId: "p" }, keeper: { kind: "external", agentId: "keeper", participantId: "k" } },
    { expectedRevision: before.revision, trigger: "participant_action", externalActions: ["player", "keeper"].map(agentId => ({ submissionId: agentId, agentId,
      rawText: "Remain alert while watching the courtyard.", goal: "Stay watchful", means: null, targetIds: [] })) });
  if (mode === "conflict-exhausted") {
    await expect(result).rejects.toThrow(); expect(engine.snapshot).toEqual(before);
  } else {
    const completed = await result;
    expect(completed.state.revision).toBe(before.revision + 1);
    expect(completed.committed.resolutionPlans).toHaveLength(2);
    expect(Object.values(completed.state.truth.conditions).filter(condition => condition.label === "Watching")).toHaveLength(2);
    expect(replaySimulationState(completed.state)).toEqual(completed.state);
  }
  expect(attempts).toBe(twoCalls ? 2 : 3);
  const views = contexts as Array<{ state: { canonicalTruth: unknown; actionSet: { assigned: unknown[]; available: unknown[] } }; repair: { previousOutput: { plans: unknown[] }; issues: Array<{ reason: string }>; planReplacement: { retainedPlanCount: number } } }>;
  expect(views.map(value => value.state.actionSet.assigned.length)).toEqual(baseline ? [2, 2] : twoCalls ? [2, 1] : [2, 1, 2]);
  for (const current of views.slice(1)) {
    expect(current.state.canonicalTruth).toEqual(views[0]!.state.canonicalTruth);
    expect(current.state.actionSet.available).toEqual(views[0]!.state.actionSet.available);
    if (current.repair.planReplacement) expect(current.repair.planReplacement.retainedPlanCount).toBe(1);
    expect(current.repair.previousOutput.plans).toHaveLength(mode === "wrong-owner-then-valid" && current === views[2] ? 1 : 2);
    expect(current.repair.previousOutput.plans).toContainEqual(outputs[0]!.plans.find(plan => plan.proposalKey === "plan-player"));
    expect(current.state.actionSet.available).toHaveLength(2);
    expect(views[0]!.state.actionSet.assigned).toEqual(expect.arrayContaining(current.state.actionSet.assigned));
  }
  if (mode.startsWith("conflict")) expect(views[2]!.repair.issues.some(issue => /duplicate|declared|declaration/.test(issue.reason))).toBe(true);
});

it.each([{ relations: false, compact: false, malformedCause: true }, { relations: false, compact: false }, { relations: true, compact: false }, { relations: false, compact: true }, { relations: true, compact: true }])("preserves full joint validation through indexed physical batching and scoped repair (%j)", async ({ relations, compact, malformedCause }) => {
  let planningCalls = 0, reviewedPlans = 0;
  const physicalSizes: number[] = [];
  const provider = new ScriptedModelProvider(({ context }) => {
    const task = (context as { task: { planningWorklist: { actions: Array<{ actionIndex: number; action: { actionRef: string } }>; targetChoices: Array<{ targetIndex: number; handle: string }> };
      planCauseChoices?: { choices: Array<{ kind: string; ref: string }> };
      planningRelations?: { conditionDurations: Array<{ conditionProfileRef: string | null; durationProfileRef: string }> } } }).task;
    const worklist = task.planningWorklist;
    planningCalls++; physicalSizes.push(worklist.actions.length);
    const plans = worklist.actions.map((row, index) => ({ proposalKey: `plan-${row.action.actionRef.split(":").at(-1)}`, actionIndex: row.actionIndex,
      targetIndices: [worklist.targetChoices.find(target => target.handle === `ref:entity:${row.action.actionRef.split(":").at(-1)!.replace("act-", "")}`)!.targetIndex],
      means: [{ description: "Observe the courtyard", source: `m:${contentHash({ actionRef: row.action.actionRef, source: { kind: "action", ref: row.action.actionRef } }).slice(0, 12)}` }], factors: [], risk: "safe", primaryEffect: { kind: "condition", proposalKey: `effect-${row.action.actionRef.split(":").at(-1)}`, targetPosition: 0,
        channel: "attention", label: "Watching", description: "Remain alert while observing.", sourceRefs: [{ kind: "action", ref: row.action.actionRef }],
        conditionRef: { proposalKey: `effect-${row.action.actionRef.split(":").at(-1)}` }, access: { kind: "public" }, magnitude: "standard",
        ...(relations ? { conditionDurationIndex: task.planningRelations!.conditionDurations.findIndex(choice => choice.conditionProfileRef === null && choice.durationProfileRef === "ref:mechanic:brief") }
          : { conditionProfileRef: null, durationProfileRef: "ref:mechanic:brief" }) }, secondaryEffect: null, threatenedEffect: null,
      visibility: "full", mode: "automatic", difficulty: null, ...(relations ? { actorRatingPosition: null } : { actorRatingRef: null }),
      causes: [{ kind: "action", ref: planningCalls === 1 && index === 1 ? worklist.actions[0]!.action.actionRef : row.action.actionRef }] }));
    if (malformedCause) return { kind: "commit_plans", plans: plans.map((plan, index) => {
      const projected: Record<string, unknown> = { ...plan, causeIndices: [planningCalls === 1 && index === 1 ? 691
        : task.planCauseChoices!.choices.findIndex(choice => choice.kind === "action" && choice.ref === worklist.actions[index]!.action.actionRef)] };
      delete projected.causes; return projected;
    }) };
    return { kind: "commit_plans", plans: compact ? plans.map(plan => ["automatic", plan.actionIndex, plan.proposalKey, plan.targetIndices,
      plan.means.map(mean => [mean.source, mean.description]), plan.factors, plan.risk,
      { ...plan.primaryEffect, sourceRefs: plan.primaryEffect.sourceRefs.map(source => [source.kind, source.ref]) }, null, null, plan.visibility,
      plan.causes.map(source => [source.kind, source.ref]), {}]) : plans };
  }, undefined, false);
  const coordinator = new TruthBatchCoordinator(dependentFieldsProvider(indexedReviewedPlanningProvider(provider, false, false, malformedCause, false, false, relations, compact)), 12, 2, SHARED_BATCH_CONTEXT_CODEC, TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const logical: StructuredModelProvider = { catalog: provider.catalog, availableProfileSummaries: provider.availableProfileSummaries.bind(provider), assertProfilesAvailable: provider.assertProfilesAvailable.bind(provider),
    generateStructured: request => {
      if (request.role === "causal-verifier") {
        reviewedPlans = (request.context as { state: { candidateResolutionPlans: unknown[] } }).state.candidateResolutionPlans.length;
        throw new ModelConfigurationError("full candidate reached semantic review");
      }
      return coordinator.generateStructured(request);
    } };
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const actions = ["player", "keeper"].map(actorId => ({ id: `act-${actorId}`, actorId, baseRevision: state.revision, rawText: "Observe.", goal: "Observe", means: null, targetIds: [] }));
  const groundings = actions.map(action => ({ kind: "action" as const, id: action.id, actorId: action.actorId, reads: [], writes: [], audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false }));
  const before = contentHash({ state, actions, groundings });
  const engine = new TruthEngine(logical, { mechanicalPlanRepair: MECHANICAL_PLAN_REPAIR, includeResolutionMeansSources: true, includeActivityTemporalEvidence: true, includePlanCauseScope: malformedCause });
  await expect(engine.resolve({ definition, state, initialActions: actions, groundings, identityOwner: "joint-test",
    temporalBoundary: { fromElapsedSeconds: 0, toElapsedSeconds: 5, deltaSeconds: 5, reasons: [], dueActivityIds: [], dueTimerIds: [], dueConditionIds: [] },
    modelWorkset: { state, initialActions: actions, availableActions: actions, availableDependencies: groundings },
    resolutionScope: { mode: "component", selectedActionIds: actions.map(action => action.id), totalActionCount: actions.length }, renderObservations: async () => { throw new Error("unexpected observations"); },
    validateProposal: () => { throw new Error("unexpected transition"); },
  }, { workloadId: "test", batchId: "test", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } })).rejects.toThrow("full candidate reached semantic review");
  expect(physicalSizes).toEqual([2, 1]); expect(reviewedPlans).toBe(2);
  expect(contentHash({ state, actions, groundings })).toBe(before);
});
