import { expect, it } from "vitest";
import { z } from "zod";
import { modelResolutionFactorSchema, resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { promptBundle } from "../../prompts";
import { logicalRepairContext } from "../../prompts/logical-repair-context";
import { decodeResolutionFactorTypes, encodeResolutionFactorTypes, factorTypesRequest, resolutionFactorTypesWireSchema } from "../resolution-factor-types";
import { dependentFieldsRequest, encodeResolutionDependentFields } from "../resolution-dependent-fields-codec";
import { planSelectorRequest } from "../plan-source-selectors";
import { expandSharedBatchContexts, factorSharedBatchContexts, type SharedBatchContext } from "../shared-batch-context";

const note = { source: { kind: "action", ref: "ref:action:a" }, authority: "semantic", role: "risk", direction: "neutral", steps: 0, channel: null, explanation: "The convoy might not arrive; this is not a numeric penalty." };
const commit = (factors: unknown[]) => ({ kind: "commit_plans", plans: [{ proposalKey: "plan", actionRef: "ref:action:a", targetRefs: [],
  means: [{ description: "Wait for the convoy", source: { kind: "action", ref: "ref:action:a" } }], mode: "automatic", difficulty: null,
  actorRatingRef: null, factors, risk: "risky", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
  visibility: "full", causes: [{ kind: "action", ref: "ref:action:a" }] }] });
const context = () => ({ task: { constraints: [] as string[] }, state: { facts: ["An unchanged source fact"], actionSet: { assigned: [
  { actionRef: "ref:action:a", rawText: "Wait until the convoy arrives", allowedMeansSources: [{ kind: "action", ref: "ref:action:a" }] },
] } }, referenceCatalog: { candidates: [{ kind: "entity", handle: "ref:entity:player", allowedUses: ["target"] }] }, repair: null as unknown });
const request = () => { const prompt = promptBundle("truth-resolution"); return { profileId: "truth-engine", workloadId: "test", batchId: "test",
  role: "truth-resolution" as const, subjectId: "test", schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
  promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt, context: context() }; };

it("round trips every legal factor type, source kind, direction, step and channel choice through the canonical schema", () => {
  const wireSchema = z.fromJSONSchema(resolutionFactorTypesWireSchema(z.toJSONSchema(modelResolutionFactorSchema, { target: "draft-07" })));
  const types = new Set<string>();
  for (const authority of ["semantic", "authored"]) for (const role of ["permission", "secondary", "risk", "control", "potency", "protection"]) {
    const numeric = ["control", "potency", "protection"].includes(role), magnitude = ["potency", "protection"].includes(role);
    for (const kind of ["action", "entity", "fact", "placement", "condition", "rating", "law"]) for (const channel of [null, "travel"]) {
      for (const direction of numeric ? ["helpful", "hindering"] : ["neutral"]) for (const steps of numeric ? authority === "authored" && magnitude ? [1, 2] : [1] : [0]) {
        const factor = { ...note, authority, role, source: { kind, ref: `ref:${kind}:source` }, direction, steps, channel };
        if ((authority === "authored" && !["rating", "law"].includes(kind)) || (magnitude && channel === null)) {
          expect(modelResolutionFactorSchema.safeParse(factor).success).toBe(false);
          continue;
        }
        expect(modelResolutionFactorSchema.safeParse(factor).success).toBe(true);
        const canonical = resolutionPlanCommitDirectiveSchema.parse(commit([factor])), before = contentHash(canonical);
        const wire = encodeResolutionFactorTypes(canonical) as { plans: Array<{ factors: Array<Record<string, unknown>> }> };
        const encoded = wire.plans[0]!.factors[0]!; types.add(String(encoded.factorType));
        expect(wireSchema.safeParse(encoded).success).toBe(true);
        expect(encoded).not.toHaveProperty("authority"); expect(encoded).not.toHaveProperty("role");
        if (!numeric) expect(encoded).not.toHaveProperty("direction");
        expect(decodeResolutionFactorTypes(wire)).toEqual(canonical);
        expect(contentHash(canonical)).toBe(before);
      }
    }
  }
  expect(types.size).toBe(12);
});

it("rejects unknown or missing choices, conflicting constants, source authority and translated enums without repairing their meaning", () => {
  const wire = encodeResolutionFactorTypes(commit([note])) as { plans: Array<{ factors: Array<Record<string, unknown>> }> };
  for (const patch of [{ factorType: "语义:risk" }, { factorType: null }, { role: "control" }, { direction: "hindering" }, { steps: 1 },
    { factorType: "authored:risk" }, { unknown: "field" }, { factorType: "semantic:control", direction: "hindering", steps: 2 }]) {
    const invalid = structuredClone(wire); Object.assign(invalid.plans[0]!.factors[0]!, patch);
    expect(resolutionPlanCommitDirectiveSchema.safeParse(decodeResolutionFactorTypes(invalid)).success).toBe(false);
  }
  expect(resolutionPlanCommitDirectiveSchema.safeParse(decodeResolutionFactorTypes(commit([note]))).success).toBe(false);
  expect(() => encodeResolutionFactorTypes(commit([{ ...note, steps: 1 }]))).toThrow("valid canonical factor");
  const same = structuredClone(wire); Object.assign(same.plans[0]!.factors[0]!, { role: "risk", authority: "semantic", direction: "neutral", steps: 0 });
  expect(decodeResolutionFactorTypes(same)).toEqual(commit([note]));
  const batch = { slots: [{ slot: 7, result: wire }, { slot: 2, result: commit([{ ...note, steps: 1 }]) }] };
  const decoded = decodeResolutionFactorTypes(batch) as typeof batch;
  expect(decoded.slots[0]!.result).toEqual(commit([note]));
  expect(resolutionPlanCommitDirectiveSchema.safeParse(decoded.slots[1]!.result).success).toBe(false);
});

it("preserves initial sources and composes with dependent fields and source selectors", () => {
  const original = request(), sourceHash = contentHash(original.context);
  const selected = planSelectorRequest(dependentFieldsRequest(original)), next = factorTypesRequest(selected);
  expect(next.context).toEqual(selected.context); expect(contentHash(original.context)).toBe(sourceHash);
  expect(next.schema).toBe(original.schema);
  const value = encodeResolutionFactorTypes(encodeResolutionDependentFields(commit([note]))) as { plans: Array<{ means: Array<{ source: unknown }> }> };
  const ctx = next.context as { state: { actionSet: { assigned: Array<{ allowedMeansSources: Array<{ sourceSelector: string }> }> } } };
  value.plans[0]!.means[0]!.source = ctx.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector;
  expect(z.fromJSONSchema(next.wireJsonSchema!).safeParse(value).success).toBe(true);
  expect(next.preprocessOutput!(value).value).toEqual(commit([note]));
  expect(() => factorTypesRequest(next)).toThrow("repeated codec");
  expect(factorTypesRequest({ ...original, role: "causal-verifier" })).toEqual({ ...original, role: "causal-verifier" });
});

it("keeps invalid repair evidence and per-slot candidate ownership while reversibly encoding valid factors", () => {
  const contexts = ["a", "b"].map(id => logicalRepairContext(context(), { attempt: 1, scope: "component", targetIds: [],
    logicalInvocationId: id, issues: [{ code: "invalid_union", class: "structure", path: ["plans", 0, "factors", 1], message: "bad risk", originalValue: { ...note, steps: 1 } }],
    previousOutput: commit([note, { ...note, steps: 1 }]),
  }, contentHash(context()), "truth_resolution_plan_commit"));
  const original = { ...request(), context: { state: factorSharedBatchContexts(contexts, "shared-json-v3") } };
  const before = contentHash(original.context), next = factorTypesRequest(original);
  const expanded = expandSharedBatchContexts((next.context as { state: SharedBatchContext }).state);
  for (const [index, id] of ["a", "b"].entries()) {
    const repair = expanded[index]!.repair as { previousOutput: { plans: Array<{ factors: unknown[] }> }; candidateBinding: { canonicalOutputHash: string; logicalInvocationId: string }; issues: unknown[] };
    expect(repair.candidateBinding).toMatchObject({ logicalInvocationId: id, canonicalOutputHash: contentHash(commit([note, { ...note, steps: 1 }])) });
    expect(repair.previousOutput.plans[0]!.factors[1]).toEqual({ ...note, steps: 1 });
    expect(repair.previousOutput.plans[0]!.factors[0]).toEqual((encodeResolutionFactorTypes(commit([note])) as { plans: Array<{ factors: unknown[] }> }).plans[0]!.factors[0]);
    expect(repair.issues).toEqual((contexts[index] as { repair: { issues: unknown[] } }).repair.issues);
  }
  expect(contentHash(original.context)).toBe(before);
});
