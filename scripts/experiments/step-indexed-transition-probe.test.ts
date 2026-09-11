import { expect, it } from "vitest";
import { indexedTransitionDecision, requireProbeDispatch } from "./step-indexed-transition-probe";
it("admits only two complete settled first-response roots, never schema recovery or partial coverage", () => {
  const rows = [0, 1].map(repeat => ({ repeat, complete: true, http: 1, tokens: 100, rawJson: true }));
  expect(indexedTransitionDecision(rows, false)).toBe("eligible-for-source-semantic-review-no-gameplay-claim");
  expect(indexedTransitionDecision(rows.slice(0, 1), false)).toBe("inconclusive");
  expect(indexedTransitionDecision([rows[0]!, rows[0]!], false)).toBe("inconclusive");
  expect(indexedTransitionDecision(rows, true)).toBe("inconclusive");
  expect(indexedTransitionDecision([{ ...rows[0]!, complete: false }], false)).toBe("failed-full-root-admission");
  expect(indexedTransitionDecision([{ ...rows[0]!, rawJson: false }, rows[1]!], false)).toBe("failed-full-root-admission");
  expect(indexedTransitionDecision([{ ...rows[0]!, http: 2 }, rows[1]!], false)).toBe("inconclusive");
  expect(indexedTransitionDecision([{ ...rows[0]!, tokens: null }, rows[1]!], false)).toBe("inconclusive");
});

it("preserves a pre-transport configuration error instead of looking up HTTP zero", () => {
  expect(() => requireProbeDispatch(0, "canonical model invocation identity requires worldHash and revision"))
    .toThrow("canonical model invocation identity requires worldHash and revision");
  expect(() => requireProbeDispatch(2)).toThrow("observed 2");
  expect(() => requireProbeDispatch(1)).not.toThrow();
});
