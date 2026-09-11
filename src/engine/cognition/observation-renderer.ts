import { observationRenderSchema, type ModelObservationRenderDraft } from "../contracts/llm-schemas";
import type {
  AgentActionProposal,
  ModelExecutionAudit,
  ObservationPacket,
  ObservationPacketDraft,
  ObservationRenderDraft,
  SimulationState,
} from "../contracts/model";
import {
  ContextLimitExceededError,
  modelInvocationCorrelation,
  modelInvocationLogicalId,
  modelInvocationIdentity,
  setModelInvocationOutcome,
  setModelInvocationResultKind,
  type ModelExecutionScope,
  type StructuredModelProvider,
} from "../models/model-provider";
import { validatePublicInformationBoundary } from "./information-boundary";
import { validateObservations } from "./observation";
import {
  MODEL_CONTEXT_CONTRACT_VERSION,
  createTruthReferenceResolver,
  projectCanonicalTruthForModel,
  projectModelAction,
  projectModelEvent,
  type PromptValidationIssue,
} from "../contracts/prompts";
import { createAgentReferenceResolver, isProposalReference, modelRoleContract, type ModelReference } from "../contracts/model-context";
import { contentHash } from "../models/model-audit";
import { promptBundle, structuredPromptBytes } from "../prompts";
import { materializeObservationPackets } from "../mechanics/truth-engine";
import { applyTransitionProposal } from "../runtime/transaction";
import type { ObservationRenderingInput } from "../algorithms/roles";
import {
  runSemanticRepairLoop,
  semanticIssue,
  SemanticRepairExhaustedError,
  type SemanticRepairIssueClass,
} from "../models/semantic-repair";

const OBSERVATION_PROMPT = promptBundle("observation-renderer");

/** One immutable source/proposal snapshot is shared by all observer slots and repairs. */
type PreparedObservationInput = ObservationRenderingInput & { candidate: SimulationState };

/** Keep the observation prompt focused on the observer's authorized view and
 * the evidence needed to explain this transition. The full canonical state
 * remains an engine concern; an observer only needs handles for objects it can
 * actually name. */
function scopedObservationTruth(
  candidate: Readonly<SimulationState["truth"]>,
  observerId: string,
  actions: readonly AgentActionProposal[],
  agents: Readonly<SimulationState["agents"]>,
): SimulationState["truth"] {
  const entityIds = new Set<string>();
  const observer = agents[observerId];
  if (observer) {
    entityIds.add(observer.entityId);
    for (const binding of Object.values(observer.bindings)) {
      binding.canonicalEntityIds.forEach((id) => entityIds.add(id));
    }
  }
  for (const action of actions) {
    const agent = agents[action.actorId];
    for (const targetId of action.targetIds) {
      agent?.bindings[targetId]?.canonicalEntityIds.forEach((id) => entityIds.add(id));
    }
  }
  const placements = candidate.placements;
  for (const entityId of [...entityIds]) {
    let parent = placements[entityId];
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      entityIds.add(parent);
      parent = placements[parent];
    }
  }
  const retain = <T>(record: Readonly<Record<string, T>>, ids: ReadonlySet<string>) =>
    Object.fromEntries(Object.entries(record).filter(([id]) => ids.has(id)));
  const factIds = new Set<string>();
  for (const [id, fact] of Object.entries(candidate.facts)) {
    if (fact.access.kind === "public" ||
      fact.access.kind === "agents" && fact.access.agentIds.includes(observerId)) factIds.add(id);
  }
  for (const factId of factIds) {
    const fact = candidate.facts[factId];
    if (!fact) continue;
    entityIds.add(fact.subjectId);
    if (fact.value.kind === "entity") entityIds.add(fact.value.entityId);
  }
  for (const entityId of [...entityIds]) {
    let parent = placements[entityId];
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      entityIds.add(parent);
      parent = placements[parent];
    }
  }
  const truth = structuredClone(candidate) as SimulationState["truth"];
  truth.entities = retain(candidate.entities, entityIds);
  truth.placements = Object.fromEntries(Object.entries(placements)
    .filter(([entityId, parent]) => entityIds.has(entityId) || (parent !== null && entityIds.has(parent))));
  truth.facts = retain(candidate.facts, factIds);
  truth.factTombstones = candidate.factTombstones.filter((id) => factIds.has(id));
  // Temporal/mechanics records are engine evidence, not observer-facing
  // ontology. Their observable consequences are represented by current
  // events and facts; omitting them avoids duplicating private implementation
  // detail in every observer slot.
  truth.meters = {};
  truth.quantities = {};
  truth.ratings = {};
  truth.conditions = {};
  truth.activities = {};
  truth.timers = {};
  truth.sharedActivityResourcePools = {};
  truth.events = [];
  return truth;
}

function observationContext(
  input: PreparedObservationInput,
  observerIds: readonly string[],
  issues: readonly PromptValidationIssue[],
  scope: Pick<ModelExecutionScope, "workloadId" | "batchId">,
) {
  const candidate = input.candidate;
  const broadResolver = createTruthReferenceResolver({
    state: candidate,
    definition: input.definition,
    actions: input.actions,
    events: input.proposal.events,
    outcomes: input.proposal.outcomes,
    extraCandidates: observerIds.flatMap((observerId) => {
      const agent = candidate.agents[observerId];
      return agent
        ? Object.values(agent.belief.localEntities).map((entity) => ({
            kind: "local_entity" as const,
            engineId: `${observerId}::${entity.id}`,
            label: entity.name,
            meaning: "an observer-local entity available to this observation slot",
            allowedUses: ["target", "subject", "evidence", "source", "assertion"] as const,
            visibility: "slot" as const,
            statePath: `state.observationSlots.${observerId}.localEntities.${entity.id}`,
          }))
        : [];
    }),
  });
  const projectedTruth = scopedObservationTruth(
    candidate.truth,
    observerIds[0]!,
    input.actions,
    candidate.agents,
  );
  const allowedByKind = new Map<string, Set<string>>();
  const allow = (kind: string, ids: Iterable<string>) => allowedByKind.set(kind, new Set(ids));
  allow("agent", Object.keys(candidate.agents));
  allow("entity", Object.keys(projectedTruth.entities));
  allow("placement", Object.keys(projectedTruth.placements));
  allow("fact", Object.keys(projectedTruth.facts));
  allow("meter", Object.keys(projectedTruth.meters));
  allow("quantity", Object.keys(projectedTruth.quantities));
  allow("rating", Object.keys(projectedTruth.ratings));
  allow("condition", Object.keys(projectedTruth.conditions));
  allow("activity", Object.keys(projectedTruth.activities));
  allow("timer", Object.keys(projectedTruth.timers));
  allow("shared_resource_pool", Object.keys(projectedTruth.sharedActivityResourcePools));
  allow("local_entity", observerIds.flatMap((observerId) => {
    const agent = candidate.agents[observerId];
    return agent ? Object.keys(agent.belief.localEntities).map((localId) => `${observerId}::${localId}`) : [];
  }));
  allow("event", [...input.proposal.events.map((event) => event.id), ...projectedTruth.events.map((event) => event.id)]);
  allow("outcome", input.proposal.outcomes.map((outcome) => outcome.id));
  allow("action", [
    ...input.actions.map((action) => action.id),
    ...Object.values(projectedTruth.activities).map((activity) => activity.sourceActionId),
  ]);
  allow("law", input.definition.laws.map((law) => law.id));
  allow("world", ["world"]);
  // Current events retain their provenance even when a cause's contents are
  // outside this observer's fact view. A handle does not grant fact access.
  for (const event of input.proposal.events) {
    for (const cause of event.causes) {
      const kind = cause.kind;
      const ids = allowedByKind.get(kind) ?? new Set<string>();
      ids.add(cause.id);
      allowedByKind.set(kind, ids);
    }
  }
  const truthResolver = broadResolver.narrow((entry) =>
    allowedByKind.get(entry.kind)?.has(entry.engineId) ?? false);
  const privateFacts = (observerId: string) => Object.values(candidate.truth.facts)
    .filter((fact) => fact.access.kind === "agents" && fact.access.agentIds.includes(observerId))
    .sort((left, right) => left.id.localeCompare(right.id));
  const observationSlots = observerIds.map((observerId, slot) => {
      const agent = candidate.agents[observerId];
      if (!agent) throw new Error(`observation slot references unknown Agent ${observerId}`);
      const canonicalBindings = new Map<string, string[]>();
      for (const binding of Object.values(agent.bindings)) {
        canonicalBindings.set(binding.localEntityId, binding.canonicalEntityIds
          .flatMap((canonicalId) => {
            try { return [truthResolver.handleFor("entity", canonicalId)]; }
            catch { return []; }
          }));
      }
      return {
        slot,
        observer: {
          agentRef: truthResolver.handleFor("agent", observerId),
          selfEntityRef: truthResolver.handleFor("entity", agent.entityId),
          placementRef: candidate.truth.placements[agent.entityId]
            ? truthResolver.handleFor("placement", agent.entityId)
            : null,
          localEntities: Object.values(agent.belief.localEntities)
            .map((entity) => ({
              ref: truthResolver.handleFor("local_entity", `${observerId}::${entity.id}`),
              name: entity.name,
              description: entity.description,
              status: entity.status,
              canonicalEntityRefs: canonicalBindings.get(entity.id) ?? [],
            }))
            .sort((left, right) => left.ref.localeCompare(right.ref)),
          privateFacts: privateFacts(observerId).map((fact) => ({
            ref: truthResolver.handleFor("fact", fact.id),
            subjectRef: truthResolver.handleFor("entity", fact.subjectId),
            predicate: fact.predicate,
            value: fact.value.kind === "entity"
              ? { kind: "entity", entityRef: truthResolver.handleFor("entity", fact.value.entityId) }
              : structuredClone(fact.value),
            description: fact.description,
          })),
        },
      };
    });
  // Keep the renderer on the same semantic envelope as every other model
  // role. Candidate truth is exposed once, under state.canonicalTruth; task
  // contains only this observer assignment and its slot-local view.
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    roleContract: modelRoleContract("observation-renderer"),
    execution: { worldId: input.state.worldId, instanceId: scope.workloadId, advanceId: scope.batchId, revision: input.state.revision, step: candidate.step },
    task: {
      assignment: { targetHandles: observerIds.map((observerId) => truthResolver.handleFor("agent", observerId)), availableHandles: truthResolver.catalog.candidates.map((entry) => entry.handle), allowedProposalKinds: ["observation"] },
      constraints: issues.map((issue) => {
        const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
        const original = issue.originalValue === undefined ? "" : ` 原值=${JSON.stringify(issue.originalValue)}`;
        const allowed = issue.allowedHandles && issue.allowedHandles.length > 0
          ? ` 允许句柄=${issue.allowedHandles.join(",")}`
          : "";
        return `${issue.code}${path}: ${issue.message}${original}${allowed}`;
      }),
    },
    state: {
      world: {
        id: input.definition.id,
        name: input.definition.name,
        description: input.definition.description,
        laws: input.definition.laws,
        disclosure: input.definition.disclosure,
      },
      baseRevision: input.state.revision,
      step: candidate.step,
      canonicalTruth: projectCanonicalTruthForModel(projectedTruth, truthResolver, { includeMechanics: false }),
      actionSet: {
        initial: input.actions.map((action) => projectModelAction(action, truthResolver)),
        assigned: input.actions.map((action) => projectModelAction(action, truthResolver)),
        available: input.actions.map((action) => projectModelAction(action, truthResolver)),
      },
      outcomes: input.proposal.outcomes.map((outcome) => ({
        outcomeRef: truthResolver.handleFor("outcome", outcome.id),
        actionRef: truthResolver.handleFor("action", outcome.proposalId),
        status: outcome.status,
        summary: outcome.summary,
      })),
      currentEvents: input.proposal.events.map((event) => projectModelEvent(event, truthResolver)),
      observationSlots,
    },
    referenceCatalog: truthResolver.catalog,
    repair: issues.length > 0 ? {
      target: observerIds[0] ? truthResolver.handleFor("agent", observerIds[0]) : null,
      issues: issues.map((issue) => ({
        code: issue.code,
        class: issue.class ?? "semantic",
        path: [...issue.path],
        originalValue: issue.originalValue ?? null,
        allowedHandles: [...(issue.allowedHandles ?? [])],
        reason: issue.message,
      })),
    } : null,
  };
}

function materializeModelObservationDraft(
  input: PreparedObservationInput,
  observerId: string,
  draft: ModelObservationRenderDraft,
): ObservationRenderDraft {
  const candidate = input.candidate;
  const observer = candidate.agents[observerId];
  if (!observer) throw new Error(`observation slot references unknown Agent ${observerId}`);
  const truthResolver = createTruthReferenceResolver({
    state: candidate,
    definition: input.definition,
    actions: input.actions,
    events: input.proposal.events,
    outcomes: input.proposal.outcomes,
    extraCandidates: Object.values(observer.belief.localEntities).map((entity) => ({
      kind: "local_entity" as const,
      engineId: `${observerId}::${entity.id}`,
      label: entity.name,
      meaning: "an observer-local entity available to this observation slot",
      allowedUses: ["target", "subject", "evidence", "source", "assertion"] as const,
      visibility: "slot" as const,
      statePath: `state.observationSlots.${observerId}.localEntities.${entity.id}`,
    })),
  });
  const privateResolver = createAgentReferenceResolver(observer, []);
  const proposals = new Map<string, string>();
  const proposalId = (namespace: string, key: string): string => {
    if (proposals.has(key)) throw new Error(`duplicate observation proposalKey ${key}`);
    const id = `observation-${namespace}-${contentHash({ observerId, step: candidate.step, namespace, key }).slice(0, 32)}`;
    proposals.set(key, id);
    return id;
  };
  const resolveLocal = (reference: ModelReference): string => {
    if (isProposalReference(reference)) {
      const id = proposals.get(reference.proposalKey);
      if (!id) throw new Error(`observation references undeclared proposalKey ${reference.proposalKey}`);
      return id;
    }
    try {
      const resolved = privateResolver.resolve(reference, "target");
      if (resolved.kind !== "local_entity") throw new Error(`observation reference ${reference} is ${resolved.kind}, expected local_entity`);
      return resolved.engineId;
    } catch (privateError) {
      const resolved = truthResolver.resolve(reference, "target");
      if (resolved.kind !== "local_entity") throw privateError;
      const prefix = `${observerId}::`;
      if (!resolved.engineId.startsWith(prefix)) throw privateError;
      return resolved.engineId.slice(prefix.length);
    }
  };
  const resolveCanonical = (reference: ModelReference | null): string | null => {
    if (reference === null) return null;
    if (isProposalReference(reference)) throw new Error("observation canonicalEntityRef cannot point to a proposal");
    const resolved = truthResolver.resolve(reference, "target");
    if (resolved.kind !== "entity") throw new Error(`observation canonicalEntityRef must reference an entity, got ${resolved.kind}`);
    return resolved.engineId;
  };
  const introductions = draft.introductions.map((introduction) => ({
    localEntity: {
      id: proposalId("local", introduction.localEntity.proposalKey),
      name: introduction.localEntity.name,
      description: introduction.localEntity.description,
      status: introduction.localEntity.status,
    },
    canonicalEntityId: resolveCanonical(introduction.canonicalEntityRef),
  }));
  const apparentClaims = draft.apparentClaims.map((claim) => ({
    subjectId: resolveLocal(claim.subjectRef),
    predicate: claim.predicate,
    value: claim.value.kind === "local_entity"
      ? { kind: "local_entity" as const, localEntityId: resolveLocal(claim.value.entityRef) }
      : structuredClone(claim.value),
    description: claim.description,
  }));
  const sourceEventIds = draft.sourceEventRefs.map((reference) => {
    if (isProposalReference(reference)) throw new Error("observation sourceEventRefs cannot point to a proposal");
    const resolved = truthResolver.resolve(reference, "source");
    if (resolved.kind !== "event") throw new Error(`observation sourceEventRefs must reference events, got ${resolved.kind}`);
    return resolved.engineId;
  });
  return { summary: draft.summary, introductions, apparentClaims, sourceEventIds };
}

function requestBytes(context: unknown): number {
  return structuredPromptBytes({
    system: OBSERVATION_PROMPT.system,
    userPrompt: OBSERVATION_PROMPT.userPrompt,
    context,
    schema: observationRenderSchema,
  }).requestUtf8Bytes;
}

export function normalizeObservationSourceEventIds(
  drafts: readonly ObservationRenderDraft[],
  currentEventIds: ReadonlySet<string>,
): { drafts: ObservationRenderDraft[]; droppedReferences: number } {
  let droppedReferences = 0;
  const normalized = drafts.map((draft) => {
    const seen = new Set<string>();
    const sourceEventIds = draft.sourceEventIds.filter((eventId) => {
      if (!currentEventIds.has(eventId) || seen.has(eventId)) {
        droppedReferences += 1;
        return false;
      }
      seen.add(eventId);
      return true;
    });
    return { ...structuredClone(draft), sourceEventIds };
  });
  return { drafts: normalized, droppedReferences };
}

export function normalizeObservationLocalReferences(
  state: Readonly<SimulationState>,
  observerIds: readonly string[],
  drafts: readonly ObservationRenderDraft[],
): {
  drafts: ObservationRenderDraft[];
  droppedClaims: number;
  droppedIntroductions: number;
  clearedCanonicalBindings: number;
} {
  let droppedClaims = 0;
  let droppedIntroductions = 0;
  let clearedCanonicalBindings = 0;
  const normalized = drafts.map((draft, index) => {
    const agent = state.agents[observerIds[index]];
    if (!agent) throw new Error(`observation slot references unknown Agent ${observerIds[index]}`);
    const localIds = new Set([
      ...Object.keys(agent.belief.localEntities),
      ...Object.keys(agent.bindings),
    ]);
    // Models occasionally emit a fresh alias for a canonical Entity that the
    // observer already knows under another local name.  Treat that as a
    // reference normalization (and rewrite claims) instead of allowing an
    // impossible re-introduction to reach the causal verifier.
    const canonicalToLocal = new Map<string, string>();
    for (const binding of Object.values(agent.bindings)) {
      for (const canonicalId of binding.canonicalEntityIds) {
        const existing = canonicalToLocal.get(canonicalId);
        if (!existing || binding.localEntityId.localeCompare(existing) < 0) {
          canonicalToLocal.set(canonicalId, binding.localEntityId);
        }
      }
    }
    const remappedLocalIds = new Map<string, string>();
    const introductions = draft.introductions.flatMap((introduction) => {
      const localId = introduction.localEntity.id;
      const knownLocalId = introduction.canonicalEntityId
        ? canonicalToLocal.get(introduction.canonicalEntityId)
        : undefined;
      if (knownLocalId && knownLocalId !== localId) {
        droppedIntroductions += 1;
        remappedLocalIds.set(localId, knownLocalId);
        return [];
      }
      if (localIds.has(localId) || state.truth.entities[localId]) {
        droppedIntroductions += 1;
        return [];
      }
      localIds.add(localId);
      if (introduction.canonicalEntityId && !state.truth.entities[introduction.canonicalEntityId]) {
        clearedCanonicalBindings += 1;
        return [{ ...structuredClone(introduction), canonicalEntityId: null }];
      }
      return [structuredClone(introduction)];
    });
    const remap = (localId: string): string => remappedLocalIds.get(localId) ?? localId;
    const apparentClaims = draft.apparentClaims.map((claim) => ({
      ...structuredClone(claim),
      subjectId: remap(claim.subjectId),
      value: claim.value.kind === "local_entity"
        ? { ...structuredClone(claim.value), localEntityId: remap(claim.value.localEntityId) }
        : structuredClone(claim.value),
    })).filter((claim) => {
      const validSubject = localIds.has(claim.subjectId);
      const validValue = claim.value.kind !== "local_entity" || localIds.has(claim.value.localEntityId);
      if (validSubject && validValue) return true;
      droppedClaims += 1;
      return false;
    });
    return { ...structuredClone(draft), introductions, apparentClaims };
  });
  return { drafts: normalized, droppedClaims, droppedIntroductions, clearedCanonicalBindings };
}

function materializeObserver(
  input: PreparedObservationInput,
  observerId: string,
  draft: ModelObservationRenderDraft,
  slotKey: string,
  scope: ModelExecutionScope,
): ObservationPacket {
  const internalDraft = materializeModelObservationDraft(input, observerId, draft);
  const eventIds = new Set(input.proposal.events.map((event) => event.id));
  const eventNormalized = normalizeObservationSourceEventIds([internalDraft], eventIds);
  const candidate = input.candidate;
  const localNormalized = normalizeObservationLocalReferences(
    candidate,
    [observerId],
    eventNormalized.drafts,
  );
  const normalizedCount = eventNormalized.droppedReferences + localNormalized.droppedClaims +
    localNormalized.droppedIntroductions + localNormalized.clearedCanonicalBindings;
  if (normalizedCount > 0) {
    scope.observer?.emit({
      event: "algorithm.observation.references_normalized",
      level: "warn",
      correlation: { ...scope.correlation, modelSubject: observerId },
      attributes: { phase: "observation", batch: scope.batchId },
      counts: {
        droppedObservationEventReferences: eventNormalized.droppedReferences,
        droppedObservationClaims: localNormalized.droppedClaims,
        droppedObservationIntroductions: localNormalized.droppedIntroductions,
        clearedObservationCanonicalBindings: localNormalized.clearedCanonicalBindings,
      },
    });
  }
  const packet: ObservationPacketDraft = {
    id: `observation-slot-${slotKey}`,
    ...structuredClone(localNormalized.drafts[0]!),
    // Slot ownership is assigned by the engine; a model must not be able to
    // move an observation to another Agent by echoing observerId.
    observerId,
  };
  const materialized = materializeObservationPackets(input.state, [packet], "outcome").packets;
  validateObservations(candidate, materialized, candidate.step);
  // Validate against the post-proposal candidate so observations can be
  // addressed to Agents created by this same transition. The candidate still
  // contains the full canonical/private state, so hidden cognition remains
  // protected while dynamic lifecycle introductions become observable.
  validatePublicInformationBoundary(candidate, input.actions, {
    ...structuredClone(input.proposal),
    observations: materialized,
  });
  return materialized[0]!;
}

function observationIssueClass(error: unknown): SemanticRepairIssueClass {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("protected") || message.includes("private") || message.includes("canonical identity")) {
    return "privacy";
  }
  if (message.includes("unknown") || message.includes("reference")) return "reference";
  return "structure";
}

/** Spec 0082 admits a limited progress view, never an interpretation of outcome prose. */
function pendingObservation(input: PreparedObservationInput, observerId: string): ModelObservationRenderDraft | undefined {
  if (input.feedbackByObserver?.[observerId]?.length || input.proposal.events.length || input.proposal.decisionRequests.length) return;
  const operations = input.proposal.operations;
  if (operations.length !== 1 || operations[0].kind !== "advance_time" || operations[0].seconds <= 0) return;
  const { elapsedSeconds: sourceSeconds, activities: sourceActivities, ...sourceWorld } = input.state.truth;
  const { elapsedSeconds: candidateSeconds, activities, ...candidateWorld } = input.candidate.truth;
  if (candidateSeconds - sourceSeconds !== operations[0].seconds || contentHash(sourceWorld) !== contentHash(candidateWorld)) return;
  const actions = input.actions.filter(action => action.actorId === observerId);
  if (actions.length !== 1) return;
  const action = actions[0]!;
  const outcomes = input.proposal.outcomes.filter(outcome => outcome.proposalId === action.id);
  if (outcomes.length !== 1 || outcomes[0]!.status !== "continuing" || outcomes[0]!.knownAlternatives.length) return;
  const matches = Object.values(activities).filter(activity => activity.sourceActionId === action.id);
  if (matches.length !== 1) return;
  const activity = matches[0]!;
  if (activity.actorId !== observerId || activity.status !== "active" || contentHash(activity.sourceAction) !== contentHash(action) ||
    activity.stageIndex !== 0 || activity.plan.stages.length || activity.nextBoundaryAtSeconds === null ||
    activity.nextBoundaryAtSeconds <= candidateSeconds || activity.startedAtSeconds > candidateSeconds ||
    activity.completionAtSeconds !== null && activity.completionAtSeconds <= candidateSeconds ||
    activity.progress !== null && activity.progress.current >= activity.progress.target) return;
  const sourceActivity = sourceActivities[activity.id];
  const intervalBoundary = sourceActivity && "plan" in sourceActivity
    ? sourceActivity.nextBoundaryAtSeconds : activity.plan.startsAtSeconds + activity.plan.checkpointSeconds;
  if (intervalBoundary === null || intervalBoundary <= candidateSeconds) return;
  return {
    summary: `你的活动仍在进行。本轮世界时间推进了 ${operations[0].seconds} 秒。\n你的原始行动意图（不代表已经实现）：${JSON.stringify(action.rawText)}`,
    introductions: [], apparentClaims: [], sourceEventRefs: [],
  };
}

async function renderObserver(
  provider: StructuredModelProvider,
  input: PreparedObservationInput,
  observerId: string,
  slot: number,
  scope: ModelExecutionScope,
  repairAttempts: number,
): Promise<{ packet: ObservationPacket; audit: ModelExecutionAudit; calls: number }> {
  const owner = `${input.identityOwner}:observer-${observerId}`;
  const profile = provider.catalog.profile(input.definition.modelProfiles.observation);
  try {
    let acceptedPacket: ObservationPacket | undefined;
    const rendered = await runSemanticRepairLoop({
      role: "observation-renderer",
      repairScope: "observer",
      targetIds: [observerId],
      maxRepairs: repairAttempts,
      logicalInvocationId: modelInvocationLogicalId(scope, "observation-renderer", owner),
      invoke: async (repair) => {
        const issues = repair.issues.map((issue) => ({
          code: issue.code,
          path: [...issue.path],
          message: issue.message,
          class: issue.class,
          ...(issue.originalValue !== undefined ? { originalValue: structuredClone(issue.originalValue) } : {}),
          ...(issue.allowedHandles ? { allowedHandles: [...issue.allowedHandles] } : {}),
        }));
        const context = observationContext(input, [observerId], [
          ...(input.feedbackByObserver?.[observerId] ?? []).map(message => ({
            code: "causal_observation_rejected", path: [], message, class: "semantic" as const,
          })),
          ...issues,
        ], scope);
        const bytes = requestBytes(context);
        if (bytes > profile.max_input_bytes) {
          throw new ContextLimitExceededError(
            `observation context for ${observerId} uses ${bytes} bytes and exceeds ` +
            `profile max_input_bytes ${profile.max_input_bytes}`,
          );
        }
        const identity = modelInvocationIdentity(scope, "observation-renderer", owner, repair.attempt + 1);
        const correlation = modelInvocationCorrelation(scope, "observation-renderer", owner, identity, {
          logicalInvocationId: repair.logicalInvocationId ?? modelInvocationLogicalId(scope, "observation-renderer", owner),
          semanticRepairAttempt: repair.attempt,
          ...(repair.parentInvocationId ? {
            parentInvocationId: repair.parentInvocationId,
            repairOf: repair.repairOf,
          } : {}),
        });
        const generated = await provider.generateStructured({
          profileId: input.definition.modelProfiles.observation,
          workloadId: scope.workloadId,
          batchId: scope.batchId,
          abortSignal: scope.abortSignal,
          cancelPendingSignal: scope.cancelPendingSignal,
          correlation,
          observer: scope.observer,
          ...identity,
          role: "observation-renderer",
          subjectId: owner,
          promptVersion: OBSERVATION_PROMPT.version,
          schemaName: "observation_render",
          system: OBSERVATION_PROMPT.system,
          userPrompt: OBSERVATION_PROMPT.userPrompt,
          context,
          schema: observationRenderSchema,
        });
        setModelInvocationResultKind(generated.audit, "observation-renderer_observer");
        return generated;
      },
      validate: (draft) => {
        acceptedPacket = undefined;
        acceptedPacket = materializeObserver(input, observerId, draft, `${slot}`, scope);
      },
      classify: (error) => [semanticIssue(
        "invalid_observation",
        error instanceof Error ? error.message : String(error),
        { class: observationIssueClass(error), path: [], targetIds: [observerId] },
      )],
      onRejected: ({ context: repair, issues, audit, error }) => {
        const identity = modelInvocationIdentity(scope, "observation-renderer", owner, repair.attempt + 1);
        scope.observer?.emit({
          event: "model.semantic.rejected",
          level: "warn",
          correlation: modelInvocationCorrelation(scope, "observation-renderer", owner, identity, {
            logicalInvocationId: repair.logicalInvocationId ?? modelInvocationLogicalId(scope, "observation-renderer", owner),
            semanticRepairAttempt: repair.attempt,
            ...(repair.parentInvocationId ? {
              parentInvocationId: repair.parentInvocationId,
              repairOf: repair.repairOf,
            } : {}),
          }),
          attributes: { resultKind: "observation-renderer_observer", observerId },
          counts: { validationIssues: issues.length },
          hashes: audit?.invocations.at(-1)?.responseHash
            ? { response: audit.invocations.at(-1)!.responseHash! }
            : undefined,
          error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) },
        });
      },
    });
    if (!acceptedPacket) throw new Error("accepted observation has no validated packet");
    setModelInvocationOutcome(rendered.audit, "accepted");
    return {
      packet: acceptedPacket,
      audit: rendered.audit,
      calls: rendered.attempts,
    };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError) || !error.audit) throw error;
    const action = input.actions.find((candidate) => candidate.actorId === observerId);
    const outcome = action
      ? input.proposal.outcomes.find((candidate) => candidate.proposalId === action.id)
      : undefined;
    const status = outcome ? {
      succeeded: "行动达成了预期结果",
      partial: "行动只取得部分结果",
      failed: "行动没有成功",
      blocked: "行动受到阻碍",
      continuing: "行动仍在继续",
    }[outcome.status] : "本步骤已经结束";
    const packet = materializeObserver(input, observerId, {
      summary: `你能确认：${status}。除此之外，本步骤没有形成其他可确认的观察。`,
      introductions: [],
      apparentClaims: [],
      sourceEventRefs: [],
    }, `${slot}.fallback`, scope);
    scope.observer?.emit({
      event: "algorithm.observation.repair_fallback",
      level: "warn",
      correlation: { ...scope.correlation, modelSubject: observerId },
      attributes: { phase: "observation", batch: scope.batchId, policy: "typed-uncertainty-observation" },
      counts: { observationFallbacks: 1 },
      error: { name: error.name, message: error.message },
    });
    return { packet, audit: error.audit, calls: error.audit.invocations.length };
  }
}

export class ObservationRenderer {
  constructor(
    private readonly provider: StructuredModelProvider,
    private readonly repairAttempts = 2,
    private readonly sourceBoundPending = false,
  ) {}

  async render(input: ObservationRenderingInput, scope: ModelExecutionScope): Promise<{
    packets: ObservationPacket[];
    modelAudits: ModelExecutionAudit[];
    batchCount: number;
  }> {
    if (new Set(input.observerIds).size !== input.observerIds.length) {
      throw new Error("observation rendering requires unique observer ids");
    }
    if (input.observerIds.length === 0) return { packets: [], modelAudits: [], batchCount: 0 };
    const snapshot = structuredClone(input);
    const prepared: PreparedObservationInput = { ...snapshot,
      candidate: applyTransitionProposal(snapshot.state, snapshot.proposal, snapshot.temporalState) };
    const rendered = await Promise.all(snapshot.observerIds.map(async (observerId, slot) => {
      const projected = this.sourceBoundPending ? pendingObservation(prepared, observerId) : undefined;
      if (projected) return { packet: materializeObserver(prepared, observerId, projected, `${slot}.pending`, scope), audit: undefined };
      return renderObserver(this.provider, prepared, observerId, slot, scope, this.repairAttempts);
    }));
    const packets = rendered.map((entry) => entry.packet);
    const expected = [...snapshot.observerIds].sort();
    const actual = packets.map((packet) => packet.observerId).sort();
    if (expected.length !== actual.length || expected.some((agentId, index) => agentId !== actual[index])) {
      throw new Error("observation rendering did not cover every observer exactly once");
    }
    return {
      packets,
      modelAudits: rendered.flatMap((entry) => entry.audit ? [entry.audit] : []),
      // A TruthBatchCoordinator shares one physical audit across all slots.
      // Count invocation identities rather than logical observer slots.
      batchCount: new Set(rendered.flatMap((entry) => entry.audit?.invocations.map((invocation) => invocation.id) ?? [])).size,
    };
  }
}
