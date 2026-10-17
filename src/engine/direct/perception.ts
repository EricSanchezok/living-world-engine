import type { AgentState, BeliefPatch, FactValue, LocalEntity, ObservationPacket, SimulationState, WorldEvent, WorldFact } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";
import type { ActionSettlement } from "./world";
import { directValueLabel, observedKindLabel } from "./presentation";

function alias(agent: AgentState, entityId: string, introductions: ObservationPacket["introductions"], contact?: "heard" | "seen"): LocalEntity {
  const bindings = Object.values(agent.bindings).filter(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === entityId);
  const known = bindings.map(binding => agent.belief.localEntities[binding.localEntityId]).filter((entity): entity is LocalEntity => Boolean(entity))
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (known) return known;
  const prior = introductions.find(intro => intro.canonicalEntityId === entityId); if (prior) return prior.localEntity;
  const localEntity: LocalEntity = { id: `seen-${contentHash([agent.id, entityId]).slice(0, 24)}`,
    name: contact === "heard" ? "一个陌生的声音" : contact === "seen" ? "附近的人" : "关系所指的对象",
    description: contact === "heard" ? "听到了说话声，尚未辨认说话者的外貌和身份。"
      : contact === "seen" ? "通过本次观察接触的对象，身份尚未确认。" : "只知道这项关系指向某个对象，尚未直接看见或辨认它。",
    status: contact ? "observed" : "reported" };
  introductions.push({ localEntity, canonicalEntityId: entityId }); return localEntity;
}
function describeValue(agent: AgentState, value: FactValue, introductions: ObservationPacket["introductions"]): string {
  return value.kind === "entity" ? alias(agent, value.entityId, introductions).name : directValueLabel(value);
}
function describeFact(agent: AgentState, fact: WorldFact, introductions: ObservationPacket["introductions"]): string {
  return ["entity", "none"].includes(fact.value.kind) ? `${fact.predicate}（${describeValue(agent, fact.value, introductions)}）` : fact.description;
}
export function directPerception(state: Readonly<SimulationState>, settlements: ActionSettlement[], events: WorldEvent[], step: number) {
  const observations: ObservationPacket[] = [], beliefPatches: BeliefPatch[] = [];
  const recipientsSoFar = new Map<string, AgentState>();
  for (const [index, settlement] of settlements.entries()) {
    const recipients = new Set([settlement.frame.actorId, ...settlement.deliveredToEntityIds.flatMap(id => Object.values(state.agents).filter(agent => agent.entityId === id).map(agent => agent.id))]);
    for (const ownerId of recipients) {
      const agent = recipientsSoFar.get(ownerId) ?? structuredClone(state.agents[ownerId]!);
      recipientsSoFar.set(ownerId, agent);
      const introductions: ObservationPacket["introductions"] = [], renamed: LocalEntity[] = [];
      const ownsAction = ownerId === settlement.frame.actorId;
      const seesActor = ownsAction || settlement.actorVisibleToEntityIds?.includes(agent.entityId) === true;
      alias(agent, settlement.frame.actorEntityId, introductions, seesActor ? "seen" : "heard");
      const visibleEntities = ownsAction || seesActor ? settlement.visibleEntities.filter(entity => ownsAction || !settlement.actorOnlyEntityIds.includes(entity.id)) : [];
      if (!ownsAction && seesActor && !visibleEntities.some(entity => entity.id === settlement.frame.actorEntityId)) {
        visibleEntities.push(state.truth.entities[settlement.frame.actorEntityId]!);
      }
      const appearanceFacts = Object.values(state.truth.facts).filter(fact =>
        visibleEntities.some(entity => entity.id === fact.subjectId) && fact.access.kind === "public" &&
        ["appearance", "appearance_label"].includes(fact.predicate));
      const eventFacts = ownsAction || seesActor ? settlement.visibleFacts.filter(fact => ownsAction || !settlement.actorOnlyFactIds.includes(fact.id)) : [];
      const facts = [...new Map([...eventFacts, ...appearanceFacts].filter(fact => fact.access.kind === "public" ||
        fact.access.kind === "agents" && fact.access.agentIds.includes(ownerId) ||
        fact.access.kind === "discoverable" && ownsAction && ["succeeded", "partial"].includes(settlement.outcome.status))
        .map(fact => [fact.id, fact])).values()];
      const details: NonNullable<ObservationPacket["scene"]>["details"] = [];
      const targetVisible = seesActor || settlement.frame.targetEntityId === agent.entityId;
      const targetLabel = settlement.frame.targetEntityId && targetVisible ? alias(agent, settlement.frame.targetEntityId, introductions).name : "四周";
      const concreteAttempt = ownsAction && settlement.frame.expression?.attempt ? settlement.frame.expression.attempt
        : settlement.frame.kind === "move" ? `走向${targetLabel}`
        : settlement.frame.kind === "observe" ? settlement.frame.observationScope === "inventory" ? "清点随身物资" : `查看${targetLabel}`
        : settlement.frame.kind === "wait" ? "等候新的消息或条件变化"
        : settlement.frame.expression?.attempt ?? settlement.frame.proposal.rawText;
      const completedExpression = ["succeeded", "partial"].includes(settlement.outcome.status);
      const voiced = completedExpression && settlement.frame.kind !== "reflect" ? settlement.frame.utterance : null;
      const spoken = voiced && settlement.deliveredToEntityIds.includes(agent.entityId);
      const observedActor = ownerId === settlement.frame.actorId ? "你" : alias(agent, settlement.frame.actorEntityId, introductions).name;
      const speech = voiced && (ownsAction || spoken)
        ? `${observedActor}${settlement.frame.targetEntityId && targetVisible ? `对${settlement.frame.targetEntityId === agent.entityId ? "你" : targetLabel}` : ""}说：“${voiced}”` : null;
      const outcome = ownsAction ? settlement.outcome.summary
        : `${observedActor}的行动结果：${settlement.outcome.summary.replace(/^你/u, observedActor)}`;
      let summary = "";
      if (ownsAction && settlement.frame.kind === "speak" && voiced) {
        const reachedListener = settlement.frame.targetEntityId ? settlement.deliveredToEntityIds.includes(settlement.frame.targetEntityId)
          : settlement.deliveredToEntityIds.length > 0;
        if (!reachedListener) summary += settlement.frame.targetEntityId ? "没有确认对方听见。" : "没有确认有人听见。";
      }
      if (completedExpression && seesActor && settlement.visibleManner) summary += `\n可见举止：${settlement.visibleManner}`;
      if (ownsAction && settlement.frame.kind === "move" && completedExpression) {
        const movement = settlement.operations.find(operation => operation.kind === "place_entity" && operation.entityId === agent.entityId);
        if (movement?.kind === "place_entity" && movement.placementId) {
          const from = state.truth.placements[agent.entityId], destination = alias(agent, movement.placementId, introductions).name;
          summary += from && from !== movement.placementId
            ? `\n你离开了${alias(agent, from, introductions).name}，来到${destination}。`
            : `\n你仍在${destination}范围内。`;
        }
      }
      // Existing records remain in the private evidence store. Copying them into
      // each reflection recursively duplicates the entire history on later turns.
      if (ownerId === settlement.frame.actorId && settlement.frame.kind === "reflect" && settlement.frame.utterance) {
        summary += `\n${settlement.frame.utterance}`;
      }
      if (ownerId === settlement.frame.actorId && settlement.frame.kind === "observe" && settlement.frame.observationScope === "inventory" && settlement.frame.targetEntityId === agent.entityId &&
        ["succeeded", "partial"].includes(settlement.outcome.status)) {
        const inventory = Object.values(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId && quantity.amount > 0)
          .map(quantity => { const resource = state.truth.mechanics.quantities[quantity.definitionId]!; return `${quantity.amount}${resource.unit}${resource.name}`; });
        summary += `\n随身物资：${inventory.join("、") || "无"}。`;
      }
      if (ownsAction) for (const quantity of settlement.inspectedQuantities) {
        const resource = state.truth.mechanics.quantities[quantity.definitionId]!;
        summary += `\n本次清点${alias(agent, quantity.holderId, introductions).name}：${quantity.amount}${resource.unit}${resource.name}。`;
      }
      for (const operation of settlement.operations) if (operation.kind === "transfer_quantity" &&
        (seesActor || operation.fromHolderId === agent.entityId || operation.toHolderId === agent.entityId)) {
        summary += `\n${alias(agent, operation.fromHolderId, introductions).name}向${alias(agent, operation.toHolderId, introductions).name}转移了${operation.amount}${state.truth.mechanics.quantities[operation.definitionId]!.unit}${state.truth.mechanics.quantities[operation.definitionId]!.name}。`;
      }
      for (const operation of settlement.operations) if ((operation.kind === "consume_quantity" || operation.kind === "produce_quantity") && operation.holderId === agent.entityId) {
        const resource = state.truth.mechanics.quantities[operation.definitionId]!;
        summary += `\n本次操作${operation.kind === "consume_quantity" ? "消耗" : "产出"}了${operation.amount}${resource.unit}${resource.name}。`;
      }
      if (ownerId === settlement.frame.actorId || settlement.frame.kind !== "observe") for (const entity of visibleEntities) {
        const local = alias(agent, entity.id, introductions, "seen");
        const named = settlement.namedEntityIds.includes(entity.id);
        const introduced = introductions.find(intro => intro.localEntity.id === local.id);
        const appearance = facts.find(fact => fact.subjectId === entity.id && fact.predicate === "appearance")?.description;
        const generic = ["关系所指的对象", "附近的对象", "附近的人", "一个陌生的声音"].includes(local.name);
        const appearanceLabel = facts.find(fact => fact.subjectId === entity.id && fact.predicate === "appearance_label");
        const label = named ? entity.name : generic
          ? (appearanceLabel?.value.kind === "text" ? appearanceLabel.value.value : appearanceLabel?.description) ?? observedKindLabel(entity.kind) : local.name;
        const next: LocalEntity = { ...local, name: label, status: "observed",
          description: appearance ?? (generic ? "本次可以直接看见这个对象，身份以已经辨认的线索为准。" : local.description) };
        if (introduced) introduced.localEntity = next;
        else if (next.name !== local.name || next.description !== local.description || next.status !== local.status) renamed.push(next);
        details.push({ localEntityId: next.id, label: next.name, description: next.description });
        if (appearance) summary += `\n${next.name}：${appearance}`;
        else if (introduced) summary += `\n你看见了${next.name}。`;
      }
      // A semantic visibility answer cannot grant access to another actor's private truth.
      // Delivered speech remains testimony even when it quotes that private fact correctly.
      for (const fact of facts) {
        const local = alias(agent, fact.subjectId, introductions);
        const label = renamed.find(entity => entity.id === local.id)?.name ?? local.name;
        const description = describeFact(agent, fact, introductions);
        if (fact.predicate !== "appearance_label" && description !== label) summary += `\n${label}：${description}`;
      }
      const findings = [...new Set(summary.split("\n").map(line => line.trim()).filter(Boolean))];
      // Intent is already retained in the action and scene. Present delivered
      // speech and results once, without dropping physical or partial outcomes.
      const omitOutcome = settlement.outcome.status === "succeeded" &&
        (settlement.frame.kind === "observe" && findings.length > 0 || settlement.frame.kind === "speak" && speech !== null);
      summary = [...new Set([speech, omitOutcome ? null : outcome, ...findings]
        .filter((line): line is string => Boolean(line)))].join("\n");
      const id = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "observation", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const actorEntity = alias(agent, settlement.frame.actorEntityId, introductions);
      const actor = ownerId === settlement.frame.actorId ? "你" : renamed.find(entity => entity.id === actorEntity.id)?.name ?? actorEntity.name;
      const knownReference = (entityId: string | null) => {
        if (!entityId) return null;
        const known = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === entityId);
        const local = known ? agent.belief.localEntities[known.localEntityId] : introductions.find(item => item.canonicalEntityId === entityId)?.localEntity;
        return local ? { localEntityId: local.id, label: renamed.find(item => item.id === local.id)?.name ?? local.name } : null;
      };
      const resource = settlement.frame.quantityDefinitionId ? state.truth.mechanics.quantities[settlement.frame.quantityDefinitionId] : null;
      const packet: ObservationPacket = { id, observerId: ownerId, step, kind: "outcome", summary, introductions, apparentClaims: [], sourceEventIds: [events[index]!.id],
        scene: { actionKind: spoken && !seesActor ? "speak" : settlement.frame.kind, status: spoken && !seesActor ? "succeeded" : settlement.outcome.status, actor, actorLocalId: actorEntity.id,
          action: { target: ownsAction || seesActor || settlement.frame.targetEntityId === agent.entityId ? knownReference(settlement.frame.targetEntityId) : null,
            tool: ownsAction || seesActor ? knownReference(settlement.frame.toolEntityId) : null,
            resource: settlement.frame.kind === "transfer" && targetVisible && resource ? { name: resource.name, unit: resource.unit, amount: settlement.frame.amount } : null,
            durationSeconds: settlement.frame.durationSeconds, addressing: voiced ? settlement.frame.targetEntityId ? "direct" : "broadcast" : "none" },
          attempt: ownerId === settlement.frame.actorId ? concreteAttempt : "", outcome: spoken && !seesActor ? `${actor}说：“${voiced}”` : settlement.outcome.summary.replace(/^你/u, actor),
          manner: completedExpression && seesActor ? settlement.visibleManner : null,
          speech: voiced && (ownerId === settlement.frame.actorId || spoken) ? { speaker: actor, speakerLocalId: actorEntity.id, utterance: voiced } : null, details } };
      const evidenceId = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "evidence", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const patch: BeliefPatch = { agentId: ownerId, baseRevision: state.revision + 1, operations: [{ kind: "upsert_evidence", evidence: {
        id: evidenceId, kind: settlement.frame.kind === "reflect" ? "inference" : spoken ? "testimony" : "observation", description: summary, sourceId: id, step } },
        ...renamed.map(entity => ({ kind: "upsert_local_entity" as const, entity }))] };
      for (const fact of facts) {
        const subject = alias(agent, fact.subjectId, introductions), target = fact.value.kind === "entity" ? alias(agent, fact.value.entityId, introductions) : null;
        patch.operations.push({ kind: "upsert_claim", claim: { id: `observed-${contentHash([ownerId, fact.id]).slice(0, 24)}`, subjectId: subject.id,
          predicate: fact.predicate, value: target ? { kind: "local_entity", localEntityId: target.id } : fact.value as Exclude<FactValue, { kind: "entity" }>,
          description: `${subject.name}：${describeFact(agent, fact, introductions)}`, confidence: 1, stance: "believed", evidenceIds: [evidenceId] } });
      }
      observations.push(packet); beliefPatches.push(patch);
      // Concurrent outcomes share one recipient namespace, without mutating source cognition.
      for (const introduction of introductions) {
        agent.belief.localEntities[introduction.localEntity.id] = introduction.localEntity;
        agent.bindings[introduction.localEntity.id] = { localEntityId: introduction.localEntity.id, canonicalEntityIds: introduction.canonicalEntityId ? [introduction.canonicalEntityId] : [] };
      }
      for (const entity of renamed) agent.belief.localEntities[entity.id] = entity;
    }
  }
  return { observations, beliefPatches };
}
