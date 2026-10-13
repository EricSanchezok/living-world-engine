import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { closeQualificationBudget, qualificationModelFetchResolver } from "../jev-qualification-budget";
import { loadModelCatalog } from "../../engine/models/model-catalog";

describe("interactive qualification budget", () => {
  it("shares one persistent capped ledger across gateway instances and refuses unpriced calls", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-interactive-budget-"));
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 2 } })));
    const catalog = loadModelCatalog(), account = catalog.account("typesafe-api");
    try {
      const first = qualificationModelFetchResolver({ LIVINGWORLD_JEV_BUDGET_ROOT: root }, () => transport);
      const second = qualificationModelFetchResolver({ LIVINGWORLD_JEV_BUDGET_ROOT: root }, () => transport);
      for (const resolver of [first, second]) await resolver("typesafe-api", account)!("https://example.invalid/systemone", {
        method: "POST", body: JSON.stringify({ model: "jev-1.13.0", state: {}, questions: {} }),
      });
      expect(transport).toHaveBeenCalledTimes(2);
      const entries = readFileSync(path.join(root, "budget.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line).entry);
      expect(entries.filter(entry => entry.kind === "reserve")).toHaveLength(2);
      expect(entries.filter(entry => entry.kind === "settle")).toHaveLength(2);
      expect(new Set(entries.filter(entry => entry.kind === "reserve").map(entry => entry.trialId)).size).toBe(1);
      await expect(first("unpriced", account)!("https://example.invalid", { body: "{}" })).rejects.toThrow("unpriced");
      expect(transport).toHaveBeenCalledTimes(2);
      await closeQualificationBudget(); expect(existsSync(path.join(root, "budget.lock"))).toBe(false);
    } finally { await closeQualificationBudget(); rmSync(root, { recursive: true, force: true }); }
  });
  it("leaves ordinary configured transport alone when qualification is disabled", () => {
    const resolver = vi.fn(() => fetch);
    expect(qualificationModelFetchResolver({}, resolver)).toBe(resolver);
  });
});
