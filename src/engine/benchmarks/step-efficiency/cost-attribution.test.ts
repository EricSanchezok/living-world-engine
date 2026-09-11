import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { composeJsonObjectPrompt } from "../../prompts";
import { PHYSICAL_BATCH_REPAIR_NOTICE, repairPromptLayout } from "../../prompts/repair-layout";
import { recordedContext } from "./repair-tail";
import { contentHash } from "../../models/model-audit";
import { STEP_E2_BUDGET } from "./nonthinking-protocol";
import { attributeTokenCost, httpConcurrency, recordedLogicalRepair, recordedPhysicalRepair, verifyHttpUsage } from "./cost-attribution";
import { factorSharedBatchContexts } from "../../mechanics/shared-batch-context";
import { compactSharedCatalogPrefix } from "../../mechanics/shared-catalog-prefix";
import { compactSharedCatalogRecords } from "../../mechanics/shared-catalog-records";

describe("cost attribution evidence", () => {
  it("finds component repairs behind the shipped catalog codecs without treating quoted feedback as a repair", () => {
    const slots = [0, 1].map(index => ({ state: { actionSet: { assigned: Array.from({ length: index + 1 }, (_, i) => ({ actionRef: `ref:action:${index}-${i}` })) },
      quoted: { repair: { issues: [{ code: "not-real-feedback" }] } } },
      referenceCatalog: { candidates: [{ handle: "ref:fact:a", label: "A", allowedUses: ["assertion"], meaning: "Source fact", statePath: null }] },
      repair: index ? { issues: [{ code: "causal_assertion_failed" }], previousOutput: { outcomes: [] } } : null,
    }));
    const shared = factorSharedBatchContexts(slots, "shared-json-v3");
    const prefix = compactSharedCatalogPrefix(shared), records = compactSharedCatalogRecords(prefix);
    for (const state of [shared, prefix, records]) {
      const context = { state, repair: null }, before = contentHash(context);
      const result = recordedLogicalRepair(context);
      expect(result.slots).toEqual(slots);
      expect(result.detail).toMatchObject({ logicalRepair: true, logicalRepairSlots: [1], logicalActionCount: 3,
        logicalRepairActionCount: 2, logicalRepairIssueCodes: ["causal_assertion_failed"], logicalLayout: "shared-json-v3" });
      expect(contentHash(context)).toBe(before);
    }
    expect(recordedLogicalRepair(slots[0]!).detail.logicalRepair).toBe(false);
    expect(recordedLogicalRepair({ state: { codec: "future-layout" } }).detail.logicalLayout).toBe("unrecognized:future-layout");
    const corrupt = structuredClone(records);
    corrupt.catalogOrderPrefix = ["ref:fact:invented"];
    expect(() => recordedLogicalRepair({ state: corrupt })).toThrow();
  });
  const body = { messages: [{ role: "user", content: "complete original context" }] };
  const request = { body, bodyHash: contentHash(body) };
  const usage = { input: 100, output: 4, cacheHit: 25 };
  const raw = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 4, prompt_cache_hit_tokens: 25 } });
  const response = { raw, rawHash: createHash("sha256").update(raw).digest("hex") };
  it("reconciles independently recorded usage and rejects altered evidence", () => {
    expect(verifyHttpUsage(request, response, usage)).toEqual(usage);
    expect(() => verifyHttpUsage({ ...request, body: {} }, response, usage)).toThrow("checksum");
    expect(() => verifyHttpUsage(request, { ...response, raw: raw + " " }, usage)).toThrow("checksum");
    expect(() => verifyHttpUsage(request, response, { ...usage, cacheHit: 26 })).toThrow("ledger");
  });
  it("does not interpret absent cache usage as zero", () => {
    const raw = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 4 } });
    expect(() => verifyHttpUsage(request, { raw, rawHash: createHash("sha256").update(raw).digest("hex") }, usage)).toThrow("missing");
  });
  it("separates paid miss, hit and output from a cache sensitivity bound", () => {
    const result = attributeTokenCost(usage, STEP_E2_BUDGET.prices!.flash!);
    expect(result.totalNanoCny).toBe(309040);
    expect(result.allInputCachedSensitivityNanoCny).toBe(53440);
  });
  it("does not add overlapping calls to infer wall time", () => {
    const at = (seconds: number) => new Date(seconds * 1000).toISOString();
    expect(httpConcurrency([{ startedAt: at(0), completedAt: at(10) },
      { startedAt: at(5), completedAt: at(15) }, { startedAt: at(20), completedAt: at(22) }])).toEqual({
      peak: 2, occupiedMs: 17000, durationSumMs: 22000, firstToLastMs: 22000,
    });
  });
  it("attributes both actual gateway repair layouts without changing the original context", () => {
    const context = { state: { action: "Keep complete meaning" }, batchRepair: { expectedSlots: [0], issues: [{ message: "Invalid JSON" }], previousOutput: "{broken" } };
    for (const placement of [undefined, "tail-v1"] as const) {
      const layout = repairPromptLayout(`Task\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`, JSON.stringify(context), placement);
      const rendered = { userMessage: composeJsonObjectPrompt({ userPrompt: layout.userPrompt, contextJson: layout.contextJson,
        schemaJson: JSON.stringify(z.toJSONSchema(z.object({ slots: z.array(z.unknown()) }))), discriminator: "Return the selected directive" }) + layout.tail };
      const actualContext = recordedContext(rendered.userMessage).value;
      expect(recordedPhysicalRepair(rendered.userMessage, actualContext)).toEqual({ physicalRepair: true,
        physicalRepairPlacement: placement ? "tail" : "context" });
      expect(Boolean(actualContext.batchRepair)).toBe(!placement);
    }
  });
  it("ignores notices in action data and refuses corrupt or contradictory repair suffixes", () => {
    const rendered = { userMessage: composeJsonObjectPrompt({ userPrompt: "Task", contextJson: JSON.stringify({ action: PHYSICAL_BATCH_REPAIR_NOTICE }),
      schemaJson: "{}", discriminator: "Return JSON" }) };
    expect(recordedPhysicalRepair(rendered.userMessage, recordedContext(rendered.userMessage).value).physicalRepair).toBe(false);
    const prefix = `${rendered.userMessage}\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}\n\n`;
    expect(() => recordedPhysicalRepair(prefix + "{broken", {})).toThrow();
    expect(() => recordedPhysicalRepair(prefix + '{"other":{}}', {})).toThrow("envelope");
    expect(() => recordedPhysicalRepair(prefix + '{"batchRepair":{}}', { batchRepair: { changed: true } })).toThrow("disagree");
  });
});
