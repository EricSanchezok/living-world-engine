import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { analyzeJevQualification, qualificationUsage, type QualificationResult, type QualificationReview } from "./jev-qualification-analysis";
import type { JevTrial } from "./jev-qualification-protocol";

const snapshot = (count: number, cost = count) => ({ phases: { trajectory: { httpRequests: count } }, estimatedPeakNanoCny: cost, unsettled: [] });
const trial: JevTrial = { id: "confirmation-1-1", category: 0, seed: 1, order: ["A", "B", "C"], phase: "confirmation" };
const journal = [{ kind: "reserve", priceId: "deepseek" }, { kind: "reserve", priceId: "jev" }, { kind: "reserve", priceId: "jev" }, { kind: "reserve", priceId: "jev" }];
function result(): QualificationResult {
  return { arm: "C", trial, binding: { head: "frozen" }, beforeBudget: snapshot(0), afterBudget: snapshot(4),
    initialization: { beforeBudget: snapshot(0), afterBudget: snapshot(1), elapsedMs: null },
    actions: [0, 1, 2].map(index => ({ index, beforeBudget: snapshot(index + 1), afterBudget: snapshot(index + 2),
      run: { status: "waiting-for-event" }, feedback: [{ revision: index + 2, elapsedMs: 10, response: { text: "Observed" }, observations: [{}] }] })),
    replay: { equal: true, modelCalls: 0 }, final: { stateHash: "state" } };
}
function review(value: QualificationResult): QualificationReview {
  return { arm: value.arm, trialId: trial.id, resultHash: contentHash(value), evidence: ["final.json#/state/truth"], completed: false,
    usefulFeedback: [{ inputIndex: 0, revision: 2 }], checks: { cognition: true, conservation: true, causality: true, replay: true, unsplitDecisions: true } };
}
describe("frozen Jev qualification accounting", () => {
  it("counts reservation ordinals instead of repeated labels, including repairs", () => {
    expect(qualificationUsage(snapshot(1), snapshot(4), journal)).toEqual({ total: 3, jev: 3, deepseek: 0, other: 0, nanoCny: 3, unsettled: false });
    expect(() => qualificationUsage(snapshot(0), snapshot(5), journal)).toThrow("interval");
  });
  it("keeps missing trials and pending semantic review unqualified", () => {
    const report = analyzeJevQualification([trial], [result()], [], journal);
    expect(report.arms.A.unexecutedInputs).toBe(3);
    expect(report.arms.C.pendingReview).toBe(1);
    expect(report.arms.C.completed).toBe(0);
    expect(report.arms.C.cold.deepseek).toBe(1);
    expect(report.metrics.jevRuntimeShare).toBe(1);
    expect(report.metrics.medianFeedbackReduction).toBeNull();
    expect(report.qualified).toBe(false);
  });
  it("separates a new trial's unknown usage from fully reserved historical uncertainty", () => {
    const before = { ...snapshot(1), unsettled: ["old"] }, after = { ...snapshot(2), unsettled: ["old"] };
    const reservations = [{ kind: "reserve", id: "old", priceId: "jev" }, { kind: "reserve", id: "new", priceId: "jev" }];
    expect(qualificationUsage(before, after, reservations).unsettled).toBe(false);
    expect(qualificationUsage(before, { ...after, unsettled: ["old", "new"] }, reservations).unsettled).toBe(true);
  });
  it("binds useful feedback to actual delivered evidence and immutable result", () => {
    const value = result(), verdict = review(value);
    expect(analyzeJevQualification([trial], [value], [verdict], journal).arms.C.medianFeedbackMs).toBe(10);
    expect(() => analyzeJevQualification([trial], [value], [{ ...verdict, resultHash: "changed" }], journal)).toThrow("evidence");
    expect(() => analyzeJevQualification([trial], [value], [{ ...verdict, usefulFeedback: [{ inputIndex: 1, revision: 2 }] }], journal)).toThrow("observation");
  });
  it("does not accept censored samples as successful tasks", () => {
    const value = result(); value.actions[0]!.censored = true;
    expect(() => analyzeJevQualification([trial], [value], [{ ...review(value), completed: true }], journal)).toThrow("censored");
    expect(analyzeJevQualification([trial], [value], [review(value)], journal).arms.C.censored).toBe(1);
  });
  it("recognizes a persistent lease budget even if the driver did not mark censorship", () => {
    const value = result(); value.actions[0]!.run = { status: "budget-paused" };
    expect(analyzeJevQualification([trial], [value], [review(value)], journal).arms.C.censored).toBe(1);
    expect(() => analyzeJevQualification([trial], [value], [{ ...review(value), completed: true }], journal)).toThrow("censored");
  });
  it("never computes a speedup from an unfinished baseline", () => {
    const values = (["A", "B", "C"] as const).map(arm => ({ ...result(), arm }));
    const reviews = values.map(value => ({ ...review(value), completed: value.arm !== "A" }));
    const report = analyzeJevQualification([trial], values, reviews, journal);
    expect(report.completeEvidence).toBe(true);
    expect(report.comparable).toBe(false);
    expect(report.metrics.successfulTaskCostReduction).toBeNull();
    expect(report.metrics.medianFeedbackReduction).toBeNull();
    expect(report.qualified).toBe(false);
  });
});
