"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { WorldInspectorModelInvocationSummary } from "../../shared/world-inspector-api";
import { WorldInspectorSelect } from "./world-inspector-select";

export type WorldInspectorInvocationListItem = WorldInspectorModelInvocationSummary & {
  /** Query results carry this routing hint; step/attempt projections may omit it because their execution is implicit. */
  boundaryIndex?: number;
  executionId?: string;
  ledgerSequence?: number;
};

function formatNumber(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : value.toLocaleString();
}

type TokenUsageField = keyof WorldInspectorModelInvocationSummary["tokenUsage"];

function aggregateTokenUsage(
  invocations: WorldInspectorInvocationListItem[],
  fields: TokenUsageField[],
  label: string,
): { text: string; title?: string } {
  if (invocations.length === 0) return { text: "0" };
  let value = 0;
  let knownValues = 0;
  for (const invocation of invocations) {
    for (const field of fields) {
      const fieldValue = invocation.tokenUsage[field];
      if (fieldValue === null) continue;
      value += fieldValue;
      knownValues += 1;
    }
  }
  const expectedValues = invocations.length * fields.length;
  if (knownValues === 0) {
    return { text: "—", title: `这些调用未记录${label}` };
  }
  if (knownValues < expectedValues) {
    return { text: `≥${formatNumber(value)}`, title: `部分调用未记录${label}，显示已知最小值` };
  }
  return { text: formatNumber(value) };
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} 秒`;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function chainStatusLabel(invocation: WorldInspectorModelInvocationSummary): string {
  switch (invocation.chainFinalDisposition) {
    case "accepted": return "成功";
    case "auto-normalized": return "规范化后接受";
    case "llm-repaired": return `修复成功 · ${invocation.semanticRepairCount} 次`;
    case "rejected": return `修复耗尽 · ${invocation.semanticRepairCount} 次`;
    case "failed": return "调用失败";
    case "in-progress": return "进行中";
    case "untracked": return "未关联旧调用";
  }
}

function stageIndex(invocation: WorldInspectorInvocationListItem): number {
  const value = invocation.logicalStageIndex;
  return value !== undefined && value < Number.MAX_SAFE_INTEGER ? value : -1;
}

const invocationSearchIndex = new WeakMap<object, string>();

function searchText(invocation: WorldInspectorInvocationListItem): string {
  const cached = invocationSearchIndex.get(invocation);
  if (cached) return cached;
  const slots = invocation.slotRefs.flatMap((slot) => [slot.agentId, slot.actionId, slot.label]).filter(Boolean).join(" ");
  const value = [invocation.id, invocation.role, invocation.subjectId, invocation.providerId, invocation.modelId,
    invocation.lineage.logicalInvocationId, invocation.lineage.parentInvocationId, invocation.lineage.repairOf,
    ...invocation.lineage.rootInvocationIds,
    invocation.profileId, invocation.errorMessage, ...invocation.issues.map((issue) => issue.code), ...invocation.eventIds,
    ...Object.values(invocation.artifactHashes), slots].filter(Boolean).join(" ").toLocaleLowerCase();
  invocationSearchIndex.set(invocation, value);
  return value;
}

function invocationRowEstimate(width: number): number {
  if (width <= 384) return 148;
  if (width <= 576) return 128;
  return 104;
}

export function WorldInspectorInvocationList({
  invocations,
  onLoadMore,
  onSelect,
  query,
  selectedId,
  scopeLabel,
  hasMore,
  loadingMore,
}: {
  invocations: WorldInspectorInvocationListItem[];
  onLoadMore?: () => void;
  onSelect: (invocation: WorldInspectorInvocationListItem) => void;
  query: string;
  selectedId?: string;
  scopeLabel?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const [sort, setSort] = useState<"stage" | "timestamp" | "duration" | "inputTokens" | "outputTokens" | "retries">("stage");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportSize, setViewportSize] = useState({ width: 1024, height: 640 });
  const [itemsOffset, setItemsOffset] = useState(0);
  const [rowHeights, setRowHeights] = useState<Record<string, number>>({});
  const listRef = useRef<HTMLElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const updateSize = () => {
      const styles = window.getComputedStyle(element);
      const horizontalPadding = (Number.parseFloat(styles.paddingLeft) || 0) + (Number.parseFloat(styles.paddingRight) || 0);
      setViewportSize({
        // Container queries measure the content box, while clientWidth also
        // includes this list's horizontal padding. Keep virtualization's
        // responsive row heights on the same width as the CSS layout.
        width: Math.max(0, (element.clientWidth || 1024) - horizontalPadding),
        height: element.clientHeight || 640,
      });
      setItemsOffset(itemsRef.current?.offsetTop ?? 0);
    };
    updateSize();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateSize);
    observer?.observe(element);
    window.addEventListener("resize", updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateSize);
    };
  }, []);
  const normalized = query.trim().toLocaleLowerCase();
  const matching = useMemo(() => invocations.filter((invocation) => {
    // Keep the selected root visible when a repair ID was used to enter the
    // calls view. The root is the navigational anchor even though its summary
    // does not duplicate every repair member ID.
    if (selectedId === invocation.id) return true;
    if (!normalized) return true;
    return searchText(invocation).includes(normalized);
  }), [invocations, normalized, selectedId]);
  const visible = useMemo(() => matching.filter((invocation) => invocation.lineage.kind !== "repair").sort((left, right) => {
    const value = (invocation: WorldInspectorInvocationListItem): number => sort === "stage"
      ? (invocation.boundaryIndex ?? -1) * 1_000_000_000_000 + (stageIndex(invocation) + 1) * 1_000_000 +
        (invocation.logicalInvocationOrdinal ?? invocation.ordinal) * 1_000 + (invocation.ledgerSequence ?? invocation.ordinal)
      : sort === "duration"
      ? invocation.timings.invocationMs ?? -1
      : sort === "inputTokens" ? invocation.tokenUsage.input ?? -1
      : sort === "outputTokens" ? invocation.tokenUsage.output ?? -1
      : sort === "retries" ? invocation.retryCount
      : invocation.startedAt ? Date.parse(invocation.startedAt) : invocation.ordinal;
    return value(right) - value(left) || (right.ledgerSequence ?? right.ordinal) - (left.ledgerSequence ?? left.ordinal) ||
      right.ordinal - left.ordinal;
  }), [matching, sort]);
  const viewportHeight = viewportSize.height;
  const overscan = 8;
  const rowOffsets = useMemo(() => {
    const offsets: number[] = [];
    let total = 0;
    const estimate = invocationRowEstimate(viewportSize.width);
    for (const invocation of visible) {
      offsets.push(total);
      total += rowHeights[invocation.id] ?? estimate;
    }
    return { offsets, total };
  }, [rowHeights, viewportSize.width, visible]);
  const findRowAt = (offset: number): number => {
    let low = 0;
    let high = rowOffsets.offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((rowOffsets.offsets[middle] ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, Math.min(visible.length, low));
  };
  const effectiveScrollTop = Math.min(Math.max(0, scrollTop - itemsOffset), Math.max(0, rowOffsets.total - viewportHeight));
  const windowStart = Math.max(0, findRowAt(effectiveScrollTop) - overscan);
  const windowEnd = Math.min(visible.length, findRowAt(effectiveScrollTop + viewportHeight) + overscan + 1);
  const windowed = visible.slice(windowStart, windowEnd);
  const windowKey = windowed.map((invocation) => invocation.id).join("|");
  const retries = matching.reduce((sum, invocation) => sum + invocation.retryCount, 0);
  const tokens = {
    total: aggregateTokenUsage(matching, ["input", "output"], "总 token"),
    input: aggregateTokenUsage(matching, ["input"], "输入 token"),
    output: aggregateTokenUsage(matching, ["output"], "输出 token"),
    reasoning: aggregateTokenUsage(matching, ["reasoning"], "推理 token"),
    cacheRead: aggregateTokenUsage(matching, ["cacheRead"], "缓存读取 token"),
    cacheWrite: aggregateTokenUsage(matching, ["cacheWrite"], "缓存写入 token"),
  };
  const semanticRepairChains = new Map<string, { explicit: number; reported: number }>();
  for (const invocation of matching) {
    const key = invocation.lineage.logicalInvocationId ?? invocation.id;
    const current = semanticRepairChains.get(key) ?? { explicit: 0, reported: 0 };
    semanticRepairChains.set(key, {
      explicit: current.explicit + (invocation.lineage.kind === "repair" ? 1 : 0),
      reported: Math.max(current.reported, invocation.semanticRepairCount),
    });
  }
  const semanticRepairs = [...semanticRepairChains.values()].reduce((sum, count) =>
    sum + Math.max(count.explicit, count.reported), 0);
  const terminalFailures = visible.filter((invocation) => invocation.chainFinalDisposition === "rejected" || invocation.chainFinalDisposition === "failed").length;
  useEffect(() => {
    const viewport = itemsRef.current;
    if (!viewport || windowed.length === 0 || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey;
        if (!key) continue;
        const height = Math.ceil(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
        if (height > 0) {
          setRowHeights((current) => current[key] === height ? current : { ...current, [key]: height });
        }
      }
    });
    viewport.querySelectorAll<HTMLElement>("[data-row-key]").forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [windowKey, windowed.length]);
  return (
    <section
      className="cg-inspector-invocation-list"
      aria-label={scopeLabel ? `模型调用清单：${scopeLabel}` : "模型调用清单"}
      ref={listRef}
      onScroll={(event) => {
        const itemOffset = itemsRef.current?.offsetTop ?? 0;
        setItemsOffset(itemOffset);
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <header className="cg-inspector-invocation-list__header">
        <div className="cg-inspector-invocation-list__controls" aria-label="调用排序">
          <label>排序
            <WorldInspectorSelect
              ariaLabel="排序"
              onChange={(value) => setSort(value as typeof sort)}
              options={[
                { value: "stage", label: "引擎顺序" },
                { value: "timestamp", label: "时间" },
                { value: "duration", label: "耗时" },
                { value: "inputTokens", label: "输入 token" },
                { value: "outputTokens", label: "输出 token" },
                { value: "retries", label: "传输重试" },
              ]}
              value={sort}
            />
          </label>
        </div>
        <dl aria-label="调用汇总">
          <div><dt>根调用</dt><dd>{visible.length}</dd></div>
          <div><dt>总 token</dt><dd title={tokens.total.title}>{tokens.total.text}</dd></div>
          <div><dt>输入 token</dt><dd title={tokens.input.title}>{tokens.input.text}</dd></div>
          <div><dt>输出 token</dt><dd title={tokens.output.title}>{tokens.output.text}</dd></div>
          <div><dt>推理 token</dt><dd title={tokens.reasoning.title}>{tokens.reasoning.text}</dd></div>
          <div><dt>缓存读取</dt><dd title={tokens.cacheRead.title}>{tokens.cacheRead.text}</dd></div>
          <div><dt>缓存写入</dt><dd title={tokens.cacheWrite.title}>{tokens.cacheWrite.text}</dd></div>
          <div><dt>语义修复</dt><dd>{semanticRepairs}</dd></div>
          <div><dt>传输重试</dt><dd>{retries}</dd></div>
          <div><dt>最终失败</dt><dd>{terminalFailures}</dd></div>
        </dl>
      </header>
      {visible.length === 0 && (
        <p className="cg-inspector-inline-empty">
          {normalized ? `没有匹配“${query}”的模型调用。` : "这次记录没有模型调用。"}
        </p>
      )}
      <div
        className="cg-inspector-invocation-list__items"
        ref={itemsRef}
      >
        <div className="cg-inspector-invocation-list__spacer" style={{ height: `${rowOffsets.total}px` }}>
          <div className="cg-inspector-invocation-list__window" style={{ transform: `translateY(${rowOffsets.offsets[windowStart] ?? 0}px)` }}>
        {windowed.map((invocation) => {
          return (
            <article
              className="cg-inspector-invocation"
              data-selected={selectedId === invocation.id || undefined}
              data-status={invocation.chainFinalDisposition}
              data-row-key={invocation.id}
              key={invocation.id}
              >
              <button
                aria-pressed={selectedId === invocation.id}
                className="cg-inspector-invocation__button"
                data-selected={selectedId === invocation.id || undefined}
                onClick={() => onSelect(invocation)}
                type="button"
              >
                <span className="cg-inspector-invocation__identity">
                  <strong>{invocation.lineage.kind === "root" ? `根调用 ${invocation.logicalInvocationOrdinal || invocation.ordinal || "?"}` : `调用 ${invocation.ordinal || "?"}`} · {invocation.role ?? "模型调用"}</strong>
                  <small title={invocation.executionId}>{invocation.providerId ?? "未知 provider"} / {invocation.modelId ?? "未知 model"}</small>
                </span>
                <span className="cg-inspector-invocation__status" data-status={invocation.chainFinalDisposition}>{chainStatusLabel(invocation)}</span>
                <time className="cg-inspector-invocation__time" dateTime={invocation.startedAt ?? invocation.updatedAt}>{formatTimestamp(invocation.startedAt ?? invocation.updatedAt)}</time>
                <span className="cg-inspector-invocation__slots">{invocation.slotRefs.length} slots</span>
                <span className="cg-inspector-invocation__metrics" role="list">
                  <span role="listitem"><span>in</span><strong>{formatNumber(invocation.tokenUsage.input)}</strong></span>
                  <span role="listitem"><span>out</span><strong>{formatNumber(invocation.tokenUsage.output)}</strong></span>
                  <span role="listitem"><span>耗时</span><strong>{formatDuration(invocation.timings.invocationMs)}</strong></span>
                </span>
              </button>
            </article>
          );
        })}
          </div>
        </div>
      </div>
      {hasMore && onLoadMore && (
        <button className="cg-inspector-invocation-list__load-more" disabled={loadingMore} onClick={onLoadMore} type="button">
          {loadingMore ? "正在读取更多调用…" : "加载更多调用"}
        </button>
      )}
    </section>
  );
}
