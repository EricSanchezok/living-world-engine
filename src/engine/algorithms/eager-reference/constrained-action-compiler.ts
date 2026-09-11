import { z } from "zod";
import type { ActionCompilationCapability } from "../roles";
import { constrainedNativeSchema } from "./constrained-native-schema";
import { actionCompilationCandidateKeyForHandle, createActionCompilationReferenceResolver, referenceHandleFor } from "../../contracts/model-context";
import { actionGroundingReferenceResolver, actionGroundingSharedContext } from "../../mechanics/action-dependency";
import { ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { loadPromptAsset, promptBundle } from "../../prompts";
import { compileActions } from "./action-compiler";
import { ConstrainedActionCompilationCodec, CONSTRAINED_COMPILATION_CODEC_VERSION } from "./constrained-action-compilation-codec";

export interface ConstrainedCompilationOptions {
  capabilities: boolean;
  snapshots: boolean;
  structuredOutputMode: "json-object-zod" | "json-schema-strict";
}

export function constrainedCompilationPrompt(options: ConstrainedCompilationOptions) {
  const original = promptBundle("action-compilation");
  const additions = [
    options.capabilities ? loadPromptAsset("shared/action-compilation-capabilities.md") : "",
    options.snapshots ? loadPromptAsset("shared/action-compilation-snapshot.md") : "",
  ].filter(Boolean);
  if (!additions.length) return original;
  const system = `${original.system}\n\n${additions.join("\n")}`;
  return { ...original, system, version: `${original.id}/CF@${contentHash({ system, userPrompt: original.userPrompt, codec: CONSTRAINED_COMPILATION_CODEC_VERSION }).slice(0, 16)}` };
}

/** Request-local adapter around the unchanged compiler and recovery chain. */
export function constrainedActionCompiler(options: ConstrainedCompilationOptions): ActionCompilationCapability {
  return async (provider, state, actions, scope, profileId, maxSlots, recovery, symbolRepairPolicy) => {
    const selectedByAction = new Map<string, readonly string[]>();
    const retrieval = scope.actionCompilationRetrieval;
    const adaptedScope = retrieval ? { ...scope, actionCompilationRetrieval: {
      ...retrieval, retrieveBatch: async (input: Parameters<typeof retrieval.retrieveBatch>[0]) => {
        const result = await retrieval.retrieveBatch(input);
        const context = input.fullContext as { task: { slots: Array<{ slot: number; actionReferences: { actionCandidateKey: string } }> } };
        for (const slot of context.task.slots) {
          const keys = result.selectedKeysBySlot.get(slot.slot);
          if (!keys) throw new Error("C/F lost the root action shortlist");
          selectedByAction.set(slot.actionReferences.actionCandidateKey, [...keys]);
        }
        return result;
      },
    } } : scope;
    const byKey = new Map(actions.map((action) => [String(actionCompilationCandidateKeyForHandle(referenceHandleFor("action", action.id))), action]));
    const prompt = constrainedCompilationPrompt(options);
    const adapted: StructuredModelProvider = {
      catalog: provider.catalog,
      availableProfileSummaries: (role) => provider.availableProfileSummaries(role),
      assertProfilesAvailable: (ids) => provider.assertProfilesAvailable(ids),
      async generateStructured(request) {
        const pinned = { ...request, modelRegistrySnapshotHash: scope.modelRegistrySnapshotHash, structuredOutputMode: options.structuredOutputMode };
        if (!options.capabilities && !options.snapshots) return provider.generateStructured(options.structuredOutputMode === "json-schema-strict"
          ? { ...pinned, wireJsonSchema: constrainedNativeSchema(z.toJSONSchema(request.schema, { target: "draft-07" })) } : pinned);
        const context = request.context as { task: { slots: Array<{ slot: number; actionReferences: { actionCandidateKey: string } }> } };
        const currentActions = context.task.slots.map((slot) => {
          const action = byKey.get(slot.actionReferences.actionCandidateKey);
          if (!action) throw new Error("C/F lost the actual request action binding");
          return action;
        });
        const slots = new Map(currentActions.map((action, index) => [action.id, context.task.slots[index]!.slot]));
        const base = actionGroundingReferenceResolver(state, currentActions, slots);
        const full = actionGroundingSharedContext(state, currentActions, base, true).referenceResolver;
        const selectedKeysBySlot = retrieval ? new Map(context.task.slots.map((slot) => {
          const keys = selectedByAction.get(slot.actionReferences.actionCandidateKey);
          if (!keys) throw new Error("C/F lost the original action shortlist");
          return [slot.slot, keys];
        })) : undefined;
        const codec = new ConstrainedActionCompilationCodec({ ...options, context: request.context, state,
          resolver: createActionCompilationReferenceResolver(full, full), selectedKeysBySlot });
        const wireJsonSchema = constrainedNativeSchema(codec.jsonSchema);
        const recordDecode = (wire: unknown, canonical: unknown) => scope.observer?.emit({
          event: "model.action_compilation.representation.decoded", correlation: { ...request.correlation, modelInvocationId: request.modelInvocationId },
          attributes: { codecVersion: CONSTRAINED_COMPILATION_CODEC_VERSION, capabilities: options.capabilities, snapshots: options.snapshots },
          hashes: { allowed: codec.allowedHash, wire: contentHash(wire ?? null), canonical: contentHash(canonical ?? null), schema: contentHash(wireJsonSchema) },
          payload: { slotIndices: codec.slotIndices, snapshotCopies: codec.snapshotEvidence },
        });
        let generated;
        try {
          generated = await provider.generateStructured({ ...pinned, system: prompt.system, promptVersion: prompt.version,
            schemaName: "constrained_compilation_v1", schema: codec.schema, wireJsonSchema, preprocessOutput: (raw: unknown) => {
              const canonical = codec.decodeOutput(raw);
              const prepared = request.preprocessOutput?.(canonical) ?? { value: canonical, symbolRepairs: [] };
              return { ...prepared, value: codec.encodeOutput(prepared.value) };
            } });
        } catch (error) {
          if (!(error instanceof ModelOutputError)) throw error;
          const decoded = codec.decodeOutput(error.rawValue);
          recordDecode(error.rawValue, decoded);
          throw new ModelOutputError(error.message, error.audit, { cause: error, rawValue: decoded });
        }
        const canonical = codec.decodeOutput(generated.value);
        recordDecode(generated.value, canonical);
        const parsed = request.schema.safeParse(canonical);
        if (!parsed.success) throw new ModelOutputError("invalid decoded C/F representation", generated.audit, { cause: parsed.error, rawValue: canonical });
        return { value: parsed.data, audit: generated.audit };
      },
    };
    return compileActions(adapted, state, actions, adaptedScope, profileId, maxSlots, recovery, symbolRepairPolicy);
  };
}
