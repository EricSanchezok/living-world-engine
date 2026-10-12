import { z } from "zod";
import type { AgentPerspectiveView, AgentState, ModelExecutionAudit } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { modelInvocationCorrelation, modelInvocationIdentity, type ModelExecutionScope, type StructuredModelProvider } from "../models/model-provider";
import { runSemanticRepairLoop, SemanticRepairExhaustedError } from "../models/semantic-repair";
import { loadPromptAsset } from "../prompts";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_VERSION } from "../prompts/logical-repair-context";
import { validateModelAudit } from "../runtime/transaction";
import { frozenClone } from "../runtime/json";

const proposedClaimSchema = z.object({
  subjectId: z.string().min(1), predicate: z.string().trim().min(1),
  value: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("text"), value: z.string() }).strict(),
    z.object({ kind: z.literal("number"), value: z.number().finite() }).strict(),
    z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
    z.object({ kind: z.literal("none") }).strict(),
    z.object({ kind: z.literal("local_entity"), localEntityId: z.string().min(1) }).strict(),
  ]), description: z.string().trim().min(1), evidenceIds: z.array(z.string().min(1)).min(1),
}).strict();
export const beliefCreationSchema = z.object({ claims: z.array(proposedClaimSchema).min(1) }).strict();
export type BeliefCreationDraft = z.infer<typeof beliefCreationSchema>;
export type BeliefCreation =
  | { status: "ready"; sourceHash: string; value: BeliefCreationDraft; audit: ModelExecutionAudit }
  | { status: "failed"; sourceHash: string; reason: string; recoverable: true; audit: ModelExecutionAudit | null };

export function beliefCreationInput(agent: Readonly<AgentState>, perspective: AgentPerspectiveView, evidenceIds: string[]) {
  const context = frozenClone({ perspective, newEvidenceIds: evidenceIds, entityIds: Object.keys(agent.belief.localEntities).sort(),
    evidenceIds: Object.keys(agent.belief.evidence).sort(), existingClaims: Object.values(agent.belief.claims).sort((a, b) => a.id.localeCompare(b.id)),
    task: { constraints: [] }, repair: null });
  const wireSchema = z.object({ claims: z.array(proposedClaimSchema.extend({
    subjectId: z.enum(context.entityIds), evidenceIds: z.array(z.enum(context.evidenceIds)).min(1),
    value: z.discriminatedUnion("kind", [proposedClaimSchema.shape.value.options[0], proposedClaimSchema.shape.value.options[1],
      proposedClaimSchema.shape.value.options[2], proposedClaimSchema.shape.value.options[3],
      z.object({ kind: z.literal("local_entity"), localEntityId: z.enum(context.entityIds) }).strict()]),
  })).min(1) }).strict();
  const wireJsonSchema = z.toJSONSchema(wireSchema, { target: "draft-07", reused: "ref" });
  const sourceHash = contentHash(context), system = loadPromptAsset("system/program-belief-creation.md");
  const userPrompt = loadPromptAsset("user/program-belief-creation.md");
  const promptVersion = `program-belief-creation-${contentHash({ system, userPrompt, sourceHash, contract: 1, repair: LOGICAL_CANDIDATE_REPAIR_VERSION })}`;
  const signature = (claim: z.infer<typeof proposedClaimSchema>) => contentHash({ subjectId: claim.subjectId, predicate: claim.predicate, value: claim.value });
  const validate = (value: BeliefCreationDraft) => {
    beliefCreationSchema.parse(value);
    const seen = new Set(Object.values(agent.belief.claims).map(signature));
    for (const claim of value.claims) {
      if (!agent.belief.localEntities[claim.subjectId] || claim.value.kind === "local_entity" && !agent.belief.localEntities[claim.value.localEntityId]) {
        throw new Error("new belief uses an unknown local entity; choose only supplied entityIds");
      }
      if (new Set(claim.evidenceIds).size !== claim.evidenceIds.length || claim.evidenceIds.some(id => !agent.belief.evidence[id]) ||
        !claim.evidenceIds.some(id => evidenceIds.includes(id))) throw new Error("new belief must reference actual evidence including a newly delivered item");
      const key = signature(claim); if (seen.has(key)) throw new Error("new belief duplicates an existing or proposed claim");
      seen.add(key);
    }
  };
  return { context, sourceHash, system, userPrompt, promptVersion, wireJsonSchema, validate };
}

export async function createEventBeliefs(provider: StructuredModelProvider, agent: Readonly<AgentState>, perspective: AgentPerspectiveView,
  evidenceIds: string[], scope: ModelExecutionScope & { profileId: string; invocationBase: number }): Promise<BeliefCreation> {
  const input = beliefCreationInput(agent, perspective, evidenceIds);
  const logicalInvocationId = modelInvocationIdentity(scope, "creation", agent.id, scope.invocationBase).modelInvocationId;
  try {
    const result = await runSemanticRepairLoop<BeliefCreationDraft>({ role: "creation", repairScope: "invocation",
      targetIds: evidenceIds, maxRepairs: 1, logicalInvocationId, validate: input.validate,
      invoke: async repair => {
        const identity = modelInvocationIdentity(scope, "creation", agent.id, scope.invocationBase + repair.attempt);
        return provider.generateStructured({ ...scope, ...identity, role: "creation", subjectId: agent.id,
          promptVersion: input.promptVersion, schemaName: "PrivateBeliefExpansionV1", schema: beliefCreationSchema, wireJsonSchema: input.wireJsonSchema,
          system: input.system, userPrompt: input.userPrompt, jsonExamplePolicy: "omit",
          ...(repair.attempt > 0 ? { repairContextPlacement: "logical-tail-v1" as const } : {}),
          correlation: modelInvocationCorrelation(scope, "creation", agent.id, identity, { logicalInvocationId,
            semanticRepairAttempt: repair.attempt, ...(repair.parentInvocationId ? { parentInvocationId: repair.parentInvocationId } : {}),
            ...(repair.repairOf ? { repairOf: repair.repairOf } : {}) }),
          context: logicalRepairContext({ ...input.context, repair: { issues: repair.issues } }, repair, input.sourceHash, "PrivateBeliefExpansionV1") });
      } });
    return { status: "ready", sourceHash: input.sourceHash, value: result.value, audit: result.audit };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    return { status: "failed", sourceHash: input.sourceHash, reason: error.message, recoverable: true, audit: error.audit ?? null };
  }
}

export function validateBeliefCreation(agent: Readonly<AgentState>, perspective: AgentPerspectiveView, evidenceIds: string[],
  creation: BeliefCreation, profileId: string) {
  const input = beliefCreationInput(agent, perspective, evidenceIds);
  if (creation.sourceHash !== input.sourceHash) throw new Error("belief creation used another private input");
  if (creation.audit) {
    validateModelAudit(creation.audit, "private belief creation");
    if (creation.audit.role !== "creation" || creation.audit.subjectId !== agent.id || creation.audit.profileId !== profileId ||
      creation.audit.promptVersion !== input.promptVersion) throw new Error("belief creation used another owner, model or prompt");
  }
  if (creation.status === "ready") {
    input.validate(creation.value);
    if (!creation.audit.invocations.some(invocation => invocation.normalizedOutputHash === contentHash(creation.value) &&
      invocation.outputDisposition !== "rejected")) throw new Error("belief creation has no matching accepted invocation");
  }
}
