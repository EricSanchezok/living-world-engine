import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadModelCatalog, parseModelCatalog } from "../model-catalog";
import { ModelGateway } from "../model-gateway";
import { contentHash } from "../model-audit";
import { vendorDialect } from "../model-dialect";
import {
  MODELS_DEV_API_URL,
  type ModelRegistryService,
  type ModelRegistrySnapshot,
  resolveModelProfile,
} from "../model-registry";
import { TEST_WORLD_HASH } from "../../testing/world";

const outputSchema = z.strictObject({ answer: z.string() });

const profileModels = {
  "agent-deepseek": "deepseek-flash",
  "agent-openai": "gpt-5.6",
  "agent-xai": "grok-4.6",
  "agent-zhipu": "glm-5.3-flash",
  "agent-zhipu-coding": "glm-5.3-flash",
  "agent-minimax": "MiniMax-M2.7",
  "agent-minimax-token-plan": "MiniMax-M2.7",
  "agent-kimi": "kimi-k2.5",
  "agent-kimi-coding": "kimi-k2.5",
  "agent-mimo": "mimo-v2-flash",
  "agent-mimo-token-plan": "mimo-v2-flash",
  "agent-qwen": "Qwen3.8-27B",
} as const;

function modelMetadata(id: string, structuredOutput: boolean) {
  return {
    id,
    name: id,
    family: "matrix",
    status: null,
    disabled: false,
    reasoning: true,
    reasoningToggle: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    reasoningBudget: { min: 1, max: 65_536 },
    toolCall: true,
    structuredOutput,
    temperature: true,
    releaseDate: "2026-08-01",
    lastUpdated: "2026-08-20",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1_000_000, output: 65_536 },
    fieldSources: {},
  };
}

function registry(catalog: ReturnType<typeof loadModelCatalog>): ModelRegistryService {
  const providers: ModelRegistrySnapshot["document"]["providers"] = {};
  for (const [profileId, modelId] of Object.entries(profileModels)) {
    const profile = catalog.profile(profileId);
    const account = catalog.account(profile.account_id);
    const provider = providers[account.models_dev_provider_id] ??= {
      id: account.models_dev_provider_id,
      name: account.models_dev_provider_id,
      models: {},
    };
    const toolOnly = account.dialect === "minimax" || account.dialect === "mimo";
    provider.models[modelId] = modelMetadata(modelId, !toolOnly);
  }
  const document: ModelRegistrySnapshot["document"] = {
    schemaVersion: 1,
    source: MODELS_DEV_API_URL,
    providers,
  };
  const snapshot = { hash: contentHash(document), document };
  return {
    catalog,
    async capture(hash) {
      if (hash && hash !== snapshot.hash) throw new Error(`unknown matrix snapshot ${hash}`);
      return snapshot;
    },
    async refresh() {
      return { outcome: "unchanged", snapshot, checkedAt: "2026-08-28T00:00:00.000Z", error: null };
    },
    status() {
      return {
        source: MODELS_DEV_API_URL,
        health: "fresh",
        refreshing: false,
        currentHash: snapshot.hash,
        checkedAt: "2026-08-28T00:00:00.000Z",
        ageMs: 0,
        stale: false,
        lastError: null,
      };
    },
  };
}

function chatResponse(model: string, answer: string, toolCall: boolean): Response {
  return Response.json({
    id: `chat-${answer}`,
    object: "chat.completion",
    created: 1,
    model,
    choices: [{
      index: 0,
      message: toolCall
        ? {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: `tool-${answer}`,
              type: "function",
              function: { name: "submit_result", arguments: JSON.stringify({ answer }) },
            }],
          }
        : { role: "assistant", content: JSON.stringify({ answer }) },
      finish_reason: toolCall ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 2 },
      prompt_tokens_details: { cached_tokens: 1 },
    },
  });
}

function responsesApiResponse(model: string, answer: string): Response {
  return Response.json({
    id: `responses-${answer}`,
    object: "response",
    created_at: 1,
    status: "completed",
    model,
    output: [{
      id: `message-${answer}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: JSON.stringify({ answer }), annotations: [] }],
    }],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 1 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 15,
    },
  });
}

function anthropicResponse(model: string, answer: string): Response {
  return Response.json({
    id: `anthropic-${answer}`,
    type: "message",
    role: "assistant",
    model,
    content: [{
      type: "tool_use",
      id: `tool-${answer}`,
      name: "submit_result",
      input: { answer },
    }],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1 },
  });
}

function request(profileId: keyof typeof profileModels, ordinal = 1) {
  return {
    profileId,
    workloadId: "matrix-workload",
    batchId: "matrix-batch",
    role: "agent-mind" as const,
    subjectId: `${profileId}-${ordinal}`,
    promptVersion: "matrix-v1",
    schemaName: "matrix_output",
    system: "Return the requested structured result.",
    userPrompt: "Return the requested matrix result for this test context.",
    context: { account: profileId },
    schema: outputSchema,
    runtimeIdentity: { worldHash: TEST_WORLD_HASH, revision: ordinal },
  };
}

describe("provider account protocol matrix", () => {
  it.each(["json-object-zod", "json-schema-strict"] as const)("runs DeepSeek Responses %s through the real gateway", async (mode) => {
    const original = loadModelCatalog();
    const accountId = original.profile("agent-deepseek").account_id;
    const catalog = parseModelCatalog({ schema_version: original.schemaVersion, scheduler: original.scheduler,
      registry: original.registry, profiles: { ...original.profiles, "agent-deepseek": { ...original.profile("agent-deepseek"), response_transport: undefined } }, model_overrides: original.modelOverrides,
      accounts: { ...original.accounts, [accountId]: { ...original.account(accountId), protocol: "openai-responses" } } });
    let body: Record<string, unknown> | undefined;
    const gateway = new ModelGateway(catalog, { [catalog.account(accountId).api_key_env]: "test-only" }, {
      registry: registry(catalog), fetch: async (url, init) => {
        expect(String(url)).toMatch(/\/responses$/u);
        body = JSON.parse(String(init?.body));
        return responsesApiResponse("deepseek-flash", "verified");
      },
    });
    const result = await gateway.generateStructured({ ...request("agent-deepseek"), structuredOutputMode: mode });
    expect(result.value).toEqual({ answer: "verified" });
    expect(result.audit.structuredOutputMode).toBe(mode);
    expect(body).toMatchObject({ reasoning: { effort: "none" }, text: { format: { type: mode === "json-object-zod" ? "json_object" : "json_schema" } } });
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("thinking");
    expect(body).not.toHaveProperty("store");
    expect(body!.input).toEqual(expect.arrayContaining([expect.objectContaining({ role: "system" })]));
    expect((body!.input as Array<{ role?: string }>).some((item) => item.role === "developer")).toBe(false);
    expect(result.audit.invocations[0]!.tokenUsage).toMatchObject({ input: 10, output: 5, cacheRead: 1 });
    expect(original.account(accountId).protocol).toBe("openai-chat");
  });
  it("pins every production DeepSeek profile to non-thinking Flash with native SSE", () => {
    const catalog = loadModelCatalog();
    const deepSeekProfiles = Object.entries(catalog.profiles)
      .filter(([, profile]) => catalog.account(profile.account_id).dialect === "deepseek");

    expect(deepSeekProfiles.map(([profileId]) => profileId).sort()).toEqual([
      "agent-deepseek",
      "truth-deepseek",
    ]);
    for (const [, profile] of deepSeekProfiles) {
      expect(profile.selector).toEqual({
        kind: "exact",
        model_id: "deepseek-flash",
      });
      expect(profile.inference.thinking).toBe("disabled");
      expect(profile.response_transport).toBe("deepseek-sse-v1");
    }
  });

  it("keeps vendor inference mapping inside independent dialect plugins", async () => {
    const catalog = loadModelCatalog();
    const snapshot = await registry(catalog).capture();
    const compile = (profileId: keyof typeof profileModels) => {
      const binding = resolveModelProfile(catalog, snapshot, profileId);
      const explicit = {
        ...binding,
        profile: {
          ...binding.profile,
          inference: {
            thinking: "enabled" as const,
            effort: "high",
            reasoning_budget_tokens: 2_048,
            reasoning_summary: "auto" as const,
            text_verbosity: "auto" as const,
            temperature: "auto" as const,
            top_p: "auto" as const,
          },
        },
      };
      const plan = vendorDialect(explicit.account.dialect, explicit.account.protocol)
        .compile(explicit, request(profileId));
      return { plan, body: plan.transformBody({ model: explicit.modelId }) };
    };

    expect(compile("agent-zhipu").body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      reasoning_budget: 2_048,
    });
    expect(compile("agent-mimo").body).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      reasoning_budget: 2_048,
    });
    expect(compile("agent-qwen").body).toMatchObject({
      chat_template_kwargs: { enable_thinking: true },
      reasoning_effort: "high",
      reasoning_budget: 2_048,
    });
    expect(compile("agent-minimax").body).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 2_048 },
      output_config: { effort: "high" },
    });
    expect(compile("agent-openai").body).toMatchObject({
      reasoning: { effort: "high" },
      store: false,
    });
    const kimi = compile("agent-kimi-coding");
    expect(kimi.body).toMatchObject({
      thinking: { type: "enabled", budget_tokens: 2_048 },
      output_config: { effort: "high" },
      prompt_cache_key: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(kimi.plan.headers["user-agent"]).toBe("LivingWorldEngine/0.1.0");
  });

  it("executes every configured account through its declared protocol without fallback", async () => {
    const catalog = loadModelCatalog();
    const credentials = Object.fromEntries(Object.values(catalog.accounts)
      .map((account) => [account.api_key_env, `secret-for-${account.api_key_env}`]));
    const calls: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const gateway = new ModelGateway(catalog, credentials, {
      registry: registry(catalog),
      fetch: async (input, init) => {
        const url = String(input);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const headers = new Headers(init?.headers);
        calls.push({ url, headers, body });
        const model = String(body.model);
        const answer = model;
        if (url.endsWith("/responses")) return responsesApiResponse(model, answer);
        if (url.endsWith("/messages")) return anthropicResponse(model, answer);
        if (body.stream === true) {
          const completion = await chatResponse(model, answer, false).json();
          const chunk = { id: completion.id, object: "chat.completion.chunk", created: 1, model,
            choices: [{ index: 0, delta: { content: JSON.stringify({ answer }) }, finish_reason: "stop" }],
            usage: { ...completion.usage, prompt_cache_hit_tokens: 1, prompt_cache_miss_tokens: 9 } };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return chatResponse(model, answer, Array.isArray(body.tools));
      },
    });

    for (const [profileId, modelId] of Object.entries(profileModels) as
      Array<[keyof typeof profileModels, string]>) {
      const result = await gateway.generateStructured(request(profileId));
      const account = catalog.account(catalog.profile(profileId).account_id);
      expect(result.value).toEqual({ answer: modelId });
      expect(result.audit).toMatchObject({
        accountId: catalog.profile(profileId).account_id,
        accountChannel: account.channel,
        protocol: account.protocol,
        dialect: account.dialect,
        providerId: account.models_dev_provider_id,
        modelId,
        registrySnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        modelMetadataHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        modelCatalogSchemaVersion: 3,
      });
      if (profileId === "agent-zhipu-coding") {
        expect(result.audit.structuredOutputMode).toBe("json-object-zod");
      }
      if (profileId === "agent-qwen") {
        expect(result.audit.structuredOutputMode).toBe("json-object-zod");
      }
      expect(JSON.stringify(result.audit)).not.toContain(credentials[account.api_key_env]);
    }

    expect(calls).toHaveLength(Object.keys(profileModels).length);
    for (const call of calls.filter((candidate) => candidate.url.includes("bigmodel.cn"))) {
      const responseFormat = call.body.response_format as { type?: unknown } | undefined;
      if (responseFormat?.type === "json_object") {
        expect(call.body.response_format).toEqual({ type: "json_object" });
        expect(call.body.tools).toBeUndefined();
        expect(call.body.tool_choice).toBeUndefined();
      } else if (call.body.response_format) {
        expect(responseFormat?.type).toBe("json_schema");
        expect(call.body.tools).toBeUndefined();
        expect(call.body.tool_choice).toBeUndefined();
      } else {
        expect(call.body.tools).toEqual([expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "submit_result" }),
        })]);
        expect(call.body.tool_choice).toBe("auto");
      }
    }
    const deepSeekCall = calls.find((candidate) => candidate.url.includes("api.deepseek.com"));
    expect(deepSeekCall?.body).toMatchObject({
      model: "deepseek-flash",
      thinking: { type: "disabled" },
    });
    expect(deepSeekCall?.body).not.toHaveProperty("reasoning_effort");
    for (const call of calls) {
      expect(call.url).not.toContain("models.dev");
      if (call.url.includes("xiaomimimo.com")) {
        expect(call.headers.get("api-key")).toMatch(/^secret-for-/);
        expect(call.headers.has("authorization")).toBe(false);
      } else {
        expect(call.headers.get("authorization")).toMatch(/^Bearer secret-for-/);
      }
    }
    const byBase = new Map(calls.map((call) => [new URL(call.url).origin + new URL(call.url).pathname
      .replace(/\/(?:chat\/completions|responses|messages)$/, ""), call]));
    for (const account of Object.values(catalog.accounts)) {
      expect([...byBase.keys()].some((calledBase) =>
        calledBase.replace(/\/$/, "") === account.base_url.replace(/\/$/, ""))).toBe(true);
    }
  });

  it("uses an honest User-Agent and stable profile/prompt-bundle cache key for Kimi Coding", async () => {
    const catalog = loadModelCatalog();
    const observed: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const gateway = new ModelGateway(catalog, { KIMI_CODING_PLAN_API_KEY: "kimi-secret" }, {
      registry: registry(catalog),
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        observed.push({ headers: new Headers(init?.headers), body });
        return anthropicResponse(String(body.model), "kimi-k2.5");
      },
    });

    await gateway.generateStructured(request("agent-kimi-coding", 1));
    await gateway.generateStructured(request("agent-kimi-coding", 2));
    expect(observed).toHaveLength(2);
    expect(observed[0]?.headers.get("user-agent")).toContain("LivingWorldEngine/0.1.0");
    expect(observed[0]?.headers.get("user-agent")).not.toMatch(/claude-code|cursor|codex/i);
    expect(observed[0]?.body.prompt_cache_key).toMatch(/^[a-f0-9]{64}$/);
    expect(observed[1]?.body.prompt_cache_key).toBe(observed[0]?.body.prompt_cache_key);
  });

  it("captures one immutable snapshot per execution while later executions see an atomic refresh", async () => {
    const catalog = loadModelCatalog();
    const base = await registry(catalog).capture();
    const snapshotWith = (modelId: string, releaseDate: string): ModelRegistrySnapshot => {
      const document = structuredClone(base.document);
      document.providers.zhipuai!.models = {
        [modelId]: {
          ...modelMetadata(modelId, true),
          releaseDate,
          lastUpdated: releaseDate,
        },
      };
      return { hash: contentHash(document), document };
    };
    const oldSnapshot = snapshotWith("glm-old", "2026-01-01");
    const newSnapshot = snapshotWith("glm-new", "2026-08-01");
    let current = oldSnapshot;
    let captures = 0;
    const snapshots = new Map([
      [oldSnapshot.hash, oldSnapshot],
      [newSnapshot.hash, newSnapshot],
    ]);
    const service: ModelRegistryService = {
      catalog,
      async capture(hash) {
        captures += 1;
        if (!hash) return current;
        const found = snapshots.get(hash);
        if (!found) throw new Error(`unknown test snapshot ${hash}`);
        return found;
      },
      async refresh() {
        current = newSnapshot;
        return { outcome: "updated", snapshot: current, checkedAt: "2026-08-28T00:00:00.000Z", error: null };
      },
      status: () => ({
        source: MODELS_DEV_API_URL,
        health: "fresh",
        refreshing: false,
        currentHash: current.hash,
        checkedAt: "2026-08-28T00:00:00.000Z",
        ageMs: 0,
        stale: false,
        lastError: null,
      }),
    };
    const gateway = new ModelGateway(catalog, { ZHIPU_API_KEY: "zhipu-secret" }, {
      registry: service,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        return chatResponse(body.model, body.model, false);
      },
    });
    const sameExecution = (ordinal: number) => ({
      ...request("agent-zhipu", ordinal),
      correlation: { executionId: "execution-old" },
    });

    const first = gateway.generateStructured(sameExecution(1));
    await service.refresh();
    const rest = Array.from({ length: 29 }, (_, index) =>
      gateway.generateStructured(sameExecution(index + 2)));
    const oldResults = await Promise.all([first, ...rest]);
    expect(new Set(oldResults.map((result) => result.audit.registrySnapshotHash)))
      .toEqual(new Set([oldSnapshot.hash]));
    expect(new Set(oldResults.map((result) => result.audit.modelId)))
      .toEqual(new Set(["glm-old"]));
    expect(captures).toBe(1);

    const next = await gateway.generateStructured({
      ...request("agent-zhipu", 31),
      correlation: { executionId: "execution-new" },
    });
    expect(next.audit).toMatchObject({
      registrySnapshotHash: newSnapshot.hash,
      modelId: "glm-new",
    });

    const replay = await gateway.generateStructured({
      ...request("agent-zhipu", 32),
      correlation: { executionId: "execution-replay" },
      modelRegistrySnapshotHash: oldSnapshot.hash,
    });
    expect(replay.audit).toMatchObject({
      registrySnapshotHash: oldSnapshot.hash,
      modelId: "glm-old",
    });
    expect(captures).toBe(3);
  });
});
