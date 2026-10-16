import type {
  AgentPerspectiveView,
  BeliefValue,
  PerspectiveFactValue,
} from "../../shared/world-api";

export type RelationKind = "exact" | "believed" | "suspected" | "disbelieved" | "attitude";
export type RelationSource = "location" | "containment" | "fact" | "claim" | "attitude";
export type ViewNodeKind = "self" | "entity" | "authorized" | "unidentified" | "value";

export interface PerspectiveViewNode {
  id: string;
  kind: ViewNodeKind;
  name: string;
  description: string;
  status: string;
  targetable: boolean;
}

export interface PerspectiveViewRelation {
  id: string;
  source: string;
  target: string;
  label: string;
  description: string;
  kind: RelationKind;
  origin: RelationSource;
  evidenceIds: string[];
}

function localRef(localEntityId: string): string {
  return `local:${localEntityId}`;
}

function factValueLabel(value: PerspectiveFactValue): string {
  switch (value.kind) {
    case "text": return value.value;
    case "number": return String(value.value);
    case "boolean": return value.value ? "是" : "否";
    case "none": return "无";
    case "entity": return value.entityRef;
  }
}

function beliefValueLabel(value: BeliefValue): string {
  switch (value.kind) {
    case "text": return value.value;
    case "number": return String(value.value);
    case "boolean": return value.value ? "是" : "否";
    case "none": return "无";
    case "local_entity": return value.localEntityId;
  }
}

export function buildAgentPerspectiveGraph(perspective: AgentPerspectiveView): {
  nodes: PerspectiveViewNode[];
  relations: PerspectiveViewRelation[];
  selfRef: string;
} {
  const selfRef = localRef(perspective.self.localEntityId);
  const nodeMap = new Map<string, PerspectiveViewNode>();
  for (const entity of perspective.knowledge.entities) {
    nodeMap.set(entity.ref, {
      id: entity.ref,
      kind: entity.ref === selfRef
        ? "self"
        : entity.status === "authorized" || entity.status === "unidentified"
          ? entity.status
          : "entity",
      name: entity.name,
      description: entity.description,
      status: entity.ref === selfRef ? "observed" : entity.status,
      targetable: entity.targetable,
    });
  }
  nodeMap.set(selfRef, {
    id: selfRef,
    kind: "self",
    name: perspective.self.name,
    description: perspective.self.description,
    status: "observed",
    targetable: true,
  });

  const relations: PerspectiveViewRelation[] = [];
  const locationRef = perspective.self.location?.localEntityId
    ? localRef(perspective.self.location.localEntityId)
    : undefined;
  if (locationRef && nodeMap.has(locationRef)) {
    relations.push({
      id: "location:self",
      source: selfRef,
      target: locationRef,
      label: "位于",
      description: `你当前位于${perspective.self.location?.name ?? "这个地点"}。`,
      kind: "exact",
      origin: "location",
      evidenceIds: [],
    });
  }
  relations.push(...perspective.knowledge.containment.map((relation, index): PerspectiveViewRelation => ({
    id: `containment:${index}`,
    source: relation.containerRef,
    target: relation.entityRef,
    label: relation.viaUnknownContainer ? "随身物品" : relation.depth === 1 ? "随身" : "包含",
    description: relation.viaUnknownContainer
      ? "随身携带，但中间容器还没有辨认出来。"
      : relation.depth === 1 ? "这件物品当前直接由你携带。" : "这件物品位于你携带的容器中。",
    kind: "exact",
    origin: "containment",
    evidenceIds: [],
  })));

  perspective.knowledge.exactFacts.forEach((fact, index) => {
    let target: string;
    if (fact.value.kind === "entity") {
      target = fact.value.entityRef;
    } else {
      target = `fact-value:${index}`;
      nodeMap.set(target, {
        id: target,
        kind: "value",
        name: factValueLabel(fact.value),
        description: fact.description,
        status: "authorized",
        targetable: false,
      });
    }
    relations.push({
      id: `fact:${index}`,
      source: fact.subjectRef,
      target,
      label: fact.predicate,
      description: fact.description,
      kind: "exact",
      origin: "fact",
      evidenceIds: [],
    });
  });

  perspective.knowledge.claims.forEach((claim, index) => {
    let target: string;
    if (claim.value.kind === "local_entity") {
      target = localRef(claim.value.localEntityId);
    } else {
      target = `claim-value:${index}`;
      nodeMap.set(target, {
        id: target,
        kind: "value",
        name: beliefValueLabel(claim.value),
        description: claim.description,
        status: claim.stance,
        targetable: false,
      });
    }
    if (!nodeMap.has(localRef(claim.subjectId)) || !nodeMap.has(target)) return;
    relations.push({
      id: `claim:${claim.id}`,
      source: localRef(claim.subjectId),
      target,
      label: claim.predicate,
      description: claim.description,
      kind: claim.stance,
      origin: "claim",
      evidenceIds: claim.evidenceIds,
    });
  });

  for (const attitude of Object.values(perspective.character.attitudes)) {
    const target = localRef(attitude.subjectId);
    if (attitude.status !== "active" || !nodeMap.has(target)) continue;
    relations.push({
      id: `attitude:${attitude.id}`, source: selfRef, target, label: "态度",
      description: attitude.description, kind: "attitude", origin: "attitude", evidenceIds: attitude.evidenceIds,
    });
  }

  return {
    nodes: [...nodeMap.values()].sort((left, right) =>
      Number(right.id === selfRef) - Number(left.id === selfRef) || left.id.localeCompare(right.id)),
    relations: relations.sort((left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target) || left.id.localeCompare(right.id)),
    selfRef,
  };
}

export const relationLabels: Record<RelationKind, string> = {
  attitude: "你的态度", exact: "已知事实", believed: "相信", suspected: "存疑", disbelieved: "不相信",
};

export function perspectiveNodeLabel(node: PerspectiveViewNode): string {
  if (node.kind === "self") return "你";
  const labels: Record<string, string> = {
    observed: "亲自观察", reported: "他人告知", hypothesized: "尚待确认",
    authorized: "已知信息", unidentified: "尚未辨认", ...relationLabels,
  };
  return labels[node.status] ?? "已知信息";
}

/** Keep all direct relations of the focused object in the auxiliary graph. */
export function focusPerspectiveGraph(graph: ReturnType<typeof buildAgentPerspectiveGraph>, focusId: string) {
  const relations = graph.relations.filter((relation) => relation.source === focusId || relation.target === focusId);
  const ids = new Set([focusId, ...relations.flatMap((relation) => [relation.source, relation.target])]);
  return { nodes: graph.nodes.filter((node) => ids.has(node.id)), relations, selfRef: focusId };
}
