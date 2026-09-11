import type { ActionCompilationCapability, ActionCompilationResult, CandidateSelectionCapability } from "../../algorithms/roles";
import type { AlgorithmRef } from "../../algorithms/composition";
import { representedActionCompiler } from "../../algorithms/eager-reference/represented-action-compiler";
import type { ModelExecutionAudit, SimulationState } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../runtime/observability";
import type { RawBenchmarkSource } from "../source-capture";
import { firstPassAlgorithmRef, type FirstPassTrial } from "./first-pass-protocol";

export interface FirstPassCallEvidence {
  ordinal: number;
  invocationId: string | null;
  semanticRepairAttempt: number;
  parentInvocationId: string | null;
  promptVersion: string;
  schemaName: string;
  context: unknown;
  value?: unknown;
  audit?: ModelExecutionAudit;
  error?: { name: string; message: string };
}

export type CompilationTrialIdentity = Omit<FirstPassTrial, "arm"> & { arm: string };
export interface FirstPassTrialEvidence<T extends CompilationTrialIdentity = FirstPassTrial> {
  trial: T;
  sourceHash: string;
  algorithmManifestHash: string;
  startedAt: string;
  completedAt: string;
  wallMs: number;
  compilerAccepted: boolean;
  result?: ActionCompilationResult;
  error?: { name: string; message: string };
  calls: FirstPassCallEvidence[];
  events: RuntimeEvent[];
  stateUnchanged: boolean;
  semanticVerdict: "pending-intent-review";
}

function errorEvidence(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownError", message: String(error) };
}

/** Actual production compiler + gateway boundary. No oracle is accepted by this
 * function: scoring cannot influence runtime recovery or spend extra calls. */
export async function executeFirstPassTrial(input: {
  trial: FirstPassTrial;
  source: RawBenchmarkSource;
  provider: StructuredModelProvider;
  retrieval: CandidateSelectionCapability;
}): Promise<FirstPassTrialEvidence> {
  return executeCompilationTrial({ ...input, compiler: representedActionCompiler(input.trial.arm),
    algorithmRef: firstPassAlgorithmRef(input.source.captureAlgorithmRef, input.trial.arm),
    executionPrefix: "ac-fp1", expectedCatalogHash: input.source.modelCatalogHash, expectedOutputMode: "json-object-zod" });
}

export async function executeCompilationTrial<T extends CompilationTrialIdentity>(input: {
  trial: T; source: RawBenchmarkSource; provider: StructuredModelProvider; retrieval: CandidateSelectionCapability;
  compiler: ActionCompilationCapability; algorithmRef: AlgorithmRef<"world-execution">;
  executionPrefix: string; expectedCatalogHash: string; expectedOutputMode: "json-object-zod" | "json-schema-strict" | "deterministic-test";
}): Promise<FirstPassTrialEvidence<T>> {
  const { trial, source } = input;
  const state = structuredClone(source.stateSnapshot) as SimulationState;
  const ref = input.algorithmRef;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const calls: FirstPassCallEvidence[] = [];
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const provider: StructuredModelProvider = {
    catalog: input.provider.catalog,
    availableProfileSummaries: (role) => input.provider.availableProfileSummaries(role),
    assertProfilesAvailable: (ids) => input.provider.assertProfilesAvailable(ids),
    async generateStructured(request) {
      if (request.profileId !== source.profileId || request.modelRegistrySnapshotHash !== source.registrySnapshotHash) {
        throw new ModelConfigurationError("trial lost its captured profile/registry pin");
      }
      const call: FirstPassCallEvidence = {
        ordinal: calls.length, invocationId: request.modelInvocationId ?? null,
        semanticRepairAttempt: request.correlation?.semanticRepairAttempt ?? 0,
        parentInvocationId: request.correlation?.parentInvocationId ?? null,
        promptVersion: request.promptVersion, schemaName: request.schemaName, context: request.context,
      };
      calls.push(call);
      try {
        const generated = await input.provider.generateStructured(request);
        call.value = generated.value;
        // Keep the live audit reference: the production compiler subsequently
        // records materialization, normalization and rejection disposition.
        call.audit = generated.audit;
        return generated;
      } catch (error) {
        call.error = errorEvidence(error);
        if (error instanceof ModelOutputError) { call.value = error.rawValue; call.audit = error.audit; }
        else if (error && typeof error === "object" && "audit" in error) call.audit = error.audit as ModelExecutionAudit | undefined;
        throw error;
      }
    },
  };
  let firstRetrieval = true;
  let result: ActionCompilationResult | undefined;
  let error: FirstPassTrialEvidence["error"];
  const execution = source.fullContext.execution as { instanceId: string; advanceId: string };
  try {
    result = await input.compiler(provider, state, source.actions, {
      workloadId: execution.instanceId, batchId: execution.advanceId,
      correlation: { executionId: `${input.executionPrefix}:${trial.id}`, revision: state.revision },
      observer, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
      modelRegistrySnapshotHash: source.registrySnapshotHash, executionAlgorithmRef: ref,
      actionCompilationRetrieval: { ...input.retrieval, retrieveBatch: async (request) => {
        const initial = firstRetrieval;
        firstRetrieval = false;
        if (initial && (contentHash(request.fullContext) !== source.fullContextHash || request.slotIndices.length !== source.actions.length)) {
          throw new ModelConfigurationError("initial full context or physical batch drift");
        }
        const selected = await input.retrieval.retrieveBatch(request);
        if (initial && (selected.modelContextHash !== source.modelContextHash || selected.shortlistHash !== source.shortlistHash)) {
          throw new ModelConfigurationError("initial R5 shortlist/model context drift");
        }
        return selected;
      } },
    }, source.profileId, source.actions.length);
  } catch (caught) { error = errorEvidence(caught); }
  const stateUnchanged = contentHash(state) === source.stateHash;
  if (!stateUnchanged) throw new Error("trial mutated the captured source state");
  for (const call of calls) {
    if (call.audit && (call.audit.modelId !== source.modelId || call.audit.profileId !== source.profileId ||
      call.audit.registrySnapshotHash !== source.registrySnapshotHash || call.audit.modelCatalogHash !== input.expectedCatalogHash ||
      call.audit.structuredOutputMode !== input.expectedOutputMode)) {
      throw new Error(`trial provider provenance drift: ${trial.id}`);
    }
  }
  return {
    trial, sourceHash: contentHash(source), algorithmManifestHash: ref.manifestHash, startedAt,
    completedAt: new Date().toISOString(), wallMs: performance.now() - started,
    compilerAccepted: Boolean(result), ...(result ? { result } : {}), ...(error ? { error } : {}),
    calls, events: observer.events, stateUnchanged, semanticVerdict: "pending-intent-review",
  };
}
