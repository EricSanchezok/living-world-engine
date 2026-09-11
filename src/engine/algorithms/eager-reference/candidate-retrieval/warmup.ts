import type { AgentActionProposal, SimulationState } from "../../../contracts/model";
import { actionCompilationContext } from "../action-compiler";
import { r5RelationalPassagesForContext } from "./relational-rrf";

export function actionCompilationPassagesForState(
  state: Readonly<SimulationState>,
): readonly string[] {
  const passages = new Set<string>();
  const collect = (actions: readonly AgentActionProposal[]): void => {
    // Ranking consumes the compiler's projected catalog, including compact
    // candidates and candidate-key references, rather than raw handle details.
    const context = actionCompilationContext(state, actions.map(action => ({ key: action.id, payload: { action }, issues: [] })),
      { workloadId: "retrieval-cache-warm", batchId: "retrieval-cache-warm" });
    r5RelationalPassagesForContext(context)
      .forEach(({ passage }) => passages.add(passage));
  };
  collect([]);
  for (const agent of Object.values(state.agents).sort((left, right) => left.id.localeCompare(right.id))) {
    collect([{
      id: `retrieval-cache-warm:${agent.id}`,
      actorId: agent.id,
      baseRevision: state.revision,
      rawText: "cache warmup",
      goal: "prepare action compilation candidate passages",
      means: null,
      targetIds: Object.keys(agent.belief.localEntities).sort(),
    }]);
  }
  return [...passages].sort();
}
