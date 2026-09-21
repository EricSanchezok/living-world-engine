import { z } from "zod";
import type { EagerActionSelection } from "../../algorithms/eager-reference/eager-reference";
import { projectAgentPerspective } from "../../cognition/agent-perspective";
import type { AgentActionProposal, ModelExecutionAudit, SimulationState } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { modelInvocationCorrelation, modelInvocationIdentity, ModelOutputError, setModelInvocationOutcome, type StructuredModelProvider } from "../../models/model-provider";
import { validateAlgorithmExecutionState, type AlgorithmExecutionState } from "../../runtime/execution-state";
import type { ExecutionContext } from "../../runtime/execution";
import type { JsonObject } from "../../runtime/json";
import { runtimeId } from "../../runtime/runtime-id";
import { agentIntentProgramSchema, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";
import { IntentExecutionCursor } from "./intent-execution-cursor";
import { loadPromptAsset } from "../../prompts";

export const INTENT_CONTINUE_PREFIX = "INTENT_CONTINUE_V1 (engine-bound continuation, not a world action):\n";
const guardInstruction = loadPromptAsset("shared/agent-intent-guard.md");
const guardTask = loadPromptAsset("shared/agent-intent-guard-user.md");
export const INTENT_GUARD_VERSION = `private-intent-guard-v1@${contentHash({ guardInstruction, guardTask }).slice(0, 16)}`;
type Snapshot = ReturnType<IntentExecutionCursor["snapshot"]>;
export interface IntentMemory { version: 1; active: Record<string, Snapshot>; retired: Record<string, Snapshot> }
const memorySchema = z.strictObject({ version: z.literal(1), active: z.record(z.string(), z.unknown()), retired: z.record(z.string(), z.unknown()) });

export function readIntentMemory(value: AlgorithmExecutionState | null, producerHash: string): IntentMemory {
  validateAlgorithmExecutionState(value, producerHash);
  if (value === null) return { version: 1, active: {}, retired: {} };
  const parsed = memorySchema.parse(value.data);
  const active = Object.fromEntries(Object.entries(parsed.active).map(([actorId, raw]) => {
    const snapshot = IntentExecutionCursor.restore(raw).snapshot();
    if (snapshot.source.action.actorId !== actorId) throw new Error("intent memory owner changed");
    return [actorId, snapshot];
  }));
  const retired = Object.fromEntries(Object.entries(parsed.retired).map(([id, raw]) => {
    const snapshot = IntentExecutionCursor.restore(raw).snapshot();
    if (snapshot.source.action.id !== id) throw new Error("retired intent identity changed");
    return [id, snapshot];
  }));
  return { version: 1, active, retired };
}

/** Consume durable results before another dispatch. No current candidate or
 * in-flight model response can advance a cursor through this boundary. */
export function reconcileIntentMemory(memory: IntentMemory, state: SimulationState) {
  for (const [actorId, snapshot] of Object.entries(memory.active)) {
    const cursor = IntentExecutionCursor.restore(snapshot);
    const settled = new Set(snapshot.events.flatMap(event => event.kind === "settle" ? [event.workId] : []));
    for (const work of cursor.frontier()) {
      if (!work.issuedAction || settled.has(work.workId) || work.issuedAction.baseRevision >= state.revision) continue;
      const activity = Object.values(state.truth.activities).find(activity => activity.sourceActionId === work.issuedAction!.id);
      if (activity) cursor.observe(work.workId, state);
      else if (cursor.status === "running" && state.history.some(step => step.reactionDecisions.some(decision =>
        decision.originalProposalId === work.issuedAction!.id && decision.kind === "replace"))) {
        cursor.suspend("committed reaction replaced the issued attempt");
      } else if (cursor.status === "running") throw new Error("issued intention lost its committed Activity");
    }
    memory.active[actorId] = cursor.snapshot();
  }
}

const verdictSchema = z.strictObject({ slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(),
  verdict: z.enum(["true", "false", "unknown"]), evidence: z.string().min(1) })) });

async function resolveGuards(provider: StructuredModelProvider, cursors: Map<string, IntentExecutionCursor>,
  state: SimulationState, context: ExecutionContext, maxSlots: number): Promise<ModelExecutionAudit[]> {
  const audits: ModelExecutionAudit[] = [];
  // Each finite program can expose at most its node count of new guard
  // activations without an intervening attempt or unchanged-view wait.
  const limit = [...cursors.values()].reduce((sum, cursor) => sum + cursor.snapshot().source.program.nodes.length, 0);
  for (let round = 0; round <= limit; round++) {
    const groups = new Map<string, Array<{ actorId: string; cursor: IntentExecutionCursor; ticket: ReturnType<IntentExecutionCursor["guardTicket"]> }>>();
    for (const [actorId, cursor] of cursors) {
      if (cursor.status !== "running") continue;
      const view = projectAgentPerspective(state, state.agents[actorId]!);
      for (const work of cursor.frontier()) {
        if (work.kind === "attempt" || work.lastPerspectiveHash === contentHash(view)) continue;
        const profile = state.agents[actorId]!.modelProfiles.mind;
        const group = groups.get(profile) ?? [];
        group.push({ actorId, cursor, ticket: cursor.guardTicket(work.workId, view) }); groups.set(profile, group);
      }
    }
    if (!groups.size) return audits;
    if (round === limit) throw new Error("intent guards did not reach an execution or waiting boundary");
    const batches = [...groups.entries()].flatMap(([profileId, entries]) =>
      Array.from({ length: Math.ceil(entries.length / maxSlots) }, (_, index) => ({ profileId, entries: entries.slice(index * maxSlots, (index + 1) * maxSlots) })));
    const results = await Promise.all(batches.map(async ({ profileId, entries }) => {
      context.modelScope.abortSignal?.throwIfAborted();
      context.modelScope.cancelPendingSignal?.throwIfAborted();
      const owner = `intent-guards:${contentHash(entries.map(entry => entry.ticket.work.workId))}`;
      const identity = modelInvocationIdentity(context.modelScope, "agent-mind", owner, round + 1);
      const generated = await provider.generateStructured({ profileId, role: "agent-mind", subjectId: owner,
        workloadId: context.modelScope.workloadId, batchId: context.modelScope.batchId,
        abortSignal: context.modelScope.abortSignal, observer: context.modelScope.observer, ...identity,
        correlation: modelInvocationCorrelation(context.modelScope, "agent-mind", owner, identity),
        promptVersion: INTENT_GUARD_VERSION, schemaName: "intent_guard_batch", schema: verdictSchema,
        system: guardInstruction, userPrompt: guardTask,
        context: { slots: entries.map((entry, slot) => ({ slot, perspective: entry.ticket.perspective,
          condition: entry.ticket.work.text, kind: entry.ticket.work.kind, targetIds: entry.ticket.work.targetIds })) },
      });
      if (generated.value.slots.length !== entries.length ||
        contentHash(generated.value.slots.map(slot => slot.slot).sort((a, b) => a - b)) !== contentHash(entries.map((_, index) => index))) {
        setModelInvocationOutcome(generated.audit, "rejected", ["intent_guard.slot_coverage"]);
        context.modelScope.observer?.emit({ event: "model.semantic.rejected", level: "warn",
          correlation: modelInvocationCorrelation(context.modelScope, "agent-mind", owner, identity),
          attributes: { resultKind: "intent_guard_batch" }, counts: { validationIssues: 1 },
          payload: { issues: [{ code: "intent_guard.slot_coverage", message: "intent guard slots do not cover the frozen request" }] } });
        throw new ModelOutputError("intent guard slots do not cover the frozen request", generated.audit);
      }
      for (const verdict of generated.value.slots) {
        const entry = entries[verdict.slot]!;
        entry.cursor.resolveGuard(entry.ticket, projectAgentPerspective(state, state.agents[entry.actorId]!), verdict.verdict);
      }
      return generated.audit;
    }));
    audits.push(...results);
  }
  return audits;
}

export function incrementalIntentSelector(provider: StructuredModelProvider, producerHash: string, maxGuardSlots: number): EagerActionSelection {
  return async (input, actions, executionState, context) => {
    const memory = readIntentMemory(executionState, producerHash);
    reconcileIntentMemory(memory, input.state);
    const selected: AgentActionProposal[] = [], cursors = new Map<string, IntentExecutionCursor>();
    for (const action of actions) {
      if (input.policyRoster[action.actorId]?.kind !== "model") { selected.push(structuredClone(action)); continue; }
      const current = memory.active[action.actorId];
      if (current?.source.action.id === action.id) {
        cursors.set(action.actorId, IntentExecutionCursor.restore(current)); continue;
      }
      if (action.rawText.startsWith(INTENT_CONTINUE_PREFIX)) {
        const continuation = z.strictObject({ sourceActionId: z.string() }).parse(JSON.parse(action.rawText.slice(INTENT_CONTINUE_PREFIX.length)));
        if (!current || current.source.action.id !== continuation.sourceActionId) throw new Error("continuation targets another intention");
        cursors.set(action.actorId, IntentExecutionCursor.restore(current));
        continue;
      }
      if (current) {
        const retiring = IntentExecutionCursor.restore(current);
        if (retiring.status === "running") retiring.suspend("Agent explicitly replaced its intention");
        memory.retired[current.source.action.id] = retiring.snapshot(); delete memory.active[action.actorId];
      }
      if (!action.rawText.startsWith(INTENT_PROGRAM_PREFIX)) { selected.push(structuredClone(action)); continue; }
      if (action.means !== null) throw new Error("program producer supplied separate means");
      const program = agentIntentProgramSchema.parse(JSON.parse(action.rawText.slice(INTENT_PROGRAM_PREFIX.length)));
      cursors.set(action.actorId, new IntentExecutionCursor({ worldHash: input.state.worldHash, action: { ...action, means: null }, program }));
    }
    const modelAudits = await resolveGuards(provider, cursors, input.state, context, maxGuardSlots);
    for (const [actorId, cursor] of cursors) {
      if (cursor.status === "running") {
        const workIds = cursor.frontier().filter(work => work.kind === "attempt" && !work.issuedAction).map(work => work.workId);
        if (workIds.length) {
          const draft = cursor.attemptGroup(workIds);
          for (const id of draft.targetIds) if (!input.state.agents[actorId]!.belief.localEntities[id]) throw new Error("pending intention targets a retired local entity; replanning is required");
          const action = { ...draft, actorId, baseRevision: input.state.revision,
            id: runtimeId({ worldHash: input.state.worldHash, revision: input.state.revision, kind: "action", stage: "intent-frontier",
              owner: [actorId, ...workIds], round: 0, ordinal: 0 }) };
          selected.push(cursor.issueGroup(workIds, action));
        }
      }
      memory.active[actorId] = cursor.snapshot();
    }
    return { actions: selected, modelAudits,
      executionState: { producerHash, data: memory as unknown as JsonObject } };
  };
}
