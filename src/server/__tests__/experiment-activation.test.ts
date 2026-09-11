import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_ALGORITHM_REF, FULL_CATALOG_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { defineAlgorithmExperimentManifest } from "../../engine/runtime/experiments";
import { verifyExperimentActivationEvidence } from "../experiment-activation";

const roots: string[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

const ENCODER_FINGERPRINT = MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint;

function artifact(hardGate = true): { file: string; hash: string; datasetManifest: string } {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-experiment-evidence-"));
  roots.push(root);
  const file = path.join(root, "results.json");
  const datasetManifest = path.join(root, "manifest.json");
  const datasetBytes = Buffer.from(`${JSON.stringify({ generation: { targetCases: 1 } })}\n`);
  writeFileSync(datasetManifest, datasetBytes);
  const value = Buffer.from(JSON.stringify({
    schemaVersion: 4,
    kind: "action-compilation-retrieval-experiment-v4",
    datasetId: "action-compilation/fullcatalog-stabilized",
    datasetVersion: 1,
    offline: { llmRequests: 0, networkRequests: 0, worldMutations: 0 },
    encoder: { encoderFingerprint: ENCODER_FINGERPRINT },
    runs: [{
      algorithm: "A0-full-catalog",
      microRecall: 1,
      macroRecall: 1,
      deterministic: true,
      cases: 1,
    }, {
      algorithm: "treatment",
      cases: 1,
      hardGate,
      microRecall: 0.95,
      macroRecall: 0.94,
      averageBatchCompression: 0.81,
      p95BatchShortlistRatio: 0.19,
      deterministic: true,
      invalidKeys: 0,
      privateKeys: 0,
      outOfShortlistAccepted: 0,
      budgetExceededCases: 0,
      batchResults: [{ cache: { passageHits: 1, passageMisses: 0 } }],
    }],
    activation: {
      replayMatched: true,
      worldContentHashes: [`sha256:${"1".repeat(64)}`],
      datasetManifestHash: `sha256:${createHash("sha256").update(datasetBytes).digest("hex")}`,
    },
    recommendation: { status: "candidate-selected", runId: "treatment" },
  }));
  writeFileSync(file, value);
  return { file, datasetManifest, hash: `sha256:${createHash("sha256").update(value).digest("hex")}` };
}

function treatmentRef() {
  return DEFAULT_ALGORITHM_REF;
}

describe("experiment activation evidence", () => {
  it("verifies immutable artifact, offline gates, cache readiness, and replay", () => {
    const evidence = artifact();
    const manifest = defineAlgorithmExperimentManifest({
      id: "fixture",
      version: "1",
      salt: "salt",
      eligibility: { worldContentHashes: [`sha256:${"1".repeat(64)}`] },
      variants: [
        { id: "control", allocationBasisPoints: 7_000, algorithmRef: FULL_CATALOG_ALGORITHM_REF },
        { id: "treatment", allocationBasisPoints: 3_000, algorithmRef: treatmentRef() },
      ],
      activationEvidence: { artifactHash: evidence.hash, verifier: "action-compilation-retrieval-v4" },
    });
    expect(verifyExperimentActivationEvidence(manifest, {
      LIVINGWORLD_RETRIEVAL_EVALUATION_PATH: evidence.file,
      LIVINGWORLD_RETRIEVAL_DATASET_MANIFEST_PATH: evidence.datasetManifest,
    })).toMatchObject({
      offlineGatesPassed: true,
      cacheReadiness: 1,
      replayMatched: true,
    });
  });

  it("fails closed on an unqualified treatment artifact", () => {
    const evidence = artifact(false);
    const manifest = defineAlgorithmExperimentManifest({
      id: "fixture",
      version: "1",
      salt: "salt",
      eligibility: { worldContentHashes: [`sha256:${"1".repeat(64)}`] },
      variants: [
        { id: "control", allocationBasisPoints: 7_000, algorithmRef: FULL_CATALOG_ALGORITHM_REF },
        { id: "treatment", allocationBasisPoints: 3_000, algorithmRef: treatmentRef() },
      ],
      activationEvidence: { artifactHash: evidence.hash, verifier: "action-compilation-retrieval-v4" },
    });
    expect(() => verifyExperimentActivationEvidence(manifest, {
      LIVINGWORLD_RETRIEVAL_EVALUATION_PATH: evidence.file,
      LIVINGWORLD_RETRIEVAL_DATASET_MANIFEST_PATH: evidence.datasetManifest,
    })).toThrow(/offline retrieval gate/u);
  });
});
