import type { SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { DecisionUse } from "../programs/decision-runtime";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { nextWorldClockBoundary } from "./clock-boundary";
import { activeRandomReservation, validateRandomReservation, validateWorldRandomness } from "./randomness";
import { programWorldResources } from "./resources";
import { sealDecisionEventState, type DecisionEventState } from "./runtime-state";
import { EventScheduler } from "./scheduler";

/** A control commit consumes RNG before any model can inspect its outcome. */
export function settleRandomReservation(source: Readonly<SimulationState>, prepared: DecisionEventState,
  authority: WorldRuntimeContract, decisions: DecisionUse[]) {
  const state = structuredClone(source) as SimulationState, reservation = prepared.randomReservation;
  if (!reservation || activeRandomReservation(source)) return { state, control: prepared };
  validateRandomReservation(reservation);
  const scheduler = new EventScheduler(source.truth.elapsedSeconds, prepared.scheduler);
  const times = [scheduler.nextTime, nextWorldClockBoundary(source)].filter((time): time is number => time !== null);
  if (reservation.sourceRevision !== source.revision || !times.length || reservation.atSeconds !== Math.min(...times) ||
    reservation.atSeconds <= source.truth.elapsedSeconds) throw new Error("random reservation is outside the actual pending frontier");
  const programs = prepared.pending.filter(pending => pending.bound && !pending.failure && pending.atSeconds === reservation.atSeconds).map(pending => pending.bound!);
  validateWorldRandomness(source, authority, prepared.worldResources, programs, reservation.commitment);
  if (!decisions.some(use => contentHash(use.batch) === contentHash(reservation.commitment.plan.batch) &&
    contentHash(use.result) === contentHash(reservation.commitment.authorization))) throw new Error("random reservation lacks its actual authorization call");
  state.truth.rng = structuredClone(reservation.commitment.after);
  const control = sealDecisionEventState({ ...prepared,
    worldResources: programWorldResources(state, authority, prepared.activities, prepared.worldResources) });
  return { state, control };
}
