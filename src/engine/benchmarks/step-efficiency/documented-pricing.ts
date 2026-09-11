import type { ExperimentUsage } from "../action-compilation/experiment-budget";

/** Reviewed public tariff, not a provider bill or a replacement budget policy. */
export const DEEPSEEK_FLASH_TARIFF_20260908 = {
  checkedOn: "2026-09-08", currency: "CNY", model: "deepseek-v4-flash", version: "DeepSeek-V4-Flash-0731",
  source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  peakNanoCnyPerToken: { hit: 100, miss: 3000, output: 9000 },
  offPeakNanoCnyPerToken: { hit: 50, miss: 1500, output: 4500 },
  peakSchedule: "Monday-Friday UTC [01:00,04:00) and [06:00,10:00)",
  historicalEffectiveDate: null,
} as const;

export function isDeepSeekPeak(timestampMs: number): boolean {
  if (!Number.isFinite(timestampMs)) throw new Error("invalid pricing timestamp");
  const date = new Date(timestampMs), weekday = date.getUTCDay(), hour = date.getUTCHours();
  return weekday >= 1 && weekday <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
}

export function documentedFlashCost(usage: ExperimentUsage, startedAt: string, completedAt: string) {
  const start = Date.parse(startedAt), end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("invalid pricing interval");
  if (Object.values(usage).some(value => !Number.isSafeInteger(value) || value < 0) || usage.cacheHit > usage.input) throw new Error("invalid pricing usage");
  const charge = (peak: boolean) => {
    const price = peak ? DEEPSEEK_FLASH_TARIFF_20260908.peakNanoCnyPerToken : DEEPSEEK_FLASH_TARIFF_20260908.offPeakNanoCnyPerToken;
    return usage.cacheHit * price.hit + (usage.input - usage.cacheHit) * price.miss + usage.output * price.output;
  };
  const regimes = new Set([isDeepSeekPeak(start), isDeepSeekPeak(end)]);
  // The public page does not define which instant determines billing when a
  // request spans a price boundary. Preserve the possible price range.
  for (let at = (Math.floor(start / 3_600_000) + 1) * 3_600_000; at < end; at += 3_600_000) regimes.add(isDeepSeekPeak(at));
  const costs = [...regimes].map(charge);
  return { dispatchRegime: isDeepSeekPeak(start) ? "peak" : "off-peak",
    dispatchEstimateNanoCny: charge(isDeepSeekPeak(start)),
    intervalMinimumNanoCny: Math.min(...costs), intervalMaximumNanoCny: Math.max(...costs),
    crossesTariffBoundary: regimes.size > 1, providerBilledNanoCny: null };
}
