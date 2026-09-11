import { expect, it } from "vitest";
import { conditionProfileProbeDecision } from "./step-condition-profile-probe";

it("requires the complete frozen root and settled bounded usage before semantic review", () => {
  const row = { rootId: "004", arm: "I", complete: true, httpCalls: 1, totalTokens: 5000,
    documentedKnownNanoCny: 1000, admittedActions: 4, admittedSlots: 4 };
  expect(conditionProfileProbeDecision([row], false)).toBe("eligible-for-source-semantic-review-no-gameplay-claim");
  expect(conditionProfileProbeDecision([{ ...row, httpCalls: 2 }], false)).toBe("eligible-for-source-semantic-review-no-gameplay-claim");
  for (const patch of [{ complete: false }, { admittedActions: 3 }, { admittedSlots: 3 }]) {
    expect(conditionProfileProbeDecision([{ ...row, ...patch }], false)).toBe("failed-full-root-admission");
  }
  for (const patch of [{ rootId: "partial" }, { arm: "changed" }, { httpCalls: 0 }, { httpCalls: 3 },
    { httpCalls: 1.5 }, { totalTokens: null }, { documentedKnownNanoCny: null }]) {
    expect(conditionProfileProbeDecision([{ ...row, ...patch }], false)).toBe("inconclusive");
  }
  expect(conditionProfileProbeDecision([row], true)).toBe("inconclusive");
  expect(conditionProfileProbeDecision([row, row], false)).toBe("inconclusive");
  expect(conditionProfileProbeDecision([], false)).toBe("inconclusive");
});
