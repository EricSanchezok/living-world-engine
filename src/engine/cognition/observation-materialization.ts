import type { ModelObservationRenderDraft } from "../contracts/llm-schemas";
import type { ObservationPacket, ObservationPacketDraft, SimulationState } from "../contracts/model";
import { createAgentReferenceResolver, isProposalReference, type ModelReference, type ReferenceResolver } from "../contracts/model-context";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";

export function materializeObservationPackets(
  state: SimulationState,
  packets: readonly ObservationPacketDraft[],
  stage: "stimulus" | "outcome",
  eventAliases: ReadonlyMap<string, string> = new Map(),
): { packets: ObservationPacket[]; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  for (const [ordinal, packet] of packets.entries()) {
    if (aliases.has(packet.id)) throw new Error(`duplicate ${stage} observation alias ${packet.id}`);
    aliases.set(packet.id, runtimeId({
      worldHash: state.worldHash,
      revision: state.revision,
      kind: "observation",
      stage,
      owner: packet.observerId,
      round: 0,
      ordinal,
    }));
  }
  return {
    aliases,
    packets: packets.map((packet, packetOrdinal) => {
      const id = aliases.get(packet.id)!;
      return {
        ...structuredClone(packet),
        id,
        step: state.step + 1,
        kind: stage,
        apparentClaims: packet.apparentClaims.map((claim, claimOrdinal) => ({
          ...structuredClone(claim),
          id: runtimeId({
            worldHash: state.worldHash,
            revision: state.revision,
            kind: "claim",
            stage,
            owner: [packet.observerId, id],
            round: packetOrdinal,
            ordinal: claimOrdinal,
          }),
        })),
        sourceEventIds: packet.sourceEventIds.map((eventId) => eventAliases.get(eventId) ?? eventId),
      };
    }),
  };
}

export interface PrivateStimulusDraft {
  observerId: string;
  stimulus: ModelObservationRenderDraft;
}

/** Project rendered stimuli through each observer's own identity namespace. */
export function materializePrivateStimuli(
  state: SimulationState,
  requests: readonly PrivateStimulusDraft[],
  truthResolver: ReferenceResolver,
): ObservationPacket[] {
  const resolveTruth = (reference: ModelReference, use: Parameters<ReferenceResolver["resolve"]>[1], kind: string): string => {
    if (isProposalReference(reference)) throw new Error(`reaction routing cannot use proposal ${reference.proposalKey} for ${kind}`);
    const resolved = truthResolver.resolve(reference, use);
    if (resolved.kind !== kind) throw new Error(`reaction routing reference ${reference} is ${resolved.kind}, expected ${kind}`);
    return resolved.engineId;
  };
  const materializeStimulus = (request: PrivateStimulusDraft, agentId: string, index: number): ObservationPacketDraft => {
    const agent = state.agents[agentId];
    if (!agent) throw new Error(`reaction request references unknown Agent ${agentId}`);
    const localResolver = createAgentReferenceResolver(agent, []);
    const proposalIds = new Map<string, string>();
    const newLocalId = (key: string): string => {
      if (proposalIds.has(key)) throw new Error(`reaction stimulus duplicates proposalKey ${key}`);
      const id = `reaction-local-${contentHash({ agentId, step: state.step + 1, index, key }).slice(0, 32)}`;
      proposalIds.set(key, id);
      return id;
    };
    const resolveLocal = (reference: ModelReference): string => {
      if (isProposalReference(reference)) {
        const id = proposalIds.get(reference.proposalKey);
        if (!id) throw new Error(`reaction stimulus references undeclared proposalKey ${reference.proposalKey}`);
        return id;
      }
      const resolved = localResolver.resolve(reference, "target");
      if (resolved.kind !== "local_entity") throw new Error(`reaction stimulus reference ${reference} is ${resolved.kind}, expected local_entity`);
      return resolved.engineId;
    };
    const introductions = request.stimulus.introductions.map((introduction) => ({
      localEntity: {
        id: newLocalId(introduction.localEntity.proposalKey),
        name: introduction.localEntity.name,
        description: introduction.localEntity.description,
        status: introduction.localEntity.status,
      },
      canonicalEntityId: introduction.canonicalEntityRef === null
        ? null
        : resolveTruth(introduction.canonicalEntityRef, "target", "entity"),
    }));
    return {
      id: `reaction-stimulus-${index}`,
      observerId: agentId,
      summary: request.stimulus.summary,
      introductions,
      apparentClaims: request.stimulus.apparentClaims.map((claim) => ({
        subjectId: resolveLocal(claim.subjectRef),
        predicate: claim.predicate,
        value: claim.value.kind === "local_entity"
          ? { kind: "local_entity" as const, localEntityId: resolveLocal(claim.value.entityRef) }
          : structuredClone(claim.value),
        description: claim.description,
      })),
      sourceEventIds: request.stimulus.sourceEventRefs.map((reference) => resolveTruth(reference, "source", "event")),
    };
  };
  return materializeObservationPackets(
    state,
    requests.map((request, index) => materializeStimulus(request, request.observerId, index)),
    "stimulus",
  ).packets;
}
