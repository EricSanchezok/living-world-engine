import type { ObservationPacket } from "../../engine/contracts/model";
import type { ParticipantDiscourse } from "../../engine/contracts/discourse";
import type { ScenePacket } from "./contracts";

/** An expression is an attempted procedure, not a receipt for its physical verbs. */
export function executedDescription(observation: Pick<ObservationPacket, "summary" | "scene">): string {
  if (!observation.scene) return observation.summary;
  if (observation.scene.actionKind === "observe" && ["succeeded", "partial"].includes(observation.scene.status)) {
    return [...new Set([observation.scene.outcome, ...observation.summary.split("\n")].filter(Boolean))].join("\n");
  }
  return [observation.scene.outcome, ...observation.summary.split("\n").slice(1)].filter(Boolean).join("\n");
}

/** The audit retains attempted actions; prose receives their actually executed part. */
export function narrativeEvidence(source: ScenePacket) {
  // The publication task owns the earlier-request receipts. Keeping their raw
  // scene packets here made a repair mistake the whole request for the new beat.
  const { requestedAction: _request, priorObservedReceipts: _prior, ...evidence } = source;
  void _request; void _prior;
  return { ...evidence,
    memories: source.reply ? source.memories.map(memory => ({ kind: memory.kind, description: memory.executedDescription ?? memory.description })) : [],
    observations: source.observations.map(observation => ({ ...observation,
      summary: observation.scene?.actionKind === "speak" ? observation.summary.split("\n").slice(1).join("\n") || null : executedDescription({ ...observation, scene: observation.scene ?? undefined }),
      spokenDeliveryRecord: observation.scene?.actionKind === "speak" ? observation.scene.outcome : null,
      scene: observation.scene ? { ...observation.scene,
        outcome: observation.scene.actionKind === "speak" ? null : observation.scene.outcome,
        attempt: observation.scene.actionKind !== "speak" ? observation.scene.attempt : null } : null,
    })),
  };
}

function priorReceipt(observation: ScenePacket["observations"][number] & { requestRelation?: NonNullable<ScenePacket["priorObservedReceipts"]>[number]["requestRelation"] }) {
  return { id: observation.id, ...(observation.requestRelation ? { requestRelation: observation.requestRelation } : {}), actor: observation.scene?.actor ?? null, actorLocalId: observation.scene?.actorLocalId ?? null,
    operation: observation.scene?.actionKind ?? null, action: observation.scene?.action ?? null,
    status: observation.scene?.status ?? null, worldTimeSeconds: observation.worldTimeSeconds,
    manner: observation.scene?.manner ?? null, details: observation.scene?.details ?? [],
    deliveredSpeech: observation.scene?.speech ?? null,
    actualResult: observation.scene?.actionKind === "speak" ? observation.summary.split("\n").slice(1).join("\n") || null : executedDescription({ ...observation, scene: observation.scene ?? undefined }) };
}

/** Arithmetic scale is separate from observed weather or calendar transitions. */
function elapsedReceipts(source: ScenePacket) {
  const units = new Map<number, string[]>();
  for (const [term, seconds] of Object.entries(source.elapsedUnits)) {
    const terms = units.get(seconds) ?? []; terms.push(term); units.set(seconds, terms);
  }
  const ordered = [...units].sort(([left], [right]) => left - right);
  return source.observations.flatMap(observation => {
    const duration = observation.scene?.action?.durationSeconds;
    if (!duration || observation.scene?.actionKind === "speak") return [];
    const firstLarger = ordered.find(([seconds]) => seconds > duration)?.[0];
    return [{ observationId: observation.id, durationSeconds: duration,
      fromWorldTimeSeconds: observation.worldTimeSeconds - duration, toWorldTimeSeconds: observation.worldTimeSeconds,
      equivalents: ordered.filter(([seconds]) => seconds > 1 && (seconds <= duration || seconds === firstLarger))
        .map(([seconds, terms]) => ({ terms, secondsPerUnit: seconds,
          wholeUnits: Math.floor(duration / seconds), remainderSeconds: duration % seconds,
          approximateUnits: Number((duration / seconds).toPrecision(6)) })) }];
  });
}

/** A publication task separates new receipts from the prose used to resolve references. */
export function narrativeTask(source: ScenePacket, discourse?: ParticipantDiscourse) {
  return {
    viewpoint: "The participant is the player. Address their character as you in second person; other characters remain third person.",
    responseTo: source.reply?.requested ?? null,
    kind: source.reply?.kind ?? "newly_observed_events",
    time: { boundary: source.boundary, elapsedUnits: source.elapsedUnits, elapsedReceipts: elapsedReceipts(source), observedPeriodicTransitions: source.observedPeriodicTransitions,
      interpretation: "Action durations are elapsed seconds. Convert only with these exact local term-to-seconds values; an hour and an authored traditional unit are not interchangeable. Local days may differ from 24 hours. A stopping condition can end an activity before its requested duration; state only the actual elapsed receipt. The supplied equivalents are arithmetic, not sightings of a sun or moon. observedPeriodicTransitions certifies an already observed public phase transition exactly at its recorded boundary, including the start of that phase rather than merely some time within it. Calendar phases are observed properties, not inferred from a generic day length; even a long elapsed interval can remain within one local night or a place with constant light." },
    spatialEvidence: { participantLocation: source.location, nonSpeechReceipts: source.observations.filter(observation => observation.scene?.actionKind !== "speak").map(priorReceipt),
      interpretation: "Actual non-speech outcomes and observed properties establish presence and movement, including movement caused by another operation. Delivered requests to bring, summon or visit someone do not locate that person. Their implied premises remain the speaker's view, not an independently established absence. No recorded arrival proves only that no arrival is established, not that the person is absent. A newly heard or mentioned person may already be present; earlier prose supplies no independent movement evidence." },
    propertyHistory: { observations: source.observedProperties ?? [],
      interpretation: "These are last-known properties of separate local subjects, with their actual evidence boundary when available. They do not all describe the current location or current time. New receipts supersede older observations of the same subject; a prior night's description or another place's older state cannot override a fresh observation here. No new observation means the present property may remain unknown." },
    alreadyObservedForThisRequest: (source.priorObservedReceipts ?? []).map(priorReceipt),
    priorReceiptBoundary: "These earlier participant observations occurred in this request window, not necessarily because of the request. Their requestRelation distinguishes participant steps, causally related responses, independent concurrent events and unattributed events. Preserve each actual actor, action and delivered reply when describing the current result; they are not new events or new speech to repeat. A later completion can add elapsed time without erasing an earlier answer.",
    ownSpeechOnly: source.observations.length > 0 && source.observations.every(observation =>
      observation.scene?.actor === "你" && observation.scene.actionKind === "speak"),
    executionBoundary: source.reply ? {
      newPhysicalEffects: false, newSpeech: false, elapsedWorldTime: false,
      explanation: source.reply.reason,
      scope: "Only this failed or explanatory boundary; earlier observed events retain their actual actors and effects. Only participant_step belongs to this request; caused_response is another actor responding through recorded causality; concurrent_event is independent; unattributed has no established request relation.",
      originalRequest: source.reply.requested,
      earlierObservedEvents: (source.priorObservedReceipts ?? []).map(priorReceipt),
    } : null,
    newReceipts: source.observations.map(observation => ({ id: observation.id, worldTimeSeconds: observation.worldTimeSeconds,
      actor: observation.scene?.actor ?? null, actorLocalId: observation.scene?.actorLocalId ?? null,
      operation: observation.scene?.actionKind ?? null, status: observation.scene?.status ?? null,
      action: observation.scene?.action ?? null,
      currentMethodOrAttention: observation.scene?.actionKind !== "speak" ? observation.scene?.attempt ?? null : null,
      manner: observation.scene?.manner ?? null,
      actualResult: observation.scene?.actionKind === "speak" ? observation.summary.split("\n").slice(1).join("\n") || null : executedDescription({ ...observation, scene: observation.scene ?? undefined }),
      spokenDeliveryRecord: observation.scene?.actionKind === "speak" ? observation.scene.outcome : null })),
    actionBoundary: "These receipts are the complete new action record. spokenDeliveryRecord proves only that words were delivered; its quoted premises, requests and reports are not physical results. For speech, actualResult contains only accompanying observation lines; actual manner and independently observed details retain their separate authority. Earlier prose is not a new action. No extra gesture, movement, reaction or physical completion is implied by fluent dialogue or by an object's suitability for use.",
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
