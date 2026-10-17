import type { ActionOutcome, AgentActionProposal, AgentState, BeliefPatch, CharacterPatch, DiscreteRandomRequest, DiscreteRandomResult, ModelExecutionAudit,
  ObservationPacket, SimulationState, WorldDeltaOperation, WorldEvent } from "../contracts/model";
import type { DecisionBatchV2, DecisionResultV2 } from "../models/decision-v2";
import type { AlgorithmRef } from "../runtime/execution";
import type { JsonValue } from "../runtime/json";
import type { ModelServicePause } from "../models/service-failure";

export type ActionKind = "move" | "observe" | "reflect" | "speak" | "transfer" | "use" | "change" | "wait";
export interface ActionExpression {
  attempt: string;
  utterance: string | null;
  manner: string | null;
}
export interface ActionFrame {
  version: 1; id: string; actorId: string; actorEntityId: string; submissionId: string | null;
  expression?: ActionExpression;
  /** Conditional branch answer from the player-language interpretation batch. */
  requestContinuation?: "complete" | "continue" | "wait";
  proposal: AgentActionProposal; kind: ActionKind; goalId: string | null;
  targetEntityId: string | null; toolEntityId: string | null; quantityDefinitionId: string | null;
  amount: number | null; utterance: string | null; capabilityId: string | null;
  startedAtSeconds: number; dueAtSeconds: number | null; temporalProfileId: string | null;
  /** Zero with a null deadline is unresolved and cannot enter the timeline. */
  durationSeconds: number; durationSource: "explicit" | "profile" | "judgment";
  progressSeconds: number; activityStatus: "active" | "queued" | "paused";
  interruptCondition: string | null;
  interruptedByEventIds?: string[];
  inputHash: string; causeActionId: string | null;
  preparatoryFor: ActionKind | null;
  observationScope: "target" | "surroundings" | "inventory";
}
export interface AgentIntentState {
  goalId: string | null;
  status: "ready" | "active" | "waiting" | "failed";
  wakeReasons: string[];
  causeActionId: string | null;
  /** Delivered interactions retained while another cause owns the current work. */
  pendingCauseActionIds: string[];
  activityId: string | null;
  wait: { entityIds: string[]; untilSeconds: number | null; reason: string } | null;
  lastInputHash: string | null;
  lastActionHash: string | null;
  recentOutcomeIds: string[];
  urgency: number;
  noProgressCount: number;
  goalProgress: Record<string, "partial" | "completed" | "unchanged" | "unknown">;
  dependencies: Record<string, string>;
  activeSubmission: import("../runtime/execution").ExternalActionInput | null;
  failure: { inputHash: string; message: string; recoverable: true; atRevision: number; servicePause: ModelServicePause | null } | null;
}
export type SavedDecisionResult = Omit<DecisionResultV2, "audits">;
export interface DirectDecisionUse { batch: DecisionBatchV2; result: SavedDecisionResult; reused: boolean }
export interface CapabilityDefinition {
  id: string; description: string; kind: ActionKind; scope: "world" | "private";
  ownerId: string | null; applicability: string; effectDescription: string; sourceIds: string[];
  createdByActionId: string; version: 1;
  effects: CapabilityEffect[];
  knownToAgentIds: string[];
}
export type CapabilityEffect =
  | { kind: "fact"; subject: "actor" | "target" | "tool"; predicate: string; value: string | boolean; description: string }
  | { kind: "condition"; subject: "actor" | "target" | "tool"; profileId: string }
  | { kind: "placement"; subject: "actor" | "target" | "tool"; destination: "actor" | "target" | "scene" }
  | { kind: "object"; name: string; description: string; placement: "actor" | "target" };
/** A semantic decision saved before execution. No generated control flow or proof tree. */
export interface PreparedDirectAction {
  actionId: string; reads: Record<string, string>; status: ActionOutcome["status"]; summary: string;
  operations: WorldDeltaOperation[]; visibleFactIds: string[]; visibleEntityIds: string[]; deliveredToEntityIds: string[];
  /** Perception is bound to the value that actually survives settlement. */
  propertyVisibility: Array<{ factId: string; previousValueHash: string; proposedValueHash: string; previousVisible: boolean; proposedVisible: boolean }>;
  inspectedQuantityIds: string[];
  actorOnlyFactIds: string[]; actorOnlyEntityIds: string[];
  namedEntityIds: string[];
  /** Recipients who can see the actor, independently of hearing the utterance. */
  actorVisibleToEntityIds?: string[];
  randomRequests: DiscreteRandomRequest[];
  randomBindings: Array<{ factId: string; requestId: string; stepId: string }>;
  sharedClaims: Array<{ poolId: string; amount: number }>;
  ongoing: boolean;
  requestProgress: "complete" | "continue" | "wait";
  interruptActivityIds: string[];
  interruptionCandidateIds: string[];
}
export interface DirectRuntimeState {
  kind: "direct-world"; version: 4; hash: string; worldHash: string; modelCatalogHash: string; registryHash: string;
  models: { decision: string; creation: string; fallback: string };
  modelOverrides: { decision: string | null; creation: string | null; fallback: string | null };
  intents: Record<string, AgentIntentState>;
  activities: ActionFrame[];
  prepared: Record<string, PreparedDirectAction>;
  capabilities: CapabilityDefinition[];
  cache: Record<string, SavedDecisionResult>;
  dependencies: Record<string, { version: number; hash: string }>;
  completedSubmissionIds: string[];
}
export interface DirectBootstrap {
  version: 2; producer: AlgorithmRef; authorityHash: string; control: DirectRuntimeState;
  modelCatalog: import("../models/model-catalog").ModelCatalogDocument;
}
export interface DirectStepRecord {
  version: 2; id: string; baseRevision: number; producerHash: string; authorityHash: string;
  reads: Record<string, string>; fromSeconds: number; atSeconds: number;
  frames: ActionFrame[]; completedActionIds: string[];
  controlDelta: import("../runtime/json-delta").JsonDelta;
  operations: WorldDeltaOperation[]; events: WorldEvent[]; outcomes: ActionOutcome[];
  observations: ObservationPacket[]; beliefPatches: BeliefPatch[]; characterPatches: CharacterPatch[];
  cognition: DirectCognitiveUpdate[];
  presentation?: import("../contracts/discourse").PresentationReply[];
  decisions: DirectDecisionUse[]; modelAudits: ModelExecutionAudit[];
  rng: SimulationState["truth"]["rng"];
  randomRequests: DiscreteRandomRequest[]; randomResults: DiscreteRandomResult[];
  timerUpdates: SimulationState["truth"]["timers"];
}
export interface DirectCognitiveUpdate {
  agentId: string; decisionHash: string;
  goals: Record<string, "completed" | "partial" | "unchanged" | "unknown">;
  beliefs: Record<string, "supported" | "refuted" | "unresolved" | "unchanged">;
}
export interface DirectLocalView {
  state: JsonValue;
  reads: Record<string, string>;
  entities: Record<string, string>;
}
export type AgentStateMap = Record<string, AgentState>;

export interface DirectBootstrapCandidate {
  kind: "direct";
  sourceStateHash: string;
  bootstrap: DirectBootstrap;
  modelAudits: ModelExecutionAudit[];
}

export interface DirectStepPreparation {
  kind: "direct";
  id: string;
  sourceStateHash: string;
  algorithmManifestHash: string;
  policyRosterHash: string;
  requestHash: string;
  record: DirectStepRecord;
  activatedAgentIds: string[];
}

export interface DirectStepCandidate {
  kind: "direct";
  preparationId: string;
  sourceStateHash: string;
  record: DirectStepRecord;
  activatedAgentIds: string[];
}

export interface DirectExecutionAlgorithm {
  readonly protocol: "direct";
  readonly manifest: import("../runtime/execution").AlgorithmManifest;
  readonly rulePackages?: import("../mechanics/rule-package").RulePackageRegistry;
  bootstrap(input: Readonly<import("../runtime/execution").BootstrapInput>, context: import("../runtime/execution").ExecutionContext): Promise<DirectBootstrapCandidate>;
  prepareStep(input: Readonly<import("../runtime/execution").WorldStepInput>, context: import("../runtime/execution").ExecutionContext): Promise<DirectStepPreparation>;
  completeStep(input: Readonly<import("../runtime/execution").WorldStepInput>, preparation: Readonly<DirectStepPreparation>,
    reactions: readonly import("../runtime/execution").ExternalReactionInput[], context: import("../runtime/execution").ExecutionContext): Promise<DirectStepCandidate>;
}

/** Native receipt: common observable results are owned by the event exactly once. */
export interface DirectCommittedStep {
  directEvent: Omit<DirectStepRecord, "operations" | "events" | "outcomes" | "observations" | "beliefPatches" | "characterPatches" | "randomRequests" | "randomResults" | "rng" | "atSeconds" | "fromSeconds">;
  actions: AgentActionProposal[];
  operations: WorldDeltaOperation[];
  events: WorldEvent[];
  outcomes: ActionOutcome[];
  observations: ObservationPacket[];
  beliefPatches: BeliefPatch[];
  characterPatches: CharacterPatch[];
  randomRequests: DiscreteRandomRequest[];
  randomResults: DiscreteRandomResult[];
  rngBefore: SimulationState["truth"]["rng"];
  rngAfter: SimulationState["truth"]["rng"];
  temporalBoundary: import("../mechanics/temporal").TemporalBoundary;
  contentHash: string;
  semanticHash: string;
  executionRef?: import("../runtime/execution").ExecutionRef;
  baseRevision: number;
  revision: number;
  step: number;
}
