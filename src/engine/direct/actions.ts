import type { SimulationState, ModelExecutionAudit, AgentPerspectiveView } from "../contracts/model";
import type { MemoryEpisode } from "../cognition/memory";
import type { ExternalActionInput } from "../runtime/execution";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { JsonValue } from "../runtime/json";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import type { DecisionQuestionV2 } from "../models/decision-v2";
import { runtimeId } from "../runtime/runtime-id";
import { agentCapabilityModels } from "../models/capability-bindings";
import { privateActionView, type PrivateInteraction } from "./views";
import { DirectDecisions, selected } from "./decisions";
import type { ActionExpression, ActionFrame, ActionKind, DirectRuntimeState } from "./contracts";
import { readAction } from "./action-reading";
import { resolveDurationUnits, standardDurationUnits } from "../mechanics/duration-units";
import { cognitiveQuestions, cognitiveUpdate } from "./cognition";
import { orderedValues } from "./state";
import { extendCapability } from "./capabilities";
import type { PresentationReply } from "../contracts/discourse";
import { periodicDeadlineCandidates, periodicDeadlineSeconds } from "./periodic-deadlines";

const kinds: Record<ActionKind | "unknown" | "expand", string> = { move: "Travel to a place", observe: "Inspect, notice or investigate",
  reflect: "Explicitly review records or formulate private thoughts when that is the requested activity; checking a condition before a requested physical action is part of choosing that action, not a separate reflection",
  speak: "Communicate actual words: ask, offer, reply or request someone else's action", transfer: "Personally give or pay an owned resource or object", use: "Use one's body, a tool, ability or object to attempt a concrete physical effect",
  change: "Change a state or access condition, including physically blocking or clearing a route", wait: "Listen without speaking, await an event or continue a long activity", unknown: "Cannot identify any next attempt, even a question or observation",
  expand: "A missing concept or capability is required" };
const actionLabels: Record<ActionKind, string> = { move: "前往", observe: "观察", reflect: "思考", speak: "交谈", transfer: "交付", use: "使用", change: "调整", wait: "等待" };
function choice(field: string, criteria: Record<string, string | Record<string, JsonValue> | JsonValue[] | null>): DecisionQuestionV2 {
  return { type: "choice", version: "direct-action-3", instructions: { field }, criteria };
}
export function literalNumbers(text: string, knownUnits: readonly string[] = []): number[] {
  const values = [...text.matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?![\d.])/gu)].map(match => Number(match[1]));
  // A resource unit can itself be a numeral, such as 两. Keep the complete
  // numeral candidate and add the source span ending before that known unit;
  // semantic choice still determines which amount the action authorizes.
  for (const unit of new Set(knownUnits.filter(Boolean))) {
    const escaped = unit.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?)\\s*${escaped}(?![\\d零〇一二两三四五六七八九十百千万亿点])`, "gu");
    for (const match of text.matchAll(pattern)) values.push(...literalNumbers(match[1]!));
  }
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000, 亿: 100000000 };
  // Whole numeral runs are candidates; interpretation chooses their role and unit.
  // Do not restrict discovery to a fixed list of classifiers such as pieces or liters.
  for (const [token] of text.matchAll(/[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?/gu)) {
    const [integer, fraction] = token.split("点");
    let total = 0, section = 0, digit = 0;
    if (!/[十百千万亿]/u.test(integer!)) total = Number([...integer!].map(char => digits[char]).join(""));
    else {
      for (const char of integer!) {
        if (char in digits) { digit = digits[char]!; continue; }
        const unit = units[char]!;
        if (unit < 10000) section += (digit || 1) * unit;
        else if (unit === 10000) { total += (section + digit) * unit; section = 0; }
        else { total = (total + section + digit) * unit; section = 0; }
        digit = 0;
      }
      total += section + digit;
    }
    values.push(total + (fraction ? Number(`0.${[...fraction].map(char => digits[char]).join("")}`) : 0));
  }
  return [...new Set(values.filter(value => Number.isFinite(value) && value > 0))];
}
export function literalUtterances(text: string): string[] {
  return [...text.matchAll(/[“"「『]([^”"」』]+)[”"」』]/gu)].map(match => match[1]!);
}
/** Exact source spans are candidates, never invented dialogue or canonical facts. */
export function speechSpans(text: string): string[] {
  return [...new Set([text, ...text.split(/(?<=[。！？!?；;])|\n/gu), ...text.split(/[：:]/u).slice(1)]
    .map(value => value.trim()).filter(Boolean))];
}
const calendarTerms = ["day", "days", "week", "weeks", "month", "months", "year", "years", "天", "日", "周", "星期", "月", "年", "夜", "时辰"];
/** Exact source spans retain unresolved calendar units for semantic binding and clarification. */
export function durationSpans(text: string, authoredUnits: Readonly<Record<string, number>> = {}): Array<{ text: string; seconds: number | null }> {
  const units = { ...standardDurationUnits, ...authoredUnits };
  const terms = [...new Set([...Object.keys(units), ...calendarTerms])].sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + (/[a-z]$/iu.test(term) ? "(?![a-z])" : ""));
  const pattern = new RegExp(`(\\d+(?:\\.\\d+)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?|半)\\s*(?:个\\s*)?(${terms.join("|")})(半)?`, "giu");
  const spans: Array<{ text: string; seconds: number | null; end: number }> = [];
  for (const match of text.matchAll(pattern)) {
    const value = match[1] === "半" ? 0.5 : literalNumbers(match[1]!)[0];
    if (value === undefined) continue;
    const scale = units[match[2]!.toLocaleLowerCase("en-US")];
    const candidate = scale === undefined ? null : Math.ceil((value + (match[3] ? 0.5 : 0)) * scale);
    const seconds = candidate !== null && Number.isSafeInteger(candidate) && candidate > 0 ? candidate : null;
    const prior = spans.at(-1), separator = prior ? text.slice(prior.end, match.index) : null;
    if (prior && separator !== null && /^(?:\s|零|又|and)*$/iu.test(separator)) {
      const combined = prior.seconds === null || seconds === null ? null : prior.seconds + seconds;
      prior.text += separator + match[0]; prior.seconds = combined !== null && Number.isSafeInteger(combined) ? combined : null; prior.end = match.index + match[0].length;
    } else spans.push({ text: match[0], seconds, end: match.index + match[0].length });
  }
  return spans.map(({ text, seconds }) => ({ text, seconds }));
}
export function literalDurations(text: string, units: Readonly<Record<string, number>> = {}): Array<{ text: string; seconds: number }> {
  return durationSpans(text, units).filter((span): span is { text: string; seconds: number } => span.seconds !== null);
}
export function actionSeconds(state: Readonly<SimulationState>, profileId: string | null, raw: string, explicitDuration = true): number | null {
  const duration = explicitDuration ? literalDurations(raw)[0] : undefined;
  if (duration) return duration.seconds;
  const profile = profileId ? state.truth.mechanics.temporalProfiles[profileId] : null;
  if (profile?.kind === "fixed") return profile.durationSeconds;
  if (profile?.kind === "staged") return profile.stages.reduce((sum, stage) => sum + stage.durationSeconds, 0);
  // An open-ended activity starts now; its later checkpoints are not time already spent.
  if (profile?.kind === "ongoing") return 1;
  if (profile?.kind === "rate") {
    const escaped = [profile.unit, ...profile.unitAliases].map(unit => unit.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
    const quantity = raw.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:${escaped.join("|")})`, "iu"));
    if (quantity) return Math.max(1, Math.ceil(Number(quantity[1]) / profile.unitsPerPeriod * profile.periodSeconds));
  }
  if (profile?.kind === "conditional" || profile?.kind === "goal") return profile.checkEverySeconds;
  return null;
}

export async function chooseAction(input: { state: Readonly<SimulationState>; definition: WorldRuntimeContract; control: DirectRuntimeState;
  decisions: DirectDecisions; agentId: string; external?: ExternalActionInput; creationEnabled: boolean }) {
  const { state, control, decisions, agentId, external } = input;
  const agent = state.agents[agentId]!, intent = control.intents[agentId]!, view = privateActionView(state, agentId, intent.causeActionId, decisions.scope.memory);
  if (external) intent.activeSubmission = structuredClone(external);
  const configuredProfiles = agentCapabilityModels(state, control, agentId);
  // Autonomous intent and open player language share joint binding before world adjudication.
  const jointInterpretation = !external || input.creationEnabled;
  const profiles = configuredProfiles;
  const goals = orderedValues(agent.character.goals).filter(goal => goal.status === "active");
  const text = external?.rawText ?? "";
  if (external?.discourse && (external.discourse.agentId !== agentId ||
    external.discourse.hash !== contentHash({ ...external.discourse, hash: "" }))) throw new Error("Player discourse does not belong to this perspective");
  const quotes = literalUtterances(text);
  const quantityUnits = orderedValues(state.truth.mechanics.quantities).map(resource => resource.unit);
  const { knowledge, memory } = view.state as unknown as { knowledge: AgentPerspectiveView["knowledge"];
    memory: { summary: string; important: MemoryEpisode[] } };
  // The observation cursor marks processing progress, not the end of retained memory.
  const observedNumbers = knowledge.evidence.flatMap(evidence => literalNumbers(evidence.description, quantityUnits));
  const rememberedNumbers = literalNumbers([memory.summary, ...memory.important.map(item => item.evidence.description)].join("\n"), quantityUnits);
  const amounts = [...new Set([1, ...literalNumbers(text, quantityUnits), ...observedNumbers, ...rememberedNumbers, ...goals.flatMap(goal => literalNumbers(goal.description, quantityUnits))])];
  const known = Object.entries(view.entities).map(([localId]) => [localId, agent.belief.localEntities[localId]!] as const);
  const perspective = view.state as { self: { location: unknown } };
  const targetCriteria = { none: "No separate target is needed. Movement needs the actual destination. Use current_location only for movement within that place; never substitute it for an unavailable destination. Discover an unknown destination through an authorized observation or search first.", ...Object.fromEntries(known.map(([id, entity]) => [id, {
    name: entity.name, description: entity.description,
    relationship: view.entities[id] === agent.entityId ? "self" :
      view.entities[id] === state.truth.placements[agent.entityId] && perspective.self.location ? "current_location" : "known_entity",
  }])) };
  const recipients = known.filter(([id]) => view.entities[id] !== agent.entityId && Object.values(state.agents).some(other => other.entityId === view.entities[id]));
  const recipientCriteria = { none: "This branch has no intended recipient", broadcast: "Speak or shout openly to whoever can hear, without needing a named listener", discover: "No perceptible recipient is available; first find someone",
    ...Object.fromEntries(recipients.map(([id, entity]) => [id, { name: entity.name, description: entity.description }])) };
  const spans = speechSpans(text);
  const resources = Object.keys(state.truth.mechanics.quantities).sort();
  const timing = orderedValues(state.truth.mechanics.temporalProfiles);
  const durationUnits = resolveDurationUnits(state.truth.mechanics.durationUnits, state.truth.placements, agent.entityId);
  const durations = durationSpans(text, durationUnits);
  const priorRequestFrames = external ? state.history.flatMap(step => step.directEvent?.frames ?? [])
    .filter(frame => frame.actorId === agentId && frame.submissionId === external.submissionId) : [];
  const requestAnchor = priorRequestFrames.length ? Math.min(...priorRequestFrames.map(frame => frame.startedAtSeconds)) : state.truth.elapsedSeconds;
  const phaseDeadlines = external && jointInterpretation ? periodicDeadlineCandidates(state, agentId, requestAnchor, [1]) : [];
  const capabilities = control.capabilities.filter(capability => capability.knownToAgentIds.includes(agentId)).sort((a, b) => a.id.localeCompare(b.id));
  const questions: Record<string, DecisionQuestionV2> = {
    ...cognitiveQuestions(state, agentId, knowledge.claims),
    operation: choice(external ? "The next executable action actually requested. Resolve if/only-if conditions using the latest known properties, then select the authorized branch. A conditional request to operate is use/change when its stated conditions are established; do not substitute private reflection for doing it. Unknown conditions permit concrete observation or asking. Do not invent additional prerequisites." : "Choose this NPC's next action from its own goals, commitments, present opportunities and privately delivered interactions. It can pursue its affairs, approach someone, make an offer or warning, inspect, act or wait without a player asking first. Initiative needs a motive, not a compulsory interruption. Use perspective.interactions to identify actual speakers, addressees and results. An information question permits an answer, uncertainty or motivated refusal; a request to inspect or act permits actually doing that work. Saying you will check is not checking. Received materials do not establish their use. Choose an inspection when you need unknown evidence before reporting it.", kinds),
    target: choice("Target of the selected NEXT operation: observe inspects this object, use/change affects this object's properties, move approaches this destination. A machine operated through a control panel is the target; the panel is the tool. In 'inspect an object then report to a person', inspect the object first, not the later listener. Do not select a prerequisite object when the requested effect belongs to another known object.", targetCriteria),
    tool: choice("Separate instrument used on the target, or the item discussed in speech. A control panel used to test a machine is a tool. Select none when no separate instrument is involved.", targetCriteria),
    observation_scope: choice(external ? "If observing, what is actually being inspected? Inspecting one's money, food or possessions selects inventory; reviewing memories selects the reflect operation."
      : "For observation, distinguish the selected entity from an unfocused survey. Keep a concrete target's identity: observing harbor conditions is target, not inspecting the actor. Observing one's possessions uses target=self. Reviewing memories is reflect.", {
      target: "The selected entity; self inspects the actor's own possessions", surroundings: "The immediate surroundings",
      ...(external ? { inventory: "The actor's own actual inventory and resources" } : {}),
    }),
    recipient: choice("If the next action communicates words or transfers goods, select its actual recipient. A transfer goes to the intended payee or beneficiary of the established request or agreement, who may differ from the person requesting it. For a spoken NPC reply, use the speaker of the latest interaction addressed to this NPC, not another person merely mentioned in that question or the listener in an old exchange. Discover a recipient before addressing an unknown person. Ignore for other operations.", recipientCriteria),
    ...(known.length ? { search_location: choice("If the intended recipient has not yet been seen, where does this request seek them? A shopkeeper is sought in that shop, not among unrelated people in the surrounding district. Select a known place, shop, building or landmark to inspect or search around; none means the current surroundings. Entity kinds are world-defined and do not restrict which object can be a search focus.", {
      none: "Current surroundings; no more specific known place",
      ...Object.fromEntries(known.map(([id, entity]) => [id, { name: entity.name, description: entity.description }])),
    }) } : {}),
    amount: choice("The actual quantity of the selected resource authorized by this action or its established terms. A deadline, duration, code or unrelated goal number is not a payment amount. Select unknown if the intended quantity is not among the candidates; never substitute another number.", { unknown: "No established amount", ...Object.fromEntries(amounts.map(amount => [`n${amount}`, String(amount)])) }),
    speech: choice("The actual words THIS speaker should say next. For an NPC answering a question, select words that answer or acknowledge it, not a verbatim copy of the received question. Existing testimony is evidence, not a script to echo.", { none: "No speech", input: "EVERY word of the input is itself dialogue, with NO instruction describing speaking, delivery or movement", create: "The input contains an instruction: express only its intended spoken words, separating any stage direction or physical action",
      ...Object.fromEntries(quotes.map((quote, index) => [`q${index}`, quote])),
      ...Object.fromEntries(spans.map((span, index) => [`span${index}`, { literalWords: span }])) }),
    reflection: choice("If the operation is private reflection, does the request require NEW synthesis, distinctions, a plan or a formulated question? The instruction not to speak aloud concerns delivery; it does not mean no private text is needed.", {
      none: "Only retrieve and review existing records without new conclusions or wording",
      create: "Create the requested private synthesis, analysis, plan or concrete next question from existing evidence",
    }),
    dialogue: choice("communicative intention; guides expression but does not fix wording", { ask_price: "Ask the price of the selected object", request: "Ask the other person to do something without claiming they already did it",
      ask_information: "Ask a question about the present conversation or scene", answer: "Answer the question actually received, including multiple parts",
      greet: "Greet or introduce oneself", explain: "Explain an experience, situation or reason", correct: "Correct a misunderstanding or earlier words",
      apologize: "Apologize or acknowledge an effect on the other person", farewell: "End this conversation naturally",
      offer: "Offer the selected resource amount", accept: "Explicitly accept the currently discussed terms", refuse: "Explicitly refuse the currently discussed terms",
      clarify: "Ask for clearer terms", report: "State the selected existing belief", acknowledge: "Acknowledge and wait for actual evidence", unknown_information: "Tell the questioner that this Agent does not know the requested information" }),
    timing: choice("Choose the temporal profile that fits THIS step's actual scope using temporalCalibrations. Consider the whole utterance, distance, effort and detail of inspection. Default asks the world to judge missing timing; it never means the shortest action. Select prolonged work only when authorized. Checkpoint intervals describe future activity, not elapsed time at its start.", {
      default: "No applicable profile is established; adjudicate the actual duration",
      ...Object.fromEntries(timing.map(profile => [profile.id, { ...profile }])),
    }),
    reflection_duration: choice("For private reflection only, estimate the time to perform the requested mental work using the temporal calibrations. Explicitly bound duration takes precedence. Other operations ignore this field.",
      Object.fromEntries([...new Set([...timing.flatMap(profile => profile.kind === "fixed" ? [profile.durationSeconds] : []), 30])]
        .sort((a, b) => a - b).map(seconds => [`s${seconds}`, `${seconds} seconds`]))),
  };
  if (external) questions.interruption = choice("Does THIS next activity have an explicit condition for stopping before its requested duration ends? Preserve that condition from the original request. An ordinary contingency for a later action, a quoted instruction, or merely wanting a result does not authorize interrupting this activity.", {
    none: "No conditional early stop was requested for this step",
    request: "The original request explicitly says to stop this activity when a future perceived condition occurs",
  });
  if (external) questions.interaction = choice("What kind of response does this input seek in the actual shared conversation? Choose clarification for a reader asking which previously presented person/thing was meant, a recap, their already known location, or the meaning/status of earlier feedback without requesting a new action. Choose world_action for words directed at a character (including elliptical follow-ups), observation of NEW evidence or any actual attempt. A question is not automatically clarification: asking the recent speaker for their name is in-world speech. Use the published exchanges, addressee and current focus; no special command syntax is needed.", {
    world_action: "Act or speak in the world",
    clarification: "Explain already available information without new speech, observation or elapsed world time",
  });
  if (external || durations.length) questions.duration = choice("Which duration or periodic phase endpoint belongs to THIS next concrete step? Bind an instructed wait/activity interval or public phase endpoint, not a quoted deadline, another person's commitment, incidental numeral or future clause. For a periodic endpoint, select only the transition whose TO phase is requested; durationReference separately specifies its relative calendar cycle or occurrence. Each transition appears once. Its shown next-arrival time is context, not a restriction to that occurrence. Use requestCycle, phaseAtRequest and transition.from/to rather than old narrative time descriptions. The engine computes the deadline from the bound phase and reference, anchored to this submission's initial boundary. After a completed wait, a later observation does not repeat that wait. Questions about time do not authorize waiting. Select unresolved when an actual requested endpoint has no matching known schedule/candidate, is ambiguous, already passed or unrepresentable. Never substitute ordinary short timing for an unresolved requested endpoint.", {
    default: "No explicit duration belongs to this next step; use its ordinary world timing",
    unresolved: "This step requests a temporal endpoint that cannot be bound to a supplied exact interval or public cycle",
    ...Object.fromEntries(durations.map((duration, index) => [`d${index}`, duration])),
    ...Object.fromEntries(phaseDeadlines.map((deadline, index) => [`phase${index}`, deadline])),
  });
  questions.expression = { type: "noul", version: "action-expression-1",
    instructions: { field: "Does THIS selected next action need a meaningful physical delivery, gesture, tactic or separation from a compound request beyond choosing new words? Ordinary conversation and new wording alone need none. Select true for an intentional physical manner that changes this interaction, or an explicitly requested gesture. Routine glances, nods and clothing adjustments are not required by speech." } };
  if (resources.length) questions.resource = choice("resource", { none: "No quantified resource", ...Object.fromEntries(resources.map(id => [id, state.truth.mechanics.quantities[id]!.name])) });
  if (!jointInterpretation) for (const [index, resourceId] of resources.entries()) {
    const resource = state.truth.mechanics.quantities[resourceId]!;
    const amountQuestion = questions.amount!;
    if (amountQuestion.type !== "choice") throw new Error("amount selection requires choices");
    questions[`resource_amount_${index}`] = choice(`For the hypothetical branch where THIS actor gives ${resource.name}: how many ${resource.unit} of ${resource.name} does the actor intend to GIVE? This is the outgoing resource, not the price received or another person's side of an exchange. Use the actual commitment and holdings for this named resource. Only used if resource selects ${resourceId}.`, amountQuestion.criteria);
  }
  if (external) questions.transfer_authority = choice("For the hypothetical transfer branch: does this CURRENT submission authorize the PLAYER to give their own goods now? Prior negotiations and another person's demand alone are not permission; an explicit current instruction to pay the accepted price IS permission. Check only the player's stated prerequisites against actual delivered evidence. When the agreed sequence is payment THEN delivery, the absence of later delivery does not block the authorized payment. Do not add a delivery-first prerequisite.", {
    pending: "The player's transfer condition is not established, or the input does not authorize a transfer",
    give: "The player explicitly authorizes their own transfer now, and its stated conditions are met",
    request: "The player asks ANOTHER person to deliver, return or give something; this is speech, not payment by the player",
  });
  const claims = knowledge.claims;
  if (external && jointInterpretation) {
    questions.progress_next = choice("After the selected next operation, what remains of THIS submission's actual intent? Necessary low-risk continuity is authorized by that intent; reaching a waypoint or discovering the route need not end the request. Use currentRequestReceipts and continue feasible remaining work without repeating completed acts. New spending, commitments, voluntary speech or risk choices need authorization. Only the applicable conditional branch runs. Judge progress AFTER the selected step supplies its result: evidence that this very step can obtain permits continuation. An authorized inspection followed by a report continues into a truthful report, even of uncertainty. Only an actual external dependency such as unavailable access, a reply or a new choice requires wait.", {
      complete: "The requested immediate work is covered; no further action is authorized by this input",
      continue: "A distinct requested step or necessary low-risk continuation can be attempted next without a new reply or player choice",
      wait: "Further progress needs another person's reply, unknown evidence, consent or a new player choice",
    });
  }
  if (claims.length) questions.claim = choice("existing belief to express, used only by a report", { none: "No claim to express", ...Object.fromEntries(claims.map(claim =>
    [claim.id, { description: claim.description, value: claim.value as unknown as JsonValue, stance: claim.stance }])) });
  if (capabilities.length) questions.capability = choice("Select a learned capability only when its method and immediate result match THIS request. The same equipment or long-term goal is insufficient. A repair does not express a later test. Choose none for a different procedure or ordinary action.", { none: "Ordinary action without a matching learned capability", ...Object.fromEntries(capabilities.map(capability =>
    [capability.id, { description: capability.description, applicability: capability.applicability, effect: capability.effectDescription }])) });
  if (goals.length) questions.goal = choice("goal", { none: "Respond to the situation without selecting a goal", ...Object.fromEntries(goals.map(goal => [goal.id, goal.description])) });
  const recentActions = state.history.flatMap(entry => {
    const event = entry.directEvent;
    if (!event) return [];
    return event.frames.filter(frame => frame.actorId === agentId).map(frame => ({
      submissionId: frame.submissionId, requested: frame.proposal.goal,
      target: Object.entries(view.entities).find(([, canonicalId]) => canonicalId === frame.targetEntityId)?.[0] ?? null,
      actionKind: frame.kind, attempted: frame.expression?.attempt ?? frame.proposal.rawText,
      preparatoryFor: frame.preparatoryFor,
      outcome: entry.outcomes.find(outcome => outcome.proposalId === frame.id)?.summary ?? null,
      observed: entry.observations.filter(observation => observation.observerId === agentId).map(observation => observation.summary),
    }));
  });
  const currentRequestReceipts = external ? recentActions.filter(action => action.submissionId === external.submissionId) : [];
  const actionPolicy = jointInterpretation ? "Interpret all fields jointly as one next interaction. Current receipts distinguish requested steps from executed work."
    : loadPromptAsset("user/direct-action.md");
  const context = { actionPolicy, temporalCalibrations: state.truth.mechanics.temporalCalibrations, perspective: view.state, submittedAction: external ? { ...external, discourse: undefined } : null, discourse: external?.discourse ?? null, currentRequestReceipts,
    ...(external ? { requestPhase: currentRequestReceipts.length ? "Continue this same submission after its listed receipts" : "New submission: none of this input has executed. Earlier similar actions belong to other requests." } : {}),
    recentActions: recentActions.slice(-6).map(({ requested, target, actionKind, attempted, outcome, preparatoryFor }) => ({ requested, target, actionKind, attempted, outcome, preparatoryFor })),
    ...(external ? { priorRequests: recentActions.filter(action => action.submissionId !== external.submissionId).slice(-3)
      .map(({ requested, target, outcome }) => ({ requested, target, outcome })) } : {}),
    intent: { goalId: intent.goalId, goalProgress: intent.goalProgress, wakeReasons: intent.wakeReasons,
    recentOutcomeIds: intent.recentOutcomeIds }, latestEvidenceIds: knowledge.evidence.filter(evidence => evidence.step === agent.observationCursorStep).map(evidence => evidence.id),
    actionKinds: kinds } as unknown as JsonValue;
  if (external) for (const id of ["operation", "target", "recipient", "amount", "resource", "transfer_authority", "capability", "search_location", "observation_scope", ...Object.keys(questions).filter(id => id.startsWith("progress_"))]) {
    const item = questions[id]; if (!item) continue;
    item.instructions = { ...item.instructions as Record<string, JsonValue>,
      context: "Use submittedAction.rawText, perspective.mechanics.quantities and currentRequestReceipts from the shared state; retain their restrictions and distinguish attempted from settled work." };
    if (["recipient", "target", "search_location"].includes(id)) item.instructions = { ...item.instructions as Record<string, JsonValue>,
      referenceRule: "Resolve the intended local identity against the actual published exchanges, their stable mentions and delivered speakers. Corrections may replace a preceding focus. A prior unsuccessful search does not automatically override the current conversational addressee. If more than one interpretation genuinely remains, preserve uncertainty instead of substituting another person." };
  }
  const inputHash = contentHash({ perspective: view.state, submittedAction: external ?? null, goal: intent.goalId });
  if (!external && inputHash === intent.lastInputHash) {
    intent.status = "waiting"; intent.wakeReasons = []; intent.wait = { entityIds: [], untilSeconds: null, reason: "same-input" };
    return { frame: null, audits: [] as ModelExecutionAudit[], reads: view.reads, cognition: null };
  }
  const reading = jointInterpretation ? await readAction({ decisions, agentId, context, questions, autonomous: !external,
    profileId: external ? configuredProfiles.fallback : configuredProfiles.creation, language: input.definition.narrative.language, quotes }) : null;
  const answers = reading?.answers ?? await decisions.ask(agentId, context, view.reads, questions, profiles);
  const audits: ModelExecutionAudit[] = reading ? reading.audits : [];
  const cognition = cognitiveUpdate(state, agentId, knowledge.claims, answers);
  intent.goalProgress = { ...intent.goalProgress, ...cognition.goals };
  if (answers.urgency?.type === "score") intent.urgency = answers.urgency.score;
  intent.lastInputHash = inputHash; intent.wakeReasons = []; intent.failure = null; intent.dependencies = view.reads;
  let operation = selected(answers, "operation");
  if (external && selected(answers, "interaction") === "request_complete") {
    intent.status = "waiting"; intent.activityId = null; intent.activeSubmission = null; intent.causeActionId = null;
    intent.wait = { entityIds: [], untilSeconds: null, reason: "request-complete" };
    control.completedSubmissionIds.push(external.submissionId);
    return { frame: null, audits, reads: view.reads, cognition };
  }
  if (external && selected(answers, "interaction") === "clarification") {
    intent.status = "waiting"; intent.activityId = null; intent.activeSubmission = null; intent.causeActionId = null;
    intent.wait = { entityIds: [], untilSeconds: null, reason: "presentation-clarification" };
    control.completedSubmissionIds.push(external.submissionId);
    const target = selected(answers, "target");
    const presentation: PresentationReply = { agentId, submissionId: external.submissionId, kind: "clarification", requested: text,
      focusLocalEntityId: agent.belief.localEntities[target] ? target : null,
      reason: "Explain the existing scene and conversation. No new action, perception or speech has occurred." };
    return { frame: null, audits, reads: view.reads, cognition, presentation };
  }
  if (external && !reading && ["speak", "wait", "reflect"].includes(operation) && selected(answers, "transfer_authority") === "give") {
    const resolved = await decisions.ask(agentId, { actionPolicy, currentPlayerRequest: text, perspective: view.state,
      currentRequestReceipts, selectedOperation: operation, authorizedTransfer: { recipient: selected(answers, "recipient"),
        resource: questions.resource ? selected(answers, "resource") : null, amount: selected(answers, "amount") } } as unknown as JsonValue, view.reads, {
      transfer_execution: choice("The first answers disagree: they authorize an immediate transfer but select words or waiting. Resolve only this contradiction against the current request and actually delivered terms. An explicit instruction to give/pay now executes a transfer. A quotation, promise, request for the OTHER person's goods, or proposed deal alone does not. Keep unmet conditions pending.", {
        expression: "Only the selected speech, reflection or waiting is authorized",
        transfer: "The player authorized their own actual handover now",
        unknown: "The condition or permission for a handover remains unknown",
      }),
    }, profiles);
    if (selected(resolved, "transfer_execution") === "transfer") operation = "transfer";
  }
  if (external && !reading && operation === "transfer" && selected(answers, "transfer_authority") !== "give") {
    operation = selected(answers, "transfer_authority") === "request" ? "speak" : "wait";
  }
  intent.goalId = questions.goal && selected(answers, "goal") !== "none" ? selected(answers, "goal") : null;
  let targetKey = ["speak", "transfer"].includes(operation) ? selected(answers, "recipient") : selected(answers, "target");
  if (!reading && operation === "speak" && targetKey === "none") {
    const resolved = await decisions.ask(agentId, { ...context as Record<string, JsonValue>, concreteOperation: "speak",
      selectedSpeech: selected(answers, "speech") }, view.reads, {
      recipient: choice("Resolve the listener of this selected speech against the submitted request. Select broadcast for an open call, discover for an unlocated listener, or none for intentional silence.", recipientCriteria),
    }, profiles);
    targetKey = selected(resolved, "recipient");
    if (targetKey === "none") operation = "wait";
  }
  // Native decisions bind self through target, so an independent scope answer cannot replace another target with self.
  const observationScope = (!external && view.entities[targetKey] === agent.entityId ? "inventory"
    : selected(answers, "observation_scope")) as ActionFrame["observationScope"];
  let target = operation === "observe" && observationScope === "inventory" ? agent.entityId
    : operation === "observe" && observationScope === "surroundings" ? null : view.entities[targetKey] ?? null;
  // Discovery is an explicitly selected prerequisite, never a substitute for a
  // missing move/transfer parameter. The world can resolve an unbound attempt.
  const preparatoryFor: ActionKind | null = ["speak", "transfer"].includes(operation) && targetKey === "discover" ? operation as ActionKind : null;
  if (preparatoryFor && ["speak", "transfer"].includes(preparatoryFor) && questions.search_location) target = view.entities[selected(answers, "search_location")] ?? null;
  if (!external && ["wait", "unknown"].includes(operation)) {
    intent.status = "waiting"; intent.wait = { entityIds: target ? [target] : [], untilSeconds: null, reason: operation };
    return { frame: null, audits, reads: view.reads, cognition };
  }
  let utterance: string | null = !preparatoryFor ? reading?.expression.utterance ?? null : null;
  const expression: ActionExpression | undefined = !preparatoryFor ? reading?.expression : undefined;
  const speech = selected(answers, operation === "reflect" ? "reflection" : "speech");
  const literal = /^q\d+$/u.test(speech) ? quotes[Number(speech.slice(1))] : undefined;
  if (!reading && literal && external && operation === "speak" && !preparatoryFor) utterance = literal;
  else if (!reading && ["speak", "reflect"].includes(operation) && !preparatoryFor) {
    if (/^span\d+$/u.test(speech)) utterance = spans[Number(speech.slice(4))] ?? null;
    else if (speech === "input" && external) utterance = text;
    else if (operation === "speak") throw new Error("This utterance needs creation or exact player words");
  }
  if (!external && operation === "speak" && utterance) {
    const thread = view.state as unknown as { awaitingReplyTo: string[]; respondingTo: string | null; interactions: PrivateInteraction[] };
    const stimulus = thread.interactions.find(item => item.id === thread.respondingTo);
    if (stimulus?.relation === "observed_other_interaction" && stimulus.operation === "speak" &&
      thread.interactions.some(item => thread.awaitingReplyTo.includes(item.id) &&
        item.action?.target?.localEntityId === targetKey && item.utterance?.trim() === utterance!.trim())) {
      intent.status = "waiting"; intent.activityId = null;
      intent.wait = { entityIds: target ? [target] : [], untilSeconds: null, reason: "awaiting-conversation" };
      return { frame: null, audits, reads: view.reads, cognition };
    }
  }
  const kind: ActionKind = preparatoryFor ? "observe" : ["expand", "unknown"].includes(operation) ? "use" : operation as ActionKind;
  const proposedProfile = selected(answers, "timing") === "default" ? null : selected(answers, "timing");
  const profile = proposedProfile ? state.truth.mechanics.temporalProfiles[proposedProfile] : null;
  // Conditional checkpoints are wake subscriptions, not the duration of a spoken sentence or a look.
  const profileId = preparatoryFor || ["conditional", "goal"].includes(profile?.kind ?? "") ? null : proposedProfile;
  const selectedGoal = goals.find(goal => goal.id === intent.goalId)?.description;
  const rawText = expression?.attempt || text || `${actionLabels[kind]}${target ? `：${agent.belief.localEntities[targetKey]?.name ?? ""}` : ""}${utterance ? `；${utterance}` : ""}`;
  const id = runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "action", stage: "direct-action", owner: agentId, round: 0, ordinal: 0 });
  const durationChoice = questions.duration ? selected(answers, "duration") : "default";
  const selectedDuration = /^d\d+$/u.test(durationChoice) ? durations[Number(durationChoice.slice(1))]?.seconds
    : /^phase\d+$/u.test(durationChoice) ? periodicDeadlineSeconds(phaseDeadlines[Number(durationChoice.slice(5))], reading?.durationReference ?? null, requestAnchor, state.truth.elapsedSeconds)
      : durationChoice === "unresolved" ? null : undefined;
  const unsupportedDuration = selectedDuration === null || typeof selectedDuration === "number" && !Number.isSafeInteger(state.truth.elapsedSeconds + selectedDuration);
  const interruptCondition = external && !preparatoryFor && selected(answers, "interruption") === "request" ? external.rawText : null;
  const cannotInterrupt = interruptCondition !== null && profileId !== null && profile?.interruptible === false;
  if (external && !preparatoryFor && (unsupportedDuration || cannotInterrupt)) {
    intent.status = "waiting"; intent.activityId = null; intent.activeSubmission = null; intent.causeActionId = null;
    intent.wait = { entityIds: [], untilSeconds: null, reason: cannotInterrupt ? "noninterruptible-activity" : "undefined-duration-unit" };
    control.completedSubmissionIds.push(external.submissionId);
    const presentation: PresentationReply = { agentId, submissionId: external.submissionId, kind: "clarification", requested: text,
      focusLocalEntityId: null, reason: cannotInterrupt
        ? "The selected activity cannot be interrupted under its established temporal rules, but the request requires an early stopping condition. Clarify an alternative activity or whether to proceed without that condition. No physical activity or elapsed time has occurred. Do not silently remove the condition."
        : "The requested elapsed interval or phase endpoint is undefined, ambiguous, already reached during this request, or outside the exact clock range. The current observation of a restricted property does not reveal its future schedule. Ask for a resolvable endpoint or an explicit representable duration in hours or another defined unit. No physical activity or elapsed time has occurred; do not substitute a short checkpoint." };
    return { frame: null, audits, reads: view.reads, cognition, presentation };
  }
  const explicitSeconds = !preparatoryFor ? selectedDuration ?? undefined : undefined;
  const profileSeconds = actionSeconds(state, profileId, preparatoryFor ? "" : rawText, false);
  const durationSource = explicitSeconds !== undefined ? "explicit" : profileSeconds !== null ? "profile" : "judgment";
  const durationSeconds = explicitSeconds ?? profileSeconds ?? (kind === "reflect" ? Number(selected(answers, "reflection_duration").slice(1)) : 0);
  const quantityDefinitionId = questions.resource && selected(answers, "resource") !== "none" ? selected(answers, "resource") : null;
  const amountField = !jointInterpretation && quantityDefinitionId ? `resource_amount_${resources.indexOf(quantityDefinitionId)}` : "amount";
  const amountChoice = selected(answers, amountField);
  const frame: ActionFrame = { version: 1, id, actorId: agentId, actorEntityId: agent.entityId, submissionId: external?.submissionId ?? null,
    ...(expression ? { expression } : {}),
    ...(external && questions.progress_next ? { requestContinuation: selected(answers, "progress_next") as NonNullable<ActionFrame["requestContinuation"]> } : {}),
    proposal: { id, actorId: agentId, baseRevision: state.revision, rawText, goal: external?.goal ?? selectedGoal ?? rawText,
      means: external?.means ?? null, targetIds: target ? [targetKey] : [] }, kind, goalId: intent.goalId,
    targetEntityId: target, toolEntityId: ["use", "change", "speak", "transfer"].includes(kind) && view.entities[selected(answers, "tool")] !== agent.entityId
      ? view.entities[selected(answers, "tool")] ?? null : null,
    quantityDefinitionId,
    amount: amountChoice === "unknown" ? null : Number(amountChoice.slice(1)), utterance,
    capabilityId: ["use", "change"].includes(kind) && questions.capability && selected(answers, "capability") !== "none" ? selected(answers, "capability") : null,
    startedAtSeconds: state.truth.elapsedSeconds, dueAtSeconds: durationSeconds ? state.truth.elapsedSeconds + durationSeconds : null,
    durationSeconds, durationSource, progressSeconds: 0, activityStatus: "active",
    temporalProfileId: profileId, interruptCondition, inputHash, causeActionId: intent.causeActionId, preparatoryFor,
    observationScope: preparatoryFor ? target ? "target" : "surroundings" : observationScope };
  if (operation === "expand") {
    if (!input.creationEnabled) throw new Error("This new capability needs creation; ordinary actions remain available");
    const created = await extendCapability({ state, control, frame, decisions, profileId: profiles.creation,
      context: { action: rawText, target: target ? agent.belief.localEntities[selected(answers, "target")]?.description ?? "" : null,
        tool: frame.toolEntityId ? agent.belief.localEntities[selected(answers, "tool")]?.description ?? "" : null } });
    audits.push(...created.audits);
  }
  intent.status = "active"; intent.activityId = id; intent.wait = null;
  intent.lastActionHash = contentHash({ kind, target, tool: frame.toolEntityId, utterance, quantity: frame.quantityDefinitionId, amount: frame.amount });
  return { frame, audits, reads: view.reads, cognition };
}
