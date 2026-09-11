import { expect, it } from "vitest";
import { z } from "zod";
import { runConditionalCompletionScenario } from "../../benchmarks/step-efficiency/conditional-scenario";
import { evaluateCommittedBehaviorOracle } from "../../benchmarks/step-efficiency/behavior-oracle";
import { truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { promptBundle } from "../../prompts";
import { PHYSICAL_BATCH_REPAIR_NOTICE } from "../../prompts/repair-layout";
import { replaySimulationState } from "../../runtime/transaction";
import { boundaryClockWitnessRequest } from "../boundary-clock-witness";
import { transitionEvidenceWorklistRequest } from "../transition-evidence-worklist";
import type { StructuredModelRequest } from "../../models/model-provider";
import { indexedTransitionRequest, SourceIndexedTransitionCodec } from "../source-indexed-transition";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../truth-batch-provider";

function executionWitnessRequest<T>(request: StructuredModelRequest<T>) {
  const context = request.context as { task: Record<string, unknown>; state: {
    actionSet: { assigned: Array<{ actionRef: string }> }; temporalBoundary: unknown;
  } };
  // The baseline scenario has no indexed pipeline: bind its actual engine clock and actions as fixture input.
  return boundaryClockWitnessRequest({ ...request, wireJsonSchema: z.toJSONSchema(request.schema, { target: "draft-07" }),
    context: { ...context, task: { ...context.task, transitionWorklist: { sourceContextHash: contentHash(context),
      actions: context.state.actionSet.assigned.map(action => ({ action, temporalBoundary: context.state.temporalBoundary })) } } } });
}

it.each(["arrived", "continuing"] as const)("checks a selected clock through loaded-world execution and replay (%s)", async scenario => {
  let calls = 0;
  const { source, result, action, oracle } = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
    calls++;
    const generated = await fallback();
    const selected = executionWitnessRequest(request);
    const value = generated.value as { outcomes: Array<Record<string, unknown>> };
    const wire = { ...value, outcomes: value.outcomes.map(outcome => ({ ...outcome, boundaryClock: true })) };
    return { ...generated, value: selected.schema.parse(selected.preprocessOutput!(wire).value) };
  }, true);
  expect(calls).toBeGreaterThan(0);
  expect(result.committed.causalAssertionResults.some(row => row.target.kind === "outcome" && row.assertion.kind === "elapsed_seconds_compare" &&
    row.assertion.operator === "eq" && row.assertion.value === result.state.truth.elapsedSeconds && row.passed)).toBe(true);
  expect(evaluateCommittedBehaviorOracle({ source, checkpoint: result.state, action, oracle }).verdict).toBe("passed");
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});

it("retains a false additional clock assertion for the actual engine to reject and repair", async () => {
  let calls = 0; const failureEvidence: unknown[] = [];
  await runConditionalCompletionScenario("arrived", async (request, fallback) => {
    const selected = executionWitnessRequest(request);
    const context = selected.context as { task: { transitionWorklist: { actions: Array<{ temporalBoundary: { toElapsedSeconds: number } }> } }; repair: unknown };
    calls++;
    if (calls > 1) failureEvidence.push(context.repair);
    const generated = await fallback(), value = generated.value as { outcomes: Array<{ assertions: unknown[] }> };
    const wire = { ...value, outcomes: value.outcomes.map(outcome => ({ ...outcome, boundaryClock: true,
      assertions: [...outcome.assertions, ...(calls === 1 ? [{ kind: "elapsed_seconds_compare", operator: "lt", value: context.task.transitionWorklist.actions[0]!.temporalBoundary.toElapsedSeconds }] : [])] })) };
    return { ...generated, value: selected.schema.parse(selected.preprocessOutput!(wire).value) };
  });
  expect(calls).toBeGreaterThan(1);
  expect(JSON.stringify(failureEvidence)).toContain("causal assertions failed");
  expect(JSON.stringify(failureEvidence)).toContain('"phase":"after-all-operations"');
  expect(JSON.stringify(failureEvidence)).toContain('"operator":"lt"');
});

it("binds indexed witnesses per action while retaining extra evidence and refusing invalid selections", () => {
  const boundary = { fromElapsedSeconds: 0, deltaSeconds: 10, toElapsedSeconds: 10 };
  const contexts = ["a", "b"].map(id => {
    const action = { actionRef: `ref:action:${id}`, rawText: "Walk and wait for a reply.", goal: "Travel" };
    const plan = { actionRef: action.actionRef, actorRef: "ref:entity:player", targetRefs: [] };
    return { task: {}, state: { actionSet: { assigned: [action] }, committedResolutionPlans: [plan], resolutionReceipts: [{ plan }],
      temporalExecution: { activities: {}, boundary }, canonicalTruth: { elapsedSeconds: 0, facts: {}, entities: { "ref:entity:player": { placementRef: null } }, placements: {} } } };
  });
  const context = { task: { slots: [{ slot: 0 }, { slot: 1 }], assignment: { allowedProposalKinds: [], availableHandles: [], targetHandles: [] } },
    referenceCatalog: { candidates: [], hash: contentHash([]), version: 1 }, state: factorSharedBatchContexts(contexts, "shared-json-v3") };
  const prompt = promptBundle("truth-transition");
  const original = transitionEvidenceWorklistRequest(indexedTransitionRequest({ ...prompt, promptVersion: prompt.version,
    role: "truth-transition", profileId: "truth-deepseek", workloadId: "clock-fixture", batchId: "clock-fixture", subjectId: "source",
    schemaName: "truth_transition_batch", schema: truthTransitionBatchSchema, context, userPrompt: prompt.userPrompt + "\n\n" + SHARED_SLOT_RESULT_INSTRUCTION }));
  const selected = boundaryClockWitnessRequest({ ...original, userPrompt: original.userPrompt + "\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE });
  const extra = { kind: "elapsed_seconds_compare", operator: "lt", value: 10 };
  const canonical = { slots: [0, 1].map(slot => ({ slot, result: { outcomes: [{ proposalKey: `o-${slot}`, actionRef: `ref:action:${slot ? "b" : "a"}`,
    status: "continuing", summary: "Pending", causes: [{ kind: "action", ref: `ref:action:${slot ? "b" : "a"}` }], assertions: [extra] }],
    operations: [], events: [], mechanicInvocations: [], decisionRequests: [] } })) };
  const wire = new SourceIndexedTransitionCodec(context).encode(canonical);
  for (const row of wire.outcomes as Record<string, unknown>[]) { delete row.firstAssertion; row.boundaryClock = true; row.additionalAssertions = [extra]; }
  const before = contentHash(wire), decoded = selected.schema.parse(selected.preprocessOutput!(wire).value);
  expect(contentHash(wire)).toBe(before);
  expect(selected.context).toBe(original.context);
  expect(selected.system).toBe(original.system);
  expect(selected.userPrompt.endsWith("\n\n" + PHYSICAL_BATCH_REPAIR_NOTICE)).toBe(true);
  for (const slot of decoded.slots) expect(slot.result.outcomes[0]!.assertions).toEqual([{ kind: "elapsed_seconds_compare", operator: "eq", value: 10 }, extra]);
  const first = (wire.outcomes as Record<string, unknown>[])[0]!;
  for (const bad of [false, undefined]) {
    first.boundaryClock = bad;
    expect(() => selected.schema.parse(selected.preprocessOutput!(wire).value)).toThrow();
  }
  first.boundaryClock = true; first.firstAssertion = extra;
  expect(() => selected.schema.parse(selected.preprocessOutput!(wire).value)).toThrow();
  expect(() => boundaryClockWitnessRequest(selected)).toThrow("one bound");
  const invalidContext = structuredClone(original.context) as { task: { transitionWorklist: { actions: Array<{ temporalBoundary: typeof boundary }> } } };
  invalidContext.task.transitionWorklist.actions[0]!.temporalBoundary.toElapsedSeconds = 11;
  expect(() => boundaryClockWitnessRequest({ ...original, context: invalidContext })).toThrow("clock binding invalid");
});
