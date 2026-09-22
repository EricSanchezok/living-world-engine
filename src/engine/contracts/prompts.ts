import { schemaValidationIssues } from "./schema-validation-issues";
import { perceptionReferenceCatalog, projectPerceptionTargets, type PerceptionTarget } from "./perception-references";
import { contentHash } from "../models/model-audit";
import { z } from "zod";
import { activityTemporalEvidence, ACTIVITY_TEMPORAL_NOTICE } from "./activity-temporal-evidence";
import { resolutionMeansSources, withResolutionFactEvidence, RESOLUTION_FACT_EVIDENCE, RESOLUTION_FACT_EVIDENCE_NOTICE } from "./resolution-source-inventory";
import { CharacterPatchValidationError } from "../cognition/character";
import type {
  ActionOutcome,
  AgentActionProposal,
  AgentState,
  CausalAssertion,
  CausalAssertionResult,
  CausalVerification,
  CommitmentRound,
  D20CheckRequest,
  D20CheckResult,
  DiscreteRandomRequest,
  DiscreteRandomResult,
  MechanicResult,
  ObservationPacket,
  ReactionDecision,
  ReactionRequest,
  SimulationState,
  TransitionProposal,
  WorldDeltaOperation,
  WorldEvent,
  AgentPerspectiveView,
} from "./model";
import type { ResolutionPlan, ResolutionReceipt, ResolutionSourceRef } from "../mechanics/resolution";
import { difficultyDc, ResolutionCheckEffectError } from "../mechanics/resolution";
import type { InteractionDependency } from "../runtime/execution";
import { ObservationValidationError } from "../cognition/observation";
import { projectAgentPerspective } from "../cognition/agent-perspective";
import type { WorldDefinition } from "../runtime/world-definition";
import type { TemporalBoundary, TemporalStateSnapshot } from "../mechanics/temporal";
import { quantityId } from "../runtime/runtime-id";
import { MechanicInputValidationError, type MechanicPromptContract } from "../mechanics/rule-package";
import { promptBundle, type PromptBundleId } from "../prompts";
import { ModelCandidateValidationError, ModelOutputError } from "../models/model-provider";
import {
  MODEL_CONTEXT_CONTRACT_VERSION as MODEL_CONTEXT_VERSION,
  createAgentReferenceResolver,
  createReferenceResolver,
  ModelReferenceError,
  modelRoleContract,
  type ModelRepairIssue,
  type ReferenceCandidateInput,
  type ReferenceResolver,
  type ModelWorkset,
} from "./model-context";

export const MODEL_CONTEXT_CONTRACT_VERSION = MODEL_CONTEXT_VERSION;
export const PLAN_CAUSE_SCOPE = "component-plan-causes-v1";

export { promptBundle } from "../prompts";
export type { PromptBundle, PromptBundleId } from "../prompts";

export function promptFor(id: PromptBundleId) {
  return promptBundle(id);
}

export interface PromptValidationIssue {
  code: string;
  path: Array<string | number>;
  message: string;
  class?: ModelRepairIssue["class"];
  originalValue?: unknown;
  allowedHandles?: readonly string[];
}

export type TruthContextMode = "scoped" | "full";

export interface ResolutionScope {
  mode: "component" | "global" | "repair";
  selectedActionIds: string[];
  totalActionCount: number;
}

type RepairTarget = {
  kind: "mechanic" | "plan" | "operation" | "event" | "outcome" | "observation";
  id: string;
  issueClass: string;
};

/** Project internal repair metadata into the same request-local vocabulary as
 * the rest of the model context. Runtime ids never cross this boundary. A
 * mechanic invocation repair may target a same-response proposal key, which
 * is intentionally represented as a proposal marker when it is not yet in
 * the catalog. */
function projectRepairTarget(target: RepairTarget | null | undefined, resolver: ReferenceResolver): Record<string, unknown> | null {
  if (!target) return null;
  try {
    return {
      kind: target.kind,
      targetRef: resolver.handleFor(target.kind, target.id),
      issueClass: target.issueClass,
    };
  } catch {
    return target.kind === "mechanic"
      ? { kind: target.kind, targetRef: { proposalKey: target.id }, issueClass: target.issueClass }
      : { kind: target.kind, issueClass: target.issueClass };
  }
}

function projectResolutionScope(scope: ResolutionScope | null | undefined, resolver: ReferenceResolver): Record<string, unknown> | null {
  if (!scope) return null;
  return {
    mode: scope.mode,
    selectedActionRefs: scope.selectedActionIds.map((id) => resolver.handleFor("action", id)),
    totalActionCount: scope.totalActionCount,
  };
}

type CachedTruthProjection = {
  resolver: ReferenceResolver;
  canonicalTruth: Record<string, unknown>;
};

/* A transition component may ask for the same full-world projection many
 * times in one step. Keep the immutable projection request-local and reuse it
 * across those calls; slot-specific task data is still built per request. */
const fullTruthProjectionCache = new WeakMap<object, WeakMap<object, WeakMap<object, Map<string, CachedTruthProjection>>>>();

function cachedFullTruthProjection(
  state: SimulationState,
  actions: readonly AgentActionProposal[],
  definition: WorldDefinition,
  referenceInputsHash: string,
  build: () => CachedTruthProjection,
): CachedTruthProjection {
  let byActions = fullTruthProjectionCache.get(state);
  if (!byActions) {
    byActions = new WeakMap();
    fullTruthProjectionCache.set(state, byActions);
  }
  let byDefinition = byActions.get(actions);
  if (!byDefinition) {
    byDefinition = new WeakMap();
    byActions.set(actions, byDefinition);
  }
  let byReferences = byDefinition.get(definition);
  if (!byReferences) {
    byReferences = new Map();
    byDefinition.set(definition, byReferences);
  }
  const cached = byReferences.get(referenceInputsHash);
  if (cached) return cached;
  const projection = build();
  byReferences.set(referenceInputsHash, projection);
  return projection;
}

export function validationIssues(error: unknown): PromptValidationIssue[] {
  if (error instanceof ModelCandidateValidationError) return structuredClone([...error.issues]);
  if (error instanceof ResolutionCheckEffectError) return structuredClone(error.issues);
  if (error instanceof ModelOutputError) {
    const seen = new Set<ModelOutputError>();
    let cause: unknown = error;
    let rejectedValue: unknown;
    while (cause instanceof ModelOutputError && !seen.has(cause) && seen.size < 32) {
      seen.add(cause);
      rejectedValue = cause.rawValue;
      cause = cause.cause;
    }
    if (cause instanceof z.ZodError) return schemaValidationIssues(cause, rejectedValue);
    if (cause instanceof ModelCandidateValidationError || cause instanceof ModelReferenceError || cause instanceof ResolutionCheckEffectError) return validationIssues(cause);
  }
  if (error instanceof ModelReferenceError) {
    return [{
      code: error.code,
      class: "reference",
      path: [...error.path],
      message: error.message,
      originalValue: error.originalValue,
      allowedHandles: error.allowedHandles,
    }];
  }
  if (error instanceof MechanicInputValidationError) {
    return error.issues.map((issue) => ({
      code: "mechanic_input_contract",
      class: "mechanic" as const,
      path: ["mechanicInvocations", error.invocationId, ...issue.path],
      message: issue.message,
    }));
  }
  if (error instanceof ObservationValidationError || error instanceof CharacterPatchValidationError) {
    return error.issues.map((issue) => ({ ...issue, path: [...issue.path] }));
  }
  if (error instanceof z.ZodError) return schemaValidationIssues(error);
  return [{
    code: error instanceof Error ? error.name || "validation_error" : "validation_error",
    path: [],
    message: error instanceof Error ? error.message : String(error),
  }];
}

function projectPromptIssue(issue: PromptValidationIssue): ModelRepairIssue {
  return {
    code: issue.code,
    class: issue.class ?? "semantic",
    path: [...issue.path],
    originalValue: issue.originalValue ?? null,
    allowedHandles: [...(issue.allowedHandles ?? [])],
    reason: issue.message,
  };
}

/**
 * Project a delivered observation for an Agent.  Observation packet ids and
 * canonical bindings are engine-owned; the model only receives request-local
 * handles and the perceivable content.  Keep this projection separate from
 * the persisted ObservationPacket type so a future field cannot accidentally
 * leak into an Agent prompt by spreading the runtime object.
 */
function projectAgentObservation(
  packet: Readonly<ObservationPacket>,
  resolver: ReferenceResolver,
): Record<string, unknown> {
  const localRef = (localEntityId: string): string => resolver.handleFor("local_entity", localEntityId);
  return {
    observationRef: resolver.handleFor("observation", packet.id),
    step: packet.step,
    kind: packet.kind,
    summary: packet.summary,
    introductions: packet.introductions.map(({ localEntity }) => ({
      localEntityRef: localRef(localEntity.id),
      name: localEntity.name,
      description: localEntity.description,
      status: localEntity.status,
    })),
    apparentClaims: packet.apparentClaims.map((claim) => ({
      subjectRef: localRef(claim.subjectId),
      predicate: claim.predicate,
      value: claim.value.kind === "local_entity"
        ? { kind: "local_entity", entityRef: localRef(claim.value.localEntityId) }
        : structuredClone(claim.value),
      description: claim.description,
    })),
    sourceEventCount: packet.sourceEventIds.length,
  };
}

/** Safe, reference-free projection retained for callers that only need to
 * sanitize an observation outside a model request. */
function visibleObservation(packet: Readonly<ObservationPacket>): Record<string, unknown> {
  return {
    step: packet.step,
    kind: packet.kind,
    summary: packet.summary,
    introductions: packet.introductions.map(({ localEntity }) => ({ localEntity: structuredClone(localEntity) })),
    apparentClaims: packet.apparentClaims.map((claim) => structuredClone(claim)),
    sourceEventCount: packet.sourceEventIds.length,
  };
}

/**
 * Project the rich public Agent perspective into the model vocabulary. The
 * public perspective intentionally keeps persistence ids for trusted UI/API
 * consumers; model requests instead receive only request-local handles and
 * semantic fields. This adapter is the one boundary used by AgentMind,
 * reaction, action grounding, and arrival contexts.
 */
export function projectAgentPerspectiveForModel(
  state: Readonly<SimulationState>,
  agent: Readonly<AgentState>,
  resolver: ReferenceResolver,
  options: { includePrivateCognition?: boolean } = {},
): Record<string, unknown> {
  const perspective = projectAgentPerspective(state, agent);
  const tryHandle = (kind: Parameters<ReferenceResolver["handleFor"]>[0], id: string): string | null => {
    try { return resolver.handleFor(kind, id); }
    catch { return null; }
  };
  const localHandle = (id: string): string | null => tryHandle("local_entity", id);
  const localRef = (value: string): string | null => value.startsWith("local:")
    ? localHandle(value.slice("local:".length))
    : value.startsWith("ref:") ? value : null;
  const evidenceRefs = (ids: readonly string[]): string[] => ids.flatMap((id) => {
    const handle = tryHandle("evidence", id);
    return handle ? [handle] : [];
  });
  const beliefValue = (value: Readonly<AgentState["belief"]["claims"][string]["value"]>): unknown =>
    value.kind === "local_entity"
      ? (() => {
          const entityRef = localHandle(value.localEntityId);
          return entityRef
            ? { kind: "local_entity", entityRef }
            : { kind: "text", value: "未识别的局部实体" };
        })()
      : structuredClone(value);
  const character = {
    persona: {
      summary: agent.character.persona.summary,
      voice: agent.character.persona.voice,
      evidenceRefs: evidenceRefs(agent.character.persona.evidenceIds),
    },
    traits: Object.values(agent.character.traits).map((facet) => ({
      facetRef: tryHandle("character_facet", facet.id),
      description: facet.description,
      strength: facet.strength,
      status: facet.status,
      evidenceRefs: evidenceRefs(facet.evidenceIds),
    })),
    values: Object.values(agent.character.values).map((facet) => ({
      facetRef: tryHandle("character_facet", facet.id),
      description: facet.description,
      strength: facet.strength,
      status: facet.status,
      evidenceRefs: evidenceRefs(facet.evidenceIds),
    })),
    emotions: Object.values(agent.character.emotions).map((emotion) => ({
      emotionRef: tryHandle("emotion", emotion.id),
      description: emotion.description,
      intensity: emotion.intensity,
      status: emotion.status,
      evidenceRefs: evidenceRefs(emotion.evidenceIds),
    })),
    attitudes: Object.values(agent.character.attitudes).map((attitude) => ({
      attitudeRef: tryHandle("attitude", attitude.id),
      ...(localHandle(attitude.subjectId)
        ? { subjectRef: localHandle(attitude.subjectId) }
        : { subjectDescription: "未识别的局部主体" }),
      description: attitude.description,
      intensity: attitude.intensity,
      status: attitude.status,
      evidenceRefs: evidenceRefs(attitude.evidenceIds),
    })),
    goals: Object.values(agent.character.goals).map((goal) => ({
      goalRef: tryHandle("goal", goal.id),
      description: goal.description,
      priority: goal.priority,
      progress: goal.progress,
      targetRefs: goal.targetIds.flatMap((id) => {
        const handle = localHandle(id);
        return handle ? [handle] : [];
      }),
      parentGoalRef: goal.parentGoalId ? tryHandle("goal", goal.parentGoalId) : null,
      motivatedByRefs: goal.motivatedByIds.flatMap((id) => {
        const handle = tryHandle("character_facet", id) ?? tryHandle("commitment", id);
        return handle ? [handle] : [];
      }),
      status: goal.status,
      evidenceRefs: evidenceRefs(goal.evidenceIds),
    })),
    commitments: Object.values(agent.character.commitments).map((commitment) => ({
      commitmentRef: tryHandle("commitment", commitment.id),
      description: commitment.description,
      priority: commitment.priority,
      subjectRefs: commitment.subjectIds.map(localHandle),
      status: commitment.status,
      evidenceRefs: evidenceRefs(commitment.evidenceIds),
    })),
  };
  const mapObservation = (observation: AgentPerspectiveView["history"][number]["observations"][number]) => ({
    kind: observation.kind,
    summary: observation.summary,
    introductions: observation.introductions.map((introduction) => ({
      localEntityRef: localHandle(introduction.id),
      name: introduction.name,
      description: introduction.description,
      status: introduction.status,
    })),
    apparentClaims: observation.apparentClaims.map((claim) => {
      const subjectRef = localHandle(claim.subjectId);
      return subjectRef
        ? { subjectRef, predicate: claim.predicate, value: beliefValue(claim.value), description: claim.description }
        : { subjectDescription: "未识别的局部主体", predicate: claim.predicate, value: beliefValue(claim.value), description: claim.description };
    }),
  });
  const projected: Record<string, unknown> = {
    agentRef: resolver.handleFor("agent", agent.id),
    elapsedSeconds: perspective.elapsedSeconds,
    self: {
      selfRef: localHandle(perspective.self.localEntityId),
      name: perspective.self.name,
      description: perspective.self.description,
      lifecycle: perspective.self.lifecycle,
      location: perspective.self.location ? {
        ...(perspective.self.location.localEntityId ? { entityRef: localHandle(perspective.self.location.localEntityId) } : {}),
        name: perspective.self.location.name,
        description: perspective.self.location.description,
      } : null,
    },
    mechanics: structuredClone(perspective.mechanics),
    knowledge: {
      entities: perspective.knowledge.entities.map((entity) => {
        const entityRef = entity.localEntityId ? localHandle(entity.localEntityId) : null;
        return {
          ...(entityRef ? { entityRef } : {}),
          name: entity.name,
          description: entity.description,
          status: entity.status,
          targetable: entity.targetable,
        };
      }),
      containment: perspective.knowledge.containment.map((entry) => ({
        ...(localRef(entry.entityRef) ? { entityRef: localRef(entry.entityRef) } : { entityDescription: "未识别的随身存在" }),
        ...(localRef(entry.containerRef) ? { containerRef: localRef(entry.containerRef) } : { containerDescription: "未识别的容器" }),
        depth: entry.depth,
        viaUnknownContainer: entry.viaUnknownContainer,
      })),
      exactFacts: perspective.knowledge.exactFacts.map((fact) => {
        const subjectRef = localRef(fact.subjectRef);
        const value = fact.value.kind === "entity"
          ? { kind: "entity", ...(localRef(fact.value.entityRef) ? { entityRef: localRef(fact.value.entityRef) } : { entityDescription: "未识别的实体" }) }
          : structuredClone(fact.value);
        return {
          ...(subjectRef ? { subjectRef } : { subjectDescription: "未识别的实体" }),
          predicate: fact.predicate,
          value,
          description: fact.description,
        };
      }),
      claims: options.includePrivateCognition === false ? [] : Object.values(agent.belief.claims).flatMap((claim) => {
        const claimRef = tryHandle("claim", claim.id);
        const subjectRef = localHandle(claim.subjectId);
        return claimRef && subjectRef
          ? [{ claimRef, subjectRef, predicate: claim.predicate, value: beliefValue(claim.value), description: claim.description, stance: claim.stance, confidence: claim.confidence, evidenceRefs: evidenceRefs(claim.evidenceIds) }]
          : [];
      }),
      evidence: options.includePrivateCognition === false ? [] : Object.values(agent.belief.evidence).map((evidence) => ({
        evidenceRef: tryHandle("evidence", evidence.id),
        kind: evidence.kind,
        description: evidence.description,
        sourceRef: evidence.sourceId
          ? tryHandle("local_entity", evidence.sourceId) ?? tryHandle("observation", evidence.sourceId)
          : null,
      })),
    },
    character: options.includePrivateCognition === false ? undefined : character,
    history: options.includePrivateCognition === false ? [] : perspective.history.map((turn) => ({
      ownAction: turn.ownAction,
      perceivedOutcome: turn.perceivedOutcome,
      observations: turn.observations.map(mapObservation),
      resolutions: structuredClone(turn.resolutions),
    })),
  };
  if (options.includePrivateCognition === false) delete projected.character;
  return projected;
}

function scopedCanonicalTruth(
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  groundings: readonly InteractionDependency[],
): SimulationState["truth"] {
  if (groundings.some((grounding) => grounding.globalFallback)) return structuredClone(state.truth);

  const entityIds = new Set<string>();
  const factIds = new Set<string>();
  const placementIds = new Set<string>();
  const meterIds = new Set<string>();
  const quantityIds = new Set<string>();
  const ratingIds = new Set<string>();
  const conditionIds = new Set<string>();
  const activityIds = new Set<string>();
  const timerIds = new Set<string>();
  const relevantAgentIds = new Set<string>();
  const addRef = (ref: { kind: string; id: string }): void => {
    switch (ref.kind) {
      case "entity": entityIds.add(ref.id); break;
      case "fact": factIds.add(ref.id); break;
      case "placement": placementIds.add(ref.id); break;
      case "meter": meterIds.add(ref.id); break;
      case "quantity": quantityIds.add(ref.id); break;
      case "rating": ratingIds.add(ref.id); break;
      case "condition": conditionIds.add(ref.id); break;
      case "activity": activityIds.add(ref.id); break;
      case "timer": timerIds.add(ref.id); break;
      default: break;
    }
  };
  for (const grounding of groundings) {
    grounding.reads.forEach(addRef);
    grounding.writes.forEach(addRef);
    grounding.audienceAgentIds.forEach((agentId) => relevantAgentIds.add(agentId));
    if (grounding.actorId !== null) relevantAgentIds.add(grounding.actorId);
    if (grounding.kind === "activity") activityIds.add(grounding.id);
    if (grounding.kind === "timer") timerIds.add(grounding.id);
    if (grounding.kind === "condition") conditionIds.add(grounding.id);
  }
  for (const action of actions) {
    relevantAgentIds.add(action.actorId);
    const agent = state.agents[action.actorId];
    if (agent) {
      entityIds.add(agent.entityId);
      const placementId = state.truth.placements[agent.entityId];
      if (placementId) placementIds.add(placementId);
      for (const localId of action.targetIds) {
        for (const entityId of agent.bindings[localId]?.canonicalEntityIds ?? []) entityIds.add(entityId);
      }
    }
  }

  for (const fact of Object.values(state.truth.facts)) {
    if (factIds.has(fact.id)) {
      entityIds.add(fact.subjectId);
      if (fact.value.kind === "entity") entityIds.add(fact.value.entityId);
    }
  }
  for (const fact of Object.values(state.truth.facts)) {
    if (entityIds.has(fact.subjectId) ||
      fact.value.kind === "entity" && entityIds.has(fact.value.entityId)) factIds.add(fact.id);
  }
  for (const entityId of [...entityIds]) {
    let placement = state.truth.placements[entityId];
    const seen = new Set<string>();
    while (placement && !seen.has(placement)) {
      seen.add(placement);
      placementIds.add(placement);
      entityIds.add(placement);
      placement = state.truth.placements[placement];
    }
  }
  const truth = structuredClone(state.truth);
  truth.entities = Object.fromEntries(Object.entries(state.truth.entities)
    .filter(([id]) => entityIds.has(id)));
  truth.placements = Object.fromEntries(Object.entries(state.truth.placements)
    .filter(([id]) => entityIds.has(id) || placementIds.has(id)));
  truth.facts = Object.fromEntries(Object.entries(state.truth.facts)
    .filter(([id]) => factIds.has(id)));
  truth.factTombstones = state.truth.factTombstones.filter((id) => factIds.has(id));
  truth.meters = Object.fromEntries(Object.entries(state.truth.meters)
    .filter(([id, meter]) => meterIds.has(id) || entityIds.has(meter.entityId)));
  truth.quantities = Object.fromEntries(Object.entries(state.truth.quantities)
    .filter(([id, quantity]) => quantityIds.has(id) || entityIds.has(quantity.holderId)));
  truth.ratings = Object.fromEntries(Object.entries(state.truth.ratings)
    .filter(([id, rating]) => ratingIds.has(id) || entityIds.has(rating.entityId)));
  truth.conditions = Object.fromEntries(Object.entries(state.truth.conditions)
    .filter(([id, condition]) => conditionIds.has(id) || entityIds.has(condition.subjectId)));
  truth.activities = Object.fromEntries(Object.entries(state.truth.activities)
    .filter(([id, activity]) => activityIds.has(id) || relevantAgentIds.has(activity.actorId) ||
      activity.participantAgentIds.some((agentId) => relevantAgentIds.has(agentId))));
  truth.timers = Object.fromEntries(Object.entries(state.truth.timers)
    .filter(([id, timer]) => timerIds.has(id) || timer.wakeAgentIds.some((agentId) => relevantAgentIds.has(agentId))));
  truth.sharedActivityResourcePools = Object.fromEntries(Object.entries(state.truth.sharedActivityResourcePools)
    .filter(([id, pool]) => entityIds.has(pool.entityId) || groundings.some((grounding) =>
      grounding.sharedResourceClaims.some((claim) => claim.poolId === id))));
  truth.events = state.truth.events.filter((event) => event.step === state.step ||
    event.causes.some((cause) => groundings.some((grounding) => grounding.id === cause.id)));
  return truth;
}

type ModelReferenceResolvers = {
  existing: ReferenceResolver;
  task?: ReferenceResolver;
  worldHash?: string;
};

function modelHandle(
  resolvers: ModelReferenceResolvers,
  kind: Parameters<ReferenceResolver["handleFor"]>[0],
  engineId: string,
): string {
  try {
    return resolvers.existing.handleFor(kind, engineId);
  } catch (error) {
    if (resolvers.task) return resolvers.task.handleFor(kind, engineId);
    throw error;
  }
}

function projectModelFactValue(
  value: Readonly<SimulationState["truth"]["facts"][string]["value"]>,
  resolvers: ModelReferenceResolvers,
): unknown {
  return value.kind === "entity"
    ? { kind: "entity", entityRef: modelHandle(resolvers, "entity", value.entityId) }
    : structuredClone(value);
}

function projectModelCausalRef(
  cause: Readonly<{ kind: string; id: string }>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  const kind = cause.kind === "global" ? "world" : cause.kind;
  return {
    kind,
    ref: modelHandle(resolvers, kind as Parameters<ReferenceResolver["handleFor"]>[0], cause.id),
  };
}

function projectModelCausalAssertion(
  assertion: Readonly<CausalAssertion>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  switch (assertion.kind) {
    case "check_result":
      return { kind: assertion.kind, checkRef: modelHandle(resolvers, "check", assertion.checkId), expected: assertion.expected };
    case "random_result":
      return {
        kind: assertion.kind,
        requestRef: modelHandle(resolvers, "random", assertion.requestId),
        stepRef: modelHandle(resolvers, "random", assertion.stepId),
        expected: structuredClone(assertion.expected),
      };
    case "fact_matches":
      return { kind: assertion.kind, factRef: modelHandle(resolvers, "fact", assertion.factId), expected: projectModelFactValue(assertion.expected, resolvers) };
    case "fact_absent":
      return { kind: assertion.kind, factRef: modelHandle(resolvers, "fact", assertion.factId) };
    case "entity_absent":
      return { kind: assertion.kind, entityRef: modelHandle(resolvers, "entity", assertion.entityId) };
    case "entity_lifecycle":
      return { kind: assertion.kind, entityRef: modelHandle(resolvers, "entity", assertion.entityId), expected: assertion.expected };
    case "placement_equals":
    case "placement_not_equals":
      return {
        kind: assertion.kind,
        entityRef: modelHandle(resolvers, "entity", assertion.entityId),
        placementRef: assertion.placementId === null ? null : modelHandle(resolvers, "placement", assertion.placementId),
      };
    case "shared_placement":
      return {
        kind: assertion.kind,
        leftEntityRef: modelHandle(resolvers, "entity", assertion.leftEntityId),
        rightEntityRef: modelHandle(resolvers, "entity", assertion.rightEntityId),
      };
    case "meter_compare":
      return { kind: assertion.kind, meterRef: modelHandle(resolvers, "meter", assertion.meterId), operator: assertion.operator, value: assertion.value };
    case "quantity_compare":
      return {
        kind: assertion.kind,
        quantityRef: modelHandle(
          resolvers,
          "quantity",
          quantityId(resolvers.worldHash ?? "", assertion.definitionId, assertion.holderId),
        ),
        operator: assertion.operator,
        value: assertion.value,
      };
    case "rating_compare":
      return { kind: assertion.kind, ratingRef: modelHandle(resolvers, "rating", assertion.ratingId), operator: assertion.operator, value: assertion.value };
    case "shared_resource_capacity_compare":
      return { kind: assertion.kind, poolRef: modelHandle(resolvers, "shared_resource_pool", assertion.poolId), operator: assertion.operator, value: assertion.value };
    case "elapsed_seconds_compare":
      return structuredClone(assertion);
  }
}

function projectModelCheckRequest(
  request: Readonly<D20CheckRequest>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    checkRef: modelHandle(resolvers, "check", request.id),
    actorRef: modelHandle(resolvers, "entity", request.actorId),
    targetRef: request.targetId === null ? null : modelHandle(resolvers, "entity", request.targetId),
    ratingRef: request.ratingId === null ? null : modelHandle(resolvers, "rating", request.ratingId),
    modifier: request.modifier,
    modifierSources: request.modifierSources.map((source) => ({
      kind: source.kind,
      ratingRef: modelHandle(resolvers, "rating", source.id),
      amount: source.amount,
    })),
    dc: request.dc,
    mode: request.mode,
    stakes: request.stakes,
    visibility: request.visibility,
    phase: request.phase,
    causes: request.causes.map((cause) => projectModelCausalRef(cause, resolvers)),
  };
}

function projectModelCheckResult(
  result: Readonly<D20CheckResult>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    checkRef: modelHandle(resolvers, "check", result.requestId),
    dice: [...result.dice],
    kept: result.kept,
    modifier: result.modifier,
    total: result.total,
    dc: result.dc,
    succeeded: result.succeeded,
    margin: result.margin,
    visibility: result.visibility,
  };
}

function projectModelRandomRequest(
  request: Readonly<DiscreteRandomRequest>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    randomRef: modelHandle(resolvers, "random", request.id),
    distributionRef: modelHandle(resolvers, "random_distribution", request.distributionId),
    distribution: {
      description: request.distribution.description,
      steps: request.distribution.steps.map((step) => ({
        stepRef: modelHandle(resolvers, "random", step.id),
        count: step.count,
        outcomes: [...step.outcomes],
        aggregate: step.aggregate,
        when: step.when ? {
          stepRef: modelHandle(resolvers, "random", step.when.stepId),
          equals: step.when.equals,
        } : null,
      })),
    },
    causes: request.causes.map((cause) => projectModelCausalRef(cause, resolvers)),
  };
}

function projectModelRandomResult(
  result: Readonly<DiscreteRandomResult>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    randomRef: modelHandle(resolvers, "random", result.requestId),
    distributionRef: modelHandle(resolvers, "random_distribution", result.distributionId),
    steps: result.steps.map((step) => ({
      stepRef: modelHandle(resolvers, "random", step.stepId),
      skipped: step.skipped,
      draws: step.draws.map((draw) => ({ ...draw })),
      aggregate: structuredClone(step.aggregate),
    })),
  };
}

function projectModelOutcome(
  outcome: Readonly<ActionOutcome>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    outcomeRef: modelHandle(resolvers, "outcome", outcome.id),
    actionRef: modelHandle(resolvers, "action", outcome.proposalId),
    status: outcome.status,
    summary: outcome.summary,
    causes: outcome.causeRefs.map((cause) => projectModelCausalRef(cause, resolvers)),
    assertions: outcome.assertions.map((assertion) => projectModelCausalAssertion(assertion, resolvers)),
    knownAlternatives: outcome.knownAlternatives.map((alternative) => ({
      description: alternative.description,
      basis: alternative.basis.kind === "knowledge"
        ? { kind: alternative.basis.kind, evidenceRefs: alternative.basis.evidenceIds.map((id) => modelHandle(resolvers, "evidence", id)) }
        : { kind: alternative.basis.kind, observationRef: modelHandle(resolvers, "observation", alternative.basis.observationId) },
    })),
  };
}

function projectModelObservation(
  observation: Readonly<ObservationPacket>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    observationRef: modelHandle(resolvers, "observation", observation.id),
    observerRef: modelHandle(resolvers, "agent", observation.observerId),
    step: observation.step,
    kind: observation.kind,
    summary: observation.summary,
    introductions: observation.introductions.map(({ localEntity, canonicalEntityId }) => ({
      name: localEntity.name,
      description: localEntity.description,
      status: localEntity.status,
      canonicalEntityRef: canonicalEntityId === null ? null : modelHandle(resolvers, "entity", canonicalEntityId),
    })),
    apparentClaims: observation.apparentClaims.map((claim) => ({
      subjectRef: modelHandle(resolvers, "local_entity", `${observation.observerId}::${claim.subjectId}`),
      predicate: claim.predicate,
      value: claim.value.kind === "local_entity"
        ? { kind: "local_entity", entityRef: modelHandle(resolvers, "local_entity", `${observation.observerId}::${claim.value.localEntityId}`) }
        : structuredClone(claim.value),
      description: claim.description,
    })),
    sourceEventRefs: observation.sourceEventIds.map((id) => modelHandle(resolvers, "event", id)),
  };
}

function maybeModelHandle(
  resolvers: ModelReferenceResolvers,
  kind: Parameters<ReferenceResolver["handleFor"]>[0],
  engineId: string | null | undefined,
): string | null {
  if (!engineId) return null;
  try {
    return modelHandle(resolvers, kind, engineId);
  } catch {
    return null;
  }
}

function projectModelSourceRef(
  source: Readonly<ResolutionSourceRef>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    kind: source.kind,
    ref: modelHandle(resolvers, source.kind, source.id),
  };
}

function projectModelEffect(
  effect: Readonly<NonNullable<ResolutionPlan["primaryEffect"] | ResolutionPlan["threatenedEffect"]>>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    kind: effect.kind,
    targetRef: modelHandle(resolvers, "entity", effect.targetId),
    channel: effect.channel,
    label: effect.label,
    description: effect.description,
    sourceRefs: effect.sourceRefs.map((source) => projectModelSourceRef(source, resolvers)),
    ...(effect.kind === "meter"
      ? {
          meterRef: modelHandle(resolvers, "meter", effect.meterId),
          impactProfileRef: modelHandle(resolvers, "mechanic", effect.impactProfileId),
        }
      : {
          conditionRef: modelHandle(resolvers, "condition", effect.conditionId),
          conditionProfileRef: maybeModelHandle(resolvers, "mechanic", effect.conditionProfileId),
          durationProfileRef: modelHandle(resolvers, "mechanic", effect.durationProfileId),
          access: effect.access.kind === "agents"
            ? { kind: effect.access.kind, agentRefs: effect.access.agentIds.map((id) => modelHandle(resolvers, "agent", id)) }
            : { kind: effect.access.kind },
        }),
  };
}

function projectModelResolutionPlan(
  plan: Readonly<ResolutionPlan>,
  resolvers: ModelReferenceResolvers,
  options: { includeRef?: boolean } = {},
): Record<string, unknown> {
  return {
    ...(options.includeRef === false ? {} : { planRef: modelHandle(resolvers, "plan", plan.id) }),
    actionRef: modelHandle(resolvers, "action", plan.actionId),
    actorRef: modelHandle(resolvers, "entity", plan.actorId),
    targetRefs: plan.targetIds.map((id) => modelHandle(resolvers, "entity", id)),
    goal: plan.goal,
    means: plan.means.map((mean) => ({ description: mean.description, source: projectModelSourceRef(mean.source, resolvers) })),
    mode: plan.mode,
    difficulty: plan.difficulty === null
      ? null
      : plan.difficulty.kind === "environment"
        ? { kind: plan.difficulty.kind, band: plan.difficulty.band, source: projectModelSourceRef(plan.difficulty.source, resolvers) }
        : {
            kind: plan.difficulty.kind,
            targetRef: modelHandle(resolvers, "entity", plan.difficulty.targetId),
            ratingRef: modelHandle(resolvers, "rating", plan.difficulty.ratingId),
            source: projectModelSourceRef(plan.difficulty.source, resolvers),
          },
    actorRatingRef: maybeModelHandle(resolvers, "rating", plan.actorRatingId),
    factors: plan.factors.map((factor) => ({
      source: projectModelSourceRef(factor.source, resolvers),
      role: factor.role,
      direction: factor.direction,
      steps: factor.steps,
      authority: factor.authority,
      channel: factor.channel,
      explanation: factor.explanation,
    })),
    risk: plan.risk,
    baseEffect: plan.baseEffect,
    primaryEffect: plan.primaryEffect ? projectModelEffect(plan.primaryEffect, resolvers) : null,
    secondaryEffect: plan.secondaryEffect ? projectModelEffect(plan.secondaryEffect, resolvers) : null,
    threatenedEffect: plan.threatenedEffect ? projectModelEffect(plan.threatenedEffect, resolvers) : null,
    visibility: plan.visibility,
    causes: plan.causes.map((cause) => projectModelCausalRef(cause, resolvers)),
  };
}

function projectModelOperation(
  operation: Readonly<WorldDeltaOperation>,
  operationRef: string,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  const base = {
    operationRef,
    kind: operation.kind,
    causes: operation.causes.map((cause) => projectModelCausalRef(cause, resolvers)),
    assertions: operation.assertions.map((assertion) => projectModelCausalAssertion(assertion, resolvers)),
  };
  switch (operation.kind) {
    case "create_entity":
      return { ...base, entity: { entityRef: maybeModelHandle(resolvers, "entity", operation.entity.id), kind: operation.entity.kind, name: operation.entity.name, description: operation.entity.description }, placementRef: operation.placementId === null ? null : modelHandle(resolvers, "placement", operation.placementId) };
    case "retire_entity":
      return { ...base, entityRef: modelHandle(resolvers, "entity", operation.entityId) };
    case "place_entity":
      return { ...base, entityRef: modelHandle(resolvers, "entity", operation.entityId), placementRef: operation.placementId === null ? null : modelHandle(resolvers, "placement", operation.placementId) };
    case "set_fact":
      return { ...base, fact: { factRef: maybeModelHandle(resolvers, "fact", operation.fact.id), subjectRef: modelHandle(resolvers, "entity", operation.fact.subjectId), predicate: operation.fact.predicate, value: projectModelFactValue(operation.fact.value, resolvers), description: operation.fact.description } };
    case "remove_fact":
      return { ...base, factRef: modelHandle(resolvers, "fact", operation.factId) };
    case "create_agent":
      return { ...base, agent: { agentRef: maybeModelHandle(resolvers, "agent", operation.agent.id), entityRef: modelHandle(resolvers, "entity", operation.agent.entityId) } };
    case "remove_agent":
      return { ...base, agentRef: modelHandle(resolvers, "agent", operation.agentId) };
    default:
      return base;
  }
}

function projectModelHistory(
  state: Readonly<SimulationState>,
  resolvers: ModelReferenceResolvers,
): unknown[] {
  return state.history.map((step) => ({
    revision: step.revision,
    step: step.step,
    actions: step.actions.map((action) => projectModelAction(action, resolvers.existing)),
    outcomes: step.outcomes.map((outcome) => projectModelOutcome(outcome, resolvers)),
    checks: step.checks.map((check) => projectModelCheckResult(check, resolvers)),
    randomResults: step.randomResults.map((result) => projectModelRandomResult(result, resolvers)),
    resolutionPlans: step.resolutionPlans.map((plan) => projectModelResolutionPlan(plan, resolvers)),
    events: step.events.map((event) => projectModelEvent(event, resolvers.existing)),
    observations: step.observations.map((observation) => projectModelObservation(observation, resolvers)),
    operations: step.operations.map((operation, index) => projectModelOperation(
      operation,
      modelHandle(resolvers, "operation", `${step.revision}:${index}:${operation.kind}`),
      resolvers,
    )),
  }));
}

function projectModelTransitionProposal(
  proposal: Readonly<TransitionProposal>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  const operationRefs = proposal.operations.map((operation, index) =>
    modelHandle(resolvers, "operation", `${index}:${operation.kind}`));
  return {
    baseRevision: proposal.baseRevision,
    outcomes: proposal.outcomes.map((outcome) => projectModelOutcome(outcome, resolvers)),
    mechanicInvocations: proposal.mechanicInvocations.map((invocation) => ({
      invocationRef: modelHandle(resolvers, "mechanic", invocation.id),
      packageId: invocation.packageId,
      ruleId: invocation.ruleId,
      input: structuredClone(invocation.input),
      causes: invocation.causes.map((cause) => projectModelCausalRef(cause, resolvers)),
      assertions: invocation.assertions.map((assertion) => projectModelCausalAssertion(assertion, resolvers)),
    })),
    operations: proposal.operations.map((operation, index) => projectModelOperation(operation, operationRefs[index]!, resolvers)),
    events: proposal.events.map((event) => ({
      eventRef: modelHandle(resolvers, "event", event.id),
      description: event.description,
      impact: event.impact,
      causes: event.causes.map((cause) => projectModelCausalRef(cause, resolvers)),
    })),
    observations: proposal.observations.map((observation) => projectModelObservation(observation, resolvers)),
    decisionRequests: proposal.decisionRequests.map((request) => ({
      agentRef: modelHandle(resolvers, "agent", request.agentId),
      prompt: request.prompt,
      possibleNextActions: [...request.possibleNextActions],
    })),
  };
}

function projectModelAssertionResult(
  result: Readonly<CausalAssertionResult>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    target: {
      kind: result.target.kind,
      ref: modelHandle(resolvers, result.target.kind === "activity" ? "activity" : result.target.kind, result.target.id),
    },
    assertion: projectModelCausalAssertion(result.assertion, resolvers),
    passed: result.passed,
    observed: structuredClone(result.observed),
  };
}

function projectModelCommitmentRound(
  round: Readonly<CommitmentRound>,
  resolvers: ModelReferenceResolvers,
): Record<string, unknown> {
  return {
    kind: round.kind,
    ...(round.kind === "check" ? { phase: round.phase } : {}),
    requestRefs: round.requestIds.map((id) => modelHandle(resolvers, round.kind === "check" ? "check" : "random", id)),
  };
}

function resolutionPlanReferenceCandidates(
  plans: readonly ResolutionPlan[],
): ReferenceCandidateInput[] {
  return plans.flatMap((plan) => [
    {
      kind: "plan" as const,
      engineId: plan.id,
      label: plan.goal,
      meaning: "a resolution plan under review or committed within this candidate, not a committed world change",
      allowedUses: ["target", "assertion"] as const,
      visibility: "role" as const,
      statePath: `candidatePlans.${plan.id}`,
    },
    ...[plan.primaryEffect, plan.secondaryEffect, plan.threatenedEffect]
      .filter((effect): effect is NonNullable<typeof effect> => effect !== null)
      .flatMap((effect) => {
        const profileIds = effect.kind === "meter"
          ? [effect.impactProfileId]
          : [effect.conditionProfileId, effect.durationProfileId].filter((id): id is string => id !== null);
        return [
          { kind: effect.kind === "meter" ? "meter" as const : "condition" as const, engineId: effect.kind === "meter" ? effect.meterId : effect.conditionId, label: effect.label, meaning: "a planned effect channel; this reference alone does not establish a condition in canonical truth", allowedUses: ["assertion", "source"] as const, visibility: "role" as const },
          ...profileIds.map((id) => ({ kind: "mechanic" as const, engineId: id, label: id, meaning: "an authored mechanic profile used by a committed resolution plan", allowedUses: ["mechanic", "source"] as const, visibility: "role" as const })),
        ];
      }),
    ...(plan.actorRatingId ? [{ kind: "rating" as const, engineId: plan.actorRatingId, label: plan.actorRatingId, meaning: "an actor rating used by a committed resolution plan", allowedUses: ["modifier", "assertion", "source"] as const, visibility: "role" as const }] : []),
    ...(plan.difficulty?.kind === "opposed" ? [{ kind: "rating" as const, engineId: plan.difficulty.ratingId, label: plan.difficulty.ratingId, meaning: "an opposed target rating used by a committed resolution plan", allowedUses: ["modifier", "assertion", "source"] as const, visibility: "role" as const }] : []),
  ]);
}

/** Project canonical truth into the model vocabulary. Engine ids are retained
 * only inside the resolver closure; every cross-record reference in this
 * projection is a request-local handle. Authored mechanic keys remain visible
 * because they are configuration names, not runtime identities. */
export function projectCanonicalTruthForModel(
  truth: Readonly<SimulationState["truth"]>,
  resolver: ReferenceResolver,
  options: { includeMechanics?: boolean } = {},
): Record<string, unknown> {
  const handle = (kind: Parameters<ReferenceResolver["handleFor"]>[0], id: string) => resolver.handleFor(kind, id);
  const factValue = (value: Readonly<SimulationState["truth"]["facts"][string]["value"]>): unknown =>
    value.kind === "entity"
      ? { kind: "entity", entityRef: handle("entity", value.entityId) }
      : structuredClone(value);
  const access = (value: Readonly<SimulationState["truth"]["facts"][string]["access"]>): unknown =>
    value.kind === "agents"
      ? { kind: value.kind, agentRefs: value.agentIds.map((id) => handle("agent", id)) }
      : structuredClone(value);
  const entities = Object.fromEntries(Object.values(truth.entities).map((entity) => [
    handle("entity", entity.id), {
      kind: entity.kind,
      name: entity.name,
      description: entity.description,
      lifecycle: entity.lifecycle,
      placementRef: truth.placements[entity.id] ? handle("placement", truth.placements[entity.id]!) : null,
    },
  ]));
  const placements = Object.fromEntries(Object.entries(truth.placements).map(([entityId, containerId]) => [
    handle("placement", entityId),
    containerId ? handle("placement", containerId) : null,
  ]));
  const facts = Object.fromEntries(Object.values(truth.facts).map((fact) => [
    handle("fact", fact.id), {
      subjectRef: handle("entity", fact.subjectId),
      predicate: fact.predicate,
      value: factValue(fact.value),
      description: fact.description,
      access: access(fact.access),
    },
  ]));
  const meters = Object.fromEntries(Object.values(truth.meters).map((meter) => [
    handle("meter", meter.id), {
      definitionId: meter.definitionId,
      entityRef: handle("entity", meter.entityId),
      current: meter.current,
      firedThresholdIds: [...meter.firedThresholdIds],
    },
  ]));
  const quantities = Object.fromEntries(Object.values(truth.quantities).map((quantity) => [
    handle("quantity", quantity.id), {
      definitionId: quantity.definitionId,
      holderRef: handle("entity", quantity.holderId),
      amount: quantity.amount,
    },
  ]));
  const ratings = Object.fromEntries(Object.values(truth.ratings).map((rating) => [
    handle("rating", rating.id), {
      definitionId: rating.definitionId,
      entityRef: handle("entity", rating.entityId),
      value: rating.value,
    },
  ]));
  const conditions = Object.fromEntries(Object.values(truth.conditions).map((condition) => [
    handle("condition", condition.id), {
      subjectRef: handle("entity", condition.subjectId),
      label: condition.label,
      description: condition.description,
      magnitude: condition.magnitude,
      conditionProfileId: condition.conditionProfileId,
      durationProfileId: condition.durationProfileId,
      access: access(condition.access),
    },
  ]));
  const activities = Object.fromEntries(Object.values(truth.activities).map((activity) => [
    handle("activity", activity.id), {
      actorRef: handle("agent", activity.actorId),
      participantAgentRefs: activity.participantAgentIds.map((id) => handle("agent", id)),
      status: activity.status,
      sourceActionRef: handle("action", activity.sourceActionId),
      description: ("plan" in activity ? activity.plan : activity.planDraft).description,
      completionAtSeconds: "plan" in activity ? activity.plan.completionAtSeconds : null,
    },
  ]));
  const timers = Object.fromEntries(Object.values(truth.timers).map((timer) => [
    handle("timer", timer.id), {
      wakeAgentRefs: timer.wakeAgentIds.map((id) => handle("agent", id)),
      causes: timer.causes.map((cause) => ({
        kind: cause.kind,
        ref: handle(cause.kind as Parameters<ReferenceResolver["handleFor"]>[0], cause.id),
      })),
      assertions: timer.assertions.map((assertion) => projectModelCausalAssertion(assertion, { existing: resolver })),
    },
  ]));
  const events = Object.fromEntries(Object.values(truth.events).map((event) => [
    handle("event", event.id), {
      description: event.description,
      impact: event.impact,
      causes: event.causes.map((cause) => ({ kind: cause.kind, ref: handle(cause.kind, cause.id) })),
    },
  ]));
  const projected: Record<string, unknown> = {
    elapsedSeconds: truth.elapsedSeconds,
    entities,
    placements,
    facts,
    factTombstones: truth.factTombstones.map((id) => handle("fact", id)),
    meters,
    quantities,
    ratings,
    conditions,
    activities,
    timers,
    events,
    sharedActivityResourcePools: Object.fromEntries(Object.values(truth.sharedActivityResourcePools).map((pool) => [
      handle("shared_resource_pool", pool.id), {
        definitionId: pool.definitionId,
        entityRef: handle("entity", pool.entityId),
        capacity: pool.capacity,
      },
    ])),
  };
  if (options.includeMechanics !== false) projected.mechanics = structuredClone(truth.mechanics);
  return projected;
}

function projectActivityTemporalContext(state: SimulationState, boundary: TemporalBoundary | undefined,
  resolver: ReferenceResolver, activities: SimulationState["truth"]["activities"]): Record<string, unknown> {
  if (!boundary) return {};
  return { temporalExecution: activityTemporalEvidence({ worldHash: state.worldHash, revision: state.revision,
    activities: Object.values(activities), boundary, resolver,
    projectAssertion: assertion => projectModelCausalAssertion(assertion, { existing: resolver, worldHash: state.worldHash }),
  }) };
}

type ModelActionView = {
  actionRef: string;
  actorRef: string;
  rawText: string;
  goal: string;
  means: string | null;
  targetRefs: string[];
};

export function projectModelAction(
  action: Readonly<AgentActionProposal>,
  resolver: ReferenceResolver,
): ModelActionView {
  const tryHandle = (kind: Parameters<ReferenceResolver["handleFor"]>[0], id: string): string | null => {
    try {
      return resolver.handleFor(kind, id);
    } catch {
      return null;
    }
  };
  return {
    actionRef: resolver.handleFor("action", action.id),
    actorRef: resolver.handleFor("agent", action.actorId),
    rawText: action.rawText,
    goal: action.goal,
    means: action.means,
    targetRefs: action.targetIds
      .map((targetId) => tryHandle("local_entity", `${action.actorId}::${targetId}`))
      .filter((reference): reference is string => reference !== null),
  };
}

export function projectModelEvent(
  event: Readonly<WorldEvent>,
  resolver: ReferenceResolver,
): Record<string, unknown> {
  const refFor = (entry: { kind: string; id: string }): string => {
    const kind = entry.kind === "global" ? "world" : entry.kind;
    return resolver.handleFor(kind as Parameters<ReferenceResolver["handleFor"]>[0], entry.id);
  };
  return {
    eventRef: resolver.handleFor("event", event.id),
    description: event.description,
    impact: event.impact,
    causes: event.causes.map((cause) => ({ kind: cause.kind, ref: refFor(cause) })),
  };
}

function projectModelGrounding(
  grounding: Readonly<InteractionDependency>,
  resolver: ReferenceResolver,
): Record<string, unknown> {
  const kind = grounding.kind;
  const ref = resolver.handleFor(kind, grounding.id);
  const refFor = (entry: { kind: string; id: string }): string => {
    const kind = entry.kind === "global" ? "world" : entry.kind;
    return resolver.handleFor(kind as Parameters<ReferenceResolver["handleFor"]>[0], entry.id);
  };
  return {
    kind,
    ref,
    actorRef: grounding.actorId === null ? null : resolver.handleFor("agent", grounding.actorId),
    requiredExistingRefs: grounding.reads.map(refFor),
    potentiallyAffectedExistingRefs: grounding.writes.map(refFor),
    audienceAgentRefs: grounding.audienceAgentIds.map((agentId) => resolver.handleFor("agent", agentId)),
    sharedResourceClaims: grounding.sharedResourceClaims.map((claim) => ({
      resourcePoolRef: resolver.handleFor("shared_resource_pool", claim.poolId),
      amount: claim.amount,
      unit: claim.basis.kind === "explicit_quantity" ? claim.basis.unit : null,
      basis: claim.basis.kind,
    })),
  };
}

function projectModelGroundings(
  groundings: readonly InteractionDependency[],
  resolver: ReferenceResolver,
): Record<string, unknown>[] {
  return groundings.map((grounding) => projectModelGrounding(grounding, resolver));
}

function scopedActors(
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  groundings: readonly InteractionDependency[],
  observerIds: readonly string[] = [],
): Record<string, { entityId: string; existingLocalEntityIds: string[]; localEntityBindings: Record<string, string[]> }> {
  const ids = new Set<string>([...actions.map((action) => action.actorId), ...observerIds]);
  groundings.forEach((grounding) => {
    if (grounding.actorId !== null) ids.add(grounding.actorId);
    grounding.audienceAgentIds.forEach((agentId) => ids.add(agentId));
  });
  return Object.fromEntries(Object.values(state.agents)
    .filter((agent) => ids.has(agent.id))
    .map((agent) => [agent.id, {
      entityId: agent.entityId,
      existingLocalEntityIds: Object.keys(agent.belief.localEntities).sort(),
      localEntityBindings: Object.fromEntries(Object.entries(agent.bindings)
        .filter(([, binding]) => binding.canonicalEntityIds.length > 0)
        .map(([localId, binding]) => [localId, [...binding.canonicalEntityIds].sort()])),
    }]));
}

function projectModelActors(
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  groundings: readonly InteractionDependency[],
  resolver: ReferenceResolver,
  observerIds: readonly string[] = [],
): Record<string, unknown>[] {
  const scoped = scopedActors(state, actions, groundings, observerIds);
  return Object.entries(scoped).map(([agentId, actor]) => ({
    agentRef: resolver.handleFor("agent", agentId),
    entityRef: resolver.handleFor("entity", actor.entityId),
    availableLocalEntityRefs: actor.existingLocalEntityIds.flatMap((localId) => {
      try {
        return [resolver.handleFor("local_entity", `${agentId}::${localId}`)];
      } catch {
        return [];
      }
    }),
    boundCanonicalEntityRefs: Object.values(actor.localEntityBindings).flatMap((entityIds) =>
      entityIds.map((entityId) => resolver.handleFor("entity", entityId))),
    localEntityBindings: actor.existingLocalEntityIds.flatMap((localId) => {
      let localEntityRef: string;
      try {
        localEntityRef = resolver.handleFor("local_entity", `${agentId}::${localId}`);
      } catch {
        return [];
      }
      return [{ localEntityRef, canonicalEntityRefs: (actor.localEntityBindings[localId] ?? [])
        .map((entityId) => resolver.handleFor("entity", entityId)) }];
    }),
  }));
}

function perceptionCheckConstraints(
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  groundings: readonly InteractionDependency[],
  resolver: ReferenceResolver,
  observerIds: readonly string[] = [],
): unknown {
  const actorEntityIds = new Set(Object.values(scopedActors(state, actions, groundings, observerIds))
    .map((actor) => actor.entityId));
  return {
    numericRules: { environmentDc: difficultyDc, opposedBaseDc: 10, actorRating: "one owned Rating, exact value, or null" },
    actors: [...actorEntityIds].sort().map((actorId) => ({
      actorRef: resolver.handleFor("entity", actorId),
      ratings: Object.values(state.truth.ratings)
        .filter((rating) => rating.entityId === actorId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((rating) => ({ ratingRef: resolver.handleFor("rating", rating.id), value: rating.value })),
    })),
  };
}

/** Build the one catalog shared by every Truth role for this execution. The
 * catalog carries human-readable meaning while the resolver keeps engine ids
 * private to the server. Keeping this factory here prevents prompt and
 * materialization code from drifting into different handle namespaces. */
export function createTruthReferenceResolver(input: {
  state: Readonly<SimulationState>;
  definition: WorldDefinition;
  actions: readonly AgentActionProposal[];
  observerIds?: readonly string[];
  events?: readonly WorldEvent[];
    outcomes?: readonly ActionOutcome[];
  checkRequests?: readonly D20CheckRequest[];
  randomRequests?: readonly DiscreteRandomRequest[];
  resolutionReceipts?: readonly ResolutionReceipt[];
  observations?: readonly ObservationPacket[];
  includeHistoryActions?: boolean;
  mechanicContracts?: readonly MechanicPromptContract[];
  extraCandidates?: readonly ReferenceCandidateInput[];
}): ReferenceResolver {
  const state = input.state;
  const actions = input.actions;
  const events = input.events ?? [];
  const outcomes = input.outcomes ?? [];
  const checkRequests = input.checkRequests ?? [];
  const randomRequests = input.randomRequests ?? [];
  const resolutionReceipts = input.resolutionReceipts ?? [];
  const observations = [
    ...state.history.flatMap((step) => step.observations),
    ...(input.observations ?? []),
  ];
  const includeHistoryActions = input.includeHistoryActions !== false;
  const compactLabel = (value: string, limit = 160): string =>
    value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
  const historicalAgentIds = new Set([
    ...state.history.flatMap((step) => step.actions.map((action) => action.actorId)),
    ...state.history.flatMap((step) => step.observations.map((observation) => observation.observerId)),
    ...Object.keys(state.historyBase?.agents ?? {}),
  ]);
  const localTargetsByAgent = new Map<string, Set<string>>();
  for (const action of actions) {
    const targets = localTargetsByAgent.get(action.actorId) ?? new Set<string>();
    action.targetIds.forEach((targetId) => targets.add(targetId));
    localTargetsByAgent.set(action.actorId, targets);
  }
  const relevantAgentIds = new Set(actions.map((action) => action.actorId));
  const observerIds = new Set(input.observerIds ?? []);
  const mechanicCandidates = (input.mechanicContracts ?? []).map((contract) => ({
    kind: "mechanic" as const,
    engineId: `${contract.packageId}::${contract.ruleId}`,
    label: `${contract.packageId}/${contract.ruleId}`,
    meaning: contract.description,
    allowedUses: ["mechanic", "source", "cause", "assertion"] as const,
    visibility: "role" as const,
    statePath: `state.world.mechanicContracts.${contract.packageId}.${contract.ruleId}`,
  }));
  const candidates = [
    ...Object.values(state.agents).map((agent) => ({
      kind: "agent" as const, engineId: agent.id, label: agent.id,
      meaning: "an Agent participating in this execution", allowedUses: ["actor", "target", "audience"] as const,
      visibility: "role" as const, statePath: `state.agents.${agent.id}`,
    })),
    ...[...historicalAgentIds]
      .filter((agentId) => !state.agents[agentId])
      .map((agentId) => ({
        kind: "agent" as const, engineId: agentId, label: agentId,
        meaning: "an Agent referenced by committed history",
        allowedUses: ["actor", "target", "audience"] as const,
        visibility: "role" as const,
        statePath: `history.agents.${agentId}`,
      })),
    ...Object.values(state.agents).flatMap((agent) => Object.values(agent.belief.localEntities)
      .filter((entity) => observerIds.has(agent.id) || relevantAgentIds.has(agent.id) && (localTargetsByAgent.get(agent.id)?.has(entity.id) ?? false))
      .map((entity) => ({
      kind: "local_entity" as const,
      engineId: `${agent.id}::${entity.id}`,
      label: entity.name,
      meaning: "an actor-local name used by that Agent; it is not a canonical identity",
      allowedUses: ["target", "subject"] as const,
      visibility: "role" as const,
      statePath: `state.agents.${agent.id}.belief.localEntities.${entity.id}`,
      }))),
    ...observations.flatMap((observation) => {
      const localIds = new Set<string>([
        ...observation.introductions.map((introduction) => introduction.localEntity.id),
        ...observation.apparentClaims.map((claim) => claim.subjectId),
        ...observation.apparentClaims.flatMap((claim) => claim.value.kind === "local_entity" ? [claim.value.localEntityId] : []),
      ]);
      return [...localIds].map((localId) => ({
        kind: "local_entity" as const,
        engineId: `${observation.observerId}::${localId}`,
        label: localId,
        meaning: "an observer-local name already present in delivered evidence",
        allowedUses: ["target", "subject", "evidence", "source", "assertion"] as const,
        visibility: "role" as const,
        statePath: `history.observations.${observation.id}.localEntities.${localId}`,
      }));
    }),
    ...Object.values(state.truth.entities).map((entity) => ({
      kind: "entity" as const, engineId: entity.id, label: entity.name,
      meaning: "an existing canonical world entity", allowedUses: ["actor", "target", "subject", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.entities.${entity.id}`,
    })),
    ...Object.keys(state.truth.placements).map((placementId) => ({
      kind: "placement" as const, engineId: placementId, label: placementId,
      meaning: "an existing world placement/container", allowedUses: ["target", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.placements.${placementId}`,
    })),
    ...Object.values(state.truth.facts).map((fact) => ({
      kind: "fact" as const, engineId: fact.id, label: fact.predicate,
      meaning: "an existing canonical world fact", allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.facts.${fact.id}`,
    })),
    ...Object.values(state.truth.ratings).map((rating) => ({
      kind: "rating" as const, engineId: rating.id, label: rating.definitionId,
      meaning: `a rating owned by ${rating.entityId}`, allowedUses: ["modifier", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.ratings.${rating.id}`,
    })),
    ...Object.values(state.truth.meters).map((meter) => ({
      kind: "meter" as const, engineId: meter.id, label: meter.definitionId,
      meaning: "an existing world meter", allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.meters.${meter.id}`,
    })),
    ...Object.values(state.truth.quantities).map((quantity) => ({
      kind: "quantity" as const, engineId: quantity.id, label: quantity.definitionId,
      meaning: "an existing holder quantity", allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.quantities.${quantity.id}`,
    })),
    ...Object.values(state.truth.mechanics.quantities).map((definition) => ({
      kind: "quantity_definition" as const, engineId: definition.id, label: definition.name,
      meaning: `an authored quantity definition (${definition.unit}) used by a typed mechanic input`,
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.quantities.${definition.id}`,
    })),
    ...Object.values(state.truth.mechanics.meters).map((definition) => ({
      kind: "meter_definition" as const, engineId: definition.id, label: definition.name,
      meaning: "an authored meter definition used by a typed mechanic input",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.meters.${definition.id}`,
    })),
    ...Object.values(state.truth.mechanics.ratings).map((definition) => ({
      kind: "rating_definition" as const, engineId: definition.id, label: definition.name,
      meaning: "an authored rating definition used by a typed mechanic input",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.ratings.${definition.id}`,
    })),
    ...Object.values(state.truth.mechanics.impactProfiles).map((profile) => ({
      kind: "impact_profile" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored impact profile used by a typed mechanic input",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.impactProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.durationProfiles).map((profile) => ({
      kind: "duration_profile" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored duration profile used by a typed mechanic input",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.durationProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.conditionProfiles).map((profile) => ({
      kind: "condition_profile" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored condition profile used by a typed mechanic input",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.conditionProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.entityMechanicsProfiles).map((profile) => ({
      kind: "entity_mechanics_profile" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored entity mechanics profile used by a typed mechanic input",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.world.mechanics.entityMechanicsProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.conditions).map((condition) => ({
      kind: "condition" as const, engineId: condition.id, label: condition.label,
      meaning: "an existing world condition", allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.conditions.${condition.id}`,
    })),
    ...Object.values(state.truth.sharedActivityResourcePools).map((pool) => ({
      kind: "shared_resource_pool" as const, engineId: pool.id, label: pool.definitionId,
      meaning: "an existing shared activity resource pool", allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.sharedActivityResourcePools.${pool.id}`,
    })),
    ...Object.values(state.truth.activities).map((activity) => ({
      kind: "activity" as const, engineId: activity.id, label: ("plan" in activity ? activity.plan : activity.planDraft).description,
      meaning: "an existing scheduled activity whose continuation state may affect this decision",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.activities.${activity.id}`,
    })),
    ...Object.values(state.truth.timers).map((timer) => ({
      kind: "timer" as const, engineId: timer.id, label: timer.id,
      meaning: "an existing timer that may wake an Agent or advance a condition",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.timers.${timer.id}`,
    })),
    ...Object.values(state.truth.events).map((event) => ({
      kind: "event" as const, engineId: event.id, label: event.description,
      meaning: "an already committed world event", allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.events.${event.id}`,
    })),
    ...events.map((event) => ({
      kind: "event" as const, engineId: event.id, label: event.description,
      meaning: "an event produced by the current transition proposal", allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `proposal.events.${event.id}`,
    })),
    ...outcomes.map((outcome) => ({
      kind: "outcome" as const, engineId: outcome.id, label: compactLabel(outcome.summary),
      meaning: "an action outcome proposed by the current transition", allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const, statePath: `proposal.outcomes.${outcome.id}`,
    })),
    ...randomRequests.map((request) => ({
      kind: "random" as const,
      engineId: request.id,
      label: request.distributionId,
      meaning: "a committed random request available to the current stage",
      allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `execution.randomRequests.${request.id}`,
    })),
    ...resolutionReceipts.map((receipt) => ({
      kind: "resolution_receipt" as const,
      engineId: receipt.id,
      label: receipt.plan.goal,
      meaning: "an adjudication receipt available as mechanic input, not an in-world cause",
      allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const,
      statePath: `execution.resolutionReceipts.${receipt.id}`,
    })),
    ...randomRequests.flatMap((request) => request.distribution.steps.map((randomStep) => ({
      kind: "random" as const,
      engineId: randomStep.id,
      label: `${request.distributionId}/${randomStep.id}`,
      meaning: "a step inside the current random distribution",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `execution.randomRequests.${request.id}.distribution.steps.${randomStep.id}`,
    }))),
    ...state.history.flatMap((step) => step.outcomes.map((outcome) => ({
      kind: "outcome" as const,
      engineId: outcome.id,
      label: compactLabel(outcome.summary),
      meaning: "an already committed action outcome",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.outcomes.${outcome.id}`,
    }))),
    ...state.history.flatMap((step) => step.observations.map((observation) => ({
      kind: "observation" as const,
      engineId: observation.id,
      label: compactLabel(observation.summary),
      meaning: "an observation already delivered to an Agent",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.observations.${observation.id}`,
    }))),
    ...state.history.flatMap((step) => step.operations.map((operation, index) => ({
      kind: "operation" as const,
      engineId: `${step.revision}:${index}:${operation.kind}`,
      label: operation.kind,
      meaning: "an already committed deterministic world operation",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.operations.${index}`,
    }))),
    ...state.history.flatMap((step) => step.mechanicInvocations.map((invocation) => ({
      kind: "mechanic" as const,
      engineId: invocation.id,
      label: `${invocation.packageId}/${invocation.ruleId}`,
      meaning: "an already committed mechanic invocation",
      allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.mechanicInvocations.${invocation.id}`,
    }))),
    ...state.history.flatMap((step) => step.resolutionPlans.map((plan) => ({
      kind: "plan" as const,
      engineId: plan.id,
      label: compactLabel(plan.goal),
      meaning: "an already committed resolution plan",
      allowedUses: ["assertion", "source", "target"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.resolutionPlans.${plan.id}`,
    }))),
    ...[
      ...(includeHistoryActions ? state.history.flatMap((step) => step.actions) : []),
      ...Object.values(state.truth.activities).map((activity) => activity.sourceAction),
      ...actions,
    ].map((action) => ({
      kind: "action" as const, engineId: action.id, label: compactLabel(action.rawText),
      meaning: "an action being adjudicated in this step", allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.actionSet.assigned.${action.id}`,
    })),
    ...checkRequests.map((check) => ({
      kind: "check" as const, engineId: check.id, label: check.stakes,
      meaning: "a committed check result available to the current stage", allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `execution.checks.${check.id}`,
    })),
    ...state.history.flatMap((step) => step.checks.map((check) => ({
      kind: "check" as const,
      engineId: check.requestId,
      label: check.requestId,
      meaning: "a committed check result available to this stage",
      allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.checks.${check.requestId}`,
    }))),
    ...state.history.flatMap((step) => step.randomRequests.map((request) => ({
      kind: "random" as const,
      engineId: request.id,
      label: request.distributionId,
      meaning: "a committed random request available to this stage",
      allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.randomRequests.${request.id}`,
    }))),
    ...state.history.flatMap((step) => step.randomRequests.flatMap((request) => request.distribution.steps.map((randomStep) => ({
      kind: "random" as const,
      engineId: randomStep.id,
      label: `${request.distributionId}/${randomStep.id}`,
      meaning: "a step inside a committed random distribution",
      allowedUses: ["assertion", "source"] as const,
      visibility: "role" as const,
      statePath: `history.${step.revision}.randomRequests.${request.id}.distribution.steps.${randomStep.id}`,
    })))),
    ...input.definition.laws.map((law) => ({
      kind: "law" as const, engineId: law.id, label: law.id,
      meaning: "an authored world law", allowedUses: ["cause", "assertion", "source"] as const,
      visibility: "role" as const, statePath: `state.world.laws.${law.id}`,
    })),
    ...Object.values(state.truth.mechanics.impactProfiles).map((profile) => ({
      kind: "mechanic" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored impact profile", allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.mechanics.impactProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.durationProfiles).map((profile) => ({
      kind: "mechanic" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored duration profile", allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.mechanics.durationProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.conditionProfiles).map((profile) => ({
      kind: "mechanic" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored condition profile", allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.mechanics.conditionProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.entityMechanicsProfiles).map((profile) => ({
      kind: "mechanic" as const, engineId: profile.id, label: profile.id,
      meaning: "an authored entity mechanics profile", allowedUses: ["mechanic", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.mechanics.entityMechanicsProfiles.${profile.id}`,
    })),
    ...Object.values(state.truth.mechanics.temporalProfiles).map((profile) => ({
      kind: "temporal_profile" as const, engineId: profile.id, label: profile.name,
      meaning: "an authored temporal profile selectable by the action compiler", allowedUses: ["profile", "source"] as const,
      visibility: "role" as const, statePath: `state.truth.mechanics.temporalProfiles.${profile.id}`,
    })),
    ...input.definition.randomDistributions.map((distribution) => ({
      kind: "random_distribution" as const,
      engineId: distribution.id,
      label: distribution.id,
      meaning: "an authored random distribution selectable for a committed random request",
      allowedUses: ["distribution", "source"] as const,
      visibility: "role" as const,
      statePath: `state.world.randomDistributions.${distribution.id}`,
    })),
    ...mechanicCandidates,
    { kind: "world" as const, engineId: "world", label: "world", meaning: "world-wide arbitration scope", allowedUses: ["conflict"] as const, visibility: "role" as const },
    ...(input.extraCandidates ?? []),
  ] satisfies ReferenceCandidateInput[];
  const causalKinds = new Set(["action", "check", "random", "event", "fact", "law", "mechanic"]);
  const invalidCausalCandidate = candidates.find((candidate) =>
    candidate.allowedUses.some((use) => use === "cause") && !causalKinds.has(candidate.kind));
  if (invalidCausalCandidate) {
    throw new Error(
      `Truth reference candidate ${invalidCausalCandidate.kind}:${invalidCausalCandidate.engineId} ` +
      "advertises cause use but is not a model causal-reference kind",
    );
  }
  return createReferenceResolver(candidates);
}

export function buildTruthContext(input: {
  definition: WorldDefinition;
  state: SimulationState;
  workset: ModelWorkset<SimulationState, AgentActionProposal, InteractionDependency>;
  reactionRequests: readonly ReactionRequest[];
  reactionDecisions: readonly ReactionDecision[];
  reactionWindow: "open" | "closed";
  committedCheckRequests: readonly D20CheckRequest[];
  checkResults: readonly D20CheckResult[];
  committedRandomRequests: readonly DiscreteRandomRequest[];
  randomResults: readonly DiscreteRandomResult[];
  commitmentRounds: readonly CommitmentRound[];
  resolutionPlans: readonly ResolutionPlan[];
  resolutionReceipts: readonly ResolutionReceipt[];
  temporalBoundary: TemporalBoundary;
  instanceId: string;
  advanceId: string;
  issues: readonly PromptValidationIssue[];
  temporalEvidence?: TemporalBoundary;
  includeResolutionMeansSources?: boolean;
  planCauseActionIds?: readonly string[];
  includeResolutionFactEvidence?: boolean;
  perceptionTargets?: readonly PerceptionTarget[];
  stage?: "perception" | "reaction-routing" | "resolution" | "transition";
  includeHistoryActions?: boolean;
  resolutionScope?: ResolutionScope;
  candidateResolutionPlans?: readonly ResolutionPlan[];
  mechanicContracts?: readonly MechanicPromptContract[];
  repairTarget?: RepairTarget | null;
}): unknown {
  if (input.temporalEvidence && contentHash(input.temporalEvidence) !== contentHash(input.temporalBoundary)) throw new Error("temporal evidence boundary mismatch");
  const stage = input.stage ?? "transition";
  const factEvidence = stage === "resolution" && input.includeResolutionFactEvidence;
  if (factEvidence && !input.includeResolutionMeansSources) throw new Error("resolution fact evidence requires source inventory");
  const contextMode = input.workset.mode ?? "scoped";
  const availableState = input.workset.state;
  const availableActions = input.workset.availableActions;
  const initialActions = input.workset.initialActions;
  const availableGroundings = input.workset.availableDependencies;
  const assignedActions = input.workset.assignedActions;
  const assignedGroundings = input.workset.assignedDependencies;
  const canReuseFullProjection = contextMode === "full" &&
    input.committedCheckRequests.length === 0 && input.committedRandomRequests.length === 0;
  const projection = canReuseFullProjection
    ? cachedFullTruthProjection(availableState, availableActions, input.definition, contentHash({
      observations: input.reactionRequests.map(request => request.stimulus), resolutionReceipts: input.resolutionReceipts,
      includeHistoryActions: input.includeHistoryActions, mechanicContracts: input.mechanicContracts,
    }), () => {
      const resolver = createTruthReferenceResolver({
        state: availableState,
        definition: input.definition,
        actions: availableActions,
        observations: input.reactionRequests.map((request) => request.stimulus),
        resolutionReceipts: input.resolutionReceipts,
        includeHistoryActions: input.includeHistoryActions,
        mechanicContracts: input.mechanicContracts,
      });
      return {
        resolver,
        canonicalTruth: projectCanonicalTruthForModel(availableState.truth, resolver),
      };
    })
    : (() => {
      const resolver = createTruthReferenceResolver({
        state: availableState,
        definition: input.definition,
        actions: availableActions,
        observations: input.reactionRequests.map((request) => request.stimulus),
        resolutionReceipts: input.resolutionReceipts,
        includeHistoryActions: input.includeHistoryActions,
        checkRequests: input.committedCheckRequests,
        randomRequests: input.committedRandomRequests,
        mechanicContracts: input.mechanicContracts,
      });
      const visibleTruth = contextMode === "full"
        ? availableState.truth
        : scopedCanonicalTruth(input.state, availableActions, availableGroundings);
      return { resolver, canonicalTruth: projectCanonicalTruthForModel(visibleTruth, resolver) };
    })();
  // Resolution plans introduce semantic effect handles (for example a
  // condition proposed by a plan) that do not exist in canonical truth yet.
  // Extend the cached base resolver for this request without rebuilding the
  // expensive canonical-truth projection.
  const plansForProjection = [
    ...input.resolutionPlans,
    ...input.resolutionReceipts.map((receipt) => receipt.plan),
    ...(input.candidateResolutionPlans ?? []),
  ];
  const planCandidates = resolutionPlanReferenceCandidates(plansForProjection);
  const observerIds = stage === "perception" ? [...new Set(input.perceptionTargets?.map(target => target.observerId) ?? [])] : [];
  const referenceResolver = planCandidates.length === 0 && observerIds.length === 0
    ? projection.resolver
    : createTruthReferenceResolver({
      state: availableState,
      definition: input.definition,
      actions: availableActions,
      observerIds,
      observations: input.reactionRequests.map((request) => request.stimulus),
      resolutionReceipts: input.resolutionReceipts,
      includeHistoryActions: input.includeHistoryActions,
      checkRequests: input.committedCheckRequests,
      randomRequests: input.committedRandomRequests,
      mechanicContracts: input.mechanicContracts,
      extraCandidates: planCandidates,
    });
  const modelRefs: ModelReferenceResolvers = { existing: referenceResolver, worldHash: input.state.worldHash };
  const promptId: PromptBundleId = stage === "perception"
    ? "truth-perception"
    : stage === "reaction-routing"
      ? "truth-reaction-routing"
      : stage === "resolution"
        ? "truth-resolution"
        : "truth-transition";
  const task = {
    assignment: {
      targetHandles: assignedActions.map((action) => modelHandle({ existing: referenceResolver }, "action", action.id)),
      availableHandles: availableActions.map((action) => modelHandle({ existing: referenceResolver }, "action", action.id)),
      allowedProposalKinds: stage === "transition" ? ["entity", "fact", "agent", "event", "outcome", "mechanic"] : stage === "perception" ? ["local_entity"] : [],
      ...(stage === "perception" && input.perceptionTargets !== undefined ? {
        perceptionTargets: projectPerceptionTargets(input.perceptionTargets, input.state, availableActions, referenceResolver),
      } : {}),
    },
    constraints: [...input.issues.map((issue) => issue.message), ...(input.temporalEvidence ? [ACTIVITY_TEMPORAL_NOTICE] : []), ...(factEvidence ? [RESOLUTION_FACT_EVIDENCE_NOTICE] : []),
      ...(stage === "resolution" && input.candidateResolutionPlans?.length ? [
        "A targeted repair may retain a pending conditionRef only in an effect of the same action, with the same subject and channel as its prior candidate plan. A different effect requires a new proposal. Pending effects are not existing truth and cannot support means, factors, difficulty or sourceRefs.",
      ] : [])],
    stage,
    resolutionScope: projectResolutionScope(input.resolutionScope, referenceResolver),
    ...(factEvidence ? { planFactEvidence: { contract: RESOLUTION_FACT_EVIDENCE,
      factSnapshotHash: contentHash(projection.canonicalTruth.facts) } } : {}),
    ...(stage === "resolution" && input.planCauseActionIds ? { planCauseScope: {
      contract: PLAN_CAUSE_SCOPE,
      actionRefs: input.planCauseActionIds.map(id => referenceResolver.handleFor("action", id)),
    } } : {}),
  };
  const state = {
    trustBoundary: {
      externalActions: "untrusted-action-attempts",
      assignedActions: "untrusted-action-attempts",
      authoritativeState: "canonicalTruth-and-committed-history-only",
    },
    world: {
      id: input.definition.id,
      name: input.definition.name,
      description: input.definition.description,
      laws: input.definition.laws,
      disclosure: input.definition.disclosure,
      rulePackages: input.definition.rulePackages,
      randomDistributions: input.definition.randomDistributions,
      mechanicContracts: input.mechanicContracts?.map((contract) => ({
        mechanicRef: modelHandle(modelRefs, "mechanic", `${contract.packageId}::${contract.ruleId}`),
        version: contract.version,
        description: contract.description,
        inputSchema: structuredClone(contract.inputSchema),
      })) ?? [],
    },
    baseRevision: input.state.revision,
    step: input.state.step,
    canonicalTruth: projection.canonicalTruth,
    ...(input.temporalEvidence ? projectActivityTemporalContext(availableState, input.temporalEvidence, referenceResolver,
      Object.fromEntries(Object.entries(availableState.truth.activities).filter(([, activity]) =>
        Object.hasOwn(projection.canonicalTruth.activities as Record<string, unknown>, referenceResolver.handleFor("activity", activity.id))))) : {}),
    semanticHistory: projectModelHistory(input.state, modelRefs),
    actionSet: {
      initial: initialActions.map((action) => projectModelAction(action, referenceResolver)),
      assigned: assignedActions.map((action) => {
        const projected = projectModelAction(action, referenceResolver);
        if (stage !== "resolution" || !input.includeResolutionMeansSources) return projected;
        const grounding = assignedGroundings.find(candidate => candidate.kind === "action" && candidate.id === action.id);
        if (!grounding) throw new Error(`resolution source inventory requires grounding for ${action.id}`);
        const refs = projectModelGrounding(grounding, referenceResolver);
        const sources = resolutionMeansSources(referenceResolver.catalog,
          referenceResolver.handleFor("action", action.id), {
            requiredExistingRefs: refs.requiredExistingRefs as string[],
            potentiallyAffectedExistingRefs: refs.potentiallyAffectedExistingRefs as string[],
            globalFallback: grounding.globalFallback,
          });
        return { ...projected, allowedMeansSources: factEvidence
          ? withResolutionFactEvidence(sources, projection.canonicalTruth.facts as Record<string, unknown>) : sources };
      }),
      available: availableActions.map((action) => projectModelAction(action, referenceResolver)),
    },
    dependencySet: {
      assigned: projectModelGroundings(assignedGroundings, referenceResolver),
      available: projectModelGroundings(availableGroundings, referenceResolver),
    },
    committedResolutionPlans: input.resolutionPlans.map((plan) => projectModelResolutionPlan(plan, modelRefs, { includeRef: false })),
    resolutionReceipts: input.resolutionReceipts.map((receipt) => ({
      plan: projectModelResolutionPlan(receipt.plan, modelRefs, { includeRef: false }),
      settled: receipt.settled,
      checkRef: maybeModelHandle(modelRefs, "check", receipt.checkRequestId),
      outcome: receipt.outcome,
    })),
    ...(input.candidateResolutionPlans ? {
      candidateResolutionPlans: input.candidateResolutionPlans.map((plan) => projectModelResolutionPlan(plan, modelRefs)),
    } : {}),
    actors: projectModelActors(
      contextMode === "full" ? availableState : input.state,
      contextMode === "full" ? availableActions : availableActions,
      contextMode === "full" ? availableGroundings : availableGroundings,
      referenceResolver,
      observerIds,
    ),
    temporalBoundary: input.temporalBoundary,
    reactionRequests: input.reactionRequests.map((request) => ({
      requestRef: maybeModelHandle(modelRefs, "operation", request.id),
      agentRef: maybeModelHandle(modelRefs, "agent", request.agentId),
      triggerActionRef: maybeModelHandle(modelRefs, "action", request.triggerActionId),
      originalIntent: request.originalIntent.kind === "prepared_action"
        ? { kind: request.originalIntent.kind, actionRef: maybeModelHandle(modelRefs, "action", request.originalIntent.actionId) }
        : { kind: request.originalIntent.kind, activityRef: maybeModelHandle(modelRefs, "activity", request.originalIntent.activityId), sourceActionRef: maybeModelHandle(modelRefs, "action", request.originalIntent.sourceActionId) },
      stimulus: projectModelObservation(request.stimulus, modelRefs),
      perceptionReceiptHash: request.perceptionReceiptHash,
    })),
    reactionDecisions: input.reactionDecisions.map((decision) => ({
      requestRef: maybeModelHandle(modelRefs, "operation", decision.requestId),
      agentRef: maybeModelHandle(modelRefs, "agent", decision.agentId),
      originalActionRef: maybeModelHandle(modelRefs, "action", decision.originalProposalId),
      source: decision.source,
      kind: decision.kind,
      ...(decision.kind === "keep"
        ? { ongoingActivityDisposition: decision.ongoingActivityDisposition }
        : { replacementAction: projectModelAction(decision.replacementAction, referenceResolver) }),
    })),
    reactionWindow: input.reactionWindow,
    committedCheckRequests: input.committedCheckRequests.map((request) => projectModelCheckRequest(request, modelRefs)),
    checkResults: input.checkResults.map((result) => projectModelCheckResult(result, modelRefs)),
    committedRandomRequests: input.committedRandomRequests.map((request) => projectModelRandomRequest(request, modelRefs)),
    randomResults: input.randomResults.map((result) => projectModelRandomResult(result, modelRefs)),
    commitmentRounds: input.commitmentRounds.map((round) => projectModelCommitmentRound(round, modelRefs)),
    ...(stage === "perception" ? {
      perceptionCheckConstraints: perceptionCheckConstraints(input.state, availableActions, availableGroundings, referenceResolver, observerIds),
    } : {}),
  };
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    roleContract: modelRoleContract(promptId),
    execution: {
      worldId: input.definition.id,
      instanceId: input.instanceId,
      advanceId: input.advanceId,
      revision: input.state.revision,
      step: input.state.step,
    },
    task,
    state,
    referenceCatalog: stage === "perception" ? perceptionReferenceCatalog(referenceResolver, {
      state: input.state, definition: input.definition, actions: availableActions,
      checkRequests: input.committedCheckRequests,
    }) : referenceResolver.catalog,
    repair: input.issues.length > 0 || input.repairTarget
      ? { target: projectRepairTarget(input.repairTarget, referenceResolver)?.targetRef ?? null, issues: input.issues.map(projectPromptIssue) }
      : null,
  };
}

type CausalProposalReferenceInput = {
  definition: WorldDefinition;
  state: SimulationState;
  actions: readonly AgentActionProposal[];
  resolutionPlans: readonly ResolutionPlan[];
  checkRequests: readonly D20CheckRequest[];
  randomRequests: readonly DiscreteRandomRequest[];
  proposal: TransitionProposal;
  mechanicContracts?: readonly MechanicPromptContract[];
};

export function causalProposalReferenceResolver(input: CausalProposalReferenceInput): ReferenceResolver {
  const taskReferenceInputs: ReferenceCandidateInput[] = [
      ...input.resolutionPlans.map((plan) => ({
        kind: "plan" as const,
        engineId: plan.id,
        label: plan.goal,
        meaning: "a committed resolution plan being verified",
        allowedUses: ["target", "assertion", "source"] as const,
        visibility: "role" as const,
      })),
      ...resolutionPlanReferenceCandidates(input.resolutionPlans),
      ...input.proposal.events.map((event) => ({
        kind: "event" as const,
        engineId: event.id,
        label: event.description,
        meaning: "an event produced by the candidate transition",
        allowedUses: ["target", "cause", "assertion", "source"] as const,
        visibility: "role" as const,
      })),
      ...input.checkRequests.map((check) => ({
        kind: "check" as const,
        engineId: check.id,
        label: check.stakes,
        meaning: "a committed check result in this candidate",
        allowedUses: ["target", "cause", "assertion", "source"] as const,
        visibility: "role" as const,
      })),
      ...input.randomRequests.map((request) => ({
        kind: "random" as const,
        engineId: request.id,
        label: request.distributionId,
        meaning: "a committed random result in this candidate",
        allowedUses: ["target", "cause", "assertion", "source"] as const,
        visibility: "role" as const,
      })),
      ...input.randomRequests.flatMap((request) => request.distribution.steps.map((step) => ({
        kind: "random" as const,
        engineId: step.id,
        label: `${request.distributionId}/${step.id}`,
        meaning: "a step inside a committed random distribution in this candidate",
        allowedUses: ["target", "assertion", "source"] as const,
        visibility: "role" as const,
      }))),
      ...input.proposal.operations.map((operation, index) => ({
        kind: "operation" as const,
        engineId: `${index}:${operation.kind}`,
        label: operation.kind,
        meaning: "a deterministic world operation proposed by the candidate transition",
        allowedUses: ["target", "assertion", "source"] as const,
        visibility: "role" as const,
      })),
      ...input.proposal.operations.flatMap((operation): ReferenceCandidateInput[] => {
        if (operation.kind === "create_entity") return [{ kind: "entity" as const, engineId: operation.entity.id, label: operation.entity.name, meaning: "an entity created by the candidate transition", allowedUses: ["target", "subject", "assertion", "source"] as const, visibility: "role" as const }];
        if (operation.kind === "set_fact") return [{ kind: "fact" as const, engineId: operation.fact.id, label: operation.fact.predicate, meaning: "a fact created by the candidate transition", allowedUses: ["target", "assertion", "cause", "source"] as const, visibility: "role" as const }];
        if (operation.kind === "create_agent") return [
          { kind: "agent" as const, engineId: operation.agent.id, label: operation.agent.id, meaning: "an Agent created by the candidate transition", allowedUses: ["actor", "target", "audience"] as const, visibility: "role" as const },
          { kind: "entity" as const, engineId: operation.agent.entityId, label: operation.agent.entityId, meaning: "the entity bound to an Agent created by the candidate transition", allowedUses: ["actor", "target", "subject", "assertion", "source"] as const, visibility: "role" as const },
        ];
        return [];
      }),
      ...input.proposal.mechanicInvocations.map((invocation) => ({
        kind: "mechanic" as const,
        engineId: invocation.id,
        label: `${invocation.packageId}/${invocation.ruleId}`,
        meaning: "a mechanic invocation proposed by the candidate transition",
        allowedUses: ["target", "assertion", "cause", "source"] as const,
        visibility: "role" as const,
        statePath: `candidate.mechanicInvocations.${invocation.id}`,
      })),
      ...input.proposal.outcomes.map((outcome) => ({
        kind: "outcome" as const,
        engineId: outcome.id,
        label: outcome.summary,
        meaning: "an action outcome proposed by the candidate transition",
        allowedUses: ["target", "assertion"] as const,
        visibility: "role" as const,
        statePath: `candidate.outcomes.${outcome.id}`,
      })),
      ...input.proposal.observations.map((observation) => ({
        kind: "observation" as const,
        engineId: observation.id,
        label: observation.summary,
        meaning: "an observation rendered from the candidate transition",
        allowedUses: ["target", "assertion"] as const,
        visibility: "role" as const,
        statePath: `candidate.observations.${observation.id}`,
      })),
    ];
  return createTruthReferenceResolver({
    state: input.state,
    definition: input.definition,
    actions: input.actions,
    observations: input.proposal.observations,
    mechanicContracts: input.mechanicContracts,
    extraCandidates: taskReferenceInputs,
  });
}

/** Locate semantic feedback in the owning component, using its expanded candidate vocabulary. */
export function causalReviewRepairIssues(input: CausalProposalReferenceInput,
  findings: Extract<CausalVerification, { verdict: "reject" }>["findings"]): PromptValidationIssue[] {
  const projected = projectModelTransitionProposal(input.proposal, {
    existing: causalProposalReferenceResolver(input), worldHash: input.state.worldHash,
  });
  return findings.map(finding => {
    const categories: Partial<Record<string, "operations" | "events" | "outcomes" | "mechanicInvocations" | "observations">> = {
      operation: "operations", event: "events", outcome: "outcomes", mechanic: "mechanicInvocations", observation: "observations",
    };
    const category = categories[finding.target.kind];
    if (!category) throw new Error("causal repair target cannot change fixed source evidence");
    const rows = input.proposal[category];
    const index = finding.target.kind === "operation" ? Number(finding.target.id.split(":", 1)[0])
      : rows.findIndex(row => "id" in row && row.id === finding.target.id);
    const target = (projected[category] as unknown[])[index];
    if (!target) throw new Error("causal repair target is absent from its owning component");
    return { code: finding.code, class: "semantic", path: [category, index], originalValue: target,
      message: `Rejected expanded candidate target ${JSON.stringify(target)}: ${finding.message}; ${finding.repairHint}` };
  });
}

/** Preserve evaluator observations; never re-evaluate against the base snapshot. */
export function causalAssertionRepairIssues(
  input: CausalProposalReferenceInput & { failures: readonly CausalAssertionResult[]; evaluationState: SimulationState },
): PromptValidationIssue[] {
  const modelRefs: ModelReferenceResolvers = {
    existing: causalProposalReferenceResolver(input), worldHash: input.state.worldHash,
  };
  const binding = { sourceStateHash: contentHash(input.evaluationState), expandedProposalHash: contentHash(input.proposal) };
  return input.failures.map((failure) => {
    const projected = projectModelAssertionResult(failure, modelRefs);
    // These values carry reference-bearing fields, unlike scalar observations.
    let observed: unknown = structuredClone(failure.observed);
    if (failure.assertion.kind === "fact_matches" && failure.observed !== null) {
      observed = projectModelFactValue(failure.observed as SimulationState["truth"]["facts"][string]["value"], modelRefs);
    } else if (failure.assertion.kind === "placement_equals" || failure.assertion.kind === "placement_not_equals") {
      const value = failure.observed as { known: boolean; placementId: string | null };
      observed = { known: value.known, placementRef: value.placementId === null ? null : modelHandle(modelRefs, "placement", value.placementId) };
    } else if (failure.assertion.kind === "shared_placement") {
      const value = failure.observed as { left: string | null; right: string | null };
      observed = {
        leftPlacementRef: value.left === null ? null : modelHandle(modelRefs, "placement", value.left),
        rightPlacementRef: value.right === null ? null : modelHandle(modelRefs, "placement", value.right),
      };
    }
    const kind = failure.target.kind;
    const evaluation = kind === "operation"
      ? { phase: "before-operation", expandedOperationIndex: Number(failure.target.id.split(":", 1)[0]) }
      : { phase: kind === "mechanic" ? "base-state" : "after-all-operations" };
    const outcome = kind === "outcome" ? input.proposal.outcomes.find((item) => item.id === failure.target.id) : undefined;
    const evidence = {
      ...projected, observed, evaluation, binding,
      ...(outcome ? { actionRef: modelHandle(modelRefs, "action", outcome.proposalId) } : {}),
    };
    return {
      code: "causal_assertion_failed", class: "semantic", path: [],
      originalValue: evidence,
      message: `causal assertions failed: ${JSON.stringify(evidence)}`,
    };
  });
}

export function buildCausalVerificationContext(input: {
  definition: WorldDefinition;
  state: SimulationState;
  workset: ModelWorkset<SimulationState, AgentActionProposal, InteractionDependency>;
  checkRequests: readonly D20CheckRequest[];
  checkResults: readonly D20CheckResult[];
  randomRequests: readonly DiscreteRandomRequest[];
  randomResults: readonly DiscreteRandomResult[];
  commitmentRounds: readonly CommitmentRound[];
  resolutionPlans: readonly ResolutionPlan[];
  resolutionReceipts: readonly ResolutionReceipt[];
  proposal: TransitionProposal;
  assertionResults: readonly CausalAssertionResult[];
  mechanicResults: readonly MechanicResult[];
  previousReport: CausalVerification | null;
  reactionDecisions?: readonly ReactionDecision[];
  instanceId: string;
  advanceId: string;
  issues: readonly PromptValidationIssue[];
  temporalEvidence?: TemporalBoundary;
  candidateTemporalState?: Readonly<TemporalStateSnapshot>;
  resolutionScope?: ResolutionScope;
  mechanicContracts?: readonly MechanicPromptContract[];
  repairTarget?: RepairTarget | null;
}): unknown {
  const contextMode = input.workset.mode ?? "scoped";
  const availableState = input.workset.state;
  const availableActions = input.workset.availableActions;
  const availableGroundings = input.workset.availableDependencies;
  const referenceResolver = causalProposalReferenceResolver({
    ...input, state: availableState, actions: [...new Map([...input.workset.initialActions, ...availableActions]
      .map(action => [action.id, action])).values()],
  });
  const visibleTruth = contextMode === "full"
    ? availableState.truth
    : scopedCanonicalTruth(input.state, availableActions, availableGroundings);
  const modelRefs: ModelReferenceResolvers = { existing: referenceResolver, worldHash: input.state.worldHash };
  if (input.reactionDecisions?.some(decision => decision.baseRevision !== input.state.revision)) {
    throw new Error("causal review reaction evidence has a stale revision");
  }
  const task = {
    assignment: {
      targetHandles: input.workset.assignedActions.map((action) => modelHandle({ existing: referenceResolver }, "action", action.id)),
      availableHandles: availableActions.map((action) => modelHandle({ existing: referenceResolver }, "action", action.id)),
      allowedProposalKinds: ["operation", "event", "outcome", "mechanic"],
    },
    constraints: [...input.issues.map((issue) => issue.message), ...(input.temporalEvidence ? [ACTIVITY_TEMPORAL_NOTICE] : [])],
    resolutionScope: projectResolutionScope(input.resolutionScope, referenceResolver),
  };
  const state = {
    world: {
      id: input.definition.id,
      laws: input.definition.laws,
      rulePackages: input.definition.rulePackages,
      randomDistributions: input.definition.randomDistributions,
      mechanicContracts: input.mechanicContracts?.map((contract) => ({
        mechanicRef: modelHandle(modelRefs, "mechanic", `${contract.packageId}::${contract.ruleId}`),
        version: contract.version,
        description: contract.description,
        inputSchema: structuredClone(contract.inputSchema),
      })) ?? [],
    },
    baseRevision: input.state.revision,
    canonicalTruth: projectCanonicalTruthForModel(visibleTruth, referenceResolver),
    ...projectActivityTemporalContext(availableState, input.temporalEvidence, referenceResolver, visibleTruth.activities),
    ...(input.candidateTemporalState ? { candidateTemporalExecution: {
      sourceHash: contentHash(input.candidateTemporalState),
      ...projectActivityTemporalContext(availableState, input.temporalEvidence, referenceResolver,
        input.candidateTemporalState.activities),
      timers: projectCanonicalTruthForModel({ ...visibleTruth, ...input.candidateTemporalState }, referenceResolver).timers,
    } } : {}),
    semanticHistory: projectModelHistory(availableState, modelRefs),
    actionSet: {
      initial: input.workset.initialActions.map((action) => projectModelAction(action, referenceResolver)),
      assigned: input.workset.assignedActions.map((action) => projectModelAction(action, referenceResolver)),
      available: availableActions.map((action) => projectModelAction(action, referenceResolver)),
    },
    dependencySet: {
      assigned: projectModelGroundings(input.workset.assignedDependencies, referenceResolver),
      available: projectModelGroundings(availableGroundings, referenceResolver),
    },
    committedCheckRequests: input.checkRequests.map((request) => projectModelCheckRequest(request, modelRefs)),
    checkResults: input.checkResults.map((result) => projectModelCheckResult(result, modelRefs)),
    committedRandomRequests: input.randomRequests.map((request) => projectModelRandomRequest(request, modelRefs)),
    randomResults: input.randomResults.map((result) => projectModelRandomResult(result, modelRefs)),
    commitmentRounds: input.commitmentRounds.map((round) => projectModelCommitmentRound(round, modelRefs)),
    committedResolutionPlans: input.resolutionPlans.map((plan) => projectModelResolutionPlan(plan, modelRefs)),
    resolutionReceipts: input.resolutionReceipts.map((receipt) => ({
      planRef: modelHandle(modelRefs, "plan", receipt.plan.id),
      settled: receipt.settled,
      checkRef: maybeModelHandle(modelRefs, "check", receipt.checkRequestId),
      outcome: receipt.outcome,
      effectCount: receipt.effects.length,
      operationCount: receipt.operations.length,
    })),
    reactionEvidence: {
      status: input.reactionDecisions === undefined ? "unavailable" : "provided",
      sourceHash: input.reactionDecisions === undefined ? null : contentHash(input.reactionDecisions),
      decisions: (input.reactionDecisions ?? []).map((decision, sourceIndex) => ({
        sourceIndex,
        agentRef: modelHandle(modelRefs, "agent", decision.agentId),
        baseRevision: decision.baseRevision,
        originalActionRef: maybeModelHandle(modelRefs, "action", decision.originalProposalId),
        source: decision.source,
        kind: decision.kind,
        ...(decision.kind === "keep"
          ? { ongoingActivityDisposition: decision.ongoingActivityDisposition }
          : { replacementAction: {
            actionRef: maybeModelHandle(modelRefs, "action", decision.replacementAction.id),
            actorRef: modelHandle(modelRefs, "agent", decision.replacementAction.actorId),
            baseRevision: decision.replacementAction.baseRevision,
            rawText: decision.replacementAction.rawText,
            goal: decision.replacementAction.goal,
            means: decision.replacementAction.means,
            targetLocalIds: [...decision.replacementAction.targetIds],
          } }),
      })),
    },
    candidate: projectModelTransitionProposal(input.proposal, modelRefs),
    mechanicResults: input.mechanicResults.map((result) => ({
      invocationRef: modelHandle(modelRefs, "mechanic", result.invocationId),
      packageId: result.packageId,
      ruleId: result.ruleId,
      code: result.code,
      operationCount: result.operations.length,
    })),
    deterministicAssertionResults: input.assertionResults.map((result) => projectModelAssertionResult(result, modelRefs)),
    previousReport: input.previousReport === null ? null : {
        verdict: input.previousReport.verdict,
        findings: input.previousReport.verdict === "reject"
        ? input.previousReport.findings.map((finding) => ({
            target: { kind: finding.target.kind, targetHandle: modelHandle(modelRefs, finding.target.kind, finding.target.id) },
            evidenceHandles: [],
            code: finding.code,
            message: finding.message,
            repairHint: finding.repairHint,
          }))
        : [],
    },
    repairTarget: projectRepairTarget(input.repairTarget, referenceResolver),
  };
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    roleContract: modelRoleContract("causal-verifier"),
    referenceCatalog: referenceResolver.catalog,
    execution: {
      worldId: input.definition.id,
      instanceId: input.instanceId,
      advanceId: input.advanceId,
      revision: input.state.revision,
      step: input.state.step,
    },
    task,
    state,
    repair: input.issues.length > 0 || input.repairTarget
      ? { target: projectRepairTarget(input.repairTarget, referenceResolver)?.targetRef ?? null, issues: input.issues.map(projectPromptIssue) }
      : null,
  };
}

export function buildResolutionPlanVerificationContext(input: {
  definition: WorldDefinition;
  state: SimulationState;
  workset: ModelWorkset<SimulationState, AgentActionProposal, InteractionDependency>;
  plans: readonly ResolutionPlan[];
  commitmentRounds: readonly CommitmentRound[];
  instanceId: string;
  advanceId: string;
  issues: readonly PromptValidationIssue[];
  temporalBoundary: TemporalBoundary;
  temporalEvidence?: TemporalBoundary;
  resolutionScope?: ResolutionScope;
}): unknown {
  if (input.temporalEvidence && contentHash(input.temporalEvidence) !== contentHash(input.temporalBoundary)) throw new Error("temporal evidence boundary mismatch");
  const contextMode = input.workset.mode ?? "scoped";
  const availableState = input.workset.state;
  const availableActions = input.workset.availableActions;
  const availableGroundings = input.workset.availableDependencies;
  const taskReferenceInputs: ReferenceCandidateInput[] = [
    ...input.plans.map((plan) => ({
      kind: "plan" as const,
      engineId: plan.id,
      label: plan.goal,
      meaning: "a committed resolution plan under review",
      allowedUses: ["target", "assertion"] as const,
      visibility: "role" as const,
      statePath: `candidatePlans.${plan.id}`,
    })),
    ...resolutionPlanReferenceCandidates(input.plans),
  ];
  const referenceResolver = createTruthReferenceResolver({
    state: availableState,
    definition: input.definition,
    actions: availableActions,
    extraCandidates: taskReferenceInputs,
  });
  const visibleTruth = contextMode === "full"
    ? availableState.truth
    : scopedCanonicalTruth(input.state, availableActions, availableGroundings);
  const modelRefs: ModelReferenceResolvers = { existing: referenceResolver, worldHash: input.state.worldHash };
  const { mechanics, ...canonicalTruth } = projectCanonicalTruthForModel(visibleTruth, referenceResolver);
  const task = {
    assignment: {
      targetHandles: availableActions.map((action) => modelHandle({ existing: referenceResolver }, "action", action.id)),
      availableHandles: availableActions.map((action) => modelHandle({ existing: referenceResolver }, "action", action.id)),
      allowedProposalKinds: ["plan"],
    },
    constraints: [...input.issues.map((issue) => issue.message), ...(input.temporalEvidence ? [ACTIVITY_TEMPORAL_NOTICE] : [])],
    resolutionScope: projectResolutionScope(input.resolutionScope, referenceResolver),
  };
  const state = {
    world: { id: input.definition.id, laws: input.definition.laws, rulePackages: input.definition.rulePackages, mechanics },
    baseRevision: input.state.revision,
    canonicalTruth,
    temporalBoundary: structuredClone(input.temporalBoundary),
    ...projectActivityTemporalContext(availableState, input.temporalEvidence, referenceResolver, visibleTruth.activities),
    semanticHistory: projectModelHistory(availableState, modelRefs),
    actionSet: {
      initial: input.workset.initialActions.map((action) => projectModelAction(action, referenceResolver)),
      assigned: input.workset.assignedActions.map((action) => projectModelAction(action, referenceResolver)),
      available: availableActions.map((action) => projectModelAction(action, referenceResolver)),
    },
    dependencySet: {
      assigned: projectModelGroundings(input.workset.assignedDependencies, referenceResolver),
      available: projectModelGroundings(availableGroundings, referenceResolver),
    },
    candidateResolutionPlans: input.plans.map((plan) => projectModelResolutionPlan(plan, modelRefs)),
    priorCommitmentRounds: input.commitmentRounds.map((round) => projectModelCommitmentRound(round, modelRefs)),
  };
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    roleContract: modelRoleContract("resolution-plan-verifier"),
    referenceCatalog: referenceResolver.catalog,
    execution: {
      worldId: input.definition.id,
      instanceId: input.instanceId,
      advanceId: input.advanceId,
      revision: input.state.revision,
      step: input.state.step,
    },
    task,
    state,
    repair: input.issues.length > 0
      ? { target: null, issues: input.issues.map(projectPromptIssue) }
      : null,
  };
}

interface AgentContextInput {
  state: SimulationState;
  agent: AgentState;
  observations: readonly ObservationPacket[];
  events: readonly WorldEvent[];
  currentAction: AgentActionProposal | null;
  currentOutcome: Pick<ActionOutcome, "status"> | null;
  instanceId: string;
  advanceId: string;
  issues: readonly PromptValidationIssue[];
}

export function buildAgentSharedContext(input: Pick<AgentContextInput, "state" | "instanceId" | "advanceId"> & {
  promptId?: "agent-bootstrap" | "agent-mind";
}) {
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    roleContract: modelRoleContract(input.promptId ?? "agent-mind"),
    execution: {
      worldId: input.state.worldId,
      instanceId: input.instanceId,
      advanceId: input.advanceId,
      revision: input.state.revision,
      step: input.state.step,
    },
  };
}

export function buildAgentSlotContext(input: Omit<AgentContextInput, "instanceId" | "advanceId">) {
  const currentEvents = new Map(input.events
    .filter((event) => event.step === input.state.step)
    .map((event) => [event.id, event]));
  const resolver = createAgentReferenceResolver(input.agent, input.observations);
  const projectOwnAction = (action: AgentActionProposal) => ({
    rawText: action.rawText,
    goal: action.goal,
    means: action.means,
    targetHandles: action.targetIds.flatMap((targetId) => {
      try { return [resolver.handleFor("local_entity", targetId)]; }
      catch { return []; }
    }),
  });
  return {
    referenceCatalog: resolver.catalog,
    task: {
      assignment: {
        targetHandles: [],
        availableHandles: resolver.catalog.candidates.map((candidate) => candidate.handle),
        allowedProposalKinds: ["local_entity", "claim", "evidence"],
      },
      constraints: input.issues.map((issue) => issue.message),
    },
    state: {
      perspective: projectAgentPerspectiveForModel(input.state, input.agent, resolver),
      currentResolution: {
        ownAction: input.currentAction ? projectOwnAction(input.currentAction) : null,
        perceivedOutcome: input.currentOutcome,
      },
      observations: input.observations.map((observation) => projectAgentObservation(observation, resolver)),
      characterUpdatePolicy: {
        rule: "每个 character change 的 source observation 必须来自 eligible=true 的 Observation；没有 eligible source 时不得修改 character。",
        sources: input.observations.map((observation) => {
          const eventBasis = observation.sourceEventIds.flatMap((eventId) => {
            const event = currentEvents.get(eventId);
            return event ? [{ impact: event.impact }] : [];
          });
          return {
            observationRef: resolver.handleFor("observation", observation.id),
            eligible: observation.observerId === input.agent.id && observation.step === input.state.step &&
              eventBasis.length > 0,
              eventBasis: eventBasis.map(({ impact }) => ({ impact })),
          };
        }),
      },
    },
    repair: input.issues.length > 0 ? { target: resolver.handleFor("agent", input.agent.id), issues: input.issues.map(projectPromptIssue) } : null,
  };
}

export function buildAgentContext(input: AgentContextInput): unknown {
  return {
    ...buildAgentSharedContext(input),
    ...buildAgentSlotContext(input),
  };
}

export function buildReactionContext(input: {
  state: SimulationState;
  agent: AgentState;
  originalAction: AgentActionProposal;
  stimulus: ObservationPacket;
  instanceId: string;
  advanceId: string;
  issues: readonly PromptValidationIssue[];
}): unknown {
  const resolver = createAgentReferenceResolver(input.agent, [input.stimulus]);
  const preparedAction = {
    rawText: input.originalAction.rawText,
    goal: input.originalAction.goal,
    means: input.originalAction.means,
    targetHandles: input.originalAction.targetIds.flatMap((targetId) => {
      try { return [resolver.handleFor("local_entity", targetId)]; }
      catch { return []; }
    }),
  };
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    roleContract: modelRoleContract("agent-reaction"),
    execution: {
      worldId: input.state.worldId,
      instanceId: input.instanceId,
      advanceId: input.advanceId,
      revision: input.state.revision,
      step: input.state.step + 1,
    },
    task: {
      assignment: {
        targetHandles: [],
        availableHandles: resolver.catalog.candidates.map((candidate) => candidate.handle),
        allowedProposalKinds: [],
      },
      constraints: input.issues.map((issue) => issue.message),
    },
    state: {
      perspective: projectAgentPerspectiveForModel(input.state, input.agent, resolver),
      preparedAction,
      stimulus: projectAgentObservation(input.stimulus, resolver),
    },
    referenceCatalog: resolver.catalog,
    repair: input.issues.length > 0 ? { target: resolver.handleFor("agent", input.agent.id), issues: input.issues.map(projectPromptIssue) } : null,
  };
}

export function sanitizeObservationForAgent(packet: ObservationPacket): Record<string, unknown> {
  return visibleObservation(packet);
}
