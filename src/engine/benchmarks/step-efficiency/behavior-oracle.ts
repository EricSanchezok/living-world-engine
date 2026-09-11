import type { ActionOutcome, AgentActionProposal, CausalAssertion, SimulationState } from "../../contracts/model";
import { evaluateCausalAssertion } from "../../mechanics/causality";
import { contentHash } from "../../models/model-audit";

export interface FrozenBehaviorOracle {
  id: string;
  worldHash: string;
  sourceStateHash: string;
  sourceActionHash: string;
  // Authored scenario facts, never generated plan/outcome assertions.
  preconditions: CausalAssertion[];
  branches: Partial<Record<ActionOutcome["status"], {
    assertions: CausalAssertion[];
    requireLiveSourceActivity?: boolean;
  }>>;
  earliestSuccessAtSeconds?: number;
  mustSucceedBySeconds?: number;
}

/** Independent scenario labels evaluated against actual state. Caller supplies
 * the committed outcome (or validated transition candidate), not model prose. */
export function evaluateBehaviorOracle(input: {
  source: Readonly<SimulationState>;
  action: Readonly<AgentActionProposal>;
  checkpoint: Readonly<SimulationState>;
  outcome: Readonly<ActionOutcome> | null;
  oracle: Readonly<FrozenBehaviorOracle>;
}) {
  const { source, action, checkpoint, outcome, oracle } = input;
  if (source.worldHash !== oracle.worldHash || checkpoint.worldHash !== oracle.worldHash ||
    contentHash(source) !== oracle.sourceStateHash || contentHash(action) !== oracle.sourceActionHash ||
    action.baseRevision !== source.revision || checkpoint.revision <= source.revision || checkpoint.step <= source.step ||
    checkpoint.truth.elapsedSeconds <= source.truth.elapsedSeconds ||
    (outcome && outcome.proposalId !== action.id)) throw new Error("behavior oracle source/checkpoint binding mismatch");
  if (!oracle.preconditions.length || oracle.preconditions.some((assertion) => !evaluateCausalAssertion(source, assertion).passed)) {
    throw new Error("behavior oracle has unverified source preconditions");
  }
  const issues: string[] = [];
  const evidence: Array<{ assertion: CausalAssertion; passed: boolean; observed: unknown }> = [];
  const live = Object.values(checkpoint.truth.activities).filter((activity) => activity.sourceActionId === action.id &&
    ["active", "paused", "queued", "ready"].includes(activity.status));
  if (live.some((activity) => contentHash(activity.sourceAction) !== oracle.sourceActionHash)) {
    throw new Error("live activity changed original action");
  }
  if (oracle.mustSucceedBySeconds !== undefined && checkpoint.truth.elapsedSeconds >= oracle.mustSucceedBySeconds && outcome?.status !== "succeeded") {
    issues.push("source-bound completion deadline was not met");
  }
  if (!outcome) {
    // A not-due activity may legitimately have no outcome at this boundary.
    // Absence of an outcome never becomes a semantic success.
    return { id: oracle.id, verdict: issues.length ? "failed" as const : "unknown" as const,
      issues: [...issues, live.length ? "source activity has no outcome at this checkpoint" : "missing source outcome and live activity"], evidence };
  }
  const branch = oracle.branches[outcome.status];
  if (!branch) issues.push(`outcome ${outcome.status} is not admitted by the frozen scenario`);
  if (outcome.status === "succeeded" && oracle.earliestSuccessAtSeconds !== undefined &&
    checkpoint.truth.elapsedSeconds < oracle.earliestSuccessAtSeconds) issues.push("completion precedes the independent earliest boundary");
  if (branch) {
    if (!branch.assertions.length && !branch.requireLiveSourceActivity) throw new Error("behavior branch has no independent evidence");
    if (branch.requireLiveSourceActivity && !live.length) issues.push("continuation has no live source-bound activity");
    for (const assertion of branch.assertions) {
      const result = evaluateCausalAssertion(checkpoint, assertion);
      evidence.push({ assertion, ...result });
      if (!result.passed) issues.push(`independent postcondition failed: ${assertion.kind}`);
    }
  }
  return { id: oracle.id, verdict: issues.length ? "failed" as const : "passed" as const, issues, evidence };
}

/** Whole-game acceptance selects the outcome from this exact committed step.
 * A detached outcome from another attempt cannot be supplied by the caller. */
export function evaluateCommittedBehaviorOracle(input: Omit<Parameters<typeof evaluateBehaviorOracle>[0], "outcome">) {
  const step = input.checkpoint.history.find((entry) => entry.step === input.checkpoint.step && entry.revision === input.checkpoint.revision);
  if (!step) throw new Error("behavior checkpoint lacks its committed step");
  const actions = step.actions.filter((action) => action.id === input.action.id);
  if (actions.length > 1 || actions.some((action) => contentHash(action) !== input.oracle.sourceActionHash)) throw new Error("committed behavior action mismatch");
  const outcomes = step.outcomes.filter((outcome) => outcome.proposalId === input.action.id);
  if (outcomes.length > 1 || (outcomes.length && !actions.length)) throw new Error("committed behavior outcome coverage mismatch");
  return evaluateBehaviorOracle({ ...input, outcome: outcomes[0] ?? null });
}
