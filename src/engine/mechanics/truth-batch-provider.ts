import { z } from "zod";
import { validationIssues, type PromptValidationIssue } from "../contracts/prompts";
import {
  actionGroundingSchema,
  causalVerificationBatchSchema,
  observationProjectionBatchSchema,
  resolutionPlanVerificationBatchSchema,
  resolutionPlanCommitDirectiveSchema,
  resolutionContinuationDirectiveSchema,
  truthResolutionBatchSchema,
  truthTransitionBatchSchema,
} from "../contracts/llm-schemas";
import {
  ContextLimitExceededError,
  ModelConfigurationError,
  ModelOutputError,
  ModelTransportError,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "../models/model-provider";
import { ModelOverloadedError } from "../models/model-scheduler";
import type { ModelProfileSummary, ModelRole } from "../models/model-catalog";
import { canonicalize, contentHash } from "../models/model-audit";
import { structuredPromptBytes } from "../prompts";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../prompts/repair-layout";
import { MODEL_REFERENCE_CATALOG_VERSION, normalizeModelOutput } from "../contracts/model-context";
import { factorSharedBatchContexts, SHARED_BATCH_ORDER_CODEC, withSharedContextReuse, type SharedBatchContext } from "./shared-batch-context";
import { MECHANICAL_PLAN_REPAIR } from "./mechanical-plan-repair";
import { fusedPlanTransitionSchema } from "./plan-transition-fusion";

type BatchableSchemaName =
  | "truth_resolution_directive"
  | "truth_resolution_plan_commit"
  | "truth_resolution_fused_commit"
  | "truth_resolution_plan_repair"
  | "truth_resolution_continuation"
  | "resolution_plan_verification"
  | "truth_transition"
  | "causal_verification"
  | "observation_render";

type BatchSchema = z.ZodTypeAny;

interface PendingRequest {
  request: StructuredModelRequest<unknown>;
  key: string;
  resolve: (result: StructuredModelResult<unknown>) => void;
  reject: (error: unknown) => void;
}

interface SplitBatchEnvelope {
  contractVersion: number;
  roleContract: unknown;
  execution: unknown;
  task: Record<string, unknown> & {
    slots: Array<Record<string, unknown> & { slot: number; assignment: unknown; constraints: readonly string[] }>;
  };
  state: SharedBatchContext | {
    slots: Array<{ slot: number; state: unknown }>;
  };
  referenceCatalog: {
    version: number;
    hash: string;
    candidates: readonly unknown[];
  };
  referenceCatalogs: Array<{ slot: number; catalog: unknown }>;
  repair: unknown;
  batchRepair?: StructuralBatchFeedback;
}

interface StructuralBatchFeedback {
  attempt: number;
  previousInvocationId: string;
  expectedSlots: number[];
  previousOutputAvailable: boolean;
  previousOutput: unknown;
  issues: PromptValidationIssue[];
}

const BATCH_REPAIR_PROMPT_SUFFIX = PHYSICAL_BATCH_REPAIR_NOTICE;
const BATCH_REPAIR_PROMPT_VERSION = contentHash(BATCH_REPAIR_PROMPT_SUFFIX).slice(0, 16);

const BATCH_PROMPT_SUFFIX = [
  "This is a fixed independent slot batch.",
  "Treat every slot as a separate task with the same complete shared context.",
  "For each numbered slot, use only referenceCatalogs[slot] when resolving handles; a handle from another slot is invalid even when its text matches.",
  "Do not infer, merge, omit, reorder, or transfer causes, actions, plans, proposals, events, observations, or identities between slots.",
  "Return exactly one result for every numbered slot and preserve the input slot numbers.",
].join(" ");

export const SHARED_SLOT_RESULT_INSTRUCTION = "Resolve every numbered slot independently and return exactly one {slot,result} entry per slot in the supplied output schema.";
const SHARED_BATCH_PROMPT_SUFFIX = [
  SHARED_SLOT_RESULT_INSTRUCTION,
  "Each slot's complete runtime context is state.shared recursively overlaid with state.slots[slot].delta: inherit absent object keys, and replace arrays and scalar values as complete values.",
  "For a slot with catalogCandidateOrder, the reconstructed referenceCatalog.candidates is encoded as a dictionary keyed by existing handle. Its original candidate array is the dictionary values in that slot's catalogCandidateOrder. Shared dictionary entries plus that slot's overrides form its complete allowed catalog; other slots' entries are unavailable.",
  "Interpret all context paths in the task and system instructions against that reconstructed slot context, including task.assignment, task.resolutionScope, state, referenceCatalog and repair.",
  "Use only that slot's reconstructed referenceCatalog for existing handles. The outer referenceCatalogs contains audit hashes, not additional allowed handles.",
  "Keep actions, causes, plans, results, identities, observations and private knowledge within their assigned slot; shared data grants no additional output responsibility.",
  "Example: shared state {world:W,actions:[A,B]} plus slot delta state {actions:[B]} means that slot sees world W and exactly actions [B].",
].join(" ");
export const SHARED_BATCH_PROMPT_VERSION = `truth-slot-batch@${contentHash(SHARED_BATCH_PROMPT_SUFFIX).slice(0, 16)}`;
const SHARED_ORDER_PROMPT_SUFFIX = SHARED_BATCH_PROMPT_SUFFIX.replace(
  "For a slot with catalogCandidateOrder, the reconstructed referenceCatalog.candidates is encoded as a dictionary keyed by existing handle. Its original candidate array is the dictionary values in that slot's catalogCandidateOrder.",
  "For a slot with catalogOrderRef, look up that exact key in state.catalogOrders to obtain its original candidate order. The reconstructed referenceCatalog.candidates is a dictionary keyed by existing handle; restore its candidate array by selecting those dictionary values in that order. catalogOrders shares identical ordering data only; it adds no allowed references to any slot.");
export const SHARED_ORDER_PROMPT_VERSION = `truth-slot-batch@${contentHash(SHARED_ORDER_PROMPT_SUFFIX).slice(0, 16)}`;
export const TRUTH_BATCH_REQUEST_CONTRACT = "physical-cardinality-slot-repair-v2" as const;

/** These constraints already belong to physical slot delivery. Bind them to
 * the actual request without duplicating each slot's large result schema. */
export function bindTruthBatchCardinality(schema: BatchSchema, count: number): BatchSchema {
  if (!Number.isInteger(count) || count < 2 || count > 64 || !(schema instanceof z.ZodObject)) throw new Error("invalid physical batch cardinality");
  const slots = schema.shape.slots;
  if (!(slots instanceof z.ZodArray) || !(slots.element instanceof z.ZodObject) || !(slots.element.shape.slot instanceof z.ZodNumber)) throw new Error("physical batch schema shape changed");
  const item = slots.element.safeExtend({ slot: slots.element.shape.slot.max(count - 1) });
  return schema.safeExtend({ slots: z.array(item).length(count) });
}

function batchSchemaFor(
  schemaName: string,
  factored = false,
  scopedRepairs = false,
  logicalSchema?: BatchSchema,
): { name: string; schema: BatchSchema } | null {
  if (schemaName === "truth_resolution_fused_commit") return { name: `${schemaName}_batch`, schema: z.strictObject({
    slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), result: logicalSchema ?? fusedPlanTransitionSchema })),
  }) };
  if (factored && schemaName === "action_grounding") {
    return { name: "action_grounding_batch", schema: z.strictObject({
      slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), result: logicalSchema ?? actionGroundingSchema })),
    }) };
  }
  // Logical repair ownership remains in the slot; its result is the same
  // commit_plans schema consumed by the physical planning codecs.
  if (factored && scopedRepairs && schemaName === "truth_resolution_plan_repair") {
    return batchSchemaFor("truth_resolution_plan_commit", true, false, logicalSchema);
  }
  if (factored && (schemaName === "truth_resolution_plan_commit" || schemaName === "truth_resolution_continuation")) {
    return { name: `${schemaName}_batch`, schema: z.strictObject({
      slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(),
        result: logicalSchema ?? (schemaName === "truth_resolution_plan_commit" ? resolutionPlanCommitDirectiveSchema : resolutionContinuationDirectiveSchema) })),
    }) };
  }
  switch (schemaName as BatchableSchemaName) {
    case "truth_resolution_directive":
      return {
        name: "truth_resolution_batch",
        schema: truthResolutionBatchSchema,
      };
    case "resolution_plan_verification":
      return {
        name: "resolution_plan_verification_batch",
        schema: resolutionPlanVerificationBatchSchema,
      };
    case "truth_transition":
      return {
        name: "truth_transition_batch",
        schema: truthTransitionBatchSchema,
      };
    case "causal_verification":
      return {
        name: "causal_verification_batch",
        schema: causalVerificationBatchSchema,
      };
    case "observation_render":
      return {
        name: "observation_projection_batch",
        schema: observationProjectionBatchSchema,
      };
    default:
      return null;
  }
}

function batchableRequest(request: StructuredModelRequest<unknown>, factored = false, scopedRepairs = false): boolean {
  return (
    batchSchemaFor(request.schemaName, factored, scopedRepairs) !== null &&
    !request.preprocessOutput && !request.wireJsonSchema &&
    !request.schemaName.endsWith("_batch")
  );
}

function contextBoundary(request: StructuredModelRequest<unknown>, factored: boolean): string {
  const context = request.context as Record<string, unknown> | null;
  if (!context || typeof context !== "object" || Array.isArray(context))
    return "unknown";
  const execution = context.execution as Record<string, unknown> | undefined;
  const task = context.task as Record<string, unknown> | undefined;
  const state = context.state as Record<string, unknown> | undefined;
  const scope = task?.resolutionScope as
    Record<string, unknown> | null | undefined;
  const repair = context.repair as { issues?: unknown; planReplacement?: { contractVersion?: unknown } } | null | undefined;
  // Replacement scope belongs to the original uncommitted component. Its
  // full slot context retains ownership; it can share transport with another
  // component requiring complete recovery under the same request contract.
  const componentReplacement = factored && request.role === "truth-resolution" &&
    request.schemaName === "truth_resolution_plan_commit" && scope?.mode === "repair" &&
    repair?.planReplacement?.contractVersion === MECHANICAL_PLAN_REPAIR &&
    Array.isArray(repair.issues) && repair.issues.length > 0;
  const observationSlots = Array.isArray(state?.observationSlots)
    ? state.observationSlots
    : null;
  return contentHash({
    contractVersion: context.contractVersion ?? null,
    promptVersion: context.promptVersion ?? request.promptVersion,
    worldId: (execution?.worldId as string | undefined) ?? null,
    instanceId: execution?.instanceId ?? request.workloadId,
    advanceId: execution?.advanceId ?? request.batchId,
    baseRevision: state?.baseRevision ?? execution?.revision ?? null,
    step: state?.step ?? execution?.step ?? null,
    stage: task?.stage ?? request.schemaName,
    resolutionMode: componentReplacement ? "component" : scope?.mode ?? null,
    selectedActionRefs: factored ? null : scope?.selectedActionRefs ?? null,
    ...(factored ? { execution, roleContract: context.roleContract } : {}),
    observerProjection: observationSlots ? "observation" : null,
  });
}

function repairBoundary(request: StructuredModelRequest<unknown>, slotLocalTargets = false): string {
  const context = request.context as Record<string, unknown> | null;
  if (!context || typeof context !== "object" || Array.isArray(context))
    return "normal";
  const repair = context.repair as Record<string, unknown> | null | undefined;
  if (repair?.target) {
    // The reversible slot context retains each exact target and its evidence.
    // Target identity limits logical repair ownership, not physical coalescing.
    if (slotLocalTargets) return "targeted";
    const target = typeof repair.target === "string"
      ? repair.target
      : typeof repair.target === "object" && repair.target !== null && "proposalKey" in repair.target
        ? repair.target.proposalKey
        : JSON.stringify(repair.target);
    return `target:${target}`;
  }
  const issues = repair?.issues;
  return Array.isArray(issues) && issues.length > 0 ? "issues" : "normal";
}

const batchSchemaHashes = new WeakMap<BatchSchema, string>();
function batchSchemaHash(schema: BatchSchema): string {
  const existing = batchSchemaHashes.get(schema);
  if (existing) return existing;
  const hash = contentHash(z.toJSONSchema(schema, { target: "draft-07" }));
  batchSchemaHashes.set(schema, hash);
  return hash;
}

function batchGroupKey(request: StructuredModelRequest<unknown>, factored: boolean, slotLocalTargets: boolean): string {
  return contentHash({
    profileId: request.profileId,
    role: request.role,
    schemaName: request.schemaName,
    schemaHash: batchSchemaHash(request.schema),
    promptVersion: request.promptVersion,
    system: request.system,
    userPrompt: request.userPrompt,
    boundary: contextBoundary(request, factored),
    structuredOutputMode: request.structuredOutputMode ?? null,
    ...(request.jsonExamplePolicy ? { jsonExamplePolicy: request.jsonExamplePolicy } : {}),
    ...(request.repairContextPlacement ? { repairContextPlacement: request.repairContextPlacement } : {}),
    ...(request.jsonSyntaxRecovery ? { jsonSyntaxRecovery: request.jsonSyntaxRecovery } : {}),
    ...(request.contextLayout ? { contextLayout: request.contextLayout } : {}),
    repair: repairBoundary(request, slotLocalTargets),
    modelRegistrySnapshotHash: request.modelRegistrySnapshotHash ?? null,
    runtimeIdentity: request.runtimeIdentity ?? null,
  });
}

function sharedContextEnvelope(requests: readonly PendingRequest[], codec: SharedBatchContext["codec"]): SplitBatchEnvelope {
  const state = factorSharedBatchContexts(requests.map((entry) => entry.request.context), codec);
  const first = requests[0]!.request.context as Record<string, unknown>;
  const catalogs = requests.map((entry, slot) => {
    const catalog = (entry.request.context as { referenceCatalog: { version: number; hash: string } }).referenceCatalog;
    return { slot, catalog: { version: catalog.version, hash: catalog.hash } };
  });
  return {
    contractVersion: Number(first.contractVersion), roleContract: structuredClone(first.roleContract),
    execution: structuredClone(first.execution),
    task: { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [],
      slots: requests.map((entry, slot) => ({ slot, assignment: {}, constraints: [],
        ...(entry.request.schemaName === "observation_render" ? { observerBinding: observationSlotBinding(entry.request.context) } : {}) })) },
    state, referenceCatalog: { version: MODEL_REFERENCE_CATALOG_VERSION, hash: contentHash(catalogs), candidates: [] },
    referenceCatalogs: catalogs, repair: null,
  };
}

/** Copy identity relationships beside the physical slot; this grants no additional access. */
export function observationSlotBinding(value: unknown) {
  const context = value as {
    task: { assignment: { targetHandles: string[] } };
    state: {
      observationSlots: Array<{ observer: { agentRef: string; selfEntityRef: string;
        localEntities: Array<{ ref: string; canonicalEntityRefs: string[] }> } }>;
      actionSet: { assigned: Array<{ actionRef: string; actorRef: string; [key: string]: unknown }> };
      outcomes: Array<{ actionRef: string; [key: string]: unknown }>;
      currentEvents: unknown[];
    };
  };
  const slots = context.state.observationSlots;
  if (!Array.isArray(slots) || slots.length !== 1) throw new ModelOutputError("physical observation slot must contain exactly one observer");
  const observer = slots[0]!.observer;
  if (contentHash(context.task.assignment.targetHandles) !== contentHash([observer.agentRef]))
    throw new ModelOutputError("observation assignment differs from its observer");
  if (!Array.isArray(context.state.outcomes) || !Array.isArray(context.state.currentEvents))
    throw new ModelConfigurationError("observation evidence binding requires outcomes and current events");
  const ownActions = context.state.actionSet.assigned.filter(action => action.actorRef === observer.agentRef);
  return {
    observerRef: observer.agentRef,
    selfLocalRefs: observer.localEntities.filter(entity => entity.canonicalEntityRefs.includes(observer.selfEntityRef)).map(entity => entity.ref),
    existingLocalEntityRefs: observer.localEntities.map(entity => entity.ref),
    ownActionRefs: ownActions.map(action => action.actionRef),
    ownAttempts: ownActions.map(action => ({
      action: structuredClone(action),
      outcomes: structuredClone(context.state.outcomes.filter(outcome => outcome.actionRef === action.actionRef)),
    })),
    currentEventCount: context.state.currentEvents.length,
    otherActionActors: context.state.actionSet.assigned.filter(action => action.actorRef !== observer.agentRef)
      .map(({ actionRef, actorRef }) => ({ actionRef, actorRef })),
  };
}

function splitSharedContext(requests: readonly PendingRequest[]): SplitBatchEnvelope {
  const contexts = requests.map((entry) => {
    const context = entry.request.context;
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      throw new ModelOutputError(
        "truth batch requires an object context",
        undefined,
        { rawValue: context },
      );
    }
    return context as Record<string, unknown>;
  });
  const first = contexts[0]!;
  const taskValues = contexts.map((context) => {
    const task = context.task;
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      throw new ModelOutputError("truth batch requires an envelope task", undefined, { rawValue: task });
    }
    return task as Record<string, unknown>;
  });
  const stateValues = contexts.map((context) => {
    const state = context.state;
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      throw new ModelOutputError("truth batch requires an envelope state", undefined, { rawValue: state });
    }
    return state;
  });
  const commonTask: Record<string, unknown> = {};
  const taskKeys = [...new Set(taskValues.flatMap((task) => Object.keys(task)))].sort();
  for (const key of taskKeys) {
    if (key === "assignment" || key === "constraints") continue;
    const values = taskValues.map((task) => task[key]);
    const hashes = values.map((value) => contentHash(value === undefined ? null : canonicalize(value)));
    if (hashes.every((hash) => hash === hashes[0])) commonTask[key] = structuredClone(values[0]);
  }
  const catalogs = contexts.map((context, slot) => ({ slot, catalog: structuredClone(context.referenceCatalog) }));
  const repairs = contexts.map((context) => context.repair).filter((repair) => repair !== null && repair !== undefined);
  const referenceCatalog = {
    version: MODEL_REFERENCE_CATALOG_VERSION,
    hash: contentHash(catalogs),
    candidates: [] as readonly unknown[],
  };
  return {
    contractVersion: Number(first.contractVersion ?? 15),
    roleContract: structuredClone(first.roleContract),
    execution: structuredClone(first.execution),
    task: {
      assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] },
      constraints: [],
      ...commonTask,
      slots: taskValues.map((task, slot) => ({
        slot,
        assignment: structuredClone(task.assignment ?? {}),
        constraints: Array.isArray(task.constraints) ? [...task.constraints] : [],
        ...(contexts[slot]!.repair ? { repair: structuredClone(contexts[slot]!.repair) } : {}),
        ...Object.fromEntries(Object.entries(task).filter(([key]) => key !== "assignment" && key !== "constraints")),
      })),
    },
    state: {
      slots: stateValues.map((state, slot) => ({ slot, state: structuredClone(state) })),
    },
    referenceCatalog,
    referenceCatalogs: catalogs,
    repair: repairs.length > 0
      ? { target: null, issues: repairs.flatMap((repair) => {
        const value = repair as { issues?: unknown[] };
        return Array.isArray(value.issues) ? value.issues : [];
      }) }
      : null,
  };
}

function ensureSlotCoverage(
  value: unknown,
  count: number,
  audit: StructuredModelResult<unknown>["audit"],
): Array<{ slot: number; result: unknown }> {
  const parsed = z
    .strictObject({
      slots: z.array(
        z.strictObject({
          slot: z.number().int().nonnegative(),
          result: z.unknown(),
        }),
      ),
    })
    .safeParse(value);
  if (!parsed.success) {
    throw new ModelOutputError(
      "truth batch response is not a structured slot envelope",
      audit,
      { cause: parsed.error, rawValue: value },
    );
  }
  const slots = parsed.data.slots;
  if (slots.length !== count) {
    throw new ModelOutputError(
      `truth batch response must contain exactly ${count} slots, received ${slots.length}`,
      audit,
      { rawValue: value },
    );
  }
  const seen = new Set<number>();
  for (const slot of slots) {
    if (slot.slot >= count || seen.has(slot.slot)) {
      throw new ModelOutputError(
        `truth batch response contains duplicate or unknown slot ${slot.slot}`,
        audit,
        { rawValue: value },
      );
    }
    seen.add(slot.slot);
  }
  if (seen.size !== count) {
    throw new ModelOutputError("truth batch response omitted a slot", audit, {
      rawValue: value,
    });
  }
  return slots.sort((left, right) => left.slot - right.slot);
}

function logicalResultAudit(request: StructuredModelRequest<unknown>, audit: StructuredModelResult<unknown>["audit"]) {
  const logicalAudit = structuredClone(audit);
  // Physical prompt/codec evidence remains in the Ledger under the original
  // invocation IDs and request hashes. Logical identity must also survive a
  // singleton repair or split after the first physical batch.
  logicalAudit.subjectId = request.subjectId;
  logicalAudit.promptVersion = request.promptVersion;
  return logicalAudit;
}

function deliverSlotResults(
  entries: readonly PendingRequest[],
  value: unknown,
  audit: StructuredModelResult<unknown>["audit"],
): void {
  // Verify the entire mapping before accepting any slot; ambiguous identities
  // still require structural recovery of the physical envelope.
  const slots = ensureSlotCoverage(value, entries.length, audit);
  for (const [index, entry] of entries.entries()) {
    const logicalAudit = logicalResultAudit(entry.request, audit);
    const parsed = entry.request.schema.safeParse(slots[index]!.result);
    if (!parsed.success) {
      // Repair consumes the logical audit before classifying the cause. A
      // physical envelope's generic error must not mask this slot's schema.
      const invocation = logicalAudit.invocations.at(-1);
      if (invocation) invocation.issues = validationIssues(parsed.error).map((issue) => ({
        code: issue.code, class: issue.class ?? "structure", path: [...issue.path], message: issue.message,
      }));
      entry.reject(new ModelOutputError(
        `truth batch slot ${entry.key} returned an invalid ${entry.request.schemaName} result`,
        logicalAudit, { cause: parsed.error, rawValue: slots[index]!.result },
      ));
    } else {
      // A rejected raw envelope has not necessarily passed the gateway's
      // normalization gate. Apply the same gate inside this slot's namespace;
      // another slot cannot declare a proposal on this slot's behalf.
      const normalized = normalizeModelOutput(parsed.data, { dedupeArrays: true });
      // The physical audit can contain another slot's schema failure. Replace
      // it even when this slot has no issues; repair must see only local evidence.
      const invocation = logicalAudit.invocations.at(-1);
      if (invocation) invocation.issues = normalized.issues.map((issue) => ({
        code: issue.code, class: issue.class, path: [...issue.path], message: issue.reason,
        originalValue: structuredClone(issue.originalValue), allowedHandles: [...issue.allowedHandles],
      }));
      if (normalized.issues.length) {
        entry.reject(new ModelOutputError(
          `truth batch slot ${entry.key} has unresolved semantic proposals: ${normalized.issues.map((issue) => issue.reason).join("; ")}`,
          logicalAudit, { rawValue: slots[index]!.result },
        ));
      } else {
        entry.resolve({ value: normalized.value, audit: logicalAudit });
      }
    }
  }
}

function terminal(error: unknown): boolean {
  return (
    error instanceof ContextLimitExceededError ||
    error instanceof ModelConfigurationError ||
    error instanceof ModelTransportError ||
    error instanceof ModelOverloadedError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function batchPhase(
  schemaName: string,
):
  | "truth-resolution"
  | "truth-plan-verification"
  | "truth-transition"
  | "truth-causal-verification"
  | "action-grounding"
  | "observation" {
  if (schemaName.startsWith("truth_resolution_")) return "truth-resolution";
  if (schemaName === "action_grounding") return "action-grounding";
  if (schemaName === "resolution_plan_verification")
    return "truth-plan-verification";
  if (schemaName === "truth_transition") return "truth-transition";
  if (schemaName === "causal_verification") return "truth-causal-verification";
  return "observation";
}

function emitBatchMetric(
  request: StructuredModelRequest<unknown>,
  phase: ReturnType<typeof batchPhase>,
  configuredMaxSlots: number,
  logicalSlots: number,
  repairCalls: number,
  batchSplits: number,
): void {
  request.observer?.emit({
    event: "algorithm.eager_reference.slot_batch_completed",
    attributes: { phase },
    counts: {
      configuredMaxSlots,
      logicalSlots,
      physicalCalls: 1,
      submittedSlots: logicalSlots,
      repairCalls,
      repeatedFingerprints: 0,
      batchSplits,
      partialFailureSlots: 0,
      singletonFailures: 0,
    },
  });
}

/**
 * Coalesces independent Truth Engine provider calls into a typed slot envelope.
 * The logical callers still receive their original schema and therefore retain
 * all existing validation/materialization/repair behavior.
 */
export class TruthBatchCoordinator implements StructuredModelProvider {
  readonly catalog;
  private readonly pending: PendingRequest[] = [];
  private flushScheduled = false;
  private readonly signalIds = new WeakMap<AbortSignal, number>();
  private nextSignalId = 0;

  constructor(
    private readonly inner: StructuredModelProvider,
    readonly maxSlots: number,
    private readonly structuralRetries = 2,
    private readonly contextCodec?: SharedBatchContext["codec"],
    private readonly requestContract?: typeof TRUTH_BATCH_REQUEST_CONTRACT,
    private readonly repairPlacement?: "tail-v1",
    private readonly flushBoundary?: "post-promise-v1",
    private readonly planRepairBatching?: "scoped-plans-v1",
    private readonly planningPartition?: "balanced-two-v1" | "ready-wave-work-v1",
  ) {
    if (!Number.isSafeInteger(maxSlots) || maxSlots < 1 || maxSlots > 64) {
      throw new RangeError(
        "truthBatchMaxSlots must be an integer from 1 through 64",
      );
    }
    this.catalog = inner.catalog;
    if (flushBoundary && (!contextCodec || !requestContract)) throw new ModelConfigurationError("post-promise batching requires shared contexts and the physical request contract");
    if (planRepairBatching && (!contextCodec || !requestContract)) throw new ModelConfigurationError("scoped plan repair batching requires shared contexts and the physical request contract");
    if (planningPartition && (!contextCodec || !requestContract)) throw new ModelConfigurationError("balanced planning requires shared contexts and the physical request contract");
    if (planningPartition === "ready-wave-work-v1" && !flushBoundary) throw new ModelConfigurationError("ready-wave planning requires the post-promise dispatch boundary");
  }

  availableProfileSummaries(role?: ModelRole): ModelProfileSummary[] {
    return this.inner.availableProfileSummaries(role);
  }

  async assertProfilesAvailable(profileIds: readonly string[]): Promise<void> {
    return this.inner.assertProfilesAvailable(profileIds);
  }

  async modelRegistryDiagnostics() {
    if (!this.inner.modelRegistryDiagnostics)
      throw new Error("model registry diagnostics are unavailable");
    return this.inner.modelRegistryDiagnostics();
  }

  async refreshModelRegistry() {
    if (!this.inner.refreshModelRegistry)
      throw new Error("model registry refresh is unavailable");
    return this.inner.refreshModelRegistry();
  }

  generateStructured<T>(
    request: StructuredModelRequest<T>,
  ): Promise<StructuredModelResult<T>> {
    if (
      !batchableRequest(request as StructuredModelRequest<unknown>, Boolean(this.contextCodec), Boolean(this.planRepairBatching))
    ) {
      return this.generateSingle(request);
    }
    return new Promise<StructuredModelResult<T>>((resolve, reject) => {
      this.pending.push({
        request: request as StructuredModelRequest<unknown>,
        key: request.subjectId,
        resolve: resolve as (result: StructuredModelResult<unknown>) => void,
        reject,
      });
      if (this.pending.length >= this.maxSlots && this.planningPartition !== "ready-wave-work-v1") {
        void this.flush();
      } else if (!this.flushScheduled) {
        this.flushScheduled = true;
        queueMicrotask(() => {
          // Collect ordered promise continuations without a timer window.
          // Scheduling rationale and source: docs/decisions/0143-post-promise-batch-dispatch.md.
          if (this.flushBoundary) process.nextTick(() => { void this.flush(); });
          else void this.flush();
        });
      }
    });
  }

  private async generateSingle<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    try {
      const result = await this.inner.generateStructured(request);
      return { ...result, audit: logicalResultAudit(request, result.audit) };
    } catch (error) {
      if (!(error instanceof ModelOutputError) || !error.audit) throw error;
      throw new ModelOutputError(error.message, logicalResultAudit(request, error.audit), {
        cause: error, rawValue: error.rawValue, completion: error.completion,
      });
    }
  }

  private partition(group: PendingRequest[]): PendingRequest[][] {
    const fixed = () => Array.from({ length: Math.ceil(group.length / this.maxSlots) }, (_, index) =>
      group.slice(index * this.maxSlots, (index + 1) * this.maxSlots));
    if (!this.planningPartition || group.length < 2) return fixed();
    const weighted = group.map(entry => {
      const request = entry.request;
      const context = request.context as { task?: { resolutionScope?: { mode?: string } };
        state?: { actionSet?: { assigned?: unknown[] } } } | null;
      const assigned = context?.state?.actionSet?.assigned;
      const initial = request.role === "truth-resolution" && ["truth_resolution_plan_commit", "truth_resolution_fused_commit"].includes(request.schemaName) &&
        context?.task?.resolutionScope?.mode === "component" && repairBoundary(request) === "normal";
      return { entry, weight: initial && Array.isArray(assigned) ? assigned.length : 0 };
    });
    if (weighted.some(item => item.weight === 0)) return fixed();
    // LPT with action count as a work proxy; no model-time guarantee.
    // Provenance and tradeoff: docs/decisions/0168-balance-complete-planning-components.md.
    weighted.sort((left, right) => right.weight - left.weight || left.entry.key.localeCompare(right.entry.key));
    const minimumBins = this.planningPartition === "ready-wave-work-v1" ? 1 : 2;
    const bins = Array.from({ length: Math.max(minimumBins, Math.ceil(group.length / this.maxSlots)) }, () =>
      ({ entries: [] as PendingRequest[], weight: 0 }));
    for (const item of weighted) {
      const target = bins.filter(bin => bin.entries.length < this.maxSlots)
        .reduce((best, bin) => bin.weight < best.weight ? bin : best);
      target.entries.push(item.entry);
      target.weight += item.weight;
    }
    return bins.filter(bin => bin.entries.length > 0).map(bin =>
      bin.entries.sort((left, right) => left.key.localeCompare(right.key)));
  }

  private async flush(): Promise<void> {
    this.flushScheduled = false;
    if (this.pending.length === 0) return;
    const entries = this.pending.splice(0);
    const groups = new Map<string, PendingRequest[]>();
    for (const entry of entries) {
      const signals = [entry.request.abortSignal, entry.request.cancelPendingSignal].map((signal) => {
        if (!signal) return null;
        if (!this.signalIds.has(signal)) this.signalIds.set(signal, ++this.nextSignalId);
        return this.signalIds.get(signal);
      });
      const key = contentHash({ request: batchGroupKey(entry.request, Boolean(this.contextCodec),
        Boolean(this.contextCodec && this.requestContract)), signals });
      const group = groups.get(key) ?? [];
      group.push(entry);
      groups.set(key, group);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        group.sort((left, right) => left.key.localeCompare(right.key));
        // Tail batches are independent physical work. Dispatch every fixed
        // chunk together so a four-batch stage has the latency of one wave,
        // while the provider's own scheduler remains the concurrency gate.
        await Promise.all(
          this.partition(group).map(batch => {
            if (batch.length === 1) {
              return (async () => {
                try {
                  emitBatchMetric(
                    batch[0]!.request,
                    batchPhase(batch[0]!.request.schemaName),
                    this.maxSlots,
                    1,
                    repairBoundary(batch[0]!.request) === "normal" ? 0 : 1,
                    0,
                  );
                  batch[0]!.resolve(
                    await this.generateSingle(batch[0]!.request),
                  );
                } catch (error) {
                  batch[0]!.reject(error);
                }
              })();
            }
            return this.executeBatch(batch, 0, "0");
          }),
        );
      }),
    );
    if (this.pending.length > 0) await this.flush();
  }

  private async executeBatch(
    entries: readonly PendingRequest[],
    attempt: number,
    splitPath: string,
    feedback?: StructuralBatchFeedback,
  ): Promise<void> {
    // Once a malformed physical batch has been bisected to one logical slot,
    // send that slot through its original schema/context. There is no value
    // in wrapping a singleton in a batch envelope and retrying the same
    // structural failure again.
    if (entries.length === 1) {
      try {
        entries[0]!.resolve(await this.generateSingle(entries[0]!.request));
      } catch (error) {
        entries[0]!.reject(error);
      }
      return;
    }
    const first = entries[0]!.request;
    const selected = batchSchemaFor(first.schemaName, Boolean(this.contextCodec), Boolean(this.planRepairBatching), first.schema);
    if (!selected)
      throw new Error(`schema ${first.schemaName} is not batchable`);
    const physicalSchema = this.requestContract ? bindTruthBatchCardinality(selected.schema, entries.length) : selected.schema;
    let context: SplitBatchEnvelope;
    try {
      context = this.contextCodec ? sharedContextEnvelope(entries, this.contextCodec) : splitSharedContext(entries);
      if (feedback) context.batchRepair = structuredClone(feedback);
    } catch (error) {
      entries.forEach((entry) => entry.reject(error));
      return;
    }
    const profile = this.catalog.profile(first.profileId);
    const sharedVersion = this.contextCodec === SHARED_BATCH_ORDER_CODEC ? SHARED_ORDER_PROMPT_VERSION : SHARED_BATCH_PROMPT_VERSION;
    const sharedSuffix = this.contextCodec === SHARED_BATCH_ORDER_CODEC ? SHARED_ORDER_PROMPT_SUFFIX : SHARED_BATCH_PROMPT_SUFFIX;
    const promptVersion = `${first.promptVersion}:${this.contextCodec ? sharedVersion : "truth-slot-batch-v1"}${this.requestContract ? `:${this.requestContract}` : ""}${feedback ? `:structural-repair-${BATCH_REPAIR_PROMPT_VERSION}${this.repairPlacement ? `:${this.repairPlacement}` : ""}` : ""}`;
    const userPrompt = `${first.userPrompt}\n\n${this.contextCodec ? sharedSuffix : BATCH_PROMPT_SUFFIX}${feedback ? `\n\n${BATCH_REPAIR_PROMPT_SUFFIX}` : ""}`;
    const requestBytes = structuredPromptBytes({
      system: first.system,
      userPrompt,
      context,
      schema: physicalSchema,
      repairContextPlacement: feedback ? this.repairPlacement : undefined,
      contextLayout: first.contextLayout,
    }).requestUtf8Bytes;
    if (requestBytes > profile.max_input_bytes) {
      const error = new ContextLimitExceededError(
        `truth batch ${entries.map((entry) => entry.key).join(",")} uses ${requestBytes} bytes; ` +
          `profile max_input_bytes is ${profile.max_input_bytes}`,
      );
      // A batch can exceed the provider limit even when each logical slot is
      // individually valid: non-shared context is repeated once per slot.
      // Bisect deterministically until each physical request fits, preserving
      // the caller-visible slot results and avoiding a false terminal failure.
      if (entries.length > 1) {
        const midpoint = Math.ceil(entries.length / 2);
        await Promise.all([
          this.executeBatch(entries.slice(0, midpoint), attempt, `${splitPath}L`),
          this.executeBatch(entries.slice(midpoint), attempt, `${splitPath}R`),
        ]);
      } else {
        entries[0]!.reject(error);
      }
      return;
    }
    const owner = `truth-batch-${contentHash({
      role: first.role,
      schemaName: first.schemaName,
      profileId: first.profileId,
      runtimeIdentity: first.runtimeIdentity ?? null,
      modelRegistrySnapshotHash: first.modelRegistrySnapshotHash ?? null,
      keys: entries.map((entry) => entry.key).sort(),
      splitPath,
    }).slice(0, 16)}`;
    const ordinal =
      Math.max(...entries.map((entry) => entry.request.modelInvocation ?? 1)) +
      attempt;
    // The logical callers already computed canonical identities before they
    // entered this coordinator. Derive a physical identity from those source
    // identities and the canonical batch owner; this remains stable without
    // requiring runtimeIdentity to be present on the transport DTO.
    const modelInvocationId = `rt:model-audit:${contentHash({
      source: first.modelInvocationId ?? null,
      role: first.role,
      owner,
      ordinal,
      attempt,
      splitPath,
    })}`;
    const identity = {
      modelInvocationId,
      modelInvocation: ordinal,
    };
    const feedbackFor = (error: unknown, previousOutput = error instanceof ModelOutputError ? error.rawValue : undefined): StructuralBatchFeedback => ({
      attempt: attempt + 1,
      previousInvocationId: modelInvocationId,
      expectedSlots: entries.map((_, slot) => slot),
      previousOutputAvailable: previousOutput !== undefined,
      previousOutput: previousOutput === undefined ? null : structuredClone(previousOutput),
      issues: validationIssues(error),
    });
    try {
      emitBatchMetric(
        first,
        batchPhase(first.schemaName),
        this.maxSlots,
        entries.length,
        attempt > 0 || repairBoundary(first) !== "normal" ? 1 : 0,
        splitPath.length > 1 ? 1 : 0,
      );
      const generated = await withSharedContextReuse(() => this.inner.generateStructured({
        ...first,
        ...identity,
        role: first.role,
        subjectId: owner,
        promptVersion,
        schemaName: selected.name,
        userPrompt,
        context,
        schema: physicalSchema,
        ...(this.requestContract ? { jsonExamplePolicy: "omit" as const } : {}),
        ...(feedback && this.repairPlacement ? { repairContextPlacement: this.repairPlacement } : {}),
      }));
      try {
        deliverSlotResults(entries, generated.value, generated.audit);
      } catch (error) {
        if (attempt < this.structuralRetries) {
          await this.executeBatch(entries, attempt + 1, splitPath, feedbackFor(error, generated.value));
          return;
        }
        if (entries.length > 1) {
          const middle = Math.ceil(entries.length / 2);
          await Promise.all([
            this.executeBatch(entries.slice(0, middle), 0, `${splitPath}L`),
            this.executeBatch(entries.slice(middle), 0, `${splitPath}R`),
          ]);
          return;
        }
        if (entries.length === 1) {
          try {
            entries[0]!.resolve(await this.generateSingle(entries[0]!.request));
          } catch (directError) {
            entries[0]!.reject(directError);
          }
        } else {
          entries[0]!.reject(error);
        }
        return;
      }
    } catch (error) {
      if (error instanceof ModelOutputError && error.audit && error.rawValue !== undefined) {
        try {
          deliverSlotResults(entries, error.rawValue, error.audit);
          return;
        } catch {
          // Missing, duplicated or unparseable slot identities cannot be salvaged.
        }
      }
      if (terminal(error)) {
        entries.forEach((entry) => entry.reject(error));
        return;
      }
      if (attempt < this.structuralRetries) {
        await this.executeBatch(entries, attempt + 1, splitPath, feedbackFor(error));
        return;
      }
      if (entries.length > 1) {
        const middle = Math.ceil(entries.length / 2);
        await Promise.all([
          this.executeBatch(entries.slice(0, middle), 0, `${splitPath}L`),
          this.executeBatch(entries.slice(middle), 0, `${splitPath}R`),
        ]);
        return;
      }
      try {
        entries[0]!.resolve(await this.generateSingle(entries[0]!.request));
      } catch (directError) {
        entries[0]!.reject(directError);
      }
    }
  }
}
