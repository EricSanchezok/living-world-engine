import path from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { contentHash } from "../../models/model-audit";
import { serializeRuntimeError } from "../../runtime/observability";
import { completeDeepSeekJsonStream, DEEPSEEK_JSON_STREAM } from "../../models/deepseek-json-stream";
import { AC_FP1_BUDGET, deepSeekExperimentUsage, ExperimentBudget, ExperimentBudgetError, type ExperimentPhase } from "./experiment-budget";
import { immutableExperimentJson } from "./experiment-artifacts";

/** Account for actual transport, optionally retaining the provider scheduler's concurrency.
 * The caller must own the experiment writer lock for this object's lifetime. */
export class FirstPassExperimentTransport {
  private queue: Promise<unknown> = Promise.resolve();
  private trial: { id: string; phase: ExperimentPhase } | undefined;
  private sequence = 0;
  private active = 0;
  private stopped: string | null = null;
  get stopReason(): string | null { return this.stopped; }

  constructor(readonly budget: ExperimentBudget, private readonly options: {
    root: string;
    baseUrl: string;
    inputTokenCeiling: number;
    outputTokenCeiling: number;
    fetch: typeof fetch;
    trialPattern?: RegExp;
    endpointPaths?: readonly string[];
    allowLowerOutputLimit?: boolean;
    priceBinding?: { accountId: string; modelId: string; priceId: string };
    scheduling?: "serialized" | "provider";
    requireThinkingDisabled?: boolean;
    responseTransport?: typeof DEEPSEEK_JSON_STREAM;
  }) {}

  beginTrial(id: string, phase: ExperimentPhase): void {
    if (this.stopped) throw new ExperimentBudgetError(this.stopped);
    if (this.active) throw new ExperimentBudgetError("cannot change trial while HTTP requests remain queued");
    if (!(this.options.trialPattern ?? /^(?:discovery|confirmation)-P0[1-4]-[0-9]{2}-(?:B1|A|T|AT)$/u).test(id) || !id.startsWith(`${phase}-`)) throw new Error("invalid experiment trial identity");
    this.trial = { id, phase };
    const directory = path.join(this.options.root, "http");
    const prefix = `${id}-http-`;
    this.sequence = Math.max(0, ...(existsSync(directory) ? readdirSync(directory) : [])
      .filter((name) => name.startsWith(prefix) && /^\d+$/u.test(name.slice(prefix.length)))
      .map((name) => Number(name.slice(prefix.length))));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const trial = this.trial;
    if (!trial) throw new ExperimentBudgetError("HTTP request has no active experiment trial");
    this.active += 1;
    let reservedId: string | undefined;
    const execute = async () => {
      if (this.stopped) throw new ExperimentBudgetError(this.stopped);
      const request = new Request(input instanceof Request ? input.clone() : input, init);
      const url = new URL(request.url);
      const allowed = new URL(this.options.baseUrl);
      if (request.method !== "POST" || url.origin !== allowed.origin || !(this.options.endpointPaths ?? ["/chat/completions"]).includes(url.pathname.slice(allowed.pathname.replace(/\/$/u, "").length)) || url.search) {
        throw new ExperimentBudgetError("experiment attempted an unapproved provider endpoint");
      }
      const body = await request.clone().json() as Record<string, unknown>;
      request.signal.throwIfAborted();
      if (this.stopped) throw new ExperimentBudgetError(this.stopped);
      const outputLimit = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens;
      const validLimit = this.options.allowLowerOutputLimit ? typeof outputLimit === "number" && Number.isSafeInteger(outputLimit) && outputLimit > 0 && outputLimit <= this.options.outputTokenCeiling : outputLimit === this.options.outputTokenCeiling;
      const binding = this.options.priceBinding;
      const price = binding && this.budget.price(binding.priceId);
      if (binding && (!price || price.accountId !== binding.accountId || price.modelId !== binding.modelId)) {
        throw new ExperimentBudgetError("transport account/model price binding drift");
      }
      const streamed = this.options.responseTransport === DEEPSEEK_JSON_STREAM;
      const usageOptions = body.stream_options as { include_usage?: unknown } | undefined;
      if (body.model !== (binding?.modelId ?? AC_FP1_BUDGET.modelId) || !validLimit ||
        (streamed ? body.stream !== true || usageOptions?.include_usage !== true || !url.pathname.endsWith("/chat/completions") : body.stream === true)) {
        throw new ExperimentBudgetError("actual HTTP model/output limit/streaming drift");
      }
      if (this.options.requireThinkingDisabled) {
        const thinking = body.thinking as { type?: unknown } | undefined;
        const reasoning = body.reasoning as { effort?: unknown } | undefined;
        const disabled = url.pathname.endsWith("/responses")
          ? reasoning?.effort === "none" && (thinking === undefined || thinking.type === "disabled")
          : thinking?.type === "disabled" && (reasoning === undefined || reasoning.effort === "none");
        if (!disabled || (body.reasoning_effort !== undefined && body.reasoning_effort !== "none")) {
          throw new ExperimentBudgetError("actual HTTP thinking must be explicitly disabled");
        }
      }
      const id = `${trial.id}-http-${String(++this.sequence).padStart(3, "0")}`;
      const directory = path.join(this.options.root, "http", id);
      this.budget.reserve({ id, trialId: trial.id, phase: trial.phase, inputCeiling: this.options.inputTokenCeiling, outputCeiling: outputLimit as number,
        ...(binding ? { priceId: binding.priceId } : {}) });
      reservedId = id;
      const startedAt = new Date().toISOString();
      // Only the body is evidence. Request headers contain credentials and are
      // deliberately never copied into experiment artifacts or console output.
      immutableExperimentJson(path.join(directory, "request.json"), { id, trial, startedAt, url: url.origin + url.pathname, body, bodyHash: contentHash(body),
        inFlightAtDispatch: this.budget.summary.inFlight.length, scheduling: this.options.scheduling ?? "serialized" });
      const started = performance.now();
      let response: Response;
      let headersElapsedMs: number | null = null;
      let firstByteElapsedMs: number | null = null;
      let lastByteElapsedMs: number | null = null;
      let maxBodyGapMs = 0;
      const chunks: Uint8Array[] = [];
      let raw: string;
      try {
        response = await this.options.fetch(input, init);
        headersElapsedMs = performance.now() - started;
        immutableExperimentJson(path.join(directory, "response-start.json"), {
          id, status: response.status, receivedAt: new Date().toISOString(), headersElapsedMs,
          contentType: response.headers.get("content-type"),
        });
        const reader = response.clone().body?.getReader();
        if (reader) {
          try {
            for (;;) {
              const part = await reader.read();
              const now = performance.now() - started;
              maxBodyGapMs = Math.max(maxBodyGapMs, now - (lastByteElapsedMs ?? headersElapsedMs));
              if (part.done) break;
              firstByteElapsedMs ??= now;
              lastByteElapsedMs = now;
              chunks.push(part.value);
            }
          } finally { reader.releaseLock(); }
        }
        raw = new TextDecoder("utf-8", { fatal: streamed }).decode(Buffer.concat(chunks));
      } catch (error) {
        const partial = Buffer.concat(chunks);
        immutableExperimentJson(path.join(directory, "response-failure.json"), {
          id, stage: headersElapsedMs === null ? "before-response-headers" : "response-body",
          failedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
          headersElapsedMs, aborted: request.signal.aborted,
          firstByteElapsedMs, lastByteElapsedMs,
          maxBodyGapMs: Math.max(maxBodyGapMs, headersElapsedMs === null ? 0 : performance.now() - started - (lastByteElapsedMs ?? headersElapsedMs)),
          receivedBytes: partial.byteLength, partialBase64: partial.toString("base64"),
          complete: false, error: serializeRuntimeError(error),
        });
        throw error;
      }
      immutableExperimentJson(path.join(directory, "response.json"), { id, status: response.status,
        completedAt: new Date().toISOString(), elapsedMs: performance.now() - started,
        headersElapsedMs, firstByteElapsedMs, lastByteElapsedMs, maxBodyGapMs,
        raw, rawHash: contentHash(raw) });
      // Any network/parse/usage error leaves the send reservation unresolved.
      // The next attempted send fails before reaching the network.
      if (response.ok && streamed && !response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new ExperimentBudgetError("streaming response is not SSE; usage unresolved, reservation retained");
      }
      const value = response.ok && streamed ? completeDeepSeekJsonStream(raw, String(body.model)) : JSON.parse(raw);
      if (!response.ok) {
        const message = typeof value?.error?.message === "string" ? value.error.message : response.statusText;
        throw new ExperimentBudgetError(`provider HTTP ${response.status}: ${message}; usage unresolved, reservation retained`);
      }
      const usage = deepSeekExperimentUsage(value);
      this.budget.settle(id, usage);
      reservedId = undefined;
      if (this.options.requireThinkingDisabled && (
        (value.usage?.completion_tokens_details?.reasoning_tokens ?? 0) > 0 ||
        (value.usage?.output_tokens_details?.reasoning_tokens ?? 0) > 0 ||
        value.choices?.some((choice: { message?: { reasoning_content?: unknown } }) =>
          typeof choice.message?.reasoning_content === "string" && choice.message.reasoning_content.trim().length > 0) ||
        value.output?.some((item: { type?: string }) => item.type === "reasoning")
      )) throw new ExperimentBudgetError("provider reported reasoning despite disabled thinking; incurred usage retained");
      return response;
    };
    const pending = (this.options.scheduling === "provider" ? execute() : this.queue.then(execute))
      .catch((error) => {
        if (reservedId) this.budget.markUnknown(reservedId);
        this.stopped ??= error instanceof Error ? error.message : String(error);
        throw error;
      });
    this.queue = pending.catch(() => undefined);
    try { return await pending; }
    finally { this.active -= 1; }
  };
}
