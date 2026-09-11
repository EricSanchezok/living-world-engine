import type {
  ModelAccountChannel,
  ModelInferenceConfig,
  ModelProtocol,
  ModelSelector,
  ResolvedModelInference,
} from "../models/model-catalog";
import type {
  AdjudicationCalibration,
  ConditionProfileDefinition,
  ConditionState,
  DurationProfileDefinition,
  EntityMechanicsProfileDefinition,
  ImpactProfileDefinition,
  ResolutionPlan,
  ResolutionReceipt,
} from "../mechanics/resolution";
import type {
  ActivityResourceDefinition,
  ActivityState,
  ActivityTransition,
  DecisionPoint,
  TemporalBoundary,
  TemporalCalibration,
  TemporalPlan,
  TemporalProfileDefinition,
  WorldTimer,
} from "../mechanics/temporal";
import type {
  SharedActivityResourceDefinition,
  SharedActivityResourcePool,
} from "../mechanics/shared-activity-resources";
import { ACTION_COMPILATION_PROJECTION } from "./model-context";
import type { ExistingReferenceHandle } from "./model-context";
import type { SymbolRepairDomain, SymbolRepairResult } from "./symbol-repair";

export type EntityId = string;
export type AgentId = string;
export type LocalEntityId = string;
export type FactId = string;
export type EventId = string;

export type FactValue =
  | { kind: "text"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "entity"; entityId: EntityId }
  | { kind: "none" };

export type BeliefValue =
  | Exclude<FactValue, { kind: "entity" }>
  | { kind: "local_entity"; localEntityId: LocalEntityId };

export interface CausalRef {
  kind: "action" | "check" | "random" | "event" | "fact" | "law" | "mechanic";
  id: string;
}

export type NumericComparison = "eq" | "ne" | "lt" | "lte" | "gt" | "gte";

export type CausalAssertion =
  | { kind: "check_result"; checkId: string; expected: "succeeded" | "failed" }
  | {
      kind: "random_result";
      requestId: string;
      stepId: string;
      expected: DiscreteRandomAggregate;
    }
  | { kind: "fact_matches"; factId: FactId; expected: FactValue }
  | { kind: "fact_absent"; factId: FactId }
  | { kind: "entity_absent"; entityId: EntityId }
  | { kind: "entity_lifecycle"; entityId: EntityId; expected: WorldEntity["lifecycle"] }
  | { kind: "placement_equals"; entityId: EntityId; placementId: EntityId | null }
  | { kind: "placement_not_equals"; entityId: EntityId; placementId: EntityId | null }
  | { kind: "shared_placement"; leftEntityId: EntityId; rightEntityId: EntityId }
  | { kind: "meter_compare"; meterId: string; operator: NumericComparison; value: number }
  | {
      kind: "quantity_compare";
      definitionId: string;
      holderId: EntityId;
      operator: NumericComparison;
      value: number;
    }
  | { kind: "rating_compare"; ratingId: string; operator: NumericComparison; value: number }
  | { kind: "shared_resource_capacity_compare"; poolId: string; operator: NumericComparison; value: number }
  | { kind: "elapsed_seconds_compare"; operator: NumericComparison; value: number };

export interface CausalSource {
  causes: CausalRef[];
  assertions: CausalAssertion[];
}

export type FactProvenanceRef = CausalRef | {
  kind: "world_seed";
  id: string;
};

export interface WorldEntity {
  id: EntityId;
  kind: string;
  name: string;
  description: string;
  lifecycle: "active" | "retired";
  createdAtStep: number;
}

export interface WorldFact {
  id: FactId;
  subjectId: EntityId;
  predicate: string;
  value: FactValue;
  description: string;
  access:
    | { kind: "public" }
    | { kind: "private" }
    | { kind: "agents"; agentIds: AgentId[] };
  provenance: FactProvenanceRef[];
}

export interface MeterDefinition {
  id: string;
  name: string;
  min: number;
  max: number;
  thresholds: MeterThreshold[];
}

export interface MeterThreshold {
  id: string;
  when: { operator: "lte" | "gte"; value: number };
  effects: ThresholdEffect[];
}

export type ThresholdEffect =
  | { kind: "set_lifecycle"; lifecycle: WorldEntity["lifecycle"] }
  | {
      kind: "set_fact";
      predicate: string;
      value: FactValue;
      description: string;
      access?: WorldFact["access"];
    };

export interface QuantityDefinition {
  id: string;
  name: string;
  unit: string;
  productionLawIds: string[];
  consumptionLawIds: string[];
}

export interface RatingDefinition {
  id: string;
  name: string;
  min: number;
  max: number;
}

export interface MechanicsCatalog {
  meters: Record<string, MeterDefinition>;
  quantities: Record<string, QuantityDefinition>;
  ratings: Record<string, RatingDefinition>;
  impactProfiles: Record<string, ImpactProfileDefinition>;
  durationProfiles: Record<string, DurationProfileDefinition>;
  conditionProfiles: Record<string, ConditionProfileDefinition>;
  entityMechanicsProfiles: Record<string, EntityMechanicsProfileDefinition>;
  adjudicationCalibrations: AdjudicationCalibration[];
  activityResources: Record<string, ActivityResourceDefinition>;
  sharedActivityResources: Record<string, SharedActivityResourceDefinition>;
  temporalProfiles: Record<string, TemporalProfileDefinition>;
  temporalCalibrations: TemporalCalibration[];
}

export type DiscreteRandomValue = string | number | boolean | null;
export type DiscreteRandomAggregate = DiscreteRandomValue | DiscreteRandomValue[];

export interface DiscreteRandomStepDefinition {
  id: string;
  count: number;
  outcomes: DiscreteRandomValue[];
  aggregate: "first" | "sum" | "values";
  when: {
    stepId: string;
    equals: DiscreteRandomValue;
  } | null;
}

export interface DiscreteRandomDefinition {
  id: string;
  description: string;
  steps: DiscreteRandomStepDefinition[];
}

export interface MeterState {
  id: string;
  definitionId: string;
  entityId: EntityId;
  current: number;
  firedThresholdIds: string[];
}

export interface QuantityState {
  id: string;
  definitionId: string;
  holderId: EntityId;
  amount: number;
}

export interface RatingState {
  id: string;
  definitionId: string;
  entityId: EntityId;
  value: number;
}

export interface CanonicalWorldState {
  elapsedSeconds: number;
  rng: SeededRngState;
  events: WorldEvent[];
  entities: Record<EntityId, WorldEntity>;
  placements: Record<EntityId, EntityId | null>;
  facts: Record<FactId, WorldFact>;
  factTombstones: FactId[];
  mechanics: MechanicsCatalog;
  meters: Record<string, MeterState>;
  quantities: Record<string, QuantityState>;
  ratings: Record<string, RatingState>;
  conditions: Record<string, ConditionState>;
  activities: Record<string, ActivityState>;
  sharedActivityResourcePools: Record<string, SharedActivityResourcePool>;
  timers: Record<string, WorldTimer>;
}

export interface HistoryReplayBase {
  truth: CanonicalWorldState;
  agents: Record<AgentId, AgentState>;
}

export interface LocalEntity {
  id: LocalEntityId;
  name: string;
  description: string;
  status: "observed" | "reported" | "hypothesized";
}

export interface BeliefEvidence {
  id: string;
  kind: "observation" | "testimony" | "inference" | "assumption";
  description: string;
  sourceId: string | null;
  step: number;
}

export type BeliefEvidenceDraft = Omit<BeliefEvidence, "step">;

export interface BeliefClaim {
  id: string;
  subjectId: LocalEntityId;
  predicate: string;
  value: BeliefValue;
  description: string;
  stance: "believed" | "suspected" | "disbelieved";
  confidence: number;
  evidenceIds: string[];
}

export interface AgentBeliefState {
  localEntities: Record<LocalEntityId, LocalEntity>;
  claims: Record<string, BeliefClaim>;
  evidence: Record<string, BeliefEvidence>;
}

export type CharacterImpact = "ordinary" | "significant" | "transformative";

export interface CharacterFacet {
  id: string;
  description: string;
  strength: number;
  status: "active" | "retired";
  createdAtStep: number;
  updatedAtStep: number;
  evidenceIds: string[];
}

export interface EmotionState {
  id: string;
  description: string;
  intensity: number;
  status: "active" | "resolved";
  createdAtStep: number;
  updatedAtStep: number;
  evidenceIds: string[];
}

export interface AttitudeState {
  id: string;
  subjectId: LocalEntityId;
  description: string;
  intensity: number;
  status: "active" | "retired";
  createdAtStep: number;
  updatedAtStep: number;
  evidenceIds: string[];
}

export interface AgentGoal {
  id: string;
  description: string;
  priority: number;
  progress: number;
  targetIds: LocalEntityId[];
  parentGoalId?: string;
  motivatedByIds: string[];
  status: "active" | "suspended" | "completed" | "failed" | "abandoned";
  createdAtStep: number;
  updatedAtStep: number;
  evidenceIds: string[];
}

export interface AgentCommitment {
  id: string;
  description: string;
  priority: number;
  subjectIds: LocalEntityId[];
  status: "active" | "fulfilled" | "broken" | "released";
  createdAtStep: number;
  updatedAtStep: number;
  evidenceIds: string[];
}

export interface AgentCharacterState {
  persona: {
    summary: string;
    voice: string;
    updatedAtStep: number;
    evidenceIds: string[];
  };
  traits: Record<string, CharacterFacet>;
  values: Record<string, CharacterFacet>;
  emotions: Record<string, EmotionState>;
  attitudes: Record<string, AttitudeState>;
  goals: Record<string, AgentGoal>;
  commitments: Record<string, AgentCommitment>;
}

export type CharacterFacetDraft = Omit<CharacterFacet, "createdAtStep" | "updatedAtStep">;
export type EmotionStateDraft = Omit<EmotionState, "createdAtStep" | "updatedAtStep">;
export type AttitudeStateDraft = Omit<AttitudeState, "createdAtStep" | "updatedAtStep">;
export type AgentGoalDraft = Omit<AgentGoal, "createdAtStep" | "updatedAtStep">;
export type AgentCommitmentDraft = Omit<AgentCommitment, "createdAtStep" | "updatedAtStep">;

export interface AgentCharacterStateDraft {
  persona: Omit<AgentCharacterState["persona"], "updatedAtStep">;
  traits: Record<string, CharacterFacetDraft>;
  values: Record<string, CharacterFacetDraft>;
  emotions: Record<string, EmotionStateDraft>;
  attitudes: Record<string, AttitudeStateDraft>;
  goals: Record<string, AgentGoalDraft>;
  commitments: Record<string, AgentCommitmentDraft>;
}

export interface AgentBeliefStateDraft extends Omit<AgentBeliefState, "evidence"> {
  evidence: Record<string, BeliefEvidenceDraft>;
}

export interface EpistemicBinding {
  localEntityId: LocalEntityId;
  canonicalEntityIds: EntityId[];
}

export interface AgentActionProposal {
  id: string;
  actorId: AgentId;
  baseRevision: number;
  rawText: string;
  goal: string;
  means: string | null;
  targetIds: LocalEntityId[];
}

export type AgentActionDraft = Pick<
  AgentActionProposal,
  "rawText" | "goal" | "means"
> & { targetHandles: ExistingReferenceHandle[] };

export interface AgentState {
  id: AgentId;
  entityId: EntityId;
  modelProfiles: {
    bootstrap: string;
    mind: string;
    reaction: string;
  };
  character: AgentCharacterState;
  belief: AgentBeliefState;
  bindings: Record<LocalEntityId, EpistemicBinding>;
  observationCursorStep: number;
  nextAction: AgentActionProposal | null;
}

export interface AgentStateDraft {
  id: AgentId;
  entityId: EntityId;
  character: AgentCharacterStateDraft;
  belief: AgentBeliefStateDraft;
  bindings: Record<LocalEntityId, EpistemicBinding>;
}

export interface AgentResolutionEffectView {
  role: "primary" | "secondary" | "consequence";
  kind: "meter" | "condition";
  magnitude: import("../mechanics/resolution").MagnitudeBand;
  channel: string;
  label: string;
  description: string;
}

export type AgentResolutionReceiptView = {
  visibility: "result_only";
  outcome: import("../mechanics/resolution").OutcomeGrade | null;
  effects: AgentResolutionEffectView[];
} | {
  visibility: "full";
  outcome: import("../mechanics/resolution").OutcomeGrade | null;
  effects: AgentResolutionEffectView[];
  plan: {
    goal: string;
    means: string[];
    mode: import("../mechanics/resolution").ResolutionMode;
    difficulty: { kind: "environment"; band: import("../mechanics/resolution").DifficultyBand } |
      { kind: "opposed" } | null;
    actorRating: { name: string; value: number } | null;
    factors: Array<{
      role: import("../mechanics/resolution").FactorRole;
      direction: import("../mechanics/resolution").FactorDirection;
      steps: 0 | 1 | 2;
      explanation: string;
    }>;
    risk: import("../mechanics/resolution").RiskBand;
    baseEffect: import("../mechanics/resolution").MagnitudeBand;
  };
  check: {
    dc: number | null;
    modifier: number | null;
    mode: "normal" | "advantage" | "disadvantage" | null;
    dice: number[];
    kept: number | null;
    total: number | null;
    margin: number | null;
  };
};

export interface PerspectiveEntity {
  ref: string;
  localEntityId?: LocalEntityId;
  name: string;
  description: string;
  status: LocalEntity["status"] | "authorized" | "unidentified";
  targetable: boolean;
}

export interface PerspectiveContainment {
  entityRef: string;
  containerRef: string;
  depth: number;
  viaUnknownContainer: boolean;
}

export type PerspectiveFactValue =
  | Exclude<FactValue, { kind: "entity" }>
  | { kind: "entity"; entityRef: string };

export interface PerspectiveFact {
  subjectRef: string;
  predicate: string;
  value: PerspectiveFactValue;
  description: string;
}

export interface PerspectiveMeter {
  name: string;
  current: number;
  min: number;
  max: number;
}

export interface PerspectiveQuantity {
  name: string;
  unit: string;
  amount: number;
}

export interface PerspectiveRating {
  name: string;
  value: number;
  min: number;
  max: number;
}

export interface AgentPerspectiveTurn {
  revision: number;
  step: number;
  ownAction: string | null;
  perceivedOutcome: ActionOutcome["status"] | null;
  observations: AgentPerspectiveObservation[];
  resolutions: AgentResolutionReceiptView[];
}

export interface AgentPerspectiveObservation {
  kind: ObservationPacket["kind"];
  summary: string;
  introductions: LocalEntity[];
  apparentClaims: ApparentClaim[];
}

export interface AgentPerspectiveView {
  agentId: AgentId;
  revision: number;
  step: number;
  elapsedSeconds: number;
  self: {
    localEntityId: LocalEntityId;
    name: string;
    description: string;
    lifecycle: WorldEntity["lifecycle"];
    location: {
      localEntityId?: LocalEntityId;
      name: string;
      description: string;
    } | null;
  };
  mechanics: {
    meters: PerspectiveMeter[];
    quantities: PerspectiveQuantity[];
    ratings: PerspectiveRating[];
    conditions: Array<{
      label: string;
      description: string;
      magnitude: import("../mechanics/resolution").MagnitudeBand;
      duration: string;
    }>;
  };
  knowledge: {
    entities: PerspectiveEntity[];
    containment: PerspectiveContainment[];
    exactFacts: PerspectiveFact[];
    claims: BeliefClaim[];
    evidence: BeliefEvidence[];
  };
  character: AgentCharacterState;
  history: AgentPerspectiveTurn[];
}

export interface AgentMindCommit {
  agentId: AgentId;
  beliefPatch: BeliefPatch;
  characterPatch: CharacterPatch;
  nextAction: AgentActionProposal;
}

export interface SeededRngState {
  seed: number;
  state: number;
  draws: number;
}

export interface WorldEvent {
  id: EventId;
  step: number;
  description: string;
  impact: CharacterImpact;
  causes: CausalRef[];
  assertions: CausalAssertion[];
}

export interface AgentAdmissionCommit {
  contentHash: string;
  semanticHash: string;
  executionRef?: import("../runtime/execution").ExecutionRef;
  baseRevision: number;
  revision: number;
  step: number;
  entity: WorldEntity;
  placementId: EntityId | null;
  agent: AgentState;
  meters: MeterState[];
  quantities: QuantityState[];
  ratings: RatingState[];
  conditions: ConditionState[];
  invalidatedActionIds: string[];
  reusedActions: AgentActionProposal[];
}

export type WorldEventDraft = Omit<WorldEvent, "step">;

export interface SimulationState {
  schemaVersion: 15;
  worldId: string;
  worldHash: string;
  lawIds: string[];
  revision: number;
  step: number;
  truth: CanonicalWorldState;
  agents: Record<AgentId, AgentState>;
  admissions: AgentAdmissionCommit[];
  history: CommittedStep[];
  historyBase?: HistoryReplayBase;
  bootstrapAgentCommits: AgentMindCommit[];
  bootstrapExecutionRef?: import("../runtime/execution").ExecutionRef;
}

export type CheckVisibility = "full" | "result_only" | "hidden";

export interface D20CheckRequest {
  id: string;
  actorId: EntityId;
  targetId: EntityId | null;
  ratingId: string | null;
  modifier: number;
  modifierSources: ModifierSource[];
  dc: number;
  mode: "normal" | "advantage" | "disadvantage";
  stakes: string;
  visibility: CheckVisibility;
  phase: "perception" | "resolution";
  causes: CausalRef[];
}

export type D20CheckRequestDraft = Omit<D20CheckRequest, "phase">;

export type ModifierSource = { kind: "rating"; id: string; amount: number };

export interface D20CheckResult {
  requestId: string;
  dice: number[];
  kept: number;
  modifier: number;
  total: number;
  dc: number;
  succeeded: boolean;
  margin: number;
  visibility: CheckVisibility;
}

export type CommitmentRound =
  | {
      kind: "check";
      phase: D20CheckRequest["phase"];
      requestIds: string[];
    }
  | {
      kind: "random";
      requestIds: string[];
    };

export interface DiscreteRandomRequest {
  id: string;
  distributionId: string;
  distribution: DiscreteRandomDefinition;
  causes: CausalRef[];
}

export interface DiscreteRandomStepResult {
  stepId: string;
  skipped: boolean;
  draws: Array<{
    outcomeIndex: number;
    value: DiscreteRandomValue;
  }>;
  aggregate: DiscreteRandomAggregate | null;
}

export interface DiscreteRandomResult {
  requestId: string;
  distributionId: string;
  steps: DiscreteRandomStepResult[];
}

export interface KnownAlternative {
  description: string;
  basis:
    | { kind: "knowledge"; evidenceIds: string[] }
    | { kind: "observation"; observationId: string };
}

export interface ActionOutcomeDraft {
  proposalId: string;
  status: "succeeded" | "partial" | "failed" | "blocked" | "continuing";
  summary: string;
  causeRefs: CausalRef[];
  assertions: CausalAssertion[];
  knownAlternatives: KnownAlternative[];
}

export interface ActionOutcome extends ActionOutcomeDraft {
  id: string;
}

export interface ApparentClaim {
  id: string;
  subjectId: LocalEntityId;
  predicate: string;
  value: BeliefValue;
  description: string;
}

export type ApparentClaimDraft = Omit<ApparentClaim, "id">;

export interface ObservationIntroduction {
  localEntity: LocalEntity;
  canonicalEntityId: EntityId | null;
}

export interface ObservationPacket {
  id: string;
  observerId: AgentId;
  step: number;
  kind: "stimulus" | "outcome";
  summary: string;
  introductions: ObservationIntroduction[];
  apparentClaims: ApparentClaim[];
  sourceEventIds: EventId[];
}

export interface ObservationPacketDraft extends Omit<
  ObservationPacket,
  "step" | "kind" | "apparentClaims"
> {
  apparentClaims: ApparentClaimDraft[];
}

export interface ReactionStimulusDraft {
  summary: string;
  introductions: ObservationIntroduction[];
  apparentClaims: ApparentClaimDraft[];
}

export type BeliefPatchOperation =
  | { kind: "upsert_local_entity"; entity: LocalEntity }
  | { kind: "remove_local_entity"; localEntityId: LocalEntityId }
  | { kind: "upsert_evidence"; evidence: BeliefEvidence }
  | { kind: "upsert_claim"; claim: BeliefClaim }
  | { kind: "remove_claim"; claimId: string }
  | { kind: "merge_local_entities"; fromId: LocalEntityId; intoId: LocalEntityId }
  | {
      kind: "split_local_entity";
      fromId: LocalEntityId;
      entities: LocalEntity[];
      assignments: Array<{
        claimId: string;
        subjectId: LocalEntityId | null;
        valueId: LocalEntityId | null;
      }>;
    };

export type BeliefPatchDraftOperation =
  | Exclude<BeliefPatchOperation, { kind: "upsert_evidence" }>
  | { kind: "upsert_evidence"; evidence: BeliefEvidenceDraft };

export interface BeliefPatch {
  agentId: AgentId;
  baseRevision: number;
  operations: BeliefPatchOperation[];
}

type CharacterPatchSource = { sourceObservationIds: string[]; evidenceIds: string[] };

export type CharacterPatchOperation =
  | (CharacterPatchSource & { kind: "replace_persona"; summary: string; voice: string })
  | (CharacterPatchSource & {
      kind: "create_trait" | "create_value";
      facet: Pick<CharacterFacet, "id" | "description" | "strength">;
    })
  | (CharacterPatchSource & {
      kind: "update_trait" | "update_value";
      id: string;
      description: string | null;
      strength: number | null;
    })
  | (CharacterPatchSource & { kind: "retire_trait" | "retire_value"; id: string })
  | (CharacterPatchSource & {
      kind: "set_emotion";
      emotion: Pick<EmotionState, "id" | "description" | "intensity">;
    })
  | (CharacterPatchSource & { kind: "resolve_emotion"; id: string })
  | (CharacterPatchSource & {
      kind: "set_attitude";
      attitude: Pick<AttitudeState, "id" | "subjectId" | "description" | "intensity">;
    })
  | (CharacterPatchSource & { kind: "retire_attitude"; id: string })
  | (CharacterPatchSource & {
      kind: "create_goal";
      goal: Pick<AgentGoal, "id" | "description" | "priority" | "progress" | "targetIds" | "motivatedByIds"> &
        { parentGoalId: string | null };
    })
  | (CharacterPatchSource & {
      kind: "update_goal";
      id: string;
      description: string | null;
      priority: number | null;
      progress: number | null;
      targetIds: LocalEntityId[] | null;
      parentGoal:
        | { kind: "unchanged" }
        | { kind: "none" }
        | { kind: "goal"; goalId: string };
      motivatedByIds: string[] | null;
    })
  | (CharacterPatchSource & { kind: "set_goal_status"; id: string; status: AgentGoal["status"] })
  | (CharacterPatchSource & {
      kind: "create_commitment";
      commitment: Pick<AgentCommitment, "id" | "description" | "priority" | "subjectIds">;
    })
  | (CharacterPatchSource & {
      kind: "update_commitment";
      id: string;
      description: string | null;
      priority: number | null;
      subjectIds: LocalEntityId[] | null;
    })
  | (CharacterPatchSource & {
      kind: "set_commitment_status";
      id: string;
      status: AgentCommitment["status"];
    });

export interface CharacterPatch {
  agentId: AgentId;
  baseRevision: number;
  operations: CharacterPatchOperation[];
}

export interface ReactionRequest {
  id: string;
  agentId: AgentId;
  triggerActionId: string;
  originalIntent:
    | { kind: "prepared_action"; actionId: string }
    | { kind: "ongoing_activity"; activityId: string; sourceActionId: string };
  stimulus: ObservationPacket;
  perceptionReceiptHash: string;
}

export type ReactionDecision =
  | {
      requestId: string;
      source: "model" | "external" | "replay" | "profile_fallback";
      agentId: AgentId;
      baseRevision: number;
      originalProposalId: string;
      kind: "keep";
      ongoingActivityDisposition: "continue" | "pause" | "cancel";
    }
  | {
      requestId: string;
      source: "model" | "external" | "replay" | "profile_fallback";
      agentId: AgentId;
      baseRevision: number;
      originalProposalId: string;
      kind: "replace";
      replacementAction: AgentActionProposal;
    };

export type WorldDeltaOperation = CausalSource & (
  | { kind: "create_entity"; entity: WorldEntity; placementId: EntityId | null }
  | { kind: "retire_entity"; entityId: EntityId }
  | { kind: "place_entity"; entityId: EntityId; placementId: EntityId | null }
  | { kind: "set_fact"; fact: WorldFact }
  | { kind: "remove_fact"; factId: FactId }
  | { kind: "set_meter"; meter: MeterState }
  | { kind: "adjust_meter"; meterId: string; amount: number }
  | {
      kind: "transfer_quantity";
      definitionId: string;
      fromHolderId: EntityId;
      toHolderId: EntityId;
      amount: number;
    }
  | {
      kind: "produce_quantity";
      definitionId: string;
      holderId: EntityId;
      amount: number;
      lawId: string;
    }
  | {
      kind: "consume_quantity";
      definitionId: string;
      holderId: EntityId;
      amount: number;
      lawId: string;
    }
  | { kind: "set_quantity"; quantity: QuantityState }
  | { kind: "set_rating"; rating: RatingState }
  | { kind: "set_condition"; condition: ConditionState }
  | { kind: "remove_condition"; conditionId: string }
  | { kind: "set_shared_activity_resource_capacity"; poolId: string; capacity: number }
  | { kind: "advance_time"; seconds: number }
  | { kind: "create_agent"; agent: AgentState }
  | { kind: "remove_agent"; agentId: AgentId }
);

export type WorldEntityDraft = Omit<WorldEntity, "lifecycle" | "createdAtStep">;
export type WorldFactDraft = Omit<WorldFact, "provenance">;

export type WorldDeltaOperationDraft = CausalSource & (
  | { kind: "create_entity"; entity: WorldEntityDraft; placementId: EntityId | null }
  | { kind: "retire_entity"; entityId: EntityId }
  | { kind: "place_entity"; entityId: EntityId; placementId: EntityId | null }
  | { kind: "set_fact"; fact: WorldFactDraft }
  | { kind: "remove_fact"; factId: FactId }
  | { kind: "create_agent"; agent: AgentStateDraft }
  | { kind: "remove_agent"; agentId: AgentId }
);

export interface MechanicInvocation extends CausalSource {
  id: string;
  packageId: string;
  ruleId: string;
  input: unknown;
}

export interface MechanicResult {
  invocationId: string;
  packageId: string;
  ruleId: string;
  code: string;
  data: unknown;
  operations: WorldDeltaOperation[];
}

export interface CausalTarget {
  kind: "check" | "random" | "operation" | "mechanic" | "event" | "outcome" | "observation" | "activity";
  id: string;
}

export interface CausalAssertionResult {
  target: CausalTarget;
  assertion: CausalAssertion;
  passed: boolean;
  observed: unknown;
}

export type CausalFindingCode =
  | "irrelevant-cause"
  | "missing-precondition"
  | "check-result-contradiction"
  | "law-violation"
  | "effect-mismatch"
  | "impact-overstated"
  | "observation-mismatch";

export type CausalVerification =
  | { verdict: "accept"; findings: [] }
  | {
      verdict: "reject";
      findings: Array<{
        target: CausalTarget;
        code: CausalFindingCode;
        message: string;
        repairHint: string;
      }>;
    };

export interface TransitionProposal {
  baseRevision: number;
  outcomes: ActionOutcome[];
  mechanicInvocations: MechanicInvocation[];
  operations: WorldDeltaOperation[];
  events: WorldEvent[];
  observations: ObservationPacket[];
  decisionRequests: DecisionRequest[];
}

export interface TransitionProposalDraft {
  outcomes: ActionOutcomeDraft[];
  mechanicInvocations: MechanicInvocation[];
  operations: WorldDeltaOperationDraft[];
  events: WorldEventDraft[];
  decisionRequests: DecisionRequest[];
}

export interface ObservationRenderDraft {
  summary: string;
  introductions: ObservationIntroduction[];
  apparentClaims: ApparentClaimDraft[];
  sourceEventIds: EventId[];
}

export interface DecisionRequest {
  agentId: AgentId;
  prompt: string;
  possibleNextActions: string[];
}

export interface ModelTokenUsage {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
}

export interface ModelContextSectionAudit {
  utf8Bytes: number;
  itemCount: number | null;
}

export interface ModelContextAudit {
  utf8Bytes: number;
  sections: Record<string, ModelContextSectionAudit>;
  counts: {
    history: number;
    events: number;
    agents: number;
    entities: number;
    facts: number;
    beliefs: number;
    evidence: number;
    observations: number;
  };
}

export interface ModelTransportAttemptAudit {
  attempt: number;
  queueWaitMs: number;
  executionMs: number;
  retryDelayMs: number;
  status: "succeeded" | "retryable_error" | "failed";
  errorName: string | null;
  statusCode: number | null;
}

export type ModelOutputDisposition =
  | "accepted"
  | "auto-normalized"
  | "llm-repaired"
  | "rejected";

export type ModelOutputIssueClass =
  | "structure"
  | "reference"
  | "mechanic"
  | "privacy"
  | "causal"
  | "semantic";

export interface ModelOutputIssue {
  code: string;
  class: ModelOutputIssueClass;
  path: Array<string | number>;
  message: string;
  originalValue?: unknown;
  allowedHandles?: string[];
  targetIds?: string[];
}

export interface ModelNormalizationSummary {
  applied: boolean;
  modifiedFieldCount: number;
  resolvedReferenceCount: number;
  proposalCount: number;
  deduplicatedCount: number;
  symbolRepairCount: number;
  symbolRepairAcceptedCount: number;
  symbolRepairAmbiguousCount: number;
  symbolRepairUnmatchedCount: number;
  symbolRepairPostValidationRejectedCount: number;
}

export interface ModelSymbolRepairAudit extends SymbolRepairResult {
  domain: SymbolRepairDomain;
  path: Array<string | number>;
  catalogHash: string;
  candidateCount: number;
}

/** Trusted Inspector evidence for the Action Compilation reference boundary.
 * This is emitted only in full runtime traces; the model-facing context keeps
 * the same records opaque by exposing candidate keys instead of these handles.
 */
export interface ActionCompilationReferenceAudit {
  protocolVersion: 2;
  projection: typeof ACTION_COMPILATION_PROJECTION;
  context: {
    utf8Bytes: number;
    referenceCatalogUtf8Bytes: number;
    slots: number;
    candidates: number;
    detailedCandidates: number;
    duplicateSemanticDefinitionCount: number;
    canonicalRefSerializedCount: number;
    rawPrivateReferenceSerializedCount: number;
  };
  slots: Array<{
    slot: number;
    actionId: string;
    actionLabel: string;
    actionCandidateKey: string;
    actor: {
      agentId: string;
      entityId: string | null;
      status: "unique" | "stale";
      agentCandidateKey: string | null;
      boundEntityCandidateKey: string | null;
      agentHandle: string | null;
      entityHandle: string | null;
    };
    targets: Array<{
      targetIndex: number;
      localReference: string;
      label: string | null;
      status: "unique" | "ambiguous" | "unresolved" | "stale";
      canonicalEntityIds: string[];
      canonicalCandidateKeys: string[];
      canonicalHandles: string[];
    }>;
    selections: Array<{
      path: Array<string | number>;
      use: string;
      candidateKey: string;
      engineHandle: string | null;
      kind: string | null;
      status: "resolved" | "invalid";
      reason?: string;
    }>;
  }>;
}

export interface ModelJsonRecoveryEvidence {
  policy: "unmatched-closers-v1" | "terminal-root-closer-v1";
  sourceHash: string;
  recoveredTextHash: string;
  /** Original response string offsets in UTF-16 code units. */
  removed: Array<{ offset: number; character: "}" | "]" }>;
}

export interface ModelInvocationAudit {
  id: string;
  ordinal: number;
  requestHash: string;
  responseHash: string | null;
  requestUtf8Bytes: number;
  responseUtf8Bytes: number | null;
  context: ModelContextAudit;
  transports: ModelTransportAttemptAudit[];
  tokenUsage: ModelTokenUsage;
  finishReason: string | null;
  providerRequestId: string | null;
  resultKind: string | null;
  outputDisposition: ModelOutputDisposition;
  issues: ModelOutputIssue[];
  normalization: ModelNormalizationSummary;
  symbolRepairs: ModelSymbolRepairAudit[];
  referenceCatalogVersion: number;
  referenceCatalogHash: string;
  rawOutputHash: string | null;
  normalizedOutputHash: string | null;
  jsonRecoveryEvidence?: ModelJsonRecoveryEvidence;
}

export interface ModelExecutionAudit {
  role: import("../models/model-catalog").ModelRole;
  subjectId: string;
  profileId: string;
  accountId: string;
  accountChannel: ModelAccountChannel;
  protocol: ModelProtocol;
  dialect: string;
  providerId: string;
  modelId: string;
  selector: ModelSelector;
  registrySnapshotHash: string;
  modelMetadataHash: string;
  modelCatalogSchemaVersion: 3;
  modelCatalogHash: string;
  promptVersion: string;
  requestedInference: ModelInferenceConfig;
  resolvedInference: ResolvedModelInference;
  structuredOutputMode: "json-schema-strict" | "json-object-zod" | "tool-call-zod" | "deterministic-test";
  invocations: ModelInvocationAudit[];
}

export interface CommittedStep {
  contentHash: string;
  semanticHash: string;
  executionRef?: import("../runtime/execution").ExecutionRef;
  baseRevision: number;
  revision: number;
  step: number;
  initialActions: AgentActionProposal[];
  reactionRequests: ReactionRequest[];
  reactionDecisions: ReactionDecision[];
  actions: AgentActionProposal[];
  rngBefore: SeededRngState;
  rngAfter: SeededRngState;
  resolutionPlans: ResolutionPlan[];
  resolutionReceipts: ResolutionReceipt[];
  temporalPlans: TemporalPlan[];
  temporalBoundary: TemporalBoundary;
  temporalState: import("../mechanics/temporal").TemporalStateSnapshot;
  activityTransitions: ActivityTransition[];
  activityDispositions: import("../mechanics/temporal").ActivityDisposition[];
  sharedResourceAdmissions: import("../mechanics/shared-resource-allocation").SharedResourceAdmission[];
  decisionPoints: DecisionPoint[];
  checkRequests: D20CheckRequest[];
  checks: D20CheckResult[];
  randomRequests: DiscreteRandomRequest[];
  randomResults: DiscreteRandomResult[];
  commitmentRounds: CommitmentRound[];
  outcomes: ActionOutcome[];
  mechanicInvocations: MechanicInvocation[];
  mechanicResults: MechanicResult[];
  causalAssertionResults: CausalAssertionResult[];
  causalVerification: CausalVerification;
  events: WorldEvent[];
  observations: ObservationPacket[];
  operations: WorldDeltaOperation[];
  decisionRequests: DecisionRequest[];
  beliefPatches: BeliefPatch[];
  characterPatches: CharacterPatch[];
  nextActions: AgentActionProposal[];
}
