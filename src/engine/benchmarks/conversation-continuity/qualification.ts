import { CONTINUITY_AXES, CONTINUITY_CASES, RECOVERY_BOUNDARIES, type ContinuityWorld } from "./cases";

export const CONTINUITY_CORPUS_SHA256 = "3ecc09d73544b07f85b1f8658e360c4441c94371cf9cc2261cffe37eb65c7744";
export const CONTINUITY_GATES = [...RECOVERY_BOUNDARIES, "cognitive-isolation", "resource-conservation", "causality", "speech-delivery", "temporal-order", "replay"] as const;
export interface ContinuityGate { id: typeof CONTINUITY_GATES[number]; passed: boolean; evidence: string }
export interface ContinuityReview {
  caseId: string;
  turn: number;
  status: "complete" | "failed" | "censored" | "not-run";
  axes: Record<typeof CONTINUITY_AXES[number], { passed: boolean; reason: string }>;
  evidence: string[];
  hardFailures: string[];
}

/** The frozen planned denominator includes missing rounds and entire missing flows. */
export function qualifyContinuity(reviews: ContinuityReview[], gates: ContinuityGate[] = []) {
  const cases = CONTINUITY_CASES.filter(item => item.phase !== "development");
  const expected = cases.flatMap(item => item.turns.map((_, index) => ({ caseId: item.id, turn: index + 1,
    phase: item.phase, world: item.world, key: `${item.id}:${index + 1}` })));
  const validKeys = new Set(expected.map(row => row.key)), byKey = new Map<string, ContinuityReview>();
  for (const review of reviews) {
    const key = `${review.caseId}:${review.turn}`;
    if (!validKeys.has(key) || byKey.has(key)) throw new Error(`Unexpected or duplicate qualification review: ${key}`);
    if (!CONTINUITY_AXES.every(axis => typeof review.axes[axis]?.passed === "boolean" && review.axes[axis]!.reason.trim()) ||
      !review.evidence.length || review.evidence.some(item => !item.trim())) throw new Error(`Incomplete qualification evidence: ${key}`);
    byKey.set(key, review);
  }
  const rows = expected.map(row => {
    const review = byKey.get(row.key);
    return { ...row, status: review?.status ?? "not-run", qualified: review?.status === "complete" &&
      review.hardFailures.length === 0 && CONTINUITY_AXES.every(axis => review.axes[axis].passed),
      hardFailures: review?.hardFailures ?? [], reviewed: Boolean(review) };
  });
  const summarize = (selected: typeof rows) => {
    const passed = selected.filter(row => row.qualified).length;
    return { planned: selected.length, reviewed: selected.filter(row => row.reviewed).length, passed,
      rate: passed / selected.length, complete: selected.every(row => row.status === "complete") };
  };
  const confirmation = summarize(rows.filter(row => row.phase === "confirmation"));
  const worlds = Object.fromEntries((["blackmarsh", "station-program-world"] as const)
    .map(world => [world, summarize(rows.filter(row => row.phase === "confirmation" && row.world === world))])) as Record<ContinuityWorld, ReturnType<typeof summarize>>;
  const continuous = Object.fromEntries(cases.filter(item => item.phase === "continuous")
    .map(item => [item.id, summarize(rows.filter(row => row.caseId === item.id))]));
  const hardFailures = rows.flatMap(row => row.hardFailures.map(reason => ({ caseId: row.caseId, turn: row.turn, reason })));
  if (new Set(gates.map(gate => gate.id)).size !== gates.length || gates.some(gate =>
    !CONTINUITY_GATES.includes(gate.id) || typeof gate.passed !== "boolean" || !gate.evidence.trim())) throw new Error("Invalid qualification gate evidence");
  const unverifiedGates = CONTINUITY_GATES.filter(id => !gates.some(gate => gate.id === id && gate.passed));
  return { qualified: rows.every(row => row.reviewed) && hardFailures.length === 0 &&
    unverifiedGates.length === 0 && [confirmation, ...Object.values(worlds), ...Object.values(continuous)].every(group => group.rate >= 0.9),
    confirmation, worlds, continuous, hardFailures, unverifiedGates, rows };
}
