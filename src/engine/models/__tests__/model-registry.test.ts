import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog, parseModelCatalog, type ModelCatalogDocument, type ModelMetadataOverride } from "../model-catalog";
import {
  MODELS_DEV_API_URL,
  MAX_MODELS_DEV_RESPONSE_BYTES,
  ModelRegistry,
  ModelRegistryError,
  ModelResolutionError,
  normalizeModelsDevDocument,
  resolveModelProfile,
} from "../model-registry";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function dataRoot(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "livingworld-model-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function catalog(overrides: Partial<ModelCatalogDocument> = {}) {
  const base: ModelCatalogDocument = {
    schema_version: 3,
    scheduler: { global_concurrency: 2, max_queued_requests: 8, queue_timeout_ms: 1_000 },
    registry: { refresh_interval_ms: 3_600_000, request_timeout_ms: 10_000, stale_after_ms: 86_400_000 },
    accounts: {
      "deepseek-api": {
        channel: "api",
        region: "global",
        protocol: "openai-chat",
        dialect: "deepseek",
        models_dev_provider_id: "deepseek",
        base_url: "https://trusted.deepseek.test/v1",
        api_key_env: "DEEPSEEK_API_KEY",
        max_concurrency: 2,
      },
    },
    profiles: {
      latest: {
        account_id: "deepseek-api",
        selector: { kind: "latest-compatible", include: ["deep-*"], exclude: ["*vision*"] },
        description: "latest compatible test profile",
        allowed_roles: ["agent-mind"],
        request_timeout_ms: 10_000,
        max_output_tokens: 1_000,
        max_input_bytes: 4_096,
        inference: {
          thinking: "auto",
          effort: "auto",
          reasoning_budget_tokens: "auto",
          reasoning_summary: "auto",
          text_verbosity: "auto",
          temperature: "auto",
          top_p: "auto",
        },
      },
      exact: {
        account_id: "deepseek-api",
        selector: { kind: "exact", model_id: "deep-stable" },
        description: "exact test profile",
        allowed_roles: ["agent-mind"],
        request_timeout_ms: 10_000,
        max_output_tokens: 1_000,
        max_input_bytes: 4_096,
        inference: {
          thinking: "disabled",
          effort: "auto",
          reasoning_budget_tokens: "auto",
          reasoning_summary: "auto",
          text_verbosity: "auto",
          temperature: "auto",
          top_p: "auto",
        },
      },
    },
    model_overrides: {},
  };
  return parseModelCatalog({ ...base, ...overrides });
}

function model(
  id: string,
  releaseDate: string,
  lastUpdated: string,
  additions: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    family: "deep-family",
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "high"] },
      { type: "budget_tokens", min: 1, max: 8_000 },
    ],
    tool_call: true,
    structured_output: true,
    temperature: true,
    release_date: releaseDate,
    last_updated: lastUpdated,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 32_000, output: 8_000 },
    ...additions,
  };
}

function remoteCatalog(models: Record<string, unknown> = {
  "deep-stable": model("deep-stable", "2026-01-01", "2026-01-02"),
  "deep-new-z": model("deep-new-z", "2026-02-01", "2026-02-02"),
  "deep-new-a": model("deep-new-a", "2026-02-01", "2026-02-02"),
  "deep-vision": model("deep-vision", "2026-03-01", "2026-03-02"),
}) {
  return {
    deepseek: {
      id: "deepseek",
      name: "Untrusted remote display name",
      api: "https://attacker.invalid/v1",
      env: ["ATTACKER_API_KEY"],
      npm: "attacker-package",
      models,
    },
  };
}

function jsonResponse(body: unknown, options: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: options.status ?? 200,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
}

describe("trusted provider transport configuration", () => {
  it("allows loopback HTTP for local harnesses but rejects remote plaintext endpoints", () => {
    const configured = catalog();
    const document = {
      schema_version: 3 as const,
      scheduler: configured.scheduler,
      registry: configured.registry,
      profiles: configured.profiles,
      model_overrides: configured.modelOverrides,
    };
    const account = configured.account("deepseek-api");

    expect(() => parseModelCatalog({
      ...document,
      accounts: {
        "deepseek-api": { ...account, base_url: "http://127.0.0.1:32128" },
      },
    })).not.toThrow();
    expect(() => parseModelCatalog({
      ...document,
      accounts: {
        "deepseek-api": { ...account, base_url: "http://models.example.test/v1" },
      },
    })).toThrow("provider base URL must use HTTPS, or loopback HTTP");
  });
});

describe("models.dev registry", () => {
  it("creates a content-addressed first snapshot without trusting remote transport metadata", async () => {
    let requestedUrl = "";
    const root = dataRoot();
    const registry = new ModelRegistry(catalog(), root, {
      minimumRefreshIntervalMs: 0,
      fetch: async (input) => {
        requestedUrl = String(input);
        return jsonResponse(remoteCatalog(), { headers: { etag: '"catalog-v1"' } });
      },
    });

    const result = await registry.refresh();
    expect(requestedUrl).toBe(MODELS_DEV_API_URL);
    expect(result.outcome).toBe("updated");
    expect(result.snapshot.document.providers.deepseek?.models["deep-stable"]?.name)
      .toBe("deep-stable");
    expect(registry.catalog.account("deepseek-api").base_url)
      .toBe("https://trusted.deepseek.test/v1");
    const files = readdirSync(path.join(root, "model-registry", "snapshots"));
    expect(files).toEqual([`${result.snapshot.hash}.json`]);
    expect(readFileSync(path.join(
      root,
      "model-registry",
      "snapshots",
      files[0]!,
    ), "utf8")).not.toContain("checkedAt");
  });

  it("uses ETag/304 and preserves the exact immutable snapshot", async () => {
    let calls = 0;
    let ifNoneMatch: string | null = null;
    const root = dataRoot();
    const registry = new ModelRegistry(catalog(), root, {
      minimumRefreshIntervalMs: 0,
      fetch: async (_input, init) => {
        calls += 1;
        ifNoneMatch = new Headers(init?.headers).get("if-none-match");
        return calls === 1
          ? jsonResponse(remoteCatalog(), { headers: { etag: '"catalog-v1"' } })
          : new Response(null, { status: 304 });
      },
    });

    const first = await registry.refresh();
    const second = await registry.refresh();
    expect(second.outcome).toBe("not-modified");
    expect(second.snapshot).toBe(first.snapshot);
    expect(ifNoneMatch).toBe('"catalog-v1"');
    expect(readdirSync(path.join(root, "model-registry", "snapshots"))).toHaveLength(1);
  });

  it("falls back to the last valid snapshot after corrupt JSON, offline, and HTTP failures", async () => {
    const failures = [
      new Response("not-json", { status: 200, headers: { "content-type": "application/json" } }),
      new TypeError("offline"),
      new Response("unavailable", { status: 503 }),
    ];
    let calls = 0;
    const registry = new ModelRegistry(catalog(), dataRoot(), {
      minimumRefreshIntervalMs: 0,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return jsonResponse(remoteCatalog());
        const failure = failures[calls - 2]!;
        if (failure instanceof Error) throw failure;
        return failure;
      },
    });
    const first = await registry.refresh();
    for (const expected of ["invalid JSON", "offline", "HTTP 503"]) {
      const fallback = await registry.refresh();
      expect(fallback.outcome).toBe("stale-fallback");
      expect(fallback.snapshot.hash).toBe(first.snapshot.hash);
      expect(fallback.error).toContain(expected);
    }
    expect(registry.status()).toMatchObject({ health: "degraded", currentHash: first.snapshot.hash });
  });

  it("fails closed when the first remote response is corrupt", async () => {
    const registry = new ModelRegistry(catalog(), dataRoot(), {
      minimumRefreshIntervalMs: 0,
      fetch: async () => jsonResponse({ deepseek: { id: "deepseek", name: "broken", models: {} } }),
    });
    await expect(registry.refresh()).rejects.toBeInstanceOf(ModelRegistryError);
    expect(registry.status().health).toBe("missing");
  });

  it("rejects an oversized remote response before parsing it", async () => {
    const registry = new ModelRegistry(catalog(), dataRoot(), {
      minimumRefreshIntervalMs: 0,
      fetch: async () => new Response("{}", {
        headers: { "content-length": String(MAX_MODELS_DEV_RESPONSE_BYTES + 1) },
      }),
    });
    await expect(registry.refresh()).rejects.toThrow(
      `models.dev response exceeds ${MAX_MODELS_DEV_RESPONSE_BYTES} bytes`,
    );
    expect(registry.status().health).toBe("missing");
  });

  it("coalesces concurrent refreshes into one request and switches only after validation", async () => {
    let resolveResponse!: (value: Response) => void;
    let calls = 0;
    const response = new Promise<Response>((resolve) => { resolveResponse = resolve; });
    const registry = new ModelRegistry(catalog(), dataRoot(), {
      minimumRefreshIntervalMs: 0,
      fetch: async () => {
        calls += 1;
        return response;
      },
    });
    const first = registry.refresh();
    const second = registry.refresh();
    expect(registry.status()).toMatchObject({ health: "refreshing", currentHash: null });
    resolveResponse(jsonResponse(remoteCatalog()));
    const [left, right] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(left.snapshot.hash).toBe(right.snapshot.hash);
    expect(registry.currentSnapshot()?.hash).toBe(left.snapshot.hash);
  });

  it("aborts a timed-out fetch and fails closed without a valid snapshot", async () => {
    vi.useFakeTimers();
    const configured = catalog({
      registry: { refresh_interval_ms: 60_000, request_timeout_ms: 1_000, stale_after_ms: 60_000 },
    });
    const registry = new ModelRegistry(configured, dataRoot(), {
      minimumRefreshIntervalMs: 0,
      fetch: async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      }),
    });

    const refresh = expect(registry.refresh()).rejects.toThrow("timed out after 1000 ms");
    await vi.advanceTimersByTimeAsync(1_000);
    await refresh;
    expect(registry.status()).toMatchObject({ health: "missing", refreshing: false });
  });

  it("rate-limits repeated manual refreshes without starting another request", async () => {
    let calls = 0;
    const registry = new ModelRegistry(catalog(), dataRoot(), {
      now: () => 10_000,
      minimumRefreshIntervalMs: 30_000,
      fetch: async () => {
        calls += 1;
        return jsonResponse(remoteCatalog());
      },
    });

    await registry.refresh({ reason: "manual" });
    await expect(registry.refresh({ reason: "manual" })).rejects.toThrow("rate limited");
    expect(calls).toBe(1);
  });

  it("does not create a new snapshot when normalized content is unchanged", async () => {
    const root = dataRoot();
    const registry = new ModelRegistry(catalog(), root, {
      minimumRefreshIntervalMs: 0,
      fetch: async () => jsonResponse(remoteCatalog()),
    });
    const first = await registry.refresh();
    const second = await registry.refresh();
    expect(second.outcome).toBe("unchanged");
    expect(second.snapshot.hash).toBe(first.snapshot.hash);
    expect(readdirSync(path.join(root, "model-registry", "snapshots"))).toHaveLength(1);
  });

  it("records local override provenance and rejects partial overrides for unknown models", () => {
    const configured = catalog({
      model_overrides: {
        deepseek: {
          "deep-stable": { family: "locally-audited", structured_output: false },
        },
      },
    });
    const document = normalizeModelsDevDocument(remoteCatalog(), configured);
    expect(document.providers.deepseek?.models["deep-stable"]).toMatchObject({
      family: "locally-audited",
      structuredOutput: false,
      fieldSources: {
        family: "local-override",
        structuredOutput: "local-override",
        toolCall: "models.dev",
      },
    });
    const invalid = catalog({ model_overrides: { deepseek: { missing: { disabled: true } } } });
    expect(() => normalizeModelsDevDocument(remoteCatalog(), invalid))
      .toThrow("local overrides reference unknown deepseek models without complete metadata: missing");
  });
});

describe("complete local model definitions", () => {
  it("resolves the bundled non-thinking Flash profiles before remote indexing", async () => {
    const bundled = loadModelCatalog(path.resolve("config/models.yaml"));
    const configured = catalog({
      accounts: { "deepseek-api": bundled.account("deepseek-api") },
      profiles: Object.fromEntries(["truth-deepseek", "agent-deepseek"].map(id => [id, bundled.profile(id)])),
      model_overrides: { deepseek: bundled.modelOverrides.deepseek! },
    });
    const root = dataRoot();
    const registry = new ModelRegistry(configured, root, { fetch: async () => jsonResponse(remoteCatalog()) });
    const snapshot = (await registry.refresh()).snapshot;
    for (const id of ["truth-deepseek", "agent-deepseek"]) {
      const binding = resolveModelProfile(configured, snapshot, id);
      expect(binding.modelId).toBe("deepseek-flash");
      expect(binding.model.fieldSources.id).toBe("local-override");
      expect(binding.profile).toMatchObject({ inference: { thinking: "disabled" }, response_transport: "deepseek-sse-v1" });
      expect(binding.account.max_concurrency).toBe(4);
    }
    expect(new ModelRegistry(configured, root).snapshot(snapshot.hash)).toEqual(snapshot);
  });

  const definition: Required<ModelMetadataOverride> = {
    disabled: false, name: "Explicit local model", family: "deep-family", reasoning: true,
    reasoning_efforts: [], reasoning_toggle: true, tool_call: true, structured_output: false,
    temperature: true, release_date: "2026-09-10", last_updated: "2026-09-10",
    modalities: { input: ["text"], output: ["text"] }, limit: { context: 10000, output: 2000 },
  };
  function configured(value: ModelMetadataOverride = definition) {
    const original = catalog().profiles;
    const profiles = { ...original, exact: { ...original.exact!, selector: { kind: "exact" as const, model_id: "deep-local" } } };
    return catalog({ profiles, model_overrides: { deepseek: { "deep-local": value } } });
  }
  it("persists local provenance, admits exact selection and preserves snapshots after remote indexing", async () => {
    const config = configured(), root = dataRoot(); let indexed = false;
    const registry = new ModelRegistry(config, root, { minimumRefreshIntervalMs: 0, fetch: async () => {
      const remote = remoteCatalog();
      if (indexed) remote.deepseek.models["deep-local"] = model("deep-local", "2026-09-10", "2026-09-10");
      return jsonResponse(remote);
    } });
    const initial = (await registry.refresh()).snapshot;
    const local = resolveModelProfile(config, initial, "exact");
    expect(local.modelId).toBe("deep-local");
    expect(Object.values(local.model.fieldSources).every(source => source === "local-override")).toBe(true);
    expect(local.model.reasoningBudget).toBeNull();
    expect(resolveModelProfile(config, initial, "latest").modelId).toBe("deep-new-a");
    expect(local.account.base_url).toBe("https://trusted.deepseek.test/v1");
    indexed = true;
    const current = (await registry.refresh()).snapshot;
    expect(current.hash).not.toBe(initial.hash);
    expect(resolveModelProfile(config, current, "exact").model.fieldSources.id).toBeUndefined();
    expect(resolveModelProfile(config, current, "latest").modelId).toBe("deep-local");
    const reopened = new ModelRegistry(config, root);
    expect(reopened.snapshot(initial.hash)).toEqual(initial);
    expect(resolveModelProfile(config, reopened.snapshot(initial.hash), "exact").modelMetadataHash).toBe(local.modelMetadataHash);
  });
  it("requires every field and applies existing capability, disabled and output-limit rejection", () => {
    for (const key of Object.keys(definition) as Array<keyof ModelMetadataOverride>) {
      const partial = structuredClone(definition); delete (partial as ModelMetadataOverride)[key];
      expect(() => normalizeModelsDevDocument(remoteCatalog(), configured(partial))).toThrow("without complete metadata");
    }
    for (const limit of [{ output: 2000 }, { context: null, output: 2000 }, { context: 10000, output: null }]) {
      expect(() => normalizeModelsDevDocument(remoteCatalog(), configured({ ...definition, limit }))).toThrow("without complete metadata");
    }
    for (const change of [{ disabled: true }, { reasoning_toggle: false }, { tool_call: false },
      { limit: { context: 10000, output: 500 } }, { modalities: { input: [], output: ["text"] } }]) {
      const config = configured({ ...definition, ...change });
      const document = normalizeModelsDevDocument(remoteCatalog(), config);
      expect(() => resolveModelProfile(config, { hash: "a".repeat(64), document }, "exact")).toThrow("incompatible");
    }
  });
});

describe("deterministic model selection", () => {
  function snapshotFor(configured = catalog(), models?: Record<string, unknown>) {
    const document = normalizeModelsDevDocument(remoteCatalog(models), configured);
    return { hash: "a".repeat(64), document };
  }

  it("orders by release date, last update, then model id and honors include/exclude", () => {
    const configured = catalog();
    const resolved = resolveModelProfile(configured, snapshotFor(configured), "latest");
    expect(resolved.modelId).toBe("deep-new-a");
    expect(resolved.registrySnapshotHash).toBe("a".repeat(64));
    expect(resolved.account.base_url).toBe("https://trusted.deepseek.test/v1");
  });

  it("supports family globs", () => {
    const configured = catalog({
      profiles: {
        family: {
          ...catalog().profile("latest"),
          selector: { kind: "latest-compatible", family: "preferred-*", include: ["*"], exclude: [] },
        },
      },
    });
    const models = {
      other: model("other", "2026-03-01", "2026-03-01", { family: "other" }),
      preferred: model("preferred", "2026-01-01", "2026-01-01", { family: "preferred-track" }),
    };
    expect(resolveModelProfile(configured, snapshotFor(configured, models), "family").modelId)
      .toBe("preferred");
  });

  it("never replaces an absent, disabled, or incompatible exact model", () => {
    const configured = catalog();
    const missing = snapshotFor(configured, {
      replacement: model("replacement", "2026-03-01", "2026-03-01"),
    });
    expect(() => resolveModelProfile(configured, missing, "exact"))
      .toThrow("requires exact model deep-stable");

    const disabledCatalog = catalog({
      model_overrides: { deepseek: { "deep-stable": { disabled: true } } },
    });
    expect(() => resolveModelProfile(disabledCatalog, snapshotFor(disabledCatalog), "exact"))
      .toThrow("disabled by local configuration");

    const unsupported = snapshotFor(configured, {
      "deep-stable": model("deep-stable", "2026-01-01", "2026-01-01", {
        reasoning_options: [],
      }),
    });
    expect(() => resolveModelProfile(configured, unsupported, "exact"))
      .toThrow("thinking toggle is not declared");
  });

  it("fails latest-compatible when an explicit inference parameter is unsupported", () => {
    const configured = catalog({
      profiles: {
        latest: {
          ...catalog().profile("latest"),
          inference: {
            ...catalog().profile("latest").inference,
            effort: "max",
          },
        },
      },
    });
    expect(() => resolveModelProfile(configured, snapshotFor(configured), "latest"))
      .toThrow(ModelResolutionError);
    expect(() => resolveModelProfile(configured, snapshotFor(configured), "latest"))
      .toThrow("reasoning effort max is not declared");
  });
});
