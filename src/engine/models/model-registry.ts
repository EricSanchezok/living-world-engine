import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import type {
  ModelCatalog,
  ModelInferenceConfig,
  ModelMetadataOverride,
  ModelProfileConfig,
  ModelSelector,
  ProviderAccountConfig,
} from "./model-catalog";
import { modelMetadataOverrideSchema } from "./model-catalog";
import { canonicalize, contentHash, isSha256 } from "./model-audit";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const MAX_MODELS_DEV_RESPONSE_BYTES = 32 * 1024 * 1024;
const SNAPSHOT_SCHEMA_VERSION = 1;
const REGISTRY_STATE_SCHEMA_VERSION = 1;
const FIELD_SOURCE_VALUES = ["models.dev", "local-override"] as const;
const registryProviderIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const registryModelIdSchema = z.string().min(1).max(256).refine(
  (value) => !["__proto__", "constructor", "prototype"].includes(value),
  "unsafe model id",
);

const nullableNonnegativeIntegerSchema = z.number().int().nonnegative().nullable();
const isoDateSchema = z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/);

const normalizedModelSchema = z.object({
  id: registryModelIdSchema,
  name: z.string().min(1),
  family: z.string().min(1).nullable(),
  status: z.string().min(1).nullable(),
  disabled: z.boolean(),
  reasoning: z.boolean(),
  reasoningToggle: z.boolean(),
  reasoningEfforts: z.array(z.string().min(1)),
  reasoningBudget: z.object({
    min: z.number().int(),
    max: z.number().int().positive(),
  }).strict().nullable(),
  toolCall: z.boolean(),
  structuredOutput: z.boolean(),
  temperature: z.boolean(),
  releaseDate: isoDateSchema.nullable(),
  lastUpdated: isoDateSchema.nullable(),
  modalities: z.object({
    input: z.array(z.string().min(1)),
    output: z.array(z.string().min(1)),
  }).strict(),
  limit: z.object({
    context: nullableNonnegativeIntegerSchema,
    output: nullableNonnegativeIntegerSchema,
  }).strict(),
  fieldSources: z.record(z.string(), z.enum(FIELD_SOURCE_VALUES)),
}).strict();

const normalizedProviderSchema = z.object({
  id: registryProviderIdSchema,
  name: z.string().min(1),
  models: z.record(registryModelIdSchema, normalizedModelSchema),
}).strict();

const snapshotDocumentSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  source: z.literal(MODELS_DEV_API_URL),
  providers: z.record(registryProviderIdSchema, normalizedProviderSchema),
}).strict();

const registryStateSchema = z.object({
  schemaVersion: z.literal(REGISTRY_STATE_SCHEMA_VERSION),
  catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
  currentHash: z.string().regex(/^[a-f0-9]{64}$/),
  etag: z.string().min(1).nullable(),
  checkedAt: z.string().datetime(),
}).strict();

const remoteReasoningOptionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("toggle") }).passthrough(),
  z.object({
    type: z.literal("effort"),
    values: z.array(z.string().min(1)),
  }).passthrough(),
  z.object({
    type: z.literal("budget_tokens"),
    min: z.number().int(),
    max: z.number().int().positive(),
  }).passthrough(),
]);

const remoteModelSchema = z.object({
  id: registryModelIdSchema,
  name: z.string().min(1),
  family: z.string().min(1).nullable().optional(),
  status: z.string().min(1).nullable().optional(),
  reasoning: z.boolean().optional(),
  reasoning_options: z.array(remoteReasoningOptionSchema).optional(),
  tool_call: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  temperature: z.boolean().optional(),
  release_date: isoDateSchema.nullable().optional(),
  last_updated: isoDateSchema.nullable().optional(),
  modalities: z.object({
    input: z.array(z.string().min(1)),
    output: z.array(z.string().min(1)),
  }).strict().optional(),
  limit: z.object({
    context: nullableNonnegativeIntegerSchema.optional(),
    output: nullableNonnegativeIntegerSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

const remoteProviderSchema = z.object({
  id: registryProviderIdSchema,
  name: z.string().min(1),
  models: z.record(registryModelIdSchema, remoteModelSchema),
}).passthrough();

export type ModelRegistryDocument = z.infer<typeof snapshotDocumentSchema>;
export type RegisteredModel = z.infer<typeof normalizedModelSchema>;
export type ModelMetadataFieldSource = typeof FIELD_SOURCE_VALUES[number];

export interface ModelRegistrySnapshot {
  hash: string;
  document: ModelRegistryDocument;
}

export interface ResolvedModelBinding {
  profileId: string;
  profile: ModelProfileConfig;
  accountId: string;
  account: ProviderAccountConfig;
  selector: ModelSelector;
  registrySnapshotHash: string;
  modelId: string;
  model: RegisteredModel;
  modelMetadataHash: string;
}

export type ModelRegistryRefreshOutcome = "updated" | "not-modified" | "unchanged" | "stale-fallback";

export interface ModelRegistryRefreshResult {
  outcome: ModelRegistryRefreshOutcome;
  snapshot: ModelRegistrySnapshot;
  checkedAt: string;
  error: string | null;
}

export interface ModelRegistryStatus {
  source: typeof MODELS_DEV_API_URL;
  health: "missing" | "fresh" | "stale" | "refreshing" | "degraded";
  refreshing: boolean;
  currentHash: string | null;
  checkedAt: string | null;
  ageMs: number | null;
  stale: boolean;
  lastError: string | null;
}

export interface ModelRegistryOptions {
  fetch?: typeof fetch;
  now?: () => number;
  minimumRefreshIntervalMs?: number;
}

export interface ModelRegistryService {
  readonly catalog: ModelCatalog;
  capture(snapshotHash?: string): Promise<ModelRegistrySnapshot>;
  refresh(options?: { reason: "manual" | "background" | "capture" }): Promise<ModelRegistryRefreshResult>;
  status(): ModelRegistryStatus;
}

export class ModelRegistryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ModelRegistryError";
  }
}

export class ModelResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResolutionError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fieldSources(fields: readonly string[]): Record<string, ModelMetadataFieldSource> {
  return Object.fromEntries(fields.map((field) => [field, "models.dev"]));
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

function remoteModelToNormalized(model: z.infer<typeof remoteModelSchema>): RegisteredModel {
  const options = model.reasoning_options ?? [];
  const effort = options.find((option) => option.type === "effort");
  const budget = options.find((option) => option.type === "budget_tokens");
  const fields = [
    "name",
    "family",
    "status",
    "disabled",
    "reasoning",
    "reasoningToggle",
    "reasoningEfforts",
    "reasoningBudget",
    "toolCall",
    "structuredOutput",
    "temperature",
    "releaseDate",
    "lastUpdated",
    "modalities",
    "limit",
  ];
  return normalizedModelSchema.parse({
    id: model.id,
    name: model.name,
    family: model.family ?? null,
    status: model.status ?? null,
    disabled: false,
    reasoning: model.reasoning ?? false,
    reasoningToggle: options.some((option) => option.type === "toggle"),
    reasoningEfforts: effort?.type === "effort" ? sortedUnique(effort.values) : [],
    reasoningBudget: budget?.type === "budget_tokens"
      ? { min: budget.min, max: budget.max }
      : null,
    toolCall: model.tool_call ?? false,
    structuredOutput: model.structured_output ?? false,
    temperature: model.temperature ?? false,
    releaseDate: model.release_date ?? null,
    lastUpdated: model.last_updated ?? null,
    modalities: model.modalities ?? { input: [], output: [] },
    limit: {
      context: model.limit?.context ?? null,
      output: model.limit?.output ?? null,
    },
    fieldSources: fieldSources(fields),
  });
}

const overrideFieldMap: Record<Exclude<keyof ModelMetadataOverride, "reasoning_efforts">, keyof RegisteredModel> = {
  disabled: "disabled",
  name: "name",
  family: "family",
  reasoning: "reasoning",
  reasoning_toggle: "reasoningToggle",
  tool_call: "toolCall",
  structured_output: "structuredOutput",
  temperature: "temperature",
  release_date: "releaseDate",
  last_updated: "lastUpdated",
  modalities: "modalities",
  limit: "limit",
};

function applyOverride(model: RegisteredModel, override: ModelMetadataOverride): RegisteredModel {
  const updated = structuredClone(model) as RegisteredModel;
  for (const [overrideField, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const targetField = overrideField === "reasoning_efforts"
      ? "reasoningEfforts"
      : overrideFieldMap[overrideField as keyof typeof overrideFieldMap];
    if (!targetField) continue;
    if (targetField === "limit") {
      updated.limit = { ...updated.limit, ...(value as RegisteredModel["limit"]) };
    } else {
      (updated as unknown as Record<string, unknown>)[targetField] = structuredClone(value);
    }
    updated.fieldSources[targetField] = "local-override";
  }
  updated.reasoningEfforts = sortedUnique(updated.reasoningEfforts);
  return normalizedModelSchema.parse(updated);
}

function localModelDefinition(id: string, override: ModelMetadataOverride): RegisteredModel {
  const complete = modelMetadataOverrideSchema.required().extend({
    limit: z.object({ context: z.number().int().positive().safe(), output: z.number().int().positive().safe() }).strict(),
  }).parse(override);
  const model = applyOverride(remoteModelToNormalized({ id, name: complete.name }), complete);
  model.fieldSources = Object.fromEntries(Object.keys(model).filter(field => field !== "fieldSources")
    .map(field => [field, "local-override" as const]));
  return normalizedModelSchema.parse(model);
}

export function normalizeModelsDevDocument(
  value: unknown,
  catalog: ModelCatalog,
): ModelRegistryDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ModelRegistryError("models.dev returned a non-object catalog");
  }
  const remote = value as Record<string, unknown>;
  const providerIds = sortedUnique(Object.values(catalog.accounts)
    .map((account) => account.models_dev_provider_id));
  const providers: Record<string, z.infer<typeof normalizedProviderSchema>> = {};
  for (const providerId of providerIds) {
    let provider: z.infer<typeof remoteProviderSchema>;
    try {
      provider = remoteProviderSchema.parse(remote[providerId]);
    } catch (error) {
      throw new ModelRegistryError(`models.dev provider ${providerId} is missing or invalid`, { cause: error });
    }
    if (provider.id !== providerId) {
      throw new ModelRegistryError(`models.dev provider key ${providerId} disagrees with id ${provider.id}`);
    }
    if (Object.keys(provider.models).length === 0) {
      throw new ModelRegistryError(`models.dev provider ${providerId} has no models`);
    }
    const models: Record<string, RegisteredModel> = {};
    for (const modelId of sortedUnique(Object.keys(provider.models))) {
      const remoteModel = provider.models[modelId]!;
      if (remoteModel.id !== modelId) {
        throw new ModelRegistryError(
          `models.dev model key ${providerId}/${modelId} disagrees with id ${remoteModel.id}`,
        );
      }
      const override = catalog.modelOverrides[providerId]?.[modelId];
      models[modelId] = override
        ? applyOverride(remoteModelToNormalized(remoteModel), override)
        : remoteModelToNormalized(remoteModel);
    }
    const unknownOverrides = Object.keys(catalog.modelOverrides[providerId] ?? {})
      .filter((modelId) => !provider.models[modelId]);
    for (const modelId of unknownOverrides.sort()) {
      try { models[modelId] = localModelDefinition(modelId, catalog.modelOverrides[providerId]![modelId]!); }
      catch (error) { throw new ModelRegistryError(`local overrides reference unknown ${providerId} models without complete metadata: ${modelId}`, { cause: error }); }
    }
    providers[providerId] = { id: provider.id, name: provider.name, models };
  }
  return snapshotDocumentSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: MODELS_DEV_API_URL,
    providers,
  });
}

function globExpression(glob: string): RegExp {
  let pattern = "^";
  for (const character of glob) {
    if (character === "*") pattern += ".*";
    else if (character === "?") pattern += ".";
    else pattern += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${pattern}$`, "u");
}

function matchesGlob(value: string, pattern: string): boolean {
  return globExpression(pattern).test(value);
}

function explicitInferenceIssues(
  inference: ModelInferenceConfig,
  model: RegisteredModel,
): string[] {
  const issues: string[] = [];
  if (inference.thinking !== "auto" && !model.reasoningToggle) {
    issues.push("thinking toggle is not declared");
  }
  if (inference.thinking === "enabled" && !model.reasoning) {
    issues.push("reasoning is not declared");
  }
  if (inference.effort !== "auto" && !model.reasoningEfforts.includes(inference.effort)) {
    issues.push(`reasoning effort ${inference.effort} is not declared`);
  }
  if (inference.reasoning_budget_tokens !== "auto") {
    const budget = model.reasoningBudget;
    if (!budget || inference.reasoning_budget_tokens < budget.min ||
      inference.reasoning_budget_tokens > budget.max) {
      issues.push(`reasoning budget ${inference.reasoning_budget_tokens} is not declared`);
    }
  }
  if (inference.temperature !== "auto" && !model.temperature) {
    issues.push("temperature is not declared");
  }
  if (inference.top_p !== "auto") issues.push("top_p is not declared by models.dev");
  if (inference.reasoning_summary !== "auto") {
    issues.push("reasoning summary is not declared by models.dev");
  }
  if (inference.text_verbosity !== "auto") {
    issues.push("text verbosity is not declared by models.dev");
  }
  return issues;
}

function compatibilityIssues(
  profile: ModelProfileConfig,
  account: ProviderAccountConfig,
  model: RegisteredModel,
): string[] {
  const issues: string[] = [];
  if (model.disabled) issues.push("disabled by local configuration");
  if (model.status?.toLowerCase() === "deprecated") issues.push("deprecated");
  if (!model.modalities.input.includes("text")) issues.push("text input is not declared");
  if (!model.modalities.output.includes("text")) issues.push("text output is not declared");
  if (!model.structuredOutput && !model.toolCall) {
    issues.push("neither structured output nor tool calling is declared");
  }
  if (account.protocol === "anthropic-messages" && !model.toolCall) {
    issues.push("the Anthropic-compatible driver requires declared tool calling");
  }
  if (model.limit.output !== null && profile.max_output_tokens > model.limit.output) {
    issues.push(`profile output limit ${profile.max_output_tokens} exceeds model limit ${model.limit.output}`);
  }
  issues.push(...explicitInferenceIssues(profile.inference, model));
  return issues;
}

function descendingNullableDate(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left > right ? -1 : 1;
}

export function resolveModelProfile(
  catalog: ModelCatalog,
  snapshot: ModelRegistrySnapshot,
  profileId: string,
): ResolvedModelBinding {
  const profile = catalog.profile(profileId);
  const account = catalog.account(profile.account_id);
  const provider = snapshot.document.providers[account.models_dev_provider_id];
  if (!provider) {
    throw new ModelResolutionError(
      `registry snapshot ${snapshot.hash} has no provider ${account.models_dev_provider_id}`,
    );
  }
  const selector = profile.selector;
  if (selector.kind === "exact") {
    const model = provider.models[selector.model_id];
    if (!model) {
      throw new ModelResolutionError(
        `profile ${profileId} requires exact model ${selector.model_id}, which is absent from snapshot ${snapshot.hash}`,
      );
    }
    const issues = compatibilityIssues(profile, account, model);
    if (issues.length > 0) {
      throw new ModelResolutionError(
        `profile ${profileId} exact model ${model.id} is incompatible: ${issues.join("; ")}`,
      );
    }
    return {
      profileId,
      profile,
      accountId: profile.account_id,
      account,
      selector: structuredClone(selector),
      registrySnapshotHash: snapshot.hash,
      modelId: model.id,
      model,
      modelMetadataHash: contentHash(model),
    };
  }

  const included = Object.values(provider.models).filter((model) =>
    model.fieldSources.id !== "local-override" &&
    selector.include.some((pattern) => matchesGlob(model.id, pattern)) &&
    !selector.exclude.some((pattern) => matchesGlob(model.id, pattern)) &&
    (!selector.family || matchesGlob(model.family ?? "", selector.family)));
  const compatible = included.filter((model) => compatibilityIssues(profile, account, model).length === 0)
    .sort((left, right) =>
      descendingNullableDate(left.releaseDate, right.releaseDate) ||
      descendingNullableDate(left.lastUpdated, right.lastUpdated) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const model = compatible[0];
  if (!model) {
    const issueCounts = new Map<string, number>();
    for (const candidate of included) {
      for (const issue of compatibilityIssues(profile, account, candidate)) {
        issueCounts.set(issue, (issueCounts.get(issue) ?? 0) + 1);
      }
    }
    const details = included.length === 0
      ? "selector matched no models"
      : [...issueCounts.entries()]
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([issue, count]) => `${issue} (${count})`)
        .join("; ");
    throw new ModelResolutionError(
      `profile ${profileId} has no latest-compatible model in snapshot ${snapshot.hash}: ${details}`,
    );
  }
  return {
    profileId,
    profile,
    accountId: profile.account_id,
    account,
    selector: structuredClone(selector),
    registrySnapshotHash: snapshot.hash,
    modelId: model.id,
    model,
    modelMetadataHash: contentHash(model),
  };
}

function atomicWrite(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, file);
}

async function responseTextWithinLimit(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODELS_DEV_RESPONSE_BYTES) {
    throw new ModelRegistryError(
      `models.dev response exceeds ${MAX_MODELS_DEV_RESPONSE_BYTES} bytes`,
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MODELS_DEV_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ModelRegistryError(
          `models.dev response exceeds ${MAX_MODELS_DEV_RESPONSE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

export class ModelRegistry implements ModelRegistryService {
  private readonly directory: string;
  private readonly snapshotsDirectory: string;
  private readonly stateFile: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly minimumRefreshIntervalMs: number;
  private refreshFlight: Promise<ModelRegistryRefreshResult> | null = null;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private lastManualRefreshAt = Number.NEGATIVE_INFINITY;
  private lastError: string | null = null;
  private readonly snapshots = new Map<string, ModelRegistrySnapshot>();

  constructor(
    readonly catalog: ModelCatalog,
    dataRoot: string,
    options: ModelRegistryOptions = {},
  ) {
    this.directory = path.join(path.resolve(dataRoot), "model-registry");
    this.snapshotsDirectory = path.join(this.directory, "snapshots");
    this.stateFile = path.join(this.directory, "state.json");
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.minimumRefreshIntervalMs = options.minimumRefreshIntervalMs ?? 30_000;
    mkdirSync(this.snapshotsDirectory, { recursive: true });
  }

  startBackgroundRefresh(): void {
    if (this.backgroundTimer) return;
    this.backgroundTimer = setInterval(() => {
      void this.refresh({ reason: "background" }).catch(() => undefined);
    }, this.catalog.registry.refresh_interval_ms);
    this.backgroundTimer.unref?.();
  }

  stopBackgroundRefresh(): void {
    if (!this.backgroundTimer) return;
    clearInterval(this.backgroundTimer);
    this.backgroundTimer = null;
  }

  private readState(): z.infer<typeof registryStateSchema> | null {
    if (!existsSync(this.stateFile)) return null;
    try {
      return registryStateSchema.parse(JSON.parse(readFileSync(this.stateFile, "utf8")));
    } catch (error) {
      this.lastError = `cannot read model registry state: ${errorMessage(error)}`;
      return null;
    }
  }

  snapshot(hash: string): ModelRegistrySnapshot {
    if (!isSha256(hash)) throw new ModelRegistryError(`invalid model registry snapshot hash ${hash}`);
    const cached = this.snapshots.get(hash);
    if (cached) return cached;
    const file = path.join(this.snapshotsDirectory, `${hash}.json`);
    let document: ModelRegistryDocument;
    try {
      document = snapshotDocumentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      throw new ModelRegistryError(`cannot read model registry snapshot ${hash}`, { cause: error });
    }
    if (contentHash(document) !== hash) {
      throw new ModelRegistryError(`model registry snapshot ${hash} failed content verification`);
    }
    const snapshot = Object.freeze({ hash, document: deepFreeze(document) });
    this.snapshots.set(hash, snapshot);
    return snapshot;
  }

  currentSnapshot(): ModelRegistrySnapshot | null {
    const state = this.readState();
    if (!state || state.catalogHash !== this.catalog.hash) return null;
    try {
      return this.snapshot(state.currentHash);
    } catch (error) {
      this.lastError = errorMessage(error);
      return null;
    }
  }

  async capture(snapshotHash?: string): Promise<ModelRegistrySnapshot> {
    if (snapshotHash) return this.snapshot(snapshotHash);
    const current = this.currentSnapshot();
    if (!current) return (await this.refresh({ reason: "capture" })).snapshot;
    const state = this.readState();
    const checkedAt = state ? Date.parse(state.checkedAt) : Number.NaN;
    if (!Number.isFinite(checkedAt) || this.now() - checkedAt >= this.catalog.registry.refresh_interval_ms) {
      void this.refresh({ reason: "background" }).catch(() => undefined);
    }
    return current;
  }

  async refresh(options: { reason: "manual" | "background" | "capture" } = { reason: "manual" }): Promise<ModelRegistryRefreshResult> {
    if (this.refreshFlight) return this.refreshFlight;
    if (options.reason === "manual") {
      const elapsed = this.now() - this.lastManualRefreshAt;
      if (elapsed < this.minimumRefreshIntervalMs) {
        throw new ModelRegistryError(
          `model registry refresh is rate limited for ${Math.ceil(this.minimumRefreshIntervalMs - elapsed)} ms`,
        );
      }
      this.lastManualRefreshAt = this.now();
    }
    this.refreshFlight = this.performRefresh().finally(() => {
      this.refreshFlight = null;
    });
    return this.refreshFlight;
  }

  private async performRefresh(): Promise<ModelRegistryRefreshResult> {
    const previousState = this.readState();
    const previous = previousState?.catalogHash === this.catalog.hash
      ? this.currentSnapshot()
      : null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.catalog.registry.request_timeout_ms);
    const headers = new Headers({ accept: "application/json" });
    if (previousState?.catalogHash === this.catalog.hash && previousState.etag) {
      headers.set("if-none-match", previousState.etag);
    }
    try {
      const response = await this.fetchImplementation(MODELS_DEV_API_URL, {
        method: "GET",
        headers,
        signal: controller.signal,
        cache: "no-store",
      });
      const checkedAt = new Date(this.now()).toISOString();
      if (response.status === 304) {
        if (!previous || !previousState) {
          throw new ModelRegistryError("models.dev returned 304 without a valid local snapshot");
        }
        atomicWrite(this.stateFile, `${JSON.stringify({
          ...previousState,
          etag: response.headers.get("etag") ?? previousState.etag,
          checkedAt,
        }, null, 2)}\n`);
        this.lastError = null;
        return { outcome: "not-modified", snapshot: previous, checkedAt, error: null };
      }
      if (!response.ok) {
        throw new ModelRegistryError(`models.dev refresh failed with HTTP ${response.status}`);
      }
      let remote: unknown;
      try {
        remote = JSON.parse(await responseTextWithinLimit(response));
      } catch (error) {
        if (error instanceof ModelRegistryError) throw error;
        throw new ModelRegistryError("models.dev returned invalid JSON", { cause: error });
      }
      const document = normalizeModelsDevDocument(remote, this.catalog);
      const hash = contentHash(document);
      const file = path.join(this.snapshotsDirectory, `${hash}.json`);
      const serialized = `${JSON.stringify(canonicalize(document), null, 2)}\n`;
      if (existsSync(file)) {
        const existing = snapshotDocumentSchema.parse(JSON.parse(readFileSync(file, "utf8")));
        if (contentHash(existing) !== hash) {
          throw new ModelRegistryError(`existing model registry snapshot ${hash} is corrupt`);
        }
      } else {
        atomicWrite(file, serialized);
      }
      const nextState = registryStateSchema.parse({
        schemaVersion: REGISTRY_STATE_SCHEMA_VERSION,
        catalogHash: this.catalog.hash,
        currentHash: hash,
        etag: response.headers.get("etag"),
        checkedAt,
      });
      atomicWrite(this.stateFile, `${JSON.stringify(nextState, null, 2)}\n`);
      const snapshot = this.snapshot(hash);
      this.lastError = null;
      return {
        outcome: previous?.hash === hash ? "unchanged" : "updated",
        snapshot,
        checkedAt,
        error: null,
      };
    } catch (error) {
      const message = error instanceof Error && error.name === "AbortError"
        ? `models.dev refresh timed out after ${this.catalog.registry.request_timeout_ms} ms`
        : errorMessage(error);
      this.lastError = message;
      if (previous && previousState) {
        return {
          outcome: "stale-fallback",
          snapshot: previous,
          checkedAt: previousState.checkedAt,
          error: message,
        };
      }
      throw new ModelRegistryError(`model registry has no valid snapshot: ${message}`, { cause: error });
    } finally {
      clearTimeout(timeout);
    }
  }

  status(): ModelRegistryStatus {
    const state = this.readState();
    const current = this.currentSnapshot();
    const checkedAt = state?.catalogHash === this.catalog.hash && current ? state.checkedAt : null;
    const ageMs = checkedAt ? Math.max(0, this.now() - Date.parse(checkedAt)) : null;
    const stale = ageMs === null || ageMs >= this.catalog.registry.stale_after_ms;
    let health: ModelRegistryStatus["health"];
    if (this.refreshFlight) health = "refreshing";
    else if (!current) health = "missing";
    else if (this.lastError) health = "degraded";
    else health = stale ? "stale" : "fresh";
    return {
      source: MODELS_DEV_API_URL,
      health,
      refreshing: Boolean(this.refreshFlight),
      currentHash: current?.hash ?? null,
      checkedAt,
      ageMs,
      stale,
      lastError: this.lastError,
    };
  }
}
