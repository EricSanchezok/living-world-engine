import { z } from "zod";
import { loadPromptAsset } from "../../prompts";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

const instruction = loadPromptAsset("shared/conditional-plan-stakes.md");
const successDescription = loadPromptAsset("shared/conditional-plan-stakes-success.md");
const failureDescription = loadPromptAsset("shared/conditional-plan-stakes-failure.md");
export const CONDITIONAL_PLAN_STAKES = `conditional-plan-stakes-v1@${contentHash({ instruction, successDescription, failureDescription }).slice(0, 16)}`;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Experimental wording only; source data, predicates and output decoding remain unchanged. */
export function conditionalPlanStakesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(CONDITIONAL_PLAN_STAKES)) throw new ModelConfigurationError("conditional plan stakes already applied");
  const schema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  let checks = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const fields = node.properties;
    if (object(fields) && object(fields.mode) && fields.mode.const === "check" && object(fields.primaryEffect) && object(fields.threatenedEffect)) {
      fields.primaryEffect.description = successDescription;
      fields.threatenedEffect.description = failureDescription;
      checks += 1;
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  if (!checks) throw new ModelConfigurationError("conditional plan stakes requires an explicit check branch");
  const system = [request.system, instruction].join("\n\n");
  return { ...request, wireJsonSchema: schema, system,
    promptVersion: `${request.promptVersion}/${CONDITIONAL_PLAN_STAKES}` };
}
