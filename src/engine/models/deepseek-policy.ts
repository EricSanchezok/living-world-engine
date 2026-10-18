import { ModelConfigurationError } from "./model-provider";

/** The live DeepSeek cost policy. Historical receipts are never rewritten. */
export function assertDeepSeekRequest(body: Record<string, unknown>, responses = false): void {
  if (body.model !== "deepseek-flash") throw new ModelConfigurationError("DeepSeek requests require deepseek-flash; recapture historical experiments instead of replaying a different model");
  const thinking = body.thinking as { type?: unknown } | undefined;
  const reasoning = body.reasoning as { effort?: unknown } | undefined;
  const disabled = responses ? reasoning?.effort === "none" : thinking?.type === "disabled";
  const low = responses ? reasoning?.effort === "low" : thinking?.type === "enabled" && body.reasoning_effort === "low";
  if ((!disabled && !low) || body.reasoning_budget !== undefined ||
    (reasoning?.effort !== undefined && reasoning.effort !== "none" && reasoning.effort !== "low") ||
    (body.reasoning_effort !== undefined && body.reasoning_effort !== "low" && body.reasoning_effort !== "none") ||
    (disabled && body.reasoning_effort === "low")) {
    throw new ModelConfigurationError("DeepSeek requires explicit thinking disabled, or enabled with low effort");
  }
}

/** Covers both the gateway and raw experimental HTTP without changing a request. */
export function guardDeepSeekFetch(send: typeof fetch): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method === "POST") {
      const request = new Request(input instanceof Request ? input.clone() : input, init);
      assertDeepSeekRequest(await request.json(), new URL(request.url).pathname.endsWith("/responses"));
    }
    return send(input, init);
  };
}
