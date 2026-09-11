import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { serializeModelContext } from "../../prompts/context-layout";
import { expandSharedBatchContexts, factorSharedBatchContexts } from "../shared-batch-context";
import { compactSharedCatalogPrefix, expandSharedCatalogPrefix } from "../shared-catalog-prefix";
import { compactSharedCatalogRecords, expandSharedCatalogRecords } from "../shared-catalog-records";

function source() {
  return compactSharedCatalogPrefix(factorSharedBatchContexts([0, 1].map(slot => ({
    state: { unchanged: { value: null } },
    referenceCatalog: { candidates: [
      { handle: "ref:fact:a", label: "A", allowedUses: ["assertion"], meaning: "Original meaning", statePath: null },
      { handle: "ref:fact:b", label: "B", allowedUses: ["assertion"], meaning: "Original meaning" },
      { handle: "ref:fact:scoped", allowedUses: slot ? ["assertion"] : ["assertion", "cause"], extra: { retained: [2, 1] } },
      { handle: `ref:action:${slot}`, allowedUses: ["cause"] },
    ] },
  })), "shared-json-v3"));
}

it("restores original fields, absent values, slot scopes and candidate order with unchanged source hashes", () => {
  const original = source(), before = contentHash(original), compact = compactSharedCatalogRecords(original);
  expect(compact.codec).toBe("shared-json-v3-catalog-v1");
  const restored = expandSharedCatalogRecords(compact);
  expect(restored).toEqual(original);
  expect(expandSharedBatchContexts(expandSharedCatalogPrefix(restored))).toEqual(expandSharedBatchContexts(expandSharedCatalogPrefix(original)));
  expect(contentHash(original)).toBe(before);
  expect(JSON.parse(serializeModelContext({ state: compact }, "shared-state-first-v1"))).toEqual({ state: compact });
  const reordered = structuredClone(original) as { shared: { referenceCatalog: { candidates: Record<string, unknown> } } };
  reordered.shared.referenceCatalog.candidates = Object.fromEntries(Object.entries(reordered.shared.referenceCatalog.candidates).reverse());
  expect(contentHash(compactSharedCatalogRecords(reordered))).toBe(contentHash(compact));
});

it("rejects changed permissions, missing rows, invented variable fields and noncanonical templates", () => {
  const compact = compactSharedCatalogRecords(source());
  type Table = { templates: Record<string, unknown>[]; rows: Record<string, [number, Record<string, unknown>]> };
  const tableOf = (value: unknown) => (value as { shared: { referenceCatalog: { candidates: Table } } }).shared.referenceCatalog.candidates;
  for (const mutate of [
    (table: Table) => { table.templates[0]!.allowedUses = ["actor"]; },
    (table: Table) => { delete table.rows["ref:fact:a"]; },
    (table: Table) => { table.rows["ref:fact:a"]![0] = 999; },
    (table: Table) => { table.rows["ref:fact:a"]![0] = 0.5; },
    (table: Table) => { table.rows["ref:fact:a"]![1].meaning = "Invented meaning"; },
    (table: Table) => { table.rows["ref:fact:a"]![1].label = "Changed label"; },
    (table: Table) => { table.templates.push(structuredClone(table.templates[0]!)); },
    (table: Table) => { table.templates[0]!.handle = "foreign"; },
  ]) {
    const changed = structuredClone(compact); mutate(tableOf(changed));
    expect(() => expandSharedCatalogRecords(changed)).toThrow();
  }
  expect(() => compactSharedCatalogRecords(compact)).toThrow();
  expect(() => expandSharedCatalogRecords(source())).toThrow();
});

it("preserves empty shared catalogs and contexts without a shared candidate map", () => {
  for (const referenceCatalog of [undefined, { candidates: [] }]) {
    const original = compactSharedCatalogPrefix(factorSharedBatchContexts([0, 1].map(slot => ({ slot,
      state: { unchanged: true }, ...(referenceCatalog ? { referenceCatalog } : {}) })), "shared-json-v3"));
    expect(expandSharedCatalogRecords(compactSharedCatalogRecords(original))).toEqual(original);
  }
});
