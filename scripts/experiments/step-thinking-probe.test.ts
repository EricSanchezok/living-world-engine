import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { thinkingCatalog, thinkingProbeBody, thinkingProbeEvidence, thinkingProbeAccountFetch } from "./step-thinking-probe";

describe("controlled STEP-E1 thinking probe", () => {
  it.each(["high", "low"] as const)("changes only the selected profile's %s inference and leaves the base catalog immutable", (effort) => {
    const base = loadModelCatalog(path.resolve("config/models.yaml"));
    const high = thinkingCatalog(base, effort);
    expect(high.hash).not.toBe(base.hash);
    expect(high.accounts).toEqual(base.accounts);
    expect(high.registry).toEqual(base.registry);
    expect(high.modelOverrides).toEqual(base.modelOverrides);
    expect(high.scheduler).toEqual(base.scheduler);
    for (const [id, profile] of Object.entries(base.profiles)) {
      expect(high.profiles[id]).toEqual(id === "truth-deepseek" ? { ...profile,
        inference: { ...profile.inference, thinking: "enabled", effort } } : profile);
    }
    expect(base.profile("truth-deepseek").inference.thinking).toBe("disabled");
  });

  it("serializes thinking through the shared production Chat dialect without changing messages or limits", () => {
    const base = { model: "deepseek-v4-flash", max_tokens: 131072, messages: [{ role: "system", content: "Complete all slots." }],
      thinking: { type: "disabled" }, response_format: { type: "json_object" } };
    const before = structuredClone(base);
    const high = thinkingProbeBody(base, "H");
    expect(high).toEqual({ ...base, thinking: { type: "enabled" }, reasoning_effort: "high" });
    expect(thinkingProbeBody(high, "B")).toEqual(base);
    const low = thinkingProbeBody(high, "L");
    expect(low).toEqual({ ...base, thinking: { type: "enabled" }, reasoning_effort: "low" });
    expect(thinkingProbeBody(low, "B")).toEqual(base);
    expect(base).toEqual(before);
  });

  it("fails closed when the enabled mode is not visible in the actual response", () => {
    const raw = { model: "deepseek-v4-flash", usage: { completion_tokens: 3 }, choices: [{ message: { reasoning_content: "" } }] };
    expect(thinkingProbeEvidence(raw, "H").inferenceValid).toBe(false);
    const thinking = { ...raw, choices: [{ message: { reasoning_content: "Provider reasoning." } }] };
    expect(thinkingProbeEvidence(thinking, "H").inferenceValid).toBe(true);
    expect(thinkingProbeEvidence(thinking, "L").inferenceValid).toBe(true);
    expect(thinkingProbeEvidence(thinking, "B").inferenceValid).toBe(false);
    expect(thinkingProbeEvidence({ ...thinking, model: "another-model" }, "H").inferenceValid).toBe(false);
  });

  it("constructs the real multi-account gateway without sending and guards only actual unapproved sends", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "thinking-gateway-"));
    let sent = 0;
    const transport = thinkingProbeAccountFetch(async () => { sent += 1; return new Response("{}"); });
    try {
      const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
      const env = Object.fromEntries(Object.values(catalog.accounts).map((account) => [account.api_key_env, "test-only-credential"]));
      const resolved = new Set<string>();
      for (const selected of [catalog, thinkingCatalog(catalog), thinkingCatalog(catalog, "low")]) {
        const registry = new ModelRegistry(selected, root, { fetch: async () => { throw new Error("offline metadata boundary"); } });
        expect(() => createModelGateway(selected, env, { registry, fetchForAccount: (id) => {
          resolved.add(id);return transport(id);
        } })).not.toThrow();
      }
      expect([...resolved].sort()).toEqual(Object.keys(catalog.accounts).sort());
      expect(sent).toBe(0);
      await expect(transport("qwen-campus")("https://example.com")).rejects.toThrow("unapproved account");
      expect(sent).toBe(0);
      await transport("deepseek-api")("https://example.com");
      expect(sent).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
