import { expect, it } from "vitest";
import { contentHash } from "../../models/model-audit";
import { factorSharedBatchContexts, expandSharedBatchContexts } from "../shared-batch-context";
import { compactSharedCatalogPrefix, expandSharedCatalogPrefix } from "../shared-catalog-prefix";

function source(orders = [["a", "b", "x"], ["a", "b", "y", "z"]]) {
  return factorSharedBatchContexts(orders.map((order, slot) => ({ slot,
    referenceCatalog: { candidates: order.map(handle => ({ handle, allowedUses: ["assertion"], description: `${handle} meaning` })) },
    state: { literal: { catalogOrderPrefix: "unchanged data" } } })), "shared-json-v3");
}

it.each([
  [["a", "b", "x"], ["a", "b", "y", "z"]],
  [["a", "b"], ["a"]], [["a", "b"], ["a", "b"]], [["a", "b"], ["b", "a"]], [[], []],
].map(orders => ({ orders })))("restores exact candidates, rank, membership and all logical hashes for $orders", ({ orders }) => {
  const original = source(orders), before = contentHash(original), compact = compactSharedCatalogPrefix(original);
  expect(expandSharedCatalogPrefix(compact)).toEqual(original);
  expect(expandSharedBatchContexts(expandSharedCatalogPrefix(compact))).toEqual(expandSharedBatchContexts(original));
  expect(contentHash(original)).toBe(before);
  expect(() => compactSharedCatalogPrefix(compact)).toThrow();
});

it("rejects altered, duplicated, missing or foreign references and noncanonical split points", () => {
  const compact = compactSharedCatalogPrefix(source());
  expect(compact.catalogOrderPrefix).toEqual(["a", "b"]);
  for (const prefix of [["a", "x"], ["a", "a"], ["a"], ["unknown", "b"], [null]]) {
    expect(() => expandSharedCatalogPrefix({ ...compact, catalogOrderPrefix: prefix })).toThrow();
  }
  expect(() => expandSharedCatalogPrefix({ ...compact, catalogOrderSuffixes: { o0: ["x"] } })).toThrow();
  expect(() => expandSharedCatalogPrefix({ ...compact, catalogOrders: {} })).toThrow();
  expect(() => expandSharedCatalogPrefix({ ...compact, catalogOrderPrefix: ["a"], catalogOrderSuffixes: { o0: ["b", "x"], o1: ["b", "y", "z"] } })).toThrow();
});
