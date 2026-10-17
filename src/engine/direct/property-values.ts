import { z } from "zod";
import type { ModelExecutionAudit, SimulationState, WorldFact } from "../contracts/model";
import type { JsonValue } from "../runtime/json";
import { contentHash } from "../models/model-audit";
import { ModelOutputError } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import type { ActionFrame, CapabilityDefinition } from "./contracts";
import type { DirectDecisions } from "./decisions";
import { capabilityDeclarationSchema, capabilityDeclarationIssues, rememberCapability } from "./capabilities";
import { changedFact } from "./presentation";

/** Concrete replacements belong to this prepared action, never to a learned capability. */
export async function proposePropertyValues(input: {
  state: Readonly<SimulationState>; frame: ActionFrame; decisions: DirectDecisions; profileId: string;
  properties: WorldFact[]; authorView: JsonValue; laws: JsonValue; needsCapability: boolean;
}) {
  const { state, frame, decisions, properties, needsCapability } = input;
  if (!properties.length || properties.some(fact => fact.value.kind !== "text")) throw new Error("Open property values require existing text properties");
  const roleIds = { actor: frame.actorEntityId, target: frame.targetEntityId, tool: frame.toolEntityId };
  const bound = properties.map((fact, index) => ({ key: `p${index}`, subject: Object.entries(roleIds).find(([, id]) => id === fact.subjectId)![0],
    predicate: fact.predicate, description: fact.description, currentValue: fact.value }));
  const schema = z.object({
    values: z.object(Object.fromEntries(bound.map(property => [property.key, z.string()]))).strict(),
    capability: needsCapability ? capabilityDeclarationSchema : z.null(),
  }).strict();
  const system = loadPromptAsset("system/direct-property-values.md"), userPrompt = loadPromptAsset("user/direct-property-values.md");
  const audits: ModelExecutionAudit[] = [];
  let previous: unknown = null, repairIssues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await decisions.provider.generateStructured({ ...decisions.scope, modelRegistrySnapshotHash: decisions.control.registryHash,
        profileId: input.profileId, subjectId: frame.actorId, role: "creation", modelInvocation: decisions.next(frame.actorId),
        system, userPrompt, promptVersion: `direct-property-values-${contentHash({ system, userPrompt })}`,
        schemaName: "DirectPropertyValuesV1", schema,
        context: { propertyValueRequest: {
          action: frame.expression ?? { attempt: frame.proposal.rawText, utterance: frame.utterance, manner: null },
          properties: bound, author: input.authorView, laws: input.laws, needsCapability,
          roles: { actor: "The acting subject", target: frame.targetEntityId ? "The selected target" : null, tool: frame.toolEntityId ? "The selected instrument" : null },
          ...(needsCapability ? { conditionProfiles: state.truth.mechanics.conditionProfiles } : {}),
        }, previous, repairIssues } as unknown as JsonValue, jsonExamplePolicy: "omit" });
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { audits });
      if (error.audit) audits.push(error.audit);
      previous = error.rawValue ?? null; repairIssues = [error.message];
      if (attempt === 0) continue;
      throw Object.assign(error, { audits });
    }
    audits.push(result.audit); previous = result.value; repairIssues = [];
    if (result.value.capability) {
      repairIssues.push(...capabilityDeclarationIssues(result.value.capability, frame, state));
      for (const effect of result.value.capability.effects) if (effect.kind === "fact" && properties.some(fact =>
        fact.subjectId === roleIds[effect.subject] && fact.predicate === effect.predicate)) {
        repairIssues.push(`Keep the action-bound ${effect.subject}.${effect.predicate} value only in values, not in reusable effects.`);
      }
    }
    if (repairIssues.length) continue;
    const values = properties.map((fact, index): WorldFact => changedFact(fact, { kind: "text", value: result.value.values[`p${index}`]! }));
    const capability: CapabilityDefinition | null = result.value.capability ? rememberCapability(result.value.capability, decisions.control, frame) : null;
    return { values, capability, audits };
  }
  throw Object.assign(new Error(`Property values require correction: ${repairIssues.join("; ")}`), { audits });
}
