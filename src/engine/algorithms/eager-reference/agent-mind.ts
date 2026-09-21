import { z } from "zod";
import { applyBeliefPatch } from "../../cognition/belief";
import { applyCharacterPatch } from "../../cognition/character";
import {
  agentMindBatchOutputSchema,
  reactionDecisionDraftSchema,
  type AgentMindDraftOutput,
  type AgentMindOutput,
  type ReactionDecisionDraft,
} from "../../contracts/llm-schemas";
import type {
  AgentActionProposal,
  AgentState,
  BeliefPatch,
  BeliefPatchOperation,
  CharacterPatch,
  ModelExecutionAudit,
  ObservationPacket,
  ReactionDecision,
  ReactionRequest,
  SimulationState,
  WorldEvent,
} from "../../contracts/model";
import {
  eagerRequestBytes,
  eagerSlotBatchOwner,
  DEFAULT_EAGER_OUTPUT_RECOVERY,
  EagerSlotAttemptError,
  isTerminalEagerModelError,
  runEagerSlotBatches,
  settleEagerWork,
  type EagerSlot,
  type EagerSlotAttemptLineage,
} from "./eager-slot-batching";
import type {
  AgentCognitionBatchInput,
  AgentCognitionBatchResult,
  OutputRecoveryCapability,
} from "../roles";
import {
  modelInvocationCorrelation,
  modelInvocationLogicalId,
  modelInvocationIdentity,
  ModelSemanticRepairError,
  setModelInvocationOutcome,
  setModelInvocationResultKind,
  type ModelExecutionScope,
  type StructuredModelProvider,
} from "../../models/model-provider";
import { contentHash } from "../../models/model-audit";
import {
  type AgentMindBatchContextEnvelope,
  type AgentMindBatchSlotContext,
} from "../../contracts/model-context";
import { fullRuntimePayload, runtimeEventEmitter, serializeRuntimeError } from "../../runtime/observability";
import {
  buildAgentSharedContext,
  buildAgentSlotContext,
  buildReactionContext,
  sanitizeObservationForAgent,
  validationIssues,
  type PromptValidationIssue,
} from "../../contracts/prompts";
import {
  createAgentReferenceResolver,
  ModelReferenceError,
  isProposalReference,
  normalizeModelOutput,
  type ModelReference,
  type ReferenceResolver,
} from "../../contracts/model-context";
import { promptBundle } from "../../prompts";
import { runtimeId } from "../../runtime/runtime-id";
import {
  SemanticRepairExhaustedError,
  runSemanticRepairLoop,
  semanticIssue,
} from "../../models/semantic-repair";

function assertBeliefIdentityHistory(
  state: SimulationState,
  agent: AgentState,
  patch: BeliefPatch,
): void {
  const usedLocalIds = new Set([
    ...Object.keys(state.historyBase?.agents[agent.id]?.belief.localEntities ?? {}),
    ...Object.keys(agent.belief.localEntities),
  ]);
  const claimBindings = new Map(Object.values(state.historyBase?.agents[agent.id]?.belief.claims ?? {})
    .map((claim) => [claim.id, `${claim.subjectId}\u0000${claim.predicate}`]));
  for (const claim of Object.values(agent.belief.claims))
    claimBindings.set(claim.id, `${claim.subjectId}\u0000${claim.predicate}`);
  for (const commit of state.bootstrapAgentCommits) {
    if (commit.agentId !== agent.id) continue;
    for (const operation of commit.beliefPatch.operations) {
      if (operation.kind === "upsert_local_entity") usedLocalIds.add(operation.entity.id);
      if (operation.kind === "split_local_entity") {
        for (const entity of operation.entities) usedLocalIds.add(entity.id);
      }
      if (operation.kind === "upsert_claim") {
        claimBindings.set(operation.claim.id, `${operation.claim.subjectId}\u0000${operation.claim.predicate}`);
      }
    }
  }
  for (const step of state.history) {
    for (const operation of step.operations) {
      if (operation.kind === "create_agent" && operation.agent.id === agent.id) {
        for (const id of Object.keys(operation.agent.belief.localEntities)) usedLocalIds.add(id);
      }
    }
    for (const observation of step.observations) {
      if (observation.observerId !== agent.id) continue;
      for (const introduction of observation.introductions) usedLocalIds.add(introduction.localEntity.id);
    }
    for (const patch of step.beliefPatches) {
      if (patch.agentId !== agent.id) continue;
      for (const operation of patch.operations) {
        if (operation.kind === "upsert_local_entity") usedLocalIds.add(operation.entity.id);
        if (operation.kind === "split_local_entity") {
          for (const entity of operation.entities) usedLocalIds.add(entity.id);
        }
        if (operation.kind === "upsert_claim") {
          claimBindings.set(operation.claim.id, `${operation.claim.subjectId}\u0000${operation.claim.predicate}`);
        }
      }
    }
  }
  const activeLocalIds = new Set(Object.keys(agent.belief.localEntities));
  for (const operation of patch.operations) {
    if (operation.kind === "upsert_local_entity") {
      if (!activeLocalIds.has(operation.entity.id) && usedLocalIds.has(operation.entity.id)) {
        throw new Error(`AgentMind ${agent.id} reuses retired local identity ${operation.entity.id}`);
      }
      activeLocalIds.add(operation.entity.id);
      usedLocalIds.add(operation.entity.id);
    } else if (operation.kind === "remove_local_entity") {
      activeLocalIds.delete(operation.localEntityId);
    } else if (operation.kind === "merge_local_entities") {
      activeLocalIds.delete(operation.fromId);
    } else if (operation.kind === "split_local_entity") {
      activeLocalIds.delete(operation.fromId);
      for (const entity of operation.entities) {
        if (usedLocalIds.has(entity.id)) {
          throw new Error(`AgentMind ${agent.id} reuses retired local identity ${entity.id}`);
        }
        activeLocalIds.add(entity.id);
        usedLocalIds.add(entity.id);
      }
    } else if (operation.kind === "upsert_claim") {
      const binding = `${operation.claim.subjectId}\u0000${operation.claim.predicate}`;
      if (claimBindings.has(operation.claim.id) && claimBindings.get(operation.claim.id) !== binding) {
        throw new Error(`AgentMind ${agent.id} rebinds claim ${operation.claim.id}`);
      }
      claimBindings.set(operation.claim.id, binding);
    }
  }
}

type ProposalBinding = { kind: string; id: string };

function modelOwnedId(
  agent: AgentState,
  revision: number,
  namespace: string,
  key: string,
): string {
  return `agent-${namespace}-${contentHash({ agentId: agent.id, revision, namespace, key }).slice(0, 32)}`;
}

function resolveModelReference(
  reference: ModelReference,
  use: Parameters<ReferenceResolver["resolve"]>[1],
  resolver: ReferenceResolver,
  proposals: ReadonlyMap<string, ProposalBinding>,
  expectedKinds: readonly string[],
): string {
  if (isProposalReference(reference)) {
    const proposal = proposals.get(reference.proposalKey);
    if (!proposal) {
      throw new Error(`unknown proposalKey ${reference.proposalKey}; proposal keys must be declared before use`);
    }
    if (expectedKinds.length > 0 && !expectedKinds.includes(proposal.kind)) {
      throw new Error(`proposalKey ${reference.proposalKey} is ${proposal.kind}, expected ${expectedKinds.join(" or ")}`);
    }
    return proposal.id;
  }
  const resolved = resolver.resolve(reference, use);
  if (expectedKinds.length > 0 && !expectedKinds.includes(resolved.kind)) {
    throw new Error(`reference ${reference} is ${resolved.kind}, expected ${expectedKinds.join(" or ")}`);
  }
  return resolved.engineId;
}

function registerProposal(
  proposals: Map<string, ProposalBinding>,
  key: string,
  kind: string,
  id: string,
): void {
  if (proposals.has(key)) throw new Error(`duplicate proposalKey ${key}`);
  proposals.set(key, { kind, id });
}

function materializeBeliefPatch(
  agent: AgentState,
  state: SimulationState,
  observations: readonly ObservationPacket[],
  output: AgentMindDraftOutput,
  resolver: ReferenceResolver,
): { patch: BeliefPatch; proposals: ReadonlyMap<string, ProposalBinding> } {
  const proposals = new Map<string, ProposalBinding>();
  const operations: BeliefPatchOperation[] = [];
  const resolve = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], kinds: readonly string[]) =>
    resolveModelReference(reference, use, resolver, proposals, kinds);
  for (const [operationIndex, operation] of output.beliefChanges.operations.entries()) {
    const path = `beliefChanges.operations[${operationIndex}]`;
    switch (operation.kind) {
      case "upsert_local_entity": {
        const id = modelOwnedId(agent, state.revision, "local", operation.entity.proposalKey);
        registerProposal(proposals, operation.entity.proposalKey, "local_entity", id);
        operations.push({ kind: "upsert_local_entity", entity: { id, name: operation.entity.name, description: operation.entity.description, status: operation.entity.status } });
        break;
      }
      case "remove_local_entity":
        operations.push({ kind: operation.kind, localEntityId: resolve(operation.localEntityRef, "target", ["local_entity"]) });
        break;
      case "upsert_evidence": {
        const id = modelOwnedId(agent, state.revision, "evidence", operation.evidence.proposalKey);
        registerProposal(proposals, operation.evidence.proposalKey, "evidence", id);
        const sourceId = operation.evidence.sourceRef === null
          ? null
          : resolve(operation.evidence.sourceRef, "source", ["observation", "evidence"]);
        operations.push({
          kind: operation.kind,
          evidence: { id, kind: operation.evidence.kind, description: operation.evidence.description, sourceId, step: state.step },
        });
        break;
      }
      case "upsert_claim": {
        const id = modelOwnedId(agent, state.revision, "claim", operation.claim.proposalKey);
        registerProposal(proposals, operation.claim.proposalKey, "claim", id);
        const value = operation.claim.value.kind === "local_entity"
          ? { kind: "local_entity" as const, localEntityId: resolve(operation.claim.value.entityRef, "subject", ["local_entity"]) }
          : structuredClone(operation.claim.value);
        operations.push({
          kind: operation.kind,
          claim: {
            id,
            subjectId: resolve(operation.claim.subjectRef, "subject", ["local_entity"]),
            predicate: operation.claim.predicate,
            value,
            description: operation.claim.description,
            stance: operation.claim.stance,
            confidence: operation.claim.confidence,
            evidenceIds: operation.claim.evidenceRefs.map((reference) => resolve(reference, "evidence", ["evidence"])),
          },
        });
        break;
      }
      case "remove_claim":
        operations.push({ kind: operation.kind, claimId: resolve(operation.claimRef, "target", ["claim"]) });
        break;
      case "merge_local_entities":
        operations.push({
          kind: operation.kind,
          fromId: resolve(operation.fromRef, "target", ["local_entity"]),
          intoId: resolve(operation.intoRef, "target", ["local_entity"]),
        });
        break;
      case "split_local_entity": {
        const entities = operation.entities.map((entity) => {
          const id = modelOwnedId(agent, state.revision, "local", entity.proposalKey);
          registerProposal(proposals, entity.proposalKey, "local_entity", id);
          return { id, name: entity.name, description: entity.description, status: entity.status };
        });
        operations.push({
          kind: operation.kind,
          fromId: resolve(operation.fromRef, "target", ["local_entity"]),
          entities,
          assignments: operation.assignments.map((assignment) => ({
            claimId: resolve(assignment.claimRef, "target", ["claim"]),
            subjectId: assignment.subjectRef === null ? null : resolve(assignment.subjectRef, "subject", ["local_entity"]),
            valueId: assignment.valueRef === null ? null : resolve(assignment.valueRef, "subject", ["local_entity"]),
          })),
        });
        break;
      }
      default:
        throw new Error(`${path} has an unsupported belief operation`);
    }
  }
  return {
    patch: { agentId: agent.id, baseRevision: state.revision, operations },
    proposals,
  };
}

function materializeCharacterPatch(
  agent: AgentState,
  state: SimulationState,
  observations: readonly ObservationPacket[],
  output: AgentMindDraftOutput,
  resolver: ReferenceResolver,
  beliefProposals: ReadonlyMap<string, ProposalBinding>,
): CharacterPatch {
  const proposals = new Map<string, ProposalBinding>(beliefProposals);
  const resolve = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], kinds: readonly string[]) =>
    resolveModelReference(reference, use, resolver, proposals, kinds);
  const source = (operation: { observationRefs: ModelReference[]; evidenceRefs: ModelReference[] }) => ({
    sourceObservationIds: operation.observationRefs.map((reference) => resolve(reference, "source", ["observation"])),
    evidenceIds: operation.evidenceRefs.map((reference) => resolve(reference, "evidence", ["evidence"])),
  });
  const operations: CharacterPatch["operations"] = [];
  const newId = (kind: string, key: string): string => {
    const id = modelOwnedId(agent, state.revision, kind, key);
    registerProposal(proposals, key, kind, id);
    return id;
  };
  for (const operation of output.characterChanges.operations) {
    switch (operation.kind) {
      case "replace_persona":
        operations.push({ kind: operation.kind, summary: operation.summary, voice: operation.voice, ...source(operation) });
        break;
      case "create_trait":
      case "create_value":
        operations.push({ kind: operation.kind, facet: { id: newId("character_facet", operation.facet.proposalKey), description: operation.facet.description, strength: operation.facet.strength }, ...source(operation) });
        break;
      case "update_trait":
      case "update_value":
        operations.push({ kind: operation.kind, id: resolve(operation.facetRef, "replacement", ["character_facet"]), description: operation.description, strength: operation.strength, ...source(operation) });
        break;
      case "retire_trait":
      case "retire_value":
        operations.push({ kind: operation.kind, id: resolve(operation.facetRef, "replacement", ["character_facet"]), ...source(operation) });
        break;
      case "set_emotion":
        operations.push({ kind: operation.kind, emotion: { id: newId("emotion", operation.emotion.proposalKey), description: operation.emotion.description, intensity: operation.emotion.intensity }, ...source(operation) });
        break;
      case "resolve_emotion":
        operations.push({ kind: operation.kind, id: resolve(operation.emotionRef, "replacement", ["emotion"]), ...source(operation) });
        break;
      case "set_attitude":
        operations.push({ kind: operation.kind, attitude: { id: newId("attitude", operation.attitude.proposalKey), subjectId: resolve(operation.attitude.subjectRef, "subject", ["local_entity"]), description: operation.attitude.description, intensity: operation.attitude.intensity }, ...source(operation) });
        break;
      case "retire_attitude":
        operations.push({ kind: operation.kind, id: resolve(operation.attitudeRef, "replacement", ["attitude"]), ...source(operation) });
        break;
      case "create_goal":
        operations.push({ kind: operation.kind, goal: { id: newId("goal", operation.goal.proposalKey), description: operation.goal.description, priority: operation.goal.priority, progress: operation.goal.progress, targetIds: operation.goal.targetRefs.map((reference) => resolve(reference, "target", ["local_entity"])), parentGoalId: operation.goal.parentGoalRef === null ? null : resolve(operation.goal.parentGoalRef, "replacement", ["goal"]), motivatedByIds: operation.goal.motivatedByRefs.map((reference) => resolve(reference, "replacement", ["character_facet", "commitment"])) }, ...source(operation) });
        break;
      case "update_goal":
        operations.push({ kind: operation.kind, id: resolve(operation.goalRef, "replacement", ["goal"]), description: operation.description, priority: operation.priority, progress: operation.progress, targetIds: operation.targetRefs === null ? null : operation.targetRefs.map((reference) => resolve(reference, "target", ["local_entity"])), parentGoal: operation.parentGoal.kind === "unchanged" ? operation.parentGoal : operation.parentGoal.kind === "none" ? operation.parentGoal : { kind: "goal", goalId: resolve(operation.parentGoal.goalRef, "replacement", ["goal"]) }, motivatedByIds: operation.motivatedByRefs === null ? null : operation.motivatedByRefs.map((reference) => resolve(reference, "replacement", ["character_facet", "commitment"])), ...source(operation) });
        break;
      case "set_goal_status":
        operations.push({ kind: operation.kind, id: resolve(operation.goalRef, "replacement", ["goal"]), status: operation.status, ...source(operation) });
        break;
      case "create_commitment":
        operations.push({ kind: operation.kind, commitment: { id: newId("commitment", operation.commitment.proposalKey), description: operation.commitment.description, priority: operation.commitment.priority, subjectIds: operation.commitment.subjectRefs.map((reference) => resolve(reference, "target", ["local_entity"])) }, ...source(operation) });
        break;
      case "update_commitment":
        operations.push({ kind: operation.kind, id: resolve(operation.commitmentRef, "replacement", ["commitment"]), description: operation.description, priority: operation.priority, subjectIds: operation.subjectRefs === null ? null : operation.subjectRefs.map((reference) => resolve(reference, "target", ["local_entity"])), ...source(operation) });
        break;
      case "set_commitment_status":
        operations.push({ kind: operation.kind, id: resolve(operation.commitmentRef, "replacement", ["commitment"]), status: operation.status, ...source(operation) });
        break;
      default:
        throw new Error("characterChanges contains an unsupported operation");
    }
  }
  return { agentId: agent.id, baseRevision: state.revision, operations };
}

function validateMindOutput(
  agent: AgentState,
  state: SimulationState,
  observations: readonly ObservationPacket[],
  events: readonly WorldEvent[],
  output: AgentMindDraftOutput,
): AgentMindOutput {
  const { revision, step, worldHash } = state;
  const resolver = createAgentReferenceResolver(agent, observations);
  const beliefMaterialization = materializeBeliefPatch(agent, state, observations, output, resolver);
  const beliefPatch = beliefMaterialization.patch;
  assertBeliefIdentityHistory(state, agent, beliefPatch);
  const belief = applyBeliefPatch(agent.belief, beliefPatch);
  // Local identity is an Agent-owned namespace. A model may describe a
  // canonical entity, but it must choose a distinct local alias (for example
  // `守门人` rather than canonical entity id `keeper`). Catch collisions here
  // so the slot can be repaired before a candidate reaches canonical commit.
  for (const localEntityId of Object.keys(belief.localEntities)) {
    if (state.truth.entities[localEntityId]) {
      throw new Error(`AgentMind ${agent.id} local entity ${localEntityId} collides with canonical entity id; choose a local alias`);
    }
  }
  const characterPatch = materializeCharacterPatch(
    agent,
    state,
    observations,
    output,
    resolver,
    beliefMaterialization.proposals,
  );
  applyCharacterPatch(agent.character, belief, characterPatch, step, observations, events);
  const targetIds = output.nextActionIntent.targetHandles.map((handle) => {
    const resolved = resolver.resolve(handle, "target");
    if (resolved.kind !== "local_entity" || !belief.localEntities[resolved.engineId]) {
      throw new Error(`AgentMind ${agent.id} targeted unknown local entity handle ${handle}`);
    }
    return resolved.engineId;
  });
  const { targetHandles: _targetHandles, ...nextActionText } = output.nextActionIntent;
  void _targetHandles;
  return {
    beliefPatch,
    characterPatch,
    nextAction: {
      ...nextActionText,
      targetIds,
      id: runtimeId({
        worldHash,
        revision,
        kind: "action",
        stage: "prepared",
        owner: agent.id,
        round: 0,
        ordinal: 0,
      }),
      actorId: agent.id,
      baseRevision: revision,
    },
  };
}

/** The reaction validator admits known and newly introduced local entities only.
 * A local identity merely mentioned by an apparent claim is not an introduction. */
function reactionTargets(agent: AgentState, stimulus: ObservationPacket) {
  const allowed = new Set([
    ...Object.keys(agent.belief.localEntities),
    ...stimulus.introductions.map(introduction => introduction.localEntity.id),
  ]);
  const resolver = createAgentReferenceResolver(agent, [stimulus]);
  const handles = resolver.catalog.candidates.filter(candidate => candidate.kind === "local_entity" &&
    candidate.allowedUses.includes("target") && allowed.has(resolver.resolve(candidate.handle).engineId)).map(candidate => candidate.handle);
  return { resolver, handles };
}

/** Specialize only the target field; retain the complete canonical action contract. */
export function reactionTargetWireSchema(handles: readonly string[]) {
  const schema = z.toJSONSchema(reactionDecisionDraftSchema, { target: "draft-07" });
  const branch = schema.oneOf?.find(branch => {
    const kind = typeof branch === "object" ? branch.properties?.kind : undefined;
    return typeof kind === "object" && kind.const === "replace";
  });
  const replacement = typeof branch === "object" ? branch.properties?.replacementAction : undefined;
  const targets = typeof replacement === "object" ? replacement.properties?.targetHandles : undefined;
  if (typeof targets !== "object" || targets.type !== "array") throw new Error("Reaction target schema changed");
  targets.items = handles.length ? { type: "string", enum: [...handles] } : { not: {} };
  return schema;
}

function validateReactionDecision(
  worldHash: string,
  agent: AgentState,
  revision: number,
  originalAction: AgentActionProposal,
  request: ReactionRequest,
  decision: ReactionDecisionDraft,
): ReactionDecision {
  const stimulus = request.stimulus;
  if (decision.kind === "keep") {
    return {
      requestId: request.id,
      source: "model",
      agentId: agent.id,
      baseRevision: revision,
      originalProposalId: originalAction.id,
      kind: "keep",
      ongoingActivityDisposition: "continue",
    };
  }

  const replacement = decision.replacementAction;
  const { resolver, handles } = reactionTargets(agent, stimulus);
  const targetIds = replacement.targetHandles.map((handle, index) => {
    if (!handles.includes(handle)) {
      throw new ModelReferenceError({ code: resolver.catalog.candidates.some(candidate => candidate.handle === handle)
        ? "reference.disallowed_use" : "reference.unknown_handle",
        path: ["replacementAction", "targetHandles", index], originalValue: handle,
        allowedHandles: handles,
        reason: "Replacement targets must be known or newly introduced local entities; observations and claims are evidence, not action targets.",
      });
    }
    return resolver.resolve(handle, "target").engineId;
  });
  const { targetHandles: _targetHandles, ...replacementText } = replacement;
  void _targetHandles;
  return {
    requestId: request.id,
    source: "model",
    agentId: agent.id,
    baseRevision: revision,
    originalProposalId: originalAction.id,
    kind: "replace",
    replacementAction: {
      ...replacementText,
      targetIds,
      id: runtimeId({
        worldHash,
        revision,
        kind: "action",
        stage: "reaction",
        owner: agent.id,
        round: 0,
        ordinal: 0,
      }),
      actorId: agent.id,
      baseRevision: revision,
    },
  };
}

type AgentMindSlot = EagerSlot<AgentCognitionBatchInput, PromptValidationIssue>;

function agentMindBatchContext(
  state: SimulationState,
  scope: ModelExecutionScope,
  purpose: "bootstrap" | "mind" | "resume",
  slots: readonly AgentMindSlot[],
) {
  const shared = buildAgentSharedContext({
    state,
    instanceId: scope.workloadId,
    advanceId: scope.batchId,
    promptId: purpose === "bootstrap" ? "agent-bootstrap" : "agent-mind",
  });
  const slotContexts: AgentMindBatchSlotContext<ReturnType<typeof buildAgentSlotContext>["state"]>[] = slots.map((slot, index) => {
    const slotContext = buildAgentSlotContext({
      state,
      agent: slot.payload.agent,
      observations: slot.payload.observations,
      events: slot.payload.events,
      currentAction: slot.payload.currentResolution.action,
      currentOutcome: slot.payload.currentResolution.outcome,
      issues: slot.issues,
    });
    return {
      slot: index,
      agentState: slotContext.state,
      task: {
        assignment: {
          targetHandles: slotContext.task.assignment.targetHandles,
          allowedProposalKinds: slotContext.task.assignment.allowedProposalKinds as AgentMindBatchSlotContext["task"]["assignment"]["allowedProposalKinds"],
        },
        constraints: slotContext.task.constraints,
      },
      referenceCatalog: slotContext.referenceCatalog,
      allowedTargetHandles: slotContext.referenceCatalog.candidates
        .filter((candidate) => candidate.kind === "local_entity" && candidate.allowedUses.includes("target"))
        .map((candidate) => candidate.handle),
      repair: slotContext.repair,
    };
  });
  return {
    ...shared,
    slots: slotContexts,
  } satisfies AgentMindBatchContextEnvelope<ReturnType<typeof buildAgentSlotContext>["state"]>;
}

function assertAgentMindSlotCoverage(
  slots: readonly AgentMindSlot[],
  drafts: readonly { slot: number }[],
): void {
  if (drafts.length !== slots.length) {
    throw new Error(`AgentMind returned ${drafts.length} items for ${slots.length} slots`);
  }
  const indexes = drafts.map((draft) => draft.slot).sort((left, right) => left - right);
  if (indexes.some((slot, index) => slot !== index)) {
    throw new Error("AgentMind did not cover every slot exactly once");
  }
}

export class AgentMind {
  constructor(
    private readonly provider: StructuredModelProvider,
    private readonly recovery: Readonly<OutputRecoveryCapability> = DEFAULT_EAGER_OUTPUT_RECOVERY,
  ) {}

  async thinkBatch(
    state: SimulationState,
    inputs: readonly AgentCognitionBatchInput[],
    scope: ModelExecutionScope,
    purpose: "bootstrap" | "mind" | "resume" = "mind",
    maxSlots = 1,
  ): Promise<AgentCognitionBatchResult> {
    if (inputs.length === 0) {
      return {
        outputs: new Map(),
        failures: [],
        modelAudits: [],
        batchCount: 0,
        metrics: { submittedSlots: 0, repairCalls: 0, repeatedFingerprints: 0, splitCount: 0, partialFailureSlots: 0, singletonFailures: 0 },
      };
    }
    const ids = inputs.map((input) => input.agent.id);
    if (new Set(ids).size !== ids.length) throw new Error("AgentMind batch contains duplicate Agents");
    const observe = runtimeEventEmitter(scope.observer);
    const role = purpose === "bootstrap" ? "agent-bootstrap" : "agent-mind";
    const prompt = promptBundle(role);
    const groups = new Map<string, AgentMindSlot[]>();
    for (const input of [...inputs].sort((left, right) => left.agent.id.localeCompare(right.agent.id))) {
      const profileId = purpose === "bootstrap" ? input.agent.modelProfiles.bootstrap : input.agent.modelProfiles.mind;
      const group = groups.get(profileId) ?? [];
      group.push({ key: input.agent.id, payload: input, issues: [] });
      groups.set(profileId, group);
    }
    const groupResults = await settleEagerWork([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(async ([profileId, slots]) => runEagerSlotBatches({
        slots,
        maxSlots,
        maxInputBytes: this.provider.catalog.profile(profileId).max_input_bytes,
        requestBytes: (batch) => eagerRequestBytes(
          prompt.system,
          prompt.userPrompt,
          agentMindBatchContext(state, scope, purpose, batch),
          agentMindBatchOutputSchema,
        ),
        label: `AgentMind ${purpose}`,
        issuesForError: (error) => validationIssues(error),
        recovery: this.recovery,
        invoke: async (batch, attempt, lineage: EagerSlotAttemptLineage) => {
          const owner = eagerSlotBatchOwner(`agent-mind-${purpose}`, batch);
          const identity = modelInvocationIdentity(scope, role, owner, attempt + 1);
          const correlation = modelInvocationCorrelation(scope, role, owner, identity, lineage);
          let generated;
          try {
            const contextStartedAt = Date.now();
            const context = agentMindBatchContext(state, scope, purpose, batch);
            observe?.({
              event: "model.context.built",
              correlation,
              durationMs: Math.max(0, Date.now() - contextStartedAt),
              hashes: { context: contentHash(context) },
            });
            generated = await this.provider.generateStructured({
              profileId,
              workloadId: scope.workloadId,
              batchId: scope.batchId,
              abortSignal: scope.abortSignal,
              correlation,
              observer: scope.observer,
              ...identity,
              role,
              subjectId: owner,
              promptVersion: prompt.version,
              schemaName: "agent_mind_batch_output",
              system: prompt.system,
              userPrompt: prompt.userPrompt,
              context,
              schema: agentMindBatchOutputSchema,
            });
            assertAgentMindSlotCoverage(batch, generated.value.slots);
          } catch (error) {
            if (isTerminalEagerModelError(error)) throw error;
            const audit = error && typeof error === "object" && "audit" in error
              ? (error as { audit?: ModelExecutionAudit }).audit
              : generated?.audit;
            const issues = validationIssues(error);
            if (audit?.invocations.length) {
              setModelInvocationOutcome(audit, "rejected", issues.map((issue) => issue.code));
            }
            observe?.({
              event: "model.semantic.rejected",
              level: "warn",
              correlation,
              attributes: { resultKind: `agent_mind_${purpose}_batch` },
              counts: { validationIssues: issues.length },
              payload: scope.observer ? fullRuntimePayload(scope.observer, { issues }) : undefined,
              error: serializeRuntimeError(error),
            });
            throw new EagerSlotAttemptError(
              error instanceof Error ? error.message : String(error),
              audit,
              { cause: error },
            );
          }

          const accepted: Array<{ key: string; result: AgentMindOutput }> = [];
          const rejected: Array<{ slot: AgentMindSlot; issues: PromptValidationIssue[] }> = [];
          const normalizedSlots: Array<{ slot: number; result: unknown }> = [];
          let modifiedFieldCount = 0;
          let resolvedReferenceCount = 0;
          let proposalCount = 0;
          let deduplicatedCount = 0;
          const ordered = [...generated.value.slots].sort((left, right) => left.slot - right.slot);
          for (const [index, draft] of ordered.entries()) {
            const slot = batch[index]!;
            try {
              // The gateway cannot safely normalize a physical batch with one
              // resolver: each slot has a private catalog. Normalize each
              // parsed slot against its own catalog before materialization so
              // AgentMind follows the same deterministic protocol as every
              // single-slot role.
              const slotResolver = createAgentReferenceResolver(slot.payload.agent, slot.payload.observations);
              const normalized = normalizeModelOutput(draft, { resolver: slotResolver, dedupeArrays: true });
              modifiedFieldCount += normalized.modifiedFieldCount;
              resolvedReferenceCount += normalized.resolvedReferenceCount;
              proposalCount += normalized.proposalCount;
              deduplicatedCount += normalized.deduplicatedCount;
              normalizedSlots.push({ slot: draft.slot, result: normalized.value });
              if (normalized.issues.length > 0) {
                rejected.push({
                  slot,
                  issues: normalized.issues.map((issue) => ({
                    code: issue.code,
                    class: issue.class,
                    path: [...issue.path],
                    message: issue.reason,
                    originalValue: issue.originalValue,
                    allowedHandles: [...issue.allowedHandles],
                  })),
                });
                continue;
              }
              accepted.push({
                key: slot.key,
                result: validateMindOutput(
                  slot.payload.agent,
                  state,
                  slot.payload.observations,
                  slot.payload.events,
                  normalized.value,
                ),
              });
            } catch (error) {
              rejected.push({ slot, issues: validationIssues(error) });
            }
          }
          const invocationAudit = generated.audit.invocations.at(-1);
          if (invocationAudit) {
            const symbolRepairs = invocationAudit.symbolRepairs ?? [];
            const symbolRepairAcceptedCount = symbolRepairs.filter((repair) =>
              repair.status === "repaired" || repair.status === "normalized").length;
            const symbolRepairAmbiguousCount = symbolRepairs.filter((repair) => repair.status === "ambiguous").length;
            const symbolRepairUnmatchedCount = symbolRepairs.filter((repair) => repair.status === "unmatched").length;
            const symbolRepairPostValidationRejectedCount = symbolRepairs.filter((repair) =>
              repair.status === "postvalidation-rejected").length;
            const parserRecovered = invocationAudit.issues.some((issue) =>
              issue.class === "structure" && issue.code.startsWith("json."));
            invocationAudit.rawOutputHash ??= contentHash(generated.value);
            invocationAudit.normalizedOutputHash = contentHash({ slots: normalizedSlots });
            invocationAudit.normalization = {
              applied: parserRecovered || modifiedFieldCount > 0 || deduplicatedCount > 0 || symbolRepairAcceptedCount > 0,
              modifiedFieldCount: modifiedFieldCount + symbolRepairAcceptedCount,
              resolvedReferenceCount,
              proposalCount,
              deduplicatedCount,
              symbolRepairCount: symbolRepairs.length,
              symbolRepairAcceptedCount,
              symbolRepairAmbiguousCount,
              symbolRepairUnmatchedCount,
              symbolRepairPostValidationRejectedCount,
            };
            observe?.({
              event: "model.output.normalized",
              correlation,
              attributes: { applied: invocationAudit.normalization.applied },
              counts: {
                modifiedFields: modifiedFieldCount,
                resolvedReferences: resolvedReferenceCount,
                proposals: proposalCount,
                deduplicated: deduplicatedCount,
                symbolRepairAttempts: symbolRepairs.length,
                symbolRepairAccepted: symbolRepairAcceptedCount,
                symbolRepairAmbiguous: symbolRepairAmbiguousCount,
                symbolRepairUnmatched: symbolRepairUnmatchedCount,
                symbolRepairPostValidationRejected: symbolRepairPostValidationRejectedCount,
              },
              hashes: {
                rawOutput: invocationAudit.rawOutputHash,
                normalizedOutput: invocationAudit.normalizedOutputHash,
              },
              payload: symbolRepairs.length > 0 && scope.observer
                ? fullRuntimePayload(scope.observer, { symbolRepairs })
                : undefined,
            });
          }
          setModelInvocationResultKind(generated.audit, `agent_mind_${purpose}_batch`);
          if (rejected.length === 0) {
            const normalized = invocationAudit?.normalization.applied === true;
            setModelInvocationOutcome(generated.audit, attempt > 0 ? "llm-repaired" : normalized ? "auto-normalized" : "accepted");
            observe?.({
              event: "model.semantic.accepted",
              correlation,
              attributes: { resultKind: `agent_mind_${purpose}_batch` },
              hashes: { response: generated.audit.invocations.at(-1)!.responseHash! },
            });
          } else {
            const issues = rejected.flatMap((entry) => entry.issues);
            setModelInvocationOutcome(generated.audit, "rejected", issues.map((issue) => ({
              code: issue.code,
              class: issue.class ?? "semantic",
              path: issue.path,
              message: issue.message,
              ...(issue.originalValue !== undefined ? { originalValue: issue.originalValue } : {}),
              ...(issue.allowedHandles ? { allowedHandles: [...issue.allowedHandles] } : {}),
            })));
            observe?.({
              event: "model.semantic.rejected",
              level: "warn",
              correlation,
              attributes: { resultKind: `agent_mind_${purpose}_batch` },
              counts: { validationIssues: issues.length },
              payload: scope.observer ? fullRuntimePayload(scope.observer, { issues }) : undefined,
              error: { name: "AgentMindSlotValidationError", message: `${rejected.length} slot(s) rejected` },
            });
          }
          return { audit: generated.audit, accepted, rejected };
        },
      })));

    const outputs = new Map<string, AgentMindOutput>();
    groupResults.forEach((result) => result.results.forEach((output, agentId) => outputs.set(agentId, output)));
    return {
      outputs,
      failures: groupResults.flatMap((result) => result.failures.map((failure) => ({
        agentId: failure.slot.payload.agent.id,
        error: failure.error,
      }))),
      modelAudits: groupResults.flatMap((result) => result.audits),
      batchCount: groupResults.reduce((total, result) => total + result.batchCount, 0),
      metrics: {
        submittedSlots: groupResults.reduce((total, result) => total + result.metrics.submittedSlots, 0),
        repairCalls: groupResults.reduce((total, result) => total + result.metrics.repairCalls, 0),
        repeatedFingerprints: groupResults.reduce((total, result) => total + result.metrics.repeatedFingerprints, 0),
        splitCount: groupResults.reduce((total, result) => total + result.metrics.splitCount, 0),
        partialFailureSlots: groupResults.reduce((total, result) => total + result.metrics.partialFailureSlots, 0),
        singletonFailures: groupResults.reduce((total, result) => total + result.metrics.singletonFailures, 0),
      },
    };
  }

  async react(
    state: SimulationState,
    agent: AgentState,
    originalAction: AgentActionProposal,
    request: ReactionRequest,
    scope: ModelExecutionScope,
  ): Promise<ReactionDecision & { modelAudit: ModelExecutionAudit }> {
    const stimulus = request.stimulus;
    const wireJsonSchema = reactionTargetWireSchema(reactionTargets(agent, stimulus).handles);
    const observe = runtimeEventEmitter(scope.observer);
    const logicalInvocationId = modelInvocationLogicalId(scope, "agent-reaction", agent.id);
    try {
      const result = await runSemanticRepairLoop({
        role: "agent-reaction",
        repairScope: "slot",
        targetIds: [agent.id],
        maxRepairs: this.recovery.maxRepairs,
        logicalInvocationId,
        invoke: async (repairContext) => {
        const contextStartedAt = Date.now();
          const issues = repairContext.issues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
            class: issue.class,
            ...(issue.originalValue !== undefined ? { originalValue: structuredClone(issue.originalValue) } : {}),
            ...(issue.allowedHandles ? { allowedHandles: [...issue.allowedHandles] } : {}),
          }));
          const context = buildReactionContext({
          state,
          agent,
          originalAction,
          stimulus,
          instanceId: scope.workloadId,
          advanceId: scope.batchId,
          issues,
          });
        const prompt = promptBundle("agent-reaction");
          const identity = modelInvocationIdentity(scope, "agent-reaction", agent.id, repairContext.attempt + 1);
          const correlation = modelInvocationCorrelation(scope, "agent-reaction", agent.id, identity, {
            logicalInvocationId: repairContext.logicalInvocationId ?? logicalInvocationId,
            semanticRepairAttempt: repairContext.attempt,
            ...(repairContext.parentInvocationId ? {
              parentInvocationId: repairContext.parentInvocationId,
              repairOf: repairContext.repairOf,
            } : {}),
          });
        observe?.({
          event: "model.context.built",
          correlation,
          durationMs: Math.max(0, Date.now() - contextStartedAt),
          hashes: { context: contentHash(context) },
        });
        const result = await this.provider.generateStructured({
          profileId: agent.modelProfiles.reaction,
          workloadId: scope.workloadId,
          batchId: scope.batchId,
          abortSignal: scope.abortSignal,
          correlation,
          observer: scope.observer,
          ...identity,
          role: "agent-reaction",
          subjectId: agent.id,
          promptVersion: `${prompt.version}/reaction-target-domain-v1@${contentHash(wireJsonSchema).slice(0, 16)}`,
          schemaName: "agent_reaction_decision",
          system: prompt.system,
          userPrompt: prompt.userPrompt,
          context,
          schema: reactionDecisionDraftSchema,
          wireJsonSchema,
        });
          setModelInvocationResultKind(result.audit, "agent-reaction_decision");
          return result;
        },
        validate: (value) => {
          validateReactionDecision(
            state.worldHash,
            agent,
            state.revision,
            originalAction,
            request,
            value,
          );
        },
        classify: (error) => validationIssues(error).map((issue) => semanticIssue(
          issue.code,
          issue.message,
          {
            class: issue.class ?? "semantic",
            path: issue.path,
            originalValue: issue.originalValue,
            allowedHandles: issue.allowedHandles,
            targetIds: [agent.id],
          },
        )),
        onRejected: ({ context, audit, issues, error }) => {
          if (audit) setModelInvocationOutcome(audit, "rejected", issues.map((issue) => issue.code));
          const invocation = audit?.invocations.at(-1);
          observe?.({
            event: "model.semantic.rejected",
            level: "warn",
            correlation: modelInvocationCorrelation(scope, "agent-reaction", agent.id, {
              modelInvocationId: invocation?.id,
              modelInvocation: invocation?.ordinal,
            }, {
              logicalInvocationId: context.logicalInvocationId ?? logicalInvocationId,
              semanticRepairAttempt: context.attempt,
              ...(context.parentInvocationId ? {
                parentInvocationId: context.parentInvocationId,
                repairOf: context.repairOf,
              } : {}),
            }),
            attributes: { resultKind: invocation?.resultKind ?? "agent-reaction_decision" },
            counts: { validationIssues: issues.length },
            payload: scope.observer ? fullRuntimePayload(scope.observer, { issues }) : undefined,
            error: serializeRuntimeError(error),
          });
        },
      });
      const validated = validateReactionDecision(
        state.worldHash,
        agent,
        state.revision,
        originalAction,
        request,
        result.value,
      );
      setModelInvocationOutcome(result.audit, "accepted");
      const invocation = result.audit.invocations.at(-1);
        observe?.({
          event: "model.semantic.accepted",
          correlation: modelInvocationCorrelation(scope, "agent-reaction", agent.id, {
            modelInvocationId: invocation?.id,
            modelInvocation: invocation?.ordinal,
          }, {
            logicalInvocationId,
            semanticRepairAttempt: result.repairs,
          }),
          attributes: { resultKind: `reaction_${validated.kind}` },
        });
        return {
          ...validated,
          modelAudit: result.audit,
        };
    } catch (error) {
      if (!(error instanceof SemanticRepairExhaustedError)) throw error;
      throw new ModelSemanticRepairError(
        "agent-reaction",
        `Agent reaction ${agent.id} failed after repairs: ${error.message}`,
        { cause: error, audit: error.audit },
      );
    }
  }
}

export { sanitizeObservationForAgent };
