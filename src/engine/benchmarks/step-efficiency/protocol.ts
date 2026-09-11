import { TRUTH_RESOLUTION_CONTRACT_VERSION } from "../../algorithms/roles";
import { ORDERED_RANDOM_SCHEDULING } from "../../mechanics/ordered-random-stream";
import { defineAlgorithmRef, type AlgorithmRef } from "../../algorithms/composition";
import { SHARED_BATCH_CONTEXT_CODEC } from "../../mechanics/shared-batch-context";
import { SHARED_BATCH_PROMPT_VERSION } from "../../mechanics/truth-batch-provider";
import { type ExperimentBudgetPolicy, EXPERIMENT_PHASES } from "../action-compilation/experiment-budget";

export const STEP_E1_PROTOCOL = {
  id: "STEP-E1", version: 2, seed: 20260906,
  root: ".livingworld-benchmarks/experiments/step-efficiency/v1",

  deadlineUtc: "2026-09-07T00:33:50.000Z",
  model: "deepseek-v4-flash", officialVersion: "DeepSeek-V4-Flash-0731",
  thinking: "disabled", maxConcurrent: 4, targetConsecutiveSteps: 3,
  inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072,
  priceCaveat: "Peak USD prices times a conservative fixed 8 CNY/USD multiplier; not an FX quote or invoice.",
  unknownBilling: "Reviewed unknown requests may be explicitly quarantined at their full reserved ceiling; the source trial closes permanently and new trials still count that exposure.",
} as const;

export const STEP_E1_BUDGET: ExperimentBudgetPolicy = {
  maximumNanoCny: 1_000_000_000_000, maxConcurrentRequests: STEP_E1_PROTOCOL.maxConcurrent,
  inputMissNanoCnyPerToken: 3520, inputHitNanoCnyPerToken: 112, outputNanoCnyPerToken: 10560,
  prices: { flash: { accountId: "deepseek-api", modelId: STEP_E1_PROTOCOL.model,
    inputMissNanoCnyPerToken: 3520, inputHitNanoCnyPerToken: 112, outputNanoCnyPerToken: 10560,
    pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingCheckedAt: "2026-09-06" } },
  maxHttpRequests: Object.fromEntries([...EXPERIMENT_PHASES, "trajectory"].map((phase) => [phase, Number.MAX_SAFE_INTEGER])),
  maxKnownTokens: Object.fromEntries([...EXPERIMENT_PHASES, "trajectory"].map((phase) => [phase, Number.MAX_SAFE_INTEGER])),
  phaseBudgets: [
    { phases: ["probes", "calibration"], maximumNanoCny: 200_000_000_000 },
    { phases: ["discovery"], maximumNanoCny: 150_000_000_000 },
    { phases: ["trajectory"], maximumNanoCny: 450_000_000_000 },
    { phases: ["confirmation"], maximumNanoCny: 150_000_000_000 },
    { phases: ["review"], maximumNanoCny: 50_000_000_000 },
  ],
};

/** Pin only the two trusted Truth/Observation batching children. */
export function sharedContextAlgorithmRef(base: AlgorithmRef<"world-execution">): AlgorithmRef<"world-execution"> {
  const children = { ...base.children };
  for (const slot of ["truthResolution", "observationRendering"] as const) {
    const original = children[slot];
    if (!original?.children.batching) throw new Error(`composition has no ${slot} batching child`);
    const batching = defineAlgorithmRef({ role: "work-batching", id: "shared-context-slot-batching", version: "2", contractVersion: 1,
      config: { maxSlots: original.children.batching.config.maxSlots!, contextCodec: SHARED_BATCH_CONTEXT_CODEC,
        promptVersion: SHARED_BATCH_PROMPT_VERSION }, children: {} });
    children[slot] = defineAlgorithmRef({ ...original, children: { ...original.children, batching } });
  }
  return defineAlgorithmRef({ ...base, children });
}

export function orderedRandomAlgorithmRef(base: AlgorithmRef<"world-execution">): AlgorithmRef<"world-execution"> {
  const original = base.children.truthResolution;
  if (!original) throw new Error("composition has no truth resolution child");
  const truthResolution = defineAlgorithmRef({ role: "truth-resolution", id: "ordered-rng-truth-resolution", version: "1", contractVersion: TRUTH_RESOLUTION_CONTRACT_VERSION,
    config: { randomScheduling: ORDERED_RANDOM_SCHEDULING }, children: original.children });
  return defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution } });
}
