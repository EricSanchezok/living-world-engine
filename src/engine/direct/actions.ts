import { z } from "zod";
import type { SimulationState, ModelExecutionAudit } from "../contracts/model";
import type { ExternalActionInput } from "../runtime/execution";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import type { JsonValue } from "../runtime/json";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import type { DecisionQuestionV2 } from "../models/decision-v2";
import { runtimeId } from "../runtime/runtime-id";
import { agentEventModels } from "../events/model-bindings";
import { privateActionView } from "./views";
import { DirectDecisions, selected } from "./decisions";
import type { ActionFrame, ActionKind, DirectRuntimeState } from "./contracts";
import { cognitiveQuestions, cognitiveUpdate } from "./cognition";
import { orderedValues } from "./state";

const kinds: Record<ActionKind | "unknown" | "expand", string> = { move: "Travel to a place", observe: "Inspect, notice or investigate",
  speak: "Communicate actual words", transfer: "Give or pay an owned resource or object", use: "Use a tool, ability or object",
  change: "Change an existing object's state", wait: "Wait for an event or continue a long activity", unknown: "Need information to choose",
  expand: "A missing concept or capability is required" };
function choice(field: string, criteria: Record<string, string | Record<string, JsonValue> | JsonValue[] | null>): DecisionQuestionV2 {
  return { type: "choice", version: "direct-action-1", instructions: { task: loadPromptAsset("user/direct-action.md"), field }, criteria };
}
export function literalNumbers(text: string): number[] {
  const values = [...text.matchAll(/(?:^|[^\d.])(\d+(?:\.\d+)?)(?![\d.])/gu)].map(match => Number(match[1]));
  const small: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  for (const match of text.matchAll(/[一二两三四五六七八九十](?=[个枚块份单位秒分钟小时])/gu)) values.push(small[match[0]]!);
  return [...new Set(values.filter(value => Number.isFinite(value) && value > 0))];
}
export function literalUtterances(text: string): string[] {
  return [...text.matchAll(/[“"「『]([^”"」』]+)[”"」』]/gu)].map(match => match[1]!);
}
function actionSeconds(state: Readonly<SimulationState>, profileId: string | null, raw: string): number {
  const duration = raw.match(/(\d+(?:\.\d+)?)\s*(seconds?|minutes?|hours?|秒|分钟|小时)/iu);
  if (duration) return Math.max(1, Math.ceil(Number(duration[1]) * (/hours?|小时/iu.test(duration[2]!) ? 3600 : /minutes?|分钟/iu.test(duration[2]!) ? 60 : 1)));
  const profile = profileId ? state.truth.mechanics.temporalProfiles[profileId] : null;
  if (profile?.kind === "fixed") return profile.durationSeconds;
  if (profile?.kind === "staged") return profile.stages.reduce((sum, stage) => sum + stage.durationSeconds, 0);
  if (profile?.kind === "ongoing") return profile.checkpointSeconds;
  if (profile?.kind === "conditional" || profile?.kind === "goal") return profile.checkEverySeconds;
  const ordinary = Object.values(state.truth.mechanics.temporalProfiles).filter(profile => profile.kind === "fixed" && profile.selection.evidenceRequirement === "none");
  return ordinary.length ? Math.min(...ordinary.map(profile => profile.kind === "fixed" ? profile.durationSeconds : 30)) : 30;
}

export async function chooseAction(input: { state: Readonly<SimulationState>; definition: WorldRuntimeContract; control: DirectRuntimeState;
  decisions: DirectDecisions; agentId: string; external?: ExternalActionInput; creationEnabled: boolean }) {
  const { state, control, decisions, agentId, external } = input;
  const agent = state.agents[agentId]!, intent = control.intents[agentId]!, view = privateActionView(state, agentId);
  const profiles = agentEventModels(state, control, agentId);
  const goals = orderedValues(agent.character.goals).filter(goal => goal.status === "active");
  const text = external?.rawText ?? "";
  const quotes = literalUtterances(text);
  const observedNumbers = orderedValues(agent.belief.evidence).filter(evidence => evidence.step >= agent.observationCursorStep).flatMap(evidence => literalNumbers(evidence.description));
  const amounts = [...new Set([1, ...literalNumbers(text), ...observedNumbers])];
  const known = Object.entries(view.entities).map(([localId]) => [localId, agent.belief.localEntities[localId]!] as const);
  const targetCriteria = { none: "No target or insufficient identity evidence", ...Object.fromEntries(known.map(([id, entity]) => [id, { name: entity.name, description: entity.description }])) };
  const ownedQuantities = orderedValues(state.truth.quantities).filter(quantity => quantity.holderId === agent.entityId);
  const resources = [...new Set(ownedQuantities.map(quantity => quantity.definitionId))];
  const timing = orderedValues(state.truth.mechanics.temporalProfiles);
  const questions: Record<string, DecisionQuestionV2> = {
    ...cognitiveQuestions(state, agentId),
    operation: choice("operation", kinds), target: choice("target", targetCriteria), tool: choice("tool", targetCriteria),
    amount: choice("amount", { unknown: "No established amount", ...Object.fromEntries(amounts.map((amount, index) => [`n${index}`, String(amount)])) }),
    speech: choice("speech", { none: "No speech", input: "The entire player input is already the literal utterance", create: "Need new literal dialogue",
      ...Object.fromEntries(quotes.map((quote, index) => [`q${index}`, quote])) }),
    timing: choice("timing", { default: "Ordinary action duration from the world", ...Object.fromEntries(timing.map(profile => [profile.id, profile.name])) }),
  };
  if (!external) questions.urgency = { type: "score", version: "urgency-1", instructions: { task: loadPromptAsset("user/direct-action.md"), field: "urgency of the next action" },
    criteria: ["May reasonably wait", "Should act when available", "Immediate deadline or danger"] };
  if (!external && intent.lastActionHash && intent.wakeReasons.includes("observation")) questions.relevant = { type: "noul", version: "wake-relevance-1",
    instructions: { task: loadPromptAsset("user/direct-action.md"), field: "Does the new observation require changing the prior wait or responding now?" } };
  if (resources.length) questions.resource = choice("resource", { none: "No quantified resource", ...Object.fromEntries(resources.map(id => [id, state.truth.mechanics.quantities[id]!.name])) });
  if (goals.length) questions.goal = choice("goal", { none: "Respond to the situation without selecting a goal", ...Object.fromEntries(goals.map(goal => [goal.id, goal.description])) });
  const context = { perspective: view.state, submittedAction: external ?? null, intent: { goalId: intent.goalId, wakeReasons: intent.wakeReasons,
    recentOutcomeIds: intent.recentOutcomeIds }, actionKinds: kinds } as unknown as JsonValue;
  const inputHash = contentHash(context);
  if (!external && inputHash === intent.lastInputHash) {
    intent.status = "waiting"; intent.wakeReasons = []; return { frame: null, audits: [] as ModelExecutionAudit[], reads: view.reads, cognition: null };
  }
  const answers = await decisions.ask(agentId, context, view.reads, questions, profiles);
  const cognition = cognitiveUpdate(state, agentId, answers);
  intent.goalProgress = { ...intent.goalProgress, ...cognition.goals };
  if (answers.urgency?.type === "score") intent.urgency = answers.urgency.score;
  intent.lastInputHash = inputHash; intent.wakeReasons = []; intent.failure = null;
  const operation = selected(answers, "operation");
  intent.goalId = questions.goal && selected(answers, "goal") !== "none" ? selected(answers, "goal") : null;
  const target = view.entities[selected(answers, "target")] ?? null;
  if (!external && (["wait", "unknown"].includes(operation) || answers.relevant?.type === "noul" && answers.relevant.noul < 0.5)) {
    intent.status = "waiting"; intent.wait = { entityIds: target ? [target] : [], untilSeconds: null, reason: operation };
    return { frame: null, audits: [] as ModelExecutionAudit[], reads: view.reads, cognition };
  }
  const audits: ModelExecutionAudit[] = [];
  let utterance: string | null = null;
  const speech = selected(answers, "speech");
  if (operation === "speak") {
    if (/^q\d+$/u.test(speech)) utterance = quotes[Number(speech.slice(1))] ?? null;
    else if (speech === "input" && external) utterance = text;
    else if (speech === "create") {
      if (!input.creationEnabled) throw new Error("new dialogue requires the configured creation capability");
      const system = loadPromptAsset("system/direct-utterance.md"), userPrompt = loadPromptAsset("user/direct-utterance.md");
      const generated = await decisions.provider.generateStructured({ ...decisions.scope, modelRegistrySnapshotHash: control.registryHash,
        profileId: profiles.creation, subjectId: agentId, role: "creation", modelInvocation: decisions.next(agentId),
        system, userPrompt, promptVersion: `direct-utterance-${contentHash({ system, userPrompt })}`, schemaName: "DirectUtteranceV1",
        context: { ...context as Record<string, JsonValue>, recipient: selected(answers, "target") }, schema: z.object({ utterance: z.string().min(1) }).strict(), jsonExamplePolicy: "omit" });
      utterance = generated.value.utterance; audits.push(generated.audit);
    }
  }
  const kind: ActionKind = operation === "expand" ? "use" : operation === "unknown" ? "observe" : operation as ActionKind;
  const profileId = selected(answers, "timing") === "default" ? null : selected(answers, "timing");
  const rawText = text || `${kinds[kind]}${target ? `: ${agent.belief.localEntities[selected(answers, "target")]?.name ?? ""}` : ""}${utterance ? `: ${utterance}` : ""}`;
  const id = runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "action", stage: "direct-action", owner: agentId, round: 0, ordinal: 0 });
  const frame: ActionFrame = { version: 1, id, actorId: agentId, actorEntityId: agent.entityId, submissionId: external?.submissionId ?? null,
    proposal: { id, actorId: agentId, baseRevision: state.revision, rawText, goal: external?.goal ?? goals.find(goal => goal.id === intent.goalId)?.description ?? rawText,
      means: external?.means ?? null, targetIds: target ? [selected(answers, "target")] : [] }, kind, goalId: intent.goalId,
    targetEntityId: target, toolEntityId: view.entities[selected(answers, "tool")] ?? null,
    quantityDefinitionId: questions.resource && selected(answers, "resource") !== "none" ? selected(answers, "resource") : null,
    amount: selected(answers, "amount") === "unknown" ? null : amounts[Number(selected(answers, "amount").slice(1))]!, utterance, capabilityId: null,
    startedAtSeconds: state.truth.elapsedSeconds, dueAtSeconds: state.truth.elapsedSeconds + actionSeconds(state, profileId, text),
    temporalProfileId: profileId, inputHash, causeActionId: intent.causeActionId };
  intent.status = "active"; intent.activityId = id; intent.wait = null;
  intent.lastActionHash = contentHash({ kind, target, tool: frame.toolEntityId, utterance, quantity: frame.quantityDefinitionId, amount: frame.amount });
  return { frame, audits, reads: view.reads, cognition };
}
