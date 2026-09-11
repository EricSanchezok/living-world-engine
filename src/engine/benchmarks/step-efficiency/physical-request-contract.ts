import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema, truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { bindTruthBatchCardinality } from "../../mechanics/truth-batch-provider";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";
import { contentHash } from "../../models/model-audit";
import { loadPromptAsset } from "../../prompts";
import { recordedContext, type RepairTailKind } from "./repair-tail";
import type { TemporalProbeBody } from "./temporal-diagnostic";

/** Replay the same opt-in contract as the runtime; reject drift instead of
 * changing an unknown historical prompt or reconstructing missing context. */
export function physicalRequestContract(source: TemporalProbeBody, kind: RepairTailKind) {
  if (source.thinking.type !== "disabled" || source.reasoning_effort !== undefined) throw new Error("nonthinking source required");
  const message = source.messages[1]!.content;
  const context = recordedContext(message);
  if (context.value.batchRepair !== undefined) throw new Error("initial physical request required");
  const expanded = expandSharedBatchContexts(context.value.state as SharedBatchContext);
  const schema = kind === "plan" ? z.strictObject({ slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), result: resolutionPlanCommitDirectiveSchema })) }) : truthTransitionBatchSchema;
  const originalSchema = z.toJSONSchema(schema, { target: "draft-07" });
  const boundary = "\nJSON Schema: ";
  const parts = message.split(boundary);
  const example = loadPromptAsset("transport/json-example.md", { allowTemplates: true }).replace("{{EXAMPLE}}", '{"slots":[]}');
  if (parts.length !== 2 || parts[1] !== `${JSON.stringify(originalSchema)}\n${example}`) throw new Error("recorded schema/example drift");
  const wireSchema = z.toJSONSchema(bindTruthBatchCardinality(schema, expanded.length), { target: "draft-07" });
  const body = structuredClone(source);
  body.messages[1]!.content = `${parts[0]}${boundary}${JSON.stringify(wireSchema)}`;
  if (recordedContext(body.messages[1]!.content).text !== context.text) throw new Error("source context changed");
  return { body, expanded, contextHash: contentHash(context.value), originalSchemaHash: contentHash(originalSchema), wireSchemaHash: contentHash(wireSchema) };
}
