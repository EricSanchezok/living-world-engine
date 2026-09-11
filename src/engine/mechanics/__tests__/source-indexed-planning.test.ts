import { expect, it } from "vitest";
import { PLAN_CAUSE_SCOPE } from "../../contracts/prompts";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset, promptBundle } from "../../prompts";
import { dependentFieldsRequest } from "../resolution-dependent-fields-codec";
import { factorTypesRequest } from "../resolution-factor-types";
import { flatPlanBatchRequest } from "../flat-resolution-plan-batch";
import { planSelectorRequest } from "../plan-source-selectors";
import { sourceBoundPlanChoicesRequest } from "../source-bound-plan-choices";
import { physicalPlanningWorklistRequest } from "../physical-planning-worklist";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";
import { assertIndexedPlanningContext, decodeIndexedPlans, encodeIndexedPlans, indexPlanningContext,
  planningIndexDomain, sourceIndexedPlanningRequest, withoutPlanningIndices, SOURCE_INDEXED_PLAN_MEANS } from "../source-indexed-planning";
import { SourceIndexedPlanCauseCodec, sourceIndexedPlanCausesRequest, SOURCE_INDEXED_PLAN_CAUSES } from "../source-indexed-plan-causes";
import { indexedReviewedPlanningProvider, INDEXED_REVIEWED_PLANNING_PIPELINE } from "../indexed-reviewed-planning-pipeline";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";
import { ScriptedModelProvider } from "../../testing/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { parseModelCatalog } from "../../models/model-catalog";
import { createModelGateway } from "../../models/model-gateway";
import { planningContractTailRequest, PLANNING_CONTRACT_TAIL } from "../planning-contract-tail";
import { declaredRandomPlanSchema, PLAN_RANDOM_COMPLETION_PROMPT } from "../plan-random-completion";

it.each([true, false])("binds the planning tail to the current root or narrowed repair worklist (%s)", shared => {
  const { request, source, domain } = fixture(shared, false, true);
  const selected = sourceIndexedPlanCausesRequest(request), tail = planningContractTailRequest(selected);
  expect(tail.context).toBe(selected.context);
  expect(tail.schema).toBe(selected.schema);
  expect(tail.wireJsonSchema).toBe(selected.wireJsonSchema);
  expect(tail.userPrompt).toBe(selected.userPrompt);
  expect(tail.system).toBe(selected.system);
  expect(tail.jsonObjectPostlude).toContain(JSON.stringify({ requiredPlanCount: shared ? 2 : 1, requiredActionIndices: shared ? [0, 1] : [0] }));
  expect(tail.jsonObjectPostlude).toContain("distinction between acting personally, directing another person");
  expect(tail.promptVersion).toContain(PLANNING_CONTRACT_TAIL);
  const wire = new SourceIndexedPlanCauseCodec(request.context).encode(encodeIndexedPlans(source, domain));
  expect(tail.preprocessOutput!(wire)).toEqual(selected.preprocessOutput!(wire));
  expect(() => planningContractTailRequest(tail)).toThrow("already applied");
  const drift = structuredClone(selected.context) as { task: { planCauseChoices: { choices: unknown[] } } };
  drift.task.planCauseChoices.choices.reverse();
  expect(() => planningContractTailRequest({ ...selected, context: drift })).toThrow("binding changed");
  expect(() => planningContractTailRequest(sourceIndexedPlanCausesRequest(fixture().request))).toThrow("means positions");
});

it("renders and accounts for the planning tail after the actual HTTP schema, rejecting unsupported modes", async () => {
  const { request, source, domain } = fixture(true, false, true);
  const selected = sourceIndexedPlanCausesRequest(request), candidate = planningContractTailRequest(selected);
  const wire = new SourceIndexedPlanCauseCodec(request.context).encode(encodeIndexedPlans(source, domain));
  const base = createTestModelCatalog(["truth-deepseek"]), profile = base.profile("truth-deepseek");
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: base.scheduler, registry: base.registry, accounts: base.accounts,
    model_overrides: {}, profiles: { "truth-deepseek": { ...profile, inference: { ...profile.inference, thinking: "disabled" } } } });
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "tail-test", model: "scripted:truth-deepseek", choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(wire) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const scope = { profileId: "truth-deepseek", runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 } };
  const before = await gateway.generateStructured({ ...selected, ...scope }), after = await gateway.generateStructured({ ...candidate, ...scope });
  expect(after.value).toEqual(before.value);
  expect(bodies[1]!.messages[1]!.content).toBe(bodies[0]!.messages[1]!.content + candidate.jsonObjectPostlude);
  expect(bodies[1]!.messages[1]!.content.lastIndexOf("Final physical planning contract")).toBeGreaterThan(bodies[1]!.messages[1]!.content.indexOf("JSON Schema:"));
  expect(after.audit.invocations[0]!.requestUtf8Bytes).toBeGreaterThan(before.audit.invocations[0]!.requestUtf8Bytes);
  expect(after.audit.invocations[0]!.requestHash).not.toBe(before.audit.invocations[0]!.requestHash);
  await expect(gateway.generateStructured({ ...candidate, ...scope, structuredOutputMode: "json-schema-strict" })).rejects.toThrow();
  expect(bodies).toHaveLength(2);
});

function fixture(shared = true, emptyTargets = false, indexMeans = false, scopeTransform?: (context: Record<string, unknown>) => void, declarations = false) {
  const ids = shared ? ["a", "b"] : ["b"];
  const contexts = ids.map(id => ({ task: { constraints: ["Wait until the convoy arrives"], planCauseScope: { contract: PLAN_CAUSE_SCOPE, actionRefs: [`ref:action:${id}`] } }, state: { revision: 9, actionSet: {
    assigned: [{ actionRef: `ref:action:${id}`, rawText: "等待商队到来再交付物资；道路封闭则留守。", goal: "Conditional delivery",
      allowedMeansSources: ["action", "fact", "law"].map(kind => ({ kind, ref: `ref:${kind}:${id}` })) }],
    available: [{ actionRef: "ref:action:background", rawText: "Unassigned background retained" }],
  } }, referenceCatalog: { candidates: [...(emptyTargets ? [] : [{ handle: `ref:entity:${id}`, kind: "entity", allowedUses: ["target", "cause"], label: id }]),
    ...["action", "event", "fact", "law", "check", "mechanic"].map(kind => ({ handle: `ref:${kind}:${id}`, kind, allowedUses: ["cause"], label: `${kind} ${id}` }))] },
  repair: { issues: [{ path: ["plans", 0, "primaryEffect", "targetRef"], originalValue: "ref:entity:b", reason: "source issue" }],
    previousOutput: { kind: "commit_plans", plans: [{ actionRef: "ref:action:b", targetRefs: ["ref:entity:b"] }] } } }));
  contexts.forEach(context => scopeTransform?.(context));
  const prompt = promptBundle("truth-resolution");
  const logicalSchema = declarations ? declaredRandomPlanSchema : resolutionPlanCommitDirectiveSchema;
  const original: StructuredModelRequest<unknown> = { profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution", subjectId: "test",
    schemaName: shared ? "truth_resolution_plan_commit_batch" : "truth_resolution_plan_commit",
    schema: shared ? z.strictObject({ slots: z.array(z.strictObject({ slot: z.number(), result: logicalSchema })) }) : logicalSchema,
    promptVersion: prompt.version, system: prompt.system, userPrompt: `${prompt.userPrompt}${declarations ? `\n${PLAN_RANDOM_COMPLETION_PROMPT}` : ""}${shared ? `\n${SHARED_SLOT_RESULT_INSTRUCTION}` : ""}`,
    context: shared ? { state: factorSharedBatchContexts(contexts, "shared-json-v3"), task: { slots: ids.map((_, slot) => ({ slot })) } } : contexts[0]!,
  };
  const selected = planSelectorRequest(factorTypesRequest(dependentFieldsRequest(original)));
  const before = physicalPlanningWorklistRequest(sourceBoundPlanChoicesRequest(shared ? flatPlanBatchRequest(selected) : selected));
  const request = sourceIndexedPlanningRequest(before, indexMeans), domain = planningIndexDomain(before.context, indexMeans);
  const plans = ids.map(id => ({ proposalKey: id, actionRef: `ref:action:${id}`,
    ...(declarations ? { additionalRandomness: id === "a" ? "none" : "defer" } : {}),
    targetRefs: emptyTargets ? [] : [domain.targets.find(target => target.handle === `ref:entity:${id}`)!.selector],
    means: [{ description: "Wait for the convoy", source: `m:${contentHash({ actionRef: `ref:action:${id}`, source: { kind: "action", ref: `ref:action:${id}` } }).slice(0, 12)}` }],
    mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", primaryEffect: null,
    secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: `ref:action:${id}` }] }));
  return { original, before, request, domain, source: { kind: "commit_plans", plans } };
}

it("retains per-action randomness decisions through the complete physical planning codecs and HTTP validation", async () => {
  const { request, source, domain } = fixture(true, false, true, undefined, true);
  const wire = encodeIndexedPlans(source, domain);
  const catalog = createTestModelCatalog(["truth-deepseek"]);
  let response: unknown = wire;
  const bodies: Array<{ messages: Array<{ content: string }> }> = [];
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "declared-completion-test", model: "scripted:truth-deepseek", choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(response) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const actual = { ...request, profileId: "truth-deepseek", runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 } };
  const result = await gateway.generateStructured(actual);
  const output = result.value as { slots: Array<{ slot: number; result: { plans: Array<{ actionRef: string; additionalRandomness: string }> } }> };
  expect(output.slots.map(s => s.result.plans.map(p => [p.actionRef, p.additionalRandomness]))).toEqual([
    [["ref:action:a", "none"]], [["ref:action:b", "defer"]],
  ]);
  expect(bodies[0]!.messages[1]!.content).toContain(PLAN_RANDOM_COMPLETION_PROMPT);
  for (const invalid of [undefined, "probably-none"]) {
    const amended = structuredClone(wire) as { plans: Array<Record<string, unknown>> };
    if (invalid === undefined) delete amended.plans[0]!.additionalRandomness;
    else amended.plans[0]!.additionalRandomness = invalid;
    response = amended;
    await expect(gateway.generateStructured(actual)).rejects.toThrow();
  }
});

it.each([true, false])("round trips complete source records through the real physical pipeline (shared=%s)", shared => {
  const { original, before, request, domain, source } = fixture(shared);
  expect(withoutPlanningIndices(request.context)).toEqual(before.context);
  expect(() => assertIndexedPlanningContext(request.context)).not.toThrow();
  const wire = encodeIndexedPlans(source, domain);
  expect(decodeIndexedPlans(wire, domain)).toEqual(source);
  expect(z.fromJSONSchema(request.wireJsonSchema!).safeParse(wire).success).toBe(true);
  expect(original.schema.safeParse(request.preprocessOutput!(wire).value).success).toBe(true);
  expect(request.schema).toBe(original.schema);
  // Representation adapters must retain independent semantic instructions.
  expect(request.system).toContain("use that declaring effect's exact `proposalKey`");
  expect(request.system).toContain("Proposal declarations are local to their output slot.");
  expect(request.system).toBe(before.system.replace(loadPromptAsset("shared/plan-source-selectors.md"), loadPromptAsset("shared/source-indexed-planning.md")));
  expect(JSON.stringify(request.context)).toContain("Unassigned background retained");
  expect(() => sourceIndexedPlanningRequest(request)).toThrow("repeated codec");
  const reordered = structuredClone(source); reordered.plans.reverse();
  expect(decodeIndexedPlans(encodeIndexedPlans(reordered, domain), domain)).toEqual(reordered);
  const other = { ...before, role: "causal-verifier" as const }; expect(sourceIndexedPlanningRequest(other)).toBe(other);
});

it.each([true, false])("round trips action-local means positions without changing descriptions or choices (shared=%s)", shared => {
  const { before, request, domain, source } = fixture(shared, false, true);
  for (const [i, plan] of source.plans.entries()) plan.means = [2, 0, 2].map(position => ({
    description: `Use source ${position} for this exact original attempt`, source: domain.actions[i]!.means![position]!.sourceSelector,
  }));
  const wire = encodeIndexedPlans(source, domain) as { plans: Array<{ means: Array<{ sourcePosition: number }> }> };
  expect(wire.plans[0]!.means.map(mean => mean.sourcePosition)).toEqual([2, 0, 2]);
  expect(decodeIndexedPlans(wire, domain)).toEqual(source);
  expect(request.schema.parse(request.preprocessOutput!(wire).value)).toEqual(before.schema.parse(before.preprocessOutput!(source).value));
  expect(z.fromJSONSchema(request.wireJsonSchema!).safeParse(wire).success).toBe(true);
  expect(withoutPlanningIndices(request.context)).toEqual(before.context);
  expect(() => assertIndexedPlanningContext(request.context)).not.toThrow();
  expect(request.system).toContain("positions are local to that action");
  expect(request.system).not.toContain("Each means.source remains the exact sourceSelector");
  expect(request.promptVersion).toContain(SOURCE_INDEXED_PLAN_MEANS);
  const causes = new SourceIndexedPlanCauseCodec(request.context);
  expect(sourceIndexedPlanCausesRequest(request).schema.parse(sourceIndexedPlanCausesRequest(request).preprocessOutput!(causes.encode(wire)).value))
    .toEqual(request.schema.parse(request.preprocessOutput!(wire).value));
});

it("rejects malformed means positions and misspelled historical selectors without affecting a valid neighbor", () => {
  const { request, domain, source } = fixture(true, false, true);
  const wire = encodeIndexedPlans(source, domain) as { plans: Array<{ means: Array<Record<string, unknown>> }> };
  for (const position of [-1, 3, 0.5, "0", undefined, "m:160b0885365f"]) {
    const bad = structuredClone(wire); bad.plans[0]!.means[0]!.sourcePosition = position;
    const value = request.preprocessOutput!(bad).value as { slots: Array<{ result: unknown }> };
    expect(request.schema.safeParse(value).success).toBe(false);
    expect(resolutionPlanCommitDirectiveSchema.safeParse(value.slots[1]!.result).success).toBe(true);
    expect(JSON.stringify(value.slots[0])).toContain("rejectedSources");
  }
  const typo = structuredClone(source); typo.plans[0]!.means[0]!.source = "m:160b0885365f";
  expect(() => encodeIndexedPlans(typo, domain)).toThrow("cannot round trip");
  const mixed = structuredClone(wire); mixed.plans[0]!.means[0]!.source = source.plans[0]!.means[0]!.source;
  expect(request.schema.safeParse(request.preprocessOutput!(mixed).value).success).toBe(false);
  const moved = structuredClone(request.context) as { task: { planningWorklist: { actions: Array<{ action: { allowedMeansSources: Array<{ sourcePosition: number }> } }> } } };
  moved.task.planningWorklist.actions[0]!.action.allowedMeansSources[0]!.sourcePosition = 1;
  expect(() => assertIndexedPlanningContext(moved)).toThrow("binding changed");
  // The same integer is bound to each current action's source, never a global source list.
  const decoded = decodeIndexedPlans(wire, domain) as typeof source;
  expect(decoded.plans[0]!.means[0]!.source).not.toBe(decoded.plans[1]!.means[0]!.source);
});

it.each([true, false])("round trips every legal plan cause through the full physical pipeline (shared=%s)", shared => {
  const { request, domain, source } = fixture(shared), codec = new SourceIndexedPlanCauseCodec(request.context);
  const indexed = encodeIndexedPlans(source, domain) as { plans: Array<{ actionIndex: number; causes: unknown[] }> };
  for (const plan of indexed.plans) {
    const own = domain.actions[plan.actionIndex]!;
    const causes = codec.choices.filter(choice => choice.slots.includes(own.slot)).map(({ kind, ref }) => ({ kind, ref }));
    plan.causes = [...causes.slice().reverse(), causes[0]!];
  }
  const hash = contentHash(indexed), wire = codec.encode(indexed), selected = sourceIndexedPlanCausesRequest(request);
  expect(codec.choices.every(c => ["action", "event", "fact", "law"].includes(c.kind))).toBe(true);
  expect(codec.decode(wire)).toEqual(indexed); expect(contentHash(indexed)).toBe(hash);
  expect(z.fromJSONSchema(selected.wireJsonSchema!).safeParse(wire).success).toBe(true);
  expect(selected.schema.parse(selected.preprocessOutput!(wire).value)).toEqual(request.schema.parse(request.preprocessOutput!(indexed).value));
  const restored = structuredClone(selected.context) as { task: Record<string, unknown> };
  delete restored.task.planCauseChoices;
  expect(restored).toEqual(request.context);
  expect(selected.schema).toBe(request.schema);
  expect(() => sourceIndexedPlanCausesRequest(selected)).toThrow("one indexed");
  expect(request.userPrompt).toContain("only an existing action, event, fact, or law");
});

it("keeps invalid and empty cause selections invalid while preserving neighboring plans", () => {
  const { request, domain, source } = fixture(), codec = new SourceIndexedPlanCauseCodec(request.context);
  const indexed = encodeIndexedPlans(source, domain), selected = sourceIndexedPlanCausesRequest(request);
  const wire = codec.encode(indexed) as { plans: Array<Record<string, unknown>> };
  const otherSlot = codec.choices.findIndex(c => c.kind === "fact" && c.slots.includes(1));
  for (const indices of [[otherSlot], [-1], [codec.choices.length], [0.5], ["0"], [], undefined]) {
    const bad = structuredClone(wire); bad.plans[0]!.causeIndices = indices;
    const decoded = selected.preprocessOutput!(bad).value as { slots: Array<{ result: unknown }> };
    expect(selected.schema.safeParse(decoded).success).toBe(false);
    expect(resolutionPlanCommitDirectiveSchema.safeParse(decoded.slots[1]!.result).success).toBe(true);
    if (indices && indices.length) expect(JSON.stringify(decoded.slots[0])).toContain("rejectedDomain");
  }
  const mixed = structuredClone(wire); mixed.plans[0]!.causes = [{ kind: "action", ref: domain.actions[0]!.handle }];
  expect(selected.schema.safeParse(selected.preprocessOutput!(mixed).value).success).toBe(false);
  const illegal = structuredClone(indexed) as { plans: Array<{ causes: unknown[] }> };
  illegal.plans[0]!.causes = [{ kind: "entity", ref: "ref:entity:a" }];
  expect(() => codec.encode(illegal)).toThrow("cannot round trip");
});

it("retains root peers during narrowed repair while rejecting visible foreign actions", () => {
  const { request, domain, source } = fixture(false, false, false, context => {
    const task = context.task as { planCauseScope: { actionRefs: string[] } };
    task.planCauseScope.actionRefs.push("ref:action:peer");
    const catalog = context.referenceCatalog as { candidates: unknown[] };
    for (const id of ["peer", "foreign"]) catalog.candidates.push({ kind: "action", handle: `ref:action:${id}`, label: id, allowedUses: ["cause"] });
  });
  const codec = new SourceIndexedPlanCauseCodec(request.context);
  expect(domain.actions).toHaveLength(1);
  expect(codec.choices.filter(c => c.kind === "action").map(c => c.ref)).toEqual(["ref:action:b", "ref:action:peer"]);
  expect(JSON.stringify(request.context)).toContain("ref:action:foreign");
  const indexed = encodeIndexedPlans(source, domain) as { plans: Array<{ causes: unknown[] }> };
  indexed.plans[0]!.causes.push({ kind: "action", ref: "ref:action:peer" });
  expect(codec.decode(codec.encode(indexed))).toEqual(indexed);
  indexed.plans[0]!.causes.push({ kind: "action", ref: "ref:action:foreign" });
  expect(() => codec.encode(indexed)).toThrow("cannot round trip");
});

it.each(["missing", "version", "duplicate", "absent", "owner"])("rejects invalid component scope before transport: %s", mode => {
  const { request } = fixture(false, false, false, context => {
    const task = context.task as Record<string, unknown>;
    const scope = task.planCauseScope as { contract: string; actionRefs: string[] };
    if (mode === "missing") delete task.planCauseScope;
    if (mode === "version") scope.contract = "wrong";
    if (mode === "duplicate") scope.actionRefs.push(scope.actionRefs[0]!);
    if (mode === "absent") scope.actionRefs.push("ref:action:missing");
    if (mode === "owner") scope.actionRefs = [];
  });
  expect(() => new SourceIndexedPlanCauseCodec(request.context)).toThrow("plan cause choices:");
});

it("rebinds repair indices to their current source and rejects source projection drift", () => {
  const root = fixture(), repair = fixture(false), before = new SourceIndexedPlanCauseCodec(root.request.context), after = new SourceIndexedPlanCauseCodec(repair.request.context);
  const source = encodeIndexedPlans(repair.source, repair.domain);
  const wire = after.encode(source) as { plans: Array<{ causeIndices: number[] }> };
  expect(after.decode(wire)).toEqual(source);
  expect(after.choices[wire.plans[0]!.causeIndices[0]!]!.ref).toBe("ref:action:b");
  expect(before.choices[wire.plans[0]!.causeIndices[0]!]!.ref).toBe("ref:action:a");
  const drift = structuredClone(repair.request.context) as { task: { planningWorklist: { actions: Array<{ action: { rawText: string } }> } } };
  drift.task.planningWorklist.actions[0]!.action.rawText = "A changed request";
  expect(() => new SourceIndexedPlanCauseCodec(drift)).toThrow("binding changed");
});

it("preserves the cause contract through the complete physical planning provider", async () => {
  const { original, domain, source } = fixture(), seen: StructuredModelRequest<unknown>[] = [];
  const boundary = new ScriptedModelProvider(() => { throw new Error("unused scripted output"); });
  boundary.generateStructured = async request => {
    seen.push(request);
    const codec = new SourceIndexedPlanCauseCodec((() => { const context = structuredClone(request.context) as { task: Record<string, unknown> }; delete context.task.planCauseChoices; return context; })());
    const wire = codec.encode(encodeIndexedPlans(source, domain));
    // No transport or model self-report stands in for the actual codec chain.
    request.schema.parse(request.preprocessOutput!(wire).value);
    throw new Error("physical boundary reached");
  };
  const variant = { sourceInventory: true as const, resolutionRepresentation: "resolution-dependent-fields-v1" as const,
    truthTransport: "shared-state-first-v1" as const, planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE, planCauseChoices: true as const } as const;
  const ref = stepEfficiencyAlgorithmRef(variant);
  expect(registerBuiltinAlgorithms().has(ref)).toBe(true);
  expect(ref.children.truthResolution!.config.planCauseChoices).toBe(SOURCE_INDEXED_PLAN_CAUSES);
  // The registered composition selects this provider contract; exercise its full adapter chain.
  const provider = indexedReviewedPlanningProvider(boundary, false, false, true);
  await expect(provider.generateStructured(dependentFieldsRequest(original))).rejects.toThrow("physical boundary reached");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.promptVersion).toContain(SOURCE_INDEXED_PLAN_CAUSES);
  expect(() => stepEfficiencyAlgorithmRef({ planCauseChoices: true })).toThrow("indexed reviewed");
});

it("binds each effect to a selected plan target without adding, moving or dropping a subject", () => {
  const { before, request, domain, source } = fixture();
  const effect = { kind: "condition", proposalKey: "watched", targetRef: "ref:entity:a", channel: "attention", label: "watched",
    description: "Under observation", sourceRefs: [{ kind: "action", ref: "ref:action:a" }], conditionRef: { proposalKey: "watched" },
    conditionProfileRef: null, durationProfileRef: "ref:mechanic:brief", access: { kind: "public" }, magnitude: "standard" };
  const withEffects = { ...source, plans: [{ ...source.plans[0], targetRefs: [domain.targets[0]!.selector, domain.targets[0]!.selector],
    primaryEffect: effect, secondaryEffect: { ...effect, magnitude: "minor" },
    threatenedEffect: Object.fromEntries(Object.entries(effect).filter(([key]) => key !== "magnitude")) }, source.plans[1]] };
  const hash = contentHash(withEffects), wire = encodeIndexedPlans(withEffects, domain);
  expect(decodeIndexedPlans(wire, domain)).toEqual(withEffects); expect(contentHash(withEffects)).toBe(hash);
  expect(z.fromJSONSchema(request.wireJsonSchema!).safeParse(wire).success).toBe(true);
  expect(request.preprocessOutput!(wire).value).toEqual(before.preprocessOutput!(withEffects).value);
  const wrong = structuredClone(withEffects); wrong.plans[0]!.primaryEffect!.targetRef = "ref:entity:b";
  expect(() => encodeIndexedPlans(wrong, domain)).toThrow("absent from selected plan targets");
});

it("rejects missing, repeated, out-of-range and mixed action identities rather than coalescing plans", () => {
  const { domain, source } = fixture();
  const value = encodeIndexedPlans(source, domain) as { kind: string; plans: Array<Record<string, unknown>> };
  for (const actionIndex of [-1, 2, 0.5, "0", null, 1]) {
    const wrong = structuredClone(value); wrong.plans[0]!.actionIndex = actionIndex;
    expect(() => decodeIndexedPlans(wrong, domain)).toThrow("actionIndex");
  }
  expect(() => decodeIndexedPlans({ ...value, plans: value.plans.slice(1) }, domain)).toThrow("missing actionIndex");
  expect(() => decodeIndexedPlans({ ...value, plans: [...value.plans, structuredClone(value.plans[0])] }, domain)).toThrow("duplicate actionIndex");
  const mixed = structuredClone(value); mixed.plans[0]!.actionRef = "ref:action:a";
  expect(() => decodeIndexedPlans(mixed, domain)).toThrow("mixed reference");
});

it("keeps invalid target choices invalid while retaining the independent valid slot", () => {
  const { request, domain, source } = fixture();
  const value = encodeIndexedPlans(source, domain) as { kind: string; plans: Array<Record<string, unknown>> };
  for (const targetIndices of [[1], [-1], [0.1], ["0"], null]) {
    const wrong = structuredClone(value); wrong.plans[0]!.targetIndices = targetIndices;
    const result = request.preprocessOutput!(wrong).value as { slots: Array<{ slot: number; result: unknown }> };
    expect(request.schema.safeParse(result).success).toBe(false);
    expect(resolutionPlanCommitDirectiveSchema.safeParse(result.slots.find(slot => slot.slot === 1)!.result).success).toBe(true);
  }
  const wrongEffect = structuredClone(value);
  wrongEffect.plans[0]!.primaryEffect = { targetPosition: 1, description: "Must not bind to the next global entity" };
  const decoded = decodeIndexedPlans(wrongEffect, domain) as { plans: Array<{ primaryEffect: { targetRef: string } }> };
  expect(decoded.plans[0]!.primaryEffect.targetRef).toContain("unresolved-index:");
  const empty = fixture(false, true), wire = encodeIndexedPlans(empty.source, empty.domain);
  expect(z.fromJSONSchema(empty.request.wireJsonSchema!).safeParse(wire).success).toBe(true);
  expect(empty.request.schema.safeParse(empty.request.preprocessOutput!(wire).value).success).toBe(true);
});

it("detects changed source, annotations and repair scope; indices never bind across requests", () => {
  const { request, before, domain, source } = fixture();
  const next = structuredClone(request.context) as { task: { planningIndices: { sourceContextHash: string }; planningWorklist: { actions: Array<{ actionIndex: number; action: { rawText: string } }> } } };
  next.task.planningWorklist.actions[0]!.actionIndex = 1;
  expect(() => assertIndexedPlanningContext(next)).toThrow("binding changed");
  next.task.planningWorklist.actions[0]!.actionIndex = 0; next.task.planningWorklist.actions[0]!.action.rawText = "Altered action";
  expect(() => assertIndexedPlanningContext(next)).toThrow("binding changed");
  expect(indexPlanningContext(before.context)).toEqual(request.context);
  const repair = fixture(false);
  expect(repair.domain.actions).toEqual([{ handle: "ref:action:b", slot: 0 }]);
  const initial = encodeIndexedPlans(source, domain) as { kind: string; plans: unknown[] };
  expect(() => decodeIndexedPlans({ kind: "commit_plans", plans: [initial.plans[1]] }, repair.domain)).toThrow("actionIndex");
  const value = encodeIndexedPlans(repair.source, repair.domain);
  expect(decodeIndexedPlans(value, repair.domain)).toEqual(repair.source);
  try {
    request.preprocessOutput!({ kind: "commit_plans", plans: [initial.plans[1]] });
    expect.unreachable("missing action must fail");
  } catch (error) {
    expect(error).toBeInstanceOf(z.ZodError);
    const issues = (error as z.ZodError).issues;
    expect(issues[0]!.message).toContain('"actions":["ref:action:a","ref:action:b"]');
    expect(issues[0]!.message).toContain('"targets":["ref:entity:a","ref:entity:b"]');
    expect(issues[0]!.message).toContain("rejected request only");
  }
});
