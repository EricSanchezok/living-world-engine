import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { defineAlgorithmManifest, type WorldStepCandidate } from "../../engine/runtime/execution";
import {
  aggregateMetricPoints,
  deriveExecutionWork,
  MetricDefinitionRegistry,
  EXECUTION_METRICS,
} from "../../engine/runtime/execution-metrics";
import { contentHash } from "../../engine/models/model-audit";
import type { ModelExecutionAudit } from "../../engine/contracts/model";
import { materializeRuntimeEvent, redactRuntimePayload } from "../../engine/runtime/observability";
import { LocalDatabase } from "../local-database";
import { candidatePartitions, replayThroughAlgorithm } from "../../../scripts/operations/execution-command";
import { runDeterministicExperiment } from "../../../scripts/experiments/experiment-core";
import type { InvocationProbeReport } from "../../engine/models/model-invocation-probe";

function database(): LocalDatabase {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-execution-ledger-"));
  return new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
}

const manifest = defineAlgorithmManifest({
  id: "test-algorithm",
  version: "1",
  config: {},
  children: {},
});

function activationCounts(overrides: Partial<Record<string, number>> = {}) {
  return {
    persistentAgents: 0,
    eligibleAgents: 0,
    activatedAgents: 0,
    skippedAgents: 0,
    reusedAgents: 0,
    noopAgents: 0,
    externalAgents: 0,
    ...overrides,
  };
}

function candidateCounts(overrides: Partial<Record<string, number>> = {}) {
  return {
    updatedAgents: 0,
    observedAgents: 0,
    actions: 0,
    reactions: 0,
    checks: 0,
    randomResults: 0,
    resolutionPlans: 0,
    settledResolutionReceipts: 0,
    deferredResolutionReceipts: 0,
    mechanicInvocations: 0,
    mechanicResults: 0,
    outcomes: 0,
    operations: 0,
    events: 0,
    observations: 0,
    mindCommits: 0,
    mindFallbacks: 0,
    temporalPlans: 0,
    activeActivities: 0,
    activityTransitions: 0,
    dueActivities: 0,
    dueTimers: 0,
    dueConditions: 0,
    decisionPoints: 0,
    temporalDeltaSeconds: 0,
    dependencyNodes: 0,
    dependencyEdges: 0,
    dependencyComponents: 0,
    maxDependencyComponent: 0,
    globalDependencies: 0,
    globalReadjudications: 0,
    footprintCardinality: 0,
    audienceCardinality: 0,
    ...overrides,
  };
}

describe("Execution Ledger", () => {
  it("rejects an unexpired lease held by a live process", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-live-database-owner-"));
    const file = path.join(root, "livingworld.sqlite");
    const first = new LocalDatabase(file, { heartbeat: false, ownerId: "live-owner" });
    try {
      expect(() => new LocalDatabase(file, {
        heartbeat: false,
        ownerId: "contending-owner",
        isProcessAlive: () => true,
      })).toThrow("already owned by another Living World Engine instance");
    } finally {
      first.close();
    }
  });

  it("immediately reclaims an unexpired lease from a dead process", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-dead-database-owner-"));
    const file = path.join(root, "livingworld.sqlite");
    const first = new LocalDatabase(file, { heartbeat: false, ownerId: "dead-owner" });
    const recovered = new LocalDatabase(file, {
      heartbeat: false,
      ownerId: "recovered-owner",
      isProcessAlive: () => false,
    });
    try {
      expect(recovered.list()).toEqual([]);
    } finally {
      recovered.close();
      first.close();
    }
  });

  it("rejects an older database without migrating or deleting it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-old-database-"));
    const file = path.join(root, "livingworld.sqlite");
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations(version, applied_at) VALUES (5, '2026-08-27T00:00:00.000Z');
    `);
    legacy.close();

    expect(() => new LocalDatabase(file, { heartbeat: false }))
      .toThrow("use a new LIVINGWORLD_DATA_ROOT");
    const preserved = new Database(file, { readonly: true });
    expect(preserved.prepare("SELECT version FROM schema_migrations").pluck().get()).toBe(5);
    preserved.close();
  });

  it("buffers bounded trace writes until an explicit durability boundary", () => {
    const ledger = database();
    try {
      const delivered: string[] = [];
      ledger.subscribe((event) => delivered.push(event.event));
      const trace = ledger.beginExecution({
        id: "buffered-execution",
        kind: "diagnostic",
        manifest,
        worldHash: contentHash("world"),
        codeRevision: "test",
        codeDirty: false,
        modelCatalogHash: contentHash("catalog"),
        seed: 1,
        runtimeConfig: {},
      });
      trace.emit({ event: "buffered.first" });
      trace.emit({ event: "buffered.second" });
      expect(delivered).toEqual([]);

      trace.flush();

      expect(delivered).toEqual(["buffered.first", "buffered.second"]);
      expect(ledger.executionEvents("buffered-execution").map((event) => event.event))
        .toEqual(["buffered.first", "buffered.second"]);
      ledger.finishExecution("buffered-execution", { status: "succeeded" });
    } finally {
      ledger.close();
    }
  });

  it("persists full payloads as compressed content-addressed artifacts", () => {
    const ledger = database();
    try {
      const trace = ledger.beginExecution({
        id: "execution-1",
        kind: "diagnostic",
        instanceId: "instance-1",
        step: 1,
        manifest,
        worldHash: contentHash("world"),
        codeRevision: "test",
        codeDirty: false,
        modelCatalogHash: contentHash("catalog"),
        seed: 7,
        runtimeConfig: { deterministic: true },
      });
      const payload = { prompt: "完整输入", nested: { value: 42 } };
      trace.emit({
        event: "model.invocation.started",
        attributes: { providerId: "test", modelId: "deterministic" },
        measurements: { requestUtf8Bytes: 128 },
        payload,
      })!;
      trace.emit({
        event: "model.structured_output.parsed",
        measurements: { inputTokens: 11, outputTokens: 3 },
        payload: { result: "ok" },
      });
      const reference = ledger.finishExecution("execution-1", {
        status: "succeeded",
        semanticHash: contentHash("semantic"),
        stateHash: contentHash("state"),
        commitRevision: 1,
      });
      const emitted = ledger.executionEvents("execution-1")[0];

      expect(reference.terminalEventSequence).toBeGreaterThanOrEqual(emitted.sequence);
      expect(reference.traceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(ledger.execution("execution-1")).toMatchObject({
        status: "succeeded",
        instanceId: "instance-1",
        commitRevision: 1,
      });
      expect(ledger.executionEvents("execution-1").map((event) => event.payload)).toEqual([
        payload,
        { result: "ok" },
      ]);
      const hash = contentHash(payload);
      const artifact = ledger.artifact(hash)!;
      expect(artifact.value).toEqual(payload);
      expect(artifact.storedBytes).toBeLessThanOrEqual(artifact.rawBytes + 64);
      expect(() => ledger.putExecutionArtifact("execution-1", "late", { invalid: true }))
        .toThrow("already terminal");
    } finally {
      ledger.close();
    }
  });

  it("keeps failed executions queryable without a commit revision", () => {
    const ledger = database();
    try {
      ledger.beginExecution({
        id: "failed-execution",
        kind: "interactive",
        manifest,
        worldHash: contentHash("world"),
        codeRevision: "test",
        codeDirty: true,
        modelCatalogHash: contentHash("catalog"),
        seed: 1,
        runtimeConfig: {},
      }).emit({ event: "step.rolled_back", counts: { rollbacks: 1 }, payload: { reason: "invalid" } });
      ledger.finishExecution("failed-execution", { status: "failed", error: new Error("invalid") });
      expect(ledger.execution("failed-execution")).toMatchObject({ status: "failed" });
      expect(ledger.execution("failed-execution")?.commitRevision).toBeUndefined();
      expect(ledger.executionEvents("failed-execution")).toHaveLength(2);
      expect(ledger.executionEvents("failed-execution").at(-1)).toMatchObject({
        event: "execution.failed",
        error: { name: "Error", message: "invalid" },
      });
    } finally {
      ledger.close();
    }
  });

  it("marks executions left running by a prior database owner as failed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-interrupted-execution-"));
    const file = path.join(root, "livingworld.sqlite");
    const first = new LocalDatabase(file, { heartbeat: false });
    first.beginExecution({
      id: "interrupted-execution",
      kind: "interactive",
      manifest,
      worldHash: contentHash("world"),
      codeRevision: "test",
      codeDirty: false,
      modelCatalogHash: contentHash("catalog"),
      seed: 1,
      runtimeConfig: {},
    }).emit({ event: "step.started" });
    first.close();

    const recovered = new LocalDatabase(file, { heartbeat: false });
    try {
      expect(recovered.execution("interrupted-execution")).toMatchObject({ status: "failed" });
      expect(recovered.executionEvents("interrupted-execution")).toContainEqual(expect.objectContaining({
        event: "execution.recovered_as_failed",
        attributes: { reason: "process_interrupted" },
      }));
      expect(recovered.executionEvents("interrupted-execution").at(-1)).toMatchObject({
        event: "execution.failed",
        error: { name: "ExecutionInterruptedError" },
      });
    } finally {
      recovered.close();
    }
  });

  it("derives metrics from raw events and rejects high-cardinality dimensions", () => {
    const ledger = database();
    try {
      const trace = ledger.beginExecution({
        id: "metric-execution",
        kind: "benchmark",
        manifest,
        worldHash: contentHash("world"),
        codeRevision: "test",
        codeDirty: false,
        modelCatalogHash: contentHash("catalog"),
        seed: 1,
        runtimeConfig: {},
      });
      trace.emit({
        event: "step.started",
        attributes: { agentId: "must-stay-in-trace" },
        counts: { persistentAgents: 1000 },
      });
      trace.emit({
        event: "algorithm.activation.completed",
        attributes: { phase: "step", policy: "engine-decision-eligibility" },
        counts: activationCounts({ persistentAgents: 1000, activatedAgents: 1000 }),
      });
      trace.emit({
        event: "algorithm.candidate.completed",
        attributes: { phase: "step", dependencyAnalysis: "typed-action-dependencies", trigger: "batch" },
        counts: candidateCounts({
          updatedAgents: 1000,
          mindFallbacks: 2,
          resolutionPlans: 4,
          settledResolutionReceipts: 3,
          deferredResolutionReceipts: 1,
          temporalPlans: 2,
          activeActivities: 1,
          activityTransitions: 2,
          dueActivities: 2,
          dueTimers: 1,
          dueConditions: 1,
          decisionPoints: 2,
          temporalDeltaSeconds: 300,
          maxDependencyComponent: 5,
        }),
      });
      trace.emit({
        event: "algorithm.activation.completed",
        attributes: { phase: "step", policy: "engine-decision-eligibility" },
        counts: activationCounts({ persistentAgents: 800, activatedAgents: 7 }),
      });
      trace.emit({
        event: "algorithm.candidate.completed",
        attributes: { phase: "step", dependencyAnalysis: "typed-action-dependencies", trigger: "batch" },
        counts: candidateCounts({ maxDependencyComponent: 2 }),
      });
      trace.emit({ event: "temporal.boundary.reason", attributes: { reasonKind: "timer" } });
      trace.emit({ event: "temporal.activity.transition", attributes: { transitionKind: "completed" } });
      trace.emit({ event: "resolution.outcome.recorded", attributes: { outcomeStatus: "succeeded" } });
      trace.emit({ event: "resolution.operation.recorded", attributes: { operationKind: "advance_time" } });
      trace.emit({
        event: "algorithm.outcome.alternative_evidence_normalized",
        attributes: { phase: "transition" },
        counts: { droppedOutcomeAlternativeEvidenceReferences: 3, droppedOutcomeAlternatives: 1 },
      });
      trace.emit({
        event: "model.output.normalized",
        attributes: { applied: true },
        counts: {
          modifiedFields: 1,
          resolvedReferences: 1,
          proposals: 0,
          deduplicated: 0,
          symbolRepairAttempts: 1,
          symbolRepairAccepted: 1,
          symbolRepairAmbiguous: 0,
          symbolRepairUnmatched: 0,
          symbolRepairPostValidationRejected: 0,
        },
      });
      trace.emit({
        event: "instance.bootstrap.committed",
        durationMs: 123,
        counts: { activatedAgents: 1000, updatedAgents: 1000 },
      });
      const points = EXECUTION_METRICS.derive(ledger.executionEvents("metric-execution"));
      expect(points.filter((point) => point.name === "lwe.agent.persistent"))
        .toContainEqual(expect.objectContaining({ value: 1000 }));
      expect(points.filter((point) => point.name === "lwe.agent.activated"))
        .toContainEqual(expect.objectContaining({ value: 1000 }));
      expect(points.filter((point) => point.name === "lwe.agent.updated"))
        .toContainEqual(expect.objectContaining({ value: 1000 }));
      expect(points.filter((point) => point.name === "lwe.agent.mind_fallbacks"))
        .toContainEqual(expect.objectContaining({ value: 2 }));
      expect(points.filter((point) => point.name === "lwe.output.resolution_receipts_deferred"))
        .toContainEqual(expect.objectContaining({ value: 1 }));
      expect(points.filter((point) => point.name === "lwe.temporal.delta"))
        .toContainEqual(expect.objectContaining({ value: 300, unit: "s" }));
      expect(points.filter((point) => point.name === "lwe.normalization.outcome_alternatives"))
        .toEqual([expect.objectContaining({ value: 1 })]);
      expect(points.filter((point) => point.name === "lwe.model.symbol_repair.attempts"))
        .toEqual([expect.objectContaining({ value: 1 })]);
      expect(points.filter((point) => point.name === "lwe.model.symbol_repair.accepted"))
        .toEqual([expect.objectContaining({ value: 1 })]);
      expect(points.filter((point) => point.name === "lwe.temporal.boundary_reasons"))
        .toEqual([expect.objectContaining({ value: 1, dimensions: { reasonKind: "timer" } })]);
      expect(points.some((point) => "agentId" in point.dimensions)).toBe(false);
      const aggregated = aggregateMetricPoints(points);
      expect(aggregated.find((point) => point.name === "lwe.agent.persistent")).toMatchObject({ value: 800 });
      expect(aggregated.find((point) => point.name === "lwe.agent.activated")).toMatchObject({ value: 1007 });
      expect(aggregated.find((point) => point.name === "lwe.dependency.max_component")).toMatchObject({ value: 5 });
      const work = deriveExecutionWork(ledger.executionEvents("metric-execution"));
      expect(work).toMatchObject({
        maxSpanDepth: 2,
        executionWallMs: 123,
      });
      expect(work.spanCount).toBeGreaterThan(0);
      const registry = new MetricDefinitionRegistry();
      expect(() => registry.register({
        name: "invalid",
        unit: "1",
        aggregation: "sum",
        source: { field: "counts", key: "agents" },
        allowedDimensions: ["agentId"],
      })).toThrow("high-cardinality");
      registry.register({
        name: "sample-count",
        unit: "1",
        aggregation: "count",
        source: { field: "counts", key: "samples" },
        allowedDimensions: [],
      });
      expect(aggregateMetricPoints([
        { name: "sample-count", value: 5, unit: "1", dimensions: {} },
        { name: "sample-count", value: 7, unit: "1", dimensions: {} },
      ], registry)).toEqual([
        { name: "sample-count", value: 2, unit: "1", dimensions: {}, samples: 2 },
      ]);
    } finally {
      ledger.close();
    }
  });

  it("measures execution wall time across multiple committed steps", () => {
    const events = [
      materializeRuntimeEvent(
        { event: "step.started", correlation: { executionId: "multi-step" } },
        1,
        new Date("2026-08-28T00:00:00.000Z"),
        "metrics",
      ),
      materializeRuntimeEvent(
        { event: "step.committed", correlation: { executionId: "multi-step" }, durationMs: 120 },
        2,
        new Date("2026-08-28T00:00:00.120Z"),
        "metrics",
      ),
      materializeRuntimeEvent(
        { event: "step.committed", correlation: { executionId: "multi-step" }, durationMs: 180 },
        3,
        new Date("2026-08-28T00:00:00.500Z"),
        "metrics",
      ),
    ];

    expect(deriveExecutionWork(events).executionWallMs).toBe(500);
  });

  it.each([1, 3])("replays recorded model outputs for %i agents without network access", async (agentCount) => {
    const ledger = database();
    try {
      const experiment = await runDeterministicExperiment({
        agents: [agentCount],
        steps: [1],
        actionCompilationSlots: [3],
        agentMindSlots: [2],
        ledger,
      });
      expect(experiment.scenarios[0]).toMatchObject({
        ledgerEventCount: expect.any(Number),
        ledgerArtifactRawBytes: expect.any(Number),
        ledgerArtifactStoredBytes: expect.any(Number),
        ledgerSqliteWriteMs: expect.any(Number),
      });
      expect(experiment.scenarios[0].ledgerEventCount).toBeGreaterThan(0);
      expect(experiment.scenarios[0].ledgerArtifactRawBytes).toBeGreaterThan(0);
      const original = ledger.executions({ kind: "benchmark" })
        .find((execution) => execution.manifest.id === "eager-reference");
      expect(original).toBeDefined();
      expect(original?.manifest).toMatchObject({
        config: {},
        children: {
          agentCognition: { children: { batching: { config: { maxSlots: 2 } } } },
          actionCompilation: {
            children: {
              batching: { config: { maxSlots: 3 } },
              candidateSelection: { id: "full-catalog", role: "candidate-selection" },
            },
          },
          interactionGrounding: { children: { scheduling: { config: { maxConcurrent: 16 } } } },
          reactionResolution: { children: { scheduling: { config: { maxConcurrent: 8 } } } },
          truthResolution: { children: { batching: { config: { maxSlots: 12 } } } },
        },
      });
      expect(candidatePartitions(ledger.executionEvents(original!.id))).toMatchObject({
        resolution: {
          plans: expect.any(Array),
          receipts: expect.any(Array),
          mechanicResults: expect.any(Array),
          causalVerification: expect.any(Object),
        },
        temporal: {
          plans: expect.any(Array),
          boundary: expect.any(Object),
          activityTransitions: expect.any(Array),
          decisionPoints: expect.any(Array),
        },
      });
      const replayed = await replayThroughAlgorithm(
        ledger,
        original!,
        ledger.executionEvents(original!.id),
      );
      expect(replayed).toMatchObject({
        semanticHash: original!.semanticHash,
        stateHash: original!.stateHash,
      });
      expect(ledger.execution(replayed.replayExecutionId)).toMatchObject({
        kind: "replay",
        parentExecutionId: original!.id,
        status: "succeeded",
      });
      if (agentCount > 1) {
        const events = ledger.executionEvents(original!.id);
        const logicalAudits = events.filter((event) => event.event === "execution.candidate.persisted" &&
          event.attributes?.phase === "step").flatMap((event) => (event.payload as WorldStepCandidate).modelAudits);
        const physicalEvent = events.find((event) => {
          if (event.event !== "model.audit.persisted") return false;
          const physical = event.payload as ModelExecutionAudit;
          return logicalAudits.some((logical) => logical.subjectId !== physical.subjectId &&
            logical.invocations.some((invocation) => physical.invocations.some((entry) => entry.id === invocation.id)));
        });
        expect(physicalEvent, "fixture must exercise a physical batch with logical slot audits").toBeDefined();
        const replayCount = ledger.executions({ parentExecutionId: original!.id }).length;
        await expect(replayThroughAlgorithm(ledger, original!, events.filter((event) => event !== physicalEvent)))
          .rejects.toThrow("recorded model output has no physical audit");
        expect(ledger.executions({ parentExecutionId: original!.id })).toHaveLength(replayCount);
      }
    } finally {
      ledger.close();
    }
  });

  it("overlays one exact probe output and records the counterfactual evidence", async () => {
    const ledger = database();
    try {
      await runDeterministicExperiment({
        agents: [1],
        steps: [1],
        actionCompilationSlots: [3],
        agentMindSlots: [2],
        ledger,
      });
      const original = ledger.executions({ kind: "benchmark" })
        .find((execution) => execution.manifest.id === "eager-reference")!;
      const events = ledger.executionEvents(original.id);
      const candidateEvent = events.find((candidate) => candidate.event === "execution.candidate.persisted" &&
        candidate.attributes?.phase === "step")!;
      const candidate = candidateEvent.payload as WorldStepCandidate;
      const outputEvent = events.find((candidateEventValue) => candidateEventValue.event === "model.structured_output.parsed" &&
        candidate.modelAudits.some((audit) => audit.invocations.some((invocation) =>
          invocation.id === candidateEventValue.correlation?.modelInvocationId)))!;
      const targetId = outputEvent.correlation!.modelInvocationId!;
      const targetAudit = candidate.modelAudits.find((audit) => audit.invocations.some((invocation) => invocation.id === targetId));
      if (!targetAudit) throw new Error("test target audit is missing");
      const targetInvocation = targetAudit.invocations.find((invocation) => invocation.id === targetId);
      if (!targetInvocation) throw new Error("test target invocation is missing");
      const context = events.find((candidateEventValue) => candidateEventValue.event === "model.context.serialized" &&
        candidateEventValue.correlation?.modelInvocationId === targetId)!.payload as {
          role: ModelExecutionAudit["role"];
          subjectId: string;
          profileId: string;
          promptVersion: string;
          schemaName: string;
          workloadId: string;
          batchId: string;
          system: string;
          userPrompt: string;
          context: unknown;
          schema: unknown;
          modelCatalogHash: string;
          registrySnapshotHash: string;
        };
      const report = {
        schemaVersion: 1,
        kind: "model-invocation-probe",
        probeId: "probe-ledger-test",
        networkAccessed: true,
        source: {
          publicInvocationId: `${original.id}::${targetId}`,
          executionId: original.id,
          sourceInvocationId: targetId,
          status: "accepted",
          issueCodes: [],
          requestHash: targetInvocation.requestHash,
          modelCatalogHash: context.modelCatalogHash,
          registrySnapshotHash: context.registrySnapshotHash,
        },
        variant: null,
        profile: {
          sourceProfileId: context.profileId,
          effectiveProfileId: context.profileId,
          overridden: false,
          catalogHash: context.modelCatalogHash,
          registrySnapshotHash: context.registrySnapshotHash,
          drift: [],
        },
        request: {
          role: context.role,
          subjectId: context.subjectId,
          promptVersion: context.promptVersion,
          schemaName: context.schemaName,
          workloadId: context.workloadId,
          batchId: context.batchId,
          system: context.system,
          userPrompt: context.userPrompt,
          context: context.context,
          schema: context.schema,
        },
        trials: [{
          trial: 1,
          status: "accepted",
          requestHash: targetInvocation.requestHash,
          requestExactMatch: true,
          request: {
            profileId: context.profileId,
            role: context.role,
            subjectId: context.subjectId,
            promptVersion: context.promptVersion,
            schemaName: context.schemaName,
            workloadId: context.workloadId,
            batchId: context.batchId,
            system: context.system,
            userPrompt: context.userPrompt,
            context: context.context,
          },
          requestDiff: { changed: false, changedFields: [], changes: [], truncated: false },
          output: outputEvent.payload,
          audit: { ...structuredClone(targetAudit), invocations: [structuredClone(targetInvocation)] },
          events: [],
          engineSemantic: "not-run",
        }],
        summary: { total: 1, accepted: 1, rejected: 0, transportFailed: 0, configurationFailed: 0, acceptRate: 1, normalizationRate: 0 },
      } satisfies InvocationProbeReport;
      const reportHash = contentHash(redactRuntimePayload(report));
      const result = await replayThroughAlgorithm(ledger, original, events, undefined, {
        probe: { report, reportHash, trial: report.trials[0] },
      });
      expect(result).toMatchObject({ mode: "probe-overlay", replayStatus: "succeeded", engineSemantic: "accepted", probeId: "probe-ledger-test", trial: 1, targetInvocation: targetId });
      const child = ledger.execution(result.replayExecutionId)!;
      expect(child).toMatchObject({ kind: "replay", parentExecutionId: original.id, status: "succeeded" });
      expect(child.runtimeConfig).toMatchObject({ replayMode: "probe-overlay", probeNetworkAccessed: true, replayNetworkAccessed: false, probeReportHash: reportHash });
      expect(ledger.artifact(reportHash)).toMatchObject({ executionId: result.replayExecutionId, kind: "debug.model-invocation-probe.report" });
      expect(ledger.executionEvents(result.replayExecutionId).some((event) => event.event === "debug.probe.overlay.applied")).toBe(true);
      expect(ledger.execution(original.id)?.stateHash).toBe(original.stateHash);

      const rejectedReport = structuredClone(report) as InvocationProbeReport;
      const rejectedTrial = rejectedReport.trials[0]!;
      rejectedTrial.status = "rejected";
      rejectedTrial.rawOutput = outputEvent.payload;
      delete rejectedTrial.output;
      rejectedReport.summary = { ...rejectedReport.summary, accepted: 0, rejected: 1, acceptRate: 0 };
      const rejectedResult = await replayThroughAlgorithm(ledger, original, events, undefined, {
        probe: {
          report: rejectedReport,
          reportHash: contentHash(redactRuntimePayload(rejectedReport)),
          trial: rejectedTrial,
        },
      });
      expect(rejectedResult).toMatchObject({ mode: "probe-overlay", replayStatus: "succeeded", engineSemantic: "rejected" });
    } finally {
      ledger.close();
    }
  });
});
