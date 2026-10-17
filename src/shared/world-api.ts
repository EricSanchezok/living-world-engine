import type { AgentPerspectiveView } from "../engine/contracts/model";
export type { AgentPerspectiveView, BeliefValue, PerspectiveFactValue } from "../engine/contracts/model";

export const WORLD_API_VERSION = 18 as const;

/** Live work only; stage transitions never imply a committed outcome or a percentage. */
export interface PublicWorldProgress {
  stage: "preparing" | "interpreting" | "resolving" | "reacting" | "settling" | "checking" | "saving" |
    "reply-pending" | "composing" | "verifying" | "revising";
  startedAt: string;
}

export interface PublicModelServicePause {
  code: "request-limit" | "spending-limit" | "token-limit" | "usage-unresolved";
  message: string;
  retry: "after-service-change";
}

export interface WorldSummary {
  id: string;
  name: string;
  version: string;
  contentHash: string;
  description: string;
  participation: "headless" | "open";
}

export interface PublicWorldEvent {
  id: string;
  step: number;
  description: string;
  impact: "ordinary" | "significant" | "transformative";
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

export interface PublicInstanceSummary {
  id: string;
  worldId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
  step: number;
  elapsedSeconds: number;
  participantCount: number;
  schedulerMode: "paused" | "realtime";
  debugSteppingEnabled: boolean;
  runStatus?: WorldRunStatus;
}

export interface PublicWorldRun {
  id: string;
  generation: number;
  /** Last control-plane transition; used to freeze presentation timers while waiting. */
  updatedAt: string;
  status: WorldRunStatus;
  committedRevisions: number[];
  stopReason: string | null;
  lease: null | {
    commitCount: number;
    maxCommits: number;
    maxWallTimeMs: number;
    startedAt: string;
    suspendedDurationMs: number;
  };
  activity: null | {
    id: string;
    status: "active" | "paused" | "completed" | "blocked" | "failed" | "cancelled" | "queued" | "ready";
    description: string;
    stage: string | null;
    progress: { current: number; target: number; unit: string } | null;
    nextBoundaryAtSeconds: number | null;
    completionAtSeconds: number | null;
    queuePosition: number | null;
    resourceNames: string[];
  };
  debug: {
    mode: "off" | "step";
    boundaryIndex: number;
    stageIndex: number;
    stageCount: number;
    stageKey: string | null;
    stageLabel: string | null;
    checkpointId: string | null;
    canAdvance: boolean;
  };
}

export interface PublicActionWindow {
  kind: "decision" | "reaction";
  id: string;
  generation: number;
  baseRevision: number;
  requiredAgentIds: string[];
  submittedAgentIds: string[];
  deadlineAt: string | null;
  status: "open" | "resolving";
  reaction?: {
    requestId: string;
    preparedStepId: string;
    stimulus: string;
  };
}

export interface ParticipantSummary {
  id: string;
  displayName: string;
  agentId: string;
  status: "active" | "released";
  joinedAt: string;
}

export interface OriginView {
  id: string;
  title: string;
  fantasy: string;
  description: string;
  location: string;
  relationshipHooks: string[];
  risks: string[];
  image?: { hash: string; alt: string };
}

export interface WorldStartOptions {
  world: WorldSummary;
  origins: OriginView[];
  observerAvailable: true;
}

export interface PublicConversationTurn {
  id: string;
  agentId: string;
  baseRevision: number;
  createdAt: string;
  status: "awaiting" | "running" | "paused" | "committed" | "failed";
  servicePause?: PublicModelServicePause;
  action?: {
    submissionId: string;
    text: string;
  };
  response?: {
    id?: string;
    narrativeStatus?: "queued" | "generating" | "complete" | "fallback";
    segmentCount?: number;
    sourceRevisions?: number[];
    revision: number;
    step: number;
    title?: string;
    text: string;
    generated?: boolean;
    worldTimeSeconds?: number;
    activity?: PublicWorldRun["activity"];
  };
  responses?: Array<NonNullable<PublicConversationTurn["response"]>>;
}

export interface PublicActionSuggestions {
  sourceId: string;
  requestId: string | null;
  status: "idle" | "generating" | "ready" | "failed";
  items: string[];
}

export interface RequestSuggestionsInput {
  sourceId: string;
  requestId: string;
  expectedRequestId: string | null;
}

export interface PublicConversation {
  participantId: string;
  agentId: string;
  turns: PublicConversationTurn[];
  suggestions: PublicActionSuggestions | null;
}

export interface PublicInstanceDetail {
  progress: PublicWorldProgress | null;
  summary: PublicInstanceSummary;
  world: WorldSummary;
  publicEvents: PublicWorldEvent[];
  participants: ParticipantSummary[];
  actionWindow: PublicActionWindow | null;
  origins: OriginView[];
  controlledView?: AgentPerspectiveView;
  conversation?: PublicConversation;
  run?: PublicWorldRun;
  servicePause?: PublicModelServicePause;
}

export interface WorldRunControlInput {
  runId: string;
  generation: number;
}

export interface DebugModeInput {
  enabled: boolean;
  expectedRevision: number;
}

export interface DebugNextInput {
  runId: string;
  generation: number;
  checkpointId: string;
  requestId: string;
}

export type SubmitExternalReactionInput =
  | {
      submissionId: string;
      windowId: string;
      generation: number;
      preparedStepId: string;
      expectedRevision: number;
      kind: "keep";
    }
  | {
      submissionId: string;
      windowId: string;
      generation: number;
      preparedStepId: string;
      expectedRevision: number;
      kind: "replace";
      text: string;
    };

export type CreateInstanceInput = {
  worldId: string;
  title?: string;
  seed?: number;
  executionTuning?: {
    actionCompilationMaxSlots?: number;
    agentMindMaxSlots?: number;
    reactionMaxSlots?: number;
    groundingMaxSlots?: number;
    truthBatchMaxSlots?: number;
  };
  start: {
    kind: "origin";
    originId: string;
    displayName: string;
    appearance: string;
    motivation: string;
  } | { kind: "observer" };
};

export interface AdvanceWorldInput {
  expectedRevision: number;
  trigger: "manual" | "batch" | "realtime";
  steps?: number;
}

export interface ControlTransferInput {
  expectedRevision: number;
  target: { kind: "observer" } | { kind: "agent"; agentId: string };
}

export interface ControlCandidate {
  id: string;
  name: string;
  location: string | null;
}

export interface ControlOptions {
  agents: ControlCandidate[];
}

export interface SubmitExternalActionInput {
  submissionId: string;
  expectedRevision: number;
  text: string;
}

export interface ArrivalView {
  title: string;
  scene: string;
  generated: boolean;
}
