"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import ELK, { type ELK as ElkLayoutEngine } from "elkjs/lib/elk-api.js";
import {
  Box,
  Building2,
  CircleHelp,
  Orbit,
  UserRound,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  perspectiveNodeLabel,
  type PerspectiveViewNode,
  type PerspectiveViewRelation,
  type ViewNodeKind,
} from "../_lib/agent-perspective-graph";

interface PerspectiveNodeData extends Record<string, unknown> {
  node: PerspectiveViewNode;
  selected: boolean;
  onSelect: (id: string) => void;
}

type PerspectiveFlowNode = Node<PerspectiveNodeData, "perspective">;

const nodeWidth = 184;
const nodeHeight = 78;
const nodeHandles: NonNullable<PerspectiveFlowNode["handles"]> = [
  { type: "target", position: Position.Left, x: -3, y: 36, width: 6, height: 6 },
  { type: "source", position: Position.Right, x: 181, y: 36, width: 6, height: 6 },
];

const iconByNodeKind = {
  self: UserRound,
  entity: Box,
  authorized: Building2,
  unidentified: CircleHelp,
  value: Orbit,
} satisfies Record<ViewNodeKind, typeof Orbit>;

function moveNodeFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown", "Home", "End"].includes(event.key)) return;
  const graph = event.currentTarget.closest(".cg-perspective-graph");
  const buttons = [...(graph?.querySelectorAll<HTMLButtonElement>(".cg-perspective-node") ?? [])];
  const current = buttons.indexOf(event.currentTarget);
  if (current < 0 || buttons.length === 0) return;
  const target = event.key === "Home"
    ? 0
    : event.key === "End"
      ? buttons.length - 1
      : (current + (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
  event.preventDefault();
  buttons[target]?.focus({ preventScroll: true });
}

function PerspectiveNode({ data }: NodeProps<PerspectiveFlowNode>) {
  const Icon = iconByNodeKind[data.node.kind];
  const flow = useReactFlow<PerspectiveFlowNode, Edge>();
  return (
    <>
      <Handle aria-hidden="true" className="cg-perspective-node__handle" position={Position.Left} type="target" />
      <button
        aria-label={`${data.node.name}，${perspectiveNodeLabel(data.node)}。${data.node.description}`}
        aria-pressed={data.selected}
        className="cg-perspective-node nodrag"
        data-kind={data.node.kind}
        data-selected={data.selected || undefined}
        onFocus={(event) => {
          if (!event.currentTarget.matches(":focus-visible")) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          const viewport = event.currentTarget.closest(".cg-perspective-graph")?.getBoundingClientRect();
          const node = flow.getNode(data.node.id);
          if (viewport && node && (bounds.left < viewport.left || bounds.right > viewport.right || bounds.top < viewport.top || bounds.bottom > viewport.bottom)) {
            void flow.setCenter(node.position.x + nodeWidth / 2, node.position.y + nodeHeight / 2, { zoom: flow.getZoom(), duration: 0 });
          }
        }}
        onKeyDown={moveNodeFocus}
        onClick={() => data.onSelect(data.node.id)}
        type="button"
      >
        <span className="cg-perspective-node__icon"><Icon aria-hidden="true" /></span>
        <span className="cg-perspective-node__copy">
          <strong>{data.node.name}</strong>
          <small>{perspectiveNodeLabel(data.node)}</small>
        </span>
      </button>
      <Handle aria-hidden="true" className="cg-perspective-node__handle" position={Position.Right} type="source" />
    </>
  );
}

const nodeTypes = { perspective: PerspectiveNode };

function fallbackPositions(
  nodes: readonly PerspectiveViewNode[],
  selfRef: string,
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = { [selfRef]: { x: 0, y: 0 } };
  const surrounding = nodes.filter((node) => node.id !== selfRef);
  surrounding.forEach((node, index) => {
    const ring = Math.floor(index / 8);
    const count = Math.min(8, surrounding.length - ring * 8);
    const angle = (Math.PI * 2 * (index % 8)) / Math.max(1, count) - Math.PI / 2;
    const radius = 250 + ring * 180;
    positions[node.id] = {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  });
  return positions;
}

export function PerspectiveGraph({
  nodes: sourceNodes,
  onSelect,
  reduceMotion,
  relations,
  selectedId,
  selfRef,
}: {
  nodes: PerspectiveViewNode[];
  onSelect: (nodeId: string) => void;
  reduceMotion: boolean;
  relations: PerspectiveViewRelation[];
  selectedId: string;
  selfRef: string;
}) {
  const { resolvedTheme } = useTheme();
  const graphRef = useRef<HTMLDivElement>(null);
  const elkRef = useRef<ElkLayoutEngine | null>(null);
  const instanceRef = useRef<ReactFlowInstance<PerspectiveFlowNode, Edge> | null>(null);
  const [flowReady, setFlowReady] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() =>
    fallbackPositions(sourceNodes, selfRef));
  const [settledSignature, setSettledSignature] = useState<string>();
  const signature = useMemo(() => [
    sourceNodes.map((node) => node.id).join("|"),
    relations.map((relation) => relation.id).join("|"),
  ].join("::"), [relations, sourceNodes]);
  const fallback = useMemo(() => fallbackPositions(sourceNodes, selfRef), [selfRef, sourceNodes]);

  useEffect(() => {
    const worker = new Worker(new URL("../_workers/agent-perspective-layout.worker.ts", import.meta.url), {
      type: "module",
    });
    const elk = new ELK({ algorithms: ["layered"], workerFactory: () => worker });
    elkRef.current = elk;
    return () => {
      elk.terminateWorker();
      elkRef.current = null;
    };
  }, []);

  useEffect(() => {
    const elk = elkRef.current;
    if (!elk || sourceNodes.length === 0) return;
    let cancelled = false;
    void elk.layout({
      id: `agent-perspective:${signature}`,
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.edgeRouting": "ORTHOGONAL",
        "elk.spacing.nodeNode": "72",
        "elk.layered.spacing.nodeNodeBetweenLayers": "100",
        "elk.padding": "[top=80,left=80,bottom=80,right=80]",
      },
      children: sourceNodes.map((node) => ({ id: node.id, width: nodeWidth, height: nodeHeight })),
      edges: relations.map((relation) => ({
        id: relation.id,
        sources: [relation.source],
        targets: [relation.target],
      })),
    }).then((graph) => {
      if (cancelled) return;
      const raw = Object.fromEntries((graph.children ?? []).map((node) => [
        node.id,
        { x: node.x ?? 0, y: node.y ?? 0 },
      ]));
      const center = raw[selfRef] ?? { x: 0, y: 0 };
      setPositions(Object.fromEntries(Object.entries(raw).map(([id, position]) => [id, {
        x: position.x - center.x,
        y: position.y - center.y,
      }])));
      setSettledSignature(signature);
    }).catch(() => {
      if (cancelled) return;
      setPositions(fallback);
      setSettledSignature(signature);
    });
    return () => { cancelled = true; };
  }, [fallback, relations, selfRef, signature, sourceNodes]);

  const nodes = useMemo<PerspectiveFlowNode[]>(() => sourceNodes.map((node) => ({
    id: node.id,
    type: "perspective",
    position: positions[node.id] ?? fallback[node.id] ?? { x: 0, y: 0 },
    initialWidth: nodeWidth,
    initialHeight: nodeHeight,
    handles: nodeHandles,
    draggable: false,
    selectable: false,
    ariaLabel: `${node.name}：${node.description}`,
    data: { node, selected: selectedId === node.id, onSelect },
  })), [fallback, onSelect, positions, selectedId, sourceNodes]);

  const edges = useMemo<Edge[]>(() => relations.map((relation) => ({
    id: relation.id,
    source: relation.source,
    target: relation.target,
    label: relation.label,
    className: `cg-perspective-edge cg-perspective-edge--${relation.kind}`,
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { stroke: "var(--cg-foreground)" },
    labelStyle: { fill: "var(--cg-muted-foreground)", fontSize: 12 },
    labelBgStyle: { fill: "var(--cg-card)", fillOpacity: 0.9 },
  })), [relations]);

  const layoutReady = sourceNodes.length === 0 || settledSignature === signature;

  useEffect(() => {
    const graph = graphRef.current;
    if (!flowReady || !layoutReady || !instanceRef.current || !graph) return;
    const geometry = Object.values(positions);
    if (!geometry.length) return;
    const maxX = Math.max(...geometry.map((position) => Math.abs(position.x) + nodeWidth));
    const maxY = Math.max(...geometry.map((position) => Math.abs(position.y) + nodeHeight));
    const zoom = Math.max(0.95, Math.min(1.05,
      graph.clientWidth / Math.max(nodeWidth * 1.5, maxX * 2.15),
      graph.clientHeight / Math.max(nodeHeight * 1.5, maxY * 2.15)));
    const frame = requestAnimationFrame(() => {
      void instanceRef.current?.setCenter(nodeWidth / 2, nodeHeight / 2, {
        zoom,
        duration: reduceMotion ? 0 : 240,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [flowReady, layoutReady, positions, reduceMotion, signature]);

  return (
    <div
      aria-busy={!layoutReady}
      aria-label="附近的关系图"
      className="cg-perspective-graph"
      ref={graphRef}
      role="region"
    >
      <ReactFlow
        ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "放大关系图", "controls.zoomOut.ariaLabel": "缩小关系图", "controls.fitView.ariaLabel": "回到概览" }}
        colorMode={resolvedTheme === "dark" ? "dark" : "light"}
        edges={edges}
        maxZoom={1.55}
        minZoom={0.9}
        nodeTypes={nodeTypes}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodesFocusable={false}
        onInit={(instance) => {
          instanceRef.current = instance;
          setFlowReady(true);
        }}
        panOnScroll
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--cg-border)" gap={26} size={1} variant={BackgroundVariant.Dots} />
        <Controls className="cg-perspective-controls" position="bottom-left" showInteractive={false} fitViewOptions={{ minZoom: 0.95, maxZoom: 1.05 }} />
      </ReactFlow>
    </div>
  );
}
