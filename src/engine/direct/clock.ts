import type { SimulationState } from "../contracts/model";
import { nextPeriodicBoundary } from "../mechanics/periodic-properties";

/** Timers, expiry and recurring physical effects are hard barriers on the single timeline. */
export function nextWorldClockBoundary(state: Readonly<SimulationState>): number | null {
  const times = [
    ...Object.values(state.truth.mechanics.periodicProperties).map(property => nextPeriodicBoundary(property, state.truth.elapsedSeconds)),
    ...Object.values(state.truth.timers).filter(timer => timer.status === "scheduled").map(timer => timer.dueAtSeconds),
    ...Object.values(state.truth.conditions).flatMap(condition => condition.expiresAtElapsedSeconds === null ? [] : [condition.expiresAtElapsedSeconds]),
    ...Object.values(state.truth.conditions).flatMap(condition => condition.nextImpactAtElapsedSeconds === null ? [] : [condition.nextImpactAtElapsedSeconds]),
  ];
  return times.length ? Math.min(...times) : null;
}
