import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

const order = ["actionIndex", "actionRef", "proposalKey", "mode", "actorRatingRef", "difficulty", "targetIndices", "targetRefs",
  "means", "factors", "risk", "baseEffect", "primaryEffect", "secondaryEffect", "threatenedEffect", "visibility", "causeIndices", "causes", "additionalRandomness"];
const instruction = loadPromptAsset("shared/planning-decision-order.md");
export const PLANNING_DECISION_ORDER = `governing-planning-decisions-first-v1@${contentHash({ order, instruction }).slice(0, 16)}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Reorder existing schema properties only; every predicate and output decoder is retained. */
export function planningDecisionOrderRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(PLANNING_DECISION_ORDER)) throw new ModelConfigurationError("planning decision order already applied");
  const schema = structuredClone(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  let branches = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    const fields = node.properties;
    if (object(fields) && object(fields.mode) && typeof fields.mode.const === "string" && object(fields.primaryEffect)) {
      node.properties = Object.fromEntries([...order.filter(key => Object.hasOwn(fields, key)),
        ...Object.keys(fields).filter(key => !order.includes(key))].map(key => [key, fields[key]]));
      branches++;
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  if (!branches) throw new ModelConfigurationError("planning decision order requires explicit plan branches");
  const system = [request.system, instruction].join("\n\n");
  return { ...request, wireJsonSchema: schema, system, promptVersion: `${request.promptVersion}/${PLANNING_DECISION_ORDER}` };
}
