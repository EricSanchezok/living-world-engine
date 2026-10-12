import type { BeliefPatch, CharacterPatch, SimulationState } from "../contracts/model";
import { runtimeId } from "../runtime/runtime-id";
import { restoreOwnerPrograms, type DecisionEventState } from "./runtime-state";

/** Apply only separately proved long-term goal judgments. Program termination is never evidence. */
export function applyProgramGoalEvidence(state: SimulationState, control: DecisionEventState, baseRevision: number) {
  const beliefPatches: BeliefPatch[] = [], characterPatches: CharacterPatch[] = [];
  for (const agent of Object.values(state.agents)) {
    const belief: BeliefPatch = { agentId: agent.id, baseRevision, operations: [] };
    const character: CharacterPatch = { agentId: agent.id, baseRevision, operations: [] };
    for (const program of restoreOwnerPrograms(control, agent.id)) {
      for (const [goalId, evidenceHash] of Object.entries(program.completion.goals)) {
        const goal = agent.character.goals[goalId];
        if (!goal || goal.status !== "active") continue;
        const judgment = program.snapshot().events.find(event => event.kind === "predicate" && event.reason === "goal" &&
          event.subjectId === goalId && event.verdict === "yes" && event.evidenceHash === evidenceHash);
        if (!judgment || judgment.kind !== "predicate" || judgment.questionVersion === null) throw new Error("goal completion has no semantic evidence");
        const id = runtimeId({ worldHash: state.worldHash, revision: baseRevision, kind: "evidence", stage: "program-goal",
          owner: `${agent.id}:${goalId}:${evidenceHash}`, round: 0, ordinal: 0 });
        const evidence = { id, kind: "inference" as const, description: `The Agent judged its goal complete from its authorized evidence: ${goal.description}`,
          sourceId: evidenceHash, step: state.step };
        agent.belief.evidence[id] = evidence;
        belief.operations.push({ kind: "upsert_evidence", evidence });
        if (goal.progress !== 1) character.operations.push({ kind: "update_goal", id: goalId, description: null,
          priority: null, progress: 1, targetIds: null, parentGoal: { kind: "unchanged" }, motivatedByIds: null,
          sourceObservationIds: [], evidenceIds: [id] });
        character.operations.push({ kind: "set_goal_status", id: goalId, status: "completed", sourceObservationIds: [], evidenceIds: [id] });
        goal.status = "completed"; goal.progress = 1; goal.updatedAtStep = state.step; goal.evidenceIds = [id];
      }
    }
    if (belief.operations.length) beliefPatches.push(belief);
    if (character.operations.length) characterPatches.push(character);
  }
  return { beliefPatches, characterPatches };
}
