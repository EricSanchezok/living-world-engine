import { z } from "zod";
import type { ModelExecutionAudit } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { modelInvocationCorrelation, modelInvocationIdentity, type ModelExecutionScope, type StructuredModelProvider } from "../models/model-provider";
import { runSemanticRepairLoop, SemanticRepairExhaustedError } from "../models/semantic-repair";
import { loadPromptAsset } from "../prompts";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_VERSION } from "../prompts/logical-repair-context";
import { assertJsonValue, frozenClone, type JsonValue } from "../runtime/json";
import { admitProgram, bindProgram, programDefinitionSchema, programKey, type AdmittedProgram, type ProgramAdmission } from "./definition";
import { encodeProgramDraft, lowerProgramDraft, programDraftSchema } from "./creation-codec";

export const programCreationSchema = z.object({ definition: programDefinitionSchema, parameters: z.record(programKey, z.json()) }).strict();
export interface ProgramCompilationRequest extends ModelExecutionScope {
  profileId: string;
  ownerId: string;
  goalId: string;
  intent: string;
  reason: "initial-coverage" | "new-intent" | "revision";
  perspective: JsonValue;
  resources: Record<string, JsonValue>;
  sources: Record<string, JsonValue>;
  goalIds: string[];
  entityIds: string[];
  invocationBase: number;
  priorProgram?: JsonValue;
}
export type ProgramCompilationResult =
  | { status: "ready"; sourceHash: string; program: AdmittedProgram; parameters: Record<string, JsonValue>; audit: ModelExecutionAudit }
  | { status: "failed"; sourceHash: string; ownerId: string; goalId: string; reason: string; recoverable: true; audit: ModelExecutionAudit | null };

/** One initial generation plus one targeted repair; failure remains explicit and retryable on new evidence. */
export async function compileAgentProgram(provider: StructuredModelProvider, input: ProgramCompilationRequest): Promise<ProgramCompilationResult> {
  if (!input.goalIds.includes(input.goalId)) throw new Error("program compilation requires an actual authorized goal");
  const owner = z.object({ agentId: z.literal(input.ownerId) }).passthrough();
  owner.parse(input.perspective);
  if (!Number.isSafeInteger(input.invocationBase) || input.invocationBase < 1) throw new Error("invalid compiler invocation base");
  const context = frozenClone({ ownerId: input.ownerId, goalId: input.goalId, intent: input.intent, reason: input.reason,
    perspective: input.perspective, resources: input.resources, resourceKeys: Object.keys(input.resources).sort(),
    sources: input.sources, sourceIds: Object.keys(input.sources).sort(), goalIds: input.goalIds, entityIds: input.entityIds,
    priorProgram: input.priorProgram ?? null, task: { constraints: [] }, repair: null });
  assertJsonValue(context, "program compilation source");
  const sourceHash = contentHash(context);
  const admission: ProgramAdmission = { ownerId: input.ownerId, sources: new Map(Object.entries(input.sources).map(([id, source]) => [id, contentHash(source)])),
    resources: new Set(Object.keys(input.resources)), goalIds: new Set(input.goalIds) };
  const entities = new Set(input.entityIds);
  const draftSchema = programDraftSchema(input.entityIds);
  const wireJsonSchema = z.toJSONSchema(draftSchema, { target: "draft-07", reused: "ref" });
  const validate = (value: z.infer<typeof programCreationSchema>) => {
    const program = admitProgram(value.definition, admission);
    if (!program.definition.goals.some(goal => goal.goalId === input.goalId)) throw new Error("generated program does not cover the requested goal");
    bindProgram(program, value.parameters, entities);
  };
  const system = loadPromptAsset("system/program-creation.md"), userPrompt = loadPromptAsset("user/program-creation.md");
  const promptVersion = `program-creation-${contentHash({ system, userPrompt, contract: 2, wireJsonSchema, repair: LOGICAL_CANDIDATE_REPAIR_VERSION, layout: "logical-tail-v1" })}`;
  const logicalInvocationId = modelInvocationIdentity(input, "creation", input.ownerId, input.invocationBase).modelInvocationId;
  try {
    const result = await runSemanticRepairLoop({ role: "creation", repairScope: "invocation", targetIds: [input.goalId], maxRepairs: 1,
      logicalInvocationId, validate,
      invoke: async repair => {
        if (sourceHash !== contentHash(context)) throw new Error("program source changed during compilation");
        const identity = modelInvocationIdentity(input, "creation", input.ownerId, input.invocationBase + repair.attempt);
        const previous = programCreationSchema.safeParse(repair.previousOutput);
        let wireRepairCandidate: unknown = null;
        if (previous.success) {
          try { wireRepairCandidate = encodeProgramDraft(previous.data.definition, previous.data.parameters); } catch { /* Original rejection evidence is retained. */ }
        }
        return provider.generateStructured({ ...input, ...identity, role: "creation", subjectId: input.ownerId,
          schemaName: "AgentBehaviorTreeV1", schema: programCreationSchema, wireJsonSchema, system, userPrompt, promptVersion, jsonExamplePolicy: "omit",
          preprocessOutput: raw => ({ value: lowerProgramDraft(draftSchema.parse(raw), input.ownerId), symbolRepairs: [] }),
          ...(repair.attempt > 0 ? { repairContextPlacement: "logical-tail-v1" as const } : {}),
          correlation: modelInvocationCorrelation(input, "creation", input.ownerId, identity, { logicalInvocationId,
            semanticRepairAttempt: repair.attempt, ...(repair.parentInvocationId ? { parentInvocationId: repair.parentInvocationId } : {}),
            ...(repair.repairOf ? { repairOf: repair.repairOf } : {}) }),
          context: logicalRepairContext({ ...context, wireRepairCandidate, repair: { issues: repair.issues } }, repair, sourceHash, "AgentBehaviorTreeV1"),
        });
      },
    });
    const program = admitProgram(result.value.definition, admission);
    return { status: "ready", sourceHash, program,
      parameters: bindProgram(program, result.value.parameters, entities), audit: result.audit };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    return { status: "failed", sourceHash, ownerId: input.ownerId, goalId: input.goalId, reason: error.message,
      recoverable: true, audit: error.audit ?? null };
  }
}
