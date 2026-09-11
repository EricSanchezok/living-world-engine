import { expect, it } from "vitest";
import { transitionWorklistDecision } from "./step-transition-worklist-probe";

it("requires the entire original root and known billing within the frozen HTTP bound", () => {
  const complete = { complete: true, admittedSlots: 12, admittedActions: 43, http: 1, tokens: 100 };
  const eligible = "eligible-for-source-semantic-review-no-gameplay-claim";
  expect(transitionWorklistDecision(complete, false)).toBe(eligible);
  expect(transitionWorklistDecision({ ...complete, http: 2 }, false)).toBe(eligible);
  for (const changed of [{ admittedSlots: 11 }, { admittedActions: 42 }, { complete: false }]) {
    expect(transitionWorklistDecision({ ...complete, ...changed }, false)).toBe("failed-full-root-admission");
  }
  for (const changed of [{ http: 0 }, { http: 3 }, { tokens: null }, { tokens: NaN }, { tokens: 0 }]) {
    expect(transitionWorklistDecision({ ...complete, ...changed }, false)).toBe("inconclusive");
  }
  expect(transitionWorklistDecision(complete, true)).toBe("inconclusive");
  expect(transitionWorklistDecision(null, false)).toBe("inconclusive");
});
