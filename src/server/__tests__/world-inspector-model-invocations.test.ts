import { describe, expect, it } from "vitest";
import type { RuntimeEvent, RuntimeEventInput } from "../../engine/runtime/observability";
import type { ExecutionRecord } from "../execution-ledger";
import {
  buildWorldInspectorModelInvocationDetail,
  queryWorldInspectorModelInvocations,
} from "../world-inspector";

const record: ExecutionRecord = {
  id: "execution-1",
  kind: "interactive",
  instanceId: "instance-1",
  step: 1,
  manifest: {
    kind: "engine-operation",
    contractVersion: 1,
    id: "test",
    version: "1",
    config: {},
    hash: "manifest-hash",
  },
  worldHash: "world-hash",
  codeRevision: "test",
  codeDirty: false,
  modelCatalogHash: "catalog-hash",
  seed: 1,
  runtimeConfig: {},
  startedAt: "2026-08-30T09:00:00.000Z",
  status: "failed",
  traceId: "trace-1",
  finishedAt: "2026-08-30T09:00:08.000Z",
};

function runtimeEvents(): RuntimeEvent[] {
  let sequence = 0;
  const at = (milliseconds: number) => new Date(Date.parse("2026-08-30T09:00:00.000Z") + milliseconds).toISOString();
  const event = (milliseconds: number, input: RuntimeEventInput): RuntimeEvent => ({
    schemaVersion: 4,
    sequence: ++sequence,
    timestamp: at(milliseconds),
    level: input.level ?? "info",
    ...input,
  });
  const correlation = {
    executionId: record.id,
    modelInvocationId: "invocation-action-1",
    modelRole: "action-compilation" as const,
    modelSubject: "batch:0",
    modelInvocation: 1,
  };
  const second = {
    executionId: record.id,
    modelInvocationId: "invocation-mind-1",
    modelRole: "agent-mind" as const,
    modelSubject: "curator",
    modelInvocation: 2,
  };
  return [
    event(0, {
      event: "model.context.serialized",
      correlation,
      durationMs: 4,
      measurements: { contextUtf8Bytes: 8_000, requestUtf8Bytes: 9_000 },
      hashes: { context: "context-hash", request: "request-hash" },
      payload: {
        context: {
          slots: [{
            slot: 0,
            actorPerspective: { agentId: "sigrun", self: { name: "Sigrun" } },
            action: { id: "action-1", actorId: "sigrun", rawText: "看看周围有什么吧" },
          }],
          canonicalCatalog: { entities: [{ id: "place-1" }] },
          temporalProfiles: [{ id: "profile-1" }],
          existingActivities: [],
          validationIssues: [{ code: "previous_issue" }],
        },
      },
    }),
    event(10, {
      event: "model.action_compilation.context.captured",
      correlation,
      attributes: { middlewareVersion: "retrieval-v4", role: "action-compilation" },
      counts: {
        slots: 1,
        visibleCandidates: 1_783,
        selectedCandidates: 356,
        batchBudget: 356,
        passageCacheHits: 1_782,
        passageCacheMisses: 0,
        queryCacheHits: 0,
        queryCacheMisses: 1,
      },
      measurements: { batchShortlistRatio: 356 / 1_783, cacheReadMs: 12, queryEncodeMs: 8 },
      payload: { perSlotSelectedCount: { "0": 355 } },
    }),
    event(11, {
      event: "model.invocation.started",
      correlation,
      attributes: {
        providerId: "qwen",
        accountId: "local-qwen",
        profileId: "truth-qwen",
        modelId: "qwen-plus",
        promptVersion: "action-v3",
        schemaName: "action-compilation",
      },
    }),
    event(20, { event: "model.queue.completed", correlation: { ...correlation, transportAttempt: 1 }, durationMs: 20, measurements: { queueWaitMs: 20 } }),
    event(1_020, {
      event: "model.transport.failed",
      correlation: { ...correlation, transportAttempt: 1 },
      durationMs: 1_000,
      level: "warn",
      attributes: { status: "retryable_error" },
      error: { name: "ModelTransportError", message: "gateway timeout", status: 504 },
    }),
    event(1_320, { event: "model.transport.retry_wait", correlation: { ...correlation, transportAttempt: 1 }, durationMs: 300, measurements: { retryDelayMs: 300 } }),
    event(1_350, { event: "model.queue.completed", correlation: { ...correlation, transportAttempt: 2 }, durationMs: 30, measurements: { queueWaitMs: 30 } }),
    event(3_350, { event: "model.transport.completed", correlation: { ...correlation, transportAttempt: 2 }, durationMs: 2_000, attributes: { status: "succeeded" } }),
    event(3_360, {
      event: "model.structured_output.rejected",
      correlation,
      durationMs: 10,
      level: "warn",
      measurements: { inputTokens: 148_537, outputTokens: 1_900, reasoningTokens: 120, responseUtf8Bytes: 4_100 },
      hashes: { request: "request-hash", response: "response-hash" },
      payload: { issues: [{ code: "continuation_assertion" }], output: { assertions: [] } },
      error: { name: "SchemaValidationError", message: "continuation assertion failed" },
    }),
    event(4_000, {
      event: "model.context.serialized",
      correlation: second,
      durationMs: 2,
      measurements: { contextUtf8Bytes: 3_000, requestUtf8Bytes: 3_800 },
      payload: { context: { actorPerspective: { agentId: "curator" }, observations: [] } },
    }),
    event(4_010, {
      event: "model.invocation.started",
      correlation: second,
      attributes: { providerId: "qwen", profileId: "agent-qwen", modelId: "qwen-plus" },
    }),
    event(4_020, { event: "model.queue.completed", correlation: { ...second, transportAttempt: 1 }, durationMs: 10 }),
    event(5_020, { event: "model.transport.completed", correlation: { ...second, transportAttempt: 1 }, durationMs: 1_000 }),
    event(5_030, {
      event: "model.structured_output.parsed",
      correlation: second,
      durationMs: 10,
      measurements: { inputTokens: 10_000, outputTokens: 800, reasoningTokens: 0, responseUtf8Bytes: 1_500 },
      payload: { nextAction: null },
    }),
    event(5_040, { event: "model.semantic.accepted", correlation: second }),
  ];
}

function lineageRuntimeEvents(): RuntimeEvent[] {
  let sequence = 0;
  const event = (milliseconds: number, input: RuntimeEventInput): RuntimeEvent => ({
    schemaVersion: 4,
    sequence: ++sequence,
    timestamp: new Date(Date.parse("2026-08-30T09:00:00.000Z") + milliseconds).toISOString(),
    level: input.level ?? "info",
    ...input,
  });
  const correlation = (modelInvocationId: string, semanticRepairAttempt: number, extra: Record<string, string> = {}) => ({
    executionId: record.id,
    modelInvocationId,
    modelRole: "truth-resolution" as const,
    modelSubject: modelInvocationId,
    modelInvocation: semanticRepairAttempt + 1,
    logicalInvocationId: "shared-chain",
    semanticRepairAttempt,
    ...extra,
  });
  const rootOne = correlation("root-1", 0);
  const rootTwo = correlation("root-2", 0);
  const repair = correlation("repair-1", 1, { parentInvocationId: "root-1", repairOf: "root-1" });
  return [
    event(0, { event: "model.invocation.started", correlation: rootOne }),
    event(10, { event: "model.structured_output.rejected", correlation: rootOne, level: "warn", payload: { issues: [{ code: "root_issue" }] } }),
    event(20, { event: "model.semantic.rejected", correlation: rootOne, level: "warn", payload: { issues: [{ code: "root_issue" }] } }),
    event(30, { event: "model.invocation.started", correlation: rootTwo }),
    event(40, { event: "model.structured_output.rejected", correlation: rootTwo, level: "warn", payload: { issues: [{ code: "root_issue" }] } }),
    event(50, { event: "model.semantic.rejected", correlation: rootTwo, level: "warn", payload: { issues: [{ code: "root_issue" }] } }),
    event(60, { event: "model.invocation.started", correlation: repair }),
    event(70, { event: "model.structured_output.parsed", correlation: repair, payload: { plans: [] } }),
    event(80, { event: "model.semantic.accepted", correlation: repair }),
  ];
}

describe("world inspector model invocation projection", () => {
  it("separates logical invocations, transports, retries, tokens, and slot identity", () => {
    const result = queryWorldInspectorModelInvocations([record], runtimeEvents(), { sort: "retries" });

    expect(result.total).toBe(2);
    expect(result.items.map((item) => item.ordinal).sort((left, right) => left - right)).toEqual([1, 2]);
    expect(result.items.map((item) => item.transportAttempts.length)).toEqual([2, 1]);
    expect(result.items[0]).toMatchObject({
      id: "execution-1::invocation-action-1",
      sourceInvocationId: "invocation-action-1",
      status: "rejected",
      retryCount: 1,
      tokenUsage: { input: 148_537, output: 1_900, reasoning: 120 },
      requestUtf8Bytes: 9_000,
      contextUtf8Bytes: 8_000,
      responseUtf8Bytes: 4_100,
      slotRefs: [{ slot: 0, agentId: "sigrun", actionId: "action-1", label: "看看周围有什么吧" }],
      outputDisposition: "rejected",
      chainFinalDisposition: "untracked",
      semanticRepairCount: 0,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "ModelTransportError" }),
        expect.objectContaining({ code: "SchemaValidationError" }),
        expect.objectContaining({ code: "continuation_assertion" }),
      ]),
      actionCompilationRetrieval: {
        mode: "shortlist",
        runtimeVersion: "retrieval-v4",
        fullCatalogCount: 1_783,
        modelCatalogCount: 356,
        passageCacheHits: 1_782,
        passageCacheMisses: 0,
        perSlotSelectedCount: { "0": 355 },
      },
    });
    expect(result.items[0]?.transportAttempts[0]).toMatchObject({
      attempt: 1,
      status: "retryable_error",
      retryDelayMs: 300,
    });
    expect(result.items[0]?.contextSections.map((section) => section.key)).toEqual([
      "slots",
      "canonicalCatalog",
      "temporalProfiles",
      "existingActivities",
      "validationIssues",
    ]);
  });

  it("reports repair exhaustion on the root without counting transport retries as repairs", () => {
    const first = lineageRuntimeEvents().map((event) => event.correlation?.modelInvocationId === "repair-1" && event.event === "model.semantic.accepted"
      ? { ...event, event: "model.semantic.rejected", level: "warn" as const }
      : event);
    const second = first.filter((event) => event.correlation?.modelInvocationId === "repair-1").map((event, index) => ({
      ...event,
      sequence: 100 + index,
      timestamp: new Date(Date.parse(event.timestamp) + 1_000).toISOString(),
      correlation: event.correlation ? {
        ...event.correlation,
        modelInvocationId: "repair-2",
        modelInvocation: 3,
        semanticRepairAttempt: 2,
        parentInvocationId: "repair-1",
        repairOf: "repair-1",
      } : undefined,
    }));
    const result = queryWorldInspectorModelInvocations([record], [...first, ...second]);
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.chainFinalDisposition === "rejected")).toBe(true);
    expect(result.items.every((item) => item.semanticRepairCount === 2)).toBe(true);
    const detail = buildWorldInspectorModelInvocationDetail(record.id, "execution-1::root-1", record, [...first, ...second]);
    expect(detail?.repairChain.attempts.map((attempt) => attempt.attempt)).toEqual([0, 0, 1, 2]);
  });

  it("filters by persisted Agent/slot facts and paginates without returning payload bodies", () => {
    const events = runtimeEvents();
    const firstPage = queryWorldInspectorModelInvocations([record], events, {
      actorId: "sigrun",
      minInputTokens: 100_000,
      minRetries: 1,
      limit: 1,
    });

    expect(firstPage.total).toBe(1);
    expect(firstPage.items[0]?.id).toBe("execution-1::invocation-action-1");
    expect(firstPage.items[0]).not.toHaveProperty("payload");

    const detail = buildWorldInspectorModelInvocationDetail(record.id, "execution-1::invocation-action-1", record, events);
    expect(detail?.eventSummaries).toHaveLength(9);
    expect(detail?.eventSummaries.every((event) => !("payload" in event))).toBe(true);
    expect(detail?.payloadEventIds.context).toBeDefined();
    expect(detail?.payloadEventIds.output).toBeDefined();
    expect(detail?.artifactHashes).toMatchObject({ context: "context-hash", output: "response-hash" });
  });

  it("scopes identical producer invocation IDs by execution", () => {
    const secondRecord: ExecutionRecord = { ...record, id: "execution-2", traceId: "trace-2", startedAt: "2026-08-30T10:00:00.000Z" };
    const secondEvents = runtimeEvents().map((event) => ({
      ...event,
      timestamp: new Date(Date.parse(event.timestamp) + 3_600_000).toISOString(),
      correlation: event.correlation ? { ...event.correlation, executionId: secondRecord.id } : undefined,
    }));
    const result = queryWorldInspectorModelInvocations([record, secondRecord], [...runtimeEvents(), ...secondEvents]);
    const actionInvocations = result.items.filter((item) => item.sourceInvocationId === "invocation-action-1");

    expect(actionInvocations).toHaveLength(2);
    expect(new Set(actionInvocations.map((item) => item.id))).toEqual(new Set([
      "execution-1::invocation-action-1",
      "execution-2::invocation-action-1",
    ]));
    expect(actionInvocations.every((item) => item.sourceInvocationId === "invocation-action-1")).toBe(true);

    const secondDetail = buildWorldInspectorModelInvocationDetail(
      secondRecord.id,
      "execution-2::invocation-action-1",
      secondRecord,
      secondEvents,
    );
    expect(secondDetail?.id).toBe("execution-2::invocation-action-1");
    expect(secondDetail?.sourceInvocationId).toBe("invocation-action-1");
  });

  it("projects one final disposition for a shared semantic repair chain and hides repair rows by default", () => {
    const result = queryWorldInspectorModelInvocations([record], lineageRuntimeEvents());
    expect(result.total).toBe(2);
    expect(result.items.every((item) => item.lineage.kind === "root")).toBe(true);
    expect(result.items.map((item) => item.chainFinalDisposition)).toEqual(["llm-repaired", "llm-repaired"]);
    expect(result.items.map((item) => item.semanticRepairCount)).toEqual([1, 1]);
    expect(result.items.every((item) => item.lineage.rootInvocationIds.length === 2)).toBe(true);

    const exhaustive = queryWorldInspectorModelInvocations([record], lineageRuntimeEvents(), { includeRepairs: true });
    expect(exhaustive.total).toBe(3);
    expect(exhaustive.items.find((item) => item.lineage.kind === "repair")?.lineage.rootInvocationIds).toHaveLength(2);
    expect(exhaustive.items.find((item) => item.lineage.kind === "repair")?.lineage.repairOf).toBe("execution-1::root-1");
    const detail = buildWorldInspectorModelInvocationDetail(record.id, "execution-1::root-2", record, lineageRuntimeEvents());
    expect(detail?.repairChain.attempts.map((attempt) => attempt.invocationId)).toEqual([
      "execution-1::root-1",
      "execution-1::root-2",
      "execution-1::repair-1",
    ]);
    expect(detail?.repairChain.finalDisposition).toBe("llm-repaired");
  });

  it("projects trusted Action Compilation candidate resolution evidence", () => {
    const events = runtimeEvents();
    events.push({
      schemaVersion: 4,
      sequence: 99,
      timestamp: "2026-08-30T09:00:03.400Z",
      level: "info",
      event: "model.action_compilation.references",
      correlation: {
        executionId: record.id,
        modelInvocationId: "invocation-action-1",
        modelRole: "action-compilation",
        modelSubject: "batch:0",
        modelInvocation: 1,
      },
      payload: {
        protocolVersion: 2,
        projection: "candidate-key-v3-complete-repair-issues",
        context: {
          utf8Bytes: 12_345,
          referenceCatalogUtf8Bytes: 4_000,
          slots: 1,
          candidates: 3,
          detailedCandidates: 2,
          duplicateSemanticDefinitionCount: 0,
          canonicalRefSerializedCount: 0,
          rawPrivateReferenceSerializedCount: 0,
        },
        slots: [{
          slot: 0,
          actionId: "action-1",
          actionLabel: "看看周围有什么吧",
          actionCandidateKey: "candidate_0123456789ab",
          actor: {
            agentId: "sigrun",
            entityId: "entity-sigrun",
            status: "unique",
            agentCandidateKey: "candidate_0123456789ac",
            boundEntityCandidateKey: "candidate_0123456789ad",
            agentHandle: "ref:agent:sigrun",
            entityHandle: "ref:entity:entity-sigrun",
          },
          targets: [],
          selections: [{
            path: ["temporalPlan", "profileRef"],
            use: "profile",
            candidateKey: "candidate_0123456789ae",
            engineHandle: "ref:temporal_profile:default",
            kind: "temporal_profile",
            status: "resolved",
          }],
        }],
      },
    });

    const result = queryWorldInspectorModelInvocations([record], events, { role: "action-compilation" });
    expect(result.items[0]?.slotRefs).toEqual([{ slot: 0, agentId: "sigrun", actionId: "action-1", label: "看看周围有什么吧" }]);
    expect(result.items[0]?.actionCompilationReferenceAudit?.context).toMatchObject({
      utf8Bytes: 12_345,
      duplicateSemanticDefinitionCount: 0,
    });
    expect(result.items[0]?.actionCompilationReferenceAudit?.slots[0]?.selections[0]).toMatchObject({
      candidateKey: "candidate_0123456789ae",
      engineHandle: "ref:temporal_profile:default",
      use: "profile",
      status: "resolved",
    });
  });

  it("projects deterministic symbol repair evidence and aggregate counts", () => {
    const events = runtimeEvents().filter((event) => event.event !== "model.structured_output.rejected");
    events.push({
      schemaVersion: 4,
      sequence: 100,
      timestamp: "2026-08-30T09:00:03.500Z",
      level: "info",
      event: "model.output.normalized",
      correlation: {
        executionId: record.id,
        modelInvocationId: "invocation-action-1",
        modelRole: "action-compilation",
        modelSubject: "batch:0",
        modelInvocation: 1,
      },
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
      payload: {
        symbolRepairs: [{
          domain: "candidate-key",
          path: ["slots", 0, "temporalPlan", "profileRef"],
          originalValue: "candidate_0123456789ab",
          normalizedValue: "candidate_0123456789ab",
          correctedValue: "candidate_0123456789ac",
          status: "repaired",
          bestDistance: 1,
          secondBestDistance: null,
          margin: null,
          candidates: [{ value: "candidate_0123456789ac", distance: 1 }],
          method: "bounded-damerau",
          policyVersion: "symbol-repair-v2",
          catalogHash: "catalog-hash",
          candidateCount: 1,
        }],
      },
    });
    const result = queryWorldInspectorModelInvocations([record], events);

    expect(result.items[0]).toMatchObject({
      outputDisposition: "auto-normalized",
      symbolRepairs: [expect.objectContaining({ status: "repaired", bestDistance: 1 })],
      normalization: expect.objectContaining({ symbolRepairCount: 1, symbolRepairAcceptedCount: 1 }),
    });
  });
});
