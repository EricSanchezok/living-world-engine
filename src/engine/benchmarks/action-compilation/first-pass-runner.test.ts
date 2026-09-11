import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { DEFAULT_ALGORITHM_REF } from "../../algorithms/registry";
import type { CandidateSelectionCapability } from "../../algorithms/roles";
import { ModelGateway } from "../../models/model-gateway";
import { contentHash } from "../../models/model-audit";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { createTestModelRegistry, deterministicActionCompilationBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { readActionCompilationCapturedSources } from "../source-capture";
import { executeFirstPassTrial } from "./first-pass-runner";
import { AC_FP1_ARMS } from "./first-pass-protocol";
import { firstPassReviewEntries, scoreFirstPassTrial } from "./first-pass-scoring";

async function fixture() {
  let output: unknown;
  const scripted = new ScriptedModelProvider(({ profileId, context }) => {
    output = deterministicActionCompilationBatch(profileId, context);
    return output;
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: scripted.catalog });
  const state = definition.initialState;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  await compileActions(scripted, state, [{ id: "runner-action", actorId: "player", baseRevision: 0,
    rawText: "Observe the gate", goal: "observe", means: null, targetIds: [] }], {
    workloadId: "runner-fixture", batchId: "batch", correlation: { executionId: "fixture", revision: state.revision },
    observer, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision }, executionAlgorithmRef: DEFAULT_ALGORITHM_REF,
  }, "truth-engine", 12);
  const source = readActionCompilationCapturedSources(observer.events)[0]!;
  const registry = createTestModelRegistry(scripted.catalog);
  source.registrySnapshotHash = (await registry.capture()).hash;
  source.modelContextHash = source.fullContextHash;
  source.shortlistHash = "fixture-shortlist";
  const retrieval: CandidateSelectionCapability = {
    role: "candidate-selection", version: "action-compilation-retrieval-runtime-v6",
    retrieveBatch: async ({ fullContext, slotIndices }) => {
      const context = structuredClone(fullContext);
      const candidates = (context.referenceCatalog as { candidates: Array<{ candidateKey: string }> }).candidates;
      return { modelContext: context, fullContextHash: contentHash(context), modelContextHash: contentHash(context), shortlistHash: "fixture-shortlist",
        selectedKeysBySlot: new Map(slotIndices.map((slot) => [slot, candidates.map((entry) => entry.candidateKey)])),
        diagnostics: { selectedCount: candidates.length, visibleCount: candidates.length, batchBudget: candidates.length, batchShortlistRatio: 1,
          prunedReferenceCount: 0, anchorCount: 0, budgetExceeded: false, perSlotSelectedCount: { "0": candidates.length },
          cache: { passageHits: candidates.length, passageMisses: 0, queryHits: 0, queryMisses: 0, readMs: 0, passageEncodeMs: 0, queryEncodeMs: 0, queryBatchSize: 0 } },
      };
    },
  };
  return { source, registry, catalog: scripted.catalog, retrieval, output };
}

function chatResponse(value: unknown) {
  return Response.json({ id: "fixture-response", object: "chat.completion", created: 1, model: "scripted:truth-engine",
    choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 20 },
  });
}

describe("AC-FP1 real gateway/compiler runner", () => {
  it.each(AC_FP1_ARMS)("runs %s through actual gateway parsing, materialization and audit", async (arm) => {
    const input = await fixture();
    const codec = new ActionCompilationCodec(arm, input.source.fullContext);
    let http = 0;
    const provider = new ModelGateway(input.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, { registry: input.registry,
      fetch: async () => { http++; return chatResponse(codec.encodeOutput(input.output)); },
    });
    const evidence = await executeFirstPassTrial({ ...input, provider,
      trial: { id: `discovery-P01-00-${arm}`, phase: "discovery", sourceId: "P01", sourceIndex: 0, repetition: 0, arm },
    });
    expect(evidence.compilerAccepted).toBe(true);
    expect(evidence.stateUnchanged).toBe(true);
    expect(evidence.semanticVerdict).toBe("pending-intent-review");
    expect(http).toBe(1);
    expect(evidence.calls[0]!.audit!.structuredOutputMode).toBe("json-object-zod");
    expect(evidence.calls[0]!.audit!.invocations[0]!.outputDisposition).not.toBe("rejected");
    expect(evidence.events.some((event) => event.event === "model.action_compilation.context.captured")).toBe(true);
    const validated = evidence.events.find((event) => event.event === "model.action_compilation.slots.validated");
    expect(validated?.payload).toMatchObject({ accepted: [{ key: "runner-action", result: evidence.result!.compilations[0] }], rejected: [] });
    const httpEvidence = [{ id: "fixture-http", input: 20, output: 5, cacheHit: 0, elapsedMs: 1, reasoning: null, cacheWrite: null }];
    const pending = scoreFirstPassTrial({ evidence, source: input.source, oracleHash: "fixture-oracle", verdicts: [], http: httpEvidence });
    expect(pending).toMatchObject({ firstFormal: true, firstSemantic: false, unresolvedOutputs: 1, tokens: 25, cacheWrite: null });
    const [entry] = firstPassReviewEntries(evidence, input.source, "fixture-oracle");
    expect(entry).not.toHaveProperty("arm");
    const verdict = { oracleHash: entry!.oracleHash, stateHash: entry!.stateHash, actionId: entry!.actionId,
      canonicalCompilationHash: entry!.canonicalCompilationHash, verdict: "pass", evidenceKind: "deterministic",
      mustFindings: ["Fixture expected exact brief-action compilation"], forbiddenFindings: ["Fixture contains no extra activity"],
      evidenceArtifacts: ["first-pass-runner.test.ts"], reviewer: "unit-fixture" };
    expect(scoreFirstPassTrial({ evidence, source: input.source, oracleHash: "fixture-oracle", verdicts: [verdict], http: httpEvidence }))
      .toMatchObject({ firstSemantic: true, rawFirstSemantic: true, singleHttpSemantic: true, finalSemanticSlots: 1, unresolvedOutputs: 0 });
    expect(() => scoreFirstPassTrial({ evidence, source: input.source, oracleHash: "fixture-oracle", verdicts: [verdict, { ...verdict, verdict: "fail" }], http: httpEvidence })).toThrow("conflicting");
  });

  it("retains a failed initial call, actual repair and final result without oracle intervention", async () => {
    const input = await fixture();
    const codec = new ActionCompilationCodec("A", input.source.fullContext);
    let http = 0;
    const provider = new ModelGateway(input.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, { registry: input.registry,
      fetch: async () => {
        const value = codec.encodeOutput(input.output) as { slots: Array<{ temporalPlan: { profileRef: string } }> };
        if (++http === 1) value.slots[0]!.temporalPlan.profileRef = "r999";
        return chatResponse(value);
      },
    });
    const evidence = await executeFirstPassTrial({ ...input, provider,
      trial: { id: "discovery-P01-00-A", phase: "discovery", sourceId: "P01", sourceIndex: 0, repetition: 0, arm: "A" },
    });
    expect(evidence.compilerAccepted).toBe(true);
    expect(http).toBe(2);
    expect(evidence.calls.map((call) => call.semanticRepairAttempt)).toEqual([0, 1]);
    expect(evidence.calls[0]!.audit!.invocations[0]!.outputDisposition).toBe("rejected");
    expect(evidence.result!.metrics.repairCalls).toBe(1);
  });

  it.each(["malformed-json", "invalid-schema"])("captures the original source after %s without hiding its rejection", async (failure) => {
    const input = await fixture();
    const codec = new ActionCompilationCodec("T", input.source.fullContext);
    let http = 0;
    const provider = new ModelGateway(input.catalog, { TEST_MODEL_API_KEY: "fixture-only" }, { registry: input.registry,
      fetch: async () => {
        if (++http > 1) return chatResponse(codec.encodeOutput(input.output));
        const response = await chatResponse({ slots: [{ slot: 0 }] }).json();
        if (failure === "malformed-json") response.choices[0].message.content = "{broken";
        return Response.json(response);
      },
    });
    const evidence = await executeFirstPassTrial({ ...input, provider,
      trial: { id: "discovery-P01-00-T", phase: "discovery", sourceId: "P01", sourceIndex: 0, repetition: 0, arm: "T" },
    });
    expect(evidence.compilerAccepted).toBe(true);
    expect(evidence.stateUnchanged).toBe(true);
    expect(http).toBe(2);
    expect(evidence.calls.map((call) => call.semanticRepairAttempt)).toEqual([0, 1]);
    expect(evidence.calls[0]!.audit!.invocations[0]!.outputDisposition).toBe("rejected");
    const captures = evidence.events.filter((event) => event.event === "model.action_compilation.context.captured");
    expect(captures.map((event) => event.correlation?.semanticRepairAttempt)).toEqual([0, 1]);
    const sources = readActionCompilationCapturedSources(evidence.events);
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      fullContextHash: input.source.fullContextHash,
      stateHash: input.source.stateHash,
      actionIds: input.source.actionIds,
      modelCatalogHash: input.catalog.hash,
      registrySnapshotHash: input.source.registrySnapshotHash,
      sourceInvocationId: evidence.calls[0]!.invocationId,
    });
    expect(contentHash(evidence.calls[0]!.context)).toBe(input.source.modelContextHash);
  });
});
