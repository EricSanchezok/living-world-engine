import { describe, expect, it } from "vitest";
import { DEFAULT_ALGORITHM_REF, FULL_CATALOG_ALGORITHM_REF } from "../../src/engine/algorithms/registry";
import { algorithmManifest } from "../../src/engine/runtime/execution";
import { executionUsesFullCatalog } from "./export-action-compilation-reference";

describe("direct Action Compilation reference export guard", () => {
  it("accepts only an execution whose pinned Composition is FullCatalog", () => {
    const fullCatalog = algorithmManifest(FULL_CATALOG_ALGORITHM_REF);
    expect(executionUsesFullCatalog(fullCatalog)).toBe(true);
    expect(executionUsesFullCatalog(algorithmManifest(DEFAULT_ALGORITHM_REF))).toBe(false);
    const forged = structuredClone(fullCatalog);
    forged.children.actionCompilation!.children.candidateSelection!.manifestHash = "forged-full-catalog";
    expect(executionUsesFullCatalog(forged)).toBe(false);
  });
});
