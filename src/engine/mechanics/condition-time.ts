import type { CausalRef, SimulationState, WorldDeltaOperation } from "../contracts/model";
import { deriveClampedMeterDelta, type ConditionState } from "./resolution";

/** Periodic effects depend only on authored cadence and persisted due times, never the number of steps. */
export function deriveConditionAdvance(input: {
  state: Readonly<SimulationState>;
  endElapsedSeconds: number;
  conditions?: readonly ConditionState[];
  meterCurrents?: ReadonlyMap<string, number>;
  causes?: CausalRef[];
}): WorldDeltaOperation[] {
  const { state, endElapsedSeconds: end } = input;
  if (!Number.isSafeInteger(end) || end <= state.truth.elapsedSeconds) throw new Error("condition time must advance");
  const currents = new Map(input.meterCurrents ?? Object.values(state.truth.meters).map(meter => [meter.id, meter.current]));
  const conditions = [...(input.conditions ?? Object.values(state.truth.conditions))].sort((a, b) => a.id.localeCompare(b.id));
  const operations: WorldDeltaOperation[] = [];
  const pending = conditions.filter(condition => condition.nextImpactAtElapsedSeconds !== null).map(condition => {
    const profile = condition.conditionProfileId ? state.truth.mechanics.conditionProfiles[condition.conditionProfileId] : null;
    const interval = profile?.recurringIntervalSeconds, impact = profile?.recurringImpactProfileId
      ? state.truth.mechanics.impactProfiles[profile.recurringImpactProfileId] : null;
    if (!interval || !Number.isSafeInteger(interval) || interval <= 0 || !impact) throw new Error("recurring condition requires an authored cadence and impact");
    const meter = Object.values(state.truth.meters).find(value => value.entityId === condition.subjectId && value.definitionId === impact.meterDefinitionId);
    const definition = meter ? state.truth.mechanics.meters[meter.definitionId] : null;
    if (!meter || !definition) throw new Error(`condition ${condition.id} has no meter for recurring impact`);
    return { condition, interval, impact, meter, definition, next: condition.nextImpactAtElapsedSeconds!,
      limit: Math.min(end, condition.expiresAtElapsedSeconds ?? end) };
  });
  // Stable time/identity order preserves clamping when several increasing/decreasing effects share a meter.
  while (true) {
    const work = pending.filter(value => value.next <= value.limit).sort((a, b) => a.next - b.next || a.condition.id.localeCompare(b.condition.id))[0];
    if (!work) break;
    const { condition, meter, definition, impact } = work;
    const current = currents.get(meter.id);
    if (current === undefined) throw new Error("recurring impact has no projected meter");
    const magnitude = impact.amounts[condition.magnitude];
    const amount = deriveClampedMeterDelta(current, definition.min, definition.max, impact.direction === "increase" ? magnitude : -magnitude);
    if (amount !== 0) {
      operations.push({ kind: "adjust_meter", meterId: meter.id, amount, causes: structuredClone(input.causes ?? condition.provenance),
        assertions: [{ kind: "meter_compare", meterId: meter.id, operator: "eq", value: current }] });
      currents.set(meter.id, current + amount);
    }
    work.next += work.interval;
    if (!Number.isSafeInteger(work.next)) throw new Error("recurring condition time overflow");
  }
  for (const condition of conditions) {
    const causes = structuredClone(input.causes ?? condition.provenance);
    const assertions = [{ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value: state.truth.elapsedSeconds }];
    if (condition.expiresAtElapsedSeconds !== null && condition.expiresAtElapsedSeconds <= end) {
      operations.push({ kind: "remove_condition", conditionId: condition.id, causes, assertions });
    } else {
      const work = pending.find(value => value.condition.id === condition.id);
      if (work && work.next !== condition.nextImpactAtElapsedSeconds) operations.push({ kind: "set_condition",
        condition: { ...structuredClone(condition), nextImpactAtElapsedSeconds: work.next }, causes, assertions });
    }
  }
  return operations;
}
