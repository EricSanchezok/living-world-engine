import type { AgentState, BeliefPatch, FactValue, LocalEntity, ObservationPacket, SimulationState, WorldEvent, WorldFact } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";
import type { ActionSettlement } from "./world";
import { directValueLabel, observedKindLabel } from "./presentation";

function alias(agent: AgentState, entityId: string, introductions: ObservationPacket["introductions"], contact?: "heard" | "seen"): LocalEntity {
  const bindings = Object.values(agent.bindings).filter(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === entityId);
  if (bindings.length === 1 && agent.belief.localEntities[bindings[0]!.localEntityId]) return agent.belief.localEntities[bindings[0]!.localEntityId]!;
  const prior = introductions.find(intro => intro.canonicalEntityId === entityId); if (prior) return prior.localEntity;
  const localEntity: LocalEntity = { id: `seen-${contentHash([agent.id, entityId]).slice(0, 24)}`,
    name: contact === "heard" ? "一个陌生的声音" : contact === "seen" ? "附近的人" : "附近的对象",
    description: contact === "heard" ? "听到了说话声，尚未辨认说话者的外貌和身份。" : "通过本次观察接触的对象，身份尚未确认。", status: "observed" };
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
  for (const [index, settlement] of settlements.entries()) {
    const recipients = new Set([settlement.frame.actorId, ...settlement.deliveredToEntityIds.flatMap(id => Object.values(state.agents).filter(agent => agent.entityId === id).map(agent => agent.id))]);
    for (const ownerId of recipients) {
      const agent = state.agents[ownerId]!, introductions: ObservationPacket["introductions"] = [], renamed: LocalEntity[] = [];
      const ownsAction = ownerId === settlement.frame.actorId;
      const seesActor = ownsAction || settlement.actorVisibleToEntityIds?.includes(agent.entityId) === true;
      alias(agent, settlement.frame.actorEntityId, introductions, seesActor ? "seen" : "heard");
      const visibleEntities = ownsAction || seesActor ? [...settlement.visibleEntities] : [];
      if (!ownsAction && seesActor && !visibleEntities.some(entity => entity.id === settlement.frame.actorEntityId)) {
        visibleEntities.push(state.truth.entities[settlement.frame.actorEntityId]!);
      }
      const appearanceFacts = Object.values(state.truth.facts).filter(fact =>
        visibleEntities.some(entity => entity.id === fact.subjectId) && fact.access.kind === "public" &&
        ["appearance", "appearance_label"].includes(fact.predicate));
      const facts = [...new Map([...(ownsAction || seesActor ? settlement.visibleFacts : []), ...appearanceFacts].filter(fact => fact.access.kind === "public" ||
        fact.access.kind === "agents" && fact.access.agentIds.includes(ownerId)).map(fact => [fact.id, fact])).values()];
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
      let summary = spoken ? `${alias(agent, settlement.frame.actorEntityId, introductions).name}${settlement.frame.targetEntityId && targetVisible ? `对${settlement.frame.targetEntityId === agent.entityId ? "你" : targetLabel}` : ""}说：“${settlement.frame.utterance}”` :
        ownerId === settlement.frame.actorId ? `你尝试了“${concreteAttempt}”。${settlement.outcome.summary}${voiced && settlement.frame.kind !== "speak" ? `你说：“${voiced}”` : ""}`
          : `${observedActor}的行动结果：${settlement.outcome.summary.replace(/^你/u, observedActor)}`;
      if (completedExpression && seesActor && settlement.frame.expression?.manner) summary += `\n可见举止：${settlement.frame.expression.manner}`;
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
      if (ownerId === settlement.frame.actorId && settlement.frame.kind === "observe" && settlement.frame.targetEntityId === agent.entityId &&
        ["succeeded", "partial"].includes(settlement.outcome.status)) {
        const inventory = Object.values(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId && quantity.amount > 0)
          .map(quantity => { const resource = state.truth.mechanics.quantities[quantity.definitionId]!; return `${quantity.amount}${resource.unit}${resource.name}`; });
        summary += `\n随身物资：${inventory.join("、") || "无"}。`;
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
        const local = alias(agent, entity.id, introductions);
        const named = settlement.namedEntityIds.includes(entity.id);
        const introduced = introductions.find(intro => intro.localEntity.id === local.id);
        const appearance = facts.find(fact => fact.subjectId === entity.id && fact.predicate === "appearance")?.description;
        const generic = ["附近的对象", "附近的人", "一个陌生的声音"].includes(local.name);
        const label = named ? entity.name : generic
          ? facts.find(fact => fact.subjectId === entity.id && fact.predicate === "appearance_label")?.description ?? local.name : local.name;
        const next = { ...local, name: ["附近的对象", "一个陌生的声音"].includes(label) ? observedKindLabel(entity.kind) : label,
          description: appearance ?? (local.name === "一个陌生的声音" ? "现在可以看见说话的人，但身份还没有确认。" : local.description) };
        if (introduced) introduced.localEntity = next;
        else if (next.name !== local.name || next.description !== local.description) renamed.push(next);
        details.push({ localEntityId: next.id, label: next.name, description: next.description });
        summary += `\n${next.name}：${appearance ?? "你能看见其所在的位置。"}`;
      }
      // A semantic visibility answer cannot grant access to another actor's private truth.
      // Delivered speech remains testimony even when it quotes that private fact correctly.
      for (const fact of facts) summary += `\n${alias(agent, fact.subjectId, introductions).name}：${describeFact(agent, fact, introductions)}`;
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
          manner: completedExpression && seesActor ? settlement.frame.expression?.manner ?? null : null,
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
    }
  }
  return { observations, beliefPatches };
}
