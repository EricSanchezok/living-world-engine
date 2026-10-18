import { describe, expect, it, vi } from "vitest";
import { assertDeepSeekRequest, guardDeepSeekFetch } from "../deepseek-policy";
import { createModelFetchResolver } from "../model-network";
import { loadModelCatalog } from "../model-catalog";

describe("live DeepSeek policy", () => {
  it.each([
    { model: "deepseek-v4-pro", thinking: { type: "disabled" } },
    { model: "deepseek-v4-flash", thinking: { type: "disabled" } },
    { model: "deepseek-flash" },
    { model: "deepseek-flash", thinking: { type: "enabled" } },
    { model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "high" },
    { model: "deepseek-flash", thinking: { type: "enabled" }, reasoning_effort: "max" },
    { model: "deepseek-flash", thinking: { type: "disabled" }, reasoning_effort: "low" },
  ])("rejects unsupported or implicit inference before dispatch: %j", async body => {
    const send = vi.fn<typeof fetch>();
    await expect(guardDeepSeekFetch(send)("https://example.test/chat/completions", { method: "POST", body: JSON.stringify(body) })).rejects.toThrow(/DeepSeek/u);
    expect(send).not.toHaveBeenCalled();
  });

  it.each(["disabled", "low"])("preserves allowed %s requests without rewriting their evidence", async mode => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const body = { model: "deepseek-flash", messages: [{ role: "user", content: "A real task" }],
      thinking: { type: mode === "low" ? "enabled" : "disabled" }, ...(mode === "low" ? { reasoning_effort: "low" } : {}) };
    const request = new Request("https://example.test/chat/completions", { method: "POST", body: JSON.stringify(body) });
    await guardDeepSeekFetch(send)(request);
    expect(send).toHaveBeenCalledWith(request, undefined);
    expect(await request.json()).toEqual(body);
  });

  it("enforces the same policy for Responses and raw experiment network clients", async () => {
    for (const effort of ["none", "low"]) expect(() => assertDeepSeekRequest({ model: "deepseek-flash", reasoning: { effort } }, true)).not.toThrow();
    for (const effort of [undefined, "high", "max"]) expect(() => assertDeepSeekRequest({ model: "deepseek-flash", reasoning: { effort } }, true)).toThrow(/DeepSeek/u);
    const account = { ...loadModelCatalog().account("deepseek-api"), network: undefined };
    const transport = createModelFetchResolver({})("experiment", account)!;
    await expect(transport("https://api.deepseek.com/chat/completions", { method: "POST", body: JSON.stringify({ model: "deepseek-v4-pro" }) })).rejects.toThrow("deepseek-flash");
  });
});
