import { createWorldExpansion, type WorldExpansion } from "./expansion";
import type { ActionOutcome, CausalSource, FactValue, ModelExecutionAudit, SimulationState, WorldDeltaOperation, WorldFact, WorldEntity } from "../contracts/model";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { loadPromptAsset } from "../prompts";
import { applyWorldDeltaOperation } from "../runtime/transaction";
import { contentHash } from "../models/model-audit";
import type { DecisionQuestionV2 } from "../models/decision-v2";
import type { JsonValue } from "../runtime/json";
import { deriveClampedMeterDelta, magnitudeBands, materializeCondition } from "../mechanics/resolution";
import type { ActionFrame, CapabilityDefinition, CapabilityEffect, PreparedDirectAction } from "./contracts";
import { DirectDecisions, selected } from "./decisions";
import { localWorldView } from "./views";
import { orderedValues, captureDependencies } from "./state";
import { literalNumbers } from "./actions";
import { changedFact } from "./presentation";
import { extendCapability } from "./capabilities";
import { agentCapabilityModels } from "../models/capability-bindings";

export interface ActionSettlement {
  frame: ActionFrame; outcome: ActionOutcome; operations: WorldDeltaOperation[]; visibleFacts: WorldFact[];
  visibleEntities: WorldEntity[];
  namedEntityIds: string[];
  deliveredToEntityIds: string[];
}
const ordinaryStates = ["open", "closed", "working", "stopped", "damaged", "repaired", "leaking", "sealed", "temporarily sealed", "tested", "untested", "available", "unavailable"];
function factOptions(fact: WorldFact, frames: ActionFrame[], state: Readonly<SimulationState>): FactValue[] {
  if (fact.value.kind === "boolean") return [{ kind: "boolean", value: true }, { kind: "boolean", value: false }];
  if (fact.value.kind === "text") {
    const values = orderedValues(state.truth.facts).filter(value => value.predicate === fact.predicate && value.value.kind === "text")
      .map(value => (value.value as { kind: "text"; value: string }).value);
    const quotes = frames.flatMap(frame => [...frame.proposal.rawText.matchAll(/[“"「『]([^”"」』]+)[”"」』]/gu)].map(match => match[1]!));
    const namedValues = frames.flatMap(frame => [...`${frame.proposal.rawText} ${frame.proposal.goal}`.matchAll(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/gu)].map(match => match[0]));
    return [...new Set([...values, ...ordinaryStates, ...quotes, ...namedValues])].map(value => ({ kind: "text", value }));
  }
  // Arbitrary numeric effects require an owned numeric mechanism, not guessed arithmetic.
  return [fact.value];
}
function question(task: string, data: JsonValue, criteria: Record<string, string | Record<string, JsonValue>>): DecisionQuestionV2 {
  return { type: "choice", version: "direct-world-1", instructions: { task: loadPromptAsset("user/direct-world.md"), field: task, data }, criteria };
}
export function sourceFor(frame: ActionFrame): CausalSource {
  return { causes: [{ kind: "action", id: frame.id }], assertions: [{ kind: "entity_lifecycle", entityId: frame.actorEntityId, expected: "active" }] };
}
function capabilityFact(state: Readonly<SimulationState>, frame: ActionFrame, capability: CapabilityDefinition,
  effect: Extract<CapabilityEffect, { kind: "fact" }>, ordinal: number): WorldFact | null {
  const subjectId = effect.subject === "actor" ? frame.actorEntityId : effect.subject === "target" ? frame.targetEntityId : frame.toolEntityId;
  if (!subjectId) return null;
  const existing = orderedValues(state.truth.facts).find(fact => fact.subjectId === subjectId && fact.predicate === effect.predicate);
  return { id: existing?.id ?? directSemanticId("fact", [capability.id, subjectId, String(ordinal)]), subjectId, predicate: effect.predicate,
    value: typeof effect.value === "boolean" ? { kind: "boolean", value: effect.value } : { kind: "text", value: effect.value },
    description: effect.description, access: existing?.access ?? { kind: "public" }, provenance: sourceFor(frame).causes };
}
export function directSemanticId(kind: "fact" | "object" | "condition", owners: string[]): string {
  return `direct-${kind}-${contentHash(owners).slice(0, 40)}`;
}
export async function prepareActions(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frames: ActionFrame[], decisions: DirectDecisions, creationEnabled = true) {
  const audits: ModelExecutionAudit[] = [];
  if (!frames.length) return { prepared: [] as PreparedDirectAction[], reads: {} as Record<string, string>, audits };
  const view = localWorldView(state, definition, frames), questions: Record<string, DecisionQuestionV2> = {};
  const effects = new Map<string, { fact: WorldFact; values: FactValue[] }>();
  const visibility = new Map<string, WorldFact>();
  const entityVisibility = new Map<string, WorldEntity>();
  const entityNames = new Map<string, string>();
  const createdObjectQuestions = (frame: ActionFrame, prefix: string, capability: CapabilityDefinition, sink: Record<string, DecisionQuestionV2>) => {
    for (const [ordinal, effect] of capability.effects.entries()) if (effect.kind === "object") {
      const entity: WorldEntity = { id: directSemanticId("object", [frame.id, String(ordinal)]), kind: "object", name: effect.name,
        description: effect.description, lifecycle: "active", createdAtStep: state.step + 1 };
      const id = `${prefix}_created${ordinal}`; entityVisibility.set(id, entity); entityNames.set(`${id}_name`, entity.id);
      sink[id] = question("If this declared construction occurs, is the created object perceptible through the resulting action?", {
        actionId: frame.id, entity: entity as unknown as JsonValue }, { visible: "The constructed object is perceptible", hidden: "It is concealed", unknown: "No perceptual evidence" });
      sink[`${id}_name`] = question("Is this constructed object's descriptive name recognizable from its appearance or the witnessed construction?", {
        actionId: frame.id, entity: entity as unknown as JsonValue }, { named: "Its descriptive name is recognizable", unnamed: "Only its presence is perceptible" });
    }
  };
  const candidates = new Map<string, string[]>();
  const randomOptions = new Map<string, { distributionId: string; stepId: string; applies: string; facts: WorldFact[] }>();
  const durations = [...new Set([ ...frames.map(frame => frame.durationSeconds),
    ...orderedValues(state.truth.mechanics.temporalProfiles).flatMap(profile => profile.kind === "fixed" ? [profile.durationSeconds] : []),
    ...definition.laws.flatMap(law => [...law.text.matchAll(/(\d+)\s*(秒|分钟|小时|seconds?|minutes?|hours?)/giu)].map(match => Number(match[1]) *
      (/小时|hours?/iu.test(match[2]!) ? 3600 : /分钟|minutes?/iu.test(match[2]!) ? 60 : 1))),
  ])].filter(value => Number.isSafeInteger(value) && value > 0).sort((a, b) => a - b);
  const amounts = [...new Set([1, ...frames.flatMap(frame => literalNumbers(frame.proposal.rawText)), ...definition.laws.flatMap(law => literalNumbers(law.text))])].sort((a, b) => a - b);
  const resources = new Map<string, { definitionId: string; lawId: string; kind: "consume_quantity" | "produce_quantity" }>();
  const claims = new Map<string, { poolId: string; amount: number }>();
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`;
    if (creationEnabled && definition.narrative.expansion) questions[`${prefix}_world_expansion`] = question(
      "This is an OPEN world with a partial initial catalog. When the actor explores an unestablished area or seeks an ordinary person/material absent from that catalog, should local creation propose a plausible discovery or arrival? Mere absence from the catalog does not mean absence from the world. Choose introduce for such a genuine opening, including meeting a local worker or finding ordinary scrap in a suitable workplace. Choose none for familiar complete scenes, implausible requests, conserved resources or established absence. This authorizes a draft for later judgment, not instant success.",
      frame as unknown as JsonValue, { none: "Existing world content suffices", introduce: "Introduce a reasonable persistent addition to the world" });
    const capability = decisions.control.capabilities.find(capability => capability.id === frame.capabilityId && capability.knownToAgentIds.includes(frame.actorId));
    const transfer = frame.kind === "transfer" ? { actionId: frame.id, sender: frame.actorEntityId, recipient: frame.targetEntityId,
      resource: frame.quantityDefinitionId, amount: frame.amount,
      currentlyOwnedBySender: orderedValues(state.truth.quantities).filter(quantity => quantity.holderId === frame.actorEntityId && quantity.definitionId === frame.quantityDefinitionId).reduce((sum, quantity) => sum + quantity.amount, 0),
      senderPlace: state.truth.placements[frame.actorEntityId] ?? null, recipientPlace: frame.targetEntityId ? state.truth.placements[frame.targetEntityId] ?? null : null } : null;
    questions[`${prefix}_outcome`] = question(transfer
      ? "Can this willing sender hand THIS listed resource amount to THIS recipient now? The sender, resource, quantity and actual inventory are explicitly bound below. Judge only this handover and applicable social or physical restrictions, not the recipient paying again or completion of the sender's entire goal. A recipient who has already spent their payment can receive goods with zero currency remaining. An established exchange permits its second leg after the first actual payment. The kernel separately enforces inventory arithmetic. Earlier failed attempts do not themselves prohibit a fresh valid handover."
      : "feasibility of this single concrete kind and its parameters, NOT completion of proposal.goal or the whole compound proposal.rawText. Speaking succeeds when actual words can be uttered; accepting terms does not require goods already delivered. Observing attempts to inspect the selected object or immediate surroundings; separate visibility questions decide what is learned.", (transfer ?? frame) as unknown as JsonValue,
      { succeeded: "The action can achieve its specified immediate effect", partial: "Only part of that immediate effect is achieved",
        failed: "The concrete attempted action cannot occur", unknown: "Evidence required for this immediate action is absent; speech need not already be true or accepted" });
    if (["move", "use", "change"].includes(frame.kind)) questions[`${prefix}_duration`] = question("required total duration, respecting explicit rules and the actual activity", frame as unknown as JsonValue,
      { planned: `Use the proposed ${frame.durationSeconds} seconds`, ...Object.fromEntries(durations.map(seconds => [`s${seconds}`, `${seconds} seconds`])) });
    if (frame.kind === "move") questions[`${prefix}_movement`] = question("Does this movement enter the target as a place, or merely approach an object/person without entering its interior? Standing beside a machine does not put the actor inside it.", frame as unknown as JsonValue,
      { enter: "Enter the selected destination as a place", near: "Approach the target within its surrounding place" });
    if (!frame.requestContinuation && (frame.submissionId || frame.causeActionId)) questions[`${prefix}_request_progress`] = question("Assuming THIS concrete action and its admitted immediate effects have settled, does it cover the submitted request or this NPC's immediate response? An if/otherwise request has alternative branches: completing its applicable branch completes that request, without then doing the other branch. A completed repair does not authorize testing unless the current request also asks for testing; the Agent's broader goal does not authorize extra work. Movement alone does not perform a requested gesture, repair or conversation. A non-null utterance is spoken alongside this action, including a move/change/use; never repeat those already included words. Speech also includes any simultaneous expressive gesture described in ActionExpression: waving while greeting completes both. An observation without an utterance does not speak or build. Select continue only when a distinct remaining step is already authorized and does not need another person's reply; select wait only when new evidence or consent is genuinely required. For an NPC, continue only its concrete immediate follow-through, such as actually handing over goods after saying it is doing so; a general long-term goal or an optional future plan is not continuation of this response.", frame as unknown as JsonValue,
      { complete: "This attempt handles the submitted action; any long-term goal remains separate",
        continue: "Only a prerequisite is handled; another concrete step is already authorized by this input",
        wait: "The next step needs an actual reply, new evidence or a new player decision" });
    const focus = frame.kind === "observe" && frame.observationScope === "inventory" ? frame.actorEntityId
      : frame.kind === "observe" && (!frame.targetEntityId || frame.targetEntityId === frame.actorEntityId) ? state.truth.placements[frame.actorEntityId] : frame.targetEntityId;
    const targetFacts = orderedValues(state.truth.facts).filter(fact => fact.subjectId === (focus ?? frame.actorEntityId));
    if (["use", "change"].includes(frame.kind)) {
      if (!capability) questions[`${prefix}_expression`] = question("Can the existing properties and authored mechanical procedures represent the requested immediate RESULT? Choose existing when an available procedure or property change expresses that result, including a random outcome. Operating steps, tool handling, taking readings, or a differently worded method do not themselves require a new capability. Expand only for a genuinely missing result concept or new constructed object; never invent a second success property alongside an existing authored result.", {
        action: frame as unknown as JsonValue, existingProperties: targetFacts as unknown as JsonValue,
        authoredProcedures: definition.randomDistributions as unknown as JsonValue }, {
        existing: "Existing properties and mechanical operations express the immediate effect, or this attempt has no justified effect",
        expand: "A plausible new qualitative property, construct or capability is needed to express the actual intended effect",
      });
      for (const [ordinal, fact] of targetFacts.entries()) {
        const id = `${prefix}_fact${ordinal}`, values = factOptions(fact, frames, state);
        effects.set(id, { fact, values });
        questions[id] = question("resulting value of this existing fact if the action succeeds and no random trial governs it. Unaffected properties stay unchanged.", { actionId: frame.id, fact: fact as unknown as JsonValue },
          { unchanged: "This property is unaffected or evidence is insufficient", ...Object.fromEntries(values.map((value, i) => [`v${i}`, value as unknown as Record<string, JsonValue>])) });
      }
      for (const [distributionIndex, distribution] of definition.randomDistributions.entries()) {
        const applies = `${prefix}_random${distributionIndex}`;
        questions[applies] = question("Does this actual action require this specific authored random procedure?", {
          actionId: frame.id, procedure: distribution as unknown as JsonValue },
          { apply: "This action performs this procedure, so its draw must occur", none: "This procedure is unrelated to this action", unknown: "Its preconditions are not established" });
        for (const [stepIndex, step] of distribution.steps.entries()) {
          const facts = targetFacts.filter(fact => step.outcomes.every(value => typeof value === (fact.value.kind === "boolean" ? "boolean" : fact.value.kind === "number" ? "number" : "string")));
          if (!facts.length) continue;
          const id = `${applies}_target${stepIndex}`;
          randomOptions.set(id, { distributionId: distribution.id, stepId: step.id, applies, facts });
          questions[id] = question("Which ONE existing property receives this procedure step's actual sampled value? Match the meaning of the sample to the property. Other properties remain governed by their separate effects. This answer is ignored unless the procedure is performed.", {
            actionId: frame.id, procedure: distribution.description, step: step as unknown as JsonValue },
            { none: "This sample does not directly set any listed property", ...Object.fromEntries(facts.map((fact, i) => [`f${i}`, {
              property: fact.predicate, meaning: fact.description, currentValue: fact.value as unknown as JsonValue }])) });
        }
      }
      for (const resource of orderedValues(state.truth.mechanics.quantities)) for (const kind of ["consume_quantity", "produce_quantity"] as const) {
        const laws = kind === "consume_quantity" ? resource.consumptionLawIds : resource.productionLawIds;
        for (const lawId of laws) {
          const id = `${prefix}_resource${resources.size}`; resources.set(id, { definitionId: resource.id, lawId, kind });
          const data = { actionId: frame.id, resource: resource.name, kind, lawId, law: definition.laws.find(law => law.id === lawId)!.text };
          questions[`${id}_applies`] = question("Does this resource-changing law apply to the actual operation being performed NOW? A previously completed prerequisite does not consume materials again. Inspecting, checking or testing a repaired object does not repeat its repair.", data,
            { apply: "This concrete action actually performs the resource-changing operation described by this law", none: "This action does not perform that operation", unknown: "The operation cannot yet be established" });
          questions[id] = question("amount required IF this resource-changing law applies; this answer is ignored when the law does not apply", data,
            { none: "No actual resource change under this law", ...Object.fromEntries(amounts.map(amount => [`n${amount}`, `${amount} ${resource.unit}`])) });
        }
      }
      const conditions = orderedValues(state.truth.mechanics.conditionProfiles);
      if (conditions.length) questions[`${prefix}_condition`] = question("condition caused on the target", frame as unknown as JsonValue,
        { none: "No condition is created", ...Object.fromEntries(conditions.map(profile => [profile.id, profile.name])) });
      if (capability) questions[`${prefix}_capability`] = question("Does this capability perform this action's immediate intended method and result? Sharing an object or general goal is insufficient. A different procedure does not authorize repeating this capability's effects or prerequisites.", { action: frame as unknown as JsonValue, capability: capability as unknown as JsonValue },
        { apply: "Apply its immediate declared effects", unavailable: "The required materials, skill or conditions are absent", unknown: "Need more evidence" });
      for (const pool of orderedValues(state.truth.sharedActivityResourcePools).filter(pool => pool.entityId in view.entities)) {
        const resource = state.truth.mechanics.sharedActivityResources[pool.definitionId]!;
        const id = `${prefix}_pool${claims.size}`; claims.set(id, { poolId: pool.id, amount: resource.defaultClaimAmount });
        view.reads[`pool:${pool.id}`] = contentHash(pool);
        questions[id] = question("does this activity occupy the shared resource", { action: frame as unknown as JsonValue, resource: resource.name, location: pool.entityId, capacity: pool.capacity },
          { claim: "The activity requires exclusive capacity while active", none: "This action does not occupy that resource" });
      }
      const impacts = orderedValues(state.truth.mechanics.impactProfiles);
      if (impacts.length) {
        questions[`${prefix}_impact`] = question("authored numeric impact", frame as unknown as JsonValue,
          { none: "No numeric meter impact", ...Object.fromEntries(impacts.map(profile => [profile.id, profile as unknown as Record<string, JsonValue>])) });
        questions[`${prefix}_magnitude`] = question("effect magnitude on the authored scale", frame as unknown as JsonValue,
          Object.fromEntries(magnitudeBands.map(band => [band, band])));
      }
    }
    const observableFacts = new Map(targetFacts.map(fact => [fact.id, fact]));
    if (capability) createdObjectQuestions(frame, prefix, capability, questions);
    for (const [ordinal, effect] of capability?.effects.entries() ?? []) if (effect.kind === "fact") {
      const fact = capabilityFact(state, frame, capability!, effect, ordinal);
      if (fact) observableFacts.set(fact.id, fact);
    }
    if (["observe", "use", "change"].includes(frame.kind)) for (const [ordinal, fact] of [...observableFacts.values()].entries()) {
      const id = `${prefix}_visible${ordinal}`; visibility.set(id, fact);
      questions[id] = question("Is this PROPERTY perceptible through this action's resulting feedback? Judge access to the property, not whether its pre-action value is still true. A public visible state of the very object being handled is ordinarily perceptible; private codes and hidden mental states require their actual disclosure channel.", { actionId: frame.id, fact: fact as unknown as JsonValue },
        { visible: "The attempt reveals the resulting fact through an available perceptual channel", hidden: "The fact remains hidden", unknown: "No justified perceptual access" });
    }
    if (frame.kind === "observe" && frame.observationScope !== "inventory") {
      const focus = frame.targetEntityId && frame.targetEntityId !== frame.actorEntityId ? frame.targetEntityId : state.truth.placements[frame.actorEntityId];
      for (const [ordinal, entity] of orderedValues(state.truth.entities).filter(entity => entity.lifecycle === "active" && entity.id !== frame.actorEntityId && state.truth.placements[entity.id] === focus).entries()) {
        const id = `${prefix}_entity${ordinal}`; entityVisibility.set(id, entity);
        const nameId = `${id}_name`; entityNames.set(nameId, entity.id);
        questions[nameId] = question("Can the observer actually recognize this public name, for example from a visible sign or established prior acquaintance? Seeing a person does not disclose their hidden name or identity.", {
          actionId: frame.id, entity: entity as unknown as JsonValue }, { unnamed: "Only appearance or existence is established", named: "The actual name is perceptible or already known" });
        questions[id] = question("Is this entity's physical presence visible in the observed place? It is already located here. Public appearance supplies positive perceptual evidence unless an actual concealment or obstruction prevents it. Unknown name, private identity, deception in the submitted request, or unwillingness to speak do not hide a person's body. Judge only physical presence, not the success of the actor's later intentions.", { action: { kind: frame.kind, observationScope: frame.observationScope }, entity: entity as unknown as JsonValue,
          publicAppearance: orderedValues(state.truth.facts).filter(fact => fact.subjectId === entity.id && fact.access.kind === "public" && ["appearance", "appearance_label"].includes(fact.predicate)) as unknown as JsonValue },
          { visible: "Its presence is observable", hidden: "Its presence is concealed", unknown: "Insufficient perceptual evidence" });
      }
    }
    const recipients = ["speak", "transfer"].includes(frame.kind) && frame.targetEntityId ? [frame.targetEntityId]
      : frame.utterance || ["speak", "use", "change", "move"].includes(frame.kind) ? orderedValues(state.agents).filter(agent => agent.id !== frame.actorId &&
        state.truth.placements[agent.entityId] === state.truth.placements[frame.actorEntityId]).map(agent => agent.entityId) : [];
    candidates.set(prefix, recipients);
    for (const [ordinal, recipient] of recipients.entries()) questions[`${prefix}_delivery${ordinal}`] = question("can the recipient perceive this speech, transfer or physical method and effect", { action: frame as unknown as JsonValue, recipient },
      { delivered: "The actual words or physical method and effect are perceived", unavailable: "No actual perception", unknown: "Perception is uncertain" });
  }
  let answers = await decisions.ask(null, view.state, view.reads, questions);
  const missingBindings: Record<string, DecisionQuestionV2> = {};
  for (const [id, option] of randomOptions) if (selected(answers, option.applies) === "apply" && selected(answers, id) === "none") {
    const distribution = definition.randomDistributions.find(item => item.id === option.distributionId)!;
    missingBindings[id] = question("This procedure has actually been selected for execution. Which existing property receives its sampled physical result? Bind the result itself, not a completion label. The property's current value need not equal a possible result. Select none only if no listed property represents that result; the draw still occurs.", {
      action: frames[Number(id.split("_")[0]!.slice(1))] as unknown as JsonValue,
      procedure: distribution.description, step: distribution.steps.find(step => step.id === option.stepId) as unknown as JsonValue,
    }, { none: "No listed property represents this result", ...Object.fromEntries(option.facts.map((fact, i) => [`f${i}`, {
      property: fact.predicate, meaning: fact.description, currentValue: fact.value as unknown as JsonValue,
    }])) });
  }
  if (Object.keys(missingBindings).length) answers = { ...answers, ...await decisions.ask(null, view.state, view.reads, missingBindings) };
  const expansions = frames.flatMap((frame, index) => questions[`a${index}_expression`] && selected(answers, `a${index}_expression`) === "expand" ? [{ frame, index }] : []);
  const capabilityFailures = new Set<string>();
  if (expansions.length) {
    if (!creationEnabled) throw new Error("This action needs a new effect concept; the creation capability is disabled");
    const expanded = await Promise.allSettled(expansions.map(async ({ frame, index }) => ({ index, frame,
      result: await extendCapability({ state, control: decisions.control, frame, decisions,
        profileId: agentCapabilityModels(state, decisions.control, frame.actorId).creation,
        context: { action: frame.proposal.rawText, target: frame.targetEntityId ? state.truth.entities[frame.targetEntityId]!.description : null,
          tool: frame.toolEntityId ? state.truth.entities[frame.toolEntityId]!.description : null } }) })));
    const supplemental: Record<string, DecisionQuestionV2> = {};
    for (const [expansionIndex, result] of expanded.entries()) if (result.status === "fulfilled") {
      const { index, frame, result: extension } = result.value, prefix = `a${index}`;
      audits.push(...extension.audits);
      supplemental[`${prefix}_capability`] = question("Does this newly declared capability express this action's immediate intended method and result, with its conditions met? A related object or broader goal alone does not authorize its effects.", { action: frame as unknown as JsonValue, capability: extension.capability as unknown as JsonValue },
        { apply: "Apply its immediate declared effects", unavailable: "The required materials, skill or conditions are absent", unknown: "Need more evidence" });
      createdObjectQuestions(frame, prefix, extension.capability, supplemental);
      for (const [ordinal, effect] of extension.capability.effects.entries()) if (effect.kind === "fact") {
        const fact = capabilityFact(state, frame, extension.capability, effect, ordinal);
        if (!fact) continue;
        const id = `${prefix}_extended_visible${ordinal}`; visibility.set(id, fact);
        supplemental[id] = question("is this new property perceptible through the resulting action", { actionId: frame.id, fact: fact as unknown as JsonValue },
          { visible: "The resulting property is perceptible", hidden: "The property is hidden", unknown: "No justified perceptual access" });
      }
    } else {
      capabilityFailures.add(expansions[expansionIndex]!.frame.id);
      if (result.reason?.audits) audits.push(...result.reason.audits);
      else if (result.reason?.audit) audits.push(result.reason.audit);
    }
    try { if (Object.keys(supplemental).length) answers = { ...answers, ...await decisions.ask(null, view.state, view.reads, supplemental) }; }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      audits: [...audits, ...((error as { audits?: ModelExecutionAudit[] } | null)?.audits ?? [])] }); }
  }
  const worldExpansions = new Map<string, WorldExpansion>();
  const expansionFailures = new Set<string>();
  for (const [index, frame] of frames.entries()) if (answers[`a${index}_world_expansion`] && (selected(answers, `a${index}_world_expansion`) === "introduce" ||
    frame.submissionId && frame.kind === "observe" && frame.observationScope !== "inventory" && frame.targetEntityId !== frame.actorEntityId) &&
    ["succeeded", "partial", "unknown"].includes(selected(answers, `a${index}_outcome`))) {
    try {
    Object.assign(view.reads, captureDependencies(state, ["catalog:entities"]));
    const generated = await createWorldExpansion(state, definition, frame, decisions, view.state, view.reads);
    audits.push(...generated.audits);
    if (generated.expansion?.operations.length) worldExpansions.set(frame.id, generated.expansion);
    } catch (error) {
      const evidence = error as { audits?: ModelExecutionAudit[]; audit?: ModelExecutionAudit };
      audits.push(...(evidence.audits ?? (evidence.audit ? [evidence.audit] : [])));
      expansionFailures.add(frame.id);
    }
  }
  let projected = structuredClone(state) as SimulationState;
  const prepared: PreparedDirectAction[] = [];
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`, verdict = selected(answers, `${prefix}_outcome`), source = sourceFor(frame);
    const durationChoice = answers[`${prefix}_duration`] ? selected(answers, `${prefix}_duration`) : "planned";
    const duration = durationChoice === "planned" ? frame.durationSeconds : Number(durationChoice.slice(1));
    const ongoing = Boolean(frame.temporalProfileId && state.truth.mechanics.temporalProfiles[frame.temporalProfileId]?.kind === "ongoing" &&
      !/\d+\s*(秒|分钟|小时|seconds?|minutes?|hours?)/iu.test(frame.proposal.rawText));
    frame.durationSeconds = duration;
    frame.dueAtSeconds = Math.max(state.truth.elapsedSeconds + 1, frame.startedAtSeconds + duration);
    let status: ActionOutcome["status"] = capabilityFailures.has(frame.id) ? "blocked"
      : expansionFailures.has(frame.id) ? frame.kind === "observe" && ["succeeded", "partial"].includes(verdict) ? "partial" : "blocked"
      : verdict === "unknown" ? worldExpansions.has(frame.id) && frame.kind === "observe" ? "succeeded" : "blocked" : verdict as ActionOutcome["status"];
    let operations: WorldDeltaOperation[] = [];
    const randomRequests: PreparedDirectAction["randomRequests"] = [], randomBindings: PreparedDirectAction["randomBindings"] = [];
    let detail = status === "blocked" ? "还需要更多信息。" : status === "failed" ? "这次尝试未能完成。" : status === "partial" ? "这次行动取得了部分进展。"
      : frame.kind === "wait" ? "你在等待新的消息或条件变化。" : frame.kind === "observe" ? "你查看了眼前的情况。" : "行动已完成。";
    if (status === "succeeded" || status === "partial") {
      if (frame.kind === "move" && frame.targetEntityId) {
        const near = selected(answers, `${prefix}_movement`) === "near";
        const placementId = near ? state.truth.placements[frame.targetEntityId] ?? frame.targetEntityId : frame.targetEntityId;
        operations.push({ kind: "place_entity", entityId: frame.actorEntityId, placementId, ...source });
        if (near) {
          const fact: WorldFact = { id: directSemanticId("fact", [frame.actorEntityId, "proximity"]), subjectId: frame.actorEntityId,
            predicate: "proximity", value: { kind: "entity", entityId: frame.targetEntityId }, access: { kind: "public" },
            description: "来到目标附近。", provenance: source.causes };
          operations.push({ kind: "set_fact", fact, ...source });
          detail = "你已经来到目标附近。";
        }
      }
      if (frame.kind === "transfer") {
        if (frame.quantityDefinitionId && frame.targetEntityId && frame.amount !== null) operations.push({ kind: "transfer_quantity", definitionId: frame.quantityDefinitionId,
          fromHolderId: frame.actorEntityId, toHolderId: frame.targetEntityId, amount: frame.amount, ...source });
        else if (frame.toolEntityId && frame.targetEntityId) operations.push({ kind: "place_entity", entityId: frame.toolEntityId, placementId: frame.targetEntityId, ...source });
        else { status = "blocked"; detail = "还需要确认转移的对象、接收方或数量。"; }
      }
      const randomEffects = new Map<string, { distributionId: string; stepId: string }>();
      for (const [ordinal, distribution] of definition.randomDistributions.entries()) if (answers[`${prefix}_random${ordinal}`] && selected(answers, `${prefix}_random${ordinal}`) === "apply") {
        randomRequests.push({ id: `${frame.id}/random/${distribution.id}`, distributionId: distribution.id, distribution, causes: source.causes });
      }
      let unboundRandomEffect = false;
      for (const [id, option] of randomOptions) if (id.startsWith(`${prefix}_`) && selected(answers, option.applies) === "apply") {
        const target = selected(answers, id);
        if (target !== "none") randomEffects.set(option.facts[Number(target.slice(1))]!.id, option);
        else unboundRandomEffect = true;
      }
      for (const [id, effect] of effects) {
        if (!id.startsWith(`${prefix}_`)) continue;
        const value = selected(answers, id);
        const random = randomEffects.get(effect.fact.id);
        if (random) {
          const requestId = `${frame.id}/random/${random.distributionId}`;
          randomBindings.push({ factId: effect.fact.id, requestId, stepId: random.stepId });
          operations.push({ kind: "set_fact", fact: { ...effect.fact, provenance: source.causes }, ...source });
          continue;
        }
        if (value === "unchanged" || unboundRandomEffect) continue;
        const chosen = effect.values[Number(value.slice(1))]!;
        if (contentHash(chosen) === contentHash(effect.fact.value)) continue;
        operations.push({ kind: "set_fact", fact: { ...changedFact(effect.fact, chosen), provenance: source.causes }, ...source });
      }
      for (const [id, resource] of resources) if (id.startsWith(`${prefix}_`)) {
        if (selected(answers, `${id}_applies`) !== "apply") continue;
        const amount = selected(answers, id); if (amount === "none") continue;
        operations.push({ ...resource, kind: resource.kind, holderId: frame.actorEntityId, amount: Number(amount.slice(1)),
          causes: [...source.causes, { kind: "law", id: resource.lawId }], assertions: source.assertions });
      }
      const addCondition = (profileId: string, subjectId: string) => {
        const profile = state.truth.mechanics.conditionProfiles[profileId]!;
        const duration = state.truth.mechanics.durationProfiles[profile.defaultDurationProfileId]!;
        const id = directSemanticId("condition", [frame.id, profileId, subjectId]);
        const condition = materializeCondition({ intent: { kind: "condition", id, targetId: subjectId, channel: profile.id, label: profile.name,
          description: profile.name, conditionId: id, conditionProfileId: profile.id, durationProfileId: duration.id, access: { kind: "public" }, magnitude: "standard", sourceRefs: [] },
          magnitude: "standard", duration, profile, elapsedSeconds: frame.dueAtSeconds!, provenance: source.causes });
        operations.push({ kind: "set_condition", condition, ...source });
      };
      if (answers[`${prefix}_condition`] && selected(answers, `${prefix}_condition`) !== "none") addCondition(selected(answers, `${prefix}_condition`), frame.targetEntityId ?? frame.actorEntityId);
      if (answers[`${prefix}_capability`]) {
        if (selected(answers, `${prefix}_capability`) === "apply") {
          const capability = decisions.control.capabilities.find(capability => capability.id === frame.capabilityId)!;
          for (const [ordinal, effect] of capability.effects.entries()) {
            if (effect.kind === "object") {
              const id = directSemanticId("object", [frame.id, String(ordinal)]);
              operations.push({ kind: "create_entity", entity: { id, kind: "object", name: effect.name, description: effect.description, lifecycle: "active", createdAtStep: state.step + 1 },
                placementId: effect.placement === "actor" ? frame.actorEntityId : frame.targetEntityId, ...source });
            } else {
              const subjectId = effect.subject === "actor" ? frame.actorEntityId : effect.subject === "target" ? frame.targetEntityId : frame.toolEntityId;
              if (!subjectId) { status = "blocked"; detail = "能力缺少实际作用对象。"; break; }
              if (effect.kind === "condition") addCondition(effect.profileId, subjectId);
              else if (effect.kind === "placement") operations.push({ kind: "place_entity", entityId: subjectId,
                placementId: effect.destination === "actor" ? frame.actorEntityId : effect.destination === "target" ? frame.targetEntityId : state.truth.placements[frame.actorEntityId] ?? null,
                ...source });
              else {
                const fact = capabilityFact(state, frame, capability, effect, ordinal)!;
                if (!unboundRandomEffect && !randomEffects.has(fact.id)) operations.push({ kind: "set_fact", fact, ...source });
              }
            }
          }
        } else { status = "blocked"; operations = []; detail = "能力的适用条件尚未满足。"; }
      }
      const impactChoice = answers[`${prefix}_impact`] ? selected(answers, `${prefix}_impact`) : "none";
      if (impactChoice !== "none") {
        const impact = state.truth.mechanics.impactProfiles[impactChoice]!;
        const meter = Object.values(projected.truth.meters).find(meter => meter.entityId === (frame.targetEntityId ?? frame.actorEntityId) && meter.definitionId === impact.meterDefinitionId);
        if (meter) {
          const definition = state.truth.mechanics.meters[meter.definitionId]!, band = selected(answers, `${prefix}_magnitude`) as typeof magnitudeBands[number];
          const amount = deriveClampedMeterDelta(meter.current, definition.min, definition.max, impact.amounts[band] * (impact.direction === "increase" ? 1 : -1));
          if (amount) operations.push({ kind: "adjust_meter", meterId: meter.id, amount, ...source });
        }
      }
      const expansion = worldExpansions.get(frame.id);
      if (["use", "change"].includes(frame.kind)) {
        const noConfirmedEffect = !ongoing && operations.length === 0 && randomRequests.length === 0;
        detail = ongoing ? "你已开始持续进行这项活动。" : noConfirmedEffect ? "你作出了这次尝试，尚无可确认的状态变化。" : "本次操作已执行，具体结果以观察到的状态为准。";
        const method = answers[`${prefix}_capability`] && selected(answers, `${prefix}_capability`) === "apply"
          ? decisions.control.capabilities.find(capability => capability.id === frame.capabilityId) : null;
        if (method && !noConfirmedEffect && !ongoing) detail = `本次已执行的方法：${method.description}。具体结果以观察到的状态为准。`;
        if (noConfirmedEffect) status = "partial";
        if (unboundRandomEffect) { status = "partial"; detail = "本次程序已执行并记录实际抽取结果，结果对应的状态仍待确认。"; }
      }
      // The draft summary is creative intent, not an executed action receipt.
      if (expansion) operations.push(...expansion.operations);
      const transaction = structuredClone(projected);
      try { for (const operation of operations) applyWorldDeltaOperation(transaction, operation); projected = transaction; }
      catch (error) { operations = []; status = "blocked"; detail = error instanceof Error && error.message === "insufficient quantity" ? "可用资源不足，这次操作没有完成。" : "当前状态不允许完成这次行动。"; }
    }
    const expansion = worldExpansions.get(frame.id);
    const visibleFacts = [...visibility].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "visible").map(([, fact]) => fact);
    const visibleEntities = [...entityVisibility].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "visible").map(([, entity]) => entity);
    const deliveredToEntityIds = ["succeeded", "partial"].includes(status)
      ? (candidates.get(prefix) ?? []).filter((_, ordinal) => selected(answers, `${prefix}_delivery${ordinal}`) === "delivered") : [];
    if (frame.kind === "speak" && !frame.utterance) { status = "blocked"; detail = "还没有形成实际话语。"; }
    else if (frame.kind === "speak" && ["succeeded", "partial"].includes(status)) detail = deliveredToEntityIds.length
      ? `你说：“${frame.utterance}”话语已送达。` : `你说：“${frame.utterance}”没有听众作出回应。`;
    if (!["succeeded", "partial"].includes(status)) operations = [];
    prepared.push({ actionId: frame.id, status, summary: detail, operations, reads: view.reads,
      visibleFactIds: ["succeeded", "partial"].includes(status) ? [...visibleFacts, ...(expansion?.facts ?? []),
        ...operations.flatMap(operation => operation.kind === "set_fact" && operation.fact.predicate === "proximity" ? [operation.fact] : [])].map(fact => fact.id) : [],
      visibleEntityIds: ["succeeded", "partial"].includes(status) ? [...visibleEntities, ...(expansion?.entities ?? [])].map(entity => entity.id) : [], deliveredToEntityIds,
      namedEntityIds: [...entityNames].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "named").map(([, entityId]) => entityId),
      randomRequests: ["succeeded", "partial"].includes(status) ? randomRequests : [], randomBindings: ["succeeded", "partial"].includes(status) ? randomBindings : [],
      sharedClaims: [...claims].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "claim").map(([, claim]) => claim),
      ongoing,
      requestProgress: frame.requestContinuation ?? (frame.submissionId || frame.causeActionId ? selected(answers, `${prefix}_request_progress`) as PreparedDirectAction["requestProgress"] : "complete") });
  }
  return { prepared, reads: view.reads, audits };
}
