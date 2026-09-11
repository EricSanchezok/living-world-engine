import { expect, it } from "vitest";
import { documentedFlashCost, isDeepSeekPeak } from "./documented-pricing";

it.each([
  ["2026-09-07T00:59:59Z", false], ["2026-09-07T01:00:00Z", true],
  ["2026-09-07T03:59:59Z", true], ["2026-09-07T04:00:00Z", false],
  ["2026-09-07T06:00:00Z", true], ["2026-09-07T10:00:00Z", false],
  ["2026-09-06T02:00:00Z", false], ["2026-09-05T07:00:00Z", false],
])("uses the documented UTC calendar at %s", (stamp, peak) => {
  expect(isDeepSeekPeak(Date.parse(stamp))).toBe(peak);
});

it("reports tariff ambiguity without inventing a provider bill", () => {
  const usage = { input: 1_000_000, cacheHit: 200_000, output: 100_000 };
  const result = documentedFlashCost(usage, "2026-09-07T03:59:59Z", "2026-09-07T04:00:10Z");
  expect(result).toEqual({ dispatchRegime: "peak", dispatchEstimateNanoCny: 3_320_000_000,
    intervalMinimumNanoCny: 1_660_000_000, intervalMaximumNanoCny: 3_320_000_000,
    crossesTariffBoundary: true, providerBilledNanoCny: null });
  const acrossWindow = documentedFlashCost(usage, "2026-09-07T00:00:00Z", "2026-09-07T05:00:00Z");
  expect(acrossWindow.crossesTariffBoundary).toBe(true);
  expect(acrossWindow.dispatchEstimateNanoCny).toBe(1_660_000_000);
});

it("rejects invalid clocks and inconsistent usage", () => {
  expect(() => isDeepSeekPeak(NaN)).toThrow("timestamp");
  expect(() => documentedFlashCost({ input: 1, cacheHit: 2, output: 0 }, "2026-09-07", "2026-09-08")).toThrow("usage");
  expect(() => documentedFlashCost({ input: 1, cacheHit: 0, output: 0 }, "2026-09-08", "2026-09-07")).toThrow("interval");
});
