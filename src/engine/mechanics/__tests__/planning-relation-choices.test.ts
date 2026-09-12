import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { PLAN_CAUSE_SCOPE } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import { ModelOutputError, ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
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

import { RatingOwnedOppositionCodec, ratingOwnedOppositionRequest } from "../../benchmarks/step-efficiency/rating-owned-opposition";
import { dependentFieldsProvider } from "../resolution-dependent-fields-codec";
import { indexedReviewedPlanningProvider } from "../indexed-reviewed-planning-pipeline";
import { planningCatalogEncodingProvider, planningCatalogEncodingRequest } from "../planning-catalog-encoding";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { actionTextCopies, MeansTextCopyCodec, meansTextCopiesRequest } from "../../benchmarks/step-efficiency/means-text-copies";

type Value = Record<string, unknown>;
type Output = { kind: string; plans: Value[] };

function fixture(ids = ["a", "b"], empty = false, actionTexts: Record<string, string> = {}) {
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
      assigned: [{ actionRef: `ref:action:${id}`, actorRef: `ref:agent:${id}`, rawText: actionTexts[id] ?? "观察对方，等他明确同意才继续。", goal: "Wait for explicit consent", allowedMeansSources: [{ kind: "action", ref: `ref:action:${id}` }] }], available: [] } },
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
  return { request, candidate, codec, source, contexts, original };
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


function ratingFixture(ids = ["a", "b"], empty = false) {
  const base = fixture(ids, empty);
  return { ...base, request: planningCatalogEncodingRequest(base.request) };
}

it("round trips every eligible flat rating owner without completing invalid explicit choices", () => {
  const { source, request, codec: hierarchy } = ratingFixture();
  const codec = new RatingOwnedOppositionCodec(request.context), candidate = ratingOwnedOppositionRequest(request);
  expect(codec.owners).toHaveLength(4);
  expect(codec.owners.find(row => row.ratingRef === "ref:rating:insight:b")!.slots).toEqual([1]);
  for (const owner of codec.owners) for (const slot of owner.slots) {
    const value = structuredClone(source), plan = value.plans[slot]!;
    const index = hierarchy.targets.findIndex(target => target.targetRef === owner.entityRef);
    plan.targetIndices = [index, index]; plan.mode = "check";
    plan.difficulty = { kind: "opposed", targetRef: owner.entityRef, ratingRef: owner.ratingRef };
    plan.primaryEffect = condition(1); plan.threatenedEffect = { ...Object.fromEntries(Object.entries(condition(1)).filter(([key]) => key !== "magnitude")), proposalKey: "threat", conditionRef: { proposalKey: "threat" } };
    const before = contentHash(value), encoded = codec.encode(value) as Output;
    expect(encoded.plans[slot]!.difficulty).toHaveProperty("targetRef", null);
    expect(codec.decode(encoded)).toEqual(value); expect(contentHash(value)).toBe(before);
    expect(candidate.preprocessOutput!(encoded)).toEqual(request.preprocessOutput!(value));
    candidate.schema.parse(candidate.preprocessOutput!(encoded).value);
  }
  const bad = structuredClone(source); bad.plans[0]!.difficulty = { kind: "opposed", ratingRef: "ref:rating:resolve:a", targetRef: "ref:entity:b" };
  expect(codec.decode(codec.encode(bad))).toEqual(bad);
  const historical = { repair: { previousOutput: { kind: "commit_plans", plans: [{ actionIndex: 0, difficulty: { kind: "opposed", ratingRef: "ref:rating:resolve:a", targetRef: null } }] } } };
  expect(codec.decode(historical)).toEqual(historical);
  for (const difficulty of [{ kind: "environment", band: "easy", source: { kind: "fact", ref: "ref:fact:terrain" } },
    { kind: "opposed", ratingRef: "ref:rating:resolve:a" }, { kind: "opposed", ratingRef: "ref:rating:missing", targetRef: null },
    { kind: "opposed", ratingRef: "ref:rating:insight:b", targetRef: null }]) {
    const value = structuredClone(source); value.plans[0]!.difficulty = difficulty;
    expect(codec.decode(value)).toEqual(value);
  }
  const empty = ratingFixture(["a", "b"], true), emptyCodec = new RatingOwnedOppositionCodec(empty.request.context);
  expect(emptyCodec.owners).toEqual([]); expect(emptyCodec.decode(empty.source)).toEqual(empty.source);
  expect(ratingOwnedOppositionRequest(empty.request).schema).toBe(empty.request.schema);
});

it("binds opposed ownership projection and schemas to their complete source", () => {
  for (const field of ["ratingRef", "entityRef", "value", "slots"]) {
    const { request, source } = ratingFixture(), codec = new RatingOwnedOppositionCodec(request.context);
    (codec.owners[0] as unknown as Value)[field] = "changed";
    expect(() => codec.decode(source)).toThrow("projection changed");
  }
  const { request, source } = ratingFixture(), candidate = ratingOwnedOppositionRequest(request);
  expect(() => ratingOwnedOppositionRequest(candidate)).toThrow("already applied");
  candidate.wireJsonSchema!.changed = true;
  expect(() => candidate.preprocessOutput!(source)).toThrow("wire schema changed");
  const next = ratingFixture(), other = ratingOwnedOppositionRequest(next.request);
  (next.request.context as { task: Value }).task.changed = true;
  expect(() => other.preprocessOutput!(next.source)).toThrow("source or ownership");
  expect(() => ratingOwnedOppositionRequest({ ...ratingFixture().request, system: "unrelated" })).toThrow("representation contract");
});

it.each(["rating", "copy"].flatMap(kind => [false, true].map(bad => ({ kind, bad }))))("retains full batching, temporal scope and valid neighbors ($kind, $bad)", async ({ kind, bad }) => {
  const base = fixture(), catalog = createTestModelCatalog(["truth-deepseek"], { maxInputBytes: 4_000_000 });
  let output: unknown; const bodies: unknown[] = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "rating-owned", model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } });
    } });
  const sink = { ...gateway, availableProfileSummaries: () => [], assertProfilesAvailable: async () => {}, generateStructured: async <T,>(request: StructuredModelRequest<T>) => {
    const candidate = kind === "rating" ? ratingOwnedOppositionRequest(request) : meansTextCopiesRequest(request);
    const raw = structuredClone(base.source), plan = raw.plans[0]!;
    if (kind === "rating") {
      plan.mode = "check"; plan.primaryEffect = condition();
      plan.threatenedEffect = { ...Object.fromEntries(Object.entries(condition()).filter(([key]) => key !== "magnitude")), proposalKey: "threat", conditionRef: { proposalKey: "threat" } };
      plan.difficulty = { kind: "opposed", ratingRef: bad ? "ref:rating:insight:b" : "ref:rating:resolve:a", targetRef: null };
    } else plan.means = [{ description: { copy: bad ? 999 : 0 }, sourcePosition: 0 }];
    output = raw;
    return gateway.generateStructured(candidate);
  } };
  const provider = dependentFieldsProvider(indexedReviewedPlanningProvider(planningCatalogEncodingProvider(sink), false, false, true, true, true));
  const coordinator = new TruthBatchCoordinator({ ...provider, generateStructured: async request => {
    try { return await provider.generateStructured(request); }
    catch (error) { if (error instanceof ModelOutputError) throw error; throw new ModelConfigurationError(String(error)); }
  } }, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
  const prompt = promptBundle("truth-resolution");
  const results = await Promise.allSettled(base.contexts.map((context, slot) => coordinator.generateStructured({ ...base.original,
    schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
    context: { ...context, contractVersion: 17, execution: { worldId: "world", instanceId: "test", advanceId: "test", revision: 0, step: 0 },
      roleContract: { role: "truth-resolution", purpose: "test", modelOwns: [], engineOwns: [], existingReferenceRule: "", proposalRule: "", failureRule: "" },
      referenceCatalog: { ...context.referenceCatalog, version: 2, hash: "test" }, repair: null },
    system: prompt.system, userPrompt: prompt.userPrompt, subjectId: `source-${slot}`, profileId: "truth-deepseek", runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 } })));
  if (!bodies.length && results[0]?.status === "rejected") throw results[0].reason;
  expect(bodies).toHaveLength(1); expect(JSON.stringify(bodies).includes("do not propose future task-completion effects before their prerequisites hold.")).toBe(true);
  expect(results[1]!.status).toBe("fulfilled"); expect(results[0]!.status).toBe(bad ? "rejected" : "fulfilled");
  if (bad) {
    const rejected = (results[0] as PromiseRejectedResult).reason as ModelOutputError;
    expect(rejected).toBeInstanceOf(ModelOutputError); expect(JSON.stringify(rejected.rawValue)).toContain(kind === "rating" ? "ref:rating:insight:b" : '"copy":999');
  } else if (kind === "copy") {
    expect(JSON.stringify((results[0] as PromiseFulfilledResult<unknown>).value)).toContain(base.contexts[0]!.state.actionSet.assigned[0]!.rawText);
  }
});

it("retains exact authored text, punctuation, Unicode and provenance for copy choices", () => {
  const rawText = " 👩🏽‍🚀先观察；若门没开，就继续等。\n不要进入！  ";
  const action = { rawText, goal: rawText, means: "Only ask; never force entry." }, copies = actionTextCopies(action);
  expect(copies[0]!.text).toBe(rawText);
  expect(copies[0]!.sources.map(row => row.field)).toEqual(["rawText", "goal"]);
  for (const copy of copies) for (const source of copy.sources) expect(action[source.field].slice(source.start, source.end)).toBe(copy.text);
  expect(copies.some(copy => copy.text === "若门没开，就继续等。\n")).toBe(true);
  expect(copies.some(copy => copy.text === action.means)).toBe(true);
  expect(new Set(copies.map(copy => copy.text)).size).toBe(copies.length);
  expect(actionTextCopies({ rawText: "A", goal: "B", means: null }).map(copy => copy.text)).toEqual(["A", "B"]);
});

it("round trips every copy, preserves free text and rejects malformed copying without repairing it", () => {
  const { request, source } = ratingFixture(), codec = new MeansTextCopyCodec(request.context), candidate = meansTextCopiesRequest(request);
  for (const action of codec.actions) for (const copy of action.copies) {
    const raw = structuredClone(source); raw.plans[action.actionIndex]!.means = [{ description: copy.text, sourcePosition: 0 }, { description: copy.text, sourcePosition: 0 }];
    const hash = contentHash(raw), encoded = codec.encode(raw);
    expect(codec.decode(encoded)).toEqual(raw); expect(contentHash(raw)).toBe(hash);
    expect(candidate.preprocessOutput!(encoded)).toEqual(request.preprocessOutput!(raw));
    candidate.schema.parse(candidate.preprocessOutput!(encoded).value);
  }
  expect(codec.decode(codec.encode(source))).toEqual(source);
  const historical = { repair: { previousOutput: { kind: "commit_plans", plans: [{ actionIndex: 0, means: [{ description: { copy: 0 } }] }] } } };
  expect(codec.decode(historical)).toEqual(historical);
  for (const description of [{ copy: -1 }, { copy: 999 }, { copy: 0.5 }, { copy: "0" }, { copy: null }, {}, { copy: 0, text: "extra" }, { copy: 0, actionIndex: 1 }]) {
    const raw = structuredClone(source); raw.plans[0]!.means = [{ description, sourcePosition: 0 }];
    expect(codec.decode(raw)).toEqual(raw);
    expect(candidate.schema.safeParse(candidate.preprocessOutput!(raw).value).success).toBe(false);
  }
});

it("binds copies to original assigned actions, projected text and outgoing schema", () => {
  const distinct = fixture(["a", "b"], false, { a: "Wait outside.", b: "Ask before opening." });
  const local = new MeansTextCopyCodec(planningCatalogEncodingRequest(distinct.request).context);
  const selected = structuredClone(distinct.source);
  selected.plans.forEach(plan => { plan.means = [{ description: { copy: 0 }, sourcePosition: 0 }]; });
  const restored = local.decode(selected) as Output;
  expect((restored.plans[0]!.means as Value[])[0]!.description).toBe("Wait outside.");
  expect((restored.plans[1]!.means as Value[])[0]!.description).toBe("Ask before opening.");
  const { request, source } = ratingFixture(), codec = new MeansTextCopyCodec(request.context);
  codec.actions[0]!.copies[0]!.text = "changed";
  expect(() => codec.decode(source)).toThrow("projection changed");
  const next = ratingFixture(), candidate = meansTextCopiesRequest(next.request);
  expect(() => meansTextCopiesRequest(candidate)).toThrow("already applied");
  candidate.wireJsonSchema!.changed = true;
  expect(() => candidate.preprocessOutput!(next.source)).toThrow("wire schema changed");
  const third = ratingFixture(), bound = meansTextCopiesRequest(third.request);
  (third.request.context as { task: Value }).task.changed = true;
  expect(() => bound.preprocessOutput!(third.source)).toThrow("source or text projection");
});
