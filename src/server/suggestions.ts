import { z } from "zod";
import { projectAgentPerspective } from "../engine/cognition/agent-perspective";
import { agentCapabilityModels } from "../engine/models/capability-bindings";
import { contentHash } from "../engine/models/model-audit";
import type { ModelExecutionScope, StructuredModelProvider } from "../engine/models/model-provider";
import { defineEngineOperationManifest } from "../engine/runtime/execution";
import type { DirectRuntimeState } from "../engine/direct/contracts";
import { loadPromptAsset } from "../engine/prompts";
import { participantDiscourse } from "./world-discourse";
import type { ParticipantRecord, WorldInstanceDocument } from "./world-instance-types";

export interface ParticipantSuggestions {
  sourceId: string;
  requestId: string | null;
  status: "idle" | "queued" | "generating" | "ready" | "failed" | "invalidated";
  items: string[];
  executionId: string | null;
}

const system = loadPromptAsset("system/action-suggestions.md");
const userPrompt = loadPromptAsset("user/action-suggestions.md");
const promptVersion = `action-suggestions-${contentHash([system, userPrompt])}`;
const inferenceOverrides = { thinking: "disabled", effort: "auto", reasoning_budget_tokens: "auto" } as const;
export const SUGGESTIONS_MANIFEST = defineEngineOperationManifest({
  id: "action-suggestions", version: "2", config: { promptVersion, inferenceOverrides },
});
const outputSchema = z.strictObject({ items: z.array(z.string().trim().min(1).max(120)).max(3) });

/** Scene references come only from published prose; private goals express intent, not scene facts. */
export function suggestionContext(document: WorldInstanceDocument, participant: ParticipantRecord) {
  const view = projectAgentPerspective(document.state, document.state.agents[participant.agentId]!);
  const discourse = participantDiscourse(document, participant.id);
  return {
    task: "action-suggestions",
    language: document.world.narrative.language,
    perspective: { self: { name: view.self.name }, goals: Object.values(view.character.goals)
      .filter(goal => goal.status === "active").map(goal => goal.description) },
    discourse: { arrival: discourse.arrival.text, exchanges: discourse.exchanges.map(exchange => ({
      requested: exchange.requested, paragraphs: exchange.paragraphs.map(paragraph => paragraph.text),
    })) },
    latestRequest: document.participantIntents.findLast(intent => intent.participantId === participant.id)?.text ?? null,
  };
}

function sourceId(document: WorldInstanceDocument, participant: ParticipantRecord): string {
  return contentHash({ participantId: participant.id, agentId: participant.agentId, revision: document.state.revision,
    controlledSinceRevision: participant.controlledSinceRevision,
    submissionId: document.participantIntents.findLast(intent => intent.participantId === participant.id)?.submissionId ?? null,
    context: suggestionContext(document, participant) });
}

/** Reconcile availability and invalidate stale work without requesting inference. */
export function reconcileSuggestions(document: WorldInstanceDocument, decisionAgentIds: readonly string[]): void {
  const run = Object.values(document.runs).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
  for (const participant of Object.values(document.participants)) {
    const binding = document.policyBindings[participant.agentId];
    const stable = participant.status === "active" && binding?.kind === "external" && binding.participantId === participant.id &&
      decisionAgentIds.includes(participant.agentId) && !run?.servicePause &&
      (!run || ["completed", "awaiting-decision", "failed"].includes(run.status)) &&
      document.actionWindow?.kind !== "reaction" &&
      !document.actionWindow?.submissions[participant.agentId] &&
      !document.narratives.some(beat => beat.participantId === participant.id && ["queued", "generating"].includes(beat.status));
    if (!stable) {
      if (participant.suggestions && participant.suggestions.status !== "invalidated") {
        participant.suggestions.status = "invalidated";
        participant.suggestions.items = [];
      }
      continue;
    }
    const nextSource = sourceId(document, participant);
    if (participant.suggestions?.sourceId === nextSource && participant.suggestions.status !== "invalidated") continue;
    participant.suggestions = { sourceId: nextSource, requestId: null, status: "idle", items: [], executionId: null };
  }
}

export function recoverSuggestions(document: WorldInstanceDocument): boolean {
  let changed = false;
  for (const participant of Object.values(document.participants)) {
    if (participant.suggestions && ["queued", "generating"].includes(participant.suggestions.status)) {
      participant.suggestions.status = "failed";
      changed = true;
    }
  }
  return changed;
}

function normalized(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
}

/** One logical creation request; invalid output has no repair or template fallback. */
export async function generateSuggestions(
  provider: StructuredModelProvider,
  document: WorldInstanceDocument,
  participantId: string,
  scope: ModelExecutionScope,
): Promise<string[]> {
  const participant = document.participants[participantId]!;
  const data = document.state.executionState?.data;
  const control = data?.kind === "direct-world" ? data as unknown as DirectRuntimeState : null;
  const models = control ? agentCapabilityModels(document.state, control, participant.agentId) : document.state.agents[participant.agentId]!.modelProfiles;
  const previousSuggestions = participant.suggestions?.items ?? [];
  const context = { ...suggestionContext(document, participant), previousSuggestions };
  const result = await provider.generateStructured({ ...scope,
    ...(control ? { modelRegistrySnapshotHash: control.registryHash } : {}),
    profileId: models.creation, role: "creation", subjectId: participant.agentId,
    inferenceOverrides,
    promptVersion, schemaName: "ActionSuggestionsV1", system, userPrompt, context,
    schema: outputSchema, jsonExamplePolicy: "omit",
  });
  const seen = new Set([...previousSuggestions, ...document.participantIntents
    .filter(intent => intent.participantId === participantId).slice(-6).map(intent => intent.text)].map(normalized));
  return result.value.items.filter(item => {
    const key = normalized(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
