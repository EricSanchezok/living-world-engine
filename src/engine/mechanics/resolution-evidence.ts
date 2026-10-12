import type { AgentActionProposal, SimulationState } from "../contracts/model";
import type { ResolutionEvidenceIndex } from "./resolution";

export function resolutionEvidenceIndex(
  state: Readonly<SimulationState>,
  actions: readonly Pick<AgentActionProposal, "id">[],
  laws: readonly { id: string }[],
): ResolutionEvidenceIndex {
  return {
    actions: new Set(actions.map((action) => action.id)),
    entities: new Set(Object.keys(state.truth.entities)),
    facts: new Set(Object.keys(state.truth.facts)),
    conditions: new Set(Object.keys(state.truth.conditions)),
    conditionOwners: new Map(Object.values(state.truth.conditions)
      .map((condition) => [condition.id, condition.subjectId])),
    laws: new Set(laws.map((law) => law.id)),
    placements: new Set(Object.keys(state.truth.placements)),
    ratingOwners: new Map(Object.values(state.truth.ratings).map((rating) => [rating.id, rating.entityId])),
    ratingValues: new Map(Object.values(state.truth.ratings).map((rating) => [rating.id, rating.value])),
  };
}
