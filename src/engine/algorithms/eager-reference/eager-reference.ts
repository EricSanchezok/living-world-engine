import { validateOnsetPerceptionReceipts } from "../../mechanics/onset-receipts";
import type { OnsetPerceptionTranscript } from "../../runtime/execution";
import { TRUTH_RESOLUTION_CONTRACT_VERSION } from "../roles";
import { AgentMind } from "./agent-mind";
import { compileActions } from "./action-compiler";
import { DEFAULT_EAGER_OUTPUT_RECOVERY } from "./eager-slot-batching";
import type {
  ActionCompilationCapability,
  AgentCognitionBatchInput,
  AgentCognitionCapability,
  AlgorithmBatchMetrics,
  CandidateSelectionCapability,
  InteractionGroundingCapability,
  ObservationRenderingCapability,
  OnsetPerceptionCapability,
  OutputRecoveryCapability,
  PlannedTemporalActivity,
  ReactionDecisionCapability,
  TruthResolution,
  UnreviewedTruthResolution,
  TruthCandidateStage,
  TruthCandidateSession,
  TruthCandidateFeedback,
  BoundCausalReview,
  CausalReviewEvidence,
  TruthResolutionCapability,
  TruthResolutionInput,
} from "../roles";
import {
  ActivityFootprintIndex,
  buildInteractionDependencyGraph,
  interactionDependencyComponents,
  forceGlobalInteractionDependency,
  generateInteractionDependency,
  interactionDependencyForActivity,
  interactionDependencyForCondition,
  interactionDependencyForTimer,
  interactionDependenciesConflict,
  resolutionExceedsDeclaredDependencies,
  resolvedComponentsConflict,
} from "../../mechanics/action-dependency";
import { evaluateProposalCausality } from "../../mechanics/causality";
import { defineAlgorithmRef } from "../composition";
import { algorithmManifest } from "../../runtime/execution";
import type {
  InteractionDependency,
  BootstrapCandidate,
  BootstrapInput,
  ExecutionContext,
  ExternalActionInput,
  ExternalReactionInput,
  JsonObject,
  WorldExecutionAlgorithm,
  AlgorithmManifest,
  WorldStepCandidate,
  WorldStepInput,
  WorldStepPreparation,
} from "../../runtime/execution";
import {
  StepPreparationInvalidatedError,
  finalCausalReviewContentHash,
  WORLD_STEP_CANDIDATE_SCHEMA_VERSION,
  WORLD_STEP_PREPARATION_SCHEMA_VERSION,
} from "../../runtime/execution";
import type { AgentMindOutput } from "../../contracts/llm-schemas";
import type {
  AgentActionProposal,
  AgentId,
  CausalRef,
  MechanicInvocation,
  ModelExecutionAudit,
  ObservationPacket,
  ReactionDecision,
  ReactionRequest,
  SimulationState,
  TransitionProposal,
} from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { applyMindCommit } from "../../cognition/mind-commit";
import {
  ModelSemanticRepairError,
  ModelCandidateValidationError,
  type StructuredModelProvider,
} from "../../models/model-provider";
import { applyObservationBindings, pendingObservationsFor, validateObservations } from "../../cognition/observation";
import { ObservationRenderer } from "../../cognition/observation-renderer";
import { createCoreRulePackageRegistry, type RulePackageRegistry } from "../../mechanics/rule-package";
import { runtimeId } from "../../runtime/runtime-id";
import { executionStage } from "../../runtime/stages";
import { applyTransitionProposal } from "../../runtime/transaction";
import { TruthEngine, assertCausalReviewMatches } from "../../mechanics/truth-engine";
import { TruthBatchCoordinator } from "../../mechanics/truth-batch-provider";
import { OrderedRandomStream } from "../../mechanics/ordered-random-stream";
import { causalReviewRepairIssues, type ResolutionScope } from "../../contracts/prompts";
import {
  cancelActivity,
  cancelDeferredActivity,
  advanceTemporalState,
  blockScheduledActivity,
  pauseActivity,
  reconcileTemporalOutcomes,
  selectTemporalBoundary,
  settleActivityContexts,
  startReadyActivity,
  validateActivityResources,
  evaluateActivityContinuation,
  type TemporalAdvanceResult,
  type TemporalBoundary,
  type ActivityTransition,
  type ScheduledActivityState,
} from "../../mechanics/temporal";
import {
  applySharedResourceAdmissions,
  materializeSharedResourceAdmissionOutcomes,
  planSharedResourceAdmissions,
  promoteSharedResourceQueues,
  type SharedResourceAdmission,
} from "../../mechanics/shared-resource-allocation";
import {
  ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH,
  ACTION_COMPILATION_CANDIDATE_KEY_VERSION,
} from "../../contracts/model-context";
import {
  ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
} from "./candidate-retrieval/runtime";
import {
  RELATIONAL_RRF_ENCODER_FINGERPRINT,
  RELATIONAL_RRF_ENCODER_MODEL_ID,
} from "./candidate-retrieval/relational-rrf";
import { DEFAULT_SYMBOL_REPAIR_POLICY, type SymbolRepairPolicy } from "../../contracts/symbol-repair";

export type EagerReferenceCandidateRetrievalConfig =
  | { mode: "off" }
  | { mode: "runtime"; runtimeVersion: string; encoderFingerprint: string; budgetRatio: 0.2 };

export interface EagerReferenceAlgorithmConfig {
  actionCompilationMaxSlots: number;
  agentMindMaxSlots: number;
  reactionMaxSlots: number;
  groundingMaxSlots: number;
  truthBatchMaxSlots: number;
  candidateRetrieval: EagerReferenceCandidateRetrievalConfig;
}

interface NormalizedEagerReferenceAlgorithmConfig {
  actionCompilationMaxSlots: number;
  agentMindMaxSlots: number;
  reactionMaxSlots: number;
  groundingMaxSlots: number;
  truthBatchMaxSlots: number;
  candidateRetrieval: EagerReferenceCandidateRetrievalConfig;
}

const EAGER_REFERENCE_LIMITS = {
  actionCompilationMaxSlots: 12,
  agentMindMaxSlots: 8,
  reactionMaxSlots: 8,
  groundingMaxSlots: 16,
  truthBatchMaxSlots: 12,
} as const;

export const FULL_CATALOG_EAGER_REFERENCE_CONFIG: Readonly<EagerReferenceAlgorithmConfig> = Object.freeze({
  ...EAGER_REFERENCE_LIMITS,
  candidateRetrieval: { mode: "off" as const },
});

export const DEFAULT_EAGER_REFERENCE_CONFIG: Readonly<EagerReferenceAlgorithmConfig> = Object.freeze({
  ...EAGER_REFERENCE_LIMITS,
  candidateRetrieval: {
    mode: "runtime" as const,
    runtimeVersion: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
    encoderFingerprint: RELATIONAL_RRF_ENCODER_FINGERPRINT,
    budgetRatio: 0.2 as const,
  },
});

function slotLimit(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 64) {
    throw new Error(`${label} must be an integer from 1 through 64`);
  }
  return Number(value);
}

export function parseEagerReferenceAlgorithmConfig(value: unknown): NormalizedEagerReferenceAlgorithmConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("eager-reference config must be an object");
  }
  const input = value as Record<string, unknown>;
  const expected = [
    "actionCompilationMaxSlots",
    "agentMindMaxSlots",
    "candidateRetrieval",
    "groundingMaxSlots",
    "reactionMaxSlots",
    "truthBatchMaxSlots",
  ];
  const keys = Object.keys(input).sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error(`eager-reference config fields must be exactly: ${expected.join(", ")}`);
  }
  return {
    actionCompilationMaxSlots: slotLimit(
      input.actionCompilationMaxSlots,
      "actionCompilationMaxSlots",
    ),
    agentMindMaxSlots: slotLimit(input.agentMindMaxSlots, "agentMindMaxSlots"),
    reactionMaxSlots: slotLimit(
      input.reactionMaxSlots,
      "reactionMaxSlots",
    ),
    groundingMaxSlots: slotLimit(
      input.groundingMaxSlots,
      "groundingMaxSlots",
    ),
    truthBatchMaxSlots: slotLimit(input.truthBatchMaxSlots, "truthBatchMaxSlots"),
    candidateRetrieval: parseCandidateRetrievalConfig(input.candidateRetrieval),
  };
}

function parseCandidateRetrievalConfig(value: unknown): EagerReferenceCandidateRetrievalConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("candidateRetrieval must be an object");
  const input = value as Record<string, unknown>;
  if (input.mode === "off" && Object.keys(input).length === 1) return { mode: "off" };
  const keys = Object.keys(input).sort();
  const expected = ["budgetRatio", "encoderFingerprint", "mode", "runtimeVersion"];
  if (input.mode !== "runtime" || JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new Error(`runtime candidateRetrieval fields must be exactly: ${expected.join(", ")}`);
  }
  if (input.budgetRatio !== 0.2) throw new Error("candidateRetrieval budgetRatio must be exactly 0.2");
  if (input.runtimeVersion !== ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION) {
    throw new Error(`candidateRetrieval runtimeVersion must be ${ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION}`);
  }
  if (typeof input.encoderFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(input.encoderFingerprint)) {
    throw new Error("candidateRetrieval encoderFingerprint must be a SHA-256 identity");
  }
  if (input.encoderFingerprint !== RELATIONAL_RRF_ENCODER_FINGERPRINT) {
    throw new Error(`candidateRetrieval encoderFingerprint must be ${RELATIONAL_RRF_ENCODER_FINGERPRINT}`);
  }
  return { mode: "runtime", runtimeVersion: input.runtimeVersion, encoderFingerprint: input.encoderFingerprint, budgetRatio: 0.2 };
}

export function createEagerReferenceManifest(
  value: unknown = DEFAULT_EAGER_REFERENCE_CONFIG,
) {
  const config = parseEagerReferenceAlgorithmConfig(value);
  return algorithmManifest(createEagerReferenceAlgorithmRef(config));
}

export function createEagerReferenceAlgorithmRef(
  value: unknown = DEFAULT_EAGER_REFERENCE_CONFIG,
) {
  const config = parseEagerReferenceAlgorithmConfig(value);
  const batching = (maxSlots: number) => defineAlgorithmRef({
    role: "work-batching" as const,
    id: "bounded-slot-batching",
    version: "1",
    contractVersion: 1,
    config: { maxSlots },
  });
  const scheduling = (maxConcurrent: number) => defineAlgorithmRef({
    role: "work-scheduling" as const,
    id: "bounded-concurrency",
    version: "1",
    contractVersion: 1,
    config: { maxConcurrent },
  });
  const recovery = () => defineAlgorithmRef({
    role: "output-recovery" as const,
    id: "localized-repair-bisect",
    version: "1",
    contractVersion: 1,
    config: { maxRepairs: 2, exhaustion: "fail-step", split: "bisect" },
  });
  const candidateSelection = config.candidateRetrieval.mode === "off"
    ? defineAlgorithmRef({
        role: "candidate-selection",
        id: "full-catalog",
        version: "1",
        contractVersion: 1,
        config: {},
      })
    : defineAlgorithmRef({
        role: "candidate-selection",
        id: "relational-rrf",
        version: "2",
        contractVersion: 1,
        config: {
          budgetRatio: config.candidateRetrieval.budgetRatio,
          budgetPolicy: "mandatory-floor-v1",
          cacheSchemaVersion: 1,
          dynamicPassageWrites: true,
        },
        children: {
          ranking: defineAlgorithmRef({
            role: "candidate-ranking",
            id: "typed-channel-rrf",
            version: "1",
            contractVersion: 1,
            config: {
              encoderFingerprint: config.candidateRetrieval.encoderFingerprint,
              encoderModel: RELATIONAL_RRF_ENCODER_MODEL_ID,
              graphDepth: 3,
              pseudoSeedCount: 16,
              channels: ["identity", "state", "fact", "temporal"],
              passageSchemaVersion: 1,
              querySchemaVersion: 1,
              rrfSchemaVersion: 1,
            },
          }),
          allocation: defineAlgorithmRef({
            role: "candidate-allocation",
            id: "coverage-aware-joint-budget",
            version: "1",
            contractVersion: 1,
            config: { compactKindRatio: 0.15 },
          }),
        },
      });
  const symbolRepair = defineAlgorithmRef({
    role: "symbol-repair",
    id: "bounded-symbol-repair",
    version: "1",
    contractVersion: 1,
    config: {
      mode: "auto",
      policyVersion: "symbol-repair-v2",
      maxDistance: 3,
      minDistanceMargin: 1,
      minPayloadLength: 8,
      allowAdjacentTransposition: true,
      maxAuditCandidates: 8,
    },
  });
  const actionCompilation = defineAlgorithmRef({
    role: "action-compilation",
    id: "model-action-compilation",
    version: "2",
    contractVersion: 1,
    config: {
      candidateKeyVersion: ACTION_COMPILATION_CANDIDATE_KEY_VERSION,
      candidateKeyPayloadLength: ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH,
    },
    children: { candidateSelection, symbolRepair, batching: batching(config.actionCompilationMaxSlots), recovery: recovery() },
  });
  const agentCognition = defineAlgorithmRef({
    role: "agent-cognition",
    id: "model-agent-cognition",
    version: "1",
    contractVersion: 1,
    config: { externalUpdates: false },
    children: { batching: batching(config.agentMindMaxSlots), recovery: recovery() },
  });
  const interactionGrounding = defineAlgorithmRef({
    role: "interaction-grounding",
    id: "model-interaction-grounding",
    version: "1",
    contractVersion: 1,
    config: {},
    children: { scheduling: scheduling(config.groundingMaxSlots), recovery: recovery() },
  });
  const reactionResolution = defineAlgorithmRef({
    role: "reaction-resolution",
    id: "onset-reaction",
    version: "1",
    contractVersion: 1,
    config: {},
    children: {
      onsetPerception: defineAlgorithmRef({
        role: "onset-perception",
        id: "model-onset-perception",
        version: "7",
        contractVersion: 1,
        config: { fallback: "global", contextMode: "full" },
      }),
      reactionDecision: defineAlgorithmRef({
        role: "reaction-decision",
        id: "model-reaction-decision",
        version: "1",
        contractVersion: 1,
        config: {},
      }),
      scheduling: scheduling(config.reactionMaxSlots),
      recovery: recovery(),
    },
  });
  const truthResolution = defineAlgorithmRef({
    role: "truth-resolution",
    id: "model-truth-resolution",
    version: "1",
    contractVersion: TRUTH_RESOLUTION_CONTRACT_VERSION,
    config: {},
    children: { batching: batching(config.truthBatchMaxSlots), recovery: recovery() },
  });
  const observationRendering = defineAlgorithmRef({
    role: "observation-rendering",
    id: "model-observation-rendering",
    version: "2",
    contractVersion: 1,
    config: {},
    children: { batching: batching(config.truthBatchMaxSlots), recovery: recovery() },
  });
  return defineAlgorithmRef({
    role: "world-execution",
    id: "eager-reference",
    version: "24",
    contractVersion: 9,
    config: {},
    children: { agentCognition, actionCompilation, interactionGrounding, reactionResolution, truthResolution, observationRendering },
  });
}

export const EAGER_REFERENCE_MANIFEST = createEagerReferenceManifest();

function observationsFor(packets: readonly ObservationPacket[], observerId: string): ObservationPacket[] {
  return packets.filter((packet) => packet.observerId === observerId);
}

function dedupeModelAudits(audits: readonly ModelExecutionAudit[]): ModelExecutionAudit[] {
  const merged = new Map<string, ModelExecutionAudit>();
  const invocations = new Map<string, ModelExecutionAudit["invocations"][number]>();
  for (const audit of audits) {
    const auditKey = contentHash({ ...audit, invocations: [] });
    let target = merged.get(auditKey);
    if (!target) {
      target = { ...structuredClone(audit), invocations: [] };
      merged.set(auditKey, target);
    }
    for (const invocation of audit.invocations) {
      const existing = invocations.get(invocation.id);
      if (existing) {
        // A batch shares one physical invocation across logical slots. Slot
        // validation may classify those views differently; retain the most
        // conservative outcome and all issue codes in the physical audit.
        const dispositionRank = { accepted: 0, "auto-normalized": 1, "llm-repaired": 2, rejected: 3 } as const;
        existing.outputDisposition = dispositionRank[existing.outputDisposition] >= dispositionRank[invocation.outputDisposition]
          ? existing.outputDisposition : invocation.outputDisposition;
        existing.issues = [...existing.issues, ...invocation.issues].filter((issue, index, all) =>
          all.findIndex((candidate) => candidate.code === issue.code && JSON.stringify(candidate.path) === JSON.stringify(issue.path)) === index);
        existing.normalization = {
          applied: existing.normalization.applied || invocation.normalization.applied,
          modifiedFieldCount: existing.normalization.modifiedFieldCount + invocation.normalization.modifiedFieldCount,
          resolvedReferenceCount: existing.normalization.resolvedReferenceCount + invocation.normalization.resolvedReferenceCount,
          proposalCount: Math.max(existing.normalization.proposalCount, invocation.normalization.proposalCount),
          deduplicatedCount: existing.normalization.deduplicatedCount + invocation.normalization.deduplicatedCount,
          symbolRepairCount: existing.normalization.symbolRepairCount + invocation.normalization.symbolRepairCount,
          symbolRepairAcceptedCount: existing.normalization.symbolRepairAcceptedCount + invocation.normalization.symbolRepairAcceptedCount,
          symbolRepairAmbiguousCount: existing.normalization.symbolRepairAmbiguousCount + invocation.normalization.symbolRepairAmbiguousCount,
          symbolRepairUnmatchedCount: existing.normalization.symbolRepairUnmatchedCount + invocation.normalization.symbolRepairUnmatchedCount,
          symbolRepairPostValidationRejectedCount: existing.normalization.symbolRepairPostValidationRejectedCount + invocation.normalization.symbolRepairPostValidationRejectedCount,
        };
        existing.symbolRepairs = [...existing.symbolRepairs, ...invocation.symbolRepairs];
        existing.resultKind ??= invocation.resultKind;
        continue;
      }
      const copy = structuredClone(invocation);
      target.invocations.push(copy);
      invocations.set(copy.id, copy);
    }
  }
  return [...merged.values()].filter((audit) => audit.invocations.length > 0);
}

type EagerMindOutput = AgentMindOutput;

interface EagerMindBatchOutput {
  outputs: EagerMindOutput[];
  modelAudits: ModelExecutionAudit[];
  batchCount: number;
  metrics: AlgorithmBatchMetrics;
}

interface ComponentResolution {
  resolution: UnreviewedTruthResolution;
  stage: TruthCandidateStage;
  interactionIds: readonly string[];
  repair(error: unknown): Promise<void>;
  finish(): Promise<void>;
  close(): Promise<unknown>;
}

async function settledValues<T>(
  tasks: readonly (() => Promise<T>)[],
  label: string,
  maxConcurrent = tasks.length || 1,
  onFirstFailure?: (error: unknown) => void,
): Promise<T[]> {
  const results = Array<T | undefined>(tasks.length);
  const failures: unknown[] = [];
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      if (failures.length > 0) return;
      const index = nextIndex++;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]!();
      } catch (error) {
        failures.push(error);
        if (failures.length === 1) onFirstFailure?.(error);
      }
    }
  };
  const workerCount = Math.max(1, Math.min(maxConcurrent, tasks.length || 1));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failures.length > 0) throw new AggregateError(failures, `${label} batch failed`);
  return results as T[];
}

function materializeExternalAction(
  state: Readonly<SimulationState>,
  input: ExternalActionInput,
  ordinal: number,
  stage: "external" | "replay",
): AgentActionProposal {
  if (!input.rawText.trim() || !input.goal.trim()) throw new Error(`external action for ${input.agentId} is blank`);
  return {
    id: runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "action",
      stage,
      owner: input.agentId,
      round: 0,
      ordinal,
    }),
    actorId: input.agentId,
    baseRevision: state.revision,
    rawText: input.rawText.trim(),
    goal: input.goal.trim(),
    means: input.means?.trim() || null,
    targetIds: [...input.targetIds],
  };
}

function collectKnownActions(
  input: Readonly<WorldStepInput>,
  eligibleAgentIds: readonly AgentId[],
  deferredAgentIds: ReadonlySet<AgentId>,
): AgentActionProposal[] {
  const state = input.state;
  const agentIds = Object.keys(state.agents).sort();
  const rosterIds = Object.keys(input.policyRoster).sort();
  if (contentHash(agentIds) !== contentHash(rosterIds)) throw new Error("policy roster must cover every Agent exactly once");
  const externalByAgent = new Map<string, ExternalActionInput>();
  for (const external of input.request.externalActions) {
    if (externalByAgent.has(external.agentId)) throw new Error(`duplicate external action for ${external.agentId}`);
    externalByAgent.set(external.agentId, external);
  }
  const eligible = new Set(eligibleAgentIds);
  const actions = agentIds.flatMap((agentId, ordinal) => {
    const binding = input.policyRoster[agentId];
    if (!binding || binding.agentId !== agentId) throw new Error(`invalid policy binding for ${agentId}`);
    if (!eligible.has(agentId)) return [];
    if (binding.kind === "model") {
      if (deferredAgentIds.has(agentId)) return [];
      const prepared = state.agents[agentId].nextAction;
      if (!prepared) return [];
      return [structuredClone(prepared)];
    }
    if (binding.kind === "external" || binding.kind === "replay") {
      const external = externalByAgent.get(agentId);
      if (!external) throw new Error(`${binding.kind} Agent ${agentId} has no supplied action`);
      externalByAgent.delete(agentId);
      return [materializeExternalAction(state, external, ordinal, binding.kind)];
    }
    return [];
  });
  if (externalByAgent.size > 0) throw new Error(`external action targets non-external Agent ${externalByAgent.keys().next().value}`);
  return actions;
}

interface PreparedInteractionDependency {
  dependency: InteractionDependency;
}

interface EagerStepPreparationPayload {
  resumedAgentIds: AgentId[];
  resumedOutputs: EagerMindOutput[];
  newActions: AgentActionProposal[];
  temporalPlanning: PlannedTemporalActivity[];
  dependencyResults: PreparedInteractionDependency[];
  planningState: SimulationState;
  interruptionTransitions: ActivityTransition[];
  sharedResourceAdmissions: SharedResourceAdmission[];
  resourceDecisionPoints: import("../../mechanics/temporal").DecisionPoint[];
  readyTemporalPlans: import("../../mechanics/temporal").TemporalPlan[];

}

function eagerPreparationPayload(preparation: Readonly<WorldStepPreparation>): EagerStepPreparationPayload {
  const value = preparation.payload as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StepPreparationInvalidatedError("step preparation payload is not an object");
  }
  const payload = value as Partial<EagerStepPreparationPayload>;
  if (!Array.isArray(payload.resumedAgentIds) || !Array.isArray(payload.resumedOutputs) ||
    !Array.isArray(payload.newActions) || !Array.isArray(payload.temporalPlanning) ||
    !Array.isArray(payload.dependencyResults) || !payload.planningState ||
    typeof payload.planningState !== "object" || !Array.isArray(payload.interruptionTransitions) ||
    !Array.isArray(payload.sharedResourceAdmissions) || !Array.isArray(payload.resourceDecisionPoints) ||
    !Array.isArray(payload.readyTemporalPlans)) {
    throw new StepPreparationInvalidatedError("step preparation payload is incomplete");
  }
  return structuredClone(payload) as EagerStepPreparationPayload;
}

interface OnsetReactionCandidate {
  agentId: AgentId;
  trigger: AgentActionProposal;
  originalIntent: ReactionRequest["originalIntent"];
  ordinal: number;
}

type OnsetReactionCandidateDraft = Omit<OnsetReactionCandidate, "ordinal">;

function collectOnsetReactionCandidates(input: {
  state: Readonly<SimulationState>;
  planningState: Readonly<SimulationState>;
  actions: readonly AgentActionProposal[];
  dependencies: readonly InteractionDependency[];
}): OnsetReactionCandidate[] {
  const requestInputs: OnsetReactionCandidateDraft[] = [];
  const dependencyByAction = new Map(input.dependencies.map((dependency) => [dependency.id, dependency]));
  const actionById = new Map(input.actions.map((action) => [action.id, action]));
  for (const action of input.actions) {
    const activity = Object.values(input.planningState.truth.activities)
      .find((candidate): candidate is ScheduledActivityState =>
        candidate.status === "active" && candidate.sourceActionId === action.id);
    if (!activity?.plan.interruptible) continue;
    const dependency = dependencyByAction.get(action.id);
    if (!dependency) continue;
    const triggerDependency = input.dependencies.find((candidate) =>
      candidate.id !== dependency.id && candidate.actorId !== action.actorId &&
      candidate.audienceAgentIds.includes(action.actorId) &&
      interactionDependenciesConflict(dependency, candidate));
    const trigger = triggerDependency && actionById.get(triggerDependency.id);
    if (trigger) {
      requestInputs.push({
        agentId: action.actorId,
        trigger,
        originalIntent: { kind: "prepared_action", actionId: action.id },
      });
    }
  }
  for (const activity of Object.values(input.state.truth.activities)
    .filter((candidate): candidate is ScheduledActivityState =>
      candidate.status === "active" && candidate.plan.interruptible)
    .sort((left, right) => left.id.localeCompare(right.id))) {
    if (input.actions.some((action) => action.actorId === activity.actorId)) continue;
    const triggerDependency = input.dependencies.find((dependency) =>
      dependency.actorId !== activity.actorId &&
      dependency.audienceAgentIds.includes(activity.actorId) &&
      interactionDependenciesConflict(activity.interactionFootprint, dependency));
    const trigger = triggerDependency && actionById.get(triggerDependency.id);
    if (!trigger) continue;
    requestInputs.push({
      agentId: activity.actorId,
      trigger,
      originalIntent: {
        kind: "ongoing_activity",
        activityId: activity.id,
        sourceActionId: activity.sourceActionId,
      },
    });
  }
  const unique = [...new Map(requestInputs
    .sort((left, right) => left.agentId.localeCompare(right.agentId) || left.trigger.id.localeCompare(right.trigger.id))
    .map((entry) => [entry.agentId, entry])).values()];
  return unique.map((entry, ordinal) => ({ ...entry, ordinal }));
}

function materializeOnsetReactionRequests(
  state: Readonly<SimulationState>,
  candidates: readonly OnsetReactionCandidate[],
  perception: Readonly<OnsetPerceptionTranscript>,
): ReactionRequest[] {
  if (perception.receipts.length !== candidates.length) throw new Error("onset receipt coverage changed before reactions");
  return perception.receipts.flatMap((receipt): ReactionRequest[] => {
    const entry = candidates[receipt.targetIndex];
    if (!entry || entry.agentId !== receipt.observerId || entry.trigger.id !== receipt.sourceActionId) {
      throw new Error("onset receipt does not match the frozen reaction candidate");
    }
    if (receipt.kind === "no_stimulus") return [];
    return [{
      id: runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "reaction-request",
        stage: "action-onset", owner: [entry.agentId, entry.trigger.id, receipt.contentHash], round: 0, ordinal: entry.ordinal }),
      agentId: entry.agentId,
      triggerActionId: entry.trigger.id,
      originalIntent: structuredClone(entry.originalIntent),
      stimulus: structuredClone(receipt.stimulus),
      perceptionReceiptHash: receipt.contentHash,
    }];
  });
}

interface ReactionResolutionBatch {
  decisions: ReactionDecision[];
  audits: ModelExecutionAudit[];
}

export interface EagerReferenceComponents {
  provider: StructuredModelProvider;
  agentCognition: AgentCognitionCapability;
  actionCompilation: ActionCompilationCapability;
  interactionGrounding: InteractionGroundingCapability;
  onsetPerception: OnsetPerceptionCapability;
  reactionDecision: ReactionDecisionCapability;
  truthResolution: TruthResolutionCapability;
  observationRendering: ObservationRenderingCapability;
  symbolRepair: Readonly<SymbolRepairPolicy>;
  actionCompilationRecovery: Readonly<OutputRecoveryCapability>;
  interactionGroundingRecovery: Readonly<OutputRecoveryCapability>;
  orderedComponentRandom?: boolean;
}

async function resolveAgentReactionRequests(
  agentMind: EagerReferenceComponents["reactionDecision"],
  planningState: Readonly<SimulationState>,
  newActions: readonly AgentActionProposal[],
  reactionRequests: readonly ReactionRequest[],
  policyRoster: Readonly<WorldStepInput["policyRoster"]>,
  context: Readonly<ExecutionContext>,
  maxConcurrent = 8,
): Promise<ReactionResolutionBatch> {
  const reactionResults = await settledValues(reactionRequests.map((request) => async () => {
    const policy = policyRoster[request.agentId];
    if (!policy) throw new Error(`reaction request ${request.id} has no policy`);
    if (policy.kind === "external") return null;
    if (policy.kind === "idle") {
      return { decision: fallbackReactionDecision(planningState, request), audit: null };
    }
    if (policy.kind === "replay") {
      return { decision: fallbackReactionDecision(planningState, request, "replay"), audit: null };
    }
    const agent = applyObservationBindings(planningState.agents[request.agentId], [request.stimulus]);
    const originalAction = originalActionForReaction(planningState, newActions, request);
    try {
      const output = await agentMind.react(
        planningState,
        agent,
        originalAction,
        request,
        context.modelScope,
      );
      const { modelAudit, ...decision } = output;
      return { decision, audit: modelAudit };
    } catch (error) {
      if (!(error instanceof ModelSemanticRepairError) || !error.audit) throw error;
      context.instrumentation.emit({
        event: "algorithm.agent_reaction.repair_exhausted",
        level: "warn",
        correlation: { ...context.modelScope.correlation, modelSubject: request.agentId },
        attributes: { phase: "reaction", policy: "fail-step" },
        counts: { reactionFailures: 1 },
        error: { name: error.name, message: error.message },
      });
      throw error;
    }
  }), "action-onset reactions", maxConcurrent);
  return {
    decisions: reactionResults.flatMap((result) => result ? [result.decision] : []),
    audits: reactionResults.flatMap((result) => result?.audit ? [result.audit] : []),
  };
}

function originalActionForReaction(
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  request: Readonly<ReactionRequest>,
): AgentActionProposal {
  const intent = request.originalIntent;
  const original = intent.kind === "prepared_action"
    ? actions.find((action) => action.id === intent.actionId)
    : state.truth.activities[intent.activityId]?.sourceAction;
  if (!original) throw new Error(`reaction ${request.id} has no original intent`);
  return structuredClone(original);
}

function fallbackReactionDecision(
  state: Readonly<SimulationState>,
  request: Readonly<ReactionRequest>,
  source: ReactionDecision["source"] = "profile_fallback",
): ReactionDecision {
  const intent = request.originalIntent;
  const activity = intent.kind === "ongoing_activity"
    ? state.truth.activities[intent.activityId]
    : Object.values(state.truth.activities)
      .find((candidate) => candidate.sourceActionId === intent.actionId);
  if (!activity) throw new Error(`reaction ${request.id} has no temporal profile`);
  if (activity.status === "queued" || activity.status === "ready") {
    throw new Error(`reaction ${request.id} targets an Activity that has not started`);
  }
  const profile = state.truth.mechanics.temporalProfiles[activity.plan.profileId];
  if (!profile) throw new Error(`reaction ${request.id} references unknown temporal profile`);
  const disposition = intent.kind === "ongoing_activity"
    ? profile.reactionFallback === "pause"
      ? "pause"
      : profile.reactionFallback === "cancel"
        ? "cancel"
        : "continue"
    : "continue";
  return {
    requestId: request.id,
    source,
    agentId: request.agentId,
    baseRevision: state.revision,
    originalProposalId: intent.kind === "prepared_action" ? intent.actionId : intent.sourceActionId,
    kind: "keep",
    ongoingActivityDisposition: disposition,
  };
}

function materializeExternalReaction(
  state: Readonly<SimulationState>,
  request: Readonly<ReactionRequest>,
  input: Readonly<ExternalReactionInput>,
  ordinal: number,
): ReactionDecision {
  if (input.requestId !== request.id || input.agentId !== request.agentId || !input.submissionId.trim()) {
    throw new Error(`external reaction does not match request ${request.id}`);
  }
  const originalProposalId = request.originalIntent.kind === "prepared_action"
    ? request.originalIntent.actionId
    : request.originalIntent.sourceActionId;
  if (input.kind === "keep") {
    return {
      requestId: request.id,
      source: "external",
      agentId: request.agentId,
      baseRevision: state.revision,
      originalProposalId,
      kind: "keep",
      ongoingActivityDisposition: "continue",
    };
  }
  if (!input.rawText.trim() || !input.goal.trim()) throw new Error(`external reaction ${request.id} is blank`);
  return {
    requestId: request.id,
    source: "external",
    agentId: request.agentId,
    baseRevision: state.revision,
    originalProposalId,
    kind: "replace",
    replacementAction: {
      id: runtimeId({
        worldHash: state.worldHash,
        revision: state.revision,
        kind: "action",
        stage: "external-reaction",
        owner: request.agentId,
        round: 0,
        ordinal,
      }),
      actorId: request.agentId,
      baseRevision: state.revision,
      rawText: input.rawText.trim(),
      goal: input.goal.trim(),
      means: input.means?.trim() || null,
      targetIds: [...input.targetIds],
    },
  };
}

function mergeResolutions(
  source: Readonly<SimulationState>,
  resolutions: readonly UnreviewedTruthResolution[],
  boundary: Readonly<TemporalBoundary>,
  fallbackCause: import("../../contracts/model").CausalRef,
): UnreviewedTruthResolution {
  const actions = resolutions.flatMap((resolution) => structuredClone(resolution.actions));
  const allMechanicInvocations = resolutions.flatMap((resolution) =>
    structuredClone(resolution.proposal.mechanicInvocations));
  const allMechanicResults = resolutions.flatMap((resolution) => structuredClone(resolution.mechanicResults));
  const conditionAdvances = allMechanicInvocations.filter((invocation) =>
    invocation.packageId === "core-resolution" && invocation.ruleId === "advance-conditions");
  const keptConditionAdvanceId = conditionAdvances[0]?.id;
  if (conditionAdvances.length > 1 && conditionAdvances.some((invocation) =>
    allMechanicResults.find((result) => result.invocationId === invocation.id)?.operations.length !== 0)) {
    throw new Error("condition advancement with effects requires global resolution");
  }
  const mechanicInvocations = allMechanicInvocations.filter((invocation) =>
    invocation.packageId !== "core-resolution" || invocation.ruleId !== "advance-conditions" ||
    invocation.id === keptConditionAdvanceId);
  const mechanicInvocationIds = new Set(mechanicInvocations.map((invocation) => invocation.id));
  const mechanicResults = allMechanicResults.filter((result) => mechanicInvocationIds.has(result.invocationId));
  const proposal: TransitionProposal = {
    baseRevision: source.revision,
    outcomes: resolutions.flatMap((resolution) => structuredClone(resolution.proposal.outcomes)),
    mechanicInvocations,
    operations: [
      ...resolutions.flatMap((resolution) => resolution.proposal.operations
        .filter((operation) => operation.kind !== "advance_time")
        .map((operation) => structuredClone(operation))),
      {
        kind: "advance_time",
        seconds: boundary.deltaSeconds,
        causes: actions.length > 0
          ? actions.map((action) => ({ kind: "action" as const, id: action.id }))
          : [structuredClone(fallbackCause)],
        assertions: [{
          kind: "elapsed_seconds_compare" as const,
          operator: "eq" as const,
          value: source.truth.elapsedSeconds,
        }],
      },
    ],
    events: resolutions.flatMap((resolution) => structuredClone(resolution.proposal.events)),
    observations: resolutions.flatMap((resolution) => structuredClone(resolution.proposal.observations)),
    decisionRequests: resolutions.flatMap((resolution) => structuredClone(resolution.proposal.decisionRequests)),
  };
  const checks = resolutions.flatMap((resolution) => structuredClone(resolution.checks));
  const randomResults = resolutions.flatMap((resolution) => structuredClone(resolution.randomResults));
  return {
    proposal,
    initialActions: resolutions.flatMap((resolution) => structuredClone(resolution.initialActions)),
    actions,
    reactionRequests: resolutions.flatMap((resolution) => structuredClone(resolution.reactionRequests)),
    reactionDecisions: resolutions.flatMap((resolution) => structuredClone(resolution.reactionDecisions)),
    stimulusObservations: resolutions.flatMap((resolution) => structuredClone(resolution.stimulusObservations)),
    requests: resolutions.flatMap((resolution) => structuredClone(resolution.requests)),
    checks,
    randomRequests: resolutions.flatMap((resolution) => structuredClone(resolution.randomRequests)),
    randomResults,
    commitmentRounds: resolutions.flatMap((resolution) => structuredClone(resolution.commitmentRounds)),
    resolutionPlans: resolutions.flatMap((resolution) => structuredClone(resolution.resolutionPlans)),
    resolutionReceipts: resolutions.flatMap((resolution) => structuredClone(resolution.resolutionReceipts)),
    rng: structuredClone(resolutions.at(-1)?.rng ?? source.truth.rng),
    mechanicResults,
    causalAssertionResults: evaluateProposalCausality(source, checks, randomResults, proposal),
    modelAudits: dedupeModelAudits(resolutions.flatMap((resolution) => resolution.modelAudits)),
    reactionModelAudits: dedupeModelAudits(resolutions.flatMap((resolution) => resolution.reactionModelAudits)),
  };
}

export class EagerReferenceAlgorithm implements WorldExecutionAlgorithm {
  readonly algorithmIdentity;
  readonly manifest;
  readonly config: Readonly<NormalizedEagerReferenceAlgorithmConfig>;
  private readonly truthEngine: EagerReferenceComponents["truthResolution"];
  private readonly onsetPerception: EagerReferenceComponents["onsetPerception"];
  private readonly agentMind: EagerReferenceComponents["agentCognition"];
  private readonly reactionMind: EagerReferenceComponents["reactionDecision"];
  private readonly observationRenderer: EagerReferenceComponents["observationRendering"];
  private readonly actionCompiler: EagerReferenceComponents["actionCompilation"];
  private readonly interactionGrounder: EagerReferenceComponents["interactionGrounding"];
  private readonly symbolRepairPolicy: Readonly<SymbolRepairPolicy>;
  private readonly actionCompilationRecovery: Readonly<OutputRecoveryCapability>;
  private readonly interactionGroundingRecovery: Readonly<OutputRecoveryCapability>;
  private readonly provider: StructuredModelProvider;
  private readonly rulePackages: RulePackageRegistry;
  private readonly actionCompilationRetrieval?: CandidateSelectionCapability;
  private readonly orderedComponentRandom: boolean;

  constructor(
    provider: StructuredModelProvider,
    rulePackages?: RulePackageRegistry,
    config: Readonly<EagerReferenceAlgorithmConfig> = FULL_CATALOG_EAGER_REFERENCE_CONFIG,
    actionCompilationRetrieval?: CandidateSelectionCapability,
    components?: Readonly<EagerReferenceComponents>,
    manifest?: AlgorithmManifest,
  ) {
    this.config = Object.freeze(parseEagerReferenceAlgorithmConfig(config));
    this.manifest = manifest ?? createEagerReferenceManifest(this.config);
    this.algorithmIdentity = Object.freeze({
      role: this.manifest.role,
      id: this.manifest.id,
      version: this.manifest.version,
      contractVersion: this.manifest.contractVersion,
    });
    this.provider = components?.provider ?? provider;
    this.orderedComponentRandom = components?.orderedComponentRandom ?? false;
    this.rulePackages = rulePackages ?? createCoreRulePackageRegistry();
    if (this.config.candidateRetrieval.mode === "runtime") {
      if (!actionCompilationRetrieval) throw new Error("candidate retrieval runtime is required by the eager-reference algorithm config");
      if (actionCompilationRetrieval.version !== this.config.candidateRetrieval.runtimeVersion) {
        throw new Error("candidate retrieval runtime version does not match the algorithm config");
      }
    } else if (actionCompilationRetrieval) {
      throw new Error("candidate retrieval runtime was supplied to an algorithm configured off");
    }
    this.actionCompilationRetrieval = actionCompilationRetrieval;
    if (components) {
      this.agentMind = components.agentCognition;
      this.reactionMind = components.reactionDecision;
      this.actionCompiler = components.actionCompilation;
      this.interactionGrounder = components.interactionGrounding;
      this.onsetPerception = components.onsetPerception;
      this.truthEngine = components.truthResolution;
      this.observationRenderer = components.observationRendering;
      this.symbolRepairPolicy = components.symbolRepair;
      this.actionCompilationRecovery = components.actionCompilationRecovery;
      this.interactionGroundingRecovery = components.interactionGroundingRecovery;
    } else {
      const truthProvider = new TruthBatchCoordinator(provider, this.config.truthBatchMaxSlots);
      const agentMind = new AgentMind(provider, DEFAULT_EAGER_OUTPUT_RECOVERY);
      const truthEngine = new TruthEngine(truthProvider, {
        rulePackages: this.rulePackages,
        repairAttempts: DEFAULT_EAGER_OUTPUT_RECOVERY.maxRepairs,
      });
      this.agentMind = agentMind;
      this.reactionMind = agentMind;
      this.actionCompiler = compileActions;
      this.interactionGrounder = generateInteractionDependency;
      this.onsetPerception = truthEngine;
      this.truthEngine = truthEngine;
      this.observationRenderer = new ObservationRenderer(
        truthProvider,
        DEFAULT_EAGER_OUTPUT_RECOVERY.maxRepairs,
      );
      this.symbolRepairPolicy = DEFAULT_SYMBOL_REPAIR_POLICY;
      this.actionCompilationRecovery = DEFAULT_EAGER_OUTPUT_RECOVERY;
      this.interactionGroundingRecovery = DEFAULT_EAGER_OUTPUT_RECOVERY;
    }
  }

  private emitSlotBatchMetrics(
    context: ExecutionContext,
    phase: "action-compilation" | "agent-bootstrap" | "agent-resume" | "agent-mind",
    logicalSlots: number,
    configuredMaxSlots: number,
    batchCount: number,
    metrics: AlgorithmBatchMetrics,
  ): void {
    context.instrumentation.emit({
      event: "algorithm.eager_reference.slot_batch_completed",
      attributes: { phase },
      counts: {
        configuredMaxSlots,
        logicalSlots,
        physicalCalls: batchCount,
        submittedSlots: metrics.submittedSlots,
        repairCalls: metrics.repairCalls,
        repeatedFingerprints: metrics.repeatedFingerprints,
        batchSplits: metrics.splitCount,
        partialFailureSlots: metrics.partialFailureSlots,
        singletonFailures: metrics.singletonFailures,
      },
    });
  }

  private actionCompilationScope(context: ExecutionContext): ExecutionContext["modelScope"] {
    return this.actionCompilationRetrieval
      ? { ...context.modelScope, actionCompilationRetrieval: this.actionCompilationRetrieval }
      : context.modelScope;
  }

  private async thinkBatchWithFallback(
    state: SimulationState,
    inputs: readonly AgentCognitionBatchInput[],
    purpose: "bootstrap" | "resume" | "mind",
    context: ExecutionContext,
  ): Promise<EagerMindBatchOutput> {
    if (inputs.length === 0) {
      return {
        outputs: [],
        modelAudits: [],
        batchCount: 0,
        metrics: { submittedSlots: 0, repairCalls: 0, repeatedFingerprints: 0, splitCount: 0, partialFailureSlots: 0, singletonFailures: 0 },
      };
    }
    const result = await this.agentMind.thinkBatch(
      state,
      inputs,
      context.modelScope,
      purpose,
      this.config.agentMindMaxSlots,
    );
    this.emitSlotBatchMetrics(
      context,
      purpose === "bootstrap" ? "agent-bootstrap" : purpose === "resume" ? "agent-resume" : "agent-mind",
      inputs.length,
      this.config.agentMindMaxSlots,
      result.batchCount,
      result.metrics,
    );
    const failures = new Map(result.failures.map((failure) => [failure.agentId, failure.error]));
    const outputs = inputs.map((input): EagerMindOutput => {
      const output = result.outputs.get(input.agent.id);
      if (output) return output;
      const error = failures.get(input.agent.id);
      if (!error) throw new Error(`AgentMind ${purpose} omitted ${input.agent.id}`);
      context.instrumentation.emit({
        event: "algorithm.agent_mind.repair_exhausted",
        level: "warn",
        correlation: { ...context.modelScope.correlation, modelSubject: input.agent.id },
        attributes: { phase: purpose, policy: "fail-step" },
        counts: { mindFailures: 1 },
        error: {
          name: error instanceof Error ? error.name : "AgentMindError",
          message: error instanceof Error ? error.message : String(error),
        },
      });
      throw new ModelSemanticRepairError(
        "agent-mind",
        `AgentMind ${purpose} ${input.agent.id} failed after semantic repairs; step must be retried`,
        {
          cause: error,
          audit: result.modelAudits.length > 0 ? result.modelAudits[result.modelAudits.length - 1] : undefined,
        },
      );
    });
    return {
      outputs,
      modelAudits: result.modelAudits,
      batchCount: result.batchCount,
      metrics: result.metrics,
    };
  }

  private contextOnlyResolution(
    input: Readonly<WorldStepInput>,
    boundary: Readonly<TemporalBoundary>,
    cause: Readonly<CausalRef>,
  ): UnreviewedTruthResolution {
    const invocation: MechanicInvocation = {
      id: runtimeId({
        worldHash: input.state.worldHash,
        revision: input.state.revision,
        kind: "mechanic",
        stage: "condition-advance",
        owner: "context-only",
        round: 0,
        ordinal: 0,
      }),
      packageId: "core-resolution",
      ruleId: "advance-conditions",
      input: { seconds: boundary.deltaSeconds },
      causes: [structuredClone(cause)],
      assertions: [{
        kind: "elapsed_seconds_compare",
        operator: "eq",
        value: input.state.truth.elapsedSeconds,
      }],
    };
    const mechanics = this.rulePackages.resolve(input.definition.rulePackages, {
      state: structuredClone(input.state),
      actions: [],
      resolutionPlans: [],
      resolutionReceipts: [],
      checkRequests: [],
      checkResults: [],
      randomRequests: [],
      randomResults: [],
    }, [invocation], []);
    const proposal: TransitionProposal = {
      baseRevision: input.state.revision,
      outcomes: [],
      mechanicInvocations: mechanics.invocations,
      operations: [
        ...mechanics.operations,
        {
          kind: "advance_time",
          seconds: boundary.deltaSeconds,
          causes: [structuredClone(cause)],
          assertions: [{
            kind: "elapsed_seconds_compare",
            operator: "eq",
            value: input.state.truth.elapsedSeconds,
          }],
        },
      ],
      events: [],
      observations: [],
      decisionRequests: [],
    };
    return {
      proposal,
      initialActions: [],
      actions: [],
      reactionRequests: [],
      reactionDecisions: [],
      stimulusObservations: [],
      requests: [],
      checks: [],
      randomRequests: [],
      randomResults: [],
      commitmentRounds: [],
      resolutionPlans: [],
      resolutionReceipts: [],
      rng: structuredClone(input.state.truth.rng),
      mechanicResults: mechanics.results,
      causalAssertionResults: evaluateProposalCausality(input.state, [], [], proposal),
      modelAudits: [],
      reactionModelAudits: [],
    };
  }

  async bootstrap(input: Readonly<BootstrapInput>, context: ExecutionContext): Promise<BootstrapCandidate> {
    const source = structuredClone(input.state);
    const agents = Object.values(source.agents).sort((left, right) => left.id.localeCompare(right.id));
    const mindBatch = await this.thinkBatchWithFallback(
      source,
      agents.map((agent) => ({
        agent,
        observations: [],
        currentResolution: { action: null, outcome: null },
        events: [],
      })),
      "bootstrap",
      context,
    );
    const outputs = mindBatch.outputs;
    return {
      schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION,
      sourceStateHash: contentHash(source),
      agentCommits: outputs.map((output, index) => ({
        agentId: agents[index].id,
        beliefPatch: structuredClone(output.beliefPatch),
        characterPatch: structuredClone(output.characterPatch),
        nextAction: structuredClone(output.nextAction),
      })),
      modelAudits: mindBatch.modelAudits.map((audit) => structuredClone(audit)),
      diagnostics: {
        activatedAgentIds: agents.map((agent) => agent.id),
        reusedAgentIds: [],
        mindFallbackAgentIds: [],
      },
    };
  }

  private async resolveComponent(
    input: Readonly<WorldStepInput>,
    actions: readonly AgentActionProposal[],
    dependencies: readonly InteractionDependency[],
    interactionIds: readonly string[],
    rngState: SimulationState["truth"]["rng"],
    context: ExecutionContext,
    globalFallback: boolean,
    temporal: Readonly<TemporalAdvanceResult>,
    completedReactionDecisions: readonly ReactionDecision[],
    sessions: Set<TruthCandidateSession>,
    orderedRandom?: TruthResolutionInput["orderedRandom"],
  ): Promise<ComponentResolution> {
    const componentDependencies = dependencies.filter((dependency) => interactionIds.includes(dependency.id));
    const actorIds = [...new Set(componentDependencies.flatMap((dependency) =>
      dependency.actorId === null ? [] : [dependency.actorId]))].sort();
    const scopedActivities = Object.fromEntries(Object.entries(temporal.activities)
      .filter(([, activity]) => actorIds.includes(activity.actorId))
      .map(([id, activity]) => [id, structuredClone(activity)]));
    const scopedTimers = Object.fromEntries(Object.entries(temporal.timers)
      .filter(([, timer]) => timer.wakeAgentIds.some((agentId) => actorIds.includes(agentId)))
      .map(([id, timer]) => [id, structuredClone(timer)]));
    const scopedDecisionPoints = temporal.decisionPoints.filter((point) => actorIds.includes(point.agentId))
      .map((point) => structuredClone(point));
    const scopedState = structuredClone(input.state);
    scopedState.truth.rng = structuredClone(rngState);
    // Keep the complete Agent registry in the deterministic candidate state.
    // Canonical facts may grant access to observers outside this component;
    // dropping those registry entries makes an otherwise unrelated component
    // fail validation before its local operations can be merged.  Model
    // model workset remains scoped by its explicit state and available actions
    // projections above, so this does not expose another subject's cognition.
    scopedState.agents = Object.fromEntries(Object.entries(input.state.agents)
      .map(([agentId, agent]) => [agentId, structuredClone(agent)]));
    const componentActionIds = new Set(componentDependencies
      .filter((dependency) => dependency.kind === "action")
      .map((dependency) => dependency.id));
    const scopedActions = actions.filter((action) => componentActionIds.has(action.id));
    const scopedDependencies = componentDependencies.map((dependency) => structuredClone(dependency));
    const scopedTemporalBase: TemporalAdvanceResult = {
      ...structuredClone(temporal),
      activities: scopedActivities,
      timers: scopedTimers,
      transitions: temporal.transitions.filter((transition) => actorIds.includes(transition.actorId))
        .map((transition) => structuredClone(transition)),
      decisionPoints: scopedDecisionPoints,
    };
    const identityOwner = globalFallback ? "component-global" : `component-${actorIds.join("+")}`;
    const session = this.truthEngine.prepare({
      definition: input.definition,
      state: scopedState,
      initialActions: scopedActions.map((action) => structuredClone(action)),
      temporalBoundary: temporal.boundary,
      identityOwner,
      groundings: scopedDependencies,
      modelWorkset: {
        state: input.state,
        initialActions: actions,
        availableActions: actions,
        availableDependencies: dependencies,
      },
      resolutionScope: {
        mode: globalFallback ? "global" : "component",
        selectedActionIds: scopedActions.map((action) => action.id).sort(),
        totalActionCount: actions.length,
      } satisfies ResolutionScope,
      completedReactionDecisions,
      orderedRandom,
    }, context.modelScope);
    sessions.add(session);
    const validate = (resolution: UnreviewedTruthResolution) => {
        const { proposal, actions: finalActions } = resolution;
        const resolvedTemporal = reconcileTemporalOutcomes(scopedTemporalBase, proposal.outcomes);
        applyTransitionProposal(scopedState, proposal, resolvedTemporal);
        if (finalActions.length !== scopedActions.length) throw new Error("component transition changed action cardinality");
        const continuingActionIds = new Set(Object.values(resolvedTemporal.activities)
          .filter((activity) => activity.status === "active")
          .map((activity) => activity.sourceActionId));
        // A due Activity whose engine-selected boundary is its completion is no
        // longer allowed to remain a deferred/continuing action.  This is a
        // deterministic temporal fact, so make it a repairable semantic issue
        // before the candidate reaches CanonicalCommitter.  Without this guard
        // a model can return `continuing` for a just-completed long action,
        // leaving its receipt unapplied and making the step unreplayable.
        const completingActionIds = new Set(scopedTemporalBase.boundary.dueActivityIds
          .map((activityId) => scopedTemporalBase.activities[activityId])
          .filter((activity): activity is import("../../mechanics/temporal").ScheduledActivityState =>
            Boolean(activity) && activity.status === "completed")
          .map((activity) => activity.sourceActionId));
        for (const actionId of continuingActionIds) {
          const outcome = proposal.outcomes.find((entry) => entry.proposalId === actionId);
          if (outcome && outcome.status !== "continuing") {
            throw new Error(`activity action ${actionId} must remain continuing before completion`);
          }
        }
        for (const actionId of completingActionIds) {
          const outcome = proposal.outcomes.find((entry) => entry.proposalId === actionId);
          if (!outcome || outcome.status === "continuing") {
            throw new Error(`activity action ${actionId} reached its completion boundary and must settle now`);
          }
        }
        // Continuing describes the entire task, not each interval consequence.
        // TruthEngine defers receipt settlement; typed causal validation and
        // bound review adjudicate proposed partial effects against the source.
    };
    const next = async (feedback?: TruthCandidateFeedback): Promise<TruthCandidateStage> => {
      let pending = await session.next(feedback!);
      while (!pending.done) {
        try {
          validate(pending.value.resolution);
          return pending.value;
        } catch (error) {
          pending = await session.next({ kind: "repair", error, previousReport: null });
        }
      }
      throw new Error("component TruthEngine returned no candidate");
    };
    const stage = await next();
    const result: ComponentResolution = {
      stage, resolution: stage.resolution, interactionIds,
      repair: async error => {
        result.stage = await next({ kind: "repair", error, previousReport: null });
        result.resolution = result.stage.resolution;
      },
      finish: async () => {
        const completed = await session.next({ kind: "finish" });
        if (!completed.done || !completed.value) throw new Error("component candidate did not finish");
        result.resolution.modelAudits = completed.value.modelAudits;
      },
      close: () => session.return(undefined),
    };
    return result;
  }

  async prepareStep(input: Readonly<WorldStepInput>, context: ExecutionContext): Promise<WorldStepPreparation> {
    const source = structuredClone(input.state);
    const planningState = structuredClone(source);
    const readyTemporalPlans: import("../../mechanics/temporal").TemporalPlan[] = [];
    const readyTransitions: ActivityTransition[] = [];
    const readyDecisionPoints: import("../../mechanics/temporal").DecisionPoint[] = [];
    for (const ready of Object.values(planningState.truth.activities)
      .filter((activity): activity is import("../../mechanics/temporal").ReadyActivityState => activity.status === "ready")
      .sort((left, right) => left.id.localeCompare(right.id))) {
      const started = startReadyActivity({
        activity: ready,
        atSeconds: source.truth.elapsedSeconds,
        profiles: planningState.truth.mechanics.temporalProfiles,
      });
      planningState.truth.activities[ready.id] = started.activity;
      readyTemporalPlans.push(structuredClone(started.activity.plan));
      readyTransitions.push(started.transition);
      if (evaluateActivityContinuation(planningState, started.activity).some((result) => !result.passed)) {
        const blocked = blockScheduledActivity(started.activity, source.truth.elapsedSeconds);
        planningState.truth.activities[ready.id] = blocked.activity;
        readyTransitions.push(blocked.transition);
        readyDecisionPoints.push(blocked.decisionPoint);
      }
    }
    const eligibleAgentIds = [...input.decisionEligibleAgentIds];
    const eligibleAgents = new Set(eligibleAgentIds);
    const resumedAgentIds = Object.entries(input.policyRoster)
      .filter(([agentId, binding]) => eligibleAgents.has(agentId) && binding.kind === "model" &&
        (binding.resumeFromRevision !== undefined || source.agents[agentId]?.nextAction === null))
      .map(([agentId]) => agentId)
      .sort();
    const knownActions = collectKnownActions(input, eligibleAgentIds, new Set(resumedAgentIds));
    const actionOverlapStartedAt = performance.now();
    const actionCompilationStage = executionStage("action-compilation");
    await context.stages?.before(actionCompilationStage);
    let preparationFailed = false;
    let preparationError: unknown;
    const failPreparation = (error: unknown): never => {
      preparationFailed = true;
      preparationError = error;
      throw error;
    };
    const knownActionCompilation = this.actionCompiler(
      this.provider,
      planningState,
      knownActions,
      this.actionCompilationScope(context),
      input.definition.modelProfiles.grounding,
      this.config.actionCompilationMaxSlots,
      this.actionCompilationRecovery,
      this.symbolRepairPolicy,
    ).catch(failPreparation);
    const resumedMindBatchPromise = this.thinkBatchWithFallback(
      source,
      resumedAgentIds.map((agentId) => ({
        agent: source.agents[agentId],
        observations: pendingObservationsFor(source, source.agents[agentId]),
        currentResolution: { action: null, outcome: null },
        events: [],
      })),
      "resume",
      context,
    );
    // Dynamic compilation depends on its AgentMind output, not on unrelated
    // known-action repairs. Both branches read the same frozen planning state.
    const resumedPreparation = resumedMindBatchPromise.then(async (resumedMindBatch) => {
      if (preparationFailed) throw preparationError;
      context.modelScope.abortSignal?.throwIfAborted();
      context.modelScope.cancelPendingSignal?.throwIfAborted();
      const resumedActions = resumedAgentIds.map((agentId, index) => {
        const action = resumedMindBatch.outputs[index]?.nextAction;
        if (!action) throw new Error(`resume AgentMind omitted action for ${agentId}`);
        return structuredClone(action);
      });
      const newActions = [...knownActions, ...resumedActions]
        .sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
      if (new Set(newActions.map((action) => action.actorId)).size !== newActions.length) {
        throw new Error("step preparation produced more than one action for an Agent");
      }
      if (new Set(newActions.map((action) => action.id)).size !== newActions.length) {
        throw new Error("step preparation produced duplicate action identities");
      }
      const compiled = await this.actionCompiler(
        this.provider,
        planningState,
        resumedActions,
        this.actionCompilationScope(context),
        input.definition.modelProfiles.grounding,
        this.config.actionCompilationMaxSlots,
        this.actionCompilationRecovery,
        this.symbolRepairPolicy,
      );
      return { resumedMindBatch, resumedActions, newActions, compiled };
    }).catch(failPreparation);
    const compilationWork = [
      knownActionCompilation,
      resumedPreparation,
    ] as const;
    // Preserve the first failure, but keep the execution and its Ledger open
    // until both already-started branches have recorded their final evidence.
    const [knownActionCompilationBatch, resumed] = await Promise.all(compilationWork)
      .finally(async () => { await Promise.allSettled(compilationWork); });
    const { resumedMindBatch, resumedActions, newActions, compiled: resumedActionCompilationBatch } = resumed;
    const resumedOutputs = resumedMindBatch.outputs;
    await context.stages?.after(actionCompilationStage);
    if (knownActions.length > 0) {
      this.emitSlotBatchMetrics(
        context,
        "action-compilation",
        knownActions.length,
        this.config.actionCompilationMaxSlots,
        knownActionCompilationBatch.batchCount,
        knownActionCompilationBatch.metrics,
      );
    }
    if (resumedActions.length > 0) {
      this.emitSlotBatchMetrics(
        context,
        "action-compilation",
        resumedActions.length,
        this.config.actionCompilationMaxSlots,
        resumedActionCompilationBatch.batchCount,
        resumedActionCompilationBatch.metrics,
      );
    }
    const actionCompilations = [
      ...knownActionCompilationBatch.compilations,
      ...resumedActionCompilationBatch.compilations,
    ].sort((left, right) => left.plan.actionId.localeCompare(right.plan.actionId));
    if (contentHash(actionCompilations.map((entry) => entry.plan.actionId).sort()) !==
      contentHash(newActions.map((action) => action.id).sort())) {
      throw new Error("step preparation did not compile every action exactly once");
    }
    context.instrumentation.emit({
      event: "algorithm.eager_reference.overlap_completed",
      durationMs: Math.max(0, performance.now() - actionOverlapStartedAt),
      attributes: { phase: "action-preparation" },
      counts: {
        knownActions: knownActions.length,
        deferredActions: resumedActions.length,
        directReactions: 0,
        perceptionReactions: 0,
      },
    });
    const temporalPlanning: PlannedTemporalActivity[] = actionCompilations.map((result) => ({
      plan: structuredClone(result.plan),
      activity: structuredClone(result.activity),
    }));
    const groundingStage = executionStage("grounding-resource-admission");
    await context.stages?.before(groundingStage);
    const newDependencyResults: PreparedInteractionDependency[] = actionCompilations.map((result) => ({
      dependency: structuredClone(result.dependency),
    }));
    const interruptionTransitions = [...readyTransitions];
    for (const action of newActions) {
      for (const activity of Object.values(planningState.truth.activities)
        .filter((candidate) => candidate.actorId === action.actorId &&
          (candidate.status === "active" || candidate.status === "paused" || candidate.status === "queued" ||
            candidate.status === "ready"))) {
        if (activity.status === "queued" || activity.status === "ready") {
          interruptionTransitions.push(cancelDeferredActivity(activity, source.truth.elapsedSeconds));
          delete planningState.truth.activities[activity.id];
        } else {
          const cancelled = cancelActivity(activity, source.truth.elapsedSeconds);
          planningState.truth.activities[activity.id] = cancelled.activity;
          interruptionTransitions.push(cancelled.transition);
        }
      }
    }
    for (const [index, result] of temporalPlanning.entries()) {
      if (planningState.truth.activities[result.activity.id]) {
        throw new Error(`duplicate activity identity ${result.activity.id}`);
      }
      const dependency = newDependencyResults[index]?.dependency;
      if (!dependency || dependency.id !== result.activity.sourceActionId) {
        throw new Error(`temporal activity ${result.activity.id} has no matching onset grounding`);
      }
      result.activity.interactionFootprint = interactionDependencyForActivity(
        source,
        result.activity,
        dependency,
      );
      result.activity.sharedResourceClaims = structuredClone(result.activity.interactionFootprint.sharedResourceClaims);
      if (evaluateActivityContinuation(source, result.activity).some((entry) => !entry.passed)) {
        throw new Error(`temporal activity ${result.activity.id} starts with a failed continuation assertion`);
      }
      planningState.truth.activities[result.activity.id] = structuredClone(result.activity);
    }
    const sharedResourceAdmissions = planSharedResourceAdmissions({
      activities: planningState.truth.activities,
      proposalActivityIds: temporalPlanning.map((result) => result.activity.id),
      pools: planningState.truth.sharedActivityResourcePools,
      definitions: planningState.truth.mechanics.sharedActivityResources,
      entities: planningState.truth.entities,
    }).admissions;
    const appliedAdmissions = applySharedResourceAdmissions({
      activities: planningState.truth.activities,
      admissions: sharedResourceAdmissions,
      atSeconds: source.truth.elapsedSeconds,
    });
    planningState.truth.activities = appliedAdmissions.activities;
    interruptionTransitions.push(...appliedAdmissions.transitions);
    validateActivityResources(
      planningState.truth.activities,
      planningState.truth.mechanics.activityResources,
    );
    await context.stages?.after(groundingStage);
    const reactionCandidates = collectOnsetReactionCandidates({
      state: source,
      planningState,
      actions: newActions,
      dependencies: newDependencyResults.map((result) => result.dependency),
    });
    const reactionPreparationStartedAt = performance.now();
    const reactionStage = executionStage("reaction-perception");
    await context.stages?.before(reactionStage);
    const onsetPerception = reactionCandidates.length === 0 ? null : await this.onsetPerception.perceiveOnset({
          definition: input.definition,
          state: source,
          actions: structuredClone(newActions),
          temporalBoundary: selectTemporalBoundary({
            elapsedSeconds: source.truth.elapsedSeconds,
            maxAutonomousSpanSeconds: input.definition.runtimeDefaults.maxAutonomousSpanSeconds,
            activities: planningState.truth.activities,
            timers: planningState.truth.timers,
            conditionExpiries: Object.fromEntries(Object.values(planningState.truth.conditions)
              .filter((condition) => condition.expiresAtElapsedSeconds !== null)
              .map((condition) => [condition.id, condition.expiresAtElapsedSeconds!])),
          }),
          identityOwner: "action-onset-perception",
          groundings: newDependencyResults.map((result) => structuredClone(result.dependency)),
          perceptionTargets: reactionCandidates.map(candidate => ({
            observerId: candidate.agentId,
            sourceActionId: candidate.trigger.id,
          })),
        }, context.modelScope).catch(error => {
          if (error instanceof ModelSemanticRepairError) context.instrumentation.emit({
            event: "algorithm.truth_perception.repair_exhausted", level: "warn", correlation: context.modelScope.correlation,
            attributes: { phase: "truth-perception", policy: "fail-step" }, counts: { perceptionFailures: 1 },
            error: { name: error.name, message: error.message },
          });
          throw error;
        });
    const onsetPerceptionTranscript: OnsetPerceptionTranscript = {
      targets: reactionCandidates.map(candidate => ({ observerId: candidate.agentId, sourceActionId: candidate.trigger.id })),
      receipts: onsetPerception?.receipts ?? [], requests: onsetPerception?.requests ?? [], checks: onsetPerception?.checks ?? [],
      commitmentRounds: onsetPerception?.commitmentRounds ?? [], rng: structuredClone(onsetPerception?.rng ?? source.truth.rng),
    };
    validateOnsetPerceptionReceipts({ definition: input.definition, state: source, actions: newActions,
      targets: reactionCandidates.map(candidate => ({ observerId: candidate.agentId, sourceActionId: candidate.trigger.id })),
      requests: onsetPerceptionTranscript.requests, checks: onsetPerceptionTranscript.checks }, onsetPerceptionTranscript.receipts);
    const reactionRequests = materializeOnsetReactionRequests(source, reactionCandidates, onsetPerceptionTranscript)
      .sort((left, right) => left.id.localeCompare(right.id));
    const reactionResults = await resolveAgentReactionRequests(this.reactionMind, planningState, newActions,
      reactionRequests, input.policyRoster, context, this.config.reactionMaxSlots);
    await context.stages?.after(reactionStage);
    context.instrumentation.emit({ event: "algorithm.eager_reference.reactions_prepared",
      durationMs: Math.max(0, performance.now() - reactionPreparationStartedAt),
      attributes: { phase: "reaction-preparation" },
      counts: { perceptionTargets: reactionCandidates.length, perceptionReactions: reactionRequests.length } });
    const preparedReactionDecisions = reactionResults.decisions.sort((left, right) => left.requestId.localeCompare(right.requestId));
    const reactionAudits = reactionResults.audits.sort((left, right) => left.subjectId.localeCompare(right.subjectId) || left.role.localeCompare(right.role));
    const reactionOrdinalByAgent = new Map(reactionCandidates.map((candidate) => [candidate.agentId, candidate.ordinal]));
    const pendingReactionRequests = reactionRequests
      .filter((request) => !preparedReactionDecisions.some((decision) => decision.requestId === request.id))
      .sort((left, right) =>
        (reactionOrdinalByAgent.get(left.agentId) ?? Number.MAX_SAFE_INTEGER) -
          (reactionOrdinalByAgent.get(right.agentId) ?? Number.MAX_SAFE_INTEGER) ||
        left.id.localeCompare(right.id));
    const payload: EagerStepPreparationPayload = {
      resumedAgentIds: structuredClone(resumedAgentIds),
      resumedOutputs: structuredClone(resumedOutputs),
      newActions: structuredClone(newActions),
      temporalPlanning: structuredClone(temporalPlanning),
      dependencyResults: structuredClone(newDependencyResults),
      planningState: structuredClone(planningState),
      interruptionTransitions: structuredClone(interruptionTransitions),
      sharedResourceAdmissions: structuredClone(sharedResourceAdmissions),
      resourceDecisionPoints: structuredClone([...readyDecisionPoints, ...appliedAdmissions.decisionPoints]),
      readyTemporalPlans: structuredClone(readyTemporalPlans),

    };
    return {
      schemaVersion: WORLD_STEP_PREPARATION_SCHEMA_VERSION,
      id: runtimeId({
        worldHash: source.worldHash,
        revision: source.revision,
        kind: "step-preparation",
        stage: "eager-reference",
        owner: context.modelScope.batchId,
        round: 0,
        ordinal: 0,
      }),
      sourceStateHash: contentHash(source),
      algorithmManifestHash: this.manifest.hash,
      policyRosterHash: contentHash(input.policyRoster),
      requestHash: contentHash(input.request),
      onsetPerception: structuredClone(onsetPerceptionTranscript),
      reactionRequests: structuredClone(reactionRequests),
      pendingReactionRequests: structuredClone(pendingReactionRequests),
      preparedReactionDecisions: structuredClone(preparedReactionDecisions),
      modelAudits: [
        ...resumedMindBatch.modelAudits.map((audit) => structuredClone(audit)),
        ...knownActionCompilationBatch.modelAudits.map((audit) => structuredClone(audit)),
        ...resumedActionCompilationBatch.modelAudits.map((audit) => structuredClone(audit)),
        ...(onsetPerception ? [structuredClone(onsetPerception.modelAudit)] : []),
        ...reactionAudits.map((audit) => structuredClone(audit)),
      ],
      payload: structuredClone(payload) as unknown as JsonObject,
    };
  }

  async completeStep(
    input: Readonly<WorldStepInput>,
    preparation: Readonly<WorldStepPreparation>,
    reactions: readonly ExternalReactionInput[],
    context: ExecutionContext,
  ): Promise<WorldStepCandidate> {
    const sessions = new Set<TruthCandidateSession>();
    try {
      return await this.completeStepCandidate(input, preparation, reactions, context, sessions);
    } finally {
      await Promise.all([...sessions].map(session => session.return(undefined)));
    }
  }

  private async completeStepCandidate(
    input: Readonly<WorldStepInput>,
    preparation: Readonly<WorldStepPreparation>,
    reactions: readonly ExternalReactionInput[],
    context: ExecutionContext,
    sessions: Set<TruthCandidateSession>,
  ): Promise<WorldStepCandidate> {
    const source = structuredClone(input.state);
    if (preparation.schemaVersion !== WORLD_STEP_PREPARATION_SCHEMA_VERSION ||
      preparation.sourceStateHash !== contentHash(source) ||
      preparation.algorithmManifestHash !== this.manifest.hash ||
      preparation.policyRosterHash !== contentHash(input.policyRoster) ||
      preparation.requestHash !== contentHash(input.request)) {
      throw new StepPreparationInvalidatedError();
    }
    const payload = eagerPreparationPayload(preparation);
    const expectedCandidates = collectOnsetReactionCandidates({ state: source, planningState: payload.planningState,
      actions: payload.newActions, dependencies: payload.dependencyResults.map(result => result.dependency) });
    validateOnsetPerceptionReceipts({ definition: input.definition, state: source, actions: payload.newActions,
      targets: expectedCandidates.map(candidate => ({ observerId: candidate.agentId, sourceActionId: candidate.trigger.id })),
      requests: preparation.onsetPerception.requests, checks: preparation.onsetPerception.checks }, preparation.onsetPerception.receipts);
    if (contentHash(preparation.reactionRequests) !== contentHash(materializeOnsetReactionRequests(source, expectedCandidates, preparation.onsetPerception)
      .sort((left, right) => left.id.localeCompare(right.id)))) throw new StepPreparationInvalidatedError("frozen reactions differ from onset receipts");
    if (preparation.pendingReactionRequests.some(request => !preparation.reactionRequests.some(frozen => contentHash(frozen) === contentHash(request)))) {
      throw new StepPreparationInvalidatedError("pending reactions differ from frozen requests");
    }

    const pendingById = new Map(preparation.pendingReactionRequests.map((request) => [request.id, request]));
    if (new Set(reactions.map((reaction) => reaction.requestId)).size !== reactions.length ||
      reactions.some((reaction) => !pendingById.has(reaction.requestId))) {
      throw new Error("external reactions do not match the pending preparation requests");
    }
    const suppliedById = new Map(reactions.map((reaction) => [reaction.requestId, reaction]));
    const externalDecisions = preparation.pendingReactionRequests.map((request, ordinal) => {
      const supplied = suppliedById.get(request.id);
      return supplied
        ? materializeExternalReaction(source, request, supplied, ordinal)
        : fallbackReactionDecision(payload.planningState, request);
    });
    const reactionDecisions = [
      ...structuredClone(preparation.preparedReactionDecisions),
      ...externalDecisions,
    ].sort((left, right) => left.requestId.localeCompare(right.requestId));
    if (reactionDecisions.length !== preparation.reactionRequests.length ||
      new Set(reactionDecisions.map((decision) => decision.requestId)).size !== reactionDecisions.length) {
      throw new Error("reaction decisions do not cover the frozen onset request set");
    }
    const resumedAgentIds = structuredClone(payload.resumedAgentIds);
    const resumedOutputs = structuredClone(payload.resumedOutputs);
    const resumedByAgent = new Map(resumedAgentIds.map((agentId, index) => [agentId, resumedOutputs[index]]));
    let newActions = structuredClone(payload.newActions);
    let temporalPlanning = structuredClone(payload.temporalPlanning);
    let newDependencyResults = structuredClone(payload.dependencyResults);
    const planningState = structuredClone(payload.planningState);
    const preparedAdmissionActivityIds = new Set(payload.sharedResourceAdmissions.map((admission) => admission.activityId));
    let interruptionTransitions = structuredClone(payload.interruptionTransitions)
      .filter((transition) => transition.kind !== "queued" &&
        !(transition.kind === "blocked" && preparedAdmissionActivityIds.has(transition.activityId)));
    const reactionDecisionPoints: import("../../mechanics/temporal").DecisionPoint[] = [];
    const reactionActivityIds = new Set<string>();

    for (const decision of reactionDecisions.filter((entry) => entry.kind === "keep")) {
      const request = preparation.reactionRequests.find((entry) => entry.id === decision.requestId)!;
      if (request.originalIntent.kind !== "ongoing_activity" ||
        decision.ongoingActivityDisposition === "continue") continue;
      const activity = planningState.truth.activities[request.originalIntent.activityId];
      if (!activity || activity.status !== "active") throw new Error(`reaction ${request.id} cannot settle Activity`);
      const settled = decision.ongoingActivityDisposition === "pause"
        ? pauseActivity(activity, source.truth.elapsedSeconds)
        : cancelActivity(activity, source.truth.elapsedSeconds);
      planningState.truth.activities[activity.id] = settled.activity;
      interruptionTransitions.push(settled.transition);
      reactionDecisionPoints.push({
        agentId: activity.actorId,
        reason: "activity_interrupted",
        activityId: activity.id,
        timerId: null,
      });
      reactionActivityIds.add(activity.id);
    }

    const replacementDecisions = reactionDecisions.filter((decision) => decision.kind === "replace");
    const replacementCompilationBatch = await this.actionCompiler(
      this.provider,
      planningState,
      replacementDecisions.map((decision) => decision.replacementAction),
      this.actionCompilationScope(context),
      input.definition.modelProfiles.grounding,
      this.config.actionCompilationMaxSlots,
      this.actionCompilationRecovery,
      this.symbolRepairPolicy,
    );
    if (replacementDecisions.length > 0) {
      this.emitSlotBatchMetrics(
        context,
        "action-compilation",
        replacementDecisions.length,
        this.config.actionCompilationMaxSlots,
        replacementCompilationBatch.batchCount,
        replacementCompilationBatch.metrics,
      );
    }
    const replacementCompilations = replacementCompilationBatch.compilations;
    const replacementPlanning: PlannedTemporalActivity[] = replacementCompilations.map((result) => ({
      plan: structuredClone(result.plan),
      activity: structuredClone(result.activity),
    }));
    const replacementDependencies: PreparedInteractionDependency[] = replacementCompilations.map((result) => ({
      dependency: structuredClone(result.dependency),
    }));
    for (const [index, decision] of replacementDecisions.entries()) {
      const request = preparation.reactionRequests.find((entry) => entry.id === decision.requestId)!;
      const generated = replacementPlanning[index]!;
      const dependency = replacementDependencies[index]!.dependency;
      generated.activity.interactionFootprint = interactionDependencyForActivity(
        planningState,
        generated.activity,
        dependency,
      );
      generated.activity.sharedResourceClaims = structuredClone(generated.activity.interactionFootprint.sharedResourceClaims);
      if (evaluateActivityContinuation(planningState, generated.activity).some((entry) => !entry.passed)) {
        throw new Error(`reaction Activity ${generated.activity.id} starts with a failed continuation assertion`);
      }
      if (request.originalIntent.kind === "prepared_action") {
        const originalActionId = request.originalIntent.actionId;
        const originalActivity = temporalPlanning.find((entry) => entry.plan.actionId === originalActionId)?.activity;
        if (!originalActivity) throw new Error(`reaction ${request.id} has no prepared Activity`);
        delete planningState.truth.activities[originalActivity.id];
        newActions = newActions.filter((action) => action.id !== originalActionId);
        temporalPlanning = temporalPlanning.filter((entry) => entry.plan.actionId !== originalActionId);
        newDependencyResults = newDependencyResults.filter((entry) => entry.dependency.id !== originalActionId);
      } else {
        const originalActivity = planningState.truth.activities[request.originalIntent.activityId];
        if (!originalActivity || originalActivity.status !== "active") {
          throw new Error(`reaction ${request.id} has no active source Activity`);
        }
        const cancelled = cancelActivity(originalActivity, source.truth.elapsedSeconds);
        planningState.truth.activities[originalActivity.id] = cancelled.activity;
        interruptionTransitions.push(cancelled.transition);
        reactionActivityIds.add(originalActivity.id);
      }
      newActions.push(structuredClone(decision.replacementAction));
      temporalPlanning.push(structuredClone(generated));
      newDependencyResults.push(structuredClone(replacementDependencies[index]!));
      planningState.truth.activities[generated.activity.id] = structuredClone(generated.activity);
    }
    newActions.sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
    for (const result of temporalPlanning) {
      planningState.truth.activities[result.activity.id] = structuredClone(result.activity);
    }
    const sharedResourceAdmissions = planSharedResourceAdmissions({
      activities: planningState.truth.activities,
      proposalActivityIds: temporalPlanning.map((result) => result.activity.id),
      pools: planningState.truth.sharedActivityResourcePools,
      definitions: planningState.truth.mechanics.sharedActivityResources,
      entities: planningState.truth.entities,
    }).admissions;
    const appliedAdmissions = applySharedResourceAdmissions({
      activities: planningState.truth.activities,
      admissions: sharedResourceAdmissions,
      atSeconds: source.truth.elapsedSeconds,
    });
    planningState.truth.activities = appliedAdmissions.activities;
    interruptionTransitions = [...interruptionTransitions, ...appliedAdmissions.transitions];
    validateActivityResources(
      planningState.truth.activities,
      planningState.truth.mechanics.activityResources,
    );
    const temporalStage = executionStage("temporal-dependency");
    await context.stages?.before(temporalStage);
    const temporalBoundary = selectTemporalBoundary({
      elapsedSeconds: source.truth.elapsedSeconds,
      maxAutonomousSpanSeconds: input.definition.runtimeDefaults.maxAutonomousSpanSeconds,
      activities: planningState.truth.activities,
      timers: planningState.truth.timers,
      conditionExpiries: Object.fromEntries(Object.values(planningState.truth.conditions)
        .filter((condition) => condition.expiresAtElapsedSeconds !== null)
        .map((condition) => [condition.id, condition.expiresAtElapsedSeconds!])),
    });
    let temporal = advanceTemporalState({
      boundary: temporalBoundary,
      activities: planningState.truth.activities,
      timers: planningState.truth.timers,
    });
    temporal.transitions = [...interruptionTransitions, ...temporal.transitions];
    temporal.decisionPoints = [...new Map([
      ...temporal.decisionPoints,
      ...reactionDecisionPoints,
      ...payload.resourceDecisionPoints.filter((point) =>
        !point.activityId || !preparedAdmissionActivityIds.has(point.activityId)),
      ...appliedAdmissions.decisionPoints,
    ].map((point) => [
      `${point.agentId}:${point.reason}:${point.activityId ?? ""}:${point.timerId ?? ""}`,
      point,
    ])).values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
    const dueActions = temporalBoundary.dueActivityIds.flatMap((activityId) => {
      const activity = planningState.truth.activities[activityId];
      if (!activity) throw new Error(`temporal boundary references unknown activity ${activityId}`);
      return [{ ...structuredClone(activity.sourceAction), baseRevision: source.revision }];
    });
    const dueActivityActors = new Set(dueActions.map((action) => action.actorId));
    const timerDescriptionsByAgent = new Map<AgentId, string[]>();
    for (const timerId of temporalBoundary.dueTimerIds) {
      const timer = planningState.truth.timers[timerId];
      if (!timer) throw new Error(`temporal boundary references unknown Timer ${timerId}`);
      for (const agentId of timer.wakeAgentIds) {
        const descriptions = timerDescriptionsByAgent.get(agentId) ?? [];
        descriptions.push(timer.description);
        timerDescriptionsByAgent.set(agentId, descriptions);
      }
    }
    const timerActions = [...timerDescriptionsByAgent.entries()]
      .filter(([agentId]) => !dueActivityActors.has(agentId))
      .map(([agentId, descriptions], ordinal): AgentActionProposal => ({
        id: runtimeId({
          worldHash: source.worldHash,
          revision: source.revision,
          kind: "action",
          stage: "timer",
          owner: agentId,
          round: 0,
          ordinal,
        }),
        actorId: agentId,
        baseRevision: source.revision,
        rawText: `处理同时到期的世界定时触发：${descriptions.join("；")}`,
        goal: "根据当前世界事实联合结算已到期触发",
        means: null,
        targetIds: [],
      }));
    const timerActionActors = new Set(timerActions.map((action) => action.actorId));
    const deferredActionIds = new Set(appliedAdmissions.deferredActionIds);
    const adjudicatedNewActions = newActions.filter((action) =>
      !timerActionActors.has(action.actorId) && !deferredActionIds.has(action.id));
    const adjudicatedHolderActivities = [...new Set(sharedResourceAdmissions.flatMap((admission) =>
      admission.kind === "adjudicate" ? admission.competingActivityIds : []))]
      .map((activityId) => planningState.truth.activities[activityId])
      .filter((activity): activity is ScheduledActivityState => Boolean(activity) && activity.status !== "queued" &&
        activity.status !== "ready")
      .sort((left, right) => left.id.localeCompare(right.id));
    const adjudicatedHolderActions = adjudicatedHolderActivities
      .filter((activity) => !timerActionActors.has(activity.actorId))
      .map((activity) => ({ ...structuredClone(activity.sourceAction), baseRevision: source.revision }));
    let actions = [...new Map([
      ...adjudicatedNewActions,
      ...adjudicatedHolderActions,
      ...dueActions,
      ...timerActions,
    ].map((action) => [action.id, action])).values()]
      .sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
    const temporalInputState = structuredClone(planningState);
    temporalInputState.truth.rng = structuredClone(preparation.onsetPerception.rng);
    const temporalInput: WorldStepInput = { ...input, state: temporalInputState };
    const newDependencyByAction = new Map(newDependencyResults.map((result) => [
      result.dependency.id,
      result,
    ]));
    const holderDependencyByAction = new Map(adjudicatedHolderActivities.map((activity) => [
      activity.sourceActionId,
      {
        ...structuredClone(activity.interactionFootprint),
        kind: "action" as const,
        id: activity.sourceActionId,
      },
    ]));
    const dependencyResults = await settledValues(actions.map((action) => async (): Promise<{
      dependency: InteractionDependency;
      audit: ModelExecutionAudit | null;
    }> => {
      const existing = newDependencyByAction.get(action.id);
      if (existing) return { dependency: existing.dependency, audit: null };
      const holderDependency = holderDependencyByAction.get(action.id);
      if (holderDependency) {
        return {
          dependency: holderDependency,
          audit: null,
        };
      }
      return this.interactionGrounder(
        this.provider,
        planningState,
        action,
        context.modelScope,
        input.definition.modelProfiles.grounding,
        0,
        this.interactionGroundingRecovery.maxRepairs,
      );
    }), "action grounding", this.config.groundingMaxSlots);
    const actionDependencies = [
      ...dependencyResults.map((result) => result.dependency),
      ...newDependencyResults
        .filter((result) => deferredActionIds.has(result.dependency.id))
        .map((result) => result.dependency),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const temporalContextDependencies: InteractionDependency[] = [
      ...temporalBoundary.dueTimerIds.map((timerId) =>
        interactionDependencyForTimer(planningState, planningState.truth.timers[timerId]!)),
      ...temporalBoundary.dueConditionIds.map((conditionId) =>
        interactionDependencyForCondition(planningState, planningState.truth.conditions[conditionId]!)),
    ];
    const actionIds = new Set(actionDependencies.map((dependency) => dependency.id));
    const affectedActivityIds = new ActivityFootprintIndex(planningState.truth.activities)
      .affectedBy([...actionDependencies, ...temporalContextDependencies])
      .filter((activityId) => {
        const activity = planningState.truth.activities[activityId];
        return Boolean(activity) && activity.status !== "completed" && activity.status !== "blocked" &&
          activity.status !== "failed" && activity.status !== "cancelled" && !actionIds.has(activity.sourceActionId);
      });
    let interactionDependencies = [
      ...actionDependencies,
      ...temporalContextDependencies,
      ...affectedActivityIds.map((activityId) =>
        structuredClone(planningState.truth.activities[activityId]!.interactionFootprint)),
    ].sort((left, right) => left.id.localeCompare(right.id));
    let components = interactionDependencyComponents(interactionDependencies);
    const resolvingActionIds = new Set(actions.map((action) => action.id));
    let adjudicatedComponents = components.filter((component) => component.some((interactionId) =>
      resolvingActionIds.has(interactionId)));
    let componentResults: ComponentResolution[] = [];
    let rng = structuredClone(preparation.onsetPerception.rng);
    const orderedComponents = adjudicatedComponents
      .map((component) => [...component].sort())
      .sort((left, right) => left[0]!.localeCompare(right[0]!));
    await context.stages?.after(temporalStage);
    const truthResolutionStage = executionStage("truth-resolution");
    await context.stages?.before(truthResolutionStage);
    if (orderedComponents.length > 1) {
      const speculativeRng = structuredClone(rng);
      const orderedRandom = this.orderedComponentRandom ? new OrderedRandomStream(speculativeRng, orderedComponents.length) : null;
      const pendingWork = new AbortController();
      const componentContext: ExecutionContext = {
        ...context,
        modelScope: {
          ...context.modelScope,
          cancelPendingSignal: AbortSignal.any([
            pendingWork.signal,
            ...(context.modelScope.cancelPendingSignal ? [context.modelScope.cancelPendingSignal] : []),
          ]),
        },
      };
      const speculativeResults = await settledValues(
        orderedComponents.map((component, index) => async () => {
          const result = await this.resolveComponent(
            temporalInput, actions, interactionDependencies, component,
            speculativeRng, componentContext, false, temporal,
            reactionDecisions, sessions,
            orderedRandom ? {
              acquire: () => orderedRandom.acquire(index),
              finish: state => orderedRandom.finish(index, state),
            } : undefined,
          );
          return result;
        }),
        "truth resolution components",
        orderedComponents.length || 1,
        () => {
          const error = new DOMException("Atomic component work is invalidated", "AbortError");
          pendingWork.abort(error);
          orderedRandom?.abort(error);
        },
      );
      const hasRandomCommitments = speculativeResults.some((result) =>
        result.resolution.rng.draws !== speculativeRng.draws ||
        result.resolution.checks.length > 0 ||
        result.resolution.randomRequests.length > 0);
      if (orderedRandom) {
        componentResults = speculativeResults;
        rng = structuredClone(componentResults.at(-1)!.resolution.rng);
      } else if (!hasRandomCommitments) {
        componentResults = speculativeResults;
      } else {
        // A single deterministic RNG stream cannot be consumed concurrently
        // without changing replay semantics.  Keep the fast path for
        // non-random components and fall back to the canonical stream order
        // whenever a component actually commits a check or random draw.
        await Promise.all(speculativeResults.map(result => result.close()));
        componentResults = [];
        rng = structuredClone(preparation.onsetPerception.rng);
        for (const component of orderedComponents) {
          const result = await this.resolveComponent(
            temporalInput,
            actions,
            interactionDependencies,
            component,
            rng,
            context,
            false,
            temporal,
            reactionDecisions, sessions,
          );
          componentResults.push(result);
          rng = structuredClone(result.resolution.rng);
        }
      }
    } else {
      for (const component of orderedComponents) {
        const result = await this.resolveComponent(
          temporalInput,
          actions,
          interactionDependencies,
          component,
          rng,
          context,
          false,
          temporal,
          reactionDecisions, sessions,
        );
        componentResults.push(result);
        rng = structuredClone(result.resolution.rng);
      }
    }
    componentResults.sort((left, right) => {
      const leftKey = left.resolution.actions.map((action) => action.id).sort()[0] ?? "";
      const rightKey = right.resolution.actions.map((action) => action.id).sort()[0] ?? "";
      return leftKey.localeCompare(rightKey);
    });
    if (componentResults.every((result) => result.resolution.rng.draws === preparation.onsetPerception.rng.draws)) {
      rng = structuredClone(preparation.onsetPerception.rng);
    }
    let resolutions = componentResults.map((result) => result.resolution);
    const fallbackLaw = input.definition.laws[0];
    if (!fallbackLaw) throw new Error("temporal advancement requires at least one world law");
    let fallback = false;
    if (contentHash(interactionDependencyComponents(interactionDependencies)) !== contentHash(components)) fallback = true;
    for (let left = 0; left < resolutions.length; left += 1) {
      for (let right = left + 1; right < resolutions.length; right += 1) {
        if (resolvedComponentsConflict(source, resolutions[left], resolutions[right])) fallback = true;
      }
    }
    for (const [index, resolution] of resolutions.entries()) {
      const componentDependencies = interactionDependencies.filter((dependency) =>
        componentResults[index]!.interactionIds.includes(dependency.id));
      if (resolutionExceedsDeclaredDependencies(source, resolution, componentDependencies)) fallback = true;
    }
    if (fallback) {
      await Promise.all(componentResults.map(result => result.close()));
      actions = [...new Map(resolutions.flatMap((entry) => entry.actions)
        .map((action) => [action.id, structuredClone(action)])).values()]
        .sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
      const globalDependencies = interactionDependencies.map((dependency) =>
        forceGlobalInteractionDependency(dependency));
      components = [globalDependencies.map((dependency) => dependency.id).sort()];
      adjudicatedComponents = components;
      componentResults = [await this.resolveComponent(
        temporalInput,
        actions,
        globalDependencies,
        components[0],
        preparation.onsetPerception.rng,
        context,
        true,
        temporal,
        reactionDecisions, sessions,
      )];
      resolutions = componentResults.map((result) => result.resolution);
      interactionDependencies = globalDependencies;
    }
    await context.stages?.after(truthResolutionStage);
    const transitionStage = executionStage("transition-causal-verification");
    await context.stages?.before(transitionStage);
    const temporalBase = structuredClone(temporal);
    const globalObservationAudits: ModelExecutionAudit[] = [];
    const finalReviewAudits: ModelExecutionAudit[] = [];
    const assemble = () => {
      const resolution = mergeResolutions(
        planningState,
        componentResults.length > 0 ? componentResults.map(result => result.resolution)
          : [this.contextOnlyResolution(temporalInput, temporalBoundary, { kind: "law", id: fallbackLaw.id })],
        temporalBoundary,
        { kind: "law", id: fallbackLaw.id },
      );
      const deterministicResourceActions = newActions
        .filter((action) => deferredActionIds.has(action.id))
        .sort((left, right) => left.id.localeCompare(right.id));
      const deterministicResourceOutcomes = materializeSharedResourceAdmissionOutcomes({
        worldHash: source.worldHash,
        revision: source.revision,
        actions: deterministicResourceActions,
        admissions: sharedResourceAdmissions,
        activities: planningState.truth.activities,
        pools: planningState.truth.sharedActivityResourcePools,
        definitions: planningState.truth.mechanics.sharedActivityResources,
      });
      resolution.actions = [...resolution.actions, ...structuredClone(deterministicResourceActions)]
        .sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
      resolution.proposal.outcomes = [...resolution.proposal.outcomes, ...deterministicResourceOutcomes]
        .sort((left, right) => left.proposalId.localeCompare(right.proposalId));
      resolution.causalAssertionResults = evaluateProposalCausality(
        planningState,
        resolution.checks,
        resolution.randomResults,
        resolution.proposal,
      );
      resolution.requests = [
        ...structuredClone(preparation.onsetPerception.requests),
        ...resolution.requests,
      ];
      resolution.checks = [
        ...structuredClone(preparation.onsetPerception.checks),
        ...resolution.checks,
      ];
      resolution.commitmentRounds = [
        ...structuredClone(preparation.onsetPerception.commitmentRounds),
        ...resolution.commitmentRounds,
      ];
      resolution.initialActions = [...new Map([
        ...timerActions,
        ...dueActions,
        ...payload.newActions,
      ].map((action) => [action.actorId, structuredClone(action)])).values()]
        .sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
      resolution.reactionRequests = structuredClone(preparation.reactionRequests);
      resolution.reactionDecisions = structuredClone(reactionDecisions);
      resolution.stimulusObservations = preparation.reactionRequests.map((request) =>
        structuredClone(request.stimulus));

      resolution.rng = structuredClone(componentResults.reduce((latest, result) =>
        result.resolution.rng.draws > latest.draws ? result.resolution.rng : latest, preparation.onsetPerception.rng));
      const reconciled = reconcileTemporalOutcomes(temporalBase, resolution.proposal.outcomes);
      const preview = applyTransitionProposal(source, resolution.proposal, reconciled);
      const liveAgents = Object.keys(preview.agents).sort();
      const dynamicLifecycleChange = resolution.proposal.operations.some(operation =>
        operation.kind === "create_entity" || operation.kind === "create_agent" ||
        operation.kind === "retire_entity" || operation.kind === "remove_agent");
      let observerIds = components.length > 1 || deterministicResourceActions.length > 0 || dynamicLifecycleChange
        ? liveAgents : [...new Set([
          ...resolution.actions.map(action => action.actorId),
          ...interactionDependencies.flatMap(dependency => dependency.audienceAgentIds),
        ])].filter(id => Boolean(preview.agents[id])).sort();
      // Observer coverage can expand once to all live Agents. Recompute lifecycle
      // settlement from the immutable base, never from the preceding settlement.
      while (true) {
        let settledTemporal = structuredClone(reconciled);
        const preContextCandidate = applyTransitionProposal(source, resolution.proposal, settledTemporal);
        preContextCandidate.truth.rng = structuredClone(resolution.rng);
        const observedAgentIds = new Set([...observerIds, ...resolution.stimulusObservations.map(packet => packet.observerId)]);
        // Retained Activity footprints constrain this boundary without emitting a new interaction.
        const relevantExternalObservers = new Set(interactionDependencies.filter(dependency => dependency.kind !== "activity").flatMap(dependency =>
          dependency.audienceAgentIds.filter(agentId => dependency.actorId !== agentId && observedAgentIds.has(agentId))));
        const preserveActiveActivityIds = new Set(reactionDecisions.flatMap((decision) => {
          if (decision.kind !== "keep" || decision.ongoingActivityDisposition !== "continue") return [];
          const request = preparation.reactionRequests.find((entry) => entry.id === decision.requestId);
          if (!request) return [];
          if (request.originalIntent.kind === "ongoing_activity") return [request.originalIntent.activityId];
          const preparedActionId = request.originalIntent.actionId;
          const activity = Object.values(settledTemporal.activities).find((entry) =>
            entry.sourceActionId === preparedActionId);
          return activity ? [activity.id] : [];
        }));
        const contextSettlement = settleActivityContexts({
          preTransitionState: planningState,
          state: preContextCandidate,
          temporal: settledTemporal,
          activityIds: [...new Set([
            ...affectedActivityIds,
            ...temporalBoundary.dueActivityIds,
            ...reactionActivityIds,
          ])],
          relevantObserverIds: relevantExternalObservers,
          preserveActiveActivityIds,
        });
        settledTemporal = contextSettlement.temporal;
        const activityDispositions = contextSettlement.dispositions;
        const promotionState = applyTransitionProposal(source, resolution.proposal, settledTemporal);
        const queuePromotion = promoteSharedResourceQueues({
          activities: settledTemporal.activities,
          pools: promotionState.truth.sharedActivityResourcePools,
          definitions: promotionState.truth.mechanics.sharedActivityResources,
          entities: promotionState.truth.entities,
          atSeconds: temporalBoundary.toElapsedSeconds,
        });
        settledTemporal.activities = queuePromotion.activities;
        settledTemporal.transitions = [...settledTemporal.transitions, ...queuePromotion.transitions];

        const needsAllObservers = activityDispositions.some(disposition =>
          disposition.kind === "block" || disposition.kind === "fail" || disposition.kind === "cancel") ||
          queuePromotion.reservedActivityIds.length > 0;
        if (needsAllObservers && contentHash(observerIds) !== contentHash(liveAgents)) {
          observerIds = liveAgents;
          continue;
        }
        return { resolution, temporal: settledTemporal, activityDispositions, observerIds };
      }
    };
    let assembled = assemble();
    let observationRound = 0;
    let observationRepairs = 0;
    const render = async (observerIds: readonly string[], feedbackByObserver?: Readonly<Record<string, readonly string[]>>) => {
      if (observerIds.length === 0) return;
      const rendered = await this.observationRenderer.render({
        definition: input.definition, state: planningState,
        proposal: structuredClone(assembled.resolution.proposal), actions: assembled.resolution.actions,
        observerIds, identityOwner: `step-final-observation-${observationRound++}`,
        temporalState: assembled.temporal, feedbackByObserver,
      }, context.modelScope);
      if (contentHash([...new Set(rendered.packets.map(packet => packet.observerId))].sort()) !== contentHash([...observerIds].sort())) {
        throw new Error("final observation rendering changed observer coverage");
      }
      const requested = new Set(observerIds);
      assembled.resolution.proposal.observations = [
        ...assembled.resolution.proposal.observations.filter(packet => !requested.has(packet.observerId)),
        ...structuredClone(rendered.packets),
      ].sort((left, right) => left.observerId.localeCompare(right.observerId) || left.id.localeCompare(right.id));
      globalObservationAudits.push(...structuredClone(rendered.modelAudits));
      context.instrumentation.emit({ event: "algorithm.observation.global_projection_completed",
        attributes: { phase: "observation", reason: "final-candidate" },
        counts: { observations: rendered.packets.length, observationBatches: rendered.batchCount, dependencyComponents: components.length } });
    };
    await render(assembled.observerIds);
    let acceptedReview: BoundCausalReview;
    while (true) {
      const candidateResolution = assembled.resolution;
      const proposal = candidateResolution.proposal;
      const preview = applyTransitionProposal(source, proposal, assembled.temporal);
      validateObservations(preview, [...candidateResolution.stimulusObservations, ...proposal.observations], preview.step);
      for (const action of candidateResolution.actions) {
        if (!proposal.observations.some(packet => packet.kind === "outcome" && packet.observerId === action.actorId)) {
          throw new Error(`final transition omitted observation for ${action.actorId}`);
        }
      }
      candidateResolution.causalAssertionResults = evaluateProposalCausality(planningState,
        candidateResolution.checks, candidateResolution.randomResults, proposal);
      if (candidateResolution.causalAssertionResults.some(result => !result.passed)) {
        throw new Error("merged candidate failed deterministic causal assertions");
      }
      const evidence: CausalReviewEvidence = {
        definition: input.definition, state: planningState,
        workset: { state: planningState, mode: "full", initialActions: candidateResolution.initialActions,
          assignedActions: candidateResolution.actions, availableActions: candidateResolution.actions,
          assignedDependencies: interactionDependencies, availableDependencies: interactionDependencies },
        checkRequests: candidateResolution.requests, checkResults: candidateResolution.checks,
        randomRequests: candidateResolution.randomRequests, randomResults: candidateResolution.randomResults,
        commitmentRounds: candidateResolution.commitmentRounds, resolutionPlans: candidateResolution.resolutionPlans,
        resolutionReceipts: candidateResolution.resolutionReceipts, proposal,
        assertionResults: candidateResolution.causalAssertionResults, mechanicResults: candidateResolution.mechanicResults,
        reactionDecisions, temporalEvidence: temporalBoundary,
        candidateTemporalState: { activities: assembled.temporal.activities, timers: assembled.temporal.timers },
        previousReport: null, instanceId: context.modelScope.workloadId, advanceId: context.modelScope.batchId,
        mechanicContracts: componentResults[0]?.stage.reviewEvidence.mechanicContracts,
        resolutionScope: { mode: "global", selectedActionIds: candidateResolution.actions.map(action => action.id).sort(),
          totalActionCount: candidateResolution.actions.length },
      };
      const review = await this.truthEngine.reviewCandidate(evidence, context.modelScope, "step-final",
        finalReviewAudits.reduce((count, audit) => count + audit.invocations.length, 0));
      finalReviewAudits.push(review.audit);
      if (review.value.verdict === "accept") {
        assertCausalReviewMatches(evidence, review);
        acceptedReview = review;
        break;
      }
      const findings = review.value.findings;
      const describe = (finding: typeof findings[number]) => `${finding.code}: ${finding.message}; ${finding.repairHint}`;
      const error = new Error(`causal verifier rejected final transition: ${findings.map(describe).join(" | ")}`);
      const feedback: Record<string, string[]> = {};
      for (const finding of findings.filter(finding => finding.target.kind === "observation")) {
        const packet = proposal.observations.find(packet => packet.id === finding.target.id);
        if (!packet) throw error;
        (feedback[packet.observerId] ??= []).push(describe(finding));
      }
      if (findings.length > 0 && findings.every(finding => finding.target.kind === "observation")) {
        if (observationRepairs++ >= this.truthEngine.candidateRepairLimit) throw error;
        await render(Object.keys(feedback).sort(), feedback);
        continue;
      }
      const repairs = new Map<ComponentResolution, typeof findings>();
      for (const finding of findings.filter(finding => finding.target.kind !== "observation")) {
        const owners = componentResults.filter(component => {
          const local = component.resolution.proposal;
          switch (finding.target.kind) {
            case "outcome": return local.outcomes.some(value => value.id === finding.target.id);
            case "event": return local.events.some(value => value.id === finding.target.id);
            case "mechanic": return local.mechanicInvocations.some(value => value.id === finding.target.id);
            case "operation": {
              const operation = proposal.operations[Number(finding.target.id.split(":", 1)[0])];
              return operation && operation.kind !== "advance_time" && local.operations.some(value => contentHash(value) === contentHash(operation));
            }
            default: return false;
          }
        });
        if (owners.length !== 1) throw new Error(`final finding ${finding.target.kind}:${finding.target.id} has ${owners.length} component owners`, { cause: error });
        const owner = owners[0]!;
        const ownedFindings = repairs.get(owner) ?? [];
        const target = structuredClone(finding.target);
        if (target.kind === "operation") {
          const operation = proposal.operations[Number(target.id.split(":", 1)[0])]!;
          const localIndex = owner.resolution.proposal.operations.findIndex(value => contentHash(value) === contentHash(operation));
          target.id = `${localIndex}:${operation.kind}`;
        }
        ownedFindings.push({ ...finding, target });
        repairs.set(owner, ownedFindings);
      }
      if (repairs.size === 0) throw error;
      await settledValues([...repairs].map(([owner, ownedFindings]) => () => owner.repair(new ModelCandidateValidationError(
        causalReviewRepairIssues({ ...owner.stage.reviewEvidence, state: owner.stage.reviewEvidence.workset.state,
          actions: owner.stage.reviewEvidence.workset.availableActions }, ownedFindings),
      ))),
        "final candidate component repairs");
      for (const component of componentResults) {
        const dependencies = interactionDependencies.filter(dependency => component.interactionIds.includes(dependency.id));
        if (resolutionExceedsDeclaredDependencies(source, component.resolution, dependencies)) {
          throw new Error("repaired final component exceeded its fixed dependencies");
        }
      }
      for (let left = 0; left < componentResults.length; left += 1) {
        for (let right = left + 1; right < componentResults.length; right += 1) {
          if (resolvedComponentsConflict(source, componentResults[left]!.resolution, componentResults[right]!.resolution)) {
            throw new Error("repaired final components introduced a conflict");
          }
        }
      }
      assembled = assemble();
      await render(assembled.observerIds, feedback);
    }
    await Promise.all(componentResults.map(result => result.finish()));
    const resolution: TruthResolution = { ...assembled.resolution, causalVerification: acceptedReview.value,
      modelAudits: dedupeModelAudits([...componentResults.flatMap(result => result.resolution.modelAudits), ...finalReviewAudits]) };
    temporal = assembled.temporal;
    const activityDispositions = assembled.activityDispositions;
    const observations = [...resolution.stimulusObservations, ...resolution.proposal.observations];
    const candidate = applyTransitionProposal(source, resolution.proposal, temporal);
    candidate.truth.rng = structuredClone(resolution.rng);
    await context.stages?.after(transitionStage);
    const { modelAudits: resolutionModelAudits, reactionModelAudits, ...resolutionCandidate } = resolution;
    const finalCausalReview = {
      contentHash: finalCausalReviewContentHash({ sourceStateHash: contentHash(source), onsetPerception: preparation.onsetPerception, resolution: resolutionCandidate,
        temporalBoundary, temporalState: { activities: temporal.activities, timers: temporal.timers } }),
      ...acceptedReview.binding,
      invocationIds: acceptedReview.audit.invocations.map(invocation => invocation.id),
    };
    const postBoundaryDecisionAgents = new Set(temporal.decisionPoints.map((point) => point.agentId));
    const busyAfterBoundary = new Set(Object.values(temporal.activities)
      .filter((activity) => activity.status === "active" || activity.status === "paused" ||
        activity.status === "queued" || activity.status === "ready")
      .flatMap((activity) => activity.participantAgentIds));
    const modelAgentIds = Object.keys(candidate.agents)
      .filter((agentId) => !source.agents[agentId] ||
        input.policyRoster[agentId]?.kind === "model" &&
        (!busyAfterBoundary.has(agentId) || postBoundaryDecisionAgents.has(agentId)))
      .sort();
    const mindWork = modelAgentIds.map((agentId) => {
      let agent = applyObservationBindings(candidate.agents[agentId], observationsFor(observations, agentId));
      const resumed = resumedByAgent.get(agentId);
      if (resumed) {
        agent = applyMindCommit(
          agent,
          resumed,
          source.step,
          [],
          [],
        );
      }
      const action = resolution.actions.find((entry) => entry.actorId === agentId) ?? null;
      const outcome = action
        ? resolution.proposal.outcomes.find((entry) => entry.proposalId === action.id) ?? null
        : null;
      const purpose = source.agents[agentId] ? "mind" : "bootstrap";
      const pendingObservations = pendingObservationsFor(
        candidate,
        agent,
        observationsFor(observations, agentId),
      );
      return {
        agentId,
        purpose,
        input: {
          agent,
          observations: pendingObservations,
          currentResolution: { action, outcome: outcome ? { status: outcome.status } : null },
          events: resolution.proposal.events,
        } satisfies AgentCognitionBatchInput,
      };
    });
    const mindStage = executionStage("observation-agent-mind");
    await context.stages?.before(mindStage);
    const finalMindBatches = await Promise.all((["bootstrap", "mind"] as const).map(async (purpose) => {
      const work = mindWork.filter((entry) => entry.purpose === purpose);
      const batch = await this.thinkBatchWithFallback(
        candidate,
        work.map((entry) => entry.input),
        purpose,
        context,
      );
      return { work, batch };
    }));
    const outputsByAgent = new Map(finalMindBatches.flatMap(({ work, batch }) =>
      work.map((entry, index) => [entry.agentId, batch.outputs[index]!] as const)));
    const outputs = modelAgentIds.map((agentId) => {
      const output = outputsByAgent.get(agentId);
      if (!output) throw new Error(`AgentMind omitted final output for ${agentId}`);
      return output;
    });
    const finalMindAudits = finalMindBatches.flatMap(({ batch }) => batch.modelAudits);
    await context.stages?.after(mindStage);
    const finalActionIds = new Set(resolution.actions.map((action) => action.id));
    interactionDependencies = interactionDependencies.filter((dependency) =>
      dependency.kind !== "action" || finalActionIds.has(dependency.id));
    components = interactionDependencyComponents(interactionDependencies);
    const dependencyGraph = buildInteractionDependencyGraph(interactionDependencies, "canonical");
    return {
      schemaVersion: WORLD_STEP_CANDIDATE_SCHEMA_VERSION,
      sourceStateHash: contentHash(source),
      resolution: resolutionCandidate,
      onsetPerception: structuredClone(preparation.onsetPerception),
      finalCausalReview,
      mindCommits: outputs.map((output, index) => {
        const agentId = modelAgentIds[index];
        const resumed = resumedByAgent.get(agentId);
        return {
          agentId,
          beliefPatch: {
            ...structuredClone(output.beliefPatch),
            operations: [
              ...structuredClone(resumed?.beliefPatch.operations ?? []),
              ...structuredClone(output.beliefPatch.operations),
            ],
          },
          characterPatch: {
            ...structuredClone(output.characterPatch),
            operations: [
              ...structuredClone(resumed?.characterPatch.operations ?? []),
              ...structuredClone(output.characterPatch.operations),
            ],
          },
          nextAction: structuredClone(output.nextAction),
        };
      }),
      modelAudits: dedupeModelAudits([
        ...structuredClone(preparation.modelAudits),
        ...replacementCompilationBatch.modelAudits.map((audit) => structuredClone(audit)),
        ...dependencyResults.flatMap((result) => result.audit ? [structuredClone(result.audit)] : []),
        ...resolutionModelAudits,
        ...reactionModelAudits,
        ...globalObservationAudits,
        ...finalMindAudits,
      ]),
      interactionDependencies: structuredClone(interactionDependencies),
      diagnostics: {
        activatedAgentIds: [...modelAgentIds],
        reusedAgentIds: [],
        mindFallbackAgentIds: [],
        dependencyComponents: structuredClone(components),
        globalReadjudication: fallback,
        dependencyGraph: {
          mode: "canonical",
          nodeCount: dependencyGraph.nodeIds.length,
          edgeCount: dependencyGraph.edgeCount,
          componentCount: dependencyGraph.components.length,
          maxComponentSize: dependencyGraph.maxComponentSize,
          globalFallbackNodeIds: structuredClone(dependencyGraph.globalFallbackNodeIds),
          contentHash: dependencyGraph.contentHash,
        },
      },
      temporalPlans: [
        ...structuredClone(payload.readyTemporalPlans),
        ...temporalPlanning
          .filter((result) => planningState.truth.activities[result.activity.id]?.status !== "queued")
          .map((result) => structuredClone(result.plan)),
      ],
      temporalBoundary: structuredClone(temporalBoundary),
      temporalState: {
        activities: structuredClone(temporal.activities),
        timers: structuredClone(temporal.timers),
      },
      activityTransitions: structuredClone(temporal.transitions),
      activityDispositions: structuredClone(activityDispositions),
      sharedResourceAdmissions: structuredClone(sharedResourceAdmissions),
      decisionPoints: structuredClone(temporal.decisionPoints),
    };
  }
}
