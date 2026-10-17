import { createWorldExpansion, type WorldExpansion } from "./expansion";
import { canHaveWitnesses, contactQuestions, contactPolicy } from "./contact";
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
import { localWorldView, perceptualNeighborhood, sharesContactNeighborhood } from "./views";
import { orderedValues, captureDependencies } from "./state";
import { literalNumbers } from "./actions";
import { changedFact } from "./presentation";
import { extendCapability } from "./capabilities";
import { agentCapabilityModels } from "../models/capability-bindings";

export interface ActionSettlement {
  frame: ActionFrame; outcome: ActionOutcome; operations: WorldDeltaOperation[]; visibleFacts: WorldFact[];
  visibleEntities: WorldEntity[];
  actorOnlyFactIds: string[]; actorOnlyEntityIds: string[];
  namedEntityIds: string[];
  deliveredToEntityIds: string[];
  actorVisibleToEntityIds?: string[];
}
const ordinaryStates = ["open", "closed", "working", "stopped", "damaged", "repaired", "leaking", "sealed", "temporarily sealed", "tested", "untested", "available", "unavailable"];
function factOptions(fact: WorldFact, frames: ActionFrame[], state: Readonly<SimulationState>): FactValue[] {
  if (fact.value.kind === "boolean") return [{ kind: "boolean", value: true }, { kind: "boolean", value: false }];
  if (fact.value.kind === "entity" || fact.value.kind === "none") {
    const previous = fact.value.kind === "entity" ? fact.value.entityId : null;
    const related = new Set(frames.flatMap(frame => [frame.actorEntityId, frame.targetEntityId, frame.toolEntityId])
      .filter((id): id is string => id !== null && id !== previous));
    return [fact.value, ...(previous ? [{ kind: "none" as const }] : []), ...[...related].map(entityId => ({ kind: "entity" as const, entityId }))];
  }
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
  const view = localWorldView(state, definition, frames, decisions.scope.memory), questions: Record<string, DecisionQuestionV2> = {};
  const adjudicationRules: Record<string, string> = {};
  const question = (task: string, data: JsonValue, criteria: Record<string, string | Record<string, JsonValue>>): DecisionQuestionV2 => {
    const rule = `rule_${contentHash(task).slice(0, 16)}`;
    adjudicationRules[rule] = task;
    return { type: "choice", version: "direct-world-3", instructions: {
      task: "Apply state.adjudicationPolicy and state.adjudicationRules[rule]. Resolve actionId in state.actions; all parameters and words are retained there.", rule, data,
    }, criteria };
  };
  view.state = { ...view.state as Record<string, JsonValue>, adjudicationPolicy: loadPromptAsset("user/direct-world.md"), adjudicationRules };
  const effects = new Map<string, { fact: WorldFact; values: FactValue[] }>();
  const visibility = new Map<string, WorldFact>();
  const entityVisibility = new Map<string, WorldEntity>();
  const entityNames = new Map<string, string>();
  const incidental = new Map<string, { facts: string[]; entities: string[] }>();
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
  if (!durations.length) durations.push(30);
  const amounts = [...new Set([1, ...frames.flatMap(frame => literalNumbers(frame.proposal.rawText)), ...definition.laws.flatMap(law => literalNumbers(law.text))])].sort((a, b) => a - b);
  const resources = new Map<string, { definitionId: string; lawId: string; kind: "consume_quantity" | "produce_quantity" }>();
  const claims = new Map<string, { poolId: string; amount: number }>();
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`;
    if (creationEnabled && definition.narrative.expansion) questions[`${prefix}_world_expansion`] = question(
      "Does this action reach a plausible but not yet established part of the local situation? The initial catalog is partial: a place's name and exterior do not exhaust its people, contents or affairs. Exploration and ongoing local concerns can warrant ordinary discoverable content or a new opportunity without an explicit request for a surprise. Select introduce for a useful local draft when existing content does not cover that scope. Missing entries are not evidence of physical absence. Existing actors still act through their own decisions; respect confirmed absence, identity, privacy and conserved resources. A draft may give a lead or complication rather than the desired outcome. Select none for sufficient existing content or quiet continuity; do not create merely to force success.",
      { actionId: frame.id }, { none: "Existing content covers this interaction, or no plausible addition is warranted", introduce: "Develop a plausible unestablished part of the local situation for admission" });
    const capability = decisions.control.capabilities.find(capability => capability.id === frame.capabilityId && capability.knownToAgentIds.includes(frame.actorId));
    const transfer = frame.kind === "transfer" ? { actionId: frame.id, sender: frame.actorEntityId, recipient: frame.targetEntityId,
      resource: frame.quantityDefinitionId, amount: frame.amount,
      currentlyOwnedBySender: orderedValues(state.truth.quantities).filter(quantity => quantity.holderId === frame.actorEntityId && quantity.definitionId === frame.quantityDefinitionId).reduce((sum, quantity) => sum + quantity.amount, 0),
      senderPlace: state.truth.placements[frame.actorEntityId] ?? null, recipientPlace: frame.targetEntityId ? state.truth.placements[frame.targetEntityId] ?? null : null } : null;
    questions[`${prefix}_outcome`] = question(transfer
      ? "Can this willing sender hand THIS listed resource amount to THIS recipient now? The sender, resource, quantity and actual inventory are explicitly bound below. Judge only this handover and applicable social or physical restrictions, not the recipient paying again or completion of the sender's entire goal. A recipient who has already spent their payment can receive goods with zero currency remaining. An established exchange permits its second leg after the first actual payment. The kernel separately enforces inventory arithmetic. Earlier failed attempts do not themselves prohibit a fresh valid handover."
      : "feasibility of this single concrete kind and its parameters, NOT completion of proposal.goal or the whole compound proposal.rawText. Speaking succeeds when actual words can be uttered; accepting terms does not require goods already delivered. Observing attempts to inspect the selected object or immediate surroundings; separate visibility questions decide what is learned.", (transfer ?? { actionId: frame.id }) as unknown as JsonValue,
      { succeeded: "The action can achieve its specified immediate effect", partial: "Only part of that immediate effect is achieved",
        failed: "The concrete attempted action cannot occur", unknown: "Evidence required for this immediate action is absent; speech need not already be true or accepted" });
    const timingProfile = frame.temporalProfileId ? state.truth.mechanics.temporalProfiles[frame.temporalProfileId] : null;
    if (frame.durationSource !== "explicit" && !(frame.durationSeconds > 0 && ["rate", "staged", "ongoing"].includes(timingProfile?.kind ?? ""))) {
      questions[`${prefix}_duration`] = question("Choose the realistic TOTAL duration of this concrete step. Use temporalCalibrations, explicit laws, distance, effort and the length of actual spoken words. A missing duration is not evidence of an instantaneous action. Estimate the nearest plausible authored scale; neither minimize time nor charge a later unperformed step. Concurrent actions keep independent durations.",
        { actionId: frame.id }, { ...(frame.durationSeconds > 0 ? { planned: `Use the proposed ${frame.durationSeconds} seconds if it fits the actual activity` } : {}),
          ...Object.fromEntries(durations.map(seconds => [`s${seconds}`, `${seconds} seconds`])) });
    }
    if (frame.kind === "move") questions[`${prefix}_movement`] = question("Does this movement enter the target as a place, or merely approach an object/person without entering its interior? Standing beside a machine does not put the actor inside it.", { actionId: frame.id },
      { enter: "Enter the selected destination as a place", near: "Approach the target within its surrounding place" });
    const trigger = frame.causeActionId ? state.history.flatMap(step => step.directEvent?.frames ?? [])
      .find(action => action.id === frame.causeActionId) : null;
    if (!frame.requestContinuation && (frame.submissionId || frame.causeActionId)) questions[`${prefix}_request_progress`] = question("After THIS action settles, is the immediate request handled? responseTo gives the interaction that this NPC is answering. If someone asked the NPC to inspect and tell them the result, a private observation only obtains evidence: continue with the report or a grounded explanation before completing that response. Inspecting is not answering, and announcing that one will act is not doing it. Likewise, continue an immediately promised handover. End once the requested answer/work is done; a broader goal, optional future plan or unrelated overheard exchange does not authorize extra work. A non-null utterance is already spoken alongside this action and must not repeat. For compound or conditional work, continue only a distinct authorized step in the applicable branch. Movement alone does not perform later work. Select wait when the next step needs new consent, evidence or a reply.",
      { actionId: frame.id, responseTo: trigger ? { kind: trigger.kind, utterance: trigger.utterance, requested: trigger.proposal.goal,
        actorEntityId: trigger.actorEntityId, recipientEntityId: trigger.targetEntityId } : null } as unknown as JsonValue,
      { complete: "This attempt handles the submitted action; any long-term goal remains separate",
        continue: "Only a prerequisite is handled; another concrete step is already authorized by this input",
        wait: "The next step needs an actual reply, new evidence or a new player decision" });
    const focus = frame.kind === "observe" && frame.observationScope === "inventory" ? frame.actorEntityId
      : frame.kind === "observe" && (!frame.targetEntityId || frame.targetEntityId === frame.actorEntityId) ? state.truth.placements[frame.actorEntityId] : frame.targetEntityId;
    const targetFacts = orderedValues(state.truth.facts).filter(fact => fact.subjectId === (focus ?? frame.actorEntityId));
    const effectSubjects = new Set([frame.actorEntityId, frame.targetEntityId, frame.toolEntityId]);
    const effectFacts = ["move", "use", "change"].includes(frame.kind)
      ? orderedValues(state.truth.facts).filter(fact => effectSubjects.has(fact.subjectId)) : targetFacts;
    if (["move", "use", "change"].includes(frame.kind)) for (const [ordinal, fact] of effectFacts.entries()) {
      const id = `${prefix}_fact${ordinal}`, values = factOptions(fact, frames, state);
      effects.set(id, { fact, values });
      questions[id] = question("Resulting value of this existing property if the action succeeds and no random trial governs it. Include necessary changes to the actor's or tool's state caused by this immediate method, including movement. An obsolete posture or relation must cease when this action reverses it; do not preserve contradictory states. Unaffected properties stay unchanged. Necessary state consequences do not authorize extra voluntary actions.", { actionId: frame.id, fact: fact as unknown as JsonValue },
        { unchanged: "This property is unaffected or evidence is insufficient",
          ...(fact.value.kind === "text" ? { new_value: "This action necessarily changes this property, but NONE of the offered values expresses the new state. Request an open qualitative effect for this exact property." } : {}),
          ...Object.fromEntries(values.map((value, i) => [`v${i}`, value as unknown as Record<string, JsonValue>])) });
    }
    if (["use", "change"].includes(frame.kind)) {
      if (!capability) questions[`${prefix}_expression`] = question("How will this immediate result be represented? existing requires a specific available property or authored procedure that actually expresses the result. An unrelated appearance or object description is insufficient. A posture, holding/contact, ongoing pressure or temporary bodily relation persists after this boundary and needs an actual property, even when its intended wider benefit fails. Use expand if that property is missing. no_change is only a newly performed instantaneous method with no continuing condition. already means evidence establishes that the requested end state already holds: no repeated method occurs. Do not silently drop a requested state change or duplicate a property for a differently worded method.", {
        actionId: frame.id, existingPropertyIds: effectFacts.map(fact => fact.id),
        authoredProcedures: definition.randomDistributions as unknown as JsonValue }, {
        existing: "A specific existing property or authored procedure expresses the immediate effect",
        no_change: "A new instantaneous method is performed without any continuing posture, contact or state change",
        already: "Actual current evidence establishes the requested state already holds; no repeated physical method is needed",
        expand: "A plausible new qualitative property, construct or capability is needed to express the actual intended effect",
      });
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
      if (conditions.length) questions[`${prefix}_condition`] = question("condition caused on the target", { actionId: frame.id },
        { none: "No condition is created", ...Object.fromEntries(conditions.map(profile => [profile.id, profile.name])) });
      if (capability) questions[`${prefix}_capability`] = question("Does this capability perform this action's immediate intended method and result? Sharing an object or general goal is insufficient. A different procedure does not authorize repeating this capability's effects or prerequisites.", { actionId: frame.id, capability: capability as unknown as JsonValue },
        { apply: "Apply its immediate declared effects", unavailable: "The required materials, skill or conditions are absent", unknown: "Need more evidence" });
      for (const pool of orderedValues(state.truth.sharedActivityResourcePools).filter(pool => pool.entityId in view.entities)) {
        const resource = state.truth.mechanics.sharedActivityResources[pool.definitionId]!;
        const id = `${prefix}_pool${claims.size}`; claims.set(id, { poolId: pool.id, amount: resource.defaultClaimAmount });
        view.reads[`pool:${pool.id}`] = contentHash(pool);
        questions[id] = question("does this activity occupy the shared resource", { actionId: frame.id, resource: resource.name, location: pool.entityId, capacity: pool.capacity },
          { claim: "The activity requires exclusive capacity while active", none: "This action does not occupy that resource" });
      }
      const impacts = orderedValues(state.truth.mechanics.impactProfiles);
      if (impacts.length) {
        questions[`${prefix}_impact`] = question("authored numeric impact", { actionId: frame.id },
          { none: "No numeric meter impact", ...Object.fromEntries(impacts.map(profile => [profile.id, profile as unknown as Record<string, JsonValue>])) });
        questions[`${prefix}_magnitude`] = question("effect magnitude on the authored scale", { actionId: frame.id },
          Object.fromEntries(magnitudeBands.map(band => [band, band])));
      }
    }
    const neighborhood = perceptualNeighborhood(state, frame);
    incidental.set(frame.id, { entities: [...neighborhood], facts: orderedValues(state.truth.facts)
      .filter(fact => neighborhood.has(fact.subjectId) && !effectFacts.some(effect => effect.id === fact.id)).map(fact => fact.id) });
    const observableFacts = new Map([...effectFacts, ...orderedValues(state.truth.facts).filter(fact => neighborhood.has(fact.subjectId))].map(fact => [fact.id, fact]));
    if (capability) createdObjectQuestions(frame, prefix, capability, questions);
    for (const [ordinal, effect] of capability?.effects.entries() ?? []) if (effect.kind === "fact") {
      const fact = capabilityFact(state, frame, capability!, effect, ordinal);
      if (fact) observableFacts.set(fact.id, fact);
    }
    for (const [ordinal, fact] of [...observableFacts.values()].entries()) {
      const id = `${prefix}_visible${ordinal}`; visibility.set(id, fact);
      questions[id] = question("Judge this property's perceptual access under the incidental-perception policy.", { actionId: frame.id, factId: fact.id,
        ...(!state.truth.facts[fact.id] ? { fact: fact as unknown as JsonValue } : {}) },
        { visible: "The attempt reveals the resulting fact through an available perceptual channel", hidden: "The fact remains hidden", unknown: "No justified perceptual access" });
    }
    if (neighborhood.size) {
      const actor = state.agents[frame.actorId]!;
      const alreadySeen = new Set(Object.values(actor.bindings).filter(binding => actor.belief.localEntities[binding.localEntityId]?.status === "observed")
        .flatMap(binding => binding.canonicalEntityIds));
      for (const [ordinal, entity] of orderedValues(state.truth.entities).filter(entity => neighborhood.has(entity.id) && entity.id !== frame.actorEntityId &&
        (frame.kind === "observe" || !alreadySeen.has(entity.id))).entries()) {
        const id = `${prefix}_entity${ordinal}`; entityVisibility.set(id, entity);
        const nameId = `${id}_name`; entityNames.set(nameId, entity.id);
        questions[nameId] = question("Is this name recognizable through evidence such as a sign or prior acquaintance? Seeing a body alone does not identify a person.", {
          actionId: frame.id, entityId: entity.id }, { unnamed: "Only appearance or existence is established", named: "The actual name is perceptible or already known" });
        questions[id] = question("Judge this entity's physical presence under the incidental-perception policy.", { actionId: frame.id, entityId: entity.id },
          { visible: "Its presence is observable", hidden: "Its presence is concealed", unknown: "Insufficient perceptual evidence" });
      }
    }
    const nearby = canHaveWitnesses(frame) ? orderedValues(state.agents)
      .filter(agent => agent.id !== frame.actorId && (sharesContactNeighborhood(state, agent.entityId, frame.actorEntityId) ||
        frame.kind === "move" && state.truth.placements[agent.entityId] === frame.targetEntityId))
      .map(agent => agent.entityId) : [];
    const recipients = [...new Set([...["speak", "transfer"].includes(frame.kind) && frame.targetEntityId ? [frame.targetEntityId] : [], ...nearby])];
    candidates.set(prefix, recipients);
    for (const [ordinal, recipient] of recipients.entries()) {
      const contact = contactQuestions(frame, recipient, state.truth.placements[recipient] === state.truth.placements[frame.actorEntityId]);
      questions[`${prefix}_delivery${ordinal}`] = contact.delivery;
      questions[`${prefix}_actor_visibility${ordinal}`] = contact.actorVisibility;
    }
  }
  if ([...candidates.values()].some(recipients => recipients.length)) Object.assign(view.state as object, { contactPolicy });
  let answers = await decisions.ask(null, view.state, view.reads, questions);
  const missingBindings: Record<string, DecisionQuestionV2> = {};
  for (const [id, option] of randomOptions) if (selected(answers, option.applies) === "apply" && selected(answers, id) === "none") {
    const distribution = definition.randomDistributions.find(item => item.id === option.distributionId)!;
    missingBindings[id] = question("This procedure has actually been selected for execution. Which existing property receives its sampled physical result? Bind the result itself, not a completion label. The property's current value need not equal a possible result. Select none only if no listed property represents that result; the draw still occurs.", {
      actionId: frames[Number(id.split("_")[0]!.slice(1))]!.id,
      procedure: distribution.description, step: distribution.steps.find(step => step.id === option.stepId) as unknown as JsonValue,
    }, { none: "No listed property represents this result", ...Object.fromEntries(option.facts.map((fact, i) => [`f${i}`, {
      property: fact.predicate, meaning: fact.description, currentValue: fact.value as unknown as JsonValue,
    }])) });
  }
  if (Object.keys(missingBindings).length) answers = { ...answers, ...await decisions.ask(null, view.state, view.reads, missingBindings) };
  const expansions = frames.flatMap((frame, index) => {
    if (!["succeeded", "partial"].includes(selected(answers, `a${index}_outcome`))) return [];
    const requiredPropertyChanges = [...effects].filter(([id]) => id.startsWith(`a${index}_`) && selected(answers, id) === "new_value")
      .map(([, { fact }]) => ({ subject: fact.subjectId === frame.actorEntityId ? "actor" : fact.subjectId === frame.targetEntityId ? "target" : "tool",
        predicate: fact.predicate, currentValue: fact.value, description: fact.description }));
    return requiredPropertyChanges.length || questions[`a${index}_expression`] && selected(answers, `a${index}_expression`) === "expand"
      ? [{ frame, index, requiredPropertyChanges }] : [];
  });
  const capabilityFailures = new Set<string>();
  if (expansions.length) {
    if (!creationEnabled) throw new Error("This action needs a new effect concept; the creation capability is disabled");
    const expanded = await Promise.allSettled(expansions.map(async ({ frame, index, requiredPropertyChanges }) => ({ index, frame,
      result: await extendCapability({ state, control: decisions.control, frame, decisions,
        profileId: agentCapabilityModels(state, decisions.control, frame.actorId).creation,
        context: { action: frame.expression?.attempt ?? frame.proposal.rawText, operation: frame.kind,
          requiredPropertyChanges: requiredPropertyChanges as unknown as JsonValue,
          target: frame.targetEntityId ? state.truth.entities[frame.targetEntityId]!.description : null,
          tool: frame.toolEntityId ? state.truth.entities[frame.toolEntityId]!.description : null } }) })));
    const supplemental: Record<string, DecisionQuestionV2> = {};
    for (const [expansionIndex, result] of expanded.entries()) if (result.status === "fulfilled") {
      const { index, frame, result: extension } = result.value, prefix = `a${index}`;
      audits.push(...extension.audits);
      supplemental[`${prefix}_capability`] = question("Does this newly declared capability express this action's immediate intended method and result, with its conditions met? A related object or broader goal alone does not authorize its effects.", { actionId: frame.id, capability: extension.capability as unknown as JsonValue },
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
  for (const [index, frame] of frames.entries()) if (answers[`a${index}_world_expansion`] && selected(answers, `a${index}_world_expansion`) === "introduce" &&
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
    if (!Number.isSafeInteger(duration) || duration < 1) throw new Error("World adjudication must resolve a positive action duration");
    const ongoing = Boolean(frame.temporalProfileId && state.truth.mechanics.temporalProfiles[frame.temporalProfileId]?.kind === "ongoing" &&
      frame.durationSource !== "explicit");
    frame.durationSeconds = duration;
    frame.dueAtSeconds = Math.max(state.truth.elapsedSeconds + 1, frame.startedAtSeconds + duration);
    let status: ActionOutcome["status"] = capabilityFailures.has(frame.id) ? "blocked"
      : expansionFailures.has(frame.id) ? frame.kind === "observe" && ["succeeded", "partial"].includes(verdict) ? "partial" : "blocked"
      : verdict === "unknown" ? worldExpansions.has(frame.id) && frame.kind === "observe" ? "succeeded" : "blocked" : verdict as ActionOutcome["status"];
    let operations: WorldDeltaOperation[] = [];
    const randomRequests: PreparedDirectAction["randomRequests"] = [], randomBindings: PreparedDirectAction["randomBindings"] = [];
    let detail = status === "blocked" ? "还需要更多信息。" : status === "failed" ? "这次尝试未能完成。" : status === "partial" ? "这次行动取得了部分进展。"
      : frame.kind === "wait" ? `这段等候已过去${frame.durationSeconds}秒。` : frame.kind === "observe" ? "你查看了眼前的情况。" : "行动已完成。";
    if (frame.kind === "transfer" && frame.quantityDefinitionId && frame.amount !== null) {
      const held = orderedValues(projected.truth.quantities).filter(quantity => quantity.holderId === frame.actorEntityId &&
        quantity.definitionId === frame.quantityDefinitionId).reduce((sum, quantity) => sum + quantity.amount, 0);
      if (held < frame.amount) {
        const resource = state.truth.mechanics.quantities[frame.quantityDefinitionId]!;
        status = "blocked";
        detail = `你当前持有${held}${resource.unit}${resource.name}，不足以交付所尝试的${frame.amount}${resource.unit}；没有发生转移。`;
      }
    }
    if (status === "succeeded" || status === "partial") {
      if (frame.kind === "move" && frame.targetEntityId) {
        const near = selected(answers, `${prefix}_movement`) === "near";
        const currentPlace = state.truth.placements[frame.actorEntityId];
        const containingPlaces = new Set<string>();
        for (let place = currentPlace; place && !containingPlaces.has(place); place = state.truth.placements[place]) containingPlaces.add(place);
        // Approaching an enclosing destination cannot move outside that destination.
        const placementId = near && !containingPlaces.has(frame.targetEntityId)
          ? state.truth.placements[frame.targetEntityId] ?? frame.targetEntityId : frame.targetEntityId;
        operations.push({ kind: "place_entity", entityId: frame.actorEntityId, placementId, ...source });
        if (near) {
          const existing = orderedValues(state.truth.facts).find(fact => fact.subjectId === frame.actorEntityId && fact.predicate === "proximity");
          const fact: WorldFact = { id: existing?.id ?? directSemanticId("fact", [frame.actorEntityId, "proximity"]), subjectId: frame.actorEntityId,
            predicate: "proximity", value: { kind: "entity", entityId: frame.targetEntityId }, access: existing?.access ?? { kind: "public" },
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
        // The admitted approach already supplies its exact new proximity.
        if (frame.kind === "move" && selected(answers, `${prefix}_movement`) === "near" &&
          effect.fact.subjectId === frame.actorEntityId && effect.fact.predicate === "proximity") continue;
        const value = selected(answers, id);
        const random = randomEffects.get(effect.fact.id);
        if (random) {
          const requestId = `${frame.id}/random/${random.distributionId}`;
          randomBindings.push({ factId: effect.fact.id, requestId, stepId: random.stepId });
          operations.push({ kind: "set_fact", fact: { ...effect.fact, provenance: source.causes }, ...source });
          continue;
        }
        if (value === "unchanged" || value === "new_value" || unboundRandomEffect) continue;
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
        detail = ongoing ? "你已开始持续进行这项活动。" : noConfirmedEffect ? "你作出了这次尝试，尚无可确认的状态变化。" : "这次操作已完成。";
        const representation = answers[`${prefix}_expression`] ? selected(answers, `${prefix}_expression`) : null;
        const completedWithoutChange = noConfirmedEffect && status === "succeeded" && representation === "no_change";
        if (completedWithoutChange) detail = "这次操作已完成，没有留下持续的变化。";
        else if (noConfirmedEffect && status === "succeeded" && representation === "already") detail = "当前已经处于所要求的状态，没有再次执行这个动作。";
        else if (noConfirmedEffect) status = "partial";
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
      ? [...(candidates.get(prefix) ?? []).filter((_, ordinal) => selected(answers, `${prefix}_delivery${ordinal}`) === "delivered"),
        ...(expansion?.deliveredToEntityIds ?? [])] : [];
    if (frame.kind === "speak" && !frame.utterance) { status = "blocked"; detail = "还没有形成实际话语。"; }
    else if (frame.kind === "speak" && ["succeeded", "partial"].includes(status)) {
      const reachedListener = frame.targetEntityId ? deliveredToEntityIds.includes(frame.targetEntityId) : deliveredToEntityIds.length > 0;
      detail = `你说：“${frame.utterance}”${reachedListener ? "话语已送达。" : frame.targetEntityId ? "没有确认对方听见。" : "没有确认有人听见。"}`;
    }
    if (!["succeeded", "partial"].includes(status)) operations = [];
    prepared.push({ actionId: frame.id, status, summary: detail, operations, reads: view.reads,
      actorOnlyFactIds: incidental.get(frame.id)!.facts, actorOnlyEntityIds: incidental.get(frame.id)!.entities,
      visibleFactIds: [...visibleFacts.filter(fact => state.truth.facts[fact.id] || ["succeeded", "partial"].includes(status)),
        ...(["succeeded", "partial"].includes(status) ? expansion?.facts ?? [] : []),
        ...operations.flatMap(operation => operation.kind === "set_fact" && operation.fact.predicate === "proximity" ? [operation.fact] : [])].map(fact => fact.id),
      visibleEntityIds: ["succeeded", "partial"].includes(status) ? [...visibleEntities, ...(expansion?.entities ?? [])].map(entity => entity.id) : [], deliveredToEntityIds,
      namedEntityIds: [...entityNames].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "named").map(([, entityId]) => entityId),
      actorVisibleToEntityIds: deliveredToEntityIds.filter(recipient => expansion?.actorVisibleToEntityIds.includes(recipient) || (candidates.get(prefix) ?? []).includes(recipient) && selected(answers,
        `${prefix}_actor_visibility${(candidates.get(prefix) ?? []).indexOf(recipient)}`) === "visible"),
      randomRequests: ["succeeded", "partial"].includes(status) ? randomRequests : [], randomBindings: ["succeeded", "partial"].includes(status) ? randomBindings : [],
      sharedClaims: [...claims].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "claim").map(([, claim]) => claim),
      ongoing,
      requestProgress: frame.requestContinuation ?? (frame.submissionId || frame.causeActionId ? selected(answers, `${prefix}_request_progress`) as PreparedDirectAction["requestProgress"] : "complete") });
  }
  return { prepared, reads: view.reads, audits };
}
