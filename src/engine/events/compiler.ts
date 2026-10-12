import { z } from "zod";
import { worldDeltaOperationSchema } from "../contracts/llm-schemas";
import type { ModelExecutionAudit, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { modelInvocationCorrelation, modelInvocationIdentity, type ModelExecutionScope, type StructuredModelProvider } from "../models/model-provider";
import { runSemanticRepairLoop, SemanticRepairExhaustedError } from "../models/semantic-repair";
import { programKey, type ProgramResources } from "../programs/definition";
import { loadPromptAsset } from "../prompts";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_VERSION } from "../prompts/logical-repair-context";
import { frozenClone, type JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { worldProgramDuration, worldQuestionWork, type BoundWorldProgram, type WorldAttempt } from "./adjudication";
import { captureReads, worldProgramSources } from "./resources";
import { admitWorldProgram, bindWorldProgram, renderWorldText, worldProgramSchema } from "./world-program";
import { decodeWorldDraft, encodeWorldDraft, worldDraftSchema } from "./creation-codec";
import { prepareWorldRandomPlan } from "./randomness";
import { worldMechanicContracts } from "./mechanics";
import { worldActivityClaims } from "./activities";

export const worldCompilationSchema = z.object({ definition: worldProgramSchema, parameters: z.record(programKey, z.json()) }).strict();
export interface WorldCompilationRequest extends ModelExecutionScope {
  profileId: string; invocationBase: number; definition: WorldRuntimeContract; state: Readonly<SimulationState>;
  resources: ProgramResources; attempt: WorldAttempt; reason: "initial-coverage" | "new-intent" | "revision";
  rejection?: { reason: string; program: BoundWorldProgram | null; evidenceHashes: string[] };
}
export type WorldCompilation =
  | { status: "ready"; bound: BoundWorldProgram; sourceHash: string; audit: ModelExecutionAudit }
  | { status: "failed"; recoverable: true; sourceHash: string; attemptId: string; reason: string; audit: ModelExecutionAudit | null };

export async function compileWorldProgram(provider: StructuredModelProvider, request: WorldCompilationRequest): Promise<WorldCompilation> {
  if (!Number.isSafeInteger(request.invocationBase) || request.invocationBase < 1) throw new Error("invalid world compiler invocation base");
  if (request.state.agents[request.attempt.actorId]?.entityId !== request.attempt.actorEntityId) throw new Error("world compiler attempt ownership mismatch");
  const sources = worldProgramSources(request.definition, request.state), entities = new Set(Object.keys(request.state.truth.entities));
  // Explicit projection: never serialize request.state, whose Agent entries contain hidden cognition and identity bindings.
  const sourceAddresses = Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, id.startsWith("fact:")
    ? { resourceRef: id, hash: contentHash(source) } : source]));
  const context = frozenClone({ shared: { sources: sourceAddresses, sourceIds: Object.keys(sources),
    // Lossless view: atomic keys address the same values in these collections; do not send their contents twice.
    resources: Object.fromEntries(Object.entries(request.resources).filter(([key]) => !key.includes(":") && key !== "rng")),
    resourceKeys: Object.keys(request.resources).filter(key => key !== "rng").sort(), entityIds: [...entities].sort(),
    resourceAddressing: { entity: "entities[id]", placement: "placements[id]", fact: "facts[id]", meter: "meters[id]", quantity: "quantities[id]",
      rating: "ratings[id]", condition: "conditions[id]", activity: "activities[id]", pool: "pools[id]", timer: "timers[id]", law: "laws entry matching id",
      temporal: "mechanics.temporalProfiles[id]" },
    effectContract: z.toJSONSchema(worldDeltaOperationSchema, { target: "draft-07", reused: "ref" }),
    mechanicContracts: worldMechanicContracts(request.definition) },
    task: { attempt: request.attempt, reason: request.reason, rejection: request.rejection ?? null, constraints: [] }, repair: null });
  const sourceHash = contentHash(context);
  const validate = (output: z.infer<typeof worldCompilationSchema>) => {
    const program = admitWorldProgram(output.definition, sources); bindWorldProgram(program, output.parameters, entities);
    if (output.parameters.actor !== request.attempt.actorEntityId) throw new Error("world compiler changed the action owner");
    if (request.attempt.utterance !== null && (program.definition.parameters.utterance?.kind !== "text" ||
      output.parameters.utterance !== request.attempt.utterance ||
      program.definition.branches.some(branch => branch.deliveries.some(delivery => delivery.kind === "speech" && delivery.text !== "{utterance}")))) {
      throw new Error("pre-action speech must bind the reusable utterance text parameter exactly");
    }
    const bound: BoundWorldProgram = { program, parameters: output.parameters, attempt: request.attempt };
    captureReads(request.resources, program.definition.reads.filter(key => !key.startsWith("random:")).map(key => renderWorldText(key, bound.parameters)));
    worldProgramDuration(bound, request.resources);
    worldActivityClaims(bound, request.state, request.resources);
    // Build every branch before accepting it, so malformed effect shapes get the single targeted repair.
    if (!program.definition.random.length) worldQuestionWork(bound, request.resources, { state: request.state, definition: request.definition });
    else prepareWorldRandomPlan(request.state, request.definition, request.resources, [bound]);
  };
  const system = loadPromptAsset("system/world-program-creation.md"), userPrompt = loadPromptAsset("user/world-program-creation.md");
  const promptVersion = `world-program-creation-${contentHash({ system, userPrompt, contract: 3, repair: LOGICAL_CANDIDATE_REPAIR_VERSION, layout: "logical-tail-v1" })}`;
  const logicalInvocationId = modelInvocationIdentity(request, "creation", "world", request.invocationBase).modelInvocationId;
  const scope = { workloadId: request.workloadId, batchId: request.batchId, runtimeIdentity: request.runtimeIdentity,
    modelRegistrySnapshotHash: request.modelRegistrySnapshotHash, observer: request.observer, abortSignal: request.abortSignal,
    cancelPendingSignal: request.cancelPendingSignal, executionAlgorithmRef: request.executionAlgorithmRef,
    logicalStage: request.logicalStage, stageHooks: request.stageHooks };
  try {
    const result = await runSemanticRepairLoop({ role: "creation", repairScope: "invocation", targetIds: [request.attempt.id], maxRepairs: 1,
      logicalInvocationId, validate, invoke: async repair => {
        const identity = modelInvocationIdentity(request, "creation", "world", request.invocationBase + repair.attempt);
        const previous = worldCompilationSchema.safeParse(repair.previousOutput);
        const wireRepairCandidate = previous.success ? encodeWorldDraft(previous.data.definition, previous.data.parameters as Record<string, JsonValue>) : null;
        return provider.generateStructured({ ...scope, ...identity, profileId: request.profileId, subjectId: "world", role: "creation",
          schemaName: "WorldProgramV3", schema: worldCompilationSchema,
          wireJsonSchema: z.toJSONSchema(worldDraftSchema([...entities].sort()), { target: "draft-07" }),
          system, userPrompt, promptVersion, jsonExamplePolicy: "omit",
          preprocessOutput: raw => ({ value: decodeWorldDraft(raw, [...entities].sort()), symbolRepairs: [] }),
          ...(repair.attempt > 0 ? { repairContextPlacement: "logical-tail-v1" as const } : {}),
          correlation: modelInvocationCorrelation(request, "creation", "world", identity, { logicalInvocationId,
            semanticRepairAttempt: repair.attempt, ...(repair.parentInvocationId ? { parentInvocationId: repair.parentInvocationId } : {}), ...(repair.repairOf ? { repairOf: repair.repairOf } : {}) }),
          context: logicalRepairContext({ ...context, wireRepairCandidate, repair: { issues: repair.issues } }, repair, sourceHash, "WorldProgramV3"),
        });
      } });
    return { status: "ready", sourceHash, bound: { program: admitWorldProgram(result.value.definition, sources),
      parameters: result.value.parameters as Record<string, JsonValue>, attempt: frozenClone(request.attempt) }, audit: result.audit };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    return { status: "failed", recoverable: true, sourceHash, attemptId: request.attempt.id, reason: error.message, audit: error.audit ?? null };
  }
}
