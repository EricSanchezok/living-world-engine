import type { ParticipantSuggestions } from "./suggestions";
import type { NarrativeBeat } from "./narrative/contracts";
import type { ModelServicePause } from "../engine/models/service-failure";
import type {
  AlgorithmRef,
  ExternalActionInput,
  ExternalReactionInput,
  ParticipantId,
  PolicyBinding,
  WorldAdvanceRequest,
} from "../engine/runtime/execution";
import type { AgentId, SimulationState } from "../engine/contracts/model";
import type { ReactionRequest } from "../engine/contracts/model";
import type { WorldRuntimeContract } from "../engine/runtime/world-definition";
import type { ExecutionStageKey } from "../engine/runtime/stages";
import type { ExperimentEnrollment } from "../engine/runtime/experiments";

export interface ParticipantRecord {
  id: ParticipantId;
  principalId: string;
  displayName: string;
  agentId: AgentId;
  status: "active" | "released";
  joinedAt: string;
  updatedAt: string;
  controlledSinceRevision: number;
  admissionExecutionId?: string;
  suppressedActionId?: string;
  arrival: ParticipantArrivalRecord;
  suggestions: ParticipantSuggestions | null;
}

export interface ParticipantArrivalRecord {
  id: string;
  revision: number;
  step: number;
  title: string;
  scene: string;
  generated: boolean;
  createdAt: string;
  knownEntities: Array<{ localEntityId: string; name: string; description: string }>;
  executionId?: string;
}

interface ActionWindowBase {
  id: string;
  generation: number;
  baseRevision: number;
  requiredAgentIds: AgentId[];
  deadlineAt: string | null;
  status: "open" | "resolving" | "committed" | "cancelled";
}

export interface DecisionActionWindow extends ActionWindowBase {
  kind: "decision";
  submissions: Record<AgentId, ExternalActionInput>;
}

export interface ReactionActionWindow extends ActionWindowBase {
  kind: "reaction";
  preparedStepId: string;
  preparationArtifactHash: string;
  preparationExecutionId: string;
  sourceStateHash: string;
  algorithmManifestHash: string;
  policyRosterHash: string;
  policyRoster: Record<AgentId, PolicyBinding>;
  advanceRequest: WorldAdvanceRequest;
  requests: Record<AgentId, ReactionRequest>;
  submissions: Record<AgentId, ExternalReactionInput>;
}

export type ActionWindow = DecisionActionWindow | ReactionActionWindow;

export interface InstanceRuntimeConfig {
  maxAutonomousSpanSeconds: number;
  realtimeIntervalMs: number;
  actionWindowMs: number;
  debugSteppingEnabled: boolean;
}

export interface SchedulerState {
  mode: "paused" | "realtime";
  generation: number;
  nextTickAt: string | null;
}

export type WorldRunStatus =
  | "queued"
  | "running"
  | "pausing"
  | "paused"
  | "debug-paused"
  | "awaiting-decision"
  | "awaiting-reaction"
  | "preparation-invalidated"
  | "completed"
  | "failed"
  | "budget-paused";

export interface WorldRunLease {
  id: string;
  generation: number;
  startedAt: string;
  maxCommits: number;
  maxWallTimeMs: number;
  commitCount: number;
  suspendedDurationMs?: number;
}

export interface WorldRunRecord {
  id: string;
  generation: number;
  trigger: "manual" | "batch" | "realtime" | "participant_action";
  status: WorldRunStatus;
  rootIntents: ExternalActionInput[];
  activityIds: string[];
  requestedBoundaryCount: number | null;
  createdAt: string;
  startedAtWorldSeconds: number;
  updatedAt: string;
  executionIds: string[];
  committedRevisions: number[];
  stopReason: string | null;
  lease: WorldRunLease | null;
  debugMode: "off" | "step";
  debugCheckpoint: {
    id: string;
    executionId: string;
    artifactHash: string;
    boundaryIndex: number;
    stageIndex: number;
    stageKey: ExecutionStageKey;
    updatedAt: string;
  } | null;
  lastDebugRequestId: string | null;
  error?: string;
  servicePause?: ModelServicePause;
}

export interface ParticipantIntentRecord {
  participantId: ParticipantId;
  agentId: AgentId;
  runId: string;
  submissionId: string;
  revision: number;
  text: string;
  submittedAt: string;
}

export interface ParticipantReactionRecord {
  participantId: ParticipantId;
  agentId: AgentId;
  runId: string;
  preparedStepId: string;
  requestId: string;
  submissionId: string;
  kind: "keep" | "replace";
  text: string | null;
  submittedAt: string;
}

export interface WorldInstanceDocument {
  schemaVersion: 29;
  id: string;
  world: WorldRuntimeContract;
  executionAlgorithm: AlgorithmRef;
  experimentEnrollment: ExperimentEnrollment | null;
  experimentExclusion: {
    reason: "explicit-execution-tuning" | "no-active-experiment" | "world-ineligible" | "experiment-stopped";
    detail: string | null;
  } | null;
  title: string;
  createdAt: string;
  updatedAt: string;
  state: SimulationState;
  participants: Record<ParticipantId, ParticipantRecord>;
  policyBindings: Record<AgentId, PolicyBinding>;
  actionWindow: ActionWindow | null;
  runtime: InstanceRuntimeConfig;
  scheduler: SchedulerState;
  runs: Record<string, WorldRunRecord>;
  narratives: NarrativeBeat[];
  participantIntents: ParticipantIntentRecord[];
  reactionSubmissions: ParticipantReactionRecord[];
}

export interface StoredWorldInstance {
  generation: number;
  document: WorldInstanceDocument;
}
