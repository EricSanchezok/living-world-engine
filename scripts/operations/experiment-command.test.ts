import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_EAGER_REFERENCE_CONFIG } from "../../src/engine/algorithms/eager-reference/eager-reference";
import { eagerReferenceAlgorithmRef, FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/model-assets";
import { AlgorithmExperimentRegistry, defineAlgorithmExperimentManifest } from "../../src/engine/runtime/experiments";
import { WorldExecutionAlgorithmRegistry } from "../../src/engine/runtime/execution";
import { contentHash } from "../../src/engine/models/model-audit";
import { createTestModelCatalog, DeterministicModelProvider } from "../../src/engine/testing/model-provider";
import { loadWorldScript } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { buildExperimentReport } from "./experiment-command";

describe("experiment report command", () => {
  it("reads persisted cohorts and Action Compilation slot evidence without mutation", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-experiment-report-"));
    const file = path.join(root, "livingworld.sqlite");
    const database = new LocalDatabase(file, { heartbeat: false });
    try {
      const provider = new DeterministicModelProvider(createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
      const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
      const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
      const experiments = new AlgorithmExperimentRegistry(algorithms, database);
      const encoderFingerprint = MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint;
      const treatment = eagerReferenceAlgorithmRef({
        ...DEFAULT_EAGER_REFERENCE_CONFIG,
        candidateRetrieval: { mode: "runtime", runtimeVersion: "action-compilation-retrieval-runtime-v6", encoderFingerprint, budgetRatio: 0.2 },
      });
      const retrievalRuntime = {
        version: "action-compilation-retrieval-runtime-v6",
        role: "candidate-selection" as const,
        async retrieveBatch(input: { fullContext: Readonly<Record<string, unknown>>; slotIndices: readonly number[] }) {
          const catalog = input.fullContext.referenceCatalog as { candidates: Array<{ candidateKey: string; scope?: { kind?: string; slot?: number } }> };
          const selectedKeysBySlot = new Map(input.slotIndices.map((slot) => [slot, catalog.candidates
            .filter((candidate) => candidate.scope?.kind !== "slot" || candidate.scope.slot === slot)
            .map((candidate) => candidate.candidateKey)]));
          const fullContext = structuredClone(input.fullContext) as Record<string, unknown>;
          return {
            modelContext: structuredClone(fullContext),
            selectedKeysBySlot,
            fullContextHash: contentHash(fullContext),
            modelContextHash: contentHash(fullContext),
            shortlistHash: contentHash([...selectedKeysBySlot]),
            diagnostics: {
              selectedCount: catalog.candidates.length,
              visibleCount: catalog.candidates.length,
              batchBudget: catalog.candidates.length,
              batchShortlistRatio: 1,
              prunedReferenceCount: 0,
              anchorCount: 0,
              budgetExceeded: false as const,
              perSlotSelectedCount: Object.fromEntries([...selectedKeysBySlot].map(([slot, keys]) => [String(slot), keys.length])),
            cache: {
              passageHits: 0,
              passageMisses: 0,
              queryHits: 0,
              queryMisses: 0,
              readMs: 0,
              passageEncodeMs: 0,
              queryEncodeMs: 0,
              queryBatchSize: 0,
            },
            },
          };
        },
      };
      const manifest = defineAlgorithmExperimentManifest({
        id: "report-fixture",
        version: "1",
        salt: "report-fixture",
        eligibility: { worldContentHashes: [definition.contentHash] },
        variants: [
          { id: "baseline-a", allocationBasisPoints: 7_000, algorithmRef: FULL_CATALOG_ALGORITHM_REF },
          { id: "candidate-b", allocationBasisPoints: 3_000, algorithmRef: treatment },
        ],
        activationEvidence: { artifactHash: `sha256:${"1".repeat(64)}`, verifier: "fixture" },
      });
      experiments.register(manifest);
      experiments.activate(manifest.id, manifest.version);
      const ids = new Map<string, string>();
      for (let ordinal = 0; ordinal < 10_000 && ids.size < 2; ordinal += 1) {
        const id = `report-instance-${ordinal}`;
        const variant = experiments.enrollment({
          instanceId: id,
          worldContentHash: definition.contentHash,
          defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
          explicitExecutionTuning: false,
        }).enrollment!.variantId;
        ids.set(variant, ids.get(variant) ?? id);
      }
      expect([...ids.keys()].sort()).toEqual(["baseline-a", "candidate-b"]);
      const repository = new MemoryWorldRepository({ [definition.id]: definition });
      for (const instanceId of [ids.get("baseline-a")!, ids.get("candidate-b")!]) {
        let ordinal = 0;
        const host = new WorldHost({
          repository,
          store: database,
          ledger: database,
          provider,
          algorithmRegistry: algorithms,
          experimentRegistry: experiments,
          actionCompilationRetrievalProvider: {
            runtime: (ref) => ref.manifestHash === treatment.manifestHash ? retrievalRuntime : undefined,
            preflight: async () => undefined,
          },
          idFactory: () => ordinal++ === 0 ? instanceId : `${instanceId}-generated-${ordinal}`,
        });
        const created = await host.createInstance({ worldId: definition.id, start: { kind: "observer" } });
        await host.advance(created.summary.id, {
          expectedRevision: created.summary.revision,
          trigger: "manual",
        });
      }
      experiments.stopNewEnrollment("fixture stop");
      const report = buildExperimentReport({ experimentId: manifest.id, version: manifest.version, database: file }) as {
        readOnly: boolean;
        instances: number;
        comparisonAvailable: boolean;
        enrollmentStops: Record<string, string>;
        variants: Record<string, { cohort: string; actionCompilationSlots: number }>;
      };
      expect(report).toMatchObject({ readOnly: true, instances: 2, comparisonAvailable: true, enrollmentStops: { "1": "fixture stop" } });
      expect(report.variants["baseline-a"]).toMatchObject({ cohort: "fullcatalog-control", actionCompilationSlots: expect.any(Number) });
      expect(report.variants["candidate-b"]).toMatchObject({ cohort: "retrieval-treatment", actionCompilationSlots: expect.any(Number) });
      expect(report.variants["baseline-a"]!.actionCompilationSlots).toBeGreaterThan(0);
      expect(report.variants["candidate-b"]!.actionCompilationSlots).toBeGreaterThan(0);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
