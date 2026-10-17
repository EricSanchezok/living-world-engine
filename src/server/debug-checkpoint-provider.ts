import type { ModelExecutionAudit } from "../engine/contracts/model";
import { MemoryContextChanged } from "../engine/cognition/memory";
import { contentHash } from "../engine/models/model-audit";
import type { ModelRole } from "../engine/models/model-catalog";
import {
  ContextLimitExceededError,
  ModelOutputError,
  modelInvocationIdentity,
  type StructuredModelProvider,
  type StructuredModelRequest,
  type StructuredModelResult,
} from "../engine/models/model-provider";
import type { RuntimeEvent } from "../engine/runtime/observability";
import type { ExecutionStageKey } from "../engine/runtime/stages";

export const EXECUTION_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export interface ExecutionCheckpoint {
  schemaVersion: typeof EXECUTION_CHECKPOINT_SCHEMA_VERSION;
  id: string;
  executionId: string;
  runId: string;
  generation: number;
  sourceRevision: number;
  sourceStateHash: string;
  boundaryIndex: number;
  stageIndex: number;
  stageKey: ExecutionStageKey;
  eventRange: { fromSequence: number | null; toSequence: number | null };
  priorArtifactRefs: string[];
  continuation: {
    schemaVersion: 1;
    kind: "recorded-stage-replay";
    nextStageIndex: number;
    producerManifestHash: string;
    worldHash: string;
    modelCatalogHash: string;
    codeRevision: string;
    codeDirty: boolean;
  };
  createdAt: string;
}

interface RecordedStageOutput {
  audit: ModelExecutionAudit;
  event: RuntimeEvent;
  rejected: boolean;
  value: unknown;
}

export function debugCheckpointReplayValidationError(
  events: readonly RuntimeEvent[],
  completedStageIndex: number,
): string | null {
  const inCompletedStage = (event: RuntimeEvent) =>
    (event.correlation?.logicalStageIndex ?? Number.MAX_SAFE_INTEGER) <= completedStageIndex;
  const started = new Map(events.filter((event) => event.event === "model.invocation.started" && inCompletedStage(event))
    .flatMap((event) => event.correlation?.modelInvocationId ? [[event.correlation.modelInvocationId, event] as const] : []));
  const outputs = new Map(events.filter((event) =>
    (event.event === "model.structured_output.parsed" || event.event === "model.structured_output.rejected") &&
    event.payload !== undefined && inCompletedStage(event))
    .flatMap((event) => event.correlation?.modelInvocationId ? [[event.correlation.modelInvocationId, event] as const] : []));
  const audits = new Map(events.filter((event) => event.event === "model.audit.persisted" &&
    event.payload !== undefined && inCompletedStage(event))
    .flatMap((event) => event.correlation?.modelInvocationId ? [[event.correlation.modelInvocationId, event] as const] : []));
  const incomplete = [...started.keys()].filter((id) => !outputs.has(id) || !audits.has(id));
  if (incomplete.length > 0) {
    return `debug checkpoint is missing ${incomplete.length} recorded model continuation${incomplete.length === 1 ? "" : "s"}`;
  }
  for (const [id, start] of started) {
    const output = outputs.get(id)!;
    const auditEvent = audits.get(id)!;
    if (!auditEvent.payload || typeof auditEvent.payload !== "object" || Array.isArray(auditEvent.payload)) {
      return "debug checkpoint contains invalid recorded model continuation evidence";
    }
    const audit = auditEvent.payload as Partial<ModelExecutionAudit>;
    const invocation = Array.isArray(audit.invocations)
      ? audit.invocations.find((candidate) => candidate?.id === id)
      : undefined;
    const responseHash = contentHash(output.payload);
    if (!invocation || typeof audit.role !== "string" || typeof audit.subjectId !== "string" ||
      typeof audit.profileId !== "string" ||
      (start.hashes?.request !== undefined && start.hashes.request !== invocation.requestHash) ||
      (output.hashes?.response !== undefined && output.hashes.response !== responseHash) ||
      (invocation.responseHash !== null && invocation.responseHash !== responseHash) ||
      (start.correlation?.modelRole !== undefined && start.correlation.modelRole !== audit.role) ||
      (start.correlation?.modelSubject !== undefined && start.correlation.modelSubject !== audit.subjectId) ||
      (start.attributes?.profileId !== undefined && start.attributes.profileId !== audit.profileId)) {
      return "debug checkpoint contains invalid recorded model continuation evidence";
    }
  }
  return null;
}

/**
 * Replays only model work that belongs to stages already sealed by a debug
 * checkpoint. Requests from the next stage continue through the live provider.
 */
export class DebugCheckpointModelProvider implements StructuredModelProvider {
  private readonly memoryRetries: Set<string>;
  private readonly contextRejections = new Map<string, { profileId: string; message: string }>();
  readonly catalog;
  private readonly outputs = new Map<string, RecordedStageOutput>();
  private readonly consumed = new Set<string>();

  constructor(
    private readonly live: StructuredModelProvider,
    events: readonly RuntimeEvent[],
    completedStageIndex: number,
  ) {
    this.catalog = live.catalog;
    this.memoryRetries = new Set(events.filter(event => event.event === "model.memory.context.retry" &&
      (event.correlation?.logicalStageIndex ?? Number.MAX_SAFE_INTEGER) <= completedStageIndex)
      .map(event => (event.payload as { modelInvocationId: string }).modelInvocationId));
    for (const event of events.filter(event => event.event === "model.context.rejected" &&
      (event.correlation?.logicalStageIndex ?? Number.MAX_SAFE_INTEGER) <= completedStageIndex)) {
      const rejection = event.payload as { modelInvocationId: string; profileId: string; message: string };
      this.contextRejections.set(rejection.modelInvocationId, rejection);
    }
    const audits = new Map<string, ModelExecutionAudit>();
    for (const event of events) {
      if (event.event !== "model.audit.persisted" || event.payload === undefined ||
        (event.correlation?.logicalStageIndex ?? Number.MAX_SAFE_INTEGER) > completedStageIndex) continue;
      const audit = event.payload as ModelExecutionAudit;
      for (const invocation of audit.invocations ?? []) audits.set(invocation.id, structuredClone(audit));
    }
    for (const event of events) {
      if ((event.event !== "model.structured_output.parsed" && event.event !== "model.structured_output.rejected") ||
        event.payload === undefined ||
        (event.correlation?.logicalStageIndex ?? Number.MAX_SAFE_INTEGER) > completedStageIndex) continue;
      const invocationId = event.correlation?.modelInvocationId;
      const audit = invocationId ? audits.get(invocationId) : undefined;
      if (!invocationId || !audit) continue;
      this.outputs.set(invocationId, {
        audit,
        event,
        rejected: event.event === "model.structured_output.rejected" ||
          audit.invocations.some((invocation) => invocation.id === invocationId && invocation.outputDisposition === "rejected"),
        value: structuredClone(event.payload),
      });
    }
  }

  availableProfileSummaries(role?: ModelRole) {
    return this.live.availableProfileSummaries(role);
  }

  assertProfilesAvailable(profileIds: readonly string[]): Promise<void> {
    return this.live.assertProfilesAvailable(profileIds);
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    const invocationId = request.modelInvocationId ?? (request.modelInvocation
      ? modelInvocationIdentity(request, request.role, request.subjectId, request.modelInvocation).modelInvocationId : undefined);
    if (invocationId && this.memoryRetries.delete(invocationId)) throw new MemoryContextChanged();
    const rejection = invocationId ? this.contextRejections.get(invocationId) : undefined;
    if (rejection) {
      if (rejection.profileId !== request.profileId) throw new Error(`debug checkpoint preflight identity mismatch: ${invocationId}`);
      this.contextRejections.delete(invocationId!);
      throw new ContextLimitExceededError(rejection.message);
    }
    const output = invocationId ? this.outputs.get(invocationId) : undefined;
    if (!invocationId || !output) return this.live.generateStructured(request);
    if (this.consumed.has(invocationId)) {
      throw new Error(`debug checkpoint model output was consumed twice: ${invocationId}`);
    }
    if (output.audit.role !== request.role || output.audit.subjectId !== request.subjectId ||
      output.audit.profileId !== request.profileId) {
      throw new Error(`debug checkpoint model output identity mismatch: ${invocationId}`);
    }
    this.consumed.add(invocationId);
    const correlation = {
      ...request.correlation,
      ...(request.logicalStage ? {
        logicalStageIndex: request.logicalStage.index,
        logicalStageKey: request.logicalStage.key,
      } : {}),
      modelInvocationId: invocationId,
      modelRole: request.role,
      modelSubject: request.subjectId,
      modelInvocation: request.modelInvocation ?? 1,
    };
    request.observer?.emit({
      event: "model.invocation.started",
      correlation,
      attributes: {
        profileId: output.audit.profileId,
        accountId: output.audit.accountId,
        providerId: output.audit.providerId,
        modelId: output.audit.modelId,
        promptVersion: output.audit.promptVersion,
        schemaName: request.schemaName,
        replayed: true,
      },
    });
    request.observer?.emit({
      event: output.rejected ? "model.structured_output.rejected" : "model.structured_output.parsed",
      level: output.rejected ? "warn" : "info",
      correlation,
      hashes: { response: contentHash(output.value) },
      payload: output.value,
    });
    request.observer?.emit({
      event: "model.audit.persisted",
      level: output.rejected ? "warn" : "info",
      correlation,
      payload: output.audit,
    });
    request.observer?.emit({
      event: "model.replay_output.consumed",
      correlation,
      links: output.event.traceId && output.event.spanId
        ? [{ traceId: output.event.traceId, spanId: output.event.spanId }]
        : [],
      hashes: { response: contentHash(output.value) },
    });
    request.observer?.flush?.();
    const parsed = request.schema.safeParse(output.value);
    if (!parsed.success || output.rejected) {
      throw new ModelOutputError(
        parsed.success ? "recorded model output was rejected" : parsed.error.message,
        structuredClone(output.audit),
        { rawValue: structuredClone(output.value) },
      );
    }
    return { value: parsed.data, audit: structuredClone(output.audit) };
  }
}
