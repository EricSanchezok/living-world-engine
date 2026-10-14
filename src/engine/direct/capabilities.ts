import { z } from "zod";
import type { SimulationState, ModelExecutionAudit } from "../contracts/model";
import type { JsonValue } from "../runtime/json";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import { ModelOutputError } from "../models/model-provider";
import type { ActionFrame, CapabilityDefinition, DirectRuntimeState } from "./contracts";
import type { DirectDecisions } from "./decisions";

const subject = z.enum(["actor", "target", "tool"]);
const declaration = z.object({ description: z.string().min(1), applicability: z.string().min(1), effectDescription: z.string().min(1),
  effects: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("fact"), subject, predicate: z.string().min(1), value: z.union([z.string().min(1), z.boolean()]), description: z.string().min(1) }),
    z.object({ kind: z.literal("condition"), subject, profileId: z.string().min(1) }),
    z.object({ kind: z.literal("placement"), subject, destination: z.enum(["actor", "target", "scene"]) }),
    z.object({ kind: z.literal("object"), name: z.string().min(1), description: z.string().min(1), placement: z.enum(["actor", "target"]) }),
  ])).min(1),
});

export async function extendCapability(input: { state: Readonly<SimulationState>; control: DirectRuntimeState; frame: ActionFrame;
  decisions: DirectDecisions; profileId: string; context: JsonValue }) {
  const { state, control, frame, decisions } = input, audits: ModelExecutionAudit[] = [];
  const system = loadPromptAsset("system/direct-capability.md"), userPrompt = loadPromptAsset("user/direct-capability.md");
  const roleBindings = { actor: "The acting character",
    target: !frame.targetEntityId ? null : frame.targetEntityId === frame.actorEntityId ? "The actor itself" : "A separate selected target entity",
    tool: !frame.toolEntityId ? null : frame.toolEntityId === frame.targetEntityId ? "The same entity as target" : "A separate selected instrument entity" };
  const roleProperties = Object.fromEntries(Object.entries({ actor: frame.actorEntityId, target: frame.targetEntityId, tool: frame.toolEntityId })
    .map(([role, entityId]) => [role, Object.values(state.truth.facts).filter(fact => fact.subjectId === entityId && fact.access.kind === "public")
      .map(fact => ({ predicate: fact.predicate, value: fact.value, description: fact.description }))]));
  let previous: unknown = null, repairIssues: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try { result = await decisions.provider.generateStructured({ ...decisions.scope, modelRegistrySnapshotHash: control.registryHash,
      profileId: input.profileId, subjectId: frame.actorId, role: "creation", modelInvocation: decisions.next(frame.actorId),
      system, userPrompt, promptVersion: `direct-capability-${contentHash({ system, userPrompt })}`, schemaName: "DirectCapabilityV1", schema: declaration,
      context: { requestedAction: input.context, roleBindings, roleProperties, conditionProfiles: state.truth.mechanics.conditionProfiles, previous, repairIssues } as unknown as JsonValue, jsonExamplePolicy: "omit" });
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { audits });
      if (error.audit) audits.push(error.audit);
      previous = error.rawValue ?? null; repairIssues = [error.message];
      if (attempt === 0) continue;
      throw Object.assign(error, { audits });
    }
    audits.push(result.audit); previous = result.value; repairIssues = [];
    for (const effect of result.value.effects) {
      if (effect.kind === "condition" && !state.truth.mechanics.conditionProfiles[effect.profileId]) repairIssues.push(`Unknown condition profile: ${effect.profileId}`);
      if (effect.kind !== "object" && effect.subject === "target" && !frame.targetEntityId) repairIssues.push("The action has no target");
      if (effect.kind !== "object" && effect.subject === "tool" && !frame.toolEntityId) repairIssues.push("The action has no tool");
      if (effect.kind === "object" && effect.placement === "target" && !frame.targetEntityId) repairIssues.push("The object placement has no target");
      if (effect.kind === "placement" && effect.destination === "target" && !frame.targetEntityId) repairIssues.push("The destination has no target");
      if (effect.kind === "placement") {
        const bound = { actor: frame.actorEntityId, target: frame.targetEntityId, tool: frame.toolEntityId, scene: state.truth.placements[frame.actorEntityId] };
        if (bound[effect.subject] && bound[effect.subject] === bound[effect.destination]) repairIssues.push("A placement cannot put an entity inside itself. Express posture or use of an appearance detail as a fact on its actual owner.");
      }
    }
    if (repairIssues.length) continue;
    const id = `capability-${contentHash(result.value).slice(0, 24)}`;
    const capability: CapabilityDefinition = { ...result.value, id, kind: "use", scope: "world", ownerId: null, sourceIds: [],
      createdByActionId: frame.id, version: 1, knownToAgentIds: [frame.actorId] };
    if (!control.capabilities.some(existing => existing.id === id)) control.capabilities.push(capability);
    frame.capabilityId = id;
    return { capability, audits };
  }
  const error = new Error(`Capability requires correction: ${repairIssues.join("; ")}`);
  Object.assign(error, { audits }); throw error;
}
