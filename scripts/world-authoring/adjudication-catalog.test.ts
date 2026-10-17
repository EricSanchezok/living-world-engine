import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { sourceAdjudicationCatalog } from "./adjudication-catalog";

describe("source adjudication workload catalog", () => {
  it("creates a dedicated creation profile while preserving account transport and the global catalog", () => {
    const base = loadModelCatalog(path.resolve("config/models.yaml")), original = base.hash;
    const catalog = sourceAdjudicationCatalog(base, { profileId: "source-review-openai", baseProfileId: "agent-openai",
      modelId: "gpt-6-astra", effort: "high", accountConcurrency: 4 });
    catalog.assertProfile("source-review-openai", "creation");
    expect(catalog.profile("source-review-openai")).toMatchObject({ account_id: "openai-api",
      allowed_roles: ["creation"], max_input_bytes: 4000000, selector: { kind: "exact", model_id: "gpt-6-astra" },
      inference: { thinking: "auto", effort: "high" } });
    expect(catalog.accounts["openai-api"]?.protocol).toBe(base.accounts["openai-api"]?.protocol);
    expect(catalog.accounts["openai-api"]?.max_concurrency).toBe(4);
    expect(catalog.profile("agent-openai")).toEqual(base.profile("agent-openai"));
    expect(base.hash).toBe(original);
    expect(base.profiles).not.toHaveProperty("source-review-openai");
    expect(() => catalog.assertProfile("source-review-openai", "agent-mind")).toThrow();
  });
});
