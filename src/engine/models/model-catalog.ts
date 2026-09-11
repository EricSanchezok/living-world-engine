import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { canonicalize, contentHash } from "./model-audit";

const identifierSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const environmentVariableSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const positiveIntegerSchema = z.number().int().positive();
const isoDateSchema = z.string().regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/);
const modelIdSchema = z.string().min(1).max(256).refine(
  (value) => !["__proto__", "constructor", "prototype"].includes(value),
  "unsafe model id",
);
const trustedBaseUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  const loopbackHttp = url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return (url.protocol === "https:" || loopbackHttp) &&
    !url.username && !url.password && !url.search && !url.hash;
}, "provider base URL must use HTTPS, or loopback HTTP, without credentials, query, or fragment");

const modelNetworkSchema = z.object({
  // The address is deliberately indirect: only the environment variable name
  // is part of the catalog. The local address itself never enters a save,
  // audit record, or source-controlled configuration.
  local_address_env: environmentVariableSchema.optional(),
  dns_over_https_url: trustedBaseUrlSchema.refine((value) => new URL(value).protocol === "https:", "DNS resolver must use HTTPS").optional(),
  socket_connect_attempts: z.union([z.literal(1), z.literal(2)]).optional(),
}).strict().refine((value) => value.local_address_env || value.dns_over_https_url, "network requires an address binding or DNS resolver");

export const modelRoles = [
  "truth-perception",
  "truth-reaction-routing",
  "truth-resolution",
  "truth-transition",
  "action-compilation",
  "action-grounding",
  "observation-renderer",
  "causal-verifier",
  "agent-bootstrap",
  "agent-mind",
  "agent-reaction",
  "arrival-generator",
] as const;

export const modelProtocols = [
  "openai-chat",
  "openai-responses",
  "anthropic-messages",
] as const;

export const modelAccountChannels = ["api", "coding-plan", "token-plan"] as const;

export type ModelRole = typeof modelRoles[number];
export type ModelProtocol = typeof modelProtocols[number];
export type ModelAccountChannel = typeof modelAccountChannels[number];

const providerAccountSchema = z.object({
  channel: z.enum(modelAccountChannels),
  region: identifierSchema,
  protocol: z.enum(modelProtocols),
  dialect: identifierSchema,
  models_dev_provider_id: identifierSchema,
  base_url: trustedBaseUrlSchema,
  api_key_env: environmentVariableSchema,
  max_concurrency: positiveIntegerSchema,
  network: modelNetworkSchema.optional(),
}).strict();

const automaticStringSchema = z.union([z.literal("auto"), z.string().min(1).max(64)]);
const automaticPositiveIntegerSchema = z.union([z.literal("auto"), positiveIntegerSchema]);
const automaticTemperatureSchema = z.union([z.literal("auto"), z.number().min(0).max(2)]);
const automaticTopPSchema = z.union([z.literal("auto"), z.number().min(0).max(1)]);

/**
 * Provider-neutral inference intent. `auto` omits the field from the transport
 * request so the selected provider/model owns its default.
 */
export const modelInferenceSchema = z.object({
  thinking: z.enum(["auto", "enabled", "disabled"]).default("auto"),
  effort: automaticStringSchema.default("auto"),
  reasoning_budget_tokens: automaticPositiveIntegerSchema.default("auto"),
  reasoning_summary: automaticStringSchema.default("auto"),
  text_verbosity: automaticStringSchema.default("auto"),
  temperature: automaticTemperatureSchema.default("auto"),
  top_p: automaticTopPSchema.default("auto"),
}).strict().superRefine((value, context) => {
  if (value.temperature !== "auto" && value.top_p !== "auto") {
    context.addIssue({
      code: "custom",
      message: "configure temperature or top_p, not both",
    });
  }
});

const exactSelectorSchema = z.object({
  kind: z.literal("exact"),
  model_id: modelIdSchema,
}).strict();

const latestCompatibleSelectorSchema = z.object({
  kind: z.literal("latest-compatible"),
  family: z.string().min(1).max(128).optional(),
  include: z.array(z.string().min(1).max(256)).default(["*"]),
  exclude: z.array(z.string().min(1).max(256)).default([]),
}).strict();

export const modelSelectorSchema = z.discriminatedUnion("kind", [
  exactSelectorSchema,
  latestCompatibleSelectorSchema,
]);

const profileSchema = z.object({
  account_id: identifierSchema,
  selector: modelSelectorSchema,
  description: z.string().min(1),
  allowed_roles: z.array(z.enum(modelRoles)).min(1),
  request_timeout_ms: z.number().int().min(1_000).max(3_600_000),
  response_transport: z.literal("deepseek-sse-v1").optional(),
  max_output_tokens: positiveIntegerSchema,
  max_input_bytes: positiveIntegerSchema.default(262_144),
  inference: modelInferenceSchema,
}).strict();

export const modelMetadataOverrideSchema = z.object({
  disabled: z.boolean().optional(),
  name: z.string().min(1).optional(),
  family: z.string().min(1).nullable().optional(),
  reasoning: z.boolean().optional(),
  reasoning_efforts: z.array(z.string().min(1)).optional(),
  reasoning_toggle: z.boolean().optional(),
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
    context: positiveIntegerSchema.nullable().optional(),
    output: positiveIntegerSchema.nullable().optional(),
  }).strict().optional(),
}).strict();

const catalogDocumentSchema = z.object({
  schema_version: z.literal(3),
  scheduler: z.object({
    global_concurrency: positiveIntegerSchema,
    max_queued_requests: positiveIntegerSchema,
    queue_timeout_ms: positiveIntegerSchema,
  }).strict(),
  registry: z.object({
    refresh_interval_ms: z.number().int().min(60_000).default(3_600_000),
    request_timeout_ms: z.number().int().min(1_000).max(60_000).default(10_000),
    stale_after_ms: z.number().int().min(60_000).default(86_400_000),
  }).strict(),
  accounts: z.record(identifierSchema, providerAccountSchema),
  profiles: z.record(identifierSchema, profileSchema),
  model_overrides: z.record(
    identifierSchema,
    z.record(modelIdSchema, modelMetadataOverrideSchema),
  ).default({}),
}).strict();

export type ProviderAccountConfig = z.infer<typeof providerAccountSchema>;
export type ModelNetworkConfig = z.infer<typeof modelNetworkSchema>;
export type ModelInferenceConfig = z.infer<typeof modelInferenceSchema>;
export type ModelSelector = z.infer<typeof modelSelectorSchema>;
export type ModelProfileConfig = z.infer<typeof profileSchema>;
export type ModelMetadataOverride = z.infer<typeof modelMetadataOverrideSchema>;
export type ModelCatalogDocument = z.infer<typeof catalogDocumentSchema>;

export const resolvedModelInferenceSchema = z.object({
  thinking: z.enum(["enabled", "disabled"]).nullable(),
  effort: z.string().min(1).nullable(),
  reasoningBudgetTokens: positiveIntegerSchema.nullable(),
  reasoningSummary: z.string().min(1).nullable(),
  textVerbosity: z.string().min(1).nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  topP: z.number().min(0).max(1).nullable(),
}).strict();

export type ResolvedModelInference = z.infer<typeof resolvedModelInferenceSchema>;

export interface ModelProfileSummary {
  id: string;
  description: string;
  allowedRoles: ModelRole[];
  accountId: string;
  channel: ModelAccountChannel;
  protocol: ModelProtocol;
  dialect: string;
  modelsDevProviderId: string;
  selector: ModelSelector;
  inference: ModelInferenceConfig;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  return value;
}

export class ModelCatalog {
  readonly schemaVersion: 3;
  readonly hash: string;
  readonly scheduler: Readonly<ModelCatalogDocument["scheduler"]>;
  readonly registry: Readonly<ModelCatalogDocument["registry"]>;
  readonly accounts: Readonly<Record<string, Readonly<ProviderAccountConfig>>>;
  readonly profiles: Readonly<Record<string, Readonly<ModelProfileConfig>>>;
  readonly modelOverrides: Readonly<ModelCatalogDocument["model_overrides"]>;

  constructor(document: ModelCatalogDocument) {
    const parsed = catalogDocumentSchema.parse(document);
    if (Object.keys(parsed.accounts).length === 0) {
      throw new Error("model catalog requires at least one provider account");
    }
    if (Object.keys(parsed.profiles).length === 0) {
      throw new Error("model catalog requires at least one profile");
    }
    if (parsed.scheduler.global_concurrency > parsed.scheduler.max_queued_requests) {
      throw new Error("model scheduler queue must be at least as large as global concurrency");
    }
    for (const [profileId, profile] of Object.entries(parsed.profiles)) {
      if (!parsed.accounts[profile.account_id]) {
        throw new Error(`model profile ${profileId} references unknown account ${profile.account_id}`);
      }
      if (new Set(profile.allowed_roles).size !== profile.allowed_roles.length) {
        throw new Error(`model profile ${profileId} has duplicate allowed roles`);
      }
    }
    for (const providerId of Object.keys(parsed.model_overrides)) {
      if (!Object.values(parsed.accounts).some((account) =>
        account.models_dev_provider_id === providerId)) {
        throw new Error(`model overrides reference unused models.dev provider ${providerId}`);
      }
    }
    this.schemaVersion = parsed.schema_version;
    this.hash = contentHash(canonicalize(parsed));
    this.scheduler = deepFreeze(parsed.scheduler);
    this.registry = deepFreeze(parsed.registry);
    this.accounts = deepFreeze(parsed.accounts);
    this.profiles = deepFreeze(parsed.profiles);
    this.modelOverrides = deepFreeze(parsed.model_overrides);
    Object.freeze(this);
  }

  profile(profileId: string): ModelProfileConfig {
    const profile = this.profiles[profileId];
    if (!profile) throw new Error(`unknown model profile ${profileId}`);
    return profile;
  }

  account(accountId: string): ProviderAccountConfig {
    const account = this.accounts[accountId];
    if (!account) throw new Error(`unknown model provider account ${accountId}`);
    return account;
  }

  assertProfile(profileId: string, role?: ModelRole): void {
    const profile = this.profile(profileId);
    if (role && !profile.allowed_roles.includes(role)) {
      throw new Error(`model profile ${profileId} does not allow role ${role}`);
    }
  }

  profileSummaries(role?: ModelRole): ModelProfileSummary[] {
    return Object.entries(this.profiles)
      .filter(([, profile]) => !role || profile.allowed_roles.includes(role))
      .map(([id, profile]) => {
        const account = this.account(profile.account_id);
        return {
          id,
          description: profile.description,
          allowedRoles: [...profile.allowed_roles],
          accountId: profile.account_id,
          channel: account.channel,
          protocol: account.protocol,
          dialect: account.dialect,
          modelsDevProviderId: account.models_dev_provider_id,
          selector: structuredClone(profile.selector),
          inference: structuredClone(profile.inference),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}

export function parseModelCatalog(value: unknown): ModelCatalog {
  return new ModelCatalog(catalogDocumentSchema.parse(value));
}

export function loadModelCatalog(file = path.resolve("config/models.yaml")): ModelCatalog {
  let value: unknown;
  try {
    value = parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot read model catalog ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return parseModelCatalog(value);
  } catch (error) {
    throw new Error(`invalid model catalog ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
