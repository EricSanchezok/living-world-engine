import type { SimulationState } from "../contracts/model";
import type { ActionFrame, DirectRuntimeState } from "./contracts";

/** Capacity is reserved in stable admission order; a queue never changes an already running lease. */
export function admitActivities(state: Readonly<SimulationState>, control: DirectRuntimeState) {
  const used = new Map<string, number>();
  const frames = control.activities.slice().sort((a, b) => Number(a.activityStatus !== "active") - Number(b.activityStatus !== "active") ||
    a.startedAtSeconds - b.startedAtSeconds || a.id.localeCompare(b.id));
  for (const frame of frames) {
    const preparation = control.prepared[frame.id]; if (!preparation) continue;
    if (!Number.isSafeInteger(frame.durationSeconds) || frame.durationSeconds < 1) throw new Error("An activity requires adjudicated positive duration");
    const claims = preparation.sharedClaims;
    if (frame.activityStatus === "paused") {
      for (const claim of claims) {
        const pool = state.truth.sharedActivityResourcePools[claim.poolId]!;
        if (state.truth.mechanics.sharedActivityResources[pool.definitionId]!.pausedRetention === "retain") used.set(pool.id, (used.get(pool.id) ?? 0) + claim.amount);
      }
      continue;
    }
    const fits = claims.every(claim => {
      const pool = state.truth.sharedActivityResourcePools[claim.poolId];
      return pool && state.truth.entities[pool.entityId]?.lifecycle === "active" && (used.get(pool.id) ?? 0) + claim.amount <= pool.capacity;
    });
    if (!fits) {
      const queueable = claims.every(claim => {
        const pool = state.truth.sharedActivityResourcePools[claim.poolId];
        return pool && state.truth.mechanics.sharedActivityResources[pool.definitionId]!.contention === "queue" && claim.amount <= pool.capacity;
      });
      if (queueable) { frame.activityStatus = "queued"; continue; }
      preparation.status = "blocked"; preparation.summary = "所需共享资源当前不可用。";
      preparation.operations = []; preparation.randomRequests = []; preparation.randomBindings = []; preparation.sharedClaims = [];
      frame.activityStatus = "active"; frame.dueAtSeconds = state.truth.elapsedSeconds + 1;
      continue;
    }
    if (frame.activityStatus === "queued") {
      frame.startedAtSeconds = state.truth.elapsedSeconds; frame.dueAtSeconds = state.truth.elapsedSeconds + frame.durationSeconds;
      frame.activityStatus = "active"; frame.progressSeconds = 0;
    }
    for (const claim of claims) used.set(claim.poolId, (used.get(claim.poolId) ?? 0) + claim.amount);
  }
}

export function activityBoundary(frame: ActionFrame): number[] {
  return frame.activityStatus === "active" && frame.dueAtSeconds !== null ? [frame.dueAtSeconds] : [];
}
