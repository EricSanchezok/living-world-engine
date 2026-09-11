// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldInspectorModelInvocationSummary } from "../../shared/world-inspector-api";
import { WorldInspectorInvocationList } from "./world-inspector-invocation-list";

const invocation: WorldInspectorModelInvocationSummary = {
  id: "invocation-1",
  sourceInvocationId: "invocation-1",
  ordinal: 1,
  role: "action-compilation",
  providerId: "qwen",
  modelId: "qwen-plus",
  status: "rejected",
  lineage: { kind: "root", logicalInvocationId: "chain-1", semanticRepairAttempt: 0, rootInvocationIds: ["invocation-1"] },
  chainFinalDisposition: "rejected",
  semanticRepairCount: 2,
  slotRefs: [{ slot: 0, agentId: "sigrun", actionId: "action-1", label: "看看周围有什么吧" }],
  transportAttempts: [
    { attempt: 1, status: "retryable_error", statusCode: 504, errorName: "ModelTransportError", queueWaitMs: 20, executionMs: 1_000, retryDelayMs: 300, eventIds: [] },
    { attempt: 2, status: "succeeded", queueWaitMs: 30, executionMs: 2_000, retryDelayMs: 0, eventIds: [] },
  ],
  retryCount: 1,
  tokenUsage: { input: 148_537, output: 1_900, reasoning: 120, cacheRead: 0, cacheWrite: 0 },
  requestUtf8Bytes: 9_000,
  contextUtf8Bytes: 8_000,
  responseUtf8Bytes: 4_100,
  contextSections: [],
  timings: { invocationMs: 3_350, queueWaitMs: 50, transportMs: 3_000, parseMs: 10, retryDelayMs: 300 },
  eventIds: [],
  payloadEventIds: {},
  artifactHashes: {},
  outputDisposition: "rejected",
  issues: [{ code: "continuation_assertion", class: "causal", path: [], message: "continuation_assertion" }],
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
  referenceCatalogHash: "0".repeat(64),
  rawOutputHash: null,
  normalizedOutputHash: null,
  errorMessage: "continuation assertion failed",
  hasPayload: true,
  startedAt: "2026-09-02T08:00:00.000Z",
};

describe("WorldInspectorInvocationList", () => {
  afterEach(cleanup);

  it("shows a compact row with timestamp, status, and core metrics", () => {
    render(<WorldInspectorInvocationList invocations={[invocation]} onSelect={() => {}} query="" />);

    const summary = within(screen.getByLabelText("调用汇总"));
    expect(screen.getByText("根调用 1 · action-compilation")).toBeVisible();
    expect(summary.getByText("总 token")).toBeVisible();
    expect(summary.getByText("150,437")).toBeVisible();
    expect(summary.getByText("输入 token")).toBeVisible();
    expect(summary.getByText("148,537")).toBeVisible();
    expect(summary.getByText("输出 token")).toBeVisible();
    expect(summary.getByText("1,900")).toBeVisible();
    expect(summary.getByText("推理 token")).toBeVisible();
    expect(summary.getByText("120")).toBeVisible();
    expect(summary.getByText("缓存读取")).toBeVisible();
    expect(summary.getByText("缓存写入")).toBeVisible();
    expect(summary.getAllByText("0")).toHaveLength(2);
    expect(screen.getByLabelText("调用排序")).toBeVisible();
    expect(screen.queryByText(/根调用 ·/)).not.toBeInTheDocument();
    expect(screen.queryByText("语义修复和传输重试收在右侧详情")).not.toBeInTheDocument();
    expect(screen.getByText("修复耗尽 · 2 次")).toBeVisible();
    expect(screen.queryByText("初始输出拒绝")).not.toBeInTheDocument();
    expect(screen.getByText("09/02 08:00:00")).toBeVisible();
    expect(screen.getByText("1 slots")).toBeVisible();
    expect(screen.queryByText("Transport 1")).not.toBeInTheDocument();
    expect(screen.queryByText("1 次 retry · 2 次物理尝试")).not.toBeInTheDocument();
  });

  it("renders only root calls while keeping repair attempts for the detail view", () => {
    const repair = {
      ...invocation,
      id: "run-1::invocation-2",
      sourceInvocationId: "invocation-2",
      ordinal: 2,
      lineage: {
        kind: "repair" as const,
        logicalInvocationId: "chain-1",
        semanticRepairAttempt: 1,
        rootInvocationIds: [invocation.id],
        parentInvocationId: invocation.id,
        repairOf: invocation.id,
      },
      tokenUsage: { input: 10, output: 2, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    };
    render(<WorldInspectorInvocationList invocations={[invocation, repair]} onSelect={() => {}} query="" />);

    expect(screen.getAllByRole("button", { name: /根调用 1/ })).toHaveLength(1);
    expect(screen.queryByText(/语义修复 1 · action-compilation/)).not.toBeInTheDocument();
    const summary = within(screen.getByLabelText("调用汇总"));
    expect(summary.getByText("150,449")).toBeVisible();
    expect(summary.getByText("148,547")).toBeVisible();
    expect(summary.getByText("1,902")).toBeVisible();
    expect(screen.queryByText("筛选")).not.toBeInTheDocument();
  });

  it("distinguishes partial token totals from completely missing usage", () => {
    const partial = {
      ...invocation,
      id: "run-2::invocation-1",
      sourceInvocationId: "invocation-2",
      lineage: { ...invocation.lineage, logicalInvocationId: "chain-2", rootInvocationIds: ["run-2::invocation-1"] },
      tokenUsage: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
    };
    const { rerender } = render(<WorldInspectorInvocationList invocations={[invocation, partial]} onSelect={() => {}} query="" />);

    const summary = within(screen.getByLabelText("调用汇总"));
    expect(summary.getByText("≥150,437")).toHaveAttribute("title", "部分调用未记录总 token，显示已知最小值");
    expect(summary.getByText("≥148,537")).toHaveAttribute("title", "部分调用未记录输入 token，显示已知最小值");
    expect(summary.getByText("≥1,900")).toHaveAttribute("title", "部分调用未记录输出 token，显示已知最小值");
    expect(summary.getByText("≥120")).toHaveAttribute("title", "部分调用未记录推理 token，显示已知最小值");
    expect(summary.getAllByText("≥0")).toHaveLength(2);

    rerender(<WorldInspectorInvocationList invocations={[partial]} onSelect={() => {}} query="" />);
    expect(within(screen.getByLabelText("调用汇总")).getAllByText("—")).toHaveLength(6);
  });

  it("searches persisted Agent and action fields and selects the logical invocation", () => {
    const onSelect = vi.fn();
    const { rerender } = render(<WorldInspectorInvocationList invocations={[invocation]} onSelect={onSelect} query="Sigrun" />);

    fireEvent.click(screen.getByRole("button", { name: /根调用 1/ }));
    expect(onSelect).toHaveBeenCalledWith(invocation);

    rerender(<WorldInspectorInvocationList invocations={[invocation]} onSelect={onSelect} query="missing" />);
    expect(screen.getByText("没有匹配“missing”的模型调用。")).toBeVisible();
  });

  it("keeps the root anchor visible when a repair search selected it", () => {
    render(<WorldInspectorInvocationList invocations={[invocation]} onSelect={() => {}} query="repair-2" selectedId={invocation.id} />);

    expect(screen.getByRole("button", { name: /根调用 1/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps large slot batches compact and moves the full mapping to the detail panel", () => {
    const batched = {
      ...invocation,
      slotRefs: Array.from({ length: 5 }, (_, slot) => ({ slot, agentId: `agent-${slot}` })),
    };
    render(<WorldInspectorInvocationList invocations={[batched]} onSelect={() => {}} query="" />);

    expect(screen.getByText("5 slots")).toBeVisible();
    expect(screen.queryByText("查看全部")).not.toBeInTheDocument();
    expect(screen.queryByText("agent-0")).not.toBeInTheDocument();
    expect(screen.queryByText("agent-4")).not.toBeInTheDocument();
  });

  it("uses one full-card button for selection", () => {
    const onSelect = vi.fn();
    render(<WorldInspectorInvocationList invocations={[invocation]} onSelect={onSelect} query="" />);

    const card = screen.getByRole("button", { name: /根调用 1/ });
    expect(card).toHaveAttribute("aria-pressed", "false");
    expect(card.querySelectorAll("button")).toHaveLength(0);
    fireEvent.click(card);
    expect(onSelect).toHaveBeenCalledWith(invocation);
  });

  it("keeps repeated invocation ordinals distinguishable across executions", () => {
    const first = { ...invocation, id: "first-run::invocation-1", sourceInvocationId: "invocation-1", executionId: "first-run", startedAt: "2026-09-02T08:00:00.000Z" };
    const second = { ...invocation, id: "second-run::invocation-1", sourceInvocationId: "invocation-1", executionId: "second-run", startedAt: "2026-09-02T08:01:00.000Z" };

    render(<WorldInspectorInvocationList invocations={[first, second]} onSelect={() => {}} query="" />);

    const buttons = screen.getAllByRole("button", { name: /根调用 1/ });
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toHaveTextContent("09/02 08:00:00");
    expect(buttons[1]).toHaveTextContent("09/02 08:01:00");
    expect(buttons[0].textContent).not.toBe(buttons[1].textContent);
  });

  it("keeps the newest evidence at the top and hides the internal stage sentinel", () => {
    const older = {
      ...invocation,
      id: "run::older",
      sourceInvocationId: "older",
      ordinal: 1,
      boundaryIndex: 2,
      logicalStageIndex: Number.MAX_SAFE_INTEGER,
      ledgerSequence: 10,
      updatedAt: "2026-09-02T08:00:00.000Z",
    };
    const newer = {
      ...invocation,
      id: "run::newer",
      sourceInvocationId: "newer",
      ordinal: 2,
      boundaryIndex: 2,
      logicalStageIndex: Number.MAX_SAFE_INTEGER,
      ledgerSequence: 20,
      updatedAt: "2026-09-02T08:00:01.000Z",
    };

    render(<WorldInspectorInvocationList invocations={[older, newer]} onSelect={() => {}} query="" />);

    const buttons = screen.getAllByRole("button", { name: /根调用/ });
    expect(buttons[0]).toHaveTextContent("根调用 2");
    expect(buttons[0]).not.toHaveTextContent("未分阶段");
    expect(buttons[0]).not.toHaveTextContent("9007199254740992");
  });

  it("windows large collections instead of mounting every invocation", () => {
    const invocations = Array.from({ length: 10_000 }, (_, index) => ({
      ...invocation,
      id: `run::invocation-${index}`,
      ordinal: index + 1,
      sourceInvocationId: `invocation-${index}`,
    }));

    render(<WorldInspectorInvocationList invocations={invocations} onSelect={() => {}} query="" />);

    expect(document.querySelectorAll(".cg-inspector-invocation").length).toBeLessThan(40);
    const viewport = document.querySelector<HTMLElement>(".cg-inspector-invocation-list");
    expect(viewport).not.toBeNull();
    fireEvent.scroll(viewport!, { target: { scrollTop: 500_000 } });
    expect(document.querySelectorAll(".cg-inspector-invocation").length).toBeLessThan(40);
  });
});
