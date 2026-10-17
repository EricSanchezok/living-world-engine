import type { SimulationState, BeliefClaim } from "../contracts/model";
import type { DecisionQuestionV2, DecisionAnswerV2 } from "../models/decision-v2";
import { loadPromptAsset } from "../prompts";
import { contentHash } from "../models/model-audit";
import { runtimeId } from "../runtime/runtime-id";
import type { DirectCognitiveUpdate } from "./contracts";
import type { JsonValue } from "../runtime/json";
import { orderedValues } from "./state";

export function cognitiveQuestions(state: Readonly<SimulationState>, agentId: string, claims: readonly BeliefClaim[]): Record<string, DecisionQuestionV2> {
  const agent = state.agents[agentId]!, instructions = loadPromptAsset("user/direct-cognition.md");
  const questions: Record<string, DecisionQuestionV2> = {};
  orderedValues(agent.character.goals).filter(goal => goal.status === "active").forEach((goal, index) => {
    questions[`goal_status_${index}`] = { type: "choice", version: "goal-progress-1", instructions: { task: instructions, goal: goal as unknown as JsonValue },
      criteria: { completed: "Actual evidence establishes the entire goal", partial: "Evidence establishes only a component or milestone",
        unchanged: "No new progress", unknown: "Not enough evidence to judge completion" } };
  });
  claims.forEach((claim, index) => {
    questions[`belief_status_${index}`] = { type: "choice", version: "belief-update-1", instructions: { task: instructions, claim: claim as unknown as JsonValue },
      criteria: { supported: "New evidence supports this claim", refuted: "New evidence contradicts this claim",
        unresolved: "New evidence makes this uncertain", unchanged: "No relevant new evidence" } };
  });
  return questions;
}
export function cognitiveUpdate(state: Readonly<SimulationState>, agentId: string, claims: readonly BeliefClaim[], answers: Record<string, DecisionAnswerV2>): DirectCognitiveUpdate {
  const agent = state.agents[agentId]!;
  const verdict = (id: string) => { const answer = answers[id]; if (answer?.type !== "choice") throw new Error(`missing cognitive decision ${id}`); return answer.choice; };
  return { agentId, decisionHash: contentHash(answers),
    goals: Object.fromEntries(orderedValues(agent.character.goals).filter(goal => goal.status === "active").map((goal, index) =>
      [goal.id, verdict(`goal_status_${index}`) as DirectCognitiveUpdate["goals"][string]])),
    beliefs: Object.fromEntries(claims.map((claim, index) =>
      [claim.id, verdict(`belief_status_${index}`) as DirectCognitiveUpdate["beliefs"][string]])) };
}
/** Cognition may use earlier delivered evidence at the same instant; it need not invent a new world event. */
export function applyDirectCognition(state: SimulationState, updates: DirectCognitiveUpdate[], evaluatedAtStep: number) {
  for (const update of updates) {
    const agent = state.agents[update.agentId]; if (!agent) throw new Error("unknown cognitive owner");
    const stanceFor = (verdict: string) => verdict === "supported" ? "believed" : verdict === "refuted" ? "disbelieved" : "suspected";
    const goals = Object.entries(update.goals).filter(([goalId, verdict]) => verdict === "completed" && agent.character.goals[goalId]?.status !== "completed");
    const beliefs = Object.entries(update.beliefs).filter(([claimId, verdict]) => verdict !== "unchanged" && agent.belief.claims[claimId]?.stance !== stanceFor(verdict));
    if (!goals.length && !beliefs.length) continue;
    const id = runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "evidence", stage: "direct-cognition", owner: update.agentId, round: 0, ordinal: 0 });
    agent.belief.evidence[id] = { id, kind: "inference", description: `根据已接收的观察更新判断：${JSON.stringify({ goals: Object.fromEntries(goals), beliefs: Object.fromEntries(beliefs) })}`,
      sourceId: update.decisionHash, step: evaluatedAtStep };
    for (const [goalId, verdict] of goals) {
      const goal = agent.character.goals[goalId]; if (!goal) throw new Error("cognitive update references an unknown owned goal");
      if (verdict === "completed") { goal.status = "completed"; goal.progress = 1; goal.updatedAtStep = evaluatedAtStep; goal.evidenceIds = [...new Set([...goal.evidenceIds, id])]; }
    }
    for (const [claimId, verdict] of beliefs) {
      const claim = agent.belief.claims[claimId]; if (!claim) throw new Error("cognitive update references an unknown owned belief");
      if (verdict === "unchanged") continue;
      claim.stance = stanceFor(verdict);
      claim.evidenceIds = [...new Set([...claim.evidenceIds, id])];
    }
  }
}
