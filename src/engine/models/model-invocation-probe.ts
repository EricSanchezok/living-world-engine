import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  canonicalize,
  contentHash,
} from "./model-audit";
import {
  createModelGateway,
} from "./model-gateway";
import { overrideModelInference, resolveModelProfile, type ModelRegistryService, type ModelRegistrySnapshot } from "./model-registry";
import { modelInferenceSchema, type ModelCatalog, type ModelRole } from "./model-catalog";
import {
  ModelOutputError,
  ModelTransportError,
  type StructuredModelProvider,
  type StructuredModelRequest,
} from "./model-provider";
import type { ModelExecutionAudit, ModelSymbolRepairAudit } from "../contracts/model";
import { modelSchemaForName } from "./model-schema-registry";
import { createModelFetchResolver } from "./model-network";
import {
  RecordingRuntimeObserver,
  redactRuntimePayload,
  type RuntimeEvent,
} from "../runtime/observability";
import type { DebugInspection, DebugEventSummary } from "../../shared/debug-api";

export interface SerializedModelRequest {
  inferenceOverrides?: StructuredModelRequest<unknown>["inferenceOverrides"];
  jsonExamplePolicy?: "omit";
  modelCatalogHash: string;
  workloadId: string;
  batchId: string;
  role: ModelRole;
  subjectId: string;
  profileId: string;
  profile: unknown;
  accountId: string;
  providerId: string;
  protocol: string;
  dialect: string;
  selector: unknown;
  registrySnapshotHash: string;
  modelId: string;
  modelMetadataHash: string;
  resolvedInference: unknown;
  promptVersion: string;
  schemaName: string;
  schema: unknown;
  system: string;
  userPrompt: string;
  context: unknown;
}

export interface InvocationProbeSource {
  publicInvocationId: string;
  executionId: string;
  sourceInvocationId: string;
  status: string;
  issueCodes: string[];
  requestHash: string | null;
  request: SerializedModelRequest;
  inspection: DebugInspection;
}

export interface InvocationProbeRequest {
  inferenceOverrides?: StructuredModelRequest<unknown>["inferenceOverrides"];
  jsonExamplePolicy?: "omit";
  profileId: string;
  role: ModelRole;
  subjectId: string;
  promptVersion: string;
  schemaName: string;
  system: string;
  userPrompt: string;
  context: unknown;
  schema: z.ZodTypeAny;
  workloadId: string;
  batchId: string;
  modelRegistrySnapshotHash?: string;
}

export interface InvocationProbeVariantContext {
  source: InvocationProbeSource;
  request: Readonly<InvocationProbeRequest>;
}

export type InvocationProbeRequestPatch = Partial<Pick<
  InvocationProbeRequest,
  "system" | "userPrompt" | "context"
>>;

export interface InvocationProbeVariant {
  id?: string;
  transformRequest?: (
    input: InvocationProbeVariantContext,
  ) => InvocationProbeRequestPatch | void | Promise<InvocationProbeRequestPatch | void>;
  preprocessOutput?: (
    raw: unknown,
    input: InvocationProbeVariantContext,
  ) => {
    value: unknown;
    symbolRepairs?: readonly ModelSymbolRepairAudit[];
  };
}

export interface InvocationProbeVariantMetadata {
  id: string;
  path: string;
  hash: string;
}

export interface InvocationProbeTrial {
  trial: number;
  status: "accepted" | "rejected" | "transport_failed" | "configuration_failed";
  requestHash: string | null;
  requestExactMatch: boolean | null;
  request: {
    inferenceOverrides?: StructuredModelRequest<unknown>["inferenceOverrides"];
    jsonExamplePolicy?: "omit";
    profileId: string;
    role: ModelRole;
    subjectId: string;
    promptVersion: string;
    schemaName: string;
    workloadId: string;
    batchId: string;
    system: string;
    userPrompt: string;
    context: unknown;
  };
  requestDiff: RequestDiff;
  rawOutput?: unknown;
  output?: unknown;
  audit?: ModelExecutionAudit;
  error?: unknown;
  events: ProbeEvent[];
  engineSemantic: "not-run";
}

export interface ProbeEvent {
  eventName: string;
  level: string;
  payload?: unknown;
  attributes?: Readonly<Record<string, string | number | boolean | null>>;
  measurements?: Readonly<Record<string, number | null>>;
  counts?: Readonly<Record<string, number>>;
  hashes?: Readonly<Record<string, string>>;
  error?: unknown;
}

export interface RequestDiff {
  changed: boolean;
  changedFields: string[];
  changes: Array<{ path: Array<string | number>; before: unknown; after: unknown }>;
  truncated: boolean;
}

export interface InvocationProbeReport {
  schemaVersion: 1;
  kind: "model-invocation-probe";
  probeId: string;
  networkAccessed: true;
  source: {
    publicInvocationId: string;
    executionId: string;
    sourceInvocationId: string;
    status: string;
    issueCodes: string[];
    requestHash: string | null;
    modelCatalogHash: string;
    registrySnapshotHash: string;
  };
  variant: InvocationProbeVariantMetadata | null;
  profile: {
    sourceProfileId: string;
    effectiveProfileId: string;
    overridden: boolean;
    catalogHash: string;
    registrySnapshotHash: string;
    drift: string[];
  };
  request: {
    role: ModelRole;
    subjectId: string;
    promptVersion: string;
    schemaName: string;
    workloadId: string;
    batchId: string;
    system: string;
    userPrompt: string;
    context: unknown;
    schema: unknown;
  };
  trials: InvocationProbeTrial[];
  summary: {
    total: number;
    accepted: number;
    rejected: number;
    transportFailed: number;
    configurationFailed: number;
    acceptRate: number;
    normalizationRate: number;
  };
}

/** The one-trial, one-invocation evidence accepted by counterfactual replay. */
export interface InvocationProbeReplayOverride {
  report: InvocationProbeReport;
  reportHash: string;
  trial: InvocationProbeTrial;
}

export function sanitizeInvocationProbeReport(report: InvocationProbeReport): InvocationProbeReport {
  const sanitized = structuredClone(report);
  if (sanitized.variant) sanitized.variant.path = path.basename(sanitized.variant.path);
  return sanitized;
}

export interface LoadInvocationSourceOptions {
  database: string;
  source?: "api" | "sqlite" | "auto";
  apiUrl?: string;
  fetch?: typeof fetch;
}

export interface RunInvocationProbeOptions {
  source: InvocationProbeSource;
  catalog: ModelCatalog;
  registry: ModelRegistryService;
  provider?: StructuredModelProvider;
  profileId?: string;
  variant?: InvocationProbeVariant;
  variantMetadata?: InvocationProbeVariantMetadata | null;
  repeat?: number;
  allowDrift?: boolean;
  probeId?: string;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Read a probe report explicitly supplied by the operator. This deliberately
 * does not discover files or execute the report's variant metadata.
 */
export function loadInvocationProbeReport(
  file: string,
  selectedTrial = 1,
): InvocationProbeReplayOverride {
  if (!Number.isSafeInteger(selectedTrial) || selectedTrial < 1) {
    throw new Error("--trial must be a positive integer");
  }
  const resolved = path.resolve(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`probe report could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = record(parsed) as Partial<InvocationProbeReport> | null;
  if (!report || report.schemaVersion !== 1 || report.kind !== "model-invocation-probe") {
    throw new Error("probe report schemaVersion/kind is invalid; expected model-invocation-probe v1");
  }
  if (report.networkAccessed !== true || typeof report.probeId !== "string" || !report.probeId.trim()) {
    throw new Error("probe report must record networkAccessed=true and a probeId");
  }
  const source = record(report.source);
  if (!source || typeof source.executionId !== "string" || typeof source.sourceInvocationId !== "string" ||
    typeof source.publicInvocationId !== "string") {
    throw new Error("probe report source identity is invalid");
  }
  const separator = source.publicInvocationId.indexOf("::");
  if (separator <= 0 || source.publicInvocationId.slice(0, separator) !== source.executionId ||
    source.publicInvocationId.slice(separator + 2) !== source.sourceInvocationId) {
    throw new Error("probe report source publicInvocationId does not match executionId/sourceInvocationId");
  }
  const profile = record(report.profile);
  if (!profile || typeof profile.sourceProfileId !== "string" || typeof profile.effectiveProfileId !== "string" ||
    typeof profile.overridden !== "boolean" || !Array.isArray(profile.drift)) {
    throw new Error("probe report profile metadata is invalid");
  }
  if (report.variant !== null) {
    const variant = record(report.variant);
    if (!variant || typeof variant.id !== "string" || !variant.id.trim() || typeof variant.path !== "string" ||
      !variant.path.trim() || typeof variant.hash !== "string" || !variant.hash.trim()) {
      throw new Error("probe report variant metadata is invalid");
    }
  }
  if (!record(report.request)) throw new Error("probe report request is invalid");
  if (!Array.isArray(report.trials)) throw new Error("probe report trials must be an array");
  const matchingTrials = report.trials.filter((candidate) => record(candidate)?.trial === selectedTrial);
  if (matchingTrials.length > 1) throw new Error(`probe report contains duplicate trial: ${selectedTrial}`);
  const trial = matchingTrials[0] as InvocationProbeTrial | undefined;
  if (!trial) throw new Error(`probe report trial not found: ${selectedTrial}`);
  if (trial.status !== "accepted" && trial.status !== "rejected") {
    throw new Error(`probe trial ${selectedTrial} status is not overlayable: ${String(trial.status)}`);
  }
  if (trial.requestExactMatch !== true || typeof trial.requestHash !== "string" || !trial.requestHash) {
    throw new Error(`probe trial ${selectedTrial} does not have an exact request match`);
  }
  if (!record(trial.request)) throw new Error(`probe trial ${selectedTrial} request is invalid`);
  if (!trial.audit || !record(trial.audit) || !Array.isArray(trial.audit.invocations) || trial.audit.invocations.length !== 1) {
    throw new Error(`probe trial ${selectedTrial} must contain exactly one model audit invocation`);
  }
  if (trial.status === "accepted" && !hasOwn(trial as object, "output")) {
    throw new Error(`probe trial ${selectedTrial} is accepted but has no normalized output`);
  }
  if (trial.status === "rejected" && !hasOwn(trial as object, "rawOutput")) {
    throw new Error(`probe trial ${selectedTrial} is rejected but has no rawOutput`);
  }
  const sanitizedReport = sanitizeInvocationProbeReport(report as InvocationProbeReport);
  const reportHash = contentHash(redactRuntimePayload(sanitizedReport));
  return {
    report: sanitizedReport,
    reportHash,
    trial: structuredClone(trial),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`model invocation source field ${name} is invalid`);
  return value;
}

function parsePublicInvocationId(publicInvocationId: string): { executionId: string; sourceInvocationId: string } {
  const separator = publicInvocationId.indexOf("::");
  if (separator <= 0 || separator === publicInvocationId.length - 2) {
    throw new Error("invocation id must be <execution-id>::<source-invocation-id>");
  }
  return {
    executionId: publicInvocationId.slice(0, separator),
    sourceInvocationId: publicInvocationId.slice(separator + 2),
  };
}

function contextEvent(inspection: DebugInspection): DebugEventSummary {
  const event = inspection.events.find((candidate) =>
    candidate.eventName === "model.context.serialized" && candidate.payload !== undefined);
  if (!event) throw new Error("invocation has no complete model.context.serialized payload");
  return event;
}

function parseSerializedRequest(value: unknown): SerializedModelRequest {
  const input = record(value);
  if (!input) throw new Error("model.context.serialized payload is not an object");
  const role = requiredString(input.role, "role") as ModelRole;
  const request = {
    ...(input.inferenceOverrides ? { inferenceOverrides: modelInferenceSchema.partial().parse(input.inferenceOverrides) } : {}),
    ...(input.jsonExamplePolicy === "omit" ? { jsonExamplePolicy: "omit" as const } : {}),
    modelCatalogHash: requiredString(input.modelCatalogHash, "modelCatalogHash"),
    workloadId: requiredString(input.workloadId, "workloadId"),
    batchId: requiredString(input.batchId, "batchId"),
    role,
    subjectId: requiredString(input.subjectId, "subjectId"),
    profileId: requiredString(input.profileId, "profileId"),
    profile: structuredClone(input.profile),
    accountId: requiredString(input.accountId, "accountId"),
    providerId: requiredString(input.providerId, "providerId"),
    protocol: requiredString(input.protocol, "protocol"),
    dialect: requiredString(input.dialect, "dialect"),
    selector: structuredClone(input.selector),
    registrySnapshotHash: requiredString(input.registrySnapshotHash, "registrySnapshotHash"),
    modelId: requiredString(input.modelId, "modelId"),
    modelMetadataHash: requiredString(input.modelMetadataHash, "modelMetadataHash"),
    resolvedInference: structuredClone(input.resolvedInference),
    promptVersion: requiredString(input.promptVersion, "promptVersion"),
    schemaName: requiredString(input.schemaName, "schemaName"),
    schema: structuredClone(input.schema),
    system: requiredString(input.system, "system"),
    userPrompt: requiredString(input.userPrompt, "userPrompt"),
    context: structuredClone(input.context),
  } satisfies SerializedModelRequest;
  return request;
}

export function sourceFromInspection(
  publicInvocationId: string,
  inspection: DebugInspection,
): InvocationProbeSource {
  const parsedId = parsePublicInvocationId(publicInvocationId);
  if (inspection.executionId !== parsedId.executionId || inspection.sourceInvocationId !== parsedId.sourceInvocationId) {
    throw new Error("debug inspection identity does not match the requested invocation");
  }
  const event = contextEvent(inspection);
  const request = parseSerializedRequest(event.payload);
  const auditEvent = inspection.events.find((candidate) =>
    candidate.eventName === "model.audit.persisted" && candidate.payload !== undefined);
  const auditPayload = record(auditEvent?.payload);
  const invocations = Array.isArray(auditPayload?.invocations) ? auditPayload.invocations : [];
  const sourceAudit = invocations
    .map(record)
    .find((candidate) => candidate?.id === parsedId.sourceInvocationId);
  const requestHash = typeof sourceAudit?.requestHash === "string"
    ? sourceAudit.requestHash
    : contentHash(request);
  return {
    publicInvocationId,
    executionId: parsedId.executionId,
    sourceInvocationId: parsedId.sourceInvocationId,
    status: inspection.status,
    issueCodes: [...inspection.issueCodes],
    requestHash,
    request,
    inspection,
  };
}

async function fetchInspection(
  publicInvocationId: string,
  options: LoadInvocationSourceOptions,
): Promise<DebugInspection> {
  const fetchImplementation = options.fetch ?? fetch;
  const base = (options.apiUrl ?? "http://127.0.0.1:3000").replace(/\/$/u, "");
  const response = await fetchImplementation(
    `${base}/api/debug/invocations/${encodeURIComponent(publicInvocationId)}?payload=true`,
  );
  const payload = await response.json() as unknown;
  if (!response.ok) {
    const message = record(payload)?.error;
    throw new Error(`debug API returned HTTP ${response.status}: ${typeof message === "string" ? message : response.statusText}`);
  }
  return payload as DebugInspection;
}

export async function loadInvocationSource(
  publicInvocationId: string,
  options: LoadInvocationSourceOptions,
): Promise<InvocationProbeSource> {
  const source = options.source ?? "auto";
  if (source !== "sqlite") {
    try {
      return sourceFromInspection(publicInvocationId, await fetchInspection(publicInvocationId, options));
    } catch (error) {
      if (source === "api") throw error;
    }
  }
  const { LocalDatabase } = await import("../../server/local-database");
  const database = new LocalDatabase(options.database, { readOnly: true, heartbeat: false });
  try {
    const inspection = database.debugInspect(publicInvocationId, true);
    if (!inspection) throw new Error(`model invocation not found: ${publicInvocationId}`);
    return sourceFromInspection(publicInvocationId, inspection);
  } finally {
    database.close();
  }
}

export async function loadVariant(file: string): Promise<{
  variant: InvocationProbeVariant;
  metadata: InvocationProbeVariantMetadata;
}> {
  const resolved = path.resolve(file);
  const source = readFileSync(resolved, "utf8");
  const loaded = await import(pathToFileURL(resolved).href);
  const value = loaded.default ?? loaded.variant ?? loaded;
  if (!value || typeof value !== "object") throw new Error(`variant ${resolved} must export an object`);
  const variant = value as InvocationProbeVariant;
  if (variant.transformRequest !== undefined && typeof variant.transformRequest !== "function") {
    throw new Error(`variant ${resolved} transformRequest must be a function`);
  }
  if (variant.preprocessOutput !== undefined && typeof variant.preprocessOutput !== "function") {
    throw new Error(`variant ${resolved} preprocessOutput must be a function`);
  }
  return {
    variant,
    metadata: {
      id: typeof variant.id === "string" && variant.id.trim() ? variant.id : path.basename(resolved),
      path: resolved,
      hash: contentHash(source),
    },
  };
}

function modelSchema(request: SerializedModelRequest): z.ZodTypeAny {
  const schema = modelSchemaForName(request.schemaName);
  if (!schema) throw new Error(`no production Zod schema is registered for ${request.schemaName}`);
  const generated = canonicalize(z.toJSONSchema(schema, { target: "draft-07" }));
  if (contentHash(generated) !== contentHash(request.schema)) {
    throw new Error(`stored Schema for ${request.schemaName} differs from the current production Schema`);
  }
  return schema;
}

function baseProbeRequest(source: InvocationProbeSource, profileId: string): InvocationProbeRequest {
  const schema = modelSchema(source.request);
  return {
    profileId,
    ...(source.request.inferenceOverrides ? { inferenceOverrides: structuredClone(source.request.inferenceOverrides) } : {}),
    ...(source.request.jsonExamplePolicy ? { jsonExamplePolicy: source.request.jsonExamplePolicy } : {}),
    role: source.request.role,
    subjectId: source.request.subjectId,
    promptVersion: source.request.promptVersion,
    schemaName: source.request.schemaName,
    system: source.request.system,
    userPrompt: source.request.userPrompt,
    context: structuredClone(source.request.context),
    schema,
    workloadId: source.request.workloadId,
    batchId: source.request.batchId,
    modelRegistrySnapshotHash: source.request.registrySnapshotHash,
  };
}

function bindingDrift(source: InvocationProbeSource, catalog: ModelCatalog, snapshot: ModelRegistrySnapshot): string[] {
  const request = source.request;
  const binding = overrideModelInference(resolveModelProfile(catalog, snapshot, request.profileId), request.inferenceOverrides);
  const drift: string[] = [];
  if (catalog.hash !== request.modelCatalogHash) drift.push("modelCatalogHash");
  if (binding.registrySnapshotHash !== request.registrySnapshotHash) drift.push("registrySnapshotHash");
  if (binding.accountId !== request.accountId) drift.push("accountId");
  if (binding.account.models_dev_provider_id !== request.providerId) drift.push("providerId");
  if (binding.account.protocol !== request.protocol) drift.push("protocol");
  if (binding.account.dialect !== request.dialect) drift.push("dialect");
  if (binding.modelId !== request.modelId) drift.push("modelId");
  if (binding.modelMetadataHash !== request.modelMetadataHash) drift.push("modelMetadataHash");
  if (contentHash(binding.selector) !== contentHash(request.selector)) drift.push("selector");
  if (contentHash(binding.profile) !== contentHash(request.profile)) drift.push("profile");
  return drift;
}

function safeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: redactRuntimePayload(error.message) };
  }
  return redactRuntimePayload(String(error));
}

function eventProjection(event: RuntimeEvent): ProbeEvent {
  return {
    eventName: event.event,
    level: event.level ?? "info",
    ...(event.payload === undefined ? {} : { payload: redactRuntimePayload(structuredClone(event.payload)) }),
    ...(event.attributes ? { attributes: structuredClone(event.attributes) } : {}),
    ...(event.measurements ? { measurements: structuredClone(event.measurements) } : {}),
    ...(event.counts ? { counts: structuredClone(event.counts) } : {}),
    ...(event.hashes ? { hashes: structuredClone(event.hashes) } : {}),
    ...(event.error ? { error: structuredClone(event.error) } : {}),
  };
}

function collectDiff(before: unknown, after: unknown, pathValue: Array<string | number>, changes: Array<{ path: Array<string | number>; before: unknown; after: unknown }>, limit: number): boolean {
  if (changes.length >= limit) return true;
  if (contentHash(before) === contentHash(after)) return false;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      if (collectDiff(before[index], after[index], [...pathValue, index], changes, limit)) return true;
    }
    return false;
  }
  const beforeRecord = record(before);
  const afterRecord = record(after);
  if (beforeRecord && afterRecord) {
    const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])].sort();
    for (const key of keys) {
      if (collectDiff(beforeRecord[key], afterRecord[key], [...pathValue, key], changes, limit)) return true;
    }
    return false;
  }
  changes.push({
    path: pathValue,
    before: redactRuntimePayload(structuredClone(before)),
    after: redactRuntimePayload(structuredClone(after)),
  });
  return changes.length >= limit;
}

function requestDiff(before: InvocationProbeRequest, after: InvocationProbeRequest): RequestDiff {
  const changes: Array<{ path: Array<string | number>; before: unknown; after: unknown }> = [];
  const trackedBefore = { system: before.system, userPrompt: before.userPrompt, context: before.context };
  const trackedAfter = { system: after.system, userPrompt: after.userPrompt, context: after.context };
  const truncated = collectDiff(trackedBefore, trackedAfter, [], changes, 128);
  return {
    changed: changes.length > 0 || contentHash(trackedBefore) !== contentHash(trackedAfter),
    changedFields: [...new Set(changes.map((change) => String(change.path[0] ?? "")))].sort(),
    changes,
    truncated,
  };
}

function requestForReport(request: InvocationProbeRequest): InvocationProbeTrial["request"] {
  return {
    ...(request.inferenceOverrides ? { inferenceOverrides: request.inferenceOverrides } : {}),
    ...(request.jsonExamplePolicy ? { jsonExamplePolicy: request.jsonExamplePolicy } : {}),
    profileId: request.profileId,
    role: request.role,
    subjectId: request.subjectId,
    promptVersion: request.promptVersion,
    schemaName: request.schemaName,
    workloadId: request.workloadId,
    batchId: request.batchId,
    system: request.system,
    userPrompt: request.userPrompt,
    context: structuredClone(request.context),
  };
}

function outputError(error: unknown): boolean {
  return error instanceof ModelOutputError || error instanceof z.ZodError || error instanceof SyntaxError;
}

function trialStatus(error: unknown): InvocationProbeTrial["status"] {
  if (outputError(error)) return "rejected";
  if (error instanceof ModelTransportError || (error instanceof Error && ["APICallError", "TimeoutError", "AbortError"].includes(error.name))) {
    return "transport_failed";
  }
  return "configuration_failed";
}

function auditFrom(error: unknown): ModelExecutionAudit | undefined {
  return error instanceof ModelOutputError ? error.audit : undefined;
}

function rawOutputFrom(error: unknown): unknown {
  return error instanceof ModelOutputError ? error.rawValue : undefined;
}

export async function runInvocationProbe(options: RunInvocationProbeOptions): Promise<InvocationProbeReport> {
  const repeat = options.repeat ?? 1;
  if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 100) throw new Error("repeat must be an integer from 1 through 100");
  const profileId = options.profileId ?? options.source.request.profileId;
  const probeId = options.probeId ?? randomUUID();
  const profileCheck = await (async () => {
    options.catalog.assertProfile(profileId, options.source.request.role);
    const snapshot = profileId === options.source.request.profileId
      ? await options.registry.capture(options.source.request.registrySnapshotHash)
      : await options.registry.capture();
    const drift = profileId === options.source.request.profileId
      ? bindingDrift(options.source, options.catalog, snapshot)
      : [];
    if (drift.length > 0 && !options.allowDrift) {
      throw new Error(`model profile baseline drift detected: ${drift.join(", ")}; pass --allow-drift or choose --profile explicitly`);
    }
    return { snapshot, drift };
  })();
  const provider = options.provider ?? createModelGateway(options.catalog, process.env, {
    registry: options.registry,
    fetchForAccount: createModelFetchResolver(process.env),
  });
  const base = baseProbeRequest(options.source, profileId);
  if (profileId !== options.source.request.profileId) {
    base.modelRegistrySnapshotHash = profileCheck.snapshot.hash;
  }
  const trials: InvocationProbeTrial[] = [];
  for (let trial = 1; trial <= repeat; trial += 1) {
    // Zod schemas contain parser functions and are intentionally not cloned;
    // the replay request is otherwise isolated per trial.
    const request: InvocationProbeRequest = {
      ...base,
      context: structuredClone(base.context),
    };
    const variantContext: InvocationProbeVariantContext = {
      source: options.source,
      request,
    };
    if (options.variant?.transformRequest) {
      const patch = await options.variant.transformRequest(variantContext);
      if (patch) Object.assign(request, structuredClone(patch));
    }
    const diff = requestDiff(base, request);
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    let rawCaptured: unknown;
    const preprocessOutput = (raw: unknown) => {
      rawCaptured = structuredClone(raw);
      if (!options.variant?.preprocessOutput) return { value: raw, symbolRepairs: [] };
      const result = options.variant.preprocessOutput(raw, { source: options.source, request });
      return { value: result.value, symbolRepairs: [...(result.symbolRepairs ?? [])] };
    };
    const gatewayRequest: StructuredModelRequest<unknown> = {
      ...request,
      observer,
      modelInvocation: trial,
      modelInvocationId: `probe:${probeId}:${trial}`,
      correlation: {
        modelRole: request.role,
        modelSubject: request.subjectId,
        modelInvocation: trial,
      },
      preprocessOutput,
    };
    try {
      const result = await provider.generateStructured(gatewayRequest);
      const audit = result.audit;
      const requestHash = audit.invocations.at(-1)?.requestHash ?? null;
      trials.push({
        trial,
        status: "accepted",
        requestHash,
        requestExactMatch: options.source.requestHash === null || requestHash === null
          ? null
          : requestHash === options.source.requestHash,
        request: requestForReport(request),
        requestDiff: diff,
        ...(rawCaptured === undefined ? {} : { rawOutput: redactRuntimePayload(rawCaptured) }),
        output: redactRuntimePayload(result.value),
        audit: structuredClone(audit),
        events: observer.snapshot().map(eventProjection),
        engineSemantic: "not-run",
      });
      if (contentHash(audit.resolvedInference) !== contentHash(options.source.request.resolvedInference) && profileId === options.source.request.profileId) {
        trials.at(-1)!.status = "configuration_failed";
        trials.at(-1)!.error = { name: "ProfileDrift", message: "resolved inference differs from the recorded invocation" };
      }
    } catch (error) {
      const audit = auditFrom(error);
      const invocation = audit?.invocations.at(-1);
      trials.push({
        trial,
        status: trialStatus(error),
        requestHash: invocation?.requestHash ?? null,
        requestExactMatch: options.source.requestHash === null || !invocation?.requestHash
          ? null
          : invocation.requestHash === options.source.requestHash,
        request: requestForReport(request),
        requestDiff: diff,
        ...(rawCaptured === undefined && rawOutputFrom(error) === undefined ? {} : {
          rawOutput: redactRuntimePayload(rawCaptured ?? rawOutputFrom(error)),
        }),
        ...(audit ? { audit: structuredClone(audit) } : {}),
        error: safeError(error),
        events: observer.snapshot().map(eventProjection),
        engineSemantic: "not-run",
      });
    }
  }
  const accepted = trials.filter((trial) => trial.status === "accepted").length;
  const rejected = trials.filter((trial) => trial.status === "rejected").length;
  const transportFailed = trials.filter((trial) => trial.status === "transport_failed").length;
  const configurationFailed = trials.filter((trial) => trial.status === "configuration_failed").length;
  const normalized = trials.filter((trial) => trial.audit?.invocations.at(-1)?.outputDisposition === "auto-normalized").length;
  return {
    schemaVersion: 1,
    kind: "model-invocation-probe",
    probeId,
    networkAccessed: true,
    source: {
      publicInvocationId: options.source.publicInvocationId,
      executionId: options.source.executionId,
      sourceInvocationId: options.source.sourceInvocationId,
      status: options.source.status,
      issueCodes: [...options.source.issueCodes],
      requestHash: options.source.requestHash,
      modelCatalogHash: options.source.request.modelCatalogHash,
      registrySnapshotHash: options.source.request.registrySnapshotHash,
    },
    variant: options.variantMetadata ?? null,
    profile: {
      sourceProfileId: options.source.request.profileId,
      effectiveProfileId: profileId,
      overridden: profileId !== options.source.request.profileId,
      catalogHash: options.catalog.hash,
      registrySnapshotHash: profileCheck.snapshot.hash,
      drift: profileCheck.drift,
    },
    request: {
      role: options.source.request.role,
      subjectId: options.source.request.subjectId,
      promptVersion: options.source.request.promptVersion,
      schemaName: options.source.request.schemaName,
      workloadId: options.source.request.workloadId,
      batchId: options.source.request.batchId,
      system: options.source.request.system,
      userPrompt: options.source.request.userPrompt,
      context: structuredClone(options.source.request.context),
      schema: structuredClone(options.source.request.schema),
    },
    trials,
    summary: {
      total: trials.length,
      accepted,
      rejected,
      transportFailed,
      configurationFailed,
      acceptRate: trials.length === 0 ? 0 : accepted / trials.length,
      normalizationRate: trials.length === 0 ? 0 : normalized / trials.length,
    },
  };
}
