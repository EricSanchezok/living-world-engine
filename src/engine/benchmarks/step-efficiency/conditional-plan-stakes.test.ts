import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { dependentFieldsRequest } from "../../mechanics/resolution-dependent-fields-codec";
import { promptBundle } from "../../prompts";
import type { StructuredModelRequest } from "../../models/model-provider";
import { conditionalPlanStakesRequest, CONDITIONAL_PLAN_STAKES } from "./conditional-plan-stakes";

const withoutDescriptions = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "description").map(([key, entry]) => [key, withoutDescriptions(entry)]));
  return value;
};
function request(): StructuredModelRequest<unknown> {
  const prompt = promptBundle("truth-resolution");
  return dependentFieldsRequest({ ...prompt, promptVersion: prompt.version, workloadId: "world", batchId: "step",
    profileId: "truth-engine", subjectId: "component", role: "truth-resolution", schemaName: "truth_resolution_plan_commit",
    schema: resolutionPlanCommitDirectiveSchema, context: { state: { actions: ["Request passage without claiming permission was granted"] }, repair: null } });
}

it("preserves every production schema predicate, complete context and decoder while clarifying conditional check stakes", () => {
  const original = request();
  const before = JSON.stringify(original.wireJsonSchema);
  const candidate = conditionalPlanStakesRequest(original);
  expect(withoutDescriptions(candidate.wireJsonSchema)).toEqual(withoutDescriptions(original.wireJsonSchema));
  expect(candidate.context).toBe(original.context);
  expect(candidate.schema).toBe(original.schema);
  expect(candidate.preprocessOutput).toBe(original.preprocessOutput);
  expect(candidate.userPrompt).toBe(original.userPrompt);
  expect(candidate.system.startsWith(original.system)).toBe(true);
  expect(candidate.promptVersion).toContain(CONDITIONAL_PLAN_STAKES);
  expect(JSON.stringify(original.wireJsonSchema)).toBe(before);
  expect(() => conditionalPlanStakesRequest(candidate)).toThrow("already applied");
});

it("does not synthesize a missing check effect or change unrelated model stages", () => {
  const source = request();
  const candidate = conditionalPlanStakesRequest(source);
  const invalid = { kind: "commit_plans", plans: [{ mode: "check", primaryEffect: null, threatenedEffect: null }] };
  expect(candidate.preprocessOutput!(invalid).value).toEqual({ kind: "commit_plans", plans: [{ ...invalid.plans[0], baseEffect: "none" }] });
  expect(candidate.schema.safeParse(candidate.preprocessOutput!(invalid).value).success).toBe(false);
  const other = { ...source, schemaName: "truth_transition" };
  expect(conditionalPlanStakesRequest(other)).toBe(other);
  expect(() => conditionalPlanStakesRequest({ ...source, wireJsonSchema: z.toJSONSchema(z.object({ done: z.boolean() })) })).toThrow("explicit check branch");
});
