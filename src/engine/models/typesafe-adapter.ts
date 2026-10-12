import { z } from "zod";
import type { ModelAdapterResult, ModelProviderAdapter } from "./model-adapter";
import type { ProviderAccountConfig, ResolvedModelInference } from "./model-catalog";
import type { ResolvedModelBinding } from "./model-registry";
import { contentHash } from "./model-audit";
import { ContextLimitExceededError, ModelConfigurationError, ModelOutputError, ModelTransportError, type StructuredModelRequest } from "./model-provider";
import { decisionOutputSchema, decisionPrompt, decisionWireContext, validateDecisionBatch } from "./decision";
import { runtimeEventEmitter, type RuntimeCorrelation } from "../runtime/observability";

const nativeInference: ResolvedModelInference = {
  thinking: null, effort: null, reasoningBudgetTokens: null, reasoningSummary: null,
  textVerbosity: null, temperature: null, topP: null,
};
const usageSchema = z.object({ input_tokens: z.number().int().nonnegative().safe(), output_tokens: z.number().int().nonnegative().safe() });

function nativeContext(context: unknown) {
  const envelope = z.object({ decision: z.unknown() }).strict().parse(context);
  const batch = validateDecisionBatch(envelope.decision);
  const wire = decisionWireContext(batch);
  // No provider tokenizer is published. UTF-8 bytes are a conservative token
  // upper bound; never silently truncate an authorized projection. The runtime
  // may partition independent dependencies or use an explicitly audited fallback.
  const stateBound = Buffer.byteLength(JSON.stringify(wire.state), "utf8") + 256;
  const questionBounds = Object.values(wire.questions).map(question => Buffer.byteLength(JSON.stringify(question), "utf8") + 256);
  if (stateBound + Math.max(...questionBounds) > 32_000 ||
    stateBound + questionBounds.reduce((sum, length) => sum + length, 0) > 64_000) {
    throw new ContextLimitExceededError("TypeSafe decision exceeds the conservative 32k per-question or 64k combined token bound");
  }
  return { batch, wire };
}

/** Native TypeSafe transport. Scheduling, retries and durable audits are owned by ModelGateway. */
export class TypeSafeModelAdapter implements ModelProviderAdapter {
  readonly protocol = "typesafe-systemone" as const;
  readonly dialect = "typesafe";
  constructor(readonly accountId: string, private readonly account: ProviderAccountConfig,
    private readonly apiKey: string, private readonly fetchImplementation: typeof fetch) {
    if (account.protocol !== this.protocol || account.dialect !== this.dialect) {
      throw new ModelConfigurationError("invalid TypeSafe account protocol or dialect");
    }
  }

  describe<T>(binding: ResolvedModelBinding, request: StructuredModelRequest<T>) {
    const prompt = decisionPrompt();
    if (request.role !== "decision" || request.schemaName !== "DecisionBatchV1" || request.structuredOutputMode ||
      request.preprocessOutput || request.jsonSyntaxRecovery || binding.profile.response_transport ||
      request.system !== prompt.system || request.userPrompt !== prompt.userPrompt || request.promptVersion !== prompt.version) {
      throw new ModelConfigurationError("TypeSafe accepts only native DecisionBatchV1 requests");
    }
    if (Object.values(binding.profile.inference).some(value => value !== "auto")) {
      throw new ModelConfigurationError("TypeSafe does not accept generative inference parameters");
    }
    const { batch } = nativeContext(request.context);
    if (batch.view.kind === "agent" && batch.view.agentId !== request.subjectId) {
      throw new ModelConfigurationError("native private decision requires the owning subject");
    }
    return { resolvedInference: nativeInference, structuredOutputMode: "native-decision" as const };
  }

  async generate<T>(binding: ResolvedModelBinding, request: StructuredModelRequest<T>, contextJson: string,
    transportCorrelation?: RuntimeCorrelation): Promise<ModelAdapterResult> {
    const description = this.describe(binding, request);
    const { batch, wire } = nativeContext(JSON.parse(contextJson));
    const url = `${this.account.base_url.replace(/\/$/u, "")}/systemone`;
    const body = JSON.stringify({ model: binding.modelId, ...wire });
    const signal = AbortSignal.any([AbortSignal.timeout(binding.profile.request_timeout_ms), ...(request.abortSignal ? [request.abortSignal] : [])]);
    const observe = request.observer?.mode === "full" ? runtimeEventEmitter(request.observer) : undefined;
    observe?.({ event: "model.transport.request.raw", correlation: transportCorrelation,
      payload: { url, method: "POST", headers: { "content-type": "application/json", authorization: "[redacted]" }, body } });
    const response = await this.fetchImplementation(url, {
      method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body, signal, redirect: "error",
    });
    const text = await response.text();
    observe?.({ event: "model.transport.response.raw", correlation: transportCorrelation,
      payload: { url, status: response.status, headers: Object.fromEntries(response.headers), body: text } });
    if (!response.ok) {
      const error = new ModelTransportError(`TypeSafe returned HTTP ${response.status}`, {
        statusCode: response.status, retriable: [408, 429].includes(response.status) || response.status >= 500,
      });
      Object.assign(error, { responseHeaders: Object.fromEntries(response.headers) });
      throw error;
    }
    let value: unknown;
    try { value = JSON.parse(text); }
    catch (cause) { throw new ModelOutputError("TypeSafe returned invalid JSON", undefined, { cause, rawValue: text }); }
    const envelope = value as { usage?: unknown; model?: unknown; answers?: unknown } | null;
    const usage = usageSchema.safeParse(envelope?.usage);
    const completion = { tokenUsage: { input: usage.success ? usage.data.input_tokens : null,
      output: usage.success ? usage.data.output_tokens : null, cacheRead: null, cacheWrite: null, reasoning: null },
      responseId: response.headers.get("x-request-id") ?? "", responseModelId: typeof envelope?.model === "string" ? envelope.model : "",
      finishReason: "stop" };
    try {
      if (!usage.success) throw new Error("TypeSafe response has no valid usage");
      if (envelope?.model !== binding.modelId) throw new Error("TypeSafe response model differs from the pinned model");
      const parsed = decisionOutputSchema(batch, true).parse({ answers: envelope.answers });
      return { ...description, ...completion, value: parsed, rawValueHash: contentHash(value), symbolRepairs: [], jsonRecovery: "strict" };
    } catch (cause) {
      throw new ModelOutputError("TypeSafe returned an invalid decision", undefined, { cause, rawValue: value, completion });
    }
  }
}
