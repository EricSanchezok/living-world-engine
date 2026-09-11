import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { PLAN_CAUSE_SCOPE } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { promptBundle } from "../../prompts";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { dependentFieldsRequest } from "../resolution-dependent-fields-codec";
import { factorTypesRequest } from "../resolution-factor-types";
import { planSelectorRequest } from "../plan-source-selectors";
import { flatPlanBatchRequest } from "../flat-resolution-plan-batch";
import { sourceBoundPlanChoicesRequest } from "../source-bound-plan-choices";
import { physicalPlanningWorklistRequest } from "../physical-planning-worklist";
import { sourceIndexedPlanningRequest } from "../source-indexed-planning";
import { sourceIndexedPlanCausesRequest } from "../source-indexed-plan-causes";
import { planningContractTailRequest } from "../planning-contract-tail";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";
import { PlanningRelationChoiceCodec, planningRelationChoicesRequest, PLANNING_RELATION_CHOICES } from "../planning-relation-choices";
import { createModelGateway } from "../../models/model-gateway";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { INDEXED_REVIEWED_PLANNING_PIPELINE } from "../indexed-reviewed-planning-pipeline";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";

type Value = Record<string, unknown>;
type Output = { kind: string; plans: Value[] };

function fixture(ids = ["a", "b"], empty = false) {
  const truth = {
    entities: Object.fromEntries(["a", "b"].map(id => [`ref:entity:${id}`, { name: id, lifecycle: "active" }])),
    ratings: empty ? {} : Object.fromEntries(["a", "b"].flatMap(id => ["resolve", "insight"].map((name, value) => [`ref:rating:${name}:${id}`, { entityRef: `ref:entity:${id}`, value, definitionId: name }]))),
    meters: empty ? {} : Object.fromEntries(["a", "b"].map(id => [`ref:meter:health:${id}`, { entityRef: `ref:entity:${id}`, current: 20, definitionId: "health" }])),
    mechanics: { impactProfiles: { harm: { id: "harm", meterDefinitionId: "health" }, recover: { id: "recover", meterDefinitionId: "health" }, incompatible: { id: "incompatible", meterDefinitionId: "energy" } },
      durationProfiles: { brief: { id: "brief" }, ongoing: { id: "ongoing" } },
      conditionProfiles: { watched: { id: "watched", defaultDurationProfileId: "brief" } } },
  };
  const entityRows = Object.keys(truth.entities).map(handle => ({ handle, kind: "entity", label: handle, allowedUses: ["target"] }));
  const ratedRows = Object.keys(truth.ratings).map(handle => ({ handle, kind: "rating", label: handle, allowedUses: ["modifier", "source"] }));
  const meterRows = Object.keys(truth.meters).map(handle => ({ handle, kind: "meter", label: handle, allowedUses: ["source"] }));
  const mechanicRows = Object.entries(truth.mechanics).flatMap(([collection, rows]) => Object.keys(rows).map(id => ({ handle: `ref:mechanic:${id}`, kind: "mechanic", label: id, allowedUses: ["mechanic"], statePath: `state.truth.mechanics.${collection}.${id}` })));
  const contexts = ids.map(id => ({ task: { planCauseScope: { contract: PLAN_CAUSE_SCOPE, actionRefs: [`ref:action:${id}`] } },
    state: { canonicalTruth: structuredClone(truth), actors: [{ agentRef: `ref:agent:${id}`, entityRef: `ref:entity:${id}` }], actionSet: {
      assigned: [{ actionRef: `ref:action:${id}`, actorRef: `ref:agent:${id}`, rawText: "观察对方，等他明确同意才继续。", goal: "Wait for explicit consent", allowedMeansSources: [{ kind: "action", ref: `ref:action:${id}` }] }], available: [] } },
    referenceCatalog: { candidates: [...entityRows, ...ratedRows.filter(row => id === "b" || row.handle !== "ref:rating:insight:b"), ...meterRows, ...mechanicRows,
      { handle: `ref:action:${id}`, kind: "action", label: id, allowedUses: ["cause", "source"] }] },
  }));
  const shared = ids.length > 1, prompt = promptBundle("truth-resolution");
  const original: StructuredModelRequest<unknown> = { profileId: "truth-deepseek", workloadId: "relations", batchId: "relations", role: "truth-resolution", subjectId: "relations",
    schemaName: shared ? "truth_resolution_plan_commit_batch" : "truth_resolution_plan_commit",
    schema: shared ? z.strictObject({ slots: z.array(z.strictObject({ slot: z.number(), result: resolutionPlanCommitDirectiveSchema })) }) : resolutionPlanCommitDirectiveSchema,
    promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt + (shared ? `\n${SHARED_SLOT_RESULT_INSTRUCTION}` : ""),
    context: shared ? { state: factorSharedBatchContexts(contexts, "shared-json-v3"), task: { slots: ids.map((_, slot) => ({ slot })) } } : contexts[0]!,
  };
  const selected = planSelectorRequest(factorTypesRequest(dependentFieldsRequest(original)));
  const indexed = sourceIndexedPlanningRequest(physicalPlanningWorklistRequest(sourceBoundPlanChoicesRequest(shared ? flatPlanBatchRequest(selected) : selected)), true);
  const request = planningContractTailRequest(sourceIndexedPlanCausesRequest(indexed));
  const codec = new PlanningRelationChoiceCodec(request.context), candidate = planningRelationChoicesRequest(request);
  const causeChoices = (request.context as { task: { planCauseChoices: { choices: Array<{ ref: string }> } } }).task.planCauseChoices.choices;
  const source: Output = { kind: "commit_plans", plans: ids.map((id, actionIndex) => ({ proposalKey: `plan-${id}`, actionIndex, targetIndices: [codec.targets.findIndex(row => row.targetRef === `ref:entity:${id}`)],
    means: [{ description: "Observe and wait for explicit consent", sourcePosition: 0 }], factors: [], mode: "automatic", difficulty: null, actorRatingRef: null,
    risk: "safe", primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causeIndices: [causeChoices.findIndex(row => row.ref === `ref:action:${id}`)] })) };
  return { request, candidate, codec, source };
}

function condition(targetPosition = 0): Value {
  return { kind: "condition", proposalKey: "effect", targetPosition, channel: "attention", label: "Observing", description: "Maintain observation until consent; do not complete the requested interaction.",
    sourceRefs: [{ kind: "action", ref: "ref:action:a" }], conditionRef: { proposalKey: "effect" }, conditionProfileRef: null,
    durationProfileRef: "ref:mechanic:ongoing", access: { kind: "public" }, magnitude: "standard" };
}

it.each([["a", "b"], ["b"]])("round trips complete or narrowed responsibility with all legal relation combinations (%j)", (...ids) => {
  const { source, codec, request, candidate } = fixture(ids);
  expect(codec.restoreContext()).toEqual(request.context);
  const action = codec.actions[0]!, target = codec.targets.find(row => row.ratings.some(rating => rating.slots.includes(action.slot)))!;
  const cases: Output[] = [source];
  for (const rating of [null, ...action.ratings]) for (const opposed of target.ratings.filter(row => row.slots.includes(action.slot))) {
    const value = structuredClone(source), plan = value.plans[0]!;
    plan.targetIndices = [target.targetIndex, target.targetIndex];
    plan.actorRatingRef = rating?.ratingRef ?? null;
    plan.difficulty = { kind: "opposed", targetRef: target.targetRef, ratingRef: opposed.ratingRef, source: { kind: "rating", ref: opposed.ratingRef } };
    plan.mode = "check"; plan.primaryEffect = condition(1); plan.threatenedEffect = Object.fromEntries(Object.entries(condition(1)).filter(([key]) => key !== "magnitude"));
    cases.push(value);
  }
  for (const target of codec.targets) for (const pair of target.meterEffects.filter(row => row.slots.includes(action.slot))) {
    const value = structuredClone(source), plan = value.plans[0]!; plan.targetIndices = [target.targetIndex];
    plan.primaryEffect = { kind: "meter", proposalKey: "effect", targetPosition: 0, channel: "health", label: "Recover", description: "Recover the selected target's health.",
      sourceRefs: [{ kind: "action", ref: action.actionRef }], meterRef: pair.meterRef, impactProfileRef: pair.impactProfileRef, magnitude: "minor" };
    cases.push(value);
  }
  for (const pair of codec.conditionDurations.filter(row => row.slots.includes(action.slot))) {
    const value = structuredClone(source); value.plans[0]!.primaryEffect = { ...condition(), conditionProfileRef: pair.conditionProfileRef, durationProfileRef: pair.durationProfileRef }; cases.push(value);
  }
  expect(cases.length).toBeGreaterThan(10);
  for (const value of cases) {
    const before = contentHash(value), wire = codec.encode(value);
    expect(codec.decode(wire)).toEqual(value); expect(contentHash(value)).toBe(before);
    expect(z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(wire).success).toBe(true);
    expect(candidate.preprocessOutput!(wire)).toEqual(request.preprocessOutput!(value));
    expect(candidate.schema.safeParse(candidate.preprocessOutput!(wire).value).success).toBe(true);
  }
  expect(codec.targets.flatMap(row => row.meterEffects).some(row => row.impactProfileRef === "ref:mechanic:incompatible")).toBe(false);
  expect(codec.conditionDurations).toHaveLength(3);
});

it("preserves empty numeric domains, null ratings and unrestricted authored durations for open conditions", () => {
  const { source, codec, candidate } = fixture(["a"], true);
  expect(codec.actions[0]!.ratings).toEqual([]); expect(codec.targets.every(row => !row.ratings.length && !row.meterEffects.length)).toBe(true);
  source.plans[0]!.primaryEffect = condition();
  const wire = codec.encode(source);
  expect(candidate.schema.safeParse(candidate.preprocessOutput!(wire).value).success).toBe(true);
  expect(codec.decode(wire)).toEqual(source);
});

it("rejects mismatched source combinations and cross-slot choices while retaining independent valid slots", () => {
  const { source, codec, candidate } = fixture();
  for (const patch of [
    { actorRatingRef: "ref:rating:resolve:b" },
    { difficulty: { kind: "opposed", targetRef: "ref:entity:b", ratingRef: "ref:rating:resolve:b" } },
    { primaryEffect: { ...condition(), kind: "meter", meterRef: "ref:meter:health:b", impactProfileRef: "ref:mechanic:harm" } },
    { primaryEffect: { ...condition(), conditionProfileRef: "ref:mechanic:watched", durationProfileRef: "ref:mechanic:ongoing" } },
  ]) { const wrong = structuredClone(source); Object.assign(wrong.plans[0]!, patch); expect(() => codec.encode(wrong)).toThrow(); }
  const wire = codec.encode(source) as Output;
  const target = codec.targets.find(row => row.targetRef === "ref:entity:b")!;
  const invalids: Value[] = [
    { actorRatingPosition: -1 }, { actorRatingPosition: "0" }, { actorRatingRef: null },
    { difficulty: { kind: "opposed", targetPosition: 1, opposedRatingPosition: 0 } },
    { targetIndices: [target.targetIndex], difficulty: { kind: "opposed", targetPosition: 0, opposedRatingPosition: target.ratings.findIndex(row => row.ratingRef === "ref:rating:insight:b") } },
  ];
  for (const patch of invalids) {
    const wrong = structuredClone(wire); Object.assign(wrong.plans[0]!, patch);
    const result = candidate.preprocessOutput!(wrong).value as { slots: Array<{ slot: number; result: unknown }> };
    expect(candidate.schema.safeParse(result).success).toBe(false);
    expect(resolutionPlanCommitDirectiveSchema.safeParse(result.slots.find(row => row.slot === 1)!.result).success).toBe(true);
    expect(JSON.stringify(result)).toContain("invalidPlanningRelation");
  }
});

it("binds source, menus and repair vocabulary and preserves semantic prose without automatic correction", () => {
  const { source, codec, request } = fixture();
  source.plans[0]!.primaryEffect = { ...condition(), description: "An intentionally unsupported claim remains visible for the existing semantic reviewer." };
  expect(codec.decode(codec.encode(source))).toEqual(source);
  expect(() => codec.decode(codec.encode(source), "another-request")).toThrow("binding changed");
  const mutated = new PlanningRelationChoiceCodec(request.context); mutated.targets.reverse();
  expect(() => mutated.encode(source)).toThrow("binding changed");
  (request.context as { task: Value }).task.changed = true;
  expect(() => codec.encode(source)).toThrow("binding changed");
  const next = fixture(["b"]); expect(next.codec.actions[0]!.actionRef).toBe("ref:action:b");
  expect(next.codec.bindingHash).not.toBe(codec.bindingHash);
});

it("passes the actual HTTP schema and existing decoders and registers only an explicit candidate", async () => {
  const { source, codec, candidate } = fixture();
  const catalog = createTestModelCatalog(["truth-deepseek"]), bodies: string[] = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ id: "relations", model: "scripted:truth-deepseek",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(codec.encode(source)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const result = await gateway.generateStructured({ ...candidate, runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 } });
  expect(result.value).toEqual(candidate.schema.parse(candidate.preprocessOutput!(codec.encode(source)).value));
  expect(bodies).toHaveLength(1); expect(bodies[0]).toContain("planningRelations"); expect(bodies[0]).toContain("conditionDurationIndex");
  expect(candidate.jsonObjectPostlude).toContain("Planning relation choices");
  const ref = stepEfficiencyAlgorithmRef({ sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1", planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE, planningRelationChoices: true });
  expect(registerBuiltinAlgorithms().has(ref)).toBe(true); expect(ref.children.truthResolution!.config.planningRelationChoices).toBe(PLANNING_RELATION_CHOICES);
  expect(() => stepEfficiencyAlgorithmRef({ planningRelationChoices: true })).toThrow("indexed reviewed");
});
