import { contentHash } from "../../models/model-audit";
import { AC_FP2_ARMS, AC_FP2_CANDIDATES, AC_FP2_PROTOCOL, constrainedFirstPassSchedule, type ConstrainedFirstPassCandidate, type ConstrainedFirstPassTrial } from "./constrained-first-pass-protocol";
import { quantile, summarizeFirstPass, type FirstPassTrialScore } from "./first-pass-scoring";
export type ConstrainedTrialScore = FirstPassTrialScore<ConstrainedFirstPassTrial>;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const cost = (rows: readonly ConstrainedTrialScore[]) => sum(rows.map((row) => row.cacheMiss * 3520 + row.cacheHit * 112 + row.output * 10560));

export function validateConstrainedScores(rows: readonly ConstrainedTrialScore[], phase: "discovery" | "confirmation", winner?: ConstrainedFirstPassCandidate) {
  const expected = constrainedFirstPassSchedule(phase, winner);
  if (rows.length !== expected.length || new Set(rows.map((row) => row.trial.id)).size !== rows.length ||
    expected.some((trial) => !rows.some((row) => contentHash(row.trial) === contentHash(trial)))) throw new Error("incomplete or duplicate fixed AC-FP2 schedule");
}

export function selectConstrainedWinner(rows: readonly ConstrainedTrialScore[]) {
  validateConstrainedScores(rows, "discovery");
  const groups = Object.fromEntries(AC_FP2_ARMS.map((arm) => [arm, summarizeFirstPass(rows.filter((row) => row.trial.arm === arm))]));
  const base = groups.B!;
  const stratum = (arm: string) => rows.filter((row) => row.trial.arm === arm && ["P01", "P03"].includes(row.trial.sourceId) && row.firstFormal).length;
  const eligibility = Object.fromEntries(AC_FP2_CANDIDATES.map((arm) => {
    const group = groups[arm]!;
    return [arm, { firstPass: group.firstFormal >= base.firstFormal + 3, finalPass: group.finalFormal >= base.finalFormal,
      successfulStratum: stratum(arm) >= stratum("B"), tokens: group.tokens <= base.tokens, http: group.http <= base.http }];
  }));
  const candidates = AC_FP2_CANDIDATES.filter((arm) => Object.values(eligibility[arm]!).every(Boolean)).sort((a, b) =>
    groups[b]!.firstFormal - groups[a]!.firstFormal || groups[b]!.finalFormal - groups[a]!.finalFormal ||
    groups[a]!.tokens - groups[b]!.tokens || groups[a]!.http - groups[b]!.http || AC_FP2_CANDIDATES.indexOf(a) - AC_FP2_CANDIDATES.indexOf(b));
  return { status: candidates.length ? "eligible" : "no-eligible-candidate", winner: candidates[0] ?? null,
    groups, eligibility, scoreHash: contentHash(rows), metric: "first-pass-formal-not-semantic" };
}

export function exactOneSidedMcNemar(gained: number, lost: number): number {
  const n = gained + lost;
  let term = 2 ** -n, probability = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= gained) probability += term;
    term *= (n - k) / (k + 1);
  }
  return Math.min(1, probability);
}

export function confirmConstrainedWinner(rows: readonly ConstrainedTrialScore[], winner: ConstrainedFirstPassCandidate) {
  validateConstrainedScores(rows, "confirmation", winner);
  const baseRows = rows.filter((row) => row.trial.arm === "B");
  const candidateRows = rows.filter((row) => row.trial.arm === winner);
  const base = summarizeFirstPass(baseRows), candidate = summarizeFirstPass(candidateRows);
  const pairs = baseRows.map((a) => [a, candidateRows.find((b) => b.trial.sourceId === a.trial.sourceId && b.trial.repetition === a.trial.repetition)!] as const);
  const gained = pairs.filter(([a, b]) => !a.firstFormal && b.firstFormal).length;
  const lost = pairs.filter(([a, b]) => a.firstFormal && !b.firstFormal).length;
  const pValue = exactOneSidedMcNemar(gained, lost);
  const successStratum = (items: readonly ConstrainedTrialScore[]) => items.filter((row) => ["P01", "P03"].includes(row.trial.sourceId) && row.firstFormal).length;
  const mean = (items: readonly ConstrainedTrialScore[]) => sum(items.map((row) => row.wallMs)) / items.length;
  const gates = { firstPass: candidate.firstFormal >= 61, failureReduction: base.firstFormal < 64 && 64 - candidate.firstFormal <= (64 - base.firstFormal) * .5,
    significance: pValue < .05, finalPass: candidate.finalFormal >= base.finalFormal,
    successfulStratum: successStratum(candidateRows) >= successStratum(baseRows), tokens: candidate.tokens <= .8 * base.tokens,
    http: candidate.http <= base.http, repair: candidate.repairCalls <= .5 * base.repairCalls,
    cost: cost(candidateRows) <= cost(baseRows), meanLatency: mean(candidateRows) <= mean(baseRows),
    p95Latency: candidate.p95WallMs! <= 1.1 * base.p95WallMs! };
  let seed = AC_FP2_PROTOCOL.statistics.seed as number;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
  const strata = AC_FP2_PROTOCOL.sources.map((source) => pairs.filter(([row]) => row.trial.sourceId === source.id));
  const differences: number[] = [], tokenRatios: number[] = [], httpRatios: number[] = [];
  for (let sample = 0; sample < AC_FP2_PROTOCOL.statistics.bootstrapSamples; sample++) {
    const sampled = strata.flatMap((stratum) => stratum.map(() => stratum[Math.floor(random() * stratum.length)]!));
    differences.push(sum(sampled.map(([a, b]) => Number(b.firstFormal) - Number(a.firstFormal))) / 64);
    tokenRatios.push(sum(sampled.map(([, b]) => b.tokens)) / sum(sampled.map(([a]) => a.tokens)));
    httpRatios.push(sum(sampled.map(([, b]) => b.http)) / sum(sampled.map(([a]) => a.http)));
  }
  const interval = (values: number[]) => [quantile(values, .025), quantile(values, .975)];
  return { status: Object.values(gates).every(Boolean) ? "engineering-qualified-semantic-evidence-separate" : "not-qualified", gates,
    base, candidate, gained, lost, pValue, bootstrap: { seed: AC_FP2_PROTOCOL.statistics.seed, samples: AC_FP2_PROTOCOL.statistics.bootstrapSamples,
      firstFormalDifference: interval(differences), tokenRatio: interval(tokenRatios), httpRatio: interval(httpRatios) }, productionPromotion: false };
}
