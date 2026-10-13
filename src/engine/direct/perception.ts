import type { AgentState, BeliefPatch, FactValue, LocalEntity, ObservationPacket, SimulationState, WorldEvent } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";
import type { ActionSettlement } from "./world";
import { directValueLabel, observedKindLabel } from "./presentation";

function alias(agent: AgentState, entityId: string, introductions: ObservationPacket["introductions"]): LocalEntity {
  const bindings = Object.values(agent.bindings).filter(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === entityId);
  if (bindings.length === 1 && agent.belief.localEntities[bindings[0]!.localEntityId]) return agent.belief.localEntities[bindings[0]!.localEntityId]!;
  const prior = introductions.find(intro => intro.canonicalEntityId === entityId); if (prior) return prior.localEntity;
  const localEntity: LocalEntity = { id: `seen-${contentHash([agent.id, entityId]).slice(0, 24)}`, name: "附近的对象", description: "通过本次观察接触的对象，身份尚未确认。", status: "observed" };
  introductions.push({ localEntity, canonicalEntityId: entityId }); return localEntity;
}
function describeValue(agent: AgentState, value: FactValue, introductions: ObservationPacket["introductions"]): string {
  return value.kind === "entity" ? alias(agent, value.entityId, introductions).name : directValueLabel(value);
}
export function directPerception(state: Readonly<SimulationState>, settlements: ActionSettlement[], events: WorldEvent[], step: number) {
  const observations: ObservationPacket[] = [], beliefPatches: BeliefPatch[] = [];
  for (const [index, settlement] of settlements.entries()) {
    const recipients = new Set([settlement.frame.actorId, ...settlement.deliveredToEntityIds.flatMap(id => Object.values(state.agents).filter(agent => agent.entityId === id).map(agent => agent.id))]);
    for (const ownerId of recipients) {
      const agent = state.agents[ownerId]!, introductions: ObservationPacket["introductions"] = [];
      const spoken = settlement.frame.utterance && settlement.deliveredToEntityIds.includes(agent.entityId);
      let summary = spoken ? `${alias(agent, settlement.frame.actorEntityId, introductions).name}说：“${settlement.frame.utterance}”` :
        ownerId === settlement.frame.actorId ? `你尝试了“${settlement.frame.proposal.rawText}”。${settlement.outcome.summary}` : settlement.outcome.summary;
      if (ownerId === settlement.frame.actorId && settlement.frame.kind === "observe" && settlement.frame.targetEntityId === agent.entityId &&
        ["succeeded", "partial"].includes(settlement.outcome.status)) {
        const inventory = Object.values(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId && quantity.amount > 0)
          .map(quantity => { const resource = state.truth.mechanics.quantities[quantity.definitionId]!; return `${quantity.amount}${resource.unit}${resource.name}`; });
        summary += `\n随身物资：${inventory.join("、") || "无"}。`;
      }
      for (const operation of settlement.operations) if (operation.kind === "transfer_quantity") {
        summary += `\n${alias(agent, operation.fromHolderId, introductions).name}向${alias(agent, operation.toHolderId, introductions).name}转移了${operation.amount}${state.truth.mechanics.quantities[operation.definitionId]!.unit}${state.truth.mechanics.quantities[operation.definitionId]!.name}。`;
      }
      if (ownerId === settlement.frame.actorId) for (const entity of settlement.visibleEntities) {
        const local = alias(agent, entity.id, introductions);
        const introduced = introductions.find(intro => intro.localEntity.id === local.id);
        if (introduced) { introduced.localEntity.name = observedKindLabel(entity.kind);
          introduced.localEntity.description = "这次观察确认了其存在；尚未确认名字和身份。"; }
        summary += `\n你注意到${local.name}。`;
      }
      const facts = ownerId === settlement.frame.actorId ? settlement.visibleFacts : settlement.visibleFacts.filter(fact => fact.access.kind === "public");
      for (const fact of facts) summary += `\n${alias(agent, fact.subjectId, introductions).name}：${fact.value.kind === "entity"
        ? describeValue(agent, fact.value, introductions) : fact.description}`;
      const id = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "observation", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const packet: ObservationPacket = { id, observerId: ownerId, step, kind: "outcome", summary, introductions, apparentClaims: [], sourceEventIds: [events[index]!.id] };
      const evidenceId = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "evidence", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const patch: BeliefPatch = { agentId: ownerId, baseRevision: state.revision + 1, operations: [{ kind: "upsert_evidence", evidence: {
        id: evidenceId, kind: spoken ? "testimony" : "observation", description: summary, sourceId: id, step } }] };
      for (const fact of facts) {
        const subject = alias(agent, fact.subjectId, introductions), target = fact.value.kind === "entity" ? alias(agent, fact.value.entityId, introductions) : null;
        patch.operations.push({ kind: "upsert_claim", claim: { id: `observed-${contentHash([ownerId, fact.id]).slice(0, 24)}`, subjectId: subject.id,
          predicate: fact.predicate, value: target ? { kind: "local_entity", localEntityId: target.id } : fact.value as Exclude<FactValue, { kind: "entity" }>,
          description: fact.value.kind === "entity" ? `${subject.name}的关联对象` : `${subject.name}：${fact.description}`, confidence: 1, stance: "believed", evidenceIds: [evidenceId] } });
      }
      observations.push(packet); beliefPatches.push(patch);
    }
  }
  return { observations, beliefPatches };
}
