import { z } from "zod";
import type { AgentPerspectiveView, ModelExecutionAudit } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { modelInvocationCorrelation, modelInvocationIdentity, type ModelExecutionScope, type StructuredModelProvider } from "../models/model-provider";
import { runSemanticRepairLoop, SemanticRepairExhaustedError } from "../models/semantic-repair";
import { loadPromptAsset } from "../prompts";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_VERSION } from "../prompts/logical-repair-context";
import type { ProgramAttemptWork } from "./interpreter";

const utteranceSchema = z.object({ text: z.string().trim().min(1) }).strict();
export type ProgramUtterance =
  | { status: "ready"; text: string; sourceHash: string; audit: ModelExecutionAudit }
  | { status: "failed"; recoverable: true; sourceHash: string; reason: string; audit: ModelExecutionAudit | null };

/** Content is authored from one private perspective before the world decides whether anyone receives it. */
export async function createProgramUtterance(provider: StructuredModelProvider, input: ModelExecutionScope & {
  profileId: string; invocationBase: number; perspective: AgentPerspectiveView; work: ProgramAttemptWork;
}): Promise<ProgramUtterance> {
  if (input.work.kind !== "utterance") throw new Error("speech creation requires an actual utterance frontier");
  const context = JSON.parse(JSON.stringify({ perspective: input.perspective, work: input.work, task: { constraints: [] }, repair: null }));
  const sourceHash = contentHash(context), system = loadPromptAsset("system/program-utterance.md");
  const userPrompt = "Write the concrete words this Agent will attempt to say for this program node.";
  const promptVersion = `program-utterance-${contentHash({ system, userPrompt, repair: LOGICAL_CANDIDATE_REPAIR_VERSION })}`;
  const logicalInvocationId = modelInvocationIdentity(input, "creation", input.perspective.agentId, input.invocationBase).modelInvocationId;
  try {
    const result = await runSemanticRepairLoop<z.infer<typeof utteranceSchema>>({ role: "creation", repairScope: "invocation", targetIds: [input.work.id],
      maxRepairs: 1, logicalInvocationId, validate: value => { utteranceSchema.parse(value); },
      invoke: async repair => {
        const identity = modelInvocationIdentity(input, "creation", input.perspective.agentId, input.invocationBase + repair.attempt);
        return provider.generateStructured({ ...input, ...identity, role: "creation", subjectId: input.perspective.agentId,
          promptVersion, schemaName: "ProgramUtteranceV1", schema: utteranceSchema, system, userPrompt, jsonExamplePolicy: "omit",
          ...(repair.attempt > 0 ? { repairContextPlacement: "logical-tail-v1" as const } : {}),
          correlation: modelInvocationCorrelation(input, "creation", input.perspective.agentId, identity, { logicalInvocationId,
            semanticRepairAttempt: repair.attempt, ...(repair.parentInvocationId ? { parentInvocationId: repair.parentInvocationId } : {}),
            ...(repair.repairOf ? { repairOf: repair.repairOf } : {}) }),
          context: logicalRepairContext({ ...context, repair: { issues: repair.issues } }, repair, sourceHash, "ProgramUtteranceV1") });
      } });
    return { status: "ready", text: result.value.text, sourceHash, audit: result.audit };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    return { status: "failed", recoverable: true, sourceHash, reason: error.message, audit: error.audit ?? null };
  }
}
