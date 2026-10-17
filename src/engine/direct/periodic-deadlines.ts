import type { SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import { periodicFact } from "../mechanics/periodic-properties";

/** Public local schedules are rules, not permission to inspect a hidden current value. */
export function periodicDeadlineCandidates(state: Readonly<SimulationState>, agentId: string, anchorSeconds: number, occurrences: readonly number[]) {
  const agent = state.agents[agentId]!;
  const ancestry: string[] = [];
  for (let place = state.truth.placements[agent.entityId]; place && !ancestry.includes(place); place = state.truth.placements[place]) ancestry.push(place);
  const seen = new Set<string>();
  return Object.values(state.truth.mechanics.periodicProperties)
    .filter(property => property.access.kind === "public" && ancestry.includes(property.subjectId))
    .sort((a, b) => ancestry.indexOf(a.subjectId) - ancestry.indexOf(b.subjectId) || a.id.localeCompare(b.id))
    .flatMap(property => {
      const signature = contentHash({ predicate: property.predicate, period: property.periodSeconds,
        initial: property.initialPhaseSeconds, phases: property.phases });
      if (seen.has(signature)) return [];
      seen.add(signature);
      const binding = Object.values(agent.bindings).find(item => item.canonicalEntityIds.length === 1 && item.canonicalEntityIds[0] === property.subjectId);
      const subject = binding ? agent.belief.localEntities[binding.localEntityId]?.name ?? "local surroundings" : "local surroundings";
      const period = BigInt(property.periodSeconds), anchor = BigInt(anchorSeconds);
      const initial = BigInt(property.initialPhaseSeconds);
      const cycle = (anchor + initial) / period;
      const offset = (anchor + initial) % period;
      return property.phases.flatMap((phase, phaseIndex) => occurrences.map(occurrence => {
        let until = (BigInt(phase.startsAtSeconds) - offset + period) % period;
        if (until === BigInt(0)) until = period;
        const at = anchor + until + BigInt(occurrence - 1) * period;
        const representable = at <= BigInt(Number.MAX_SAFE_INTEGER);
        const remaining = representable ? Number(at) - state.truth.elapsedSeconds : null;
        const cycleOffset = (at + initial) / period - cycle;
        return { subject, predicate: property.predicate, occurrence,
          requestCycle: { index: Number(cycle), positionSeconds: Number(offset), beginsWith: property.phases[0]!.description },
          endpointCycle: { offsetFromRequestCycle: cycleOffset <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(cycleOffset) : null,
            meaning: cycleOffset === BigInt(0) ? "The same cycle as this request."
              : cycleOffset === BigInt(1) ? "The following cycle after this request's cycle."
                : `${cycleOffset} cycles after this request's cycle.` },
          currentPhase: periodicFact(property, state.truth.elapsedSeconds).description,
          transition: { from: property.phases[(phaseIndex + property.phases.length - 1) % property.phases.length]!.description,
            to: phase.description, startsAtSeconds: phase.startsAtSeconds },
          endpoint: "At this boundary the from phase ends and the to phase begins.",
          occurrenceMeaning: occurrence === 1 ? "The next such transition after this request began."
            : `The ${occurrence}th such transition after this request began; ${occurrence - 1} complete cycles after its next occurrence.`,
          phaseAtRequest: periodicFact(property, anchorSeconds).description, periodSeconds: property.periodSeconds,
          deadlineAtSeconds: representable ? Number(at) : null,
          seconds: remaining !== null && remaining > 0 ? remaining : null,
          availability: !representable ? "outside exact clock range" : remaining! <= 0 ? "already reached during this request" : "future public phase" };
      }));
    });
}

/** Interpret the selected public transition only; the reference supplies its cycle or occurrence. */
export function periodicDeadlineSeconds(candidate: ReturnType<typeof periodicDeadlineCandidates>[number] | undefined,
  reference: { basis: string; count: number | null } | null, anchorSeconds: number, elapsedSeconds: number): number | null {
  if (!candidate || !reference || reference.count === null || !Number.isSafeInteger(reference.count) || reference.count < 0) return null;
  const period = BigInt(candidate.periodSeconds), anchor = BigInt(anchorSeconds), offset = BigInt(candidate.requestCycle.positionSeconds);
  const phase = BigInt(candidate.transition.startsAtSeconds), count = BigInt(reference.count);
  let at: bigint;
  if (reference.basis === "relative_cycle") at = anchor - offset + count * period + phase;
  else if (reference.basis === "phase_occurrence" && reference.count >= 1) {
    let until = (phase - offset + period) % period;
    if (until === BigInt(0)) until = period;
    at = anchor + until + (count - BigInt(1)) * period;
  } else return null;
  return at > BigInt(elapsedSeconds) && at <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(at) - elapsedSeconds : null;
}
