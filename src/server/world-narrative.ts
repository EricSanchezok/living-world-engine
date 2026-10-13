import type { ObservationPacket } from "../engine/contracts/model";
import { contentHash } from "../engine/models/model-audit";
import type { WorldInstanceDocument } from "./world-instance-types";
import { executeDecisionV2 } from "../engine/models/decision-v2";
import type { ModelExecutionScope, StructuredModelProvider } from "../engine/models/model-provider";
import { loadPromptAsset } from "../engine/prompts";
import type { JsonValue } from "../engine/runtime/json";

export interface ScenePacket {
  participantId: string;
  agentId: string;
  submissionId: string | null;
  submittedAt: string | null;
  requestedAction: string | null;
  world: { name: string; language: string; style: string };
  playerName: string;
  location: string | null;
  observations: Array<{ id: string; revision: number; step: number; worldTimeSeconds: number;
    summary: string; scene: NonNullable<ObservationPacket["scene"]> | null; sourceEventIds: string[] }>;
  speech: Array<{ id: string; speaker: string; utterance: string }>;
  memories: Array<{ kind: string; description: string }>;
  knownEntities: Array<{ name: string; description: string }>;
}
export interface NarrativeBeat {
  id: string;
  participantId: string;
  agentId: string;
  submissionId: string | null;
  status: "queued" | "generating" | "complete" | "fallback";
  source: ScenePacket;
  sourceHash: string;
  segments: Array<{ sequence: number; text: string; publishedAt: string }>;
  attempts: number;
  executionIds: string[];
  createdAt: string;
  firstParagraphAt: string | null;
  completedAt: string | null;
  error: string | null;
  producer: { profileId: string; modelId: string | null; promptVersion: string; registryHash: string | null } | null;
  grounding: Array<{ start: number; inputHash: string; choices: string[]; invocationIds: string[] }>;
}

/** The audit retains the request; prose receives only the action that actually executed. */
export function narrativeEvidence(source: ScenePacket) {
  const { requestedAction: _request, ...evidence } = source;
  void _request;
  return evidence;
}

/** Called in the world transaction. Never performs model work. */
export function enqueueNarrative(document: WorldInstanceDocument, now: string): void {
  for (const participant of Object.values(document.participants).filter(p => p.status === "active")) {
    const existing = document.narratives.filter(beat => beat.participantId === participant.id);
    const covered = new Set(existing.flatMap(beat => beat.source.observations.map(o => o.id)));
    const fresh = document.state.history.filter(step => step.revision > participant.controlledSinceRevision)
      .flatMap(step => step.observations.filter(o => o.observerId === participant.agentId && !covered.has(o.id))
        .map(o => ({ id: o.id, revision: step.revision, step: step.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds,
          summary: o.summary, scene: o.scene ?? null, sourceEventIds: [...o.sourceEventIds] })));
    if (!fresh.length) continue;
    const intents = document.participantIntents.filter(intent => intent.participantId === participant.id);
    for (const observation of fresh) {
      const intent = intents.findLast(item => document.runs[item.runId]?.committedRevisions.includes(observation.revision)) ??
        intents.findLast(item => item.revision < observation.revision);
      const submissionId = intent?.submissionId ?? null;
      const pending = document.narratives.findLast(beat => beat.participantId === participant.id && beat.submissionId === submissionId && beat.status === "queued" && beat.attempts === 0);
      const agent = document.state.agents[participant.agentId]!;
      const self = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === agent.entityId);
      const place = document.state.truth.placements[agent.entityId];
      const localPlace = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === place);
      const source: ScenePacket = pending?.source ?? {
        participantId: participant.id, agentId: participant.agentId, submissionId,
        submittedAt: intent?.submittedAt ?? null, requestedAction: intent?.text ?? null,
        world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
        playerName: self ? agent.belief.localEntities[self.localEntityId]?.name ?? participant.displayName : participant.displayName,
        location: localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null,
        observations: [], speech: [],
        knownEntities: Object.values(agent.belief.localEntities).map(entity => ({ name: entity.name, description: entity.description })),
        memories: Object.values(agent.belief.evidence).filter(evidence => evidence.step < observation.step)
          .slice(-12).map(evidence => ({ kind: evidence.kind, description: evidence.description })),
      };
      source.observations.push(observation);
      if (observation.scene?.speech) source.speech.push({ id: `speech-${contentHash(observation.id).slice(0, 16)}`, ...observation.scene.speech });
      if (pending) pending.sourceHash = contentHash(source);
      else document.narratives.push({ id: `scene-${contentHash([participant.id, observation.id]).slice(0, 24)}`,
        participantId: participant.id, agentId: participant.agentId, submissionId, status: "queued", source,
        sourceHash: contentHash(source), segments: [], attempts: 0, executionIds: [], createdAt: now,
        firstParagraphAt: null, completedAt: null, error: null, producer: null, grounding: [] });
    }
  }
  if (document.actionWindow && document.narratives.some(beat => ["queued", "generating"].includes(beat.status) &&
    document.actionWindow!.requiredAgentIds.includes(beat.agentId))) document.actionWindow.deadlineAt = null;
}

/** A single narrow publication decision for each available batch of complete paragraphs. */
export async function checkNarrativeGrounding(provider: StructuredModelProvider, scope: ModelExecutionScope,
  source: ScenePacket, paragraphs: string[], profileId: string, fallbackProfileId: string, ordinal: number) {
  const state = { scene: narrativeEvidence(source), paragraphs } as unknown as JsonValue;
  return executeDecisionV2(provider, { ...scope, profileId, fallbackProfileId, subjectId: source.agentId,
    modelInvocation: ordinal, batch: { version: 2, view: { kind: "agent", agentId: source.agentId, projectionHash: contentHash(state) },
      dependencies: {}, state, questions: Object.fromEntries(paragraphs.map((_, index) => [`paragraph${index}`, {
        type: "choice" as const, version: "narrative-grounding-1", instructions: { task: loadPromptAsset("user/narrative-grounding.md"), index },
        criteria: { grounded: "Faithful expression of supplied facts and delivered speech; only harmless stylistic rendering is added",
          added_content: "Introduces an unsupported person, distinct usable object or possession, action, speech, result, knowledge or meaningful change",
          contradiction: "Changes a known amount, identity, outcome, commitment or evidence status; or chooses new actions or feelings for the player" },
      }])) } });
}

/** Publish closed strings and blank-line-delimited paragraphs inside an open string. */
export function completeParagraphs(text: string): string[] {
  const start = /"paragraphs"\s*:\s*\[/u.exec(text);
  if (!start) return [];
  const result: string[] = [];
  let cursor = start.index + start[0].length;
  while (cursor < text.length) {
    while (/\s|,/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (text[cursor] !== '"') break;
    const from = cursor++;
    let escaped = false, ended = false;
    while (cursor < text.length) {
      const char = text[cursor++]!;
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { ended = true; break; }
    }
    if (!ended) {
      try {
        const partial = JSON.parse(`${text.slice(from, cursor)}"`) as string;
        result.push(...partial.split(/\n\s*\n/u).slice(0, -1).filter(value => value.trim()));
      } catch { /* An unfinished JSON escape is not a publishable boundary. */ }
      break;
    }
    result.push(...(JSON.parse(text.slice(from, cursor)) as string).split(/\n\s*\n/u).filter(value => value.trim()));
  }
  return result;
}
export function renderNarrativeParagraph(text: string, source: ScenePacket): string {
  for (const match of text.matchAll(/[“「]([^”」]+)[”」]/gu)) {
    if (!source.speech.some(speech => speech.utterance === match[1])) throw new Error("Quote differs from delivered speech; use its supplied speech reference instead");
  }
  const rendered = text.replace(/\[\[(speech-[a-f0-9]+)\]\]/gu, (_, id: string) => {
    const speech = source.speech.find(item => item.id === id);
    if (!speech) throw new Error("Narrative referenced an undelivered utterance");
    return `“${speech.utterance}”`;
  }).trim();
  if (!rendered || /\[\[|\]\]/u.test(rendered)) throw new Error("Narrative paragraph is empty or contains an unresolved reference");
  return rendered;
}
export function requireDeliveredSpeech(source: ScenePacket, paragraphs: string[]): void {
  const text = paragraphs.join("\n");
  if (source.speech.some(speech => !text.includes(speech.utterance))) {
    throw new Error("Include the missing delivered speech references after the published prefix; do not replay earlier paragraphs");
  }
}
export function narrativeFallback(source: ScenePacket, published: string[] = []): string {
  const existing = published.join("\n");
  const paragraphs = source.observations.map(observation => {
    const scene = observation.scene;
    if (!scene) return observation.summary;
    return [scene.speech ? existing.includes(scene.speech.utterance) ? "" : `${scene.speech.speaker}说：“${scene.speech.utterance}”` : scene.outcome,
      ...(published.length ? [] : scene.details.map(detail => `${detail.label}：${detail.description}`)),
      ...observation.summary.split("\n").slice(1).filter(line => line.startsWith("随身物资：") || line.includes("转移了"))]
      .filter(text => text && !existing.includes(text)).filter((text, index, all) => all.indexOf(text) === index).join("\n");
  }).filter(text => text && !existing.includes(text));
  return paragraphs.join("\n\n") || (published.length ? "" : "眼前的情况还没有出现新的变化。");
}
