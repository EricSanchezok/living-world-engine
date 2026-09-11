import { modelRoles, type ModelRole } from "../models/model-catalog";
import type { ActionOutcome, WorldDeltaOperation } from "../contracts/model";
import type { ActivityTransition, TemporalBoundaryReason } from "../mechanics/temporal";
import { ACTION_COMPILATION_PROJECTION } from "../contracts/model-context";
import { ALGORITHM_ROLES, type AlgorithmRole } from "../algorithms/composition";

export const RUNTIME_EVENT_SCHEMA_VERSION = 4 as const;

export type RuntimeObservabilityMode = "off" | "metrics" | "full";
export type RuntimeEventLevel = "debug" | "info" | "warn" | "error";

export interface RuntimeCorrelation {
  executionId?: string;
  requestId?: string;
  instanceId?: string;
  advanceId?: string;
  advanceAttempt?: number;
  revision?: number;
  step?: number;
  modelInvocationId?: string;
  modelRole?: ModelRole;
  modelSubject?: string;
  modelInvocation?: number;
  transportAttempt?: number;
  logicalStageIndex?: number;
  logicalStageKey?: string;
  component?: string;
  operation?: string;
  logicalInvocationId?: string;
  /** Zero for the root semantic attempt; positive values are LLM repairs. */
  semanticRepairAttempt?: number;
  parentInvocationId?: string;
  repairOf?: string;
  attemptGroupId?: string;
  trigger?: string;
}

export interface RuntimeError {
  name: string;
  message: string;
  code?: string;
  domain?: string;
  owner?: string;
  retryability?: "not_retryable" | "retryable" | "unknown";
  stack?: string;
  status?: number;
  cause?: RuntimeError;
  errors?: RuntimeError[];
}

export type RuntimeAttribute = string | number | boolean | null;

export interface RuntimeEventInput {
  event: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  links?: readonly { traceId: string; spanId: string }[];
  level?: RuntimeEventLevel;
  correlation?: RuntimeCorrelation;
  durationMs?: number;
  attributes?: Readonly<Record<string, RuntimeAttribute>>;
  measurements?: Readonly<Record<string, number | null>>;
  counts?: Readonly<Record<string, number>>;
  hashes?: Readonly<Record<string, string>>;
  payload?: unknown;
  error?: RuntimeError;
  algorithm?: AlgorithmNodeRuntimeIdentity;
}

export interface AlgorithmNodeRuntimeIdentity {
  path: string;
  role: AlgorithmRole;
  id: string;
  version: string;
  manifestHash: string;
}

type AlgorithmTelemetryBase = Omit<
  RuntimeEventInput,
  "event" | "payload" | "measurements" | "hashes" | "attributes" | "counts"
> & {
  payload?: never;
  measurements?: never;
  hashes?: never;
};

export type AlgorithmTelemetryEventInput = AlgorithmTelemetryBase & ({
  event: "algorithm.eager_reference.action_compilation_context_projected";
  attributes: Readonly<{
    phase: "action-compilation";
    projection: "c0-repeated-slot-catalog" | "c1-shared-full-catalog" |
      "c2-normalized-complete-catalog" | "c3-deterministic-details" |
      typeof ACTION_COMPILATION_PROJECTION |
      "c4-bounded-expansion" | "c5-retrieval-supplement";
    repair: boolean;
  }>;
  counts: Readonly<{
    slots: number;
    candidateKeys: number;
    serializedCandidates: number;
    detailedCandidates: number;
    duplicateSemanticDefinitionCount: number;
    repairIssues: number;
    contextUtf8Bytes: number;
    referenceCatalogUtf8Bytes: number;
    canonicalTruthUtf8Bytes: number;
    taskUtf8Bytes: number;
    canonicalRefSerializedCount: number;
    rawPrivateReferenceSerializedCount: number;
  }>;
} | {
  event: "algorithm.eager_reference.slot_batch_completed";
  attributes: Readonly<{
    phase: "action-compilation" | "agent-bootstrap" | "agent-resume" | "agent-mind" |
      "truth-resolution" | "truth-plan-verification" | "truth-transition" |
      "truth-causal-verification" | "action-grounding" | "observation";
  }>;
  counts: Readonly<{
    configuredMaxSlots: number;
    logicalSlots: number;
    physicalCalls: number;
    submittedSlots: number;
    repairCalls: number;
    repeatedFingerprints: number;
    batchSplits: number;
    partialFailureSlots: number;
    singletonFailures: number;
  }>;
} | {
  event: "algorithm.eager_reference.overlap_completed";
  attributes: Readonly<{
    phase: "action-preparation" | "reaction-preparation";
  }>;
  counts: Readonly<{
    knownActions: number;
    deferredActions: number;
    directReactions: number;
    perceptionReactions: number;
  }>;
} | {
  event: "algorithm.agent_mind.repair_exhausted";
  attributes: Readonly<{
    phase: "bootstrap" | "resume" | "mind";
    policy: "fail-step";
  }>;
  counts: Readonly<{ mindFailures: number }>;
} | {
  event: "algorithm.agent_mind.repair_fallback";
  attributes: Readonly<{
    phase: "bootstrap" | "resume" | "mind";
    policy: "empty-patch-and-idle-action";
  }>;
  counts: Readonly<{ mindFallbacks: number }>;
} | {
  event: "algorithm.agent_reaction.repair_fallback";
  attributes: Readonly<{
    phase: "reaction";
    policy: "temporal-profile-fallback";
  }>;
  counts: Readonly<{ reactionFallbacks: number }>;
} | {
  event: "algorithm.agent_reaction.repair_exhausted";
  attributes: Readonly<{
    phase: "reaction";
    policy: "fail-step";
  }>;
  counts: Readonly<{ reactionFailures: number }>;
} | {
  event: "algorithm.truth_perception.repair_fallback";
  attributes: Readonly<{
    phase: "truth-perception";
    policy: "no-perception-reaction";
  }>;
  counts: Readonly<{ perceptionFallbacks: number }>;
} | {
  event: "algorithm.truth_perception.repair_exhausted";
  attributes: Readonly<{
    phase: "truth-perception";
    policy: "fail-step";
  }>;
  counts: Readonly<{ perceptionFailures: number }>;
} | {
  event: "algorithm.grounding.global_fallback";
  attributes: Readonly<{ phase: "grounding"; reasons: string }>;
  counts: Readonly<{ normalizedGroundingFields: number; globalFallbacks: number }>;
} | {
  event: "algorithm.observation.references_normalized";
  attributes: Readonly<{ phase: "observation"; batch: string }>;
  counts: Readonly<{
    droppedObservationEventReferences: number;
    droppedObservationClaims: number;
    droppedObservationIntroductions: number;
    clearedObservationCanonicalBindings: number;
  }>;
} | {
  event: "algorithm.observation.batch_split";
  attributes: Readonly<{ phase: "observation"; batch: string }>;
  counts: Readonly<{ observationBatchSplits: number; splitObserverSlots: number }>;
} | {
  event: "algorithm.observation.repair_fallback";
  attributes: Readonly<{
    phase: "observation";
    batch: string;
    policy: "typed-uncertainty-observation";
  }>;
  counts: Readonly<{ observationFallbacks: number }>;
} | {
  event: "algorithm.observation.global_projection_completed";
  attributes: Readonly<{
    phase: "observation";
    reason: "multiple-conflict-components" | "dynamic-lifecycle" | "final-candidate";
  }>;
  counts: Readonly<{
    observations: number;
    observationBatches: number;
    dependencyComponents: number;
  }>;
} | {
  event: "algorithm.observation.rendering_completed";
  attributes: Readonly<{ phase: "observation" }>;
  counts: Readonly<{ observationBatches: number; observations: number }>;
} | {
  event: "algorithm.outcome.alternative_evidence_normalized";
  attributes: Readonly<{ phase: "transition" }>;
  counts: Readonly<{
    droppedOutcomeAlternativeEvidenceReferences: number;
    droppedOutcomeAlternatives: number;
  }>;
});

export type AlgorithmTelemetryEventName = AlgorithmTelemetryEventInput["event"];

export interface AlgorithmInstrumentation {
  emit(input: AlgorithmTelemetryEventInput): RuntimeEvent | undefined;
}

export type EngineStableRuntimeEventInput = Omit<
  RuntimeEventInput,
  "event" | "payload" | "measurements" | "hashes" | "attributes" | "counts"
> & ({
  event: "algorithm.activation.completed";
  attributes: Readonly<{
    phase: "bootstrap" | "step";
    policy: "engine-bootstrap-roster" | "engine-decision-eligibility";
  }>;
  counts: Readonly<{
    persistentAgents: number;
    eligibleAgents: number;
    activatedAgents: number;
    skippedAgents: number;
    reusedAgents: number;
    noopAgents: number;
    externalAgents: number;
  }>;
} | {
  event: "algorithm.candidate.completed";
  attributes: Readonly<{
    phase: "step";
    dependencyAnalysis: "typed-action-dependencies";
    trigger: "manual" | "batch" | "realtime" | "participant_action";
  }>;
  counts: Readonly<{
    updatedAgents: number;
    observedAgents: number;
    actions: number;
    reactions: number;
    checks: number;
    randomResults: number;
    resolutionPlans: number;
    settledResolutionReceipts: number;
    deferredResolutionReceipts: number;
    mechanicInvocations: number;
    mechanicResults: number;
    outcomes: number;
    operations: number;
    events: number;
    observations: number;
    mindCommits: number;
    mindFallbacks: number;
    temporalPlans: number;
    activeActivities: number;
    activityTransitions: number;
    dueActivities: number;
    dueTimers: number;
    dueConditions: number;
    decisionPoints: number;
    temporalDeltaSeconds: number;
    dependencyNodes: number;
    dependencyEdges: number;
    dependencyComponents: number;
    maxDependencyComponent: number;
    globalDependencies: number;
    globalReadjudications: number;
    footprintCardinality: number;
    audienceCardinality: number;
  }>;
} | {
  event: "temporal.boundary.reason";
  attributes: Readonly<{ reasonKind: TemporalBoundaryReason["kind"] }>;
  counts?: never;
} | {
  event: "temporal.activity.transition";
  attributes: Readonly<{ transitionKind: ActivityTransition["kind"] }>;
  counts?: never;
} | {
  event: "resolution.outcome.recorded";
  attributes: Readonly<{ outcomeStatus: ActionOutcome["status"] }>;
  counts?: never;
} | {
  event: "resolution.operation.recorded";
  attributes: Readonly<{ operationKind: WorldDeltaOperation["kind"] }>;
  counts?: never;
});

const engineOwnedStableEvents: ReadonlySet<string> = new Set<EngineStableRuntimeEventInput["event"]>([
  "algorithm.activation.completed",
  "algorithm.candidate.completed",
  "temporal.boundary.reason",
  "temporal.activity.transition",
  "resolution.outcome.recorded",
  "resolution.operation.recorded",
]);

const engineStableTelemetryFields: Record<EngineStableRuntimeEventInput["event"], {
  attributes: readonly string[];
  counts: readonly string[];
  attributeValues?: Readonly<Record<string, readonly RuntimeAttribute[]>>;
}> = {
  "algorithm.activation.completed": {
    attributes: ["phase", "policy"],
    counts: [
      "persistentAgents",
      "eligibleAgents",
      "activatedAgents",
      "skippedAgents",
      "reusedAgents",
      "noopAgents",
      "externalAgents",
    ],
    attributeValues: {
      phase: ["bootstrap", "step"],
      policy: ["engine-bootstrap-roster", "engine-decision-eligibility"],
    },
  },
  "algorithm.candidate.completed": {
    attributes: ["phase", "dependencyAnalysis", "trigger"],
    counts: [
      "updatedAgents",
      "observedAgents",
      "actions",
      "reactions",
      "checks",
      "randomResults",
      "resolutionPlans",
      "settledResolutionReceipts",
      "deferredResolutionReceipts",
      "mechanicInvocations",
      "mechanicResults",
      "outcomes",
      "operations",
      "events",
      "observations",
      "mindCommits",
      "mindFallbacks",
      "temporalPlans",
      "activeActivities",
      "activityTransitions",
      "dueActivities",
      "dueTimers",
      "dueConditions",
      "decisionPoints",
      "temporalDeltaSeconds",
      "dependencyNodes",
      "dependencyEdges",
      "dependencyComponents",
      "maxDependencyComponent",
      "globalDependencies",
      "globalReadjudications",
      "footprintCardinality",
      "audienceCardinality",
    ],
    attributeValues: {
      phase: ["step"],
      dependencyAnalysis: ["typed-action-dependencies"],
      trigger: ["manual", "batch", "realtime", "participant_action"],
    },
  },
  "temporal.boundary.reason": {
    attributes: ["reasonKind"],
    counts: [],
    attributeValues: {
      reasonKind: ["activity_checkpoint", "activity_completion", "timer", "condition_expiry", "safety_horizon"],
    },
  },
  "temporal.activity.transition": {
    attributes: ["transitionKind"],
    counts: [],
    attributeValues: {
      transitionKind: ["progressed", "stage_changed", "completed", "paused", "resumed", "blocked", "failed", "cancelled"],
    },
  },
  "resolution.outcome.recorded": {
    attributes: ["outcomeStatus"],
    counts: [],
    attributeValues: { outcomeStatus: ["succeeded", "partial", "failed", "blocked", "continuing"] },
  },
  "resolution.operation.recorded": {
    attributes: ["operationKind"],
    counts: [],
    attributeValues: {
      operationKind: [
        "create_entity",
        "retire_entity",
        "place_entity",
        "set_fact",
        "remove_fact",
        "set_meter",
        "adjust_meter",
        "transfer_quantity",
        "produce_quantity",
        "consume_quantity",
        "set_quantity",
        "set_rating",
        "set_condition",
        "remove_condition",
        "advance_time",
        "create_agent",
        "remove_agent",
      ],
    },
  },
};

const algorithmTelemetryFields: Record<AlgorithmTelemetryEventName, {
  attributes: readonly string[];
  counts: readonly string[];
  attributeValues?: Readonly<Record<string, readonly RuntimeAttribute[]>>;
}> = {
  "algorithm.eager_reference.action_compilation_context_projected": {
    attributes: ["phase", "projection", "repair"],
    counts: [
      "slots",
      "candidateKeys",
      "serializedCandidates",
      "detailedCandidates",
      "duplicateSemanticDefinitionCount",
      "repairIssues",
      "contextUtf8Bytes",
      "referenceCatalogUtf8Bytes",
      "canonicalTruthUtf8Bytes",
      "taskUtf8Bytes",
      "canonicalRefSerializedCount",
      "rawPrivateReferenceSerializedCount",
    ],
    attributeValues: {
      phase: ["action-compilation"],
      projection: [
        "c0-repeated-slot-catalog",
        "c1-shared-full-catalog",
        "c2-normalized-complete-catalog",
        "c3-deterministic-details",
        ACTION_COMPILATION_PROJECTION,
        "c4-bounded-expansion",
        "c5-retrieval-supplement",
      ],
      repair: [true, false],
    },
  },
  "algorithm.eager_reference.slot_batch_completed": {
    attributes: ["phase"],
    counts: [
      "configuredMaxSlots",
      "logicalSlots",
      "physicalCalls",
      "submittedSlots",
      "repairCalls",
      "repeatedFingerprints",
      "batchSplits",
      "partialFailureSlots",
      "singletonFailures",
    ],
    attributeValues: {
      phase: [
        "action-compilation", "agent-bootstrap", "agent-resume", "agent-mind",
        "truth-resolution", "truth-plan-verification", "truth-transition",
        "truth-causal-verification", "action-grounding", "observation",
      ],
    },
  },
  "algorithm.eager_reference.overlap_completed": {
    attributes: ["phase"],
    counts: ["knownActions", "deferredActions", "directReactions", "perceptionReactions"],
    attributeValues: {
      phase: ["action-preparation", "reaction-preparation"],
    },
  },
  "algorithm.agent_mind.repair_fallback": {
    attributes: ["phase", "policy"],
    counts: ["mindFallbacks"],
    attributeValues: {
      phase: ["bootstrap", "resume", "mind"],
      policy: ["empty-patch-and-idle-action"],
    },
  },
  "algorithm.agent_mind.repair_exhausted": {
    attributes: ["phase", "policy"],
    counts: ["mindFailures"],
    attributeValues: {
      phase: ["bootstrap", "resume", "mind"],
      policy: ["fail-step"],
    },
  },
  "algorithm.agent_reaction.repair_fallback": {
    attributes: ["phase", "policy"],
    counts: ["reactionFallbacks"],
    attributeValues: {
      phase: ["reaction"],
      policy: ["temporal-profile-fallback"],
    },
  },
  "algorithm.agent_reaction.repair_exhausted": {
    attributes: ["phase", "policy"],
    counts: ["reactionFailures"],
    attributeValues: {
      phase: ["reaction"],
      policy: ["fail-step"],
    },
  },
  "algorithm.truth_perception.repair_fallback": {
    attributes: ["phase", "policy"],
    counts: ["perceptionFallbacks"],
    attributeValues: {
      phase: ["truth-perception"],
      policy: ["no-perception-reaction"],
    },
  },
  "algorithm.truth_perception.repair_exhausted": {
    attributes: ["phase", "policy"],
    counts: ["perceptionFailures"],
    attributeValues: {
      phase: ["truth-perception"],
      policy: ["fail-step"],
    },
  },
  "algorithm.grounding.global_fallback": {
    attributes: ["phase", "reasons"],
    counts: ["normalizedGroundingFields", "globalFallbacks"],
    attributeValues: { phase: ["grounding"] },
  },
  "algorithm.observation.references_normalized": {
    attributes: ["phase", "batch"],
    counts: [
      "droppedObservationEventReferences",
      "droppedObservationClaims",
      "droppedObservationIntroductions",
      "clearedObservationCanonicalBindings",
    ],
    attributeValues: { phase: ["observation"] },
  },
  "algorithm.observation.batch_split": {
    attributes: ["phase", "batch"],
    counts: ["observationBatchSplits", "splitObserverSlots"],
    attributeValues: { phase: ["observation"] },
  },
  "algorithm.observation.repair_fallback": {
    attributes: ["phase", "batch", "policy"],
    counts: ["observationFallbacks"],
    attributeValues: {
      phase: ["observation"],
      policy: ["typed-uncertainty-observation"],
    },
  },
  "algorithm.observation.global_projection_completed": {
    attributes: ["phase", "reason"],
    counts: ["observations", "observationBatches", "dependencyComponents"],
    attributeValues: {
      phase: ["observation"],
      reason: ["multiple-conflict-components", "dynamic-lifecycle", "final-candidate"],
    },
  },
  "algorithm.observation.rendering_completed": {
    attributes: ["phase"],
    counts: ["observationBatches", "observations"],
    attributeValues: { phase: ["observation"] },
  },
  "algorithm.outcome.alternative_evidence_normalized": {
    attributes: ["phase"],
    counts: ["droppedOutcomeAlternativeEvidenceReferences", "droppedOutcomeAlternatives"],
    attributeValues: { phase: ["transition"] },
  },
};

function validateExactFields(
  actual: Readonly<Record<string, unknown>> | undefined,
  expected: readonly string[],
  label: string,
): void {
  const keys = Object.keys(actual ?? {}).sort();
  const required = [...expected].sort();
  if (keys.length !== required.length || keys.some((key, index) => key !== required[index])) {
    throw new Error(`${label} fields must be exactly: ${required.join(", ")}`);
  }
}

function validateAllowedAttributeValues(
  input: RuntimeEventInput,
  allowed: Readonly<Record<string, readonly RuntimeAttribute[]>> | undefined,
): void {
  for (const [key, values] of Object.entries(allowed ?? {})) {
    const value = input.attributes?.[key];
    if (!values.includes(value ?? null)) {
      throw new Error(`${input.event} attribute ${key} is invalid: ${String(value)}`);
    }
  }
}

export function validateAlgorithmTelemetryEvent(input: RuntimeEventInput): asserts input is AlgorithmTelemetryEventInput {
  if (engineOwnedStableEvents.has(input.event)) {
    throw new Error(`stable runtime event is engine-owned: ${input.event}`);
  }
  const definition = algorithmTelemetryFields[input.event as AlgorithmTelemetryEventName];
  if (!definition) throw new Error(`unknown algorithm telemetry event: ${input.event}`);
  if (input.payload !== undefined || input.measurements !== undefined || input.hashes !== undefined) {
    throw new Error(`algorithm telemetry contains unsupported data: ${input.event}`);
  }
  validateExactFields(input.attributes, definition.attributes, `${input.event} attributes`);
  validateExactFields(input.counts, definition.counts, `${input.event} counts`);
  validateAllowedAttributeValues(input, definition.attributeValues);
}

function validateStableRuntimeEvent(input: RuntimeEventInput): void {
  if ((input.event.startsWith("algorithm.") || input.event.startsWith("temporal.") ||
    input.event.startsWith("resolution.")) &&
    !engineOwnedStableEvents.has(input.event) &&
    !(input.event in algorithmTelemetryFields)) {
    throw new Error(`unknown stable runtime event: ${input.event}`);
  }
  const engineDefinition = engineStableTelemetryFields[input.event as EngineStableRuntimeEventInput["event"]];
  if (engineDefinition) {
    if (input.payload !== undefined || input.measurements !== undefined || input.hashes !== undefined) {
      throw new Error(`stable engine telemetry contains unsupported data: ${input.event}`);
    }
    validateExactFields(input.attributes, engineDefinition.attributes, `${input.event} attributes`);
    validateExactFields(input.counts, engineDefinition.counts, `${input.event} counts`);
    validateAllowedAttributeValues(input, engineDefinition.attributeValues);
  }
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    if (value !== null && typeof value !== "string" && typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error(`runtime attribute ${key} must be a string, finite number, boolean, or null`);
    }
  }
  if (input.correlation?.modelRole !== undefined && !modelRoles.includes(input.correlation.modelRole)) {
    throw new Error(`runtime model role is invalid: ${String(input.correlation.modelRole)}`);
  }
  if (input.algorithm) {
    if (!/^root(?:\.[a-z][A-Za-z0-9]*)*$/u.test(input.algorithm.path)) {
      throw new Error(`runtime algorithm node path is invalid: ${input.algorithm.path}`);
    }
    if (!ALGORITHM_ROLES.includes(input.algorithm.role)) {
      throw new Error(`runtime algorithm role is invalid: ${String(input.algorithm.role)}`);
    }
    for (const [field, value] of Object.entries({
      id: input.algorithm.id,
      version: input.algorithm.version,
      manifestHash: input.algorithm.manifestHash,
    })) {
      if (typeof value !== "string" || !value.trim()) throw new Error(`runtime algorithm ${field} is required`);
    }
  }
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs < 0)) {
    throw new Error(`runtime event duration must be a non-negative finite number: ${input.event}`);
  }
  for (const [key, value] of Object.entries(input.counts ?? {})) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`runtime count ${key} must be a non-negative integer`);
  }
  for (const [key, value] of Object.entries(input.measurements ?? {})) {
    if (value !== null && !Number.isFinite(value)) throw new Error(`runtime measurement ${key} must be finite or null`);
  }
}

export interface RuntimeEvent extends RuntimeEventInput {
  schemaVersion: typeof RUNTIME_EVENT_SCHEMA_VERSION;
  sequence: number;
  timestamp: string;
  level: RuntimeEventLevel;
}

export interface RuntimeObserver {
  readonly mode: RuntimeObservabilityMode;
  readonly degraded: boolean;
  readonly critical?: boolean;
  emit(input: RuntimeEventInput): RuntimeEvent | undefined;
  flush?(): void;
  subscribe?(listener: RuntimeEventListener): () => void;
  snapshot?(): RuntimeEvent[];
  close?(): void;
}

export type RuntimeEventListener = (event: RuntimeEvent) => void;

function numericStatus(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as { status?: unknown; statusCode?: unknown };
  if (typeof candidate.status === "number" && Number.isFinite(candidate.status)) {
    return candidate.status;
  }
  if (typeof candidate.statusCode === "number" && Number.isFinite(candidate.statusCode)) {
    return candidate.statusCode;
  }
  return undefined;
}

export function serializeRuntimeError(error: unknown, depth = 0): RuntimeError {
  if (!(error instanceof Error)) {
    return { name: "NonError", message: String(error) };
  }
  const serialized: RuntimeError = {
    name: error.name || "Error",
    message: error.message,
  };
  const metadata = error as Error & {
    code?: unknown;
    domain?: unknown;
    owner?: unknown;
    retryability?: unknown;
  };
  if (typeof metadata.code === "string" && metadata.code.length > 0) serialized.code = metadata.code;
  if (typeof metadata.domain === "string" && metadata.domain.length > 0) serialized.domain = metadata.domain;
  if (typeof metadata.owner === "string" && metadata.owner.length > 0) serialized.owner = metadata.owner;
  if (metadata.retryability === "not_retryable" || metadata.retryability === "retryable" || metadata.retryability === "unknown") {
    serialized.retryability = metadata.retryability;
  }
  if (error.stack) serialized.stack = error.stack;
  const status = numericStatus(error);
  if (status !== undefined) serialized.status = status;
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause !== undefined && depth < 3) serialized.cause = serializeRuntimeError(cause, depth + 1);
  if (error instanceof AggregateError && depth < 3) {
    serialized.errors = error.errors.slice(0, 32).map((member) => serializeRuntimeError(member, depth + 1));
  }
  return serialized;
}

const sensitiveFieldNames = new Set([
  "accesstoken",
  "apikey",
  "auth",
  "authorization",
  "bearertoken",
  "clientsecret",
  "clienttoken",
  "cookie",
  "credential",
  "password",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "secret",
  "sessiontoken",
  "setcookie",
  "token",
  "xapikey",
]);

function redactRuntimeString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(authorization|api[-_ ]?key|x[-_ ]?api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|client[-_ ]?secret|password|cookie|set-cookie)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      "$1$2[REDACTED]",
    );
}

export function redactRuntimePayload(value: unknown): unknown {
  if (typeof value === "string") return redactRuntimeString(value);
  if (Array.isArray(value)) return value.map(redactRuntimePayload);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    return [key, sensitiveFieldNames.has(normalized) ? "[REDACTED]" : redactRuntimePayload(entry)];
  }));
}

export class NoopRuntimeObserver implements RuntimeObserver {
  readonly mode = "off" as const;
  readonly degraded = false;

  emit(): undefined {
    return undefined;
  }
}

export const NOOP_RUNTIME_OBSERVER: RuntimeObserver = new NoopRuntimeObserver();

export interface RecordingRuntimeObserverOptions {
  mode?: Exclude<RuntimeObservabilityMode, "off">;
  now?: () => Date;
}

export class RecordingRuntimeObserver implements RuntimeObserver {
  readonly mode: Exclude<RuntimeObservabilityMode, "off">;
  readonly degraded = false;
  readonly events: RuntimeEvent[] = [];
  serializedUtf8Bytes = 0;
  serializationMs = 0;
  private readonly now: () => Date;
  private readonly listeners = new Set<RuntimeEventListener>();
  private sequence = 0;

  constructor(options: RecordingRuntimeObserverOptions = {}) {
    this.mode = options.mode ?? "metrics";
    this.now = options.now ?? (() => new Date());
  }

  emit(input: RuntimeEventInput): RuntimeEvent {
    const event = materializeRuntimeEvent(input, ++this.sequence, this.now(), this.mode);
    const startedAt = performance.now();
    try {
      this.serializedUtf8Bytes += Buffer.byteLength(JSON.stringify(event), "utf8") + 1;
    } finally {
      this.serializationMs += performance.now() - startedAt;
    }
    this.events.push(event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Diagnostic consumers cannot change runtime semantics.
      }
    }
    return event;
  }

  subscribe(listener: RuntimeEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): RuntimeEvent[] {
    return structuredClone(this.events);
  }
}

export function fullRuntimePayload(observer: RuntimeObserver, payload: unknown): unknown {
  return observer.mode === "full" ? payload : undefined;
}

export function materializeRuntimeEvent(
  input: RuntimeEventInput,
  sequence: number,
  now: Date,
  mode: RuntimeObservabilityMode,
): RuntimeEvent {
  validateStableRuntimeEvent(input);
  const event = redactRuntimePayload({
    ...input,
    schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
    sequence,
    timestamp: now.toISOString(),
    level: input.level ?? "info",
  }) as RuntimeEvent;
  if (mode !== "full") delete event.payload;
  return event;
}

function emitRuntimeEvent(
  observer: RuntimeObserver | undefined,
  input: RuntimeEventInput,
): RuntimeEvent | undefined {
  if (!observer) return undefined;
  try {
    return observer.emit(input);
  } catch (error) {
    if (observer.critical) throw error;
    return undefined;
  }
}

export type RuntimeEventEmitter = (input: RuntimeEventInput) => RuntimeEvent | undefined;

export function runtimeEventEmitter(
  observer: RuntimeObserver | undefined,
): RuntimeEventEmitter | undefined {
  if (!observer || observer.mode === "off") return undefined;
  return (input) => emitRuntimeEvent(observer, input);
}
