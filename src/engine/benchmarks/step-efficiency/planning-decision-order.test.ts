import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { dependentFieldsRequest } from "../../mechanics/resolution-dependent-fields-codec";
import { promptBundle } from "../../prompts";
import { planningDecisionOrderRequest } from "./planning-decision-order";

function request() {
  const prompt = promptBundle("truth-resolution");
  return dependentFieldsRequest({ ...prompt, promptVersion: prompt.version, workloadId: "world", batchId: "step",
    profileId: "truth", subjectId: "component", role: "truth-resolution", schemaName: "truth_resolution_plan_commit_batch",
    schema: resolutionPlanCommitDirectiveSchema, context: { state: { complete: true }, repair: null } });
}

it("places governing selections before dependent fields without changing schema predicates, source, or decoding", () => {
  const source = request(), before = JSON.stringify(source.wireJsonSchema), result = planningDecisionOrderRequest(source);
  expect(result.wireJsonSchema).toEqual(source.wireJsonSchema);
  expect(JSON.stringify(result.wireJsonSchema)).not.toBe(before);
  expect(JSON.stringify(source.wireJsonSchema)).toBe(before);
  expect(result.context).toBe(source.context);
  expect(result.schema).toBe(source.schema);
  expect(result.preprocessOutput).toBe(source.preprocessOutput);
  expect(result.userPrompt).toBe(source.userPrompt);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>, fields = node.properties as Record<string, unknown> | undefined;
    if (fields?.mode && fields.primaryEffect) {
      const keys = Object.keys(fields);
      expect(keys.indexOf("mode")).toBeLessThan(keys.indexOf("primaryEffect"));
      expect(keys.indexOf("actorRatingRef")).toBeLessThan(keys.indexOf("factors"));
      expect(keys.indexOf("difficulty")).toBeLessThan(keys.indexOf("factors"));
    }
    Object.values(node).forEach(walk);
  };
  walk(result.wireJsonSchema);
  expect(() => planningDecisionOrderRequest(result)).toThrow("already applied");
});

it("retains rejection of invalid check effects and ignores other stages", () => {
  const source = request(), result = planningDecisionOrderRequest(source);
  const invalid = { kind: "commit_plans", plans: [{ mode: "check", primaryEffect: null, threatenedEffect: null }] };
  expect(result.preprocessOutput!(invalid)).toEqual(source.preprocessOutput!(invalid));
  expect(result.schema.safeParse(result.preprocessOutput!(invalid).value).success).toBe(false);
  const unrelated = { ...source, schemaName: "truth_transition" };
  expect(planningDecisionOrderRequest(unrelated)).toBe(unrelated);
});
