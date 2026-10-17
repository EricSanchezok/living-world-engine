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

function queuedBeat(id: string, source: ScenePacket, now: string): NarrativeBeat {
  return { id, participantId: source.participantId, agentId: source.agentId, submissionId: source.submissionId,
    status: "queued", source, sourceHash: contentHash(source), segments: [], attempts: 0, executionIds: [], createdAt: now,
    firstParagraphAt: null, completedAt: null, error: null, producer: null, grounding: [] };
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
  const controlHistory = new Map<number, DirectRuntimeState["intents"]>();
  for (const [revision, control] of directControlHistory(document.state)) controlHistory.set(revision, control.intents);
  const actionFrames = new Map(document.state.history.flatMap(step => step.directEvent?.frames ?? []).map(frame => [frame.id, frame]));
  const events = new Map(document.state.truth.events.map(event => [event.id, event]));
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
      const agent = document.state.agents[participant.agentId]!;
      const self = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === agent.entityId);
      const place = document.state.truth.placements[agent.entityId];
      const localPlace = Object.values(agent.bindings).find(binding => binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === place);
      const ownObservations = new Map(document.state.history.flatMap(step => step.observations
        .filter(item => item.observerId === participant.agentId).map(item => [item.id, item] as const)));
      const source: ScenePacket = pending?.source ?? {
        participantId: participant.id, agentId: participant.agentId, submissionId,
        submittedAt: intent?.submittedAt ?? null, requestedAction: intent?.text ?? null,
        world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
        playerName: self ? agent.belief.localEntities[self.localEntityId]?.name ?? participant.displayName : participant.displayName,
        location: localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null,
        boundary: { revision: observation.revision, step: observation.step, worldTimeSeconds: observation.worldTimeSeconds }, reply: null,
        observations: [], speech: [],
        knownEntities: [], observedProperties: [],
        memories: Object.values(agent.belief.evidence).filter(evidence => evidence.step < observation.step)
          .slice(-12).map(evidence => { const recorded = evidence.sourceId ? ownObservations.get(evidence.sourceId) : null;
            return { kind: evidence.kind, description: evidence.description,
              ...(recorded ? { executedDescription: executedDescription(recorded) } : {}) }; }),
      };
      source.knownEntities = Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description }));
      source.currentHoldings = { coverage: "complete-current-self-holdings", quantities: projectAgentPerspective(document.state, agent).mechanics.quantities };
      source.knownWork = Object.values(agent.character.goals).map(goal => ({ description: goal.description, status: goal.status }));
      source.location = localPlace ? agent.belief.localEntities[localPlace.localEntityId]?.name ?? null : null;
      source.boundary = { revision: observation.revision, step: observation.step, worldTimeSeconds: observation.worldTimeSeconds };
      source.observedProperties = Object.values(agent.belief.claims).map(claim => ({
        subject: agent.belief.localEntities[claim.subjectId]?.name ?? claim.subjectId, predicate: claim.predicate,
        value: claim.value as unknown as JsonValue, stance: claim.stance, description: claim.description,
      }));
      source.observations.push(observation);
      if (observation.scene?.speech) source.speech.push({ id: `speech-${contentHash(observation.id).slice(0, 16)}`, ...observation.scene.speech });
      if (pending) pending.sourceHash = contentHash(source);
      else document.narratives.push(queuedBeat(`scene-${contentHash([participant.id, observation.id]).slice(0, 24)}`, source, now));
    }
    for (const step of document.state.history.filter(item => item.revision > participant.controlledSinceRevision)) {
      const record = step.directEvent; if (!record) continue;
      const intent = controlHistory.get(step.revision)![participant.agentId];
      const replies = [...(record.presentation ?? []).filter(reply => reply.agentId === participant.agentId)];
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
        const local = Object.values(document.state.agents[participant.agentId]!.bindings).find(binding =>
          binding.canonicalEntityIds.length === 1 && binding.canonicalEntityIds[0] === document.state.agents[ownerId]?.entityId);
        replies.push({ submissionId: original.submissionId, agentId: participant.agentId, kind: "recovery",
          requested: original.text, focusLocalEntityId: local?.localEntityId ?? null,
          reason: "The player's interaction already committed. Processing a relevant character response was interrupted before that response could commit. Preserve the delivered question and earlierObservedEvents according to their requestRelation and actual actor. Explain that the response could not be completed and the outstanding question can be continued. This is not a refusal, silence, a missed delivery, or evidence that the character did nothing. Do not invent their intended answer, motive, private activity or the technical cause." });
      }
      for (const reply of replies) {
        const id = `reply-${contentHash([participant.id, step.revision, reply.submissionId]).slice(0, 24)}`;
        if (document.narratives.some(beat => beat.id === id)) continue;
        const agent = document.state.agents[participant.agentId]!;
        const participantIntent = document.participantIntents.find(item => item.participantId === participant.id && item.submissionId === reply.submissionId);
        const source: ScenePacket = {
          participantId: participant.id, agentId: participant.agentId, submissionId: reply.submissionId,
          submittedAt: participantIntent?.submittedAt ?? null, requestedAction: reply.requested, reply: structuredClone(reply),
          boundary: { revision: step.revision, step: step.step, worldTimeSeconds: step.temporalBoundary.toElapsedSeconds },
          world: { name: document.world.name, language: document.world.narrative.language, style: document.world.narrative.style },
          playerName: participant.displayName, location: projectAgentPerspective(document.state, agent).self.location?.name ?? null, observations: [], speech: [],
          priorObservedReceipts: reply.kind === "recovery" ? document.narratives.filter(beat =>
            beat.participantId === participant.id && beat.submissionId === reply.submissionId && !beat.source.reply)
            .flatMap(beat => beat.source.observations.map(observation => {
              const sourceEvents = observation.sourceEventIds.map(id => events.get(id));
              const actionIds = sourceEvents.flatMap(event => event?.causes.filter(cause => cause.kind === "action").map(cause => cause.id) ?? []);
              const complete = sourceEvents.length > 0 && sourceEvents.every(event => event?.causes.some(cause => cause.kind === "action"));
              return { ...structuredClone(observation), requestRelation: complete
                ? requestRelation(actionIds, actionFrames, participant.agentId, reply.submissionId) : "unattributed" as const };
            })) : [],
          currentHoldings: { coverage: "complete-current-self-holdings", quantities: projectAgentPerspective(document.state, agent).mechanics.quantities },
          knownWork: Object.values(agent.character.goals).map(goal => ({ description: goal.description, status: goal.status })),
          knownEntities: Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description })),
          observedProperties: Object.values(agent.belief.claims).map(claim => ({ subject: agent.belief.localEntities[claim.subjectId]?.name ?? claim.subjectId,
            predicate: claim.predicate, value: claim.value as unknown as JsonValue, stance: claim.stance, description: claim.description })),
          memories: Object.values(agent.belief.evidence).map(evidence => {
            const observation = document.state.history.flatMap(item => item.observations).find(item => item.id === evidence.sourceId && item.observerId === participant.agentId);
            return { kind: evidence.kind, description: observation ? executedDescription(observation) : evidence.description };
          }).slice(-16),
        };
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
