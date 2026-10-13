import type { FactValue, SimulationState } from "../contracts/model";
import type { ActionFrame, DirectRuntimeState, DirectStepRecord } from "./contracts";
import type { ActionSettlement } from "./world";
import { sourceFor } from "./world";
import { applyWorldDeltaOperation } from "../runtime/transaction";
import { resolveDiscreteRandomRequests } from "../mechanics/random";
import { runtimeId } from "../runtime/runtime-id";
import { changedFact } from "./presentation";

/** Pure mechanical settlement of previously admitted semantics. No model calls or new choices. */
export function settlePreparedActions(state: Readonly<SimulationState>, control: DirectRuntimeState, frames: ActionFrame[]) {
  let projected = structuredClone(state) as SimulationState, rng = structuredClone(state.truth.rng);
  const settlements: ActionSettlement[] = [], randomRequests: DirectStepRecord["randomRequests"] = [], randomResults: DirectStepRecord["randomResults"] = [];
  for (const [index, frame] of frames.slice().sort((a, b) => a.id.localeCompare(b.id)).entries()) {
    const preparation = control.prepared[frame.id]!;
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
          operation.fact = changedFact(operation.fact, value); operation.causes.push({ kind: "random", id: binding.requestId });
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
    const observedFacts = happened ? preparation.visibleFactIds.flatMap(id => projected.truth.facts[id] ? [projected.truth.facts[id]!] : []) : [];
    settlements.push({ frame, operations, outcome: { id: runtimeId({ worldHash: state.worldHash, revision: state.revision + 1,
      kind: "outcome", stage: "direct-world", owner: frame.actorId, round: 0, ordinal: index }), proposalId: frame.id, status,
      summary, causeRefs: source.causes, assertions: source.assertions, knownAlternatives: [] }, visibleFacts: observedFacts,
      visibleEntities: happened ? preparation.visibleEntityIds.flatMap(id => projected.truth.entities[id] ? [projected.truth.entities[id]!] : []) : [],
      deliveredToEntityIds: happened ? preparation.deliveredToEntityIds : [] });
  }
  return { settlements, rng, randomRequests, randomResults };
}
