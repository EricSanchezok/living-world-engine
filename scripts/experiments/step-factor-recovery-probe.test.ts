import { expect, it } from "vitest";
import { factorRecoveryDecision } from "./step-factor-recovery-probe";
import type { HistoricalRecoveryRow } from "./step-check-feedback-probe";

it("requires exact historical retention, the free successful control and known bounded repair charges", () => {
  const rows: HistoricalRecoveryRow[] = [
    { rootId: "007", complete: true, retainedFromHistoricalFirstResponse: 7, newHttp: 0, unknownUsageRequests: 0 },
    { rootId: "041", complete: true, retainedFromHistoricalFirstResponse: 13, newHttp: 2, unknownUsageRequests: 0 },
  ];
  expect(factorRecoveryDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  expect(factorRecoveryDecision([rows[0]!, { ...rows[1]!, complete: false }], false)).toBe("failed");
  expect(factorRecoveryDecision(rows, true)).toBe("inconclusive");
  for (const patch of [{ newHttp: 0 }, { newHttp: 3 }, { retainedFromHistoricalFirstResponse: 29 }, { unknownUsageRequests: 1 }]) {
    expect(factorRecoveryDecision([rows[0]!, { ...rows[1]!, ...patch }], false)).toBe("inconclusive");
  }
  expect(factorRecoveryDecision([{ ...rows[0]!, newHttp: 1 }, rows[1]!], false)).toBe("inconclusive");
  expect(factorRecoveryDecision([rows[0]!, rows[0]!], false)).toBe("inconclusive");
});
