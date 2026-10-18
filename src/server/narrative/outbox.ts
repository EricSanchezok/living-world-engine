import { replaySimulationState } from "../../engine/runtime/transaction";
import { directControlHistory } from "../../engine/direct/canonical";
import { contentHash } from "../../engine/models/model-audit";
import type { WorldInstanceDocument } from "../world-instance-types";
import type { ActionFrame, DirectRuntimeState } from "../../engine/direct/contracts";
import type { JsonValue } from "../../engine/runtime/json";
import { projectAgentPerspective } from "../../engine/cognition/agent-perspective";
import { participantReactionIds } from "../../engine/direct/foreground";
import type { ScenePacket, NarrativeBeat, RequestRelation } from "./contracts";
import { executedDescription } from "./scene";
import { narrativeFallback, explicitNarrativeMentions } from "./publication";
import type { AgentState, SimulationState } from "../../engine/contracts/model";
import { resolveDurationUnits, standardDurationUnits } from "../../engine/mechanics/duration-units";

function elapsedUnitsAt(state: Readonly<SimulationState>, agent: AgentState) {
  return { ...standardDurationUnits, ...resolveDurationUnits(state.truth.mechanics.durationUnits, state.truth.placements, agent.entityId) };
}

function observedPropertiesAt(state: Readonly<SimulationState>, agent: AgentState): ScenePacket["observedProperties"] {
  const observations = new Map(state.history.flatMap(step => step.observations.filter(observation => observation.observerId === agent.id)
    .map(observation => [observation.id, { revision: step.revision, step: step.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds }] as const)));
  return Object.values(agent.belief.claims).map(claim => ({
    subject: agent.belief.localEntities[claim.subjectId]?.name ?? claim.subjectId, subjectLocalId: claim.subjectId,
    predicate: claim.predicate, value: claim.value as unknown as JsonValue, stance: claim.stance, description: claim.description,
    evidenceBoundary: claim.evidenceIds.flatMap(id => {
      const source = agent.belief.evidence[id]?.sourceId, boundary = source ? observations.get(source) : undefined;
      return boundary ? [boundary] : [];
    }).sort((left, right) => right.revision - left.revision)[0] ?? null,
  }));
}

/** A current observed public phase can establish its exact boundary, never a hidden schedule. */
export function observedPeriodicTransitionsAt(state: Readonly<SimulationState>, agent: AgentState,
  properties: NonNullable<ScenePacket["observedProperties"]>): ScenePacket["observedPeriodicTransitions"] {
  const ancestry: string[] = [];
  for (let place = state.truth.placements[agent.entityId]; place && !ancestry.includes(place); place = state.truth.placements[place]) ancestry.push(place);
  return properties.flatMap(observed => {
    if (observed.evidenceBoundary?.worldTimeSeconds !== state.truth.elapsedSeconds) return [];
    const binding = agent.bindings[observed.subjectLocalId];
    if (binding?.canonicalEntityIds.length !== 1) return [];
    const subjectId = binding.canonicalEntityIds[0]!, rank = ancestry.indexOf(subjectId);
    if (rank < 0) return [];
    // A nearer public environment owns this property even when it is constant.
    if (Object.values(state.truth.facts).some(fact => fact.predicate === observed.predicate && fact.access.kind === "public" &&
      ancestry.indexOf(fact.subjectId) >= 0 && ancestry.indexOf(fact.subjectId) < rank)) return [];
    const property = Object.values(state.truth.mechanics.periodicProperties).find(item => item.subjectId === subjectId &&
      item.predicate === observed.predicate && item.access.kind === "public");
    if (!property) return [];
    const offset = Number((BigInt(state.truth.elapsedSeconds) + BigInt(property.initialPhaseSeconds)) % BigInt(property.periodSeconds));
    const index = property.phases.findIndex(phase => phase.startsAtSeconds === offset && contentHash(phase.value) === contentHash(observed.value));
    if (index < 0) return [];
    return [{ subject: observed.subject, subjectLocalId: observed.subjectLocalId, predicate: observed.predicate,
      atWorldTimeSeconds: state.truth.elapsedSeconds, from: property.phases[(index + property.phases.length - 1) % property.phases.length]!.description,
      to: property.phases[index]!.description }];
  });
}

function queuedBeat(id: string, source: ScenePacket, now: string): NarrativeBeat {
  return { id, participantId: source.participantId, agentId: source.agentId, submissionId: source.submissionId,
    status: "queued", source, sourceHash: contentHash(source), segments: [], attempts: 0, executionIds: [], createdAt: now,
    firstParagraphAt: null, completedAt: null, error: null, producer: null, grounding: [] };
}

/** Same-submission participant observations are history, never another subject's private receipts. */
export function earlierRequestReceipts(beats: readonly Pick<NarrativeBeat, "participantId" | "agentId" | "submissionId" | "source">[],
  participantId: string, agentId: string, submissionId: string | null, throughRevision = Number.MAX_SAFE_INTEGER): ScenePacket["observations"] {
  if (!submissionId) return [];
  const ids = new Set<string>(), events = new Set<string>();
  return beats.filter(beat => beat.participantId === participantId && beat.agentId === agentId &&
    beat.submissionId === submissionId && !beat.source.reply).flatMap(beat => beat.source.observations).filter(observation => observation.revision <= throughRevision)
    .sort((a, b) => a.worldTimeSeconds - b.worldTimeSeconds || a.revision - b.revision || a.step - b.step || a.id.localeCompare(b.id))
    .filter(observation => {
      const eventKey = observation.sourceEventIds.length ? [...observation.sourceEventIds].sort().join("\n") : null;
      if (ids.has(observation.id) || eventKey && events.has(eventKey)) return false;
      ids.add(observation.id); if (eventKey) events.add(eventKey); return true;
    }).map(observation => structuredClone(observation));
}

type RecoveryAttempt = Pick<DirectRuntimeState["intents"][string], "causeActionId" | "failure">;

/** Repeated failed attempts retain their Ledger records but share unchanged feedback. */
export function sameRecoveryFeedback(previous: ScenePacket, current: ScenePacket,
  earlier: RecoveryAttempt | undefined, latest: RecoveryAttempt): boolean {
  const focus = current.reply?.focusLocalEntityId;
  if (current.reply?.kind !== "recovery" || previous.reply?.kind !== "recovery" || !focus ||
    previous.reply.focusLocalEntityId !== focus || !current.knownEntities.some(entity => entity.localEntityId === focus) ||
    !previous.knownEntities.some(entity => entity.localEntityId === focus) || !latest.causeActionId ||
    earlier?.causeActionId !== latest.causeActionId || !earlier.failure || !latest.failure ||
    earlier.failure.servicePause || latest.failure.servicePause || earlier.failure.message !== latest.failure.message ||
    earlier.failure.recoverable !== latest.failure.recoverable) return false;
  const { boundary: _previousBoundary, ...previousContent } = previous;
  const { boundary: _currentBoundary, ...currentContent } = current;
  void _previousBoundary; void _currentBoundary;
  return contentHash(previousContent) === contentHash(currentContent);
}

/** Coalesce immediate prerequisites and replies; admitted activities and terminal runs remain publishable. */
export function nextNarrative(document: WorldInstanceDocument): NarrativeBeat | undefined {
  const seen = new Set<string>();
  for (const beat of document.narratives) {
    if (!["queued", "generating"].includes(beat.status) || seen.has(beat.participantId)) continue;
    seen.add(beat.participantId);
    if (beat.status === "generating" || beat.attempts > 0 || !beat.submissionId) return beat;
    const data = document.state.executionState?.data;
    const control = data?.kind === "direct-world" ? data as unknown as DirectRuntimeState : null;
    const intent = control?.intents[beat.agentId];
    const run = Object.values(document.runs).findLast(run => run.rootIntents.some(input => input.submissionId === beat.submissionId));
    const prerequisite = beat.source.observations.every(observation => observation.scene?.actor === "你" &&
      ["move", "observe", "reflect"].includes(observation.scene.actionKind) && !observation.scene.speech && observation.scene.status !== "continuing");
    if (prerequisite && intent?.status === "ready" && intent.activeSubmission?.submissionId === beat.submissionId &&
      run && ["queued", "running"].includes(run.status)) continue;
    const ownSpeech = beat.source.observations.length > 0 && beat.source.observations.every(observation =>
      observation.scene?.actor === "你" && observation.scene.actionKind === "speak");
    if (ownSpeech && control && run && ["queued", "running"].includes(run.status) &&
      [...participantReactionIds(document.state, control, [beat.agentId], [beat.submissionId])]
        .some(id => document.policyBindings[id]?.kind === "model" && control.intents[id]?.status === "ready")) continue;
    return beat;
  }
}

/** Window membership is not request provenance; only committed frame links establish it. */
function requestRelation(actionIds: string[], frames: Map<string, ActionFrame>, agentId: string, submissionId: string): RequestRelation {
  const relation = (id: string): RequestRelation => {
    const first = frames.get(id);
    if (!first) return "unattributed";
    if (first.actorId === agentId) return first.submissionId === submissionId ? "participant_step" : "concurrent_event";
    const visited = new Set<string>();
    let frame: ActionFrame | undefined = first;
    while (frame) {
      if (visited.has(frame.id)) return "unattributed";
      visited.add(frame.id);
      if (frame.actorId === agentId) return frame.submissionId === submissionId ? "caused_response" : "concurrent_event";
      if (!frame.causeActionId) return "concurrent_event";
      frame = frames.get(frame.causeActionId);
    }
    return "unattributed";
  };
  const relations = new Set(actionIds.map(relation));
  return relations.size === 1 ? [...relations][0]! : "unattributed";
}

/** Called in the world transaction. Never performs model work. */
export function enqueueNarrative(document: WorldInstanceDocument, now: string): void {
  const boundaryStates = new Map([[document.state.revision, document.state]]);
  const stateAt = (revision: number) => {
    let state = boundaryStates.get(revision);
    if (!state) { state = replaySimulationState(document.state, revision); boundaryStates.set(revision, state); }
    return state;
  };
  const controlHistory = new Map<number, DirectRuntimeState["intents"]>();
  for (const [revision, control] of directControlHistory(document.state)) controlHistory.set(revision, control.intents);
  const actionFrames = new Map(document.state.history.flatMap(step => step.directEvent?.frames ?? []).map(frame => [frame.id, frame]));
  const events = new Map(document.state.truth.events.map(event => [event.id, event]));
  const priorReceipts = (participantId: string, agentId: string, submissionId: string | null, throughRevision: number): NonNullable<ScenePacket["priorObservedReceipts"]> =>
    earlierRequestReceipts(document.narratives, participantId, agentId, submissionId, throughRevision).map(observation => {
      const sourceEvents = observation.sourceEventIds.map(id => events.get(id));
      const actionIds = sourceEvents.flatMap(event => event?.causes.filter(cause => cause.kind === "action").map(cause => cause.id) ?? []);
      const complete = sourceEvents.length > 0 && sourceEvents.every(event => event?.causes.some(cause => cause.kind === "action"));
      return { ...observation, requestRelation: complete && submissionId
        ? requestRelation(actionIds, actionFrames, agentId, submissionId) : "unattributed" };
    });
  for (const participant of Object.values(document.participants).filter(p => p.status === "active")) {
    const existing = document.narratives.filter(beat => beat.participantId === participant.id);
    const covered = new Set(existing.flatMap(beat => beat.source.observations.map(o => o.id)));
    const fresh = document.state.history.filter(step => step.revision > participant.controlledSinceRevision)
      .flatMap(step => step.observations.filter(o => o.observerId === participant.agentId && !covered.has(o.id))
        .map(o => ({ id: o.id, revision: step.revision, step: step.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds,
          summary: o.summary, scene: o.scene ?? null, sourceEventIds: [...o.sourceEventIds] })));
    const intents = document.participantIntents.filter(intent => intent.participantId === participant.id);
    for (const observation of fresh) {
      const intent = intents.findLast(item => document.runs[item.runId]?.committedRevisions.includes(observation.revision)) ??
        intents.findLast(item => item.revision < observation.revision);
      const submissionId = intent?.submissionId ?? null;
      const pending = document.narratives.findLast(beat => beat.participantId === participant.id && beat.submissionId === submissionId && !beat.source.reply && beat.status === "queued" && beat.attempts === 0);
      const boundaryState = stateAt(observation.revision);
      const agent = boundaryState.agents[participant.agentId]!;
      const self = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === agent.entityId);
      const place = boundaryState.truth.placements[agent.entityId];
      const localPlace = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === place);
      const ownObservations = new Map(boundaryState.history.flatMap(step => step.observations
        .filter(item => item.observerId === participant.agentId).map(item => [item.id, item] as const)));
      const source: ScenePacket = pending?.source ?? {
        participantId: participant.id, agentId: participant.agentId, submissionId,
        submittedAt: intent?.submittedAt ?? null, requestedAction: intent?.text ?? null,
        world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
        playerName: self ? agent.belief.localEntities[self.localEntityId]?.name ?? participant.displayName : participant.displayName,
        location: localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null,
        boundary: { revision: observation.revision, step: observation.step, worldTimeSeconds: observation.worldTimeSeconds }, reply: null,
        elapsedUnits: elapsedUnitsAt(boundaryState, agent),
        observedPeriodicTransitions: observedPeriodicTransitionsAt(boundaryState, agent, observedPropertiesAt(boundaryState, agent) ?? []),
        observations: [], speech: [],
        priorObservedReceipts: priorReceipts(participant.id, participant.agentId, submissionId, observation.revision),
        knownEntities: [], observedProperties: [],
        memories: Object.values(agent.belief.evidence).filter(evidence => evidence.step < observation.step)
          .slice(-12).map(evidence => { const recorded = evidence.sourceId ? ownObservations.get(evidence.sourceId) : null;
            return { kind: evidence.kind, description: evidence.description,
              ...(recorded ? { executedDescription: executedDescription(recorded) } : {}) }; }),
      };
      source.knownEntities = Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description }));
      source.currentHoldings = { coverage: "complete-current-self-holdings", quantities: projectAgentPerspective(boundaryState, agent).mechanics.quantities };
      source.knownWork = Object.values(agent.character.goals).map(goal => ({ description: goal.description, status: goal.status }));
      source.location = localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null;
      source.boundary = { revision: observation.revision, step: observation.step, worldTimeSeconds: observation.worldTimeSeconds };
      source.elapsedUnits = elapsedUnitsAt(boundaryState, agent);
      source.observedProperties = observedPropertiesAt(boundaryState, agent);
      source.observedPeriodicTransitions = observedPeriodicTransitionsAt(boundaryState, agent, source.observedProperties ?? []);
      source.observations.push(observation);
      if (observation.scene?.speech) source.speech.push({ id: `speech-${contentHash(observation.id).slice(0, 16)}`, ...observation.scene.speech });
      if (pending) pending.sourceHash = contentHash(source);
      else document.narratives.push(queuedBeat(`scene-${contentHash([participant.id, observation.id]).slice(0, 24)}`, source, now));
    }
    for (const step of document.state.history.filter(item => item.revision > participant.controlledSinceRevision)) {
      const record = step.directEvent; if (!record) continue;
      const intent = controlHistory.get(step.revision)![participant.agentId];
      const replies = [...(record.presentation ?? []).filter(reply => reply.agentId === participant.agentId)];
      const responseFailures = new Map<string, { ownerId: string; intent: RecoveryAttempt }>();
      const failed = intent?.failure;
      if (failed && failed.atRevision === step.baseRevision && !failed.servicePause && intent.activeSubmission) {
        replies.push({ submissionId: intent.activeSubmission.submissionId, agentId: participant.agentId, kind: "recovery",
          requested: intent.activeSubmission.rawText, focusLocalEntityId: null,
          reason: "Processing the next unperformed step was interrupted before it could commit. Use earlierObservedEvents and their requestRelation to distinguish completed participant steps, causally related responses and independent observed events; preserve each actual actor and effect, including elapsed waiting. Explain only the remaining interruption; retry only the unfinished part. Do not claim the entire original request failed or invent a physical obstacle or refusal." });
      }
      for (const [ownerId, other] of Object.entries(controlHistory.get(step.revision)!)) {
        if (ownerId === participant.agentId || !other.failure || other.failure.atRevision !== step.baseRevision ||
          other.failure.servicePause || !other.causeActionId) continue;
        const cause = actionFrames.get(other.causeActionId);
        if (cause?.actorId !== participant.agentId || !cause.submissionId || replies.some(reply => reply.submissionId === cause.submissionId)) continue;
        const original = intents.find(item => item.submissionId === cause.submissionId);
        if (!original) continue;
        const replyId = `reply-${contentHash([participant.id, step.revision, original.submissionId]).slice(0, 24)}`;
        if (document.narratives.some(beat => beat.id === replyId)) continue;
        const boundaryState = stateAt(step.revision);
        const local = Object.values(boundaryState.agents[participant.agentId]!.bindings).find(binding =>
          binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === boundaryState.agents[ownerId]?.entityId);
        replies.push({ submissionId: original.submissionId, agentId: participant.agentId, kind: "recovery",
          requested: original.text, focusLocalEntityId: local?.localEntityId ?? null,
          reason: "The player's interaction already committed. Processing a relevant character response was interrupted before that response could commit. Preserve the delivered question and earlierObservedEvents according to their requestRelation and actual actor. Explain only that this response processing did not complete before commit. This does not establish that the player's requested goal remains unfinished; use the actual earlier receipts to preserve any completed result. This is not a refusal, silence, a missed delivery, or evidence that the character did nothing. Do not invent their intended answer, motive, private activity or the technical cause." });
        responseFailures.set(original.submissionId, { ownerId, intent: other });
      }
      for (const reply of replies) {
        const id = `reply-${contentHash([participant.id, step.revision, reply.submissionId]).slice(0, 24)}`;
        if (document.narratives.some(beat => beat.id === id)) continue;
        const boundaryState = stateAt(step.revision);
        const agent = boundaryState.agents[participant.agentId]!;
        const participantIntent = document.participantIntents.find(item => item.participantId === participant.id && item.submissionId === reply.submissionId);
        const source: ScenePacket = {
          participantId: participant.id, agentId: participant.agentId, submissionId: reply.submissionId,
          submittedAt: participantIntent?.submittedAt ?? null, requestedAction: reply.requested, reply: structuredClone(reply),
          boundary: { revision: step.revision, step: step.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds },
          elapsedUnits: elapsedUnitsAt(boundaryState, agent),
          observedPeriodicTransitions: observedPeriodicTransitionsAt(boundaryState, agent, observedPropertiesAt(boundaryState, agent) ?? []),
          world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
          playerName: participant.displayName, location: projectAgentPerspective(boundaryState, agent).self.location?.name ?? null, observations: [], speech: [],
          priorObservedReceipts: reply.kind === "recovery"
            ? priorReceipts(participant.id, participant.agentId, reply.submissionId, step.revision) : [],
          currentHoldings: { coverage: "complete-current-self-holdings", quantities: projectAgentPerspective(boundaryState, agent).mechanics.quantities },
          knownWork: Object.values(agent.character.goals).map(goal => ({ description: goal.description, status: goal.status })),
          knownEntities: Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description })),
          observedProperties: observedPropertiesAt(boundaryState, agent),
          memories: Object.values(agent.belief.evidence).map(evidence => {
            const observation = boundaryState.history.flatMap(item => item.observations).find(item => item.id === evidence.sourceId && item.observerId === participant.agentId);
            return { kind: evidence.kind, description: observation ? executedDescription(observation) : evidence.description };
          }).slice(-16),
        };
        const response = responseFailures.get(reply.submissionId);
        if (response && document.narratives.some(beat => sameRecoveryFeedback(beat.source, source,
          controlHistory.get(beat.source.boundary.revision)?.[response.ownerId], response.intent))) continue;
        document.narratives.push(queuedBeat(id, source, now));
      }
    }
  }
  if (document.actionWindow && document.narratives.some(beat => ["queued", "generating"].includes(beat.status) &&
    document.actionWindow!.requiredAgentIds.includes(beat.agentId))) document.actionWindow.deadlineAt = null;
}

/** A paused service cannot generate prose, but its committed receipts are ready. */
export function settleQueuedNarratives(document: WorldInstanceDocument, now: string): void {
  for (const beat of document.narratives.filter(item => item.status === "queued")) {
    const fallback = narrativeFallback(beat.source, beat.segments.map(segment => segment.text));
    if (fallback) beat.segments.push({ sequence: beat.segments.length, text: fallback,
      mentions: explicitNarrativeMentions(fallback, beat.source), publishedAt: now });
    beat.status = "fallback"; beat.completedAt = now;
    if (beat.segments.length) beat.firstParagraphAt ??= now;
  }
}
