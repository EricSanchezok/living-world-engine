import { describe, expect, it } from "vitest";
import type { PublicConversation, PublicWorldRun } from "../../shared/world-api";
import { formatRunElapsed, isRunClockPaused, runBoundaryLabel, runStatusPresentation, worldProgressPhase } from "./run-status";

function run(overrides: Partial<PublicWorldRun> = {}): PublicWorldRun {
  return {
    id: "run-1",
    generation: 1,
    updatedAt: "2026-08-29T08:00:00.000Z",
    status: "running",
    committedRevisions: [],
    stopReason: null,
    lease: {
      commitCount: 0,
      maxCommits: 100,
      maxWallTimeMs: 900_000,
      startedAt: "2026-08-29T08:00:00.000Z",
      suspendedDurationMs: 0,
    },
    activity: null,
    debug: {
      mode: "off",
      boundaryIndex: 0,
      stageIndex: 0,
      stageCount: 10,
      stageKey: null,
      stageLabel: null,
      checkpointId: null,
      canAdvance: false,
    },
    ...overrides,
  };
}

describe("run status presentation", () => {
  it("keeps an earlier unfinished reply in progress even when the latest turn is complete", () => {
    const conversation: PublicConversation = { participantId: "player", agentId: "traveler", suggestions: null,
      turns: ["running", "committed"].map((status, index) => ({ id: `turn-${index}`, agentId: "traveler",
        baseRevision: index, createdAt: `2026-10-17T02:00:0${index}Z`, status: status as "running" | "committed" })) };
    expect(worldProgressPhase({ run: run({ status: "awaiting-decision" }), conversation })).toBe("publishing");
    conversation.turns[0]!.status = "committed";
    expect(worldProgressPhase({ run: run({ status: "awaiting-decision" }), conversation })).toBeNull();
  });

  it("keeps execution active after a published reply but releases genuine pause boundaries", () => {
    for (const status of ["queued", "running", "pausing"] as const) {
      expect(worldProgressPhase({ run: run({ status }) })).toBe("executing");
    }
    for (const status of ["paused", "budget-paused", "debug-paused", "preparation-invalidated", "awaiting-reaction", "failed", "completed"] as const) {
      expect(worldProgressPhase({ run: run({ status }) })).toBeNull();
    }
  });

  it("explains an in-flight action even before a canonical activity exists", () => {
    const presentation = runStatusPresentation(run(), true);
    expect(presentation.title).toBe("正在处理你的行动");
    expect(presentation.detail).toBe("正在等待眼前的回应。");
    expect(runStatusPresentation(run({ status: "queued" }), true).detail).toBe("正在整理眼前的变化。");
  });

  it("uses real activity stage and progress without inventing a percentage", () => {
    const presentation = runStatusPresentation(run({
      activity: {
        id: "activity-1",
        status: "active",
        description: "搜寻失踪信使",
        stage: "侦查",
        progress: { current: 2, target: 10, unit: "米" },
        nextBoundaryAtSeconds: 12,
        completionAtSeconds: null,
        queuePosition: null,
        resourceNames: [],
      },
    }), true);
    expect(presentation.detail).toBe("侦查 · 2.00 / 10 米");
  });

  it("keeps lease counters in explicit debugging, outside ordinary play", () => {
    expect(runBoundaryLabel(run())).toBeUndefined();
    const debugging = run();
    debugging.debug.mode = "step";
    expect(runBoundaryLabel(debugging)).toBe("本轮推进 0 / 100 个世界边界");
  });

  it("shows the current logical stage while single-step debugging is paused", () => {
    expect(runStatusPresentation(run({
      status: "debug-paused",
      debug: {
        mode: "step",
        boundaryIndex: 0,
        stageIndex: 3,
        stageCount: 10,
        stageKey: "reaction-perception",
        stageLabel: "反应与感知",
        checkpointId: "checkpoint-1",
        canAdvance: true,
      },
    }))).toEqual({ title: "阶段 4 / 10 · 反应与感知", detail: "等待你的下一步" });
  });

  it("keeps the logical stage visible while a debug step is executing", () => {
    expect(runStatusPresentation(run({
      debug: {
        mode: "step",
        boundaryIndex: 0,
        stageIndex: 1,
        stageCount: 10,
        stageKey: "action-compilation",
        stageLabel: "行动编译",
        checkpointId: "checkpoint-1",
        canAdvance: false,
      },
    }))).toEqual({ title: "阶段 2 / 10 · 行动编译", detail: "正在执行当前逻辑阶段" });
  });

  it("does not describe an invalid debug continuation as resumable", () => {
    expect(runStatusPresentation(run({
      status: "preparation-invalidated",
      debug: {
        mode: "step",
        boundaryIndex: 0,
        stageIndex: 1,
        stageCount: 10,
        stageKey: "action-compilation",
        stageLabel: "行动编译",
        checkpointId: "checkpoint-1",
        canAdvance: false,
      },
    })).detail).toBe("单步证据已失效，请开始新的推演");
  });

  it("formats elapsed execution time", () => {
    expect(formatRunElapsed("2026-08-29T08:00:00.000Z", Date.parse("2026-08-29T08:01:12.000Z"))).toBe("1 分 12 秒");
  });

  it("freezes the presentation clock at the control-plane transition", () => {
    expect(isRunClockPaused("debug-paused")).toBe(true);
    expect(formatRunElapsed(
      "2026-08-29T08:00:00.000Z",
      Date.parse("2026-08-29T12:00:00.000Z"),
      "2026-08-29T08:00:04.000Z",
    )).toBe("4 秒");
    expect(formatRunElapsed(
      "2026-08-29T08:00:00.000Z",
      Date.parse("2026-08-29T08:01:12.000Z"),
      undefined,
      12_000,
    )).toBe("1 分 00 秒");
    expect(isRunClockPaused("running")).toBe(false);
  });
});
