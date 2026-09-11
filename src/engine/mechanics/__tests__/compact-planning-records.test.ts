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
import { PlanningRelationChoiceCodec, planningRelationChoicesRequest } from "../planning-relation-choices";
import { createModelGateway } from "../../models/model-gateway";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { INDEXED_REVIEWED_PLANNING_PIPELINE } from "../indexed-reviewed-planning-pipeline";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";

import { CompactPlanningRecordCodec, compactPlanningRecordsRequest, COMPACT_PLANNING_RECORDS } from "../compact-planning-records";

type Value = Record<string, unknown>;
type Output = { kind: string; plans: Value[] };

function fixture(ids = ["a", "b"], relations = false) {
  const truth = {
    entities: Object.fromEntries(["a", "b"].map(id => [`ref:entity:${id}`, { name: id, lifecycle: "active" }])),
    ratings: Object.fromEntries(["a", "b"].flatMap(id => ["resolve", "insight"].map((name, value) => [`ref:rating:${name}:${id}`, { entityRef: `ref:entity:${id}`, value, definitionId: name }]))),
    meters: Object.fromEntries(["a", "b"].map(id => [`ref:meter:health:${id}`, { entityRef: `ref:entity:${id}`, current: 20, definitionId: "health" }])),
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
  const inputRequest = relations ? candidate : request;
  const input = relations ? codec.encode(source) as Output : source;
  return { request: inputRequest, source: input, codec: new CompactPlanningRecordCodec(inputRequest.wireJsonSchema!), candidate: compactPlanningRecordsRequest(inputRequest) };
}

it.each([false, true])("round trips complete and narrowed indexed sources with unchanged canonical results (relations=%s)", relations => {
  for (const ids of [["a", "b"], ["b"]]) {
    const { source, request, codec, candidate } = fixture(ids, relations);
    const before = contentHash({ source, context: request.context });
    const wire = codec.encode(source) as { plans: unknown[][] };
    expect(wire.plans.map(row => row.slice(0, 2))).toEqual(ids.map((_, index) => ["automatic", index]));
    expect(codec.decode(wire)).toEqual(source);
    expect(z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(wire).success).toBe(true);
    expect(candidate.preprocessOutput!(wire)).toEqual(request.preprocessOutput!(source));
    expect(candidate.schema.safeParse(candidate.preprocessOutput!(wire).value).success).toBe(true);
    expect(contentHash({ source, context: request.context })).toBe(before);
  }
});

function effect(): Value {
  return { kind: "condition", proposalKey: "effect", targetPosition: 1, channel: "attention", label: "Observing", description: "等待明确同意，保持观察；不宣称已经完成。",
    sourceRefs: [{ kind: "action", ref: "ref:action:a" }], conditionRef: { proposalKey: "effect" }, conditionProfileRef: null,
    durationProfileRef: "ref:mechanic:ongoing", access: { kind: "public" }, magnitude: "standard" };
}

it.each(["automatic", "check", "blocked"].flatMap(mode => [false, true].map(optional => ({ mode, optional }))))(
  "preserves nested sources, repetitions and every factor alternative (mode=$mode, optional=$optional)", ({ mode, optional }) => {
  const { source, codec, request } = fixture();
  const branches = ((request.wireJsonSchema!.properties as Value).plans as Value).items as { oneOf: Array<{ properties: Value }> };
  const factorAlternatives = (branches.oneOf[0]!.properties.factors as { items: { oneOf: Array<{ oneOf: Array<{ properties: Record<string, { const?: unknown; enum?: unknown[]; minimum?: number }> }> }> } }).items.oneOf.flatMap(group => group.oneOf);
  const value = structuredClone(source), plan = value.plans[0]!;
  plan.mode = mode; plan.targetIndices = [0, 0];
  plan.means = [{ sourcePosition: 0, description: "Keep every condition, quotation and Unicode character: ‘同意后再行动’" }, { sourcePosition: 0, description: "Repeated sources remain repeated." }];
  if (mode !== "blocked") plan.primaryEffect = effect();
  if (mode === "check") {
    plan.difficulty = { kind: "opposed", targetRef: "ref:entity:a", ratingRef: "ref:rating:resolve:a", source: { kind: "rating", ref: "ref:rating:resolve:a" } };
    plan.actorRatingRef = "ref:rating:insight:a";
    plan.threatenedEffect = Object.fromEntries(Object.entries(effect()).filter(([key]) => key !== "magnitude"));
  }
  if (optional) plan.baseEffect = mode === "blocked" ? "none" : "standard";
  for (const alternative of factorAlternatives) {
    const fields = alternative.properties;
    plan.factors = [{ factorType: fields.factorType!.const, source: { kind: "rating", ref: "ref:rating:insight:a" }, channel: fields.channel!.const ?? "attention", explanation: "An unsupported semantic assertion is retained for the real reviewer.",
      ...(fields.direction ? { direction: fields.direction.enum![0] } : {}), ...(fields.steps ? { steps: fields.steps.minimum ?? 1 } : {}) }];
    const wire = codec.encode(value);
    expect(codec.decode(wire)).toEqual(value);
    expect(request.preprocessOutput!(codec.decode(wire))).toEqual(request.preprocessOutput!(value));
  }
});

it("rejects malformed columns and required check effects while preserving independent valid slots", () => {
  const { source, codec, candidate } = fixture();
  const wire = codec.encode(source) as { plans: unknown[][] };
  for (const mutate of [
    (row: unknown[]) => row.pop(), (row: unknown[]) => row.push("extra"),
    (row: unknown[]) => { row[0] = "check"; }, (row: unknown[]) => { row[0] = "invented"; },
    (row: unknown[]) => { row[4] = [{ sourcePosition: 0, description: "wrong representation" }]; },
    (row: unknown[]) => { (row.at(-1) as Value).actorRatingRef = "ref:rating:insight:a"; },
  ]) {
    const wrong = structuredClone(wire); mutate(wrong.plans[0]!);
    const result = candidate.preprocessOutput!(wrong).value as { slots: Array<{ slot: number; result: unknown }> };
    expect(candidate.schema.safeParse(result).success).toBe(false);
    expect(JSON.stringify(result.slots[0])).toContain("invalidCompactPlanningRecord");
    expect(resolutionPlanCommitDirectiveSchema.safeParse(result.slots[1]!.result).success).toBe(true);
  }
  expect(() => codec.decode({ kind: "commit_plans", plans: [source.plans[0]] })).toThrow("action identity");
  const wrong = structuredClone(source); wrong.plans[0]!.mode = "check";
  expect(() => codec.encode(wrong)).toThrow("source batch");
});

it("binds source and schema, rejects duplicate and missing action identities through the original decoder", () => {
  const { source, codec, candidate } = fixture();
  const wire = codec.encode(source) as { plans: unknown[][] };
  const duplicate = structuredClone(wire); duplicate.plans[1]![1] = 0;
  expect(() => candidate.preprocessOutput!(duplicate)).toThrow("duplicate actionIndex");
  expect(() => candidate.preprocessOutput!({ kind: "commit_plans", plans: [wire.plans[0]] })).toThrow("missing actionIndex");
  expect(() => compactPlanningRecordsRequest(candidate)).toThrow("exactly once");
  (candidate.context as Value).changed = true;
  expect(() => candidate.preprocessOutput!(wire)).toThrow("context changed");
  codec.schema.changed = true;
  expect(() => codec.decode(wire)).toThrow("schema changed");
});

it("uses the actual gateway wire and registers an explicit candidate without changing defaults", async () => {
  const { source, codec, candidate } = fixture();
  const catalog = createTestModelCatalog(["truth-deepseek"]), bodies: string[] = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ id: "compact", model: "scripted:truth-deepseek",
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(codec.encode(source)) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } }); } });
  const result = await gateway.generateStructured({ ...candidate, runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 } });
  expect(result.value).toEqual(candidate.schema.parse(candidate.preprocessOutput!(codec.encode(source)).value));
  expect(bodies).toHaveLength(1); expect(bodies[0]).toContain("Columns: mode, actionIndex");
  expect(candidate.jsonObjectPostlude!.endsWith("Keep complete action coverage and all original validation rules.")).toBe(true);
  const config = { sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1", planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE } as const;
  const before = stepEfficiencyAlgorithmRef(config), ref = stepEfficiencyAlgorithmRef({ ...config, compactPlanningRecords: true });
  expect(registerBuiltinAlgorithms().has(ref)).toBe(true); expect(ref.children.truthResolution!.config.compactPlanningRecords).toBe(COMPACT_PLANNING_RECORDS);
  expect(before.children.truthResolution!.config.compactPlanningRecords).toBeUndefined();
  expect(() => stepEfficiencyAlgorithmRef({ compactPlanningRecords: true })).toThrow("indexed reviewed");
});
