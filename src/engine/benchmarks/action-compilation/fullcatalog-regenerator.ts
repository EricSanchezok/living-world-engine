import type {
  ActionCompilationReferenceAudit,
  ModelExecutionAudit,
  SimulationState,
} from "../../contracts/model";
import {
  ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH,
  ACTION_COMPILATION_CANDIDATE_KEY_VERSION,
  ACTION_COMPILATION_PROJECTION,
} from "../../contracts/model-context";
import { DEFAULT_SYMBOL_REPAIR_POLICY } from "../../contracts/symbol-repair";
import type { StructuredModelProvider } from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import { validateSimulationState } from "../../runtime/transaction";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../runtime/observability";
import { FULL_CATALOG_ALGORITHM_REF } from "../../algorithms/registry";
import {
  ACTION_COMPILER_PROMPT_VERSION,
  compileActions,
} from "../../algorithms/eager-reference/action-compiler";
import { DEFAULT_EAGER_OUTPUT_RECOVERY } from "../../algorithms/eager-reference/eager-slot-batching";
import type {
  RawBenchmarkSource,
  RegeneratedActionCompilationReference,
} from "../source-capture";

function referenceAudit(event: RuntimeEvent): ActionCompilationReferenceAudit | undefined {
  if (event.event !== "model.action_compilation.references" ||
    !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) return undefined;
  const payload = event.payload as Partial<ActionCompilationReferenceAudit>;
  return payload.projection === ACTION_COMPILATION_PROJECTION && Array.isArray(payload.slots)
    ? payload as ActionCompilationReferenceAudit
    : undefined;
}

function assertSourceContract(source: RawBenchmarkSource): void {
  if (contentHash(source.fullContext) !== source.fullContextHash ||
    contentHash(source.stateSnapshot) !== source.stateHash) {
    throw new Error(`source ${source.sourceInvocationId} context/state hash does not match its payload`);
  }
  if (source.actions.length === 0 || source.actions.length !== source.actionIds.length ||
    source.actions.length !== source.slotIndices.length ||
    contentHash(source.actions.map((action) => action.id)) !== contentHash(source.actionIds)) {
    throw new Error(`source ${source.sourceInvocationId} does not contain a complete physical action batch`);
  }
  if (source.promptVersion !== ACTION_COMPILER_PROMPT_VERSION ||
    source.projectorVersion !== ACTION_COMPILATION_PROJECTION ||
    source.candidateKeyVersion !== ACTION_COMPILATION_CANDIDATE_KEY_VERSION ||
    source.candidateKeyPayloadLength !== ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH ||
    source.symbolRepairPolicyVersion !== DEFAULT_SYMBOL_REPAIR_POLICY.version) {
    throw new Error(`source ${source.sourceInvocationId} is incompatible with the installed Action Compilation contract`);
  }
}

function invocationAudits(audits: readonly ModelExecutionAudit[]): Map<string, ModelExecutionAudit["invocations"][number]> {
  return new Map(audits.flatMap((audit) => audit.invocations.map((invocation) => [invocation.id, invocation] as const)));
}

export async function regenerateActionCompilationFullCatalog(
  source: RawBenchmarkSource,
  provider: StructuredModelProvider,
): Promise<RegeneratedActionCompilationReference> {
  assertSourceContract(source);
  const state = structuredClone(source.stateSnapshot) as SimulationState;
  validateSimulationState(state, false, true);
  const capturedExecution = source.fullContext.execution as { instanceId?: unknown; advanceId?: unknown } | undefined;
  if (typeof capturedExecution?.instanceId !== "string" || typeof capturedExecution.advanceId !== "string") {
    throw new Error(`source ${source.sourceInvocationId} has incomplete execution context identity`);
  }
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const result = await compileActions(
    provider,
    state,
    structuredClone(source.actions),
    {
      workloadId: capturedExecution.instanceId,
      batchId: capturedExecution.advanceId,
      correlation: { executionId: `reference:${source.sourceExecutionId}`, revision: state.revision },
      observer,
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
      modelRegistrySnapshotHash: source.registrySnapshotHash,
      executionAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
    },
    source.profileId,
    source.actions.length,
    DEFAULT_EAGER_OUTPUT_RECOVERY,
    DEFAULT_SYMBOL_REPAIR_POLICY,
  );

  const regeneratedCapture = observer.events.find((event) =>
    event.event === "model.action_compilation.context.captured" &&
    (event.correlation?.semanticRepairAttempt ?? 0) === 0);
  if (regeneratedCapture?.hashes?.fullContext !== source.fullContextHash) {
    throw new Error(`FullCatalog regenerated a different full context for ${source.sourceInvocationId}`);
  }
  for (const audit of result.modelAudits) {
    if (audit.profileId !== source.profileId || audit.modelId !== source.modelId ||
      audit.promptVersion !== source.promptVersion || audit.modelCatalogHash !== source.modelCatalogHash ||
      audit.registrySnapshotHash !== source.registrySnapshotHash) {
      throw new Error(`FullCatalog regeneration drifted from captured model provenance for ${source.sourceInvocationId}`);
    }
  }

  const finalByAction = new Map<string, {
    slot: ActionCompilationReferenceAudit["slots"][number];
    invocationId: string;
    repairCount: number;
  }>();
  for (const event of observer.events) {
    const reference = referenceAudit(event);
    const invocationId = event.correlation?.modelInvocationId;
    if (!reference || !invocationId) continue;
    for (const slot of reference.slots) {
      finalByAction.set(slot.actionId, {
        slot,
        invocationId,
        repairCount: event.correlation?.semanticRepairAttempt ?? 0,
      });
    }
  }
  const audits = invocationAudits(result.modelAudits);
  const slots = source.actions.flatMap((action, index) => {
    const final = finalByAction.get(action.id);
    if (!final) throw new Error(`FullCatalog regeneration omitted ${action.id}`);
    if (final.slot.selections.some((selection) => selection.status !== "resolved")) {
      throw new Error(`FullCatalog regeneration retained an invalid reference for ${action.id}`);
    }
    const invocation = audits.get(final.invocationId);
    if (!invocation?.rawOutputHash || !invocation.normalizedOutputHash) {
      throw new Error(`FullCatalog regeneration has incomplete output provenance for ${action.id}`);
    }
    return [{
      slotIndex: source.slotIndices[index]!,
      requiredCandidateKeys: [...new Set(final.slot.selections.map((selection) => selection.candidateKey))].sort(),
      repairCount: final.repairCount,
      rawOutputHash: invocation.rawOutputHash,
      normalizedOutputHash: invocation.normalizedOutputHash,
    }];
  });
  const providerRequests = result.modelAudits.reduce((count, audit) =>
    count + audit.invocations.reduce((sum, invocation) => sum + invocation.transports.length, 0), 0);
  if (providerRequests < 1) throw new Error("FullCatalog regeneration made no provider request");
  return {
    fullContextHash: source.fullContextHash,
    providerRequests,
    fullyValidated: true,
    slots,
  };
}
