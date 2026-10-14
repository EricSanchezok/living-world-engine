import type { ObservationPacket } from "../engine/contracts/model";
import { contentHash } from "../engine/models/model-audit";
import type { WorldInstanceDocument } from "./world-instance-types";
import { executeDecisionV2 } from "../engine/models/decision-v2";
import type { ModelExecutionScope, StructuredModelProvider } from "../engine/models/model-provider";
import { loadPromptAsset } from "../engine/prompts";
import type { JsonValue } from "../engine/runtime/json";
import type { DirectRuntimeState } from "../engine/direct/contracts";
import type { DiscourseMention, ParticipantDiscourse, PresentationReply } from "../engine/contracts/discourse";
import { projectAgentPerspective } from "../engine/cognition/agent-perspective";
import { participantReactionIds } from "../engine/direct/foreground";
import { z } from "zod";

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
  reply: PresentationReply | null;
  observations: Array<{ id: string; revision: number; step: number; worldTimeSeconds: number;
    summary: string; scene: NonNullable<ObservationPacket["scene"]> | null; sourceEventIds: string[] }>;
  speech: Array<{ id: string; speaker: string; speakerLocalId?: string; utterance: string }>;
  memories: Array<{ kind: string; description: string; executedDescription?: string }>;
  knownEntities: Array<{ localEntityId: string; name: string; description: string }>;
  currentHoldings?: { coverage: "complete-current-self-holdings"; quantities: Array<{ name: string; unit: string; amount: number }> };
  observedProperties?: Array<{ subject: string; predicate: string; value: JsonValue; stance: string; description: string }>;
  priorRequestReceipts?: ScenePacket["observations"];
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

/** Coalesce immediate prerequisites and replies; admitted activities and terminal runs remain publishable. */
export function nextNarrative(document: WorldInstanceDocument): NarrativeBeat | undefined {
  const seen = new Set<string>();
  for (const beat of document.narratives) {
    if (!["queued", "generating"].includes(beat.status) || seen.has(beat.participantId)) continue;
    seen.add(beat.participantId);
    if (beat.status === "generating" || beat.attempts > 0 || !beat.submissionId) return beat;
    const data = document.state.executionState?.data;
    const control = data?.kind === "direct-world" ? data as unknown as DirectRuntimeState : null;
    const intent = control?.intents[beat.agentId];
    const run = Object.values(document.runs).findLast(run => run.rootIntents.some(input => input.submissionId === beat.submissionId));
    const prerequisite = beat.source.observations.every(observation => observation.scene?.actor === "你" &&
      ["move", "observe", "reflect"].includes(observation.scene.actionKind) && !observation.scene.speech && observation.scene.status !== "continuing");
    if (prerequisite && intent?.status === "ready" && intent.activeSubmission?.submissionId === beat.submissionId &&
      run && ["queued", "running"].includes(run.status)) continue;
    const ownSpeech = beat.source.observations.length > 0 && beat.source.observations.every(observation =>
      observation.scene?.actor === "你" && observation.scene.actionKind === "speak");
    if (ownSpeech && control && run && ["queued", "running"].includes(run.status) &&
      [...participantReactionIds(document.state, control, [beat.agentId], [beat.submissionId])]
        .some(id => document.policyBindings[id]?.kind === "model" && control.intents[id]?.status === "ready")) continue;
    return beat;
  }
}

/** An expression is an attempted procedure, not a receipt for its physical verbs. */
export function executedDescription(observation: Pick<ObservationPacket, "summary" | "scene">): string {
  if (!observation.scene) return observation.summary;
  return [observation.scene.outcome, ...observation.summary.split("\n").slice(1)].filter(Boolean).join("\n");
}

/** The audit retains attempted actions; prose receives their actually executed part. */
export function narrativeEvidence(source: ScenePacket) {
  const { requestedAction: _request, ...evidence } = source;
  void _request;
  return { ...evidence,
    memories: source.reply ? source.memories.map(memory => ({ kind: memory.kind, description: memory.executedDescription ?? memory.description })) : [],
    observations: source.observations.map(observation => ({ ...observation,
      summary: executedDescription({ ...observation, scene: observation.scene ?? undefined }),
      scene: observation.scene ? { ...observation.scene,
        attempt: observation.scene.actionKind !== "speak" ? observation.scene.attempt : null } : null,
    })),
  };
}

/** A publication task separates new receipts from the prose used to resolve references. */
export function narrativeTask(source: ScenePacket, discourse?: ParticipantDiscourse) {
  return {
    viewpoint: "The participant is the player. Address their character as you in second person; other characters remain third person.",
    responseTo: source.reply?.requested ?? null,
    kind: source.reply?.kind ?? "newly_observed_events",
    ownSpeechOnly: source.observations.length > 0 && source.observations.every(observation =>
      observation.scene?.actor === "你" && observation.scene.actionKind === "speak"),
    executionBoundary: source.reply ? {
      newPhysicalEffects: false, newSpeech: false, elapsedWorldTime: false,
      explanation: source.reply.reason,
      scope: "Only this failed or explanatory boundary; earlier committed steps of the same request remain executed.",
      originalRequest: source.reply.requested,
      earlierCommittedSteps: (source.priorRequestReceipts ?? []).map(observation => ({
        operation: observation.scene?.actionKind ?? null, action: observation.scene?.action ?? null,
        status: observation.scene?.status ?? null, worldTimeSeconds: observation.worldTimeSeconds,
        actualResult: executedDescription({ ...observation, scene: observation.scene ?? undefined }),
      })),
    } : null,
    newReceipts: source.observations.map(observation => ({ id: observation.id,
      actor: observation.scene?.actor ?? null, actorLocalId: observation.scene?.actorLocalId ?? null,
      operation: observation.scene?.actionKind ?? null, status: observation.scene?.status ?? null,
      action: observation.scene?.action ?? null,
      actualResult: executedDescription({ ...observation, scene: observation.scene ?? undefined }) })),
    performedNow: source.observations.map(observation => ({ actor: observation.scene?.actor ?? null,
      operation: observation.scene?.actionKind ?? null, status: observation.scene?.status ?? null,
      currentMethodOrAttention: observation.scene?.actionKind !== "speak" ? observation.scene?.attempt ?? null : null,
      manner: observation.scene?.manner ?? null, result: executedDescription({ ...observation, scene: observation.scene ?? undefined }) })),
    actionBoundary: "These receipts are the complete new action record. Earlier prose is not a new action. No extra gesture, movement, reaction or physical completion is implied by fluent dialogue or by an object's suitability for use.",
    evidenceBoundary: "A partial outcome establishes only its listed effects and observations. It supplies no unstated cause or degree of success. No delivered report means the result is unknown, not that nobody acted. Earlier prose can resolve references but cannot establish a world fact.",
    playerCurrentHoldings: source.currentHoldings?.quantities.map(quantity => `You currently hold ${quantity.amount} ${quantity.unit} of ${quantity.name}.`) ?? [],
    backgroundUse: "Holdings and old properties constrain accuracy; mention them only when they answer the current request or changed in the new receipts.",
    newSpeech: source.speech,
    speechOrder: source.speech.map(speech => ({ reference: `[[${speech.id}]]`, speaker: speech.speaker })),
    publishedForThisRequest: discourse?.exchanges.filter(exchange => exchange.submissionId === source.submissionId)
      .flatMap(exchange => exchange.paragraphs.map(paragraph => paragraph.text)) ?? [],
    firstAppearances: source.knownEntities.filter(entity => !discourse?.entities.some(known => known.localEntityId === entity.localEntityId))
      .map(entity => ({ ...entity, instruction: "If this entity is mentioned, introduce it intelligibly; the reader has not met it in published prose." })),
  };
}

/** Published words resolve references; historic player requests are not new execution evidence. */
export function narrativeDiscourse(discourse: ParticipantDiscourse) {
  return { ...discourse, exchanges: discourse.exchanges.map(({ requested: _requested, ...exchange }) => {
    void _requested; return exchange;
  }), unresolved: discourse.unresolved.map(({ requested: _requested, ...item }) => { void _requested; return item; }) };
}

function unpublishedSpeech(source: ScenePacket, published: string[]) {
  const text = published.join("\n"), used = new Map<string, number>();
  return source.speech.filter(speech => {
    const quote = `“${speech.utterance}”`, ordinal = (used.get(quote) ?? 0) + 1;
    used.set(quote, ordinal);
    return text.split(quote).length - 1 < ordinal;
  });
}

/** A rejected draft is never evidence that its words reached the reader. */
export function narrativeRepair(source: ScenePacket, published: string[], issue: string | null) {
  return { mode: published.length ? "continue_published" : "replace_unpublished", issue,
    immutablePublishedParagraphs: published, unpublishedSpeech: unpublishedSpeech(source, published),
    task: published.length
      ? "Continue after the exact published ending. Cover the still-missing result and the listed unpublished speech in order. Do not replay published content. Return no paragraphs only if nothing remains."
      : "Nothing from the rejected draft was shown. Write the complete supported scene, including every listed delivered line in order and the actual accompanying manner. Do not treat rejected text as published history." };
}

/** Already introduced speakers need no second creative pass to repeat their delivered words. */
export function deliveredDialogue(source: ScenePacket, discourse: ParticipantDiscourse) {
  if (source.reply || !source.speech.length || source.observations.length !== source.speech.length) return null;
  if (source.observations.some(observation => !observation.scene || observation.scene.actionKind !== "speak" ||
    observation.scene.status !== "succeeded" || observation.scene.manner || !observation.scene.speech)) return null;
  const own = source.observations.filter(observation => observation.scene!.actor === "你");
  // Stage directions and compound player expressions retain their creative scene rendering.
  if (own.length && (own.length !== 1 || own[0]!.scene!.speech!.utterance.trim() !== source.requestedAction?.trim())) return null;
  for (const observation of source.observations) {
    const scene = observation.scene!;
    if (scene.actor !== "你" && !discourse.entities.some(entity => entity.localEntityId === scene.actorLocalId)) return null;
    if (scene.details.some(detail => !discourse.entities.some(entity => entity.localEntityId === detail.localEntityId &&
      entity.description === detail.description))) return null;
  }
  return source.speech.map(speech => ({ text: `${speech.speaker}：“${speech.utterance}”`,
    mentions: speech.speakerLocalId && source.knownEntities.some(entity => entity.localEntityId === speech.speakerLocalId)
      ? [{ localEntityId: speech.speakerLocalId, surface: speech.speaker }] : [] }));
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
    const intents = document.participantIntents.filter(intent => intent.participantId === participant.id);
    for (const observation of fresh) {
      const intent = intents.findLast(item => document.runs[item.runId]?.committedRevisions.includes(observation.revision)) ??
        intents.findLast(item => item.revision < observation.revision);
      const submissionId = intent?.submissionId ?? null;
      const pending = document.narratives.findLast(beat => beat.participantId === participant.id && beat.submissionId === submissionId && !beat.source.reply && beat.status === "queued" && beat.attempts === 0);
      const agent = document.state.agents[participant.agentId]!;
      const self = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === agent.entityId);
      const place = document.state.truth.placements[agent.entityId];
      const localPlace = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === place);
      const ownObservations = new Map(document.state.history.flatMap(step => step.observations
        .filter(item => item.observerId === participant.agentId).map(item => [item.id, item] as const)));
      const source: ScenePacket = pending?.source ?? {
        participantId: participant.id, agentId: participant.agentId, submissionId,
        submittedAt: intent?.submittedAt ?? null, requestedAction: intent?.text ?? null,
        world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
        playerName: self ? agent.belief.localEntities[self.localEntityId]?.name ?? participant.displayName : participant.displayName,
        location: localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null,
        boundary: { revision: observation.revision, step: observation.step, worldTimeSeconds: observation.worldTimeSeconds }, reply: null,
        observations: [], speech: [],
        knownEntities: [], observedProperties: [],
        memories: Object.values(agent.belief.evidence).filter(evidence => evidence.step < observation.step)
          .slice(-12).map(evidence => { const recorded = evidence.sourceId ? ownObservations.get(evidence.sourceId) : null;
            return { kind: evidence.kind, description: evidence.description,
              ...(recorded ? { executedDescription: executedDescription(recorded) } : {}) }; }),
      };
      source.knownEntities = Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description }));
      source.currentHoldings = { coverage: "complete-current-self-holdings", quantities: projectAgentPerspective(document.state, agent).mechanics.quantities };
      source.knownWork = Object.values(agent.character.goals).map(goal => ({ description: goal.description, status: goal.status }));
      source.location = localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null;
      source.boundary = { revision: observation.revision, step: observation.step, worldTimeSeconds: observation.worldTimeSeconds };
      source.observedProperties = Object.values(agent.belief.claims).map(claim => ({
        subject: agent.belief.localEntities[claim.subjectId]?.name ?? claim.subjectId, predicate: claim.predicate,
        value: claim.value as unknown as JsonValue, stance: claim.stance, description: claim.description,
      }));
      source.observations.push(observation);
      if (observation.scene?.speech) source.speech.push({ id: `speech-${contentHash(observation.id).slice(0, 16)}`, ...observation.scene.speech });
      if (pending) pending.sourceHash = contentHash(source);
      else document.narratives.push({ id: `scene-${contentHash([participant.id, observation.id]).slice(0, 24)}`,
        participantId: participant.id, agentId: participant.agentId, submissionId, status: "queued", source,
        sourceHash: contentHash(source), segments: [], attempts: 0, executionIds: [], createdAt: now,
        firstParagraphAt: null, completedAt: null, error: null, producer: null, grounding: [] });
    }
    for (const step of document.state.history.filter(item => item.revision > participant.controlledSinceRevision)) {
      const record = step.directEvent; if (!record) continue;
      const intent = record.control.intents[participant.agentId];
      const replies = [...(record.presentation ?? []).filter(reply => reply.agentId === participant.agentId)];
      const failed = intent?.failure;
      if (failed && failed.atRevision === step.baseRevision && !failed.servicePause && intent.activeSubmission) {
        replies.push({ submissionId: intent.activeSubmission.submissionId, agentId: participant.agentId, kind: "recovery",
          requested: intent.activeSubmission.rawText, focusLocalEntityId: null,
          reason: "Processing the next unperformed step was interrupted before it could commit. The original request may contain earlier steps that already completed: use earlierCommittedSteps to identify and preserve them, including elapsed waiting. Explain only the remaining interruption; retry only the unfinished part. Do not claim the entire original request failed or invent a physical obstacle or refusal." });
      }
      for (const reply of replies) {
        const id = `reply-${contentHash([participant.id, step.revision, reply.submissionId]).slice(0, 24)}`;
        if (document.narratives.some(beat => beat.id === id)) continue;
        const agent = document.state.agents[participant.agentId]!;
        const participantIntent = document.participantIntents.find(item => item.participantId === participant.id && item.submissionId === reply.submissionId);
        const source: ScenePacket = {
          participantId: participant.id, agentId: participant.agentId, submissionId: reply.submissionId,
          submittedAt: participantIntent?.submittedAt ?? null, requestedAction: reply.requested, reply: structuredClone(reply),
          boundary: { revision: step.revision, step: step.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds },
          world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
          playerName: participant.displayName, location: projectAgentPerspective(document.state, agent).self.location?.name ?? null, observations: [], speech: [],
          priorRequestReceipts: reply.kind === "recovery" ? document.narratives.filter(beat =>
            beat.participantId === participant.id && beat.submissionId === reply.submissionId && !beat.source.reply)
            .flatMap(beat => structuredClone(beat.source.observations)) : [],
          currentHoldings: { coverage: "complete-current-self-holdings", quantities: projectAgentPerspective(document.state, agent).mechanics.quantities },
          knownWork: Object.values(agent.character.goals).map(goal => ({ description: goal.description, status: goal.status })),
          knownEntities: Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description })),
          observedProperties: Object.values(agent.belief.claims).map(claim => ({ subject: agent.belief.localEntities[claim.subjectId]?.name ?? claim.subjectId,
            predicate: claim.predicate, value: claim.value as unknown as JsonValue, stance: claim.stance, description: claim.description })),
          memories: Object.values(agent.belief.evidence).map(evidence => {
            const observation = document.state.history.flatMap(item => item.observations).find(item => item.id === evidence.sourceId && item.observerId === participant.agentId);
            return { kind: evidence.kind, description: observation ? executedDescription(observation) : evidence.description };
          }).slice(-16),
        };
        document.narratives.push({ id, participantId: participant.id, agentId: participant.agentId, submissionId: reply.submissionId,
          status: "queued", source, sourceHash: contentHash(source), segments: [], attempts: 0, executionIds: [], createdAt: now,
          firstParagraphAt: null, completedAt: null, error: null, producer: null, grounding: [] });
      }
    }
  }
  if (document.actionWindow && document.narratives.some(beat => ["queued", "generating"].includes(beat.status) &&
    document.actionWindow!.requiredAgentIds.includes(beat.agentId))) document.actionWindow.deadlineAt = null;
}

const groundingAxes = {
  continuity: "Compare against alreadyPublished and earlier paragraphs in this batch. Choose redundant ONLY if this entire paragraph merely paraphrases information already presented for this result and adds no new finding, speech or answer. Repeated clauses mixed with new information need a continuation repair (added_content), not dropping the new information. A requested recap or comparison may deliberately revisit old information and is grounded.",
  material: "Check only material people, distinct objects and possessions. Match them to knownEntities or established scene details. Background workers, tools, wallets and storage containers require actual entries or explicit facts. An intended attempt or expressive manner alone does not establish a new prop. Harmless texture or metaphor on an existing thing is allowed.",
  agency: "Compare each asserted bodily action against performedNow, the COMPLETE list of newly executed actions. This includes small nods, hand movements, handling a board, looking up, or taking another step: dialogue alone does not perform them. A null manner supplies no accompanying gesture. A previous paragraph's action cannot happen again without a new receipt. Observation does not perform the intended use of what was found. A silent use/change with an executed-method receipt does perform that method. Do not make new choices or feelings for the player.",
  evidence: "Check only results, amounts, conditions and history. Preserve observed facts, unresolved attempts and actual inventory. A speaker's claim remains attributed; a request or unsupported earlier prose is not evidence. Do not invent a prerequisite, completed test, earlier payment or prior repair.",
  speech: "Check only dialogue and attribution. Current delivered words belong to their supplied speaker; distinguish the player's own voice from the other person's reply. Do not invent, repeat, paraphrase as a second exchange, or change speech. An empty speech list permits no new spoken dialogue. References and ordinary descriptive quotations are allowed.",
  reference: "Check whether a reader can identify each person or thing referred to using published discourse, this paragraph, and earlier paragraphs in this batch. First appearances need an intelligible introduction using available description or the source of a voice. Do not start with an unexplained definite pronoun as if the reader already met someone. Familiar local identities stay the same across pronouns, name revelations, corrections and topic changes. Clarification may explain earlier words but cannot invent new perception or dialogue.",
} as const;

export function narrativeGroundingChoices(answers: Record<string, { type: string; choice?: string }>, count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const choices = Object.keys(groundingAxes).map(axis => answers[`paragraph${index}_${axis}`]?.choice ?? "added_content");
    if (choices.includes("contradiction")) return "contradiction";
    if (choices.includes("added_content")) return "added_content";
    return answers[`paragraph${index}_continuity`]?.choice === "redundant" ? "redundant" : choices.every(choice => choice === "grounded") ? "grounded" : "added_content";
  });
}

/** Independent factual checks share one publication request per available paragraph batch. */
export async function checkNarrativeGrounding(provider: StructuredModelProvider, scope: ModelExecutionScope,
  source: ScenePacket, paragraphs: string[], profileId: string, fallbackProfileId: string, ordinal: number, discourse?: ParticipantDiscourse, alreadyPublished: string[] = []) {
  const evidence = narrativeEvidence(source);
  const state = { paragraphs, alreadyPublished, scene: evidence, discourse: discourse ? narrativeDiscourse(discourse) : null, publicationTask: narrativeTask(source, discourse) } as unknown as JsonValue;
  return executeDecisionV2(provider, { ...scope, profileId, fallbackProfileId, subjectId: source.agentId, instructionProfile: "publication",
    modelInvocation: ordinal, batch: { version: 2, view: { kind: "agent", agentId: source.agentId, projectionHash: contentHash(state) },
      dependencies: {}, state, questions: Object.fromEntries(paragraphs.flatMap((_, index) => Object.entries(groundingAxes).map(([axis, focus]) => [`paragraph${index}_${axis}`, {
        type: "choice" as const, version: "narrative-grounding-5", instructions: { task: loadPromptAsset("user/narrative-grounding.md"), index, focus,
          executionBoundary: narrativeTask(source, discourse).executionBoundary,
          executedNow: evidence.observations.map(observation => ({ actor: observation.scene?.actor ?? null,
            kind: observation.scene?.actionKind ?? null, status: observation.scene?.status ?? null, receipt: observation.summary })),
        },
        criteria: { grounded: "Faithful expression of supplied facts and delivered speech; only harmless stylistic rendering is added",
          added_content: "Introduces an unsupported person, distinct usable object or possession, action, speech, result, knowledge or meaningful change",
          contradiction: "Changes a known amount, identity, outcome, commitment or evidence status; or chooses new actions or feelings for the player",
          ...(axis === "continuity" ? { redundant: "This whole paragraph adds nothing beyond already published information; omit it without changing any earlier paragraph" } : {}) },
      }]))) } });
}

const flatNarrativeSchema = z.object({
  reading: z.object({ currentResults: z.array(z.string()), remainingUnconfirmed: z.array(z.string()), dialogueSpeakersInOrder: z.array(z.string()) }).optional()
    .describe("Brief source reading BEFORE prose: new results, limits and actual speakers. During recovery, identify only what has not already been published."),
  paragraphs: z.array(z.string().trim().min(1)),
});
// A nested array of strings is the same ordered text, not a semantic error.
// Retain nontext entries so validation still rejects a malformed response.
export const narrativeOutputSchema = z.preprocess(value => {
  if (!value || typeof value !== "object" || !("paragraphs" in value) || !Array.isArray(value.paragraphs)) return value;
  return { ...value, paragraphs: value.paragraphs.flat(Infinity) };
}, flatNarrativeSchema);
export const narrativeOutputJsonSchema = z.toJSONSchema(flatNarrativeSchema, { target: "draft-07" });

/** Publish closed strings and blank-line-delimited paragraphs inside an open string. */
export function completeParagraphs(text: string): string[] {
  const start = /"paragraphs"\s*:\s*\[/u.exec(text);
  if (!start) return [];
  const result: string[] = [];
  let cursor = start.index + start[0].length;
  let depth = 1;
  while (cursor < text.length) {
    while (/\s|,/u.test(text[cursor] ?? "") && cursor < text.length) cursor++;
    if (text[cursor] === "[") { depth++; cursor++; continue; }
    if (text[cursor] === "]") { cursor++; if (--depth === 0) break; continue; }
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
export function renderNarrativeSegment(text: string, source: ScenePacket): { text: string; mentions: DiscourseMention[] } {
  const mentions: DiscourseMention[] = [];
  const voicedMentions: DiscourseMention[] = [];
  const bindSpeaker = (speech: ScenePacket["speech"][number]) => {
    if (speech.speakerLocalId && source.knownEntities.some(entity => entity.localEntityId === speech.speakerLocalId)) {
      voicedMentions.push({ localEntityId: speech.speakerLocalId, surface: `“${speech.utterance}”` });
    }
  };
  text = text.replace(/[“"](\[\[speech-[^\]\n]+\]\])[”"]/gu, "$1");
  if (/\[\[|\]\]/u.test(text.replace(/\[\[[^\]\n]+\]\]/gu, ""))) throw new Error("Narrative paragraph contains an unresolved reference");
  // Typography is not a speech act. The publication decision checks unsupported
  // quotations; references and delivered-speech completeness remain exact.
  const rendered = text.replace(/\[\[([^\]\n]+)\]\]/gu, (_, token: string) => {
    if (token.includes("|") && !token.startsWith("speech-")) {
      const separator = token.indexOf("|"), reference = token.slice(0, separator), surface = token.slice(separator + 1).trim();
      const key = reference.slice(reference.lastIndexOf(":") + 1);
      const exact = source.knownEntities.find(entity => entity.localEntityId === key);
      const named = source.knownEntities.filter(entity => entity.name === key);
      const entity = exact ?? (named.length === 1 ? named[0] : undefined);
      if (!surface || !entity) throw new Error("Narrative referenced an unknown local entity");
      mentions.push({ localEntityId: entity.localEntityId, surface }); return surface;
    }
    const speech = source.speech.find(item => item.id === token);
    if (!speech) throw new Error(token.startsWith("speech-") ? "Narrative referenced an undelivered utterance" : "Narrative contains an unresolved reference");
    bindSpeaker(speech);
    return `“${speech.utterance}”`;
  }).trim();
  if (!rendered) throw new Error("Narrative paragraph is empty");
  // A literal quote followed by its reference can produce the same utterance twice.
  let result = rendered.replace(/(“[^”]+”)(?:\s*\1)+/gu, (repeated, quote: string) =>
    source.speech.filter(speech => speech.utterance === quote.slice(1, -1)).length === 1 ? quote : repeated);
  for (const speech of source.speech) if (source.speech.filter(item => item.utterance === speech.utterance).length === 1) {
    const escaped = speech.utterance.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    result = result.replace(new RegExp(`${escaped}\\s*“${escaped}”`, "gu"), () => `“${speech.utterance}”`);
    if (result.includes(`“${speech.utterance}”`)) bindSpeaker(speech);
  }
  for (const mention of explicitNarrativeMentions(result, source)) if (!mentions.some(existing => existing.localEntityId === mention.localEntityId)) mentions.push(mention);
  // A delivered voice identifies its speaker even when the introduction paraphrases the display label.
  for (const mention of voicedMentions) if (!mentions.some(existing => existing.localEntityId === mention.localEntityId)) mentions.push(mention);
  return { text: result, mentions };
}
export function renderNarrativeParagraph(text: string, source: ScenePacket): string {
  return renderNarrativeSegment(text, source).text;
}
/** Literal unique labels establish references in code-owned factual fallbacks as well. */
export function explicitNarrativeMentions(text: string, source: ScenePacket): DiscourseMention[] {
  return source.knownEntities.filter(entity => entity.name.length > 1 && text.includes(entity.name) &&
    source.knownEntities.filter(other => other.name === entity.name).length === 1)
    .map(entity => ({ localEntityId: entity.localEntityId, surface: entity.name }));
}

/** A continuation may echo its accepted prefix; published text remains immutable. */
export function narrativeContinuation(text: string, published: string[]): string {
  let remaining = text.trim(), previous: string;
  do {
    previous = remaining;
    const echoed = published.find(paragraph => remaining.startsWith(paragraph.trim()));
    if (echoed) remaining = remaining.slice(echoed.trim().length).trim();
  } while (remaining !== previous);
  return remaining;
}
export function requireDeliveredSpeech(source: ScenePacket, paragraphs: string[]): void {
  if (unpublishedSpeech(source, paragraphs).length) {
    throw new Error("Include the missing delivered speech references in their original order. Only actually published paragraphs count as presented; rejected drafts do not.");
  }
}

/** Recovered streams cannot publish a delivered utterance more often than its source events. */
export function assertSpeechMultiplicity(source: ScenePacket, paragraphs: string[]): void {
  const text = paragraphs.join("\n");
  for (const utterance of new Set(source.speech.map(speech => speech.utterance))) {
    const allowed = source.speech.filter(speech => speech.utterance === utterance).length;
    if (text.split(`“${utterance}”`).length - 1 > allowed) {
      throw new Error("This delivered utterance has already been published. Continue with the remaining new result without repeating its speech reference or literal words.");
    }
  }
}

/** A streamed answer cannot precede an earlier, as-yet unpublished question. */
export function assertSpeechOrder(source: ScenePacket, paragraphs: string[]): void {
  const text = paragraphs.join("\n");
  let position = 0;
  for (let index = 0; index < source.speech.length; index++) {
    const speech = source.speech[index]!, quote = `“${speech.utterance}”`;
    const next = text.indexOf(quote, position);
    if (next < 0) {
      if (source.speech.slice(index + 1).some(later => text.indexOf(`“${later.utterance}”`, position) >= 0)) {
        throw new Error(`Preserve the delivered dialogue order: include [[${speech.id}]] from ${speech.speaker} before the later reply. Continue after the published prefix.`);
      }
      return;
    }
    if (source.speech.slice(index + 1).some(later => {
      const earlier = text.indexOf(`“${later.utterance}”`, position);
      return earlier >= 0 && earlier < next;
    })) throw new Error(`Present [[${speech.id}]] from ${speech.speaker} before its later replies. Continue after the published prefix.`);
    position = next + quote.length;
  }
}
export function narrativeFallback(source: ScenePacket, published: string[] = []): string {
  const existing = published.join("\n");
  const speechOccurrences = new Map<string, number>();
  const paragraphs = source.observations.map(observation => {
    const scene = observation.scene;
    if (!scene) return observation.summary;
    const factualLines = observation.summary.split("\n").slice(1).filter(line =>
      line.startsWith("随身物资：") || line.includes("转移了") || line.includes("当前状态：") ||
      line.startsWith("本次操作消耗了") || line.startsWith("本次操作产生了") ||
      scene.actionKind === "observe" && scene.action?.target && line.startsWith(`${scene.action.target.label}：`));
    const outcome = scene.outcome === "行动已完成。" && factualLines.some(line => line.includes("转移了")) ? "" :
      scene.outcome.replace(/^本次已执行的方法：(.+?)。+具体结果以观察到的状态为准。$/u, (_, method: string) => `${scene.actor}${method}。`);
    const manner = scene.manner?.trim().replace(/[。.!！?？]+$/u, "");
    const performedManner = manner ? `${manner.startsWith(scene.actor) ? "" : scene.actor}${manner}` : "";
    const quote = scene.speech ? `“${scene.speech.utterance}”` : null;
    const ordinal = quote ? (speechOccurrences.get(quote) ?? 0) + 1 : 0;
    if (quote) speechOccurrences.set(quote, ordinal);
    const speech = scene.speech && quote && existing.split(quote).length - 1 < ordinal
      ? `${performedManner || `${scene.speech.speaker}说`}：“${scene.speech.utterance}”` : "";
    const details = published.length ? [] : scene.details.map(detail => `你注意到${detail.label}。${detail.description}${/[。.!！?？]$/u.test(detail.description) ? "" : "。"}`);
    return [...details,
      scene.speech ? speech : [performedManner ? `${performedManner}。` : "", outcome].filter(Boolean).join("\n"),
      ...factualLines.map(line => line.replace(/^我向(.+)转移了(.+)。$/u, "你把$2交给了$1。")
        .replace(/^(.+)向我转移了(.+)。$/u, "你收到了$1交给你的$2。"))]
      .filter(text => text && (text === speech || !existing.includes(text))).filter((text, index, all) => all.indexOf(text) === index).join("\n");
  }).filter(Boolean);
  return paragraphs.join("\n\n") || (published.length ? "" : source.reply?.kind === "recovery"
    ? "这一步的回应中断了，已确认的进展仍然保留。你可以接着说明刚才的意思。"
    : source.reply ? "现有记录还不足以清楚回答这个问题。" : "眼前的情况还没有出现新的变化。");
}

/** A paused service cannot generate prose, but its committed receipts are ready. */
export function settleQueuedNarratives(document: WorldInstanceDocument, now: string): void {
  for (const beat of document.narratives.filter(item => item.status === "queued")) {
    const fallback = narrativeFallback(beat.source, beat.segments.map(segment => segment.text));
    if (fallback) beat.segments.push({ sequence: beat.segments.length, text: fallback,
      mentions: explicitNarrativeMentions(fallback, beat.source), publishedAt: now });
    beat.status = "fallback"; beat.completedAt = now;
    if (beat.segments.length) beat.firstParagraphAt ??= now;
  }
}
