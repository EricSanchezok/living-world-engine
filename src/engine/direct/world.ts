import type { ActionOutcome, CausalSource, FactValue, SimulationState, WorldDeltaOperation, WorldFact, WorldEntity } from "../contracts/model";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { loadPromptAsset } from "../prompts";
import { applyWorldDeltaOperation } from "../runtime/transaction";
import { contentHash } from "../models/model-audit";
import type { DecisionQuestionV2 } from "../models/decision-v2";
import type { JsonValue } from "../runtime/json";
import { deriveClampedMeterDelta, magnitudeBands, materializeCondition } from "../mechanics/resolution";
import type { ActionFrame, PreparedDirectAction } from "./contracts";
import { DirectDecisions, selected } from "./decisions";
import { localWorldView } from "./views";
import { orderedValues } from "./state";
import { literalNumbers } from "./actions";

export interface ActionSettlement {
  frame: ActionFrame; outcome: ActionOutcome; operations: WorldDeltaOperation[]; visibleFacts: WorldFact[];
  visibleEntities: WorldEntity[];
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
export async function prepareActions(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frames: ActionFrame[], decisions: DirectDecisions) {
  if (!frames.length) return { prepared: [] as PreparedDirectAction[], reads: {} as Record<string, string> };
  const view = localWorldView(state, definition, frames), questions: Record<string, DecisionQuestionV2> = {};
  const effects = new Map<string, { fact: WorldFact; values: FactValue[] }>();
  const visibility = new Map<string, WorldFact>();
  const entityVisibility = new Map<string, WorldEntity>();
  const candidates = new Map<string, string[]>();
  const randomOptions = new Map<string, { distributionId: string; stepId: string }>();
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
    questions[`${prefix}_outcome`] = question("feasibility and outcome", frame as unknown as JsonValue,
      { succeeded: "The action can achieve its specified immediate effect", partial: "Only part of that immediate effect is achieved",
        failed: "The attempt fails or the other party explicitly refuses", unknown: "Insufficient evidence; do not assume consent or success" });
    questions[`${prefix}_duration`] = question("required total duration, respecting explicit rules and the actual activity", frame as unknown as JsonValue,
      { planned: `Use the proposed ${frame.durationSeconds} seconds`, ...Object.fromEntries(durations.map(seconds => [`s${seconds}`, `${seconds} seconds`])) });
    if (frame.submissionId) questions[`${prefix}_request_progress`] = question("coverage of the player's whole submitted intent by this immediate action", frame as unknown as JsonValue,
      { complete: "This attempt handles the submitted action; any long-term goal remains separate",
        continue: "Only a prerequisite is handled; another concrete step is already authorized by this input",
        wait: "The next step needs an actual reply, new evidence or a new player decision" });
    const focus = frame.kind === "observe" && (!frame.targetEntityId || frame.targetEntityId === frame.actorEntityId) ? state.truth.placements[frame.actorEntityId] : frame.targetEntityId;
    const targetFacts = orderedValues(state.truth.facts).filter(fact => fact.subjectId === (focus ?? frame.actorEntityId));
    if (["use", "change"].includes(frame.kind)) {
      for (const [ordinal, fact] of targetFacts.entries()) {
        const id = `${prefix}_fact${ordinal}`, values = factOptions(fact, frames, state);
        effects.set(id, { fact, values });
        const randomCriteria: Record<string, Record<string, JsonValue>> = {};
        for (const distribution of definition.randomDistributions) for (const step of distribution.steps) {
          if (!step.outcomes.every(value => typeof value === (fact.value.kind === "boolean" ? "boolean" : fact.value.kind === "number" ? "number" : "string"))) continue;
          const option = `random_${randomOptions.size}`;
          randomOptions.set(`${id}:${option}`, { distributionId: distribution.id, stepId: step.id });
          randomCriteria[option] = { committedRandomResult: distribution.id, step: step.id, meaning: distribution.description };
        }
        questions[id] = question("resulting value of this existing fact if the action succeeds", { action: frame as unknown as JsonValue, fact: fact as unknown as JsonValue },
          { unchanged: "This property is unaffected or evidence is insufficient", ...Object.fromEntries(values.map((value, i) => [`v${i}`, value as unknown as Record<string, JsonValue>])), ...randomCriteria });
      }
      for (const resource of orderedValues(state.truth.mechanics.quantities)) for (const kind of ["consume_quantity", "produce_quantity"] as const) {
        const laws = kind === "consume_quantity" ? resource.consumptionLawIds : resource.productionLawIds;
        for (const lawId of laws) {
          const id = `${prefix}_resource${resources.size}`; resources.set(id, { definitionId: resource.id, lawId, kind });
          questions[id] = question("actual resource change required by this law; no consumption for merely talking or observing", {
            action: frame as unknown as JsonValue, resource: resource.name, kind, lawId },
            { none: "No actual resource change under this law", ...Object.fromEntries(amounts.map(amount => [`n${amount}`, `${amount} ${resource.unit}`])) });
        }
      }
      const conditions = orderedValues(state.truth.mechanics.conditionProfiles);
      if (conditions.length) questions[`${prefix}_condition`] = question("condition caused on the target", frame as unknown as JsonValue,
        { none: "No condition is created", ...Object.fromEntries(conditions.map(profile => [profile.id, profile.name])) });
      const capability = decisions.control.capabilities.find(capability => capability.id === frame.capabilityId && capability.knownToAgentIds.includes(frame.actorId));
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
    if (["observe", "use", "change"].includes(frame.kind)) for (const [ordinal, fact] of targetFacts.entries()) {
      const id = `${prefix}_visible${ordinal}`; visibility.set(id, fact);
      questions[id] = question("is this fact actually observable through this action", { action: frame as unknown as JsonValue, fact: fact as unknown as JsonValue },
        { visible: "The attempt reveals the resulting fact through an available perceptual channel", hidden: "The fact remains hidden", unknown: "No justified perceptual access" });
    }
    if (frame.kind === "observe") {
      const focus = frame.targetEntityId && frame.targetEntityId !== frame.actorEntityId ? frame.targetEntityId : state.truth.placements[frame.actorEntityId];
      for (const [ordinal, entity] of orderedValues(state.truth.entities).filter(entity => entity.lifecycle === "active" && entity.id !== frame.actorEntityId && state.truth.placements[entity.id] === focus).entries()) {
        const id = `${prefix}_entity${ordinal}`; entityVisibility.set(id, entity);
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
  const answers = await decisions.ask(null, view.state, view.reads, questions);
  let projected = structuredClone(state) as SimulationState;
  const prepared: PreparedDirectAction[] = [];
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`, verdict = selected(answers, `${prefix}_outcome`), source = sourceFor(frame);
    const durationChoice = selected(answers, `${prefix}_duration`);
    const duration = durationChoice === "planned" ? frame.durationSeconds : Number(durationChoice.slice(1));
    frame.durationSeconds = duration;
    frame.dueAtSeconds = Math.max(state.truth.elapsedSeconds + 1, frame.startedAtSeconds + duration);
    let status: ActionOutcome["status"] = verdict === "unknown" ? "blocked" : verdict as ActionOutcome["status"];
    let operations: WorldDeltaOperation[] = [];
    const randomRequests: PreparedDirectAction["randomRequests"] = [], randomBindings: PreparedDirectAction["randomBindings"] = [];
    let detail = status === "blocked" ? "还需要更多信息。" : status === "failed" ? "这次尝试未能完成。" : status === "partial" ? "这次行动取得了部分进展。" : "行动已完成。";
    if (status === "succeeded" || status === "partial") {
      if (frame.kind === "move" && frame.targetEntityId) operations.push({ kind: "place_entity", entityId: frame.actorEntityId, placementId: frame.targetEntityId, ...source });
      if (frame.kind === "transfer") {
        if (frame.quantityDefinitionId && frame.targetEntityId && frame.amount !== null) operations.push({ kind: "transfer_quantity", definitionId: frame.quantityDefinitionId,
          fromHolderId: frame.actorEntityId, toHolderId: frame.targetEntityId, amount: frame.amount, ...source });
        else if (frame.toolEntityId && frame.targetEntityId) operations.push({ kind: "place_entity", entityId: frame.toolEntityId, placementId: frame.targetEntityId, ...source });
        else { status = "blocked"; detail = "还需要确认转移的对象、接收方或数量。"; }
      }
      for (const [id, effect] of effects) {
        if (!id.startsWith(`${prefix}_`)) continue;
        const value = selected(answers, id); if (value === "unchanged") continue;
        const random = randomOptions.get(`${id}:${value}`);
        if (random) {
          const distribution = definition.randomDistributions.find(item => item.id === random.distributionId)!;
          const requestId = `${frame.id}/random/${distribution.id}`;
          if (!randomRequests.some(request => request.id === requestId)) randomRequests.push({ id: requestId, distributionId: distribution.id, distribution, causes: source.causes });
          randomBindings.push({ factId: effect.fact.id, requestId, stepId: random.stepId });
          operations.push({ kind: "set_fact", fact: { ...effect.fact, provenance: source.causes }, ...source });
          continue;
        }
        const chosen = effect.values[Number(value.slice(1))]!;
        if (contentHash(chosen) === contentHash(effect.fact.value)) continue;
        operations.push({ kind: "set_fact", fact: { ...effect.fact, value: chosen, provenance: source.causes }, ...source });
      }
      for (const [id, resource] of resources) if (id.startsWith(`${prefix}_`)) {
        const amount = selected(answers, id); if (amount === "none") continue;
        operations.push({ ...resource, kind: resource.kind, holderId: frame.actorEntityId, amount: Number(amount.slice(1)),
          causes: [...source.causes, { kind: "law", id: resource.lawId }], assertions: source.assertions });
      }
      const addCondition = (profileId: string, subjectId: string) => {
        const profile = state.truth.mechanics.conditionProfiles[profileId]!;
        const duration = state.truth.mechanics.durationProfiles[profile.defaultDurationProfileId]!;
        const id = `${frame.id}/condition/${profileId}/${subjectId}`;
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
              const id = `${frame.id}/object/${ordinal}`;
              operations.push({ kind: "create_entity", entity: { id, kind: "object", name: effect.name, description: effect.description, lifecycle: "active", createdAtStep: state.step + 1 },
                placementId: effect.placement === "actor" ? frame.actorEntityId : frame.targetEntityId, ...source });
            } else {
              const subjectId = effect.subject === "actor" ? frame.actorEntityId : effect.subject === "target" ? frame.targetEntityId : frame.toolEntityId;
              if (!subjectId) { status = "blocked"; detail = "能力缺少实际作用对象。"; break; }
              if (effect.kind === "condition") addCondition(effect.profileId, subjectId);
              else {
                const existing = orderedValues(state.truth.facts).find(fact => fact.subjectId === subjectId && fact.predicate === effect.predicate);
                const id = existing?.id ?? `${capability.id}/${subjectId}/${ordinal}`;
                operations.push({ kind: "set_fact", fact: { id, subjectId, predicate: effect.predicate,
                  value: typeof effect.value === "boolean" ? { kind: "boolean", value: effect.value } : { kind: "text", value: effect.value },
                  description: effect.description, access: existing?.access ?? { kind: "public" }, provenance: source.causes }, ...source });
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
    if (!["succeeded", "partial"].includes(status)) operations = [];
    prepared.push({ actionId: frame.id, status, summary: detail, operations, reads: view.reads,
      visibleFactIds: ["succeeded", "partial"].includes(status) ? visibleFacts.map(fact => fact.id) : [],
      visibleEntityIds: ["succeeded", "partial"].includes(status) ? visibleEntities.map(entity => entity.id) : [], deliveredToEntityIds,
      randomRequests: operations.length ? randomRequests : [], randomBindings: operations.length ? randomBindings : [],
      sharedClaims: [...claims].filter(([id]) => id.startsWith(`${prefix}_`) && selected(answers, id) === "claim").map(([, claim]) => claim),
      ongoing: frame.temporalProfileId ? state.truth.mechanics.temporalProfiles[frame.temporalProfileId]?.kind === "ongoing" && !/\d+\s*(秒|分钟|小时|seconds?|minutes?|hours?)/iu.test(frame.proposal.rawText) : false,
      requestProgress: frame.submissionId ? selected(answers, `${prefix}_request_progress`) as PreparedDirectAction["requestProgress"] : "complete" });
  }
  return { prepared, reads: view.reads };
}
