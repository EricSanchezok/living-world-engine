import { z } from "zod";
import type { SimulationState } from "../contracts/model";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import { contentHash } from "../models/model-audit";
import { modelInvocationIdentity, type ModelExecutionScope, type StructuredModelProvider } from "../models/model-provider";
import { runSemanticRepairLoop, SemanticRepairExhaustedError } from "../models/semantic-repair";
import type { ExternalActionInput } from "../runtime/execution";
import { runtimeId } from "../runtime/runtime-id";
import type { WorldAttempt } from "./adjudication";
import { loadPromptAsset } from "../prompts";

const utteranceSchema = z.object({ utterance: z.string().trim().min(1).nullable() }).strict();
export function externalWorldAttempt(source: Readonly<SimulationState>, action: ExternalActionInput, utterance: string | null): WorldAttempt {
  const agent = source.agents[action.agentId];
  if (!agent || !action.rawText.trim()) throw new Error("external action requires an active actor and concrete intent");
  const targetEntityIds = action.targetIds.map(localId => {
    const binding = agent.bindings[localId];
    if (!agent.belief.localEntities[localId] || !binding || binding.canonicalEntityIds.length !== 1 ||
      !source.truth.entities[binding.canonicalEntityIds[0]!]) throw new Error("external action target requires identity clarification");
    return binding.canonicalEntityIds[0]!;
  });
  return { id: runtimeId({ worldHash: source.worldHash, revision: source.revision, kind: "action", stage: "external-program",
    owner: [agent.id, action.submissionId], round: 0, ordinal: 0 }), actorId: agent.id, actorEntityId: agent.entityId,
    intent: action.rawText, utterance, targetEntityIds, startedAtSeconds: source.truth.elapsedSeconds, program: null };
}
export async function authorExternalAction(provider: StructuredModelProvider, state: Readonly<SimulationState>, action: ExternalActionInput,
  scope: ModelExecutionScope & { profileId: string; invocationBase: number }) {
  externalWorldAttempt(state, action, null);
  const context = JSON.parse(JSON.stringify({ action, perspective: projectAgentPerspective(state as SimulationState, state.agents[action.agentId]!) }));
  const sourceHash = contentHash(context), system = loadPromptAsset("system/external-program-action.md");
  const userPrompt = loadPromptAsset("user/external-program-action.md");
  const promptVersion = `external-program-action-${contentHash({ system, userPrompt })}`;
  const logicalInvocationId = modelInvocationIdentity(scope, "creation", action.agentId, scope.invocationBase).modelInvocationId;
  try {
    const result = await runSemanticRepairLoop<z.infer<typeof utteranceSchema>>({ role: "creation", repairScope: "invocation",
      targetIds: [action.submissionId], maxRepairs: 1, logicalInvocationId, validate: output => {
        const quoted = [...action.rawText.matchAll(/"([^"]+)"|“([^”]+)”|「([^」]+)」/gu)].map(match => match[1] ?? match[2] ?? match[3]!);
        if (output.utterance !== null && quoted.some(words => !output.utterance!.includes(words))) throw new Error("explicitly quoted player words must be preserved exactly");
      },
      invoke: async repair => {
        const identity = modelInvocationIdentity(scope, "creation", action.agentId, scope.invocationBase + repair.attempt);
        return provider.generateStructured({ ...scope, ...identity, role: "creation", subjectId: action.agentId,
          schemaName: "ExternalProgramActionV1", schema: utteranceSchema, system, userPrompt,
          promptVersion, jsonExamplePolicy: "omit", context: { ...context, repair: { issues: repair.issues, sourceHash } } });
      } });
    return { status: "ready" as const, attempt: externalWorldAttempt(state, action, result.value.utterance), audit: result.audit };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    return { status: "failed" as const, reason: error.message, audit: error.audit ?? null };
  }
}
