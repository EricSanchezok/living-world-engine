import type { z } from "zod";
import type { ModelCatalog, ModelProfileSummary, ModelRole } from "./model-catalog";
import type {
  ModelExecutionAudit,
  ModelInvocationAudit,
  ModelTokenUsage,
  ModelOutputIssue,
  ModelSymbolRepairAudit,
  ModelJsonRecoveryEvidence,
} from "../contracts/model";
import type { RuntimeCorrelation, RuntimeObserver } from "../runtime/observability";
import type { ModelRegistryStatus } from "./model-registry";
import { runtimeId } from "../runtime/runtime-id";
import type { ExecutionStageHooks, ExecutionStagePosition } from "../runtime/stages";
import type { CandidateSelectionCapability } from "../algorithms/roles";
import type { AlgorithmRef } from "../algorithms/composition";
import type { PromptValidationIssue } from "../contracts/prompts";

export interface ModelExecutionScope {
  workloadId: string;
  batchId: string;
  abortSignal?: AbortSignal;
  /** Cancel queued/new work while allowing active HTTP to finish with usage. */
  cancelPendingSignal?: AbortSignal;
  correlation?: RuntimeCorrelation;
  observer?: RuntimeObserver;
  runtimeIdentity?: { worldHash: string; revision: number };
  /** Exact immutable Composition that produced this execution. */
  executionAlgorithmRef?: AlgorithmRef<"world-execution">;
  /** Pins benchmark/replay work to one immutable historical registry snapshot. */
  modelRegistrySnapshotHash?: string;
  /** Engine-owned logical stage metadata for Inspector ordering and debug gates. */
  logicalStage?: ExecutionStagePosition;
  /** Trusted local debug control; never serialized into model context. */
  stageHooks?: ExecutionStageHooks;
  /** Optional Action Compilation retrieval runtime; authoritative validation remains full-catalog. */
  actionCompilationRetrieval?: CandidateSelectionCapability;
}

export interface StructuredModelRequest<T> extends ModelExecutionScope {
  profileId: string;
  role: ModelExecutionAudit["role"];
  subjectId: string;
  promptVersion: string;
  schemaName: string;
  system: string;
  /** A short, call-specific task instruction placed before the JSON context. */
  userPrompt: string;
  context: unknown;
  schema: z.ZodType<T>;
  /** Explicit transport mode for controlled experiments; canonical validation remains mandatory. */
  structuredOutputMode?: "json-object-zod" | "json-schema-strict";
  /** Trusted codec-owned wire schema; canonical validation remains schema-owned. */
  wireJsonSchema?: Record<string, unknown>;
  /** Pinned request rendering policy; omit examples that would invent task output. */
  jsonExamplePolicy?: "omit";
  /** Trusted optional instruction after the JSON-object schema and repair evidence. */
  jsonObjectPostlude?: string;
  /** Explicit lossless placement of physical or bound logical repair evidence. */
  repairContextPlacement?: "tail-v1" | "logical-tail-v1";
  /** Experimental local parser policy; never a provider generation parameter. */
  jsonSyntaxRecovery?: "unmatched-closers-v1";
  /** Lossless ordering of shared-state fields ahead of volatile batch metadata. */
  contextLayout?: "shared-state-first-v1";
  /** Deterministic, field-scoped normalization before schema validation. */
  preprocessOutput?: (raw: unknown) => {
    value: unknown;
    symbolRepairs: readonly ModelSymbolRepairAudit[];
  };
  modelInvocationId?: string;
  modelInvocation?: number;
}

export interface ModelInvocationLineage {
  logicalInvocationId: string;
  semanticRepairAttempt: number;
  parentInvocationId?: string;
  repairOf?: string;
}

export interface StructuredModelResult<T> {
  value: T;
  audit: ModelExecutionAudit;
}

export interface ModelOutputCompletion {
  tokenUsage: ModelTokenUsage;
  finishReason: string;
  responseId: string;
  responseModelId: string;
  jsonRecoveryEvidence?: ModelJsonRecoveryEvidence;
}

export class ModelOutputError extends Error {
  /**
   * The provider value is retained only in memory so a caller can isolate a
   * malformed slot from an otherwise valid batch. It is never included in
   * public DTOs or persisted outside the normal model audit.
   */
  readonly rawValue: unknown;
  /** Known provider completion remains billable even when its output fails. */
  readonly completion?: ModelOutputCompletion;

  constructor(
    message: string,
    readonly audit?: ModelExecutionAudit,
    options: ErrorOptions & { rawValue?: unknown; completion?: ModelOutputCompletion } = {},
  ) {
    super(message, options);
    this.name = "ModelOutputError";
    this.rawValue = options.rawValue;
    this.completion = options.completion ? structuredClone(options.completion) : undefined;
  }
}

export interface ModelTransportErrorOptions extends ErrorOptions {
  retriable?: boolean;
  statusCode?: number | null;
}

/** A rejected candidate's independent validation failures, for one repair. */
export class ModelCandidateValidationError extends Error {
  readonly issues: readonly PromptValidationIssue[];

  constructor(issues: readonly PromptValidationIssue[]) {
    if (issues.length === 0) throw new Error("candidate validation requires at least one issue");
    super(issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("\n"));
    this.name = "ModelCandidateValidationError";
    this.issues = structuredClone(issues);
  }
}

export class ModelTransportError extends Error {
  readonly retriable: boolean;
  readonly statusCode: number | null;

  constructor(message: string, options: ModelTransportErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ModelTransportError";
    this.retriable = options.retriable ?? false;
    this.statusCode = options.statusCode ?? null;
  }
}

export class ModelConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelConfigurationError";
  }
}

/** Raised when a complete model request exceeds the profile input budget. */
export class ContextLimitExceededError extends ModelConfigurationError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextLimitExceeded";
  }
}

export interface ModelSemanticRepairErrorOptions extends ErrorOptions {
  audit?: ModelExecutionAudit;
}

export class ModelSemanticRepairError extends Error {
  readonly audit?: ModelExecutionAudit;

  constructor(readonly role: ModelRole, message: string, options: ModelSemanticRepairErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ModelSemanticRepairError";
    this.audit = options.audit ? structuredClone(options.audit) : undefined;
  }
}

export interface StructuredModelProvider {
  readonly catalog: ModelCatalog;
  availableProfileSummaries(role?: ModelRole): ModelProfileSummary[];
  assertProfilesAvailable(profileIds: readonly string[]): Promise<void>;
  generateStructured<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>>;
  modelRegistryDiagnostics?(): Promise<ModelRegistryDiagnostics>;
  refreshModelRegistry?(): Promise<ModelRegistryRefreshDiagnostics>;
}

export interface ModelRegistryAccountDiagnostic {
  id: string;
  channel: import("./model-catalog").ModelAccountChannel;
  region: string;
  protocol: import("./model-catalog").ModelProtocol;
  credentialConfigured: boolean;
}

export interface ModelRegistryProfileDiagnostic {
  id: string;
  accountId: string;
  credentialConfigured: boolean;
  resolvedModelId: string | null;
  modelMetadataHash: string | null;
  structuredOutputMode: ModelExecutionAudit["structuredOutputMode"] | null;
  resolutionError: string | null;
}

export interface ModelRegistryDiagnostics {
  catalog: { schemaVersion: 3; hash: string };
  registry: ModelRegistryStatus;
  accounts: ModelRegistryAccountDiagnostic[];
  profiles: ModelRegistryProfileDiagnostic[];
}

export interface ModelRegistryRefreshDiagnostics {
  outcome: import("./model-registry").ModelRegistryRefreshOutcome;
  checkedAt: string;
  error: string | null;
  diagnostics: ModelRegistryDiagnostics;
}

function addNullable(left: number | null, right: number | null): number | null {
  if (left === null && right === null) return null;
  return (left ?? 0) + (right ?? 0);
}

export function combineModelExecutionAudits(
  audits: readonly ModelExecutionAudit[],
): ModelExecutionAudit {
  const first = audits[0];
  if (!first) throw new Error("cannot combine an empty model audit list");
  for (const audit of audits.slice(1)) {
    if (audit.role !== first.role || audit.subjectId !== first.subjectId ||
      audit.profileId !== first.profileId || audit.providerId !== first.providerId ||
      audit.accountId !== first.accountId || audit.accountChannel !== first.accountChannel ||
      audit.protocol !== first.protocol || audit.dialect !== first.dialect ||
      audit.modelId !== first.modelId || audit.modelCatalogHash !== first.modelCatalogHash ||
      audit.registrySnapshotHash !== first.registrySnapshotHash ||
      audit.modelMetadataHash !== first.modelMetadataHash ||
      audit.modelCatalogSchemaVersion !== first.modelCatalogSchemaVersion ||
      audit.promptVersion !== first.promptVersion ||
      audit.structuredOutputMode !== first.structuredOutputMode ||
      JSON.stringify(audit.selector) !== JSON.stringify(first.selector) ||
      JSON.stringify(audit.requestedInference) !== JSON.stringify(first.requestedInference) ||
      JSON.stringify(audit.resolvedInference) !== JSON.stringify(first.resolvedInference)) {
      throw new Error("cannot combine model audits with different execution identities");
    }
  }
  return {
    ...structuredClone(first),
    invocations: audits.flatMap((audit) => structuredClone(audit.invocations)),
  };
}

export interface ModelExecutionSummary {
  invocations: number;
  transportAttempts: number;
  repairAttempts: number;
  queueWaitMs: number;
  executionMs: number;
  retryDelayMs: number;
  tokenUsage: ModelTokenUsage;
}

export function summarizeModelExecutionAudit(audit: ModelExecutionAudit): ModelExecutionSummary {
  const invocations = audit.invocations;
  const emptyUsage: ModelTokenUsage = {
    input: null,
    output: null,
    reasoning: null,
    cacheRead: null,
    cacheWrite: null,
  };
  return {
    invocations: invocations.length,
    transportAttempts: invocations.reduce((sum, invocation) => sum + invocation.transports.length, 0),
    repairAttempts: invocations.filter((invocation) => invocation.outputDisposition === "llm-repaired" || invocation.outputDisposition === "rejected").length,
    queueWaitMs: invocations.flatMap((invocation) => invocation.transports)
      .reduce((sum, attempt) => sum + attempt.queueWaitMs, 0),
    executionMs: invocations.flatMap((invocation) => invocation.transports)
      .reduce((sum, attempt) => sum + attempt.executionMs, 0),
    retryDelayMs: invocations.flatMap((invocation) => invocation.transports)
      .reduce((sum, attempt) => sum + attempt.retryDelayMs, 0),
    tokenUsage: invocations.reduce((usage, invocation) => ({
      input: addNullable(usage.input, invocation.tokenUsage.input),
      output: addNullable(usage.output, invocation.tokenUsage.output),
      reasoning: addNullable(usage.reasoning, invocation.tokenUsage.reasoning),
      cacheRead: addNullable(usage.cacheRead, invocation.tokenUsage.cacheRead),
      cacheWrite: addNullable(usage.cacheWrite, invocation.tokenUsage.cacheWrite),
    }), emptyUsage),
  };
}

export function setModelInvocationOutcome(
  audit: ModelExecutionAudit,
  disposition: ModelInvocationAudit["outputDisposition"],
  issues: readonly (string | ModelOutputIssue)[] = [],
): void {
  const invocation = audit.invocations.at(-1);
  if (!invocation) throw new Error("model audit has no invocation to classify");
  // A caller that only knows validation succeeded commonly reports
  // `accepted` after the gateway has already classified deterministic
  // normalization or the repair loop has classified an LLM retry. Preserve
  // those stronger audit dispositions instead of erasing the evidence.
  const effectiveDisposition = disposition === "accepted" &&
    (invocation.outputDisposition === "auto-normalized" || invocation.outputDisposition === "llm-repaired")
    ? invocation.outputDisposition
    : disposition;
  invocation.outputDisposition = effectiveDisposition;
  invocation.issues = issues.map((issue) => typeof issue === "string"
    ? { code: issue, class: "semantic", path: [], message: issue }
    : structuredClone(issue));
}

export function setModelInvocationResultKind(
  audit: ModelExecutionAudit,
  resultKind: string,
): void {
  const invocation = audit.invocations.at(-1);
  if (!invocation) throw new Error("model audit has no invocation to classify");
  invocation.resultKind = resultKind;
}

export function modelInvocationIdentity(
  scope: ModelExecutionScope,
  role: ModelExecutionAudit["role"],
  subjectId: string,
  ordinal: number,
): { modelInvocationId: string; modelInvocation: number } {
  if (!scope.runtimeIdentity) {
    throw new ModelConfigurationError("canonical model invocation identity requires worldHash and revision");
  }
  const { worldHash, revision } = scope.runtimeIdentity;
  return {
    modelInvocationId: runtimeId({
      worldHash,
      revision,
      kind: "model-audit",
      stage: role,
      // workloadId/batchId are transport correlation (often instance/advance UUIDs),
      // never persisted identity coordinates. A retry of the same semantic
      // model stage must receive the same engine-owned id.
      owner: subjectId,
      round: 0,
      ordinal,
    }),
    modelInvocation: ordinal,
  };
}

export function modelInvocationCorrelation(
  scope: ModelExecutionScope,
  role: ModelExecutionAudit["role"],
  subjectId: string,
  identity?: { modelInvocationId?: string; modelInvocation?: number },
  lineage?: ModelInvocationLineage,
): RuntimeCorrelation {
  return {
    ...scope.correlation,
    modelInvocationId: identity?.modelInvocationId,
    modelRole: role,
    modelSubject: subjectId,
    modelInvocation: identity?.modelInvocation,
    ...(lineage ? {
      logicalInvocationId: lineage.logicalInvocationId,
      semanticRepairAttempt: lineage.semanticRepairAttempt,
      ...(lineage.parentInvocationId ? { parentInvocationId: lineage.parentInvocationId } : {}),
      ...(lineage.repairOf ? { repairOf: lineage.repairOf } : {}),
    } : {}),
  };
}

/** Stable semantic-chain identity for a single model work item. */
export function modelInvocationLogicalId(
  scope: ModelExecutionScope,
  role: ModelExecutionAudit["role"],
  subjectId: string,
  ordinal = 1,
): string {
  return modelInvocationIdentity(scope, role, subjectId, ordinal).modelInvocationId;
}
