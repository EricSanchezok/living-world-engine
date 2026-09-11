import { expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { factorSharedBatchContexts, expandSharedBatchContexts, SHARED_BATCH_ORDER_CODEC } from "../mechanics/shared-batch-context";
import { structuredPromptBytes } from "./index";
import { repairPromptLayout, PHYSICAL_BATCH_REPAIR_NOTICE } from "./repair-layout";
import { serializeModelContext, SHARED_STATE_FIRST_LAYOUT } from "./context-layout";

const context = (hash: string) => ({ referenceCatalog: { hash, candidates: [] }, state: factorSharedBatchContexts([0, 1].map(slot => ({
  referenceCatalog: { hash, candidates: [{ handle: "ref:entity:a", meaning: "同一角色" }] },
  state: { canonicalTruth: { fact: "same immutable state", values: [false, 0, null, "braces } ] and quotes \""] } },
  task: { slot },
})), SHARED_BATCH_ORDER_CODEC), task: { slots: [0, 1] }, repair: null });
const commonPrefix = (a: string, b: string) => { let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++; return i; };

it("preserves exact contexts and slot expansion while moving stable content before varying hashes", () => {
  const a = context("first"), b = context("second");
  const before = contentHash(a);
  const rendered = serializeModelContext(a, SHARED_STATE_FIRST_LAYOUT);
  const restored = JSON.parse(rendered);
  expect(restored).toEqual(a);
  expect(contentHash(a)).toBe(before);
  expect(expandSharedBatchContexts(restored.state)).toEqual(expandSharedBatchContexts(a.state));
  expect(Object.keys(restored)[0]).toBe("state");
  expect(Object.keys(restored.state)[0]).toBe("shared");
  expect(Object.keys(restored.state.shared).slice(0, 2)).toEqual(["state", "referenceCatalog"]);
  expect(commonPrefix(rendered, serializeModelContext(b, SHARED_STATE_FIRST_LAYOUT))).toBeGreaterThan(commonPrefix(serializeModelContext(a), serializeModelContext(b)));
  expect(Buffer.byteLength(rendered)).toBe(Buffer.byteLength(serializeModelContext(a)));
});

it("composes with repair-tail rendering without losing the original ordered prefix or any feedback", () => {
  const initial = context("same");
  const feedback = { issues: [{ code: "invalid_union", path: ["slots", 1] }], previousOutput: { literal: "original" } };
  const first = structuredPromptBytes({ system: "system", userPrompt: "task", context: initial, schema: z.object({}), contextLayout: SHARED_STATE_FIRST_LAYOUT });
  const repaired = structuredPromptBytes({ system: "system", userPrompt: `task\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`,
    context: { ...initial, batchRepair: feedback }, schema: z.object({}), contextLayout: SHARED_STATE_FIRST_LAYOUT, repairContextPlacement: "tail-v1" });
  const layout = repairPromptLayout(`task\n\n${PHYSICAL_BATCH_REPAIR_NOTICE}`, repaired.contextJson, "tail-v1");
  expect(layout.contextJson).toBe(first.contextJson);
  expect(repaired.userMessage.startsWith(first.userMessage)).toBe(true);
  expect(JSON.parse(layout.tail.split("\n\n").at(-1)!)).toEqual({ batchRepair: feedback });
});

it("fails before rendering when a selected layout lacks its required shared structure", () => {
  for (const bad of [null, {}, { state: {} }, { state: { codec: "unknown", shared: { state: {} } } }]) {
    expect(() => serializeModelContext(bad, SHARED_STATE_FIRST_LAYOUT)).toThrow("complete shared context");
  }
  expect(serializeModelContext({ z: 0, a: false })).toBe('{"a":false,"z":0}');
});
