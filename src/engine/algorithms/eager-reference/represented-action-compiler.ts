import type { ModelExecutionAudit } from "../../contracts/model";
import type { ActionCompilationCapability } from "../roles";
import { compileActions } from "./action-compiler";
import { ActionCompilationCodec, actionCompilationProfileKinds, ACTION_COMPILATION_REPRESENTATION_VERSION, type ActionCompilationRepresentation } from "./action-compilation-representation";
import { loadPromptAsset, promptBundle } from "../../prompts";
import { contentHash } from "../../models/model-audit";
import { ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { SourceActionDescription } from "./source-action-description";

const referenceRule = "`candidateKey` is an opaque request-local selector, not an identity. Each key is exactly `candidate_` followed by twelve lowercase hexadecimal characters. Copy keys exactly from this request; do not derive, concatenate, abbreviate, normalize, or invent one. The engine resolves it after validation.";
const conditionalRule = "A conditional profile requires at least one continuation assertion that is already true at activity onset and remains true until its boundary. Use an exact candidate key or numeric comparison. Never invent a reference or submit an onset-false assertion.";

export function representedActionCompilationPrompt(representation: ActionCompilationRepresentation, sourceOwnedDescription = false, profileChoiceEvidence = false, namedTemporalContracts = false, omitSourceDescription = false) {
  if (omitSourceDescription && !sourceOwnedDescription) throw new Error("omitted description schema requires source ownership");
  const original = promptBundle("action-compilation");
  if (representation === "B1" && !sourceOwnedDescription && !profileChoiceEvidence && !namedTemporalContracts) return original;
  let system = original.system;
  const replacements = [
    [representation === "A" || representation === "AT", referenceRule, "shared/action-compilation-alias.md"],
    [representation === "T" || representation === "AT", conditionalRule, "shared/action-compilation-conditional.md"],
  ] as const;
  for (const [enabled, previous, asset] of replacements) {
    if (!enabled) continue;
    if (system.split(previous).length !== 2) throw new Error(`AC-FP1 base prompt drift at ${asset}`);
    system = system.replace(previous, loadPromptAsset(asset));
  }
  if (sourceOwnedDescription) system += `\n\n${omitSourceDescription
    ? loadPromptAsset("shared/action-compilation-source-description-omitted.md")
    : loadPromptAsset("shared/action-compilation-source-description.md")}`;
  if (profileChoiceEvidence) system += `\n\n${loadPromptAsset("shared/action-compilation-profile-choice.md")}`;
  if (namedTemporalContracts) system += `\n\n${loadPromptAsset("shared/action-compilation-temporal-contract.md")}`;
  return { ...original, system, version: `${original.id}/${representation}@${contentHash({ system, userPrompt: original.userPrompt, codec: ACTION_COMPILATION_REPRESENTATION_VERSION }).slice(0, 16)}` };
}

/** A representation adapter around the one production compiler. The gateway
 * audits wire output; the compiler still records canonical materialization and
 * performs the same slot, shortlist, temporal and dependency validation. */
export function representedActionCompiler(representation: ActionCompilationRepresentation, eligibleProfilesOnly = false, sourceOwnedDescription = false, profileChoiceEvidence = false, namedTemporalContracts = false, omitSourceDescription = false): ActionCompilationCapability {
  if (omitSourceDescription && !sourceOwnedDescription) throw new Error("omitted description schema requires source ownership");
  if (eligibleProfilesOnly && representation !== "T" && representation !== "AT") throw new Error("eligible profile schema requires a temporal representation");
  if (profileChoiceEvidence && representation !== "T" && representation !== "AT") throw new Error("profile choice evidence requires a temporal representation");
  if (namedTemporalContracts && representation !== "T" && representation !== "AT") throw new Error("named temporal contracts require a temporal representation");
  return async (provider, state, actions, scope, profileId, maxSlots, recovery, symbolRepairPolicy) => {
    const codecs = new Map<string, ActionCompilationCodec>();
    const fullContexts = new Map<string, unknown>();
    const retrieval = scope.actionCompilationRetrieval;
    const representedScope = retrieval ? { ...scope, actionCompilationRetrieval: {
      ...retrieval, retrieveBatch: async (input: Parameters<typeof retrieval.retrieveBatch>[0]) => {
        const selected = await retrieval.retrieveBatch(input);
        fullContexts.set(selected.modelContextHash, input.fullContext);
        return selected;
      },
    } } : scope;
    const prompt = representedActionCompilationPrompt(representation, sourceOwnedDescription, profileChoiceEvidence, namedTemporalContracts, omitSourceDescription);
    const adapted: StructuredModelProvider = {
      catalog: provider.catalog,
      availableProfileSummaries: (role) => provider.availableProfileSummaries(role),
      assertProfilesAvailable: (ids) => provider.assertProfilesAvailable(ids),
      async generateStructured(request) {
        const pinned = { ...request, modelRegistrySnapshotHash: scope.modelRegistrySnapshotHash };
        if (representation === "B1" && !sourceOwnedDescription) return provider.generateStructured(pinned);
        const rootId = request.correlation?.logicalInvocationId;
        if (!rootId) throw new Error("represented compiler requires physical root lineage");
        let current = codecs.get(rootId);
        if (!current) {
          current = new ActionCompilationCodec(representation, request.context, fullContexts.get(contentHash(request.context)) ?? request.context, actionCompilationProfileKinds(state), namedTemporalContracts);
          codecs.set(rootId, current);
        }
        const description = sourceOwnedDescription ? new SourceActionDescription(request.context, actions) : undefined;
        const restore = (raw: unknown) => description?.restore(current.decodeOutput(raw)) ?? current.decodeOutput(raw);
        const encode = (raw: unknown) => current.encodeOutput(description?.omit(raw) ?? raw);
        const schema = current.wireSchema(request.context, eligibleProfilesOnly, profileChoiceEvidence, request.schema);
        const wireSchema = description?.wireSchema(schema, omitSourceDescription) ?? schema;
        const decodeChecked = (raw: unknown, audit: ModelExecutionAudit | undefined) => {
          const canonical = current.decodeOutput(raw);
          try { description?.assertConsistent(canonical); }
          catch (error) {
            // Retain the exact candidate for repair. The compiler recognizes
            // this cause and rejects the entire attempt before localization.
            throw new ModelOutputError(error instanceof Error ? error.message : String(error), audit,
              { cause: error, rawValue: description?.restore(canonical) ?? canonical });
          }
          return description?.restore(canonical) ?? canonical;
        };
        const wireRequest = {
          ...pinned,
          system: prompt.system,
          promptVersion: prompt.version,
          schemaName: `action_compilation_${representation.toLowerCase()}${eligibleProfilesOnly ? "_eligible" : ""}${sourceOwnedDescription ? "_source" : ""}${profileChoiceEvidence ? "_choice" : ""}${namedTemporalContracts ? "_contract" : ""}${omitSourceDescription ? "_omitted" : ""}_v1`,
          schema: wireSchema,
          context: current.encodeContext(request.context),
          preprocessOutput: current.usesAliases ? current.aliasPreprocessor(wireSchema) : (raw: unknown) => {
            const prepared = request.preprocessOutput?.(restore(raw)) ?? { value: restore(raw), symbolRepairs: [] };
            return { ...prepared, value: encode(prepared.value) };
          },
        };
        let generated;
        try {
          generated = await provider.generateStructured(wireRequest);
        } catch (error) {
          if (!(error instanceof ModelOutputError)) throw error;
          throw new ModelOutputError(error.message, error.audit, { cause: error, rawValue: decodeChecked(error.rawValue, error.audit) });
        }
        const canonical = decodeChecked(generated.value, generated.audit);
        const parsed = request.schema.safeParse(canonical);
        if (!parsed.success) throw new ModelOutputError("invalid decoded Action Compilation representation", generated.audit, { cause: parsed.error, rawValue: canonical });
        return { value: parsed.data, audit: generated.audit };
      },
    };
    return compileActions(adapted, state, actions, representedScope, profileId, maxSlots, recovery, symbolRepairPolicy);
  };
}
