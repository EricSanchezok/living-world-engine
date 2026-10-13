import type { SimulationState } from "../contracts/model";

/** Timers, expiry and recurring physical effects are hard barriers on the single timeline. */
export function nextWorldClockBoundary(state: Readonly<SimulationState>): number | null {
  const times = [
    ...Object.values(state.truth.timers).filter(timer => timer.status === "scheduled").map(timer => timer.dueAtSeconds),
    ...Object.values(state.truth.conditions).flatMap(condition => condition.expiresAtElapsedSeconds === null ? [] : [condition.expiresAtElapsedSeconds]),
    ...Object.values(state.truth.conditions).flatMap(condition => condition.nextImpactAtElapsedSeconds === null ? [] : [condition.nextImpactAtElapsedSeconds]),
  ];
  return times.length ? Math.min(...times) : null;
}
