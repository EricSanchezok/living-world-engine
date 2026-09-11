import { describe, expect, it } from "vitest";
import path from "node:path";
import { canonicalize, contentHash, measureModelContext, prepareModelContext } from "../../models/model-audit";
import {
  RecordingRuntimeObserver,
  serializeRuntimeError,
  validateAlgorithmTelemetryEvent,
  type RuntimeObserver,
} from "../observability";
import { DeterministicModelProvider } from "../../testing/model-provider";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../simulation";
import type { PolicyBinding, WorldExecutionAlgorithm } from "../execution";

function modelRoster(engine: SimulationEngine): Record<string, PolicyBinding> {
  return Object.fromEntries(Object.values(engine.snapshot.agents).map((agent) => [agent.id, {
    kind: "model" as const,
    agentId: agent.id,
    profiles: agent.modelProfiles,
  }]));
}

describe("model context measurements", () => {
  it.each([null, false, 0, "中文 🐉", [null, false, { z: 1, a: "x" }],
    { z: [], "10": null, "2": false, a: { "é": "🙂", A: 1, a: 2 } },
  ].map((context) => ({ context })))("preserves existing hash and byte/count semantics for context $context", ({ context }) => {
    const prepared = prepareModelContext(context);
    expect(prepared.hash).toBe(contentHash(context));
    expect(prepared.measure()).toEqual(measureModelContext(context));
    const compact = JSON.stringify(canonicalize(context));
    expect(prepared.measure(compact)).toEqual(measureModelContext(context, compact));
  });

  it("retains measurement rejection for a non-JSON undefined top-level section", () => {
    const context = { missing: undefined };
    const prepared = prepareModelContext(context);
    expect(prepared.hash).toBe(contentHash(context));
    expect(() => measureModelContext(context)).toThrow(TypeError);
    expect(() => prepared.measure()).toThrow(TypeError);
  });

  it("owns a fresh request snapshot without caching later mutations of the caller's context", () => {
    const context = { state: { facts: { visible: { value: "before" } } } };
    const initial = structuredClone(context);
    const first = prepareModelContext(context);
    context.state.facts.visible.value = "after with more bytes";
    expect(first.value).toEqual(initial);
    expect(first.hash).toBe(contentHash(initial));
    expect(first.measure()).toEqual(measureModelContext(initial));
    const second = prepareModelContext(context);
    expect(second.value).toEqual(context);
    expect(second.hash).not.toBe(first.hash);
    expect(second.measure().utf8Bytes).toBeGreaterThan(first.measure().utf8Bytes);
  });

  it("rejects unknown, engine-owned, and malformed algorithm telemetry", () => {
    expect(() => validateAlgorithmTelemetryEvent({ event: "algorithm.typo" }))
      .toThrow("unknown algorithm telemetry event");
    expect(() => validateAlgorithmTelemetryEvent({ event: "algorithm.activation.completed" }))
      .toThrow("engine-owned");
    expect(() => validateAlgorithmTelemetryEvent({
      event: "algorithm.agent_mind.repair_fallback",
      attributes: { phase: "mind" },
      counts: { mindFallbacks: 1 },
    })).toThrow("attributes fields must be exactly");
    expect(() => validateAlgorithmTelemetryEvent({
      event: "algorithm.eager_reference.action_compilation_context_projected",
      attributes: { phase: "action-compilation", projection: "c0-repeated-slot-catalog", repair: false },
      counts: {
        slots: 5,
        candidateKeys: 1_000,
        serializedCandidates: 5_000,
        detailedCandidates: 5_000,
        duplicateSemanticDefinitionCount: 0,
        repairIssues: 0,
        contextUtf8Bytes: 3_000_000,
        referenceCatalogUtf8Bytes: 2_400_000,
        canonicalTruthUtf8Bytes: 380_000,
        taskUtf8Bytes: 330_000,
        canonicalRefSerializedCount: 0,
        rawPrivateReferenceSerializedCount: 0,
      },
    })).not.toThrow();
    const observer = new RecordingRuntimeObserver();
    expect(() => observer.emit({ event: "resolution.unknown" }))
      .toThrow("unknown stable runtime event");
    expect(() => observer.emit({
      event: "temporal.boundary.reason",
      attributes: { reason: "timer" },
    })).toThrow("attributes fields must be exactly");
    expect(() => observer.emit({
      event: "temporal.boundary.reason",
      attributes: { reasonKind: "future_boundary" },
    })).toThrow("attribute reasonKind is invalid");
    expect(() => observer.emit({
      event: "model.invocation.started",
      correlation: { modelRole: "unregistered-role" as never },
    })).toThrow("runtime model role is invalid");
    expect(() => observer.emit({
      event: "model.invocation.started",
      attributes: { phase: { nested: true } as never },
    })).toThrow("runtime attribute phase must be");
  });

  it("preserves AggregateError members for terminal diagnostics", () => {
    const error = serializeRuntimeError(new AggregateError([
      new Error("first transport failed"),
      new Error("second transport failed"),
    ], "grounding batch failed"));
    expect(error).toMatchObject({
      name: "AggregateError",
      message: "grounding batch failed",
      errors: [
        { name: "Error", message: "first transport failed" },
        { name: "Error", message: "second transport failed" },
      ],
    });
  });

  it("preserves structured diagnostic metadata on serialized errors", () => {
    const error = Object.assign(new Error("invalid model output"), {
      code: "json.syntax-repair",
      domain: "model",
      owner: "src/engine/models/model-adapter.ts",
      retryability: "not_retryable" as const,
    });
    expect(serializeRuntimeError(error)).toMatchObject({
      code: "json.syntax-repair",
      domain: "model",
      owner: "src/engine/models/model-adapter.ts",
      retryability: "not_retryable",
    });
  });

  it("uses canonical pretty JSON UTF-8 bytes and reports top-level sections and state counts", () => {
    const context = {
      zeta: "你好",
      semanticHistory: [{ events: [{ id: "event-1" }] }],
      agentEpistemics: {
        agentA: {
          belief: {
            localEntities: { self: { id: "self" } },
            claims: { claim: { id: "claim" } },
            evidence: { evidenceA: { id: "evidence" } },
          },
        },
      },
      canonicalTruth: {
        entities: { player: { id: "player" } },
        facts: { fact: { id: "fact" } },
        events: [{ id: "event-2" }],
      },
      observations: [{ id: "observation-1" }],
    };
    const canonical = canonicalize(context);
    const json = JSON.stringify(canonical, null, 2);
    const measured = measureModelContext(context, json);

    expect(measured.utf8Bytes).toBe(Buffer.byteLength(json, "utf8"));
    expect(measured.sections.zeta.utf8Bytes)
      .toBe(Buffer.byteLength(JSON.stringify("你好", null, 2), "utf8"));
    expect(Object.keys(measured.sections)).toEqual([
      "agentEpistemics",
      "canonicalTruth",
      "observations",
      "semanticHistory",
      "zeta",
    ]);
    expect(measured.counts).toMatchObject({
      history: 1,
      events: 2,
      agents: 1,
      entities: 2,
      facts: 1,
      beliefs: 1,
      evidence: 1,
      observations: 1,
    });
  });

  it("does not change truth, belief, history, or public semantics across logging modes", async () => {
    const run = async (observer?: RuntimeObserver) => {
      const provider = new DeterministicModelProvider();
      const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
        seed: 91,
        modelCatalog: provider.catalog,
      });
      const engine = new SimulationEngine(
        definition,
        new EagerReferenceAlgorithm(provider),
      );
      const scope = {
        workloadId: "semantic-equivalence",
        batchId: "semantic-equivalence-run",
        correlation: { instanceId: "semantic-equivalence", revision: 0, step: 0 },
        observer,
      };
      await engine.bootstrapAgents(scope);
      const state = engine.snapshot;
      const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
        kind: "model" as const,
        agentId: agent.id,
        profiles: agent.modelProfiles,
      }]));
      await engine.step(roster, {
        expectedRevision: state.revision,
        trigger: "manual",
        externalActions: [],
      }, {
        ...scope,
        correlation: {
          ...scope.correlation,
          advanceId: "semantic-equivalence-run",
          advanceAttempt: 1,
          step: 1,
        },
      });
      return engine.snapshot;
    };

    const off = await run();
    const metrics = await run(new RecordingRuntimeObserver({ mode: "metrics" }));
    const full = await run(new RecordingRuntimeObserver({ mode: "full" }));
    expect(metrics).toEqual(off);
    expect(full).toEqual(off);
  });

  it("derives stable lifecycle and temporal signals in the engine", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 92,
      modelCatalog: provider.catalog,
    });
    const observer = new RecordingRuntimeObserver({ mode: "metrics" });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    const scope = {
      workloadId: "engine-owned-telemetry",
      batchId: "engine-owned-telemetry",
      correlation: { executionId: "engine-owned-telemetry", revision: 0, step: 0 },
      observer,
    };
    await engine.bootstrapAgents(scope);
    const source = engine.snapshot;
    await engine.step(modelRoster(engine), {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    }, {
      ...scope,
      correlation: { ...scope.correlation, revision: source.revision, step: source.step + 1 },
    });

    const events = observer.snapshot().map((event) => event.event);
    expect(events).toContain("algorithm.activation.completed");
    expect(events).toContain("algorithm.candidate.completed");
    expect(events).toContain("temporal.boundary.reason");
    expect(events).toContain("resolution.outcome.recorded");
    expect(events).toContain("resolution.operation.recorded");
    const modelEvents = observer.snapshot().filter((event) => event.event.startsWith("model."));
    expect(modelEvents.length).toBeGreaterThan(0);
    expect(modelEvents.every((event) => event.schemaVersion === 4 && event.algorithm)).toBe(true);
    expect(modelEvents).toContainEqual(expect.objectContaining({
      correlation: expect.objectContaining({ modelRole: "agent-mind" }),
      algorithm: expect.objectContaining({
        path: "root.agentCognition",
        role: "agent-cognition",
        id: "model-agent-cognition",
      }),
    }));
    expect(modelEvents).toContainEqual(expect.objectContaining({
      correlation: expect.objectContaining({ modelRole: "action-compilation" }),
      algorithm: expect.objectContaining({
        path: "root.actionCompilation",
        role: "action-compilation",
        id: "model-action-compilation",
      }),
    }));
    expect(observer.snapshot()).toContainEqual(expect.objectContaining({
      event: "algorithm.eager_reference.slot_batch_completed",
      attributes: expect.objectContaining({ phase: "agent-bootstrap" }),
      algorithm: expect.objectContaining({
        path: "root.agentCognition.batching",
        role: "work-batching",
        id: "bounded-slot-batching",
      }),
    }));
  });

  it("accounts for discarded model work when candidate generation fails", async () => {
    const provider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 93,
      modelCatalog: provider.catalog,
    });
    const eager = new EagerReferenceAlgorithm(provider);
    const failingAlgorithm: WorldExecutionAlgorithm = {
      manifest: eager.manifest,
      bootstrap: eager.bootstrap.bind(eager),
      async prepareStep(_input, context) {
        context.modelScope.observer?.emit({
          event: "model.invocation.started",
          correlation: { modelInvocationId: "discarded-invocation", modelRole: "agent-mind" },
        });
        context.modelScope.observer?.emit({
          event: "model.structured_output.rejected",
          correlation: { modelInvocationId: "discarded-invocation", modelRole: "agent-mind" },
          measurements: { inputTokens: 13, outputTokens: 2, reasoningTokens: 4 },
        });
        context.modelScope.observer?.emit({
          event: "model.transport.failed",
          correlation: { modelInvocationId: "discarded-invocation", modelRole: "agent-mind" },
          measurements: { executionMs: 17 },
        });
        expect(() => context.modelScope.observer?.emit({ event: "step.committed" }))
          .toThrow("runtime event is engine-owned: step.committed");
        throw new Error("candidate generation interrupted");
      },
      completeStep: eager.completeStep.bind(eager),
    };
    const observer = new RecordingRuntimeObserver({ mode: "metrics" });
    const engine = new SimulationEngine(definition, failingAlgorithm);
    await engine.bootstrapAgents({
      workloadId: "discarded-work",
      batchId: "discarded-work-bootstrap",
      observer,
    });
    const source = engine.snapshot;

    await expect(engine.step(modelRoster(engine), {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    }, {
      workloadId: "discarded-work",
      batchId: "discarded-work-step",
      observer,
    })).rejects.toThrow("candidate generation interrupted");

    expect(engine.snapshot).toEqual(source);
    expect(observer.snapshot().filter((event) => event.event === "step.committed")).toHaveLength(0);
    expect(observer.snapshot().findLast((event) => event.event === "step.rolled_back")).toMatchObject({
      counts: { rollbacks: 1, discardedModelCalls: 1 },
      measurements: {
        discardedInputTokens: 13,
        discardedOutputTokens: 2,
        discardedReasoningTokens: 4,
        discardedModelExecutionMs: 17,
      },
    });
  });
});
