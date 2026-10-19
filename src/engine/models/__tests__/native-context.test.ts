import { describe, expect, it } from "vitest";
import { directTestProvider, nativeAnswer, type DirectTestWire } from "../../testing/direct-provider";
import { createTestModelRegistry } from "../../testing/model-provider";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { contentHash } from "../model-audit";
import { parseModelCatalog } from "../model-catalog";
import { ModelGateway } from "../model-gateway";
import { decisionPromptV2, decisionWireContextV2, executeDecisionV2, type DecisionRequestV2 } from "../decision-v2";
import { estimateTokens, requestPressure } from "../context-budget";
import { resolveModelProfile } from "../model-registry";
import { ContextLimitExceededError } from "../model-provider";

const answers = (wire: DirectTestWire) => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q)]));
async function fixture(respond: (wire: DirectTestWire, call: number) => unknown = wire => answers(wire)) {
  const base = directTestProvider(respond), source = base.catalog.snapshot();
  source.profiles["decision-jev"] = { ...source.profiles["decision-jev"]!, max_input_bytes: 4_000_000,
    max_question_tokens: 32000, long_context_tokens: 262000 };
  source.profiles["decision-deepseek"]!.max_input_bytes = 4_000_000;
  const catalog = parseModelCatalog(source), registry = createTestModelRegistry(catalog), snapshot = await registry.capture();
  snapshot.document.providers.typesafe!.models["jev-1.13.0"]!.limit.context = 64000;
  snapshot.hash = contentHash(snapshot.document);
  const gateway = new ModelGateway(catalog, { TYPESAFE_API_KEY: "test", TEST_MODEL_API_KEY: "test" },
    { registry, fetch: base.transport, maxTransportAttempts: 1 });
  return { catalog, registry, gateway, transport: base.transport };
}
function request(text: string): DecisionRequestV2 {
  const state = { evidence: text };
  return { workloadId: "native-context", batchId: contentHash(text), subjectId: "world", profileId: "decision-jev",
    runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 1 },
    batch: { version: 2, state, view: { kind: "world", projectionHash: contentHash(state) }, dependencies: {},
      questions: { safe: { type: "choice", version: "1", instructions: "Does the evidence support the action?", criteria: { yes: "Supported", no: "Unsupported" } } } } };
}
const header = (init?: RequestInit) => new Headers(init?.headers).get("TypeSafe-Danger-Zone-Long-Context");

describe("native default and long-context admission", () => {
  it("keeps concurrent small requests in default mode and sends the complete large request once", async () => {
    const f = await fixture(), observer = new RecordingRuntimeObserver({ mode: "full" });
    const small = request("Observed action"), large = request("历史事实。".repeat(6000));
    const limits: number[] = [];
    await Promise.all([small, large].map(input => executeDecisionV2(f.gateway, { ...input, observer,
      memory: { read: () => null, pressure: async (_ids, pressure) => { limits.push(pressure.inputLimit); } } })));
    expect(limits.sort((a, b) => a - b)).toEqual([64000, 262000]);
    expect(f.transport).toHaveBeenCalledTimes(2);
    for (const [, init] of f.transport.mock.calls) {
      const body = JSON.parse(String(init?.body));
      const original = body.state.context.evidence === "Observed action" ? small : large;
      expect(body).toEqual({ model: "jev-1.13.0", ...decisionWireContextV2(original.batch) });
      expect(header(init)).toBe(original === large ? "true" : null);
    }
    const records = observer.snapshot().filter(event => event.event === "model.context.serialized");
    expect(records.map(event => (event.payload as { nativeContextMode: string }).nativeContextMode).sort()).toEqual(["default", "long"]);
  });

  it("measures total questions separately and treats exact token boundaries as default mode", async () => {
    const f = await fixture(), input = request("a short shared state");
    input.batch.questions = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`q${i}`, {
      type: "noul" as const, version: "1", instructions: "a specific condition ".repeat(1000) }]));
    const binding = resolveModelProfile(f.catalog, await f.registry.capture(), "decision-jev");
    const prompt = { system: decisionPromptV2().system, userMessage: "", schemaJson: "", requestUtf8Bytes: 0 };
    const measured = requestPressure(binding, { decision: input.batch }, prompt);
    expect(measured.estimatedInputTokens).toBeGreaterThan(64000);
    expect(measured.estimatedQuestionTokens).toBeLessThan(32000);
    expect(measured.nativeContextMode).toBe("long");
    binding.model.limit.context = measured.estimatedInputTokens;
    binding.profile = { ...binding.profile, max_question_tokens: measured.estimatedQuestionTokens };
    expect(requestPressure(binding, { decision: input.batch }, prompt).nativeContextMode).toBe("default");
  });

  it("does not bypass operator token or byte caps when selecting long mode", async () => {
    const f = await fixture(), input = request("真实证据。".repeat(6000));
    const binding = resolveModelProfile(f.catalog, await f.registry.capture(), "decision-jev");
    const prompt = { system: decisionPromptV2().system, userMessage: "", schemaJson: "", requestUtf8Bytes: 0 };
    binding.profile = { ...binding.profile, max_input_tokens: 1000 };
    const capped = requestPressure(binding, { decision: input.batch }, prompt);
    expect(capped.nativeContextMode).toBe("long");
    expect(capped.inputLimit).toBe(1000);
    expect(capped.ratio).toBeGreaterThan(1);
    delete binding.profile.max_input_tokens;
    binding.profile.max_input_bytes = 1000;
    expect(requestPressure(binding, { decision: input.batch }, prompt).ratio).toBeGreaterThan(1);
  });

  it.each([false, true])("escalates a provider-confirmed default overflow once before fallback: %s", async failLong => {
    const f = await fixture((wire, call) => call === 1 || call === 2 && failLong
      ? Response.json({ code: "max_tokens_exceeded" }, { status: 400 }) : answers(wire));
    const result = await executeDecisionV2(f.gateway, { ...request("Observed action"), fallbackProfileId: "decision-deepseek" });
    expect(result.dispatches.map(item => item.profileId)).toEqual(failLong
      ? ["decision-jev", "decision-jev", "decision-deepseek"] : ["decision-jev", "decision-jev"]);
    expect(f.transport.mock.calls.map(([, init]) => header(init))).toEqual(failLong ? [null, "true", null] : [null, "true"]);
    expect(f.transport.mock.calls[0]![1]!.body).toBe(f.transport.mock.calls[1]![1]!.body);
  });

  it("rejects above the extended budget before HTTP even without memory, preserving intact fallback", async () => {
    const f = await fixture(), input = request("汉".repeat(140000));
    await expect(executeDecisionV2(f.gateway, input)).rejects.toBeInstanceOf(ContextLimitExceededError);
    expect(f.transport).not.toHaveBeenCalled();
    await executeDecisionV2(f.gateway, { ...input, fallbackProfileId: "decision-deepseek" });
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(String(f.transport.mock.calls[0]![1]!.body)).toContain("汉".repeat(140000));
  });

  it("does not repeat an already-long request rejected by the provider", async () => {
    const f = await fixture((wire, call) => call === 1
      ? Response.json({ code: "max_tokens_exceeded" }, { status: 400 }) : answers(wire));
    const input = request("当前证据。".repeat(6000));
    const result = await executeDecisionV2(f.gateway, { ...input, fallbackProfileId: "decision-deepseek" });
    expect(result.dispatches.map(item => item.profileId)).toEqual(["decision-jev", "decision-deepseek"]);
    expect(f.transport.mock.calls.map(([, init]) => header(init))).toEqual(["true", null]);
  });

  it("budgets the actual publication policy and does not escalate a non-context provider error", async () => {
    const f = await fixture(() => Response.json({ message: "invalid key" }, { status: 401 })), input = request("a grounded paragraph");
    const binding = resolveModelProfile(f.catalog, await f.registry.capture(), "decision-jev"), prompt = decisionPromptV2("publication");
    const pressure = requestPressure(binding, { decision: input.batch }, { system: prompt.system, userMessage: "", schemaJson: "", requestUtf8Bytes: 0 });
    const wire = decisionWireContextV2(input.batch, "publication");
    expect(pressure.uncalibratedInputTokens).toBe(estimateTokens(wire) + 128);
    expect(pressure.requestUtf8Bytes).toBe(Buffer.byteLength(JSON.stringify({ model: "jev-1.13.0", ...wire })));
    await expect(executeDecisionV2(f.gateway, { ...input, instructionProfile: "publication", fallbackProfileId: "decision-deepseek" })).rejects.toThrow("401");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
});
