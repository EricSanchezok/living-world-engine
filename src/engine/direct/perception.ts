import type { AgentState, BeliefPatch, FactValue, LocalEntity, ObservationPacket, SimulationState, WorldEvent } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";
import type { ActionSettlement } from "./world";

function alias(agent: AgentState, entityId: string, introductions: ObservationPacket["introductions"]): LocalEntity {
  const bindings = Object.values(agent.bindings).filter(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === entityId);
  if (bindings.length === 1 && agent.belief.localEntities[bindings[0]!.localEntityId]) return agent.belief.localEntities[bindings[0]!.localEntityId]!;
  const prior = introductions.find(intro => intro.canonicalEntityId === entityId); if (prior) return prior.localEntity;
  const localEntity: LocalEntity = { id: `seen-${contentHash([agent.id, entityId]).slice(0, 24)}`, name: "附近的对象", description: "通过本次观察接触的对象，身份尚未确认。", status: "observed" };
  introductions.push({ localEntity, canonicalEntityId: entityId }); return localEntity;
}
function describeValue(agent: AgentState, value: FactValue, introductions: ObservationPacket["introductions"]): string {
  return value.kind === "entity" ? alias(agent, value.entityId, introductions).name : value.kind === "none" ? "无" : String(value.value);
}
export function directPerception(state: Readonly<SimulationState>, settlements: ActionSettlement[], events: WorldEvent[], step: number) {
  const observations: ObservationPacket[] = [], beliefPatches: BeliefPatch[] = [];
  for (const [index, settlement] of settlements.entries()) {
    const recipients = new Set([settlement.frame.actorId, ...settlement.deliveredToEntityIds.flatMap(id => Object.values(state.agents).filter(agent => agent.entityId === id).map(agent => agent.id))]);
    for (const ownerId of recipients) {
      const agent = state.agents[ownerId]!, introductions: ObservationPacket["introductions"] = [];
      const spoken = settlement.frame.utterance && settlement.deliveredToEntityIds.includes(agent.entityId);
      let summary = spoken ? `${alias(agent, settlement.frame.actorEntityId, introductions).name}说：“${settlement.frame.utterance}”` : settlement.outcome.summary;
      const facts = ownerId === settlement.frame.actorId ? settlement.visibleFacts : [];
      for (const fact of facts) summary += `\n${alias(agent, fact.subjectId, introductions).name}的${fact.predicate}：${describeValue(agent, fact.value, introductions)}`;
      const id = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "observation", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const packet: ObservationPacket = { id, observerId: ownerId, step, kind: "outcome", summary, introductions, apparentClaims: [], sourceEventIds: [events[index]!.id] };
      const evidenceId = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "evidence", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const patch: BeliefPatch = { agentId: ownerId, baseRevision: state.revision + 1, operations: [{ kind: "upsert_evidence", evidence: {
        id: evidenceId, kind: spoken ? "testimony" : "observation", description: summary, sourceId: id, step } }] };
      for (const fact of facts) {
        const subject = alias(agent, fact.subjectId, introductions), target = fact.value.kind === "entity" ? alias(agent, fact.value.entityId, introductions) : null;
        patch.operations.push({ kind: "upsert_claim", claim: { id: `observed-${contentHash([ownerId, fact.id]).slice(0, 24)}`, subjectId: subject.id,
          predicate: fact.predicate, value: target ? { kind: "local_entity", localEntityId: target.id } : fact.value as Exclude<FactValue, { kind: "entity" }>,
          description: `${subject.name}的${fact.predicate}`, confidence: 1, stance: "believed", evidenceIds: [evidenceId] } });
      }
      observations.push(packet); beliefPatches.push(patch);
    }
  }
  return { observations, beliefPatches };
}
