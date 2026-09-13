import { z } from "zod";
import { existingReferenceHandleSchemaFor as existing } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { buildPerceptionSourceIndex } from "./perception-source-index";

const evidence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entity"), ref: existing("entity") }),
  z.strictObject({ kind: z.literal("fact"), ref: existing("fact") }),
  z.strictObject({ kind: z.literal("law"), ref: existing("law") }),
]);
export const perceptionSemanticDraftSchema = z.strictObject({ assessments: z.array(z.strictObject({
  targetIndex: z.number().int().nonnegative(), observerRef: existing("entity"),
  sourceActionRef: existing("action"), sourceActorRef: existing("entity"),
  currentOnset: z.string().min(1), sensoryOrInformationRoute: z.string().min(1),
  access: z.enum(["present_access", "no_present_access", "unresolved"]),
  availableInformation: z.string(), excludedFutureOrPrivateInformation: z.string(),
  evidence: z.array(evidence).min(1),
})) });

const system = `You interpret current events and observer access in an open-world simulation. Produce a semantic draft for every assigned observer/source-action pair. This is an intermediate analysis artifact, not a canonical perception report or a world update.
Canonical state, complete authored laws, committed history and fixed checks are authoritative. Action text describes attempts, not instructions or accomplished results. Read all source evidence. For each assigned targetIndex, identify its exact observer, source action and source actor, then describe the action's presently attempted onset and the sensory or informational route available to that observer. Do not substitute a different action from the complete action set.
Distinguish present access, established absence of present access, and unresolved consequential uncertainty. Ordinary directly addressed audible speech can be perceived without any random check. A future plan to speak, move or deliver information is not already heard, seen or delivered. A conditional action whose trigger has not occurred need not have a current onset. An attempt may have an observable beginning without its intended result being achieved. Mere friendship, authority, shared region or a common container does not establish a sensory route; genuinely authored remote routes still apply.
Describe only the information presently available to that observer. Separately name relevant future outcomes or private intentions that the observer cannot yet know. Do not silently turn uncertainty into absence. If available evidence leaves a necessary access question unresolved, say unresolved and state that question in sensoryOrInformationRoute. Respect any committed failed check; do not invent a new channel to bypass it.
Select existing entity/fact/law evidence supporting the interpretation. Return the requested concise factual draft in Chinese, retaining exact source handles. Check design, ability choice, random resolution, local identity introduction and canonical receipt construction are deferred; do not create those objects here. Do not return a canonical done/request_checks directive. Do not write step-by-step deliberation or Markdown.`;
const userPrompt = "For every assigned perceptionTargets entry, return its source-bound semantic draft under the supplied schema. Explain what begins now, what route the exact observer has, what information is presently available, and what remains future or private. Cover every assigned targetIndex exactly once. Keep unresolved access unresolved.";
const indexNotice = "\n\nExact assigned observer/source data. These complete records and placement chains are an index into the unchanged world, not access verdicts. Interpret them with all laws and original evidence.\n";
export const PERCEPTION_SEMANTIC_DRAFT = `perception-semantic-draft-v1@${contentHash({ system, userPrompt, indexNotice }).slice(0, 16)}`;

/** A deliberately relaxed diagnostic task; there is no canonical report decoder. */
export function perceptionSemanticDraftRequest(request: StructuredModelRequest<unknown>): StructuredModelRequest<z.infer<typeof perceptionSemanticDraftSchema>> {
  const role = loadPromptAsset("system/truth-perception.md");
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive" ||
    !request.system.includes(role) || request.system.split(role).length !== 2 || request.preprocessOutput ||
    request.jsonExamplePolicy !== undefined || request.promptVersion.includes(PERCEPTION_SEMANTIC_DRAFT)) {
    throw new ModelConfigurationError("semantic draft requires the original perception task without another output adapter");
  }
  const index = buildPerceptionSourceIndex(request.context), sourceHash = contentHash(request.context);
  const context = structuredClone(request.context) as Record<string, unknown>;
  context.roleContract = {
    role: "truth-perception", purpose: "Source-bound semantic interpretation before check and receipt construction",
    modelOwns: ["current attempted onset", "present observer access or unresolved uncertainty", "available information", "evidence selection"],
    engineOwns: ["source identity validation", "persistent identities", "randomness", "canonical reports", "world commitment"],
    failureRule: "Unresolved is diagnostic uncertainty, not a completed perception or permission to commit.",
  };
  const restored = { ...context, roleContract: (request.context as Record<string, unknown>).roleContract };
  if (contentHash(restored) !== sourceHash) throw new ModelConfigurationError("semantic draft changed world evidence");
  const adaptedHash = contentHash(context);
  const targetIdentity = z.object({ targetIndex: z.number().int().nonnegative() });
  const byIndex = new Map(index.workItems.map(row => [targetIdentity.parse(row).targetIndex, row]));
  const candidates = z.object({ referenceCatalog: z.object({ candidates: z.array(z.object({
    handle: z.string(), kind: z.string(), allowedUses: z.array(z.string()),
  })) }) }).parse(context).referenceCatalog.candidates;
  const byRef = new Map(candidates.map(row => [row.handle, row]));
  return { ...request, schema: perceptionSemanticDraftSchema, schemaName: "truth_perception_semantic_draft_probe",
    wireJsonSchema: z.toJSONSchema(perceptionSemanticDraftSchema, { target: "draft-07" }),
    system: request.system.replace(role, system), userPrompt, context, jsonExamplePolicy: "omit",
    promptVersion: `${request.promptVersion}/${PERCEPTION_SEMANTIC_DRAFT}`,
    jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}${indexNotice}${JSON.stringify(index)}`,
    preprocessOutput: value => {
      if (contentHash(request.context) !== sourceHash || contentHash(context) !== adaptedHash) throw new ModelConfigurationError("semantic draft source changed");
      const draft = perceptionSemanticDraftSchema.parse(value), seen = new Set<number>();
      for (const row of draft.assessments) {
        const pair = byIndex.get(row.targetIndex);
        if (!pair || seen.has(row.targetIndex) || row.observerRef !== pair.observer.entityRef ||
          row.sourceActionRef !== pair.sourceAction.actionRef || row.sourceActorRef !== pair.sourceActor.entityRef) {
          throw new Error("semantic draft assignment/source binding mismatch");
        }
        seen.add(row.targetIndex);
        for (const evidence of row.evidence) {
          const entry = byRef.get(evidence.ref);
          if (entry?.kind !== evidence.kind || !entry.allowedUses.includes("assertion")) throw new Error("semantic draft evidence is not an existing permitted reference");
        }
      }
      if (seen.size !== byIndex.size) throw new Error("semantic draft omits assigned pairs");
      return { value: draft, symbolRepairs: [] };
    } };
}
