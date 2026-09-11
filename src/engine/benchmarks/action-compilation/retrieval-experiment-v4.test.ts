import { describe, expect, it } from "vitest";
import type { ActionCompilationReferenceDataset } from "./stabilized-behavior";
import { evaluateActionCompilationRetrievalV4, evaluateFullCatalogControlV4 } from "./retrieval-experiment-v4";

function dataset(): ActionCompilationReferenceDataset {
  const candidates = Array.from({ length: 10 }, (_, index) => ({
    candidateKey: `candidate_${(index + 1).toString(16).padStart(12, "0")}`,
    scope: { kind: "shared" },
  }));
  return {
    root: "/fixture",
    manifest: { datasetId: "fixture", version: 1 } as ActionCompilationReferenceDataset["manifest"],
    contexts: new Map([["context", { contextHash: "context", context: { referenceCatalog: { candidates } } }]]),
    cases: [{
      caseId: "case-1",
      contextHash: "context",
      slotIndex: 0,
      batchSize: 1,
      requiredCandidateKeys: ["candidate_000000000001"],
      source: { catalogHash: "catalog", worldHash: `sha256:${"1".repeat(64)}`, algorithmManifestHash: "algorithm" },
    }],
  };
}

describe("retrieval v4 evaluation", () => {
  it("measures physical batch compression and keeps FullCatalog as a control", async () => {
    const fixture = dataset();
    const report = await evaluateActionCompilationRetrievalV4({
      dataset: fixture,
      algorithm: "fixture-runtime",
      runtime: {
        version: "fixture",
        role: "candidate-selection",
        async retrieveBatch() {
          return {
            modelContext: {},
            selectedKeysBySlot: new Map([[0, ["candidate_000000000001"]]]),
            fullContextHash: "full",
            modelContextHash: "model",
            shortlistHash: "shortlist",
            diagnostics: {
              selectedCount: 1,
              visibleCount: 10,
              batchBudget: 1,
              batchShortlistRatio: 0.1,
              prunedReferenceCount: 0,
              anchorCount: 1,
              budgetExceeded: false,
              perSlotSelectedCount: { "0": 1 },
              cache: {
                passageHits: 10,
                passageMisses: 0,
                queryHits: 0,
                queryMisses: 1,
                readMs: 1,
                passageEncodeMs: 0,
                queryEncodeMs: 2,
                queryBatchSize: 1,
              },
            },
          };
        },
      },
    });
    expect(report).toMatchObject({ microRecall: 1, macroRecall: 1, averageBatchCompression: 0.9, p95BatchShortlistRatio: 0.1, deterministic: true, hardGate: true });
    expect(evaluateFullCatalogControlV4(fixture)).toMatchObject({ microRecall: 1, macroRecall: 1, averageBatchCompression: 0, p95BatchShortlistRatio: 1 });
  });
});
