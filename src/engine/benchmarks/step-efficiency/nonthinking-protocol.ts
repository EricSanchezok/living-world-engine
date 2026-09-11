import { STEP_E1_BUDGET } from "./protocol";
import type { ExperimentBudgetPolicy, ExperimentPrice } from "../action-compilation/experiment-budget";

export const FLASH41_COHORT = Object.freeze({ id: "flash41-20260910", model: "deepseek-flash",
  officialVersion: "DeepSeek-V4.1-Flash", thinking: "disabled", priceId: "flash41-cny-peak-20260910" } as const);
export const FLASH41_PRICE: ExperimentPrice = Object.freeze({ accountId: "deepseek-api", modelId: FLASH41_COHORT.model,
  inputMissNanoCnyPerToken: 2000, inputHitNanoCnyPerToken: 40, outputNanoCnyPerToken: 8000,
  pricingSource: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", pricingCheckedAt: "2026-09-10" });

export const STEP_E2_PROTOCOL = {
  id: "STEP-E2", version: 1, seed: 20260907,
  root: ".livingworld-benchmarks/experiments/step-efficiency/v2",
  model: "deepseek-v4-flash", officialVersion: "DeepSeek-V4-Flash-0731",
  thinking: "disabled", overallDeadlineUtc: null,
  inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072,
  sourceRoot: ".livingworld-benchmarks/experiments/step-efficiency/v1",
  acceptance: "Three credible full-world steps plus a fresh confirmation trajectory; independent source-action behavior checks, replay equality, and measured avoidable-cost reduction. Diagnostic checks alone cannot certify gameplay.",
} as const;

// A separate authorization and journal. Historical reservations never enter E2.
export const STEP_E2_BUDGET: ExperimentBudgetPolicy = {
  ...structuredClone(STEP_E1_BUDGET),
  prices: { flash: { ...STEP_E1_BUDGET.prices!.flash!, pricingCheckedAt: "2026-09-07" } },
  phaseBudgets: [
    { phases: ["probes", "calibration"], maximumNanoCny: 150_000_000_000 },
    { phases: ["discovery"], maximumNanoCny: 150_000_000_000 },
    { phases: ["trajectory"], maximumNanoCny: 400_000_000_000 },
    { phases: ["confirmation"], maximumNanoCny: 250_000_000_000 },
    { phases: ["review"], maximumNanoCny: 50_000_000_000 },
  ],
};
