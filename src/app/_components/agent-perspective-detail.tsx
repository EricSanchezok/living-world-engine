"use client";

import type { AgentPerspectiveView } from "../../shared/world-api";
import { perspectiveNodeLabel, relationLabels, type PerspectiveViewNode, type PerspectiveViewRelation } from "../_lib/agent-perspective-graph";

export type PerspectiveReading = {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  records: { id: string; label: string; description: string; evidenceIds: readonly string[] }[];
};

export function entityReading(node: PerspectiveViewNode, perspective: AgentPerspectiveView, relations: readonly PerspectiveViewRelation[], carrying?: string): PerspectiveReading {
  return {
    id: node.id,
    title: node.kind === "self" ? "关于自己的信息" : node.name,
    subtitle: carrying ?? perspectiveNodeLabel(node),
    description: node.kind === "self" ? "" : node.description,
    records: [
      ...Object.values(perspective.character.attitudes)
        .filter((attitude) => attitude.status === "active" && `local:${attitude.subjectId}` === node.id)
        .map((attitude) => ({ id: `attitude:${attitude.id}`, label: "你的态度", description: attitude.description, evidenceIds: attitude.evidenceIds })),
      ...relations.filter((relation) => relation.source === node.id && (relation.origin === "fact" || relation.origin === "claim"))
        .map((relation) => ({ id: relation.id, label: relationLabels[relation.kind], description: relation.description, evidenceIds: relation.evidenceIds })),
    ],
  };
}

const evidenceLabels = { observation: "亲自观察", testimony: "他人证词", inference: "推断", assumption: "假设" } as const;

export function PerspectiveDetail({ reading, perspective }: { reading: PerspectiveReading; perspective: AgentPerspectiveView }) {
  const ids = new Set(reading.records.flatMap((record) => record.evidenceIds));
  const evidence = perspective.knowledge.evidence.filter((item) => ids.has(item.id));
  return <div className="cg-perspective-detail__content">
    {reading.description && <p className="cg-perspective-detail__description">{reading.description}</p>}
    {reading.records.length > 0 && <section aria-label="相关信息" className="cg-perspective-detail__records">
      {reading.records.map((record) => <div className="cg-perspective-record" key={record.id}>
        <span>{record.label}</span><p>{record.description}</p>
        {evidence.some((item) => record.evidenceIds.includes(item.id)) && <small>依据 {evidence.flatMap((item, index) => record.evidenceIds.includes(item.id) ? [index + 1] : []).join("、")}</small>}
      </div>)}
    </section>}
    {evidence.length > 0 && <section className="cg-perspective-evidence" aria-label="信息依据">
      <h4>信息依据 <small>{evidence.length} 条</small></h4>
      <ol>{evidence.map((item) => <li key={item.id}><span>{evidenceLabels[item.kind]}</span><p>{item.description}</p></li>)}</ol>
    </section>}
    {!reading.description && !reading.records.length && <p className="cg-perspective-empty">暂时没有更多信息。</p>}
  </div>;
}
