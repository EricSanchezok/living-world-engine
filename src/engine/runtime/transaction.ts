import { validateAlgorithmExecutionState } from "./execution-state";
import { z } from "zod";
import type { ExecutionRef } from "./execution";
import type {
  AgentAdmissionCommit,
  AgentBeliefState,
  AgentState,
  CausalRef,
  CommittedStep,
  FactValue,
  MeterState,
  ModelExecutionAudit,
  QuantityState,
  SimulationState,
  TransitionProposal,
  WorldDeltaOperation,
} from "../contracts/model";
import { evaluateProposalCausality } from "../mechanics/causality";
import { validateCharacterState } from "../cognition/character";
import { applyMindCommit } from "../cognition/mind-commit";
import {
  beliefPatchSchema,
  causalAssertionResultSchema,
  causalVerificationSchema,
  characterPatchSchema,
  mechanicResultSchema,
  persistedCheckRequestSchema,
  persistedTransitionProposalSchema,
  reactionDecisionSchema,
  reactionRequestSchema,
  resolutionPlanSchema,
  resolutionReceiptSchema,
} from "../contracts/llm-schemas";
import {
  modelAccountChannels,
  modelInferenceSchema,
  modelProtocols,
  modelRoles,
  modelSelectorSchema,
  resolvedModelInferenceSchema,
} from "../models/model-catalog";
import { contentHash, isSha256 } from "../models/model-audit";
import { applyObservationBindings, pendingObservationsFor, validateObservations } from "../cognition/observation";
import { resolveD20Checks, resolveDiscreteRandomRequests } from "../mechanics/random";
import {
  coreResolutionRulePackage,
  deriveCoreResolutionMechanicResult,
} from "../mechanics/rule-package";
import {
  deriveCheck,
  deriveResolutionReceipt,
  expectedActionStatus,
  validateResolutionPlan,
  type ResolutionEvidenceIndex,
} from "../mechanics/resolution";
import {
  actionProposalSchema,
  agentStateSchema,
  commitmentRoundsSchema,
  conditionStateSchema,
  discreteRandomRequestSchema,
  discreteRandomResultSchema,
  d20CheckResultSchema,
  entitySchema,
  isSemanticId,
  isSafeId,
  meterSchema,
  persistedFactSchema,
  quantityStateSchema,
  ratingSchema,
  sharedActivityResourcePoolSchema,
} from "../contracts/state-schemas";
import { isRuntimeId, quantityId, runtimeId } from "./runtime-id";
import { validateImpactProfile } from "../mechanics/resolution";
import {
  validateActivityResources,
  validateActivityState,
  validateTemporalPlan,
  validateTemporalProfile,
  validateWorldTimer,
} from "../mechanics/temporal";
import {
  validateSharedActivityResourceClaimForAction,
  validateSharedActivityResourceDefinition,
  validateSharedActivityResourcePool,
} from "../mechanics/shared-activity-resources";
import { validateSharedResourceCapacity } from "../mechanics/shared-resource-allocation";
import {
  actionDraftEqual,
  admissionCandidateFromCommit,
  computeAdmissionImpact,
  expectedRebasedActionId,
} from "./admission-impact";

function assertExactKeys(value: object, required: readonly string[], optional: readonly string[] = [], label = "object"): void {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !keys.includes(key)) || keys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unexpected or missing fields`);
  }
}

function assertSafeId(value: string, label: string): void {
  if (!isSafeId(value)) throw new Error(`${label} uses a reserved object key`);
}

function assertSemanticId(value: string, label: string): void {
  if (!isSemanticId(value)) throw new Error(`${label} is not a valid semantic id`);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} contains duplicate ids`);
}

function validateExecutionRef(reference: ExecutionRef, label: string): void {
  assertExactKeys(reference, ["executionId", "terminalEventSequence", "traceHash"], [], label);
  if (!reference.executionId.trim() || !Number.isSafeInteger(reference.terminalEventSequence) ||
    reference.terminalEventSequence <= 0 || !isSha256(reference.traceHash)) throw new Error(`${label} is invalid`);
}

function assertCauses(causes: readonly CausalRef[], label: string): void {
  if (causes.length === 0) throw new Error(`${label} has no causal provenance`);
  assertUnique(causes.map((cause) => `${cause.kind}:${cause.id}`), `${label} causes`);
  for (const cause of causes) assertSafeId(cause.id, `${label} cause id`);
}

function assertFactValueReferences(value: FactValue, state: SimulationState, label: string): void {
  if (value.kind === "entity" && !state.truth.entities[value.entityId]) {
    throw new Error(`${label} references unknown entity ${value.entityId}`);
  }
}

function quantityKey(state: SimulationState, definitionId: string, holderId: string): string {
  return quantityId(state.worldHash, definitionId, holderId);
}

function getOrCreateQuantity(state: SimulationState, definitionId: string, holderId: string): QuantityState {
  const id = quantityKey(state, definitionId, holderId);
  state.truth.quantities[id] ??= { id, definitionId, holderId, amount: 0 };
  return state.truth.quantities[id];
}

function validateMeter(state: SimulationState, meter: MeterState): void {
  const definition = state.truth.mechanics.meters[meter.definitionId];
  if (!definition || !state.truth.entities[meter.entityId]) throw new Error(`invalid meter ${meter.id}`);
  if (!Number.isFinite(meter.current) || meter.current < definition.min || meter.current > definition.max) {
    throw new Error(`meter ${meter.id} is outside ${definition.min}..${definition.max}`);
  }
  const thresholds = new Set(definition.thresholds.map((threshold) => threshold.id));
  assertUnique(meter.firedThresholdIds, `meter ${meter.id} threshold ledger`);
  if (meter.firedThresholdIds.some((id) => !thresholds.has(id))) throw new Error(`meter ${meter.id} has an unknown threshold`);
}

function applyThresholds(state: SimulationState, meter: MeterState, causes: CausalRef[]): void {
  const definition = state.truth.mechanics.meters[meter.definitionId];
  for (const threshold of definition.thresholds) {
    const reached = threshold.when.operator === "lte" ? meter.current <= threshold.when.value : meter.current >= threshold.when.value;
    if (!reached || meter.firedThresholdIds.includes(threshold.id)) continue;
    meter.firedThresholdIds.push(threshold.id);
    for (const effect of threshold.effects) {
      if (effect.kind === "set_lifecycle") {
        state.truth.entities[meter.entityId].lifecycle = effect.lifecycle;
      } else {
        const id = runtimeId({
          worldHash: state.worldHash,
          revision: state.revision,
          kind: "fact",
          stage: "threshold",
          owner: [meter.id, threshold.id],
          round: 0,
          ordinal: 0,
        });
        state.truth.facts[id] = {
          id,
          subjectId: meter.entityId,
          predicate: effect.predicate,
          value: structuredClone(effect.value),
          description: effect.description,
          access: structuredClone(effect.access ?? { kind: "public" }),
          provenance: structuredClone(causes),
        };
      }
    }
  }
}

function historicalAgentBindings(state: SimulationState): Map<string, string> {
  const result = new Map<string, string>();
  for (const [agentId, agent] of Object.entries(state.historyBase?.agents ?? {})) result.set(agentId, agent.entityId);
  for (const [agentId, agent] of Object.entries(state.agents)) result.set(agentId, agent.entityId);
  for (const step of state.history) {
    for (const operation of step.operations) {
      if (operation.kind === "create_agent") result.set(operation.agent.id, operation.agent.entityId);
    }
  }
  return result;
}

export function applyWorldDeltaOperation(state: SimulationState, operation: WorldDeltaOperation): void {
  assertCauses(operation.causes, operation.kind);
  if (operation.assertions.length === 0) throw new Error(`${operation.kind} has no causal assertions`);
  switch (operation.kind) {
    case "create_entity":
      assertSemanticId(operation.entity.id, "entity id");
      if (state.truth.entities[operation.entity.id]) throw new Error(`entity already exists: ${operation.entity.id}`);
      if (operation.placementId && !state.truth.entities[operation.placementId]) throw new Error(`unknown placement ${operation.placementId}`);
      state.truth.entities[operation.entity.id] = structuredClone(operation.entity);
      state.truth.placements[operation.entity.id] = operation.placementId;
      return;
    case "retire_entity":
      if (!state.truth.entities[operation.entityId]) throw new Error(`unknown entity ${operation.entityId}`);
      state.truth.entities[operation.entityId].lifecycle = "retired";
      return;
    case "place_entity":
      if (!state.truth.entities[operation.entityId]) throw new Error(`unknown entity ${operation.entityId}`);
      if (operation.placementId && !state.truth.entities[operation.placementId]) throw new Error(`unknown placement ${operation.placementId}`);
      if (operation.entityId === operation.placementId) throw new Error("entity cannot contain itself");
      state.truth.placements[operation.entityId] = operation.placementId;
      return;
    case "set_fact":
      assertSemanticId(operation.fact.id, "fact id");
      if (state.truth.factTombstones.includes(operation.fact.id)) throw new Error(`fact identity is tombstoned: ${operation.fact.id}`);
      if (!state.truth.entities[operation.fact.subjectId]) throw new Error(`unknown fact subject ${operation.fact.subjectId}`);
      assertFactValueReferences(operation.fact.value, state, `fact ${operation.fact.id}`);
      if (state.truth.facts[operation.fact.id] &&
        (state.truth.facts[operation.fact.id].subjectId !== operation.fact.subjectId ||
          state.truth.facts[operation.fact.id].predicate !== operation.fact.predicate)) {
        throw new Error(`fact ${operation.fact.id} cannot change identity`);
      }
      state.truth.facts[operation.fact.id] = { ...structuredClone(operation.fact), provenance: structuredClone(operation.causes) };
      return;
    case "remove_fact":
      if (!state.truth.facts[operation.factId]) throw new Error(`unknown fact ${operation.factId}`);
      delete state.truth.facts[operation.factId];
      state.truth.factTombstones.push(operation.factId);
      return;
    case "set_meter":
      if (state.truth.meters[operation.meter.id] &&
        (state.truth.meters[operation.meter.id].definitionId !== operation.meter.definitionId ||
          state.truth.meters[operation.meter.id].entityId !== operation.meter.entityId)) throw new Error(`meter ${operation.meter.id} cannot change identity`);
      if (state.truth.meters[operation.meter.id] &&
        contentHash(state.truth.meters[operation.meter.id].firedThresholdIds) !== contentHash(operation.meter.firedThresholdIds)) {
        throw new Error(`meter ${operation.meter.id} threshold ledger is engine-owned`);
      }
      state.truth.meters[operation.meter.id] = structuredClone(operation.meter);
      validateMeter(state, operation.meter);
      applyThresholds(state, state.truth.meters[operation.meter.id], operation.causes);
      return;
    case "adjust_meter": {
      const meter = state.truth.meters[operation.meterId];
      if (!meter) throw new Error(`unknown meter ${operation.meterId}`);
      meter.current += operation.amount;
      validateMeter(state, meter);
      applyThresholds(state, meter, operation.causes);
      return;
    }
    case "transfer_quantity": {
      if (!state.truth.mechanics.quantities[operation.definitionId]) throw new Error(`unknown quantity ${operation.definitionId}`);
      if (!state.truth.entities[operation.fromHolderId] || !state.truth.entities[operation.toHolderId]) throw new Error("unknown quantity holder");
      if (!Number.isFinite(operation.amount) || operation.amount <= 0) throw new Error("transfer amount must be positive");
      const from = getOrCreateQuantity(state, operation.definitionId, operation.fromHolderId);
      const to = getOrCreateQuantity(state, operation.definitionId, operation.toHolderId);
      if (from.amount < operation.amount) throw new Error("insufficient quantity");
      from.amount -= operation.amount;
      to.amount += operation.amount;
      return;
    }
    case "produce_quantity":
    case "consume_quantity": {
      const definition = state.truth.mechanics.quantities[operation.definitionId];
      const authorized = operation.kind === "produce_quantity" ? definition?.productionLawIds : definition?.consumptionLawIds;
      if (!authorized?.includes(operation.lawId) || !operation.causes.some((cause) => cause.kind === "law" && cause.id === operation.lawId)) {
        throw new Error(`law ${operation.lawId} cannot authorize ${operation.kind}`);
      }
      if (!state.truth.entities[operation.holderId]) throw new Error(`unknown holder ${operation.holderId}`);
      if (!Number.isFinite(operation.amount) || operation.amount <= 0) throw new Error("quantity amount must be positive");
      const quantity = getOrCreateQuantity(state, operation.definitionId, operation.holderId);
      if (operation.kind === "consume_quantity" && quantity.amount < operation.amount) throw new Error("insufficient quantity");
      quantity.amount += operation.kind === "produce_quantity" ? operation.amount : -operation.amount;
      return;
    }
    case "set_quantity": {
      const quantity = operation.quantity;
      const expectedId = quantityId(state.worldHash, quantity.definitionId, quantity.holderId);
      if (quantity.id !== expectedId || state.truth.quantities[quantity.id] ||
        !state.truth.mechanics.quantities[quantity.definitionId] || !state.truth.entities[quantity.holderId] ||
        !Number.isFinite(quantity.amount) || quantity.amount < 0) {
        throw new Error(`invalid quantity initialization ${quantity.id}`);
      }
      state.truth.quantities[quantity.id] = structuredClone(quantity);
      return;
    }
    case "set_rating": {
      const existing = state.truth.ratings[operation.rating.id];
      if (existing && (existing.definitionId !== operation.rating.definitionId || existing.entityId !== operation.rating.entityId)) {
        throw new Error(`rating ${operation.rating.id} cannot change identity`);
      }
      const definition = state.truth.mechanics.ratings[operation.rating.definitionId];
      if (!definition || !state.truth.entities[operation.rating.entityId] ||
        operation.rating.value < definition.min || operation.rating.value > definition.max) throw new Error(`invalid rating ${operation.rating.id}`);
      state.truth.ratings[operation.rating.id] = structuredClone(operation.rating);
      return;
    }
    case "set_condition": {
      conditionStateSchema.parse(operation.condition);
      const existing = state.truth.conditions[operation.condition.id];
      if (!state.truth.entities[operation.condition.subjectId] ||
        (existing && existing.subjectId !== operation.condition.subjectId) ||
        !state.truth.mechanics.durationProfiles[operation.condition.durationProfileId] ||
        (operation.condition.conditionProfileId !== null &&
          !state.truth.mechanics.conditionProfiles[operation.condition.conditionProfileId]) ||
        contentHash(operation.condition.provenance) !== contentHash(operation.causes)) {
        throw new Error(`invalid condition ${operation.condition.id}`);
      }
      state.truth.conditions[operation.condition.id] = structuredClone(operation.condition);
      return;
    }
    case "remove_condition":
      if (!state.truth.conditions[operation.conditionId]) throw new Error(`unknown condition ${operation.conditionId}`);
      delete state.truth.conditions[operation.conditionId];
      return;
    case "set_shared_activity_resource_capacity": {
      const pool = state.truth.sharedActivityResourcePools[operation.poolId];
      if (!pool) throw new Error(`unknown shared activity resource pool ${operation.poolId}`);
      if (!Number.isFinite(operation.capacity) || operation.capacity < 0) {
        throw new Error("shared activity resource capacity must be non-negative");
      }
      pool.capacity = operation.capacity;
      return;
    }
    case "advance_time":
      if (!Number.isSafeInteger(operation.seconds) || operation.seconds <= 0) throw new Error("time advance must be positive seconds");
      state.truth.elapsedSeconds += operation.seconds;
      return;
    case "create_agent": {
      assertSemanticId(operation.agent.id, "agent id");
      const history = historicalAgentBindings(state);
      if (history.has(operation.agent.id)) throw new Error(`agent identity was already used: ${operation.agent.id}`);
      if ([...history.values()].includes(operation.agent.entityId)) throw new Error(`agent entity was already bound: ${operation.agent.entityId}`);
      if (!state.truth.entities[operation.agent.entityId]) throw new Error(`unknown agent entity ${operation.agent.entityId}`);
      if (operation.agent.nextAction !== null) throw new Error("new Agent cannot prefill nextAction");
      state.agents[operation.agent.id] = structuredClone(operation.agent);
      return;
    }
    case "remove_agent":
      if (!state.agents[operation.agentId]) throw new Error(`unknown agent ${operation.agentId}`);
      delete state.agents[operation.agentId];
      return;
  }
}

function validatePlacementCycles(state: SimulationState): void {
  for (const entityId of Object.keys(state.truth.entities)) {
    if (!(entityId in state.truth.placements)) throw new Error(`entity ${entityId} has no placement`);
    const seen = new Set([entityId]);
    let placement = state.truth.placements[entityId];
    while (placement) {
      if (!state.truth.entities[placement]) throw new Error(`unknown placement entity ${placement}`);
      if (seen.has(placement)) throw new Error(`placement cycle detected at ${placement}`);
      seen.add(placement);
      placement = state.truth.placements[placement];
    }
  }
}

function validateBelief(belief: AgentBeliefState, bindings: AgentState["bindings"], state: SimulationState, label: string): void {
  for (const [id, entity] of Object.entries(belief.localEntities)) {
    if (entity.id !== id || state.truth.entities[id]) throw new Error(`${label} has invalid local entity ${id}`);
  }
  for (const [id, evidence] of Object.entries(belief.evidence)) {
    if (evidence.id !== id || !Number.isSafeInteger(evidence.step) || evidence.step < 0 || evidence.step > state.step) {
      throw new Error(`${label} has invalid evidence ${id}`);
    }
  }
  for (const [id, claim] of Object.entries(belief.claims)) {
    if (claim.id !== id || !belief.localEntities[claim.subjectId] ||
      (claim.value.kind === "local_entity" && !belief.localEntities[claim.value.localEntityId]) ||
      claim.evidenceIds.some((evidenceId) => !belief.evidence[evidenceId])) throw new Error(`${label} has invalid claim ${id}`);
  }
  for (const [localId, binding] of Object.entries(bindings)) {
    if (binding.localEntityId !== localId || !belief.localEntities[localId] ||
      binding.canonicalEntityIds.some((entityId) => !state.truth.entities[entityId])) throw new Error(`${label} has invalid binding ${localId}`);
    assertUnique(binding.canonicalEntityIds, `${label} binding ${localId}`);
  }
}

function semanticStepHash(step: Readonly<CommittedStep>): string {
  const semantic = structuredClone(step) as Partial<CommittedStep>;
  delete semantic.contentHash;
  delete semantic.semanticHash;
  delete semantic.executionRef;
  return contentHash(semantic);
}

export function semanticAdmissionHash(commit: Readonly<AgentAdmissionCommit>): string {
  const semantic = structuredClone(commit) as Partial<AgentAdmissionCommit>;
  delete semantic.contentHash;
  delete semantic.semanticHash;
  delete semantic.executionRef;
  return contentHash(semantic);
}

function validateAdmissionShape(commit: AgentAdmissionCommit): void {
  assertExactKeys(commit, [
    "contentHash", "semanticHash", "baseRevision", "revision", "step", "entity", "placementId", "agent",
    "meters", "quantities", "ratings", "conditions", "invalidatedActionIds", "reusedActions",
  ], ["executionRef"], `Agent admission ${commit.revision}`);
  if (commit.semanticHash !== semanticAdmissionHash(commit)) {
    throw new Error(`Agent admission revision ${commit.revision} semantic hash mismatch`);
  }
  const payload = structuredClone(commit) as Partial<AgentAdmissionCommit>;
  delete payload.contentHash;
  if (commit.contentHash !== contentHash(payload)) {
    throw new Error(`Agent admission revision ${commit.revision} content hash mismatch`);
  }
  if (commit.executionRef) validateExecutionRef(commit.executionRef, `Agent admission ${commit.revision} executionRef`);
  entitySchema.parse(commit.entity);
  agentStateSchema.parse(commit.agent);
  commit.meters.forEach((meter) => meterSchema.parse(meter));
  commit.quantities.forEach((quantity) => quantityStateSchema.parse(quantity));
  commit.ratings.forEach((rating) => ratingSchema.parse(rating));
  commit.conditions.forEach((condition) => conditionStateSchema.parse(condition));
  assertUnique(commit.invalidatedActionIds, `Agent admission ${commit.revision} invalidated actions`);
  assertUnique(commit.reusedActions.map((action) => action.actorId), `Agent admission ${commit.revision} reused Agents`);
  assertUnique(commit.reusedActions.map((action) => action.id), `Agent admission ${commit.revision} reused actions`);
  commit.reusedActions.forEach((action) => actionProposalSchema.parse(action));
}

export function applyAdmissionCommit(state: SimulationState, input: Readonly<AgentAdmissionCommit>): void {
  const commit = structuredClone(input);
  validateAdmissionShape(commit);
  if (commit.baseRevision !== state.revision || commit.revision !== state.revision + 1 || commit.step !== state.step) {
    throw new Error(`Agent admission revision ${commit.revision} is not contiguous`);
  }
  if (state.truth.entities[commit.entity.id]) throw new Error(`Agent admission reuses entity ${commit.entity.id}`);
  if (commit.placementId && !state.truth.entities[commit.placementId]) {
    throw new Error(`Agent admission has unknown placement ${commit.placementId}`);
  }
  if (state.agents[commit.agent.id]) throw new Error(`Agent admission reuses Agent ${commit.agent.id}`);
  if (Object.values(state.agents).some((agent) => agent.entityId === commit.agent.entityId)) {
    throw new Error(`Agent admission reuses bound entity ${commit.agent.entityId}`);
  }
  if (commit.agent.entityId !== commit.entity.id || commit.agent.nextAction !== null) {
    throw new Error("Agent admission must bind its new entity and cannot prefill an action");
  }
  const preparedActionIds = Object.values(state.agents)
    .flatMap((agent) => agent.nextAction ? [agent.nextAction.id] : [])
    .sort();
  if (contentHash(preparedActionIds) !== contentHash([...commit.invalidatedActionIds].sort())) {
    throw new Error("Agent admission has an invalid prepared-action invalidation ledger");
  }
  const priorActionsByAgent = new Map(Object.values(state.agents)
    .flatMap((agent) => agent.nextAction ? [[agent.id, agent.nextAction] as const] : []));
  const reusedAgentIds = new Set<string>();
  const reusedActionIds = new Set<string>();
  for (const action of commit.reusedActions) {
    const prior = priorActionsByAgent.get(action.actorId);
    if (!prior || reusedAgentIds.has(action.actorId) || reusedActionIds.has(action.id)) {
      throw new Error(`Agent admission reuses an unknown or duplicate prepared action for ${action.actorId}`);
    }
    if (action.baseRevision !== commit.revision ||
      action.id !== expectedRebasedActionId(state, action.actorId, commit.revision) ||
      !actionDraftEqual(prior, action)) {
      throw new Error(`Agent admission has an invalid rebased action for ${action.actorId}`);
    }
    for (const targetId of action.targetIds) {
      if (!state.agents[action.actorId]!.belief.localEntities[targetId]) {
        throw new Error(`Agent admission rebased action ${action.id} targets an unknown local entity`);
      }
    }
    reusedAgentIds.add(action.actorId);
    reusedActionIds.add(action.id);
  }
  const expectedImpact = computeAdmissionImpact(state, admissionCandidateFromCommit(commit));
  if (contentHash(expectedImpact.reusedActions) !== contentHash(commit.reusedActions) ||
    contentHash(expectedImpact.invalidatedAgentIds) !== contentHash(
      Object.keys(state.agents).filter((agentId) => !reusedAgentIds.has(agentId)).sort(),
    )) {
    throw new Error("Agent admission reused actions do not match the canonical impact proof");
  }
  for (const agent of Object.values(state.agents)) agent.nextAction = null;
  state.truth.entities[commit.entity.id] = structuredClone(commit.entity);
  state.truth.placements[commit.entity.id] = commit.placementId;
  state.agents[commit.agent.id] = structuredClone(commit.agent);
  for (const meter of commit.meters) {
    if (meter.entityId !== commit.entity.id || state.truth.meters[meter.id]) {
      throw new Error(`Agent admission has invalid meter ${meter.id}`);
    }
    validateMeter(state, meter);
    state.truth.meters[meter.id] = structuredClone(meter);
  }
  for (const quantity of commit.quantities) {
    const expectedId = quantityId(state.worldHash, quantity.definitionId, commit.entity.id);
    if (quantity.id !== expectedId || quantity.holderId !== commit.entity.id ||
      !state.truth.mechanics.quantities[quantity.definitionId] || state.truth.quantities[quantity.id]) {
      throw new Error(`Agent admission has invalid quantity ${quantity.id}`);
    }
    state.truth.quantities[quantity.id] = structuredClone(quantity);
  }
  for (const rating of commit.ratings) {
    const definition = state.truth.mechanics.ratings[rating.definitionId];
    if (rating.entityId !== commit.entity.id || state.truth.ratings[rating.id] || !definition ||
      rating.value < definition.min || rating.value > definition.max) {
      throw new Error(`Agent admission has invalid rating ${rating.id}`);
    }
    state.truth.ratings[rating.id] = structuredClone(rating);
  }
  for (const condition of commit.conditions) {
    if (condition.subjectId !== commit.entity.id || state.truth.conditions[condition.id]) {
      throw new Error(`Agent admission has invalid condition ${condition.id}`);
    }
    state.truth.conditions[condition.id] = structuredClone(condition);
  }
  for (const action of commit.reusedActions) {
    state.agents[action.actorId]!.nextAction = structuredClone(action);
  }
  state.revision = commit.revision;
  state.admissions.push(commit);
}

function validateCommittedRandomTranscript(step: CommittedStep, state: SimulationState): void {
  if (contentHash(step.rngBefore) !== contentHash(state.truth.rng)) {
    throw new Error(`step ${step.step} RNG does not continue canonical state`);
  }
  const checkRoundIds = step.commitmentRounds
    .filter((round) => round.kind === "check")
    .flatMap((round) => round.requestIds);
  const randomRoundIds = step.commitmentRounds
    .filter((round) => round.kind === "random")
    .flatMap((round) => round.requestIds);
  assertUnique(checkRoundIds, `step ${step.step} committed check rounds`);
  assertUnique(randomRoundIds, `step ${step.step} committed random rounds`);
  assertUnique(step.checkRequests.map((request) => request.id), `step ${step.step} check requests`);
  assertUnique(step.checks.map((result) => result.requestId), `step ${step.step} check results`);
  assertUnique(step.randomRequests.map((request) => request.id), `step ${step.step} random requests`);
  assertUnique(step.randomResults.map((result) => result.requestId), `step ${step.step} random results`);
  if (contentHash([...checkRoundIds].sort()) !== contentHash(step.checkRequests.map((request) => request.id).sort()) ||
    contentHash([...checkRoundIds].sort()) !== contentHash(step.checks.map((result) => result.requestId).sort()) ||
    contentHash([...randomRoundIds].sort()) !== contentHash(step.randomRequests.map((request) => request.id).sort()) ||
    contentHash([...randomRoundIds].sort()) !== contentHash(step.randomResults.map((result) => result.requestId).sort())) {
    throw new Error(`step ${step.step} commitment rounds do not cover their random transcript`);
  }
  let rng = structuredClone(step.rngBefore);
  let phase: "perception" | "resolution" | "random" = "perception";
  for (const round of step.commitmentRounds) {
    if (round.kind === "check") {
      if (phase === "random" || (phase === "resolution" && round.phase === "perception")) {
        throw new Error(`step ${step.step} has an invalid commitment phase order`);
      }
      phase = round.phase;
      const requests = round.requestIds.map((id) => {
        const request = step.checkRequests.find((candidate) => candidate.id === id);
        if (!request || request.phase !== round.phase) throw new Error(`step ${step.step} has an invalid check round`);
        return request;
      });
      const resolved = resolveD20Checks(rng, requests);
      const recorded = round.requestIds.map((id) => step.checks.find((candidate) => candidate.requestId === id));
      if (recorded.some((result) => !result) || contentHash(resolved.results) !== contentHash(recorded)) {
        throw new Error(`step ${step.step} has a non-deterministic d20 transcript`);
      }
      rng = resolved.rng;
      continue;
    }
    phase = "random";
    const requests = round.requestIds.map((id) => {
      const request = step.randomRequests.find((candidate) => candidate.id === id);
      if (!request) throw new Error(`step ${step.step} has an invalid discrete random round`);
      return request;
    });
    const resolved = resolveDiscreteRandomRequests(rng, requests);
    const recorded = round.requestIds.map((id) => step.randomResults.find((candidate) => candidate.requestId === id));
    if (recorded.some((result) => !result) || contentHash(resolved.results) !== contentHash(recorded)) {
      throw new Error(`step ${step.step} has a non-deterministic discrete random transcript`);
    }
    rng = resolved.rng;
  }
  if (contentHash(rng) !== contentHash(step.rngAfter)) {
    throw new Error(`step ${step.step} has an invalid RNG continuation`);
  }
}

function validateCommittedStepShape(step: CommittedStep, state: SimulationState): void {
  validateAlgorithmExecutionState(step.executionState, state.executionState?.producerHash);
  if (step.semanticHash !== semanticStepHash(step)) throw new Error(`step ${step.step} semantic hash mismatch`);
  const payload = structuredClone(step) as Partial<CommittedStep>;
  delete payload.contentHash;
  if (step.contentHash !== contentHash(payload)) throw new Error(`step ${step.step} content hash mismatch`);
  if (step.executionRef) validateExecutionRef(step.executionRef, `step ${step.step} executionRef`);
  step.initialActions.forEach((action) => actionProposalSchema.parse(action));
  step.actions.forEach((action) => actionProposalSchema.parse(action));
  step.reactionRequests.forEach((request) => reactionRequestSchema.parse(request));
  step.reactionDecisions.forEach((decision) => reactionDecisionSchema.parse(decision));
  step.checkRequests.forEach((request) => persistedCheckRequestSchema.parse(request));
  step.checks.forEach((result) => d20CheckResultSchema.parse(result));
  step.resolutionPlans.forEach((plan) => resolutionPlanSchema.parse(plan));
  step.resolutionReceipts.forEach((receipt) => resolutionReceiptSchema.parse(receipt));
  assertUnique(step.resolutionPlans.map((plan) => plan.id), `step ${step.step} resolution plans`);
  assertUnique(step.resolutionReceipts.map((receipt) => receipt.id), `step ${step.step} resolution receipts`);
  assertUnique(step.sharedResourceAdmissions.map((admission) => admission.activityId),
    `step ${step.step} shared resource admissions`);
  const deferredActionIds = new Set(step.sharedResourceAdmissions.flatMap((admission) => {
    if (admission.kind !== "queue" && admission.kind !== "reject") return [];
    const activity = step.temporalState.activities[admission.activityId];
    if (!activity) throw new Error(`step ${step.step} shared resource admission lost Activity ${admission.activityId}`);
    return [activity.sourceActionId];
  }));
  if (contentHash(step.resolutionPlans.map((plan) => plan.actionId).sort()) !==
    contentHash(step.actions.filter((action) => !deferredActionIds.has(action.id)).map((action) => action.id).sort())) {
    throw new Error(`step ${step.step} resolution plans do not cover actions`);
  }
  if (step.resolutionReceipts.length !== step.resolutionPlans.length) {
    throw new Error(`step ${step.step} resolution receipts do not cover plans`);
  }
  const evidence: ResolutionEvidenceIndex = {
    actions: new Set(step.actions.map((action) => action.id)),
    entities: new Set(Object.keys(state.truth.entities)),
    facts: new Set(Object.keys(state.truth.facts)),
    conditions: new Set(Object.keys(state.truth.conditions)),
    conditionOwners: new Map(Object.values(state.truth.conditions)
      .map((condition) => [condition.id, condition.subjectId])),
    laws: new Set(state.lawIds),
    placements: new Set(Object.keys(state.truth.entities)),
    ratingOwners: new Map(Object.values(state.truth.ratings).map((rating) => [rating.id, rating.entityId])),
    ratingValues: new Map(Object.values(state.truth.ratings).map((rating) => [rating.id, rating.value])),
  };
  for (const plan of step.resolutionPlans) {
    validateResolutionPlan(plan, evidence);
    const receipt = step.resolutionReceipts.find((candidate) => candidate.plan.id === plan.id);
    if (!receipt || contentHash(receipt.plan) !== contentHash(plan)) {
      throw new Error(`step ${step.step} resolution receipt does not pin plan ${plan.id}`);
    }
    const request = receipt.checkRequestId
      ? step.checkRequests.find((candidate) => candidate.id === receipt.checkRequestId)
      : null;
    const result = receipt.checkRequestId
      ? step.checks.find((candidate) => candidate.requestId === receipt.checkRequestId)
      : null;
    const check = plan.mode === "check" ? deriveCheck(plan, evidence) : null;
    const expectedTargetId = plan.difficulty?.kind === "opposed"
      ? plan.difficulty.targetId
      : plan.primaryEffect?.targetId ?? plan.targetIds[0] ?? null;
    const expectedModifierSources = plan.actorRatingId
      ? [{ kind: "rating" as const, id: plan.actorRatingId, amount: check!.modifier }]
      : [];
    if (plan.mode === "check" && (!request || !result || request.phase !== "resolution" ||
      request.actorId !== plan.actorId || request.targetId !== expectedTargetId ||
      request.ratingId !== plan.actorRatingId || request.visibility !== plan.visibility ||
      request.dc !== check!.dc || request.modifier !== check!.modifier || request.mode !== check!.mode ||
      request.stakes !== `${plan.risk}: ${plan.primaryEffect?.description ?? plan.goal}` ||
      contentHash(request.modifierSources) !== contentHash(expectedModifierSources) ||
      contentHash(request.causes) !== contentHash(plan.causes))) {
      throw new Error(`step ${step.step} receipt ${receipt.id} has an invalid committed check`);
    }
    const derived = deriveResolutionReceipt({
      receiptId: receipt.id,
      plan,
      checkRequestId: receipt.checkRequestId,
      check,
      result: result ?? null,
    });
    const expectedReceipt = {
      ...derived,
      settled: receipt.settled,
      operations: receipt.operations,
    };
    if (contentHash(expectedReceipt) !== contentHash(receipt)) {
      throw new Error(`step ${step.step} resolution receipt ${receipt.id} is not deterministic`);
    }
    const outcome = step.outcomes.find((candidate) => candidate.proposalId === plan.actionId);
    const actionActivity = Object.values(step.temporalState.activities).find((activity) =>
      activity.sourceActionId === plan.actionId);
    const activityIsContinuing = Boolean(actionActivity &&
      (actionActivity.status === "active" || actionActivity.status === "paused"));
    const disposition = actionActivity && step.activityDispositions.find((entry) =>
      entry.activityId === actionActivity.id);
    const temporallyTerminated = disposition?.kind === "block" || disposition?.kind === "fail" ||
      disposition?.kind === "cancel";
    const intervalStillContinuing = activityIsContinuing || (temporallyTerminated && outcome?.status === "continuing");
    const expectedStatus = intervalStillContinuing ? "continuing" : expectedActionStatus(receipt);
    if (!receipt.settled || !outcome || outcome.status !== expectedStatus) {
      throw new Error(`step ${step.step} resolution receipt ${receipt.id} contradicts temporal settlement`);
    }
  }
  step.randomRequests.forEach((request) => discreteRandomRequestSchema.parse(request));
  step.randomResults.forEach((result) => discreteRandomResultSchema.parse(result));
  commitmentRoundsSchema.parse(step.commitmentRounds);
  validateCommittedRandomTranscript(step, state);
  step.mechanicResults.forEach((result) => mechanicResultSchema.parse(result));
  assertUnique(step.mechanicResults.map((result) => result.invocationId), `step ${step.step} mechanic results`);
  if (contentHash(step.mechanicResults.map((result) => result.invocationId)) !==
    contentHash(step.mechanicInvocations.map((invocation) => invocation.id))) {
    throw new Error(`step ${step.step} mechanic results do not preserve invocation order`);
  }
  const recordedMechanicOperations = step.mechanicResults.flatMap((result) => result.operations);
  const directOperationCount = step.operations.length - recordedMechanicOperations.length - 1;
  const finalOperation = step.operations.at(-1);
  if (directOperationCount < 0 || finalOperation?.kind !== "advance_time" ||
    contentHash(step.operations.slice(directOperationCount, -1)) !== contentHash(recordedMechanicOperations)) {
    throw new Error(`step ${step.step} has an invalid mechanic operation transcript`);
  }
  const directOperations = step.operations.slice(0, directOperationCount);
  const replayContext = {
    state,
    actions: step.actions,
    resolutionPlans: step.resolutionPlans,
    resolutionReceipts: step.resolutionReceipts.map((receipt) => ({ ...structuredClone(receipt), operations: [] })),
    checkRequests: step.checkRequests,
    checkResults: step.checks,
    randomRequests: step.randomRequests,
    randomResults: step.randomResults,
  };
  coreResolutionRulePackage.validateDirectOperations?.(replayContext, {}, directOperations);
  const priorMechanicResults: typeof step.mechanicResults = [];
  for (const invocation of step.mechanicInvocations) {
    const recorded = step.mechanicResults.find((result) => result.invocationId === invocation.id);
    if (!recorded) throw new Error(`step ${step.step} has no result for mechanic ${invocation.id}`);
    if (invocation.packageId === coreResolutionRulePackage.id) {
      const derived = deriveCoreResolutionMechanicResult(
        replayContext,
        invocation,
        priorMechanicResults,
        directOperations,
      );
      if (contentHash(derived) !== contentHash(recorded)) {
        throw new Error(`step ${step.step} has a non-deterministic core-resolution result for ${invocation.id}`);
      }
    }
    priorMechanicResults.push(recorded);
  }
  const receiptInvocations = step.mechanicInvocations.filter((invocation) =>
    invocation.packageId === "core-resolution" && invocation.ruleId === "apply-receipt");
  if (receiptInvocations.length !== step.resolutionReceipts.length) {
    throw new Error(`step ${step.step} has an invalid apply-receipt invocation count`);
  }
  for (const receipt of step.resolutionReceipts) {
    const invocations = receiptInvocations.filter((invocation) =>
      (invocation.input as { receiptId?: unknown }).receiptId === receipt.id);
    if (invocations.length !== 1) throw new Error(`step ${step.step} does not uniquely apply receipt ${receipt.id}`);
    const result = step.mechanicResults.find((candidate) => candidate.invocationId === invocations[0].id);
    if (!result || result.packageId !== "core-resolution" || result.ruleId !== "apply-receipt" ||
      contentHash(result.operations) !== contentHash(receipt.operations) ||
      receipt.operations.some((receiptOperation) => !step.operations.some((operation) =>
        contentHash(operation) === contentHash(receiptOperation)))) {
      throw new Error(`step ${step.step} receipt ${receipt.id} is not pinned to its trusted operations`);
    }
  }
  const conditionAdvanceInvocations = step.mechanicInvocations.filter((invocation) =>
    invocation.packageId === "core-resolution" && invocation.ruleId === "advance-conditions");
  const timeAdvance = step.operations.find((operation) => operation.kind === "advance_time");
  const conditionAdvance = conditionAdvanceInvocations[0];
  const conditionAdvanceResult = conditionAdvance
    ? step.mechanicResults.find((result) => result.invocationId === conditionAdvance.id)
    : null;
  if (conditionAdvanceInvocations.length !== 1 || !conditionAdvanceResult || !timeAdvance ||
    (conditionAdvance.input as { seconds?: unknown }).seconds !== timeAdvance.seconds ||
    conditionAdvanceResult.operations.some((conditionOperation) => !step.operations.some((operation) =>
      contentHash(operation) === contentHash(conditionOperation)))) {
    throw new Error(`step ${step.step} does not pin deterministic condition advancement`);
  }
  step.causalAssertionResults.forEach((result) => causalAssertionResultSchema.parse(result));
  causalVerificationSchema.parse(step.causalVerification);
  step.beliefPatches.forEach((entry) => beliefPatchSchema.parse(entry));
  step.characterPatches.forEach((entry) => characterPatchSchema.parse(entry));
  step.nextActions.forEach((entry) => actionProposalSchema.parse(entry));
  if (!Number.isSafeInteger(step.temporalBoundary.fromElapsedSeconds) ||
    !Number.isSafeInteger(step.temporalBoundary.toElapsedSeconds) ||
    !Number.isSafeInteger(step.temporalBoundary.deltaSeconds) || step.temporalBoundary.deltaSeconds <= 0 ||
    step.temporalBoundary.toElapsedSeconds !== step.temporalBoundary.fromElapsedSeconds + step.temporalBoundary.deltaSeconds ||
    step.temporalBoundary.reasons.length === 0) {
    throw new Error(`step ${step.step} has an invalid temporal boundary`);
  }
  const timeOperations = step.operations.filter((operation) => operation.kind === "advance_time");
  if (timeOperations.length !== 1 || timeOperations[0]!.seconds !== step.temporalBoundary.deltaSeconds) {
    throw new Error(`step ${step.step} time operation does not match temporal boundary`);
  }
  assertUnique(step.temporalPlans.map((plan) => plan.id), `step ${step.step} temporal plans`);
  assertUnique(step.activityTransitions.map((transition) =>
    `${transition.activityId}:${transition.kind}:${transition.fromStatus}:${transition.toStatus}:${transition.fromElapsedSeconds}:${transition.toElapsedSeconds}`),
  `step ${step.step} activity transitions`);
  assertUnique(step.activityDispositions.map((disposition) => disposition.activityId),
    `step ${step.step} Activity dispositions`);
  assertUnique(step.decisionPoints.map((point) =>
    `${point.agentId}:${point.reason}:${point.activityId ?? ""}:${point.timerId ?? ""}`), `step ${step.step} decision points`);
  persistedTransitionProposalSchema.parse({
    baseRevision: step.baseRevision,
    outcomes: step.outcomes,
    mechanicInvocations: step.mechanicInvocations,
    operations: step.operations,
    events: step.events,
    observations: step.observations,
    decisionRequests: step.decisionRequests,
  });
}

export function replaySimulationState(
  state: SimulationState,
  throughRevision = state.revision,
): SimulationState {
  if (!Number.isSafeInteger(throughRevision) || throughRevision < 0 || throughRevision > state.revision) {
    throw new Error("replay target revision is outside the state history");
  }
  if (!state.historyBase) {
    if (state.history.length > 0 || state.admissions.length > 0) {
      throw new Error("committed history requires historyBase");
    }
    if (throughRevision !== state.revision) throw new Error("replay target is unavailable without historyBase");
    return structuredClone(state);
  }
  const replay: SimulationState = {
    schemaVersion: 16,
    executionState: structuredClone(state.historyBase.executionState),
    worldId: state.worldId,
    worldHash: state.worldHash,
    lawIds: structuredClone(state.lawIds),
    revision: 0,
    step: 0,
    truth: structuredClone(state.historyBase.truth),
    agents: structuredClone(state.historyBase.agents),
    admissions: [],
    history: [],
    historyBase: structuredClone(state.historyBase),
    bootstrapAgentCommits: structuredClone(state.bootstrapAgentCommits),
    ...(state.bootstrapExecutionRef ? { bootstrapExecutionRef: structuredClone(state.bootstrapExecutionRef) } : {}),
  };
  for (const commit of replay.bootstrapAgentCommits) {
    const agent = replay.agents[commit.agentId];
    if (!agent) throw new Error(`bootstrap commit targets unknown Agent ${commit.agentId}`);
    replay.agents[commit.agentId] = applyMindCommit(agent, commit, 0, [], []);
  }
  const entries = [
    ...state.history.map((step) => ({ kind: "step" as const, revision: step.revision, value: step })),
    ...state.admissions.map((commit) => ({ kind: "admission" as const, revision: commit.revision, value: commit })),
  ].sort((left, right) => left.revision - right.revision);
  assertUnique(entries.map((entry) => String(entry.revision)), "canonical revision log");
  for (const entry of entries) {
    if (entry.revision > throughRevision) break;
    if (entry.kind === "admission") {
      applyAdmissionCommit(replay, entry.value);
      continue;
    }
    const step = entry.value;
    validateCommittedStepShape(step, replay);
    if (step.baseRevision !== replay.revision || step.revision !== replay.revision + 1 || step.step !== replay.step + 1) {
      throw new Error(`history step ${step.step} is not contiguous`);
    }
    assertUnique(step.initialActions.map((action) => action.id), `history step ${step.step} initial actions`);
    assertUnique(step.initialActions.map((action) => action.actorId), `history step ${step.step} initial actors`);
    for (const action of step.initialActions) {
      if (!replay.agents[action.actorId]) throw new Error(`history step ${step.step} action targets unknown Agent`);
    }
    if (step.temporalBoundary.fromElapsedSeconds !== replay.truth.elapsedSeconds) {
      throw new Error(`history step ${step.step} temporal boundary starts from another clock`);
    }
    for (const plan of step.temporalPlans) {
      validateTemporalPlan(plan, replay.truth.mechanics.temporalProfiles, replay.truth.mechanics.activityResources);
      if (plan.startsAtSeconds !== step.temporalBoundary.fromElapsedSeconds) {
        throw new Error(`history step ${step.step} temporal plan starts from another clock`);
      }
      const activity = Object.values(step.temporalState.activities)
        .find((candidate) => candidate.status !== "queued" && candidate.status !== "ready" &&
          candidate.plan.id === plan.id);
      if (!activity || activity.sourceActionId !== plan.actionId) {
        throw new Error(`history step ${step.step} temporal plan has no persisted activity`);
      }
    }
    const outcomes = step.outcomes.map((outcome) => outcome.proposalId).sort();
    if (contentHash(outcomes) !== contentHash(step.actions.map((action) => action.id).sort())) {
      throw new Error(`history step ${step.step} outcome slots do not match actions`);
    }
    const proposal: TransitionProposal = {
      baseRevision: step.baseRevision,
      outcomes: structuredClone(step.outcomes),
      mechanicInvocations: structuredClone(step.mechanicInvocations),
      operations: structuredClone(step.operations),
      events: structuredClone(step.events),
      observations: structuredClone(step.observations),
      decisionRequests: structuredClone(step.decisionRequests),
    };
    const assertionResults = evaluateProposalCausality(replay, step.checks, step.randomResults, proposal);
    if (contentHash(assertionResults) !== contentHash(step.causalAssertionResults)) {
      throw new Error(`history step ${step.step} causal assertions do not replay`);
    }
    const advanced = applyTransitionProposal(replay, proposal, step.temporalState);
    advanced.truth.rng = structuredClone(step.rngAfter);
    validateObservations(advanced, step.observations, advanced.step);
    for (const agentId of Object.keys(advanced.agents)) {
      advanced.agents[agentId] = applyObservationBindings(
        advanced.agents[agentId],
        step.observations.filter((packet) => packet.observerId === agentId),
      );
    }
    const beliefs = new Map(step.beliefPatches.map((entry) => [entry.agentId, entry]));
    const characters = new Map(step.characterPatches.map((entry) => [entry.agentId, entry]));
    const actions = new Map(step.nextActions.map((entry) => [entry.actorId, entry]));
    const mindAgents = new Set([...beliefs.keys(), ...characters.keys(), ...actions.keys()]);
    for (const agentId of mindAgents) {
      const agent = advanced.agents[agentId];
      const beliefPatch = beliefs.get(agentId);
      const characterPatch = characters.get(agentId);
      const nextAction = actions.get(agentId);
      if (!agent || !beliefPatch || !characterPatch || !nextAction) throw new Error(`partial AgentMind commit for ${agentId}`);
      const observed = pendingObservationsFor(
        advanced,
        agent,
        step.observations.filter((packet) => packet.observerId === agentId),
      );
      advanced.agents[agentId] = applyMindCommit(
        agent,
        { beliefPatch, characterPatch, nextAction },
        advanced.step,
        observed,
        step.events,
      );
    }
    advanced.executionState = structuredClone(step.executionState);
    advanced.history.push(structuredClone(step));
    Object.assign(replay, advanced);
  }
  if (replay.revision !== throughRevision) {
    throw new Error(`canonical revision ${throughRevision} is not present in the replay log`);
  }
  return replay;
}

export function replayCommittedHistory(state: SimulationState): void {
  const replay = replaySimulationState(state);
  const core = (value: SimulationState) => ({
    revision: value.revision,
    executionState: value.executionState,
    step: value.step,
    truth: value.truth,
    agents: value.agents,
    admissions: value.admissions,
    history: value.history,
  });
  if (contentHash(core(replay)) !== contentHash(core(state))) throw new Error("state does not match replayed history");
}

export function validateModelAudit(
  audit: ModelExecutionAudit,
  label: string,
  _worldHash?: string,
  _revision?: number,
  seenInvocationIds = new Set<string>(),
): void {
  if (!modelRoles.includes(audit.role) || !audit.subjectId.trim() || !audit.profileId.trim() ||
    !audit.accountId.trim() || !modelAccountChannels.includes(audit.accountChannel) ||
    !modelProtocols.includes(audit.protocol) || !audit.dialect.trim() ||
    !audit.providerId.trim() || !audit.modelId.trim() || audit.modelCatalogSchemaVersion !== 3 ||
    !isSha256(audit.registrySnapshotHash) || !isSha256(audit.modelMetadataHash) ||
    !isSha256(audit.modelCatalogHash) || !audit.promptVersion.trim() ||
    !["json-schema-strict", "json-object-zod", "tool-call-zod", "deterministic-test"]
      .includes(audit.structuredOutputMode)) throw new Error(`${label} has invalid model identity`);
  modelSelectorSchema.parse(audit.selector);
  modelInferenceSchema.parse(audit.requestedInference);
  resolvedModelInferenceSchema.parse(audit.resolvedInference);
  if (audit.invocations.length === 0) throw new Error(`${label} has no invocations`);
  for (const invocation of audit.invocations) {
    if (!invocation.id.trim() || seenInvocationIds.has(invocation.id)) throw new Error(`${label} has duplicate invocation id`);
    seenInvocationIds.add(invocation.id);
    if (!Number.isSafeInteger(invocation.ordinal) || invocation.ordinal <= 0 || !isSha256(invocation.requestHash) ||
      (invocation.responseHash !== null && !isSha256(invocation.responseHash)) || invocation.transports.length === 0) {
      throw new Error(`${label} has invalid invocation audit`);
    }
  }
}

export function validateSimulationState(state: SimulationState, requireNextActions = false, requireHistoryAlignment = false): void {
  assertExactKeys(state, [
    "schemaVersion", "executionState", "worldId", "worldHash", "lawIds", "revision", "step", "truth", "agents", "admissions", "history",
    "bootstrapAgentCommits",
  ], ["historyBase", "bootstrapExecutionRef"], "simulation state");
  validateAlgorithmExecutionState(state.executionState);
  if (state.schemaVersion !== 16 || !isSemanticId(state.worldId) || !/^sha256:[a-f0-9]{64}$/.test(state.worldHash)) {
    throw new Error("invalid simulation identity");
  }
  if (state.bootstrapExecutionRef) validateExecutionRef(state.bootstrapExecutionRef, "bootstrapExecutionRef");
  if (!Number.isSafeInteger(state.revision) || state.revision < 0 || !Number.isSafeInteger(state.step) || state.step < 0 ||
    !Number.isSafeInteger(state.truth.elapsedSeconds) || state.truth.elapsedSeconds < 0) throw new Error("invalid world clock");
  assertExactKeys(state.truth, [
    "elapsedSeconds", "rng", "events", "entities", "placements", "facts", "factTombstones", "mechanics",
    "meters", "quantities", "ratings", "conditions", "activities", "sharedActivityResourcePools", "timers",
  ], [], "canonical truth");
  assertExactKeys(state.truth.mechanics, [
    "meters", "quantities", "ratings", "impactProfiles", "durationProfiles", "conditionProfiles",
    "entityMechanicsProfiles", "adjudicationCalibrations", "activityResources", "temporalProfiles",
    "sharedActivityResources", "temporalCalibrations",
  ], [], "mechanics catalog");
  for (const [id, definition] of Object.entries(state.truth.mechanics.meters)) {
    if (definition.id !== id || !definition.name.trim() || !Number.isFinite(definition.min) ||
      !Number.isFinite(definition.max) || definition.max <= definition.min) throw new Error(`invalid meter definition ${id}`);
  }
  for (const [id, definition] of Object.entries(state.truth.mechanics.quantities)) {
    if (definition.id !== id || !definition.name.trim() || !definition.unit.trim()) throw new Error(`invalid quantity definition ${id}`);
  }
  for (const [id, definition] of Object.entries(state.truth.mechanics.ratings)) {
    if (definition.id !== id || !definition.name.trim() || !Number.isFinite(definition.min) ||
      !Number.isFinite(definition.max) || definition.max < definition.min) throw new Error(`invalid rating definition ${id}`);
  }
  for (const [id, resource] of Object.entries(state.truth.mechanics.activityResources)) {
    if (resource.id !== id || !resource.name.trim() || !Number.isFinite(resource.capacity) || resource.capacity <= 0) {
      throw new Error(`invalid activity resource ${id}`);
    }
  }
  for (const [id, resource] of Object.entries(state.truth.mechanics.sharedActivityResources)) {
    if (resource.id !== id) throw new Error(`shared activity resource key mismatch ${id}`);
    validateSharedActivityResourceDefinition(resource);
  }
  for (const [id, profile] of Object.entries(state.truth.mechanics.temporalProfiles)) {
    if (profile.id !== id) throw new Error(`temporal profile key mismatch ${id}`);
    validateTemporalProfile(profile, state.truth.mechanics.activityResources);
  }
  assertUnique(state.truth.mechanics.temporalCalibrations.map((entry) => entry.id), "temporal calibrations");
  for (const calibration of state.truth.mechanics.temporalCalibrations) {
    if (!calibration.id.trim() || !calibration.situation.trim() || !calibration.explanation.trim() ||
      !state.truth.mechanics.temporalProfiles[calibration.profileId]) {
      throw new Error(`invalid temporal calibration ${calibration.id}`);
    }
  }
  for (const [id, profile] of Object.entries(state.truth.mechanics.impactProfiles)) {
    if (profile.id !== id || !state.truth.mechanics.meters[profile.meterDefinitionId]) {
      throw new Error(`invalid impact profile ${id}`);
    }
    validateImpactProfile(profile);
  }
  for (const [id, profile] of Object.entries(state.truth.mechanics.durationProfiles)) {
    if (profile.id !== id || !profile.name.trim() ||
      (profile.kind === "uses" && (!Number.isSafeInteger(profile.uses) || profile.uses <= 0)) ||
      (profile.kind === "elapsed" && (!Number.isSafeInteger(profile.seconds) || profile.seconds <= 0))) {
      throw new Error(`invalid duration profile ${id}`);
    }
  }
  for (const [id, profile] of Object.entries(state.truth.mechanics.conditionProfiles)) {
    if (profile.id !== id || !state.truth.mechanics.durationProfiles[profile.defaultDurationProfileId] ||
      (profile.recurringImpactProfileId !== null && !state.truth.mechanics.impactProfiles[profile.recurringImpactProfileId])) {
      throw new Error(`invalid condition profile ${id}`);
    }
  }
  for (const [id, profile] of Object.entries(state.truth.mechanics.entityMechanicsProfiles)) {
    if (profile.id !== id || !profile.name.trim()) throw new Error(`invalid entity mechanics profile ${id}`);
    const refs = [
      ...profile.meters.map((entry) => `meter:${entry.definitionId}`),
      ...profile.quantities.map((entry) => `quantity:${entry.definitionId}`),
      ...profile.ratings.map((entry) => `rating:${entry.definitionId}`),
    ];
    assertUnique(refs, `entity mechanics profile ${id}`);
    for (const entry of profile.meters) {
      const definition = state.truth.mechanics.meters[entry.definitionId];
      if (!definition || entry.current < definition.min || entry.current > definition.max) {
        throw new Error(`invalid entity mechanics profile ${id} meter ${entry.definitionId}`);
      }
    }
    for (const entry of profile.quantities) {
      if (!state.truth.mechanics.quantities[entry.definitionId] || !Number.isFinite(entry.amount) || entry.amount < 0) {
        throw new Error(`invalid entity mechanics profile ${id} quantity ${entry.definitionId}`);
      }
    }
    for (const entry of profile.ratings) {
      const definition = state.truth.mechanics.ratings[entry.definitionId];
      if (!definition || entry.value < definition.min || entry.value > definition.max) {
        throw new Error(`invalid entity mechanics profile ${id} rating ${entry.definitionId}`);
      }
    }
  }
  const calibrationIds = state.truth.mechanics.adjudicationCalibrations.map((entry) => entry.id);
  assertUnique(calibrationIds, "adjudication calibrations");
  assertUnique(state.lawIds, "world laws");
  validatePlacementCycles(state);
  for (const [id, entity] of Object.entries(state.truth.entities)) {
    entitySchema.parse(entity);
    if (entity.id !== id) throw new Error(`entity key does not match ${entity.id}`);
  }
  const entityIds = new Set(Object.keys(state.truth.entities));
  const entityResourceDefinitions = new Set<string>();
  for (const [id, pool] of Object.entries(state.truth.sharedActivityResourcePools)) {
    sharedActivityResourcePoolSchema.parse(pool);
    if (pool.id !== id) throw new Error(`shared activity resource pool key mismatch ${id}`);
    validateSharedActivityResourcePool(
      state.worldHash,
      pool,
      state.truth.mechanics.sharedActivityResources,
      entityIds,
    );
    const entityDefinitionKey = `${pool.entityId}\u0000${pool.definitionId}`;
    if (entityResourceDefinitions.has(entityDefinitionKey)) {
      throw new Error(`duplicate shared activity resource pool for ${pool.entityId} ${pool.definitionId}`);
    }
    entityResourceDefinitions.add(entityDefinitionKey);
  }
  for (const [id, fact] of Object.entries(state.truth.facts)) {
    persistedFactSchema.parse(fact);
    if (fact.id !== id || !state.truth.entities[fact.subjectId] || fact.provenance.length === 0) throw new Error(`invalid Fact ${id}`);
    assertFactValueReferences(fact.value, state, `fact ${id}`);
    if (fact.access.kind === "agents" && fact.access.agentIds.some((agentId) => !state.agents[agentId])) {
      throw new Error(`Fact ${id} grants access to unknown Agent`);
    }
  }
  assertUnique(state.truth.factTombstones, "fact tombstones");
  for (const id of state.truth.factTombstones) if (state.truth.facts[id]) throw new Error(`Fact ${id} is active and tombstoned`);
  for (const [id, meter] of Object.entries(state.truth.meters)) {
    meterSchema.parse(meter);
    if (meter.id !== id) throw new Error(`meter key mismatch ${id}`);
    validateMeter(state, meter);
  }
  for (const [id, quantity] of Object.entries(state.truth.quantities)) {
    quantityStateSchema.parse(quantity);
    if (quantity.id !== id || quantity.id !== quantityKey(state, quantity.definitionId, quantity.holderId) ||
      !state.truth.mechanics.quantities[quantity.definitionId] || !state.truth.entities[quantity.holderId]) throw new Error(`invalid quantity ${id}`);
  }
  for (const [id, rating] of Object.entries(state.truth.ratings)) {
    ratingSchema.parse(rating);
    const definition = state.truth.mechanics.ratings[rating.definitionId];
    if (rating.id !== id || !definition || !state.truth.entities[rating.entityId] ||
      rating.value < definition.min || rating.value > definition.max) throw new Error(`invalid rating ${id}`);
  }
  for (const [id, condition] of Object.entries(state.truth.conditions)) {
    conditionStateSchema.parse(condition);
    if (condition.id !== id || !state.truth.entities[condition.subjectId] ||
      !state.truth.mechanics.durationProfiles[condition.durationProfileId] ||
      (condition.conditionProfileId !== null && !state.truth.mechanics.conditionProfiles[condition.conditionProfileId]) ||
      (condition.expiresAtElapsedSeconds !== null && condition.expiresAtElapsedSeconds <= state.truth.elapsedSeconds)) {
      throw new Error(`invalid condition ${id}`);
    }
  }
  for (const [id, activity] of Object.entries(state.truth.activities)) {
    if (activity.id !== id) throw new Error(`activity key mismatch ${id}`);
    actionProposalSchema.parse(activity.sourceAction);
    if (!state.agents[activity.actorId] || activity.participantAgentIds.some((agentId) => !state.agents[agentId])) {
      throw new Error(`activity ${id} references unknown Agent`);
    }
    validateActivityState(
      activity,
      state.truth.elapsedSeconds,
      state.truth.mechanics.temporalProfiles,
      state.truth.mechanics.activityResources,
    );
    for (const ref of [...activity.interactionFootprint.reads, ...activity.interactionFootprint.writes]) {
      const known = ref.kind === "global" ||
        (ref.kind === "entity" || ref.kind === "placement") && Boolean(state.truth.entities[ref.id]) ||
        ref.kind === "fact" && Boolean(state.truth.facts[ref.id]) ||
        ref.kind === "meter" && Boolean(state.truth.meters[ref.id]) ||
        ref.kind === "quantity" && Boolean(state.truth.quantities[ref.id]) ||
        ref.kind === "rating" && Boolean(state.truth.ratings[ref.id]) ||
        ref.kind === "condition" && Boolean(state.truth.conditions[ref.id]) ||
        ref.kind === "activity" && Boolean(state.truth.activities[ref.id]) ||
        ref.kind === "shared_resource_pool" && Boolean(state.truth.sharedActivityResourcePools[ref.id]);
      if (!known) throw new Error(`activity ${id} footprint references unknown ${ref.kind} ${ref.id}`);
    }
    const claimPoolIds = new Set<string>();
    const activityCauses = activity.status === "queued" || activity.status === "ready"
      ? activity.planDraft.causes
      : activity.plan.causes;
    for (const claim of activity.interactionFootprint.sharedResourceClaims) {
      if (claimPoolIds.has(claim.poolId)) throw new Error(`activity ${id} repeats shared resource claim ${claim.poolId}`);
      claimPoolIds.add(claim.poolId);
      validateSharedActivityResourceClaimForAction(
        claim,
        activity.sourceAction.rawText,
        state.truth.sharedActivityResourcePools,
        state.truth.mechanics.sharedActivityResources,
        new Set(activityCauses.filter((cause) => cause.kind === "mechanic").map((cause) => cause.id)),
      );
    }
    const unknownAudienceAgentId = activity.interactionFootprint.audienceAgentIds
      .find((agentId) => !state.agents[agentId]);
    if (unknownAudienceAgentId) {
      throw new Error(`activity ${id} footprint references unknown audience Agent ${unknownAudienceAgentId}`);
    }
  }
  validateActivityResources(state.truth.activities, state.truth.mechanics.activityResources);
  validateSharedResourceCapacity({
    activities: state.truth.activities,
    pools: state.truth.sharedActivityResourcePools,
    definitions: state.truth.mechanics.sharedActivityResources,
    entities: state.truth.entities,
  });
  const latestCommittedStep = state.history.at(-1);
  const currentDecisionPoints = latestCommittedStep?.revision === state.revision
    ? latestCommittedStep.decisionPoints
    : [];
  for (const point of currentDecisionPoints) {
    const occupying = Object.values(state.truth.activities).find((activity) =>
      activity.status === "active" && activity.participantAgentIds.includes(point.agentId));
    if (occupying) {
      throw new Error(`decision point for ${point.agentId} conflicts with active Activity ${occupying.id}`);
    }
  }
  for (const [id, timer] of Object.entries(state.truth.timers)) {
    if (timer.id !== id) throw new Error(`timer key mismatch ${id}`);
    validateWorldTimer(timer, state.truth.elapsedSeconds);
    if (timer.wakeAgentIds.some((agentId) => !state.agents[agentId])) {
      throw new Error(`timer ${id} wakes unknown Agent`);
    }
  }
  const ownedEntities = new Set<string>();
  const actionIds = new Set<string>();
  for (const [id, agent] of Object.entries(state.agents)) {
    agentStateSchema.parse(agent);
    if (agent.id !== id || !state.truth.entities[agent.entityId] || state.truth.entities[agent.entityId].lifecycle !== "active" ||
      ownedEntities.has(agent.entityId) || agent.observationCursorStep > state.step) throw new Error(`invalid Agent ${id}`);
    ownedEntities.add(agent.entityId);
    validateBelief(agent.belief, agent.bindings, state, `Agent ${id}`);
    if (Object.values(agent.bindings).filter((binding) => binding.canonicalEntityIds.includes(agent.entityId)).length !== 1) {
      throw new Error(`Agent ${id} must have exactly one self binding`);
    }
    validateCharacterState(agent.character, agent.belief, state.step, `Agent ${id}`);
    if (requireNextActions && !agent.nextAction) throw new Error(`Agent ${id} has no next action`);
    if (agent.nextAction) {
      actionProposalSchema.parse(agent.nextAction);
      if (agent.nextAction.actorId !== id || agent.nextAction.baseRevision !== state.revision || actionIds.has(agent.nextAction.id)) {
        throw new Error(`Agent ${id} has an invalid prepared action`);
      }
      actionIds.add(agent.nextAction.id);
      for (const targetId of agent.nextAction.targetIds) {
        if (!agent.belief.localEntities[targetId]) throw new Error(`Agent ${id} targets unknown local entity`);
      }
    }
  }
  for (const commit of state.bootstrapAgentCommits) {
    beliefPatchSchema.parse(commit.beliefPatch);
    characterPatchSchema.parse(commit.characterPatch);
    actionProposalSchema.parse(commit.nextAction);
    if (commit.agentId !== commit.nextAction.actorId) throw new Error("bootstrap commit changes ownership");
  }
  for (const admission of state.admissions) validateAdmissionShape(admission);
  const eventIds = new Set<string>();
  for (const event of state.truth.events) {
    if (!isRuntimeId(event.id, "event") || eventIds.has(event.id) || event.step < 1 || event.step > state.step) {
      throw new Error(`invalid world event ${event.id}`);
    }
    eventIds.add(event.id);
    assertCauses(event.causes, `event ${event.id}`);
    if (event.assertions.length === 0) throw new Error(`event ${event.id} has no assertions`);
  }
  if (state.historyBase) {
    assertExactKeys(state.historyBase, ["truth", "agents", "executionState"], [], "history replay base");
    validateAlgorithmExecutionState(state.historyBase.executionState);
  }
  if (requireHistoryAlignment) replayCommittedHistory(state);
}

export const simulationStateSchema = z.unknown().transform((value, context) => {
  try {
    validateSimulationState(value as SimulationState, false, true);
    return value as SimulationState;
  } catch (error) {
    context.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) });
    return z.NEVER;
  }
}) as z.ZodType<SimulationState>;

export class TransitionValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join("; "));
    this.name = "TransitionValidationError";
  }
}

export function applyTransitionProposal(
  source: SimulationState,
  proposal: TransitionProposal,
  temporalState?: Readonly<import("../mechanics/temporal").TemporalStateSnapshot>,
): SimulationState {
  const issues: string[] = [];
  if (proposal.baseRevision !== source.revision) issues.push(`stale proposal revision ${proposal.baseRevision}; expected ${source.revision}`);
  try {
    persistedTransitionProposalSchema.parse(proposal);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }
  if (proposal.operations.filter((operation) => operation.kind === "advance_time").length !== 1) {
    issues.push("every world step must contain exactly one time advance");
  }
  const next = structuredClone(source);
  if (issues.length === 0) {
    for (const operation of proposal.operations) {
      try {
        applyWorldDeltaOperation(next, operation);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
        break;
      }
    }
  }
  if (issues.length === 0) {
    try {
      for (const [conditionId, condition] of Object.entries(next.truth.conditions)) {
        if (condition.expiresAtElapsedSeconds !== null &&
          condition.expiresAtElapsedSeconds <= next.truth.elapsedSeconds) {
          delete next.truth.conditions[conditionId];
        }
      }
      if (temporalState) {
        next.truth.activities = structuredClone(temporalState.activities);
        next.truth.timers = structuredClone(temporalState.timers);
      }
      next.revision += 1;
      next.step += 1;
      next.truth.events.push(...structuredClone(proposal.events));
      for (const [agentId, agent] of Object.entries(next.agents)) {
        if (next.truth.entities[agent.entityId]?.lifecycle !== "active") delete next.agents[agentId];
        else agent.nextAction = null;
      }
      for (const request of proposal.decisionRequests) {
        if (!next.agents[request.agentId]) throw new Error(`decision request targets unknown Agent ${request.agentId}`);
      }
      validateSimulationState(next, false);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (issues.length > 0) throw new TransitionValidationError(issues);
  return next;
}

export function createEmptyBelief(): AgentState["belief"] {
  return { localEntities: {}, claims: {}, evidence: {} };
}

export function createEmptyCharacter(summary: string, voice = ""): AgentState["character"] {
  return {
    persona: { summary, voice, updatedAtStep: 0, evidenceIds: [] },
    traits: {},
    values: {},
    emotions: {},
    attitudes: {},
    goals: {},
    commitments: {},
  };
}
