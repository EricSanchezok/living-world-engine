import type { DiscourseMention, DiscourseParagraph, ParticipantDiscourse } from "../contracts/discourse";
import { contentHash } from "../models/model-audit";

export interface PublishedDiscourseSource {
  participantId: string;
  agentId: string;
  revision: number;
  arrival: { id: string; text: string; entities: Array<{ localEntityId: string; name: string; description: string }> };
  beats: Array<{
    id: string;
    submissionId: string | null;
    requested: string | null;
    paragraphs: DiscourseParagraph[];
    entities: Array<{ localEntityId: string; name: string; description: string }>;
    speakers: Array<{ localEntityId: string; label: string; utterance: string }>;
  }>;
  unresolved: ParticipantDiscourse["unresolved"];
}

/** Reconstruct shared reference history from immutable publication records; no model work or truth access. */
export function projectParticipantDiscourse(source: PublishedDiscourseSource): ParticipantDiscourse {
  const entities = new Map<string, ParticipantDiscourse["entities"][number]>();
  const mention = (reference: DiscourseMention, paragraphId: string, known: PublishedDiscourseSource["beats"][number]["entities"]) => {
    const identity = known.find(entity => entity.localEntityId === reference.localEntityId);
    if (!identity) throw new Error("Published reference has no participant-local identity");
    const prior = entities.get(reference.localEntityId);
    entities.set(reference.localEntityId, { localEntityId: identity.localEntityId, label: identity.name,
      description: identity.description, firstMentionParagraphId: prior?.firstMentionParagraphId ?? paragraphId,
      lastMentionParagraphId: paragraphId, surfaces: [...new Set([...(prior?.surfaces ?? []), reference.surface])] });
  };
  for (const entity of source.arrival.entities) {
    // An arrival's explicit known label can establish a referent. Merely knowing an entity cannot.
    if (entity.name.length > 1 && source.arrival.text.includes(entity.name) &&
      source.arrival.entities.filter(candidate => candidate.name === entity.name).length === 1) {
      mention({ localEntityId: entity.localEntityId, surface: entity.name }, source.arrival.id, source.arrival.entities);
    }
  }
  const exchanges: ParticipantDiscourse["exchanges"] = [];
  for (const beat of source.beats) {
    if (!beat.paragraphs.length) continue;
    for (const paragraph of beat.paragraphs) {
      if (!Number.isSafeInteger(paragraph.worldTimeSeconds) || paragraph.worldTimeSeconds < 0) {
        throw new Error("Published paragraph has no valid world-time boundary");
      }
      for (const reference of paragraph.mentions) mention(reference, paragraph.id, beat.entities);
    }
    const previous = exchanges.at(-1);
    const published = beat.paragraphs.map(paragraph => paragraph.text).join("\n");
    const speakers = beat.speakers.filter(speaker => published.includes(speaker.utterance));
    if (previous && previous.submissionId && previous.submissionId === beat.submissionId) {
      previous.paragraphs.push(...structuredClone(beat.paragraphs)); previous.speakers.push(...structuredClone(speakers));
    } else exchanges.push({ id: beat.id, submissionId: beat.submissionId, requested: beat.requested,
      paragraphs: structuredClone(beat.paragraphs), speakers: structuredClone(speakers) });
  }
  const projection: ParticipantDiscourse = {
    version: 1, participantId: source.participantId, agentId: source.agentId, asOfRevision: source.revision,
    arrival: { id: source.arrival.id, text: source.arrival.text }, entities: [...entities.values()],
    exchanges: exchanges.slice(-12), unresolved: structuredClone(source.unresolved), hash: "",
  };
  projection.hash = contentHash(projection);
  return projection;
}
