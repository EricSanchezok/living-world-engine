import type { ActionOutcome, AgentActionProposal, AgentState, BeliefPatch, CharacterPatch, DiscreteRandomRequest, DiscreteRandomResult, ModelExecutionAudit,
  ObservationPacket, SimulationState, WorldDeltaOperation, WorldEvent } from "../contracts/model";
import type { DecisionBatchV2, DecisionResultV2 } from "../models/decision-v2";
import type { AlgorithmRef } from "../runtime/execution";
import type { JsonValue } from "../runtime/json";

export type ActionKind = "move" | "observe" | "speak" | "transfer" | "use" | "change" | "wait";
export interface ActionFrame {
  version: 1; id: string; actorId: string; actorEntityId: string; submissionId: string | null;
  proposal: AgentActionProposal; kind: ActionKind; goalId: string | null;
  targetEntityId: string | null; toolEntityId: string | null; quantityDefinitionId: string | null;
  amount: number | null; utterance: string | null; capabilityId: string | null;
  startedAtSeconds: number; dueAtSeconds: number | null; temporalProfileId: string | null;
  durationSeconds: number; progressSeconds: number; activityStatus: "active" | "queued" | "paused";
  inputHash: string; causeActionId: string | null;
  preparatoryFor: ActionKind | null;
}
export interface AgentIntentState {
  goalId: string | null;
  status: "ready" | "active" | "waiting" | "failed";
  wakeReasons: string[];
  causeActionId: string | null;
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
  failure: { inputHash: string; message: string; recoverable: true } | null;
}
export interface DirectDecisionUse { batch: DecisionBatchV2; result: DecisionResultV2; reused: boolean }
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
  | { kind: "object"; name: string; description: string; placement: "actor" | "target" };
/** A semantic decision saved before execution. No generated control flow or proof tree. */
export interface PreparedDirectAction {
  actionId: string; reads: Record<string, string>; status: ActionOutcome["status"]; summary: string;
  operations: WorldDeltaOperation[]; visibleFactIds: string[]; visibleEntityIds: string[]; deliveredToEntityIds: string[];
  randomRequests: DiscreteRandomRequest[];
  randomBindings: Array<{ factId: string; requestId: string; stepId: string }>;
  sharedClaims: Array<{ poolId: string; amount: number }>;
  ongoing: boolean;
  requestProgress: "complete" | "continue" | "wait";
}
export interface DirectRuntimeState {
  kind: "direct-world"; version: 1; hash: string; worldHash: string; modelCatalogHash: string; registryHash: string;
  models: { decision: string; creation: string; fallback: string };
  modelOverrides: { decision: string | null; creation: string | null; fallback: string | null };
  intents: Record<string, AgentIntentState>;
  activities: ActionFrame[];
  prepared: Record<string, PreparedDirectAction>;
  capabilities: CapabilityDefinition[];
  cache: Array<{ key: string; result: DecisionResultV2 }>;
  dependencies: Record<string, { version: number; hash: string }>;
  completedSubmissionIds: string[];
}
export interface DirectBootstrap {
  version: 1; producer: AlgorithmRef; authorityHash: string; control: DirectRuntimeState;
  modelCatalog: import("../models/model-catalog").ModelCatalogDocument;
}
export interface DirectStepRecord {
  version: 1; id: string; baseRevision: number; producerHash: string; authorityHash: string;
  reads: Record<string, string>; atSeconds: number;
  frames: ActionFrame[]; completedActionIds: string[];
  control: DirectRuntimeState;
  operations: WorldDeltaOperation[]; events: WorldEvent[]; outcomes: ActionOutcome[];
  observations: ObservationPacket[]; beliefPatches: BeliefPatch[]; characterPatches: CharacterPatch[];
  cognition: DirectCognitiveUpdate[];
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
