import { contentHash } from "../../models/model-audit";
import { EXPERIMENT_PHASES, type ExperimentBudgetPolicy } from "./experiment-budget";

export const AC_FP3_PROTOCOL = {
  id: "AC-FP3", version: 1, seed: 20260906,
  spec: "docs/specs/0025-action-compilation-semantic-first-pass-experiment.md",


  root: ".livingworld-benchmarks/experiments/ac-fp3/v1",
  compiler: { modelId: "deepseek-v4-flash", profileId: "truth-deepseek", thinking: "disabled", maxOutputTokens: 131072 },
  reviewers: [
    { id: "flash", modelId: "deepseek-v4-flash", profileId: "ac-fp3-review-flash" },
    { id: "pro", modelId: "deepseek-v4-pro", profileId: "ac-fp3-review-pro" },
  ],
  reviewerAmendment: "2026-09-06 user: campus Qwen and GLM Coding Plan are free but unavailable; only DeepSeek is usable",
  review: { maxOutputTokens: 16384, maxPacketEntries: 12, thinking: "disabled", retries: 0,
    limitation: "Flash and Pro share a model family; separate blind requests are not independent model-family errors.",
    holdoutCases: 252, positivesPerDimension: 16, negativesPerDimension: 16, unresolved: 28,
    minimumPolarityCorrect: 107, minimumDimensionPolarityCorrect: 15, minimumUnresolvedCorrect: 27 },
  arms: ["B", "R", "R+L", "R+T", "R+F", "R+TF"], conditionalNativeArm: "R+S",
  discovery: { batchSizes: [12, 12, 12, 7], repetitions: 6, maximumTokenRatio: .9, maximumHttpRatio: 1 },
  confirmation: { scenes: 8, batchSize: 12, repetitions: 8, minimumFirstSuccess: 61,
    maximumFailureRatio: .5, maximumTokenRatio: .8, maximumRepairRatio: .5,
    maximumHttpRatio: 1, maximumCostRatio: 1, maximumMeanLatencyRatio: 1, maximumP95LatencyRatio: 1.1 },
  statistics: { bootstrapSamples: 20_000, alpha: .05, test: "one-sided-exact-mcnemar" },
  stopOnCalibrationFailure: true, productionPromotion: false,
} as const;

// Peak USD prices times a conservative fixed 8 CNY/USD reserve multiplier.
// This is a budget estimate, not a live FX quote or an account statement.
const priceSource = { accountId: "deepseek-api", pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/",
  pricingCheckedAt: "2026-09-06", usdToCnyReserveMultiplier: 8 };
export const AC_FP3_BUDGET: ExperimentBudgetPolicy = {
  maximumNanoCny: 1_000_000_000_000,
  inputMissNanoCnyPerToken: 3520, inputHitNanoCnyPerToken: 112, outputNanoCnyPerToken: 10560,
  prices: {
    flash: { ...priceSource, modelId: "deepseek-v4-flash", inputMissNanoCnyPerToken: 3520, inputHitNanoCnyPerToken: 112, outputNanoCnyPerToken: 10560 },
    pro: { ...priceSource, modelId: "deepseek-v4-pro", inputMissNanoCnyPerToken: 10560, inputHitNanoCnyPerToken: 352, outputNanoCnyPerToken: 31680 },
  },
  maxHttpRequests: Object.fromEntries([...EXPERIMENT_PHASES, "trajectory"].map((phase) => [phase, Number.MAX_SAFE_INTEGER])),
  maxKnownTokens: Object.fromEntries([...EXPERIMENT_PHASES, "trajectory"].map((phase) => [phase, Number.MAX_SAFE_INTEGER])),
  phaseBudgets: [
    { phases: ["calibration", "probes"], maximumNanoCny: 200_000_000_000 },
    { phases: ["discovery"], maximumNanoCny: 200_000_000_000 },
    { phases: ["confirmation"], maximumNanoCny: 250_000_000_000 },
    { phases: ["review"], maximumNanoCny: 250_000_000_000 },
    { phases: ["trajectory"], maximumNanoCny: 50_000_000_000 },
  ],
};

export function semanticFirstPassProtocolHash(): string { return contentHash(AC_FP3_PROTOCOL); }
