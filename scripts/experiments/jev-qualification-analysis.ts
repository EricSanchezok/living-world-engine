import { contentHash } from "../../src/engine/models/model-audit";
import { JEV_QUALIFICATION_PROTOCOL, type JevArm, type JevTrial } from "./jev-qualification-protocol";

export interface QualificationBudgetSnapshot {
  phases: Record<string, { httpRequests: number }>;
  estimatedPeakNanoCny: number;
  unsettled: string[];
}
interface BudgetReservation { kind: string; id?: string; priceId?: string }
export interface QualificationAction {
  index: number;
  beforeBudget: QualificationBudgetSnapshot;
  afterBudget: QualificationBudgetSnapshot;
  failure?: string;
  censored?: boolean;
  run?: { status: string; error?: string };
  feedback: { revision: number; elapsedMs: number; response?: { text: string }; observations: unknown[] }[];
}
export interface QualificationResult {
  arm: JevArm;
  trial: JevTrial;
  binding: { head: string };
  beforeBudget: QualificationBudgetSnapshot;
  afterBudget: QualificationBudgetSnapshot;
  initialization?: { beforeBudget: QualificationBudgetSnapshot; afterBudget: QualificationBudgetSnapshot; elapsedMs: number | null };
  actions: QualificationAction[];
  failure?: unknown;
  replay?: { equal: boolean; modelCalls: number | string };
  final?: { stateHash: string };
}
/** Semantic verdicts reference a complete immutable result and delivered feedback. */
export interface QualificationReview {
  trialId: string;
  arm: JevArm;
  resultHash: string;
  evidence: string[];
  completed: boolean;
  usefulFeedback: { inputIndex: number; revision: number }[];
  checks: { cognition: boolean; conservation: boolean; causality: boolean; replay: boolean; unsplitDecisions: boolean };
}
interface Usage { jev: number; deepseek: number; other: number; total: number; nanoCny: number; unsettled: boolean }
const censored = (action: QualificationAction) => action.censored || action.run?.status === "budget-paused";
const emptyUsage = (): Usage => ({ jev: 0, deepseek: 0, other: 0, total: 0, nanoCny: 0, unsettled: false });
const requestCount = (value: QualificationBudgetSnapshot) => Object.values(value.phases).reduce((sum, item) => sum + item.httpRequests, 0);

/** Global reservation ordinals disambiguate repeated trial labels in later cohorts. */
export function qualificationUsage(before: QualificationBudgetSnapshot, after: QualificationBudgetSnapshot, journal: BudgetReservation[]): Usage {
  const reservations = journal.filter(value => value.kind === "reserve"), start = requestCount(before), end = requestCount(after);
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end < start || end > reservations.length ||
    after.estimatedPeakNanoCny < before.estimatedPeakNanoCny) throw new Error("invalid qualification budget interval");
  const result = emptyUsage();
  for (const value of reservations.slice(start, end)) {
    result.total++;
    if (value.priceId === "jev") result.jev++;
    else if (value.priceId === "deepseek") result.deepseek++;
    else result.other++;
  }
  result.nanoCny = after.estimatedPeakNanoCny - before.estimatedPeakNanoCny;
  // Historical unknown reservations still count toward the shared spending cap,
  // but do not turn a fully settled later trial into an unknown-cost sample.
  const ids = new Set(reservations.slice(start, end).flatMap(value => value.id ? [value.id] : []));
  result.unsettled = after.unsettled.some(id => ids.has(id) || !before.unsettled.includes(id));
  return result;
}
function addUsage(target: Usage, source: Usage) {
  for (const key of ["jev", "deepseek", "other", "total", "nanoCny"] as const) target[key] += source[key];
  target.unsettled ||= source.unsettled;
}
function quantile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}
const key = (trial: string, arm: JevArm) => `${trial}:${arm}`;

export function analyzeJevQualification(trials: JevTrial[], results: QualificationResult[], reviews: QualificationReview[], journal: BudgetReservation[]) {
  const expected = new Set(trials.flatMap(trial => trial.order.map(arm => key(trial.id, arm))));
  if (expected.size !== trials.length * 3 || trials.some(trial => [...trial.order].sort().join() !== "A,B,C")) {
    throw new Error("qualification trials must have unique identities and all three arms");
  }
  const recorded = new Map<string, QualificationResult>(), reviewed = new Map<string, QualificationReview>();
  for (const result of results) {
    const identity = key(result.trial.id, result.arm);
    if (!expected.has(identity) || recorded.has(identity)) throw new Error("unexpected or duplicate qualification result");
    if (result.actions.some((action, index) => action.index !== index || index > 2)) throw new Error("qualification inputs are not the original ordered prefix");
    recorded.set(identity, result);
  }
  for (const review of reviews) {
    const identity = key(review.trialId, review.arm), result = recorded.get(identity);
    if (!result || reviewed.has(identity) || review.resultHash !== contentHash(result) || !review.evidence.length ||
      review.evidence.some(value => !value.trim())) throw new Error("semantic review is missing or differs from its evidence");
    if (review.completed && (!result.final?.stateHash || result.failure || result.actions.length !== 3 || result.actions.some(value => value.failure || censored(value) || value.run?.error || value.run?.status === "failed"))) {
      throw new Error("incomplete or censored trial cannot be reviewed as completed");
    }
    const checkKeys = ["cognition", "conservation", "causality", "replay", "unsplitDecisions"] as const;
    if (Object.keys(review.checks).length !== checkKeys.length || checkKeys.some(item => typeof review.checks[item] !== "boolean")) {
      throw new Error("semantic review requires every invariant verdict");
    }
    const indices = new Set<number>();
    for (const selected of review.usefulFeedback) {
      const action = result.actions.find(value => value.index === selected.inputIndex);
      const feedback = action?.feedback.find(value => value.revision === selected.revision);
      if (indices.has(selected.inputIndex) || !feedback?.response?.text.trim() || !feedback.observations.length ||
        !Number.isFinite(feedback.elapsedMs) || feedback.elapsedMs < 0) throw new Error("useful feedback lacks a delivered observation");
      indices.add(selected.inputIndex);
    }
    reviewed.set(identity, review);
  }
  const arms = Object.fromEntries((["A", "B", "C"] as const).map(arm => {
    const value = { planned: trials.length, recorded: 0, completed: 0, censored: 0, failed: 0, pendingReview: 0,
      executedInputs: 0, unexecutedInputs: trials.length * 3, cold: emptyUsage(), firstExpansion: emptyUsage(),
      continuation: emptyUsage(), runtime: emptyUsage(), usefulFeedbackMs: [] as number[], mechanicalChecks: true,
      completedCostNanoCny: 0, producerHeads: [] as string[] };
    for (const trial of trials) {
      const identity = key(trial.id, arm), result = recorded.get(identity), review = reviewed.get(identity);
      if (!result) continue;
      value.recorded++; value.executedInputs += result.actions.length; value.unexecutedInputs -= result.actions.length;
      value.pendingReview += review ? 0 : 1;
      value.failed += result.failure || result.actions.some(action => action.failure || action.run?.error || action.run?.status === "failed") ? 1 : 0;
      value.censored += result.actions.some(censored) ? 1 : 0;
      value.producerHeads.push(result.binding.head);
      const cold = result.initialization ?? (result.actions.length === 0 ? result : undefined);
      if (cold) addUsage(value.cold, qualificationUsage(cold.beforeBudget, cold.afterBudget, journal));
      let trialCost = cold ? cold.afterBudget.estimatedPeakNanoCny - cold.beforeBudget.estimatedPeakNanoCny : 0;
      for (const action of result.actions) {
        const usage = qualificationUsage(action.beforeBudget, action.afterBudget, journal);
        addUsage(value.runtime, usage); addUsage(action.index === 0 ? value.firstExpansion : value.continuation, usage);
        trialCost += usage.nanoCny;
        const selected = review?.usefulFeedback.find(item => item.inputIndex === action.index);
        if (selected) value.usefulFeedbackMs.push(action.feedback.find(item => item.revision === selected.revision)!.elapsedMs);
      }
      if (review?.completed) { value.completed++; value.completedCostNanoCny += trialCost; }
      value.mechanicalChecks &&= !!review && Object.values(review.checks).every(Boolean) && result.replay?.equal === true && result.replay.modelCalls === 0;
    }
    value.producerHeads = [...new Set(value.producerHeads)];
    return [arm, { ...value, completionRate: value.planned ? value.completed / value.planned : null,
      medianFeedbackMs: quantile(value.usefulFeedbackMs, 0.5), p95FeedbackMs: quantile(value.usefulFeedbackMs, 0.95) }];
  })) as Record<JevArm, { planned: number; recorded: number; completed: number; censored: number; failed: number; pendingReview: number;
    executedInputs: number; unexecutedInputs: number; cold: Usage; firstExpansion: Usage; continuation: Usage; runtime: Usage;
    usefulFeedbackMs: number[]; mechanicalChecks: boolean; completedCostNanoCny: number; producerHeads: string[];
    completionRate: number | null; medianFeedbackMs: number | null; p95FeedbackMs: number | null }>;
  const completeEvidence = Object.values(arms).every(value => value.recorded === value.planned && value.pendingReview === 0 &&
    value.unexecutedInputs === 0 && !value.runtime.unsettled && !value.cold.unsettled && value.runtime.other === 0 && value.producerHeads.length === 1);
  // A failed baseline cannot support a successful-task cost or speedup claim.
  const comparable = completeEvidence && arms.A.completed === arms.A.planned && arms.C.completed === arms.C.planned &&
    arms.A.censored === 0 && arms.C.censored === 0 && arms.A.usefulFeedbackMs.length === trials.length * 3 && arms.C.usefulFeedbackMs.length === trials.length * 3;
  const metrics = {
    jevRuntimeShare: arms.C.runtime.total ? arms.C.runtime.jev / arms.C.runtime.total : null,
    deepseekReduction: comparable && arms.A.runtime.deepseek ? 1 - arms.C.runtime.deepseek / arms.A.runtime.deepseek : null,
    successfulTaskCostReduction: comparable && arms.A.completedCostNanoCny ? 1 - arms.C.completedCostNanoCny / arms.A.completedCostNanoCny : null,
    medianFeedbackReduction: comparable && arms.A.medianFeedbackMs ? 1 - arms.C.medianFeedbackMs! / arms.A.medianFeedbackMs : null,
    p95Nonregression: comparable ? arms.C.p95FeedbackMs! <= arms.A.p95FeedbackMs! : null,
  };
  const targets = {
    jevShare: metrics.jevRuntimeShare === null ? null : metrics.jevRuntimeShare >= 0.8,
    deepseekReduction: metrics.deepseekReduction === null ? null : metrics.deepseekReduction >= 0.8,
    costReduction: metrics.successfulTaskCostReduction === null ? null : metrics.successfulTaskCostReduction >= 0.7,
    medianFeedbackReduction: metrics.medianFeedbackReduction === null ? null : metrics.medianFeedbackReduction >= 0.5,
    p95: metrics.p95Nonregression,
    completion: completeEvidence && arms.C.completionRate !== null && arms.A.completionRate !== null
      ? arms.C.completionRate >= 0.9 && arms.C.completionRate >= arms.A.completionRate : null,
    invariants: completeEvidence ? Object.values(arms).every(value => value.mechanicalChecks) : null,
  };
  const confirmation = JEV_QUALIFICATION_PROTOCOL.trials.filter(trial => trial.phase === "confirmation");
  return { arms, metrics, targets, completeEvidence, comparable,
    qualified: contentHash(trials) === contentHash(confirmation) && Object.values(targets).every(value => value === true) };
}
