import { contentHash } from "../../src/engine/models/model-audit";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import type { SimulationState } from "../../src/engine/contracts/model";
import type { WorldHost } from "../../src/server/world-host";
import type { WorldInstanceDocument } from "../../src/server/world-instance-types";
import type { PublicConversationTurn } from "../../src/shared/world-api";

export interface PlayerFeedbackResult {
  submissionId: string;
  text: string;
  baseRevision: number;
  status: "running" | "completed" | "awaiting-decision" | "stopped";
  firstFeedbackElapsedMs: number | null;
  completedElapsedMs: number | null;
  endedElapsedMs: number | null;
  failure?: string;
  feedback: Array<{ revision: number; step: number; observedElapsedMs: number; truthHash: string;
    response: NonNullable<PublicConversationTurn["response"]>; observationCount: number }>;
  reactions: Array<{ windowId: string; observedElapsedMs: number; choice: "keep" }>;
}

/** Measures persisted feedback and the submitted Activity's completion separately from run termination. */
export async function runPlayerFeedbackAction(input: {
  host: WorldHost; instanceId: string; participantId: string; submissionId: string; text: string;
  read: () => WorldInstanceDocument;
  onUpdate: (result: PlayerFeedbackResult) => void;
  onCheckpoint: (checkpoint: { source: SimulationState; checkpoint: SimulationState;
    committed: SimulationState["history"][number] }, observedElapsedMs: number) => void;
  stopReason: () => string | undefined;
  onStop: (reason: string) => void;
  pollMs?: number;
}): Promise<PlayerFeedbackResult> {
  const initial = input.read().state;
  const result: PlayerFeedbackResult = { submissionId: input.submissionId, text: input.text,
    baseRevision: initial.revision, status: "running", firstFeedbackElapsedMs: null,
    completedElapsedMs: null, endedElapsedMs: null, feedback: [], reactions: [] };
  const started = performance.now();
  let previous = initial;
  input.onUpdate(result);
  try {
    await input.host.submitAction(input.instanceId, input.participantId, {
      submissionId: input.submissionId, expectedRevision: initial.revision, text: input.text,
    });
    for (;;) {
      const document = input.read();
      const detail = input.host.instance(input.instanceId);
      const observedElapsedMs = performance.now() - started;
      const intent = document.participantIntents.find(intent => intent.participantId === input.participantId && intent.submissionId === input.submissionId);
      const run = intent && document.runs[intent.runId];
      if (!run) throw new Error("submitted player action has no durable run");
      const turn = detail.conversation?.turns.find(turn => turn.action?.submissionId === input.submissionId);
      for (const revision of run.committedRevisions.filter(revision => revision > previous.revision)) {
        const committed = document.state.history.find(entry => entry.revision === revision);
        const response = turn?.responses?.find(response => response.revision === revision);
        if (!committed || !response?.text.trim() || turn?.action?.text !== input.text ||
          committed.revision !== previous.revision + 1 || committed.step !== previous.step + 1) {
          throw new Error("player feedback is not bound to a contiguous committed world step");
        }
        const advances = committed.operations.filter(operation => operation.kind === "advance_time");
        if (advances.length !== 1 || advances[0]!.seconds <= 0) throw new Error("player feedback has no positive world-time advance");
        const checkpoint = replaySimulationState(document.state, revision);
        const truthHash = contentHash(checkpoint.truth);
        if (revision === document.state.revision && truthHash !== contentHash(document.state.truth)) throw new Error("player feedback replay diverged");
        result.firstFeedbackElapsedMs ??= observedElapsedMs;
        result.feedback.push({ revision, step: committed.step, observedElapsedMs, truthHash, response,
          observationCount: committed.observations.filter(packet => packet.observerId === intent!.agentId).length });
        input.onCheckpoint({ source: previous, checkpoint, committed }, observedElapsedMs);
        previous = checkpoint;
        input.onUpdate(result);
      }
      if (["failed", "preparation-invalidated", "budget-paused", "paused", "debug-paused"].includes(run.status)) {
        throw new Error(run.error ?? run.stopReason ?? run.status);
      }
      if (run.status === "completed" || run.status === "awaiting-decision") {
        if (!result.feedback.length || turn?.status !== "committed") throw new Error("player run ended without committed feedback");
        const activityId = result.feedback.at(-1)!.response.activity?.id;
        const activity = activityId ? document.state.truth.activities[activityId] : undefined;
        if (!activity || activity.actorId !== intent!.agentId || activity.sourceAction.baseRevision !== initial.revision ||
          activity.sourceAction.rawText !== input.text || !run.activityIds.includes(activity.id)) {
          throw new Error("terminal feedback is not bound to the submitted player Activity");
        }
        result.endedElapsedMs = performance.now() - started;
        if (activity.status === "completed") {
          result.completedElapsedMs = result.endedElapsedMs;
          result.status = "completed";
        } else if (run.status === "awaiting-decision") {
          result.status = "awaiting-decision";
        } else {
          throw new Error(`player run ended with Activity ${activity.status}`);
        }
        input.onUpdate(result);
        return result;
      }
      if (run.status === "awaiting-reaction") {
        const reason = input.stopReason();
        if (reason) throw new Error(reason);
        const window = document.actionWindow;
        if (!window || window.kind !== "reaction" || window.status !== "open" ||
          !window.requiredAgentIds.includes(intent!.agentId)) throw new Error("player reaction is not available to the test participant");
        await input.host.submitReaction(input.instanceId, input.participantId, {
          submissionId: `${input.submissionId}-keep-${result.reactions.length + 1}`,
          windowId: window.id, generation: window.generation, preparedStepId: window.preparedStepId,
          expectedRevision: document.state.revision, kind: "keep",
        });
        result.reactions.push({ windowId: window.id, observedElapsedMs, choice: "keep" });
        input.onUpdate(result);
      }
      // Transport observes stopReason and drains the active run. Never abandon a live engine.
      await new Promise(resolve => setTimeout(resolve, input.pollMs ?? 250));
    }
  } catch (error) {
    result.status = "stopped";
    result.failure = error instanceof Error ? error.message : String(error);
    input.onStop(result.failure);
    // A measurement error may occur between commits while the next boundary is live.
    // Stop later dispatch and let the current engine run settle before closing its store.
    for (;;) {
      const document = input.read();
      const intent = document.participantIntents.find(intent => intent.participantId === input.participantId && intent.submissionId === input.submissionId);
      const run = intent && document.runs[intent.runId];
      if (!run || !["queued", "running", "pausing"].includes(run.status)) break;
      await new Promise(resolve => setTimeout(resolve, input.pollMs ?? 250));
    }
    result.endedElapsedMs = performance.now() - started;
    input.onUpdate(result);
    return result;
  }
}
