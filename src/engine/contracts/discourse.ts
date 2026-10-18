/** Presentation memory uses only the participant's local identities and published text. */
export interface DiscourseMention {
  localEntityId: string;
  surface: string;
}

export interface DiscourseParagraph {
  id: string;
  text: string;
  /** World boundary of the immutable scene owning this published paragraph. */
  worldTimeSeconds: number;
  mentions: DiscourseMention[];
}

export interface ParticipantDiscourse {
  version: 1;
  participantId: string;
  agentId: string;
  asOfRevision: number;
  arrival: { id: string; text: string };
  entities: Array<{
    localEntityId: string;
    label: string;
    description: string;
    firstMentionParagraphId: string;
    lastMentionParagraphId: string;
    surfaces: string[];
  }>;
  exchanges: Array<{
    id: string;
    submissionId: string | null;
    requested: string | null;
    paragraphs: DiscourseParagraph[];
    speakers: Array<{ localEntityId: string; label: string; utterance: string }>;
  }>;
  unresolved: Array<{ submissionId: string; requested: string; status: string; receipts: string[] }>;
  hash: string;
}

/** Explaining already available perception does not create speech, observation or physical time. */
export interface PresentationReply {
  submissionId: string;
  agentId: string;
  kind: "clarification" | "recovery";
  requested: string;
  focusLocalEntityId: string | null;
  reason: string;
}
