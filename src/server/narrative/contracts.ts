import type { ObservationPacket } from "../../engine/contracts/model";
import type { JsonValue } from "../../engine/runtime/json";
import type { DiscourseMention, PresentationReply } from "../../engine/contracts/discourse";

export type RequestRelation = "participant_step" | "caused_response" | "concurrent_event" | "unattributed";

export interface ScenePacket {
  participantId: string;
  agentId: string;
  submissionId: string | null;
  submittedAt: string | null;
  requestedAction: string | null;
  world: { name: string; language: string; style: string };
  playerName: string;
  location: string | null;
  boundary: { revision: number; step: number; worldTimeSeconds: number };
  elapsedUnits: Record<string, number>;
  observedPeriodicTransitions: Array<{ subject: string; subjectLocalId: string; predicate: string;
    atWorldTimeSeconds: number; from: string; to: string }>;
  reply: PresentationReply | null;
  observations: Array<{ id: string; revision: number; step: number; worldTimeSeconds: number;
    summary: string; scene: NonNullable<ObservationPacket["scene"]> | null; sourceEventIds: string[] }>;
  speech: Array<{ id: string; speaker: string; speakerLocalId?: string; utterance: string }>;
  memories: Array<{ kind: string; description: string; executedDescription?: string }>;
  knownEntities: Array<{ localEntityId: string; name: string; description: string }>;
  currentHoldings?: { coverage: "complete-current-self-holdings"; quantities: Array<{ name: string; unit: string; amount: number }> };
  observedProperties?: Array<{ subject: string; subjectLocalId: string; predicate: string; value: JsonValue; stance: string; description: string;
    evidenceBoundary: ScenePacket["boundary"] | null }>;
  priorObservedReceipts?: Array<ScenePacket["observations"][number] & { requestRelation: RequestRelation }>;
  knownWork?: Array<{ description: string; status: string }>;
}
export interface NarrativeBeat {
  id: string;
  participantId: string;
  agentId: string;
  submissionId: string | null;
  status: "queued" | "generating" | "complete" | "fallback";
  source: ScenePacket;
  sourceHash: string;
  segments: Array<{ sequence: number; text: string; mentions: DiscourseMention[]; publishedAt: string }>;
  attempts: number;
  executionIds: string[];
  createdAt: string;
  firstParagraphAt: string | null;
  completedAt: string | null;
  error: string | null;
  producer: { profileId: string; modelId: string | null; promptVersion: string; registryHash: string | null } | null;
  grounding: Array<{ start: number; inputHash: string; choices: string[]; invocationIds: string[] }>;
}
