import type { ObservationPacket } from "../../engine/contracts/model";
import type { ParticipantDiscourse } from "../../engine/contracts/discourse";
import type { ScenePacket } from "./contracts";

/** An expression is an attempted procedure, not a receipt for its physical verbs. */
export function executedDescription(observation: Pick<ObservationPacket, "summary" | "scene">): string {
  if (!observation.scene) return observation.summary;
  return [observation.scene.outcome, ...observation.summary.split("\n").slice(1)].filter(Boolean).join("\n");
}

/** The audit retains attempted actions; prose receives their actually executed part. */
export function narrativeEvidence(source: ScenePacket) {
  const { requestedAction: _request, ...evidence } = source;
  void _request;
  const observed = <T extends ScenePacket["observations"][number]>(observation: T) => ({ ...observation,
    summary: executedDescription({ ...observation, scene: observation.scene ?? undefined }),
    scene: observation.scene ? { ...observation.scene,
      attempt: observation.scene.actionKind !== "speak" ? observation.scene.attempt : null } : null,
  });
  return { ...evidence,
    memories: source.reply ? source.memories.map(memory => ({ kind: memory.kind, description: memory.executedDescription ?? memory.description })) : [],
    observations: source.observations.map(observed),
    ...(source.priorObservedReceipts ? { priorObservedReceipts: source.priorObservedReceipts.map(observed) } : {}),
  };
}

/** A publication task separates new receipts from the prose used to resolve references. */
export function narrativeTask(source: ScenePacket, discourse?: ParticipantDiscourse) {
  return {
    viewpoint: "The participant is the player. Address their character as you in second person; other characters remain third person.",
    responseTo: source.reply?.requested ?? null,
    kind: source.reply?.kind ?? "newly_observed_events",
    ownSpeechOnly: source.observations.length > 0 && source.observations.every(observation =>
      observation.scene?.actor === "你" && observation.scene.actionKind === "speak"),
    executionBoundary: source.reply ? {
      newPhysicalEffects: false, newSpeech: false, elapsedWorldTime: false,
      explanation: source.reply.reason,
      scope: "Only this failed or explanatory boundary; earlier observed events retain their actual actors and effects. Only participant_step belongs to this request; caused_response is another actor responding through recorded causality; concurrent_event is independent; unattributed has no established request relation.",
      originalRequest: source.reply.requested,
      earlierObservedEvents: (source.priorObservedReceipts ?? []).map(observation => ({
        requestRelation: observation.requestRelation,
        actor: observation.scene?.actor ?? null, actorLocalId: observation.scene?.actorLocalId ?? null,
        operation: observation.scene?.actionKind ?? null, action: observation.scene?.action ?? null,
        status: observation.scene?.status ?? null, worldTimeSeconds: observation.worldTimeSeconds,
        actualResult: executedDescription({ ...observation, scene: observation.scene ?? undefined }),
      })),
    } : null,
    newReceipts: source.observations.map(observation => ({ id: observation.id,
      actor: observation.scene?.actor ?? null, actorLocalId: observation.scene?.actorLocalId ?? null,
      operation: observation.scene?.actionKind ?? null, status: observation.scene?.status ?? null,
      action: observation.scene?.action ?? null,
      currentMethodOrAttention: observation.scene?.actionKind !== "speak" ? observation.scene?.attempt ?? null : null,
      manner: observation.scene?.manner ?? null,
      actualResult: executedDescription({ ...observation, scene: observation.scene ?? undefined }) })),
    actionBoundary: "These receipts are the complete new action record. Earlier prose is not a new action. No extra gesture, movement, reaction or physical completion is implied by fluent dialogue or by an object's suitability for use.",
    evidenceBoundary: "A partial outcome establishes only its listed effects and observations. It supplies no unstated cause or degree of success. No delivered report means the result is unknown, not that nobody acted or the other person lacks knowledge. A delivered instruction establishes that its actor spoke, not that the requested payment or work occurred. Earlier prose can resolve references but cannot establish a world fact.",
    playerCurrentHoldings: source.currentHoldings?.quantities.map(quantity => `You currently hold ${quantity.amount} ${quantity.unit} of ${quantity.name}.`) ?? [],
    backgroundUse: "Holdings and old properties constrain accuracy; mention them only when they answer the current request or changed in the new receipts.",
    newSpeech: source.speech,
    speechOrder: source.speech.map(speech => ({ reference: `[[${speech.id}]]`, speaker: speech.speaker })),
    publishedForThisRequest: discourse?.exchanges.filter(exchange => exchange.submissionId === source.submissionId)
      .flatMap(exchange => exchange.paragraphs.map(paragraph => paragraph.text)) ?? [],
    firstAppearances: source.knownEntities.filter(entity => !discourse?.entities.some(known => known.localEntityId === entity.localEntityId))
      .map(entity => ({ ...entity, instruction: "If this entity is mentioned, introduce it intelligibly; the reader has not met it in published prose." })),
  };
}

/** Published words resolve references; historic player requests are not new execution evidence. */
export function narrativeDiscourse(discourse: ParticipantDiscourse) {
  return { ...discourse, exchanges: discourse.exchanges.map(({ requested: _requested, ...exchange }) => {
    void _requested; return exchange;
  }), unresolved: discourse.unresolved.map(({ requested: _requested, ...item }) => { void _requested; return item; }) };
}
