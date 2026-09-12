import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalize, contentHash } from "../models/model-audit";
import { repairPromptLayout } from "./repair-layout";
import { serializeModelContext, type SHARED_STATE_FIRST_LAYOUT } from "./context-layout";

export type PromptBundleId =
  | "truth-perception"
  | "truth-reaction-routing"
  | "truth-resolution"
  | "truth-transition"
  | "agent-bootstrap"
  | "agent-mind"
  | "agent-reaction"
  | "action-compilation"
  | "action-grounding"
  | "observation-renderer"
  | "arrival-generator"
  | "resolution-plan-verifier"
  | "causal-verifier"
  | "model-smoke";

export interface PromptBundle {
  readonly id: PromptBundleId;
  readonly system: string;
  readonly userPrompt: string;
  readonly version: string;
}

const cache = new Map<string, string>();
const templateKeys: Readonly<Record<string, readonly string[]>> = {
  "transport/context-envelope.md": ["TASK", "CONTEXT"],
  "transport/json-object.md": ["ENVELOPE", "DISCRIMINATOR", "SCHEMA", "EXAMPLE_BLOCK"],
  "transport/json-example.md": ["EXAMPLE"],
  "transport/tool-call.md": ["ENVELOPE", "DISCRIMINATOR"],
  "transport/tool-description.md": ["SCHEMA_NAME"],
};

function normalizePrompt(value: string, relativePath: string, allowTemplates: boolean): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  if (!normalized) throw new Error(`prompt asset ${relativePath} is empty`);
  const placeholders = [...normalized.matchAll(/\{\{([^}]+)\}\}/gu)].map((match) => match[1]!.trim());
  if (!allowTemplates && placeholders.length > 0) {
    throw new Error(`prompt asset ${relativePath} contains an unresolved template placeholder`);
  }
  if (allowTemplates) {
    const allowed = new Set(templateKeys[relativePath] ?? []);
    if (placeholders.some((placeholder) => !allowed.has(placeholder))) {
      throw new Error(`prompt asset ${relativePath} contains an unresolved template placeholder`);
    }
  }
  return normalized;
}

export function loadPromptAsset(relativePath: string, options: { allowTemplates?: boolean } = {}): string {
  if (!/^(?:system|user|shared|transport)(?:\/[a-z0-9-]+)+\.md$/u.test(relativePath)) {
    throw new Error(`invalid prompt asset path: ${relativePath}`);
  }
  const allowTemplates = options.allowTemplates ?? false;
  const cacheKey = `${relativePath}:${allowTemplates ? "template" : "plain"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;
  const sourcePath = path.join(process.cwd(), "src", "engine", "prompts", relativePath);
  const modulePath = new URL(relativePath, new URL("./", import.meta.url));
  const assetPath = existsSync(sourcePath) ? sourcePath : modulePath;
  const value = normalizePrompt(
    readFileSync(assetPath, "utf8"),
    relativePath,
    allowTemplates,
  );
  cache.set(cacheKey, value);
  return value;
}

function composeSystem(assets: readonly string[]): string {
  return [...assets, "shared/semantic-contract.md", "shared/failure-examples.md"]
    .map((asset) => loadPromptAsset(asset))
    .join("\n\n")
    .trim();
}

interface PromptSpec {
  system: readonly string[];
  user: string;
}

const specs: Record<PromptBundleId, PromptSpec> = {
  "truth-perception": { system: ["system/truth-perception.md", "shared/language.md"], user: "user/truth-perception.md" },
  "truth-reaction-routing": { system: ["system/truth.md", "shared/language.md"], user: "user/truth-reaction-routing.md" },
  "truth-resolution": { system: ["system/truth.md", "shared/resolution-effect-scope.md", "shared/resolution-plan-effects.md", "shared/resolution-condition-references.md", "shared/language.md"], user: "user/truth-resolution.md" },
  "truth-transition": { system: ["system/truth.md", "shared/transition-assertion-states.md", "shared/transition-receipt-stage.md", "shared/language.md"], user: "user/truth-transition.md" },
  "agent-bootstrap": { system: ["system/agent-batch.md", "system/agent.md", "shared/language.md"], user: "user/agent-bootstrap.md" },
  "agent-mind": { system: ["system/agent-batch.md", "system/agent.md", "shared/language.md"], user: "user/agent-mind.md" },
  "agent-reaction": { system: ["system/reaction.md", "shared/language.md"], user: "user/agent-reaction.md" },
  "action-compilation": { system: ["system/action-compilation.md", "shared/interaction-grounding.md", "shared/language.md"], user: "user/action-compilation.md" },
  "action-grounding": { system: ["system/action-grounding.md", "shared/interaction-grounding.md", "shared/language.md"], user: "user/action-grounding.md" },
  "observation-renderer": { system: ["system/observation-renderer.md", "shared/language.md"], user: "user/observation-renderer.md" },
  "arrival-generator": { system: ["system/arrival.md", "shared/language.md"], user: "user/arrival.md" },
  "resolution-plan-verifier": { system: ["system/resolution-plan-verifier.md", "shared/language.md"], user: "user/resolution-plan-verifier.md" },
  "causal-verifier": { system: ["system/causal-verifier.md", "shared/language.md"], user: "user/causal-verifier.md" },
  "model-smoke": { system: ["system/model-smoke.md", "shared/language.md"], user: "user/model-smoke.md" },
};

const bundleCache = new Map<PromptBundleId, PromptBundle>();
const transportVersionAssets = [
  "transport/context-envelope.md",
  "transport/json-object.md",
  "transport/json-example.md",
  "transport/tool-call.md",
  "transport/tool-description.md",
  "transport/discriminator/default.md",
  "transport/discriminator/truth-perception.md",
  "transport/discriminator/truth-resolution.md",
] as const;

export function promptBundle(id: PromptBundleId): PromptBundle {
  const existing = bundleCache.get(id);
  if (existing) return existing;
  const spec = specs[id];
  const system = composeSystem(spec.system);
  const userPrompt = loadPromptAsset(spec.user);
  const transport = Object.fromEntries(transportVersionAssets.map((asset) => [
    asset,
    loadPromptAsset(asset, { allowTemplates: true }),
  ]));
  const version = `${id}@${contentHash({ system, userPrompt, transport }).slice(0, 16)}`;
  const bundle = Object.freeze({ id, system, userPrompt, version });
  bundleCache.set(id, bundle);
  return bundle;
}

function renderTemplate(template: string, values: Readonly<Record<string, string>>): string {
  for (const match of template.matchAll(/\{\{([A-Z_]+)\}\}/gu)) {
    if (values[match[1]!] === undefined) throw new Error(`missing prompt template value ${match[1]}`);
  }
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/gu, (_match, key: string) => {
    const value = values[key];
    return value!;
  });
  return rendered.trim();
}

export function composeContextEnvelope(userPrompt: string, contextJson: string): string {
  return renderTemplate(loadPromptAsset("transport/context-envelope.md", { allowTemplates: true }), {
    TASK: userPrompt,
    CONTEXT: contextJson,
  });
}

export function composeJsonObjectPrompt(input: {
  userPrompt: string;
  contextJson: string;
  schemaJson: string;
  exampleJson?: string;
  discriminator: string;
}): string {
  return renderTemplate(loadPromptAsset("transport/json-object.md", { allowTemplates: true }), {
    ENVELOPE: composeContextEnvelope(input.userPrompt, input.contextJson),
    DISCRIMINATOR: input.discriminator,
    SCHEMA: input.schemaJson,
    EXAMPLE_BLOCK: input.exampleJson === undefined ? "" : renderTemplate(
      loadPromptAsset("transport/json-example.md", { allowTemplates: true }), { EXAMPLE: input.exampleJson }),
  });
}

export function composeToolCallPrompt(input: {
  userPrompt: string;
  contextJson: string;
  discriminator: string;
}): string {
  return renderTemplate(loadPromptAsset("transport/tool-call.md", { allowTemplates: true }), {
    ENVELOPE: composeContextEnvelope(input.userPrompt, input.contextJson),
    DISCRIMINATOR: input.discriminator,
  });
}

export function toolDescription(schemaName: string): string {
  return renderTemplate(loadPromptAsset("transport/tool-description.md", { allowTemplates: true }), {
    SCHEMA_NAME: schemaName,
  });
}

export function discriminatorInstruction(schemaName: string): string {
  if (schemaName === "truth_perception_directive") {
    return loadPromptAsset("transport/discriminator/truth-perception.md");
  }
  if (schemaName === "truth_resolution_directive") {
    return loadPromptAsset("transport/discriminator/truth-resolution.md");
  }
  return loadPromptAsset("transport/discriminator/default.md");
}

export function structuredPromptBytes(input: {
  system: string;
  userPrompt: string;
  context: unknown;
  schema: z.ZodType;
  wireJsonSchema?: Record<string, unknown>;
  jsonObjectPostlude?: string;
  repairContextPlacement?: "tail-v1" | "logical-tail-v1";
  contextLayout?: typeof SHARED_STATE_FIRST_LAYOUT;
}): { contextJson: string; schemaJson: string; userMessage: string; requestUtf8Bytes: number } {
  // Compact JSON keeps the data payload lossless while avoiding formatting
  // bytes that do not help the model or the request budget.
  const contextJson = serializeModelContext(input.context, input.contextLayout);
  const schemaJson = JSON.stringify(canonicalize(input.wireJsonSchema ?? z.toJSONSchema(input.schema, { target: "draft-07" })));
  const layout = repairPromptLayout(input.userPrompt, contextJson, input.repairContextPlacement);
  const userMessage = composeContextEnvelope(layout.userPrompt, layout.contextJson) + layout.tail + (input.jsonObjectPostlude ?? "");
  return {
    contextJson,
    schemaJson,
    userMessage,
    requestUtf8Bytes: Buffer.byteLength(JSON.stringify({
      system: input.system,
      prompt: userMessage,
      schema: schemaJson,
    }, null, 2), "utf8"),
  };
}

export function promptAssetManifest(): Readonly<Record<PromptBundleId, string>> {
  return Object.fromEntries((Object.keys(specs) as PromptBundleId[]).map((id) => [id, promptBundle(id).version])) as Record<PromptBundleId, string>;
}
