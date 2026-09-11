import { expect, it } from "vitest";
import { z } from "zod";
import { factorSharedBatchContexts, SHARED_BATCH_ORDER_CODEC } from "../../mechanics/shared-batch-context";
import { compactSharedCatalogPrefix } from "../../mechanics/shared-catalog-prefix";
import { compactSharedCatalogRecords } from "../../mechanics/shared-catalog-records";
import { promptBundle } from "../../prompts";
import { planningActionFrames, planningActionFramesRequest } from "./planning-action-frames";

function fixture() {
  const actions = ["guest", "traveler"].map((name, i) => ({ actionRef: `ref:action:${name}`, actorRef: `ref:agent:${name}`,
    rawText: i ? "Ask about lodging and local factions" : "Ask about lodging", goal: "Find lodging", means: null, targetRefs: [] }));
  const boundary = { fromElapsedSeconds: 0, toElapsedSeconds: 10, deltaSeconds: 10 };
  const contexts = actions.map((action, i) => ({ state: { actionSet: { assigned: [action] },
    actors: [{ agentRef: action.actorRef, entityRef: `ref:entity:${i}` }],
    canonicalTruth: { entities: { [`ref:entity:${i}`]: { name: "Newcomer", description: `Distinct actor ${i}` } } },
    temporalBoundary: { ...boundary, dueActivityIds: ["engine-id"] },
    temporalExecution: { boundary: { ...boundary, dueActivityRefs: ["ref:activity:guest"] }, activities: {
      [`ref:activity:${i}`]: { sourceActionRef: action.actionRef, actorRef: action.actorRef, completionAtSeconds: i ? null : 10,
        nextBoundaryAtSeconds: i ? 300 : 10, status: "active", plan: { mode: i ? "ongoing" : "fixed" } },
    } },
  }, referenceCatalog: { candidates: [] } }));
  const state = compactSharedCatalogRecords(compactSharedCatalogPrefix(factorSharedBatchContexts(contexts, SHARED_BATCH_ORDER_CODEC)));
  return { context: { state, task: { planningWorklist: { actionCount: 2, actions: actions.map((action, slot) => ({ actionIndex: slot, slot, action })) } } }, contexts };
}

it("keeps similar actors and their original action clauses separate and joins current clock with future Activity checkpoints", () => {
  const { context } = fixture();
  const before = structuredClone(context);
  const frames = planningActionFrames(context).frames;
  expect(frames).toMatchObject([
    { actionIndex: 0, sourceAction: { rawText: "Ask about lodging" }, actor: { entityRef: "ref:entity:0" },
      interval: { toElapsedSeconds: 10 }, activity: { completionAtSeconds: 10, nextBoundaryAtSeconds: 10 } },
    { actionIndex: 1, sourceAction: { rawText: "Ask about lodging and local factions" }, actor: { entityRef: "ref:entity:1" },
      interval: { toElapsedSeconds: 10 }, activity: { completionAtSeconds: null, nextBoundaryAtSeconds: 300 } },
  ]);
  expect(context).toEqual(before);
});

it("rejects mismatched actors, altered source actions and inconsistent clocks before model dispatch", () => {
  const { context, contexts } = fixture();
  const wrongActor = structuredClone(contexts);
  wrongActor[0]!.state.temporalExecution.activities["ref:activity:0"]!.actorRef = "ref:agent:traveler";
  expect(() => planningActionFrames(context, wrongActor)).toThrow("Activity identity");
  const wrongClock = structuredClone(contexts);
  wrongClock[0]!.state.temporalExecution.boundary.toElapsedSeconds = 300;
  expect(() => planningActionFrames(context, wrongClock)).toThrow("temporal boundary mismatch");
  const wrongAction = structuredClone(context);
  wrongAction.task.planningWorklist.actions[0]!.action.rawText = "Ask about local factions";
  expect(() => planningActionFrames(wrongAction, contexts)).toThrow("source action changed");
});

it("only adds source evidence and rejects mutation without rewriting model output or changing the schema", () => {
  const { context } = fixture(), prompt = promptBundle("truth-resolution");
  const schema = z.object({ valid: z.boolean() });
  const request = { ...prompt, promptVersion: prompt.version, workloadId: "world", batchId: "step", profileId: "truth", subjectId: "batch",
    role: "truth-resolution" as const, schemaName: "truth_resolution_plan_commit_batch", schema, context };
  const candidate = planningActionFramesRequest(request);
  expect(candidate.schema).toBe(schema);
  expect(candidate.wireJsonSchema).toBeUndefined();
  expect(candidate.userPrompt).toBe(request.userPrompt);
  const restored = structuredClone(candidate.context) as { task: Record<string, unknown> };
  delete restored.task.planningActionFrames;
  expect(restored).toEqual(context);
  const value = { invalid: "untouched" };
  expect(candidate.preprocessOutput!(value).value).toBe(value);
  expect(schema.safeParse(candidate.preprocessOutput!(value).value).success).toBe(false);
  expect(() => planningActionFramesRequest(candidate)).toThrow("already applied");
  (candidate.context as { task: Record<string, unknown> }).task.planningActionFrames = {};
  expect(() => candidate.preprocessOutput!(value)).toThrow("projection changed");
});
