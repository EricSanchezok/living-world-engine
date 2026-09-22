import { describe, expect, it } from "vitest";
import { actionTexts, auditCoverage, criticalPath, sha256, type ActionInput, type TextAnnotation } from "./step-executable-interaction-audit";

const action: ActionInput = {
  id: "a", actorId: "courier", targetIds: ["recipient"],
  rawText: 'CURRENT_PARALLEL_ATTEMPTS_V1 (all members are attempted together; no success is assumed):\n{"attempts":[{"text":"派信使送信；尚未送达。","targetIndices":[0]},{"text":"等待回信，不预付。","targetIndices":[]}]}',
};
const annotations = (): TextAnnotation[] => actionTexts(action).map((p) => ({
  actorId: action.actorId, phase: "initial", pointer: p.pointer, textHash: sha256(p.text),
  clauses: [{ text: p.text, coverage: "fallback", work: "delivery", prerequisites: "Bound messenger and route", residual: "Delivery not established", expected: "Pending until evidenced receipt", deterministicOperations: [] }],
}));

describe("offline executable-interaction P0 evidence", () => {
  it("rejects dropped negation, parallel work, reaction changes, and duplicate actors", () => {
    expect(auditCoverage([action], [action], annotations())).toHaveLength(2);
    expect(auditCoverage([action], [action], annotations()).map((p) => p.targetIds)).toEqual([["recipient"], []]);
    const unsupportedCoverage = annotations();
    unsupportedCoverage[0].clauses[0].coverage = "complete";
    expect(() => auditCoverage([action], [action], unsupportedCoverage)).toThrow("Incomplete clause assessment");
    const dropped = annotations();
    dropped[0].clauses[0].text = "派信使送信；";
    expect(() => auditCoverage([action], [action], dropped)).toThrow("clause partition");
    expect(() => auditCoverage([action], [action], annotations().slice(0, 1))).toThrow("membership");
    expect(() => auditCoverage([action], [{ ...action, rawText: "取消寄信。" }], annotations())).toThrow("membership");
    expect(() => auditCoverage([action], [{ ...action, targetIds: ["another-person"] }], annotations())).toThrow("membership");
    expect(() => auditCoverage([action, action], [action, action], annotations())).toThrow("roster");
  });

  it("keeps a mixed physical request whole and computes parallel joins with max", () => {
    const nodes = [
      { id: "mixed", durationMs: 80_000, parents: [], actorIds: ["a", "b"], replaceable: true },
      { id: "other", durationMs: 20_000, parents: [], actorIds: ["c"], replaceable: true },
      { id: "commit", durationMs: 3_000, parents: ["mixed", "other"], actorIds: [], replaceable: false },
    ];
    expect(criticalPath(nodes, new Set(["a"]))).toEqual({ ms: 83_000, path: ["mixed", "commit"], removed: [] });
    expect(criticalPath(nodes, new Set(["a", "b"]))).toEqual({ ms: 23_000, path: ["other", "commit"], removed: ["mixed"] });
    expect(criticalPath(nodes, new Set(["a", "b", "c"]))).toEqual({ ms: 3_000, path: ["mixed", "commit"], removed: ["mixed", "other"] });
  });

  it("fails closed on unbound or cyclic dependency evidence", () => {
    const base = { id: "a", durationMs: 1, actorIds: [], replaceable: true };
    expect(() => criticalPath([{ ...base, parents: ["missing"] }], new Set())).toThrow("Invalid DAG");
    expect(() => criticalPath([{ ...base, parents: ["a"] }], new Set())).toThrow("Invalid DAG");
    expect(criticalPath([{ ...base, parents: [] }], new Set(["a"])).removed).toEqual([]);
  });
});
