import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EAGER_REFERENCE_CONFIG,
} from "../../engine/algorithms/eager-reference/eager-reference";
import { CachedPassageEncoder } from "../../engine/algorithms/eager-reference/candidate-retrieval/embedding-cache";
import type { LocalEncoderRuntime } from "../../engine/algorithms/eager-reference/candidate-retrieval/local-encoder";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { actionCompilationPassagesForState } from "../../engine/algorithms/eager-reference/candidate-retrieval/warmup";
import { r5RelationalPassagesForContext } from "../../engine/algorithms/eager-reference/candidate-retrieval/relational-rrf";
import { compileActions } from "../../engine/algorithms/eager-reference/action-compiler";
import { ModelTransportError } from "../../engine/models/model-provider";
import {
  DEFAULT_ALGORITHM_REF,
  eagerReferenceAlgorithmRef,
  FULL_CATALOG_ALGORITHM_REF,
} from "../../engine/algorithms/registry";
import { createTestModelCatalog, DeterministicModelProvider } from "../../engine/testing/model-provider";
import { loadWorldScript } from "../../script/world-loader";
import { createActionCompilationRetrievalRuntimeProvider } from "../action-compilation-retrieval-runtime";

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-retrieval-runtime-"));
  roots.push(root);
  const encoder: LocalEncoderRuntime = {
    modelId: MULTILINGUAL_E5_BASE_ASSET.modelId,
    modelHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
    dimensions: 2,
    async encodeBatch(texts) {
      return texts.map((text) => [text.length % 7, 1]);
    },
  };
  const provider = new DeterministicModelProvider(createTestModelCatalog());
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 47,
    modelCatalog: provider.catalog,
  });
  return { root, encoder, definition };
}

describe("Action Compilation retrieval runtime provider", () => {
  it("warms the projected passages actually delivered by compileActions", async () => {
    const input = fixture();
    const state = input.definition.initialState;
    const provider = new DeterministicModelProvider(createTestModelCatalog());
    const writer = new CachedPassageEncoder(input.encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, input.root);
    await writer.encodePassages({ worldContentHash: state.worldHash,
      passages: actionCompilationPassagesForState(state), allowWrite: true });
    const before = structuredClone(state);
    let observed = 0;
    try {
      await expect(compileActions(provider, state, [{ id: "observe-gate", actorId: "player", baseRevision: state.revision,
        rawText: "Observe the gate.", goal: "Observe the gate", means: null,
        targetIds: Object.keys(state.agents.player!.belief.localEntities).sort() }], {
        workloadId: "real-instance", batchId: "real-advance",
        runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
        actionCompilationRetrieval: { role: "candidate-selection", version: "test-boundary", async retrieveBatch(request) {
          const passages = r5RelationalPassagesForContext(request.fullContext).map(entry => entry.passage);
          const result = await writer.encodePassages({ worldContentHash: request.worldContentHash, passages, allowWrite: false });
          expect(result.misses).toBe(0);
          expect(result.hits).toBe(new Set(passages).size);
          observed += 1;
          throw new ModelTransportError("stop after real retrieval boundary");
        } },
      }, "truth-engine", 12)).rejects.toThrow("stop after real retrieval boundary");
      expect(observed).toBe(1);
      expect(state).toEqual(before);
    } finally { writer.close(); }
  });

  it("does not inspect encoder assets for a FullCatalog Composition", async () => {
    const support = createActionCompilationRetrievalRuntimeProvider({
      cacheRoot: path.join("does-not-exist", "cache"),
    });
    expect(support.runtime(FULL_CATALOG_ALGORITHM_REF)).toBeUndefined();
    await expect(support.preflight(FULL_CATALOG_ALGORITHM_REF, {
      worldContentHash: `sha256:${"1".repeat(64)}`,
      state: { worldHash: `sha256:${"1".repeat(64)}` } as never,
    })).resolves.toBeUndefined();
  });

  it("defers a missing local model error until relational instance preflight", async () => {
    const input = fixture();
    const support = createActionCompilationRetrievalRuntimeProvider({
      cacheRoot: path.join(input.root, "missing-cache"),
    });
    expect(support.runtime(DEFAULT_ALGORITHM_REF)).toBeDefined();
    await expect(support.preflight(DEFAULT_ALGORITHM_REF, {
      worldContentHash: input.definition.contentHash,
      state: input.definition.initialState,
    })).rejects.toThrow(/local encoder model root is missing/u);
  });

  it("fails a cold initial passage cache and reports the selected Composition", async () => {
    const input = fixture();
    const violations: string[] = [];
    const support = createActionCompilationRetrievalRuntimeProvider({
      cacheRoot: input.root,
      encoder: input.encoder,
      fingerprint: () => MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint,
      onSafetyViolation: (ref, reason) => violations.push(`${ref.manifestHash}:${reason}`),
    });
    await expect(support.preflight(DEFAULT_ALGORITHM_REF, {
      worldContentHash: input.definition.contentHash,
      state: input.definition.initialState,
    })).rejects.toThrow(/cache/u);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(DEFAULT_ALGORITHM_REF.manifestHash);
  });

  it("verifies warmed initial passages and resolves tuned pinned Compositions", async () => {
    const input = fixture();
    const passages = actionCompilationPassagesForState(input.definition.initialState);
    const writer = new CachedPassageEncoder(
      input.encoder,
      MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint,
      input.root,
    );
    await writer.encodePassages({
      worldContentHash: input.definition.contentHash,
      passages,
      allowWrite: true,
    });
    writer.close();
    const support = createActionCompilationRetrievalRuntimeProvider({
      cacheRoot: input.root,
      encoder: input.encoder,
      fingerprint: () => MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint,
    });
    const tuned = eagerReferenceAlgorithmRef({
      ...DEFAULT_EAGER_REFERENCE_CONFIG,
      actionCompilationMaxSlots: 3,
    });

    expect(support.runtime(DEFAULT_ALGORITHM_REF)).toBeDefined();
    expect(support.runtime(tuned)).toBeDefined();
    expect(support.runtime(tuned)).not.toBe(support.runtime(DEFAULT_ALGORITHM_REF));
    await expect(support.preflight(tuned, {
      worldContentHash: input.definition.contentHash,
      state: input.definition.initialState,
    })).resolves.toBeUndefined();
  });
});
