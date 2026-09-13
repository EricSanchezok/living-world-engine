import { z } from "zod";
import { onsetPerceptionReportSchema, perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { existingReferenceHandleSchemaFor } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { buildPerceptionSourceIndex } from "./perception-source-index";

const system = loadPromptAsset("system/perception-temporal-routes.md");
const userPrompt = loadPromptAsset("user/perception-temporal-routes.md");
const indexNotice = loadPromptAsset("shared/perception-temporal-route-index.md");
export const PERCEPTION_TEMPORAL_ROUTES = `perception-temporal-routes-v1@${contentHash({ system, userPrompt, indexNotice }).slice(0, 16)}`;

const common = onsetPerceptionReportSchema.options[0].omit({ kind: true });
const stimulus = onsetPerceptionReportSchema.options[1].shape.stimulus;
const channelEvidence = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("fact"), ref: existingReferenceHandleSchemaFor("fact") }),
  z.strictObject({ kind: z.literal("law"), ref: existingReferenceHandleSchemaFor("law") }),
]);
export const perceptionTemporalRouteReportSchema = z.discriminatedUnion("route", [
  common.extend({ route: z.literal("direct_current"), presentCue: z.string().trim().min(1), stimulus }),
  common.extend({ route: z.literal("current_channel"), channelDescription: z.string().trim().min(1), channelBasis: z.array(channelEvidence).min(1), stimulus }),
  common.extend({ route: z.literal("awaiting_transfer"), firstReceiver: z.string().trim().min(1), requiredTransfer: z.string().trim().min(1) }),
  common.extend({ route: z.literal("no_current_stimulus") }),
]);
export const perceptionTemporalRoutesSchema = z.discriminatedUnion("kind", [
  perceptionDirectiveSchema.options[0],
  z.strictObject({ kind: z.literal("done"), reports: z.array(perceptionTemporalRouteReportSchema) }),
]);

/** Compile a selected temporal case; this does not certify its free-form world semantics. */
export function perceptionTemporalRoutesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  const originalRole = loadPromptAsset("system/truth-perception.md");
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive" || request.preprocessOutput ||
    request.system.split(originalRole).length !== 2 || request.promptVersion.includes(PERCEPTION_TEMPORAL_ROUTES) ||
    request.jsonExamplePolicy !== undefined || request.wireJsonSchema && contentHash(request.wireJsonSchema) !== contentHash(z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }))) {
    throw new ModelConfigurationError("temporal routes require the original unadapted perception request");
  }
  const sourceHash = contentHash(request.context), index = buildPerceptionSourceIndex(request.context);
  const targetIdentity = z.object({ targetIndex: z.number().int().nonnegative() });
  const targets = new Set(index.workItems.map(row => targetIdentity.parse(row).targetIndex));
  const source = z.looseObject({ referenceCatalog: z.looseObject({ candidates: z.array(z.looseObject({
    handle: z.string(), kind: z.string(), allowedUses: z.array(z.string()),
  })) }) }).parse(request.context);
  const catalog = new Map(source.referenceCatalog.candidates.map(row => [row.handle, row]));
  if (catalog.size !== source.referenceCatalog.candidates.length) throw new ModelConfigurationError("temporal route catalog has duplicate references");
  const context = structuredClone(request.context) as Record<string, unknown>;
  context.roleContract = {
    role: "truth-perception", purpose: "Current observer perception with explicit temporal route cases",
    modelOwns: ["source cue interpretation", "actual first recipient", "current route or required later transfer", "check requests", "private stimulus"],
    engineOwns: ["pair identity", "case-to-canonical-tag mapping", "fixed checks", "persistent identities", "world commitment"],
    failureRule: "A pending transfer has no current stimulus; correct case selection and cue semantics still require source review.",
  };
  const adaptedHash = contentHash(context);
  return { ...request, schemaName: "truth_perception_temporal_routes", context,
    system: request.system.replace(originalRole, system), userPrompt, jsonExamplePolicy: "omit",
    wireJsonSchema: z.toJSONSchema(perceptionTemporalRoutesSchema, { target: "draft-07" }),
    jsonObjectPostlude: `${request.jsonObjectPostlude ?? ""}\n\n${indexNotice}\n${JSON.stringify(index)}`,
    promptVersion: `${request.promptVersion}/${PERCEPTION_TEMPORAL_ROUTES}`,
    preprocessOutput: value => {
      if (contentHash(request.context) !== sourceHash || contentHash(context) !== adaptedHash) throw new ModelConfigurationError("temporal route source changed");
      const parsed = perceptionTemporalRoutesSchema.parse(value);
      if (parsed.kind === "request_checks") return { value: parsed, symbolRepairs: [] };
      const seen = new Set<number>();
      const reports = parsed.reports.map(report => {
        if (!targets.has(report.targetIndex) || seen.has(report.targetIndex)) throw new ModelOutputError("temporal route assignment mismatch", undefined, { rawValue: value });
        seen.add(report.targetIndex);
        if (report.route === "current_channel") {
          const used = new Set<string>();
          for (const basis of report.channelBasis) {
            const entry = catalog.get(basis.ref), key = `${basis.kind}:${basis.ref}`;
            if (entry?.kind !== basis.kind || !entry.allowedUses.includes("assertion") || used.has(key) ||
              !report.evidence.some(evidence => evidence.kind === basis.kind && evidence.ref === basis.ref)) {
              throw new ModelOutputError("temporal channel basis must be unique existing permitted report evidence", undefined, { rawValue: value });
            }
            used.add(key);
          }
        }
        const base = { targetIndex: report.targetIndex, reason: report.reason, evidence: report.evidence, checkRefs: report.checkRefs };
        return report.route === "direct_current" || report.route === "current_channel"
          ? { ...base, kind: "perceived" as const, stimulus: report.stimulus }
          : { ...base, kind: "no_stimulus" as const };
      });
      if (seen.size !== targets.size) throw new ModelOutputError("temporal route reports omit an assigned pair", undefined, { rawValue: value });
      return { value: perceptionDirectiveSchema.parse({ kind: "done", reports }), symbolRepairs: [] };
    } };
}
