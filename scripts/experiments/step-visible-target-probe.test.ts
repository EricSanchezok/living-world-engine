import { expect, it } from "vitest";
import { visibleTargetDecision } from "./step-visible-target-probe";
import type { ProbeRow } from "./step-state-prefix-probe";

const paired = (): ProbeRow[] => ["041", "007"].flatMap(rootId => ["B", "C"].map(arm => ({ rootId, arm,
  complete: true, initialAdmittedActions: rootId === "041" ? 41 : 7, httpCalls: 1,
  totalTokens: arm === "B" ? 1000 : 890, documentedKnownNanoCny: 100 })));

it("requires complete paired source roots and distinguishes token benefit from schema-only overhead", () => {
  expect(visibleTargetDecision(paired(), false)).toBe("eligible-for-source-semantic-review");
  const overhead = paired().map(row => ({ ...row, totalTokens: 1100 }));
  expect(visibleTargetDecision(overhead, false)).toBe("failed");
  overhead[0]!.complete = false;
  expect(visibleTargetDecision(overhead, false)).toBe("eligible-for-source-semantic-review");
  overhead[1]!.httpCalls = 2;
  expect(visibleTargetDecision(overhead, false)).toBe("failed");
  const lostFirstPass = paired(); lostFirstPass[1]!.initialAdmittedActions--;
  expect(visibleTargetDecision(lostFirstPass, false)).toBe("failed");
  const incompleteCandidate = paired(); incompleteCandidate[1]!.complete = false;
  expect(visibleTargetDecision(incompleteCandidate, false)).toBe("failed");
  expect(visibleTargetDecision(paired().slice(1), false)).toBe("inconclusive");
  expect(visibleTargetDecision(paired(), true)).toBe("inconclusive");
  expect(visibleTargetDecision(paired().map(row => ({ ...row, totalTokens: null })), false)).toBe("inconclusive");
});
