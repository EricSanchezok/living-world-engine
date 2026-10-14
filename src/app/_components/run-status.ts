import type { PublicWorldRun } from "../../shared/world-api";

export type RunStatusPresentation = {
  title: string;
  detail: string;
};

/**
 * A run can remain present in the UI while control is handed back to the
 * player. Presentation clocks must stop at those boundaries instead of
 * turning user think-time into execution time.
 */
export function isRunClockPaused(status: PublicWorldRun["status"]): boolean {
  return status === "debug-paused" || status === "awaiting-decision" ||
    status === "awaiting-reaction" || status === "paused" ||
    status === "budget-paused" || status === "preparation-invalidated";
}

function activityDescription(run: PublicWorldRun): string | undefined {
  const activity = run.activity;
  if (!activity) return undefined;
  if (activity.status === "queued") {
    return `等待${activity.resourceNames.join("、") || "资源"} · 队列 ${activity.queuePosition ?? 1}`;
  }
  if (activity.status === "ready") return "资源已预留 · 等待推进";
  const stage = activity.stage ?? "活动推进中";
  if (!activity.progress) return stage;
  return `${stage} · ${activity.progress.current.toFixed(2)} / ${activity.progress.target} ${activity.progress.unit}`;
}

export function runStatusPresentation(run: PublicWorldRun, hasParticipantAction = false): RunStatusPresentation {
  if (run.debug.mode === "step" && (run.status === "queued" || run.status === "running")) {
    return run.debug.stageKey ? {
      title: `阶段 ${run.debug.stageIndex + 1} / ${run.debug.stageCount} · ${run.debug.stageLabel ?? run.debug.stageKey}`,
      detail: "正在执行当前逻辑阶段",
    } : {
      title: "正在准备单步推演",
      detail: "即将在第一个逻辑阶段前暂停",
    };
  }
  let title: string;
  let detail: string;
  switch (run.status) {
    case "queued":
      title = "正在准备世界变化";
      detail = "正在整理眼前的变化。";
      break;
    case "pausing":
      title = "即将暂停";
      detail = "正在保存当前进度。";
      break;
    case "paused":
      title = "世界推进已暂停";
      detail = "可恢复，或提交新行动";
      break;
    case "debug-paused":
      title = run.debug.stageKey
        ? `阶段 ${run.debug.stageIndex + 1} / ${run.debug.stageCount} · ${run.debug.stageLabel ?? run.debug.stageKey}`
        : "等待第一个逻辑阶段";
      detail = "等待你的下一步";
      break;
    case "budget-paused":
      title = "本轮已达到上限";
      detail = "恢复后开启新一轮推进";
      break;
    case "preparation-invalidated":
      title = "需要重新准备";
      detail = run.debug.mode === "step"
        ? "单步证据已失效，请开始新的推演"
        : "情境有了变化，可以重新尝试。";
      break;
    case "running":
      title = hasParticipantAction ? "正在处理你的行动" : "世界正在自主推进";
      detail = hasParticipantAction ? "正在等待眼前的回应。" : "周围的人和事正在继续。";
      break;
    default:
      title = "世界正在推进";
      detail = "准备下一次世界变化";
  }
  return { title, detail: activityDescription(run) || detail };
}

export function runBoundaryLabel(run: PublicWorldRun): string | undefined {
  if (run.debug.mode !== "step") return undefined;
  const lease = run.lease;
  if (!lease) return "本轮推进准备中";
  return `本轮推进 ${lease.commitCount} / ${lease.maxCommits} 个世界边界`;
}

export function formatRunElapsed(
  startedAt?: string,
  now = Date.now(),
  endedAt?: string,
  pausedDurationMs = 0,
): string | undefined {
  if (!startedAt) return undefined;
  const timestamp = Date.parse(startedAt);
  if (!Number.isFinite(timestamp)) return undefined;
  const endTimestamp = endedAt ? Date.parse(endedAt) : now;
  const effectiveNow = Number.isFinite(endTimestamp) ? endTimestamp : now;
  const seconds = Math.max(0, Math.floor((effectiveNow - timestamp - Math.max(0, pausedDurationMs)) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${String(remainder).padStart(2, "0")} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${String(minutes % 60).padStart(2, "0")} 分`;
}
