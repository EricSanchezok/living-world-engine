import type { ObservationPacket, SimulationState, TransitionProposal } from "../contracts/model";
import { referenceHandleFor } from "../contracts/model-context";

function observerVisibleCorpus(state: SimulationState, observerId: string): string {
  const values: string[] = [];
  const belief = state.agents[observerId]?.belief;
  if (!belief) return "";
  for (const entity of Object.values(belief.localEntities)) {
    values.push(entity.id, entity.name, entity.description);
  }
  for (const evidence of Object.values(belief.evidence)) {
    values.push(evidence.id, evidence.description, evidence.sourceId ?? "");
  }
  for (const claim of Object.values(belief.claims)) {
    values.push(claim.id, claim.subjectId, claim.predicate, claim.description);
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

function protectedTokens(state: SimulationState, observerId: string): readonly ProtectedToken[] {
  const tokens = new Map<string, ProtectedToken>();
  const visible = observerVisibleCorpus(state, observerId);
  const protect = (value: unknown, identifier = false): void => {
    if (typeof value !== "string") return;
    const normalized = value.trim().toLocaleLowerCase();
    const token = { value: normalized, identifier };
    if (normalized.length >= 3 && !containsToken(visible, token)) tokens.set(`${identifier}:${normalized}`, token);
  };

  for (const entityId of Object.keys(state.truth.entities)) protect(entityId, true);
  for (const fact of Object.values(state.truth.facts)) {
    if (fact.access.kind === "public") continue;
    protect(fact.id, true);
    protect(fact.description);
    if (fact.value.kind === "text") protect(fact.value.value);
    if (fact.value.kind === "entity") protect(fact.value.entityId, true);
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.id === observerId) continue;
    for (const profileId of Object.values(agent.modelProfiles)) protect(profileId, true);
    protect(agent.character.persona.summary);
    protect(agent.character.persona.voice);
    for (const collection of [
      agent.character.traits,
      agent.character.values,
      agent.character.emotions,
      agent.character.attitudes,
      agent.character.goals,
      agent.character.commitments,
    ]) {
      for (const record of Object.values(collection)) {
        protect(record.id, true);
        protect(record.description);
      }
    }
    for (const entity of Object.values(agent.belief.localEntities)) {
      // A local alias belongs to its Agent; an ordinary word such as "keep"
      // in another observer's prose does not identify that private entity.
      protect(referenceHandleFor("local_entity", `${agent.id}::${entity.id}`), true);
      protect(entity.description);
    }
    for (const claim of Object.values(agent.belief.claims)) {
      protect(claim.id, true);
      protect(claim.description);
      if (claim.value.kind === "text") protect(claim.value.value);
      if (claim.value.kind === "local_entity") protect(referenceHandleFor("local_entity", `${agent.id}::${claim.value.localEntityId}`), true);
    }
  }
  return [...tokens.values()];
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
    if (!state.agents[observerId]) throw new Error(`observation targets unknown agent ${observerId}`);
    const packets = proposal.observations.filter((packet) => packet.observerId === observerId);
    const text = packets.map(publicText).join("\n");
    for (const token of protectedTokens(state, observerId)) {
      if (containsToken(text, token)) throw new Error(`observation for ${observerId} contains protected information`);
    }
  }
}
