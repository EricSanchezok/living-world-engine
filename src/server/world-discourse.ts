import { projectParticipantDiscourse } from "../engine/cognition/discourse";
import type { ParticipantDiscourse } from "../engine/contracts/discourse";
import type { WorldInstanceDocument } from "./world-instance-types";

/** Reads only this participant's arrival, published segments and their frozen local scene records. */
export function participantDiscourse(document: WorldInstanceDocument, participantId: string, throughBeatId?: string): ParticipantDiscourse {
  const participant = document.participants[participantId];
  if (!participant) throw new Error("Discourse participant does not exist");
  const limit = throughBeatId ? document.narratives.findIndex(beat => beat.id === throughBeatId) : document.narratives.length - 1;
  if (throughBeatId && limit < 0) throw new Error("Discourse publication boundary does not exist");
  const beats = document.narratives.slice(0, limit + 1).filter(beat => beat.participantId === participantId);
  const unresolved = beats.filter(beat => beat.submissionId && (beat.source.reply?.kind === "recovery" ||
    beat.source.observations.some(observation => ["partial", "failed", "blocked", "continuing"].includes(observation.scene?.status ?? ""))))
    .slice(-6).map(beat => ({ submissionId: beat.submissionId!, requested: beat.source.requestedAction ?? "",
      status: beat.source.reply?.kind ?? beat.source.observations.at(-1)?.scene?.status ?? "unknown",
      receipts: beat.source.observations.map(observation => observation.scene?.outcome ?? observation.summary) }));
  return projectParticipantDiscourse({ participantId, agentId: participant.agentId,
    revision: throughBeatId ? document.narratives[limit]!.source.boundary.revision : document.state.revision,
    arrival: { id: participant.arrival.id, text: participant.arrival.scene, entities: participant.arrival.knownEntities },
    beats: beats.map(beat => ({ id: beat.id, submissionId: beat.submissionId, requested: beat.source.requestedAction,
      paragraphs: beat.segments.map(segment => ({ id: `${beat.id}:${segment.sequence}`, text: segment.text,
        worldTimeSeconds: beat.source.boundary.worldTimeSeconds, mentions: segment.mentions })),
      entities: beat.source.knownEntities,
      speakers: beat.source.speech.flatMap(speech => speech.speakerLocalId ? [{ localEntityId: speech.speakerLocalId, label: speech.speaker, utterance: speech.utterance }] : []) })),
    unresolved });
}
