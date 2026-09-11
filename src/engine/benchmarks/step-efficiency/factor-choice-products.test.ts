import { expect, it } from "vitest";
import { z } from "zod";
import { modelResolutionFactorSchema, resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { decodeResolutionFactorTypes, encodeResolutionFactorTypes, factorTypesRequest, resolutionFactorTypesWireSchema } from "../../mechanics/resolution-factor-types";
import { promptBundle } from "../../prompts";
import { decodeFactorProducts, encodeFactorProducts, factorChoiceProductsRequest, factorProductSchema } from "./factor-choice-products";

const wrap = (factor: unknown) => ({ kind: "commit_plans", plans: [{ factors: [factor] }] });
const first = (value: unknown) => (value as ReturnType<typeof wrap>).plans[0]!.factors[0];
const source = resolutionFactorTypesWireSchema(z.toJSONSchema(modelResolutionFactorSchema, { target: "draft-07" }));
const { schema, domain } = factorProductSchema(source);

it("round trips every legal direction and magnitude while preserving source authority, channels and explanations", () => {
  const wire = z.fromJSONSchema(schema), keys = new Set<string>();
  for (const authority of ["semantic", "authored"]) for (const role of ["permission", "secondary", "risk", "control", "potency", "protection"]) {
    for (const kind of ["action", "entity", "fact", "placement", "condition", "rating", "law"]) {
      for (const direction of ["neutral", "helpful", "hindering"]) for (const steps of [0, 1, 2]) for (const channel of [null, "travel"]) {
        const factor = { authority, role, direction, steps, channel, source: { kind, ref: `ref:${kind}:source` }, explanation: "Retained source rationale" };
        if (!modelResolutionFactorSchema.safeParse(factor).success) continue;
        const original = wrap(factor), encoded = encodeFactorProducts(encodeResolutionFactorTypes(original), domain);
        const choice = first(encoded) as Record<string, unknown>;
        keys.add(String(choice.factorType));
        expect(choice).not.toHaveProperty("direction"); expect(choice).not.toHaveProperty("steps");
        expect(wire.safeParse(choice).success).toBe(true);
        expect(decodeResolutionFactorTypes(decodeFactorProducts(encoded, domain))).toEqual(original);
      }
    }
  }
  expect(keys.size).toBe(22); expect(domain.size).toBe(22);
});

it("rejects the recorded missing direction, mixed representations and invented choices without changing valid neighbors", () => {
  const base = { factorType: "semantic:control", source: { kind: "fact", ref: "ref:fact:source" }, channel: "command", explanation: "A competing command limits discretion" };
  expect(() => encodeFactorProducts(wrap(base), domain)).toThrow("complete explicit choice");
  const valid = { ...base, factorType: "semantic:control:hindering" };
  for (const patch of [{ factorType: "semantic:control" }, { factorType: "semantic:control:neutral" }, { direction: "hindering" },
    { factorType: "authored:potency:helpful:3" }, { factorType: null }]) {
    const raw = { kind: "commit_plans", plans: [{ factors: [valid, { ...valid, ...patch }] }] };
    const decoded = decodeResolutionFactorTypes(decodeFactorProducts(raw, domain)) as typeof raw;
    expect(modelResolutionFactorSchema.safeParse(decoded.plans[0]!.factors[0]).success).toBe(true);
    expect(modelResolutionFactorSchema.safeParse(decoded.plans[0]!.factors[1]).success).toBe(false);
    expect(raw.plans[0]!.factors[0]).toEqual(valid);
  }
  const unauthorized = decodeResolutionFactorTypes(decodeFactorProducts(wrap({ ...valid, factorType: "authored:control:helpful" }), domain));
  expect(modelResolutionFactorSchema.safeParse(first(unauthorized)).success).toBe(false);
});

it("composes with the production factor decoder, retaining source context and canonical admission", () => {
  const prompt = promptBundle("truth-resolution");
  const base = factorTypesRequest({ ...prompt, promptVersion: prompt.version, workloadId: "world", batchId: "step",
    profileId: "truth", subjectId: "component", role: "truth-resolution" as const, schemaName: "truth_resolution_plan_commit_batch",
    schema: resolutionPlanCommitDirectiveSchema, context: { state: { complete: true }, repair: null } });
  const candidate = factorChoiceProductsRequest(base), { domain } = factorProductSchema(base.wireJsonSchema!);
  const canonical = { kind: "commit_plans", plans: [{ proposalKey: "plan", actionRef: "ref:action:a", targetRefs: [], means: [],
    mode: "automatic", difficulty: null, actorRatingRef: null, factors: [{ authority: "semantic", role: "control", direction: "hindering", steps: 1,
      source: { kind: "fact", ref: "ref:fact:source" }, explanation: "A competing command limits discretion", channel: null }],
    risk: "risky", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full",
    causes: [{ kind: "action", ref: "ref:action:a" }] }] };
  const raw = encodeFactorProducts(encodeResolutionFactorTypes(canonical), domain);
  expect(z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(raw).success).toBe(true);
  expect(candidate.context).toBe(base.context); expect(candidate.schema).toBe(base.schema);
  expect(candidate.schema.parse(candidate.preprocessOutput!(raw).value)).toEqual(canonical);
  expect(() => factorChoiceProductsRequest(candidate)).toThrow("already applied");
  const other = { ...base, schemaName: "truth_transition" };
  expect(factorChoiceProductsRequest(other)).toBe(other);
  const malformed = { type: "object", properties: { factorType: { const: "semantic:control" }, direction: { type: "string" } }, required: ["factorType", "direction"] };
  expect(() => factorProductSchema(malformed)).toThrow("complete finite domain");
});
