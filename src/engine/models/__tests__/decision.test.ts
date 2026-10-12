import { describe, expect, it, vi } from "vitest";
import { executeDecision, validateDecisionBatch, type DecisionBatch, type DecisionRequest } from "../decision";
import { contentHash } from "../model-audit";
import { ModelGateway } from "../model-gateway";
import { parseModelCatalog } from "../model-catalog";
import { normalizeModelsDevDocument } from "../model-registry";
import { ContextLimitExceededError, ModelOutputError } from "../model-provider";
import { createTestModelRegistry } from "../../testing/model-provider";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { validateModelAudit } from "../../runtime/transaction";

function catalog() {
  return parseModelCatalog({ schema_version: 3,
    scheduler: { global_concurrency: 4, max_queued_requests: 10, queue_timeout_ms: 1000 },
    registry: {},
    accounts: {
      typesafe: { channel: "api", region: "global", protocol: "typesafe-systemone", dialect: "typesafe",
        models_dev_provider_id: "typesafe", base_url: "https://api.typesafe.test/v1", api_key_env: "TYPESAFE_API_KEY", max_concurrency: 4 },
      deepseek: { channel: "api", region: "global", protocol: "openai-chat", dialect: "deepseek",
        models_dev_provider_id: "deepseek", base_url: "https://api.deepseek.test", api_key_env: "DEEPSEEK_API_KEY", max_concurrency: 4 },
    },
    profiles: Object.fromEntries(["typesafe", "deepseek"].map(account => [account, {
      account_id: account, selector: { kind: "exact", model_id: account === "typesafe" ? "jev-1.13.0" : "deepseek-flash" },
      description: "Decision contract test", allowed_roles: ["decision"], request_timeout_ms: 1000,
      max_output_tokens: 512, max_input_bytes: 262144, inference: account === "deepseek" ? { thinking: "disabled" } : {},
    }])),
    model_overrides: { typesafe: { "jev-1.13.0": {
      disabled: false, name: "Jev 1.13.0", family: "jev", reasoning: false, reasoning_efforts: [], reasoning_toggle: false,
      tool_call: false, structured_output: true, temperature: false, release_date: null, last_updated: null,
      modalities: { input: ["text"], output: ["text"] }, limit: { context: 64000, output: null },
    } } },
  });
}
function batch(): DecisionBatch {
  const state = { observation: "The recipient has not replied.", speaker: "agent-a" };
  return { version: 1, view: { kind: "agent", agentId: "agent-a", projectionHash: contentHash(state) },
    programHash: contentHash("ask-and-trade"), dependencies: { "observation:recipient": 3 }, state,
    questions: { consent: { version: "1", instructions: "Has the recipient explicitly accepted the proposed terms?",
      criteria: { yes: "Explicit acceptance", no: "Explicit refusal", unknown: "Insufficient evidence" }, sources: ["program:consent"] } } };
}
function request(): DecisionRequest {
  return { workloadId: "decision-test", batchId: "decision-test-1", runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 0 },
    profileId: "typesafe", subjectId: "agent-a", batch: batch() };
}
function response() {
  return { model: "jev-1.13.0", answers: { consent: { type: "choice", choice: "unknown",
    probabilities: { yes: 0.02, no: 0.03, unknown: 0.95 }, confidence: 0.91 } }, usage: { input_tokens: 123, output_tokens: 4 } };
}
function gateway(fetch: typeof globalThis.fetch, options: { sleep?: (ms: number) => Promise<void>; observer?: RecordingRuntimeObserver } = {}) {
  const configured = catalog();
  return new ModelGateway(configured, { TYPESAFE_API_KEY: "private-test-key", DEEPSEEK_API_KEY: "private-test-key" }, {
    registry: createTestModelRegistry(configured), fetch, ...options,
  });
}

describe("native decision gateway", () => {
  it("dispatches native choice questions and preserves the full probability distribution and audit", async () => {
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://api.typesafe.test/v1/systemone");
      const wire = JSON.parse(String(init?.body));
      expect(Object.keys(wire).sort()).toEqual(["model", "questions", "state"]);
      expect(wire.state).toEqual(batch().state);
      expect(wire.questions.consent.type).toBe("choice");
      expect(wire.questions.consent.instructions).toContain(batch().questions.consent!.instructions);
      expect(init?.redirect).toBe("error");
      return Response.json(response(), { headers: { "x-request-id": "jev-test" } });
    });
    const result = await gateway(transport, { observer }).decide(request());
    expect(result.answers.consent).toEqual({ choice: "unknown", probabilities: response().answers.consent.probabilities, confidence: 0.91 });
    expect(result.audit.structuredOutputMode).toBe("native-decision");
    expect(result.audit.invocations[0]).toMatchObject({ providerRequestId: "jev-test", tokenUsage: { input: 123, output: 4 } });
    expect(() => validateModelAudit(result.audit, "native decision")).not.toThrow();
    expect(JSON.stringify(observer.snapshot())).not.toContain("private-test-key");
    expect(observer.snapshot().filter(event => event.event === "model.transport.request.raw")).toHaveLength(1);
  });

  it.each(["choice", "probability", "sum", "missing", "extra", "model"])("rejects invalid %s while retaining billable usage", async failure => {
    const value = response();
    if (failure === "choice") value.answers.consent.choice = "invented";
    if (failure === "probability") value.answers.consent.probabilities.yes = -0.2;
    if (failure === "sum") value.answers.consent.probabilities.unknown = 0.2;
    if (failure === "missing") Reflect.deleteProperty(value.answers.consent.probabilities, "no");
    if (failure === "extra") Object.assign(value.answers, { extra: value.answers.consent });
    if (failure === "model") value.model = "jev-latest";
    const transport = vi.fn<typeof fetch>(async () => Response.json(value));
    const error = await gateway(transport).decide(request()).catch(error => error);
    expect(error).toBeInstanceOf(ModelOutputError);
    expect(error.audit.invocations[0].tokenUsage.input).toBe(123);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid view identity, projection, empty batches and singletons before dispatch", async () => {
    const transport = vi.fn<typeof fetch>();
    for (const mutate of [
      (r: DecisionRequest) => { r.subjectId = "agent-b"; },
      (r: DecisionRequest) => { r.batch.view.projectionHash = contentHash("changed"); },
      (r: DecisionRequest) => { r.batch.questions = {}; },
      (r: DecisionRequest) => { r.batch.questions.consent!.criteria = { yes: "Only choice" }; },
    ]) {
      const input = request(); mutate(input);
      await expect(gateway(transport).decide(input)).rejects.toThrow();
    }
    expect(transport).not.toHaveBeenCalled();
    const input = batch(); input.state = Number.NaN;
    expect(() => validateDecisionBatch(input)).toThrow("finite JSON");
  });

  it("honors Retry-After and retains both physical attempts", async () => {
    const delays: number[] = []; let attempts = 0;
    const result = await gateway(async () => ++attempts === 1
      ? new Response("busy", { status: 429, headers: { "Retry-After": "0.1" } }) : Response.json(response()),
    { sleep: async ms => { delays.push(ms); } }).decide(request());
    expect(delays).toEqual([100]);
    expect(result.audit.invocations[0]!.transports).toHaveLength(2);
  });

  it("reports overflow before dispatch and uses only an explicitly configured generative fallback", async () => {
    const input = request(); input.batch.state = "x".repeat(33000); input.batch.view.projectionHash = contentHash(input.batch.state);
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("deepseek-flash");
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(JSON.stringify(body.messages)).toContain(input.batch.state);
      return Response.json({ id: "fallback-test", model: "deepseek-flash", created: 1,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ answers: { consent: { choice: "unknown" } } }) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
    });
    const provider = gateway(transport);
    await expect(provider.decide(input)).rejects.toBeInstanceOf(ContextLimitExceededError);
    expect(transport).not.toHaveBeenCalled();
    const result = await executeDecision(provider, { ...input, fallbackProfileId: "deepseek" });
    expect(result.fallback?.reason).toBe("context-limit");
    expect(result.answers.consent).toEqual({ choice: "unknown", probabilities: null, confidence: null });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch aborted requests", async () => {
    const transport = vi.fn<typeof fetch>(); const controller = new AbortController(); controller.abort();
    await expect(gateway(transport).decide({ ...request(), abortSignal: controller.signal })).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("admits complete local native metadata when a provider is not indexed", () => {
    const configured = catalog();
    const remote = { deepseek: { id: "deepseek", name: "DeepSeek", models: { "deepseek-flash": { id: "deepseek-flash", name: "Flash" } } } };
    const document = normalizeModelsDevDocument(remote, configured);
    expect(document.providers.typesafe!.models["jev-1.13.0"]!.limit.output).toBeNull();
    expect(document.providers.typesafe!.models["jev-1.13.0"]!.fieldSources.limit).toBe("local-override");
    expect(() => normalizeModelsDevDocument({ ...remote, typesafe: null }, configured)).toThrow("missing or invalid");
  });
});
