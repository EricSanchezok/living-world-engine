import { expect, it } from "vitest";
import { worklistRecoveryDecision } from "./step-worklist-recovery-probe";
import type { HistoricalRecoveryRow } from "./step-check-feedback-probe";

it("requires exact historical retention, the free successful control and known bounded repair charges", () => {
  const rows: HistoricalRecoveryRow[] = [
    { rootId: "007", complete: true, retainedFromHistoricalFirstResponse: 7, newHttp: 0, unknownUsageRequests: 0 },
    { rootId: "041", complete: true, retainedFromHistoricalFirstResponse: 40, newHttp: 2, unknownUsageRequests: 0 },
  ];
  expect(worklistRecoveryDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  expect(worklistRecoveryDecision([rows[0]!, { ...rows[1]!, complete: false }], false)).toBe("failed");
  expect(worklistRecoveryDecision(rows, true)).toBe("inconclusive");
  for (const patch of [{ newHttp: 0 }, { newHttp: 3 }, { retainedFromHistoricalFirstResponse: 29 }, { unknownUsageRequests: 1 }]) {
    expect(worklistRecoveryDecision([rows[0]!, { ...rows[1]!, ...patch }], false)).toBe("inconclusive");
  }
  expect(worklistRecoveryDecision([{ ...rows[0]!, newHttp: 1 }, rows[1]!], false)).toBe("inconclusive");
  expect(worklistRecoveryDecision([rows[0]!, rows[0]!], false)).toBe("inconclusive");
});
