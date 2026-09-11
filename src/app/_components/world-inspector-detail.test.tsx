// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorldInspectorModelInvocationDetail,
  WorldInspectorRuntimeEventSummary,
} from "../../shared/world-inspector-api";
import { WorldInspectorDetail } from "./world-inspector-detail";

const event: WorldInspectorRuntimeEventSummary = {
  schemaVersion: 4,
  sequence: 1,
  timestamp: "2026-09-03T04:13:30.000Z",
  level: "error",
  event: "model.structured_output.rejected",
  id: "runtime-1",
  hasPayload: true,
};

const invocation: WorldInspectorModelInvocationDetail = {
  id: "run-1::invocation-1",
  sourceInvocationId: "invocation-1",
  executionId: "run-1",
  attemptId: "attempt-1",
  boundaryIndex: 0,
  ledgerSequence: 1,
  ordinal: 1,
  role: "action-compilation",
  providerId: "deepseek",
  modelId: "deepseek-v4-flash",
  profileId: "agent-deepseek",
  promptVersion: "agent-bootstrap@v1",
  schemaName: "agent_mind_batch_output",
  status: "rejected",
  lineage: { kind: "root", logicalInvocationId: "chain-1", semanticRepairAttempt: 0, rootInvocationIds: ["run-1::invocation-1"] },
  chainFinalDisposition: "rejected",
  semanticRepairCount: 1,
  slotRefs: [],
  transportAttempts: [],
  retryCount: 0,
  tokenUsage: { input: 10, output: 4, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  requestUtf8Bytes: 100,
  contextUtf8Bytes: 200,
  responseUtf8Bytes: 80,
  contextSections: [],
  timings: { invocationMs: 500, queueWaitMs: 0, transportMs: 400, parseMs: 10, retryDelayMs: 0 },
  eventIds: [event.id],
  payloadEventIds: { request: event.id },
  artifactHashes: {},
  outputDisposition: "rejected",
  issues: [{
    code: "invalid_format",
    class: "mechanic",
    path: ["slots", 0],
    message: "must be a handle from the request reference catalog",
  }],
  normalization: {
    applied: false,
    modifiedFieldCount: 0,
    resolvedReferenceCount: 0,
    proposalCount: 0,
    deduplicatedCount: 0,
    symbolRepairCount: 0,
    symbolRepairAcceptedCount: 0,
    symbolRepairAmbiguousCount: 0,
    symbolRepairUnmatchedCount: 0,
    symbolRepairPostValidationRejectedCount: 0,
  },
  symbolRepairs: [],
  referenceCatalogVersion: 1,
  referenceCatalogHash: "catalog-hash",
  rawOutputHash: null,
  normalizedOutputHash: null,
  errorMessage: "structured output failed schema validation: [{\"path\":[\"slots\",0],\"message\":\"must be a handle from the request reference catalog\"}]",
  hasPayload: true,
  startedAt: "2026-09-03T04:13:30.000Z",
  updatedAt: "2026-09-03T04:13:31.000Z",
  eventSummaries: [event],
  repairChain: {
    rootInvocationIds: ["run-1::invocation-1"],
    attempts: [
      { invocationId: "run-1::invocation-1", attempt: 0, status: "rejected", outputDisposition: "rejected", issueSummary: "invalid_format", startedAt: "2026-09-03T04:13:30.000Z", finishedAt: "2026-09-03T04:13:31.000Z" },
      { invocationId: "run-1::invocation-2", attempt: 1, status: "rejected", outputDisposition: "rejected", issueSummary: "invalid_format", startedAt: "2026-09-03T04:13:31.000Z", finishedAt: "2026-09-03T04:13:32.500Z" },
    ],
    initialAttemptId: "run-1::invocation-1",
    finalAttemptId: "run-1::invocation-2",
    finalDisposition: "rejected",
    semanticRepairCount: 1,
  },
};

describe("WorldInspectorDetail", () => {
  afterEach(cleanup);

  it("keeps one title for related events and one title for payload", () => {
    render(
      <WorldInspectorDetail
        actorId="world"
        actorName="整个世界"
        instanceId="instance-1"
        invocation={invocation}
        loading={false}
        selection={{ kind: "invocation", id: invocation.id, executionId: invocation.executionId }}
      />,
    );

    expect(screen.getAllByText("调用关联事件", { exact: true })).toHaveLength(1);
    expect(screen.getAllByText("原始 payload", { exact: true })).toHaveLength(1);
    expect(screen.getAllByText("原始请求", { exact: true })).toHaveLength(1);
  });

  it("projects validation errors into one surface with raw text behind a disclosure", () => {
    const { container } = render(
      <WorldInspectorDetail
        actorId="world"
        actorName="整个世界"
        instanceId="instance-1"
        invocation={invocation}
        loading={false}
        selection={{ kind: "invocation", id: invocation.id, executionId: invocation.executionId }}
      />,
    );

    expect(container.querySelectorAll(".cg-inspector-error-surface")).toHaveLength(1);
    expect(container.querySelectorAll(".cg-model-invocation__error")).toHaveLength(0);
    expect(container.querySelectorAll(".cg-inspector-error-details > pre")).toHaveLength(1);
    expect(screen.getByText("structured output failed schema validation:")).toBeInTheDocument();
    expect(container.querySelector(".cg-inspector-error-details > pre")?.textContent).toContain("invalid_format");
  });

  it("shows the chain conclusion once and keeps per-attempt evidence in the chain", () => {
    render(
      <WorldInspectorDetail
        actorId="world"
        actorName="整个世界"
        instanceId="instance-1"
        invocation={invocation}
        loading={false}
        selection={{ kind: "invocation", id: invocation.id, executionId: invocation.executionId }}
      />,
    );

    expect(screen.getAllByText("修复耗尽 · 1 次")).toHaveLength(1);
    expect(screen.getByText(/未通过 · 1.0 秒 · invalid_format/)).toBeVisible();
    expect(screen.getByText(/未通过 · 1.5 秒 · invalid_format/)).toBeVisible();
  });

  it("shows and copies the complete public invocation identity", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(
      <WorldInspectorDetail
        actorId="world"
        actorName="整个世界"
        instanceId="instance-1"
        invocation={invocation}
        loading={false}
        selection={{ kind: "invocation", id: invocation.id, executionId: invocation.executionId }}
      />,
    );

    const identity = screen.getByRole("region", { name: "调用调试标识" });
    expect(within(identity).getByText(invocation.id)).toBeVisible();
    expect(within(identity).getByText(invocation.executionId)).toBeVisible();
    expect(within(identity).getByText(String(invocation.ledgerSequence))).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制 public invocation ID" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(invocation.id));
    expect(screen.getByRole("status")).toHaveTextContent("已复制 public invocation ID");
  });

  it("uses a balanced four-cell grid for Action Compilation reference metrics", () => {
    const withReferenceAudit: WorldInspectorModelInvocationDetail = {
      ...invocation,
      actionCompilationReferenceAudit: {
        protocolVersion: 2,
        projection: "candidate-key-v3-complete-repair-issues",
        context: {
          utf8Bytes: 703_061,
          referenceCatalogUtf8Bytes: 640_000,
          slots: 1,
          candidates: 1_841,
          detailedCandidates: 914,
          duplicateSemanticDefinitionCount: 0,
          canonicalRefSerializedCount: 0,
          rawPrivateReferenceSerializedCount: 0,
        },
        slots: [],
      },
    };
    const { container } = render(
      <WorldInspectorDetail
        actorId="world"
        actorName="整个世界"
        instanceId="instance-1"
        invocation={withReferenceAudit}
        loading={false}
        selection={{ kind: "invocation", id: invocation.id, executionId: invocation.executionId }}
      />,
    );

    expect(container.querySelector(".cg-inspector-change-summary--four")?.children).toHaveLength(4);
  });

  it("shows field-level symbol repair evidence", () => {
    const repaired = {
      ...invocation,
      status: "accepted" as const,
      outputDisposition: "auto-normalized" as const,
      chainFinalDisposition: "auto-normalized" as const,
      semanticRepairCount: 0,
      repairChain: {
        ...invocation.repairChain,
        attempts: [invocation.repairChain.attempts[0]!],
        finalAttemptId: invocation.id,
        finalDisposition: "auto-normalized" as const,
        semanticRepairCount: 0,
      },
      symbolRepairs: [{
        domain: "candidate-key" as const,
        path: ["slots", 0, "temporalPlan", "profileRef"] as Array<string | number>,
        originalValue: "candidate_0123456789ab",
        normalizedValue: "candidate_0123456789ab",
        correctedValue: "candidate_0123456789ac",
        status: "repaired" as const,
        bestDistance: 1,
        secondBestDistance: null,
        margin: null,
        candidates: [{ value: "candidate_0123456789ac", distance: 1 }],
        method: "bounded-damerau" as const,
        policyVersion: "symbol-repair-v2" as const,
        catalogHash: "catalog-hash",
        candidateCount: 1,
      }],
      normalization: {
        ...invocation.normalization,
        applied: true,
        modifiedFieldCount: 1,
        symbolRepairCount: 1,
        symbolRepairAcceptedCount: 1,
      },
    };
    render(
      <WorldInspectorDetail
        actorId="world"
        actorName="整个世界"
        instanceId="instance-1"
        invocation={repaired}
        loading={false}
        selection={{ kind: "invocation", id: repaired.id, executionId: repaired.executionId }}
      />,
    );

    fireEvent.click(screen.getByText("确定性符号修复（非 LLM 调用）"));
    expect(screen.getByText("确定性符号修复（非 LLM 调用）")).toBeVisible();
    expect(screen.getByText(/candidate_0123456789ab → candidate_0123456789ac/)).toBeVisible();
    expect(screen.getByText("已修复")).toBeVisible();
  });
});
