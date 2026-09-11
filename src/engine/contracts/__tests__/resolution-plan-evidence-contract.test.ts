import { expect, it } from "vitest";
import { z } from "zod";
import { modelCausalRefSchema, modelResolutionPlanCauseSchema, resolutionPlanCommitDirectiveSchema } from "../llm-schemas";
import { resolutionDependentFieldsWireSchema } from "../../mechanics/resolution-dependent-fields-codec";

const plan = { proposalKey: "watch", actionRef: "ref:action:watch", targetRefs: [], means: [], factors: [], risk: "safe", baseEffect: "none",
  primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", mode: "automatic", difficulty: null,
  actorRatingRef: null, causes: [{ kind: "action", ref: "ref:action:watch" }] };

it.each(["action", "event", "fact", "law"])("preserves existing %s causes and rejects their proposed substitutes at the exact field", kind => {
  const cause = { kind, ref: `ref:${kind}:existing` };
  expect(modelResolutionPlanCauseSchema.parse(cause)).toEqual(cause);
  const value = { kind: "commit_plans", plans: [{ ...plan, causes: [plan.causes[0], { kind, ref: { proposalKey: "watch" } }] }] };
  const result = resolutionPlanCommitDirectiveSchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) expect(result.error.issues).toContainEqual(expect.objectContaining({ path: ["plans", 0, "causes", 1, "ref"], code: "invalid_type" }));
  // Other output stages still support their explicitly declared proposals.
  expect(modelCausalRefSchema.safeParse({ kind, ref: { proposalKey: "new-evidence" } }).success).toBe(true);
});

it.each(["check", "random", "mechanic", "entity", "placement", "quantity"])("rejects %s as a planning cause without changing reference meaning", kind => {
  const cause = { kind, ref: `ref:${kind}:visible` };
  expect(modelResolutionPlanCauseSchema.safeParse(cause).success).toBe(false);
  expect(cause).toEqual({ kind, ref: `ref:${kind}:visible` });
});

it("keeps valid plans unchanged and advertises the same phase and per-action source contracts on the actual wire", () => {
  const value = { kind: "commit_plans", plans: [plan] };
  expect(resolutionPlanCommitDirectiveSchema.parse(value)).toEqual(value);
  const wire = resolutionDependentFieldsWireSchema(z.toJSONSchema(resolutionPlanCommitDirectiveSchema, { target: "draft-07" }));
  const planObjects: Array<Record<string, unknown>> = [];
  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>, properties = node.properties as Record<string, unknown> | undefined;
    if (properties?.actionRef && properties.causes) planObjects.push(properties);
    Object.values(node).forEach(visit);
  }
  visit(wire);
  expect(planObjects).toHaveLength(3);
  for (const properties of planObjects) {
    const causes = properties.causes as { items: { oneOf: Array<{ properties: { kind: { const: string }; ref: { type: string; pattern: string } } }> }; description: string };
    expect(causes.items.oneOf.map(item => item.properties.kind.const)).toEqual(["action", "event", "fact", "law"]);
    expect(causes.items.oneOf.every(item => item.properties.ref.type === "string")).toBe(true);
    expect(causes.description).toContain("this plan.actionRef");
    expect(JSON.stringify(properties.means)).toContain("allowedMeansSources");
  }
});
