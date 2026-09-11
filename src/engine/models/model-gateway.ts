import { z } from "zod";
import {
  createModelProviderAdapter,
  structuredOutputMode,
  validateModelProviderAccount,
  type ModelAdapterResult,
  type ModelProviderAdapter,
} from "./model-adapter";
import type { ModelCatalog } from "./model-catalog";
import { canonicalize, contentHash, prepareModelContext } from "./model-audit";
import {
  type ModelRegistryService,
  type ModelRegistrySnapshot,
  resolveModelProfile,
} from "./model-registry";
import type {
  ModelExecutionAudit,
  ModelInvocationAudit,
  ModelSymbolRepairAudit,
  ModelTransportAttemptAudit,
} from "../contracts/model";
import { createReferenceResolver, normalizeModelOutput } from "../contracts/model-context";
import { validationIssues } from "../contracts/prompts";
import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
  ModelRegistryDiagnostics,
  ModelRegistryRefreshDiagnostics,
} from "./model-provider";
import {
  ModelConfigurationError,
  ContextLimitExceededError,
  modelInvocationIdentity,
  ModelOutputError,
  ModelTransportError,
} from "./model-provider";
import {
  FairModelScheduler,
  ModelOverloadedError,
  ModelScheduledExecutionError,
} from "./model-scheduler";
import {
  NOOP_RUNTIME_OBSERVER,
  fullRuntimePayload,
  runtimeEventEmitter,
  serializeRuntimeError,
  type RuntimeCorrelation,
  type RuntimeObserver,
} from "../runtime/observability";
import type { ResolvedModelBinding } from "./model-registry";
import type { ProviderAccountConfig } from "./model-catalog";
import { structuredPromptBytes } from "../prompts";

function referenceCatalogAudit(context: unknown): { version: number; hash: string } {
  const record = context && typeof context === "object" && !Array.isArray(context)
    ? context as {
        referenceCatalog?: { version?: number; hash?: string };
        referenceCatalogs?: readonly { slot: number; catalog: { version?: number; hash?: string } }[];
        slots?: readonly { slot: number; referenceCatalog?: { version?: number; hash?: string } }[];
      }
    : undefined;
  const catalog = record?.referenceCatalog;
  const isolatedCatalogs = record?.referenceCatalogs;
  if (isolatedCatalogs?.length) {
    return {
      version: isolatedCatalogs[0]?.catalog.version ?? catalog?.version ?? 1,
      hash: contentHash(isolatedCatalogs.map(({ slot, catalog: entry }) => ({ slot, version: entry.version ?? 1, hash: entry.hash ?? null }))),
    };
  }
  const agentMindCatalogs = record?.slots?.filter((slot) => slot.referenceCatalog !== undefined)
    .map(({ slot, referenceCatalog }) => ({ slot, catalog: referenceCatalog! })) ?? [];
  if (agentMindCatalogs.length) {
    return {
      version: agentMindCatalogs[0]?.catalog.version ?? catalog?.version ?? 1,
      hash: contentHash(agentMindCatalogs.map(({ slot, catalog: entry }) => ({
        slot,
        version: entry.version ?? 1,
        hash: entry.hash ?? null,
      }))),
    };
  }
  return {
    version: catalog?.version ?? 1,
    hash: catalog?.hash ?? contentHash(catalog ?? null),
  };
}

export interface ModelGatewayOptions {
  registry: ModelRegistryService;
  scheduler?: FairModelScheduler;
  adapters?: ReadonlyMap<string, ModelProviderAdapter>;
  maxTransportAttempts?: number;
  fetch?: typeof fetch;
  /** Resolve an account-specific transport without changing other accounts. */
  fetchForAccount?: (
    accountId: string,
    account: ProviderAccountConfig,
  ) => typeof fetch | undefined;
  now?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  observer?: RuntimeObserver;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", aborted);
      reject(abortError());
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function abortError(): Error {
  const error = new Error("model request aborted");
  error.name = "AbortError";
  return error;
}

function statusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  if (typeof candidate.status === "number") return candidate.status;
  return statusCode(candidate.cause);
}

function responseHeaders(error: unknown): Record<string, string> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as Record<string, unknown>;
  const headers = candidate.responseHeaders;
  if (headers && typeof headers === "object") return headers as Record<string, string>;
  return responseHeaders(candidate.cause);
}

function retryAfterMs(error: unknown, now: number): number | undefined {
  const headers = responseHeaders(error);
  const raw = headers && Object.entries(headers)
    .find(([key]) => key.toLowerCase() === "retry-after")?.[1];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

function isRetryableTransportError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted || error instanceof ModelOverloadedError) return false;
  const code = statusCode(error);
  if (code !== undefined) return code === 408 || code === 429 || code >= 500;
  if (error instanceof z.ZodError || error instanceof SyntaxError) return false;
  const name = error instanceof Error ? error.name : "";
  return name === "APICallError" || name === "TypeError" || name === "TimeoutError" || name === "AbortError";
}

function isOutputError(error: unknown): boolean {
  if (error instanceof ModelOutputError || error instanceof z.ZodError || error instanceof SyntaxError) return true;
  const name = error instanceof Error ? error.name : "";
  return name === "NoOutputGeneratedError" || name === "NoObjectGeneratedError" ||
    name === "AI_NoOutputGeneratedError" || name === "AI_NoObjectGeneratedError";
}

function unwrapScheduledError(error: unknown): unknown {
  return error instanceof ModelScheduledExecutionError ? error.cause : error;
}

function safeDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\b(?:sk|key)-[a-z0-9_-]{8,}\b/giu, "[redacted]")
    .slice(0, 500);
}

function executionAudit(
  binding: ResolvedModelBinding,
  request: Pick<StructuredModelRequest<unknown>, "role" | "subjectId" | "profileId" | "promptVersion">,
  adapter: Pick<ModelAdapterResult, "resolvedInference" | "structuredOutputMode">,
  catalog: ModelCatalog,
  invocations: ModelInvocationAudit[],
): ModelExecutionAudit {
  return {
    role: request.role,
    subjectId: request.subjectId,
    profileId: request.profileId,
    accountId: binding.accountId,
    accountChannel: binding.account.channel,
    protocol: binding.account.protocol,
    dialect: binding.account.dialect,
    providerId: binding.account.models_dev_provider_id,
    modelId: binding.modelId,
    selector: structuredClone(binding.selector),
    registrySnapshotHash: binding.registrySnapshotHash,
    modelMetadataHash: binding.modelMetadataHash,
    modelCatalogSchemaVersion: catalog.schemaVersion,
    modelCatalogHash: catalog.hash,
    promptVersion: request.promptVersion,
    requestedInference: structuredClone(binding.profile.inference),
    resolvedInference: structuredClone(adapter.resolvedInference),
    structuredOutputMode: adapter.structuredOutputMode,
    invocations,
  };
}

export class ModelGateway implements StructuredModelProvider {
  readonly catalog: ModelCatalog;
  private readonly adapters = new Map<string, ModelProviderAdapter>();
  private readonly scheduler: FairModelScheduler;
  private readonly maxTransportAttempts: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private readonly observer: RuntimeObserver;
  private readonly emittedContracts = new Set<string>();
  private readonly executionSnapshots = new Map<string, Promise<ModelRegistrySnapshot>>();
  readonly registry: ModelRegistryService;

  constructor(
    catalog: ModelCatalog,
    env: Readonly<Record<string, string | undefined>>,
    options: ModelGatewayOptions,
  ) {
    this.catalog = catalog;
    this.registry = options.registry;
    if (this.registry.catalog.hash !== catalog.hash) {
      throw new Error("model registry and catalog hashes do not match");
    }
    for (const [accountId, account] of Object.entries(catalog.accounts)) {
      validateModelProviderAccount(account);
      const configuredAdapter = options.adapters?.get(accountId);
      const apiKey = env[account.api_key_env]?.trim();
      if (!configuredAdapter && !apiKey) continue;
      const accountFetch = options.fetchForAccount?.(accountId, account);
      const adapter = configuredAdapter ?? createModelProviderAdapter(
        accountId,
        account,
        apiKey!,
        accountFetch ?? options.fetch,
      );
      if (adapter.accountId !== accountId || adapter.protocol !== account.protocol ||
        adapter.dialect !== account.dialect) {
        throw new Error(`model provider adapter identity mismatch: ${accountId}`);
      }
      this.adapters.set(accountId, adapter);
    }
    this.scheduler = options.scheduler ?? new FairModelScheduler({
      globalConcurrency: catalog.scheduler.global_concurrency,
      maxQueuedRequests: catalog.scheduler.max_queued_requests,
      queueTimeoutMs: catalog.scheduler.queue_timeout_ms,
      providerConcurrency: Object.fromEntries(
        Object.entries(catalog.accounts).map(([id, account]) => [id, account.max_concurrency]),
      ),
    });
    this.maxTransportAttempts = options.maxTransportAttempts ?? 3;
    if (!Number.isSafeInteger(this.maxTransportAttempts) || this.maxTransportAttempts <= 0) {
      throw new Error("max transport attempts must be a positive integer");
    }
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? defaultSleep;
    this.observer = options.observer ?? NOOP_RUNTIME_OBSERVER;
  }

  private requireAdapter(accountId: string): ModelProviderAdapter {
    const adapter = this.adapters.get(accountId);
    if (adapter) return adapter;
    const account = this.catalog.account(accountId);
    throw new ModelConfigurationError(`model account ${accountId} requires ${account.api_key_env}`);
  }

  availableProfileSummaries(role?: Parameters<ModelCatalog["profileSummaries"]>[0]) {
    return this.catalog.profileSummaries(role)
      .filter((profile) => this.adapters.has(profile.accountId));
  }

  async modelRegistryDiagnostics(): Promise<ModelRegistryDiagnostics> {
    let snapshot: ModelRegistrySnapshot | null = null;
    let captureError: string | null = null;
    try {
      snapshot = await this.registry.capture();
    } catch (error) {
      captureError = safeDiagnosticError(error);
    }
    const accounts = Object.entries(this.catalog.accounts)
      .map(([id, account]) => ({
        id,
        channel: account.channel,
        region: account.region,
        protocol: account.protocol,
        credentialConfigured: this.adapters.has(id),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    const profiles = this.catalog.profileSummaries().map((summary) => {
      if (!snapshot) {
        return {
          id: summary.id,
          accountId: summary.accountId,
          credentialConfigured: this.adapters.has(summary.accountId),
          resolvedModelId: null,
          modelMetadataHash: null,
          structuredOutputMode: null,
          resolutionError: captureError ?? "model registry snapshot is unavailable",
        };
      }
      try {
        const binding = resolveModelProfile(this.catalog, snapshot, summary.id);
        return {
          id: summary.id,
          accountId: summary.accountId,
          credentialConfigured: this.adapters.has(summary.accountId),
          resolvedModelId: binding.modelId,
          modelMetadataHash: binding.modelMetadataHash,
          structuredOutputMode: structuredOutputMode(binding),
          resolutionError: null,
        };
      } catch (error) {
        return {
          id: summary.id,
          accountId: summary.accountId,
          credentialConfigured: this.adapters.has(summary.accountId),
          resolvedModelId: null,
          modelMetadataHash: null,
          structuredOutputMode: null,
          resolutionError: safeDiagnosticError(error),
        };
      }
    });
    const registry = this.registry.status();
    return {
      catalog: { schemaVersion: this.catalog.schemaVersion, hash: this.catalog.hash },
      registry: {
        ...registry,
        lastError: registry.lastError ? safeDiagnosticError(registry.lastError) : null,
      },
      accounts,
      profiles,
    };
  }

  async refreshModelRegistry(): Promise<ModelRegistryRefreshDiagnostics> {
    const result = await this.registry.refresh({ reason: "manual" });
    return {
      outcome: result.outcome,
      checkedAt: result.checkedAt,
      error: result.error ? safeDiagnosticError(result.error) : null,
      diagnostics: await this.modelRegistryDiagnostics(),
    };
  }

  async assertProfilesAvailable(profileIds: readonly string[]): Promise<void> {
    const accountIds = new Set(profileIds.map((profileId) => {
      return this.catalog.profile(profileId).account_id;
    }));
    for (const accountId of [...accountIds].sort()) this.requireAdapter(accountId);
    const snapshot = await this.registry.capture();
    for (const profileId of profileIds) resolveModelProfile(this.catalog, snapshot, profileId);
  }

  private async captureSnapshot<T>(request: StructuredModelRequest<T>): Promise<ModelRegistrySnapshot> {
    const executionId = request.correlation?.executionId;
    if (!executionId) return this.registry.capture(request.modelRegistrySnapshotHash);
    const existing = this.executionSnapshots.get(executionId);
    if (existing) {
      const snapshot = await existing;
      if (request.modelRegistrySnapshotHash && request.modelRegistrySnapshotHash !== snapshot.hash) {
        throw new ModelConfigurationError(
          `execution ${executionId} is already bound to model registry snapshot ${snapshot.hash}`,
        );
      }
      return snapshot;
    }
    const capture = this.registry.capture(request.modelRegistrySnapshotHash);
    this.executionSnapshots.set(executionId, capture);
    capture.catch(() => {
      if (this.executionSnapshots.get(executionId) === capture) this.executionSnapshots.delete(executionId);
    });
    while (this.executionSnapshots.size > 4_096) {
      const oldest = this.executionSnapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.executionSnapshots.delete(oldest);
    }
    return capture;
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    if (!request.workloadId.trim() || !request.batchId.trim() || !request.subjectId.trim() ||
      !request.promptVersion.trim() || !request.schemaName.trim() || !request.system.trim() ||
      !request.userPrompt.trim()) {
      throw new Error("structured model request identity is incomplete");
    }
    this.catalog.assertProfile(request.profileId, request.role);
    const snapshot = await this.captureSnapshot(request);
    const binding = resolveModelProfile(this.catalog, snapshot, request.profileId);
    const profile = binding.profile;
    const account = binding.account;
    const adapter = this.requireAdapter(binding.accountId);
    const adapterDescription = adapter.describe(binding, request);
    const observer = request.observer ?? this.observer;
    const observe = runtimeEventEmitter(observer);
    const modelInvocation = request.modelInvocation ?? 1;
    const modelInvocationId = request.modelInvocationId ?? modelInvocationIdentity(
      request,
      request.role,
      request.subjectId,
      modelInvocation,
    ).modelInvocationId;
    const correlation: RuntimeCorrelation = {
      ...request.correlation,
      ...(request.logicalStage ? {
        logicalStageIndex: request.logicalStage.index,
        logicalStageKey: request.logicalStage.key,
      } : {}),
      modelInvocationId,
      modelRole: request.role,
      modelSubject: request.subjectId,
      modelInvocation,
    };
    const normalizeStartedAt = this.now();
    const preparedContext = prepareModelContext(request.context);
    const context = preparedContext.value;
    observe?.({
      event: "model.context.normalized",
      correlation,
      durationMs: Math.max(0, this.now() - normalizeStartedAt),
      hashes: { context: preparedContext.hash },
    });
    const serializationStartedAt = this.now();
    const schema = canonicalize(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
    const promptBytes = structuredPromptBytes({
      system: request.system,
      userPrompt: request.userPrompt,
      context,
      schema: request.schema,
      wireJsonSchema: request.wireJsonSchema,
      repairContextPlacement: request.repairContextPlacement,
      jsonObjectPostlude: request.jsonObjectPostlude,
      contextLayout: request.contextLayout,
    });
    const contextJson = promptBytes.contextJson;
    const contextAudit = preparedContext.measure(contextJson);
    const rendering = {
      ...(profile.response_transport ? { responseTransport: profile.response_transport } : {}),
      ...(request.jsonObjectPostlude !== undefined ? { jsonObjectPostlude: request.jsonObjectPostlude } : {}),
      ...(request.jsonExamplePolicy ? { jsonExamplePolicy: request.jsonExamplePolicy } : {}),
      ...(request.repairContextPlacement ? { repairContextPlacement: request.repairContextPlacement } : {}),
      ...(request.jsonSyntaxRecovery ? { jsonSyntaxRecovery: request.jsonSyntaxRecovery } : {}),
    ...(request.contextLayout ? { contextLayout: request.contextLayout } : {}),
    };
    const contractHash = contentHash({ system: request.system, userPrompt: request.userPrompt, schema, ...rendering });
    const requestDocument = {
      ...rendering,
      modelCatalogHash: this.catalog.hash,
      workloadId: request.workloadId,
      batchId: request.batchId,
      role: request.role,
      subjectId: request.subjectId,
      profileId: request.profileId,
      profile,
      accountId: binding.accountId,
      providerId: account.models_dev_provider_id,
      protocol: account.protocol,
      dialect: account.dialect,
      selector: binding.selector,
      registrySnapshotHash: binding.registrySnapshotHash,
      modelId: binding.modelId,
      modelMetadataHash: binding.modelMetadataHash,
      resolvedInference: adapterDescription.resolvedInference,
      promptVersion: request.promptVersion,
      schemaName: request.schemaName,
      schema,
      system: request.system,
      userPrompt: request.userPrompt,
      context,
    };
    const requestHash = contentHash(requestDocument);
    const requestUtf8Bytes = promptBytes.requestUtf8Bytes;
    if (requestUtf8Bytes > profile.max_input_bytes) {
      throw new ContextLimitExceededError(
        `model profile ${request.profileId} request is ${requestUtf8Bytes} bytes; ` +
        `maximum is ${profile.max_input_bytes} bytes`,
      );
    }
    observe?.({
      event: "model.context.serialized",
      correlation,
      durationMs: Math.max(0, this.now() - serializationStartedAt),
      measurements: {
        contextUtf8Bytes: contextAudit.utf8Bytes,
        systemPromptUtf8Bytes: Buffer.byteLength(request.system, "utf8"),
        userPromptUtf8Bytes: Buffer.byteLength(request.userPrompt, "utf8"),
        requestUtf8Bytes,
      },
      counts: contextAudit.counts,
      hashes: { context: preparedContext.hash, request: requestHash, contract: contractHash },
      payload: fullRuntimePayload(observer, requestDocument),
    });
    const contractEmissionKey = `${observer.mode}:${contractHash}`;
    if (observe && !this.emittedContracts.has(contractEmissionKey)) {
      this.emittedContracts.add(contractEmissionKey);
      observe({
        event: "model.contract.registered",
        correlation,
        hashes: { contract: contractHash },
        measurements: {
          systemUtf8Bytes: Buffer.byteLength(request.system, "utf8"),
          schemaUtf8Bytes: Buffer.byteLength(JSON.stringify(schema), "utf8"),
        },
        payload: fullRuntimePayload(observer, { system: request.system, userPrompt: request.userPrompt, schema, ...rendering }),
      });
    }
    observe?.({
      event: "model.invocation.started",
      correlation,
      attributes: {
        profileId: request.profileId,
        accountId: binding.accountId,
        providerId: account.models_dev_provider_id,
        modelId: binding.modelId,
        promptVersion: request.promptVersion,
        schemaName: request.schemaName,
      },
      hashes: { request: requestHash, contract: contractHash },
      measurements: {
        requestUtf8Bytes,
        contextUtf8Bytes: contextAudit.utf8Bytes,
        systemPromptUtf8Bytes: Buffer.byteLength(request.system, "utf8"),
        userPromptUtf8Bytes: Buffer.byteLength(request.userPrompt, "utf8"),
      },
    });
    observer.flush?.();
    const transports: ModelTransportAttemptAudit[] = [];
    const dispatchSignal = request.cancelPendingSignal
      ? AbortSignal.any([request.cancelPendingSignal, ...(request.abortSignal ? [request.abortSignal] : [])])
      : request.abortSignal;
    let transportAttempts = 0;
    let auditPersisted = false;

    while (transportAttempts < this.maxTransportAttempts) {
      transportAttempts += 1;
      let completedResult: ModelAdapterResult | undefined;
      const transportCorrelation = { ...correlation, transportAttempt: transportAttempts };
      observe?.({
        event: "model.queue.started",
        correlation: transportCorrelation,
        attributes: { accountId: binding.accountId, modelId: binding.modelId },
      });
      try {
        const scheduled = await this.scheduler.schedule({
          providerId: binding.accountId,
          workloadId: request.workloadId,
          abortSignal: dispatchSignal,
          execute: () => {
            dispatchSignal?.throwIfAborted();
            observe?.({
              event: "model.transport.started",
              correlation: transportCorrelation,
              attributes: { accountId: binding.accountId, modelId: binding.modelId },
            });
            return adapter.generate(
              binding,
              request.observer === observer ? request : { ...request, observer },
              contextJson,
              transportCorrelation,
            );
          },
        });
        transports.push({
          attempt: transportAttempts,
          queueWaitMs: scheduled.queueWaitMs,
          executionMs: scheduled.executionMs,
          retryDelayMs: 0,
          status: "succeeded",
          errorName: null,
          statusCode: null,
        });
        observe?.({
          event: "model.queue.completed",
          correlation: transportCorrelation,
          durationMs: scheduled.queueWaitMs,
          measurements: { queueWaitMs: scheduled.queueWaitMs },
        });
        observe?.({
          event: "model.transport.completed",
          correlation: transportCorrelation,
          durationMs: scheduled.executionMs,
          measurements: {
            queueWaitMs: scheduled.queueWaitMs,
            executionMs: scheduled.executionMs,
          },
          attributes: { status: "succeeded" },
        });
        completedResult = scheduled.value;
        const parseStartedAt = this.now();
        const parsedOutput = request.schema.parse(scheduled.value.value);
        const contextCatalog = request.context && typeof request.context === "object" && !Array.isArray(request.context) &&
          "referenceCatalog" in request.context
          ? (request.context as { referenceCatalog?: { candidates?: readonly { handle?: string; candidateKey?: string; kind: import("../contracts/model-context").ModelReferenceKind; label: string; meaning: string; allowedUses: readonly import("../contracts/model-context").ModelReferenceUse[]; visibility?: "public" | "role" | "slot" }[] } }).referenceCatalog
          : undefined;
        // Batched Agent requests carry one isolated catalog per slot. The
        // slot materializer performs the authoritative reference check; a
        // single request-level resolver would either leak private handles or
        // reject valid handles from every slot as unknown.
        const hasIsolatedSlotCatalogs = request.context && typeof request.context === "object" &&
          !Array.isArray(request.context) && "referenceCatalogs" in request.context;
        const catalogCandidates = contextCatalog?.candidates ?? [];
        const referenceResolver = contextCatalog && !hasIsolatedSlotCatalogs &&
          catalogCandidates.length > 0 && catalogCandidates.every((candidate) => typeof candidate.handle === "string")
          ? createReferenceResolver(catalogCandidates.map((candidate) => ({
              ...candidate,
              engineId: candidate.handle as string,
              visibility: candidate.visibility ?? "role",
            })))
          : undefined;
        const normalized = normalizeModelOutput(parsedOutput, { resolver: referenceResolver, dedupeArrays: true });
        const output = normalized.value;
        const parserRecovered = scheduled.value.jsonRecovery !== "strict";
        const symbolRepairs: ModelSymbolRepairAudit[] = [
          ...(scheduled.value.symbolRepairs ?? []),
          ...normalized.symbolRepairs,
        ];
        const symbolRepairAcceptedCount = symbolRepairs.filter((repair) =>
          repair.status === "repaired" || repair.status === "normalized").length;
        const symbolRepairAmbiguousCount = symbolRepairs.filter((repair) => repair.status === "ambiguous").length;
        const symbolRepairUnmatchedCount = symbolRepairs.filter((repair) => repair.status === "unmatched").length;
        const symbolRepairPostValidationRejectedCount = symbolRepairs.filter((repair) =>
          repair.status === "postvalidation-rejected").length;
        const responseJson = JSON.stringify(canonicalize(output));
        const responseHash = contentHash(output);
        const rawOutputHash = scheduled.value.rawValueHash;
        const invocation: ModelInvocationAudit = {
          id: modelInvocationId,
          ordinal: modelInvocation,
          requestHash,
          responseHash,
          requestUtf8Bytes,
          responseUtf8Bytes: Buffer.byteLength(responseJson, "utf8"),
          context: contextAudit,
          transports,
          tokenUsage: scheduled.value.tokenUsage,
          finishReason: scheduled.value.finishReason,
          providerRequestId: scheduled.value.responseId || null,
          resultKind: null,
          outputDisposition: normalized.issues.length > 0 ? "rejected" : parserRecovered || normalized.modifiedFieldCount > 0 || normalized.deduplicatedCount > 0 || symbolRepairAcceptedCount > 0 ? "auto-normalized" : "accepted",
          issues: [
            ...(parserRecovered ? [{
              code: `json.${scheduled.value.jsonRecovery}`,
              class: "structure" as const,
              path: [],
              message: `provider JSON was recovered with ${scheduled.value.jsonRecovery}`,
              originalValue: null,
              allowedHandles: [],
            }] : []),
            ...normalized.issues.map((issue) => ({
              code: issue.code,
              class: issue.class,
              path: issue.path,
              message: issue.reason,
              originalValue: issue.originalValue,
              allowedHandles: [...issue.allowedHandles],
            })),
          ],
          normalization: {
            applied: parserRecovered || normalized.modifiedFieldCount > 0 || normalized.deduplicatedCount > 0 || symbolRepairAcceptedCount > 0,
            modifiedFieldCount: normalized.modifiedFieldCount + symbolRepairAcceptedCount,
            resolvedReferenceCount: normalized.resolvedReferenceCount,
            proposalCount: normalized.proposalCount,
            deduplicatedCount: normalized.deduplicatedCount,
            symbolRepairCount: symbolRepairs.length,
            symbolRepairAcceptedCount,
            symbolRepairAmbiguousCount,
            symbolRepairUnmatchedCount,
            symbolRepairPostValidationRejectedCount,
          },
          symbolRepairs: structuredClone(symbolRepairs),
          referenceCatalogVersion: referenceCatalogAudit(request.context).version,
          referenceCatalogHash: referenceCatalogAudit(request.context).hash,
          rawOutputHash,
          normalizedOutputHash: responseHash,
          ...(scheduled.value.jsonRecoveryEvidence ? { jsonRecoveryEvidence: structuredClone(scheduled.value.jsonRecoveryEvidence) } : {}),
        };
        const audit = executionAudit(binding, request, scheduled.value, this.catalog, [invocation]);
        observe?.({
          event: "model.audit.persisted",
          correlation,
          hashes: { request: requestHash, response: responseHash },
          payload: fullRuntimePayload(observer, audit),
        });
        auditPersisted = true;
        observe?.({
          event: "model.structured_output.parsed",
          correlation,
          durationMs: Math.max(0, this.now() - parseStartedAt),
          attributes: {
            finishReason: scheduled.value.finishReason,
            providerRequestId: scheduled.value.responseId || null,
          },
          measurements: {
            responseUtf8Bytes: invocation.responseUtf8Bytes,
            inputTokens: scheduled.value.tokenUsage.input,
            outputTokens: scheduled.value.tokenUsage.output,
            reasoningTokens: scheduled.value.tokenUsage.reasoning,
            cacheReadTokens: scheduled.value.tokenUsage.cacheRead,
            cacheWriteTokens: scheduled.value.tokenUsage.cacheWrite,
          },
          hashes: { request: requestHash, response: responseHash },
          payload: fullRuntimePayload(observer, output),
        });
        observe?.({
          event: "model.output.normalized",
          correlation,
          attributes: { applied: invocation.normalization.applied },
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
          hashes: { rawOutput: rawOutputHash, normalizedOutput: responseHash },
          payload: normalized.issues.length > 0
            ? fullRuntimePayload(observer, { issues: normalized.issues, symbolRepairs })
            : symbolRepairs.length > 0 ? fullRuntimePayload(observer, { symbolRepairs }) : undefined,
        });
        if (normalized.issues.length > 0) {
          throw new ModelOutputError("model output contains unresolved semantic references", audit, {
            rawValue: scheduled.value.value,
          });
        }
        observe?.({
          event: "model.invocation.provider_completed",
          correlation,
          attributes: { result: "structured_output" },
          counts: { transportAttempts: transports.length },
          measurements: {
            queueWaitMs: transports.reduce((sum, attempt) => sum + attempt.queueWaitMs, 0),
            executionMs: transports.reduce((sum, attempt) => sum + attempt.executionMs, 0),
            retryDelayMs: transports.reduce((sum, attempt) => sum + attempt.retryDelayMs, 0),
          },
          hashes: { request: requestHash, response: responseHash },
        });
        observer.flush?.();
        return {
          value: output,
          audit,
        };
      } catch (scheduledError) {
        let queueWaitMs = 0;
        let executionMs = 0;
        if (scheduledError instanceof ModelScheduledExecutionError) {
          queueWaitMs = scheduledError.queueWaitMs;
          executionMs = scheduledError.executionMs;
        }
        const error = unwrapScheduledError(scheduledError);
        const outputError = isOutputError(error);
        const retryable = transportAttempts < this.maxTransportAttempts &&
          isRetryableTransportError(error, dispatchSignal);
        const transportCompleted = transports.some((attempt) =>
          attempt.attempt === transportAttempts && attempt.status === "succeeded");
        const transportAudit: ModelTransportAttemptAudit = transportCompleted
          ? transports.at(-1)!
          : {
              attempt: transportAttempts,
              queueWaitMs,
              executionMs,
              retryDelayMs: 0,
              status: outputError ? "succeeded" : retryable ? "retryable_error" : "failed",
              errorName: outputError ? null : error instanceof Error ? error.name : "NonError",
              statusCode: outputError ? null : statusCode(error) ?? null,
            };
        if (!transportCompleted) {
          transports.push(transportAudit);
          observe?.({
            event: outputError || scheduledError instanceof ModelScheduledExecutionError
              ? "model.queue.completed"
              : "model.queue.failed",
            level: outputError || scheduledError instanceof ModelScheduledExecutionError ? "info" : "warn",
            correlation: transportCorrelation,
            durationMs: queueWaitMs,
            measurements: { queueWaitMs },
            error: outputError || scheduledError instanceof ModelScheduledExecutionError
              ? undefined
              : serializeRuntimeError(error),
          });
          if (outputError) {
            observe?.({
              event: "model.transport.completed",
              correlation: transportCorrelation,
              durationMs: executionMs,
              measurements: { queueWaitMs, executionMs },
              attributes: { status: "succeeded" },
            });
          } else {
            observe?.({
              event: "model.transport.failed",
              level: retryable ? "warn" : "error",
              correlation: transportCorrelation,
              durationMs: executionMs,
              attributes: { status: transportAudit.status },
              measurements: { queueWaitMs, executionMs },
              error: serializeRuntimeError(error),
            });
          }
        }
        if (transportAttempts >= this.maxTransportAttempts ||
          !isRetryableTransportError(error, dispatchSignal)) {
          if (isOutputError(error)) {
            if (error instanceof ModelOutputError && error.audit) {
              if (!auditPersisted) {
                observe?.({
                  event: "model.audit.persisted",
                  level: "warn",
                  correlation,
                  hashes: { request: requestHash },
                  payload: fullRuntimePayload(observer, error.audit),
                });
              }
              observer.flush?.();
              throw error;
            }
            const rejectedCompletion = error instanceof ModelOutputError ? error.completion : undefined;
            const rawProviderOutput = completedResult?.value ??
              (error instanceof ModelOutputError ? error.rawValue : undefined);
            const rawProviderOutputHash = rawProviderOutput === undefined ? null : contentHash(rawProviderOutput);
            const rawProviderOutputBytes = rawProviderOutput === undefined ? null : Buffer.byteLength(
              typeof rawProviderOutput === "string"
                ? rawProviderOutput
                : JSON.stringify(canonicalize(rawProviderOutput)),
              "utf8",
            );
            const invocation: ModelInvocationAudit = {
              id: modelInvocationId,
              ordinal: modelInvocation,
              requestHash,
              responseHash: rawProviderOutputHash,
              requestUtf8Bytes,
              responseUtf8Bytes: rawProviderOutputBytes,
              context: contextAudit,
              transports,
              tokenUsage: completedResult?.tokenUsage ?? rejectedCompletion?.tokenUsage ?? {
                  input: null,
                  output: null,
                  reasoning: null,
                  cacheRead: null,
                  cacheWrite: null,
                },
              finishReason: completedResult?.finishReason ?? rejectedCompletion?.finishReason ?? null,
              providerRequestId: completedResult?.responseId || rejectedCompletion?.responseId || null,
              resultKind: null,
              outputDisposition: "rejected",
              issues: validationIssues(error).map((issue) => ({
                code: issue.code, class: issue.class ?? "structure", path: [...issue.path], message: issue.message,
                ...(issue.originalValue !== undefined ? { originalValue: structuredClone(issue.originalValue) } : {}),
                ...(issue.allowedHandles ? { allowedHandles: [...issue.allowedHandles] } : {}),
              })),
              normalization: {
                applied: Boolean(rejectedCompletion?.jsonRecoveryEvidence),
                modifiedFieldCount: 0,
                resolvedReferenceCount: 0,
                proposalCount: 0,
                deduplicatedCount: 0,
                symbolRepairCount: 0,
                symbolRepairAcceptedCount: 0,
                symbolRepairAmbiguousCount: 0,
                symbolRepairUnmatchedCount: 0,
                symbolRepairPostValidationRejectedCount: 0,
              },
              symbolRepairs: [],
              referenceCatalogVersion: referenceCatalogAudit(request.context).version,
              referenceCatalogHash: referenceCatalogAudit(request.context).hash,
              rawOutputHash: rawProviderOutputHash,
              normalizedOutputHash: null,
              ...(rejectedCompletion?.jsonRecoveryEvidence ? { jsonRecoveryEvidence: structuredClone(rejectedCompletion.jsonRecoveryEvidence) } : {}),
            };
            const audit = executionAudit(
              binding,
              request,
              completedResult ?? adapterDescription,
              this.catalog,
              [invocation],
            );
            observe?.({
              event: "model.audit.persisted",
              level: "warn",
              correlation,
              hashes: {
                request: requestHash,
                ...(invocation.responseHash ? { response: invocation.responseHash } : {}),
              },
              payload: fullRuntimePayload(observer, audit),
            });
            auditPersisted = true;
            observe?.({
              event: "model.structured_output.rejected",
              level: "warn",
              correlation,
              measurements: {
                responseUtf8Bytes: invocation.responseUtf8Bytes,
                inputTokens: invocation.tokenUsage.input,
                outputTokens: invocation.tokenUsage.output,
                reasoningTokens: invocation.tokenUsage.reasoning,
                cacheReadTokens: invocation.tokenUsage.cacheRead,
                cacheWriteTokens: invocation.tokenUsage.cacheWrite,
              },
              hashes: {
                request: requestHash,
                ...(invocation.responseHash ? { response: invocation.responseHash } : {}),
              },
              payload: rawProviderOutput === undefined
                ? undefined
                : fullRuntimePayload(observer, rawProviderOutput),
              error: serializeRuntimeError(error),
            });
            observe?.({
              event: "model.invocation.provider_completed",
              level: "warn",
              correlation,
              attributes: { result: "structured_output_rejected" },
              counts: { transportAttempts: transports.length },
              hashes: { request: requestHash },
            });
            observer.flush?.();
            throw new ModelOutputError(
              error instanceof Error ? error.message : String(error),
              audit,
              {
                cause: error,
                rawValue: error instanceof ModelOutputError ? error.rawValue : undefined,
                completion: rejectedCompletion,
              },
            );
          }
          if (error instanceof ModelOverloadedError ||
            (error instanceof Error && error.name === "AbortError")) {
            observe?.({
              event: "model.invocation.failed",
              level: "error",
              correlation,
              attributes: { result: error instanceof ModelOverloadedError ? "overloaded" : "cancelled" },
              counts: { transportAttempts: transports.length },
              hashes: { request: requestHash },
              error: serializeRuntimeError(error),
            });
            observer.flush?.();
            throw error;
          }
          observe?.({
            event: "model.invocation.failed",
            level: "error",
            correlation,
            attributes: { result: "transport_failed" },
            counts: { transportAttempts: transports.length },
            hashes: { request: requestHash },
            error: serializeRuntimeError(error),
          });
          observer.flush?.();
          throw new ModelTransportError(
            error instanceof Error ? error.message : String(error),
            {
              cause: error,
              retriable: isRetryableTransportError(error, dispatchSignal),
              statusCode: statusCode(error) ?? null,
            },
          );
        }
        const serverDelay = retryAfterMs(error, this.now());
        const exponential = Math.min(10_000, 500 * 2 ** (transportAttempts - 1));
        const delayMs = serverDelay ?? Math.floor(this.random() * exponential);
        transportAudit.retryDelayMs = delayMs;
        observe?.({
          event: "model.transport.retry_wait",
          correlation: transportCorrelation,
          durationMs: delayMs,
          attributes: { source: serverDelay === undefined ? "backoff" : "retry-after" },
          measurements: { retryDelayMs: delayMs },
        });
        observer.flush?.();
        try {
          await this.sleep(delayMs, dispatchSignal);
        } catch (retryError) {
          const cancelled = retryError instanceof Error && retryError.name === "AbortError";
          observe?.({
            event: "model.transport.retry_wait.failed",
            level: "error",
            correlation: transportCorrelation,
            attributes: { result: cancelled ? "cancelled" : "failed" },
            error: serializeRuntimeError(retryError),
          });
          observe?.({
            event: "model.invocation.failed",
            level: "error",
            correlation,
            attributes: { result: cancelled ? "cancelled" : "retry_wait_failed" },
            counts: { transportAttempts: transports.length },
            hashes: { request: requestHash },
            error: serializeRuntimeError(retryError),
          });
          observer.flush?.();
          if (cancelled) throw retryError;
          throw new ModelTransportError(
            retryError instanceof Error ? retryError.message : String(retryError),
            { cause: retryError, retriable: false, statusCode: statusCode(retryError) ?? null },
          );
        }
      }
    }
    throw new Error("model transport attempts exhausted");
  }
}

export function createModelGateway(
  catalog: ModelCatalog,
  env: Readonly<Record<string, string | undefined>>,
  options: ModelGatewayOptions,
): ModelGateway {
  return new ModelGateway(catalog, env, options);
}
