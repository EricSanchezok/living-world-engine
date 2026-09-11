import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import { loadPromptAsset } from "../prompts";

const declaration = { additionalRandomness: z.enum(["none", "defer"]) };
const [automatic, check, blocked] = resolutionPlanCommitDirectiveSchema.shape.plans.element.options;
export const declaredRandomPlanSchema = resolutionPlanCommitDirectiveSchema.extend({
  plans: z.array(z.discriminatedUnion("mode", [
    automatic.extend(declaration), check.extend(declaration), blocked.extend(declaration),
  ])).min(1),
});

export const PLAN_RANDOM_COMPLETION_PROMPT = loadPromptAsset("shared/plan-random-completion.md");
export const PLAN_RANDOM_COMPLETION = `plan-declared-random-completion-v1@${contentHash({
  prompt: PLAN_RANDOM_COMPLETION_PROMPT,
  schema: z.toJSONSchema(declaredRandomPlanSchema, { target: "draft-07" }),
}).slice(0, 16)}`;

/** The caller must separately bind complete accepted plans, review and new evidence. */
export function declaresNoAdditionalRandomness(value: unknown): boolean {
  const parsed = declaredRandomPlanSchema.safeParse(value);
  return parsed.success && parsed.data.plans.every(plan => plan.additionalRandomness === "none");
}
