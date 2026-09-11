import { contentHash } from "../../models/model-audit";
import { AC_FP1_SOURCES } from "./first-pass-protocol";
import { defineAlgorithmRef, type AlgorithmRef } from "../../algorithms/composition";
import { constrainedCompilationPrompt, type ConstrainedCompilationOptions } from "../../algorithms/eager-reference/constrained-action-compiler";
import { CONSTRAINED_COMPILATION_CODEC_VERSION } from "../../algorithms/eager-reference/constrained-action-compilation-codec";
import { EXPERIMENT_PHASES } from "./experiment-budget";

export const AC_FP2_ARMS = ["B", "R", "S", "SC", "SF", "SCF"] as const;
export type ConstrainedFirstPassArm = typeof AC_FP2_ARMS[number];
export const AC_FP2_CANDIDATES = ["S", "SC", "SF", "SCF"] as const;
export type ConstrainedFirstPassCandidate = typeof AC_FP2_CANDIDATES[number];

export const AC_FP2_PROTOCOL = {
  id: "AC-FP2", version: 2,
  spec: "docs/specs/0024-action-compilation-constrained-first-pass-experiment.md",

  sourceManifestHash: "4700b167b0ef54351b6d2a91618d45ecd70a861d2eda9d2459007ba8f1804176",
  sourceScoreHash: "8cc38158cc2b47a034fefd1ff8ba998400c6869b6430c2d491768457c5e34348",
  arms: AC_FP2_ARMS, candidates: AC_FP2_CANDIDATES, sources: AC_FP1_SOURCES,
  repetitions: { discovery: 6, confirmation: 16 },
  statistics: { seed: 20260906, bootstrapSamples: 20_000, alpha: .05, test: "one-sided-exact-mcnemar" },
  discovery: { minimumAdditionalFirstSuccess: 3, maximumTokenRatio: 1, maximumHttpRatio: 1 },
  confirmation: { minimumFirstSuccess: 61, maximumFailureRatio: .5, maximumTokenRatio: .8,
    maximumHttpRatio: 1, maximumRepairRatio: .5, maximumCostRatio: 1, maximumMeanLatencyRatio: 1, maximumP95LatencyRatio: 1.1 },
  readiness: { requiredActions: 43, maximumLogicalProbes: 24, evaluation: "formal-plus-calibrated-blind-review" },
  budget: { currency: "CNY", maximumAdditionalNanoCny: 950_000_000_000, maximumCumulativeNanoCny: 1_000_000_000_000,
    historicalNanoCny: 12_511_921_600, stageTokenCaps: false },
  fixed: { model: "deepseek-v4-flash", profile: "truth-deepseek", thinking: false, maximumOutputTokens: 131072,
    timeoutMs: 300000, rootConcurrency: 1, shortlistRatio: .2, runtimeJudgeCalls: 0, extraOracleRepairs: 0, productionPromotion: false },
} as const;

/** Conservative peak USD prices multiplied by a fixed 8 CNY/USD reserve policy, not a live FX quote. */
export const AC_FP2_BUDGET = {
  currency: "CNY", maximumNanoCny: AC_FP2_PROTOCOL.budget.maximumAdditionalNanoCny,
  inputMissNanoCnyPerToken: 3520, inputHitNanoCnyPerToken: 112, outputNanoCnyPerToken: 10560,
  pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingCheckedAt: "2026-09-06",
  modelId: "deepseek-v4-flash", usdToCnyReserveMultiplier: 8,
  maxHttpRequests: Object.fromEntries(EXPERIMENT_PHASES.map((phase) => [phase, Number.MAX_SAFE_INTEGER])),
  maxKnownTokens: Object.fromEntries(EXPERIMENT_PHASES.map((phase) => [phase, Number.MAX_SAFE_INTEGER])),
} as const;

export function constrainedArmOptions(arm: ConstrainedFirstPassArm): ConstrainedCompilationOptions {
  return { capabilities: arm.includes("C"), snapshots: arm.includes("F"), structuredOutputMode: arm === "B" || arm === "R" ? "json-object-zod" : "json-schema-strict" };
}

export function constrainedFirstPassAlgorithmRef(base: AlgorithmRef<"world-execution">, arm: ConstrainedFirstPassArm): AlgorithmRef<"world-execution"> {
  const original = base.children.actionCompilation;
  if (!original) throw new Error("source has no action compiler");
  const options = constrainedArmOptions(arm);
  const compiler = defineAlgorithmRef({ role: "action-compilation", id: "constrained-action-compilation", version: "1", contractVersion: 1,
    config: { ...original.config, ...options, codecVersion: CONSTRAINED_COMPILATION_CODEC_VERSION,
      promptVersion: constrainedCompilationPrompt(options).version }, children: original.children });
  return defineAlgorithmRef({ ...base, children: { ...base.children, actionCompilation: compiler } });
}

export interface ConstrainedFirstPassTrial {
  id: string;
  phase: "discovery" | "confirmation";
  sourceId: string;
  sourceIndex: number;
  repetition: number;
  arm: ConstrainedFirstPassArm;
}

/** Source-local Latin rotation; confirmation alternates the baseline and sealed candidate. */
export function constrainedFirstPassSchedule(phase: ConstrainedFirstPassTrial["phase"], winner?: ConstrainedFirstPassCandidate): ConstrainedFirstPassTrial[] {
  if (phase === "confirmation" && (!winner || !AC_FP2_CANDIDATES.includes(winner))) {
    throw new Error("AC-FP2 confirmation requires an eligible sealed candidate");
  }
  const arms: readonly ConstrainedFirstPassArm[] = phase === "discovery" ? AC_FP2_ARMS : ["B", winner!];
  return Array.from({ length: AC_FP2_PROTOCOL.repetitions[phase] }, (_, repetition) =>
    AC_FP1_SOURCES.flatMap((source, sourceIndex) => {
      const offset = (repetition + sourceIndex) % arms.length;
      return arms.map((_, index) => {
        const arm = arms[(offset + index) % arms.length]!;
        return { id: `${phase}-${source.id}-${String(repetition).padStart(2, "0")}-${arm}`,
          phase, sourceId: source.id, sourceIndex, repetition, arm };
      });
    })).flat();
}

export function constrainedFirstPassProtocolHash(): string { return contentHash(AC_FP2_PROTOCOL); }
