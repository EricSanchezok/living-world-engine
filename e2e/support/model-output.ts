import {
  deterministicActionCompilationBatch,
  deterministicModelOutput,
} from "../../src/engine/testing/model-provider";
import { expandSharedBatchContexts, isSharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { expandSharedCatalogPrefix, SHARED_CATALOG_PREFIX_CODEC } from "../../src/engine/mechanics/shared-catalog-prefix";
import { expandSharedCatalogRecords, SHARED_CATALOG_RECORDS_CODEC } from "../../src/engine/mechanics/shared-catalog-records";


export function agentOutput(context: Record<string, unknown>) {
  const output = {
    beliefChanges: { operations: [] },
    characterChanges: { operations: [] },
    nextActionIntent: {
      rawText: "根据当前认知继续观察世界",
      goal: "继续自主行动",
      means: null,
      targetHandles: [],
    },
  };
  const state = context.state && typeof context.state === "object" && !Array.isArray(context.state)
    ? context.state as Record<string, unknown>
    : undefined;
  const slots = Array.isArray(context.slots) ? context.slots : state?.slots;
  if (Array.isArray(slots)) {
    return {
      slots: slots.map((_, slot) => ({ slot, ...output })),
    };
  }
  return output;
}

export function truthOutput(context: Record<string, unknown>): unknown {
  const task = context.task as { slots?: Array<{ slot: number }>; planningWorklist?: { actions: Array<{ actionIndex: number; slot: number;
    action: { actionRef: string; rawText: string; allowedMeansSources: Array<{ kind: string; ref: string; sourcePosition: number }> } }> };
    planCauseChoices?: { choices: Array<{ kind: string; ref: string; slots: number[]; causeIndex: number }> };
    transitionWorklist?: { actions: Array<{ actionIndex: number; slot: number; action: { actionRef: string };
      temporalBoundary: { toElapsedSeconds: number }; activities: Record<string, { completionAtSeconds: number | null }> }> } } | undefined;
  if (task?.planningWorklist && task.planCauseChoices) {
    const choices = task.planCauseChoices.choices;
    return { kind: "commit_plans", plans: task.planningWorklist.actions.map(({ action, actionIndex, slot }) => {
      const source = action.allowedMeansSources.find(row => row.kind === "action" && row.ref === action.actionRef);
      const cause = choices.find(row => row.kind === "action" && row.ref === action.actionRef && row.slots.includes(slot));
      if (!source || !cause) throw new Error("E2E planning fixture requires its own action source");
      return { proposalKey: `plan-${actionIndex}`, actionIndex, targetIndices: [],
        means: [{ description: action.rawText, sourcePosition: source.sourcePosition }],
        mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe",
        primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full",
        causeIndices: [cause.causeIndex], additionalRandomness: "none" };
    }) };
  }
  if (task?.transitionWorklist) {
    const actions = task.transitionWorklist.actions;
    return {
      slots: task.slots?.map(row => row.slot),
      outcomes: actions.map(row => ({ actionIndex: row.actionIndex, proposalKey: `outcome-${row.actionIndex}`,
        status: Object.values(row.activities).some(activity => activity.completionAtSeconds === null ||
          activity.completionAtSeconds > row.temporalBoundary.toElapsedSeconds) ? "continuing" : "succeeded",
        causes: [{ kind: "action", ref: row.action.actionRef }], boundaryClock: true, additionalAssertions: [] })),
      events: actions.map(row => ({ slot: row.slot, proposalKey: `event-${row.actionIndex}`, description: "世界继续变化。",
        impact: "ordinary", causes: [{ kind: "action", ref: row.action.actionRef }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: row.temporalBoundary.toElapsedSeconds }] })),
      mechanicInvocations: [], operations: [], decisionRequests: [],
    };
  }
  let shared = context.state;
  if (shared && typeof shared === "object" && "codec" in shared && shared.codec === SHARED_CATALOG_RECORDS_CODEC) {
    shared = expandSharedCatalogRecords(shared);
  }
  if (shared && typeof shared === "object" && "codec" in shared && shared.codec === SHARED_CATALOG_PREFIX_CODEC) {
    shared = expandSharedCatalogPrefix(shared);
  }
  if (isSharedBatchContext(shared)) return { slots: expandSharedBatchContexts(shared).map((source, slot) => ({ slot, result: truthOutput(source) })) };
  const batch = context as {
    sharedContext?: Record<string, unknown>;
    slots?: Array<{ slot: number; context: Record<string, unknown> }>;
  };
  if (batch.sharedContext && Array.isArray(batch.slots) && batch.slots.every((slot) =>
    slot && typeof slot === "object" && typeof slot.slot === "number" &&
    slot.context && typeof slot.context === "object" && !Array.isArray(slot.context))) {
    return {
      slots: batch.slots.map((slot) => ({
        slot: slot.slot,
        result: truthOutput({ ...batch.sharedContext, ...slot.context }),
      })),
    };
  }
  if (Array.isArray(context.slots) && context.slots.every((slot) =>
    slot && typeof slot === "object" && "action" in slot)) {
    return deterministicActionCompilationBatch("e2e-truth", context);
  }
  // Keep the HTTP fixture on the same contract as the in-process deterministic
  // provider. The production request envelope stores stage/task/state data in
  // nested sections; duplicating that branching here made the fixture drift
  // whenever a schema evolved and masked the real browser path behind 500s.
  const roleContract = context.roleContract && typeof context.roleContract === "object" && !Array.isArray(context.roleContract)
    ? context.roleContract as Record<string, unknown>
    : undefined;
  const role = typeof roleContract?.role === "string" ? roleContract.role : undefined;
  if (role === "arrival-generator") {
    const task = context.task && typeof context.task === "object" && !Array.isArray(context.task)
      ? context.task as Record<string, unknown>
      : {};
    return deterministicModelOutput("truth-e2e", {
      ...context,
      task: { ...task, kind: "arrival" },
    });
  }
  if (role === "causal-verifier" || role === "resolution-plan-verifier") {
    return { verdict: "accept", findings: [] };
  }
  const output = deterministicModelOutput("truth-e2e", context);
  // ScriptedModelProvider unwraps the deterministic Truth directive before
  // validating a transition proposal. Mirror that adapter at the HTTP edge.
  if (output && typeof output === "object" && !Array.isArray(output) &&
    (output as Record<string, unknown>).kind === "transition" &&
    "proposal" in output) {
    return (output as Record<string, unknown>).proposal;
  }
  if (role === "observation-renderer" && output && typeof output === "object") {
    const restoreSummary = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(restoreSummary);
      if (!value || typeof value !== "object") return value;
      const record = value as Record<string, unknown>;
      return {
        ...record,
        ...(typeof record.summary === "string" ? { summary: "你看见庭院中的世界继续变化。" } : {}),
        ...(Array.isArray(record.slots) ? { slots: record.slots.map(restoreSummary) } : {}),
        ...(record.result && typeof record.result === "object" ? { result: restoreSummary(record.result) } : {}),
      };
    };
    return restoreSummary(output);
  }
  return output;
}
