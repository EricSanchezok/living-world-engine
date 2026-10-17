import { z } from "zod";
import type { SimulationState, ModelExecutionAudit } from "../contracts/model";
import type { ExternalActionInput } from "../runtime/execution";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { JsonValue } from "../runtime/json";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import { ModelOutputError, type StructuredModelResult } from "../models/model-provider";
import type { DecisionQuestionV2 } from "../models/decision-v2";
import { runtimeId } from "../runtime/runtime-id";
import { agentCapabilityModels } from "../models/capability-bindings";
import { privateActionView } from "./views";
import { DirectDecisions, selected } from "./decisions";
import type { ActionExpression, ActionFrame, ActionKind, DirectRuntimeState } from "./contracts";
import { readPlayerAction } from "./player-reading";
import { cognitiveQuestions, cognitiveUpdate } from "./cognition";
import { orderedValues } from "./state";
import { extendCapability } from "./capabilities";
import type { PresentationReply } from "../contracts/discourse";

const kinds: Record<ActionKind | "unknown" | "expand", string> = { move: "Travel to a place", observe: "Inspect, notice or investigate",
  reflect: "Explicitly review records or formulate private thoughts when that is the requested activity; checking a condition before a requested physical action is part of choosing that action, not a separate reflection",
  speak: "Communicate actual words: ask, offer, reply or request someone else's action", transfer: "Personally give or pay an owned resource or object", use: "Use one's body, a tool, ability or object to attempt a concrete physical effect",
  change: "Change a state or access condition, including physically blocking or clearing a route", wait: "Listen without speaking, await an event or continue a long activity", unknown: "Cannot identify any next attempt, even a question or observation",
  expand: "A missing concept or capability is required" };
const actionLabels: Record<ActionKind, string> = { move: "前往", observe: "观察", reflect: "思考", speak: "交谈", transfer: "交付", use: "使用", change: "调整", wait: "等待" };
const sharedActionPolicy = "Apply state.actionPolicy and the current request/settled receipts in state. Answer this field independently; only the selected operation's parameters execute.";
function choice(field: string, criteria: Record<string, string | Record<string, JsonValue> | JsonValue[] | null>): DecisionQuestionV2 {
  return { type: "choice", version: "direct-action-2", instructions: { task: sharedActionPolicy, field }, criteria };
}
export function literalNumbers(text: string): number[] {
  const values = [...text.matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?![\d.])/gu)].map(match => Number(match[1]));
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
/** Exact duration spans are candidates; the language decision binds one to the selected step. */
export function literalDurations(text: string): Array<{ text: string; seconds: number }> {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二两三四五六七八九]+)?|半)\s*(seconds?|minutes?|hours?|秒钟?|分钟?|小时)(半)?/giu)];
  const spans: Array<{ text: string; seconds: number; end: number }> = [];
  for (const match of matches) {
    const value = match[1] === "半" ? 0.5 : literalNumbers(match[1]!)[0];
    if (value === undefined) continue;
    const seconds = Math.ceil((value + (match[3] ? 0.5 : 0)) * (/hours?|小时/iu.test(match[2]!) ? 3600 : /minutes?|分/iu.test(match[2]!) ? 60 : 1));
    if (!Number.isSafeInteger(seconds) || seconds < 1) continue;
    const prior = spans.at(-1), separator = prior ? text.slice(prior.end, match.index) : null;
    if (prior && separator !== null && /^(?:\s|零|又|and)*$/iu.test(separator)) {
      prior.text += separator + match[0]; prior.seconds += seconds; prior.end = match.index + match[0].length;
    } else spans.push({ text: match[0], seconds, end: match.index + match[0].length });
  }
  return spans.map(({ text, seconds }) => ({ text, seconds }));
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
  const agent = state.agents[agentId]!, intent = control.intents[agentId]!, view = privateActionView(state, agentId, intent.causeActionId);
  if (external) intent.activeSubmission = structuredClone(external);
  const configuredProfiles = agentCapabilityModels(state, control, agentId);
  // Open player language needs interpretation before the world judges its effects.
  const jointInterpretation = Boolean(external && input.creationEnabled);
  const profiles = configuredProfiles;
  const goals = orderedValues(agent.character.goals).filter(goal => goal.status === "active");
  const text = external?.rawText ?? "";
  if (external?.discourse && (external.discourse.agentId !== agentId ||
    external.discourse.hash !== contentHash({ ...external.discourse, hash: "" }))) throw new Error("Player discourse does not belong to this perspective");
  const quotes = literalUtterances(text);
  const observedNumbers = orderedValues(agent.belief.evidence).filter(evidence => evidence.step >= agent.observationCursorStep).flatMap(evidence => literalNumbers(evidence.description));
  const amounts = [...new Set([1, ...literalNumbers(text), ...observedNumbers, ...goals.flatMap(goal => literalNumbers(goal.description))])];
  const known = Object.entries(view.entities).map(([localId]) => [localId, agent.belief.localEntities[localId]!] as const);
  const perspective = view.state as { self: { location: unknown } };
  const targetCriteria = { none: "No separate target is needed. For move, bind the current place or an actual destination; do not leave an intended destination unspecified.", ...Object.fromEntries(known.map(([id, entity]) => [id, {
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
  const durations = literalDurations(text);
  const capabilities = control.capabilities.filter(capability => capability.knownToAgentIds.includes(agentId)).sort((a, b) => a.id.localeCompare(b.id));
  const questions: Record<string, DecisionQuestionV2> = {
    ...cognitiveQuestions(state, agentId),
    operation: choice(external ? "The next executable action actually requested. Resolve if/only-if conditions using the latest known properties, then select the authorized branch. A conditional request to operate is use/change when its stated conditions are established; do not substitute private reflection for doing it. Unknown conditions permit concrete observation or asking. Do not invent additional prerequisites." : "Choose this NPC's response to the latest privately delivered interaction. Use perspective.interactions to identify its speaker, addressee and actual result. An information question permits an answer, uncertainty or motivated refusal; a request to inspect or act permits actually doing that work. Saying you will check is not checking. A question to somebody else does not require your answer. Received materials do not establish their use. Choose an inspection when you intend to establish an unknown condition before reporting it.", kinds),
    target: choice("Target of the selected NEXT operation: observe inspects this object, use/change affects this object's properties, move approaches this destination. A machine operated through a control panel is the target; the panel is the tool. In 'inspect an object then report to a person', inspect the object first, not the later listener. Do not select a prerequisite object when the requested effect belongs to another known object.", targetCriteria),
    tool: choice("Separate instrument used on the target, or the item discussed in speech. A control panel used to test a machine is a tool. Select none when no separate instrument is involved.", targetCriteria),
    observation_scope: choice("If observing, what is actually being inspected? Inspecting one's money, food or possessions selects inventory; reviewing memories selects the reflect operation.", {
      target: "The selected external object", surroundings: "The immediate surroundings", inventory: "The actor's own actual inventory and resources",
    }),
    recipient: choice("If the next action communicates words or transfers goods, select its actual recipient. For an NPC reply, use the speaker of the latest interaction addressed to this NPC, not another person mentioned in that question or the listener in an old exchange. Discover a recipient before addressing an unknown person. Ignore for other operations.", recipientCriteria),
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
  if (external) questions.interaction = choice("What kind of response does this input seek in the actual shared conversation? Choose clarification for a reader asking which previously presented person/thing was meant, a recap, their already known location, or the meaning/status of earlier feedback without requesting a new action. Choose world_action for words directed at a character (including elliptical follow-ups), observation of NEW evidence or any actual attempt. A question is not automatically clarification: asking the recent speaker for their name is in-world speech. Use the published exchanges, addressee and current focus; no special command syntax is needed.", {
    world_action: "Act or speak in the world",
    clarification: "Explain already available information without new speech, observation or elapsed world time",
  });
  if (durations.length) questions.duration = choice("Which explicit duration belongs to THIS next concrete step? Distinguish an instructed wait or activity duration from a quoted deadline, remaining time, another person's commitment or a future clause. After a completed wait, later observation does not repeat that duration. Questions about how long something takes do not authorize waiting that long.", {
    default: "No explicit duration belongs to this next step; use its ordinary world timing",
    ...Object.fromEntries(durations.map((duration, index) => [`d${index}`, duration])),
  });
  questions.expression = { type: "noul", version: "action-expression-1",
    instructions: { task: sharedActionPolicy, field: "Does THIS selected next action need a meaningful physical delivery, gesture, tactic or separation from a compound request beyond choosing new words? Ordinary conversation and new wording alone need none. Select true for an intentional physical manner that changes this interaction, or an explicitly requested gesture. Routine glances, nods and clothing adjustments are not required by speech." } };
  if (!external) questions.urgency = { type: "score", version: "urgency-1", instructions: { task: sharedActionPolicy, field: "urgency of the next action" },
    criteria: ["May reasonably wait", "Should act when available", "Immediate deadline or danger"] };
  if (!external && intent.lastActionHash && intent.wakeReasons.includes("observation")) questions.relevant = { type: "noul", version: "wake-relevance-1",
    instructions: { task: sharedActionPolicy, field: "Is there a new conversational move addressed to this NPC, or other observation requiring a response or change? A direct question, correction or received payment is relevant even if the answer is unknown. Irrelevant background observations alone need not wake the Agent." } };
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
  const claims = orderedValues(agent.belief.claims);
  if (jointInterpretation) {
    questions.progress_next = choice("After the selected next operation, what remains of THIS submission's actual intent? Necessary low-risk continuity is authorized by that intent; reaching a waypoint or discovering the route need not end the request. Use currentRequestReceipts and continue feasible remaining work without repeating completed acts. New spending, commitments, voluntary speech or risk choices need authorization. Only the applicable conditional branch runs. Missing evidence that this very step can supply permits continuation; a genuinely unavailable reply or new choice requires wait.", {
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
  const currentObservedFacts = claims.map(claim => ({ subject: agent.belief.localEntities[claim.subjectId]?.name,
    localEntityId: claim.subjectId, predicate: claim.predicate, value: claim.value, description: claim.description, stance: claim.stance,
    evidence: claim.evidenceIds.map(id => agent.belief.evidence[id]).filter(Boolean).map(item => ({ kind: item!.kind, step: item!.step })) }));
  const actionPolicy = jointInterpretation ? "Interpret all fields jointly as one next interaction. Current receipts distinguish requested steps from executed work."
    : loadPromptAsset("user/direct-action.md");
  const context = { actionPolicy, temporalCalibrations: state.truth.mechanics.temporalCalibrations, perspective: view.state, submittedAction: external ? { ...external, discourse: undefined } : null, discourse: external?.discourse ?? null, currentRequestReceipts,
    requestPhase: currentRequestReceipts.length ? "Continue this same submission after its listed receipts" : "New submission: none of this input has executed. Earlier similar actions belong to other requests.",
    recentActions: recentActions.slice(-6).map(({ requested, target, actionKind, attempted, outcome, preparatoryFor }) => ({ requested, target, actionKind, attempted, outcome, preparatoryFor })),
    currentObservedFacts, intent: { goalId: intent.goalId, wakeReasons: intent.wakeReasons,
    recentOutcomeIds: intent.recentOutcomeIds }, latestObservedEvidence: orderedValues(agent.belief.evidence).filter(evidence => evidence.step === agent.observationCursorStep),
    actionKinds: kinds } as unknown as JsonValue;
  if (external) for (const id of ["operation", "target", "recipient", "amount", "resource", "transfer_authority", "capability", "search_location", "observation_scope", ...Object.keys(questions).filter(id => id.startsWith("progress_"))]) {
    const item = questions[id]; if (!item) continue;
    item.instructions = { ...item.instructions as Record<string, JsonValue>, currentPlayerRequest: external.rawText,
      actualHoldings: (view.state as { mechanics: { quantities: JsonValue } }).mechanics.quantities,
      settledSteps: currentRequestReceipts.map(receipt => ({ kind: receipt.actionKind, target: receipt.target,
        outcome: receipt.outcome, actualObservations: receipt.observed })) };
    if (["recipient", "target", "search_location"].includes(id)) item.instructions = { ...item.instructions as Record<string, JsonValue>,
      recentRequests: recentActions.filter(action => action.submissionId !== external.submissionId).slice(-3)
        .map(({ requested, target, outcome }) => ({ requested, target, outcome })),
      referenceRule: "Resolve the intended local identity against the actual published exchanges, their stable mentions and delivered speakers. Corrections may replace a preceding focus. A prior unsuccessful search does not automatically override the current conversational addressee. If more than one interpretation genuinely remains, preserve uncertainty instead of substituting another person." };
  }
  const inputHash = contentHash({ perspective: view.state, submittedAction: external ?? null, goal: intent.goalId });
  if (!external && inputHash === intent.lastInputHash) {
    intent.status = "waiting"; intent.wakeReasons = []; intent.wait = { entityIds: [], untilSeconds: null, reason: "same-input" };
    return { frame: null, audits: [] as ModelExecutionAudit[], reads: view.reads, cognition: null };
  }
  const reading = jointInterpretation ? await readPlayerAction({ decisions, agentId, context, questions,
    profileId: configuredProfiles.fallback, language: input.definition.narrative.language, quotes }) : null;
  const answers = reading?.answers ?? await decisions.ask(agentId, context, view.reads, questions, profiles);
  const audits: ModelExecutionAudit[] = reading ? reading.audits : [];
  const cognition = cognitiveUpdate(state, agentId, answers);
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
  if (operation === "speak" && targetKey === "none") {
    const resolved = await decisions.ask(agentId, { ...context as Record<string, JsonValue>, concreteOperation: "speak",
      selectedSpeech: selected(answers, "speech") }, view.reads, {
      recipient: choice("Speech has actually been selected. Resolve where THESE words are addressed. An open reminder to everyone uses broadcast. A specific unseen person uses discover. A silent listening action uses none. Do not require a known name for an open call.", recipientCriteria),
    }, profiles);
    targetKey = selected(resolved, "recipient");
    if (targetKey === "none") operation = "wait";
  }
  const observationScope = selected(answers, "observation_scope") as ActionFrame["observationScope"];
  let target = operation === "observe" && observationScope === "inventory" ? agent.entityId
    : operation === "observe" && observationScope === "surroundings" ? null : view.entities[targetKey] ?? null;
  // Discovery is an explicitly selected prerequisite, never a substitute for a
  // missing move/transfer parameter. The world can resolve an unbound attempt.
  const preparatoryFor: ActionKind | null = ["speak", "transfer"].includes(operation) && targetKey === "discover" ? operation as ActionKind : null;
  if (preparatoryFor && ["speak", "transfer"].includes(preparatoryFor) && questions.search_location) target = view.entities[selected(answers, "search_location")] ?? null;
  if (!external && (["wait", "unknown"].includes(operation) || answers.relevant?.type === "noul" && answers.relevant.noul < 0.5)) {
    intent.status = "waiting"; intent.wait = { entityIds: target ? [target] : [], untilSeconds: null, reason: operation };
    return { frame: null, audits: [] as ModelExecutionAudit[], reads: view.reads, cognition };
  }
  let utterance: string | null = !preparatoryFor ? reading?.expression.utterance ?? null : null;
  let expression: ActionExpression | undefined = !preparatoryFor ? reading?.expression : undefined;
  const speech = selected(answers, operation === "reflect" ? "reflection" : "speech");
  const literal = /^q\d+$/u.test(speech) ? quotes[Number(speech.slice(1))] : undefined;
  const needsExpression = !preparatoryFor && (
    operation === "speak" && (!external || !literal) ||
    operation === "reflect" && speech === "create" ||
    external && ["use", "change"].includes(operation) && (!questions.capability || selected(answers, "capability") === "none") ||
    answers.expression?.type === "noul" && answers.expression.noul >= 0.5);
  if (!reading && needsExpression && input.creationEnabled) {
    const wordsOnly = !external && operation === "speak" && !(answers.expression?.type === "noul" && answers.expression.noul >= 0.5);
    const system = loadPromptAsset(external ? "system/player-expression.md" : "system/direct-utterance.md"), userPrompt = loadPromptAsset("user/direct-utterance.md");
    const schema = z.object({ conversationReading: z.object({
      currentQuestion: z.string().describe("The full question or conversational move actually addressed to you, resolving an ellipsis from the preceding shared exchange. Preserve what is being asked while replacing only its corrected subject or scope."),
      evidenceForAnswer: z.string().describe("Your actual received evidence and its limits, including who did or said what. Do not manufacture earlier questions, promises or completed work."),
      newContribution: z.string().describe("What this reply adds. If your previous question to this recipient is still unanswered and nothing relevant changed, do not ask it again."),
    }).optional(), attempt: z.string().optional(), utterance: z.string().nullable(), manner: z.string().nullable().optional(),
      recipientLocalId: z.enum(["broadcast", ...recipients.map(([id]) => id)]).optional()
        .describe("For an autonomous spoken reply, bind the actual listener of THESE words from knownRecipients, or broadcast. Match second-person references and names to that listener. Omit for reflection, player-controlled expression and other action kinds."),
    });
    const generate = (repair: { issue: string; previous: unknown } | null) => decisions.provider.generateStructured({ ...decisions.scope, modelRegistrySnapshotHash: control.registryHash,
      profileId: profiles.creation, subjectId: agentId, role: "creation", modelInvocation: decisions.next(agentId),
      system, userPrompt, promptVersion: `action-expression-${contentHash({ system, userPrompt })}`, schemaName: "ActionExpressionV2",
      context: { ...context as Record<string, JsonValue>, language: input.definition.narrative.language, recipient: operation === "reflect" ? null : targetKey,
        addressee: operation === "reflect" ? null : targetKey === "broadcast" ? { audience: "everyone who can hear" }
          : { localEntityId: targetKey, name: agent.belief.localEntities[targetKey]?.name ?? null },
        ...(!external && operation === "speak" ? { knownRecipients: Object.fromEntries(recipients.map(([id, entity]) =>
          [id, { name: entity.name, description: entity.description }])) } : {}),
        chosenDirection: operation, communicativeIntent: external && selected(answers, "transfer_authority") === "request"
          ? "Request the other person's action; do not offer payment or accept any new terms" : selected(answers, "dialogue"), playerControlled: Boolean(external),
        currentPlayerRequest: external?.rawText ?? null,
        currentHoldings: (view.state as { mechanics: { quantities: JsonValue } }).mechanics.quantities,
        exactQuotes: quotes, expression: operation === "reflect" ? "Private reflection; do not deliver to anyone." : wordsOnly
          ? "This action is an ordinary spoken reply. Supply its actual words; attempt and manner can be omitted. No accompanying physical gesture is selected."
          : "Concrete attempted behavior and actual words before execution. Outcomes are not yet decided.",
        ...(repair ? { repair: { ...repair, task: "Correct the response format once, preserving this same received interaction, intended words and actual listener. Explicitly return utterance=null only for intentional silence; an empty object is not a response." } } : {}) },
      schema, jsonExamplePolicy: "omit" });
    let generated: StructuredModelResult<z.infer<typeof schema>>;
    try { generated = await generate(null); }
    catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      if (error.audit) audits.push(error.audit);
      try { generated = await generate({ issue: error.message, previous: error.rawValue ?? null }); }
      catch (failure) {
        const final = failure instanceof Error ? failure : new Error(String(failure));
        throw Object.assign(final, { audits: [...audits, ...((final as { audits?: ModelExecutionAudit[] }).audits ?? [])] });
      }
    }
    if (!external && operation === "speak" && generated.value.recipientLocalId) {
      targetKey = generated.value.recipientLocalId;
      target = view.entities[targetKey] ?? null;
    }
    expression = { attempt: (!wordsOnly ? generated.value.attempt?.trim() : null) || text || actionLabels[operation as ActionKind] || "尝试行动",
      utterance: literal && external && (operation === "speak" || generated.value.utterance?.trim()) ? literal : generated.value.utterance?.trim() || null,
      manner: wordsOnly ? null : generated.value.manner?.trim() || null };
    utterance = expression.utterance; audits.push(generated.audit);
    const awaitingReply = (view.state as { ownSpeechSinceLastRecipientReply: Array<{ recipientLocalId: string; words: string }> }).ownSpeechSinceLastRecipientReply;
    const stimulus = (view.state as { respondingTo: { relation: string; operation: string } | null }).respondingTo;
    const unrelatedSpeech = stimulus?.relation === "observed_other_interaction" && stimulus.operation === "speak";
    if (wordsOnly && (!utterance || unrelatedSpeech && awaitingReply.some(item => item.recipientLocalId === targetKey && item.words.trim() === utterance!.trim()))) {
      intent.status = "waiting"; intent.activityId = null;
      intent.wait = { entityIds: target ? [target] : [], untilSeconds: null, reason: "awaiting-conversation" };
      return { frame: null, audits, reads: view.reads, cognition };
    }
  } else if (!reading && literal && external && operation === "speak" && !preparatoryFor) utterance = literal;
  else if (!reading && ["speak", "reflect"].includes(operation) && !preparatoryFor) {
    if (/^span\d+$/u.test(speech)) utterance = spans[Number(speech.slice(4))] ?? null;
    else if (speech === "input" && external) utterance = text;
    else if (operation === "speak") throw new Error("This utterance needs creation or exact player words");
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
  const selectedDuration = /^d\d+$/u.test(durationChoice) ? durations[Number(durationChoice.slice(1))]?.seconds : undefined;
  const explicitSeconds = !preparatoryFor ? selectedDuration : undefined;
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
    temporalProfileId: profileId, inputHash, causeActionId: intent.causeActionId, preparatoryFor,
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
