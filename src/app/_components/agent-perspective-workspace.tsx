"use client";

import { ChevronDown, MapPin, Network, Orbit, Search, UserRound } from "lucide-react";
import { lazy, Suspense, useId, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentPerspectiveView } from "../../shared/world-api";
import {
  buildAgentPerspectiveGraph,
  focusPerspectiveGraph,
  perspectiveNodeLabel,
  relationLabels,
  type PerspectiveViewNode,
  type PerspectiveViewRelation,
} from "../_lib/agent-perspective-graph";

const PerspectiveGraph = lazy(() => import("./agent-perspective-graph").then((module) => ({ default: module.PerspectiveGraph })));
const evidenceLabels = { observation: "亲自观察", testimony: "他人证词", inference: "推断", assumption: "假设" } as const;
const magnitudeLabels = { none: "无", minor: "轻微", standard: "中等", major: "显著", decisive: "决定性" } as const;

function elapsedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分`;
  return `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
}

function Evidence({ ids, perspective }: { ids: readonly string[]; perspective: AgentPerspectiveView }) {
  const evidence = perspective.knowledge.evidence.filter((item) => ids.includes(item.id));
  if (!evidence.length) return null;
  return <details className="cg-perspective-evidence">
    <summary>查看依据 · {evidence.length}</summary>
    <ul>{evidence.map((item) => <li key={item.id}>
      <span>{evidenceLabels[item.kind]}</span><p>{item.description}</p>
    </li>)}</ul>
  </details>;
}

function Status({ perspective, headingRef }: { perspective: AgentPerspectiveView; headingRef: RefObject<HTMLHeadingElement | null> }) {
  const { meters, ratings, conditions } = perspective.mechanics;
  const ranges = new Set(ratings.map((rating) => `${rating.min} 至 ${rating.max}`));
  return <section className="cg-perspective-section" aria-label="状态">
    <h3 ref={headingRef} tabIndex={-1}>状态</h3>
    {meters.length > 0 && <div className="cg-perspective-meters">{meters.map((meter) => <div className="cg-perspective-meter" key={meter.name}>
      <span><strong>{meter.name}</strong><small>{meter.current} / {meter.max}</small></span>
      <meter aria-label={meter.name} min={meter.min} max={meter.max} value={meter.current}>{meter.current}</meter>
    </div>)}</div>}
    {conditions.length > 0 && <ul className="cg-perspective-conditions">{conditions.map((condition, index) => <li key={`${condition.label}:${index}`}>
      <strong>{condition.label}</strong><span>{condition.duration} · {magnitudeLabels[condition.magnitude]}影响</span>
      {condition.description && <p>{condition.description}</p>}
    </li>)}</ul>}
    {!meters.length && !conditions.length && <p className="cg-perspective-empty">暂无身体状态记录。</p>}
    {ratings.length > 0 && <details className="cg-perspective-disclosure">
      <summary>能力 <span>{ratings.length} 项</span><ChevronDown aria-hidden="true" /></summary>
      <p className="cg-perspective-note">显示当前能力值{ranges.size === 1 ? `，数值范围为 ${[...ranges][0]}` : "及各自的数值范围"}。</p>
      <dl className="cg-perspective-ratings">{ratings.map((rating) => <div key={rating.name}>
        <dt>{rating.name}</dt><dd>{rating.value}{ranges.size > 1 && <small>范围 {rating.min} 至 {rating.max}</small>}</dd>
      </div>)}</dl>
    </details>}
    {perspective.self.description && <details className="cg-perspective-disclosure">
      <summary>关于自己<ChevronDown aria-hidden="true" /></summary><p>{perspective.self.description}</p>
    </details>}
  </section>;
}

function EntityEntry({ node, perspective, relations, register, carrying }: {
  node: PerspectiveViewNode;
  perspective: AgentPerspectiveView;
  relations: readonly PerspectiveViewRelation[];
  register: (element: HTMLDetailsElement | null) => void;
  carrying?: string;
}) {
  const ownRelations = relations.filter((relation) => relation.source === node.id && (relation.origin === "fact" || relation.origin === "claim"));
  const attitudes = Object.values(perspective.character.attitudes).filter((attitude) =>
    attitude.status === "active" && `local:${attitude.subjectId}` === node.id);
  return <details className="cg-perspective-entity" ref={register}>
    <summary>
      <span className="cg-perspective-entity__title"><strong>{node.kind === "self" ? "关于自己的信息" : node.name}</strong><small>{carrying ?? perspectiveNodeLabel(node)}</small></span>
      <ChevronDown aria-hidden="true" />
    </summary>
    <div className="cg-perspective-entity__body">
      {node.kind !== "self" && node.description && <p>{node.description}</p>}
      {attitudes.map((attitude) => <div className="cg-perspective-record" key={attitude.id}>
        <span>你的态度</span><p>{attitude.description}</p><Evidence ids={attitude.evidenceIds} perspective={perspective} />
      </div>)}
      {ownRelations.map((relation) => <div className="cg-perspective-record" key={relation.id}>
        <span>{relationLabels[relation.kind]}</span><p>{relation.description}</p>
        <Evidence ids={relation.evidenceIds} perspective={perspective} />
      </div>)}
      {!node.description && !ownRelations.length && !attitudes.length && <p className="cg-perspective-empty">暂时没有更多信息。</p>}
    </div>
  </details>;
}

function Goals({ perspective }: { perspective: AgentPerspectiveView }) {
  const goals = Object.values(perspective.character.goals).filter((goal) => goal.status === "active" || goal.status === "suspended");
  const commitments = Object.values(perspective.character.commitments).filter((commitment) => commitment.status === "active");
  const summary = [goals.length ? `${goals.length} 项目标` : null, commitments.length ? `${commitments.length} 项承诺` : null].filter(Boolean).join(" · ");
  return <section className="cg-perspective-section" aria-label="目标">
    <h3>目标 <small>{summary}</small></h3>
    {!goals.length && !commitments.length && <p className="cg-perspective-empty">还没有记录目标或承诺。</p>}
    <ul className="cg-perspective-goals">{goals.map((goal) => <li key={`goal:${goal.id}`}>
      <span>{goal.status === "suspended" ? "暂缓" : "目标"}</span><div><p>{goal.description}</p><Evidence ids={goal.evidenceIds} perspective={perspective} /></div>
    </li>)}{commitments.map((commitment) => <li key={`commitment:${commitment.id}`}>
      <span>承诺</span><div><p>{commitment.description}</p><Evidence ids={commitment.evidenceIds} perspective={perspective} /></div>
    </li>)}</ul>
  </section>;
}

function PerspectiveContent({ perspective, reduceMotion }: { perspective: AgentPerspectiveView; reduceMotion: boolean }) {
  const graph = useMemo(() => buildAgentPerspectiveGraph(perspective), [perspective]);
  const entries = graph.nodes.filter((node) => node.kind !== "value");
  const carried = new Map(perspective.knowledge.containment.map((item) => [item.entityRef, item]));
  const [query, setQuery] = useState("");
  const [graphOpen, setGraphOpen] = useState(false);
  const [focusId, setFocusId] = useState(graph.selfRef);
  const [selectedId, setSelectedId] = useState(graph.selfRef);
  const currentFocus = graph.nodes.some((node) => node.id === focusId) ? focusId : graph.selfRef;
  const nearby = useMemo(() => focusPerspectiveGraph(graph, currentFocus), [graph, currentFocus]);
  const selected = nearby.nodes.find((node) => node.id === selectedId) ?? nearby.nodes.find((node) => node.id === currentFocus)!;
  const entryRefs = useRef(new Map<string, HTMLDetailsElement>());
  const statusRef = useRef<HTMLHeadingElement>(null);
  const searchId = useId();
  const focusSelectId = useId();
  const search = query.trim().toLocaleLowerCase();
  const known = entries.filter((node) => !carried.has(node.id) && (node.id !== graph.selfRef || graph.relations.some((relation) =>
    relation.source === node.id && (relation.origin === "fact" || relation.origin === "claim"))));
  const visible = known.filter((node) => [node.name, node.description,
    ...graph.relations.filter((relation) => relation.source === node.id).map((relation) => relation.description),
    ...Object.values(perspective.character.attitudes).filter((attitude) => `local:${attitude.subjectId}` === node.id).map((attitude) => attitude.description),
  ].join(" ").toLocaleLowerCase().includes(search));
  function register(id: string) {
    return (element: HTMLDetailsElement | null) => {
      if (element) entryRefs.current.set(id, element);
      else entryRefs.current.delete(id);
    };
  }
  function showSelectedDetails() {
    const id = selected.kind === "value"
      ? graph.relations.find((relation) => relation.target === selected.id)?.source ?? graph.selfRef
      : selected.id;
    setQuery("");
    requestAnimationFrame(() => {
      const entry = entryRefs.current.get(id);
      if (entry) {
        entry.open = true;
        entry.querySelector("summary")?.focus({ preventScroll: true });
        entry.scrollIntoView({ block: "start", behavior: reduceMotion ? "instant" : "smooth" });
      } else {
        statusRef.current?.focus({ preventScroll: true });
        statusRef.current?.scrollIntoView({ block: "start", behavior: reduceMotion ? "instant" : "smooth" });
      }
    });
  }
  return <section className="cg-perspective-workspace">
    <header className="cg-perspective-summary">
      <div className="cg-perspective-summary__identity"><span aria-hidden="true"><UserRound /></span><h2>{perspective.self.name}</h2></div>
      <dl><div><dt><MapPin aria-hidden="true" />地点</dt><dd>{perspective.self.location?.name ?? "位置未知"}</dd></div>
        <div><dt><Orbit aria-hidden="true" />已过时间</dt><dd>{elapsedLabel(perspective.elapsedSeconds)}</dd></div></dl>
    </header>
    <div className="cg-perspective-overview">
      <div><Status headingRef={statusRef} perspective={perspective} /></div>
      <section className="cg-perspective-section" aria-label="物品">
        <h3>物品</h3>
        {perspective.mechanics.quantities.length > 0 && <dl className="cg-perspective-quantities">{perspective.mechanics.quantities.map((quantity) => <div key={quantity.name}>
          <dt>{quantity.name}</dt><dd><strong>{quantity.amount}</strong> <span>{quantity.unit}</span></dd>
        </div>)}</dl>}
        {entries.filter((node) => carried.has(node.id)).map((node) => {
          const item = carried.get(node.id)!;
          const container = entries.find((entry) => entry.id === item.containerRef);
          const carrying = item.viaUnknownContainer ? "随身携带 · 容器尚未辨认" : item.depth === 1 ? "随身携带" : container ? `收在${container.name}中` : "收在随身容器中";
          return <EntityEntry key={node.id} node={node} carrying={carrying} perspective={perspective} relations={graph.relations} register={register(node.id)} />;
        })}
        {!perspective.mechanics.quantities.length && !carried.size && <p className="cg-perspective-empty">当前没有随身物品记录。</p>}
      </section>
    </div>
    <Goals perspective={perspective} />
    <section className="cg-perspective-section" aria-label="已知信息">
      <div className="cg-perspective-section__heading"><h3>已知信息 <small>{known.length} 项</small></h3>
        {known.length > 0 && <div className="cg-perspective-search"><Search aria-hidden="true" /><label className="cg-sr-only" htmlFor={searchId}>搜索已知信息</label><input id={searchId} type="search" placeholder="搜索人物、地点或线索" value={query} onChange={(event) => setQuery(event.target.value)} /></div>}
      </div>
      {!known.length ? <p className="cg-perspective-empty">还没有认识的人、地点或线索。</p> : !visible.length ? <p className="cg-perspective-empty" role="status">没有找到匹配的信息。试试其他关键词。</p> : <div className="cg-perspective-known">{visible.map((node) => <EntityEntry key={node.id} node={node} perspective={perspective} relations={graph.relations} register={register(node.id)} />)}</div>}
    </section>
    <details className="cg-perspective-map cg-perspective-disclosure" onToggle={(event) => setGraphOpen(event.currentTarget.open)}>
      <summary><Network aria-hidden="true" />关系图<span>辅助查看</span><ChevronDown aria-hidden="true" /></summary>
      {graphOpen && <div className="cg-perspective-map__body">
        <div className="cg-perspective-map__toolbar"><label htmlFor={focusSelectId}>围绕</label><select id={focusSelectId} value={currentFocus} onChange={(event) => { setFocusId(event.target.value); setSelectedId(event.target.value); }}>{entries.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}</select><span>显示直接联系 · 可拖动与缩放</span></div>
        <div className="cg-perspective-legend" aria-label="关系图图例">{([...new Set(nearby.relations.map((relation) => relation.kind))]).map((kind) => <span data-relation={kind} key={kind}><i />{relationLabels[kind]}</span>)}</div>
        <Suspense fallback={<p role="status">正在准备关系图…</p>}><PerspectiveGraph nodes={nearby.nodes} relations={nearby.relations} selfRef={currentFocus} selectedId={selected.id} onSelect={setSelectedId} reduceMotion={reduceMotion} /></Suspense>
        <div className="cg-perspective-map__selection"><div><strong>{selected.name}</strong><p>{selected.description}</p></div><button type="button" onClick={showSelectedDetails}>查看详情</button></div>
      </div>}
    </details>
  </section>;
}

export function AgentPerspectiveWorkspace(props: { perspective: AgentPerspectiveView; reduceMotion: boolean }) {
  return <PerspectiveContent key={props.perspective.agentId} {...props} />;
}
