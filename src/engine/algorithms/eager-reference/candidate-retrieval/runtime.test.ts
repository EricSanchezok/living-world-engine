import { describe, expect, it } from "vitest";
import { contentHash } from "../../../models/model-audit";
import { createRuntimeGraphSlotRetriever } from "./graph-aware";
import { createCoverageAwareJointBudgetSelector } from "./coverage-aware-joint-budget";
import type { PassageEmbeddingEncoder } from "./embedding-cache";
import { CachedQueryEncoder, type LocalEncoderRuntime } from "./local-encoder";
import { createRelationalRrfPhysicalBatchRetriever } from "./relational-rrf";
import { createActionCompilationRetrievalRuntime } from "./runtime";

function context(): Record<string, unknown> {
  return {
    referenceCatalog: {
      hash: "runtime-fixture",
      candidates: Array.from({ length: 20 }, (_, index) => ({
        candidateKey: `candidate_${(index + 1).toString(16).padStart(12, "0")}`,
        kind: index === 0 ? "action" : "entity",
        label: `candidate ${index + 1}`,
        allowedUses: index === 0 ? ["cause"] : ["target"],
        scope: index === 19 ? { kind: "slot", slot: 1 } : { kind: "shared" },
        ...(index === 0 ? { details: { targetRef: "candidate_000000000002", hiddenRef: "candidate_000000000014" } } : {}),
      })),
    },
    task: {
      slots: [
        { slot: 0, actionReferences: { actionCandidateKey: "candidate_000000000001", targets: [{ status: "unique", candidateKeys: ["candidate_000000000002"] }] } },
        { slot: 1, actionReferences: { actionCandidateKey: "candidate_000000000003", targets: [{ status: "unique", candidateKeys: ["candidate_000000000004"] }] } },
      ],
    },
  };
}

describe("Action Compilation retrieval runtime", () => {
  it("enforces one physical batch budget and preserves per-slot membership", async () => {
    const full = context();
    const before = contentHash(full);
    const runtime = createActionCompilationRetrievalRuntime({
      version: "retrieval-v4-test",
      retrieveSlot: async ({ slotIndex }) => ({
        candidates: slotIndex === 0
          ? [
              { candidateKey: "candidate_000000000001", score: 100 },
              { candidateKey: "candidate_000000000002", score: 90 },
              { candidateKey: "candidate_000000000005", score: 20 },
            ]
          : [
              { candidateKey: "candidate_000000000003", score: 100 },
              { candidateKey: "candidate_000000000004", score: 90 },
              { candidateKey: "candidate_000000000006", score: 30 },
            ],
      }),
    });
    const both = await runtime.retrieveBatch({ worldContentHash: `sha256:${"1".repeat(64)}`, fullContext: full, slotIndices: [0, 1] });
    expect(both.diagnostics).toMatchObject({ batchBudget: 4, nominalBatchBudget: 3,
      mandatoryBudgetFloorApplied: true, selectedCount: 4, budgetExceeded: false });
    expect(both.selectedKeysBySlot.get(0)).toEqual(["candidate_000000000001", "candidate_000000000002"]);
    expect(both.selectedKeysBySlot.get(1)).toEqual(["candidate_000000000003", "candidate_000000000004"]);

    const oneSlot = await runtime.retrieveBatch({ worldContentHash: `sha256:${"1".repeat(64)}`, fullContext: full, slotIndices: [0] });
    expect(contentHash(full)).toBe(before);
    expect(oneSlot.diagnostics.batchBudget).toBe(3);
    expect(oneSlot.diagnostics.mandatoryBudgetFloorApplied).toBe(false);
    expect(oneSlot.diagnostics.batchShortlistRatio).toBeLessThan(0.2);
    expect(oneSlot.selectedKeysBySlot.get(0)).toEqual([
      "candidate_000000000001",
      "candidate_000000000002",
      "candidate_000000000005",
    ]);
    expect((oneSlot.modelContext.referenceCatalog as { candidates: unknown[] }).candidates).toHaveLength(3);
    expect(oneSlot.diagnostics.prunedReferenceCount).toBe(0);
    expect(oneSlot.modelContext.referenceEvidence).toMatchObject({ sourceContextHash: before, entries: [
      { stateReference: "snapshot_000000000014", label: "candidate 20", scope: { kind: "slot", slot: 1 } },
    ] });
    const projected = (oneSlot.modelContext.referenceCatalog as { candidates: Array<{ details?: unknown }> }).candidates;
    expect(projected[0]!.details).toEqual({ targetRef: "candidate_000000000002", hiddenRef: { stateReference: "snapshot_000000000014" } });
  });

  it("rejects private, duplicate, invalid, and missing-anchor output", async () => {
    const invoke = (keys: readonly string[]) => createActionCompilationRetrievalRuntime({
      version: "test",
      retrieveSlot: async () => ({ candidates: keys.map((candidateKey, score) => ({ candidateKey, score })) }),
    }).retrieveBatch({ worldContentHash: `sha256:${"1".repeat(64)}`, fullContext: context(), slotIndices: [0] });
    await expect(invoke(["candidate_000000000001", "candidate_000000000014"])).rejects.toThrow(/private/u);
    await expect(invoke(["candidate_000000000001", "candidate_000000000001"])).rejects.toThrow(/duplicate/u);
    await expect(invoke(["candidate_000000000002"])).rejects.toThrow(/anchor missing/u);
  });

  it("validates replaceable physical-batch selection policies", async () => {
    const retrieveSlot = async () => ({
      candidates: [
        { candidateKey: "candidate_000000000001", score: 100 },
        { candidateKey: "candidate_000000000002", score: 90 },
        { candidateKey: "candidate_000000000005", score: 80 },
      ],
    });
    const accepted = createActionCompilationRetrievalRuntime({
      version: "custom-batch-selector",
      retrieveSlot,
      selectBatch: ({ mandatoryKeys }) => [...mandatoryKeys, "candidate_000000000005"],
    });
    const result = await accepted.retrieveBatch({
      worldContentHash: `sha256:${"1".repeat(64)}`,
      fullContext: context(),
      slotIndices: [0],
    });
    expect(result.selectedKeysBySlot.get(0)).toEqual([
      "candidate_000000000001",
      "candidate_000000000002",
      "candidate_000000000005",
    ]);

    const rejected = createActionCompilationRetrievalRuntime({
      version: "invalid-batch-selector",
      retrieveSlot,
      selectBatch: () => ["candidate_000000000005"],
    });
    await expect(rejected.retrieveBatch({
      worldContentHash: `sha256:${"1".repeat(64)}`,
      fullContext: context(),
      slotIndices: [0],
    })).rejects.toThrow(/dropped mandatory keys/u);
  });

  it("uses persistent passages with a dynamic process-cached query", async () => {
    let queryCalls = 0;
    let passageCalls = 0;
    const encoder: LocalEncoderRuntime = {
      modelId: "fixture",
      modelHash: `sha256:${"2".repeat(64)}`,
      dimensions: 2,
      async encodeBatch(texts) {
        queryCalls += 1;
        return texts.map((text) => [text.includes("candidate") ? 1 : 0, 1]);
      },
    };
    const passageEncoder: PassageEmbeddingEncoder = {
      encoder,
      encoderFingerprint: `sha256:${"3".repeat(64)}`,
      async encodePassages(input) {
        passageCalls += 1;
        expect(input.allowWrite).toBe(false);
        return { vectors: input.passages.map(() => [1, 0]), hits: input.passages.length, misses: 0, written: 0 };
      },
      close() {},
    };
    const runtime = createActionCompilationRetrievalRuntime({
      version: "runtime-graph-test",
      retrieveSlot: createRuntimeGraphSlotRetriever({ strategy: "graph-hybrid", encoder, passageEncoder }),
    });
    const input = { worldContentHash: `sha256:${"4".repeat(64)}`, fullContext: context(), slotIndices: [0] };
    const first = await runtime.retrieveBatch(input);
    const second = await runtime.retrieveBatch(input);
    expect(first.diagnostics.cache.passageMisses).toBe(0);
    expect(first.diagnostics.cache.queryMisses).toBe(1);
    expect(second.diagnostics.cache.queryHits).toBe(1);
    expect(passageCalls).toBe(2);
    expect(queryCalls).toBe(1);
  });

  it("ranks a physical batch with one passage read and one deduplicated query batch", async () => {
    const full = context();
    const catalog = full.referenceCatalog as { candidates: Array<Record<string, unknown>> };
    catalog.candidates.push(...Array.from({ length: 5 }, (_, index) => ({
      candidateKey: `candidate_${(index + 21).toString(16).padStart(12, "0")}`,
      kind: "entity",
      label: `extra ${index}`,
      meaning: "background",
      allowedUses: ["target"],
      scope: { kind: "shared" },
    })));
    let queryCalls = 0;
    let passageCalls = 0;
    const encoder: LocalEncoderRuntime = {
      modelId: "fixture",
      modelHash: `sha256:${"5".repeat(64)}`,
      dimensions: 2,
      async encodeBatch(texts) {
        queryCalls += 1;
        return texts.map((text) => [text.length / 100, 1]);
      },
    };
    const passageEncoder: PassageEmbeddingEncoder = {
      encoder,
      encoderFingerprint: `sha256:${"6".repeat(64)}`,
      async encodePassages(input) {
        passageCalls += 1;
        expect(input.allowWrite).toBe(true);
        return {
          vectors: input.passages.map(() => [1, 0]),
          hits: input.passages.length,
          misses: 0,
          written: 0,
          readMs: 2,
          encodeMs: 0,
        };
      },
      close() {},
    };
    const queryEncoder = new CachedQueryEncoder(encoder);
    const runtime = createActionCompilationRetrievalRuntime({
      version: "relational-rrf-v1-test",
      selectBatch: createCoverageAwareJointBudgetSelector({ compactKindBudgetRatio: 0.15 }),
      retrievePhysicalBatch: createRelationalRrfPhysicalBatchRetriever({
        encoder,
        passageEncoder,
        queryEncoder,
        maxPathDepth: 3,
        pseudoSeedCount: 16,
      }),
    });
    const input = {
      worldContentHash: `sha256:${"7".repeat(64)}`,
      fullContext: full,
      slotIndices: [0, 1],
    };
    const first = await runtime.retrieveBatch(input);
    const second = await runtime.retrieveBatch(input);

    expect(first.diagnostics.batchBudget).toBe(4);
    expect(first.diagnostics.batchShortlistRatio).toBeLessThan(0.2);
    expect(first.diagnostics.cache.queryBatchSize).toBeGreaterThan(1);
    expect(first.diagnostics.cache.queryMisses).toBe(first.diagnostics.cache.queryBatchSize);
    expect(second.diagnostics.cache.queryHits).toBe(second.diagnostics.cache.queryBatchSize);
    expect(second.diagnostics.cache.queryMisses).toBe(0);
    expect(passageCalls).toBe(2);
    expect(queryCalls).toBe(1);
  });

  it("fails an oversized physical query batch before encoding", async () => {
    const full = context();
    (full.task as { slots: unknown[] }).slots = Array.from({ length: 13 }, (_, slot) => ({
      slot,
      action: { rawText: `unique action ${slot}` },
    }));
    let encoderCalls = 0;
    let passageCalls = 0;
    const encoder: LocalEncoderRuntime = {
      modelId: "fixture",
      modelHash: `sha256:${"8".repeat(64)}`,
      dimensions: 2,
      async encodeBatch(texts) {
        encoderCalls += 1;
        return texts.map(() => [1, 0]);
      },
    };
    const passageEncoder: PassageEmbeddingEncoder = {
      encoder,
      encoderFingerprint: `sha256:${"9".repeat(64)}`,
      async encodePassages(input) {
        passageCalls += 1;
        return { vectors: input.passages.map(() => [1, 0]), hits: 0, misses: input.passages.length, written: 0 };
      },
      close() {},
    };
    const retrieve = createRelationalRrfPhysicalBatchRetriever({ encoder, passageEncoder });

    await expect(retrieve({
      worldContentHash: `sha256:${"a".repeat(64)}`,
      context: full,
      slotIndices: Array.from({ length: 13 }, (_, index) => index),
    })).rejects.toThrow(/query batch exceeds 60: 65/u);
    expect(passageCalls).toBe(0);
    expect(encoderCalls).toBe(0);
  });
});
