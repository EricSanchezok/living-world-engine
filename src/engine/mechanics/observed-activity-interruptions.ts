import type { AgentActionProposal, CausalRef, ObservationPacket } from "../contracts/model";

type CausalNode = { id: string; causes: readonly CausalRef[] };
type InterruptionEvidence = {
  actions: readonly Pick<AgentActionProposal, "id" | "actorId">[];
  requests: readonly CausalNode[];
  randomRequests: readonly CausalNode[];
  proposal: {
    events: readonly CausalNode[];
    mechanicInvocations: readonly CausalNode[];
    observations: readonly Pick<ObservationPacket, "observerId" | "sourceEventIds">[];
  };
};

/** Post-boundary event interruptions; onset decisions are already applied before this boundary. See decision 0211. */
export function observedExternalInterruptions(resolution: InterruptionEvidence): ReadonlySet<string> {
  const observers = new Set<string>();
  const actors = new Map(resolution.actions.map(action => [action.id, action.actorId]));
  const sources = new Map<string, readonly CausalRef[]>();
  for (const [kind, rows] of [
    ["event", resolution.proposal.events], ["check", resolution.requests],
    ["random", resolution.randomRequests], ["mechanic", resolution.proposal.mechanicInvocations],
  ] as const) for (const row of rows) sources.set(`${kind}:${row.id}`, row.causes);
  const eventActors = new Map<string, ReadonlySet<string>>();
  const actorsForEvent = (eventId: string): ReadonlySet<string> => {
    const cached = eventActors.get(eventId);
    if (cached) return cached;
    const result = new Set<string>(), seen = new Set<string>();
    const pending: CausalRef[] = [{ kind: "event", id: eventId }];
    while (pending.length) {
      const ref = pending.pop()!, key = `${ref.kind}:${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ref.kind === "action") {
        const actor = actors.get(ref.id);
        if (actor) result.add(actor);
      } else pending.push(...sources.get(key) ?? []);
    }
    eventActors.set(eventId, result);
    return result;
  };
  for (const packet of resolution.proposal.observations) {
    if (packet.sourceEventIds.some(id => [...actorsForEvent(id)].some(actor => actor !== packet.observerId))) {
      observers.add(packet.observerId);
    }
  }
  return observers;
}
