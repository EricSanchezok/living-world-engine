import { z } from "zod";
import { bindMechanicalPlanRepairContext, MECHANICAL_PLAN_REPAIR, selectMechanicalPlanRepair } from "./mechanical-plan-repair";
import { CausalAssertionValidationError, evaluateProposalCausality } from "./causality";
import { perceptionCauseScope, perceptionDraftRelationIssues } from "../contracts/perception-references";
import {
  causalVerificationSchema,
  mechanicInvocationRepairSchema,
  perceptionDirectiveSchema,
  reactionRoutingOutputSchema,
  resolutionContinuationDirectiveSchema,
  resolutionDirectiveSchema,
  resolutionPlanCommitDirectiveSchema,
  resolutionPlanVerificationSchema,
  transitionProposalSchema,
  type DiscreteRandomRequestProposal,
  type ModelCheckRequestDraft,
  type ModelCausalAssertion,
  type ModelCausalRef,
  type ModelFactValue,
  type ModelAccess,
  type ModelCausalVerification,
  type ReactionRequestDraft,
  type ResolutionPlanDraft,
  type ModelTransitionProposalDraft,
} from "../contracts/llm-schemas";
import type {
  InteractionDependency,
} from "../runtime/execution";
import type {
  AgentActionProposal,
  CausalAssertion,
  CausalRef,
  CausalVerification,
  CommitmentRound,
  D20CheckRequest,
  D20CheckResult,
  DiscreteRandomRequest,
  DiscreteRandomResult,
  ModelExecutionAudit,
  MechanicInvocation,
  ObservationPacket,
  ObservationPacketDraft,
  ReactionDecision,
  ReactionRequest,
  SimulationState,
  TransitionProposal,
  WorldDeltaOperation,
  WorldDeltaOperationDraft,
} from "../contracts/model";
import {
  deriveCheck,
  deriveCheckNumbers,
  deriveResolutionReceipt,
  expectedActionStatus,
  validateResolutionPlan,
  type ResolutionEvidenceIndex,
  type ResolutionPlan,
  type ResolutionReceipt,
  type ResolutionSourceRef,
} from "./resolution";
import { MAX_COMMITMENT_ROUNDS_PER_STEP } from "./commitment-rounds";
import {
  combineModelExecutionAudits,
  ModelConfigurationError,
  ModelCandidateValidationError,
  modelInvocationCorrelation,
  modelInvocationLogicalId,
  modelInvocationIdentity,
  ModelOutputError,
  ModelSemanticRepairError,
  ModelTransportError,
  setModelInvocationOutcome,
  setModelInvocationResultKind,
  type ModelExecutionScope,
  type StructuredModelProvider,
} from "../models/model-provider";
import { contentHash } from "../models/model-audit";
import { ModelOverloadedError } from "../models/model-scheduler";
import { fullRuntimePayload, runtimeEventEmitter, serializeRuntimeError } from "../runtime/observability";
import { validateObservations } from "../cognition/observation";
import {
  buildCausalVerificationContext,
  causalProposalReferenceResolver,
  causalAssertionRepairIssues,
  buildResolutionPlanVerificationContext,
  createTruthReferenceResolver,
  buildTruthContext,
  validationIssues,
  type ResolutionScope,
  type PromptValidationIssue,
} from "../contracts/prompts";
import { createReferenceResolver, ModelReferenceError, normalizeModelOutput } from "../contracts/model-context";
import { promptBundle, type PromptBundleId } from "../prompts";
import { logicalRepairContext } from "../prompts/logical-repair-context";
import {
  resolveD20Checks,
  resolveDiscreteRandomRequests,
  validateDiscreteRandomCommitmentBudget,
} from "./random";
import { MAX_RANDOM_REQUESTS_PER_ROUND } from "./random-limits";
import {
  createCoreRulePackageRegistry,
  MechanicInputValidationError,
  type MechanicPromptContract,
  type RulePackageRegistry,
} from "./rule-package";
import type { WorldDefinition } from "../runtime/world-definition";
import type { ModelRole } from "../models/model-catalog";
import { runtimeId } from "../runtime/runtime-id";
import {
  runSemanticRepairLoop,
  SemanticRepairExhaustedError,
  semanticIssue,
  type SemanticRepairScope,
  type SemanticRepairContext,
} from "../models/semantic-repair";
import {
  type ModelReference,
  type ReferenceResolver,
  createAgentReferenceResolver,
  isProposalReference,
} from "../contracts/model-context";
import type {
  BoundCausalReview,
  CausalReviewEvidence,
  TruthCandidateSession,
  UnreviewedTruthResolution,
  OnsetPerceptionInput,
  OnsetPerceptionResult,
  TruthResolution,
  TruthResolutionInput,
  TruthPreparationInput,
} from "../algorithms/roles";

import { declaredRandomPlanSchema, declaresNoAdditionalRandomness, PLAN_RANDOM_COMPLETION, PLAN_RANDOM_COMPLETION_PROMPT } from "./plan-random-completion";

export interface TruthEngineOptions {
  mechanicalPlanRepair?: typeof MECHANICAL_PLAN_REPAIR;
  planRandomCompletion?: typeof PLAN_RANDOM_COMPLETION;
  includeResolutionMeansSources?: boolean;
  includePlanCauseScope?: boolean;
  includeResolutionFactEvidence?: boolean;
  includeActivityTemporalEvidence?: boolean;
  repairAttempts?: number;
  maxCommitmentRounds?: number;
  rulePackages?: RulePackageRegistry;
}

/** A model verdict only applies to the complete evidence that it reviewed. */
export function assertCausalReviewMatches(evidence: CausalReviewEvidence, review: BoundCausalReview): void {
  if (review.value.verdict !== "accept") throw new Error("causal review did not accept the candidate");
  if (review.binding.evidenceHash !== contentHash(evidence) ||
    review.binding.promptVersion !== promptBundle("causal-verifier").version) {
    throw new Error("causal review evidence binding mismatch");
  }
}

export function normalizeOutcomeAlternativeEvidence(
  state: Readonly<SimulationState>,
  actions: readonly AgentActionProposal[],
  proposal: Readonly<TransitionProposal>,
): { proposal: TransitionProposal; droppedReferences: number; droppedAlternatives: number } {
  const actorByAction = new Map(actions.map((action) => [action.id, action.actorId]));
  let droppedReferences = 0;
  let droppedAlternatives = 0;
  const outcomes = proposal.outcomes.map((outcome) => {
    const actorId = actorByAction.get(outcome.proposalId);
    const evidence = actorId ? state.agents[actorId]?.belief.evidence : undefined;
    const knownAlternatives = outcome.knownAlternatives.flatMap((alternative) => {
      if (alternative.basis.kind !== "knowledge") return [structuredClone(alternative)];
      const seen = new Set<string>();
      const evidenceIds = alternative.basis.evidenceIds.filter((evidenceId) => {
        if (!evidence?.[evidenceId] || seen.has(evidenceId)) {
          droppedReferences += 1;
          return false;
        }
        seen.add(evidenceId);
        return true;
      });
      if (evidenceIds.length === 0) {
        droppedAlternatives += 1;
        return [];
      }
      return [{
        ...structuredClone(alternative),
        basis: { kind: "knowledge" as const, evidenceIds },
      }];
    });
    return { ...structuredClone(outcome), knownAlternatives };
  });
  return {
    proposal: { ...structuredClone(proposal), outcomes },
    droppedReferences,
    droppedAlternatives,
  };
}

class ReactionExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReactionExecutionError";
  }
}

class ResolutionPlanCardinalityError extends Error {
  readonly expectedActionIds: string[];
  readonly receivedActionIds: string[];
  readonly missingActionIds: string[];

  constructor(expectedActionIds: readonly string[], receivedActionIds: readonly string[]) {
    const expected = [...new Set(expectedActionIds)].sort();
    const received = [...receivedActionIds].sort();
    const receivedSet = new Set(received);
    super(
      `resolution plans must cover every final joint action exactly once ` +
      `(expected ${expected.length}, received ${received.length})`,
    );
    this.name = "ResolutionPlanCardinalityError";
    this.expectedActionIds = expected;
    this.receivedActionIds = received;
    this.missingActionIds = expected.filter((id) => !receivedSet.has(id));
  }
}

function cardinalityError(error: unknown): ResolutionPlanCardinalityError | null {
  if (error instanceof ResolutionPlanCardinalityError) return error;
  if (error instanceof ModelSemanticRepairError) {
    if (error.cause instanceof ResolutionPlanCardinalityError) return error.cause;
    if (error.cause instanceof SemanticRepairExhaustedError &&
      error.cause.cause instanceof ResolutionPlanCardinalityError) {
      return error.cause.cause;
    }
  }
  return null;
}

function combineCompatibleModelAudits(
  audits: readonly ModelExecutionAudit[],
): ModelExecutionAudit[] {
  const groups: ModelExecutionAudit[][] = [];
  for (const audit of audits) {
    const compatible = groups.find((group) => {
      try {
        combineModelExecutionAudits([...group, audit]);
        return true;
      } catch {
        return false;
      }
    });
    if (compatible) compatible.push(audit);
    else groups.push([audit]);
  }
  return groups.map((group) => combineModelExecutionAudits(group));
}

interface ValidatedCallInput<T> {
  provider: StructuredModelProvider;
  profileId: string;
  role: ModelRole;
  subjectId: string;
  promptId: PromptBundleId;
  schemaName: string;
  schema: z.ZodType<T>;
  scope: ModelExecutionScope;
  buildContext: (issues: readonly PromptValidationIssue[]) => unknown;
  validate?: (value: T) => void;
  repairAttempts: number;
  invocationOffset?: number;
  repairScope?: SemanticRepairScope;
  targetIds?: readonly string[];
  promptExtension?: { version: string; userPrompt: string };
  projectRepair?: (repair: SemanticRepairContext, context: unknown) => {
    context: unknown;
    merge: (value: T) => T;
    evidence: Record<string, unknown>;
  } | undefined;
}

async function generateValidated<T>(input: ValidatedCallInput<T>): Promise<{
  value: T;
  audit: ModelExecutionAudit;
}> {
  const observe = runtimeEventEmitter(input.scope.observer);
  const logicalInvocationId = modelInvocationLogicalId(
    input.scope,
    input.role,
    input.subjectId,
    (input.invocationOffset ?? 0) + 1,
  );
  let sourceContextHash: string | undefined;
  try {
    const result = await runSemanticRepairLoop({
      role: input.role,
      repairScope: input.repairScope ?? "step",
      targetIds: input.targetIds ?? [input.subjectId],
      maxRepairs: input.repairAttempts,
      logicalInvocationId,
      invoke: async (repairContext) => {
        input.scope.cancelPendingSignal?.throwIfAborted();
        const contextStartedAt = Date.now();
        const issues = repairContext.issues.map((issue) => ({
          code: issue.code,
          path: issue.path,
          message: issue.message,
          class: issue.class,
          ...(issue.originalValue !== undefined ? { originalValue: structuredClone(issue.originalValue) } : {}),
          ...(issue.allowedHandles ? { allowedHandles: [...issue.allowedHandles] } : {}),
        }));
        const sourceContext = input.buildContext(issues);
        sourceContextHash ??= contentHash(sourceContext);
        const logicalContext = logicalRepairContext(sourceContext, repairContext, sourceContextHash, input.schemaName);
        const projection = input.projectRepair?.(repairContext, logicalContext);
        const context = projection?.context ?? logicalContext;
        const prompt = promptBundle(input.promptId);
        const invocation = (input.invocationOffset ?? 0) + repairContext.attempt + 1;
        const identity = modelInvocationIdentity(input.scope, input.role, input.subjectId, invocation);
        const correlation = modelInvocationCorrelation(input.scope, input.role, input.subjectId, identity, {
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
        const generated = await input.provider.generateStructured({
          profileId: input.profileId,
          workloadId: input.scope.workloadId,
          batchId: input.scope.batchId,
          abortSignal: input.scope.abortSignal,
          cancelPendingSignal: input.scope.cancelPendingSignal,
          correlation,
          observer: input.scope.observer,
          ...identity,
          role: input.role,
          subjectId: input.subjectId,
          promptVersion: input.promptExtension ? `${prompt.version}/${input.promptExtension.version}` : prompt.version,
          schemaName: input.schemaName,
          system: prompt.system,
          userPrompt: input.promptExtension ? `${prompt.userPrompt}\n\n${input.promptExtension.userPrompt}` : prompt.userPrompt,
          context,
          schema: input.schema,
        });
        const contextCatalog = context && typeof context === "object" && !Array.isArray(context)
          ? (context as { referenceCatalog?: { candidates?: readonly { handle: string; kind: import("../contracts/model-context").ModelReferenceKind; label: string; meaning: string; allowedUses: readonly import("../contracts/model-context").ModelReferenceUse[]; visibility: "public" | "role" | "slot" }[] } }).referenceCatalog
          : undefined;
        const referenceResolver = contextCatalog
          ? createReferenceResolver((contextCatalog.candidates ?? []).map((candidate) => ({ ...candidate, engineId: candidate.handle })))
          : undefined;
        const normalized = normalizeModelOutput(generated.value, { resolver: referenceResolver, dedupeArrays: true });
        const invocationAudit = generated.audit.invocations.at(-1);
        if (invocationAudit) {
          const providerNormalization = invocationAudit.normalization;
          const providerAlreadyAuditedNormalization = generated.audit.structuredOutputMode !== "deterministic-test" &&
            normalized.issues.length === 0 &&
            providerNormalization.modifiedFieldCount === normalized.modifiedFieldCount &&
            providerNormalization.resolvedReferenceCount === normalized.resolvedReferenceCount &&
            providerNormalization.proposalCount === normalized.proposalCount &&
            providerNormalization.deduplicatedCount === normalized.deduplicatedCount &&
            providerNormalization.symbolRepairCount === normalized.symbolRepairs.length;
          const symbolRepairs = [
            ...(invocationAudit.symbolRepairs ?? []),
            ...normalized.symbolRepairs,
          ];
          const symbolRepairAcceptedCount = symbolRepairs.filter((repair) =>
            repair.status === "repaired" || repair.status === "normalized").length;
          const symbolRepairAmbiguousCount = symbolRepairs.filter((repair) => repair.status === "ambiguous").length;
          const symbolRepairUnmatchedCount = symbolRepairs.filter((repair) => repair.status === "unmatched").length;
          const symbolRepairPostValidationRejectedCount = symbolRepairs.filter((repair) =>
            repair.status === "postvalidation-rejected").length;
          invocationAudit.symbolRepairs = structuredClone(symbolRepairs);
          invocationAudit.rawOutputHash ??= contentHash(generated.value);
          invocationAudit.normalizedOutputHash = contentHash(normalized.value);
          invocationAudit.normalization = {
            applied: normalized.modifiedFieldCount > 0 || normalized.deduplicatedCount > 0 || symbolRepairAcceptedCount > 0,
            modifiedFieldCount: normalized.modifiedFieldCount + symbolRepairAcceptedCount,
            resolvedReferenceCount: normalized.resolvedReferenceCount,
            proposalCount: normalized.proposalCount,
            deduplicatedCount: normalized.deduplicatedCount,
            symbolRepairCount: symbolRepairs.length,
            symbolRepairAcceptedCount,
            symbolRepairAmbiguousCount,
            symbolRepairUnmatchedCount,
            symbolRepairPostValidationRejectedCount,
          };
          if (!providerAlreadyAuditedNormalization) {
            observe?.({
              event: "model.output.normalized",
              correlation,
              attributes: { applied: invocationAudit.normalization.applied },
              counts: {
                modifiedFields: normalized.modifiedFieldCount,
                resolvedReferences: normalized.resolvedReferenceCount,
                proposals: normalized.proposalCount,
                deduplicated: normalized.deduplicatedCount,
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
              payload: (normalized.issues.length > 0 || symbolRepairs.length > 0) && input.scope.observer
                ? fullRuntimePayload(input.scope.observer, { issues: normalized.issues, symbolRepairs })
                : undefined,
            });
          }
          if (normalized.issues.length > 0) {
            invocationAudit.outputDisposition = "rejected";
            invocationAudit.issues = normalized.issues.map((issue) => ({
              code: issue.code,
              class: issue.class,
              path: issue.path,
              message: issue.reason,
              originalValue: issue.originalValue,
              allowedHandles: [...issue.allowedHandles],
            }));
            throw new ModelOutputError(
              `model output contains unresolved semantic references: ${normalized.issues.map((issue) => `${issue.code} at ${issue.path.join(".") || "$"}`).join("; ")}`,
              generated.audit,
              {
              rawValue: generated.value,
              },
            );
          }
        }
        let logicalValue = normalized.value as T;
        if (projection) {
          try { logicalValue = projection.merge(logicalValue); }
          catch (error) {
            if (error instanceof ModelConfigurationError) throw error;
            throw new ModelOutputError("scoped repair did not return its complete assigned replacements", generated.audit,
              { cause: error, rawValue: normalized.value });
          }
          observe?.({ event: "model.repair.candidate_reconstructed", correlation,
            hashes: { replacement: contentHash(normalized.value), candidate: contentHash(logicalValue) },
            payload: input.scope.observer ? fullRuntimePayload(input.scope.observer, { binding: projection.evidence, candidate: logicalValue }) : undefined });
          const complete = normalizeModelOutput(logicalValue, { resolver: referenceResolver, dedupeArrays: false });
          if (complete.issues.length > 0) {
            if (invocationAudit) invocationAudit.issues = complete.issues.map(issue => ({ code: issue.code, class: issue.class,
              path: issue.path, message: issue.reason, originalValue: issue.originalValue, allowedHandles: [...issue.allowedHandles] }));
            throw new ModelOutputError("reconstructed joint candidate contains invalid references or declarations", generated.audit,
              { rawValue: logicalValue });
          }
          logicalValue = complete.value as T;
        }
        const value = logicalValue as { kind?: unknown; verdict?: unknown };
        const resultKind = typeof value.kind === "string"
          ? `${input.role}_${value.kind}`
          : typeof value.verdict === "string"
            ? `${input.role}_${value.verdict}`
            : input.role;
        setModelInvocationResultKind(generated.audit, resultKind);
        return { ...generated, value: logicalValue };
      },
      validate: (value) => input.validate?.(value),
      classify: (error) => validationIssues(error).map((issue) => semanticIssue(
        issue.code,
        issue.message,
        {
          path: issue.path,
          class: issue.class ?? "semantic",
          originalValue: issue.originalValue,
          allowedHandles: issue.allowedHandles,
          targetIds: input.targetIds ? [...input.targetIds] : undefined,
        },
      )),
      onRejected: ({ context, audit, issues, error }) => {
        const invocation = audit?.invocations.at(-1);
        if (audit) setModelInvocationOutcome(audit, "rejected", issues.map((issue) => issue.code));
        observe?.({
          event: "model.semantic.rejected",
          level: "warn",
          correlation: modelInvocationCorrelation(input.scope, input.role, input.subjectId, {
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
          attributes: { resultKind: invocation?.resultKind ?? null },
          counts: { validationIssues: issues.length },
          hashes: invocation?.responseHash ? { response: invocation.responseHash } : undefined,
          error: serializeRuntimeError(error),
        });
      },
    });
    const acceptedInvocation = result.audit.invocations.at(-1);
    if (acceptedInvocation) setModelInvocationOutcome(result.audit, result.repairs > 0 ? "llm-repaired" : "accepted");
    observe?.({
      event: "model.semantic.accepted",
      correlation: modelInvocationCorrelation(input.scope, input.role, input.subjectId, {
        modelInvocationId: acceptedInvocation?.id,
        modelInvocation: acceptedInvocation?.ordinal,
      }, {
        logicalInvocationId,
        semanticRepairAttempt: result.repairs,
      }),
      attributes: { resultKind: acceptedInvocation?.resultKind ?? input.role },
    });
    return { value: result.value, audit: result.audit };
  } catch (error) {
    if (!(error instanceof SemanticRepairExhaustedError)) throw error;
    throw new ModelSemanticRepairError(
      input.role,
      `${input.role} failed after repairs: ${error.message}`,
      { cause: error, audit: error.audit },
    );
  }
}

function validateCausalReference(
  cause: CausalRef,
  allowed: Record<CausalRef["kind"], Set<string>>,
  label: string,
): void {
  if (!allowed[cause.kind].has(cause.id)) {
    throw new Error(`${label} references unknown ${cause.kind} ${cause.id}`);
  }
}

function validateCheckRequest(
  state: SimulationState,
  request: D20CheckRequest,
  allowed: Record<CausalRef["kind"], Set<string>>,
  maximumVisibility: WorldDefinition["disclosure"]["defaultCheckVisibility"],
): void {
  const actor = state.truth.entities[request.actorId];
  if (!actor || actor.lifecycle !== "active") throw new Error(`check ${request.id} has inactive actor`);
  if (request.targetId && !state.truth.entities[request.targetId]) {
    throw new Error(`check ${request.id} has unknown target`);
  }
  if (request.ratingId) {
    const rating = state.truth.ratings[request.ratingId];
    if (!rating || rating.entityId !== request.actorId) {
      throw new Error(`check ${request.id} has invalid actor rating`);
    }
  }
  if (request.modifierSources.reduce((total, source) => total + source.amount, 0) !== request.modifier) {
    throw new Error(`check ${request.id} modifier does not equal its declared sources`);
  }
  const modifierSourceIds = new Set<string>();
  for (const source of request.modifierSources) {
    const sourceKey = `${source.kind}:${source.id}`;
    if (modifierSourceIds.has(sourceKey)) {
      throw new Error(`check ${request.id} repeats modifier source ${sourceKey}`);
    }
    modifierSourceIds.add(sourceKey);
    const rating = state.truth.ratings[source.id];
    if (!rating) throw new Error(`check ${request.id} has unknown rating modifier ${source.id}`);
    if (rating.value !== source.amount) {
      throw new Error(`check ${request.id} misstates rating modifier ${source.id}`);
    }
  }
  for (const cause of request.causes) validateCausalReference(cause, allowed, `check ${request.id}`);
  const visibilityRank = { hidden: 0, result_only: 1, full: 2 } as const;
  if (visibilityRank[request.visibility] > visibilityRank[maximumVisibility]) {
    throw new Error(`check ${request.id} exceeds world disclosure policy ${maximumVisibility}`);
  }
}

function resolveTruthReference(
  reference: ModelReference,
  use: Parameters<ReferenceResolver["resolve"]>[1],
  resolver: ReferenceResolver,
  expectedKind: string,
): string {
  if (typeof reference !== "string") {
    throw new Error(`truth model cannot use proposal ${reference.proposalKey} for ${expectedKind}; this reference must already exist`);
  }
  const resolved = resolver.resolve(reference, use);
  if (resolved.kind !== expectedKind) throw new Error(`truth reference ${reference} is ${resolved.kind}, expected ${expectedKind}`);
  return resolved.engineId;
}

function materializeCheckDraft(
  draft: ModelCheckRequestDraft,
  resolver: ReferenceResolver,
  id: string,
  evidence: ResolutionEvidenceIndex,
): D20CheckRequest {
  const resolve = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], kind: string) =>
    resolveTruthReference(reference, use, resolver, kind);
  const actorId = resolve(draft.actorRef, "actor", "entity");
  const targetId = draft.targetRef === null ? null : resolve(draft.targetRef, "target", "entity");
  const ratingId = draft.ratingRef === null ? null : resolve(draft.ratingRef, "modifier", "rating");
  const difficulty = draft.difficulty.kind === "environment"
    ? { kind: "environment" as const, band: draft.difficulty.band, source: materializeResolutionSource(draft.difficulty.source, resolver) }
    : { kind: "opposed" as const, targetId: resolve(draft.difficulty.targetRef, "target", "entity"),
        ratingId: resolve(draft.difficulty.ratingRef, "source", "rating"), source: materializeResolutionSource(draft.difficulty.source, resolver) };
  // The perceived object and the entity providing opposition are distinct
  // semantic choices (for example, a concealed key and its concealing owner).
  const targetIds = [...new Set([...(targetId === null ? [] : [targetId]), ...(difficulty.kind === "opposed" ? [difficulty.targetId] : [])])];
  const numbers = deriveCheckNumbers({ actorId, actorRatingId: ratingId, targetIds, difficulty }, evidence, `check ${id}`);
  if (!Number.isSafeInteger(numbers.dc) || numbers.dc < 0 || numbers.dc > 100 || !Number.isSafeInteger(numbers.modifier)) {
    throw new Error(`check ${id} derives unsupported d20 numbers`);
  }
  return {
    id,
    actorId,
    targetId,
    ratingId,
    modifier: numbers.modifier,
    modifierSources: ratingId === null ? [] : [{ kind: "rating", id: ratingId, amount: numbers.modifier }],
    dc: numbers.dc,
    mode: draft.mode,
    stakes: draft.stakes,
    visibility: draft.visibility,
    phase: "perception",
    causes: draft.causes.map((cause) => ({
      kind: cause.kind,
      id: resolve(cause.ref, "cause", cause.kind),
    })),
  };
}

async function runOnsetPerceptionStage(input: Readonly<OnsetPerceptionInput> & {
  provider: StructuredModelProvider;
  repairAttempts: number;
  maxCommitmentRounds: number;
  scope: ModelExecutionScope;
}): Promise<OnsetPerceptionResult> {
  const perceptionSchema = perceptionDirectiveSchema;
  const requests: D20CheckRequest[] = [];
  const checks: D20CheckResult[] = [];
  const commitmentRounds: CommitmentRound[] = [];
  const aliases = new Map<string, string | null>();
  const audits: ModelExecutionAudit[] = [];
  let rng = structuredClone(input.state.truth.rng);
  const evidence = resolutionEvidenceIndex(input.state, input.actions, input.definition.laws);

  while (true) {
    const referenceInput = { state: input.state, definition: input.definition, actions: input.actions, checkRequests: requests };
    const resolver = createTruthReferenceResolver(referenceInput);
    const allowed = perceptionCauseScope(referenceInput);
    const accepted = { round: null as D20CheckRequest[] | null };
    let draftRound: ModelCheckRequestDraft[] = [];
    const call = await generateValidated({
      provider: input.provider,
      profileId: input.definition.modelProfiles.perception,
      role: "truth-perception",
      subjectId: input.identityOwner,
      promptId: "truth-perception",
      schemaName: "truth_perception_directive",
      schema: perceptionSchema,
      scope: input.scope,
      buildContext: (issues) => buildTruthContext({
        definition: input.definition,
        state: input.state,
        perceptionTargets: input.perceptionTargets,
        workset: {
          mode: "full",
          state: input.state,
          initialActions: input.actions,
          availableActions: input.actions,
          assignedActions: input.actions,
          availableDependencies: input.groundings,
          assignedDependencies: input.groundings,
        },
        reactionRequests: [],
        reactionDecisions: [],
        reactionWindow: "open",
        committedCheckRequests: requests,
        checkResults: checks,
        committedRandomRequests: [],
        randomResults: [],
        commitmentRounds,
        resolutionPlans: [],
        resolutionReceipts: [],
        temporalBoundary: input.temporalBoundary,
        instanceId: input.scope.workloadId,
        advanceId: input.scope.batchId,
        issues,
        stage: "perception",
      }),
      validate: (directive) => {
        if (directive.kind !== "request_checks") return;
        if (commitmentRounds.length >= input.maxCommitmentRounds) {
          throw new Error("maximum commitment rounds exceeded");
        }
        const relationIssues = perceptionDraftRelationIssues(directive.requests, { ...referenceInput, perceptionTargets: input.perceptionTargets }, resolver);
        draftRound = structuredClone(directive.requests);
        const roundAliases = new Map<string, string>();
        for (const [ordinal, request] of directive.requests.entries()) {
          roundAliases.set(request.proposalKey, runtimeId({
            worldHash: input.state.worldHash,
            revision: input.state.revision,
            kind: "check",
            stage: "perception",
            owner: input.identityOwner,
            round: commitmentRounds.length,
            ordinal,
          }));
        }
        const normalized: D20CheckRequest[] = [];
        const materializationIssues: PromptValidationIssue[] = [...relationIssues];
        for (const [index, draft] of directive.requests.entries()) {
          if (relationIssues.some(issue => issue.path[1] === index)) continue;
          try {
            const request = materializeCheckDraft(draft, resolver, roundAliases.get(draft.proposalKey)!, evidence);
            validateCheckRequest(input.state, request, allowed, input.definition.disclosure.defaultCheckVisibility);
            normalized.push(request);
          } catch (error) {
            materializationIssues.push(...validationIssues(error).map(issue => ({ ...issue, path: ["requests", index, ...issue.path] })));
          }
        }
        if (materializationIssues.length) throw new ModelCandidateValidationError(materializationIssues);
        accepted.round = normalized;
      },
      repairAttempts: input.repairAttempts,
      invocationOffset: audits.reduce((count, audit) => count + audit.invocations.length, 0),
      repairScope: "step",
      targetIds: input.actions.map((action) => action.id),
    });
    audits.push(call.audit);
    if (call.value.kind === "done") break;
    const acceptedRound = accepted.round;
    if (!acceptedRound) throw new Error("accepted perception round was not materialized");
    const resolved = resolveD20Checks(rng, acceptedRound);
    rng = resolved.rng;
    requests.push(...structuredClone(acceptedRound));
    checks.push(...resolved.results);
    commitmentRounds.push({
      kind: "check",
      phase: "perception",
      requestIds: acceptedRound.map((request) => request.id),
    });
    draftRound.forEach((request, index) => {
      const canonicalId = acceptedRound![index]!.id;
      aliases.set(request.proposalKey, aliases.has(request.proposalKey) ? null : canonicalId);
    });
  }

  return {
    requests,
    checks,
    commitmentRounds,
    rng,
    modelAudit: combineModelExecutionAudits(audits),
    aliases: [...aliases.entries()],
  };
}

function resolutionEvidenceIndex(
  state: SimulationState,
  actions: readonly AgentActionProposal[],
  laws: readonly { id: string }[],
): ResolutionEvidenceIndex {
  return {
    actions: new Set(actions.map((action) => action.id)),
    entities: new Set(Object.keys(state.truth.entities)),
    facts: new Set(Object.keys(state.truth.facts)),
    conditions: new Set(Object.keys(state.truth.conditions)),
    conditionOwners: new Map(Object.values(state.truth.conditions)
      .map((condition) => [condition.id, condition.subjectId])),
    laws: new Set(laws.map((law) => law.id)),
    placements: new Set(Object.keys(state.truth.placements)),
    ratingOwners: new Map(Object.values(state.truth.ratings).map((rating) => [rating.id, rating.entityId])),
    ratingValues: new Map(Object.values(state.truth.ratings).map((rating) => [rating.id, rating.value])),
  };
}

function groundingContainsSource(grounding: InteractionDependency, source: ResolutionSourceRef): boolean {
  if (grounding.globalFallback || source.kind === "action" || source.kind === "law") return true;
  const kind = source.kind === "entity" || source.kind === "fact" || source.kind === "condition" ||
    source.kind === "rating" || source.kind === "placement"
    ? source.kind
    : null;
  return kind !== null && [...grounding.reads, ...grounding.writes]
    .some((reference) => reference.kind === kind && reference.id === source.id);
}

function validatePlanEffect(
  state: SimulationState,
  plan: ResolutionPlan,
  effect: NonNullable<ResolutionPlan["primaryEffect"]> | NonNullable<ResolutionPlan["threatenedEffect"]>,
  binding: { draft: ResolutionPlanDraft; ordinal: number; field: "primaryEffect" | "secondaryEffect" | "threatenedEffect"; resolver: ReferenceResolver },
): void {
  if (effect.kind === "meter") {
    const meter = state.truth.meters[effect.meterId];
    const profile = state.truth.mechanics.impactProfiles[effect.impactProfileId];
    if (!meter || meter.entityId !== effect.targetId || !profile || profile.meterDefinitionId !== meter.definitionId) {
      throw new Error(`plan ${plan.id} has invalid meter effect ${effect.id}`);
    }
    return;
  }
  const duration = state.truth.mechanics.durationProfiles[effect.durationProfileId];
  const profile = effect.conditionProfileId
    ? state.truth.mechanics.conditionProfiles[effect.conditionProfileId]
    : null;
  const draftEffect = binding.draft[binding.field];
  if (!draftEffect || draftEffect.kind !== "condition") throw new Error("condition effect draft binding differs from materialized effect");
  const handles = (ids: readonly string[]) => binding.resolver.candidatesFor("mechanic")
    .filter(candidate => ids.includes(binding.resolver.resolve(candidate.handle, "mechanic").engineId))
    .map(candidate => candidate.handle);
  const issues: PromptValidationIssue[] = [];
  const issue = (field: "conditionProfileRef" | "durationProfileRef", allowedHandles: string[], message: string) => {
    issues.push({ code: "reference.invalid_effect_profile", class: "reference",
      path: ["plans", binding.ordinal, binding.field, field], originalValue: draftEffect[field], allowedHandles,
      message: `Plan ${binding.draft.proposalKey} for action ${binding.draft.actionRef}: ${binding.field}.${field} ${draftEffect[field]}. ${message} ` +
        "Choose only a profile supported by the intended effect; do not change the action or effect meaning to pass validation." });
  };
  if (effect.conditionProfileId !== null && !profile) {
    issue("conditionProfileRef", handles(Object.keys(state.truth.mechanics.conditionProfiles)),
      "This reference is not an authored condition profile. A duration, impact or other mechanic profile is not interchangeable with a condition profile. " +
      "allowedHandles lists condition profiles. null is also legal for an open semantic condition without an authored condition profile; it does not remove the effect.");
  }
  if (!duration) {
    issue("durationProfileRef", handles(profile ? [profile.defaultDurationProfileId] : Object.keys(state.truth.mechanics.durationProfiles)),
      "This reference is not an authored duration profile. allowedHandles lists valid duration profiles, restricted to the selected condition profile's default when one is selected.");
  } else if (profile && profile.defaultDurationProfileId !== effect.durationProfileId) {
    issue("durationProfileRef", handles([profile.defaultDurationProfileId]),
      `The selected conditionProfileRef ${draftEffect.conditionProfileRef} requires its authored default duration. allowedHandles lists that duration. ` +
      "Reconcile the selected condition and duration using the effect evidence.");
  }
  if (issues.length) throw new ModelCandidateValidationError(issues);
  const existing = state.truth.conditions[effect.conditionId];
  if (existing && existing.subjectId !== effect.targetId) {
    throw new Error(`plan ${plan.id} reuses condition ${effect.conditionId} for another subject`);
  }
}

function materializeResolutionSource(
  source: ResolutionPlanDraft["means"][number]["source"],
  resolver: ReferenceResolver,
): ResolutionSourceRef {
  if (isProposalReference(source.ref)) throw new Error(`resolution source ${source.kind} cannot use a new proposal`);
  const resolved = resolver.resolve(source.ref, "source");
  if (resolved.kind !== source.kind) throw new Error(`resolution source expected ${source.kind}, got ${resolved.kind}`);
  return { kind: source.kind, id: resolved.engineId };
}

type ModelResolutionEffect =
  NonNullable<ResolutionPlanDraft["primaryEffect"]> |
  NonNullable<ResolutionPlanDraft["threatenedEffect"]>;

function materializeModelFactValue(value: ModelFactValue, resolver: ReferenceResolver): import("../contracts/model").FactValue {
  if (value.kind !== "entity") return structuredClone(value);
  if (isProposalReference(value.entityRef)) throw new Error("fact value entityRef must identify an existing entity");
  const entity = resolver.resolve(value.entityRef, "assertion");
  if (entity.kind !== "entity") throw new Error(`fact value expected entity, got ${entity.kind}`);
  return { kind: "entity", entityId: entity.engineId };
}

function materializeModelAccess(access: ModelAccess, resolver: ReferenceResolver): import("../contracts/model").WorldFact["access"] {
  if (access.kind !== "agents") return { kind: access.kind };
  return {
    kind: "agents",
    agentIds: access.agentRefs.map((reference) => {
      if (isProposalReference(reference)) throw new Error("access agentRefs must identify existing Agents");
      const agent = resolver.resolve(reference, "audience");
      if (agent.kind !== "agent") throw new Error(`access agentRef expected agent, got ${agent.kind}`);
      return agent.engineId;
    }),
  };
}

function materializeResolutionEffect(
  effect: NonNullable<ResolutionPlanDraft["primaryEffect"]> | null,
  resolver: ReferenceResolver,
  state: SimulationState,
  includeMagnitude: true,
): NonNullable<ResolutionPlan["primaryEffect"]>;
function materializeResolutionEffect(
  effect: NonNullable<ResolutionPlanDraft["threatenedEffect"]> | null,
  resolver: ReferenceResolver,
  state: SimulationState,
  includeMagnitude: false,
): NonNullable<ResolutionPlan["threatenedEffect"]>;
function materializeResolutionEffect(
  effect: ModelResolutionEffect | null,
  resolver: ReferenceResolver,
  state: SimulationState,
  includeMagnitude: boolean,
): ResolutionPlan["primaryEffect"] | ResolutionPlan["threatenedEffect"] {
  if (!effect) return null;
  const targetRef = effect.targetRef;
  if (isProposalReference(targetRef)) throw new Error("resolution effect target must be an existing entity");
  const target = resolver.resolve(targetRef, "target");
  if (target.kind !== "entity") throw new Error(`resolution effect target is ${target.kind}, expected entity`);
  const sourceRefs = effect.sourceRefs.map((source) => materializeResolutionSource(source, resolver));
  const id = `effect-${contentHash({ revision: state.revision, proposalKey: effect.proposalKey }).slice(0, 32)}`;
  if (effect.kind === "meter") {
    const meterRef = effect.meterRef;
    const impactRef = effect.impactProfileRef;
    if (isProposalReference(meterRef) || isProposalReference(impactRef)) throw new Error("meter effects require existing meter and impact profile references");
    const meter = resolver.resolve(meterRef, "source");
    const impact = resolver.resolve(impactRef, "mechanic");
    if (meter.kind !== "meter" || impact.kind !== "mechanic") throw new Error("meter effect references have the wrong kinds");
    return {
      kind: "meter", id, targetId: target.engineId, channel: effect.channel, label: effect.label,
      description: effect.description, sourceRefs, meterId: meter.engineId, impactProfileId: impact.engineId,
      ...(includeMagnitude && "magnitude" in effect ? { magnitude: effect.magnitude } : {}),
    };
  }
  const conditionRef = effect.conditionRef;
  const durationRef = effect.durationProfileRef;
  const conditionProfileRef = effect.conditionProfileRef;
  if (isProposalReference(durationRef) || (conditionProfileRef && isProposalReference(conditionProfileRef))) {
    throw new Error("condition effects require an existing duration and condition profile");
  }
  const conditionProposal = isProposalReference(conditionRef);
  const condition = conditionProposal ? null : resolver.resolve(conditionRef, "source");
  const duration = resolver.resolve(durationRef, "mechanic");
  const conditionProfile = conditionProfileRef === null ? null : resolver.resolve(conditionProfileRef, "mechanic");
  if ((condition && condition.kind !== "condition") || duration.kind !== "mechanic" || (conditionProfile && conditionProfile.kind !== "mechanic")) {
    throw new Error("condition effect references have the wrong kinds");
  }
  const conditionId = condition
    ? condition.engineId
    : `condition-${contentHash({ revision: state.revision, proposalKey: conditionProposal ? conditionRef.proposalKey : "unknown" }).slice(0, 32)}`;
  return {
    kind: "condition", id, targetId: target.engineId, channel: effect.channel, label: effect.label,
    description: effect.description, sourceRefs, conditionId,
    conditionProfileId: conditionProfile?.engineId ?? null, durationProfileId: duration.engineId,
    access: materializeModelAccess(effect.access, resolver),
    ...(includeMagnitude && "magnitude" in effect ? { magnitude: effect.magnitude } : {}),
  };
}

export interface ResolutionPlanMaterializationInput {
  state: SimulationState;
  definition: WorldDefinition;
  actions: readonly AgentActionProposal[];
  groundings: readonly InteractionDependency[];
  identityOwner: string;
  drafts: readonly ResolutionPlanDraft[];
  allowedCauses: Record<CausalRef["kind"], Set<string>>;
}

/** Read-only admission evidence from the same materializer used by execution.
 * Collect failures across plans with the complete original action/reference
 * scope; never return a partially accepted batch or commit any world change. */
export function inspectResolutionPlanDrafts(input: ResolutionPlanMaterializationInput): { valid: boolean; issues: PromptValidationIssue[] } {
  try { materializeResolutionPlans(input); return { valid: true, issues: [] }; }
  catch (error) { return { valid: false, issues: validationIssues(error) }; }
}

function materializeResolutionPlans(input: ResolutionPlanMaterializationInput): ResolutionPlan[] {
  if (input.drafts.length !== input.actions.length) {
    throw new ResolutionPlanCardinalityError(
      input.actions.map((action) => action.id),
      input.drafts.map((draft) => draft.proposalKey),
    );
  }
  const aliases = new Set<string>();
  const actionIds = new Set<string>();
  const conditionSubjects = new Map<string, string>();
  const evidence = resolutionEvidenceIndex(input.state, input.actions, input.definition.laws);
  const resolver = createTruthReferenceResolver({ state: input.state, definition: input.definition, actions: input.actions });
  const resolve = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], kind: string): string => {
    if (isProposalReference(reference)) throw new Error(`resolution plan cannot use proposal ${reference.proposalKey} for ${kind}`);
    const resolved = resolver.resolve(reference, use);
    if (resolved.kind !== kind) throw new Error(`resolution plan reference ${reference} is ${resolved.kind}, expected ${kind}`);
    return resolved.engineId;
  };
  const visibilityRank = { hidden: 0, result_only: 1, full: 2 } as const;
  const materialize = (draft: ResolutionPlanDraft, ordinal: number): ResolutionPlan => {
    if (aliases.has(draft.proposalKey)) throw new Error(`duplicate resolution plan proposalKey ${draft.proposalKey}`);
    aliases.add(draft.proposalKey);
    const actionId = resolve(draft.actionRef, "source", "action");
    if (actionIds.has(actionId)) throw new Error(`duplicate resolution plan for action ${actionId}`);
    actionIds.add(actionId);
    const action = input.actions.find((candidate) => candidate.id === actionId);
    if (!action) throw new Error(`resolution plan references unknown action ${actionId}`);
    const actor = input.state.agents[action.actorId];
    if (!actor) throw new Error(`resolution plan ${draft.proposalKey} references unknown action actor ${action.actorId}`);
    // The action binding is authoritative for identity and intent.  These two
    // fields are repeated in the draft for provider readability, but accepting
    // a paraphrase (or a stale actor id) would let a model retarget a plan.
    // targetIds are an optional canonical index for the free-form action.  A
    // local belief alias without a unique canonical binding is still valid in
    // the action's natural-language intent, but cannot be persisted as a
    // Truth reference.  Omit only that unresolved index; effects and explicit
    // difficulty targets remain strict and continue to fail closed.
    const targetIds = [...new Set(draft.targetRefs.map((targetRef) => resolve(targetRef, "target", "entity")))];
    const difficulty = draft.difficulty
      ? draft.difficulty.kind === "opposed"
        ? {
            kind: "opposed" as const,
            targetId: resolve(draft.difficulty.targetRef, "target", "entity"),
            ratingId: resolve(draft.difficulty.ratingRef, "source", "rating"),
            source: materializeResolutionSource(draft.difficulty.source, resolver),
          }
        : {
            kind: "environment" as const,
            band: draft.difficulty.band,
            source: materializeResolutionSource(draft.difficulty.source, resolver),
          }
      : null;
    const plan: ResolutionPlan = {
      id: runtimeId({
        worldHash: input.state.worldHash,
        revision: input.state.revision,
        kind: "resolution-plan",
        stage: "resolution",
        owner: [input.identityOwner, action.id],
        round: 0,
        ordinal,
      }),
      actionId: action.id,
      actorId: actor.entityId,
      goal: action.goal,
      targetIds,
      difficulty,
      means: draft.means.map((mean) => ({ description: mean.description, source: materializeResolutionSource(mean.source, resolver) })),
      factors: draft.factors.map((factor) => ({
        role: factor.role,
        direction: factor.direction,
        steps: factor.steps,
        authority: factor.authority,
        channel: factor.channel,
        explanation: factor.explanation,
        source: materializeResolutionSource(factor.source, resolver),
      })),
      primaryEffect: materializeResolutionEffect(draft.primaryEffect, resolver, input.state, true),
      secondaryEffect: materializeResolutionEffect(draft.secondaryEffect, resolver, input.state, true),
      threatenedEffect: materializeResolutionEffect(draft.threatenedEffect, resolver, input.state, false),
      actorRatingId: draft.actorRatingRef === null ? null : resolve(draft.actorRatingRef, "modifier", "rating"),
      mode: draft.mode,
      risk: draft.risk,
      baseEffect: draft.baseEffect,
      visibility: draft.visibility,
      causes: draft.causes.map((cause) => ({ kind: cause.kind, id: resolve(cause.ref, "cause", cause.kind) })),
    };
    const grounding = input.groundings.find((candidate) =>
      candidate.kind === "action" && candidate.id === action.id);
    if (!grounding) throw new Error(`resolution plan ${plan.id} has no action grounding`);
    for (const [meanIndex, mean] of plan.means.entries()) {
      if (!groundingContainsSource(grounding, mean.source)) {
        const draftSource = draft.means[meanIndex]!.source;
        const sourceRef = isProposalReference(draftSource.ref)
          ? `proposal:${draftSource.ref.proposalKey}`
          : draftSource.ref;
        const allowedHandles = resolver.candidatesFor("source").filter((candidate) => {
          const resolved = resolver.resolve(candidate.handle, "source");
          if (resolved.kind === "action") return resolved.engineId === action.id;
          if (resolved.kind !== "law" && resolved.kind !== "entity" && resolved.kind !== "fact" &&
            resolved.kind !== "condition" && resolved.kind !== "rating" && resolved.kind !== "placement") return false;
          return groundingContainsSource(grounding, { kind: resolved.kind, id: resolved.engineId });
        }).map((candidate) => candidate.handle);
        throw new ModelReferenceError({
          code: "reference.outside_action_grounding",
          path: ["plans", ordinal, "means", meanIndex, "source", "ref"],
          originalValue: sourceRef,
          allowedHandles,
          reason: `Plan ${draft.proposalKey} for action ${draft.actionRef} uses means source ${sourceRef} outside that action's committed grounding. ` +
            "Use a source from allowedHandles that actually supports this means description; keep the action's meaning. " +
            "Another action's dependencies and an audience Agent do not authorize a source for this action.",
        });
      }
    }
    if (visibilityRank[plan.visibility] > visibilityRank[input.definition.disclosure.defaultCheckVisibility]) {
      throw new Error(`resolution plan ${plan.id} exceeds world disclosure policy`);
    }
    if (!plan.causes.some((cause) => cause.kind === "action" && cause.id === action.id)) {
      throw new Error(`resolution plan ${plan.id} does not cite its action`);
    }
    for (const cause of plan.causes) {
      if (cause.kind === "check" || cause.kind === "random" || cause.kind === "mechanic") {
        throw new Error(`resolution plan ${plan.id} cites post-plan evidence`);
      }
      validateCausalReference(cause, input.allowedCauses, `resolution plan ${plan.id}`);
    }
    const effectTargetIssues: PromptValidationIssue[] = [];
    for (const field of ["primaryEffect", "secondaryEffect", "threatenedEffect"] as const) {
      const effect = plan[field];
      if (!effect || plan.targetIds.includes(effect.targetId)) continue;
      effectTargetIssues.push({
        code: "reference.outside_plan_targets", class: "reference",
        path: ["plans", ordinal, field, "targetRef"], originalValue: draft[field]!.targetRef,
        allowedHandles: draft.targetRefs.flatMap(ref => typeof ref === "string" ? [ref] : []),
        message: `Plan ${draft.proposalKey} for action ${draft.actionRef}: ${field}.targetRef ${draft[field]!.targetRef} ` +
          "resolves to an existing entity but is absent from this plan's targetRefs. " +
          "allowedHandles lists this plan's currently declared targets, not all visible entities. " +
          "Reconcile the effect subject and targetRefs using the original action and state evidence; " +
          "declare an additional visible target only if the action supports that effect on it. " +
          "Do not transfer an effect to another subject or invent an effect merely to pass validation.",
      });
    }
    if (effectTargetIssues.length > 0) throw new ModelCandidateValidationError(effectTargetIssues);
    validateResolutionPlan(plan, evidence);
    const effectIssues: PromptValidationIssue[] = [];
    for (const field of ["primaryEffect", "secondaryEffect", "threatenedEffect"] as const) {
      const effect = plan[field];
      if (!effect) continue;
      try { validatePlanEffect(input.state, plan, effect, { draft, ordinal, field, resolver }); }
      catch (error) { effectIssues.push(...validationIssues(error)); continue; }
      if (effect.kind !== "condition") continue;
      const subject = conditionSubjects.get(effect.conditionId);
      if (subject && subject !== effect.targetId) {
        throw new Error(`resolution plans reuse condition ${effect.conditionId} for multiple subjects`);
      }
      conditionSubjects.set(effect.conditionId, effect.targetId);
    }
    if (effectIssues.length) throw new ModelCandidateValidationError(effectIssues);
    return plan;
  };
  const plans: ResolutionPlan[] = [];
  const issues: PromptValidationIssue[] = [];
  for (const [ordinal, draft] of input.drafts.entries()) {
    try { plans.push(materialize(draft, ordinal)); }
    catch (error) {
      issues.push(...validationIssues(error).map(issue => ({ ...issue,
        path: issue.path[0] === "plans" ? issue.path : ["plans", ordinal, ...issue.path] })));
    }
  }
  // Preserve the entire action/reference scope while checking other plans.
  // No partially materialized batch can escape into verification or commits.
  if (issues.length > 0) throw new ModelCandidateValidationError(issues);
  if (input.actions.some((action) => !actionIds.has(action.id))) {
    throw new Error("resolution plans omit a final joint action");
  }
  return plans;
}

function checkRequestsForPlans(input: {
  state: SimulationState;
  plans: readonly ResolutionPlan[];
  identityOwner: string;
  round: number;
  allowedCauses: Record<CausalRef["kind"], Set<string>>;
  maximumVisibility: WorldDefinition["disclosure"]["defaultCheckVisibility"];
}): D20CheckRequest[] {
  const baseEvidence = resolutionEvidenceIndex(input.state, [], []);
  const evidence: ResolutionEvidenceIndex = {
    ...baseEvidence,
    actions: new Set(input.plans.map((plan) => plan.actionId)),
  };
  return input.plans.filter((plan) => plan.mode === "check").map((plan, ordinal) => {
    const derived = deriveCheck(plan, evidence);
    if (!Number.isSafeInteger(derived.dc) || !Number.isSafeInteger(derived.modifier)) {
      throw new Error(`resolution plan ${plan.id} derives a non-integer d20 value`);
    }
    const id = runtimeId({
      worldHash: input.state.worldHash,
      revision: input.state.revision,
      kind: "check",
      stage: "resolution",
      owner: [input.identityOwner, plan.id],
      round: input.round,
      ordinal,
    });
    const request: D20CheckRequest = {
      id,
      actorId: plan.actorId,
      targetId: plan.difficulty?.kind === "opposed"
        ? plan.difficulty.targetId
        : plan.primaryEffect?.targetId ?? plan.targetIds[0] ?? null,
      ratingId: plan.actorRatingId,
      modifier: derived.modifier,
      modifierSources: plan.actorRatingId
        ? [{ kind: "rating", id: plan.actorRatingId, amount: derived.modifier }]
        : [],
      dc: derived.dc,
      mode: derived.mode,
      stakes: `${plan.risk}: ${plan.primaryEffect?.description ?? plan.goal}`,
      visibility: plan.visibility,
      phase: "resolution",
      causes: structuredClone(plan.causes),
    };
    validateCheckRequest(input.state, request, input.allowedCauses, input.maximumVisibility);
    return request;
  });
}

function validateReactionRequests(
  input: TruthPreparationInput,
  requests: readonly ReactionRequest[],
  checkRequests: readonly D20CheckRequest[],
  checks: readonly D20CheckResult[],
): void {
  const requestedAgents = new Set<string>();
  const requestByCheck = new Map(checkRequests.map((request) => [request.id, request]));
  const resultByCheck = new Map(checks.map((result) => [result.requestId, result]));

  for (const request of requests) {
    if (requestedAgents.has(request.agentId)) throw new Error(`duplicate reaction request for ${request.agentId}`);
    requestedAgents.add(request.agentId);
    const agent = input.state.agents[request.agentId];
    if (!agent) throw new Error(`reaction request has unknown agent ${request.agentId}`);
    const sourceAction = input.initialActions.find((action) => action.id === request.triggerActionId);
    if (!sourceAction || sourceAction.actorId === request.agentId) {
      throw new Error(`reaction request for ${request.agentId} has an invalid source action`);
    }
    const sourceAgent = input.state.agents[sourceAction.actorId];
    if (!sourceAgent) throw new Error(`reaction request references unknown source actor ${sourceAction.actorId}`);
    if (request.originalIntent.kind === "prepared_action") {
      const actionId = request.originalIntent.actionId;
      const original = input.initialActions.find((action) => action.id === actionId);
      if (!original || original.actorId !== request.agentId) {
        throw new Error(`reaction request for ${request.agentId} has no matching prepared action`);
      }
    } else {
      const activity = input.state.truth.activities[request.originalIntent.activityId];
      if (!activity || activity.status !== "active" || activity.actorId !== request.agentId ||
        activity.sourceActionId !== request.originalIntent.sourceActionId || !activity.plan.interruptible) {
        throw new Error(`reaction request for ${request.agentId} has no matching interruptible Activity`);
      }
    }
    if (request.stimulus.observerId !== request.agentId || request.stimulus.kind !== "stimulus") {
      throw new Error(`reaction request for ${request.agentId} has an invalid private stimulus`);
    }
    if (request.stimulus.sourceEventIds.length !== 0) {
      throw new Error(`reaction stimulus ${request.stimulus.id} cannot cite uncommitted events`);
    }

    const basisIds = new Set<string>();
    for (const basis of request.basis) {
      const basisId = basis.kind === "shared_placement"
        ? `${basis.kind}:${basis.placementId}`
        : basis.kind === "fact"
          ? `${basis.kind}:${basis.factId}`
          : `${basis.kind}:${basis.checkId}`;
      if (basisIds.has(basisId)) throw new Error(`reaction request for ${request.agentId} repeats basis ${basisId}`);
      basisIds.add(basisId);

      if (basis.kind === "shared_placement") {
        const sourcePlacement = input.state.truth.placements[sourceAgent.entityId];
        const agentPlacement = input.state.truth.placements[agent.entityId];
        if (!sourcePlacement || sourcePlacement !== agentPlacement || sourcePlacement !== basis.placementId) {
          throw new Error(`reaction request for ${request.agentId} has no shared direct placement`);
        }
        continue;
      }
      if (basis.kind === "fact") {
        const fact = input.state.truth.facts[basis.factId];
        const accessible = fact && (fact.access.kind === "public" ||
          (fact.access.kind === "agents" && fact.access.agentIds.includes(request.agentId)));
        if (!accessible) throw new Error(`reaction request for ${request.agentId} cites inaccessible fact`);
        const endpoints = new Set([sourceAgent.entityId, agent.entityId]);
        const connected = endpoints.has(fact.subjectId) ||
          (fact.value.kind === "entity" && endpoints.has(fact.value.entityId));
        if (!connected) {
          throw new Error(`reaction request for ${request.agentId} cites a fact unrelated to either participant`);
        }
        continue;
      }

      const checkRequest = requestByCheck.get(basis.checkId);
      const result = resultByCheck.get(basis.checkId);
      if (!checkRequest || checkRequest.phase !== "perception" || !result?.succeeded) {
        throw new Error(`reaction request for ${request.agentId} cites no successful perception check`);
      }
      if (checkRequest.actorId !== agent.entityId) {
        throw new Error(`perception check ${basis.checkId} belongs to another observer`);
      }
      const citesSourceAction = checkRequest.causes.some((cause) =>
        cause.kind === "action" && cause.id === sourceAction.id);
      const citesWorldBasis = checkRequest.causes.some((cause) =>
        cause.kind === "fact" || cause.kind === "law");
      if (!citesSourceAction || !citesWorldBasis) {
        throw new Error(`perception check ${basis.checkId} lacks source-action and world basis`);
      }
    }
  }

  validateObservations(input.state, requests.map((request) => request.stimulus), input.state.step + 1);
}

function applyReactionDecisions(
  input: TruthPreparationInput,
  requests: readonly ReactionRequest[],
  decisions: readonly ReactionDecision[],
): AgentActionProposal[] {
  if (decisions.length !== requests.length) throw new Error("reaction decisions do not cover every request");
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const decisionAgents = new Set<string>();
  const actions = input.initialActions.map((action) => structuredClone(action));

  for (const decision of decisions) {
    const request = requestById.get(decision.requestId);
    if (!request || request.agentId !== decision.agentId || decisionAgents.has(decision.agentId)) {
      throw new Error(`unexpected or duplicate reaction decision for ${decision.agentId}`);
    }
    decisionAgents.add(decision.agentId);
    if (decision.baseRevision !== input.state.revision) throw new Error("reaction decision has stale revision");
    const originalProposalId = request.originalIntent.kind === "prepared_action"
      ? request.originalIntent.actionId
      : request.originalIntent.sourceActionId;
    if (decision.originalProposalId !== originalProposalId) {
      throw new Error(`reaction decision for ${decision.agentId} references another intent`);
    }
    const preparedActionId = request.originalIntent.kind === "prepared_action"
      ? request.originalIntent.actionId
      : null;
    const actionIndex = preparedActionId !== null
      ? actions.findIndex((action) => action.id === preparedActionId)
      : -1;
    if (request.originalIntent.kind === "prepared_action" && actionIndex < 0) {
      throw new Error(`reaction decision for ${decision.agentId} references another prepared action`);
    }
    if (decision.kind === "replace") {
      const replacement = decision.replacementAction;
      if (replacement.actorId !== decision.agentId || replacement.baseRevision !== input.state.revision) {
        throw new Error(`reaction replacement for ${decision.agentId} changes actor or revision`);
      }
      const allowedTargets = new Set([
        ...Object.keys(input.state.agents[decision.agentId].belief.localEntities),
        ...request.stimulus.introductions.map((introduction) => introduction.localEntity.id),
      ]);
      for (const targetId of replacement.targetIds) {
        if (!allowedTargets.has(targetId)) {
          throw new Error(`reaction replacement for ${decision.agentId} targets unknown local entity ${targetId}`);
        }
      }
      if (actionIndex < 0) actions.push(structuredClone(replacement));
      else actions[actionIndex] = structuredClone(replacement);
    }
  }

  const ids = new Set<string>();
  const actors = new Set<string>();
  for (const action of actions) {
    if (ids.has(action.id)) throw new Error(`reaction produced duplicate action id ${action.id}`);
    if (actors.has(action.actorId)) throw new Error(`reaction produced duplicate actor ${action.actorId}`);
    if (action.baseRevision !== input.state.revision) throw new Error(`reaction action ${action.id} has stale revision`);
    if (!input.state.agents[action.actorId]) {
      throw new Error(`reaction produced action for unknown actor ${action.actorId}`);
    }
    ids.add(action.id);
    actors.add(action.actorId);
  }
  return actions.sort((left, right) =>
    left.actorId.localeCompare(right.actorId) || left.id.localeCompare(right.id));
}

export function materializeObservationPackets(
  state: SimulationState,
  packets: readonly ObservationPacketDraft[],
  stage: "stimulus" | "outcome",
  eventAliases: ReadonlyMap<string, string> = new Map(),
): { packets: ObservationPacket[]; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  for (const [ordinal, packet] of packets.entries()) {
    if (aliases.has(packet.id)) throw new Error(`duplicate ${stage} observation alias ${packet.id}`);
    aliases.set(packet.id, runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "observation",
      stage,
      owner: packet.observerId,
      round: 0,
      ordinal,
    }));
  }
  return {
    aliases,
    packets: packets.map((packet, packetOrdinal) => {
      const id = aliases.get(packet.id)!;
      return {
        ...structuredClone(packet),
        id,
        step: state.step + 1,
        kind: stage,
        apparentClaims: packet.apparentClaims.map((claim, claimOrdinal) => ({
          ...structuredClone(claim),
          id: runtimeId({
            worldHash: state.worldHash,
            revision: state.revision,
            kind: "claim",
            stage,
            owner: [packet.observerId, id],
            round: packetOrdinal,
            ordinal: claimOrdinal,
          }),
        })),
        sourceEventIds: packet.sourceEventIds.map((eventId) => eventAliases.get(eventId) ?? eventId),
      };
    }),
  };
}

function materializeReactionRequests(
  input: TruthPreparationInput,
  requests: readonly ReactionRequestDraft[],
  committedChecks: readonly D20CheckRequest[] = [],
): ReactionRequest[] {
  const truthResolver = createTruthReferenceResolver({
    state: input.state,
    definition: input.definition,
    actions: input.initialActions,
    checkRequests: committedChecks,
  });
  const resolveTruth = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], kind: string): string => {
    if (isProposalReference(reference)) throw new Error(`reaction routing cannot use proposal ${reference.proposalKey} for ${kind}`);
    const resolved = truthResolver.resolve(reference, use);
    if (resolved.kind !== kind) throw new Error(`reaction routing reference ${reference} is ${resolved.kind}, expected ${kind}`);
    return resolved.engineId;
  };
  const materializeStimulus = (request: ReactionRequestDraft, agentId: string, index: number): ObservationPacketDraft => {
    const agent = input.state.agents[agentId];
    if (!agent) throw new Error(`reaction request references unknown Agent ${agentId}`);
    const localResolver = createAgentReferenceResolver(agent, []);
    const proposalIds = new Map<string, string>();
    const newLocalId = (key: string): string => {
      if (proposalIds.has(key)) throw new Error(`reaction stimulus duplicates proposalKey ${key}`);
      const id = `reaction-local-${contentHash({ agentId, step: input.state.step + 1, index, key }).slice(0, 32)}`;
      proposalIds.set(key, id);
      return id;
    };
    const resolveLocal = (reference: ModelReference): string => {
      if (isProposalReference(reference)) {
        const id = proposalIds.get(reference.proposalKey);
        if (!id) throw new Error(`reaction stimulus references undeclared proposalKey ${reference.proposalKey}`);
        return id;
      }
      const resolved = localResolver.resolve(reference, "target");
      if (resolved.kind !== "local_entity") throw new Error(`reaction stimulus reference ${reference} is ${resolved.kind}, expected local_entity`);
      return resolved.engineId;
    };
    const introductions = request.stimulus.introductions.map((introduction) => ({
      localEntity: {
        id: newLocalId(introduction.localEntity.proposalKey),
        name: introduction.localEntity.name,
        description: introduction.localEntity.description,
        status: introduction.localEntity.status,
      },
      canonicalEntityId: introduction.canonicalEntityRef === null
        ? null
        : resolveTruth(introduction.canonicalEntityRef, "target", "entity"),
    }));
    return {
      id: `reaction-stimulus-${index}`,
      observerId: agentId,
      summary: request.stimulus.summary,
      introductions,
      apparentClaims: request.stimulus.apparentClaims.map((claim) => ({
        subjectId: resolveLocal(claim.subjectRef),
        predicate: claim.predicate,
        value: claim.value.kind === "local_entity"
          ? { kind: "local_entity" as const, localEntityId: resolveLocal(claim.value.entityRef) }
          : structuredClone(claim.value),
        description: claim.description,
      })),
        sourceEventIds: request.stimulus.sourceEventRefs.map((reference) => resolveTruth(reference, "source", "event")),
    };
  };
  const materialized = materializeObservationPackets(
    input.state,
    requests.map((request, index) => ({
      ...materializeStimulus(request, resolveTruth(request.agentRef, "target", "agent"), index),
    })),
    "stimulus",
  ).packets;
  return requests.map((request, index) => {
    const agentId = resolveTruth(request.agentRef, "target", "agent");
    const sourceActionId = resolveTruth(request.sourceActionRef, "source", "action");
    const prepared = input.initialActions.find((action) => action.actorId === agentId);
    const ongoing = Object.values(input.state.truth.activities)
      .find((activity) => activity.status === "active" && activity.actorId === agentId);
    if (!prepared && !ongoing) throw new Error(`reaction request for ${agentId} has no original intent`);
    return {
      id: runtimeId({
        worldHash: input.state.worldHash,
        revision: input.state.revision,
        kind: "reaction-request",
        stage: "truth-routing",
        owner: [agentId, sourceActionId],
        round: 0,
        ordinal: index,
      }),
      agentId,
      triggerActionId: sourceActionId,
      originalIntent: prepared
        ? { kind: "prepared_action" as const, actionId: prepared.id }
        : {
            kind: "ongoing_activity" as const,
            activityId: ongoing!.id,
            sourceActionId: ongoing!.sourceActionId,
          },
      stimulus: materialized[index],
      basis: request.basis.map((basis) => basis.kind === "shared_placement"
        ? { kind: basis.kind, placementId: resolveTruth(basis.placementRef, "assertion", "placement") }
        : basis.kind === "fact"
          ? { kind: basis.kind, factId: resolveTruth(basis.factRef, "assertion", "fact") }
          : { kind: basis.kind, checkId: resolveTruth(basis.checkRef, "assertion", "check") }),
    };
  });
}

function materializeWorldOperation(
  state: SimulationState,
  definition: WorldDefinition,
  operation: WorldDeltaOperationDraft,
  rewriteCause: (cause: CausalRef) => CausalRef,
  rewriteAssertion: (assertion: CausalAssertion) => CausalAssertion,
): WorldDeltaOperation {
  const causes = operation.causes.map(rewriteCause);
  const assertions = operation.assertions.map(rewriteAssertion);
  const nextStep = state.step + 1;

  switch (operation.kind) {
    case "create_entity":
      return {
        ...structuredClone(operation),
        entity: {
          ...structuredClone(operation.entity),
          lifecycle: "active",
          createdAtStep: nextStep,
        },
        causes,
        assertions,
      };
    case "set_fact":
      return {
        ...structuredClone(operation),
        fact: {
          ...structuredClone(operation.fact),
          provenance: structuredClone(causes),
        },
        causes,
        assertions,
      };
    case "create_agent": {
      const stampRecords = <T extends { id: string }>(records: Record<string, T>) =>
        Object.fromEntries(Object.entries(records).map(([id, record]) => [id, {
          ...structuredClone(record),
          createdAtStep: nextStep,
          updatedAtStep: nextStep,
        }]));
      return {
        ...structuredClone(operation),
        agent: {
          ...structuredClone(operation.agent),
          modelProfiles: structuredClone(definition.modelProfiles.dynamicAgent),
          character: {
            persona: {
              ...structuredClone(operation.agent.character.persona),
              updatedAtStep: nextStep,
            },
            traits: stampRecords(operation.agent.character.traits),
            values: stampRecords(operation.agent.character.values),
            emotions: stampRecords(operation.agent.character.emotions),
            attitudes: stampRecords(operation.agent.character.attitudes),
            goals: stampRecords(operation.agent.character.goals),
            commitments: stampRecords(operation.agent.character.commitments),
          },
          belief: {
            ...structuredClone(operation.agent.belief),
            evidence: Object.fromEntries(Object.entries(operation.agent.belief.evidence)
              .map(([id, evidence]) => [id, { ...structuredClone(evidence), step: nextStep }])),
          },
          observationCursorStep: nextStep,
          nextAction: null,
        },
        causes,
        assertions,
      };
    }
    default:
      return {
        ...structuredClone(operation),
        causes,
        assertions,
      };
  }
}

function materializeCausalVerification(
  input: Parameters<typeof causalProposalReferenceResolver>[0] & { report: ModelCausalVerification },
): CausalVerification {
  if (input.report.verdict === "accept") return { verdict: "accept", findings: [] };
  const resolver = causalProposalReferenceResolver(input);
  for (const finding of input.report.findings) {
    if (isProposalReference(finding.target.targetHandle)) throw new Error("causal finding cannot target a proposal");
    const target = resolver.resolve(finding.target.targetHandle, "target");
    if (target.kind !== finding.target.kind) throw new Error("causal finding target kind does not match its handle");
    for (const evidenceHandle of finding.evidenceHandles) {
      if (isProposalReference(evidenceHandle)) {
        throw new Error(`causal verifier evidence cannot target proposal ${evidenceHandle.proposalKey}`);
      }
      resolver.resolve(evidenceHandle, "assertion");
    }
  }
  return {
    verdict: "reject",
    findings: input.report.findings.map((finding) => ({
      target: {
        kind: finding.target.kind,
        id: isProposalReference(finding.target.targetHandle)
          ? (() => { throw new Error(`causal verifier cannot target proposal ${finding.target.targetHandle.proposalKey}`); })()
          : resolver.resolve(finding.target.targetHandle, "target").engineId,
      },
      code: finding.code,
      message: finding.message,
      repairHint: finding.repairHint,
    })),
  };
}

function materializeTransitionProposal(
  definition: WorldDefinition,
  state: SimulationState,
  actions: readonly AgentActionProposal[],
  direct: ModelTransitionProposalDraft,
  checkAliases: ReadonlyMap<string, string | null>,
  randomAliases: ReadonlyMap<string, string | null>,
  identityOwner: string,
  checkRequests: readonly D20CheckRequest[] = [],
  randomRequests: readonly DiscreteRandomRequest[] = [],
  resolutionReceipts: readonly ResolutionReceipt[] = [],
  mechanicContracts: readonly MechanicPromptContract[] = [],
): TransitionProposal {
  const resolver = createTruthReferenceResolver({ state, definition, actions, checkRequests, randomRequests, resolutionReceipts, mechanicContracts });
  const proposalAliases = new Map<string, string>();
  const mechanicAliases = new Map<string, string>();
  for (const [ordinal, invocation] of direct.mechanicInvocations.entries()) {
    if (mechanicAliases.has(invocation.proposalKey)) throw new Error(`duplicate mechanic proposalKey ${invocation.proposalKey}`);
    /* IDs are assigned by the engine after semantic validation. */
    const id = runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "mechanic",
      stage: "transition",
      owner: identityOwner,
      round: 0,
      ordinal,
    });
    mechanicAliases.set(invocation.proposalKey, id);
    proposalAliases.set(invocation.proposalKey, id);
  }
  const eventAliases = new Map<string, string>();
  for (const [ordinal, event] of direct.events.entries()) {
    if (eventAliases.has(event.proposalKey)) throw new Error(`duplicate event proposalKey ${event.proposalKey}`);
    const id = runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "event",
      stage: "transition",
      owner: identityOwner,
      round: 0,
      ordinal,
    });
    eventAliases.set(event.proposalKey, id);
    proposalAliases.set(event.proposalKey, id);
  }
  const outcomeAliases = new Map<string, string>();
  for (const outcome of direct.outcomes) {
    if (outcomeAliases.has(outcome.proposalKey)) throw new Error(`duplicate outcome proposalKey ${outcome.proposalKey}`);
    const id = runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "outcome",
      stage: "transition",
      owner: isProposalReference(outcome.actionRef)
        ? (() => { throw new Error("outcome must refer to an existing action"); })()
        : resolver.resolve(outcome.actionRef, "cause").engineId,
      round: 0,
      ordinal: 0,
    });
    outcomeAliases.set(outcome.proposalKey, id);
    proposalAliases.set(outcome.proposalKey, id);
  }
  const entityAliases = new Map<string, string>();
  const factAliases = new Map<string, string>();
  const agentAliases = new Map<string, string>();
  for (const operation of direct.operations) {
    if (operation.kind === "create_entity") {
      if (entityAliases.has(operation.entity.proposalKey)) throw new Error(`duplicate entity proposalKey ${operation.entity.proposalKey}`);
      const id = `entity-${contentHash({ worldHash: state.worldHash, revision: state.revision, proposalKey: operation.entity.proposalKey }).slice(0, 32)}`;
      entityAliases.set(operation.entity.proposalKey, id);
      proposalAliases.set(operation.entity.proposalKey, id);
    }
    if (operation.kind === "set_fact") {
      if (factAliases.has(operation.fact.proposalKey)) throw new Error(`duplicate fact proposalKey ${operation.fact.proposalKey}`);
      const id = `fact-${contentHash({ worldHash: state.worldHash, revision: state.revision, proposalKey: operation.fact.proposalKey }).slice(0, 32)}`;
      factAliases.set(operation.fact.proposalKey, id);
      proposalAliases.set(operation.fact.proposalKey, id);
    }
    if (operation.kind === "create_agent") {
      if (agentAliases.has(operation.agent.proposalKey)) throw new Error(`duplicate agent proposalKey ${operation.agent.proposalKey}`);
      const id = `agent-${contentHash({ worldHash: state.worldHash, revision: state.revision, proposalKey: operation.agent.proposalKey }).slice(0, 32)}`;
      agentAliases.set(operation.agent.proposalKey, id);
      proposalAliases.set(operation.agent.proposalKey, id);
    }
  }
  const resolveReference = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], expectedKind?: string): string => {
    if (isProposalReference(reference)) {
      const id = expectedKind === "check"
        ? checkAliases.get(reference.proposalKey)
        : expectedKind === "random"
          ? randomAliases.get(reference.proposalKey)
          : proposalAliases.get(reference.proposalKey);
      if (!id) throw new Error(`unknown proposalKey ${reference.proposalKey}`);
      return id;
    }
    const resolved = resolver.resolve(reference, use);
    if (expectedKind && resolved.kind !== expectedKind) throw new Error(`expected ${expectedKind} reference, got ${resolved.kind}`);
    return resolved.engineId;
  };
  const rewriteModelCause = (cause: ModelCausalRef): CausalRef => {
    const referenceKey = isProposalReference(cause.ref) ? cause.ref.proposalKey : cause.ref;
    const checkId = cause.kind === "check" ? checkAliases.get(referenceKey) : undefined;
    if (checkId) {
      return { kind: cause.kind, id: checkId };
    }
    const randomId = cause.kind === "random" ? randomAliases.get(referenceKey) : undefined;
    if (randomId) {
      return { kind: cause.kind, id: randomId };
    }
    if (cause.kind === "mechanic" && isProposalReference(cause.ref) && mechanicAliases.has(cause.ref.proposalKey)) {
      return { kind: cause.kind, id: mechanicAliases.get(cause.ref.proposalKey)! };
    }
    if (cause.kind === "event" && isProposalReference(cause.ref) && eventAliases.has(cause.ref.proposalKey)) {
      return { kind: cause.kind, id: eventAliases.get(cause.ref.proposalKey)! };
    }
    return { kind: cause.kind, id: resolveReference(cause.ref, "cause", cause.kind) };
  };
  const rewriteAssertion = (assertion: ModelCausalAssertion): CausalAssertion => {
    switch (assertion.kind) {
      case "check_result": return { kind: assertion.kind, checkId: resolveReference(assertion.checkRef, "assertion", "check"), expected: assertion.expected };
      case "random_result": return { kind: assertion.kind, requestId: resolveReference(assertion.requestRef, "assertion", "random"), stepId: resolveReference(assertion.stepRef, "assertion", "random"), expected: structuredClone(assertion.expected) as never };
      case "fact_matches": return { kind: assertion.kind, factId: resolveReference(assertion.factRef, "assertion", "fact"), expected: materializeModelFactValue(assertion.expected, resolver) };
      case "fact_absent": return { kind: assertion.kind, factId: resolveReference(assertion.factRef, "assertion", "fact") };
      case "entity_absent": return { kind: assertion.kind, entityId: resolveReference(assertion.entityRef, "assertion", "entity") };
      case "entity_lifecycle": return { kind: assertion.kind, entityId: resolveReference(assertion.entityRef, "assertion", "entity"), expected: assertion.expected };
      case "placement_equals": return { kind: assertion.kind, entityId: resolveReference(assertion.entityRef, "assertion", "entity"), placementId: assertion.placementRef === null ? null : resolveReference(assertion.placementRef, "assertion", "placement") };
      case "placement_not_equals": return { kind: assertion.kind, entityId: resolveReference(assertion.entityRef, "assertion", "entity"), placementId: assertion.placementRef === null ? null : resolveReference(assertion.placementRef, "assertion", "placement") };
      case "shared_placement": return { kind: assertion.kind, leftEntityId: resolveReference(assertion.leftEntityRef, "assertion", "entity"), rightEntityId: resolveReference(assertion.rightEntityRef, "assertion", "entity") };
      case "meter_compare": return { kind: assertion.kind, meterId: resolveReference(assertion.meterRef, "assertion", "meter"), operator: assertion.operator, value: assertion.value };
      case "quantity_compare": {
        const quantityId = resolveReference(assertion.quantityRef, "assertion", "quantity");
        const quantity = state.truth.quantities[quantityId];
        if (!quantity) throw new Error(`quantity assertion references unknown quantity ${quantityId}`);
        return { kind: assertion.kind, definitionId: quantity.definitionId, holderId: quantity.holderId, operator: assertion.operator, value: assertion.value };
      }
      case "rating_compare": return { kind: assertion.kind, ratingId: resolveReference(assertion.ratingRef, "assertion", "rating"), operator: assertion.operator, value: assertion.value };
      case "shared_resource_capacity_compare": return { kind: assertion.kind, poolId: resolveReference(assertion.poolRef, "assertion", "shared_resource_pool"), operator: assertion.operator, value: assertion.value };
      case "elapsed_seconds_compare": return structuredClone(assertion);
    }
  };
  const rewriteMechanicInput = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewriteMechanicInput);
    if (typeof value === "string") {
      const checkId = checkAliases.get(value);
      if (checkId) return checkId;
      const randomId = randomAliases.get(value);
      if (randomId) return randomId;
      if (value.startsWith("ref:")) return resolver.resolve(value).engineId;
      return value;
    }
    if (!value || typeof value !== "object") return structuredClone(value);
    if ("proposalKey" in value && typeof value.proposalKey === "string" &&
      Object.keys(value as Record<string, unknown>).length === 1) {
      const resolved = proposalAliases.get(value.proposalKey);
      if (!resolved) throw new Error(`unknown mechanic input proposalKey ${value.proposalKey}`);
      return resolved;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      // Mechanic contracts are authored with runtime `*Id` fields, while the
      // model sees the same shape as `*Ref`/`*Refs`. Rename only at this
      // boundary and resolve every model reference through the request-local
      // catalog. Literal fields such as `kind`, `amount`, and `seconds` keep
      // their authored names and values.
      const runtimeKey = key.endsWith("Refs") ? `${key.slice(0, -4)}Ids` :
        key.endsWith("Ref") ? `${key.slice(0, -3)}Id` : key;
      if (runtimeKey === "entityId" && typeof item === "string" && entityAliases.has(item)) {
        return [runtimeKey, entityAliases.get(item)!];
      }
      if (runtimeKey === "entityIds" && Array.isArray(item)) {
        return [runtimeKey, item.map((entry) => typeof entry === "string" && entityAliases.has(entry)
          ? entityAliases.get(entry)! : rewriteMechanicInput(entry))];
      }
      if (runtimeKey === "checkId" && typeof item === "string" && checkAliases.get(item)) {
        return [runtimeKey, checkAliases.get(item)!];
      }
      if (runtimeKey === "requestId" && typeof item === "string" && randomAliases.get(item)) {
        return [runtimeKey, randomAliases.get(item)!];
      }
      return [runtimeKey, rewriteMechanicInput(item)];
    }));
  };
  const mechanicIdentity = (reference: ModelReference): { packageId: string; ruleId: string } => {
    if (isProposalReference(reference)) {
      throw new Error(`mechanicRef cannot be a proposal: ${reference.proposalKey}`);
    }
    const resolved = resolver.resolve(reference, "mechanic");
    if (resolved.kind !== "mechanic") throw new Error(`mechanicRef ${reference} is ${resolved.kind}, expected mechanic`);
    const separator = resolved.engineId.indexOf("::");
    if (separator <= 0 || separator === resolved.engineId.length - 2) {
      throw new Error(`mechanicRef ${reference} does not identify an authored mechanic contract`);
    }
    return { packageId: resolved.engineId.slice(0, separator), ruleId: resolved.engineId.slice(separator + 2) };
  };
  const materializeOperation = (operation: ModelTransitionProposalDraft["operations"][number]): WorldDeltaOperationDraft => {
    const nextStep = state.step + 1;
    const causal = {
      causes: operation.causes.map(rewriteModelCause),
      assertions: operation.assertions.map(rewriteAssertion),
    };
    switch (operation.kind) {
      case "create_entity":
        return {
          kind: operation.kind,
          entity: {
            id: entityAliases.get(operation.entity.proposalKey)!,
            kind: operation.entity.kind,
            name: operation.entity.name,
            description: operation.entity.description,
          },
          placementId: operation.placementRef === null ? null : resolveReference(operation.placementRef, "target", "placement"),
          ...causal,
        };
      case "retire_entity":
        return { kind: operation.kind, entityId: resolveReference(operation.entityRef, "target", "entity"), ...causal };
      case "place_entity":
        return {
          kind: operation.kind,
          entityId: resolveReference(operation.entityRef, "target", "entity"),
          placementId: operation.placementRef === null ? null : resolveReference(operation.placementRef, "target", "placement"),
          ...causal,
        };
      case "set_fact":
        return {
          kind: operation.kind,
          fact: {
            id: factAliases.get(operation.fact.proposalKey)!,
            subjectId: resolveReference(operation.fact.subjectRef, "subject", "entity"),
            predicate: operation.fact.predicate,
            value: operation.fact.value.kind === "entity" && isProposalReference(operation.fact.value.entityRef)
              ? { kind: "entity" as const, entityId: resolveReference(operation.fact.value.entityRef, "assertion", "entity") }
              : materializeModelFactValue(operation.fact.value, resolver),
            description: operation.fact.description,
            access: materializeModelAccess(operation.fact.access, resolver),
          },
          ...causal,
        };
      case "create_agent": {
        const agentValue = operation.agent;
        const recordId = (kind: string, key: string): string =>
          `${kind}-${contentHash({ worldHash: state.worldHash, revision: state.revision, agent: operation.agent.proposalKey, key }).slice(0, 32)}`;
        const localEntityAliases = new Map(agentValue.belief.localEntities.map((entity) => [entity.proposalKey, recordId("local", entity.proposalKey)]));
        const evidenceAliases = new Map(agentValue.belief.evidence.map((evidence) => [evidence.proposalKey, recordId("evidence", evidence.proposalKey)]));
        const facetAliases = new Map<string, string>();
        const addFacetAliases = (kind: string, records: readonly { proposalKey: string }[]) =>
          records.forEach((record) => facetAliases.set(`${kind}:${record.proposalKey}`, recordId(kind, record.proposalKey)));
        addFacetAliases("trait", agentValue.character.traits);
        addFacetAliases("value", agentValue.character.values);
        addFacetAliases("emotion", agentValue.character.emotions);
        addFacetAliases("attitude", agentValue.character.attitudes);
        const goalAliases = new Map(agentValue.character.goals.map((goal) => [goal.proposalKey, recordId("goal", goal.proposalKey)]));
        const commitmentAliases = new Map(agentValue.character.commitments.map((commitment) => [commitment.proposalKey, recordId("commitment", commitment.proposalKey)]));
        const resolveReference = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], expectedKind?: string): string => {
          if (isProposalReference(reference)) {
            const id = localEntityAliases.get(reference.proposalKey) ?? evidenceAliases.get(reference.proposalKey) ??
              facetAliases.get(`trait:${reference.proposalKey}`) ?? facetAliases.get(`value:${reference.proposalKey}`) ??
              facetAliases.get(`emotion:${reference.proposalKey}`) ?? facetAliases.get(`attitude:${reference.proposalKey}`) ??
              goalAliases.get(reference.proposalKey) ?? commitmentAliases.get(reference.proposalKey) ??
              entityAliases.get(reference.proposalKey);
            if (!id) throw new Error(`unknown create_agent proposalKey ${reference.proposalKey}`);
            return id;
          }
          const resolved = resolver.resolve(reference, use);
          if (expectedKind && resolved.kind !== expectedKind) throw new Error(`expected ${expectedKind} reference, got ${resolved.kind}`);
          return resolved.engineId;
        };
        const evidenceIds = (refs: readonly ModelReference[]) => refs.map((reference) => resolveReference(reference, "evidence", "evidence"));
        const localId = (reference: ModelReference) => resolveReference(reference, "subject", "local_entity");
        const character = {
          persona: { summary: agentValue.character.persona.summary, voice: agentValue.character.persona.voice, evidenceIds: evidenceIds(agentValue.character.persona.evidenceRefs) },
          traits: Object.fromEntries(agentValue.character.traits.map((facet) => [facetAliases.get(`trait:${facet.proposalKey}`)!, { id: facetAliases.get(`trait:${facet.proposalKey}`)!, description: facet.description, strength: facet.strength, status: facet.status, createdAtStep: nextStep, updatedAtStep: nextStep, evidenceIds: evidenceIds(facet.evidenceRefs) }])),
          values: Object.fromEntries(agentValue.character.values.map((facet) => [facetAliases.get(`value:${facet.proposalKey}`)!, { id: facetAliases.get(`value:${facet.proposalKey}`)!, description: facet.description, strength: facet.strength, status: facet.status, createdAtStep: nextStep, updatedAtStep: nextStep, evidenceIds: evidenceIds(facet.evidenceRefs) }])),
          emotions: Object.fromEntries(agentValue.character.emotions.map((emotion) => [facetAliases.get(`emotion:${emotion.proposalKey}`)!, { id: facetAliases.get(`emotion:${emotion.proposalKey}`)!, description: emotion.description, intensity: emotion.intensity, status: emotion.status, createdAtStep: nextStep, updatedAtStep: nextStep, evidenceIds: evidenceIds(emotion.evidenceRefs) }])),
          attitudes: Object.fromEntries(agentValue.character.attitudes.map((attitude) => [facetAliases.get(`attitude:${attitude.proposalKey}`)!, { id: facetAliases.get(`attitude:${attitude.proposalKey}`)!, subjectId: localId(attitude.subjectRef), description: attitude.description, intensity: attitude.intensity, status: attitude.status, createdAtStep: nextStep, updatedAtStep: nextStep, evidenceIds: evidenceIds(attitude.evidenceRefs) }])),
          goals: Object.fromEntries(agentValue.character.goals.map((goal) => [goalAliases.get(goal.proposalKey)!, { id: goalAliases.get(goal.proposalKey)!, description: goal.description, priority: goal.priority, progress: goal.progress, targetIds: goal.targetRefs.map(localId), parentGoalId: goal.parentGoalRef === null ? undefined : resolveReference(goal.parentGoalRef, "source", "goal"), motivatedByIds: goal.motivatedByRefs.map((reference) => resolveReference(reference, "source")), status: goal.status, createdAtStep: nextStep, updatedAtStep: nextStep, evidenceIds: evidenceIds(goal.evidenceRefs) }])),
          commitments: Object.fromEntries(agentValue.character.commitments.map((commitment) => [commitmentAliases.get(commitment.proposalKey)!, { id: commitmentAliases.get(commitment.proposalKey)!, description: commitment.description, priority: commitment.priority, subjectIds: commitment.subjectRefs.map(localId), status: commitment.status, createdAtStep: nextStep, updatedAtStep: nextStep, evidenceIds: evidenceIds(commitment.evidenceRefs) }])),
        };
        const belief = {
          localEntities: Object.fromEntries(agentValue.belief.localEntities.map((entity) => [localEntityAliases.get(entity.proposalKey)!, { id: localEntityAliases.get(entity.proposalKey)!, name: entity.name, description: entity.description, status: entity.status }])),
          evidence: Object.fromEntries(agentValue.belief.evidence.map((evidence) => [evidenceAliases.get(evidence.proposalKey)!, { id: evidenceAliases.get(evidence.proposalKey)!, kind: evidence.kind, description: evidence.description, sourceId: evidence.sourceRef === null ? null : resolveReference(evidence.sourceRef, "source"), step: nextStep }])),
          claims: Object.fromEntries(agentValue.belief.claims.map((claim) => [recordId("claim", claim.proposalKey), { id: recordId("claim", claim.proposalKey), subjectId: localId(claim.subjectRef), predicate: claim.predicate, value: claim.value.kind === "local_entity" ? { kind: "local_entity" as const, localEntityId: localId(claim.value.entityRef) } : structuredClone(claim.value), description: claim.description, stance: claim.stance, confidence: claim.confidence, evidenceIds: evidenceIds(claim.evidenceRefs) }])),
        };
        const bindings = Object.fromEntries(agentValue.bindings.map((binding) => {
          const localEntityId = localId(binding.localEntityRef);
          return [localEntityId, { localEntityId, canonicalEntityIds: binding.canonicalEntityRefs.map((reference) => resolveReference(reference, "target", "entity")) }];
        }));
        return {
          kind: operation.kind,
          agent: {
            id: agentAliases.get(operation.agent.proposalKey)!,
            entityId: resolveReference(operation.agent.entityRef, "target", "entity"),
            character,
            belief,
            bindings,
          },
          ...causal,
        };
      }
      case "remove_fact":
        return { kind: operation.kind, factId: resolveReference(operation.factRef, "target", "fact"), ...causal };
      case "remove_agent":
        return { kind: operation.kind, agentId: resolveReference(operation.agentRef, "target", "agent"), ...causal };
    }
  };
  return {
    baseRevision: state.revision,
    mechanicInvocations: direct.mechanicInvocations.map((invocation) => {
      const { packageId, ruleId } = mechanicIdentity(invocation.mechanicRef);
      return {
      id: mechanicAliases.get(invocation.proposalKey)!,
      packageId,
      ruleId,
      causes: invocation.causes.map(rewriteModelCause),
      assertions: invocation.assertions.map(rewriteAssertion),
      input: rewriteMechanicInput(invocation.input),
      };
    }),
    operations: direct.operations.map((operation) => materializeWorldOperation(
      state,
      definition,
      materializeOperation(operation),
      (cause) => cause,
      (assertion) => assertion,
    )),
    events: direct.events.map((event) => ({
      id: eventAliases.get(event.proposalKey)!,
      step: state.step + 1,
      description: event.description,
      impact: event.impact,
      causes: event.causes.map(rewriteModelCause),
      assertions: event.assertions.map(rewriteAssertion),
    })),
    outcomes: direct.outcomes.map((outcome) => ({
      id: outcomeAliases.get(outcome.proposalKey)!,
      proposalId: resolveReference(outcome.actionRef, "cause", "action"),
      status: outcome.status,
      summary: outcome.summary,
      causeRefs: outcome.causes.map(rewriteModelCause),
      assertions: outcome.assertions.map(rewriteAssertion),
      // Truth roles cannot see Agent-private evidence. Subjective alternatives
      // therefore belong to a later cognition/observation boundary, not this
      // canonical transition proposal.
      knownAlternatives: [],
    })),
    decisionRequests: direct.decisionRequests.map((request) => ({
      agentId: resolveReference(request.agentRef, "audience", "agent"),
      prompt: request.prompt,
      possibleNextActions: structuredClone(request.possibleNextActions),
    })),
    observations: [],
  };
}

/**
 * Runtime rule schemas intentionally keep canonical `*Id`/`*Ids` names. The
 * model-facing mechanic contract uses `*Ref`/`*Refs`; before the registry's
 * shape-only preflight we project those names back without resolving them.
 * Exact handle/proposal resolution remains the responsibility of
 * `materializeTransitionProposal`, where the request-local catalog and the
 * same-response proposal aliases are available.
 */
function runtimeMechanicInputShape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(runtimeMechanicInputShape);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && typeof record.proposalKey === "string") return record.proposalKey;
  return Object.fromEntries(Object.entries(record).map(([key, item]) => {
    const runtimeKey = key.endsWith("Refs") ? `${key.slice(0, -4)}Ids` :
      key.endsWith("Ref") ? `${key.slice(0, -3)}Id` : key;
    return [runtimeKey, runtimeMechanicInputShape(item)];
  }));
}

function validateTransitionOutcomeCoverage(
  actions: readonly AgentActionProposal[],
  proposal: TransitionProposal,
): void {
  const proposalIds = actions.map((action) => action.id);
  const outcomeIds = proposal.outcomes.map((outcome) => outcome.proposalId);
  if (new Set(outcomeIds).size !== outcomeIds.length) throw new Error("transition has duplicate action outcomes");
  if (proposalIds.length !== outcomeIds.length || proposalIds.some((id) => !outcomeIds.includes(id))) {
    const missingOutcomeIds = proposalIds.filter((id) => !outcomeIds.includes(id));
    if (missingOutcomeIds.length > 0) {
      throw new Error(`transition omitted an outcome for assigned action(s): ${missingOutcomeIds.join(", ")}; emit exactly one outcome for each. Use the Activity mode and current interval evidence: fixed/rate/staged work retains its trusted completion schedule, goal/conditional completion requires supported task achievement, and ongoing work requires an explicit terminal disposition; pre-step active status or a checkpoint alone does not determine completion`);
    }
    throw new Error("transition must contain exactly one outcome for every final joint action");
  }
}

function validateTransitionEffects(
  input: TruthPreparationInput,
  actions: readonly AgentActionProposal[],
  proposal: TransitionProposal,
  checks: readonly D20CheckResult[],
  randomResults: readonly DiscreteRandomResult[],
  resolutionReceipts: readonly ResolutionReceipt[],
): void {
  validateTransitionOutcomeCoverage(actions, proposal);
  const proposalIds = actions.map((action) => action.id);
  if (proposal.baseRevision !== input.state.revision) throw new Error("transition has a stale base revision");

  const historicalAgentIds = new Set([
    ...Object.keys(input.state.historyBase?.agents ?? {}),
    ...Object.keys(input.state.agents),
    ...input.state.history.flatMap((step) => step.operations
      .filter((operation) => operation.kind === "create_agent")
      .map((operation) => operation.agent.id)),
  ]);
  const historicalAgentEntities = new Set([
    ...Object.values(input.state.historyBase?.agents ?? {}).map((agent) => agent.entityId),
    ...Object.values(input.state.agents).map((agent) => agent.entityId),
    ...input.state.history.flatMap((step) => step.operations
      .filter((operation) => operation.kind === "create_agent")
      .map((operation) => operation.agent.entityId)),
  ]);
  for (const operation of proposal.operations) {
    if (operation.kind !== "create_agent") continue;
    if (historicalAgentIds.has(operation.agent.id)) {
      throw new Error(`agent identity was already used: ${operation.agent.id}`);
    }
    if (historicalAgentEntities.has(operation.agent.entityId)) {
      throw new Error(`agent entity was already bound: ${operation.agent.entityId}`);
    }
    historicalAgentIds.add(operation.agent.id);
    historicalAgentEntities.add(operation.agent.entityId);
  }

  const createdEntityIds = new Set(proposal.operations
    .filter((operation) => operation.kind === "create_entity")
    .map((operation) => operation.entity.id));
  const profiledEntityIds = proposal.mechanicInvocations
    .filter((invocation) => invocation.packageId === "core-resolution")
    .flatMap((invocation) => {
      if (invocation.ruleId === "instantiate-entity-profile") {
        const entityId = (invocation.input as { entityId?: unknown }).entityId;
        return typeof entityId === "string" ? [entityId] : [];
      }
      if (invocation.ruleId === "instantiate-entity-cohort") {
        const entityIds = (invocation.input as { entityIds?: unknown }).entityIds;
        return Array.isArray(entityIds) ? entityIds.filter((entityId): entityId is string => typeof entityId === "string") : [];
      }
      return [];
    });
  if (new Set(profiledEntityIds).size !== profiledEntityIds.length) {
    throw new Error("a transition can instantiate at most one mechanics profile per entity");
  }
  for (const operation of proposal.operations) {
    if (operation.kind === "create_agent" && createdEntityIds.has(operation.agent.entityId) &&
      !profiledEntityIds.includes(operation.agent.entityId)) {
      throw new Error(`new Agent entity ${operation.agent.entityId} requires an entity mechanics profile`);
    }
  }

  const eventIds = new Set(input.state.truth.events.map((event) => event.id));
  const proposedEventIds = new Set<string>();
  for (const event of proposal.events) {
    if (eventIds.has(event.id) || proposedEventIds.has(event.id)) throw new Error(`duplicate event id ${event.id}`);
    if (event.step !== input.state.step + 1) throw new Error(`event ${event.id} has invalid step`);
    proposedEventIds.add(event.id);
  }

  const allowed: Record<CausalRef["kind"], Set<string>> = {
    action: new Set(proposalIds),
    check: new Set(checks.map((check) => check.requestId)),
    random: new Set(randomResults.map((result) => result.requestId)),
    event: eventIds,
    fact: new Set(Object.keys(input.state.truth.facts)),
    law: new Set(input.definition.laws.map((law) => law.id)),
    mechanic: new Set(),
  };
  for (const invocation of proposal.mechanicInvocations) {
    for (const cause of invocation.causes) validateCausalReference(cause, allowed, `mechanic ${invocation.id}`);
    allowed.mechanic.add(invocation.id);
  }
  for (const event of proposal.events) {
    for (const cause of event.causes) validateCausalReference(cause, allowed, `event ${event.id}`);
    allowed.event.add(event.id);
  }
  for (const operation of proposal.operations) {
    for (const cause of operation.causes) validateCausalReference(cause, allowed, operation.kind);
    if ((operation.kind === "produce_quantity" || operation.kind === "consume_quantity") &&
      !allowed.law.has(operation.lawId)) {
      throw new Error(`${operation.kind} references unknown law ${operation.lawId}`);
    }
  }
  for (const outcome of proposal.outcomes) {
    for (const cause of outcome.causeRefs) validateCausalReference(cause, allowed, `outcome ${outcome.proposalId}`);
  }

  for (const action of actions) {
    const outcome = proposal.outcomes.find((candidate) => candidate.proposalId === action.id)!;
    const receipt = resolutionReceipts.find((candidate) => candidate.plan.actionId === action.id);
    if (!receipt || outcome.status !== expectedActionStatus(receipt)) {
      throw new Error(`outcome for ${action.id} contradicts its resolution receipt`);
    }
    if ((outcome.status === "failed" || outcome.status === "blocked") && !outcome.summary.trim()) {
      throw new Error(`failed outcome for ${action.actorId} requires an understandable summary`);
    }
    const belief = input.state.agents[action.actorId]?.belief;
    for (const alternative of outcome.knownAlternatives) {
      if (alternative.basis.kind === "knowledge") {
        for (const evidenceId of alternative.basis.evidenceIds) {
          if (!belief?.evidence[evidenceId]) {
            throw new Error(`outcome alternative for ${action.actorId} references unknown evidence ${evidenceId}`);
          }
        }
      }
    }
  }
}


/** Observation-dependent checks stay after rendering, including each actor's
 * evidence IDs. Effects and receipt constraints do not require model work. */
function validateTransitionObservations(input: TruthPreparationInput, actions: readonly AgentActionProposal[], proposal: TransitionProposal): void {
  const eventIds = new Set([...input.state.truth.events, ...proposal.events].map((event) => event.id));
  for (const observation of proposal.observations) {
    if (observation.kind !== "outcome") throw new Error(`transition observation ${observation.id} is not an outcome`);
    for (const eventId of observation.sourceEventIds) {
      if (!eventIds.has(eventId)) throw new Error(`observation ${observation.id} references unknown event ${eventId}`);
    }
  }
  for (const action of actions) {
    const outcome = proposal.outcomes.find((candidate) => candidate.proposalId === action.id)!;
    const observationIds = new Set(proposal.observations
      .filter((packet) => packet.observerId === action.actorId)
      .map((packet) => packet.id));
    for (const alternative of outcome.knownAlternatives) {
      if (alternative.basis.kind === "observation" && !observationIds.has(alternative.basis.observationId)) {
        throw new Error(`outcome alternative for ${action.actorId} references unknown observation ${alternative.basis.observationId}`);
      }
    }
  }
}

export class TruthEngine {
  private readonly mechanicalPlanRepair: boolean;
  private readonly planRandomCompletion: boolean;
  private readonly includeResolutionMeansSources: boolean;
  private readonly includePlanCauseScope: boolean;
  private readonly includeResolutionFactEvidence: boolean;
  private readonly includeActivityTemporalEvidence: boolean;
  private readonly repairAttempts: number;
  private readonly maxCommitmentRounds: number;
  private readonly rulePackages: RulePackageRegistry;

  constructor(
    private readonly provider: StructuredModelProvider,
    options: TruthEngineOptions = {},
  ) {
    if (options.mechanicalPlanRepair !== undefined && options.mechanicalPlanRepair !== MECHANICAL_PLAN_REPAIR) throw new Error("unknown mechanical plan repair contract");
    this.mechanicalPlanRepair = options.mechanicalPlanRepair === MECHANICAL_PLAN_REPAIR;
    if (options.planRandomCompletion !== undefined && options.planRandomCompletion !== PLAN_RANDOM_COMPLETION) throw new Error("unknown plan random completion contract");
    this.planRandomCompletion = options.planRandomCompletion === PLAN_RANDOM_COMPLETION;
    this.includeActivityTemporalEvidence = options.includeActivityTemporalEvidence ?? false;
    this.includeResolutionMeansSources = options.includeResolutionMeansSources ?? false;
    this.includePlanCauseScope = options.includePlanCauseScope ?? false;
    this.includeResolutionFactEvidence = options.includeResolutionFactEvidence ?? false;
    this.repairAttempts = options.repairAttempts ?? 2;
    this.maxCommitmentRounds = options.maxCommitmentRounds ?? MAX_COMMITMENT_ROUNDS_PER_STEP;
    if (!Number.isSafeInteger(this.maxCommitmentRounds) || this.maxCommitmentRounds < 0 ||
      this.maxCommitmentRounds > MAX_COMMITMENT_ROUNDS_PER_STEP) {
      throw new Error(`maxCommitmentRounds must be an integer from 0 to ${MAX_COMMITMENT_ROUNDS_PER_STEP}`);
    }
    this.rulePackages = options.rulePackages ?? createCoreRulePackageRegistry();
  }

  async perceiveOnset(
    input: Readonly<OnsetPerceptionInput>,
    scope: ModelExecutionScope,
  ): Promise<OnsetPerceptionResult> {
    if (input.temporalBoundary.fromElapsedSeconds !== input.state.truth.elapsedSeconds ||
      input.temporalBoundary.toElapsedSeconds !== input.state.truth.elapsedSeconds + input.temporalBoundary.deltaSeconds ||
      !Number.isSafeInteger(input.temporalBoundary.deltaSeconds) || input.temporalBoundary.deltaSeconds <= 0) {
      throw new Error("onset perception requires an engine-selected future temporal boundary");
    }
    return runOnsetPerceptionStage({
      ...structuredClone(input),
      provider: this.provider,
      repairAttempts: this.repairAttempts,
      maxCommitmentRounds: this.maxCommitmentRounds,
      scope,
    });
  }

  async resolveBatch(
    inputs: readonly TruthResolutionInput[],
    scope: ModelExecutionScope,
  ): Promise<TruthResolution[]> {
    if (inputs.length === 0) return [];
    return Promise.all(inputs.map((input) => this.resolve(input, scope)));
  }

  get candidateRepairLimit(): number { return this.repairAttempts; }

  async resolve(input: TruthResolutionInput, scope: ModelExecutionScope): Promise<TruthResolution> {
    const session = this.prepare(input, scope);
    const observationAudits: ModelExecutionAudit[] = [];
    const verifierAudits: ModelExecutionAudit[] = [];
    let observationRepairRounds = 0;
    let previousReport: CausalVerification | null = null;
    try {
      let pending = await session.next();
      while (!pending.done) {
        const stage = pending.value;
        const candidate = stage.resolution;
        const proposal = candidate.proposal;
        const actions = candidate.actions;
        let assertionResults = candidate.causalAssertionResults;
        try {
          const rendered = await input.renderObservations(proposal, actions, stage.transitionAttempt);
          proposal.observations = structuredClone(rendered.packets);
          observationAudits.push(...structuredClone(rendered.modelAudits));
          validateTransitionObservations(input, actions, proposal);
          input.validateProposal(proposal, candidate.checks, candidate.randomResults, actions, candidate.stimulusObservations);
          while (true) {
            const evidence: CausalReviewEvidence = { ...stage.reviewEvidence, proposal, assertionResults, previousReport };
            const verification = await this.reviewCandidate(evidence, scope, input.identityOwner,
              stage.reviewInvocationOffset + verifierAudits.reduce((count, audit) => count + audit.invocations.length, 0));
            verifierAudits.push(verification.audit);
            if (verification.value.verdict === "accept") {
              assertCausalReviewMatches(evidence, verification);
              const completed = await session.next({ kind: "finish" });
              if (!completed.done || !completed.value) throw new Error("truth candidate session did not finish");
              return {
                ...completed.value,
                proposal,
                causalAssertionResults: assertionResults,
                causalVerification: verification.value,
                modelAudits: [...completed.value.modelAudits, ...observationAudits, ...combineCompatibleModelAudits(verifierAudits)],
              };
            }
            previousReport = structuredClone(verification.value);
            const observationFindings = verification.value.findings.filter(finding => finding.target.kind === "observation");
            const onlyObserverFindings = observationFindings.length === verification.value.findings.length &&
              observationFindings.length > 0 && observationRepairRounds < this.repairAttempts;
            if (!onlyObserverFindings) {
              throw new Error(`causal verifier rejected transition: ${verification.value.findings
                .map(finding => `${finding.code}: ${finding.message}; ${finding.repairHint}`).join(" | ")}`);
            }
            const targetObservationIds = new Set(observationFindings.map(finding => finding.target.id));
            const targetObserverIds = proposal.observations
              .filter(observation => targetObservationIds.has(observation.id)).map(observation => observation.observerId);
            if (targetObserverIds.length !== targetObservationIds.size) {
              throw new Error("causal verifier observation target is not present in the candidate");
            }
            const repaired = await input.renderObservations(proposal, actions,
              stage.transitionAttempt + observationRepairRounds + 1, [...new Set(targetObserverIds)].sort());
            const targetObservers = new Set(targetObserverIds);
            proposal.observations = [...proposal.observations.filter(observation => !targetObservers.has(observation.observerId)),
              ...structuredClone(repaired.packets)]
              .sort((left, right) => left.observerId.localeCompare(right.observerId) || left.id.localeCompare(right.id));
            observationAudits.push(...structuredClone(repaired.modelAudits));
            validateTransitionEffects(input, actions, proposal, candidate.checks, candidate.randomResults, candidate.resolutionReceipts);
            validateTransitionObservations(input, actions, proposal);
            assertionResults = evaluateProposalCausality(input.state, candidate.checks, candidate.randomResults, proposal);
            input.validateProposal(proposal, candidate.checks, candidate.randomResults, actions, candidate.stimulusObservations);
            observationRepairRounds += 1;
          }
        } catch (error) {
          pending = await session.next({ kind: "repair", error, previousReport });
          if (pending.done) throw error;
        }
      }
      throw new Error("truth candidate session returned no reviewed resolution");
    } finally {
      await session.return(undefined);
    }
  }

  async reviewCandidate(
    evidence: CausalReviewEvidence,
    scope: ModelExecutionScope,
    subjectId: string,
    invocationOffset = 0,
  ): Promise<BoundCausalReview> {
    const snapshot = structuredClone(evidence);
    const binding = { evidenceHash: contentHash(snapshot), promptVersion: promptBundle("causal-verifier").version };
    const materialize = (report: ModelCausalVerification) => materializeCausalVerification({
      definition: snapshot.definition,
      state: snapshot.workset.state,
      actions: [...new Map([...snapshot.workset.initialActions, ...snapshot.workset.availableActions]
        .map(action => [action.id, action])).values()],
      resolutionPlans: snapshot.resolutionPlans,
      mechanicContracts: snapshot.mechanicContracts,
      checkRequests: snapshot.checkRequests,
      randomRequests: snapshot.randomRequests,
      proposal: snapshot.proposal,
      report,
    });
    const generated = await generateValidated({
      provider: this.provider,
      profileId: snapshot.definition.modelProfiles.causalVerifier,
      role: "causal-verifier",
      subjectId,
      promptId: "causal-verifier",
      schemaName: "causal_verification",
      schema: causalVerificationSchema,
      scope,
      buildContext: issues => structuredClone(buildCausalVerificationContext({ ...snapshot, issues })),
      validate: report => { if (report.verdict === "reject") materialize(report); },
      repairAttempts: this.repairAttempts,
      invocationOffset,
      repairScope: "component",
      targetIds: snapshot.workset.assignedActions.map(action => action.id),
    });
    return { value: materialize(generated.value), audit: generated.audit, binding };
  }

  async *prepare(input: TruthPreparationInput, scope: ModelExecutionScope): TruthCandidateSession {
    if (input.orderedRandom && input.enableReactionRouting !== false) {
      throw new Error("ordered random acquisition requires closed reaction routing");
    }
    const truthSubject = input.identityOwner;
    let actions = input.initialActions.map((action) => structuredClone(action));
    let groundings = input.groundings.map((grounding) => structuredClone(grounding));
    if (input.temporalBoundary.fromElapsedSeconds !== input.state.truth.elapsedSeconds ||
      input.temporalBoundary.toElapsedSeconds !== input.state.truth.elapsedSeconds + input.temporalBoundary.deltaSeconds ||
      !Number.isSafeInteger(input.temporalBoundary.deltaSeconds) || input.temporalBoundary.deltaSeconds <= 0) {
      throw new Error("truth resolution requires an engine-selected future temporal boundary");
    }
    const allowedForCommitments: Record<CausalRef["kind"], Set<string>> = {
      action: new Set(actions.map((action) => action.id)),
      check: new Set(),
      random: new Set(),
      event: new Set(input.state.truth.events.map((event) => event.id)),
      fact: new Set(Object.keys(input.state.truth.facts)),
      law: new Set(input.definition.laws.map((law) => law.id)),
      mechanic: new Set(),
    };
    let rng = structuredClone(input.state.truth.rng);
    const checks: D20CheckResult[] = [];
    const requests: D20CheckRequest[] = [];
    const requestIds = new Set<string>();
    const checkAliases = new Map<string, string | null>();
    const randomRequests: DiscreteRandomRequest[] = [];
    const randomResults: DiscreteRandomResult[] = [];
    const commitmentRounds: CommitmentRound[] = [];
    const randomRequestIds = new Set(input.state.history.flatMap((step) =>
      step.randomRequests.map((request) => request.id)));
    const randomAliases = new Map<string, string | null>();
    let resolutionPlans: ResolutionPlan[] = [];
    let resolutionReceipts: ResolutionReceipt[] = [];
    let reactionRequests: ReactionRequest[] = [];
    let reactionDecisions: ReactionDecision[] = [];
    let reactionModelAudits: ModelExecutionAudit[] = [];
    const modelAudits: ModelExecutionAudit[] = [];
    let randomRngDrawsBefore: number | null = null;
    const mechanicContracts = this.rulePackages.promptContracts(input.definition.rulePackages)
      .filter((contract) => !(contract.packageId === "core-resolution" &&
        (contract.ruleId === "apply-receipt" || contract.ruleId === "advance-conditions")));
    const mechanicIdentity = (reference: ModelReference): { packageId: string; ruleId: string } => {
      if (isProposalReference(reference)) {
        throw new Error(`mechanicRef cannot be a proposal: ${reference.proposalKey}`);
      }
      const resolver = createTruthReferenceResolver({
        state: input.state,
        definition: input.definition,
        actions,
        mechanicContracts,
      });
      const resolved = resolver.resolve(reference, "mechanic");
      if (resolved.kind !== "mechanic") throw new Error(`mechanicRef ${reference} is ${resolved.kind}, expected mechanic`);
      const separator = resolved.engineId.indexOf("::");
      if (separator <= 0 || separator === resolved.engineId.length - 2) {
        throw new Error(`mechanicRef ${reference} does not identify an authored mechanic contract`);
      }
      return { packageId: resolved.engineId.slice(0, separator), ruleId: resolved.engineId.slice(separator + 2) };
    };

    const truthContext = (
      stage: "perception" | "reaction-routing" | "resolution" | "transition",
      issues: readonly PromptValidationIssue[],
      resolutionScopeOverride?: ResolutionScope,
      repairTarget?: {
        kind: "mechanic" | "plan" | "operation" | "event" | "outcome" | "observation";
        id: string;
        issueClass: string;
      },
      candidateResolutionPlans?: readonly ResolutionPlan[],
    ) => {
      const selectedActionIds = new Set(
        (resolutionScopeOverride?.selectedActionIds ?? actions.map((action) => action.id)),
      );
      return buildTruthContext({
        includeResolutionMeansSources: this.includeResolutionMeansSources,
        includeResolutionFactEvidence: this.includeResolutionFactEvidence,
        ...(this.includePlanCauseScope && stage === "resolution" ? { planCauseActionIds: [...allowedForCommitments.action] } : {}),
        ...(this.includeActivityTemporalEvidence ? { temporalEvidence: input.temporalBoundary } : {}),
        definition: input.definition,
        state: input.state,
        workset: {
          state: input.modelWorkset?.state ?? input.state,
          mode: input.modelWorkset ? "full" : "scoped",
          initialActions: input.modelWorkset?.initialActions ?? input.initialActions,
          availableActions: input.modelWorkset?.availableActions ?? actions,
          assignedActions: actions.filter((action) => selectedActionIds.has(action.id)),
          availableDependencies: input.modelWorkset?.availableDependencies ?? groundings,
          assignedDependencies: groundings.filter((grounding) =>
            grounding.kind !== "action" || selectedActionIds.has(grounding.id)),
        },
        reactionRequests,
        reactionDecisions,
        reactionWindow: stage === "perception" || stage === "reaction-routing" ? "open" : "closed",
        committedCheckRequests: requests,
        checkResults: checks,
        committedRandomRequests: randomRequests,
        randomResults,
        commitmentRounds,
        resolutionPlans,
        resolutionReceipts,
        temporalBoundary: input.temporalBoundary,
        instanceId: scope.workloadId,
        advanceId: scope.batchId,
        issues,
        stage,
        resolutionScope: resolutionScopeOverride ?? input.resolutionScope ?? {
          mode: "component",
          selectedActionIds: actions.map((action) => action.id).sort(),
          totalActionCount: actions.length,
        },
        candidateResolutionPlans,
        mechanicContracts: stage === "transition" ? mechanicContracts : undefined,
        repairTarget: repairTarget ?? null,
      });
    };

    const repairMechanicInvocation = async (
      target: ModelTransitionProposalDraft["mechanicInvocations"][number],
      failure: MechanicInputValidationError,
    ): Promise<ModelTransitionProposalDraft["mechanicInvocations"][number]> => {
      const selectedActionIds = actions.map((action) => action.id);
      const repairActions = selectedActionIds.length > 0
        ? selectedActionIds
        : actions.map((action) => action.id).sort();
      const mechanicLogicalInvocationId = modelInvocationLogicalId(
        scope,
        "truth-transition",
        `${truthSubject}:mechanic:${target.proposalKey}`,
      );
      const result = await runSemanticRepairLoop({
        role: "truth-transition",
        repairScope: "invocation",
        targetIds: [target.proposalKey],
        maxRepairs: this.repairAttempts,
        logicalInvocationId: mechanicLogicalInvocationId,
        invoke: async (repairContext) => {
          const repairIssues = repairContext.issues.length > 0
            ? repairContext.issues
            : [semanticIssue("mechanic_input_contract", failure.message, {
              class: "mechanic",
              path: ["mechanicInvocations", target.proposalKey, ...failure.issues[0]?.path ?? []],
              targetIds: [target.proposalKey],
            })];
          const issues: PromptValidationIssue[] = repairIssues.map((issue) => ({
            code: issue.code,
            path: issue.path,
            message: issue.message,
          }));
          const context = {
            ...(truthContext(
              "transition",
              issues,
              {
                mode: "repair",
                selectedActionIds: repairActions,
                totalActionCount: actions.length,
              },
              { kind: "mechanic", id: target.proposalKey, issueClass: "mechanic" },
            ) as Record<string, unknown>),
            mechanicRepair: {
              targetInvocation: structuredClone(target),
              mechanicRef: structuredClone(target.mechanicRef),
              invalidInput: structuredClone(target.input),
            },
          };
          const invocation = transitionAudits.reduce((count, audit) =>
            count + audit.invocations.length, 0) + repairContext.attempt + 1;
          // Keep the execution identity stable so the transition stage can
          // combine its normal and invocation-repair audits deterministically.
          const identity = modelInvocationIdentity(scope, "truth-transition", truthSubject, invocation);
          const correlation = modelInvocationCorrelation(scope, "truth-transition", truthSubject, identity, {
            logicalInvocationId: repairContext.logicalInvocationId ?? mechanicLogicalInvocationId,
            semanticRepairAttempt: repairContext.attempt,
            ...(repairContext.parentInvocationId ? {
              parentInvocationId: repairContext.parentInvocationId,
              repairOf: repairContext.repairOf,
            } : {}),
          });
          const prompt = promptBundle("truth-transition");
          const generated = await this.provider.generateStructured({
            profileId: input.definition.modelProfiles.transition,
            workloadId: scope.workloadId,
            batchId: scope.batchId,
            abortSignal: scope.abortSignal,
            cancelPendingSignal: scope.cancelPendingSignal,
            correlation,
            observer: scope.observer,
            ...identity,
            role: "truth-transition",
            subjectId: truthSubject,
            promptVersion: prompt.version,
            schemaName: "truth_transition_mechanic_repair",
            system: prompt.system,
            userPrompt: prompt.userPrompt,
            context,
            schema: mechanicInvocationRepairSchema,
          });
          setModelInvocationResultKind(generated.audit, "truth-transition_mechanic-repair");
          return generated;
        },
        validate: (value) => {
          const repaired = value.invocation;
          if (repaired.proposalKey !== target.proposalKey) throw new Error(`mechanic repair changed invocation proposalKey to ${repaired.proposalKey}`);
          if (JSON.stringify(repaired.mechanicRef) !== JSON.stringify(target.mechanicRef)) {
            throw new Error("mechanic repair changed the invocation contract identity");
          }
          const { packageId, ruleId } = mechanicIdentity(repaired.mechanicRef);
          this.rulePackages.validateInvocationInputs(input.definition.rulePackages, [{
            id: repaired.proposalKey,
            packageId,
            ruleId,
            input: runtimeMechanicInputShape(repaired.input),
            causes: [],
            assertions: [],
          }]);
        },
        classify: (error) => {
          if (error instanceof MechanicInputValidationError) {
            return error.issues.map((issue) => semanticIssue(
              "mechanic_input_contract",
              issue.message,
              { class: "mechanic", path: issue.path, targetIds: [target.proposalKey] },
            ));
          }
          return validationIssues(error).map((issue) => semanticIssue(
            issue.code,
            issue.message,
            { class: "mechanic", path: issue.path, targetIds: [target.proposalKey] },
          ));
        },
      });
      transitionAudits.push(result.audit);
      return result.value.invocation;
    };

    let componentRandomStateAcquired = false;
    let componentRandomStateFinished = false;
    const acquireComponentRandomState = async (): Promise<void> => {
      if (componentRandomStateFinished) throw new Error("random commitments are already closed");
      if (input.orderedRandom && !componentRandomStateAcquired) {
        rng = await input.orderedRandom.acquire();
        componentRandomStateAcquired = true;
      }
      scope.cancelPendingSignal?.throwIfAborted();
    };
    const commitCheckRound = async (round: readonly D20CheckRequest[]) => {
      await acquireComponentRandomState();
      const resolved = resolveD20Checks(rng, round);
      rng = resolved.rng;
      requests.push(...structuredClone(round));
      checks.push(...resolved.results);
      for (const request of round) {
        requestIds.add(request.id);
        allowedForCommitments.check.add(request.id);
      }
      commitmentRounds.push({
        kind: "check",
        phase: round[0]!.phase,
        requestIds: round.map((request) => request.id),
      });
    };

    const normalizeRandomRound = (
      round: readonly DiscreteRandomRequestProposal[],
    ): DiscreteRandomRequest[] => {
      if (commitmentRounds.length >= this.maxCommitmentRounds) {
        throw new Error("maximum commitment rounds exceeded");
      }
      if (round.length > MAX_RANDOM_REQUESTS_PER_ROUND) {
        throw new Error("discrete random round exceeds request limit");
      }
      const aliases = new Map<string, string>();
      for (const [ordinal, request] of round.entries()) {
        if (aliases.has(request.proposalKey)) throw new Error(`duplicate random request proposalKey ${request.proposalKey}`);
        const canonicalId = runtimeId({
          worldHash: input.state.worldHash,
          revision: input.state.revision,
          kind: "random",
          stage: "resolution",
          owner: input.identityOwner,
          round: commitmentRounds.length,
          ordinal,
        });
        aliases.set(request.proposalKey, canonicalId);
      }
      const resolver = createTruthReferenceResolver({
        state: input.state,
        definition: input.definition,
        actions,
        checkRequests: requests,
        randomRequests,
      });
      const resolveCause = (cause: ModelCausalRef, requestProposalKey: string): CausalRef => {
        if (isProposalReference(cause.ref)) {
          throw new Error(`random request ${requestProposalKey} cannot use new proposal ${cause.ref.proposalKey} as a cause; select an existing handle`);
        }
        const resolved = resolver.resolve(cause.ref, "cause");
        if (resolved.kind !== cause.kind) {
          throw new Error(`random request ${requestProposalKey} expected ${cause.kind} cause, got ${resolved.kind}`);
        }
        return { kind: cause.kind, id: resolved.engineId };
      };
      const normalized = round.map((request) => {
        const canonicalId = aliases.get(request.proposalKey)!;
        const distributionRef = request.distributionRef;
        if (isProposalReference(distributionRef)) {
          throw new Error(`random request ${request.proposalKey} must select an existing random distribution handle`);
        }
        const distribution = resolver.resolve(distributionRef, "distribution");
        if (distribution.kind !== "random_distribution") {
          throw new Error(`random request ${request.proposalKey} expected a random distribution reference, got ${distribution.kind}`);
        }
        const definition = input.definition.randomDistributions.find((candidate) => candidate.id === distribution.engineId);
        if (!definition) {
          throw new Error(`random request ${canonicalId} references unknown distribution ${distribution.engineId}`);
        }
        const causes = request.causes.map((cause) => resolveCause(cause, request.proposalKey));
        if (randomRequestIds.has(canonicalId)) {
          throw new Error(`duplicate random request ${canonicalId}`);
        }
        for (const cause of causes) {
          validateCausalReference(cause, allowedForCommitments, `random request ${canonicalId}`);
        }
        return {
          id: canonicalId,
          distributionId: definition.id,
          causes,
          distribution: structuredClone(definition),
        };
      });
      validateDiscreteRandomCommitmentBudget([...randomRequests, ...normalized]);
      return normalized;
    };

    const commitRandomRound = async (round: readonly DiscreteRandomRequest[]) => {
      await acquireComponentRandomState();
      const resolved = resolveDiscreteRandomRequests(rng, round);
      const firstRandomDraw = randomRngDrawsBefore ?? rng.draws;
      validateDiscreteRandomCommitmentBudget(
        [...randomRequests, ...round],
        [...randomResults, ...resolved.results],
        resolved.rng.draws - firstRandomDraw,
      );
      randomRngDrawsBefore = firstRandomDraw;
      rng = resolved.rng;
      randomRequests.push(...structuredClone(round));
      randomResults.push(...resolved.results);
      for (const request of round) {
        randomRequestIds.add(request.id);
        allowedForCommitments.random.add(request.id);
      }
      commitmentRounds.push({ kind: "random", requestIds: round.map((request) => request.id) });
    };

    const registerRandomAliases = (
      draft: readonly DiscreteRandomRequestProposal[],
      normalized: readonly DiscreteRandomRequest[],
    ): void => {
      draft.forEach((request, index) => {
        const canonicalId = normalized[index]!.id;
        randomAliases.set(request.proposalKey, randomAliases.has(request.proposalKey) ? null : canonicalId);
      });
    };

    if (input.enableReactionRouting !== false) {
      const perception = await this.perceiveOnset({
        definition: input.definition,
        state: input.state,
        actions,
        temporalBoundary: input.temporalBoundary,
        identityOwner: input.identityOwner,
        groundings,
      }, scope);
      rng = structuredClone(perception.rng);
      requests.push(...structuredClone(perception.requests));
      checks.push(...structuredClone(perception.checks));
      commitmentRounds.push(...structuredClone(perception.commitmentRounds));
      perception.requests.forEach((request) => {
        requestIds.add(request.id);
        allowedForCommitments.check.add(request.id);
      });
      perception.aliases.forEach(([alias, canonicalId]) => checkAliases.set(alias, canonicalId));
      modelAudits.push(structuredClone(perception.modelAudit));

      const routing = await generateValidated({
        provider: this.provider,
        profileId: input.definition.modelProfiles.reactionRouting,
        role: "truth-reaction-routing",
        subjectId: truthSubject,
        promptId: "truth-reaction-routing",
        schemaName: "truth_reaction_routing",
        schema: reactionRoutingOutputSchema,
        scope,
        buildContext: (issues) => truthContext("reaction-routing", issues),
        validate: (output) => validateReactionRequests(
          input,
          materializeReactionRequests(input, output.requests, requests),
          requests,
          checks,
        ),
        repairAttempts: this.repairAttempts,
        repairScope: "step",
        targetIds: actions.map((action) => action.id),
      });
      modelAudits.push(routing.audit);
      reactionRequests = materializeReactionRequests(input, routing.value.requests, requests);
      if (reactionRequests.length > 0) {
        try {
          const resolved = await input.resolveReactions(reactionRequests);
          reactionDecisions = structuredClone(resolved.decisions);
          reactionModelAudits = structuredClone(resolved.modelAudits);
          actions = applyReactionDecisions(input, reactionRequests, reactionDecisions);
          const replacedActorIds = new Set(reactionDecisions
            .filter((decision) => decision.kind === "replace")
            .map((decision) => decision.agentId));
          const groundedActorIds = new Set(resolved.groundings.flatMap((grounding) =>
            grounding.actorId === null ? [] : [grounding.actorId]));
          if (resolved.groundings.length !== replacedActorIds.size ||
            groundedActorIds.size !== replacedActorIds.size ||
            [...replacedActorIds].some((actorId) => !groundedActorIds.has(actorId)) ||
            resolved.groundings.some((grounding) => {
              const action = actions.find((candidate) => candidate.actorId === grounding.actorId);
              return grounding.actorId === null || !action || !replacedActorIds.has(grounding.actorId) ||
                grounding.kind !== "action" || grounding.id !== action.id;
            })) {
            throw new Error("reaction replacement groundings do not cover replaced actions");
          }
          groundings = [
            ...groundings.filter((grounding) => grounding.actorId === null ||
              !replacedActorIds.has(grounding.actorId)),
            ...resolved.groundings.map((grounding) => structuredClone(grounding)),
          ].sort((left, right) => left.id.localeCompare(right.id));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ReactionExecutionError(`reaction execution failed: ${message}`, { cause: error });
        }
        allowedForCommitments.action = new Set(actions.map((action) => action.id));
      }
    }

    const resolutionAudits: ModelExecutionAudit[] = [];
    const resolutionPlanVerifierAudits: ModelExecutionAudit[] = [];
    const resolutionRepairAudits: ModelExecutionAudit[] = [];
    let resolutionPlanIssues: PromptValidationIssue[] = [];
    let resolutionPlanRepairs = 0;
    let lastPlanDrafts: ResolutionPlanDraft[] = [];
    const planReferenceResolver = createTruthReferenceResolver({
      state: input.state,
      definition: input.definition,
      actions,
      checkRequests: requests,
    });
    const draftActionId = (draft: ResolutionPlanDraft): string => {
      if (isProposalReference(draft.actionRef)) throw new Error(`resolution plan actionRef cannot be a proposal`);
      const resolved = planReferenceResolver.resolve(draft.actionRef, "source");
      if (resolved.kind !== "action") throw new Error(`resolution plan actionRef must reference an action`);
      return resolved.engineId;
    };
    const planningRepairSourceHash = () => contentHash({ state: input.state, definition: input.definition, actions, groundings,
      requests, checks, commitmentRounds, temporalBoundary: input.temporalBoundary });
    const planningRepairSourceBinding = this.mechanicalPlanRepair ? planningRepairSourceHash() : "";
    let initialPlanCalls = 0;
    let pendingPlanVerification: {
      plans: ResolutionPlan[];
      checks: D20CheckRequest[];
      audit: ModelExecutionAudit;
    } | null = null;
    while (true) {
      let acceptedPlans: ResolutionPlan[] = [];
      let acceptedPlanChecks: D20CheckRequest[] = [];
      let acceptedRandom: DiscreteRandomRequest[] | null = null;
      let continuationFromTargetedRepair = false;
      let call: { value: z.infer<typeof resolutionDirectiveSchema>; audit: ModelExecutionAudit };
      if (pendingPlanVerification) {
        acceptedPlans = structuredClone(pendingPlanVerification.plans);
        acceptedPlanChecks = structuredClone(pendingPlanVerification.checks);
        call = {
          value: { kind: "commit_plans", plans: [] },
          audit: pendingPlanVerification.audit,
        };
        pendingPlanVerification = null;
        continuationFromTargetedRepair = true;
      } else try {
        const directiveSchema = (resolutionPlans.length === 0
          ? this.planRandomCompletion ? declaredRandomPlanSchema : resolutionPlanCommitDirectiveSchema
          : resolutionContinuationDirectiveSchema) as z.ZodType<z.infer<typeof resolutionDirectiveSchema>>;
        call = await generateValidated<z.infer<typeof resolutionDirectiveSchema>>({
          provider: this.provider,
          profileId: input.definition.modelProfiles.resolution,
          role: "truth-resolution",
          subjectId: truthSubject,
          promptId: "truth-resolution",
          schemaName: resolutionPlans.length === 0
            ? "truth_resolution_plan_commit"
            : "truth_resolution_continuation",
          schema: directiveSchema,
          ...(this.mechanicalPlanRepair && resolutionPlans.length === 0 ? {
            projectRepair: (repair: SemanticRepairContext, context: unknown) => {
              const selection = selectMechanicalPlanRepair({ repair, schema: directiveSchema,
                actionIds: actions.map(action => action.id), actionIdFor: draftActionId,
                sourceHash: planningRepairSourceHash, expectedSourceHash: planningRepairSourceBinding });
              if (!selection) return undefined;
              const issues = repair.issues.map(issue => ({ ...issue, path: [...issue.path] }));
              const scoped = truthContext("resolution", [...resolutionPlanIssues, ...issues], {
                mode: "repair", selectedActionIds: selection.selectedActionIds, totalActionCount: actions.length });
              return { context: bindMechanicalPlanRepairContext(context, selection.binding, scoped), merge: selection.merge, evidence: selection.binding };
            },
          } : {}),
          ...(this.planRandomCompletion && resolutionPlans.length === 0 ? {
            promptExtension: { version: PLAN_RANDOM_COMPLETION, userPrompt: PLAN_RANDOM_COMPLETION_PROMPT },
          } : {}),
          scope,
          buildContext: (issues) => {
            if (resolutionPlans.length === 0) initialPlanCalls += 1;
            return truthContext("resolution", [...resolutionPlanIssues, ...issues]);
          },
          validate: (directive) => {
            if (directive.kind === "commit_plans") {
              if (resolutionPlans.length > 0) throw new Error("resolution plans are already committed");
              lastPlanDrafts = structuredClone(directive.plans);
              acceptedPlans = materializeResolutionPlans({
                state: input.state,
                definition: input.definition,
                actions,
                groundings,
                identityOwner: input.identityOwner,
                drafts: directive.plans,
                allowedCauses: allowedForCommitments,
              });
              if (acceptedPlans.some((plan) => plan.mode === "check") &&
                commitmentRounds.length >= this.maxCommitmentRounds) {
                throw new Error("maximum commitment rounds exceeded");
              }
              acceptedPlanChecks = checkRequestsForPlans({
                state: input.state,
                plans: acceptedPlans,
                identityOwner: input.identityOwner,
                round: commitmentRounds.length,
                allowedCauses: allowedForCommitments,
                maximumVisibility: input.definition.disclosure.defaultCheckVisibility,
              });
            } else if (directive.kind === "request_random") {
              if (resolutionPlans.length === 0) throw new Error("resolution plans must be committed before random requests");
              acceptedRandom = normalizeRandomRound(directive.requests);
            } else if (resolutionPlans.length === 0) {
              throw new Error("resolution plans must be committed before resolution can finish");
            }
          },
          repairAttempts: this.repairAttempts,
          invocationOffset: resolutionAudits.reduce((count, audit) => count + audit.invocations.length, 0),
          repairScope: "component",
          targetIds: actions.map((action) => action.id),
        });
      } catch (error) {
        const cardinality = cardinalityError(error);
        if (!cardinality || actions.length <= 1 || resolutionPlans.length > 0 || lastPlanDrafts.length === 0) {
          throw error;
        }

        const allActionIds = new Set(actions.map((action) => action.id));
        const receivedActionIds = new Set(lastPlanDrafts.map(draftActionId));
        const partialActions = actions.filter((action) => receivedActionIds.has(action.id));
        if (partialActions.length === 0 || partialActions.length !== lastPlanDrafts.length ||
          lastPlanDrafts.some((draft) => !allActionIds.has(draftActionId(draft)))) {
          throw error;
        }

        const partialPlans = materializeResolutionPlans({
          state: input.state,
          definition: input.definition,
          actions: partialActions,
          groundings,
          identityOwner: input.identityOwner,
          drafts: lastPlanDrafts,
          allowedCauses: allowedForCommitments,
        });
        const missingActions = actions.filter((action) => !receivedActionIds.has(action.id));
        const repairBaseOffset = resolutionAudits.reduce((count, audit) =>
          count + audit.invocations.length, 0);
        const repairResults = await Promise.all(
          [...missingActions].sort((left, right) => left.id.localeCompare(right.id)).map(async (action, index) => {
            let repairedPlans: ResolutionPlan[] = [];
            const repairScope: ResolutionScope = {
              mode: input.resolutionScope?.mode === "global" ? "global" : "repair",
              selectedActionIds: [action.id],
              totalActionCount: actions.length,
            };
            const result = await generateValidated({
              provider: this.provider,
              profileId: input.definition.modelProfiles.resolution,
              role: "truth-resolution",
              subjectId: `${truthSubject}:repair:${action.id}`,
              promptId: "truth-resolution",
              schemaName: "truth_resolution_plan_commit",
              schema: resolutionPlanCommitDirectiveSchema,
              scope,
              buildContext: (issues) => truthContext("resolution", issues, repairScope),
              validate: (directive) => {
                if (directive.kind !== "commit_plans") {
                  throw new Error("targeted resolution repair must return commit_plans");
                }
                const scopedDrafts = directive.plans.filter((draft) => draftActionId(draft) === action.id);
                repairedPlans = materializeResolutionPlans({
                  state: input.state,
                  definition: input.definition,
                  actions: [action],
                  groundings,
                  identityOwner: input.identityOwner,
                  drafts: scopedDrafts,
                  allowedCauses: allowedForCommitments,
                });
              },
              repairAttempts: this.repairAttempts,
              invocationOffset: repairBaseOffset + index * (this.repairAttempts + 1),
              repairScope: "slot",
              targetIds: [action.id],
            });
            return { plans: repairedPlans, audit: result.audit };
          }),
        );
        const repairedPlans = repairResults.flatMap((result) => result.plans);
        resolutionRepairAudits.push(...repairResults.map((result) => result.audit));
        acceptedPlans = [...partialPlans, ...repairedPlans]
          .sort((left, right) => left.actionId.localeCompare(right.actionId));
        if (acceptedPlans.some((plan) => plan.mode === "check") &&
          commitmentRounds.length >= this.maxCommitmentRounds) {
          throw new Error("maximum commitment rounds exceeded");
        }
        acceptedPlanChecks = checkRequestsForPlans({
          state: input.state,
          plans: acceptedPlans,
          identityOwner: input.identityOwner,
          round: commitmentRounds.length,
          allowedCauses: allowedForCommitments,
          maximumVisibility: input.definition.disclosure.defaultCheckVisibility,
        });
        resolutionPlanIssues = [];
        continuationFromTargetedRepair = true;
        call = {
          value: { kind: "commit_plans", plans: [] },
          audit: repairResults[0]!.audit,
        };
      }
      if (!continuationFromTargetedRepair) resolutionAudits.push(call.audit);
      if (call.value.kind === "done") break;
      if (call.value.kind === "commit_plans") {
        if (acceptedPlans.length === 0) throw new Error("accepted resolution plans were not materialized");
        const verification = await generateValidated({
          provider: this.provider,
          profileId: input.definition.modelProfiles.causalVerifier,
          role: "causal-verifier",
          subjectId: truthSubject,
          promptId: "resolution-plan-verifier",
          schemaName: "resolution_plan_verification",
          schema: resolutionPlanVerificationSchema,
          scope,
          buildContext: (issues) => buildResolutionPlanVerificationContext({
            ...(this.includeActivityTemporalEvidence ? { temporalEvidence: input.temporalBoundary } : {}),
            definition: input.definition,
            state: input.state,
            workset: {
              state: input.modelWorkset?.state ?? input.state,
              mode: "full",
              initialActions: input.modelWorkset?.initialActions ?? input.initialActions,
              availableActions: input.modelWorkset?.availableActions ?? actions,
              assignedActions: actions,
              availableDependencies: input.modelWorkset?.availableDependencies ?? groundings,
              assignedDependencies: groundings,
            },
            plans: acceptedPlans,
            commitmentRounds,
            instanceId: scope.workloadId,
            advanceId: scope.batchId,
            issues,
            resolutionScope: input.resolutionScope ?? {
              mode: "component",
              selectedActionIds: actions.map((action) => action.id).sort(),
              totalActionCount: actions.length,
            },
          }),
          validate: (report) => {
            if (report.verdict !== "reject") return;
            const planResolver = createTruthReferenceResolver({
              state: input.state,
              definition: input.definition,
              actions,
              extraCandidates: acceptedPlans.map((plan) => ({
                kind: "plan" as const,
                engineId: plan.id,
                label: plan.goal,
                meaning: "a committed resolution plan under review",
                allowedUses: ["target", "assertion"] as const,
                visibility: "role" as const,
              })),
            });
            for (const finding of report.findings) {
              if (isProposalReference(finding.planRef)) throw new Error(`resolution plan verifier cannot target proposal ${finding.planRef.proposalKey}`);
              planResolver.resolve(finding.planRef, "target");
            }
          },
          repairAttempts: this.repairAttempts,
          invocationOffset: resolutionPlanVerifierAudits
            .reduce((count, audit) => count + audit.invocations.length, 0),
          repairScope: "component",
          targetIds: acceptedPlans.map((plan) => plan.id),
        });
        resolutionPlanVerifierAudits.push(verification.audit);
        if (verification.value.verdict === "reject") {
          const planResolver = createTruthReferenceResolver({
            state: input.state,
            definition: input.definition,
            actions,
            extraCandidates: acceptedPlans.map((plan) => ({
              kind: "plan" as const,
              engineId: plan.id,
              label: plan.goal,
              meaning: "a committed resolution plan under review",
              allowedUses: ["target", "assertion"] as const,
              visibility: "role" as const,
            })),
          });
          const planIdFor = (reference: ModelReference): string => {
            if (isProposalReference(reference)) throw new Error(`resolution plan verifier cannot target proposal ${reference.proposalKey}`);
            return planResolver.resolve(reference, "target").engineId;
          };
          resolutionPlanIssues = verification.value.findings.map((finding) => ({
            code: finding.code,
            path: ["plans", planIdFor(finding.planRef)],
            message: `${finding.message} Repair: ${finding.repairHint}`,
          }));
          setModelInvocationOutcome(
            call.audit,
            "rejected",
            resolutionPlanIssues.map((issue) => issue.code),
          );
          resolutionPlanRepairs += 1;
          if (resolutionPlanRepairs > this.repairAttempts) {
            throw new ModelSemanticRepairError(
              "truth-resolution",
              `truth-resolution plan verification failed after repairs: ${resolutionPlanIssues
                .map((issue) => `${issue.code}: ${issue.message}`)
                .join(" | ")}`,
            );
          }
          const targetPlanIds = [...new Set(verification.value.findings.map((finding) => planIdFor(finding.planRef)))];
          const targetActions = targetPlanIds
            .map((planId) => acceptedPlans.find((plan) => plan.id === planId))
            .filter((plan): plan is ResolutionPlan => Boolean(plan));
          if (targetActions.length !== targetPlanIds.length) {
            throw new Error("resolution plan verifier target disappeared before repair");
          }
          const repairBaseOffset = resolutionRepairAudits.reduce((count, audit) =>
            count + audit.invocations.length, 0);
          const repaired = await Promise.all(targetActions.map(async (plan, index) => {
            const repairScope: ResolutionScope = {
              mode: "repair",
              selectedActionIds: [plan.actionId],
              totalActionCount: actions.length,
            };
            const findingIssues = verification.value.findings
              .filter((finding) => planIdFor(finding.planRef) === plan.id)
              .map((finding) => ({
                code: finding.code,
                path: ["plans", plan.id],
                message: `${finding.message} Repair: ${finding.repairHint}`,
              }));
            const result = await generateValidated({
              provider: this.provider,
              profileId: input.definition.modelProfiles.resolution,
              role: "truth-resolution",
              subjectId: `${truthSubject}:plan-repair:${plan.id}`,
              promptId: "truth-resolution",
              schemaName: "truth_resolution_plan_repair",
              schema: resolutionPlanCommitDirectiveSchema,
              scope,
              buildContext: (issues) => truthContext(
                "resolution",
                [...findingIssues, ...issues],
                repairScope,
                { kind: "plan", id: plan.id, issueClass: "causal" },
                acceptedPlans,
              ),
              validate: (directive) => {
                if (directive.kind !== "commit_plans") {
                  throw new Error("targeted plan repair must return commit_plans");
                }
                const scopedDrafts = directive.plans.filter((draft) => draftActionId(draft) === plan.actionId);
                if (scopedDrafts.length !== 1 || directive.plans.length !== 1) {
                  throw new Error(`targeted plan repair must return exactly one plan for ${plan.actionId}`);
                }
                materializeResolutionPlans({
                  state: input.state,
                  definition: input.definition,
                  actions: [actions.find((action) => action.id === plan.actionId)!],
                  groundings,
                  identityOwner: input.identityOwner,
                  drafts: scopedDrafts,
                  allowedCauses: allowedForCommitments,
                });
              },
              repairAttempts: this.repairAttempts,
              invocationOffset: repairBaseOffset + index * (this.repairAttempts + 1),
              repairScope: "slot",
              targetIds: [plan.id],
            });
            const repairedPlans = materializeResolutionPlans({
              state: input.state,
              definition: input.definition,
              actions: [actions.find((action) => action.id === plan.actionId)!],
              groundings,
              identityOwner: input.identityOwner,
                drafts: result.value.kind === "commit_plans"
                ? result.value.plans.filter((draft) => draftActionId(draft) === plan.actionId)
                : [],
              allowedCauses: allowedForCommitments,
            });
            return { planId: plan.id, plans: repairedPlans, audit: result.audit };
          }));
          resolutionRepairAudits.push(...repaired.map((entry) => entry.audit));
          const repairedByPlan = new Map(repaired.map((entry) => [entry.planId, entry.plans[0]!]));
          const repairedPlans = acceptedPlans.map((plan) => repairedByPlan.get(plan.id) ?? plan)
            .sort((left, right) => left.actionId.localeCompare(right.actionId));
          const repairedChecks = checkRequestsForPlans({
            state: input.state,
            plans: repairedPlans,
            identityOwner: input.identityOwner,
            round: commitmentRounds.length,
            allowedCauses: allowedForCommitments,
            maximumVisibility: input.definition.disclosure.defaultCheckVisibility,
          });
          pendingPlanVerification = {
            plans: repairedPlans,
            checks: repairedChecks,
            audit: repaired[0]!.audit,
          };
          resolutionPlanIssues = [];
          continue;
        }
        resolutionPlanIssues = [];
        resolutionPlans = structuredClone(acceptedPlans);
        if (acceptedPlanChecks.length > 0) await commitCheckRound(acceptedPlanChecks);
        const evidence = resolutionEvidenceIndex(input.state, actions, input.definition.laws);
        let checkOrdinal = 0;
        resolutionReceipts = resolutionPlans.map((plan, ordinal) => {
          const request = plan.mode === "check" ? acceptedPlanChecks[checkOrdinal++]! : null;
          const result = request ? checks.find((candidate) => candidate.requestId === request.id) ?? null : null;
          return deriveResolutionReceipt({
            receiptId: runtimeId({
              worldHash: input.state.worldHash,
              revision: input.state.revision,
              kind: "resolution-receipt",
              stage: "resolution",
              owner: [input.identityOwner, plan.id],
              round: 0,
              ordinal,
            }),
            plan,
            checkRequestId: request?.id ?? null,
            check: plan.mode === "check" ? deriveCheck(plan, evidence) : null,
            result,
          });
        });
        if (this.planRandomCompletion && initialPlanCalls === 1 && !continuationFromTargetedRepair &&
          resolutionPlanRepairs === 0 && resolutionRepairAudits.length === 0 &&
          verification.audit.invocations.length === 1 && commitmentRounds.length === 0 &&
          acceptedPlanChecks.length === 0 && declaresNoAdditionalRandomness(call.value)) break;
      } else {
        if (!acceptedRandom) throw new Error("accepted random round was not materialized");
        registerRandomAliases(call.value.requests, acceptedRandom);
        await commitRandomRound(acceptedRandom);
      }
    }
    // Transition and observer repairs reuse these commitments; they never draw.
    componentRandomStateFinished = true;
    if (input.orderedRandom) rng = await input.orderedRandom.finish(structuredClone(rng));
    scope.cancelPendingSignal?.throwIfAborted();
    if (resolutionAudits.length > 0) modelAudits.push(...combineCompatibleModelAudits(resolutionAudits));
    modelAudits.push(...resolutionRepairAudits);
    if (resolutionPlanVerifierAudits.length > 0) {
      modelAudits.push(...combineCompatibleModelAudits(resolutionPlanVerifierAudits));
    }

    const stimulusObservations = reactionRequests.map((request) => request.stimulus);
    let transitionIssues: PromptValidationIssue[] = [];
    let transitionRepairs = 0;
    let transitionSourceContextHash: string | undefined;
    let previousTransitionOutput: unknown;
    let previousReport: CausalVerification | null = null;
    const transitionAudits: ModelExecutionAudit[] = [];
    const observe = runtimeEventEmitter(scope.observer);
    const transitionLogicalInvocationId = modelInvocationLogicalId(scope, "truth-transition", truthSubject);

    while (true) {
      const auditCountBeforeAttempt = transitionAudits.length;
      let candidateForRepair: unknown;
      let evaluatedProposal: TransitionProposal | undefined;
      try {
        const contextStartedAt = Date.now();
        const sourceContext = truthContext("transition", transitionIssues);
        transitionSourceContextHash ??= contentHash(sourceContext);
        const repairOf = transitionAudits.at(-1)?.invocations.at(-1)?.id;
        const context = logicalRepairContext(sourceContext, {
          scope: "step", targetIds: actions.map(action => action.id), attempt: transitionRepairs, issues: [],
          previousOutput: previousTransitionOutput, logicalInvocationId: transitionLogicalInvocationId, repairOf,
        }, transitionSourceContextHash, "truth_transition");
        const invocation = transitionAudits.reduce((count, audit) => count + audit.invocations.length, 0) + 1;
        const identity = modelInvocationIdentity(
          scope,
          "truth-transition",
          truthSubject,
          invocation,
        );
        const correlation = modelInvocationCorrelation(
          scope,
          "truth-transition",
          truthSubject,
          identity,
          {
            logicalInvocationId: transitionLogicalInvocationId,
            semanticRepairAttempt: transitionRepairs,
            ...(repairOf ? { parentInvocationId: repairOf, repairOf } : {}),
          },
        );
        observe?.({
          event: "model.context.built",
          correlation,
          durationMs: Math.max(0, Date.now() - contextStartedAt),
          hashes: { context: contentHash(context) },
        });
        const prompt = promptBundle("truth-transition");
        const generated = await this.provider.generateStructured({
          profileId: input.definition.modelProfiles.transition,
          workloadId: scope.workloadId,
          batchId: scope.batchId,
          abortSignal: scope.abortSignal,
          cancelPendingSignal: scope.cancelPendingSignal,
          correlation,
          observer: scope.observer,
          ...identity,
          role: "truth-transition",
          subjectId: truthSubject,
          promptVersion: prompt.version,
          schemaName: "truth_transition",
          system: prompt.system,
          userPrompt: prompt.userPrompt,
          context,
          schema: transitionProposalSchema,
        });
        transitionAudits.push(generated.audit);
        setModelInvocationResultKind(generated.audit, "truth-transition_transition");
        let transitionDraft = structuredClone(generated.value);
        candidateForRepair = structuredClone(transitionDraft);
        while (true) {
          try {
            this.rulePackages.validateInvocationInputs(
              input.definition.rulePackages,
              transitionDraft.mechanicInvocations.map((invocation) => ({
                id: invocation.proposalKey,
                ...mechanicIdentity(invocation.mechanicRef),
                input: runtimeMechanicInputShape(invocation.input),
                causes: [],
                assertions: [],
              })),
            );
            break;
          } catch (error) {
            if (!(error instanceof MechanicInputValidationError)) throw error;
            const target = transitionDraft.mechanicInvocations.find((candidate) =>
              candidate.proposalKey === error.invocationId);
            if (!target) throw error;
            setModelInvocationOutcome(
              generated.audit,
              "rejected",
              error.issues.map(() => "mechanic_input_contract"),
            );
            const repaired = await repairMechanicInvocation(target, error);
            transitionDraft = {
              ...transitionDraft,
              mechanicInvocations: transitionDraft.mechanicInvocations.map((candidate) =>
                candidate.proposalKey === repaired.proposalKey ? structuredClone(repaired) : candidate),
            };
            candidateForRepair = structuredClone(transitionDraft);
          }
        }
        const materializedProposal = materializeTransitionProposal(
          input.definition,
          input.state,
          actions,
          transitionDraft,
          checkAliases,
          randomAliases,
          input.identityOwner,
          requests,
          randomRequests,
          resolutionReceipts,
          mechanicContracts,
        );
        const normalizedAlternatives = normalizeOutcomeAlternativeEvidence(
          input.state,
          actions,
          materializedProposal,
        );
        const directProposal = normalizedAlternatives.proposal;
        // Outcome coverage is independent of receipts and observations. Reject
        // an incomplete candidate before settling mechanics or asking any model
        // to render consequences that cannot be committed.
        validateTransitionOutcomeCoverage(actions, directProposal);
        if (normalizedAlternatives.droppedReferences > 0 || normalizedAlternatives.droppedAlternatives > 0) {
          observe?.({
            event: "algorithm.outcome.alternative_evidence_normalized",
            level: "warn",
            correlation,
            attributes: { phase: "transition" },
            counts: {
              droppedOutcomeAlternativeEvidenceReferences: normalizedAlternatives.droppedReferences,
              droppedOutcomeAlternatives: normalizedAlternatives.droppedAlternatives,
            },
          });
        }
        if (directProposal.mechanicInvocations.some((invocation) =>
          invocation.packageId === "core-resolution" &&
          (invocation.ruleId === "apply-receipt" || invocation.ruleId === "advance-conditions"))) {
          throw new Error("core-resolution settlement invocations are engine-owned");
        }
        const continuingActionIds = new Set(directProposal.outcomes
          .filter((outcome) => outcome.status === "continuing")
          .map((outcome) => outcome.proposalId));
        resolutionReceipts = resolutionReceipts.map((receipt) => ({
          ...structuredClone(receipt),
          settled: !continuingActionIds.has(receipt.plan.actionId),
          operations: [],
        }));
        const settledReceipts = resolutionReceipts.filter((receipt) => receipt.settled);
        const resolutionInvocations: MechanicInvocation[] = settledReceipts.map((receipt, ordinal) => {
          const check = receipt.checkRequestId
            ? checks.find((candidate) => candidate.requestId === receipt.checkRequestId)
            : null;
          return {
            id: runtimeId({
              worldHash: input.state.worldHash,
              revision: input.state.revision,
              kind: "mechanic",
              stage: "resolution-effect",
              owner: [input.identityOwner, receipt.id],
              round: 0,
              ordinal,
            }),
            packageId: "core-resolution",
            ruleId: "apply-receipt",
            input: { receiptId: receipt.id },
            causes: structuredClone(receipt.plan.causes),
            assertions: check ? [{
              kind: "check_result" as const,
              checkId: check.requestId,
              expected: check.succeeded ? "succeeded" as const : "failed" as const,
            }] : [{
              kind: "entity_lifecycle" as const,
              entityId: receipt.plan.actorId,
              expected: input.state.truth.entities[receipt.plan.actorId]?.lifecycle ?? "active",
            }],
          };
        });
        const conditionAdvanceInvocation: MechanicInvocation = {
          id: runtimeId({
            worldHash: input.state.worldHash,
            revision: input.state.revision,
            kind: "mechanic",
            stage: "condition-advance",
            owner: input.identityOwner,
            round: 0,
            ordinal: resolutionInvocations.length,
          }),
          packageId: "core-resolution",
          ruleId: "advance-conditions",
          input: { seconds: input.temporalBoundary.deltaSeconds },
          causes: actions.map((action) => ({ kind: "action" as const, id: action.id })),
          assertions: [{
            kind: "elapsed_seconds_compare",
            operator: "eq",
            value: input.state.truth.elapsedSeconds,
          }],
        };
        const mechanics = this.rulePackages.resolve(input.definition.rulePackages, {
          state: input.state,
          actions,
          resolutionPlans,
          resolutionReceipts,
          checkRequests: requests,
          checkResults: checks,
          randomRequests,
          randomResults,
        }, [
          ...directProposal.mechanicInvocations,
          ...resolutionInvocations,
          conditionAdvanceInvocation,
        ], directProposal.operations);
        resolutionReceipts = resolutionReceipts.map((receipt) => {
          if (!receipt.settled) return { ...structuredClone(receipt), operations: [] };
          const invocation = resolutionInvocations.find((candidate) =>
            (candidate.input as { receiptId: string }).receiptId === receipt.id)!;
          const result = mechanics.results.find((candidate) => candidate.invocationId === invocation.id);
          if (!result) throw new Error(`resolution receipt ${receipt.id} has no trusted mechanic result`);
          return { ...structuredClone(receipt), operations: structuredClone(result.operations) };
        });
        const proposal: TransitionProposal = {
          ...structuredClone(directProposal),
          mechanicInvocations: mechanics.invocations,
          operations: [
            ...structuredClone(directProposal.operations),
            ...mechanics.operations,
            {
              kind: "advance_time",
              seconds: input.temporalBoundary.deltaSeconds,
              causes: actions.map((action) => ({ kind: "action" as const, id: action.id })),
              assertions: [{
                kind: "elapsed_seconds_compare" as const,
                operator: "eq" as const,
                value: input.state.truth.elapsedSeconds,
              }],
            },
          ],
        };

        validateTransitionEffects(input, actions, proposal, checks, randomResults, resolutionReceipts);
        // Causal evaluation reads a cloned working state and does not depend on
        // observations. Reject impossible writes before paying to narrate them.
        evaluatedProposal = proposal;
        const causalAssertionResults = evaluateProposalCausality(input.state, checks, randomResults, proposal);
        const reviewEvidence: CausalReviewEvidence = {
          reactionDecisions: input.completedReactionDecisions ??
            (input.enableReactionRouting === false ? undefined : reactionDecisions),
          ...(this.includeActivityTemporalEvidence ? { temporalEvidence: input.temporalBoundary } : {}),
          definition: input.definition,
          state: input.state,
          workset: {
            state: input.modelWorkset?.state ?? input.state,
            mode: "full",
            initialActions: input.modelWorkset?.initialActions ?? input.initialActions,
            availableActions: input.modelWorkset?.availableActions ?? actions,
            assignedActions: actions,
            availableDependencies: input.modelWorkset?.availableDependencies ?? groundings,
            assignedDependencies: groundings,
          },
          checkRequests: requests,
          checkResults: checks,
          randomRequests,
          randomResults,
          commitmentRounds,
          resolutionPlans,
          resolutionReceipts,
          proposal,
          assertionResults: causalAssertionResults,
          mechanicResults: mechanics.results,
          previousReport,
          instanceId: scope.workloadId,
          advanceId: scope.batchId,
          mechanicContracts,
          resolutionScope: input.resolutionScope ?? {
            mode: "component",
            selectedActionIds: actions.map((action) => action.id).sort(),
            totalActionCount: actions.length,
          },
        };
        const snapshot = (): UnreviewedTruthResolution => ({
          proposal: structuredClone(proposal),
          initialActions: structuredClone(input.initialActions),
          actions: structuredClone(actions),
          reactionRequests: structuredClone(reactionRequests),
          reactionDecisions: structuredClone(reactionDecisions),
          stimulusObservations: structuredClone(stimulusObservations),
          requests: structuredClone(requests),
          checks: structuredClone(checks),
          randomRequests: structuredClone(randomRequests),
          randomResults: structuredClone(randomResults),
          commitmentRounds: structuredClone(commitmentRounds),
          resolutionPlans: structuredClone(resolutionPlans),
          resolutionReceipts: structuredClone(resolutionReceipts),
          rng: structuredClone(rng),
          mechanicResults: structuredClone(mechanics.results),
          causalAssertionResults: structuredClone(causalAssertionResults),
          modelAudits: [...structuredClone(modelAudits), ...combineCompatibleModelAudits(transitionAudits)],
          reactionModelAudits: structuredClone(reactionModelAudits),
        });
        const feedback = yield {
          resolution: snapshot(),
          reviewEvidence: structuredClone(reviewEvidence),
          transitionAttempt: transitionRepairs,
          reviewInvocationOffset: resolutionPlanVerifierAudits.reduce((count, audit) => count + audit.invocations.length, 0),
        };
        scope.cancelPendingSignal?.throwIfAborted();
        scope.abortSignal?.throwIfAborted();
        if (!feedback) throw new ModelConfigurationError("resuming a truth candidate requires explicit feedback");
        if (feedback.kind === "repair") {
          previousReport = structuredClone(feedback.previousReport);
          throw feedback.error;
        }
        setModelInvocationOutcome(generated.audit, "accepted");
        observe?.({
          event: "model.semantic.accepted",
          correlation,
          attributes: { resultKind: "truth-transition_transition" },
        });
        return snapshot();
      } catch (error) {
        if (error instanceof ModelSemanticRepairError &&
          (error.role === "causal-verifier" || error.role === "observation-renderer")) throw error;
        if (error instanceof ModelConfigurationError || error instanceof ModelTransportError ||
          error instanceof ModelOverloadedError || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        if (error instanceof ModelOutputError && error.audit) transitionAudits.push(error.audit);
        if (transitionAudits.length === auditCountBeforeAttempt) throw error;
        if (!(error instanceof ModelOutputError) && !(error instanceof z.ZodError) && !(error instanceof Error)) {
          throw error;
        }
        transitionIssues = error instanceof CausalAssertionValidationError && evaluatedProposal
          ? causalAssertionRepairIssues({
            definition: input.definition, state: input.modelWorkset?.state ?? input.state,
            actions: input.modelWorkset?.availableActions ?? actions,
            resolutionPlans, checkRequests: requests, randomRequests, mechanicContracts,
            proposal: evaluatedProposal, failures: error.failures, evaluationState: input.state,
          })
          : validationIssues(error);
        // Mirror the shared logical repair loop: an unavailable current candidate
        // clears old evidence, while explicit null remains available model data.
        previousTransitionOutput = structuredClone(error instanceof ModelOutputError ? error.rawValue : candidateForRepair);
        const audit = transitionAudits.at(-1);
        if (audit) setModelInvocationOutcome(audit, "rejected", transitionIssues.map((issue) => issue.code));
        const invocation = audit?.invocations.at(-1);
        observe?.({
          event: "model.semantic.rejected",
          level: "warn",
          correlation: modelInvocationCorrelation(scope, "truth-transition", truthSubject, {
            modelInvocationId: invocation?.id,
            modelInvocation: invocation?.ordinal,
          }, {
            logicalInvocationId: transitionLogicalInvocationId,
            semanticRepairAttempt: transitionRepairs,
            ...(invocation && transitionRepairs > 0 ? {
              parentInvocationId: transitionAudits.at(-2)?.invocations.at(-1)?.id,
              repairOf: transitionAudits.at(-2)?.invocations.at(-1)?.id,
            } : {}),
          }),
          attributes: { resultKind: invocation?.resultKind ?? null },
          counts: { validationIssues: transitionIssues.length },
          hashes: invocation?.responseHash ? { response: invocation.responseHash } : undefined,
          error: serializeRuntimeError(error),
        });
        transitionRepairs += 1;
        if (transitionRepairs > this.repairAttempts) {
          const message = error instanceof Error ? error.message : String(error);
          throw new ModelSemanticRepairError(
            "truth-transition",
            `truth-transition failed after repairs: ${message}`,
            { cause: error },
          );
        }
      }
    }
  }
}
