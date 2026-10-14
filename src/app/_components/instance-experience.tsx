"use client";

import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  Eye,
  FastForward,
  Pause,
  Play,
  Radio,
  UserRound,
  X,
} from "lucide-react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  ControlCandidate,
  PublicConversationTurn,
  PublicInstanceDetail,
  PublicInstanceSummary,
  PublicWorldRun,
} from "../../shared/world-api";
import type { WorldObserverDetail } from "../../shared/world-observer-api";
import { perspectiveMessages } from "../_lib/agent-perspective-messages";
import {
  parsePreferences,
  preferencesSnapshot,
  serverPreferencesSnapshot,
  subscribePreferences,
} from "../_lib/browser-state";
import { worldApi } from "../lib/world-api-client";
import { ControlOrb, type ControlOrbPhase } from "./control-orb";
import { GameThread, type ComposerMode } from "./game-thread";
import {
  formatRunElapsed,
  isRunClockPaused,
  runBoundaryLabel,
  runStatusPresentation,
} from "./run-status";
import { SettingsPanel } from "./settings-panel";
import { observerTimeline, participantTimeline } from "./world-timeline";
import WorldInspectorDialog from "./world-inspector-dialog";

const AgentPerspectiveWorkspace = dynamic(
  () => import("./agent-perspective-workspace").then((module) => module.AgentPerspectiveWorkspace),
  {
    ssr: false,
    loading: () => <p aria-live="polite" className="cg-muted">正在整理角色视角…</p>,
  },
);

type Overlay = "saves" | "settings" | "character" | "control" | null;

function assistantStatus(status: PublicConversationTurn["status"]): ThreadMessageLike["status"] {
  if (status === "running" || status === "awaiting") return { type: "running" };
  if (status === "paused") return { type: "incomplete", reason: "cancelled" };
  if (status === "failed") return { type: "incomplete", reason: "error" };
  return { type: "complete", reason: "stop" };
}

function PlayerRunConsole({
  busy,
  hasParticipantAction,
  run,
  onPause,
  onNext,
  onResume,
}: {
  busy: boolean;
  hasParticipantAction?: boolean;
  run: PublicWorldRun;
  onPause: () => void;
  onNext: () => void;
  onResume: () => void;
}) {
  const debugPaused = run.status === "debug-paused" && run.debug.canAdvance;
  const resumable = run.debug.mode !== "step" && (run.status === "paused" ||
    run.status === "budget-paused" || run.status === "preparation-invalidated");
  const [now, setNow] = useState(() => Date.now());
  const clockPaused = isRunClockPaused(run.status);
  const updatedAtTimestamp = Date.parse(run.updatedAt);
  const elapsedNow = Number.isFinite(updatedAtTimestamp) ? Math.max(now, updatedAtTimestamp) : now;
  const presentation = runStatusPresentation(run, Boolean(run.status === "running" && hasParticipantAction));
  const boundaryLabel = runBoundaryLabel(run);
  const elapsed = formatRunElapsed(
    run.lease?.startedAt,
    elapsedNow,
    clockPaused ? run.updatedAt : undefined,
    run.lease?.suspendedDurationMs ?? 0,
  );

  useEffect(() => {
    if (!run.lease?.startedAt) return;
    const refresh = window.setTimeout(() => setNow(Date.now()), 0);
    if (clockPaused) return () => window.clearTimeout(refresh);
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearTimeout(refresh);
      window.clearInterval(timer);
    };
  }, [clockPaused, run.lease?.startedAt]);

  return (
    <div aria-label="世界运行控制台" className="cg-thread-status" data-run-status={run.status} role="status">
      <span aria-hidden="true" className="cg-thread-status__indicator" />
      <div className="cg-thread-status__copy">
        <strong>{presentation.title}</strong>
        <div className="cg-thread-status__meta">
          <span>{presentation.detail}</span>
          {boundaryLabel ? <span>{boundaryLabel}</span> : null}
          {elapsed ? <span>已运行 {elapsed}</span> : null}
        </div>
      </div>
      {debugPaused ? (
        <button className="cg-thread-status__action" disabled={busy} onClick={onNext} type="button"><FastForward aria-hidden="true" /> 下一步</button>
      ) : run.debug.mode === "step" ? null : (
        <button className="cg-thread-status__action" disabled={busy || run.status === "pausing"} onClick={resumable ? onResume : onPause} type="button">
          {resumable ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
          {run.status === "preparation-invalidated" ? "重新准备" : resumable ? "恢复" : "暂停"}
        </button>
      )}
    </div>
  );
}

function ReactionConsole({
  busy,
  stimulus,
  onKeep,
}: {
  busy: boolean;
  stimulus: string;
  onKeep: () => void;
}) {
  return (
    <div className="cg-thread-status" aria-label="行动反应窗口" role="status">
      <div className="cg-thread-status__copy">
        <strong>世界时间已冻结，等待你的反应</strong>
        <span>{stimulus} 直接在输入框描述新行动，或保持当前行动。</span>
      </div>
      <button className="cg-thread-status__action" disabled={busy} onClick={onKeep} type="button">
        <Play aria-hidden="true" />保持当前行动
      </button>
    </div>
  );
}

function DecisionConsole() {
  return (
    <div className="cg-thread-status" aria-label="行动决策窗口" role="status">
      <div className="cg-thread-status__copy">
        <strong>轮到你决定下一步</strong>
        <span>描述一个自然语言行动，世界会从当前边界继续推进。</span>
      </div>
    </div>
  );
}

function ActionSubmitConsole() {
  return (
    <div className="cg-thread-status" aria-label="行动提交状态" role="status">
      <div className="cg-thread-status__copy">
        <strong>正在确认行动</strong>
        <span>已收到你的行动，正在等待眼前的回应。</span>
      </div>
    </div>
  );
}

function participantMessages(
  detail: PublicInstanceDetail,
  optimistic?: { id: string; text: string; at: string },
): ThreadMessageLike[] {
  const turns = detail.conversation?.turns ?? [];
  const messages = turns.flatMap((turn): ThreadMessageLike[] => {
    const responses = turn.responses?.length ? turn.responses : turn.response ? [turn.response] : [];
    const assistants: ThreadMessageLike[] = responses.length > 0 ? responses.map((response, index) => {
      return {
        id: response.id ? `${turn.id}:world:${response.id}` : `${turn.id}:world:${response.revision}:${index}`,
        role: "assistant" as const,
        content: [{ type: "text" as const, text: response.title
          ? `${response.title}\n\n${response.text}`
          : response.text }],
        metadata: { custom: { worldTimeSeconds: response.worldTimeSeconds, activityStage: response.activity?.stage } },
        createdAt: new Date(turn.createdAt),
        status: assistantStatus(response.narrativeStatus === "complete" || response.narrativeStatus === "fallback" ? "committed" : turn.status),
      };
    }) : [{
      id: `${turn.id}:world`,
      role: "assistant" as const,
      content: [{ type: "text" as const, text: turn.status === "failed"
        ? "这次尝试暂时没有得到完整回应。已经发生的变化会保留，你可以继续或重试。"
        : "世界正在推演…" }],
      createdAt: new Date(turn.createdAt),
      status: assistantStatus(turn.status),
    }];
    if (!turn.action) return assistants;
    return [{
      id: `${turn.id}:action`,
      role: "user",
      content: [{ type: "text", text: turn.action.text }],
      createdAt: new Date(turn.createdAt),
    }, ...assistants];
  });
  if (optimistic && !turns.some((turn) => turn.action?.submissionId === optimistic.id)) {
    messages.push({
      id: `optimistic:${optimistic.id}:action`,
      role: "user",
      content: [{ type: "text", text: optimistic.text }],
      createdAt: new Date(optimistic.at),
    }, {
      id: `optimistic:${optimistic.id}:world`,
      role: "assistant",
      content: [{ type: "text", text: "世界正在推演…" }],
      createdAt: new Date(optimistic.at),
      status: { type: "running" },
    });
  }
  return messages;
}

function observerMessages(observer?: WorldObserverDetail): ThreadMessageLike[] {
  return perspectiveMessages(observer?.selected?.perspective).map((message) => ({
    id: message.id,
    role: message.role,
    content: [{ type: "text", text: message.text }],
    ...(message.role === "assistant" ? { status: { type: "complete" as const, reason: "stop" as const } } : {}),
  }));
}

function worldClock(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const remainder = safeSeconds % 60;
  if (hours > 0) return `${hours} 小时 ${String(minutes).padStart(2, "0")} 分`;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function WorldContext({
  detail,
  roleView,
}: {
  detail: PublicInstanceDetail;
  roleView?: PublicInstanceDetail["controlledView"];
}) {
  return (
    <header aria-label="世界上下文" className="cg-game__context">
      <div className="cg-game__context-primary">
        <span>{detail.world.name}</span>
        <small>{roleView?.self.location?.name ?? "世界观察"}</small>
      </div>
      <div className="cg-game__context-secondary">
        <span>{worldClock(detail.summary.elapsedSeconds)}</span>
        <small>Step {detail.summary.step}</small>
      </div>
    </header>
  );
}

function GameOverlay({
  children,
  description,
  onOpenChange,
  open,
  title,
}: {
  children: React.ReactNode;
  description: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  title: string;
}) {
  return (
    <Dialog.Root onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal>
        <Dialog.Overlay className="cg-modal-overlay" />
        <Dialog.Content
          aria-describedby="cg-game-overlay-description"
          className="cg-game-overlay cg-modal-surface"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            window.setTimeout(() => {
              document.querySelector<HTMLButtonElement>("[data-cg-orb-trigger]")?.focus();
            }, 0);
          }}
        >
          <header className="cg-game-overlay__header">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Description id="cg-game-overlay-description">{description}</Dialog.Description>
          </header>
          <div className="cg-game-overlay__body cg-modal-scroll" tabIndex={0}>{children}</div>
          <Dialog.Close aria-label={`关闭${title}`} className="cg-modal-close">
            <X aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SaveManager({
  currentId,
  instances,
}: {
  currentId: string;
  instances: readonly PublicInstanceSummary[];
}) {
  return (
    <section className="cg-overlay-section">
      <p className="cg-eyebrow">当前世界</p>
      <h2>存档</h2>
      <p>每个世界实例都是自动保存的持续旅程。</p>
      <ul className="cg-overlay-list">
        {instances.map((instance) => (
          <li data-current={instance.id === currentId || undefined} key={instance.id}>
            <Link href={`/play/${encodeURIComponent(instance.id)}`}>
              <strong>{instance.title}</strong>
              <span>Revision {instance.revision} · Step {instance.step}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ObserverConsole({
  busy,
  detail,
  observer,
  onAdvance,
  onOpenCharacter,
  onSelectAgent,
  onTakeOver,
  onToggleRealtime,
}: {
  busy: boolean;
  detail: PublicInstanceDetail;
  observer?: WorldObserverDetail;
  onAdvance: (steps: number) => void;
  onOpenCharacter: () => void;
  onSelectAgent: (agentId: string) => void;
  onTakeOver: () => void;
  onToggleRealtime: () => void;
}) {
  const selected = observer?.selected?.agent.id ?? "";
  return (
    <div className="cg-observer-console" aria-label="无人演化控制台">
      <label>
        <span className="cg-sr-only">观察角色</span>
        <select disabled={busy || !observer} onChange={(event) => onSelectAgent(event.target.value)} value={selected}>
          {observer?.agents.map((agent) => (
            <option key={agent.id} value={agent.id}>{agent.name}{agent.location ? ` · ${agent.location}` : ""}</option>
          ))}
        </select>
      </label>
      <button disabled={busy} onClick={() => onAdvance(1)} type="button"><Play aria-hidden="true" />单步</button>
      <button disabled={busy} onClick={() => onAdvance(10)} type="button"><FastForward aria-hidden="true" />十步</button>
      <button disabled={busy} onClick={onToggleRealtime} type="button">
        {detail.summary.schedulerMode === "realtime" ? <Pause aria-hidden="true" /> : <Radio aria-hidden="true" />}
        {detail.summary.schedulerMode === "realtime" ? "暂停" : "实时"}
      </button>
      <button disabled={!observer?.selected} onClick={onOpenCharacter} type="button"><UserRound aria-hidden="true" />视角</button>
      <button className="cg-observer-console__primary" disabled={busy || !observer?.selected} onClick={onTakeOver} type="button">
        接管
      </button>
    </div>
  );
}

export function InstanceExperience({ instanceId }: { instanceId: string }) {
  const router = useRouter();
  const [detail, setDetail] = useState<PublicInstanceDetail>();
  const [observer, setObserver] = useState<WorldObserverDetail>();
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [streamWarning, setStreamWarning] = useState("");
  const [optimistic, setOptimistic] = useState<{ id: string; text: string; at: string }>();
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [instances, setInstances] = useState<PublicInstanceSummary[]>([]);
  const [controlCandidates, setControlCandidates] = useState<ControlCandidate[]>([]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const serializedPreferences = useSyncExternalStore(
    subscribePreferences,
    preferencesSnapshot,
    serverPreferencesSnapshot,
  );
  const preferences = useMemo(() => parsePreferences(serializedPreferences), [serializedPreferences]);

  const loadObserver = useCallback(async (agentId?: string) => {
    const next = await worldApi.observer(instanceId, agentId);
    setObserver(next);
    setSelectedAgentId(next.selected?.agent.id ?? "");
    return next;
  }, [instanceId]);

  const refresh = useCallback(async () => {
    const next = await worldApi.instance(instanceId);
    setDetail(next);
    if (!next.controlledView) await loadObserver(selectedAgentId || undefined);
    else setObserver(undefined);
    return next;
  }, [instanceId, loadObserver, selectedAgentId]);

  useEffect(() => {
    let active = true;
    void worldApi.instance(instanceId).then(async (next) => {
      if (!active) return;
      setDetail(next);
      if (!next.controlledView) {
        const perspective = await worldApi.observer(instanceId);
        if (!active) return;
        setObserver(perspective);
        setSelectedAgentId(perspective.selected?.agent.id ?? "");
      }
    }).catch(() => {
      if (active) setError("这个世界暂时无法打开。");
    });
    return () => { active = false; };
  }, [instanceId]);

  useEffect(() => {
    if (!detail || detail.summary.schedulerMode !== "realtime" &&
      !["queued", "running", "pausing"].includes(detail.summary.runStatus ?? "")) return;
    const timer = window.setInterval(() => {
      void refresh().catch(() => setStreamWarning("最新进度暂时无法同步，正在自动重试。"));
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [detail, refresh]);

  useEffect(() => {
    const source = new EventSource(worldApi.instanceEventsUrl(instanceId));
    source.addEventListener("changed", () => {
      void refresh().then(() => setStreamWarning("")).catch(() => {
        setStreamWarning("最新进度暂时无法同步，正在自动重试。");
      });
    });
    source.onopen = () => setStreamWarning("");
    source.onerror = () => setStreamWarning("实时更新暂时中断，正在自动重连。");
    return () => source.close();
  }, [instanceId, refresh]);

  const messages = useMemo(
    () => detail?.controlledView
      ? participantMessages(detail, optimistic)
      : observerMessages(observer),
    [detail, observer, optimistic],
  );
  const participant = detail?.controlledView
    ? detail.participants.find((candidate) => candidate.agentId === detail.controlledView!.agentId)
    : undefined;
  const latestTurn = detail?.conversation?.turns.at(-1);
  const reactionWindow = detail?.actionWindow?.kind === "reaction" && detail.actionWindow.reaction &&
    !detail.actionWindow.submittedAgentIds.includes(participant?.agentId ?? "")
    ? detail.actionWindow
    : undefined;
  const runActive = detail?.run && ["queued", "running", "pausing"].includes(detail.run.status);
  const worldProcessing = Boolean(!reactionWindow && (busy === "action" || runActive || latestTurn?.status === "running"));
  const composerMode: ComposerMode = detail?.controlledView && !busy && !worldProcessing &&
    !(detail.run?.status === "awaiting-reaction" && !reactionWindow)
    ? "available"
    : "suppressed";

  const submit = useCallback(async (message: AppendMessage) => {
    const text = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text || !detail || !participant || busy) return;
    const id = crypto.randomUUID();
    setOptimistic({ id, text, at: new Date().toISOString() });
    setBusy("action");
    setError("");
    try {
      const next = reactionWindow ? await worldApi.submitReaction(instanceId, participant.id, {
        submissionId: id,
        windowId: reactionWindow.id,
        generation: reactionWindow.generation,
        preparedStepId: reactionWindow.reaction!.preparedStepId,
        expectedRevision: detail.summary.revision,
        kind: "replace",
        text,
      }) : await worldApi.submitAction(instanceId, participant.id, {
          submissionId: id,
          expectedRevision: detail.summary.revision,
          text,
        });
      setDetail(next);
      setStreamWarning("");
    } catch {
      await refresh().catch(() => undefined);
      setError("行动暂时无法提交。请确认世界状态后重试。");
    } finally {
      setOptimistic(undefined);
      setBusy("");
    }
  }, [busy, detail, instanceId, participant, reactionWindow, refresh]);

  const keepReaction = useCallback(async () => {
    if (!detail || !participant || !reactionWindow || busy) return;
    setBusy("reaction");
    setError("");
    try {
      const next = await worldApi.submitReaction(instanceId, participant.id, {
        submissionId: crypto.randomUUID(),
        windowId: reactionWindow.id,
        generation: reactionWindow.generation,
        preparedStepId: reactionWindow.reaction!.preparedStepId,
        expectedRevision: detail.summary.revision,
        kind: "keep",
      });
      setDetail(next);
    } catch {
      await refresh().catch(() => undefined);
      setError("反应暂时无法提交。请刷新后重试。");
    } finally {
      setBusy("");
    }
  }, [busy, detail, instanceId, participant, reactionWindow, refresh]);

  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (message) => message,
    isRunning: worldProcessing,
    isSendDisabled: composerMode === "suppressed",
    onNew: submit,
  });

  const timeline = useMemo(
    () => detail?.controlledView ? participantTimeline(detail) : observerTimeline(observer),
    [detail, observer],
  );

  async function perform(key: string, operation: () => Promise<PublicInstanceDetail>): Promise<void> {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      const next = await operation();
      setDetail(next);
      if (!next.controlledView) await loadObserver(selectedAgentId || undefined);
      else setObserver(undefined);
    } catch {
      setError("世界暂时无法完成这个操作，请稍后重试。");
    } finally {
      setBusy("");
    }
  }

  async function openOverlay(next: Exclude<Overlay, null>): Promise<void> {
    if (next === "saves") {
      const result = await worldApi.instances();
      setInstances(result.instances.filter((instance) => instance.worldId === detail?.world.id));
    }
    if (next === "control") {
      const result = await worldApi.controlOptions(instanceId);
      setControlCandidates(result.agents);
    }
    setOverlay(next);
  }

  if (!detail) {
    return <main className="cg-game-loading" aria-live="polite">{error || "正在唤醒世界…"}</main>;
  }

  const roleView = detail.controlledView ?? observer?.selected?.perspective;
  const possibleNextActions = detail.conversation?.turns.find((turn) => !turn.action)?.response?.possibleNextActions ?? [];
  const orbPhase: ControlOrbPhase = worldProcessing ? "running" : busy ? "confirming" : "saved";
  const footerKey = !detail.controlledView
    ? "observer"
    : busy === "action"
      ? "action-submit"
      : reactionWindow
        ? `reaction:${reactionWindow.id}`
        : detail.run?.status === "awaiting-decision"
          ? "decision"
          : detail.run && [
            "queued",
            "running",
            "pausing",
            "paused",
            "budget-paused",
            "debug-paused",
            "preparation-invalidated",
          ].includes(detail.run.status)
            ? `run:${detail.run.id}:${detail.run.status}:${detail.run.debug.stageIndex}:${detail.run.debug.stageKey ?? ""}`
            : preferences.advancedRoleControl
              ? "control"
              : "none";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="cg-game">
        <h1 className="cg-sr-only">{detail.summary.title}</h1>
        <WorldContext detail={detail} roleView={roleView} />
        <GameThread
          actionError={error}
          busy={worldProcessing}
          composerMode={composerMode}
          footerKey={footerKey}
          footer={!detail.controlledView ? (
            <ObserverConsole
              busy={Boolean(busy)}
              detail={detail}
              observer={observer}
              onAdvance={(steps) => void perform(steps === 1 ? "step" : "batch", () => worldApi.advance(instanceId, {
                expectedRevision: detail.summary.revision,
                trigger: steps === 1 ? "manual" : "batch",
                steps,
              }))}
              onOpenCharacter={() => setOverlay("character")}
              onSelectAgent={(agentId) => {
                setSelectedAgentId(agentId);
                void loadObserver(agentId).catch(() => setError("这个角色视角暂时无法读取。"));
              }}
              onTakeOver={() => {
                const agentId = observer?.selected?.agent.id;
                if (agentId) void perform("takeover", () => worldApi.transferControl(instanceId, {
                  expectedRevision: detail.summary.revision,
                  target: { kind: "agent", agentId },
                }));
              }}
              onToggleRealtime={() => void perform("realtime", () => worldApi.realtime(
                instanceId,
                detail.summary.schedulerMode !== "realtime",
              ))}
            />
          ) : busy === "action" ? (
            <ActionSubmitConsole />
          ) : reactionWindow ? (
            <ReactionConsole
              busy={Boolean(busy)}
              onKeep={() => void keepReaction()}
              stimulus={reactionWindow.reaction!.stimulus}
            />
          ) : detail.run?.status === "awaiting-decision" ? (
            <>
              <DecisionConsole />
              {preferences.advancedRoleControl ? (
                <button className="cg-detach-button cg-detach-button--quiet" onClick={() => void openOverlay("control")} type="button">
                  切换或离开角色
                </button>
              ) : null}
            </>
          ) : detail.run && [
            "queued",
            "running",
            "pausing",
            "paused",
            "budget-paused",
            "debug-paused",
            "preparation-invalidated",
          ].includes(detail.run.status) ? (
            <>
              <PlayerRunConsole
                hasParticipantAction={Boolean(latestTurn?.action)}
                busy={Boolean(busy)}
                onPause={() => void perform("pause-run", () => worldApi.pauseRun(instanceId, {
                  runId: detail.run!.id,
                  generation: detail.run!.generation,
                }))}
                onNext={() => {
                  const currentRun = detail.run;
                  const checkpointId = currentRun?.debug.checkpointId;
                  if (!currentRun || !checkpointId) return;
                  void perform("debug-next", () => worldApi.nextDebugStep(instanceId, {
                    runId: currentRun.id,
                    generation: currentRun.generation,
                    checkpointId,
                    requestId: crypto.randomUUID(),
                  }));
                }}
                onResume={() => void perform("resume-run", () => worldApi.resumeRun(instanceId, {
                  runId: detail.run!.id,
                  generation: detail.run!.generation,
                }))}
                run={detail.run}
              />
              {preferences.advancedRoleControl ? (
                <button className="cg-detach-button cg-detach-button--quiet" onClick={() => void openOverlay("control")} type="button">
                  切换或离开角色
                </button>
              ) : null}
            </>
          ) : preferences.advancedRoleControl ? (
            <button className="cg-detach-button" onClick={() => void openOverlay("control")} type="button">
              切换或离开角色
            </button>
          ) : undefined}
          readOnly={!detail.controlledView}
          reduceMotion={preferences.reduceMotion}
          streamWarning={streamWarning}
          suggestions={possibleNextActions}
          timeline={timeline}
          timelineStep={detail.summary.step}
        />
        <ControlOrb
          composerDocked={messages.length > 0}
          inspectorEnabled={preferences.showWorldInspector}
          notice={error
            ? { id: `error:${error}`, message: error, tone: "error" }
            : streamWarning
              ? { id: `warning:${streamWarning}`, message: streamWarning, tone: "warning" }
              : undefined}
          onAction={(kind) => {
            if (kind === "exit") router.push("/");
            else void openOverlay(kind);
          }}
          onOpenInspector={() => setInspectorOpen(true)}
          reduceMotion={preferences.reduceMotion}
          status={{
            elapsedSeconds: detail.summary.elapsedSeconds,
            phase: orbPhase,
            sessionTitle: detail.summary.title,
            step: detail.summary.step,
            worldContentHash: detail.world.contentHash,
            worldName: detail.world.name,
          }}
        />

        <GameOverlay
          description="查看同一世界中的自动存档。"
          onOpenChange={(open) => { if (!open) setOverlay(null); }}
          open={overlay === "saves"}
          title="存档"
        >
          <SaveManager currentId={instanceId} instances={instances} />
        </GameOverlay>
        <GameOverlay
          description="调整外观、阅读体验和高级工具。"
          onOpenChange={(open) => { if (!open) setOverlay(null); }}
          open={overlay === "settings"}
          title="设置"
        >
          <SettingsPanel
            debugSteppingEnabled={detail.summary.debugSteppingEnabled}
            instanceId={instanceId}
            onUpdated={setDetail}
            revision={detail.summary.revision}
          />
        </GameOverlay>
        <GameOverlay
          description="这里只显示当前角色被允许知道的内容。"
          onOpenChange={(open) => { if (!open) setOverlay(null); }}
          open={overlay === "character"}
          title="视角"
        >
          {overlay === "character" && roleView ? (
            <AgentPerspectiveWorkspace perspective={roleView} reduceMotion={preferences.reduceMotion} />
          ) : <p className="cg-muted">请先选择一个 Agent 视角。</p>}
        </GameOverlay>
        <GameOverlay
          description="控制转移只会在当前 Revision 边界原子完成。"
          onOpenChange={(open) => { if (!open) setOverlay(null); }}
          open={overlay === "control"}
          title="切换或离开角色"
        >
          <section className="cg-overlay-section">
            <button
              className="cg-control-choice"
              disabled={Boolean(busy)}
              onClick={() => void perform("detach", () => worldApi.transferControl(instanceId, {
                expectedRevision: detail.summary.revision,
                target: { kind: "observer" },
              })).then(() => setOverlay(null))}
              type="button"
            >
              <Eye aria-hidden="true" /><span><strong>进入观察模式</strong><small>把当前角色交还 AgentMind</small></span>
            </button>
            <h3>直接切换角色</h3>
            <div className="cg-control-candidates">
              {controlCandidates.map((candidate) => (
                <button
                  disabled={Boolean(busy)}
                  key={candidate.id}
                  onClick={() => void perform("switch", () => worldApi.transferControl(instanceId, {
                    expectedRevision: detail.summary.revision,
                    target: { kind: "agent", agentId: candidate.id },
                  })).then(() => setOverlay(null))}
                  type="button"
                >
                  <strong>{candidate.name}</strong><small>{candidate.location ?? "位置未知"}</small>
                </button>
              ))}
            </div>
          </section>
        </GameOverlay>

        {preferences.showWorldInspector && inspectorOpen ? (
          <WorldInspectorDialog
            instanceId={instanceId}
            onOpenChange={setInspectorOpen}
            open={inspectorOpen}
            reduceMotion={preferences.reduceMotion}
          />
        ) : null}
      </main>
    </AssistantRuntimeProvider>
  );
}
