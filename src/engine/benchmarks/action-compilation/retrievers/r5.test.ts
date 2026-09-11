import { describe, expect, it } from "vitest";
import type { ActionCompilationReferenceDataset } from "../stabilized-behavior";
import { createR5ActionCompilationSlotRetriever, r5RelationalPassagesForContext } from "./r5";

function context(): Record<string, unknown> {
  return {
    referenceCatalog: {
      hash: "r5-relational-fixture",
      candidates: [
        {
          candidateKey: "candidate_000000000001",
          kind: "entity",
          label: "沼泽",
          meaning: "地点",
          allowedUses: ["target", "subject"],
          scope: { kind: "shared" },
        },
        {
          candidateKey: "candidate_000000000002",
          kind: "quantity",
          label: "补给",
          meaning: "existing quantity state",
          allowedUses: ["assertion", "conflict"],
          scope: { kind: "shared" },
          details: {
            amount: 7,
            definitionId: "provisions",
            holderRef: "candidate_000000000001",
          },
        },
      ],
    },
  };
}

describe("R5 candidate retrieval experiment", () => {
  it("renders details and resolves opaque references in relational passages", () => {
    const passage = r5RelationalPassagesForContext(context())
      .find((entry) => entry.candidateKey === "candidate_000000000002")?.passage;

    expect(passage).toContain("details.amount: 7");
    expect(passage).toContain("details.definitionId: provisions");
    expect(passage).toContain("details.holderRef: [entity] 沼泽 — 地点");
    expect(passage).toContain("entity-quantity: [entity] 沼泽");
    expect(passage).not.toContain("candidate_000000000001");
  });

  it("expands one hop from lexical pseudo-seeds", async () => {
    const contextHash = "c".repeat(64);
    const candidates = [
      {
        candidateKey: "candidate_000000000001",
        kind: "action",
        label: "调查",
        meaning: "action",
        allowedUses: ["cause"],
        scope: { kind: "shared" },
      },
      {
        candidateKey: "candidate_000000000002",
        kind: "entity",
        label: "beacon",
        meaning: "signal tower",
        allowedUses: ["target"],
        scope: { kind: "shared" },
      },
      {
        candidateKey: "candidate_000000000003",
        kind: "quantity",
        label: "opaque supply",
        meaning: "existing quantity state",
        allowedUses: ["assertion"],
        scope: { kind: "shared" },
        details: { holderRef: "candidate_000000000002", amount: 4 },
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        candidateKey: `candidate_${(index + 4).toString(16).padStart(12, "0")}`,
        kind: "entity",
        label: `unrelated ${index}`,
        meaning: "background entity",
        allowedUses: ["target"],
        scope: { kind: "shared" },
      })),
    ];
    const benchmarkContext = {
      referenceCatalog: { hash: "r5-expansion-fixture", candidates },
      task: {
        slots: [{
          slot: 0,
          action: { rawText: "inspect the beacon" },
          actionReferences: { actionCandidateKey: "candidate_000000000001" },
        }],
      },
    };
    const dataset = {
      root: ".",
      manifest: { datasetId: "fixture", version: 1 } as ActionCompilationReferenceDataset["manifest"],
      contexts: new Map([[contextHash, { contextHash, context: benchmarkContext }]]),
      cases: [{
        caseId: "fixture-case",
        contextHash,
        slotIndex: 0,
        batchSize: 1,
        requiredCandidateKeys: [],
        source: { catalogHash: "r5-expansion-fixture", worldHash: "world", algorithmManifestHash: "algorithm" },
      }],
    } satisfies ActionCompilationReferenceDataset;
    const encoder = {
      modelId: "fixture",
      modelHash: "sha256:fixture",
      dimensions: 1,
      async encodeBatch(texts: readonly string[]) {
        return texts.map(() => [0]);
      },
    };
    const baseline = await createR5ActionCompilationSlotRetriever(dataset, {
      stage: "relational-passage",
      encoder,
      pseudoSeedCount: 1,
    });
    const expanded = await createR5ActionCompilationSlotRetriever(dataset, {
      stage: "multi-seed-expand",
      encoder,
      pseudoSeedCount: 1,
    });
    const input = { worldContentHash: "world", context: benchmarkContext, slotIndex: 0 };
    const baselineKeys = (await baseline(input)).candidates.map((candidate) => candidate.candidateKey);
    const expandedKeys = (await expanded(input)).candidates.map((candidate) => candidate.candidateKey);

    expect(expandedKeys.indexOf("candidate_000000000003"))
      .toBeLessThan(baselineKeys.indexOf("candidate_000000000003"));
  });
});
