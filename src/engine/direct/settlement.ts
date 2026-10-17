import type { FactValue, SimulationState } from "../contracts/model";
import type { ActionFrame, DirectRuntimeState, DirectStepRecord } from "./contracts";
import type { ActionSettlement } from "./world";
import { sourceFor } from "./world";
import { applyWorldDeltaOperation } from "../runtime/transaction";
import { resolveDiscreteRandomRequests } from "../mechanics/random";
import { runtimeId } from "../runtime/runtime-id";
import { changedFact } from "./presentation";
import { contentHash } from "../models/model-audit";
import { refreshPeriodicFacts } from "../mechanics/periodic-properties";

/** Pure mechanical settlement of previously admitted semantics. No model calls or new choices. */
export function settlePreparedActions(state: Readonly<SimulationState>, control: DirectRuntimeState, frames: ActionFrame[], atSeconds = state.truth.elapsedSeconds) {
  let projected = structuredClone(state) as SimulationState, rng = structuredClone(state.truth.rng);
  projected.truth.elapsedSeconds = atSeconds;
  refreshPeriodicFacts(projected.truth);
  const settlements: ActionSettlement[] = [], randomRequests: DirectStepRecord["randomRequests"] = [], randomResults: DirectStepRecord["randomResults"] = [];
  for (const [index, frame] of frames.slice().sort((a, b) => a.id.localeCompare(b.id)).entries()) {
    const preparation = control.prepared[frame.id]!;
    const previousFacts = projected.truth.facts;
    let operations = structuredClone(preparation.operations), status = preparation.status, summary = preparation.summary;
    const source = sourceFor(frame);
    if (["succeeded", "partial"].includes(status)) {
      try {
        // Check all debits and references before committing random work.
        const preflight = structuredClone(projected);
        for (const operation of operations) applyWorldDeltaOperation(preflight, operation);
        const resolved = resolveDiscreteRandomRequests(rng, preparation.randomRequests);
        for (const binding of preparation.randomBindings) {
          const result = resolved.results.find(result => result.requestId === binding.requestId)?.steps.find(step => step.stepId === binding.stepId);
          if (!result || result.skipped || result.aggregate === null || Array.isArray(result.aggregate)) throw new Error("random effect has no scalar result");
          const value: FactValue = typeof result.aggregate === "boolean" ? { kind: "boolean", value: result.aggregate }
            : typeof result.aggregate === "number" ? { kind: "number", value: result.aggregate } : { kind: "text", value: result.aggregate };
          const operation = operations.find(operation => operation.kind === "set_fact" && operation.fact.id === binding.factId);
          if (!operation || operation.kind !== "set_fact") throw new Error("random effect has no owned fact operation");
          operation.fact = changedFact(operation.fact, value);
          operation.causes = [...operation.causes, { kind: "random", id: binding.requestId }];
        }
        const transaction = structuredClone(projected);
        for (const operation of operations) {
          if (operation.kind === "create_entity") operation.entity.createdAtStep = state.step + 1;
          applyWorldDeltaOperation(transaction, operation);
        }
        projected = transaction; rng = resolved.rng;
        randomRequests.push(...preparation.randomRequests); randomResults.push(...resolved.results);
      } catch {
        operations = []; status = "blocked"; summary = "可用资源或现场条件已经变化，这次效果没有提交。";
      }
    }
    const happened = ["succeeded", "partial"].includes(status);
    // Compare this action's committed result, including random outcomes, with its
    // own starting state; another action's effects cannot grant witness access.
    const changedFacts = new Set(operations.flatMap(operation => operation.kind === "set_fact" &&
      contentHash(previousFacts[operation.fact.id]?.value ?? null) !== contentHash(projected.truth.facts[operation.fact.id]?.value ?? null)
      ? [operation.fact.id] : []));
    // An unsuccessful effect can still reveal existing conditions. New failed effects do not exist in projected truth.
    const observedFacts = [...preparation.visibleFactIds.flatMap(id => projected.truth.facts[id] ? [projected.truth.facts[id]!] : []),
      ...preparation.propertyVisibility.flatMap(binding => {
        const fact = projected.truth.facts[binding.factId];
        if (!fact) return [];
        const committed = happened && operations.some(operation => operation.kind === "set_fact" && operation.fact.id === binding.factId &&
          contentHash(operation.fact.value) === binding.proposedValueHash);
        const visible = committed ? binding.proposedVisible : binding.previousVisible;
        const valueHash = committed ? binding.proposedValueHash : binding.previousValueHash;
        return visible && contentHash(fact.value) === valueHash ? [fact] : [];
      })];
    settlements.push({ frame, operations, visibleManner: happened ? preparation.visibleManner : null, outcome: { id: runtimeId({ worldHash: state.worldHash, revision: state.revision + 1,
      kind: "outcome", stage: "direct-world", owner: frame.actorId, round: 0, ordinal: index }), proposalId: frame.id, status,
      summary, causeRefs: source.causes, assertions: source.assertions, knownAlternatives: [] }, visibleFacts: observedFacts,
      inspectedQuantities: happened ? preparation.inspectedQuantityIds.flatMap(id => projected.truth.quantities[id] ? [projected.truth.quantities[id]!] : []) : [],
      actorOnlyFactIds: preparation.actorOnlyFactIds.filter(id => !changedFacts.has(id)), actorOnlyEntityIds: preparation.actorOnlyEntityIds,
      visibleEntities: happened ? preparation.visibleEntityIds.flatMap(id => projected.truth.entities[id] ? [projected.truth.entities[id]!] : []) : [],
      namedEntityIds: happened ? preparation.namedEntityIds : [],
      actorVisibleToEntityIds: happened ? preparation.actorVisibleToEntityIds ?? [] : [],
      deliveredToEntityIds: happened ? preparation.deliveredToEntityIds : [] });
  }
  return { settlements, rng, randomRequests, randomResults };
}
