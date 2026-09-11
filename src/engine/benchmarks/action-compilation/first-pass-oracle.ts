import { z } from "zod";
import type { RawBenchmarkSource } from "../source-capture";
import { contentHash } from "../../models/model-audit";
import { AC_FP1_SOURCES } from "./first-pass-protocol";

const rules = z.array(z.string().min(1)).min(1);
export const firstPassOracleSchema = z.strictObject({
  version: z.literal(1), preparedBeforeTreatmentOutputs: z.literal(true),
  reviewMode: z.string().min(1), scope: z.string().min(1),
  globalMust: rules, globalMay: rules, globalForbidden: rules,
  actions: z.array(z.strictObject({ actor: z.string().min(1), source: z.enum(["P01", "P02", "P03", "P04"]), must: rules, may: rules, forbidden: rules })).length(43),
});

/** Bind prose constraints to exact source actions before inspecting any output. */
export function bindFirstPassOracle(value: unknown, sources: readonly RawBenchmarkSource[]) {
  const oracle = firstPassOracleSchema.parse(value);
  const keys = oracle.actions.map((entry) => `${entry.source}:${entry.actor}`);
  if (new Set(keys).size !== 43) throw new Error("intent oracle has duplicate or missing subjects");
  const actions = sources.flatMap((source, index) => source.actions.map((action, slot) => {
    const sourceId = AC_FP1_SOURCES[index]!.id;
    const rule = oracle.actions.find((entry) => entry.source === sourceId && entry.actor === action.actorId);
    if (!rule) throw new Error(`intent oracle omits ${sourceId}/${action.actorId}`);
    return { ...rule, slot, actionId: action.id, actionHash: contentHash(action), stateHash: source.stateHash, rawText: action.rawText };
  }));
  if (actions.length !== 43) throw new Error("intent oracle requires 43 original actions");
  return { ...oracle, actions };
}

export const intentVerdictSchema = z.strictObject({
  oracleHash: z.string().min(1), stateHash: z.string().min(1), actionId: z.string().min(1), canonicalCompilationHash: z.string().min(1),
  verdict: z.enum(["pass", "fail", "unresolved"]),
  evidenceKind: z.enum(["deterministic", "human-adjudication", "model-assisted"]),
  mustFindings: rules, forbiddenFindings: rules,
  evidenceArtifacts: rules,
  reviewer: z.string().min(1),
});

/** Lack of a verdict cannot be promoted to pass by schema acceptance. */
export function matchIntentVerdict(verdicts: readonly unknown[], input: {
  oracleHash: string; stateHash: string; actionId: string; canonicalCompilationHash: string;
}): "pass" | "fail" | "unresolved" {
  const matched = verdicts.map((value) => intentVerdictSchema.parse(value)).filter((verdict) =>
    verdict.oracleHash === input.oracleHash && verdict.stateHash === input.stateHash &&
    verdict.actionId === input.actionId && verdict.canonicalCompilationHash === input.canonicalCompilationHash);
  if (!matched.length) return "unresolved";
  if (new Set(matched.map((verdict) => verdict.verdict)).size !== 1) throw new Error("conflicting intent adjudications");
  return matched[0]!.verdict;
}
