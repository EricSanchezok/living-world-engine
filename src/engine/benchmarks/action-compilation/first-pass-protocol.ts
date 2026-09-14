import { defineAlgorithmRef, type AlgorithmRef } from "../../algorithms/composition";
import { ACTION_COMPILATION_REPRESENTATION_VERSION, type ActionCompilationRepresentation } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompilationPrompt } from "../../algorithms/eager-reference/represented-action-compiler";
import { contentHash } from "../../models/model-audit";
import type { RawBenchmarkSource } from "../source-capture";

export const AC_FP1_ARMS = ["B1", "A", "T", "AT"] as const;
export const AC_FP1_SOURCES = [
  { id: "P01", size: 12, invocation: "14eeb1e020f23569b25ffe994b597ca677d7cb3ec0548eb3ba11f628365fcabd" },
  { id: "P02", size: 12, invocation: "a0d39813ab90d425e006a93929503656bc1481d1bbf512303ab3dea43fc48d5e" },
  { id: "P03", size: 12, invocation: "a842450ea67402f73edfad588c45a3cca8d30124e865a771cc51261ec77c86b0" },
  { id: "P04", size: 7, invocation: "17719e9b506706c3a77ce25a038ac897462d653c4a3f4b69769b94e4e330eef6" },
] as const;

export const AC_FP1_PROTOCOL = {
  version: 1, id: "AC-FP1", spec: "docs/specs/0023-action-compilation-first-pass-experiment.md",

  sources: AC_FP1_SOURCES, arms: AC_FP1_ARMS,
  repetitions: { discovery: 4, confirmation: 16 },
  seeds: { discovery: "ac-fp1-v1-discovery", confirmation: "ac-fp1-v1-confirmation", analysis: "ac-fp1-v1-analysis" },
  bootstrapSamples: 10_000,
  confirmation: { minimumFirstSuccess: 61, maximumTokenRatio: .8, maximumHttpRatio: 1, maximumRepairRatio: .5, maximumFailureRatio: .5 },
  fixed: { profile: "truth-deepseek", model: "deepseek-v4-flash", structuredOutput: "json-object-zod", shortlistRatio: .2,
    concurrency: 1, extraJudgeCalls: 0, extraOracleRepairs: 0, productionPromotion: false },
  intent: { beforeOutputs: true, constraints: ["must", "may", "forbidden"], unresolvedIsPass: false,
    reviewIdentity: ["oracleHash", "stateHash", "actionId", "canonicalCompilationHash"], blindFields: ["arm", "tokenCost", "historicalSuccess"] },
  ranking: ["semanticSafety", "firstSemanticDescending", "finalSemanticDescending", "tokensAscending", "httpAscending", "A,T,AT"],
  stop: ["unsettledUsage", "budgetReserveExceeded", "sourceOrCodeDrift", "irreversibleRepresentation", "semanticSafetyDispute", "noDiscoveryGain"],
  mechanismFamilies: ["fixed-rate-staged", "conditional-ongoing", "assertion-union-reference-values", "pause-resume-cancel",
    "interruption-simultaneity", "shared-resource-capacity", "dependencies-audience", "cause-check-random", "truth-belief-player",
    "composite-open-actions", "atomicity-illegal-input", "identity-repair-replay"],
} as const;

export function orderedFirstPassSources(sources: readonly RawBenchmarkSource[]): RawBenchmarkSource[] {
  if (sources.length !== 4) throw new Error("AC-FP1 requires exactly the four approved original batches");
  return AC_FP1_SOURCES.map((expected) => {
    const source = sources.find((entry) => entry.sourceInvocationId === `rt:model-audit:${expected.invocation}`);
    if (!source || source.actions.length !== expected.size ||
      source.sourceExecutionId !== "dec46f38-a50b-4a28-85d6-73f95a9405fb" ||
      source.stateHash !== "162934b66695b95cc6ea9c4b355fbbdceecef7f41b20a5c3a31c47f429bbc485" ||
      source.modelId !== "deepseek-v4-flash" || source.profileId !== "truth-deepseek" ||
      source.captureAlgorithmManifestHash !== "f54358535f735da671573aac63f8b4267f3b981907ffabda10f27e07bab8ca54") {
      throw new Error(`AC-FP1 source provenance drift: ${expected.id}`);
    }
    return source;
  });
}

export function firstPassAlgorithmRef(base: AlgorithmRef<"world-execution">, representation: ActionCompilationRepresentation, eligibleProfilesOnly = false,
  sourceOwnedDescription = false, profileChoiceEvidence = false, namedTemporalContracts = false, omitSourceDescription = false): AlgorithmRef<"world-execution"> {
  const original = base.children.actionCompilation;
  if (!original) throw new Error("source Composition has no Action Compilation role");
  const config = { ...original.config };
  delete config.eligibleProfileSchema;
  delete config.descriptionPolicy;
  delete config.profileChoiceEvidence;
  delete config.temporalContractSelection;
  const compiler = defineAlgorithmRef({
    role: "action-compilation", id: "represented-action-compilation", version: "3", contractVersion: 1,
    config: { ...config, representation, codecVersion: ACTION_COMPILATION_REPRESENTATION_VERSION,
      ...(eligibleProfilesOnly ? { eligibleProfileSchema: "batch-union-v1" } : {}),
      ...(sourceOwnedDescription ? { descriptionPolicy: omitSourceDescription ? "original-action-omitted-v2" : "original-action-v1" } : {}),
      ...(profileChoiceEvidence ? { profileChoiceEvidence: "visible-schema-v1" } : {}),
      ...(namedTemporalContracts ? { temporalContractSelection: "named-operators-v1" } : {}),
      promptVersion: representedActionCompilationPrompt(representation, sourceOwnedDescription, profileChoiceEvidence, namedTemporalContracts, omitSourceDescription).version,
      aliasPolicy: "sorted-root-union-reserved-tail-exact-only", temporalPolicy: "script-conditional-first-rest" },
    children: original.children,
  });
  return defineAlgorithmRef({ ...base, children: { ...base.children, actionCompilation: compiler } });
}

export interface FirstPassTrial {
  id: string;
  phase: "discovery" | "confirmation";
  sourceId: string;
  sourceIndex: number;
  repetition: number;
  arm: ActionCompilationRepresentation;
}

/** Stable block shuffle and Latin rotation, sealed before any provider output. */
export function firstPassSchedule(phase: "discovery" | "confirmation", winner?: Exclude<ActionCompilationRepresentation, "B1">): FirstPassTrial[] {
  if (phase === "confirmation" && !winner) throw new Error("confirmation requires a sealed discovery winner");
  const arms: readonly ActionCompilationRepresentation[] = phase === "discovery" ? AC_FP1_ARMS : ["B1", winner!];
  const seed = AC_FP1_PROTOCOL.seeds[phase];
  const repetitions = AC_FP1_PROTOCOL.repetitions[phase];
  const blocks = AC_FP1_SOURCES.flatMap((source, sourceIndex) =>
    Array.from({ length: repetitions }, (_, repetition) => ({ source, sourceIndex, repetition,
      order: contentHash({ seed, source: source.id, repetition }) })));
  return blocks.sort((left, right) => left.order.localeCompare(right.order)).flatMap(({ source, sourceIndex, repetition }) => {
    const offset = (sourceIndex + repetition) % arms.length;
    return arms.map((_, index) => {
      const arm = arms[(index + offset) % arms.length]!;
      return { id: `${phase}-${source.id}-${String(repetition).padStart(2, "0")}-${arm}`, phase, sourceId: source.id, sourceIndex, repetition, arm };
    });
  });
}
