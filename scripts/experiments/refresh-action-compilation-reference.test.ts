import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ALGORITHM_REF } from "../../src/engine/algorithms/registry";
import {
  allVisibleCandidateRetriever,
  evaluateActionCompilationRecall,
  loadActionCompilationReferenceDataset,
} from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";
import {
  mergeActionCompilationReferenceData,
  publishActionCompilationReferenceData,
} from "../../src/engine/benchmarks/action-compilation/reference-refresh";
import type { RawBenchmarkSource, RegeneratedActionCompilationReference } from "../../src/engine/benchmarks/source-capture";
import { contentHash } from "../../src/engine/models/model-audit";

function fixture() {
  const base = loadActionCompilationReferenceDataset("benchmarks/action-compilation/fullcatalog-stabilized/v1");
  const baseCase = base.cases[0]!;
  const context = structuredClone(base.contexts.get(baseCase.contextHash)!.context);
  context.refreshFixture = "new-context";
  const fullContextHash = contentHash(context);
  const stateSnapshot = { fixture: true };
  const source: RawBenchmarkSource = {
    schemaVersion: 2,
    sourceExecutionId: "execution-r5",
    sourceInvocationId: "invocation-r5",
    role: "action-compilation",
    slotIndices: [baseCase.slotIndex],
    fullContext: context,
    stateSnapshot,
    stateHash: contentHash(stateSnapshot),
    actions: [{ id: "action-r5", actorId: "agent-r5", baseRevision: 0, rawText: "act", goal: "act", means: null, targetIds: [] }],
    actionIds: ["action-r5"],
    fullContextHash,
    captureAlgorithmRef: DEFAULT_ALGORITHM_REF,
    captureAlgorithmManifestHash: DEFAULT_ALGORITHM_REF.manifestHash,
    worldHash: base.manifest.source.worldHash,
    candidateCatalogHash: String((context.referenceCatalog as { hash: string }).hash),
    modelCatalogHash: base.manifest.source.modelCatalogHash,
    registrySnapshotHash: base.manifest.source.registrySnapshotHash,
    modelId: base.manifest.source.modelId,
    promptVersion: base.manifest.source.promptVersion,
    profileId: base.manifest.source.profileId,
    projectorVersion: base.manifest.source.candidateKeyVersion.split("@")[0]!,
    candidateKeyVersion: 2,
    candidateKeyPayloadLength: 12,
    symbolRepairPolicyVersion: base.manifest.source.symbolRepairPolicyVersion,
  };
  const reference: RegeneratedActionCompilationReference = {
    fullContextHash,
    providerRequests: 1,
    fullyValidated: true,
    slots: [{
      slotIndex: baseCase.slotIndex,
      requiredCandidateKeys: baseCase.requiredCandidateKeys,
      repairCount: 0,
      rawOutputHash: "a".repeat(64),
      normalizedOutputHash: "b".repeat(64),
    }],
  };
  return { base, source, reference };
}

describe("Action Compilation reference refresh", () => {
  it("keeps base-v1 immutable and adds a separately stratified R5 label", () => {
    const { base, source, reference } = fixture();
    const merged = mergeActionCompilationReferenceData({
      base,
      sources: [source],
      references: [reference],
      version: 2,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
    });
    expect(base.cases).toHaveLength(46);
    expect(merged.cases).toHaveLength(47);
    expect(merged.cases.filter((item) => item.stratum === "base-v1")).toHaveLength(46);
    expect(merged.cases.filter((item) => item.stratum === "r5-captured")).toHaveLength(1);
    expect(merged.manifest.source).toMatchObject({
      captureAlgorithmManifestHash: source.captureAlgorithmManifestHash,
      referenceAlgorithmManifestHash: expect.any(String),
    });
  });

  it("rejects conflicting FullCatalog labels for contextHash + slotIndex", () => {
    const { base, source, reference } = fixture();
    source.fullContext = structuredClone(base.contexts.get(base.cases[0]!.contextHash)!.context);
    source.fullContextHash = base.cases[0]!.contextHash;
    reference.fullContextHash = source.fullContextHash;
    reference.slots[0]!.requiredCandidateKeys = [];
    expect(() => mergeActionCompilationReferenceData({
      base,
      sources: [source],
      references: [reference],
      version: 2,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
    })).toThrow(/conflicting FullCatalog labels/u);
  });

  it("verifies staging before atomic publication and cleans failed staging", () => {
    const { base, source, reference } = fixture();
    const refreshed = mergeActionCompilationReferenceData({
      base,
      sources: [source],
      references: [reference],
      version: 2,
      startedAt: "2026-09-05T00:00:00.000Z",
      completedAt: "2026-09-05T00:01:00.000Z",
    });
    const root = mkdtempSync(path.join(os.tmpdir(), "lwe-reference-refresh-"));
    try {
      const target = path.join(root, "v2");
      const published = publishActionCompilationReferenceData(refreshed, target);
      expect(published.cases).toHaveLength(47);
      expect(evaluateActionCompilationRecall(published, allVisibleCandidateRetriever).byStratum).toMatchObject({
        "base-v1": { cases: 46, microRecall: 1, macroRecall: 1 },
        "r5-captured": { cases: 1, microRecall: 1, macroRecall: 1 },
      });
      const invalid = structuredClone(refreshed);
      invalid.manifest.version = 3;
      expect(() => publishActionCompilationReferenceData(invalid, path.join(root, "v3"))).toThrow(/case IDs/u);
      expect(readdirSync(root).filter((name) => name.includes("staging"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
