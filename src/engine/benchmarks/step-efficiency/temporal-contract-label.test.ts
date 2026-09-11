import { expect, it } from "vitest";
import { temporalContractLabel } from "./temporal-contract-label";

it("distinguishes whole-action totals from progress checks using only authored mechanics", () => {
  const selection = { evidenceRequirement: "none" };
  expect(temporalContractLabel({ kind: "fixed", durationSeconds: 10, checkpointSeconds: 1, selection })).toBe("whole_action_total_10s");
  expect(temporalContractLabel({ kind: "conditional", checkEverySeconds: 300, selection })).toBe("until_success_check_every_300s");
  expect(temporalContractLabel({ kind: "ongoing", checkpointSeconds: 300, selection })).toBe("no_automatic_completion_check_every_300s");
  expect(temporalContractLabel({ kind: "rate", unitsPerPeriod: 4, unit: "km", periodSeconds: 3600, selection })).toBe("action_quantity_at_4_km_per_3600s");
  expect(temporalContractLabel({ kind: "staged", stages: [{ durationSeconds: 300 }, { durationSeconds: 900 }], selection })).toBe("staged_work_total_1200s");
});

it("never presents an explicit-duration default or an unsupported profile as an action duration", () => {
  expect(temporalContractLabel({ kind: "fixed", durationSeconds: 300, selection: { evidenceRequirement: "explicit_duration" } })).toBe("total_duration_from_action_text");
  expect(() => temporalContractLabel({ kind: "fixed", selection: { evidenceRequirement: "none" } })).toThrow(/invalid/u);
  expect(() => temporalContractLabel({ kind: "invented", selection: {} })).toThrow(/unsupported/u);
  expect(() => temporalContractLabel({ kind: "conditional", checkEverySeconds: -1, selection: {} })).toThrow(/invalid/u);
});
