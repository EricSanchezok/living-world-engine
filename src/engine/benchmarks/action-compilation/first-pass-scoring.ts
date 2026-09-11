import type { CompiledAction } from "../../algorithms/roles";
import type { ActionCompilationRepresentation } from "../../algorithms/eager-reference/action-compilation-representation";
import { contentHash } from "../../models/model-audit";
import type { RawBenchmarkSource } from "../source-capture";
import type { ExperimentUsage } from "./experiment-budget";
import { AC_FP1_ARMS, AC_FP1_PROTOCOL, AC_FP1_SOURCES, firstPassSchedule, type FirstPassTrial } from "./first-pass-protocol";
import type { CompilationTrialIdentity, FirstPassTrialEvidence } from "./first-pass-runner";
import { matchIntentVerdict } from "./first-pass-oracle";

export interface FirstPassHttpEvidence extends ExperimentUsage {
  id: string; elapsedMs: number; reasoning: number | null; cacheWrite: number | null;
}

/** Capture validated partial slots even when another slot exhausts recovery.
 * Do not reimplement the compiler or silently rescue a rejected output. */
export function validatedFirstPassOutputs(evidence: FirstPassTrialEvidence<CompilationTrialIdentity>) {
  return evidence.calls.map((call) => {
    const events = evidence.events.filter((event) => event.event === "model.action_compilation.slots.validated" &&
      event.correlation?.modelInvocationId === call.invocationId);
    if (events.length > 1) throw new Error("duplicate slot-validation evidence for an invocation");
    const payload = events[0]?.payload as { accepted: Array<{ key: string; result: CompiledAction }> } | undefined;
    const accepted = payload?.accepted ?? [];
    if (new Set(accepted.map((entry) => entry.key)).size !== accepted.length) throw new Error("duplicate validated action");
    return { call, accepted };
  });
}

export function firstPassReviewEntries(evidence: FirstPassTrialEvidence<CompilationTrialIdentity>, source: RawBenchmarkSource, oracleHash: string) {
  const entries = new Map<string, { reviewId: string; oracleHash: string; stateHash: string; actionId: string;
    canonicalCompilationHash: string; action: RawBenchmarkSource["actions"][number]; compilation: CompiledAction }>();
  for (const { accepted } of validatedFirstPassOutputs(evidence)) for (const { key, result } of accepted) {
    const action = source.actions.find((entry) => entry.id === key);
    if (!action || result.plan.actionId !== key) throw new Error("validated compilation belongs to another source action");
    const canonicalCompilationHash = contentHash(result);
    const identity = { oracleHash, stateHash: source.stateHash, actionId: key, canonicalCompilationHash };
    const reviewId = contentHash(identity);
    entries.set(reviewId, { reviewId, ...identity, action, compilation: result });
  }
  // Neither arm, cost, original success nor call order is exposed to adjudication.
  return [...entries.values()].sort((left, right) => left.reviewId.localeCompare(right.reviewId));
}

export interface FirstPassTrialScore<T extends CompilationTrialIdentity = FirstPassTrial> {
  trial: T; slots: number; compilerAccepted: boolean;
  firstFormal: boolean; rawFirstFormal: boolean; firstFormalSlots: number; finalFormalSlots: number;
  firstSemantic: boolean; rawFirstSemantic: boolean; singleHttpSemantic: boolean; finalSemantic: boolean;
  firstSemanticSlots: number; finalSemanticSlots: number; unresolvedOutputs: number; intentFailures: number;
  logicalCalls: number; repairCalls: number; recoverySplits: number; structuralCalls: number; http: number; transportRetries: number;
  input: number; output: number; tokens: number; cacheHit: number; cacheMiss: number;
  reasoning: number | null; cacheWrite: number | null; repairTokens: number | null;
  wallMs: number; providerMs: number; queryEncodeMs: number; passageEncodeMs: number; cacheReadMs: number;
  issueClasses: Record<string, number>; rootSymbols: number; outputReferenceCharacters: number;
}

const total = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0);
function nullableTotal(values: readonly (number | null)[]) { return values.some((value) => value === null) ? null : total(values as number[]); }
function symbols(value: unknown): string[] { return JSON.stringify(value ?? null).match(/(?:candidate_[0-9a-f]{12}|\br[0-9]{3,}\b)/gu) ?? []; }

export function scoreFirstPassTrial<T extends CompilationTrialIdentity>(input: { evidence: FirstPassTrialEvidence<T>; source: RawBenchmarkSource; oracleHash: string;
  verdicts: readonly unknown[]; http: readonly FirstPassHttpEvidence[] }): FirstPassTrialScore<T> {
  const { evidence, source, http } = input;
  if (evidence.sourceHash !== contentHash(source) || !evidence.stateUnchanged) throw new Error("trial source/state evidence drift");
  const outputs = validatedFirstPassOutputs(evidence);
  const first = outputs[0];
  const final = new Map<string, CompiledAction>();
  const judgments = new Map<string, "pass" | "fail" | "unresolved">();
  const verdict = (key: string, result: CompiledAction) => {
    const canonicalCompilationHash = contentHash(result);
    const identity = { oracleHash: input.oracleHash, stateHash: source.stateHash, actionId: key, canonicalCompilationHash };
    const decision = matchIntentVerdict(input.verdicts, identity);
    judgments.set(contentHash(identity), decision);
    return decision;
  };
  for (const { accepted } of outputs) for (const { key, result } of accepted) {
    if (!source.actions.some((action) => action.id === key)) throw new Error("unexpected action in slot evidence");
    if (final.has(key)) throw new Error("compiler recompiled an already accepted action");
    final.set(key, result); verdict(key, result);
  }
  if (evidence.compilerAccepted && (final.size !== source.actions.length ||
    contentHash(evidence.result?.compilations) !== contentHash(source.actions.map((action) => final.get(action.id))))) {
    throw new Error("final compilation and partial-slot evidence disagree");
  }
  const firstFormalSlots = first?.accepted.length ?? 0;
  const firstSemanticSlots = first?.accepted.filter(({ key, result }) => verdict(key, result) === "pass").length ?? 0;
  const finalSemanticSlots = [...final].filter(([key, result]) => verdict(key, result) === "pass").length;
  const oneLogicalCall = evidence.calls.length === 1 && evidence.calls[0]?.semanticRepairAttempt === 0;
  const firstFormal = oneLogicalCall && firstFormalSlots === source.actions.length;
  const firstSemantic = firstFormal && firstSemanticSlots === source.actions.length;
  const repairedSymbols = first?.call.audit?.invocations.some((invocation) => invocation.symbolRepairs.some((repair) =>
    repair.status === "normalized" || repair.status === "repaired")) ?? false;
  const issueClasses: Record<string, number> = {};
  for (const call of evidence.calls) for (const invocation of call.audit?.invocations ?? []) for (const issue of invocation.issues) {
    issueClasses[issue.code] = (issueClasses[issue.code] ?? 0) + 1;
  }
  const childCounts = new Map<string, number>();
  for (const call of evidence.calls) if (call.parentInvocationId) childCounts.set(call.parentInvocationId, (childCounts.get(call.parentInvocationId) ?? 0) + 1);
  const splitParents = [...childCounts.values()].filter((count) => count > 1);
  const repairs = evidence.calls.filter((call) => call.semanticRepairAttempt > 0 && (!call.parentInvocationId || childCounts.get(call.parentInvocationId) === 1));
  const repairUsage = repairs.flatMap((call) => call.audit?.invocations.map((invocation) => invocation.tokenUsage) ?? []);
  const measurements = (name: string) => total(evidence.events.map((event) => event.measurements?.[name] ?? 0));
  const inputTokens = total(http.map((entry) => entry.input));
  const outputTokens = total(http.map((entry) => entry.output));
  const cacheHit = total(http.map((entry) => entry.cacheHit));
  return {
    trial: evidence.trial, slots: source.actions.length, compilerAccepted: evidence.compilerAccepted,
    firstFormal, rawFirstFormal: firstFormal && !repairedSymbols, firstFormalSlots, finalFormalSlots: final.size,
    firstSemantic, rawFirstSemantic: firstSemantic && !repairedSymbols, singleHttpSemantic: firstSemantic && http.length === 1,
    finalSemantic: evidence.compilerAccepted && finalSemanticSlots === source.actions.length,
    firstSemanticSlots, finalSemanticSlots,
    unresolvedOutputs: [...judgments.values()].filter((value) => value === "unresolved").length,
    intentFailures: [...judgments.values()].filter((value) => value === "fail").length,
    logicalCalls: evidence.calls.length, repairCalls: repairs.length,
    recoverySplits: splitParents.length, structuralCalls: total(splitParents),
    http: http.length, transportRetries: Math.max(0, http.length - evidence.calls.filter((call) => call.audit).length),
    input: inputTokens, output: outputTokens, tokens: inputTokens + outputTokens, cacheHit, cacheMiss: inputTokens - cacheHit,
    reasoning: nullableTotal(http.map((entry) => entry.reasoning)), cacheWrite: nullableTotal(http.map((entry) => entry.cacheWrite)),
    repairTokens: repairUsage.length !== repairs.length ? null : nullableTotal(repairUsage.map((usage) =>
      usage.input === null || usage.output === null ? null : usage.input + usage.output)),
    wallMs: evidence.wallMs, providerMs: total(http.map((entry) => entry.elapsedMs)),
    queryEncodeMs: measurements("queryEncodeMs"), passageEncodeMs: measurements("passageEncodeMs"), cacheReadMs: measurements("cacheReadMs"),
    issueClasses, rootSymbols: new Set(symbols(evidence.calls[0]?.context)).size,
    outputReferenceCharacters: total(evidence.calls.flatMap((call) => symbols(call.value).map((symbol) => symbol.length))),
  };
}

export function quantile(values: readonly number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

export function summarizeFirstPass(scores: readonly FirstPassTrialScore<CompilationTrialIdentity>[]) {
  const sum = (field: keyof FirstPassTrialScore) => total(scores.map((score) => Number(score[field])));
  const nullable = (field: "reasoning" | "cacheWrite" | "repairTokens") => nullableTotal(scores.map((score) => score[field]));
  const slots = sum("slots"); const tokens = sum("tokens"); const finalSlots = sum("finalSemanticSlots");
  return {
    batches: scores.length, slots, firstFormal: sum("firstFormal"), rawFirstFormal: sum("rawFirstFormal"), firstFormalSlots: sum("firstFormalSlots"),
    finalFormal: sum("compilerAccepted"), finalFormalSlots: sum("finalFormalSlots"),
    firstSemantic: sum("firstSemantic"), rawFirstSemantic: sum("rawFirstSemantic"), singleHttpSemantic: sum("singleHttpSemantic"),
    finalSemantic: sum("finalSemantic"), firstSemanticSlots: sum("firstSemanticSlots"), finalSemanticSlots: finalSlots,
    unresolvedOutputs: sum("unresolvedOutputs"), intentFailures: sum("intentFailures"),
    repairedRecovery: scores.filter((score) => score.finalSemantic && !score.firstSemantic && score.repairCalls > 0).length,
    formalRepairExhaustion: scores.filter((score) => !score.compilerAccepted && score.repairCalls > 0).length,
    logicalCalls: sum("logicalCalls"), repairCalls: sum("repairCalls"), recoverySplits: sum("recoverySplits"), structuralCalls: sum("structuralCalls"),
    http: sum("http"), transportRetries: sum("transportRetries"),
    input: sum("input"), output: sum("output"), tokens, cacheHit: sum("cacheHit"), cacheMiss: sum("cacheMiss"),
    reasoning: nullable("reasoning"), cacheWrite: nullable("cacheWrite"), repairTokens: nullable("repairTokens"),
    tokensPerRequestedAction: slots ? tokens / slots : null, tokensPerSemanticAction: finalSlots ? tokens / finalSlots : null,
    p50WallMs: quantile(scores.map((score) => score.wallMs), .5), p95WallMs: quantile(scores.map((score) => score.wallMs), .95),
    providerMs: sum("providerMs"), queryEncodeMs: sum("queryEncodeMs"), passageEncodeMs: sum("passageEncodeMs"), cacheReadMs: sum("cacheReadMs"),
  };
}

export function validateCompleteFirstPass(scores: readonly FirstPassTrialScore[], phase: FirstPassTrial["phase"], winner?: Exclude<ActionCompilationRepresentation, "B1">) {
  const expected = firstPassSchedule(phase, winner);
  const byId = new Map(scores.map((score) => [score.trial.id, score]));
  if (scores.length !== expected.length || byId.size !== expected.length || expected.some((trial) =>
    contentHash(byId.get(trial.id)?.trial) !== contentHash(trial))) throw new Error("incomplete or drifted experiment schedule");
}

export function selectFirstPassWinner(scores: readonly FirstPassTrialScore[], semanticSafetyReviewed = false) {
  validateCompleteFirstPass(scores, "discovery");
  const groups = Object.fromEntries(AC_FP1_ARMS.map((arm) => [arm, summarizeFirstPass(scores.filter((score) => score.trial.arm === arm))]));
  if (scores.some((score) => score.unresolvedOutputs)) return { status: "unresolved" as const, reason: "intent adjudication is incomplete", groups };
  // Intent failures are not silently reclassified as runtime repair. Their
  // safety significance needs explicit review before any confirmation arm.
  if (scores.some((score) => score.intentFailures) && !semanticSafetyReviewed) return { status: "semantic-review-required" as const, reason: "intent failures require protocol safety review", groups };
  const candidates = [...(["A", "T", "AT"] as const)].sort((a, b) =>
    groups[b]!.firstSemantic - groups[a]!.firstSemantic || groups[b]!.finalSemantic - groups[a]!.finalSemantic ||
    groups[a]!.tokens - groups[b]!.tokens || groups[a]!.http - groups[b]!.http || ["A", "T", "AT"].indexOf(a) - ["A", "T", "AT"].indexOf(b));
  const arm = candidates[0]!; const selected = groups[arm]!; const base = groups.B1!;
  if (selected.firstSemantic <= base.firstSemantic && selected.tokens >= base.tokens) return { status: "no-gain" as const, groups };
  return { status: "eligible" as const, arm, groups };
}

/** Fixed-workload, source-stratified paired bootstrap. Each source contributes
 * equal weight; repetitions are not independent worlds or shared random seeds. */
export function firstPassIntervals(scores: readonly FirstPassTrialScore[], winner: Exclude<ActionCompilationRepresentation, "B1">) {
  validateCompleteFirstPass(scores, "confirmation", winner);
  let state = Number.parseInt(contentHash(AC_FP1_PROTOCOL.seeds.analysis).slice(0, 8), 16) >>> 0;
  const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4_294_967_296; };
  const blocks = AC_FP1_SOURCES.map((source) => Array.from({ length: 16 }, (_, repetition) => {
    const find = (arm: ActionCompilationRepresentation) => scores.find((score) => score.trial.sourceId === source.id && score.trial.repetition === repetition && score.trial.arm === arm)!;
    return [find("B1"), find(winner)] as const;
  }));
  const differences: number[] = [], tokenRatios: number[] = [], httpRatios: number[] = [];
  for (let sample = 0; sample < AC_FP1_PROTOCOL.bootstrapSamples; sample++) {
    let difference = 0, baseTokens = 0, treatmentTokens = 0, baseHttp = 0, treatmentHttp = 0;
    for (const source of blocks) for (let repetition = 0; repetition < 16; repetition++) {
      const [base, treatment] = source[Math.floor(random() * 16)]!;
      difference += Number(treatment.firstSemantic) - Number(base.firstSemantic);
      baseTokens += base.tokens; treatmentTokens += treatment.tokens; baseHttp += base.http; treatmentHttp += treatment.http;
    }
    if (!baseTokens || !baseHttp) throw new Error("confirmation cost ratio has a zero denominator");
    differences.push(difference / 64); tokenRatios.push(treatmentTokens / baseTokens); httpRatios.push(treatmentHttp / baseHttp);
  }
  const interval = (values: number[]) => [quantile(values, .025)!, quantile(values, .975)!] as const;
  return { seed: AC_FP1_PROTOCOL.seeds.analysis, samples: AC_FP1_PROTOCOL.bootstrapSamples, firstSuccessDifference: interval(differences), tokenRatio: interval(tokenRatios), httpRatio: interval(httpRatios) };
}

export function confirmFirstPass(scores: readonly FirstPassTrialScore[], winner: Exclude<ActionCompilationRepresentation, "B1">, semanticSafetyReviewed = false) {
  const intervals = firstPassIntervals(scores, winner);
  const base = summarizeFirstPass(scores.filter((score) => score.trial.arm === "B1"));
  const treatment = summarizeFirstPass(scores.filter((score) => score.trial.arm === winner));
  const successfulStratum = (arm: string) => scores.filter((score) => score.trial.arm === arm && ["P01", "P03"].includes(score.trial.sourceId) && score.firstSemantic).length;
  const policy = AC_FP1_PROTOCOL.confirmation;
  const gates = {
    semanticResolved: scores.every((score) => score.unresolvedOutputs === 0),
    noNewSemanticFailureMechanism: scores.every((score) => score.intentFailures === 0) || semanticSafetyReviewed,
    firstPass: treatment.firstSemantic >= policy.minimumFirstSuccess && treatment.firstSemantic >= base.firstSemantic,
    originalSuccessStratum: successfulStratum(winner) >= successfulStratum("B1"),
    failureReduction: base.firstSemantic >= policy.minimumFirstSuccess || ((64 - treatment.firstSemantic) <= (64 - base.firstSemantic) * policy.maximumFailureRatio && intervals.firstSuccessDifference[0] > 0),
    finalSuccess: treatment.finalSemantic >= base.finalSemantic,
    tokens: treatment.tokens <= policy.maximumTokenRatio * base.tokens,
    http: treatment.http <= policy.maximumHttpRatio * base.http,
    repair: base.repairCalls === 0 || treatment.repairCalls <= policy.maximumRepairRatio * base.repairCalls,
    costInterval: intervals.tokenRatio[1] < 1,
  };
  return { status: Object.values(gates).every(Boolean) ? "qualified-for-separate-controlled-validation" : "not-qualified",
    base, treatment, intervals, gates, productionPromotion: false };
}
