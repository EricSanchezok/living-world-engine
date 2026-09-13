import { z } from "zod";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { existingReferenceHandleSchemaFor as existing } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { buildPerceptionSourceIndex } from "./perception-source-index";

const evidence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entity"), ref: existing("entity") }),
  z.strictObject({ kind: z.literal("fact"), ref: existing("fact") }),
  z.strictObject({ kind: z.literal("law"), ref: existing("law") }),
]);
export const perceptionSourceFramesSchema = z.strictObject({ frames: z.array(z.strictObject({
  sourceActionRef: existing("action"), sourceActorRef: existing("entity"), currentOnset: z.string().trim().min(1),
  firstRecipients: z.array(z.strictObject({ entityRef: existing("entity").nullable(), description: z.string().trim().min(1) })),
  laterOrConditional: z.array(z.string().trim().min(1)), privateIntentNotSpoken: z.array(z.string().trim().min(1)),
  uncertainty: z.string().trim().min(1).nullable(),
  sourceQuotes: z.array(z.strictObject({ field: z.enum(["rawText", "means"]), text: z.string().min(1) })).min(1),
  evidence: z.array(evidence).min(1),
})) });
const system = loadPromptAsset("system/perception-source-frames.md"), userPrompt = loadPromptAsset("user/perception-source-frames.md");
export const PERCEPTION_SOURCE_FRAMES = `perception-source-frames-v1@${contentHash({ system, userPrompt }).slice(0, 16)}`;

/** Factor source interpretation without converting a frame into world evidence or perception. */
export function perceptionSourceFramesRequest(request: StructuredModelRequest<unknown>): StructuredModelRequest<z.infer<typeof perceptionSourceFramesSchema>> {
  const role = loadPromptAsset("system/truth-perception.md");
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive" ||
    request.system.split(role).length !== 2 || request.preprocessOutput || request.jsonExamplePolicy !== undefined ||
    request.promptVersion.includes(PERCEPTION_SOURCE_FRAMES) || request.wireJsonSchema &&
    contentHash(request.wireJsonSchema) !== contentHash(z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }))) {
    throw new ModelConfigurationError("source frames require the original perception request");
  }
  const sourceHash = contentHash(request.context), index = buildPerceptionSourceIndex(request.context);
  const pairShape = z.object({ targetIndex: z.number().int().nonnegative(),
    sourceActor: z.object({ entityRef: z.string() }), sourceAction: z.object({ actionRef: z.string(), rawText: z.string(), means: z.string().nullable() }) });
  const sources = new Map<string, ReturnType<typeof pairShape.parse>>(), groups = new Map<string, number[]>();
  for (const raw of index.workItems) {
    const row = pairShape.parse(raw), ref = row.sourceAction.actionRef;
    const prior = sources.get(ref);
    if (prior && (prior.sourceActor.entityRef !== row.sourceActor.entityRef || contentHash(prior.sourceAction) !== contentHash(row.sourceAction))) {
      throw new ModelConfigurationError("source frame action bindings disagree");
    }
    sources.set(ref, row); groups.set(ref, [...(groups.get(ref) ?? []), row.targetIndex]);
  }
  const sourceGroups = [...sources].map(([sourceActionRef, row]) => ({ sourceActionRef, sourceActorRef: row.sourceActor.entityRef, targetIndices: groups.get(sourceActionRef)! }));
  const context = structuredClone(request.context) as Record<string, unknown>;
  context.roleContract = { role: "truth-perception", purpose: "Source onset frame before observer projection",
    modelOwns: ["attempted current onset", "first directly receiving parties", "deferred steps", "unspoken intent", "explicit uncertainty"],
    engineOwns: ["source identity and quote membership", "all observer perception, check and commit admission"],
    failureRule: "A frame is untrusted interpretation; source binding is not semantic or gameplay qualification." };
  const adaptedHash = contentHash(context);
  const catalog = z.object({ referenceCatalog: z.object({ candidates: z.array(z.object({
    handle: z.string(), kind: z.string(), allowedUses: z.array(z.string()),
  })) }) }).parse(context).referenceCatalog.candidates;
  const byRef = new Map(catalog.map(row => [row.handle, row]));
  if (byRef.size !== catalog.length) throw new ModelConfigurationError("source frame catalog contains duplicate handles");
  return { ...request, schema: perceptionSourceFramesSchema, schemaName: "truth_perception_source_frames_probe", context,
    wireJsonSchema: z.toJSONSchema(perceptionSourceFramesSchema, { target: "draft-07" }),
    system: request.system.replace(role, system), userPrompt, jsonExamplePolicy: "omit",
    promptVersion: `${request.promptVersion}/${PERCEPTION_SOURCE_FRAMES}`,
    jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}\n\nExact original observer/source index; all world evidence remains authoritative.\n${JSON.stringify(index)}\n\nDistinct source groups (assignment joins, not event or perception findings):\n${JSON.stringify(sourceGroups)}`,
    preprocessOutput: value => {
      if (contentHash(request.context) !== sourceHash || contentHash(context) !== adaptedHash) throw new ModelConfigurationError("source frame context changed");
      const parsed = perceptionSourceFramesSchema.parse(value), seen = new Set<string>();
      const fail = (message: string): never => { throw new ModelOutputError(message, undefined, { rawValue: value }); };
      for (const frame of parsed.frames) {
        const source = sources.get(frame.sourceActionRef);
        if (!source || seen.has(frame.sourceActionRef) || source.sourceActor.entityRef !== frame.sourceActorRef) return fail("source frame identity mismatch");
        seen.add(frame.sourceActionRef);
        for (const quote of frame.sourceQuotes) {
          const text = source.sourceAction[quote.field];
          if (text === null || !quote.text.trim() || !text.includes(quote.text)) return fail("source frame quote is not an exact original action excerpt");
        }
        for (const recipient of frame.firstRecipients) if (recipient.entityRef !== null) {
          const row = byRef.get(recipient.entityRef);
          if (row?.kind !== "entity" || !row.allowedUses.includes("target")) return fail("source frame recipient is not an existing permitted entity");
        }
        for (const selected of frame.evidence) {
          const row = byRef.get(selected.ref);
          if (row?.kind !== selected.kind || !row.allowedUses.includes("assertion")) return fail("source frame evidence is not an existing permitted reference");
        }
      }
      if (seen.size !== sources.size) return fail("source frames omit an assigned action");
      return { value: parsed, symbolRepairs: [] };
    } };
}
