import type { ActionOutcome, CausalSource, FactValue, SimulationState, WorldDeltaOperation, WorldFact } from "../contracts/model";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { loadPromptAsset } from "../prompts";
import { runtimeId } from "../runtime/runtime-id";
import { applyWorldDeltaOperation } from "../runtime/transaction";
import { contentHash } from "../models/model-audit";
import type { DecisionQuestionV2 } from "../models/decision-v2";
import type { JsonValue } from "../runtime/json";
import { deriveClampedMeterDelta, magnitudeBands } from "../mechanics/resolution";
import type { ActionFrame } from "./contracts";
import { DirectDecisions, selected } from "./decisions";
import { localWorldView } from "./views";

export interface ActionSettlement {
  frame: ActionFrame; outcome: ActionOutcome; operations: WorldDeltaOperation[]; visibleFacts: WorldFact[];
  deliveredToEntityIds: string[];
}
const ordinaryStates = ["open", "closed", "working", "stopped", "damaged", "repaired", "leaking", "sealed", "temporarily sealed", "tested", "untested", "available", "unavailable"];
function factOptions(fact: WorldFact, frames: ActionFrame[], state: Readonly<SimulationState>): FactValue[] {
  if (fact.value.kind === "boolean") return [{ kind: "boolean", value: true }, { kind: "boolean", value: false }];
  if (fact.value.kind === "text") {
    const values = Object.values(state.truth.facts).filter(value => value.predicate === fact.predicate && value.value.kind === "text")
      .map(value => (value.value as { kind: "text"; value: string }).value);
    const quotes = frames.flatMap(frame => [...frame.proposal.rawText.matchAll(/[“"「『]([^”"」』]+)[”"」』]/gu)].map(match => match[1]!));
    return [...new Set([...values, ...ordinaryStates, ...quotes])].map(value => ({ kind: "text", value }));
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
export async function settleActions(state: Readonly<SimulationState>, definition: WorldRuntimeContract, frames: ActionFrame[], decisions: DirectDecisions) {
  if (!frames.length) return { settlements: [] as ActionSettlement[], reads: {} as Record<string, string> };
  const view = localWorldView(state, definition, frames), questions: Record<string, DecisionQuestionV2> = {};
  const effects = new Map<string, { fact: WorldFact; values: FactValue[] }>();
  const visibility = new Map<string, WorldFact>();
  const candidates = new Map<string, string[]>();
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`;
    questions[`${prefix}_outcome`] = question("feasibility and outcome", frame as unknown as JsonValue,
      { succeeded: "The action can achieve its specified immediate effect", partial: "Only part of that immediate effect is achieved",
        failed: "The attempt fails or the other party explicitly refuses", unknown: "Insufficient evidence; do not assume consent or success" });
    const targetFacts = Object.values(state.truth.facts).filter(fact => fact.subjectId === (frame.targetEntityId ?? frame.actorEntityId));
    if (["use", "change"].includes(frame.kind)) {
      for (const [ordinal, fact] of targetFacts.entries()) {
        const id = `${prefix}_fact${ordinal}`, values = factOptions(fact, frames, state);
        effects.set(id, { fact, values });
        questions[id] = question("resulting value of this existing fact if the action succeeds", { action: frame as unknown as JsonValue, fact: fact as unknown as JsonValue },
          { unchanged: "This property is unaffected or evidence is insufficient", ...Object.fromEntries(values.map((value, i) => [`v${i}`, value as unknown as Record<string, JsonValue>])) });
      }
      const impacts = Object.values(state.truth.mechanics.impactProfiles);
      if (impacts.length) {
        questions[`${prefix}_impact`] = question("authored numeric impact", frame as unknown as JsonValue,
          { none: "No numeric meter impact", ...Object.fromEntries(impacts.map(profile => [profile.id, profile as unknown as Record<string, JsonValue>])) });
        questions[`${prefix}_magnitude`] = question("effect magnitude on the authored scale", frame as unknown as JsonValue,
          Object.fromEntries(magnitudeBands.map(band => [band, band])));
      }
    }
    if (frame.kind === "observe") for (const [ordinal, fact] of targetFacts.entries()) {
      const id = `${prefix}_visible${ordinal}`; visibility.set(id, fact);
      questions[id] = question("is this fact actually observable through this action", { action: frame as unknown as JsonValue, fact: fact as unknown as JsonValue },
        { visible: "The attempt reveals this fact through an available perceptual channel", hidden: "The fact remains hidden", unknown: "No justified perceptual access" });
    }
    const recipients = frame.kind === "speak" && frame.targetEntityId ? [frame.targetEntityId] : [];
    candidates.set(prefix, recipients);
    for (const [ordinal, recipient] of recipients.entries()) questions[`${prefix}_delivery${ordinal}`] = question("can the literal utterance reach this recipient", { action: frame as unknown as JsonValue, recipient },
      { delivered: "The actual words reach this listener", unavailable: "No actual delivery", unknown: "Delivery is uncertain" });
  }
  const answers = await decisions.ask(null, view.state, view.reads, questions);
  let projected = structuredClone(state) as SimulationState;
  const settlements: ActionSettlement[] = [];
  for (const [index, frame] of frames.entries()) {
    const prefix = `a${index}`, verdict = selected(answers, `${prefix}_outcome`), source = sourceFor(frame);
    let status: ActionOutcome["status"] = verdict === "unknown" ? "blocked" : verdict as ActionOutcome["status"];
    let operations: WorldDeltaOperation[] = [];
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
        const chosen = effect.values[Number(value.slice(1))]!;
        if (contentHash(chosen) === contentHash(effect.fact.value)) continue;
        operations.push({ kind: "set_fact", fact: { ...effect.fact, value: chosen, provenance: source.causes }, ...source });
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
    const deliveredToEntityIds = ["succeeded", "partial"].includes(status)
      ? (candidates.get(prefix) ?? []).filter((_, ordinal) => selected(answers, `${prefix}_delivery${ordinal}`) === "delivered") : [];
    if (frame.kind === "speak" && (!frame.utterance || !deliveredToEntityIds.length)) { status = "blocked"; detail = "话语尚未送达。"; }
    const outcome: ActionOutcome = { id: runtimeId({ worldHash: state.worldHash, revision: state.revision + 1, kind: "outcome", stage: "direct-world", owner: frame.actorId, round: 0, ordinal: index }),
      proposalId: frame.id, status, summary: detail, causeRefs: source.causes, assertions: source.assertions, knownAlternatives: [] };
    settlements.push({ frame, outcome, operations, visibleFacts: ["succeeded", "partial"].includes(status) ? visibleFacts : [], deliveredToEntityIds });
  }
  return { settlements, reads: view.reads };
}
