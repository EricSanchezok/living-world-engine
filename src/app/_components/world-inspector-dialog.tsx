"use client";

import {
  ArrowDownToLine,
  Binoculars,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  GitBranch,
  LocateFixed,
  Pause,
  Play,
  RefreshCw,
  Search,
  Users,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  memo,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  startTransition,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { WorkspaceDialog } from "@/components/ui/workspace-dialog";
import type {
  WorldInspectorAttemptDetail,
  WorldInspectorAttemptSummary,
  WorldInspectorModelInvocationDetail,
  WorldInspectorModelInvocationSummary,
  WorldInspectorActor,
  WorldInspectorEdgeSummary,
  WorldInspectorNodeSummary,
  WorldInspectorStepDetail,
  WorldInspectorStepSummary,
  WorldInspectorStreamEvent,
  WorldInspectorReplay,
  WorldInspectorWindow,
} from "../../shared/world-inspector-api";
import { mergeWorldInspectorWindows } from "../_lib/world-inspector-window";
import { worldInspectorInvocationExecutionId } from "../_lib/world-inspector-invocation";
import {
  classifyWorldInspectorRuntimeEvent,
  WorldInspectorRefreshScheduler,
  type WorldInspectorRefreshDirty,
} from "../_lib/world-inspector-refresh";
import {
  WORLD_INSPECTOR_ACTOR_DEFAULT,
  WORLD_INSPECTOR_ACTOR_MAX,
  WORLD_INSPECTOR_ACTOR_MIN,
  WORLD_INSPECTOR_DETAIL_DEFAULT,
  WORLD_INSPECTOR_DETAIL_MAX,
  WORLD_INSPECTOR_DETAIL_MIN,
  clampWorldInspectorActorWidth,
  clampWorldInspectorDetailWidth,
  readWorldInspectorLayout,
  resizeWorldInspectorPanelWidth,
  writeWorldInspectorLayout,
  type WorldInspectorView,
} from "../_lib/world-inspector-preferences";
import { worldInspectorApi } from "../lib/world-inspector-api-client";
import { WorldInspectorDetail, type WorldInspectorSelection } from "./world-inspector-detail";
import { WorldInspectorAlgorithmComposition } from "./world-inspector-algorithm-composition";
import { WorldInspectorGraph } from "./world-inspector-graph";
import { WorldInspectorInvocationList, type WorldInspectorInvocationListItem } from "./world-inspector-invocation-list";
import { WorldInspectorSelect } from "./world-inspector-select";
import { WorldInspectorTimeline } from "./world-inspector-timeline";

const MemoizedWorldInspectorDetail = memo(WorldInspectorDetail);
const MemoizedWorldInspectorAlgorithmComposition = memo(WorldInspectorAlgorithmComposition);
const MemoizedWorldInspectorGraph = memo(WorldInspectorGraph);
const MemoizedWorldInspectorInvocationList = memo(WorldInspectorInvocationList);
const MemoizedWorldInspectorTimeline = memo(WorldInspectorTimeline);

type InspectorDetail =
  | { kind: "step"; value: WorldInspectorStepDetail }
  | { kind: "attempt"; value: WorldInspectorAttemptDetail };
type ResizablePanel = "actors" | "detail";
type CenterView = "calls" | "composition" | WorldInspectorView;

const narrowQuery = "(max-width: 52rem)";

function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(narrowQuery);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  );
}

function actorActivity(
  actorId: string,
  actor: WorldInspectorActor | undefined,
  steps: readonly WorldInspectorStepSummary[],
  attempts: readonly WorldInspectorAttemptSummary[],
): { attempts: number; steps: number; modelInvocations: number; transportAttempts: number; retries: number } {
  if (actor?.activity) return actor.activity;
  return {
    steps: steps.reduce((total, step) => total + (step.actorIds.includes(actorId) ? 1 : 0), 0),
    attempts: attempts.reduce((total, attempt) => total + (attempt.actorIds.includes(actorId) ? 1 : 0), 0),
    modelInvocations: 0,
    transportAttempts: 0,
    retries: 0,
  };
}

function sameInvocationSummary(
  left: WorldInspectorModelInvocationSummary,
  right: WorldInspectorModelInvocationSummary,
): boolean {
  return left.id === right.id && left.status === right.status && left.startedAt === right.startedAt &&
    left.updatedAt === right.updatedAt && left.retryCount === right.retryCount &&
    JSON.stringify(left.slotRefs) === JSON.stringify(right.slotRefs) && JSON.stringify(left.issues) === JSON.stringify(right.issues) &&
    left.eventIds.length === right.eventIds.length &&
    left.errorMessage === right.errorMessage && left.outputDisposition === right.outputDisposition &&
    left.tokenUsage.input === right.tokenUsage.input && left.tokenUsage.output === right.tokenUsage.output &&
    left.tokenUsage.reasoning === right.tokenUsage.reasoning && left.timings.invocationMs === right.timings.invocationMs &&
    left.timings.queueWaitMs === right.timings.queueWaitMs && left.timings.transportMs === right.timings.transportMs &&
    left.timings.parseMs === right.timings.parseMs && left.timings.retryDelayMs === right.timings.retryDelayMs &&
    left.logicalStageIndex === right.logicalStageIndex && left.logicalInvocationOrdinal === right.logicalInvocationOrdinal &&
    left.chainFinalDisposition === right.chainFinalDisposition && left.semanticRepairCount === right.semanticRepairCount &&
    JSON.stringify(left.lineage) === JSON.stringify(right.lineage);
}

function sameAttemptSummary(left: WorldInspectorAttemptSummary, right: WorldInspectorAttemptSummary): boolean {
  return left.id === right.id && JSON.stringify(left) === JSON.stringify(right);
}

function mergeInvocationSummaries(
  current: readonly WorldInspectorModelInvocationSummary[],
  incoming: readonly WorldInspectorModelInvocationSummary[],
): WorldInspectorModelInvocationSummary[] {
  if (current.length === incoming.length && incoming.every((item, index) => sameInvocationSummary(current[index]!, item))) {
    return current as WorldInspectorModelInvocationSummary[];
  }
  const previous = new Map(current.map((item) => [item.id, item]));
  return incoming.map((item) => {
    const old = previous.get(item.id);
    return old && sameInvocationSummary(old, item) ? old : item;
  });
}

const MemoizedWorldInspectorActors = memo(function WorldInspectorActors({
  actorsOpen,
  data,
  narrow,
  onSelect,
  selectedActorId,
  visibleActors,
  worldActivity,
}: {
  actorsOpen: boolean;
  data: WorldInspectorWindow;
  narrow: boolean;
  onSelect: (actorId: string) => void;
  selectedActorId: string;
  visibleActors: WorldInspectorActor[];
  worldActivity: { steps: number; attempts: number; modelInvocations: number; retries: number };
}) {
  return (
    <aside
      aria-hidden={narrow && !actorsOpen || undefined}
      aria-label="主体选择"
      className="cg-inspector-actors"
      data-open={actorsOpen || undefined}
      id="world-inspector-actors"
      inert={narrow && !actorsOpen || undefined}
    >
      <button
        aria-pressed={selectedActorId === "world"}
        className="cg-inspector-actor cg-inspector-actor--world"
        onClick={() => onSelect("world")}
        type="button"
      >
        <span><GitBranch aria-hidden="true" /></span>
        <span><strong>整个世界</strong><small>{worldActivity.steps} 个提交 · {worldActivity.attempts} 次尝试 · {worldActivity.modelInvocations} 次调用 · {worldActivity.retries} 次传输重试</small></span>
      </button>
      <div className="cg-inspector-actor-list">
        {visibleActors.map((actor) => {
          const activity = actorActivity(actor.id, actor, data.steps, data.attempts);
          return (
            <button
              aria-pressed={selectedActorId === actor.id}
              className="cg-inspector-actor"
              key={actor.id}
              onClick={() => onSelect(actor.id)}
              type="button"
            >
              <span className="cg-inspector-actor__sigil">{actor.name.slice(0, 1).toLocaleUpperCase()}</span>
              <span>
                <strong>{actor.name}</strong>
                <small>{activity.steps} 个提交 · {activity.attempts} 次尝试 · {activity.modelInvocations} 次调用 · {activity.retries} 次传输重试</small>
              </span>
              <i data-lifecycle={actor.lifecycle} title={actor.lifecycle} />
            </button>
          );
        })}
      </div>
      <footer>
        <span><ArrowDownToLine aria-hidden="true" /> {data.trace.retainedEventCount} 条追踪事件</span>
        <span>{data.trace.mode} · {data.trace.degraded ? "降级" : "完整"}</span>
      </footer>
    </aside>
  );
});

function InspectorCollectionHeader({
  actorName,
  data,
  view,
}: {
  actorName: string;
  data: WorldInspectorWindow;
  view: Exclude<CenterView, "calls">;
}) {
  const config = view === "timeline"
    ? { title: "世界演化流程", firstLabel: "执行尝试", first: `${data.attempts.length}`, secondLabel: "当前 Revision", second: `${data.instance.revision}` }
    : { title: "世界演化图谱", firstLabel: "语义节点", first: `${data.semanticNodes?.length ?? 0}`, secondLabel: "关系", second: `${data.semanticEdges?.length ?? 0}` };
  return (
    <header className="cg-inspector-collection-header">
      <div>
        <span>当前范围 · {actorName}</span>
        <h2>{config.title}</h2>
      </div>
      <dl>
        <div><dt>{config.firstLabel}</dt><dd>{config.first}</dd></div>
        <div><dt>{config.secondLabel}</dt><dd>{config.second}</dd></div>
      </dl>
    </header>
  );
}

function InspectorResizer({
  label,
  maximum,
  minimum,
  onKeyDown,
  onPointerCancel,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  value,
}: {
  label: string;
  maximum: number;
  minimum: number;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  value: number;
}) {
  return (
    <div
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemax={maximum}
      aria-valuemin={minimum}
      aria-valuenow={value}
      className="cg-inspector-resizer"
      onKeyDown={onKeyDown}
      onPointerCancel={onPointerCancel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="separator"
      tabIndex={0}
    />
  );
}

export default function WorldInspectorDialog({
  onOpenChange,
  open,
  reduceMotion,
  instanceId,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  reduceMotion: boolean;
  instanceId: string;
}) {
  const narrow = useNarrowViewport();
  const actorToggleRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const selectionRef = useRef<WorldInspectorSelection>(null);
  const detailRef = useRef<InspectorDetail | undefined>(undefined);
  const activeViewRef = useRef<CenterView>("calls");
  const invocationRequestRef = useRef(0);
  const invocationDetailRequestRef = useRef(0);
  const followLatestRef = useRef(true);
  const queriedInvocationsRef = useRef<WorldInspectorModelInvocationSummary[]>([]);
  const invocationDetailRef = useRef<WorldInspectorModelInvocationDetail | undefined>(undefined);
  const refreshPendingRef = useRef<WorldInspectorRefreshDirty>({ window: false, invocations: false, detail: false });
  const refreshRunningRef = useRef(false);
  const refreshSchedulerRef = useRef<WorldInspectorRefreshScheduler | undefined>(undefined);
  const resizeRef = useRef<{
    currentWidth: number;
    panel: ResizablePanel;
    startX: number;
    startWidth: number;
  } | undefined>(undefined);
  const [data, setData] = useState<WorldInspectorWindow>();
  const [detail, setDetail] = useState<InspectorDetail>();
  const [detailError, setDetailError] = useState("");
  const [invocationDetail, setInvocationDetail] = useState<WorldInspectorModelInvocationDetail>();
  const [searchError, setSearchError] = useState("");
  const [invocationError, setInvocationError] = useState("");
  const [loadingInvocation, setLoadingInvocation] = useState(false);
  const [queriedInvocations, setQueriedInvocations] = useState<WorldInspectorModelInvocationSummary[]>([]);
  const [invocationCursor, setInvocationCursor] = useState<string>();
  const [loadingMoreInvocations, setLoadingMoreInvocations] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [followLatest, setFollowLatest] = useState(true);
  const [actorsOpen, setActorsOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedActorId, setSelectedActorId] = useState("world");
  const [selection, setSelection] = useState<WorldInspectorSelection>(null);
  const [view, setView] = useState<CenterView>("calls");
  const [graphMode, setGraphMode] = useState<"semantic" | "technical">("semantic");
  const [technicalNodeLimit, setTechnicalNodeLimit] = useState<100 | 200 | 500 | 1000>(200);
  const [replay, setReplay] = useState<WorldInspectorReplay>();
  const [replayFrameIndex, setReplayFrameIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replayRate, setReplayRate] = useState<1 | 4 | 16>(1);
  const [actorWidth, setActorWidth] = useState(WORLD_INSPECTOR_ACTOR_DEFAULT);
  const [detailWidth, setDetailWidth] = useState(WORLD_INSPECTOR_DETAIL_DEFAULT);
  const activeView: CenterView = view;
  const replayFrame = replay?.frames[replayFrameIndex];
  const replaySemanticNodes = useMemo<WorldInspectorNodeSummary[]>(() => replay?.frames.map((frame) => ({
    id: frame.nodeIds[0] ?? `semantic:stage:${replay.executionId}:${frame.stageIndex}`,
    revision: data?.instance.revision ?? 0,
    laneId: "world",
    kind: "stage",
    label: `${frame.stageIndex + 1}. ${frame.stageLabel}`,
    description: frame.derived
      ? `由已有 Ledger 证据推导 · ${frame.eventIds.length} 条事件`
      : `${frame.eventIds.length} 条事件 · ${frame.invocationIds.length} 次逻辑调用`,
    ...(frame.status === "pending" ? {} : { status: frame.status }),
    relatedAttemptId: replay.executionId,
  })) ?? [], [data?.instance, replay]);
  const replaySemanticEdges = useMemo<WorldInspectorEdgeSummary[]>(() => replaySemanticNodes.slice(1).map((node, index) => ({
    id: `semantic:replay:${replaySemanticNodes[index].id}:${node.id}`,
    source: replaySemanticNodes[index].id,
    target: node.id,
    kind: "causal",
    label: "推进",
  })), [replaySemanticNodes]);
  const semanticNodes = useMemo(
    () => replay ? replaySemanticNodes : data?.semanticNodes ?? [],
    [data?.semanticNodes, replay, replaySemanticNodes],
  );
  const semanticEdges = useMemo(
    () => replay ? replaySemanticEdges : data?.semanticEdges ?? [],
    [data?.semanticEdges, replay, replaySemanticEdges],
  );
  const technicalNodes = useMemo(() => {
    const nodes = data?.nodes ?? [];
    if (!replay || !replayFrame) return nodes;
    const invocationIds = new Set(replayFrame.invocationIds);
    const stageNodeId = `stage:${replay.executionId}:stage:${replayFrame.stageIndex}`;
    return nodes.filter((node) => node.id === `attempt:${replay.executionId}` ||
      node.id === stageNodeId || node.relatedInvocationId && invocationIds.has(node.relatedInvocationId));
  }, [data?.nodes, replay, replayFrame]);
  const selectedNodeId = replayFrame?.nodeIds[0] ?? (selection?.kind === "attempt"
    ? `attempt:${selection.id}`
    : selection?.kind === "step"
      ? `commit:${selection.revision}`
      : selection?.kind === "node" ? selection.id : undefined);
  const effectiveSelection: WorldInspectorSelection = selection?.kind === "invocation"
    ? selection
    : replayFrame && selectedNodeId ? { kind: "node", id: selectedNodeId } : selection;
  const selectedInvocationId = selection?.kind === "invocation"
    ? invocationDetail?.lineage.kind === "repair"
      ? invocationDetail.repairChain.initialAttemptId
      : selection.id
    : undefined;
  const selectedGraphNode = effectiveSelection?.kind === "node"
    ? [...semanticNodes, ...technicalNodes].find((node) => node.id === effectiveSelection.id)
    : undefined;
  const graphNodeRelations = useMemo(() => {
    if (!selectedGraphNode || !data) return undefined;
    const graphNodes = graphMode === "semantic" ? semanticNodes : technicalNodes;
    const graphEdges = graphMode === "semantic" ? semanticEdges : data.edges;
    const byId = new Map(graphNodes.map((node) => [node.id, node]));
    return {
      upstream: graphEdges
        .filter((edge) => edge.target === selectedGraphNode.id)
        .map((edge) => byId.get(edge.source))
        .filter((node): node is WorldInspectorNodeSummary => node !== undefined),
      downstream: graphEdges
        .filter((edge) => edge.source === selectedGraphNode.id)
        .map((edge) => byId.get(edge.target))
        .filter((node): node is WorldInspectorNodeSummary => node !== undefined),
    };
  }, [data, graphMode, selectedGraphNode, semanticEdges, semanticNodes, technicalNodes]);
  const closeActorDrawer = useCallback(() => {
    setActorsOpen(false);
    if (narrow) requestAnimationFrame(() => actorToggleRef.current?.focus());
  }, [narrow]);

  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);

  useEffect(() => {
    detailRef.current = detail;
  }, [detail]);

  useEffect(() => {
    queriedInvocationsRef.current = queriedInvocations;
  }, [queriedInvocations]);

  useEffect(() => {
    invocationDetailRef.current = invocationDetail;
  }, [invocationDetail]);

  useEffect(() => {
    followLatestRef.current = followLatest;
  }, [followLatest]);

  useEffect(() => {
    activeViewRef.current = activeView;
  }, [activeView]);

  useEffect(() => {
    if (!open) return;
    const hydrateLayout = window.setTimeout(() => {
      const preferences = readWorldInspectorLayout();
      setView(preferences.view);
      setActorWidth(preferences.actorWidth);
      setDetailWidth(preferences.detailWidth);
    }, 0);
    return () => window.clearTimeout(hydrateLayout);
  }, [open]);

  const persistLayout = useCallback((next: {
    actorWidth?: number;
    detailWidth?: number;
    view?: WorldInspectorView;
  }) => {
    writeWorldInspectorLayout({
      actorWidth: next.actorWidth ?? actorWidth,
      detailWidth: next.detailWidth ?? detailWidth,
      view: next.view ?? (view === "calls" || view === "composition" ? "timeline" : view),
    });
  }, [actorWidth, detailWidth, view]);

  const chooseView = useCallback((next: WorldInspectorView) => {
    setView(next);
    persistLayout({ view: next });
    if (selection?.kind === "invocation") {
      setSelection(null);
      setInvocationDetail(undefined);
      setInvocationError("");
    }
  }, [persistLayout, selection]);

  const chooseCenterView = useCallback((next: CenterView) => {
    setView(next);
    if (next !== "calls" && next !== "composition") persistLayout({ view: next });
    if (next === "calls") {
      if (selection?.kind !== "invocation") {
        setSelection(null);
        setDetail(undefined);
        setDetailError("");
      }
    } else if (selection?.kind === "invocation") {
      setSelection(null);
      setInvocationDetail(undefined);
      setInvocationError("");
    }
  }, [persistLayout, selection]);

  const selectStep = useCallback(async (step: WorldInspectorStepSummary, nodeId = `commit:${step.revision}`) => {
    const request = ++detailRequestRef.current;
    invocationDetailRequestRef.current += 1;
    setSelection(nodeId === `commit:${step.revision}`
      ? { kind: "step", revision: step.revision }
      : { kind: "node", id: nodeId });
    setInvocationDetail(undefined);
    setInvocationError("");
    setLoadingDetail(true);
    setDetailError("");
    try {
      const value = await worldInspectorApi.step(instanceId, step.revision);
      if (request === detailRequestRef.current) setDetail({ kind: "step", value });
    } catch (reason) {
      if (request === detailRequestRef.current) {
        setDetailError(reason instanceof Error ? reason.message : "无法读取这一步的审计记录。");
      }
    } finally {
      if (request === detailRequestRef.current) setLoadingDetail(false);
    }
  }, [instanceId]);

  const loadInvocation = useCallback(async (invocation: WorldInspectorModelInvocationSummary, executionId: string, background = false) => {
    const request = ++invocationDetailRequestRef.current;
    setSelection({ kind: "invocation", id: invocation.id, executionId });
    if (!background) {
      setInvocationError("");
      setLoadingInvocation(true);
    }
    try {
      const value = await worldInspectorApi.modelInvocation(instanceId, executionId, invocation.id);
      if (request === invocationDetailRequestRef.current) {
        startTransition(() => setInvocationDetail(value));
      }
    } catch (reason) {
      if (request === invocationDetailRequestRef.current) {
        setInvocationError(reason instanceof Error ? reason.message : "无法读取这次模型调用的完整记录。");
      }
    } finally {
      if (!background && request === invocationDetailRequestRef.current) setLoadingInvocation(false);
    }
  }, [instanceId]);

  const loadInvocationById = useCallback(async (invocationId: string, executionId: string) => {
    const request = ++invocationDetailRequestRef.current;
    setSelection({ kind: "invocation", id: invocationId, executionId });
    setInvocationError("");
    setLoadingInvocation(true);
    try {
      const value = await worldInspectorApi.modelInvocation(instanceId, executionId, invocationId);
      if (request !== invocationDetailRequestRef.current) return;
      startTransition(() => setInvocationDetail(value));
    } catch (reason) {
      if (request === invocationDetailRequestRef.current) {
        setInvocationError(reason instanceof Error ? reason.message : "无法读取这次模型调用的完整记录。");
      }
    } finally {
      if (request === invocationDetailRequestRef.current) setLoadingInvocation(false);
    }
  }, [instanceId]);

  const selectAttempt = useCallback(async (attempt: WorldInspectorAttemptSummary, preserveInvocation = false, background = false) => {
    const request = ++detailRequestRef.current;
    const preservedInvocationId = preserveInvocation && selectionRef.current?.kind === "invocation"
      ? selectionRef.current.id : undefined;
    if (!preservedInvocationId) setSelection({ kind: "attempt", id: attempt.id });
    if (!preserveInvocation) {
      invocationDetailRequestRef.current += 1;
      setSelection({ kind: "attempt", id: attempt.id });
      setInvocationDetail(undefined);
      setInvocationError("");
    }
    if (!background) {
      setLoadingDetail(true);
      setDetailError("");
    }
    try {
      const value = await worldInspectorApi.attempt(instanceId, attempt.id);
      if (request === detailRequestRef.current) {
        startTransition(() => setDetail({ kind: "attempt", value }));
        if (preservedInvocationId) {
          const refreshedInvocation = value.modelInvocations.find((invocation) => invocation.id === preservedInvocationId);
          if (refreshedInvocation) void loadInvocation(refreshedInvocation, attempt.id, background);
          else {
            setSelection({ kind: "attempt", id: attempt.id });
            setInvocationDetail(undefined);
          }
        }
      }
      return { kind: "attempt" as const, value };
    } catch (reason) {
      if (request === detailRequestRef.current) {
        setDetailError(reason instanceof Error ? reason.message : "这条运行记录已经过期。");
      }
      return undefined;
    } finally {
      if (!background && request === detailRequestRef.current) setLoadingDetail(false);
    }
  }, [instanceId, loadInvocation]);

  const openReplay = useCallback(async (attempt: WorldInspectorAttemptSummary) => {
    setError("");
    try {
      const value = await worldInspectorApi.replay(instanceId, attempt.id);
      setReplay(value);
      setReplayFrameIndex(0);
      setReplayPlaying(false);
      setView("timeline");
      await selectAttempt(attempt);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取这次执行的回放。");
    }
  }, [instanceId, selectAttempt]);

  const selectInvocation = useCallback(async (invocation: WorldInspectorInvocationListItem) => {
    const executionId = worldInspectorInvocationExecutionId(invocation) ?? (detail?.kind === "attempt"
      ? detail.value.summary.id
      : detail?.kind === "step"
        ? detail.value.committed.executionRef?.executionId
        : undefined);
    if (!executionId) {
      setInvocationDetail(undefined);
      return;
    }
    await loadInvocation(invocation, executionId);
  }, [detail, loadInvocation]);

  const submitSearch = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = query.trim();
    setSearchError("");
    if (!value || !value.includes("::")) return;
    const request = ++invocationDetailRequestRef.current;
    setLoadingInvocation(true);
    try {
      const evidence = await worldInspectorApi.debugInspect(value);
      const invocation = await worldInspectorApi.modelInvocation(instanceId, evidence.executionId, evidence.id);
      if (request !== invocationDetailRequestRef.current) return;
      const rootId = invocation.lineage.kind === "repair"
        ? invocation.repairChain.initialAttemptId
        : invocation.id;
      const rootSummary = invocation.lineage.kind === "repair"
        ? await worldInspectorApi.modelInvocation(instanceId, evidence.executionId, rootId)
        : invocation;
      if (request !== invocationDetailRequestRef.current) return;
      if (rootSummary) {
        setQueriedInvocations((current) => current.some((candidate) => candidate.id === rootSummary.id)
          ? current : [rootSummary, ...current]);
      }
      setFollowLatest(false);
      setView("calls");
      setSelection({ kind: "invocation", id: invocation.id, executionId: invocation.executionId });
      setInvocationDetail(invocation);
      setInvocationError("");
    } catch (reason) {
      if (request === invocationDetailRequestRef.current) {
        setSearchError(reason instanceof Error ? reason.message : "没有找到这条调用。");
        setInvocationDetail(undefined);
      }
    } finally {
      if (request === invocationDetailRequestRef.current) setLoadingInvocation(false);
    }
  }, [instanceId, query]);

  const loadWindow = useCallback(async (preserveHistory: boolean) => {
    const request = ++requestRef.current;
    try {
      const incoming = await worldInspectorApi.window(instanceId);
      if (request !== requestRef.current) return;
      startTransition(() => setData((current) => preserveHistory ? mergeWorldInspectorWindows(current, incoming) : incoming));
      setError("");
      const activeAttempt = [...incoming.attempts].reverse().find((attempt) => attempt.status === "active");
      const latestFailure = [...incoming.attempts].reverse().find((attempt) =>
        attempt.status !== "active" && attempt.status !== "committed");
      const latestAttempt = [...incoming.attempts].reverse()[0];
      const latestStep = incoming.steps.at(-1);
      const failureIsCurrent = latestFailure &&
        (latestFailure.revision ?? incoming.instance.revision) >= (latestStep?.revision ?? 0);
      const nextAttempt = activeAttempt ?? (failureIsCurrent ? latestFailure : latestAttempt);
      if (!preserveHistory) {
        if (activeViewRef.current === "calls") {
          setSelection(null);
          setDetail(undefined);
          setDetailError("");
          setInvocationDetail(undefined);
          setInvocationError("");
        } else if (nextAttempt) {
          void selectAttempt(nextAttempt);
        } else if (latestStep) {
          void selectStep(latestStep);
        }
      } else if (followLatestRef.current) {
        const currentSelection = selectionRef.current;
        if (currentSelection?.kind === "invocation") return;
        const nextId = nextAttempt ? `attempt:${nextAttempt.id}` : latestStep ? `commit:${latestStep.revision}` : undefined;
        const currentNodeId = currentSelection?.kind === "attempt"
          ? `attempt:${currentSelection.id}`
          : currentSelection?.kind === "step"
            ? `commit:${currentSelection.revision}`
            : currentSelection?.kind === "node" ? currentSelection.id : undefined;
        if (nextAttempt && nextId !== currentNodeId) void selectAttempt(nextAttempt);
        else if (nextAttempt && nextId === currentNodeId && detailRef.current?.kind === "attempt" &&
          sameAttemptSummary(detailRef.current.value.summary, nextAttempt)) return;
        else if (nextAttempt && nextId === currentNodeId && detailRef.current?.kind === "attempt" &&
          detailRef.current.value.summary.id === nextAttempt.id) void selectAttempt(nextAttempt, true, true);
        else if (!nextAttempt && latestStep && nextId !== currentNodeId) void selectStep(latestStep);
      }
    } catch (reason) {
      if (request === requestRef.current) {
        setError(reason instanceof Error ? reason.message : "无法读取世界演化记录。");
      }
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [instanceId, selectAttempt, selectStep]);

  useEffect(() => {
    if (!open || activeView !== "timeline" || !data || selection) return;
    const selectLatest = window.setTimeout(() => {
      const activeAttempt = [...data.attempts].reverse().find((attempt) => attempt.status === "active");
      const latestFailure = [...data.attempts].reverse().find((attempt) =>
        attempt.status !== "active" && attempt.status !== "committed");
      const latestAttempt = [...data.attempts].reverse()[0];
      const latestStep = data.steps.at(-1);
      const failureIsCurrent = latestFailure &&
        (latestFailure.revision ?? data.instance.revision) >= (latestStep?.revision ?? 0);
      const nextAttempt = activeAttempt ?? (failureIsCurrent ? latestFailure : latestAttempt);
      if (nextAttempt) void selectAttempt(nextAttempt);
      else if (latestStep) void selectStep(latestStep);
    }, 0);
    return () => window.clearTimeout(selectLatest);
  }, [activeView, data, open, selectAttempt, selectStep, selection]);

  useEffect(() => {
    if (!open) return;
    const initialLoad = window.setTimeout(() => { void loadWindow(false); }, 0);
    return () => {
      window.clearTimeout(initialLoad);
      requestRef.current += 1;
      detailRequestRef.current += 1;
      invocationRequestRef.current += 1;
      invocationDetailRequestRef.current += 1;
      refreshSchedulerRef.current?.dispose();
      refreshSchedulerRef.current = undefined;
      refreshPendingRef.current = { window: false, invocations: false, detail: false };
      refreshRunningRef.current = false;
    };
  }, [loadWindow, open]);

  const loadInvocations = useCallback(async () => {
    const request = ++invocationRequestRef.current;
    try {
      const result = await worldInspectorApi.modelInvocations(instanceId, { includeRepairs: true, limit: 100, sort: "stage" });
      if (request !== invocationRequestRef.current) return;
      startTransition(() => {
        setQueriedInvocations((current) => mergeInvocationSummaries(current, result.items));
        setInvocationCursor(result.nextCursor);
      });
    } catch {
      if (request !== invocationRequestRef.current) return;
      // Keep the last successful projection during a transient refresh error;
      // clearing it causes a visible list flash and disconnects the selected detail.
    }
  }, [instanceId]);

  const refreshSelectedInvocation = useCallback(async () => {
    const currentSelection = selectionRef.current;
    const currentDetail = invocationDetailRef.current;
    if (currentSelection?.kind !== "invocation" || currentDetail?.status !== "active") return;
    const summary = queriedInvocationsRef.current.find((item) => item.id === currentSelection.id) ?? currentDetail;
    await loadInvocation(summary, currentSelection.executionId, true);
  }, [loadInvocation]);

  const flushInspectorRefresh = useCallback((dirty: WorldInspectorRefreshDirty) => {
    refreshPendingRef.current = {
      window: refreshPendingRef.current.window || dirty.window,
      invocations: refreshPendingRef.current.invocations || dirty.invocations,
      detail: refreshPendingRef.current.detail || dirty.detail,
    };
    if (refreshRunningRef.current) return;
    refreshRunningRef.current = true;
    void (async () => {
      try {
        while (refreshPendingRef.current.window || refreshPendingRef.current.invocations || refreshPendingRef.current.detail) {
          const batch = refreshPendingRef.current;
          refreshPendingRef.current = { window: false, invocations: false, detail: false };
          const jobs: Promise<unknown>[] = [];
          if (batch.window) jobs.push(loadWindow(true));
          if (batch.invocations && activeViewRef.current === "calls") jobs.push(loadInvocations());
          if (batch.detail) jobs.push(refreshSelectedInvocation());
          if (jobs.length > 0) await Promise.all(jobs);
        }
      } finally {
        refreshRunningRef.current = false;
      }
    })();
  }, [loadInvocations, loadWindow, refreshSelectedInvocation]);

  useEffect(() => {
    if (!open) return;
    const source = new EventSource(worldInspectorApi.eventsUrl(instanceId));
    const scheduler = new WorldInspectorRefreshScheduler(flushInspectorRefresh);
    refreshSchedulerRef.current = scheduler;
    const onRuntime = (event: MessageEvent<string>) => {
      let payload: WorldInspectorStreamEvent;
      try {
        payload = JSON.parse(event.data) as WorldInspectorStreamEvent;
      } catch {
        return;
      }
      const dirty = classifyWorldInspectorRuntimeEvent(payload);
      if (dirty) scheduler.mark(dirty);
    };
    const onResync = () => {
      scheduler.dispose();
      flushInspectorRefresh({ window: true, invocations: true, detail: true });
    };
    source.addEventListener("runtime", onRuntime as EventListener);
    source.addEventListener("resync", onResync);
    source.onopen = () => setConnection("live");
    source.onerror = () => setConnection("offline");
    return () => {
      scheduler.dispose();
      if (refreshSchedulerRef.current === scheduler) refreshSchedulerRef.current = undefined;
      source.close();
      source.removeEventListener("runtime", onRuntime as EventListener);
      source.removeEventListener("resync", onResync);
    };
  }, [flushInspectorRefresh, instanceId, open]);

  useEffect(() => {
    if (!open || activeView !== "calls") return;
    const refresh = window.setTimeout(() => { void loadInvocations(); }, 0);
    return () => window.clearTimeout(refresh);
  }, [activeView, loadInvocations, open]);

  const loadMoreInvocations = useCallback(async () => {
    if (!invocationCursor || loadingMoreInvocations) return;
    setLoadingMoreInvocations(true);
    try {
      const result = await worldInspectorApi.modelInvocations(instanceId, {
        cursor: invocationCursor,
        includeRepairs: true,
        limit: 100,
        sort: "stage",
      });
      setQueriedInvocations((current) => {
        const seen = new Set(current.map((invocation) => invocation.id));
        const appended = result.items.filter((invocation) => !seen.has(invocation.id));
        return appended.length === 0 ? current : [...current, ...appended];
      });
      setInvocationCursor(result.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取更多模型调用。");
    } finally {
      setLoadingMoreInvocations(false);
    }
  }, [instanceId, invocationCursor, loadingMoreInvocations]);

  const selectNode = useCallback(async (node: WorldInspectorNodeSummary) => {
    if (!data) return;
    const attemptId = node.kind === "attempt" ? node.id.slice("attempt:".length) : node.relatedAttemptId;
    if (attemptId) {
      const attempt = data.attempts.find((candidate) => candidate.id === attemptId);
      if (attempt) {
        await selectAttempt(attempt);
        setSelection({ kind: "node", id: node.id });
      }
      return;
    }
    const step = data.steps.find((candidate) => candidate.revision === node.revision);
    if (step) void selectStep(step, node.id);
  }, [data, selectAttempt, selectStep]);

  const loadOlder = useCallback(async () => {
    const beforeRevision = data?.pagination.oldestRevision;
    if (!beforeRevision || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const older = await worldInspectorApi.window(instanceId, { beforeRevision: beforeRevision + 1 });
      setData((current) => mergeWorldInspectorWindows(current, older));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法读取更早的推演记录。");
    } finally {
      setLoadingOlder(false);
    }
  }, [data?.pagination.oldestRevision, instanceId, loadingOlder]);

  const visibleActors = useMemo(() => {
    if (!data) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return data.actors.filter((actor) => !normalized || `${actor.name} ${actor.id} ${actor.description}`
      .toLocaleLowerCase().includes(normalized));
  }, [data, query]);

  const selectedActor = data?.actors.find((actor) => actor.id === selectedActorId);
  const worldActivity = useMemo(() => {
    if (!data) return { steps: 0, attempts: 0, modelInvocations: 0, retries: 0 };
    return {
      steps: data.steps.length,
      attempts: data.attempts.length,
      modelInvocations: data.attempts.reduce((sum, attempt) => sum + attempt.modelInvocationCount, 0),
      retries: data.attempts.reduce((sum, attempt) => sum + attempt.retryCount, 0),
    };
  }, [data]);
  const selectedInvocations = useMemo(() => {
    const contextualInvocations = detail?.kind === "attempt" || detail?.kind === "step"
      ? detail.value.modelInvocations
      : [];
    const invocations = selection?.kind === "invocation"
      ? [...queriedInvocations, ...contextualInvocations.filter((invocation) =>
        !queriedInvocations.some((candidate) => candidate.id === invocation.id))]
      : contextualInvocations.length > 0 ? contextualInvocations : queriedInvocations;
    const scoped = replayFrame
      ? invocations.filter((invocation) => replayFrame.invocationIds.includes(invocation.id) || invocation.logicalStageIndex === replayFrame.stageIndex)
      : invocations;
    if (selectedActorId === "world") return scoped;
    return scoped.filter((invocation) => invocation.subjectId === selectedActorId ||
      invocation.slotRefs.some((slot) => slot.agentId === selectedActorId));
  }, [detail, queriedInvocations, replayFrame, selectedActorId, selection]);

  useEffect(() => {
    if (!replay || !open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setReplayFrameIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setReplayFrameIndex((index) => Math.min(replay.frames.length - 1, index + 1));
      } else if (event.key === "Home") {
        event.preventDefault();
        setReplayFrameIndex(0);
      } else if (event.key === "End") {
        event.preventDefault();
        setReplayFrameIndex(replay.frames.length - 1);
      } else return;
      setFollowLatest(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, replay]);

  useEffect(() => {
    if (!replayPlaying || !replay) return;
    const timer = window.setInterval(() => {
      setReplayFrameIndex((index) => {
        if (index >= replay.frames.length - 1) {
          setReplayPlaying(false);
          return index;
        }
        return index + 1;
      });
    }, Math.max(60, 700 / replayRate));
    return () => window.clearInterval(timer);
  }, [replay, replayPlaying, replayRate]);

  const selectActor = useCallback((actorId: string) => {
    setSelectedActorId(actorId);
    invocationDetailRequestRef.current += 1;
    setSelection(null);
    setInvocationDetail(undefined);
    setInvocationError("");
    closeActorDrawer();
  }, [closeActorDrawer]);
  const experimentDescription = data?.instance.experiment
    ? `实验 ${data.instance.experiment.id}@${data.instance.experiment.version} / ${data.instance.experiment.variant}`
    : data?.instance.experimentExclusion?.reason === "explicit-execution-tuning"
      ? "未加入实验（使用显式执行配置）"
      : data?.instance.experimentExclusion?.reason === "world-ineligible"
        ? "未加入实验（世界版本不符合条件）"
        : data?.instance.experimentExclusion?.reason === "experiment-stopped"
          ? "未加入实验（实验已停止接收新实例）"
          : "未加入实验（当前无启用实验）";
  const statusDescription = data
    ? `${data.instance.worldName} · Revision ${data.instance.revision} · ${experimentDescription} · ${data.trace.degraded ? "降级审计" : "完整审计"}`
    : "读取世界提交历史、Agent 演化与运行审计。";

  const returnToLatest = () => {
    setFollowLatest(true);
    if (!data) return;
    const activeAttempt = [...data.attempts].reverse().find((attempt) => attempt.status === "active");
    const latestFailure = [...data.attempts].reverse().find((attempt) =>
      attempt.status !== "active" && attempt.status !== "committed");
    const latestAttempt = [...data.attempts].reverse()[0];
    const latestStep = data.steps.at(-1);
    const failureIsCurrent = latestFailure &&
      (latestFailure.revision ?? data.instance.revision) >= (latestStep?.revision ?? 0);
    const attempt = activeAttempt ?? (failureIsCurrent ? latestFailure : latestAttempt);
    if (attempt) {
      void selectAttempt(attempt);
    }
    else if (latestStep) void selectStep(latestStep);
  };

  const updatePanelWidth = (panel: ResizablePanel, width: number) => {
    if (panel === "actors") setActorWidth(width);
    else setDetailWidth(width);
  };

  const resizePanel = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const inlineDelta = (event.clientX - resize.startX) * (document.documentElement.dir === "rtl" ? -1 : 1);
    const next = resize.panel === "actors"
      ? clampWorldInspectorActorWidth(resize.startWidth + inlineDelta)
      : clampWorldInspectorDetailWidth(resize.startWidth - inlineDelta);
    resize.currentWidth = next;
    updatePanelWidth(resize.panel, next);
  };

  const finishResize = (event: PointerEvent<HTMLDivElement>) => {
    const resize = resizeRef.current;
    if (!resize) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    resizeRef.current = undefined;
    persistLayout(resize.panel === "actors"
      ? { actorWidth: resize.currentWidth }
      : { detailWidth: resize.currentWidth });
  };

  const resizePanelWithKeyboard = (
    panel: ResizablePanel,
    currentWidth: number,
    event: KeyboardEvent<HTMLDivElement>,
  ) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const next = resizeWorldInspectorPanelWidth(
      currentWidth,
      event.key as "ArrowLeft" | "ArrowRight" | "End" | "Home",
      panel,
      { rtl: document.documentElement.dir === "rtl", shift: event.shiftKey },
    );
    event.preventDefault();
    updatePanelWidth(panel, next);
    persistLayout(panel === "actors" ? { actorWidth: next } : { detailWidth: next });
  };

  const beginPanelResize = (
    panel: ResizablePanel,
    currentWidth: number,
    event: PointerEvent<HTMLDivElement>,
  ) => {
    resizeRef.current = {
      currentWidth,
      panel,
      startWidth: currentWidth,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handleSelectInvocation = useCallback((invocation: WorldInspectorInvocationListItem) => {
    setFollowLatest(false);
    void selectInvocation(invocation);
  }, [selectInvocation]);
  const handleSelectGraphNode = useCallback((node: WorldInspectorNodeSummary) => {
    setFollowLatest(false);
    void selectNode(node);
  }, [selectNode]);
  const handleSelectTimelineAttempt = useCallback((attempt: WorldInspectorAttemptSummary) => {
    setFollowLatest(false);
    void selectAttempt(attempt);
  }, [selectAttempt]);
  const handleSelectTimelineStep = useCallback((step: WorldInspectorStepSummary) => {
    setFollowLatest(false);
    void selectStep(step);
  }, [selectStep]);
  const handleSelectDetailInvocation = useCallback((invocation: WorldInspectorModelInvocationSummary) => {
    setView("calls");
    void selectInvocation(invocation);
  }, [selectInvocation]);
  const handleSelectDetailInvocationId = useCallback((invocationId: string, executionId: string) => {
    setView("calls");
    void loadInvocationById(invocationId, executionId);
  }, [loadInvocationById]);
  const handleGraphInteract = useCallback(() => setFollowLatest(false), []);

  return (
    <WorkspaceDialog
      closeLabel="关闭世界演化调试器"
      description={statusDescription}
      eyebrow="WORLD EVOLUTION / READ ONLY"
      onEscapeKeyDown={(event) => {
        if (!actorsOpen) return;
        event.preventDefault();
        closeActorDrawer();
      }}
      onOpenChange={onOpenChange}
      open={open}
      title="世界演化"
    >
      <div className="cg-inspector-toolbar">
        <div className="cg-inspector-view-switch" aria-label="推演视图">
          <button aria-pressed={activeView === "calls"} onClick={() => chooseCenterView("calls")} type="button">调用</button>
          <button aria-pressed={activeView === "graph"} onClick={() => chooseView("graph")} type="button">图谱</button>
          <button aria-pressed={activeView === "timeline"} onClick={() => chooseView("timeline")} type="button">流程</button>
          <button aria-pressed={activeView === "composition"} onClick={() => chooseCenterView("composition")} type="button">算法</button>
        </div>
        <button
          aria-controls="world-inspector-actors"
          aria-expanded={actorsOpen}
          className="cg-inspector-toolbar__button cg-inspector-actor-toggle"
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape" || !actorsOpen) return;
            event.preventDefault();
            event.stopPropagation();
            closeActorDrawer();
          }}
          onClick={() => setActorsOpen((value) => !value)}
          ref={actorToggleRef}
          type="button"
        >
          <Users aria-hidden="true" /> {selectedActor?.name ?? "主体"}
        </button>
        <form className="cg-inspector-search" onSubmit={(event) => void submitSearch(event)}>
          <Search aria-hidden="true" />
          <label className="cg-sr-only" htmlFor="world-inspector-search">搜索 Agent、算法、节点、revision 或 public invocation id</label>
          <input id="world-inspector-search" onChange={(event) => { setQuery(event.target.value); setSearchError(""); }} placeholder="搜索 Agent、算法、节点或 invocation ID" type="search" value={query} />
        </form>
        <button
          aria-pressed={followLatest}
          className="cg-inspector-toolbar__button"
          onClick={() => followLatest ? setFollowLatest(false) : returnToLatest()}
          type="button"
        >
          <LocateFixed aria-hidden="true" /> {followLatest ? "追随最新" : "回到最新"}
        </button>
        <span className="cg-inspector-live" data-status={connection} role="status">
          <CircleDot aria-hidden="true" />
          {{ connecting: "正在连接", live: "实时", offline: "正在重连" }[connection]}
        </span>
        {searchError && (
          <span className="cg-inspector-toolbar__message" role="alert">
            <span>{searchError}</span>
            <button onClick={() => { setSearchError(""); setQuery(""); }} type="button">清除</button>
          </span>
        )}
      </div>

      {loading && !data && (
        <div className="cg-inspector-loading" role="status">
          <RefreshCw aria-hidden="true" />
          <strong>正在重放世界历史</strong>
          <span>校验 canonical truth、Agent cognition 与提交链。</span>
        </div>
      )}
      {!loading && error && !data && (
        <div className="cg-inspector-loading" role="alert">
          <Binoculars aria-hidden="true" />
          <strong>无法打开世界调试器</strong>
          <span>{error}</span>
          <button onClick={() => { setLoading(true); setError(""); void loadWindow(false); }} type="button">重新读取</button>
        </div>
      )}
      {data && (
        <div
          className="cg-inspector-shell"
          onKeyDownCapture={(event) => {
            if (event.key !== "Escape" || !actorsOpen) return;
            event.stopPropagation();
            closeActorDrawer();
          }}
          style={{
            "--cg-inspector-actor-width": `${actorWidth}px`,
            "--cg-inspector-detail-width": `${detailWidth}px`,
          } as CSSProperties}
        >
          <button
            aria-label="关闭主体列表"
            className="cg-inspector-actor-scrim"
            data-open={actorsOpen || undefined}
            onClick={closeActorDrawer}
            tabIndex={actorsOpen ? 0 : -1}
            type="button"
          />
          <MemoizedWorldInspectorActors
            actorsOpen={actorsOpen}
            data={data}
            narrow={narrow}
            onSelect={selectActor}
            selectedActorId={selectedActorId}
            visibleActors={visibleActors}
            worldActivity={worldActivity}
          />

          <InspectorResizer
            label="调整主体列表宽度"
            maximum={WORLD_INSPECTOR_ACTOR_MAX}
            minimum={WORLD_INSPECTOR_ACTOR_MIN}
            onKeyDown={(event) => resizePanelWithKeyboard("actors", actorWidth, event)}
            onPointerCancel={finishResize}
            onPointerDown={(event) => beginPanelResize("actors", actorWidth, event)}
            onPointerMove={resizePanel}
            onPointerUp={finishResize}
            value={actorWidth}
          />

          <section
            className="cg-inspector-stage"
            data-view={activeView}
            aria-label={`${selectedActor?.name ?? "整个世界"}推演记录`}
          >
            {replay && (
              <div className="cg-inspector-replay" aria-label="执行回放控制">
                <strong>回放 · {replayFrame ? `${replayFrame.stageIndex + 1} / ${replay.frames.length} · ${replayFrame.stageLabel}` : "准备中"}</strong>
                <button aria-label="上一阶段" disabled={replayFrameIndex <= 0} onClick={() => setReplayFrameIndex((index) => Math.max(0, index - 1))} type="button"><ChevronLeft aria-hidden="true" /></button>
                <button aria-label={replayPlaying ? "暂停回放" : "播放回放"} onClick={() => setReplayPlaying((value) => !value)} type="button">
                  {replayPlaying ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
                </button>
                <button aria-label="下一阶段" disabled={replayFrameIndex >= replay.frames.length - 1} onClick={() => setReplayFrameIndex((index) => Math.min(replay.frames.length - 1, index + 1))} type="button"><ChevronRight aria-hidden="true" /></button>
                <input aria-label="回放阶段" max={Math.max(0, replay.frames.length - 1)} min={0} onChange={(event) => setReplayFrameIndex(Number(event.target.value))} type="range" value={replayFrameIndex} />
                <WorldInspectorSelect
                  ariaLabel="回放速度"
                  onChange={(value) => setReplayRate(value as 1 | 4 | 16)}
                  options={[{ value: 1, label: "1x" }, { value: 4, label: "4x" }, { value: 16, label: "16x" }]}
                  value={replayRate}
                />
                <button onClick={() => { setReplay(undefined); setReplayPlaying(false); returnToLatest(); }} type="button">退出回放</button>
              </div>
            )}
            {activeView === "composition" ? (
              <MemoizedWorldInspectorAlgorithmComposition composition={data.algorithmComposition} query={query} />
            ) : activeView === "calls" ? (
              <>
                {loadingInvocation && <p className="cg-inspector-stage__status" role="status">正在读取这次模型调用的完整记录…</p>}
                {invocationError && <p className="cg-inspector-stage__warning" role="alert">{invocationError}</p>}
                <MemoizedWorldInspectorInvocationList
                  hasMore={!detail && invocationCursor !== undefined}
                  invocations={selectedInvocations}
                  loadingMore={loadingMoreInvocations}
                  onSelect={handleSelectInvocation}
                  onLoadMore={() => void loadMoreInvocations()}
                  query={query}
                  selectedId={selectedInvocationId}
                  scopeLabel={selectedActor?.name ?? "整个世界"}
                />
              </>
            ) : activeView === "graph" ? (
              <>
                <InspectorCollectionHeader actorName={selectedActor?.name ?? "整个世界"} data={data} view="graph" />
                <div className="cg-inspector-graph-mode" aria-label="图谱层级">
                  <div className="cg-inspector-graph-mode__switch">
                    <button aria-pressed={graphMode === "semantic"} onClick={() => setGraphMode("semantic")} type="button">语义主链</button>
                    <button aria-pressed={graphMode === "technical"} onClick={() => setGraphMode("technical")} type="button">技术证据 · {data.nodes.length} 节点</button>
                  </div>
                  {graphMode === "technical" && (
                    <label>节点上限
                      <WorldInspectorSelect
                        ariaLabel="节点上限"
                        onChange={(value) => setTechnicalNodeLimit(value as typeof technicalNodeLimit)}
                        options={[{ value: 100, label: "100" }, { value: 200, label: "200" }, { value: 500, label: "500" }, { value: 1000, label: "1000" }]}
                        value={technicalNodeLimit}
                      />
                    </label>
                  )}
                  {replayFrame && <span>当前阶段 {replayFrame.stageIndex + 1} · {replayFrame.stageLabel}</span>}
                </div>
                <MemoizedWorldInspectorGraph
                  actors={data.actors}
                  edges={data.edges}
                  mode={graphMode}
                  nodeLimit={technicalNodeLimit}
                  semanticEdges={semanticEdges}
                  semanticNodes={semanticNodes}
                  followLatest={followLatest}
                  isolateActor={selectedActorId !== "world"}
                  nodes={technicalNodes}
                  onInteract={handleGraphInteract}
                  onSelect={handleSelectGraphNode}
                  query={query}
                  reduceMotion={reduceMotion}
                  selectedActorId={selectedActorId}
                  selectedNodeId={selectedNodeId}
                />
              </>
            ) : (
              <>
                <InspectorCollectionHeader actorName={selectedActor?.name ?? "整个世界"} data={data} view="timeline" />
                <MemoizedWorldInspectorTimeline
                  attempts={data.attempts}
                  hasOlder={data.pagination.hasOlder}
                  loadingOlder={loadingOlder}
                  onLoadOlder={() => void loadOlder()}
                  onReplay={(attempt) => void openReplay(attempt)}
                  onSelectAttempt={handleSelectTimelineAttempt}
                  onSelectStep={handleSelectTimelineStep}
                  query={query}
                  run={data.instance.run}
                  selectedActorId={selectedActorId}
                  selectedId={selectedNodeId}
                  steps={data.steps}
                />
              </>
            )}
            {error && <p className="cg-inspector-stage__warning" role="alert">{error}</p>}
          </section>

          <InspectorResizer
            label="调整推演详情宽度"
            maximum={WORLD_INSPECTOR_DETAIL_MAX}
            minimum={WORLD_INSPECTOR_DETAIL_MIN}
            onKeyDown={(event) => resizePanelWithKeyboard("detail", detailWidth, event)}
            onPointerCancel={finishResize}
            onPointerDown={(event) => beginPanelResize("detail", detailWidth, event)}
            onPointerMove={resizePanel}
            onPointerUp={finishResize}
            value={detailWidth}
          />

          <MemoizedWorldInspectorDetail
            actorId={selectedActorId}
            actorName={selectedActor?.name ?? (selectedActorId === "world" ? "整个世界" : selectedActorId)}
            detail={detail}
            error={effectiveSelection?.kind === "invocation" ? invocationError : detailError}
            invocation={invocationDetail}
            node={selectedGraphNode}
            nodeRelations={graphNodeRelations}
            key={effectiveSelection ? `${effectiveSelection.kind}:${"id" in effectiveSelection ? effectiveSelection.id : "revision" in effectiveSelection ? effectiveSelection.revision : "empty"}` : "empty"}
            loading={effectiveSelection?.kind === "invocation" ? loadingInvocation : loadingDetail}
            onSelectInvocation={handleSelectDetailInvocation}
            onSelectInvocationId={handleSelectDetailInvocationId}
            instanceId={instanceId}
            selection={effectiveSelection}
          />
        </div>
      )}
    </WorkspaceDialog>
  );
}
