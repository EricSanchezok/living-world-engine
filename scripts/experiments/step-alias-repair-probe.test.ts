import { expect, it } from "vitest";
import { aliasRepairDecision } from "./step-alias-repair-probe";

it("requires complete source-preserving repair with a bounded known-cost fresh request", () => {
  expect(aliasRepairDecision(true, true, 0, 1)).toBe("eligible-for-source-review");
  expect(aliasRepairDecision(true, true, 0, 2)).toBe("eligible-for-source-review");
  expect(aliasRepairDecision(false, false, 0, 2)).toBe("failed");
  expect(aliasRepairDecision(true, false, 0, 1)).toBe("failed");
  expect(aliasRepairDecision(true, true, 1, 1)).toBe("inconclusive");
  expect(aliasRepairDecision(true, true, 0, 0)).toBe("inconclusive");
  expect(aliasRepairDecision(true, true, 0, 3)).toBe("inconclusive");
});
