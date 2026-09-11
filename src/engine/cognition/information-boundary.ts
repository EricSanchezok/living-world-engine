import type { AgentState, ApparentClaim, BeliefValue, ObservationPacket, SimulationState, TransitionProposal, WorldFact } from "../contracts/model";
import { referenceHandleFor } from "../contracts/model-context";

function characterRecords(agent: AgentState) {
  return ([
    ["character_facet", agent.character.traits],
    ["character_facet", agent.character.values],
    ["emotion", agent.character.emotions],
    ["attitude", agent.character.attitudes],
    ["goal", agent.character.goals],
    ["commitment", agent.character.commitments],
  ] as const).flatMap(([kind, collection]) => Object.values(collection).map(record => ({
    handle: referenceHandleFor(kind, record.id), description: record.description,
  })));
}

function observerVisibleCorpus(state: SimulationState, observerId: string): string {
  const values: string[] = [];
  const agent = state.agents[observerId];
  if (!agent) return "";
  const belief = agent.belief;
  values.push(agent.character.persona.summary, agent.character.persona.voice);
  for (const record of characterRecords(agent)) values.push(record.handle, record.description);
  for (const entity of Object.values(belief.localEntities)) {
    values.push(entity.id, entity.name, entity.description);
  }
  for (const evidence of Object.values(belief.evidence)) {
    values.push(evidence.id, evidence.description, evidence.sourceId ?? "");
  }
  for (const claim of Object.values(belief.claims)) {
    values.push(claim.id, referenceHandleFor("claim", claim.id), claim.subjectId, claim.predicate, claim.description);
    if (claim.value.kind === "text") values.push(claim.value.value);
    if (claim.value.kind === "local_entity") values.push(claim.value.localEntityId);
  }
  return values.join("\n").toLocaleLowerCase();
}

interface ProtectedToken { value: string; identifier: boolean }

function containsToken(text: string, token: ProtectedToken): boolean {
  if (!token.identifier) return text.includes(token.value);
  // Script identifiers must not match inside unrelated words (thil/foothills).
  // Keep punctuation, reference syntax and surrounding CJK prose as boundaries.
  const identifierLetter = /[a-z0-9_]/u;
  for (let index = text.indexOf(token.value); index !== -1; index = text.indexOf(token.value, index + 1)) {
    if (!identifierLetter.test(text[index - 1] ?? "") &&
      !identifierLetter.test(text[index + token.value.length] ?? "")) return true;
  }
  return false;
}

function protectedTokens(state: SimulationState, observerId: string, privateFacts: readonly WorldFact[]): readonly ProtectedToken[] {
  const tokens = new Map<string, ProtectedToken>();
  const visible = observerVisibleCorpus(state, observerId);
  const protect = (value: unknown, identifier = false): void => {
    if (typeof value !== "string") return;
    const normalized = value.trim().toLocaleLowerCase();
    const token = { value: normalized, identifier };
    if (normalized.length >= 3 && !containsToken(visible, token)) tokens.set(`${identifier}:${normalized}`, token);
  };

  for (const entityId of Object.keys(state.truth.entities)) protect(entityId, true);
  for (const fact of privateFacts) {
    protect(fact.id, true);
    protect(fact.description);
    if (fact.value.kind === "entity") protect(fact.value.entityId, true);
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.id === observerId) continue;
    for (const profileId of Object.values(agent.modelProfiles)) protect(profileId, true);
    protect(agent.character.persona.summary);
    protect(agent.character.persona.voice);
    for (const record of characterRecords(agent)) {
      protect(record.handle, true);
      protect(record.description);
    }
    for (const entity of Object.values(agent.belief.localEntities)) {
      // A local alias belongs to its Agent; an ordinary word such as "keep"
      // in another observer's prose does not identify that private entity.
      protect(referenceHandleFor("local_entity", `${agent.id}::${entity.id}`), true);
      protect(entity.description);
    }
    for (const claim of Object.values(agent.belief.claims)) {
      protect(referenceHandleFor("claim", claim.id), true);
      protect(claim.description);
      if (claim.value.kind === "local_entity") protect(referenceHandleFor("local_entity", `${agent.id}::${claim.value.localEntityId}`), true);
    }
  }
  return [...tokens.values()];
}

function canonicalBindings(agent: AgentState, introductions: ObservationPacket["introductions"] = []) {
  const bindings = new Map(Object.values(agent.bindings).map(binding =>
    [binding.localEntityId, new Set(binding.canonicalEntityIds)] as const));
  for (const introduction of introductions) {
    if (introduction.canonicalEntityId === null) continue;
    const id = introduction.localEntity.id;
    const targets = bindings.get(id) ?? new Set<string>();
    targets.add(introduction.canonicalEntityId);
    bindings.set(id, targets);
  }
  // A multi-entity alias is not evidence identifying any one private subject.
  return (localId: string): string | undefined => {
    const targets = bindings.get(localId);
    return targets?.size === 1 ? targets.values().next().value : undefined;
  };
}

function matchesPrivateValue(value: BeliefValue, fact: WorldFact, canonical: (localId: string) => string | undefined): boolean {
  switch (fact.value.kind) {
    case "entity": return value.kind === "local_entity" && canonical(value.localEntityId) === fact.value.entityId;
    case "none": return value.kind === "none";
    default: return value.kind === fact.value.kind && value.value === fact.value.value;
  }
}

function matchesPrivateFact(claim: Pick<ApparentClaim, "subjectId" | "predicate" | "value">, fact: WorldFact,
  canonical: (localId: string) => string | undefined): boolean {
  return canonical(claim.subjectId) === fact.subjectId && claim.predicate === fact.predicate &&
    matchesPrivateValue(claim.value, fact, canonical);
}

function inaccessibleFacts(state: SimulationState, agent: AgentState): WorldFact[] {
  const canonical = canonicalBindings(agent);
  const known = Object.values(agent.belief.claims);
  return Object.values(state.truth.facts).filter(fact => fact.access.kind !== "public" &&
    !(fact.access.kind === "agents" && fact.access.agentIds.includes(agent.id)) &&
    !known.some(claim => matchesPrivateFact(claim, fact, canonical)));
}

function publicText(packet: Pick<ObservationPacket, "summary" | "introductions" | "apparentClaims">): string {
  const values = [packet.summary];
  for (const introduction of packet.introductions) {
    values.push(introduction.localEntity.name, introduction.localEntity.description);
  }
  for (const claim of packet.apparentClaims) {
    values.push(claim.description);
    if (claim.value.kind === "text") values.push(claim.value.value);
  }
  return values.join("\n").toLocaleLowerCase();
}

export function validatePublicInformationBoundary(
  state: SimulationState,
  actions: readonly { id: string; actorId: string }[],
  proposal: TransitionProposal,
): void {
  for (const observerId of new Set(proposal.observations.map((packet) => packet.observerId))) {
    const agent = state.agents[observerId];
    if (!agent) throw new Error(`observation targets unknown agent ${observerId}`);
    const packets = proposal.observations.filter((packet) => packet.observerId === observerId);
    const privateFacts = inaccessibleFacts(state, agent);
    const text = packets.map(publicText).join("\n");
    for (const token of protectedTokens(state, observerId, privateFacts)) {
      if (containsToken(text, token)) throw new Error(`observation for ${observerId} contains protected information`);
    }
    for (const packet of packets) {
      const canonical = canonicalBindings(agent, packet.introductions);
      for (const claim of packet.apparentClaims) {
        if (privateFacts.some(fact => matchesPrivateFact(claim, fact, canonical))) {
          throw new Error(`observation for ${observerId} contains protected information`);
        }
      }
    }
  }
}
