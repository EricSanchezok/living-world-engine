"use client";

import { ArrowLeft, ArrowUpRight, Backpack, Box, LayoutGrid, MapPin, Network, Orbit, Search, UserRound } from "lucide-react";
import { lazy, Suspense, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { AgentPerspectiveView } from "../../shared/world-api";
import { buildAgentPerspectiveGraph, focusPerspectiveGraph, relationLabels } from "../_lib/agent-perspective-graph";
import { AppSelect } from "./app-select";
import { entityReading, PerspectiveDetail, type PerspectiveReading } from "./agent-perspective-detail";

const PerspectiveGraph = lazy(() => import("./agent-perspective-graph").then((module) => ({ default: module.PerspectiveGraph })));
const magnitudeLabels = { none: "无", minor: "轻微", standard: "中等", major: "显著", decisive: "决定性" } as const;

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

function Status({ perspective }: { perspective: AgentPerspectiveView }) {
  const { meters, ratings, conditions } = perspective.mechanics;
  const ranges = new Set(ratings.map((rating) => `${rating.min} 至 ${rating.max}`));
  return <section className="cg-perspective-section" aria-label="状态">
    <h3>状态</h3>
    {meters.length > 0 && <div className="cg-perspective-meters">{meters.map((meter) => <div className="cg-perspective-meter" key={meter.name}>
      <span><strong>{meter.name}</strong><small>{meter.current} / {meter.max}</small></span>
      <meter aria-label={meter.name} min={meter.min} max={meter.max} value={meter.current}>{meter.current}</meter>
    </div>)}</div>}
    {conditions.length > 0 && <ul className="cg-perspective-conditions">{conditions.map((condition, index) => <li key={`${condition.label}:${index}`}>
      <strong>{condition.label}</strong><span>{condition.duration} · {magnitudeLabels[condition.magnitude]}影响</span>
      {condition.description && <p>{condition.description}</p>}
    </li>)}</ul>}
    {!meters.length && !conditions.length && <p className="cg-perspective-empty">暂无身体状态记录。</p>}
    {ratings.length > 0 && <div className="cg-perspective-abilities">
      <h4>能力 <small>{ranges.size === 1 ? `数值范围 ${[...ranges][0]}` : "显示当前值与范围"}</small></h4>
      <dl className="cg-perspective-ratings">{ratings.map((rating) => <div key={rating.name}>
        <dt>{rating.name}</dt><dd>{rating.value}{ranges.size > 1 && <small>{rating.min} 至 {rating.max}</small>}</dd>
      </div>)}</dl>
    </div>}
  </section>;
}

type OpenReading = (id: string, event: MouseEvent<HTMLButtonElement>) => void;

function ReadingCard({ reading, onOpen, item, container }: { reading: PerspectiveReading; onOpen: OpenReading; item?: boolean; container?: boolean }) {
  const Icon = container ? Backpack : Box;
  return <button type="button" className={item ? "cg-perspective-item" : "cg-perspective-card"} onClick={(event) => onOpen(reading.id, event)} aria-label={`查看${reading.title}`}>
    {item && <span className="cg-perspective-item__icon" aria-hidden="true"><Icon /></span>}
    <span className="cg-perspective-card__name"><strong>{reading.title}</strong><ArrowUpRight aria-hidden="true" /></span>
    <span className="cg-perspective-card__source">{reading.subtitle}</span>
    {!item && <span className="cg-perspective-card__preview">{reading.description || reading.records[0]?.description || "暂时没有更多描述。"}</span>}
    {!item && reading.records.length > 0 && <span className="cg-perspective-card__count">{reading.records.length} 条相关信息</span>}
  </button>;
}

function PerspectiveContent({ perspective, reduceMotion }: { perspective: AgentPerspectiveView; reduceMotion: boolean }) {
  const graph = useMemo(() => buildAgentPerspectiveGraph(perspective), [perspective]);
  const entries = graph.nodes.filter((node) => node.kind !== "value");
  const carried = new Map(perspective.knowledge.containment.map((item) => [item.entityRef, item]));
  const readings = entries.map((node) => {
    const item = carried.get(node.id);
    const container = item && entries.find((entry) => entry.id === item.containerRef);
    const carrying = !item ? undefined : item.viaUnknownContainer ? "随身携带 · 容器尚未辨认" : item.depth === 1 ? "随身携带" : container ? `收在${container.name}中` : "收在随身容器中";
    return entityReading(node, perspective, graph.relations, carrying);
  });
  const intentions = [
    ...Object.values(perspective.character.goals).filter((goal) => goal.status === "active" || goal.status === "suspended").map((goal) => ({ ...goal, id: `goal:${goal.id}`, label: goal.status === "suspended" ? "暂缓" : "目标" })),
    ...Object.values(perspective.character.commitments).filter((item) => item.status === "active").map((item) => ({ ...item, id: `commitment:${item.id}`, label: "承诺" })),
  ];
  const [query, setQuery] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [focusId, setFocusId] = useState(graph.selfRef);
  const [selectedId, setSelectedId] = useState(graph.selfRef);
  const [detailId, setDetailId] = useState<string | null>(null);
  const currentFocus = graph.nodes.some((node) => node.id === focusId) ? focusId : graph.selfRef;
  const nearby = useMemo(() => focusPerspectiveGraph(graph, currentFocus), [graph, currentFocus]);
  const selected = nearby.nodes.find((node) => node.id === selectedId) ?? nearby.nodes.find((node) => node.id === currentFocus)!;
  const intent = intentions.find((item) => item.id === detailId);
  const detail: PerspectiveReading | undefined = readings.find((item) => item.id === detailId) ?? (intent ? {
    id: intent.id, title: `${intent.label}的依据`, subtitle: "目标与承诺", description: "",
    records: [{ id: intent.id, label: intent.label, description: intent.description, evidenceIds: intent.evidenceIds }],
  } : detailId ? { id: detailId, title: "信息已更新", subtitle: "", description: "当前视角中已没有这条记录。", records: [] } : undefined);
  const rootRef = useRef<HTMLElement>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  const returnPoint = useRef<{ trigger: HTMLButtonElement; scrollTop: number } | null>(null);
  const searchId = useId();
  const focusSelectId = useId();
  const detailHeadingId = useId();
  const search = query.trim().toLocaleLowerCase();
  const known = readings.filter((reading) => !carried.has(reading.id) && (reading.id !== graph.selfRef || reading.records.length > 0));
  const visible = known.filter((reading) => [reading.title, reading.description, ...reading.records.map((record) => record.description)].join(" ").toLocaleLowerCase().includes(search));
  const items = readings.filter((reading) => carried.has(reading.id));

  useLayoutEffect(() => {
    const scroller = rootRef.current?.closest<HTMLElement>(".cg-modal-scroll");
    if (detailId) {
      if (scroller) scroller.scrollTop = 0;
      detailHeadingRef.current?.focus({ preventScroll: true });
    } else if (returnPoint.current) {
      if (scroller) scroller.scrollTop = returnPoint.current.scrollTop;
      returnPoint.current.trigger.focus({ preventScroll: true });
      returnPoint.current = null;
    }
  }, [detailId]);

  const openReading: OpenReading = (id, event) => {
    returnPoint.current = { trigger: event.currentTarget, scrollTop: rootRef.current?.closest<HTMLElement>(".cg-modal-scroll")?.scrollTop ?? 0 };
    setDetailId(id);
  };

  return <section className="cg-perspective-workspace" ref={rootRef}>
    <div className="cg-perspective-overview-content" hidden={Boolean(detail)}>
      <header className="cg-perspective-summary">
        <div className="cg-perspective-summary__identity"><span aria-hidden="true"><UserRound /></span><h2>{perspective.self.name}</h2></div>
        <dl><div><dt><MapPin aria-hidden="true" />地点</dt><dd>{perspective.self.location?.name ?? "位置未知"}</dd></div>
          <div><dt><Orbit aria-hidden="true" />已过时间</dt><dd>{elapsedLabel(perspective.elapsedSeconds)}</dd></div></dl>
        {perspective.self.description && <p className="cg-perspective-summary__description">{perspective.self.description}</p>}
      </header>
      <div className="cg-perspective-overview">
        <Status perspective={perspective} />
        <section className="cg-perspective-section" aria-label="物品">
          <h3>物品{items.length > 0 && <small>{items.length} 件随身物品</small>}</h3>
          {perspective.mechanics.quantities.length > 0 && <dl className="cg-perspective-quantities">{perspective.mechanics.quantities.map((quantity) => <div key={quantity.name}>
            <dt>{quantity.name}</dt><dd><strong>{quantity.amount}</strong> <span>{quantity.unit}</span></dd>
          </div>)}</dl>}
          {items.length > 0 && <div className="cg-perspective-inventory">{items.map((reading) => <ReadingCard key={reading.id} reading={reading} onOpen={openReading} item container={[...carried.values()].some((item) => item.containerRef === reading.id)} />)}</div>}
          {!perspective.mechanics.quantities.length && !items.length && <p className="cg-perspective-empty">当前没有随身物品记录。</p>}
        </section>
      </div>
      <section className="cg-perspective-section" aria-label="目标">
        <h3>目标{intentions.length > 0 && <small>{intentions.length} 项目标与承诺</small>}</h3>
        {!intentions.length && <p className="cg-perspective-empty">还没有记录目标或承诺。</p>}
        <ul className="cg-perspective-goals">{intentions.map((item) => <li key={item.id}>
          <span>{item.label}</span><p>{item.description}</p>
          {item.evidenceIds.some((id) => perspective.knowledge.evidence.some((evidence) => evidence.id === id)) && <button type="button" aria-label={`查看依据：${item.description}`} onClick={(event) => openReading(item.id, event)}>依据<ArrowUpRight aria-hidden="true" /></button>}
        </li>)}</ul>
      </section>
      <section className="cg-perspective-section" aria-label="已知信息">
        <div className="cg-perspective-section__heading"><h3>已知信息 <small>{known.length} 项</small></h3>
          <div className="cg-perspective-view-switch" role="group" aria-label="已知信息视图">
            <button type="button" aria-pressed={!graphOpen} onClick={() => setGraphOpen(false)}><LayoutGrid aria-hidden="true" />卡片</button>
            <button type="button" aria-pressed={graphOpen} onClick={() => setGraphOpen(true)}><Network aria-hidden="true" />关系图</button>
          </div>
        </div>
        {!graphOpen ? <>
          {known.length > 0 && <div className="cg-perspective-search"><Search aria-hidden="true" /><label className="cg-sr-only" htmlFor={searchId}>搜索已知信息</label><input id={searchId} type="search" placeholder="搜索人物、地点或线索" value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
          {!known.length ? <p className="cg-perspective-empty">还没有认识的人、地点或线索。</p> : !visible.length ? <p className="cg-perspective-empty" role="status">没有找到匹配的信息。试试其他关键词。</p> : <div className="cg-perspective-known">{visible.map((reading) => <ReadingCard key={reading.id} reading={reading} onOpen={openReading} />)}</div>}
        </> : <div className="cg-perspective-map">
          <div className="cg-perspective-map__toolbar"><label htmlFor={focusSelectId}>围绕</label><AppSelect id={focusSelectId} ariaLabel="围绕" value={currentFocus} onChange={(value) => { setFocusId(value); setSelectedId(value); }} options={entries.map((node) => ({ value: node.id, label: node.name }))} /><span>显示直接联系 · 可拖动与缩放</span></div>
          <div className="cg-perspective-legend" aria-label="关系图图例">{([...new Set(nearby.relations.map((relation) => relation.kind))]).map((kind) => <span data-relation={kind} key={kind}><i />{relationLabels[kind]}</span>)}</div>
          <Suspense fallback={<p role="status">正在准备关系图…</p>}><PerspectiveGraph nodes={nearby.nodes} relations={nearby.relations} selfRef={currentFocus} selectedId={selected.id} onSelect={setSelectedId} reduceMotion={reduceMotion} /></Suspense>
          <div className="cg-perspective-map__selection"><div><strong>{selected.name}</strong><p>{selected.description}</p></div><button type="button" onClick={(event) => openReading(selected.kind === "value" ? graph.relations.find((relation) => relation.target === selected.id)?.source ?? graph.selfRef : selected.id, event)}>查看详情</button></div>
        </div>}
      </section>
    </div>
    {detail && <section className="cg-perspective-detail" aria-labelledby={detailHeadingId}>
      <button type="button" className="cg-perspective-back" onClick={() => setDetailId(null)}><ArrowLeft aria-hidden="true" />返回视角</button>
      <header><span>{detail.subtitle}</span><h3 id={detailHeadingId} tabIndex={-1} ref={detailHeadingRef}>{detail.title}</h3></header>
      <PerspectiveDetail reading={detail} perspective={perspective} />
    </section>}
  </section>;
}

export function AgentPerspectiveWorkspace(props: { perspective: AgentPerspectiveView; reduceMotion: boolean }) {
  return <PerspectiveContent key={props.perspective.agentId} {...props} />;
}
