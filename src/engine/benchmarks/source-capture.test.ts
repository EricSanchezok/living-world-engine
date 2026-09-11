import { describe, expect, it } from "vitest";
import { RecordingRuntimeObserver } from "../runtime/observability";
import { contentHash } from "../models/model-audit";
import {
  assertSafeBenchmarkSource,
  emitActionCompilationFullContextCapture,
  readActionCompilationCapturedSources,
} from "./source-capture";
import { DEFAULT_ALGORITHM_REF } from "../algorithms/registry";

function completeSource(fullContext: Record<string, unknown>) {
  const stateSnapshot = { worldId: "world", revision: 0 };
  return {
    schemaVersion: 2 as const,
    sourceExecutionId: "execution-1",
    sourceInvocationId: "invocation-1",
    role: "action-compilation",
    slotIndices: [0],
    fullContext,
    stateSnapshot,
    stateHash: contentHash(stateSnapshot),
    actions: [{
      id: "action-1",
      actorId: "agent-1",
      baseRevision: 0,
      rawText: "wait",
      goal: "wait",
      means: null,
      targetIds: [],
    }],
    actionIds: ["action-1"],
    captureAlgorithmRef: DEFAULT_ALGORITHM_REF,
    captureAlgorithmManifestHash: DEFAULT_ALGORITHM_REF.manifestHash,
    worldHash: "world-hash",
    candidateCatalogHash: "candidate-catalog-hash",
    modelCatalogHash: "model-catalog-hash",
    registrySnapshotHash: "registry-snapshot-hash",
    modelId: "model-id",
    promptVersion: "prompt-version",
    profileId: "profile-id",
    projectorVersion: "projector-version",
    candidateKeyVersion: 2,
    candidateKeyPayloadLength: 12,
    symbolRepairPolicyVersion: "repair-version",
  };
}

describe("benchmark source capture", () => {
  it("captures full context and rejects secrets", () => {
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    const source = emitActionCompilationFullContextCapture(observer, {
      ...completeSource({ referenceCatalog: { candidates: [] }, task: { slots: [] } }),
      slotIndices: [0],
      fullContext: { referenceCatalog: { candidates: [] }, task: { slots: [] } },
    });
    expect(source.fullContextHash).toBe(contentHash(source.fullContext));
    expect(readActionCompilationCapturedSources(observer.snapshot())[0]?.actions[0]?.id).toBe("action-1");
    expect(() => assertSafeBenchmarkSource({ authorization: "secret" })).toThrow(/credential/u);
  });

  it("fails closed for credential-like fields", () => {
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    expect(() => emitActionCompilationFullContextCapture(observer, {
      ...completeSource({ api_key: "secret" }),
      fullContext: { api_key: "secret" },
    })).toThrow(/credential/u);
    expect(readActionCompilationCapturedSources(observer.snapshot())).toEqual([]);
  });

  it("does not reject ordinary world prose containing security terminology", () => {
    expect(() => assertSafeBenchmarkSource({
      belief: "claim-credit-if-success-and-deny-authorization-if-exposed",
    })).not.toThrow();
    expect(() => assertSafeBenchmarkSource({
      headers: { authorization: "Bearer abc.def" },
    })).toThrow(/credential/u);
  });
});
