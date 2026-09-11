import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { promptBundle } from "../../prompts";
import { decodeFlatResolutionPlans, encodeFlatResolutionPlans, flatPlanBatchRequest, planSlotBinding } from "../flat-resolution-plan-batch";
import { dependentFieldsRequest, encodeResolutionDependentFields } from "../resolution-dependent-fields-codec";
import { encodeResolutionFactorTypes, factorTypesRequest } from "../resolution-factor-types";
import { planSelectorRequest } from "../plan-source-selectors";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";

const plan = (actionRef: string) => ({ proposalKey: `plan-${actionRef}`, actionRef, targetRefs: [],
  means: [{ description: "Watch until the convoy arrives", source: { kind: "action", ref: actionRef } }], mode: "automatic", difficulty: null,
  actorRatingRef: null, factors: [{ source: { kind: "action", ref: actionRef }, authority: "semantic", role: "risk", direction: "neutral", steps: 0, channel: null, explanation: "No penalty" }],
  risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] });
function fixture(counts = [2, 7, 5, 15, 4, 2, 1, 1, 1, 1, 1, 1], codec: "shared-json-v2" | "shared-json-v3" = "shared-json-v3") {
  const binding = counts.map((count, slot) => Array.from({ length: count }, (_, index) => `ref:action:${slot}-${index}`));
  const contexts = binding.map(refs => ({ state: { actionSet: { assigned: refs.map(actionRef => ({ actionRef,
    rawText: "Watch until the convoy arrives", allowedMeansSources: [{ kind: "action", ref: actionRef }] })) } },
  task: { constraints: ["Keep the entire conditional action"] }, referenceCatalog: { candidates: [] },
  repair: { issues: [{ path: ["plans", 0, "factors"], message: "Original issue" }], previousOutput: { kind: "commit_plans", plans: refs.map(plan) } } }));
  const schema = z.strictObject({ slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), result: resolutionPlanCommitDirectiveSchema })).length(counts.length) });
  const prompt = promptBundle("truth-resolution");
  const request = { profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution" as const, subjectId: "test",
    schemaName: "truth_resolution_plan_commit_batch", schema, promptVersion: prompt.version, system: prompt.system,
    userPrompt: `${prompt.userPrompt}\n\n${SHARED_SLOT_RESULT_INSTRUCTION}`, context: { state: factorSharedBatchContexts(contexts, codec), task: { slots: counts.map((_, slot) => ({ slot })) } } };
  const canonical = schema.parse({ slots: binding.map((refs, slot) => ({ slot, result: { kind: "commit_plans", plans: refs.map(plan) } })) });
  return { request, binding, canonical };
}

it.each(["shared-json-v2", "shared-json-v3"] as const)("round trips all original root actions and independent slot orders with %s", codec => {
  const { request, binding, canonical } = fixture(undefined, codec), before = contentHash(request.context);
  expect(planSlotBinding(request.context)).toEqual(binding);
  for (const slots of [canonical.slots, [...canonical.slots].reverse()]) {
    const original = { slots }, flat = encodeFlatResolutionPlans(original, binding);
    expect(decodeFlatResolutionPlans(flat, binding)).toEqual(original);
    const next = flatPlanBatchRequest(request);
    expect(z.fromJSONSchema(next.wireJsonSchema!).safeParse(flat).success).toBe(true);
    expect(next.preprocessOutput!(flat).value).toEqual(original);
    expect(next.context).toBe(request.context); expect(next.schema).toBe(request.schema);
    expect(next.system).toBe(request.system);
    expect(() => flatPlanBatchRequest(next)).toThrow("repeated codec");
  }
  expect(contentHash(request.context)).toBe(before);
});

it("preserves interleaved plan order within each owner and leaves malformed independent fields for canonical rejection", () => {
  const { binding, canonical, request } = fixture([2, 2]);
  const a = canonical.slots[0]!.result.plans, b = canonical.slots[1]!.result.plans;
  const raw = { kind: "commit_plans", plans: [b[1], a[0], b[0], { ...a[1], risk: "challenging" }] };
  const decoded = decodeFlatResolutionPlans(raw, binding) as typeof canonical;
  expect(decoded.slots.map(entry => entry.slot)).toEqual([1, 0]);
  expect(decoded.slots[0]!.result.plans).toEqual([b[1], b[0]]);
  expect(resolutionPlanCommitDirectiveSchema.safeParse(decoded.slots[0]!.result).success).toBe(true);
  expect(request.schema.safeParse(decoded).success).toBe(false);
  expect(decoded.slots[1]!.result.plans[1]!.risk).toBe("challenging");
});

it("rejects missing, duplicate, foreign and malformed ownership without silently dropping or regrouping plans", () => {
  const { binding, canonical } = fixture([1, 1]);
  const plans = canonical.slots.flatMap(entry => entry.result.plans), flat = { kind: "commit_plans", plans };
  for (const raw of [canonical, { ...flat, slots: [] }, { kind: "done", plans }, { kind: "commit_plans", plans: [] },
    { ...flat, plans: [plans[0], plans[0]] }, { ...flat, plans: [plans[0], { ...plans[1], actionRef: "ref:action:another-root" }] },
    { ...flat, plans: [plans[0], { ...plans[1], actionRef: null }] }, { ...flat, plans: [plans[0], null] }]) {
    expect(() => decodeFlatResolutionPlans(raw, binding)).toThrow(z.ZodError);
  }
  const misplaced = structuredClone(canonical); misplaced.slots[0]!.result.plans = canonical.slots[1]!.result.plans;
  expect(() => encodeFlatResolutionPlans(misplaced, binding)).toThrow("another slot's owner");
});

it("fails invalid source bindings and applies only to explicitly shared physical planning batches", () => {
  const { request } = fixture([1, 1]);
  expect(() => planSlotBinding({ ...request.context, task: { slots: [{ slot: 0 }] } })).toThrow("coverage");
  const changed = structuredClone(request.context); changed.state.slots[0]!.contextHash = "stale";
  expect(() => planSlotBinding(changed)).toThrow("binding changed");
  expect(() => flatPlanBatchRequest({ ...request, context: {} })).toThrow("missing shared");
  expect(() => flatPlanBatchRequest({ ...request, userPrompt: "other" })).toThrow("unique shared");
  expect(() => flatPlanBatchRequest({ ...request, wireJsonSchema: {} })).toThrow("schema");
  for (const schemaName of ["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_continuation_batch"]) {
    const input = { ...request, schemaName }; expect(flatPlanBatchRequest(input)).toBe(input);
  }
  const nonPlanning = { ...request, role: "causal-verifier" as const }; expect(flatPlanBatchRequest(nonPlanning)).toBe(nonPlanning);
  const repeated = fixture([1, 1]);
  expect(() => decodeFlatResolutionPlans({}, [repeated.binding[0]!, repeated.binding[0]!])).toThrow("ambiguous");
});

it("composes below dependent fields, factor types and selectors without moving source or repair evidence", () => {
  const { request, canonical, binding } = fixture([1, 1]);
  const prior = planSelectorRequest(factorTypesRequest(dependentFieldsRequest(request))), next = flatPlanBatchRequest(prior);
  expect(next.context).toBe(prior.context);
  const encoded = encodeResolutionFactorTypes(encodeResolutionDependentFields(canonical)) as { slots: Array<{ slot: number; result: { plans: Array<{ actionRef: string; means: Array<{ source: unknown }> }> } }> };
  const contexts = next.context as typeof request.context;
  // The selectors are bound to each original action and its exact permitted source.
  const flat = encodeFlatResolutionPlans(encoded, binding) as { plans: Array<{ actionRef: string; means: Array<{ source: unknown }> }> };
  for (const entry of flat.plans) entry.means[0]!.source = `m:${contentHash({ actionRef: entry.actionRef, source: { kind: "action", ref: entry.actionRef } }).slice(0, 12)}`;
  expect(contexts).toBe(prior.context);
  expect(z.fromJSONSchema(next.wireJsonSchema!).safeParse(flat).success).toBe(true);
  expect(next.preprocessOutput!(flat).value).toEqual(canonical);
});
