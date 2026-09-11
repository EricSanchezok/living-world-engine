import { PinnedActionCompilationSelection } from "./candidate-retrieval/pinned-selection";
import { SourceActionDescriptionMismatch } from "./source-action-description";
import { z } from "zod";
import {
  actionCompilationBatchSchema,
  actionCompilationRequestSchema,
  actionCompilationSlotSchema,
  type ActionCompilationModelOutput,
  type ModelCausalAssertion,
} from "../../contracts/llm-schemas";
import {
  actionGroundingSharedContext,
  actionGroundingSlotContext,
  materializeModelInteractionDependency,
  actionGroundingReferenceResolver,
} from "../../mechanics/action-dependency";
import {
  DEFAULT_EAGER_OUTPUT_RECOVERY,
  eagerRequestBytes,
  eagerSlotBatchOwner,
  EagerSlotAttemptError,
  isTerminalEagerModelError,
  runEagerSlotBatches,
  type EagerSlot,
  type EagerSlotAttemptLineage,
  type EagerSlotAttemptResult,
} from "./eager-slot-batching";
import type {
  ActionCompilationResult,
  CompiledAction,
  OutputRecoveryCapability,
} from "../roles";
import type { ActionCompilationDraft } from "../../runtime/execution";
import type { ActionCompilationReferenceAudit, AgentActionProposal, CausalAssertion, DiscreteRandomAggregate, ModelExecutionAudit, ModelOutputIssue, SimulationState } from "../../contracts/model";
import {
  ModelOutputError,
  ModelSemanticRepairError,
  modelInvocationCorrelation,
  modelInvocationIdentity,
  setModelInvocationOutcome,
  setModelInvocationResultKind,
  type ModelExecutionScope,
  type StructuredModelProvider,
} from "../../models/model-provider";
import { runtimeId } from "../../runtime/runtime-id";
import {
  createActivity,
  eligibleTemporalProfiles,
  extractActionTemporalEvidence,
  materializeModelTemporalBasis,
  materializeTemporalPlan,
  type ScheduledActivityState,
} from "../../mechanics/temporal";
import { evaluateCausalAssertion } from "../../mechanics/causality";
import { promptBundle } from "../../prompts";
import {
  ACTION_COMPILATION_PROJECTION,
  ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH,
  ACTION_COMPILATION_CANDIDATE_KEY_VERSION,
  createActionCompilationReferenceResolver,
  isProposalReference,
  MODEL_CONTEXT_CONTRACT_VERSION,
  modelRepairIssueFromReferenceError,
  modelRoleContract,
  normalizeModelOutput,
  ModelReferenceError,
  type ModelRepairIssue,
  type ModelReference,
  type ModelReferenceUse,
  type ActionCompilationReferenceResolver,
} from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { fullRuntimePayload } from "../../runtime/observability";
import { semanticRepairFingerprint } from "../../models/semantic-repair";
import {
  ActionCompilationValidationError,
  materializeActionCompilationCandidateKeys,
  normalizeActionCompilationContextCauses,
  normalizeActionCompilationDraftReferences,
  preprocessActionCompilationSymbols,
  validateActionCompilationShortlistMembership,
  validateActionCompilationDraft,
} from "./action-compilation-validation";
import {
  actionCompilationContextProjectionMetrics,
  projectActionCompilationContextForModel,
} from "./action-compilation-context";
import { DEFAULT_SYMBOL_REPAIR_POLICY } from "../../contracts/symbol-repair";

const ACTION_COMPILER_PROMPT = promptBundle("action-compilation");
export const ACTION_COMPILER_PROMPT_VERSION = ACTION_COMPILER_PROMPT.version;

function candidateKeysInValue(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (/^candidate_[0-9a-f]+$/u.test(value)) output.add(value);
    return output;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => candidateKeysInValue(entry, output));
    return output;
  }
  if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((entry) => candidateKeysInValue(entry, output));
  return output;
}

interface CompilationPayload {
  action: AgentActionProposal;
  previousOutput?: unknown;
}

type CompilationSlot = EagerSlot<CompilationPayload, ModelRepairIssue>;

function compilationIssue(input: {
  code: string;
  reason: string;
  class?: ModelRepairIssue["class"];
  path?: Array<string | number>;
  originalValue?: unknown;
  allowedHandles?: readonly string[];
}): ModelRepairIssue {
  return {
    code: input.code,
    class: input.class ?? "semantic",
    path: [...(input.path ?? [])],
    originalValue: input.originalValue === undefined ? null : structuredClone(input.originalValue),
    allowedHandles: [...(input.allowedHandles ?? [])],
    reason: input.reason,
  };
}

function modelIssuePath(path: readonly PropertyKey[]): Array<string | number> {
  return path.filter((segment): segment is string | number =>
    typeof segment === "string" || typeof segment === "number");
}

function existingActivities(
  state: Readonly<SimulationState>,
  action: Readonly<AgentActionProposal>,
  resolver: ReturnType<typeof actionGroundingReferenceResolver>,
) {
  return Object.values(state.truth.activities)
    .filter((activity): activity is ScheduledActivityState =>
      activity.participantAgentIds.includes(action.actorId) &&
      (activity.status === "active" || activity.status === "paused"))
    .map(({ id, status, plan, progress }) => ({
      activityRef: resolver.handleFor("activity", id),
      status,
      profileRef: resolver.handleFor("temporal_profile", plan.profileId),
      description: plan.description,
      progress,
    }));
}

function actionReferenceStatus(
  resolver: ActionCompilationReferenceResolver,
  handleResolver: ReturnType<typeof actionGroundingReferenceResolver>,
  state: Readonly<SimulationState>,
  action: Readonly<AgentActionProposal>,
) {
  const actionHandle = handleResolver.handleFor("action", action.id);
  const actor = state.agents[action.actorId];
  const actorCandidateKey = actor ? resolver.candidateKeyForHandle(handleResolver.handleFor("agent", actor.id)) : null;
  const actorEntityCandidateKey = actor && state.truth.entities[actor.entityId]?.lifecycle === "active"
    ? resolver.candidateKeyForHandle(handleResolver.handleFor("entity", actor.entityId))
    : null;
  const targets = action.targetIds.map((localEntityId, targetIndex) => {
    const binding = actor?.bindings[localEntityId];
    const canonicalIds = (binding?.canonicalEntityIds ?? []).filter((id) => state.truth.entities[id]?.lifecycle === "active");
    const keys = canonicalIds.map((id) => resolver.candidateKeyForHandle(handleResolver.handleFor("entity", id)));
    return {
      targetIndex,
      label: actor?.belief.localEntities[localEntityId]?.name ?? null,
      status: !binding ? "unresolved" : canonicalIds.length === 1 ? "unique" : canonicalIds.length > 1 ? "ambiguous" : "stale",
      candidateKeys: keys,
    } as const;
  });
  return {
    actionCandidateKey: resolver.candidateKeyForHandle(actionHandle),
    actor: {
      status: actorCandidateKey && actorEntityCandidateKey ? "unique" : "stale",
      agentCandidateKey: actorCandidateKey,
      boundEntityCandidateKey: actorEntityCandidateKey,
    },
    targets,
  };
}

type ActionCompilationSelection = ActionCompilationReferenceAudit["slots"][number]["selections"][number];

function collectActionCompilationSelections(
  value: ActionCompilationModelOutput,
  resolver: ActionCompilationReferenceResolver,
): { selections: ActionCompilationSelection[]; issues: ModelRepairIssue[] } {
  const selections: ActionCompilationSelection[] = [];
  const issues: ModelRepairIssue[] = [];
  const add = (path: Array<string | number>, candidateKey: unknown, use: ModelReferenceUse): void => {
    if (typeof candidateKey !== "string") return;
    try {
      const resolved = resolver.resolve(candidateKey, use);
      selections.push({ path, use, candidateKey, engineHandle: resolved.handle, kind: resolved.kind, status: "resolved" });
    } catch (error) {
      if (!(error instanceof ModelReferenceError)) throw error;
      issues.push(modelRepairIssueFromReferenceError(error, path));
      selections.push({
        path,
        use,
        candidateKey,
        engineHandle: null,
        kind: null,
        status: "invalid",
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  };
  add(["temporalPlan", "profileRef"], value.temporalPlan.profileRef, "profile");
  value.temporalPlan.causes.forEach((cause, index) => add(["temporalPlan", "causes", index, "ref"], cause.ref, "cause"));
  value.temporalPlan.continuationAssertions.forEach((assertion, index) => {
    const base = ["temporalPlan", "continuationAssertions", index] as Array<string | number>;
    switch (assertion.kind) {
      case "check_result": add([...base, "checkRef"], assertion.checkRef, "assertion"); break;
      case "random_result":
        add([...base, "requestRef"], assertion.requestRef, "assertion");
        add([...base, "stepRef"], assertion.stepRef, "assertion");
        break;
      case "fact_matches":
        add([...base, "factRef"], assertion.factRef, "assertion");
        if (assertion.expected.kind === "entity") add([...base, "expected", "entityRef"], assertion.expected.entityRef, "assertion");
        break;
      case "fact_absent": add([...base, "factRef"], assertion.factRef, "assertion"); break;
      case "entity_absent":
      case "entity_lifecycle": add([...base, "entityRef"], assertion.entityRef, "assertion"); break;
      case "placement_equals":
      case "placement_not_equals":
        add([...base, "entityRef"], assertion.entityRef, "assertion");
        if (assertion.placementRef !== null) add([...base, "placementRef"], assertion.placementRef, "assertion");
        break;
      case "shared_placement":
        add([...base, "leftEntityRef"], assertion.leftEntityRef, "assertion");
        add([...base, "rightEntityRef"], assertion.rightEntityRef, "assertion");
        break;
      case "meter_compare": add([...base, "meterRef"], assertion.meterRef, "assertion"); break;
      case "quantity_compare": add([...base, "quantityRef"], assertion.quantityRef, "assertion"); break;
      case "rating_compare": add([...base, "ratingRef"], assertion.ratingRef, "assertion"); break;
      case "shared_resource_capacity_compare": add([...base, "poolRef"], assertion.poolRef, "assertion"); break;
      case "elapsed_seconds_compare": break;
    }
  });
  value.interactionDependency.stateDependencies.requiredExistingCandidateKeys.forEach((key, index) =>
    add(["interactionDependency", "stateDependencies", "requiredExistingCandidateKeys", index], key, "conflict"));
  value.interactionDependency.stateDependencies.potentiallyAffectedCandidateKeys.forEach((key, index) =>
    add(["interactionDependency", "stateDependencies", "potentiallyAffectedCandidateKeys", index], key, "conflict"));
  value.interactionDependency.audienceAgentCandidateKeys.forEach((key, index) =>
    add(["interactionDependency", "audienceAgentCandidateKeys", index], key, "audience"));
  value.interactionDependency.sharedResourceClaims.forEach((claim, index) =>
    add(["interactionDependency", "sharedResourceClaims", index, "resourcePoolCandidateKey"], claim.resourcePoolCandidateKey, "conflict"));
  return { selections, issues };
}

function actionCompilationReferenceAudit(input: {
  state: Readonly<SimulationState>;
  batch: readonly CompilationSlot[];
  context: ReturnType<typeof actionCompilationContext>;
  actionResolver: ActionCompilationReferenceResolver;
  handleResolver: ReturnType<typeof actionGroundingReferenceResolver>;
  selectionsBySlot?: ReadonlyMap<number, readonly ActionCompilationSelection[]>;
}): ActionCompilationReferenceAudit {
  const metrics = actionCompilationContextProjectionMetrics(input.context);
  return {
    protocolVersion: 2,
    projection: ACTION_COMPILATION_PROJECTION,
    context: {
      utf8Bytes: metrics.bytes,
      referenceCatalogUtf8Bytes: jsonUtf8Bytes(input.context.referenceCatalog),
      slots: metrics.slots,
      candidates: metrics.candidates,
      detailedCandidates: metrics.detailedCandidates,
      duplicateSemanticDefinitionCount: metrics.duplicateSemanticDefinitionCount,
      canonicalRefSerializedCount: metrics.canonicalRefSerializedCount,
      rawPrivateReferenceSerializedCount: metrics.rawPrivateReferenceSerializedCount,
    },
    slots: input.batch.map((entry, slot) => {
      const action = entry.payload.action;
      const scopedActionResolver = input.actionResolver.scopedToSlot(slot);
      const scopedHandleResolver = input.handleResolver.scopedToSlot(slot);
      const referenceStatus = actionReferenceStatus(scopedActionResolver, scopedHandleResolver, input.state, action);
      const actor = input.state.agents[action.actorId];
      const actorHandle = actor ? scopedHandleResolver.handleFor("agent", actor.id) : null;
      const entityHandle = actor && input.state.truth.entities[actor.entityId]?.lifecycle === "active"
        ? scopedHandleResolver.handleFor("entity", actor.entityId) : null;
      return {
        slot,
        actionId: action.id,
        actionLabel: action.rawText,
        actionCandidateKey: referenceStatus.actionCandidateKey,
        actor: {
          agentId: action.actorId,
          entityId: actor?.entityId ?? null,
          status: referenceStatus.actor.status as "unique" | "stale",
          agentCandidateKey: referenceStatus.actor.agentCandidateKey,
          boundEntityCandidateKey: referenceStatus.actor.boundEntityCandidateKey,
          agentHandle: actorHandle,
          entityHandle,
        },
        targets: referenceStatus.targets.map((target) => {
          const localId = action.targetIds[target.targetIndex] ?? String(target.targetIndex);
          const localReference = `${action.actorId}::${localId}`;
          const canonicalEntityIds = actor?.bindings[localId]?.canonicalEntityIds
            ?.filter((id) => input.state.truth.entities[id]?.lifecycle === "active") ?? [];
          return {
            targetIndex: target.targetIndex,
            localReference,
            label: target.label,
            status: target.status,
            canonicalEntityIds: [...canonicalEntityIds],
            canonicalCandidateKeys: [...target.candidateKeys],
            canonicalHandles: canonicalEntityIds.map((id) => scopedHandleResolver.handleFor("entity", id)),
          };
        }),
        selections: [...(input.selectionsBySlot?.get(slot) ?? [])],
      };
    }),
  };
}

function emitActionCompilationReferenceAudit(
  scope: ModelExecutionScope,
  owner: string,
  identity: ReturnType<typeof modelInvocationIdentity>,
  audit: ActionCompilationReferenceAudit,
  lineage?: EagerSlotAttemptLineage,
): void {
  const observer = scope.observer;
  if (!observer) return;
  observer.emit({
    event: "model.action_compilation.references",
    correlation: modelInvocationCorrelation(scope, "action-compilation", owner, identity, lineage),
    payload: fullRuntimePayload(observer, audit),
  });
}

export function actionCompilationContext(
  state: Readonly<SimulationState>,
  slots: readonly CompilationSlot[],
  scope: Pick<ModelExecutionScope, "workloadId" | "batchId">,
  batchResolver?: ReturnType<typeof actionGroundingReferenceResolver>,
) {
  const actions = slots.map((slot) => slot.payload.action);
  const slotByActionId = new Map(slots.map((entry, slot) => [entry.payload.action.id, slot]));
  const initialResolver = batchResolver ?? actionGroundingReferenceResolver(state, actions, slotByActionId);
  const shared = actionGroundingSharedContext(state, actions, initialResolver, true);
  const referenceResolver = shared.referenceResolver;
  const actionReferenceResolver = createActionCompilationReferenceResolver(shared.referenceResolver, shared.referenceResolver);
  const handleResolver = shared.referenceResolver;
  const slotContexts = slots.map((entry, slot) => {
    const slotResolver = referenceResolver.scopedToSlot(slot);
    const slotContext = actionGroundingSlotContext(
      state,
      entry.payload.action,
      entry.issues.map((issue) => issue.reason),
      slotResolver,
    );
    const temporalEvidence = extractActionTemporalEvidence(
      entry.payload.action.rawText,
      state.truth.mechanics.temporalProfiles,
    );
    return {
      slot,
      assignment: {
        targetHandles: [],
        allowedProposalKinds: [],
      },
      constraints: entry.issues.map((issue) => issue.reason),
      repair: entry.issues.length > 0
        ? {
            fingerprint: semanticRepairFingerprint(entry.issues, MODEL_CONTEXT_CONTRACT_VERSION),
            previousOutput: structuredClone(entry.payload.previousOutput ?? null),
            issues: structuredClone(entry.issues),
          }
        : null,
      state: {
        action: {
          rawText: entry.payload.action.rawText,
          goal: entry.payload.action.goal,
          means: entry.payload.action.means,
        },
        actionReferences: actionReferenceStatus(actionReferenceResolver.scopedToSlot(slot), handleResolver.scopedToSlot(slot), state, entry.payload.action),
        actorPerspective: slotContext.actorPerspective,
        existingActivities: existingActivities(state, entry.payload.action, slotResolver),
        temporalEvidence,
        temporalProfileEligibility: eligibleTemporalProfiles(
          state.truth.mechanics.temporalProfiles,
          temporalEvidence,
        ).map(({ profile, eligibility }) => ({
            profileRef: slotResolver.handleFor("temporal_profile", profile.id),
            ...eligibility,
          }))
          .sort((left, right) => left.profileRef.localeCompare(right.profileRef)),
      },
    };
  });
  return projectActionCompilationContextForModel({
    contractVersion: shared.contractVersion,
    roleContract: modelRoleContract("action-compilation"),
    execution: { worldId: state.worldId, instanceId: scope.workloadId, advanceId: scope.batchId, revision: state.revision, step: state.step },
    task: {
      assignment: { targetHandles: [], allowedProposalKinds: [] },
      constraints: slots.flatMap((slot) => slot.issues.map((issue) => issue.reason)),
      slots: slotContexts.map(({ slot, assignment, constraints, repair }) => ({ slot, assignment, constraints, repair })),
    },
    state: {
      currentElapsedSeconds: state.truth.elapsedSeconds,
      temporalProfiles: Object.values(state.truth.mechanics.temporalProfiles)
        .map((profile) => {
          const profileWithoutId = Object.fromEntries(
            Object.entries(profile).filter(([key]) => key !== "id"),
          );
          return profile.kind === "staged"
            ? {
                ...structuredClone(profileWithoutId),
                profileRef: referenceResolver.handleFor("temporal_profile", profile.id),
                stages: profile.stages.map((stage) => Object.fromEntries(
                  Object.entries(stage).filter(([key]) => key !== "id"),
                )),
              }
            : {
                ...structuredClone(profileWithoutId),
                profileRef: referenceResolver.handleFor("temporal_profile", profile.id),
              };
        })
        .sort((left, right) => left.profileRef.localeCompare(right.profileRef)),
      temporalCalibrations: state.truth.mechanics.temporalCalibrations.map((calibration) => ({
        ...structuredClone(Object.fromEntries(
          Object.entries(calibration).filter(([key]) => key !== "id" && key !== "profileId"),
        )),
        profileRef: referenceResolver.handleFor("temporal_profile", calibration.profileId),
      })),
      slots: slotContexts.map(({ slot, state: slotState }) => ({ slot, ...slotState })),
    },
    referenceCatalog: handleResolver.catalog,
    repair: slots.some((slot) => slot.issues.length > 0)
      ? {
          target: null,
          issues: slots.flatMap((slot, index) => slot.issues.map((issue) => ({
            ...structuredClone(issue),
            path: ["slots", index, ...issue.path],
          }))),
        }
      : null,
  });
}

function jsonUtf8Bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function emitActionCompilationContextProjection(
  scope: ModelExecutionScope,
  owner: string,
  identity: ReturnType<typeof modelInvocationIdentity>,
  context: ReturnType<typeof actionCompilationContext>,
  lineage?: EagerSlotAttemptLineage,
): void {
  const candidates = context.referenceCatalog.candidates;
  const metrics = actionCompilationContextProjectionMetrics(context);
  const repair = context.task.slots.some((slot) => Array.isArray(slot.issues) && slot.issues.length > 0);
  scope.observer?.emit({
    event: "algorithm.eager_reference.action_compilation_context_projected",
    correlation: modelInvocationCorrelation(scope, "action-compilation", owner, identity, lineage),
    attributes: {
      phase: "action-compilation",
      projection: ACTION_COMPILATION_PROJECTION,
      repair,
    },
    counts: {
      slots: metrics.slots,
      candidateKeys: new Set(candidates.map((candidate) => candidate.candidateKey)).size,
      serializedCandidates: candidates.length,
      detailedCandidates: metrics.detailedCandidates,
      duplicateSemanticDefinitionCount: metrics.duplicateSemanticDefinitionCount,
      repairIssues: context.task.slots.reduce((sum, slot) => sum + (Array.isArray(slot.issues) ? slot.issues.length : 0), 0),
      contextUtf8Bytes: metrics.bytes,
      referenceCatalogUtf8Bytes: jsonUtf8Bytes(context.referenceCatalog),
      canonicalTruthUtf8Bytes: 0,
      taskUtf8Bytes: jsonUtf8Bytes(context.task),
      canonicalRefSerializedCount: metrics.canonicalRefSerializedCount,
      rawPrivateReferenceSerializedCount: metrics.rawPrivateReferenceSerializedCount,
    },
  });
}

function assertSlotCoverage(
  slots: readonly CompilationSlot[],
  drafts: readonly (ActionCompilationModelOutput & { slot: number })[],
): void {
  if (drafts.length !== slots.length) {
    throw new Error(`action compilation returned ${drafts.length} items for ${slots.length} slots`);
  }
  const indexes = drafts.map((draft) => draft.slot).sort((left, right) => left - right);
  if (indexes.some((slot, index) => slot !== index)) {
    throw new Error("action compilation did not cover every slot exactly once");
  }
}

function errorChainText(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let cursor = error;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    messages.push(cursor instanceof Error ? cursor.message : String(cursor));
    cursor = cursor instanceof Error ? cursor.cause : undefined;
  }
  return messages.join("\n");
}

function sourceDescriptionMismatch(error: unknown): SourceActionDescriptionMismatch | undefined {
  let cause = error;
  const seen = new Set<Error>();
  while (cause instanceof Error) {
    if (cause instanceof SourceActionDescriptionMismatch) return cause;
    if (seen.has(cause)) break;
    seen.add(cause);
    cause = cause.cause;
  }
  return undefined;
}

function actionCompilationRepairIssues(error: unknown): ModelRepairIssue[] {
  const message = errorChainText(error);
  const mismatch = sourceDescriptionMismatch(error);
  if (mismatch) return [compilationIssue({
      code: "action_compilation.source_description_mismatch", class: "semantic",
      path: ["temporalPlan", "description"], reason: mismatch.message,
    })];
  if (message.includes("sharedResourceClaims") && (message.includes("poolId") || message.includes("resourcePoolRef") || message.includes("resourcePoolCandidateKey"))) {
    return [
      compilationIssue({
        code: "reference.shared_resource_pool_required",
        class: "reference",
        path: ["interactionDependency", "sharedResourceClaims"],
        reason: "resourcePoolCandidateKey must be copied from a shared-resource-pool candidate; use [] when no listed pool is justified.",
      }),
    ];
  }
  if (message.includes("action compilation returned") ||
    message.includes("action compilation did not cover")) {
    return [compilationIssue({
      code: "structure.slot_coverage",
      class: "structure",
      path: ["slots"],
      reason: "Return exactly one result for every current slot, numbered contiguously from zero without duplicates.",
    })];
  }
  if (error instanceof EagerSlotAttemptError && error.cause instanceof ModelOutputError) {
    return [compilationIssue({
      code: "structure.batch_schema",
      class: "structure",
      reason: "The previous output failed the structured schema; return the complete current slot batch in schema form.",
    })];
  }
  return [compilationIssue({ code: "action_compilation.invalid_batch", reason: message })];
}

function actionCompilationSlotIssues(error: unknown, actionResolver?: ActionCompilationReferenceResolver,
  selectedKeys?: readonly string[]): ModelRepairIssue[] {
  const selected = selectedKeys ? new Set(selectedKeys) : undefined;
  const selectable = (key: string) => !selected || selected.has(key);
  if (error instanceof ActionCompilationValidationError) {
    return error.issues.map((issue) => {
      const next = structuredClone(issue);
      if (actionResolver) {
        next.allowedHandles = next.allowedHandles.flatMap((handle) => {
          if (handle.startsWith("candidate_")) return [handle];
          try { return [actionResolver.candidateKeyForHandle(handle as never)]; } catch { return []; }
        });
        if (typeof next.originalValue === "string" && next.originalValue.startsWith("ref:")) {
          try { next.originalValue = actionResolver.candidateKeyForHandle(next.originalValue as never); } catch { /* keep diagnostic value */ }
        }
      }
      next.allowedHandles = next.allowedHandles.filter(selectable);
      return next;
    });
  }
  if (error instanceof ModelReferenceError) {
    const errorPath = (error as ModelReferenceError & { path?: unknown }).path;
    const path = Array.isArray(errorPath)
      ? errorPath.filter((segment): segment is string | number => typeof segment === "string" || typeof segment === "number")
      : [];
    const issue = modelRepairIssueFromReferenceError(error, path);
    if (!actionResolver) return [issue];
    return [{
      ...issue,
      allowedHandles: issue.allowedHandles.flatMap((handle) => handle.startsWith("candidate_")
        ? [handle]
        : (() => { try { return [actionResolver.candidateKeyForHandle(handle as never)]; } catch { return []; } })()).filter(selectable),
    }];
  }
  if (error instanceof z.ZodError) {
    const poolIssue = error.issues.find((issue) =>
      issue.path.includes("sharedResourceClaims") && (issue.path.includes("poolId") || issue.path.includes("resourcePoolRef") || issue.path.includes("resourcePoolCandidateKey")));
    if (poolIssue) {
      return [
        compilationIssue({
          code: "reference.shared_resource_pool_required",
          class: "reference",
          path: modelIssuePath(poolIssue.path),
          originalValue: poolIssue.input,
          reason: "resourcePoolCandidateKey must be copied from a shared-resource-pool candidate; use [] when no listed pool is justified.",
        }),
      ];
    }
    return error.issues.map((issue) => compilationIssue({
      code: `structure.${issue.code}`,
      class: "structure",
      path: modelIssuePath(issue.path),
      originalValue: issue.input,
      reason: issue.message,
    }));
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message === "explicit duration is not grounded in the action text") {
    return [
      compilationIssue({
        code: "temporal.duration_evidence_missing",
        class: "mechanic",
        path: ["temporalPlan", "basis"],
        reason: "The action has no exact duration-and-unit span. Select an eligible non-rate profile with profile basis; do not estimate or rewrite evidence.",
      }),
    ];
  }
  if (message === "explicit progress quantity is not grounded in the action text") {
    return [
      compilationIssue({
        code: "temporal.progress_evidence_missing",
        class: "mechanic",
        path: ["temporalPlan", "basis"],
        reason: "The action has no exact progress quantity compatible with the rate profile. Select an eligible non-rate profile; counts are not distance.",
      }),
    ];
  }
  if (message.includes("requires explicit quantity")) {
    return [
      compilationIssue({
        code: "temporal.profile_ineligible",
        class: "mechanic",
        path: ["temporalPlan", "profileRef"],
        reason: "A rate profile requires an exact compatible quantity in action.rawText. Select an eligible non-rate profile when the evidence is absent.",
      }),
    ];
  }
  if (message.includes("requires a continuation assertion")) {
    return [
      compilationIssue({
        code: "temporal.continuation_condition_missing",
        class: "mechanic",
        path: ["temporalPlan", "continuationAssertions"],
        originalValue: [],
        reason: "The selected conditional temporal profile requires at least one continuation assertion grounded in exact catalog candidate keys. Preserve the selected profile and describe the still-pending world condition; do not return an empty array or invent a reference.",
      }),
    ];
  }
  return [compilationIssue({ code: "action_compilation.invalid_slot", reason: message })];
}

function localizedSchemaFailure(
  error: unknown,
  batch: readonly CompilationSlot[],
  state: Readonly<SimulationState>,
  resolver: ActionCompilationReferenceResolver,
  selectedKeysBySlot?: ReadonlyMap<number, readonly string[]>,
): (EagerSlotAttemptResult<CompiledAction, CompilationPayload, ModelRepairIssue> & {
  contextualCauseRemovals: number;
  normalizedSlots: Array<{ slot: number; result: unknown }>;
}) | null {
  if (!(error instanceof ModelOutputError) || !error.audit || !error.rawValue || typeof error.rawValue !== "object" ||
    !Array.isArray((error.rawValue as { slots?: unknown }).slots)) return null;
  const rawSlots = (error.rawValue as { slots: unknown[] }).slots;
  const accepted: Array<{ key: string; result: CompiledAction }> = [];
  const rejected: Array<{ slot: CompilationSlot; issues: ModelRepairIssue[] }> = [];
  const normalizedSlots: Array<{ slot: number; result: unknown }> = [];
  let contextualCauseRemovals = 0;
  const rawByIndex = new Map<number, unknown>();
  const duplicateIndexes = new Set<number>();
  rawSlots.forEach((raw, position) => {
    const candidateIndex = raw && typeof raw === "object" && typeof (raw as { slot?: unknown }).slot === "number"
      ? (raw as { slot: number }).slot
      : position;
    if (rawByIndex.has(candidateIndex)) duplicateIndexes.add(candidateIndex);
    rawByIndex.set(candidateIndex, raw);
  });
  const expectedIndexes = new Set(batch.map((_, index) => index));
  if ([...rawByIndex.keys()].some((index) => !expectedIndexes.has(index))) return null;
  if (sourceDescriptionMismatch(error)) {
    // Source-owned text contradictions reject the whole attempt, including
    // schema-valid neighbors. Preserve each candidate without accepting it.
    return { audit: error.audit, accepted: [], contextualCauseRemovals: 0, normalizedSlots: [],
      rejected: batch.map((slot, index) => ({
        slot: { ...slot, payload: { ...slot.payload, previousOutput: structuredClone(rawByIndex.get(index) ?? null) } },
        issues: actionCompilationRepairIssues(error),
      })),
    };
  }
  for (const [index, slot] of batch.entries()) {
    const raw = rawByIndex.get(index);
    if (raw === undefined || duplicateIndexes.has(index)) {
      rejected.push({
        slot: { ...slot, payload: { ...slot.payload, previousOutput: structuredClone(raw ?? null) } },
        issues: [compilationIssue({
          code: raw === undefined ? "structure.slot_missing" : "structure.slot_duplicated",
          class: "structure",
          path: ["slot"],
          originalValue: raw ?? null,
          reason: `Slot ${index} ${raw === undefined ? "is missing" : "is duplicated"}.`,
        })],
      });
      continue;
    }
    const normalized = normalizeActionCompilationContextCauses({
      value: raw,
      expectedActionRef: resolver.scopedToSlot(index).candidateKeyForHandle(
        actionGroundingReferenceResolver(state, slot.payload.action, new Map([[slot.payload.action.id, index]])).handleFor("action", slot.payload.action.id),
      ),
    });
    contextualCauseRemovals += normalized.removedCount;
    const parsed = actionCompilationSlotSchema.safeParse(normalized.value);
    if (!parsed.success) {
      rejected.push({
        slot: { ...slot, payload: { ...slot.payload, previousOutput: structuredClone(raw) } },
        issues: actionCompilationSlotIssues(parsed.error),
      });
      continue;
    }
    normalizedSlots.push({ slot: parsed.data.slot, result: parsed.data });
    try {
      const allowed = selectedKeysBySlot?.get(index);
      if (allowed) validateActionCompilationShortlistMembership({ value: parsed.data, slot: index, allowedCandidateKeys: allowed });
      const slotResolver = resolver.scopedToSlot(index);
      const references = collectActionCompilationSelections(parsed.data, slotResolver);
      if (references.issues.length) throw new ActionCompilationValidationError(references.issues);
      const materialized = materializeActionCompilationCandidateKeys({ value: parsed.data, resolver: slotResolver });
      accepted.push({
        key: slot.key,
        result: materializeCompilation(
          state,
          slot.payload.action,
          materialized.draft,
          actionGroundingReferenceResolver(state, batch.map((entry) => entry.payload.action), new Map(batch.map((entry, slotIndex) => [entry.payload.action.id, slotIndex]))).scopedToSlot(index),
        ),
      });
    } catch (materializationError) {
      rejected.push({
        slot: { ...slot, payload: { ...slot.payload, previousOutput: structuredClone(parsed.data) } },
        issues: actionCompilationSlotIssues(materializationError, resolver.scopedToSlot(index), selectedKeysBySlot?.get(index)),
      });
    }
  }
  return { audit: error.audit!, accepted, rejected, contextualCauseRemovals, normalizedSlots };
}

function actionCompilationAuditIssues(
  rejected: readonly { slot: CompilationSlot; issues: readonly ModelRepairIssue[] }[],
  batch: readonly CompilationSlot[],
): ModelOutputIssue[] {
  return rejected.flatMap(({ slot, issues }) => issues.map((issue) => ({
    code: issue.code,
    class: issue.class,
    path: ["slots", batch.findIndex((entry) => entry.key === slot.key), ...issue.path],
    message: issue.reason,
    originalValue: structuredClone(issue.originalValue),
    allowedHandles: [...issue.allowedHandles],
    targetIds: [slot.key],
  })));
}

function materializeCompilation(
  state: Readonly<SimulationState>,
  action: AgentActionProposal,
  draft: ActionCompilationDraft,
  resolver = actionGroundingReferenceResolver(state, action),
): CompiledAction {
  const normalized = normalizeActionCompilationDraftReferences({ draft, resolver, state });
  const normalizedDraft = normalized.draft;
  if (isProposalReference(normalizedDraft.temporalPlan.profileRef)) {
    throw new Error(`temporal plan profile cannot use proposalKey ${normalizedDraft.temporalPlan.profileRef.proposalKey}`);
  }
  const temporalEvidence = extractActionTemporalEvidence(action.rawText, state.truth.mechanics.temporalProfiles);
  const profileEligibility = eligibleTemporalProfiles(state.truth.mechanics.temporalProfiles, temporalEvidence);
  const fieldIssues = validateActionCompilationDraft({
    draft: normalizedDraft,
    resolver,
    eligibleProfileHandles: new Set(profileEligibility
      .filter((entry) => entry.eligibility.eligible)
      .map((entry) => resolver.handleFor("temporal_profile", entry.profile.id))),
    ineligibleProfileReasons: new Map(profileEligibility
      .filter((entry) => !entry.eligibility.eligible && entry.eligibility.rejectionCode !== null)
      .map((entry) => [
        resolver.handleFor("temporal_profile", entry.profile.id),
        entry.eligibility.rejectionCode!,
      ])),
    conditionalProfileHandles: new Set(Object.values(state.truth.mechanics.temporalProfiles)
      .filter((entry) => entry.kind === "conditional")
      .map((entry) => resolver.handleFor("temporal_profile", entry.id))),
    requiredActionHandle: resolver.handleFor("action", action.id),
  });
  if (fieldIssues.length > 0) throw new ActionCompilationValidationError(fieldIssues);
  const profileId = resolver.resolve(normalizedDraft.temporalPlan.profileRef, "profile").engineId;
  const profile = state.truth.mechanics.temporalProfiles[profileId];
  if (!profile) throw new Error(`unknown temporal profile ${profileId}`);
  const resolveCause = (cause: ActionCompilationDraft["temporalPlan"]["causes"][number]) => {
    if (isProposalReference(cause.ref)) throw new Error(`temporal plan cause cannot use proposalKey ${cause.ref.proposalKey}`);
    return { kind: cause.kind, id: resolver.resolve(cause.ref, "cause").engineId } as const;
  };
  const resolveAssertion = (assertion: ModelCausalAssertion): CausalAssertion => {
    const resolve = (reference: ModelReference, use: ModelReferenceUse) => {
      if (isProposalReference(reference)) throw new Error(`temporal continuation assertion cannot use proposalKey ${reference.proposalKey}`);
      return resolver.resolve(reference, use).engineId;
    };
    switch (assertion.kind) {
      case "check_result": return { kind: assertion.kind, checkId: resolve(assertion.checkRef, "assertion"), expected: assertion.expected };
      case "random_result": return { kind: assertion.kind, requestId: resolve(assertion.requestRef, "assertion"), stepId: resolve(assertion.stepRef, "assertion"), expected: structuredClone(assertion.expected) as DiscreteRandomAggregate };
      case "fact_matches": return {
        kind: assertion.kind,
        factId: resolve(assertion.factRef, "assertion"),
        expected: assertion.expected.kind === "entity"
          ? { kind: "entity", entityId: resolve(assertion.expected.entityRef, "assertion") }
          : structuredClone(assertion.expected),
      };
      case "fact_absent": return { kind: assertion.kind, factId: resolve(assertion.factRef, "assertion") };
      case "entity_absent": return { kind: assertion.kind, entityId: resolve(assertion.entityRef, "assertion") };
      case "entity_lifecycle": return { kind: assertion.kind, entityId: resolve(assertion.entityRef, "assertion"), expected: assertion.expected };
      case "placement_equals": return { kind: assertion.kind, entityId: resolve(assertion.entityRef, "assertion"), placementId: assertion.placementRef === null ? null : resolve(assertion.placementRef, "assertion") };
      case "placement_not_equals": return { kind: assertion.kind, entityId: resolve(assertion.entityRef, "assertion"), placementId: assertion.placementRef === null ? null : resolve(assertion.placementRef, "assertion") };
      case "shared_placement": return { kind: assertion.kind, leftEntityId: resolve(assertion.leftEntityRef, "assertion"), rightEntityId: resolve(assertion.rightEntityRef, "assertion") };
      case "meter_compare": return { kind: assertion.kind, meterId: resolve(assertion.meterRef, "assertion"), operator: assertion.operator, value: assertion.value };
      case "quantity_compare": {
        const quantityId = resolve(assertion.quantityRef, "assertion");
        const quantity = state.truth.quantities[quantityId];
        if (!quantity) throw new Error(`quantity assertion references unknown quantity ${quantityId}`);
        return { kind: assertion.kind, definitionId: quantity.definitionId, holderId: quantity.holderId, operator: assertion.operator, value: assertion.value };
      }
      case "rating_compare": return { kind: assertion.kind, ratingId: resolve(assertion.ratingRef, "assertion"), operator: assertion.operator, value: assertion.value };
      case "shared_resource_capacity_compare": return { kind: assertion.kind, poolId: resolve(assertion.poolRef, "assertion"), operator: assertion.operator, value: assertion.value };
      case "elapsed_seconds_compare": return { kind: assertion.kind, operator: assertion.operator, value: assertion.value };
    }
    throw new Error(`unsupported continuation assertion ${String((assertion as { kind?: unknown }).kind)}`);
  };
  const resolvedContinuationAssertions = normalizedDraft.temporalPlan.continuationAssertions.map(resolveAssertion);
  const onsetIssues = resolvedContinuationAssertions.flatMap((assertion, index) => {
    const evaluation = evaluateCausalAssertion(state, assertion);
    if (evaluation.passed) return [];
    return [compilationIssue({
      code: "temporal.continuation_assertion_false",
      class: "mechanic",
      path: ["temporalPlan", "continuationAssertions", index],
      originalValue: normalizedDraft.temporalPlan.continuationAssertions[index],
      reason: `Continuation assertions are onset invariants and must already be true when the activity starts; observed ${JSON.stringify(evaluation.observed)} for ${assertion.kind}. Choose a condition that is true now and remains true until the trusted boundary.`,
    })];
  });
  if (onsetIssues.length > 0) throw new ActionCompilationValidationError(onsetIssues);
  const plan = materializeTemporalPlan({
    id: runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "temporal-plan",
      stage: "action-plan",
      owner: action.id,
      round: 0,
      ordinal: 0,
    }),
    actionId: action.id,
    actorId: action.actorId,
    rawText: action.rawText,
    startsAtSeconds: state.truth.elapsedSeconds,
    draft: {
      ...structuredClone(normalizedDraft.temporalPlan),
      profileId,
      basis: materializeModelTemporalBasis(profile, normalizedDraft.temporalPlan.basis, temporalEvidence),
      causes: normalizedDraft.temporalPlan.causes.map(resolveCause),
      continuationAssertions: resolvedContinuationAssertions,
    },
    profiles: state.truth.mechanics.temporalProfiles,
  });
  return {
    plan,
    activity: createActivity({
      id: runtimeId({
        worldHash: state.worldHash,
        revision: state.revision,
        kind: "activity",
        stage: "action-plan",
        owner: action.id,
        round: 0,
        ordinal: 0,
      }),
      plan,
      sourceAction: action,
    }),
    dependency: materializeModelInteractionDependency(
      state,
      action,
      normalizedDraft.interactionDependency,
      resolver,
    ),
  };
}

function emitSemanticRejection(
  scope: ModelExecutionScope,
  owner: string,
  identity: ReturnType<typeof modelInvocationIdentity>,
  message: string,
  slots: number,
  lineage?: EagerSlotAttemptLineage,
): void {
  scope.observer?.emit({
    event: "model.semantic.rejected",
    level: "warn",
    correlation: modelInvocationCorrelation(scope, "action-compilation", owner, identity, lineage),
    attributes: { resultKind: "action_compilation_batch" },
    counts: { validationIssues: slots },
    error: { name: "ActionCompilationError", message },
  });
}

export async function compileActions(
  provider: StructuredModelProvider,
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  scope: ModelExecutionScope,
  profileId: string,
  maxSlots: number,
  recovery: Readonly<OutputRecoveryCapability> = DEFAULT_EAGER_OUTPUT_RECOVERY,
  symbolRepairPolicy?: Readonly<import("../../contracts/symbol-repair").SymbolRepairPolicy>,
): Promise<ActionCompilationResult> {
  if (actions.length === 0) {
    return {
      compilations: [],
      modelAudits: [],
      batchCount: 0,
      metrics: { submittedSlots: 0, repairCalls: 0, repeatedFingerprints: 0, splitCount: 0, partialFailureSlots: 0, singletonFailures: 0 },
    };
  }
  const slots: CompilationSlot[] = [...actions]
    .sort((left, right) => left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id))
    .map((action) => ({ key: action.id, payload: { action }, issues: [] }));
  const maxInputBytes = provider.catalog.profile(profileId).max_input_bytes;
  const rootSelections = new Map<string, PinnedActionCompilationSelection>();
  const sourceStateHash = contentHash(state);
  const result = await runEagerSlotBatches({
    slots,
    maxSlots,
    maxInputBytes,
    requestBytes: (batch) => eagerRequestBytes(
      ACTION_COMPILER_PROMPT.system,
      ACTION_COMPILER_PROMPT.userPrompt,
      actionCompilationContext(state, batch, scope),
      actionCompilationBatchSchema,
    ),
    label: "action compilation",
    issuesForError: actionCompilationRepairIssues,
    issueFingerprint: (issue) => semanticRepairFingerprint([issue], MODEL_CONTEXT_CONTRACT_VERSION),
    recovery,
    invoke: async (batch, attempt, lineage: EagerSlotAttemptLineage) => {
      const owner = eagerSlotBatchOwner("action-compilation", batch);
      const identity = modelInvocationIdentity(scope, "action-compilation", owner, attempt + 1);
      const correlation = modelInvocationCorrelation(scope, "action-compilation", owner, identity, lineage);
      const slotByActionId = new Map(batch.map((entry, slot) => [entry.payload.action.id, slot]));
      const baseResolver = actionGroundingReferenceResolver(
        state,
        batch.map((entry) => entry.payload.action),
        slotByActionId,
      );
      const fullBatchResolver = actionGroundingSharedContext(
        state,
        batch.map((entry) => entry.payload.action),
        baseResolver,
        true,
      ).referenceResolver;
      const batchResolver = fullBatchResolver;
      const batchActionResolver = createActionCompilationReferenceResolver(batchResolver, fullBatchResolver);
      const fullBatchActionResolver = createActionCompilationReferenceResolver(fullBatchResolver, fullBatchResolver);
      const projected = actionCompilationContext(state, batch, scope, fullBatchResolver);
      const pinnedSelection = rootSelections.get(lineage.logicalInvocationId);
      if (pinnedSelection && contentHash(state) !== sourceStateHash) throw new Error("action compilation repair changed its source state snapshot");
      const context = (pinnedSelection?.project(projected) ?? projected) as typeof projected;
      emitActionCompilationContextProjection(scope, owner, identity, context, lineage);
      const retrieval = scope.actionCompilationRetrieval
        ? await (async () => {
            try {
              if (pinnedSelection) return pinnedSelection.reuse(context);
              if (lineage.semanticRepairAttempt > 0) throw new Error("action compilation repair lost its root candidate selection");
              const selected = await scope.actionCompilationRetrieval!.retrieveBatch({
                worldContentHash: state.worldHash,
                fullContext: context,
                slotIndices: batch.map((_, slot) => slot),
                signal: scope.abortSignal,
              });
              rootSelections.set(lineage.logicalInvocationId, new PinnedActionCompilationSelection(context, selected));
              return selected;
            } catch (error) {
              scope.observer?.emit({
                event: "model.action_compilation.retrieval_failed",
                correlation,
                level: "error",
                attributes: {
                  runtimeVersion: scope.actionCompilationRetrieval!.version,
                  reason: error instanceof Error ? error.message : String(error),
                },
              });
              throw error;
            }
          })()
        : undefined;
      emitActionCompilationReferenceAudit(
        scope,
        owner,
        identity,
        actionCompilationReferenceAudit({
          state,
          batch,
          context,
          actionResolver: fullBatchActionResolver,
          handleResolver: fullBatchResolver,
        }),
        lineage,
      );
      let contextCaptured = false;
      const captureContext = (audit: ModelExecutionAudit) => {
        if (scope.observer && !contextCaptured) {
          contextCaptured = true;
          const fullContextHash = retrieval?.fullContextHash ?? contentHash(context);
          scope.observer.emit({
            event: "model.action_compilation.context.captured",
            correlation,
            attributes: { middlewareVersion: scope.actionCompilationRetrieval?.version ?? "fullcatalog-control", role: "action-compilation" },
            counts: {
              slots: batch.length,
              selectedCandidates: retrieval?.diagnostics.selectedCount ?? context.referenceCatalog.candidates.length,
              visibleCandidates: retrieval?.diagnostics.visibleCount ?? context.referenceCatalog.candidates.length,
              prunedReferences: retrieval?.diagnostics.prunedReferenceCount ?? 0,
              anchors: retrieval?.diagnostics.anchorCount ?? 0,
              batchBudget: retrieval?.diagnostics.batchBudget ?? context.referenceCatalog.candidates.length,
              passageCacheHits: retrieval?.diagnostics.cache.passageHits ?? 0,
              passageCacheMisses: retrieval?.diagnostics.cache.passageMisses ?? 0,
              queryCacheHits: retrieval?.diagnostics.cache.queryHits ?? 0,
              queryCacheMisses: retrieval?.diagnostics.cache.queryMisses ?? 0,
              queryBatchSize: retrieval?.diagnostics.cache.queryBatchSize ?? 0,
            },
            measurements: {
              batchShortlistRatio: retrieval?.diagnostics.batchShortlistRatio ?? 1,
              cacheReadMs: retrieval?.diagnostics.cache.readMs ?? 0,
              passageEncodeMs: retrieval?.diagnostics.cache.passageEncodeMs ?? 0,
              queryEncodeMs: retrieval?.diagnostics.cache.queryEncodeMs ?? 0,
            },
            hashes: {
              fullContext: fullContextHash,
              ...(retrieval ? { modelContext: retrieval.modelContextHash, shortlist: retrieval.shortlistHash } : {}),
            },
            payload: fullRuntimePayload(scope.observer, {
              schemaVersion: 2,
              sourceExecutionId: scope.correlation?.executionId,
              sourceInvocationId: identity.modelInvocationId,
              logicalInvocationId: correlation.logicalInvocationId,
              role: "action-compilation",
              slotIndices: batch.map((_, slot) => slot),
              fullContext: context,
              stateSnapshot: state,
              actions: batch.map((entry) => structuredClone(entry.payload.action)),
              actionIds: batch.map((entry) => entry.payload.action.id),
              captureAlgorithmRef: scope.executionAlgorithmRef,
              captureAlgorithmManifestHash: scope.executionAlgorithmRef?.manifestHash,
              ...(retrieval ? {
                selectedKeysBySlot: [...retrieval.selectedKeysBySlot.entries()],
                perSlotSelectedCount: retrieval.diagnostics.perSlotSelectedCount,
                batchBudget: retrieval.diagnostics.batchBudget,
                nominalBatchBudget: retrieval.diagnostics.nominalBatchBudget,
                mandatoryBudgetFloorApplied: retrieval.diagnostics.mandatoryBudgetFloorApplied,
                batchShortlistRatio: retrieval.diagnostics.batchShortlistRatio,
                cache: retrieval.diagnostics.cache,
                ...(retrieval.diagnostics.rootSelection ? { rootSelection: retrieval.diagnostics.rootSelection } : {}),
              } : {}),
              fullContextHash,
              ...(retrieval ? { modelContextHash: retrieval.modelContextHash, shortlistHash: retrieval.shortlistHash } : {}),
              worldHash: scope.runtimeIdentity?.worldHash,
              stateHash: contentHash(state),
              candidateCatalogHash: typeof context.referenceCatalog?.hash === "string" ? context.referenceCatalog.hash : undefined,
              modelCatalogHash: audit.modelCatalogHash,
              registrySnapshotHash: audit.registrySnapshotHash,
              modelId: audit.modelId,
              promptVersion: audit.promptVersion,
              profileId: audit.profileId,
              projectorVersion: ACTION_COMPILATION_PROJECTION,
              candidateKeyVersion: ACTION_COMPILATION_CANDIDATE_KEY_VERSION,
              candidateKeyPayloadLength: ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH,
              symbolRepairPolicyVersion: symbolRepairPolicy?.version ?? DEFAULT_SYMBOL_REPAIR_POLICY.version,
            }),
          });
        }
      };
      let generated;
      try {
        generated = await provider.generateStructured({
          profileId,
          workloadId: scope.workloadId,
          batchId: scope.batchId,
          abortSignal: scope.abortSignal,
          correlation,
          observer: scope.observer,
          ...identity,
          role: "action-compilation",
          subjectId: owner,
          promptVersion: ACTION_COMPILER_PROMPT.version,
          schemaName: "action_compilation_batch",
          system: ACTION_COMPILER_PROMPT.system,
          userPrompt: ACTION_COMPILER_PROMPT.userPrompt,
          context: retrieval?.modelContext ?? context,
          schema: actionCompilationRequestSchema(batch.length, Object.keys(state.truth.sharedActivityResourcePools).length > 0),
          preprocessOutput: (raw) => preprocessActionCompilationSymbols({
            value: raw,
            resolver: batchActionResolver,
            ...(symbolRepairPolicy ? { policy: symbolRepairPolicy } : {}),
            ...(retrieval ? { allowedCandidateKeysBySlot: retrieval.selectedKeysBySlot } : {}),
          }),
        });
        captureContext(generated.audit);
        if (retrieval && scope.observer) {
          const outOfShortlistBySlot = generated.value.slots.flatMap((slot) => {
            const selected = new Set(retrieval.selectedKeysBySlot.get(slot.slot) ?? []);
            const keys = [...candidateKeysInValue(slot)].filter((key) => !selected.has(key)).sort();
            return keys.length > 0 ? [{ slot: slot.slot, keys }] : [];
          });
          if (outOfShortlistBySlot.length > 0) {
            scope.observer.emit({
              event: "model.action_compilation.out_of_shortlist",
              correlation,
              level: "warn",
              counts: { references: outOfShortlistBySlot.reduce((count, item) => count + item.keys.length, 0) },
              payload: fullRuntimePayload(scope.observer, { outOfShortlistBySlot }),
            });
          }
        }
        assertSlotCoverage(batch, generated.value.slots);
      } catch (error) {
        if (error instanceof ModelOutputError && error.audit) captureContext(error.audit);
        if (isTerminalEagerModelError(error)) throw error;
        const localized = localizedSchemaFailure(error, batch, state, batchActionResolver, retrieval?.selectedKeysBySlot);
        if (localized) {
          const invocationAudit = localized.audit.invocations.at(-1);
          if (invocationAudit && localized.contextualCauseRemovals > 0) {
            invocationAudit.normalization = {
              ...invocationAudit.normalization,
              applied: true,
              modifiedFieldCount: invocationAudit.normalization.modifiedFieldCount +
                localized.contextualCauseRemovals,
            };
            invocationAudit.normalizedOutputHash = contentHash({ slots: localized.normalizedSlots });
            invocationAudit.outputDisposition = "auto-normalized";
            scope.observer?.emit({
              event: "model.output.normalized",
              correlation,
              attributes: { applied: true, rule: "drop_context_only_causes" },
              counts: {
                modifiedFields: localized.contextualCauseRemovals,
                resolvedReferences: 0,
                proposals: 0,
                deduplicated: 0,
                contextualCausesRemoved: localized.contextualCauseRemovals,
              },
              hashes: {
                ...(invocationAudit.rawOutputHash ? { rawOutput: invocationAudit.rawOutputHash } : {}),
                normalizedOutput: invocationAudit.normalizedOutputHash,
              },
            });
          }
          setModelInvocationResultKind(localized.audit, "action_compilation_batch");
          if (localized.rejected.length === 0) {
            setModelInvocationOutcome(localized.audit, attempt > 0 ? "llm-repaired" : "accepted");
          }
          else setModelInvocationOutcome(
            localized.audit,
            "rejected",
            actionCompilationAuditIssues(localized.rejected, batch),
          );
          emitSemanticRejection(
            scope,
            owner,
            identity,
            `action compilation localized ${localized.rejected.length} slot failure(s)`,
            localized.rejected.length,
            lineage,
          );
          scope.observer?.emit({
            event: "model.action_compilation.slots.validated", correlation,
            counts: { accepted: localized.accepted.length, rejected: localized.rejected.length },
            payload: fullRuntimePayload(scope.observer, {
              accepted: localized.accepted,
              rejected: localized.rejected.map(({ slot, issues }) => ({ actionId: slot.key, issues })),
            }),
          });
          return localized;
        }
        const audit = error && typeof error === "object" && "audit" in error
          ? (error as { audit?: ModelExecutionAudit }).audit
          : generated?.audit;
        if (audit?.invocations.length) {
          setModelInvocationOutcome(audit, "rejected", ["invalid_action_compilation_batch"]);
        }
        emitSemanticRejection(
          scope,
          owner,
          identity,
          error instanceof Error ? error.message : String(error),
          batch.length,
          lineage,
        );
        throw new EagerSlotAttemptError(
          error instanceof Error ? error.message : String(error),
          audit,
          { cause: error },
        );
      }

      const accepted: Array<{ key: string; result: CompiledAction }> = [];
      const rejected: Array<{ slot: CompilationSlot; issues: ModelRepairIssue[] }> = [];
      const normalizedSlots: Array<{ slot: number; result: unknown }> = [];
      const selectionsBySlot = new Map<number, readonly ActionCompilationSelection[]>();
      let modifiedFieldCount = 0;
      let resolvedReferenceCount = 0;
      let proposalCount = 0;
      let deduplicatedCount = 0;
      const ordered = [...generated.value.slots].sort((left, right) => left.slot - right.slot);
      for (const [index, draft] of ordered.entries()) {
        const slot = batch[index]!;
        try {
          // The physical batch has one catalog. Resolution is scoped to the
          // output slot so a private candidate from another slot is rejected
          // before domain materialization.
          const slotResolver = batchResolver.scopedToSlot(index);
          const slotActionResolver = batchActionResolver.scopedToSlot(index);
          const allowed = retrieval?.selectedKeysBySlot.get(index);
          if (allowed) validateActionCompilationShortlistMembership({ value: draft, slot: index, allowedCandidateKeys: allowed });
          const references = collectActionCompilationSelections(draft, slotActionResolver);
          selectionsBySlot.set(index, references.selections);
          if (references.issues.length) throw new ActionCompilationValidationError(references.issues);
          const materialized = materializeActionCompilationCandidateKeys({ value: draft, resolver: slotActionResolver });
          const normalized = normalizeModelOutput(materialized.draft, { resolver: slotResolver, dedupeArrays: true });
          modifiedFieldCount += normalized.modifiedFieldCount;
          resolvedReferenceCount += materialized.resolvedCandidateCount + normalized.resolvedReferenceCount;
          proposalCount += normalized.proposalCount;
          deduplicatedCount += normalized.deduplicatedCount;
          normalizedSlots.push({ slot: draft.slot, result: normalized.value });
          accepted.push({
            key: slot.key,
            result: materializeCompilation(state, slot.payload.action, normalized.value as ActionCompilationDraft, slotResolver),
          });
        } catch (error) {
          rejected.push({
            slot: { ...slot, payload: { ...slot.payload, previousOutput: structuredClone(draft) } },
            issues: actionCompilationSlotIssues(error, batchActionResolver.scopedToSlot(index), retrieval?.selectedKeysBySlot.get(index)),
          });
        }
      }
      emitActionCompilationReferenceAudit(
        scope,
        owner,
        identity,
        actionCompilationReferenceAudit({
          state,
          batch,
          context,
          actionResolver: fullBatchActionResolver,
          handleResolver: fullBatchResolver,
          selectionsBySlot,
        }),
        lineage,
      );
      const invocationAudit = generated.audit.invocations.at(-1);
      if (invocationAudit) {
        const symbolRepairs = invocationAudit.symbolRepairs ?? [];
        const symbolRepairAcceptedCount = symbolRepairs.filter((repair) =>
          repair.status === "repaired" || repair.status === "normalized").length;
        const symbolRepairAmbiguousCount = symbolRepairs.filter((repair) => repair.status === "ambiguous").length;
        const symbolRepairUnmatchedCount = symbolRepairs.filter((repair) => repair.status === "unmatched").length;
        const symbolRepairPostValidationRejectedCount = symbolRepairs.filter((repair) =>
          repair.status === "postvalidation-rejected").length;
        invocationAudit.rawOutputHash ??= contentHash(generated.value);
        invocationAudit.normalizedOutputHash = contentHash({ slots: normalizedSlots });
        invocationAudit.normalization = {
          applied: modifiedFieldCount > 0 || deduplicatedCount > 0 || symbolRepairAcceptedCount > 0,
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
        if (rejected.length === 0) {
          invocationAudit.outputDisposition = attempt > 0
            ? "llm-repaired"
            : invocationAudit.normalization.applied ? "auto-normalized" : "accepted";
        }
        scope.observer?.emit({
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
      setModelInvocationResultKind(generated.audit, "action_compilation_batch");
      if (rejected.length === 0) {
        setModelInvocationOutcome(generated.audit, attempt > 0 ? "llm-repaired" : "accepted");
      } else {
        setModelInvocationOutcome(
          generated.audit,
          "rejected",
          actionCompilationAuditIssues(rejected, batch),
        );
        emitSemanticRejection(
          scope,
          owner,
          identity,
          `action compilation rejected ${rejected.length} slot(s)`,
          rejected.length,
          lineage,
        );
      }
      scope.observer?.emit({
        event: "model.action_compilation.slots.validated", correlation,
        counts: { accepted: accepted.length, rejected: rejected.length },
        payload: fullRuntimePayload(scope.observer, {
          accepted, rejected: rejected.map(({ slot, issues }) => ({ actionId: slot.key, issues })),
        }),
      });
      return { audit: generated.audit, accepted, rejected };
    },
  });
  if (result.failures.length > 0) {
    const failure = result.failures[0]!;
    const action = failure.slot.payload.action;
    throw new ModelSemanticRepairError(
      "action-compilation",
      `action compilation failed after repairs for ${action.actorId}: ${
        failure.error instanceof Error ? failure.error.message : String(failure.error)
      }`,
      { cause: failure.error, audit: failure.audit },
    );
  }
  return {
    compilations: actions.map((action) => {
      const compilation = result.results.get(action.id);
      if (!compilation) throw new Error(`action compilation omitted ${action.id}`);
      return compilation;
    }),
    modelAudits: result.audits,
    batchCount: result.batchCount,
    metrics: result.metrics,
  };
}
