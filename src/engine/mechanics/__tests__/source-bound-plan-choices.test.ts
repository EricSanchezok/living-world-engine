import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import type { StructuredModelRequest } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { promptBundle } from "../../prompts";
import { dependentFieldsRequest } from "../resolution-dependent-fields-codec";
import { factorTypesRequest } from "../resolution-factor-types";
import { flatPlanBatchRequest } from "../flat-resolution-plan-batch";
import { planSelectorRequest } from "../plan-source-selectors";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";
import { planChoiceDomains, sourceBoundPlanChoiceSchema, sourceBoundPlanChoicesRequest } from "../source-bound-plan-choices";

const target = (id: string) => `e:${contentHash(`ref:entity:${id}`).slice(0, 12)}`;
const source = (id: string) => `m:${contentHash({ actionRef: `ref:action:${id}`, source: { kind: "action", ref: `ref:action:${id}` } }).slice(0, 12)}`;
const plan = (id: string) => ({ proposalKey: id, actionRef: `ref:action:${id}`, targetRefs: [target(id)],
  means: [{ description: "Watch the courtyard", source: source(id) }], mode: "automatic", difficulty: null, actorRatingRef: null,
  factors: [], risk: "safe", primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: `ref:action:${id}` }] });
function fixture(shared = true, emptyTargets = false) {
  const contexts = ["a", "b"].map(id => ({ task: { constraints: ["Remain until the convoy arrives"] }, state: { actionSet: {
    assigned: [{ actionRef: `ref:action:${id}`, rawText: "Watch the courtyard", allowedMeansSources: [{ kind: "action", ref: `ref:action:${id}` }] }],
    available: [{ actionRef: "ref:action:outside-root", rawText: "Keep this visible but unassigned action" }],
  } }, referenceCatalog: { candidates: emptyTargets ? [] : [{ handle: `ref:entity:${id}`, kind: "entity", allowedUses: ["target"], label: id }] },
  repair: { issues: [{ path: ["plans", 0, "targetRefs"], message: "Unknown selector" }], previousOutput: null } }));
  const prompt = promptBundle("truth-resolution");
  const request: StructuredModelRequest<unknown> = { profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution" as const, subjectId: "test",
    schemaName: shared ? "truth_resolution_plan_commit_batch" : "truth_resolution_plan_commit",
    schema: shared ? z.strictObject({ slots: z.array(z.strictObject({ slot: z.number(), result: resolutionPlanCommitDirectiveSchema })) }) : resolutionPlanCommitDirectiveSchema,
    promptVersion: prompt.version, system: prompt.system, userPrompt: `${prompt.userPrompt}\n${SHARED_SLOT_RESULT_INSTRUCTION}`,
    context: shared ? { state: factorSharedBatchContexts(contexts, "shared-json-v3"), task: { slots: [{ slot: 0 }, { slot: 1 }] } } : contexts[0]!,
  };
  const selected = planSelectorRequest(factorTypesRequest(dependentFieldsRequest(request)));
  return shared ? flatPlanBatchRequest(selected) : selected;
}

it.each([true, false])("enumerates complete assigned choices, preserves all source and repair evidence, and resolves wire definitions (shared=%s)", shared => {
  const original = fixture(shared), before = contentHash(original.context), request = sourceBoundPlanChoicesRequest(original);
  const domains = planChoiceDomains(request.context);
  expect(domains.actionRefs).toEqual(shared ? ["ref:action:a", "ref:action:b"] : ["ref:action:a"]);
  expect(domains.targetSelectors).toEqual((shared ? [target("a"), target("b")] : [target("a")]).sort());
  expect(request.context).toBe(original.context); expect(contentHash(request.context)).toBe(before);
  expect(request.schema).toBe(original.schema); expect(request.system).toBe(original.system); expect(request.preprocessOutput).toBe(original.preprocessOutput);
  const raw = { kind: "commit_plans", plans: (shared ? ["a", "b"] : ["a"]).map(plan) };
  const wire = z.fromJSONSchema(request.wireJsonSchema!);
  expect(wire.safeParse(raw).success).toBe(true);
  expect(request.schema.safeParse(request.preprocessOutput!(raw).value).success).toBe(true);
  for (const patch of [{ actionRef: "ref:action:outside-root" }, { targetRefs: ["e:0123456789ab"] }]) {
    const changed = structuredClone(raw); Object.assign(changed.plans[0]!, patch);
    expect(wire.safeParse(changed).success).toBe(false);
  }
  expect(() => sourceBoundPlanChoicesRequest(request)).toThrow("repeated codec");
  expect(() => sourceBoundPlanChoiceSchema(request.wireJsonSchema!, domains)).toThrow("repeated schema");
});

it("keeps narrower slot ownership authoritative even when a target is in the physical root union", () => {
  const request = sourceBoundPlanChoicesRequest(fixture());
  const raw = { kind: "commit_plans", plans: [{ ...plan("a"), targetRefs: [target("b")] }, plan("b")] };
  expect(z.fromJSONSchema(request.wireJsonSchema!).safeParse(raw).success).toBe(true);
  expect(request.schema.safeParse(request.preprocessOutput!(raw).value).success).toBe(false);
  expect(JSON.stringify(request.preprocessOutput!(raw).value)).toContain("unresolved-selection:");
});

it("preserves an empty target domain without dropping the action or making its empty target list invalid", () => {
  const request = sourceBoundPlanChoicesRequest(fixture(false, true)), wire = z.fromJSONSchema(request.wireJsonSchema!);
  const raw = { kind: "commit_plans", plans: [{ ...plan("a"), targetRefs: [] }] };
  expect(wire.safeParse(raw).success).toBe(true);
  expect(wire.safeParse({ ...raw, plans: [plan("a")] }).success).toBe(false);
});

it("rejects incomplete source bindings and unannotated schemas rather than inventing domains", () => {
  const request = fixture();
  expect(() => planChoiceDomains({})).toThrow("inventory");
  expect(() => sourceBoundPlanChoicesRequest({ ...request, context: { ...(request.context as Record<string, unknown>), task: { slots: [] } } })).toThrow("binding");
  expect(() => sourceBoundPlanChoicesRequest({ ...request, wireJsonSchema: {} })).toThrow("missing plan");
  const context = { state: { actionSet: { assigned: [{ actionRef: "ref:action:a" }] } }, referenceCatalog: { candidates: [{ kind: "entity", allowedUses: ["target"], handle: "ref:entity:a", targetSelector: "e:0123456789ab" }] } };
  expect(() => planChoiceDomains(context)).toThrow("selector binding");
  context.state.actionSet.assigned.push({ actionRef: "ref:action:a" });
  expect(() => planChoiceDomains(context)).toThrow("ambiguous");
  const unrelated = { ...request, role: "causal-verifier" as const }; expect(sourceBoundPlanChoicesRequest(unrelated)).toBe(unrelated);
});
