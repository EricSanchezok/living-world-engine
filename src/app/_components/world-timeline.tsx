"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { PublicInstanceDetail, PublicWorldRun } from "../../shared/world-api";
import type { WorldObserverDetail } from "../../shared/world-observer-api";

export type TimelineEntryKind = "player" | "world";

export type TimelineEntry = {
  id: string;
  targetId: string;
  kind: TimelineEntryKind;
  step?: number;
  revision: number;
  worldTimeSeconds?: number;
  title: string;
  excerpt: string;
  outcome?: "unchanged" | "pending" | "incomplete";
  activity?: NonNullable<PublicWorldRun["activity"]>;
};

function timelineStepLabel(entry: Pick<TimelineEntry, "step" | "revision">): string {
  return entry.step === undefined ? `未推进 · Revision ${entry.revision}` : `第 ${entry.step} 步`;
}

export function participantTimeline(detail: PublicInstanceDetail): TimelineEntry[] {
  return (detail.conversation?.turns ?? []).flatMap((turn) => {
    const responses = turn.responses?.length ? turn.responses : turn.response ? [turn.response] : [];
    if (responses.length === 0) {
      if (!turn.action) return [];
      return [{
        id: `timeline:${turn.id}:action`,
        targetId: `${turn.id}:action`,
        kind: "player" as const,
        revision: turn.baseRevision,
        title: turn.status === "failed" ? "回应暂未完成" : "你的行动",
        excerpt: turn.action.text,
        outcome: turn.status === "failed" ? "incomplete" as const : "pending" as const,
      }];
    }
    const firstResponse = responses[0];
    const playerEntry: TimelineEntry[] = turn.action ? [{
      id: `timeline:${turn.id}:action`,
      targetId: `${turn.id}:action`,
      kind: "player",
      step: firstResponse.step,
      revision: firstResponse.revision,
      title: "你的行动",
      excerpt: turn.action.text,
    }] : [];
    const worldEntries = responses.map((response, index) => ({
      id: `timeline:${turn.id}:${response.revision}:${index}`,
      targetId: response.id ? `${turn.id}:world:${response.id}` : `${turn.id}:world:${response.revision}:${index}`,
      kind: "world" as const,
      step: response.step,
      revision: response.revision,
      ...(response.worldTimeSeconds === undefined ? {} : { worldTimeSeconds: response.worldTimeSeconds }),
      title: response.title ?? "世界",
      excerpt: response.text,
      ...(response.activity ? { activity: response.activity } : {}),
    }));
    return [...playerEntry, ...worldEntries];
  });
}

export function observerTimeline(observer?: WorldObserverDetail): TimelineEntry[] {
  const perspective = observer?.selected?.perspective;
  if (!perspective) return [];
  return perspective.history.flatMap((turn) => {
    const actionEntry: TimelineEntry[] = turn.ownAction ? [{
      id: `timeline:perspective:${perspective.agentId}:${turn.revision}:action`,
      targetId: `perspective:${perspective.agentId}:${turn.revision}:action`,
      kind: "player",
      step: turn.step,
      revision: turn.revision,
      title: "角色行动",
      excerpt: turn.ownAction,
      ...((turn.perceivedOutcome === "failed" || turn.perceivedOutcome === "blocked")
        ? { outcome: "unchanged" as const }
        : {}),
    }] : [];
    const excerpt = turn.observations.map((observation) => observation.summary).filter(Boolean).join("\n\n");
    if (!excerpt) return actionEntry;
    return [...actionEntry, {
      id: `timeline:perspective:${perspective.agentId}:${turn.revision}`,
      targetId: `perspective:${perspective.agentId}:${turn.revision}:observation`,
      kind: "world" as const,
      step: turn.step,
      revision: turn.revision,
      title: "世界",
      excerpt,
    }];
  });
}

export function timelineExcerpt(text: string, maxLength = 76): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function formatWorldTime(seconds?: number): string | undefined {
  if (seconds === undefined) return undefined;
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainder = safeSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function activitySummary(activity?: NonNullable<PublicWorldRun["activity"]>): string | undefined {
  if (!activity) return undefined;
  if (activity.progress) {
    return `${activity.progress.current.toFixed(2)} / ${activity.progress.target} ${activity.progress.unit}`;
  }
  if (activity.status === "queued") {
    return `等待${activity.resourceNames.join("、") || "共享资源"} · 队列第 ${activity.queuePosition ?? 1} 位`;
  }
  if (activity.status === "ready") return "资源已预留 · 下一次时间推进开始";
  return undefined;
}

function useTimelineActiveIndex(entries: readonly TimelineEntry[]): [number, (index: number) => void] {
  const [activeIndex, setActiveIndex] = useState(0);
  const navigationTargetRef = useRef<number | null>(null);
  const navigationTimeoutRef = useRef<number | undefined>(undefined);

  function selectTimelineIndex(index: number): void {
    navigationTargetRef.current = index;
    setActiveIndex(index);
    if (navigationTimeoutRef.current !== undefined) window.clearTimeout(navigationTimeoutRef.current);
    navigationTimeoutRef.current = window.setTimeout(() => {
      navigationTargetRef.current = null;
      navigationTimeoutRef.current = undefined;
    }, 1_200);
  }

  useEffect(() => {
    if (entries.length === 0) {
      navigationTargetRef.current = null;
      if (navigationTimeoutRef.current !== undefined) {
        window.clearTimeout(navigationTimeoutRef.current);
        navigationTimeoutRef.current = undefined;
      }
      return;
    }
    const viewport = document.querySelector<HTMLElement>("[data-cg-thread-viewport]");
    if (!viewport || typeof IntersectionObserver === "undefined") return;
    const scrollViewport = viewport;

    const targets = entries
      .map((entry, index) => {
        const node = document.getElementById(entry.targetId);
        return node ? { index, node } : undefined;
      })
      .filter((target): target is { index: number; node: HTMLElement } => Boolean(target));
    if (targets.length === 0) return;

    function clearNavigationTarget(): void {
      navigationTargetRef.current = null;
      if (navigationTimeoutRef.current !== undefined) {
        window.clearTimeout(navigationTimeoutRef.current);
        navigationTimeoutRef.current = undefined;
      }
    }

    function targetTopAligned(node: HTMLElement): boolean {
      const rootBounds = scrollViewport.getBoundingClientRect();
      const targetBounds = node.getBoundingClientRect();
      return Math.abs(targetBounds.top - rootBounds.top) <= 8;
    }

    function settleNavigationIfReady(): "none" | "waiting" | "settled" {
      const navigationTarget = navigationTargetRef.current;
      if (navigationTarget === null) return "none";
      const target = targets.find((candidate) => candidate.index === navigationTarget);
      if (!target) {
        clearNavigationTarget();
        return "settled";
      }
      if (!targetTopAligned(target.node)) return "waiting";
      clearNavigationTarget();
      setActiveIndex(navigationTarget);
      return "settled";
    }

    const observer = new IntersectionObserver((observations) => {
      if (settleNavigationIfReady() !== "none") return;
      const visible = observations
        .filter((observation) => observation.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];
      if (!visible) return;
      const match = targets.find((target) => target.node === visible.target);
      if (match) setActiveIndex(match.index);
    }, {
      root: viewport,
      rootMargin: "-18% 0px -62% 0px",
      threshold: [0.1, 0.45, 0.8],
    });
    const handleScroll = () => {
      settleNavigationIfReady();
    };
    scrollViewport.addEventListener("scroll", handleScroll, { passive: true });
    targets.forEach(({ node }) => observer.observe(node));
    return () => {
      observer.disconnect();
      scrollViewport.removeEventListener("scroll", handleScroll);
      if (navigationTimeoutRef.current !== undefined) {
        window.clearTimeout(navigationTimeoutRef.current);
        navigationTimeoutRef.current = undefined;
      }
    };
  }, [entries]);

  return [activeIndex, selectTimelineIndex];
}

export function WorldTimelineRail({
  entries,
  reducedMotion,
  step,
}: {
  entries: readonly TimelineEntry[];
  reducedMotion: boolean;
  step: number;
}) {
  const [activeIndex, setActiveIndex] = useTimelineActiveIndex(entries);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const [previewOffset, setPreviewOffset] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const tickRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const previewHideRef = useRef<number | undefined>(undefined);
  const safeActiveIndex = Math.min(activeIndex, Math.max(0, entries.length - 1));
  const activeEntry = entries[safeActiveIndex];
  const previewEntry = previewIndex === null ? undefined : entries[previewIndex];
  const previewActivitySummary = previewEntry ? activitySummary(previewEntry.activity) : undefined;
  const timelineHeightRem = Math.min(18, Math.max(7, (entries.length * 1.15) + 2.5));
  const trackStyle = {
    "--cg-timeline-count": String(Math.max(1, entries.length)),
    "--cg-timeline-height": `${timelineHeightRem}rem`,
    ...(previewOffset === null ? {} : { "--cg-timeline-preview-offset": `${previewOffset}px` }),
  } as CSSProperties;

  function showPreview(index: number): void {
    if (previewHideRef.current !== undefined) {
      window.clearTimeout(previewHideRef.current);
      previewHideRef.current = undefined;
    }
    const track = trackRef.current;
    const tick = tickRefs.current[index];
    if (track && tick) {
      const trackBounds = track.getBoundingClientRect();
      const tickBounds = tick.getBoundingClientRect();
      setPreviewOffset(tickBounds.top + (tickBounds.height / 2) - trackBounds.top);
    }
    setPreviewIndex(index);
  }

  function hidePreview(): void {
    if (previewHideRef.current !== undefined) window.clearTimeout(previewHideRef.current);
    previewHideRef.current = window.setTimeout(() => {
      previewHideRef.current = undefined;
      setPreviewIndex(null);
      setPreviewOffset(null);
    }, 90);
  }

  useEffect(() => () => {
    if (previewHideRef.current !== undefined) window.clearTimeout(previewHideRef.current);
  }, []);

  function goTo(index: number): void {
    if (!entries[index]) return;
    setActiveIndex(index);
    showPreview(index);
    const target = document.getElementById(entries[index].targetId);
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    }
  }

  return (
    <aside
      aria-label="世界消息时间线"
      className="cg-timeline-rail"
      data-empty={entries.length === 0 || undefined}
    >
      <div className="cg-timeline-rail__axis">
        <button
          aria-label="上一条世界回复"
          className="cg-timeline-rail__arrow"
          disabled={safeActiveIndex <= 0 || entries.length === 0}
          onClick={() => goTo(safeActiveIndex - 1)}
          type="button"
        >
          <ArrowUp aria-hidden="true" />
        </button>
        <div className="cg-timeline-rail__track" ref={trackRef} style={trackStyle}>
          <span aria-hidden="true" className="cg-timeline-rail__line" />
          {entries.length > 0 ? (
            <ol>
              {entries.map((entry, index) => (
                <li
                  data-active={index === safeActiveIndex || undefined}
                  data-kind={entry.kind}
                  key={entry.id}
                >
                  <button
                    aria-current={index === safeActiveIndex ? "location" : undefined}
                    aria-label={`${timelineStepLabel(entry)}，${entry.title}，${entry.excerpt}（${entry.kind === "player" ? "玩家消息" : "世界回复"}）`}
                    className="cg-timeline-rail__tick"
                    onClick={() => goTo(index)}
                    onBlur={hidePreview}
                    onFocus={() => showPreview(index)}
                    onMouseEnter={() => showPreview(index)}
                    onMouseLeave={hidePreview}
                    ref={(node) => { tickRefs.current[index] = node; }}
                    type="button"
                  >
                    <span aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <>
              <span className="cg-timeline-rail__empty-mark" aria-hidden="true" />
              <p className="cg-timeline-rail__empty-copy">第 {step} 步</p>
            </>
          )}
          {previewEntry ? (
            <div className="cg-timeline-rail__preview" aria-hidden="true">
              <span className="cg-timeline-rail__meta">
                {timelineStepLabel(previewEntry)}
                {formatWorldTime(previewEntry.worldTimeSeconds) ? ` · ${formatWorldTime(previewEntry.worldTimeSeconds)}` : ""}
              </span>
              <strong>{previewEntry.title}</strong>
              <p>{timelineExcerpt(previewEntry.excerpt)}</p>
              {previewEntry.outcome === "unchanged" ? <small>没有改变世界</small> : null}
              {previewEntry.outcome === "pending" ? <small>等待世界回复</small> : null}
              {previewEntry.outcome === "incomplete" ? <small>已经发生的变化会保留</small> : null}
              {previewActivitySummary ? <small>{previewActivitySummary}</small> : null}
            </div>
          ) : null}
        </div>
        <button
          aria-label="下一条世界回复"
          className="cg-timeline-rail__arrow"
          disabled={safeActiveIndex >= entries.length - 1 || entries.length === 0}
          onClick={() => goTo(safeActiveIndex + 1)}
          type="button"
        >
          <ArrowDown aria-hidden="true" />
        </button>
      </div>
      <p className="cg-sr-only" aria-live="polite">
        {activeEntry ? `正在查看${timelineStepLabel(activeEntry)}：${activeEntry.title}` : `当前为第 ${step} 步`}
      </p>
    </aside>
  );
}
