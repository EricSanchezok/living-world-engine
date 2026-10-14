import type {
  AgentState,
  ApparentClaim,
  ObservationPacket,
  SimulationState,
} from "../contracts/model";

export interface ObservationValidationIssue {
  code: string;
  path: Array<string | number>;
  message: string;
}

export class ObservationValidationError extends Error {
  constructor(readonly issues: readonly ObservationValidationIssue[]) {
    super(issues.map((issue) => issue.message).join("; "));
    this.name = "ObservationValidationError";
  }
}

function canonicalLocalIdentityIssues(
  state: Readonly<SimulationState>,
  packets: readonly ObservationPacket[],
): ObservationValidationIssue[] {
  return packets.flatMap((packet, packetIndex) => packet.introductions.flatMap((introduction, introductionIndex) => {
    const localId = introduction.localEntity.id;
    if (!state.truth.entities[localId]) return [];
    return [{
      code: "canonical_local_identity_collision",
      path: ["observations", packetIndex, "introductions", introductionIndex, "localEntity", "id"],
      message: `观察者 ${packet.observerId} 的 localEntity.id "${localId}" 与 canonicalTruth.entities 的保留 ID 冲突；请在该 Observation 内把它及 apparentClaims 中对它的引用统一改为新的观察者局部别名，不要仅为修复局部 ID 而改变 canonicalEntityId`,
    }];
  }));
}

function historicalObserverIdentityLedger(
  state: SimulationState,
  observerId: string,
): { localIds: Set<string>; claimBindings: Map<string, string> } {
  const localIds = new Set(Object.keys(state.historyBase?.agents[observerId]?.belief.localEntities ?? {}));
  const baseClaims = state.historyBase?.agents[observerId]?.belief.claims ?? {};
  const claimBindings = new Map(Object.values(baseClaims)
    .map((claim) => [claim.id, `${claim.subjectId}\u0000${claim.predicate}`]));
  for (const commit of state.bootstrapAgentCommits) {
    if (commit.agentId !== observerId) continue;
    for (const operation of commit.beliefPatch.operations) {
      if (operation.kind === "upsert_local_entity") localIds.add(operation.entity.id);
      if (operation.kind === "split_local_entity") {
        for (const entity of operation.entities) localIds.add(entity.id);
      }
      if (operation.kind === "upsert_claim") {
        claimBindings.set(operation.claim.id, `${operation.claim.subjectId}\u0000${operation.claim.predicate}`);
      }
    }
  }
  for (const committed of state.history) {
    for (const operation of committed.operations) {
      if (operation.kind !== "create_agent" || operation.agent.id !== observerId) continue;
      for (const id of Object.keys(operation.agent.belief.localEntities)) localIds.add(id);
      for (const claim of Object.values(operation.agent.belief.claims)) {
        claimBindings.set(claim.id, `${claim.subjectId}\u0000${claim.predicate}`);
      }
    }
    for (const observation of committed.observations) {
      if (observation.observerId !== observerId) continue;
      for (const introduction of observation.introductions) localIds.add(introduction.localEntity.id);
      for (const claim of observation.apparentClaims) {
        claimBindings.set(claim.id, `${claim.subjectId}\u0000${claim.predicate}`);
      }
    }
    for (const patch of committed.beliefPatches) {
      if (patch.agentId !== observerId) continue;
      for (const operation of patch.operations) {
        if (operation.kind === "upsert_local_entity") localIds.add(operation.entity.id);
        if (operation.kind === "split_local_entity") {
          for (const entity of operation.entities) localIds.add(entity.id);
        }
        if (operation.kind === "upsert_claim") {
          claimBindings.set(
            operation.claim.id,
            `${operation.claim.subjectId}\u0000${operation.claim.predicate}`,
          );
        }
      }
    }
  }
  const current = state.agents[observerId]?.belief;
  for (const id of Object.keys(current?.localEntities ?? {})) localIds.add(id);
  for (const claim of Object.values(current?.claims ?? {})) {
    claimBindings.set(claim.id, `${claim.subjectId}\u0000${claim.predicate}`);
  }
  return { localIds, claimBindings };
}

function assertLocalClaimReferences(
  localEntities: Record<string, unknown>,
  claim: ApparentClaim,
  packetId: string,
): void {
  if (!localEntities[claim.subjectId]) {
    throw new Error(`observation ${packetId} references unknown local subject ${claim.subjectId}; introduce that private local id in the same packet or use an existing observer-local id`);
  }
  if (claim.value.kind === "local_entity" && !localEntities[claim.value.localEntityId]) {
    throw new Error(`observation ${packetId} references unknown local value ${claim.value.localEntityId}; introduce that private local id in the same packet or use an existing observer-local id`);
  }
}

export function validateObservations(
  state: SimulationState,
  packets: readonly ObservationPacket[],
  expectedStep = state.step + 1,
): void {
  const identityIssues = canonicalLocalIdentityIssues(state, packets);
  if (identityIssues.length > 0) throw new ObservationValidationError(identityIssues);
  const ids = new Set(state.history.flatMap((committed) =>
    committed.observations.map((observation) => observation.id)));
  const localEntitiesByObserver = new Map<string, Record<string, unknown>>();
  const identityLedgers = new Map<string, ReturnType<typeof historicalObserverIdentityLedger>>();
  for (const packet of packets) {
    if (ids.has(packet.id)) throw new Error(`duplicate observation id ${packet.id}`);
    ids.add(packet.id);
    if (!packet.summary.trim()) throw new Error(`observation ${packet.id} has a blank summary`);
    if (!state.agents[packet.observerId]) {
      throw new Error(`observation ${packet.id} has unknown observer ${packet.observerId}`);
    }
    if (packet.step !== expectedStep) {
      throw new Error(`observation ${packet.id} targets step ${packet.step}; expected ${expectedStep}`);
    }
    let localEntities = localEntitiesByObserver.get(packet.observerId);
    if (!localEntities) {
      const existing = state.agents[packet.observerId].belief.localEntities;
      localEntities = { ...existing };
      localEntitiesByObserver.set(packet.observerId, localEntities);
    }
    let identityLedger = identityLedgers.get(packet.observerId);
    if (!identityLedger) {
      identityLedger = historicalObserverIdentityLedger(state, packet.observerId);
      identityLedgers.set(packet.observerId, identityLedger);
    }
    for (const introduction of packet.introductions) {
      if (identityLedger.localIds.has(introduction.localEntity.id)) {
        throw new Error(`observation ${packet.id} reintroduces local entity ${introduction.localEntity.id}`);
      }
      localEntities[introduction.localEntity.id] = introduction.localEntity;
      identityLedger.localIds.add(introduction.localEntity.id);
      if (introduction.canonicalEntityId && !state.truth.entities[introduction.canonicalEntityId]) {
        throw new Error(`observation ${packet.id} introduces unknown canonical entity`);
      }
    }
    for (const id of [packet.scene?.actorLocalId, packet.scene?.speech?.speakerLocalId,
      ...(packet.scene?.details.map(detail => detail.localEntityId) ?? [])]) {
      if (id && !localEntities[id]) throw new Error(`observation ${packet.id} has an unknown local scene reference`);
    }
    for (const claim of packet.apparentClaims) {
      const binding = `${claim.subjectId}\u0000${claim.predicate}`;
      if (identityLedger.claimBindings.has(claim.id)) {
        const prior = identityLedger.claimBindings.get(claim.id);
        if (prior !== binding) throw new Error(`observation ${packet.id} rebinds apparent claim ${claim.id}`);
        throw new Error(`observation ${packet.id} repeats apparent claim ${claim.id}`);
      }
      identityLedger.claimBindings.set(claim.id, binding);
      assertLocalClaimReferences(localEntities, claim, packet.id);
    }
    if (new Set(packet.sourceEventIds).size !== packet.sourceEventIds.length) {
      throw new Error(`observation ${packet.id} repeats a source event`);
    }
  }
}

export function applyObservationBindings(agent: AgentState, packets: readonly ObservationPacket[]): AgentState {
  const next = structuredClone(agent);
  for (const packet of packets) {
    for (const introduction of packet.introductions) {
      next.belief.localEntities[introduction.localEntity.id] = structuredClone(introduction.localEntity);
      if (!introduction.canonicalEntityId) continue;
      const current = next.bindings[introduction.localEntity.id];
      const canonicalEntityIds = new Set(current?.canonicalEntityIds ?? []);
      canonicalEntityIds.add(introduction.canonicalEntityId);
      next.bindings[introduction.localEntity.id] = {
        localEntityId: introduction.localEntity.id,
        canonicalEntityIds: [...canonicalEntityIds],
      };
    }
  }
  return next;
}

export function pendingObservationsFor(
  state: Readonly<SimulationState>,
  agent: Readonly<AgentState>,
  currentPackets: readonly ObservationPacket[] = [],
): ObservationPacket[] {
  const packets = [
    ...state.history.flatMap((step) => step.observations),
    ...currentPackets,
  ].filter((packet) => packet.observerId === agent.id && packet.step > agent.observationCursorStep);
  return [...new Map(packets.map((packet) => [packet.id, packet])).values()]
    .sort((left, right) => left.step - right.step || left.id.localeCompare(right.id))
    .map((packet) => structuredClone(packet));
}
