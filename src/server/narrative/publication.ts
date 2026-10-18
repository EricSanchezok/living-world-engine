import { z } from "zod";
import { contentHash } from "../../engine/models/model-audit";
import { executeDecisionV2 } from "../../engine/models/decision-v2";
import type { ModelExecutionScope, StructuredModelProvider } from "../../engine/models/model-provider";
import { loadPromptAsset } from "../../engine/prompts";
import type { JsonValue } from "../../engine/runtime/json";
import type { DiscourseMention, ParticipantDiscourse } from "../../engine/contracts/discourse";
import type { NarrativeBeat, ScenePacket } from "./contracts";
import { executedDescription, narrativeEvidence, narrativeTask, narrativeDiscourse } from "./scene";

export type NarrativePart = { kind: "narration"; text: string } | {
  kind: "delivered_speech"; text: string; speechId: string; speaker: string; speakerLocalId?: string; utterance: string;
};
export interface RenderedNarrativeSegment { text: string; mentions: DiscourseMention[]; parts: NarrativePart[] }

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
    currentObservationIds: source.observations.map(observation => observation.id),
    immutablePublishedParagraphs: published, unpublishedSpeech: unpublishedSpeech(source, published),
    task: published.length
      ? "Continue after the exact published ending. Cover the still-missing result and the listed unpublished speech in order. Do not replay published content. Return no paragraphs only if nothing remains."
      : "Nothing from this beat's rejected draft was shown. Replace only the result of currentObservationIds from publicationTask.newReceipts, including the listed unpublishedSpeech and their actual manner. Earlier same-request receipts and discourse were already observed; they are context, not part of the replacement. Do not treat rejected text as published history." };
}

/** Processing status uses only the participant's existing local identity. */
function recoveryNotice(source: ScenePacket, discourse?: ParticipantDiscourse) {
  const focus = source.knownEntities.find(entity => entity.localEntityId === source.reply?.focusLocalEntityId);
  const description = focus && discourse && !discourse.entities.some(entity => entity.localEntityId === focus.localEntityId)
    ? focus.description.trim().replace(/[。.!！?？]+$/u, "") : "";
  const label = `${focus?.name ?? ""}${description && description !== focus?.name ? `（${description}）` : ""}`;
  return { text: `${label}这一步的回应处理未能完成。已确认的进展仍然保留。`,
    mentions: focus ? [{ localEntityId: focus.localEntityId, surface: focus.name }] : [] };
}

/** A fresh known-responder failure with no world receipt is already fully determined. */
export function directKnownRecovery(beat: Pick<NarrativeBeat, "source" | "attempts" | "segments">, discourse: ParticipantDiscourse) {
  const source = beat.source;
  if (beat.attempts !== 0 || beat.segments.length || source.reply?.kind !== "recovery" ||
    !source.reply.focusLocalEntityId || source.observations.length || source.speech.length ||
    !source.knownEntities.some(entity => entity.localEntityId === source.reply!.focusLocalEntityId)) return null;
  return [recoveryNotice(source, discourse)];
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

const groundingAxes = {
  continuity: "Compare against alreadyPublished and earlier paragraphs in this batch. Choose redundant ONLY if this entire paragraph merely paraphrases information already presented for this result and adds no new finding, speech, answer, actor attribution or material qualification. A limit distinguishing an issued instruction from a completed payment or an unknown answer from NPC ignorance changes meaning and must not be dropped as redundant. Repeated clauses mixed with new information need a continuation repair (added_content), not dropping the new information. A requested recap or comparison may deliberately revisit old information and is grounded. Identify the specific published words that are being repeated; absent such a match, choose grounded on this axis. Other axes own factual accuracy. Newly executed events are not redundant merely because they appeared in a request or anticipated plan.",
  material: "Check only material people, distinct objects, possessions and their presence or whereabouts. An invitation or instruction to fetch someone is speech, not independent evidence that they are absent. Match any absence or arrival claim to an actual observation or movement receipt; otherwise it is unsupported, even if the speaker presupposes it. A narrator saying someone has not yet arrived or been brought over asserts their whereabouts; it is not merely a paraphrase of a request. No arrival receipt is not evidence that a person is still absent. Match them to knownEntities or established scene details. Background workers, tools, wallets and storage containers require actual entries or explicit facts. An intended attempt or expressive manner alone does not establish a new prop. Harmless texture or metaphor on an existing thing is allowed.",
  agency: "Compare each asserted bodily action against publicationTask.newReceipts, the COMPLETE list of newly executed actions. Use spatialEvidence.nonSpeechReceipts for asserted arrivals and departures; a request to summon someone is not movement and does not prove they were absent. This includes small nods, hand movements, handling a board, looking up, or taking another step: dialogue alone does not perform them. A null manner supplies no accompanying gesture. A previous paragraph's action cannot happen again without a new receipt. Observation does not perform the intended use of what was found. A silent use/change with an executed-method receipt does perform that method. Preserve its actual verbs: handling or collecting an object does not also dispense its contents, refill it or move the actor elsewhere. These require their own receipt. Do not make new choices or feelings for the player.",
  evidence: "Check only results, amounts, conditions, elapsed time and history. Preserve observed facts, unresolved attempts and actual inventory. Visible manner supports observable performance, not direct access to another character's private thoughts, motives or silent mental preparation. Keep a speaker's stated thought attributed rather than certifying it as an observed inner fact. Unit conversion must preserve action.durationSeconds using publicationTask.time.elapsedUnits and elapsedReceipts. These equivalents establish only the identified action's duration, not time since the previous paragraph, since departure or for the whole task. A story-gap duration needs evidence for both endpoints. publicationTask.time.previousPublicationInterval supplies the exact gap from the last actually published paragraph boundary to the current boundary; use that duration for an unqualified transition such as ten minutes later. Do not replace it with an action duration or equate it to time since a departure. A null interval supplies no gap. A zero interval means this boundary already has a published prefix. The same interval cannot pass again in another paragraph in this batch. Without interval evidence, omit the gap or qualify the number as that action's duration. These equivalents do not establish repeated solar or calendar transitions. A long local night may exceed ordinary 24-hour days without several sunrises. Current properties follow the latest observation of that subject, not older evidence or another place. A speaker's claim remains attributed; a request or unsupported earlier prose is not evidence. A delivered payment instruction is speech, not a transfer receipt. An unanswered question does not establish that its addressee lacks knowledge. An interrupted next step does not undo earlier events or prove that nothing happened. For recovery, match the interrupted responder to publicationTask.executionBoundary.recoveryFocus, not the original request's addressee. Assigning the interruption to a different person contradicts the supplied identity; a null focus does not identify a responder. Uncommitted response processing is not a half-spoken utterance or interrupted physical act; newSpeech=false supplies no partial dialogue. The focus is not evidence that the player previously addressed them. A generic recovery explanation cannot override earlier receipts: preserve an already completed requested result. Retry or clarification advice requires a specific evidenced unfinished player goal; do not reopen completed work or redirect the original request to the failed focus. Missing findings do not prove physical absence or an empty location: distinguish not yet found from confirmed absent. A transfer receipt records the amount moved; currentHoldings records the balance after that event, so different numbers can both be correct. Earlier delivered replies in publicationTask.alreadyObservedForThisRequest and discourse.exchanges[].speakers establish that those replies occurred, with their recorded actor and requestRelation. No new speech in this packet does not erase a prior answer or refusal. If an answer is recorded, an unqualified claim that the person did not answer contradicts it; do not silently reinterpret that claim as no additional answer. Do not invent a prerequisite, completed test, earlier payment or prior repair.",
  speech: "Check only dialogue and attribution. Current delivered words belong to their supplied speaker; distinguish the player's own voice from the other person's reply. paragraphRendering.delivered_speech parts retain the exact recorded utterance and speaker; compare surrounding narration for a changed attribution or an additional speech event. An unsupported adjacent gesture, location or claim of inaction belongs to its own factual focus, not to this speech focus unless it also asserts unsupported speech. Do not invent, repeat, paraphrase as a second exchange, or change speech. An empty speech list permits no new spoken dialogue. References and ordinary descriptive quotations are allowed.",
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

/** Preserve the checks already paid for when directing a replacement draft. */
export function narrativeGroundingIssue(answers: Record<string, { type: string; choice?: string }>, index: number, paragraph: string): string {
  const failed = Object.entries(groundingAxes).flatMap(([axis, focus]) => {
    const choice = answers[`paragraph${index}_${axis}`]?.choice;
    return choice === "grounded" || choice === "redundant" ? [] : [`${axis} (${choice ?? "unverified"}): ${focus}`];
  });
  return `Rejected paragraph: ${paragraph}\nFailed checks:\n${failed.join("\n")}\nRebuild the affected clause from the current receipts, not from the rejected wording. Omit an unsupported tool, gesture or other detail entirely when the receipts do not establish it; replacing its name with a synonym does not repair the missing evidence. A confirmed result can stand without an invented method. Preserve grounded content and any already published prefix.`;
}

/** Independent factual checks share one publication request per available paragraph batch. */
export async function checkNarrativeGrounding(provider: StructuredModelProvider, scope: ModelExecutionScope,
  source: ScenePacket, rendered: RenderedNarrativeSegment[], profileId: string, fallbackProfileId: string, ordinal: number, discourse?: ParticipantDiscourse, alreadyPublished: string[] = []) {
  const paragraphs = rendered.map(segment => segment.text);
  const evidence = narrativeEvidence(source);
  const state = { publicationInstruction: loadPromptAsset("user/narrative-grounding.md"),
    paragraphs, paragraphRendering: rendered.map(segment => ({ parts: segment.parts })),
    alreadyPublished, scene: evidence, discourse: discourse ? narrativeDiscourse(discourse) : null,
    publicationTask: narrativeTask(source, discourse) } as unknown as JsonValue;
  return executeDecisionV2(provider, { ...scope, profileId, fallbackProfileId, subjectId: source.agentId, instructionProfile: "publication",
    modelInvocation: ordinal, batch: { version: 2, view: { kind: "agent", agentId: source.agentId, projectionHash: contentHash(state) },
      dependencies: {}, state, questions: Object.fromEntries(paragraphs.flatMap((_, index) => Object.entries(groundingAxes).map(([axis, focus]) => [`paragraph${index}_${axis}`, {
        type: "choice" as const, version: "narrative-grounding-9", instructions: { index, focus },
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
/** Only annotation-adjacent literal phrases are redundant; ordinary repetition is prose. */
function repeatsEntitySurface(literal: string, surface: string, side: "before" | "after"): boolean {
  if ([...surface].length < 2) return false;
  const before = side === "before";
  if (before ? !literal.endsWith(surface) : !literal.startsWith(surface)) return false;
  const rest = before ? literal.slice(0, -surface.length) : literal.slice(surface.length);
  const edge = before ? [...surface][0]! : [...surface].at(-1)!;
  const neighbor = before ? [...rest].at(-1) ?? "" : [...rest][0] ?? "";
  return !/[\p{Script=Latin}\p{N}_]/u.test(edge) || !/[\p{L}\p{N}_]/u.test(neighbor);
}

export function renderNarrativeSegment(text: string, source: ScenePacket): RenderedNarrativeSegment {
  const mentions: DiscourseMention[] = [];
  const voicedMentions: DiscourseMention[] = [];
  const bindSpeaker = (speech: ScenePacket["speech"][number]) => {
    if (speech.speakerLocalId && source.knownEntities.some(entity => entity.localEntityId === speech.speakerLocalId)) {
      voicedMentions.push({ localEntityId: speech.speakerLocalId, surface: `“${speech.utterance}”` });
    }
  };
  text = text.replace(/[“"](\[\[speech-[^\]\n]+\]\])[”"]/gu, "$1");
  const standaloneSpeech = /^\s*\[\[speech-[^\]\n]+\]\]\s*$/u.test(text);
  if (/\[\[|\]\]/u.test(text.replace(/\[\[[^\]\n]+\]\]/gu, ""))) throw new Error("Narrative paragraph contains an unresolved reference");
  // Typography is not a speech act. The publication decision checks unsupported
  // quotations; references and delivered-speech completeness remain exact.
  const parts: NarrativePart[] = [];
  const narration = (value: string) => { if (value) parts.push({ kind: "narration", text: value }); };
  let cursor = 0;
  for (const match of text.matchAll(/\[\[([^\]\n]+)\]\]/gu)) {
    const token = match[1]!;
    let literal = text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    if (token.includes("|") && !token.startsWith("speech-")) {
      const separator = token.indexOf("|"), reference = token.slice(0, separator), surface = token.slice(separator + 1).trim();
      const key = reference.slice(reference.lastIndexOf(":") + 1);
      const exact = source.knownEntities.find(entity => entity.localEntityId === key);
      const named = source.knownEntities.filter(entity => entity.name === key);
      const entity = exact ?? (named.length === 1 ? named[0] : undefined);
      if (!surface || !entity) throw new Error("Narrative referenced an unknown local entity");
      if (repeatsEntitySurface(literal, surface, "before")) literal = literal.slice(0, -surface.length);
      if (repeatsEntitySurface(text.slice(cursor), surface, "after")) cursor += surface.length;
      mentions.push({ localEntityId: entity.localEntityId, surface });
      narration(literal + surface);
      continue;
    }
    const speech = source.speech.find(item => item.id === token);
    if (!speech) throw new Error(token.startsWith("speech-") ? "Narrative referenced an undelivered utterance" : "Narrative contains an unresolved reference");
    bindSpeaker(speech);
    // A bare quote still needs its recorded speaker for the reader and publication checks.
    narration(literal + (standaloneSpeech ? `${speech.speaker}：` : ""));
    parts.push({ kind: "delivered_speech", text: `“${speech.utterance}”`, speechId: speech.id,
      speaker: speech.speaker, ...(speech.speakerLocalId ? { speakerLocalId: speech.speakerLocalId } : {}), utterance: speech.utterance });
  }
  narration(text.slice(cursor));
  // Remove annotation-adjacent echoes without promoting literal prose to a
  // delivered reference or editing anything inside the recorded utterance.
  const unique = (part: NarrativePart | undefined): part is Extract<NarrativePart, { kind: "delivered_speech" }> =>
    part?.kind === "delivered_speech" && source.speech.filter(speech => speech.utterance === part.utterance).length === 1;
  for (const [index, part] of parts.entries()) if (part.kind === "narration") {
    const previous = parts[index - 1], next = parts[index + 1];
    if (unique(previous)) while (part.text.trimStart().startsWith(previous.text)) part.text = part.text.trimStart().slice(previous.text.length);
    if (unique(next)) {
      let last: string;
      do {
        last = part.text;
        const duplicate = [next.text, next.utterance].find(value => part.text.trimEnd().endsWith(value));
        if (duplicate) part.text = part.text.trimEnd().slice(0, -duplicate.length);
      } while (part.text !== last);
    }
  }
  const normalized: NarrativePart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    if (unique(part)) {
      const last = normalized.at(-1), previous = last?.kind === "narration" && !last.text.trim() ? normalized.at(-2) : last;
      if (unique(previous) && previous.speechId === part.speechId) {
        if (last !== previous) normalized.pop();
        continue;
      }
    }
    const previous = normalized.at(-1);
    if (part.kind === "narration" && previous?.kind === "narration") previous.text += part.text;
    else normalized.push({ ...part });
  }
  if (normalized[0]?.kind === "narration") normalized[0].text = normalized[0].text.trimStart();
  const last = normalized.at(-1);
  if (last?.kind === "narration") last.text = last.text.trimEnd();
  const rendering = normalized.filter(part => part.text);
  const result = rendering.map(part => part.text).join("");
  if (!result) throw new Error("Narrative paragraph is empty");
  for (const speech of source.speech) if (source.speech.filter(item => item.utterance === speech.utterance).length === 1) {
    if (result.includes(`“${speech.utterance}”`)) bindSpeaker(speech);
  }
  for (const mention of explicitNarrativeMentions(result, source)) if (!mentions.some(existing => existing.localEntityId === mention.localEntityId)) mentions.push(mention);
  // A delivered voice identifies its speaker even when the introduction paraphrases the display label.
  for (const mention of voicedMentions) if (!mentions.some(existing => existing.localEntityId === mention.localEntityId)) mentions.push(mention);
  return { text: result, mentions, parts: rendering };
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

/** Trim an immutable prefix and its provenance together; partial quotes are ordinary prose. */
export function continueNarrativeSegment(segment: RenderedNarrativeSegment, published: string[]): RenderedNarrativeSegment {
  const text = narrativeContinuation(segment.text, published);
  let skip = segment.text.length - text.length;
  const parts = segment.parts.flatMap(part => {
    if (skip >= part.text.length) { skip -= part.text.length; return []; }
    if (skip) { const remaining = part.text.slice(skip); skip = 0; return [{ kind: "narration" as const, text: remaining }]; }
    return [{ ...part }];
  });
  return { text, parts, mentions: segment.mentions.filter(mention => text.includes(mention.surface)) };
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
    // Perceptible findings may accompany any completed action. Use the same
    // executed evidence as publication, without replaying its separate scene tour.
    const factualLines = executedDescription({ ...observation, scene }).split("\n")
      .filter(line => line !== scene.outcome && !scene.details.some(detail =>
        line === `你看见了${detail.label}。` || line === `${detail.label}：${detail.label}` ||
        line.startsWith(`${detail.label}：`) && detail.description.startsWith(line.slice(detail.label.length + 1))));
    const outcome = scene.outcome === "行动已完成。" && factualLines.some(line => line.includes("转移了")) ? "" : scene.outcome;
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
  if (source.reply?.kind === "recovery") {
    const notice = recoveryNotice(source).text;
    // Published context does not establish that the processing boundary was explained.
    if (!existing.includes(notice) && !paragraphs.some(paragraph => paragraph.includes(notice))) paragraphs.push(notice);
    return paragraphs.join("\n\n");
  }
  return paragraphs.join("\n\n") || (published.length ? "" : source.reply
    ? "现有记录还不足以清楚回答这个问题。" : "眼前的情况还没有出现新的变化。");
}
