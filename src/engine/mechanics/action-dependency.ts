import { actionGroundingSchema } from "../contracts/llm-schemas";
import type {
  InteractionDependency,
  InteractionDependencyDraft,
  FootprintRef,
} from "../runtime/execution";
import type {
  AgentActionProposal,
  AgentId,
  CausalAssertion,
  ModelExecutionAudit,
  SimulationState,
  WorldDeltaOperation,
} from "../contracts/model";
import type { ConditionState } from "./resolution";
import type { ActivityState, WorldTimer } from "./temporal";
import {
  ModelSemanticRepairError,
  modelInvocationCorrelation,
  modelInvocationLogicalId,
  modelInvocationIdentity,
  setModelInvocationOutcome,
  setModelInvocationResultKind,
  ModelCandidateValidationError,
  ModelOutputError,
  type ModelExecutionScope,
  type StructuredModelProvider,
} from "../models/model-provider";
import { MODEL_CONTEXT_CONTRACT_VERSION, projectAgentPerspectiveForModel, validationIssues, type PromptValidationIssue } from "../contracts/prompts";
import {
  createReferenceResolver,
  modelRoleContract,
  withReferenceCandidateDetails,
  ModelReferenceError,
  type ExistingReferenceHandle,
  type ReferenceCandidateInput,
  type ReferenceResolver,
  type ModelReferenceUse,
  type ModelReferenceKind,
} from "../contracts/model-context";
import { promptBundle } from "../prompts";
import { quantityId } from "../runtime/runtime-id";
import { contentHash } from "../models/model-audit";
import type { UnreviewedTruthResolution } from "../algorithms/roles";
import { materializeSharedActivityResourceClaims } from "./shared-activity-resources";
import {
  SemanticRepairExhaustedError,
  runSemanticRepairLoop,
  semanticIssue,
  type SemanticRepairContext,
} from "../models/semantic-repair";

const GROUNDING_PROMPT = promptBundle("action-grounding");

export function footprintRefKey(ref: FootprintRef): string {
  return `${ref.kind}:${ref.id}`;
}

function stableRefs(refs: readonly FootprintRef[]): FootprintRef[] {
  return [...new Map(refs.map((ref) => [footprintRefKey(ref), structuredClone(ref)])).values()]
    .sort((left, right) => footprintRefKey(left).localeCompare(footprintRefKey(right)));
}

export function causalAssertionFootprintRefs(
  state: Readonly<SimulationState>,
  assertions: readonly CausalAssertion[],
): FootprintRef[] {
  return assertions.flatMap((assertion): FootprintRef[] => {
    switch (assertion.kind) {
      case "check_result":
      case "random_result":
        throw new Error(`${assertion.kind} cannot be a durable Activity continuation assertion`);
      case "fact_matches":
      case "fact_absent":
        return [{ kind: "fact", id: assertion.factId }];
      case "entity_absent":
      case "entity_lifecycle":
        return [{ kind: "entity", id: assertion.entityId }];
      case "placement_equals":
      case "placement_not_equals":
        return [
          { kind: "entity", id: assertion.entityId },
          ...(assertion.placementId ? [{ kind: "placement" as const, id: assertion.placementId }] : []),
        ];
      case "shared_placement":
        return [
          { kind: "entity", id: assertion.leftEntityId },
          { kind: "entity", id: assertion.rightEntityId },
        ];
      case "meter_compare":
        return [{ kind: "meter", id: assertion.meterId }];
      case "quantity_compare":
        return [{
          kind: "quantity",
          id: quantityId(state.worldHash, assertion.definitionId, assertion.holderId),
        }];
      case "rating_compare":
        return [{ kind: "rating", id: assertion.ratingId }];
      case "shared_resource_capacity_compare":
        return [{ kind: "shared_resource_pool", id: assertion.poolId }];
      case "elapsed_seconds_compare":
        return [];
    }
  });
}

export function interactionDependencyForTimer(
  state: Readonly<SimulationState>,
  timer: Readonly<WorldTimer>,
): InteractionDependency {
  return {
    kind: "timer",
    id: timer.id,
    actorId: null,
    reads: stableRefs(causalAssertionFootprintRefs(state, timer.assertions)),
    writes: [],
    audienceAgentIds: [...new Set(timer.wakeAgentIds)].sort(),
    sharedResourceClaims: [],
    globalFallback: false,
  };
}

export function interactionDependencyForCondition(
  state: Readonly<SimulationState>,
  condition: Readonly<ConditionState>,
): InteractionDependency {
  const audienceAgentIds = condition.access.kind === "public"
    ? Object.keys(state.agents).sort()
    : condition.access.kind === "agents"
      ? [...new Set(condition.access.agentIds)].sort()
      : [];
  return {
    kind: "condition",
    id: condition.id,
    actorId: null,
    reads: [{ kind: "condition", id: condition.id }],
    writes: [{ kind: "condition", id: condition.id }],
    audienceAgentIds,
    sharedResourceClaims: [],
    globalFallback: false,
  };
}

export function unresolvedActivityInteractionFootprint(
  activityId: string,
  actorId: AgentId,
): InteractionDependency {
  const global: FootprintRef = { kind: "global", id: "world" };
  return {
    kind: "activity",
    id: activityId,
    actorId,
    reads: [global],
    writes: [global],
    audienceAgentIds: [actorId],
    sharedResourceClaims: [],
    globalFallback: true,
  };
}

export function interactionDependencyForActivity(
  state: Readonly<SimulationState>,
  activity: Readonly<ActivityState>,
  source: Readonly<InteractionDependency>,
): InteractionDependency {
  if (source.kind !== "action" || source.id !== activity.sourceActionId || source.actorId !== activity.actorId) {
    throw new Error(`activity ${activity.id} footprint source does not match its action`);
  }
  return {
    kind: "activity",
    id: activity.id,
    actorId: activity.actorId,
    reads: stableRefs([
      ...source.reads,
      ...causalAssertionFootprintRefs(
        state,
        activity.status === "queued" || activity.status === "ready"
          ? activity.planDraft.continuationAssertions
          : activity.plan.continuationAssertions,
      ),
    ]),
    writes: stableRefs(source.writes),
    audienceAgentIds: [...new Set([
      ...source.audienceAgentIds,
      ...activity.participantAgentIds,
    ])].sort(),
    sharedResourceClaims: structuredClone(source.sharedResourceClaims),
    globalFallback: source.globalFallback,
  };
}

export function affectedActivityIdsExhaustive(
  activities: Readonly<Record<string, ActivityState>>,
  incoming: readonly InteractionDependency[],
): string[] {
  const live = Object.values(activities)
    .filter((activity) => activity.status === "active" || activity.status === "paused" ||
      activity.status === "queued" || activity.status === "ready")
    .sort((left, right) => left.id.localeCompare(right.id));
  const affected = new Set<string>();
  const pending = [...incoming];
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const dependency = pending[cursor]!;
    for (const activity of live) {
      if (affected.has(activity.id) ||
        !interactionDependenciesConflict(activity.interactionFootprint, dependency)) continue;
      affected.add(activity.id);
      pending.push(activity.interactionFootprint);
    }
  }
  return [...affected].sort();
}

export class ActivityFootprintIndex {
  private readonly activeIds: string[];
  private readonly globalIds = new Set<string>();
  private readonly readers = new Map<string, Set<string>>();
  private readonly writers = new Map<string, Set<string>>();
  private readonly actors = new Map<AgentId, Set<string>>();
  private readonly audiences = new Map<AgentId, Set<string>>();
  private readonly footprints = new Map<string, InteractionDependency>();

  constructor(activities: Readonly<Record<string, ActivityState>>) {
    const active = Object.values(activities)
      .filter((activity) => activity.status === "active" || activity.status === "paused" ||
        activity.status === "queued" || activity.status === "ready")
      .sort((left, right) => left.id.localeCompare(right.id));
    this.activeIds = active.map((activity) => activity.id);
    const add = (index: Map<string, Set<string>>, key: string, activityId: string): void => {
      const values = index.get(key) ?? new Set<string>();
      values.add(activityId);
      index.set(key, values);
    };
    for (const activity of active) {
      const footprint = activity.interactionFootprint;
      if (footprint.kind !== "activity" || footprint.id !== activity.id || footprint.actorId !== activity.actorId) {
        throw new Error(`activity ${activity.id} has an invalid interaction footprint identity`);
      }
      this.footprints.set(activity.id, footprint);
      if (footprint.globalFallback) this.globalIds.add(activity.id);
      footprint.reads.forEach((ref) => add(this.readers, footprintRefKey(ref), activity.id));
      footprint.writes.forEach((ref) => add(this.writers, footprintRefKey(ref), activity.id));
      footprint.sharedResourceClaims.forEach((claim) =>
        add(this.writers, `shared_resource_pool:${claim.poolId}`, activity.id));
      add(this.actors, activity.actorId, activity.id);
      footprint.audienceAgentIds.forEach((agentId) => add(this.audiences, agentId, activity.id));
    }
  }

  affectedBy(incoming: readonly InteractionDependency[]): string[] {
    const affected = new Set<string>();
    const pending = [...incoming];
    for (let cursor = 0; cursor < pending.length; cursor += 1) {
      const dependency = pending[cursor]!;
      const matched = new Set<string>();
      const include = (values: ReadonlySet<string> | undefined): void => values?.forEach((id) => matched.add(id));
      if (dependency.globalFallback) {
        this.activeIds.forEach((id) => matched.add(id));
      } else {
        include(this.globalIds);
      }
      const writeKeys = [
        ...dependency.writes.map(footprintRefKey),
        ...dependency.sharedResourceClaims.map((claim) => `shared_resource_pool:${claim.poolId}`),
      ];
      writeKeys.forEach((key) => {
        include(this.readers.get(key));
        include(this.writers.get(key));
      });
      dependency.reads.forEach((ref) => include(this.writers.get(footprintRefKey(ref))));
      dependency.audienceAgentIds.forEach((agentId) => include(this.actors.get(agentId)));
      if (dependency.actorId !== null) include(this.audiences.get(dependency.actorId));
      for (const activityId of [...matched].sort()) {
        if (affected.has(activityId)) continue;
        const footprint = this.footprints.get(activityId);
        if (!footprint) throw new Error(`indexed Activity ${activityId} has no interaction footprint`);
        affected.add(activityId);
        pending.push(footprint);
      }
    }
    return [...affected].sort();
  }
}

export function normalizeInteractionDependency(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  value: InteractionDependency,
): { dependency: InteractionDependency; fallbackReasons: string[] } {
  if (value.kind !== "action" || value.id !== action.id || value.actorId !== action.actorId) {
    throw new Error("interaction dependency changed action or actor identity");
  }
  const catalogs: Record<Exclude<FootprintRef["kind"], "global">, Readonly<Record<string, unknown>>> = {
    entity: state.truth.entities,
    fact: state.truth.facts,
    placement: state.truth.entities,
    meter: state.truth.meters,
    quantity: state.truth.quantities,
    rating: state.truth.ratings,
    condition: state.truth.conditions,
    activity: state.truth.activities,
    shared_resource_pool: state.truth.sharedActivityResourcePools,
  };
  const fallbackReasons: string[] = [];
  const validRefs = (refs: readonly FootprintRef[]): FootprintRef[] => refs.filter((ref) => {
    if (ref.kind === "global") {
      if (ref.id === "world") return true;
      fallbackReasons.push("invalid_global_reference");
      return false;
    }
    if (catalogs[ref.kind][ref.id]) return true;
    fallbackReasons.push(`unknown_${ref.kind}`);
    return false;
  });
  const reads = validRefs(value.reads);
  const writes = validRefs(value.writes);
  const audienceAgentIds = value.audienceAgentIds.filter((agentId) => {
    if (state.agents[agentId]) return true;
    fallbackReasons.push("unknown_audience_agent");
    return false;
  });
  const hasGlobal = [...value.reads, ...value.writes]
    .some((ref) => ref.kind === "global" && ref.id === "world");
  if (value.globalFallback !== hasGlobal) fallbackReasons.push("inconsistent_global_fallback");
  // Unknown references and a mismatched global flag are output-quality
  // failures, not evidence that the action can affect the entire world. A
  // global component is valid only when the model supplies the canonical
  // global reference itself; the caller owns the bounded repair loop.
  const globalFallback = hasGlobal;
  const globalRef: FootprintRef = { kind: "global", id: "world" };
  return {
    dependency: {
      kind: "action",
      id: action.id,
      actorId: action.actorId,
      reads: stableRefs(globalFallback ? [...reads, globalRef] : reads),
      writes: stableRefs(globalFallback ? [...writes, globalRef] : writes),
      audienceAgentIds: [...new Set(audienceAgentIds)].sort(),
      sharedResourceClaims: structuredClone(value.sharedResourceClaims),
      globalFallback,
    },
    fallbackReasons: [...new Set(fallbackReasons)].sort(),
  };
}

export class GroundingValidationError extends Error {
  constructor(
    readonly actionId: string,
    readonly reasons: readonly string[],
    options?: ErrorOptions,
  ) {
    super(`grounding for ${actionId} requires repair: ${reasons.join(", ")}`, options);
    this.name = "GroundingValidationError";
  }
}

function actionGroundingReferenceInputs(
  state: Readonly<SimulationState>,
  actionInput?: Readonly<AgentActionProposal> | readonly Readonly<AgentActionProposal>[],
  slotByActionId: ReadonlyMap<string, number> = new Map(),
): ReferenceCandidateInput[] {
  const actions = actionInput === undefined ? [] : Array.isArray(actionInput) ? actionInput : [actionInput];
  const inputs: ReferenceCandidateInput[] = [];
  const add = (candidate: ReferenceCandidateInput): void => {
    inputs.push(candidate);
  };
  for (const entity of Object.values(state.truth.entities)) {
    add({
      kind: "entity",
      engineId: entity.id,
      label: entity.name,
      meaning: `${entity.kind} entity; can be required or potentially affected by an action`,
      allowedUses: ["target", "subject", "conflict", "cause", "assertion"],
      statePath: `state.truth.entities.${entity.id}`,
    });
    add({
      kind: "placement",
      engineId: entity.id,
      label: entity.name,
      meaning: "the entity's current placement; use only when location can be affected",
      allowedUses: ["conflict", "assertion"],
      statePath: `state.truth.placements.${entity.id}`,
    });
  }
  for (const fact of Object.values(state.truth.facts)) {
    add({
      kind: "fact",
      engineId: fact.id,
      label: `${fact.predicate}: ${fact.description}`,
      meaning: "an existing canonical fact; it is never a proposal for a future fact",
      allowedUses: ["target", "subject", "conflict", "cause", "assertion"],
      statePath: `state.truth.facts.${fact.id}`,
    });
  }
  for (const meter of Object.values(state.truth.meters)) {
    add({ kind: "meter", engineId: meter.id, label: meter.id, meaning: "existing meter state", allowedUses: ["conflict", "assertion"] });
  }
  for (const quantity of Object.values(state.truth.quantities)) {
    add({ kind: "quantity", engineId: quantity.id, label: quantity.id, meaning: "existing quantity state", allowedUses: ["conflict", "assertion"] });
  }
  for (const rating of Object.values(state.truth.ratings)) {
    add({ kind: "rating", engineId: rating.id, label: rating.id, meaning: "existing rating state", allowedUses: ["conflict", "modifier", "assertion"] });
  }
  for (const condition of Object.values(state.truth.conditions)) {
    add({ kind: "condition", engineId: condition.id, label: condition.id, meaning: "existing condition state", allowedUses: ["conflict", "assertion"] });
  }
  for (const profile of Object.values(state.truth.mechanics.temporalProfiles)) {
    add({
      kind: "temporal_profile",
      engineId: profile.id,
      label: profile.name,
      meaning: "an authored temporal profile selectable for this action",
      allowedUses: ["profile"],
      visibility: "role",
      statePath: `state.world.temporalProfiles.${profile.id}`,
    });
  }
  for (const activity of Object.values(state.truth.activities)) {
    add({
      kind: "activity",
      engineId: activity.id,
      label: ("plan" in activity ? activity.plan : activity.planDraft).description,
      meaning: "an existing scheduled activity that may be affected by this action",
      allowedUses: ["target", "conflict", "cause", "assertion"],
      visibility: "role",
      statePath: `state.canonicalTruth.activities.${activity.id}`,
    });
  }
  for (const pool of Object.values(state.truth.sharedActivityResourcePools)) {
    add({ kind: "shared_resource_pool", engineId: pool.id, label: pool.id, meaning: "existing shared physical resource pool", allowedUses: ["conflict"] });
  }
  for (const agent of Object.values(state.agents)) {
    add({ kind: "agent", engineId: agent.id, label: agent.id, meaning: "existing Agent that may receive the action's observable effects", allowedUses: ["audience", "target"] });
  }
  for (const action of actions) {
    const slot = slotByActionId.get(action.id);
    add({
      kind: "action",
      engineId: action.id,
      label: action.rawText,
      meaning: "the assigned action attempt",
      allowedUses: ["cause", "source"],
      visibility: "slot",
      ...(slot === undefined ? {} : { slot }),
      statePath: "state.action",
    });
    const actor = state.agents[action.actorId];
    if (!actor) continue;
    for (const localEntity of Object.values(actor.belief.localEntities)) {
      add({
        kind: "local_entity",
        engineId: `${actor.id}::${localEntity.id}`,
        label: localEntity.name,
        meaning: "an actor-local target name; use only to explain which entity the action addresses",
        allowedUses: ["target", "subject"],
        visibility: "slot",
        ...(slot === undefined ? {} : { slot }),
        statePath: `state.actorPerspective.entities.local:${localEntity.id}`,
      });
    }
  }
  add({ kind: "world", engineId: "world", label: "world", meaning: "world-wide arbitration only; never use for a local action", allowedUses: ["conflict"] });
  return inputs;
}

export function actionGroundingReferenceResolver(
  state: Readonly<SimulationState>,
  action?: Readonly<AgentActionProposal> | readonly Readonly<AgentActionProposal>[],
  slotByActionId: ReadonlyMap<string, number> = new Map(),
): ReferenceResolver {
  return createReferenceResolver(actionGroundingReferenceInputs(state, action, slotByActionId));
}

function resolveGroundingReference(
  resolver: ReferenceResolver,
  handle: ExistingReferenceHandle,
): FootprintRef {
  const resolved = resolver.resolve(handle, "conflict");
  if (resolved.kind === "world") return { kind: "global", id: "world" };
  if (resolved.kind === "agent" || resolved.kind === "local_entity" || resolved.kind === "claim" ||
    resolved.kind === "evidence" || resolved.kind === "observation" || resolved.kind === "action" ||
    resolved.kind === "event" || resolved.kind === "check" || resolved.kind === "random" ||
    resolved.kind === "law" || resolved.kind === "mechanic" || resolved.kind === "outcome" ||
    resolved.kind === "operation" || resolved.kind === "plan" || resolved.kind === "temporal_profile") {
    throw new Error(`reference ${handle} has kind ${resolved.kind}, which cannot be an interaction footprint`);
  }
  return { kind: resolved.kind, id: resolved.engineId } as FootprintRef;
}

export function materializeModelInteractionDependency(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  value: import("../runtime/execution").ActionGroundingModelOutput,
  resolver = actionGroundingReferenceResolver(state, action),
): InteractionDependency {
  const issues: PromptValidationIssue[] = [];
  const check = (handle: ExistingReferenceHandle, use: ModelReferenceUse, path: Array<string | number>, kind?: ModelReferenceKind): void => {
    try {
      const resolved = resolver.resolve(handle, use);
      if (kind && resolved.kind !== kind) {
        throw new ModelReferenceError({ code: `reference.${kind}_required`, path, originalValue: handle,
          allowedHandles: resolver.candidatesFor(use).filter(candidate => candidate.kind === kind).map(candidate => candidate.handle),
          reason: `This field requires a ${kind} candidate; the selected candidate is ${resolved.kind}.` });
      }
    } catch (error) {
      if (!(error instanceof ModelReferenceError)) throw error;
      issues.push({ code: error.code, class: "reference", path, originalValue: handle,
        allowedHandles: resolver.candidatesFor(use).filter(candidate => !kind || candidate.kind === kind).map(candidate => candidate.handle),
        message: error.message });
    }
  };
  value.stateDependencies.requiredExistingRefs.forEach((handle, index) => check(handle, "conflict", ["stateDependencies", "requiredExistingRefs", index]));
  value.stateDependencies.potentiallyAffectedExistingRefs.forEach((handle, index) => check(handle, "conflict", ["stateDependencies", "potentiallyAffectedExistingRefs", index]));
  value.audienceAgentRefs.forEach((handle, index) => check(handle, "audience", ["audienceAgentRefs", index], "agent"));
  value.sharedResourceClaims.forEach((claim, index) => check(claim.resourcePoolRef, "conflict", ["sharedResourceClaims", index, "resourcePoolRef"], "shared_resource_pool"));
  if (issues.length > 0) throw new ModelCandidateValidationError(issues);
  const requiredExistingRefs = value.stateDependencies.requiredExistingRefs.map((handle) => resolveGroundingReference(resolver, handle));
  const potentiallyAffectedExistingRefs = value.stateDependencies.potentiallyAffectedExistingRefs.map((handle) => resolveGroundingReference(resolver, handle));
  const audienceAgentIds = value.audienceAgentRefs.map((handle) => {
    const resolved = resolver.resolve(handle, "audience");
    if (resolved.kind !== "agent") throw new Error(`audience handle ${handle} is not an Agent candidate`);
    return resolved.engineId;
  });
  const sharedResourceClaims = value.sharedResourceClaims.map((claim) => {
    const resolved = resolver.resolve(claim.resourcePoolRef, "conflict");
    if (resolved.kind !== "shared_resource_pool") {
      throw new Error(`resource pool reference ${claim.resourcePoolRef} is not a shared resource pool`);
    }
    return { poolId: resolved.engineId, basis: structuredClone(claim.basis) };
  });
  const worldHandle = [...requiredExistingRefs, ...potentiallyAffectedExistingRefs]
    .some((ref) => ref.kind === "global" && ref.id === "world");
  return materializeInteractionDependency(state, action, {
    reads: requiredExistingRefs,
    writes: potentiallyAffectedExistingRefs,
    audienceAgentIds,
    sharedResourceClaims,
    globalFallback: worldHandle,
  });
}

function enrichDependency(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  dependency: InteractionDependency,
): InteractionDependency {
  const agent = state.agents[action.actorId];
  const placementId = state.truth.placements[agent.entityId];
  const mandatory: FootprintRef[] = [
    { kind: "entity", id: agent.entityId },
    ...(placementId ? [{ kind: "placement" as const, id: placementId }] : []),
  ];
  return {
    kind: "action",
    id: action.id,
    actorId: action.actorId,
    reads: stableRefs([...dependency.reads, ...mandatory]),
    writes: stableRefs([...dependency.writes, { kind: "entity", id: agent.entityId }]),
    audienceAgentIds: [...new Set([action.actorId, ...dependency.audienceAgentIds])].sort(),
    sharedResourceClaims: structuredClone(dependency.sharedResourceClaims),
    globalFallback: dependency.globalFallback,
  };
}

export function materializeInteractionDependency(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  value: InteractionDependencyDraft,
): InteractionDependency {
  const sharedResourceClaims = materializeSharedActivityResourceClaims({
    drafts: value.sharedResourceClaims,
    rawText: action.rawText,
    pools: state.truth.sharedActivityResourcePools,
    definitions: state.truth.mechanics.sharedActivityResources,
  });
  const normalized = normalizeInteractionDependency(state, action, {
    kind: "action",
    id: action.id,
    actorId: action.actorId,
    ...structuredClone(value),
    sharedResourceClaims,
  });
  if (normalized.fallbackReasons.length > 0) {
    throw new GroundingValidationError(action.id, normalized.fallbackReasons);
  }
  return enrichDependency(state, action, normalized.dependency);
}

export function actionGroundingSharedContext(
  state: Readonly<SimulationState>,
  action?: Readonly<AgentActionProposal> | readonly Readonly<AgentActionProposal>[],
  referenceResolver = actionGroundingReferenceResolver(state, action),
  includeReferenceDetails = false,
) {
  const resolver = referenceResolver;
  const handle = (kind: Parameters<ReferenceResolver["handleFor"]>[0], id: string) => resolver.handleFor(kind, id);
  const projectFactValue = (factValue: Readonly<SimulationState["truth"]["facts"][string]["value"]>): unknown =>
    factValue.kind === "entity"
      ? { kind: "entity", entityRef: handle("entity", factValue.entityId) }
      : structuredClone(factValue);
  const projectAccess = (access: Readonly<SimulationState["truth"]["facts"][string]["access"]>): unknown =>
    access.kind === "agents"
      ? { kind: "agents", agentRefs: access.agentIds.map((agentId) => handle("agent", agentId)) }
      : { kind: access.kind };
  const canonicalTruth = {
    entities: Object.values(state.truth.entities).map(({ id, kind, name, description, lifecycle }) => ({
      ref: handle("entity", id), kind, name, description, lifecycle,
      placementRef: state.truth.placements[id] ? handle("placement", state.truth.placements[id]!) : null,
    })),
    facts: Object.values(state.truth.facts).map(({ id, subjectId, predicate, value: factValue, description, access }) => ({
      ref: handle("fact", id), subjectRef: handle("entity", subjectId), predicate, value: projectFactValue(factValue), description,
      access: projectAccess(access),
    })),
    placements: Object.entries(state.truth.placements).map(([entityId, containerId]) => ({
      entityRef: handle("placement", entityId),
      containerRef: containerId ? handle("placement", containerId) : null,
    })),
    meters: Object.values(state.truth.meters).map((meter) => ({
      ref: handle("meter", meter.id), definitionId: meter.definitionId, entityRef: handle("entity", meter.entityId), current: meter.current,
    })),
    quantities: Object.values(state.truth.quantities).map((quantity) => ({
      ref: handle("quantity", quantity.id), definitionId: quantity.definitionId, holderRef: handle("entity", quantity.holderId), amount: quantity.amount,
    })),
    ratings: Object.values(state.truth.ratings).map((rating) => ({
      ref: handle("rating", rating.id), definitionId: rating.definitionId, entityRef: handle("entity", rating.entityId), value: rating.value,
    })),
    conditions: Object.values(state.truth.conditions).map((condition) => ({
      ref: handle("condition", condition.id), subjectRef: handle("entity", condition.subjectId), label: condition.label, description: condition.description,
    })),
    sharedActivityResourcePools: Object.values(state.truth.sharedActivityResourcePools).map((pool) => ({
      ref: handle("shared_resource_pool", pool.id), definitionId: pool.definitionId, entityRef: handle("entity", pool.entityId),
      capacity: pool.capacity,
    })),
  };
  const details = new Map<string, unknown>();
  const register = (reference: unknown, value: Record<string, unknown>, referenceKey = "ref"): void => {
    if (typeof reference !== "string") return;
    details.set(reference, Object.fromEntries(Object.entries(value).filter(([key]) =>
      key !== referenceKey)));
  };
  canonicalTruth.entities.forEach((value) => register(value.ref, value));
  canonicalTruth.facts.forEach((value) => register(value.ref, value));
  canonicalTruth.placements.forEach((value) => register(value.entityRef, value, "entityRef"));
  canonicalTruth.meters.forEach((value) => register(value.ref, value));
  canonicalTruth.quantities.forEach((value) => register(value.ref, value));
  canonicalTruth.ratings.forEach((value) => register(value.ref, value));
  canonicalTruth.conditions.forEach((value) => register(value.ref, value));
  canonicalTruth.sharedActivityResourcePools.forEach((value) => register(value.ref, value));
  const actors = Object.values(state.agents).map(({ id, entityId }) => ({
    ref: handle("agent", id),
    entityRef: handle("entity", entityId),
  }));
  actors.forEach((value) => register(value.ref, value));
  for (const profile of Object.values(state.truth.mechanics.temporalProfiles)) {
    details.set(handle("temporal_profile", profile.id), Object.fromEntries(
      Object.entries(profile).filter(([key]) => key !== "id"),
    ));
  }
  for (const activity of Object.values(state.truth.activities)) {
    const plan = "plan" in activity ? activity.plan : activity.planDraft;
    details.set(handle("activity", activity.id), {
      status: activity.status,
      description: plan.description,
      profileRef: handle("temporal_profile", plan.profileId),
      participantAgentRefs: activity.participantAgentIds.map((agentId) => handle("agent", agentId)),
    });
  }
  details.set(handle("world", "world"), { currentElapsedSeconds: state.truth.elapsedSeconds });
  const projectedResolver = includeReferenceDetails
    ? withReferenceCandidateDetails(resolver, (resolution) => details.get(resolution.handle))
    : resolver;
  return {
    contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
    referenceCatalog: projectedResolver.catalog,
    referenceResolver: projectedResolver,
    state: {
      canonicalTruth,
      actors,
    },
  };
}

export function actionGroundingSlotContext(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  issues: readonly string[],
  referenceResolver = actionGroundingReferenceResolver(state, action),
) {
  const agent = state.agents[action.actorId];
  return {
    action: {
      rawText: action.rawText,
      goal: action.goal,
      means: action.means,
      actionRef: referenceResolver.handleFor("action", action.id),
      actorRef: referenceResolver.handleFor("agent", action.actorId),
      targetRefs: action.targetIds.map((targetId) => referenceResolver.handleFor("local_entity", `${action.actorId}::${targetId}`)),
    },
    actorPerspective: projectAgentPerspectiveForModel(state, agent, referenceResolver, { includePrivateCognition: false }),
    constraints: issues,
  };
}

export function actionGroundingContext(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  issues: readonly string[],
  scope: Pick<ModelExecutionScope, "workloadId" | "batchId">,
  feedback?: Pick<SemanticRepairContext, "issues" | "previousOutput">,
) {
  const shared = actionGroundingSharedContext(state, action);
  const slot = actionGroundingSlotContext(state, action, issues);
  return {
    contractVersion: shared.contractVersion,
    roleContract: modelRoleContract("action-grounding"),
    execution: { worldId: state.worldId, instanceId: scope.workloadId, advanceId: scope.batchId, revision: state.revision, step: state.step },
    task: {
      assignment: {
        targetHandles: [slot.action.actionRef],
        availableHandles: shared.referenceCatalog.candidates.map((candidate) => candidate.handle),
        allowedProposalKinds: [],
      },
      constraints: slot.constraints,
    },
    state: {
      ...shared.state,
      action: slot.action,
      actorPerspective: slot.actorPerspective,
    },
    referenceCatalog: shared.referenceCatalog,
    repair: issues.length > 0
      ? { target: slot.action.actionRef,
        issues: feedback ? feedback.issues.map(issue => ({ code: issue.code, class: issue.class, path: [...issue.path],
          originalValue: issue.originalValue ?? null, allowedHandles: [...(issue.allowedHandles ?? [])], reason: issue.message }))
          : issues.map((reason) => ({ code: "action_grounding", class: "semantic" as const, path: ["task"], originalValue: null, allowedHandles: [], reason })),
        previousOutputAvailable: feedback?.previousOutput !== undefined,
        ...(feedback?.previousOutput === undefined ? {} : { previousOutput: structuredClone(feedback.previousOutput) }),
      }
      : null,
  };
}

export async function generateInteractionDependency(
  provider: StructuredModelProvider,
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  scope: ModelExecutionScope,
  profileId: string,
  invocationOffset = 0,
  repairAttempts = 2,
): Promise<{ dependency: InteractionDependency; audit: ModelExecutionAudit }> {
  try {
    const result = await runSemanticRepairLoop({
      role: "action-grounding",
      repairScope: "slot",
      targetIds: [action.id],
      maxRepairs: repairAttempts,
      logicalInvocationId: modelInvocationLogicalId(scope, "action-grounding", action.actorId, invocationOffset + 1),
      invoke: async (repairContext) => {
        const identity = modelInvocationIdentity(
          scope,
          "action-grounding",
          action.actorId,
          invocationOffset + repairContext.attempt + 1,
        );
        const correlation = modelInvocationCorrelation(scope, "action-grounding", action.actorId, identity, {
          logicalInvocationId: repairContext.logicalInvocationId ?? modelInvocationLogicalId(scope, "action-grounding", action.actorId, invocationOffset + 1),
          semanticRepairAttempt: repairContext.attempt,
          ...(repairContext.parentInvocationId ? {
            parentInvocationId: repairContext.parentInvocationId,
            repairOf: repairContext.repairOf,
          } : {}),
        });
        const generated = await provider.generateStructured({
          profileId,
          workloadId: scope.workloadId,
          batchId: scope.batchId,
          abortSignal: scope.abortSignal,
          correlation,
          observer: scope.observer,
          ...identity,
          role: "action-grounding",
          subjectId: action.actorId,
          promptVersion: GROUNDING_PROMPT.version,
          schemaName: "action_grounding",
          system: GROUNDING_PROMPT.system,
          userPrompt: GROUNDING_PROMPT.userPrompt,
          context: actionGroundingContext(
            state,
            action,
            repairContext.issues.map((issue) => issue.message),
            scope,
            repairContext,
          ),
          schema: actionGroundingSchema,
        });
        setModelInvocationResultKind(generated.audit, "action-grounding_footprint");
        return generated;
      },
      validate: (value) => {
        materializeModelInteractionDependency(state, action, value);
      },
      classify: (error) => {
        if (error instanceof ModelCandidateValidationError || error instanceof ModelReferenceError || error instanceof ModelOutputError) {
          return validationIssues(error).map(issue => ({ ...issue, class: issue.class ?? "reference", targetIds: [action.id] }));
        }
        const reasons = error instanceof GroundingValidationError
          ? error.reasons
          : [error instanceof Error ? error.message : String(error)];
        return reasons.map((reason) => semanticIssue(
          reason.startsWith("unknown_") || reason.includes("reference") ? "grounding_reference" : "grounding_scope",
          reason,
          { class: "reference", path: ["interactionDependency"], targetIds: [action.id] },
        ));
      },
      onRejected: ({ context, audit, issues, error }) => {
        const invocation = audit?.invocations.at(-1);
        if (audit) setModelInvocationOutcome(audit, "rejected", issues.map((issue) => issue.code));
        scope.observer?.emit({
          event: "model.semantic.rejected",
          level: "warn",
          correlation: modelInvocationCorrelation(scope, "action-grounding", action.actorId, {
            modelInvocationId: invocation?.id,
            modelInvocation: invocation?.ordinal,
          }, {
            logicalInvocationId: context.logicalInvocationId ?? modelInvocationLogicalId(scope, "action-grounding", action.actorId, invocationOffset + 1),
            semanticRepairAttempt: context.attempt,
            ...(context.parentInvocationId ? {
              parentInvocationId: context.parentInvocationId,
              repairOf: context.repairOf,
            } : {}),
          }),
          attributes: { resultKind: invocation?.resultKind ?? "action-grounding_footprint" },
          counts: { validationIssues: issues.length },
          error: { name: error instanceof Error ? error.name : "GroundingValidationError", message: issues[0]?.message },
        });
      },
    });
    const last = result.audit.invocations.at(-1);
    if (last) setModelInvocationOutcome(result.audit, "accepted");
    return {
      dependency: materializeModelInteractionDependency(state, action, result.value),
      audit: result.audit,
    };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    throw new ModelSemanticRepairError(
      "action-grounding",
      `action grounding failed after repairs for ${action.actorId}: ${error.message}`,
      { cause: error, audit: error.audit },
    );
  }
}

export function forceGlobalInteractionDependency(dependency: Readonly<InteractionDependency>): InteractionDependency {
  const globalRef: FootprintRef = { kind: "global", id: "world" };
  return {
    ...structuredClone(dependency),
    reads: stableRefs([...dependency.reads, globalRef]),
    writes: stableRefs([...dependency.writes, globalRef]),
    globalFallback: true,
  };
}

export function replaceInteractionDependencies(
  current: readonly InteractionDependency[],
  replacements: readonly { actorId: AgentId; dependency: InteractionDependency }[],
): InteractionDependency[] {
  const replacedActors = new Set(replacements.map((replacement) => replacement.actorId));
  return [
    ...current.filter((dependency) => dependency.kind !== "action" ||
      dependency.actorId === null || !replacedActors.has(dependency.actorId)),
    ...replacements.map((replacement) => structuredClone(replacement.dependency)),
  ].sort((left, right) => left.id.localeCompare(right.id));
}

export type InteractionGraphMode = "canonical" | "notification";

export type InteractionDependencyConflictKind =
  | "global"
  | "read-write"
  | "write-write"
  | "shared-resource"
  | "audience";

export interface InteractionDependencyGraphEdge {
  from: string;
  to: string;
  kinds: InteractionDependencyConflictKind[];
}

export interface InteractionDependencyGraphSnapshot {
  mode: InteractionGraphMode;
  nodeIds: string[];
  edges: InteractionDependencyGraphEdge[];
  components: string[][];
  globalFallbackNodeIds: string[];
  edgeCount: number;
  maxComponentSize: number;
  contentHash: string;
}

function dependencyWriteKeys(dependency: InteractionDependency): string[] {
  return [
    ...dependency.writes.map(footprintRefKey),
    ...dependency.sharedResourceClaims.map((claim) => `shared_resource_pool:${claim.poolId}`),
  ];
}

function dependencyReadKeys(dependency: InteractionDependency): string[] {
  return dependency.reads.map(footprintRefKey);
}

/**
 * Canonical conflict excludes audience-only links. Audience is an observation
 * fan-out and becomes a Truth dependency only when onset reaction grounding
 * proves that the actor can perceive and change the ongoing action.
 */
export function interactionDependenciesConflict(
  left: InteractionDependency,
  right: InteractionDependency,
  mode: InteractionGraphMode = "notification",
): boolean {
  if (left.globalFallback || right.globalFallback) return true;
  const leftWrites = new Set(dependencyWriteKeys(left));
  const rightWrites = new Set(dependencyWriteKeys(right));
  const leftReads = new Set(dependencyReadKeys(left));
  const rightReads = new Set(dependencyReadKeys(right));
  if ([...leftWrites].some((key) => rightWrites.has(key) || rightReads.has(key)) ||
    [...rightWrites].some((key) => leftReads.has(key))) return true;
  if (mode === "notification" &&
    ((right.actorId !== null && left.audienceAgentIds.includes(right.actorId)) ||
      (left.actorId !== null && right.audienceAgentIds.includes(left.actorId)))) return true;
  return false;
}

function addIndexed(index: Map<string, number[]>, key: string, value: number): void {
  const entries = index.get(key) ?? [];
  entries.push(value);
  index.set(key, entries);
}

/**
 * Builds a deterministic sparse dependency graph using inverted indexes. The
 * graph is ephemeral evidence: canonical state remains authoritative and the
 * committer independently reconstructs the partition.
 */
export function buildInteractionDependencyGraph(
  dependencies: readonly InteractionDependency[],
  mode: InteractionGraphMode = "canonical",
): InteractionDependencyGraphSnapshot {
  const nodeIds = dependencies.map((dependency) => dependency.id);
  const seenIds = new Set<string>();
  for (const id of nodeIds) {
    if (seenIds.has(id)) throw new Error(`interaction dependency graph contains duplicate node ${id}`);
    seenIds.add(id);
  }
  const parent = dependencies.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  const edgeKinds = new Map<string, Set<InteractionDependencyConflictKind>>();
  const addEdge = (left: number, right: number, kind: InteractionDependencyConflictKind): void => {
    if (left === right) return;
    const fromIndex = Math.min(left, right);
    const toIndex = Math.max(left, right);
    const key = `${fromIndex}:${toIndex}`;
    const kinds = edgeKinds.get(key) ?? new Set<InteractionDependencyConflictKind>();
    kinds.add(kind);
    edgeKinds.set(key, kinds);
    union(fromIndex, toIndex);
  };

  const readers = new Map<string, number[]>();
  const writers = new Map<string, number[]>();
  const actors = new Map<string, number[]>();
  const globalNodes: number[] = [];
  dependencies.forEach((dependency, index) => {
    dependencyReadKeys(dependency).forEach((key) => addIndexed(readers, key, index));
    dependencyWriteKeys(dependency).forEach((key) => addIndexed(writers, key, index));
    if (dependency.actorId !== null) addIndexed(actors, dependency.actorId, index);
    if (dependency.globalFallback) globalNodes.push(index);
  });

  const connectAll = (indices: readonly number[], kind: InteractionDependencyConflictKind): void => {
    for (let left = 0; left < indices.length; left += 1) {
      for (let right = left + 1; right < indices.length; right += 1) {
        addEdge(indices[left]!, indices[right]!, kind);
      }
    }
  };
  const connectIndexes = (
    index: Map<string, number[]>,
    kind: InteractionDependencyConflictKind,
  ): void => {
    for (const indices of index.values()) connectAll(indices, kind);
  };
  connectIndexes(writers, "write-write");
  for (const [key, readIndexes] of readers.entries()) {
    const writeIndexes = writers.get(key) ?? [];
    for (const reader of readIndexes) {
      for (const writer of writeIndexes) addEdge(reader, writer, "read-write");
    }
  }
  dependencies.forEach((dependency, index) => {
    if (dependency.sharedResourceClaims.length === 0) return;
    const keys = new Set(dependencyWriteKeys(dependency)
      .filter((key) => key.startsWith("shared_resource_pool:")));
    for (const key of keys) {
      for (const other of writers.get(key) ?? []) addEdge(index, other, "shared-resource");
    }
  });
  if (globalNodes.length > 0) {
    for (const globalNode of globalNodes) {
      for (let index = 0; index < dependencies.length; index += 1) {
        addEdge(globalNode, index, "global");
      }
    }
  }
  if (mode === "notification") {
    dependencies.forEach((dependency, index) => {
      for (const audienceAgentId of dependency.audienceAgentIds) {
        for (const actorIndex of actors.get(audienceAgentId) ?? []) {
          addEdge(index, actorIndex, "audience");
        }
      }
    });
  }

  const groups = new Map<number, string[]>();
  dependencies.forEach((dependency, index) => {
    const group = groups.get(root(index)) ?? [];
    group.push(dependency.id);
    groups.set(root(index), group);
  });
  const components = [...groups.values()]
    .map((group) => group.sort())
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
  const edges = [...edgeKinds.entries()]
    .map(([key, kinds]) => {
      const [fromIndex, toIndex] = key.split(":").map(Number);
      const ids = [nodeIds[fromIndex]!, nodeIds[toIndex]!].sort((left, right) => left.localeCompare(right));
      return {
        from: ids[0]!,
        to: ids[1]!,
        kinds: [...kinds].sort(),
      };
    })
    .sort((left, right) => `${left.from}:${left.to}`.localeCompare(`${right.from}:${right.to}`));
  const snapshotBody = {
    mode,
    nodeIds: [...nodeIds].sort(),
    edges,
    components,
    globalFallbackNodeIds: globalNodes.map((index) => nodeIds[index]!).sort(),
    edgeCount: edges.length,
    maxComponentSize: Math.max(0, ...components.map((component) => component.length)),
  };
  return {
    ...snapshotBody,
    contentHash: contentHash(snapshotBody),
  };
}

export function interactionDependencyComponents(
  dependencies: readonly InteractionDependency[],
  mode: InteractionGraphMode = "canonical",
): string[][] {
  return buildInteractionDependencyGraph(dependencies, mode).components;
}

/**
 * Small, intentionally slow oracle used by regression tests. The production
 * scheduler uses the indexed graph above; this pairwise implementation gives
 * us an independent reference for proving that optimization did not change
 * component semantics.
 */
export function interactionDependencyComponentsExhaustive(
  dependencies: readonly InteractionDependency[],
  mode: InteractionGraphMode = "canonical",
): string[][] {
  const parent = dependencies.map((_, index) => index);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = root(left);
    const rightRoot = root(right);
    if (leftRoot !== rightRoot) parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  };
  for (let left = 0; left < dependencies.length; left += 1) {
    for (let right = left + 1; right < dependencies.length; right += 1) {
      if (interactionDependenciesConflict(dependencies[left]!, dependencies[right]!, mode)) union(left, right);
    }
  }
  const groups = new Map<number, string[]>();
  dependencies.forEach((dependency, index) => {
    const group = groups.get(root(index)) ?? [];
    group.push(dependency.id);
    groups.set(root(index), group);
  });
  return [...groups.values()]
    .map((group) => group.sort())
    .sort((left, right) => left[0]!.localeCompare(right[0]!));
}

export function interactionDependencyEdgeCount(
  dependencies: readonly InteractionDependency[],
  mode: InteractionGraphMode = "canonical",
): number {
  return buildInteractionDependencyGraph(dependencies, mode).edgeCount;
}

function operationResources(
  state: Readonly<SimulationState>,
  operation: WorldDeltaOperation,
): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  const addEntity = (id: string | null | undefined, target = writes) => {
    if (id) target.add(`entity:${id}`);
  };
  switch (operation.kind) {
    case "create_entity": addEntity(operation.entity.id); addEntity(operation.placementId, reads); break;
    case "retire_entity": addEntity(operation.entityId); break;
    case "place_entity": addEntity(operation.entityId); addEntity(operation.placementId, reads); break;
    case "set_fact": writes.add(`fact:${operation.fact.id}`); addEntity(operation.fact.subjectId, reads); break;
    case "remove_fact": writes.add(`fact:${operation.factId}`); break;
    case "set_meter": writes.add(`meter:${operation.meter.id}`); break;
    case "adjust_meter": writes.add(`meter:${operation.meterId}`); break;
    case "transfer_quantity":
      writes.add(`quantity:${quantityId(state.worldHash, operation.definitionId, operation.fromHolderId)}`);
      writes.add(`quantity:${quantityId(state.worldHash, operation.definitionId, operation.toHolderId)}`);
      break;
    case "produce_quantity":
    case "consume_quantity":
      writes.add(`quantity:${quantityId(state.worldHash, operation.definitionId, operation.holderId)}`);
      break;
    case "set_quantity": writes.add(`quantity:${operation.quantity.id}`); break;
    case "set_rating": writes.add(`rating:${operation.rating.id}`); break;
    case "set_condition": writes.add(`condition:${operation.condition.id}`); addEntity(operation.condition.subjectId, reads); break;
    case "remove_condition": writes.add(`condition:${operation.conditionId}`); break;
    case "create_agent": addEntity(operation.agent.entityId); break;
    case "remove_agent": writes.add(`agent:${operation.agentId}`); break;
    case "advance_time": break;
  }
  return { reads, writes };
}

function actualComponentFootprint(
  state: Readonly<SimulationState>,
  resolution: UnreviewedTruthResolution,
): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const operation of resolution.proposal.operations) {
    const actual = operationResources(state, operation);
    actual.reads.forEach((key) => reads.add(key));
    actual.writes.forEach((key) => writes.add(key));
  }
  return { reads, writes };
}

export function resolvedComponentsConflict(
  state: Readonly<SimulationState>,
  left: UnreviewedTruthResolution,
  right: UnreviewedTruthResolution,
): boolean {
  const leftFootprint = actualComponentFootprint(state, left);
  const rightFootprint = actualComponentFootprint(state, right);
  return [...leftFootprint.writes].some((key) =>
    rightFootprint.writes.has(key) || rightFootprint.reads.has(key)) ||
    [...rightFootprint.writes].some((key) => leftFootprint.reads.has(key));
}

export function resolutionExceedsDeclaredDependencies(
  state: Readonly<SimulationState>,
  resolution: UnreviewedTruthResolution,
  dependencies: readonly InteractionDependency[],
): boolean {
  if (dependencies.some((dependency) => dependency.globalFallback)) return false;
  const declaredReads = new Set(dependencies.flatMap((dependency) =>
    [...dependency.reads, ...dependency.writes].map(footprintRefKey)));
  const declaredWrites = new Set(dependencies.flatMap((dependency) =>
    dependency.writes.map(footprintRefKey)));
  const actual = actualComponentFootprint(state, resolution);
  return [...actual.reads].some((key) => !declaredReads.has(key)) ||
    [...actual.writes].some((key) => !declaredWrites.has(key));
}
