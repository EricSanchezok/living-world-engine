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
import { orderedValues } from "./state";
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
    const capability = decisions.control.capabilities.find(capability => capability.id === frame.capabilityId && capability.knownToAgentIds.includes(frame.actorId));
    questions[`${prefix}_outcome`] = question("feasibility of this single concrete kind and its parameters, NOT completion of proposal.goal or the whole compound proposal.rawText. Speaking succeeds when actual words can be uttered; accepting terms does not require goods already delivered. Observing attempts to inspect the selected object or immediate surroundings; separate visibility questions decide what is learned.", frame as unknown as JsonValue,
      { succeeded: "The action can achieve its specified immediate effect", partial: "Only part of that immediate effect is achieved",
        failed: "The concrete attempted action cannot occur", unknown: "Evidence required for this immediate action is absent; speech need not already be true or accepted" });
    if (["move", "use", "change"].includes(frame.kind)) questions[`${prefix}_duration`] = question("required total duration, respecting explicit rules and the actual activity", frame as unknown as JsonValue,
      { planned: `Use the proposed ${frame.durationSeconds} seconds`, ...Object.fromEntries(durations.map(seconds => [`s${seconds}`, `${seconds} seconds`])) });
    if (frame.submissionId) questions[`${prefix}_request_progress`] = question("coverage of the player's whole submitted intent by this immediate action", frame as unknown as JsonValue,
      { complete: "This attempt handles the submitted action; any long-term goal remains separate",
        continue: "Only a prerequisite is handled; another concrete step is already authorized by this input",
        wait: "The next step needs an actual reply, new evidence or a new player decision" });
    const focus = frame.kind === "observe" && frame.observationScope === "inventory" ? frame.actorEntityId
      : frame.kind === "observe" && (!frame.targetEntityId || frame.targetEntityId === frame.actorEntityId) ? state.truth.placements[frame.actorEntityId] : frame.targetEntityId;
    const targetFacts = orderedValues(state.truth.facts).filter(fact => fact.subjectId === (focus ?? frame.actorEntityId));
    if (["use", "change"].includes(frame.kind)) {
      if (!capability) questions[`${prefix}_expression`] = question("Can the existing properties and mechanical effects actually represent this action's intended immediate effect? A new ordinary combination can use existing properties, but an absent property or constructed object needs a small capability declaration; do not report a represented effect when none can be written.", {
        action: frame as unknown as JsonValue, existingProperties: targetFacts as unknown as JsonValue }, {
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
      if (capability) questions[`${prefix}_capability`] = question("does the declared capability actually apply here", capability as unknown as JsonValue,
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
        questions[id] = question("is this nearby entity perceptible without knowing its hidden identity", { action: frame as unknown as JsonValue, entity: entity as unknown as JsonValue },
          { visible: "Its presence is observable", hidden: "Its presence is concealed", unknown: "Insufficient perceptual evidence" });
      }
    }
    const recipients = ["speak", "transfer"].includes(frame.kind) && frame.targetEntityId ? [frame.targetEntityId]
      : ["use", "change", "move"].includes(frame.kind) ? orderedValues(state.agents).filter(agent => agent.id !== frame.actorId &&
        state.truth.placements[agent.entityId] === state.truth.placements[frame.actorEntityId]).map(agent => agent.entityId) : [];
    candidates.set(prefix, recipients);
    for (const [ordinal, recipient] of recipients.entries()) questions[`${prefix}_delivery${ordinal}`] = question("can the recipient perceive this speech, transfer or physical method and effect", { action: frame as unknown as JsonValue, recipient },
      { delivered: "The actual words or physical method and effect are perceived", unavailable: "No actual perception", unknown: "Perception is uncertain" });
  }
  let answers = await decisions.ask(null, view.state, view.reads, questions);
  const expansions = frames.flatMap((frame, index) => questions[`a${index}_expression`] && selected(answers, `a${index}_expression`) === "expand" ? [{ frame, index }] : []);
  if (expansions.length) {
    if (!creationEnabled) throw new Error("This action needs a new effect concept; the creation capability is disabled");
    const expanded = await Promise.allSettled(expansions.map(async ({ frame, index }) => ({ index, frame,
      result: await extendCapability({ state, control: decisions.control, frame, decisions,
        profileId: agentCapabilityModels(state, decisions.control, frame.actorId).creation,
        context: { action: frame.proposal.rawText, target: frame.targetEntityId ? state.truth.entities[frame.targetEntityId]!.description : null,
          tool: frame.toolEntityId ? state.truth.entities[frame.toolEntityId]!.description : null } }) })));
    const supplemental: Record<string, DecisionQuestionV2> = {};
    for (const result of expanded) if (result.status === "fulfilled") {
      const { index, frame, result: extension } = result.value, prefix = `a${index}`;
      audits.push(...extension.audits);
      supplemental[`${prefix}_capability`] = question("does this new declared capability actually apply to the already selected action", extension.capability as unknown as JsonValue,
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
      if (result.reason?.audits) audits.push(...result.reason.audits);
      else if (result.reason?.audit) audits.push(result.reason.audit);
    }
    const failed = expanded.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw Object.assign(failed.reason instanceof Error ? failed.reason : new Error(String(failed.reason)), { audits });
    try { answers = { ...answers, ...await decisions.ask(null, view.state, view.reads, supplemental) }; }
    catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      audits: [...audits, ...((error as { audits?: ModelExecutionAudit[] } | null)?.audits ?? [])] }); }
  }
  let projected = structuredClone(state) as SimulationState;
  const prepared: PreparedDirectAction[] = [];
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`, verdict = selected(answers, `${prefix}_outcome`), source = sourceFor(frame);
    const durationChoice = answers[`${prefix}_duration`] ? selected(answers, `${prefix}_duration`) : "planned";
    const duration = durationChoice === "planned" ? frame.durationSeconds : Number(durationChoice.slice(1));
    frame.durationSeconds = duration;
    frame.dueAtSeconds = Math.max(state.truth.elapsedSeconds + 1, frame.startedAtSeconds + duration);
    let status: ActionOutcome["status"] = verdict === "unknown" ? "blocked" : verdict as ActionOutcome["status"];
    let operations: WorldDeltaOperation[] = [];
    const randomRequests: PreparedDirectAction["randomRequests"] = [], randomBindings: PreparedDirectAction["randomBindings"] = [];
    let detail = status === "blocked" ? "还需要更多信息。" : status === "failed" ? "这次尝试未能完成。" : status === "partial" ? "这次行动取得了部分进展。"
      : frame.kind === "wait" ? "你在等待新的消息或条件变化。" : frame.kind === "observe" ? "你查看了眼前的情况。" : "行动已完成。";
    if (status === "succeeded" || status === "partial") {
      if (frame.kind === "move" && frame.targetEntityId) operations.push({ kind: "place_entity", entityId: frame.actorEntityId, placementId: frame.targetEntityId, ...source });
      if (frame.kind === "transfer") {
        if (frame.quantityDefinitionId && frame.targetEntityId && frame.amount !== null) operations.push({ kind: "transfer_quantity", definitionId: frame.quantityDefinitionId,
          fromHolderId: frame.actorEntityId, toHolderId: frame.targetEntityId, amount: frame.amount, ...source });
        else if (frame.toolEntityId && frame.targetEntityId) operations.push({ kind: "place_entity", entityId: frame.toolEntityId, placementId: frame.targetEntityId, ...source });
        else { status = "blocked"; detail = "还需要确认转移的对象、接收方或数量。"; }
      }
      const randomEffects = new Map<string, { distributionId: string; stepId: string }>();
      for (const [id, option] of randomOptions) if (id.startsWith(`${prefix}_`) && selected(answers, option.applies) === "apply") {
        const target = selected(answers, id);
        if (target !== "none") randomEffects.set(option.facts[Number(target.slice(1))]!.id, option);
      }
      for (const [id, effect] of effects) {
        if (!id.startsWith(`${prefix}_`)) continue;
        const value = selected(answers, id);
        const random = randomEffects.get(effect.fact.id);
        if (random) {
          const distribution = definition.randomDistributions.find(item => item.id === random.distributionId)!;
          const requestId = `${frame.id}/random/${distribution.id}`;
          if (!randomRequests.some(request => request.id === requestId)) randomRequests.push({ id: requestId, distributionId: distribution.id, distribution, causes: source.causes });
          randomBindings.push({ factId: effect.fact.id, requestId, stepId: random.stepId });
          operations.push({ kind: "set_fact", fact: { ...effect.fact, provenance: source.causes }, ...source });
          continue;
        }
        if (value === "unchanged") continue;
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
              else {
                operations.push({ kind: "set_fact", fact: capabilityFact(state, frame, capability, effect, ordinal)!, ...source });
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
      const transaction = structuredClone(projected);
      try { for (const operation of operations) applyWorldDeltaOperation(transaction, operation); projected = transaction; }
      catch (error) { operations = []; status = "blocked"; detail = error instanceof Error && error.message === "insufficient quantity" ? "可用资源不足，这次转移没有发生。" : "当前状态不允许完成这次行动。"; }
    }
    const visibleFacts = [...visibility].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "visible").map(([, fact]) => fact);
    const visibleEntities = [...entityVisibility].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "visible").map(([, entity]) => entity);
    const deliveredToEntityIds = ["succeeded", "partial"].includes(status)
      ? (candidates.get(prefix) ?? []).filter((_, ordinal) => selected(answers, `${prefix}_delivery${ordinal}`) === "delivered") : [];
    if (frame.kind === "speak" && (!frame.utterance || !deliveredToEntityIds.length)) { status = "blocked"; detail = "话语尚未送达。"; }
    else if (frame.kind === "speak") detail = `你说：“${frame.utterance}”话语已送达。`;
    if (!["succeeded", "partial"].includes(status)) operations = [];
    prepared.push({ actionId: frame.id, status, summary: detail, operations, reads: view.reads,
      visibleFactIds: ["succeeded", "partial"].includes(status) ? visibleFacts.map(fact => fact.id) : [],
      visibleEntityIds: ["succeeded", "partial"].includes(status) ? visibleEntities.map(entity => entity.id) : [], deliveredToEntityIds,
      namedEntityIds: [...entityNames].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "named").map(([, entityId]) => entityId),
      randomRequests: operations.length ? randomRequests : [], randomBindings: operations.length ? randomBindings : [],
      sharedClaims: [...claims].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "claim").map(([, claim]) => claim),
      ongoing: frame.temporalProfileId ? state.truth.mechanics.temporalProfiles[frame.temporalProfileId]?.kind === "ongoing" && !/\d+\s*(秒|分钟|小时|seconds?|minutes?|hours?)/iu.test(frame.proposal.rawText) : false,
      requestProgress: frame.submissionId ? selected(answers, `${prefix}_request_progress`) as PreparedDirectAction["requestProgress"] : "complete" });
  }
  return { prepared, reads: view.reads, audits };
}
