// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublicInstanceDetail } from "../../shared/world-api";
import type { WorldObserverDetail } from "../../shared/world-observer-api";
import {
  observerTimeline,
  participantTimeline,
  timelineExcerpt,
  WorldTimelineRail,
  type TimelineEntry,
} from "./world-timeline";

const entries: TimelineEntry[] = [
  {
    id: "timeline:one",
    targetId: "message:one",
    kind: "world",
    step: 1,
    revision: 1,
    worldTimeSeconds: 12,
    title: "石门前",
    excerpt: "风从石门缝隙里穿过。",
  },
  {
    id: "timeline:two",
    targetId: "message:two",
    kind: "world",
    step: 2,
    revision: 2,
    title: "门后",
    excerpt: "门后的道路向黑暗深处延伸。",
    activity: {
      id: "activity:two",
      status: "active",
      description: "穿过石门",
      stage: "寻找落脚点",
      progress: { current: 2, target: 10, unit: "米" },
      nextBoundaryAtSeconds: 18,
      completionAtSeconds: 24,
      queuePosition: null,
      resourceNames: [],
    },
  },
];

function timelineRect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

class MockTimelineObserver {
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(): void {}

  disconnect(): void {}

  trigger(entriesToReport: Array<Partial<IntersectionObserverEntry>>): void {
    this.callback(entriesToReport as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("world timeline rail", () => {
  it("compacts excerpts without losing short text", () => {
    expect(timelineExcerpt("  石门前  ")).toBe("石门前");
    expect(timelineExcerpt("abcdefghijklmnopqrstuvwxyz", 8)).toBe("abcdefg…");
  });

  it("exposes navigable ticks and the active activity summary", () => {
    const first = document.createElement("article");
    first.id = "message:one";
    const second = document.createElement("article");
    second.id = "message:two";
    document.body.append(first, second);
    const scrollIntoView = vi.fn();
    second.scrollIntoView = scrollIntoView;

    render(<WorldTimelineRail entries={entries} reducedMotion step={2} />);

    expect(screen.getByRole("complementary", { name: "世界消息时间线" })).toBeVisible();
    expect(screen.queryByText("石门前")).not.toBeInTheDocument();
    fireEvent.mouseEnter(screen.getByRole("button", { name: /第 1 步，石门前/ }));
    expect(screen.getByText("石门前")).toBeVisible();
    vi.useFakeTimers();
    fireEvent.mouseLeave(screen.getByRole("button", { name: /第 1 步，石门前/ }));
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByText("石门前")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /第 2 步，门后/ }));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    expect(screen.getByRole("button", { name: /第 2 步，门后/ })).toHaveAttribute("aria-current", "location");
    expect(screen.getByText("2.00 / 10 米")).toBeVisible();
    expect(screen.getByRole("button", { name: /门后的道路向黑暗深处延伸/ })).toBeInTheDocument();
  });

  it("keeps arrows and the track inside one shared axis", () => {
    const { container } = render(<WorldTimelineRail entries={entries} reducedMotion step={2} />);
    const axis = container.querySelector(".cg-timeline-rail__axis");

    expect(axis).not.toBeNull();
    expect(axis?.querySelector(".cg-timeline-rail__track")).not.toBeNull();
    expect(axis?.querySelectorAll(".cg-timeline-rail__arrow")).toHaveLength(2);
  });

  it("holds the navigation target while smooth scrolling reports an intermediate entry", () => {
    const observers: MockTimelineObserver[] = [];
    vi.stubGlobal("IntersectionObserver", class extends MockTimelineObserver {
      constructor(callback: IntersectionObserverCallback) {
        super(callback);
        observers.push(this);
      }
    });
    const viewport = document.createElement("div");
    viewport.dataset.cgThreadViewport = "true";
    viewport.getBoundingClientRect = () => timelineRect(0, 1000);
    const first = document.createElement("article");
    const second = document.createElement("article");
    first.id = "message:one";
    second.id = "message:two";
    let firstTop = -500;
    first.getBoundingClientRect = () => timelineRect(firstTop, 100);
    second.getBoundingClientRect = () => timelineRect(100, 100);
    viewport.append(first, second);
    document.body.append(viewport);

    render(<WorldTimelineRail entries={entries} reducedMotion={false} step={2} />);
    fireEvent.click(screen.getByRole("button", { name: /第 2 步，门后/ }));
    const previous = screen.getByRole("button", { name: "上一条世界回复" });
    fireEvent.click(previous);
    expect(previous).toBeDisabled();

    observers[0]?.trigger([{ target: second, isIntersecting: true, intersectionRatio: 1 }]);
    expect(previous).toBeDisabled();

    firstTop = 0;
    observers[0]?.trigger([{ target: first, isIntersecting: true, intersectionRatio: 1 }]);
    expect(previous).toBeDisabled();
  });

  it("projects every committed response with stable revision-aware ids", () => {
    const detail = {
      conversation: {
        turns: [{
          id: "turn-1",
          responses: [
            { revision: 3, step: 2, title: "第一段", text: "先听见风。" },
            { revision: 4, step: 2, title: "第二段", text: "再看见门。", activity: null },
          ],
        }],
      },
    } as unknown as PublicInstanceDetail;

    expect(participantTimeline(detail)).toEqual([
      {
        id: "timeline:turn-1:3:0",
        targetId: "turn-1:world:3:0",
        kind: "world",
        step: 2,
        revision: 3,
        title: "第一段",
        excerpt: "先听见风。",
      },
      {
        id: "timeline:turn-1:4:1",
        targetId: "turn-1:world:4:1",
        kind: "world",
        step: 2,
        revision: 4,
        title: "第二段",
        excerpt: "再看见门。",
      },
    ]);
  });

  it("keeps observer timeline entries inside the selected perspective", () => {
    const observer = {
      selected: {
        perspective: {
          agentId: "keeper",
          history: [
            { revision: 2, step: 1, ownAction: "推开石门。", observations: [{ summary: "守门人看见石门。" }] },
            { revision: 3, step: 2, ownAction: null, observations: [{ summary: "守门人听见风声。" }] },
          ],
        },
      },
    } as unknown as WorldObserverDetail;

    expect(observerTimeline(observer).map((entry) => entry.targetId)).toEqual([
      "perspective:keeper:2:action",
      "perspective:keeper:2:observation",
      "perspective:keeper:3:observation",
    ]);
    expect(observerTimeline(observer).map((entry) => entry.kind)).toEqual(["player", "world", "world"]);
    expect(observerTimeline(undefined)).toEqual([]);
  });

  it("projects a player action before its committed world responses", () => {
    const detail = {
      conversation: {
        turns: [{
          id: "turn-1",
          action: { submissionId: "submission-1", text: "沿着河岸继续走。" },
          responses: [{ revision: 3, step: 2, title: "河岸", text: "水声在左侧变得清晰。" }],
        }],
      },
    } as unknown as PublicInstanceDetail;

    expect(participantTimeline(detail).map(({ kind, targetId, title }) => ({ kind, targetId, title }))).toEqual([
      { kind: "player", targetId: "turn-1:action", title: "你的行动" },
      { kind: "world", targetId: "turn-1:world:3:0", title: "河岸" },
    ]);
  });

  it("keeps failed actions on the rail without inventing a world step", () => {
    const detail = {
      conversation: {
        turns: [{
          id: "turn-failed",
          baseRevision: 8,
          status: "failed",
          action: { submissionId: "submission-failed", text: "冲向浓雾。" },
        }],
      },
    } as unknown as PublicInstanceDetail;

    expect(participantTimeline(detail)).toEqual([{
      id: "timeline:turn-failed:action",
      targetId: "turn-failed:action",
      kind: "player",
      revision: 8,
      title: "回应暂未完成",
      excerpt: "冲向浓雾。",
      outcome: "incomplete",
    }]);
  });
});
