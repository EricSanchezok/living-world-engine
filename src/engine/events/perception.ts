import type { AgentState, BeliefPatch, LocalEntity, ObservationPacket, SimulationState } from "../contracts/model";
import { applyObservationBindings, validateObservations } from "../cognition/observation";
import { applyBeliefPatch } from "../cognition/belief";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";
import type { CommitReceipt, WorldEventCandidate } from "./kernel";

export interface EventPerception {
  observations: ObservationPacket[];
  beliefPatches: BeliefPatch[];
  agents: Record<string, AgentState>;
}

/** Project only committed deliveries. Speech establishes that words were heard, never that their contents are true. */
export function projectEventPerception(state: Readonly<SimulationState>, candidate: WorldEventCandidate, receipt: CommitReceipt): EventPerception {
  const { id, ...body } = receipt;
  const { id: candidateId, ...candidateBody } = candidate;
  if (candidateId !== contentHash(candidateBody) || id !== contentHash(body) || receipt.candidateId !== candidate.id || receipt.afterHash !== contentHash(state) ||
    receipt.eventIds.some(id => !state.truth.events.some(event => event.id === id))) throw new Error("perception lacks a matching committed world receipt");
  const observations: ObservationPacket[] = [], agents = structuredClone(state.agents), patches = new Map<string, BeliefPatch>();
  const lookup = new Map(Object.values(agents).map(agent => [agent.entityId, agent.id]));
  for (const [ordinal, delivery] of candidate.deliveries.entries()) {
    const ownerId = lookup.get(delivery.recipientEntityId); if (!ownerId) continue;
    const agent = agents[ownerId]!, actionIndex = candidate.programs.findIndex(bound => bound.attempt.id === delivery.attemptId);
    if (actionIndex < 0) throw new Error("delivery has no committed attempt");
    const attempt = candidate.programs[actionIndex]!.attempt, eventId = receipt.eventIds[actionIndex]!;
    const observationId = runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "observation", stage: "program-delivery",
      owner: [ownerId, candidate.id], round: 0, ordinal });
    const introductions: ObservationPacket["introductions"] = [];
    let summary = delivery.text;
    if (delivery.kind === "speech") {
      // A known private alias can be reused. Unknown or ambiguous identities get a neutral perceptual alias,
      // never the canonical entity's name, description, or another Agent's self-description.
      const aliases = Object.values(agent.bindings).filter(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === attempt.actorEntityId);
      let speaker: LocalEntity;
      if (aliases.length === 1 && agent.belief.localEntities[aliases[0]!.localEntityId]) speaker = agent.belief.localEntities[aliases[0]!.localEntityId]!;
      else {
        speaker = { id: `perceived-${contentHash([ownerId, observationId, "speaker"]).slice(0, 24)}`, name: "说话者",
          description: "向你传达这段话语的主体，身份尚未确认。", status: "observed" };
        introductions.push({ localEntity: speaker, canonicalEntityId: attempt.actorEntityId });
      }
      summary = `${speaker.name}说：“${delivery.text}”`;
    }
    const packet: ObservationPacket = { id: observationId, observerId: ownerId, step: state.step, kind: "outcome", summary,
      introductions, apparentClaims: [], sourceEventIds: [eventId] };
    observations.push(packet); agents[ownerId] = applyObservationBindings(agent, [packet]);
    const patch = patches.get(ownerId) ?? { agentId: ownerId, baseRevision: state.revision, operations: [] };
    patch.operations.push({ kind: "upsert_evidence", evidence: {
      id: runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "evidence", stage: "program-delivery", owner: ownerId, round: 0, ordinal }),
      kind: delivery.kind === "speech" ? "testimony" : "observation", description: summary, sourceId: observationId, step: state.step,
    } });
    patches.set(ownerId, patch);
  }
  validateObservations(structuredClone(state) as SimulationState, observations, state.step);
  for (const [ownerId, patch] of patches) {
    agents[ownerId]!.belief = applyBeliefPatch(agents[ownerId]!.belief, patch);
    agents[ownerId]!.observationCursorStep = state.step;
  }
  return { observations, beliefPatches: [...patches.values()], agents };
}
