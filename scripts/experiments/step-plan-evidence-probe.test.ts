import { expect, it } from "vitest";
import { planEvidenceDecision } from "./step-plan-evidence-probe";

it("requires both complete source roots and known billing before semantic review", () => {
  const rows = ["016", "017"].map(rootId => ({ rootId, arm: "C", complete: true, initialAdmittedActions: 0,
    httpCalls: 3, totalTokens: 1000, documentedKnownNanoCny: 1000 }));
  expect(planEvidenceDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  expect(planEvidenceDecision(rows.map((row, index) => ({ ...row, complete: index === 0 })), false)).toBe("failed");
  expect(planEvidenceDecision(rows, true)).toBe("inconclusive");
  expect(planEvidenceDecision(rows.slice(1), false)).toBe("inconclusive");
  expect(planEvidenceDecision(rows.map(row => ({ ...row, rootId: "016" })), false)).toBe("inconclusive");
  expect(planEvidenceDecision(rows.map(row => ({ ...row, arm: "B" })), false)).toBe("inconclusive");
  expect(planEvidenceDecision(rows.map(row => ({ ...row, documentedKnownNanoCny: null })), false)).toBe("inconclusive");
});
