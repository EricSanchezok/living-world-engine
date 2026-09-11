import { expect, it } from "vitest";
import { indexedPlanningDecision } from "./step-indexed-planning-probe";
import type { ProbeRow } from "./step-state-prefix-probe";

it("requires both complete bounded and accounted roots before source semantic review, without claiming comparative gain", () => {
  const rows: ProbeRow[] = [{ rootId: "045", arm: "I", complete: true, initialAdmittedActions: 40, httpCalls: 3, totalTokens: 600, documentedKnownNanoCny: 500 },
    { rootId: "003", arm: "I", complete: true, initialAdmittedActions: 3, httpCalls: 1, totalTokens: 200, documentedKnownNanoCny: 300 }];
  expect(indexedPlanningDecision(rows, false)).toBe("eligible-for-source-semantic-review-no-comparative-claim");
  expect(indexedPlanningDecision([{ ...rows[0]!, complete: false }, rows[1]!], false)).toBe("failed-full-root-admission");
  expect(indexedPlanningDecision(rows, true)).toBe("inconclusive");
  expect(indexedPlanningDecision([rows[0]!, rows[0]!], false)).toBe("inconclusive");
  for (const patch of [{ arm: "B" }, { rootId: "041" }, { httpCalls: 0 }, { httpCalls: 4 }, { httpCalls: 1.5 }, { totalTokens: null }, { documentedKnownNanoCny: null }]) {
    expect(indexedPlanningDecision([{ ...rows[0]!, ...patch }, rows[1]!], false)).toBe("inconclusive");
  }
});
