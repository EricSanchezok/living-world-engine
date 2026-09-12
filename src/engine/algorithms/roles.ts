import type { OnsetPerceptionTranscript } from "../runtime/execution";
import type { AgentMindOutput } from "../contracts/llm-schemas";
import type {
  AgentActionProposal,
  AgentState,
  CausalVerification,
  D20CheckResult,
  DiscreteRandomResult,
  ModelExecutionAudit,
  ObservationPacket,
  ReactionDecision,
  ReactionRequest,
  SimulationState,
  TransitionProposal,
  WorldEvent,
} from "../contracts/model";
import type { buildCausalVerificationContext, ResolutionScope } from "../contracts/prompts";
import type { SymbolRepairPolicy } from "../contracts/symbol-repair";
import type { PerceptionTarget } from "../contracts/perception-references";
import type { RulePackageRegistry } from "../mechanics/rule-package";
import type {
  ScheduledActivityState,
  TemporalBoundary,
  TemporalPlan,
  TemporalStateSnapshot,
} from "../mechanics/temporal";
import type { ModelExecutionScope, StructuredModelProvider } from "../models/model-provider";
import type {
  InteractionDependency,
  WorldResolutionCandidate,
} from "../runtime/execution";
import type { JsonObject } from "../runtime/json";
import type { WorldDefinition } from "../runtime/world-definition";
import type {
  AlgorithmImplementation,
  AlgorithmRole,
  ResolvedAlgorithm,
} from "./composition";

/** Stable cross-implementation metrics exposed by batched Role capabilities. */
export interface AlgorithmBatchMetrics {
  submittedSlots: number;
  repairCalls: number;
  repeatedFingerprints: number;
  splitCount: number;
  partialFailureSlots: number;
  singletonFailures: number;
}

export interface OutputRecoveryCapability {
  readonly maxRepairs: number;
  readonly exhaustion: "fail-step";
  splitAt(slotCount: number): number;
}

export interface AgentCognitionBatchInput {
  agent: AgentState;
  observations: readonly ObservationPacket[];
  currentResolution: {
    action: AgentActionProposal | null;
    outcome: {
      status: "succeeded" | "partial" | "failed" | "blocked" | "continuing";
    } | null;
  };
  events: readonly WorldEvent[];
}

export interface AgentCognitionBatchResult {
  outputs: Map<string, AgentMindOutput>;
  failures: Array<{ agentId: string; error: unknown }>;
  modelAudits: ModelExecutionAudit[];
  batchCount: number;
  metrics: AlgorithmBatchMetrics;
}

export interface AgentCognitionCapability {
  thinkBatch(
    state: SimulationState,
    inputs: readonly AgentCognitionBatchInput[],
    scope: ModelExecutionScope,
    purpose?: "bootstrap" | "mind" | "resume",
    maxSlots?: number,
  ): Promise<AgentCognitionBatchResult>;
}

export interface ReactionDecisionCapability {
  react(
    state: SimulationState,
    agent: AgentState,
    originalAction: AgentActionProposal,
    request: ReactionRequest,
    scope: ModelExecutionScope,
  ): Promise<ReactionDecision & { modelAudit: ModelExecutionAudit }>;
}

export interface CompiledAction {
  plan: TemporalPlan;
  activity: ScheduledActivityState;
  dependency: InteractionDependency;
}

export interface ActionCompilationResult {
  compilations: CompiledAction[];
  modelAudits: ModelExecutionAudit[];
  batchCount: number;
  metrics: AlgorithmBatchMetrics;
}

export type PlannedTemporalActivity = Pick<CompiledAction, "plan" | "activity">;

export interface ActionCompilationCapability {
  (
    provider: StructuredModelProvider,
    state: Readonly<SimulationState>,
    actions: readonly AgentActionProposal[],
    scope: ModelExecutionScope,
    profileId: string,
    maxSlots: number,
    recovery?: Readonly<OutputRecoveryCapability>,
    symbolRepairPolicy?: Readonly<SymbolRepairPolicy>,
  ): Promise<ActionCompilationResult>;
}

export interface CandidateSelectionDiagnostics {
  /** Repairs reuse the root allowance; their displayed pool may be smaller. */
  rootSelection?: { fullContextHash: string; shortlistHash: string; visibleCount: number; selectedCount: number; batchBudget: number };
  selectedCount: number;
  visibleCount: number;
  batchBudget: number;
  nominalBatchBudget?: number;
  mandatoryBudgetFloorApplied?: boolean;
  batchShortlistRatio: number;
  prunedReferenceCount: number;
  anchorCount: number;
  budgetExceeded: false;
  perSlotSelectedCount: Readonly<Record<string, number>>;
  cache: {
    passageHits: number;
    passageMisses: number;
    queryHits: number;
    queryMisses: number;
    readMs: number;
    passageEncodeMs: number;
    queryEncodeMs: number;
    queryBatchSize: number;
  };
}

export interface CandidateSelectionResult {
  modelContext: Record<string, unknown>;
  selectedKeysBySlot: ReadonlyMap<number, readonly string[]>;
  fullContextHash: string;
  modelContextHash: string;
  shortlistHash: string;
  diagnostics: CandidateSelectionDiagnostics;
}

export interface CandidateSelectionCapability {
  readonly version: string;
  readonly role: "candidate-selection";
  retrieveBatch(input: {
    worldContentHash: string;
    fullContext: Readonly<Record<string, unknown>>;
    slotIndices: readonly number[];
    signal?: AbortSignal;
  }): Promise<CandidateSelectionResult>;
}

export interface InteractionGroundingCapability {
  (
    provider: StructuredModelProvider,
    state: Readonly<SimulationState>,
    action: AgentActionProposal,
    scope: ModelExecutionScope,
    profileId: string,
    invocationOffset?: number,
    repairAttempts?: number,
  ): Promise<{ dependency: InteractionDependency; audit: ModelExecutionAudit }>;
}

export interface OnsetPerceptionInput {
  definition: WorldDefinition;
  state: SimulationState;
  actions: AgentActionProposal[];
  temporalBoundary: TemporalBoundary;
  identityOwner: string;
  groundings: readonly InteractionDependency[];
  perceptionTargets?: readonly PerceptionTarget[];
}

export interface OnsetPerceptionResult extends OnsetPerceptionTranscript {
  modelAudit: ModelExecutionAudit;
  aliases: Array<[string, string | null]>;
}

export interface OnsetPerceptionCapability {
  perceiveOnset(
    input: Readonly<OnsetPerceptionInput>,
    scope: ModelExecutionScope,
  ): Promise<OnsetPerceptionResult>;
}

export interface ReactionResolution {
  decisions: ReactionDecision[];
  groundings: InteractionDependency[];
  modelAudits: ModelExecutionAudit[];
}

export interface ObservationResolution {
  packets: ObservationPacket[];
  modelAudits: ModelExecutionAudit[];
}

export const TRUTH_RESOLUTION_CONTRACT_VERSION = 4;

export interface TruthResolution extends WorldResolutionCandidate {
  modelAudits: ModelExecutionAudit[];
  reactionModelAudits: ModelExecutionAudit[];
}

export type CausalReviewEvidence = Omit<Parameters<typeof buildCausalVerificationContext>[0], "issues">;

export interface BoundCausalReview {
  value: CausalVerification;
  audit: ModelExecutionAudit;
  binding: { evidenceHash: string; promptVersion: string };
}

/** Candidate generation alone never grants semantic acceptance. */
export type UnreviewedTruthResolution = Omit<TruthResolution, "causalVerification">;

export interface TruthCandidateStage {
  resolution: UnreviewedTruthResolution;
  reviewEvidence: CausalReviewEvidence;
  transitionAttempt: number;
  reviewInvocationOffset: number;
}

export type TruthCandidateFeedback = { kind: "finish" } | {
  kind: "repair";
  error: unknown;
  previousReport: CausalVerification | null;
};

/** Consume sequentially; return() closes a suspended session without model work. */
export type TruthCandidateSession = AsyncGenerator<TruthCandidateStage, UnreviewedTruthResolution | undefined, TruthCandidateFeedback>;

export interface TruthResolutionInput {
  definition: WorldDefinition;
  state: SimulationState;
  initialActions: AgentActionProposal[];
  temporalBoundary: TemporalBoundary;
  identityOwner: string;
  groundings: readonly InteractionDependency[];
  modelWorkset?: {
    state: SimulationState;
    initialActions: readonly AgentActionProposal[];
    availableActions: readonly AgentActionProposal[];
    availableDependencies: readonly InteractionDependency[];
  };
  resolutionScope?: ResolutionScope;
  /** Decisions already settled by the step preparation owner before component resolution. */
  completedReactionDecisions?: readonly ReactionDecision[];
  /** Own the canonical stream only through the closed random-commitment stage. */
  orderedRandom?: {
    acquire: () => Promise<SimulationState["truth"]["rng"]>;
    finish: (rng: SimulationState["truth"]["rng"]) => Promise<SimulationState["truth"]["rng"]>;
  };
  renderObservations: (
    proposal: Readonly<TransitionProposal>,
    actions: readonly AgentActionProposal[],
    transitionAttempt: number,
    observerIds?: readonly string[],
  ) => Promise<ObservationResolution>;
  validateProposal: (
    proposal: TransitionProposal,
    checks: readonly D20CheckResult[],
    randomResults: readonly DiscreteRandomResult[],
    actions: readonly AgentActionProposal[],
    stimulusObservations: readonly ObservationPacket[],
  ) => void;
}

export type TruthPreparationInput = Omit<TruthResolutionInput, "renderObservations" | "validateProposal">;

export interface TruthResolutionCapability {
  readonly candidateRepairLimit: number;
  resolve(input: TruthResolutionInput, scope: ModelExecutionScope): Promise<TruthResolution>;
  prepare(input: TruthPreparationInput, scope: ModelExecutionScope): TruthCandidateSession;
  reviewCandidate(evidence: CausalReviewEvidence, scope: ModelExecutionScope,
    subjectId: string, invocationOffset?: number): Promise<BoundCausalReview>;
}

export interface ObservationRenderingInput {
  definition: WorldDefinition;
  state: SimulationState;
  proposal: TransitionProposal;
  actions: readonly AgentActionProposal[];
  observerIds: readonly string[];
  identityOwner: string;
  temporalState?: Readonly<TemporalStateSnapshot>;
  feedbackByObserver?: Readonly<Record<string, readonly string[]>>;
}

export interface ObservationRenderingResult {
  packets: ObservationPacket[];
  modelAudits: ModelExecutionAudit[];
  batchCount: number;
}

export interface ObservationRenderingCapability {
  render(
    input: ObservationRenderingInput,
    scope: ModelExecutionScope,
  ): Promise<ObservationRenderingResult>;
}

export interface ConfiguredRoleAlgorithm<R extends AlgorithmRole = AlgorithmRole>
  extends AlgorithmImplementation<R> {
  readonly config: JsonObject;
  readonly children: Readonly<Record<string, ResolvedAlgorithm>>;
}

export interface AgentCognitionRoleAlgorithm extends ConfiguredRoleAlgorithm<"agent-cognition"> {
  create(provider: StructuredModelProvider, recovery: Readonly<OutputRecoveryCapability>): AgentCognitionCapability;
}

export interface ActionCompilationRoleAlgorithm extends ConfiguredRoleAlgorithm<"action-compilation"> {
  readonly compile: ActionCompilationCapability;
}

export interface CandidateSelectionRoleAlgorithm extends ConfiguredRoleAlgorithm<"candidate-selection"> {
  readonly runtime: CandidateSelectionCapability | undefined;
}

export interface CandidateRankingRoleAlgorithm extends ConfiguredRoleAlgorithm<"candidate-ranking"> {
  readonly rankingVersion: "typed-channel-rrf-v1";
}

export interface CandidateAllocationRoleAlgorithm extends ConfiguredRoleAlgorithm<"candidate-allocation"> {
  readonly allocationVersion: "coverage-aware-joint-budget-v1";
}

export interface WorkBatchingRoleAlgorithm extends ConfiguredRoleAlgorithm<"work-batching"> {
  readonly maxSlots: number;
}

export interface WorkSchedulingRoleAlgorithm extends ConfiguredRoleAlgorithm<"work-scheduling"> {
  readonly maxConcurrent: number;
}

export interface OutputRecoveryRoleAlgorithm extends ConfiguredRoleAlgorithm<"output-recovery"> {
  readonly policy: Readonly<OutputRecoveryCapability>;
}

export interface SymbolRepairRoleAlgorithm extends ConfiguredRoleAlgorithm<"symbol-repair"> {
  readonly policy: Readonly<SymbolRepairPolicy>;
}

export interface InteractionGroundingRoleAlgorithm extends ConfiguredRoleAlgorithm<"interaction-grounding"> {
  readonly ground: InteractionGroundingCapability;
}

export interface OnsetPerceptionRoleAlgorithm extends ConfiguredRoleAlgorithm<"onset-perception"> {
  create(
    provider: StructuredModelProvider,
    rulePackages: RulePackageRegistry,
    recovery: Readonly<OutputRecoveryCapability>,
  ): OnsetPerceptionCapability;
}

export interface ReactionDecisionRoleAlgorithm extends ConfiguredRoleAlgorithm<"reaction-decision"> {
  create(provider: StructuredModelProvider, recovery: Readonly<OutputRecoveryCapability>): ReactionDecisionCapability;
}

export interface TruthResolutionRoleAlgorithm extends ConfiguredRoleAlgorithm<"truth-resolution"> {
  create(
    provider: StructuredModelProvider,
    rulePackages: RulePackageRegistry,
    recovery: Readonly<OutputRecoveryCapability>,
  ): TruthResolutionCapability;
}

export interface ObservationRenderingRoleAlgorithm extends ConfiguredRoleAlgorithm<"observation-rendering"> {
  create(
    provider: StructuredModelProvider,
    recovery: Readonly<OutputRecoveryCapability>,
  ): ObservationRenderingCapability;
}
