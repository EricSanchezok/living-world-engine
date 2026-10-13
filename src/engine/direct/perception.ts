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
      const agent = state.agents[ownerId]!, introductions: ObservationPacket["introductions"] = [], renamed: LocalEntity[] = [];
      const appearanceFacts = Object.values(state.truth.facts).filter(fact =>
        settlement.visibleEntities.some(entity => entity.id === fact.subjectId) && fact.access.kind === "public" &&
        ["appearance", "appearance_label"].includes(fact.predicate));
      const facts = [...new Map([...settlement.visibleFacts, ...appearanceFacts].filter(fact => fact.access.kind === "public" ||
        fact.access.kind === "agents" && fact.access.agentIds.includes(ownerId)).map(fact => [fact.id, fact])).values()];
      const details: Array<{ label: string; description: string }> = [];
      const targetLabel = settlement.frame.targetEntityId ? alias(agent, settlement.frame.targetEntityId, introductions).name : "四周";
      const concreteAttempt = settlement.frame.kind === "move" ? `走向${targetLabel}`
        : settlement.frame.kind === "observe" ? settlement.frame.observationScope === "inventory" ? "清点随身物资" : `查看${targetLabel}`
        : settlement.frame.expression?.attempt ?? settlement.frame.proposal.rawText;
      const completedExpression = ["succeeded", "partial"].includes(settlement.outcome.status);
      const voiced = completedExpression && settlement.frame.kind !== "reflect" ? settlement.frame.utterance : null;
      const spoken = voiced && settlement.deliveredToEntityIds.includes(agent.entityId);
      let summary = spoken ? `${alias(agent, settlement.frame.actorEntityId, introductions).name}说：“${settlement.frame.utterance}”` :
        ownerId === settlement.frame.actorId ? `你尝试了“${concreteAttempt}”。${settlement.outcome.summary}${voiced && settlement.frame.kind !== "speak" ? `你说：“${voiced}”` : ""}` : settlement.outcome.summary;
      if (ownerId === settlement.frame.actorId && settlement.frame.kind === "reflect") {
        summary += `\n${settlement.frame.utterance ?? (Object.values(agent.belief.evidence).map(evidence =>
          `${evidence.kind === "testimony" ? "听到的说法" : evidence.kind === "observation" ? "观察记录" : "已有记录"}：${evidence.description}`).join("\n") || "你还没有可供核对的记录。")}`;
      }
      if (ownerId === settlement.frame.actorId && settlement.frame.kind === "observe" && settlement.frame.targetEntityId === agent.entityId &&
        ["succeeded", "partial"].includes(settlement.outcome.status)) {
        const inventory = Object.values(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId && quantity.amount > 0)
          .map(quantity => { const resource = state.truth.mechanics.quantities[quantity.definitionId]!; return `${quantity.amount}${resource.unit}${resource.name}`; });
        summary += `\n随身物资：${inventory.join("、") || "无"}。`;
      }
      for (const operation of settlement.operations) if (operation.kind === "transfer_quantity") {
        summary += `\n${alias(agent, operation.fromHolderId, introductions).name}向${alias(agent, operation.toHolderId, introductions).name}转移了${operation.amount}${state.truth.mechanics.quantities[operation.definitionId]!.unit}${state.truth.mechanics.quantities[operation.definitionId]!.name}。`;
      }
      if (ownerId === settlement.frame.actorId || settlement.frame.kind !== "observe") for (const entity of settlement.visibleEntities) {
        const local = alias(agent, entity.id, introductions);
        const named = settlement.namedEntityIds.includes(entity.id);
        const introduced = introductions.find(intro => intro.localEntity.id === local.id);
        const appearance = facts.find(fact => fact.subjectId === entity.id && fact.predicate === "appearance")?.description;
        const label = named ? entity.name : facts.find(fact => fact.subjectId === entity.id && fact.predicate === "appearance_label")?.description ?? local.name;
        const next = { ...local, name: label === "附近的对象" ? observedKindLabel(entity.kind) : label,
          description: appearance ?? local.description };
        if (introduced) introduced.localEntity = next;
        else if (next.name !== local.name || next.description !== local.description) renamed.push(next);
        details.push({ label: next.name, description: next.description });
        summary += `\n${next.name}：${appearance ?? "你能看见其所在的位置。"}`;
      }
      // A semantic visibility answer cannot grant access to another actor's private truth.
      // Delivered speech remains testimony even when it quotes that private fact correctly.
      for (const fact of facts) summary += `\n${alias(agent, fact.subjectId, introductions).name}：${fact.value.kind === "entity"
        ? describeValue(agent, fact.value, introductions) : fact.description}`;
      const id = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "observation", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const actorEntity = alias(agent, settlement.frame.actorEntityId, introductions);
      const actor = ownerId === settlement.frame.actorId ? "你" : renamed.find(entity => entity.id === actorEntity.id)?.name ?? actorEntity.name;
      const packet: ObservationPacket = { id, observerId: ownerId, step, kind: "outcome", summary, introductions, apparentClaims: [], sourceEventIds: [events[index]!.id],
        scene: { actionKind: settlement.frame.kind, status: settlement.outcome.status, actor, attempt: ownerId === settlement.frame.actorId ? concreteAttempt : "", outcome: settlement.outcome.summary.replace(/^你/u, actor),
          manner: completedExpression ? settlement.frame.expression?.manner ?? null : null,
          speech: voiced && (ownerId === settlement.frame.actorId || spoken) ? { speaker: actor, utterance: voiced } : null, details } };
      const evidenceId = runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "evidence", stage: "direct-perception", owner: ownerId, round: 0, ordinal: index });
      const patch: BeliefPatch = { agentId: ownerId, baseRevision: state.revision + 1, operations: [{ kind: "upsert_evidence", evidence: {
        id: evidenceId, kind: settlement.frame.kind === "reflect" ? "inference" : spoken ? "testimony" : "observation", description: summary, sourceId: id, step } },
        ...renamed.map(entity => ({ kind: "upsert_local_entity" as const, entity }))] };
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
