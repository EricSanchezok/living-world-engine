import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { TruthEngine } from "../../mechanics/truth-engine";
import { createActivity, materializeTemporalPlan, selectTemporalBoundary } from "../../mechanics/temporal";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { ModelConfigurationError, type StructuredModelProvider } from "../../models/model-provider";
import { createTestModelAudit, createTestModelCatalog, createTestModelRegistry, ScriptedModelProvider } from "../../testing/model-provider";
import { agentIntentProgramSchema, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";
import { INITIAL_INTENT_FRONTIER, InitialIntentFrontierView, initialIntentFrontierProvider } from "./initial-intent-frontier";

const program = agentIntentProgramSchema.parse({ root: 0, nodes: [
  { nodeId: 0, kind: "parallel", children: [1, 4, 7, 9] },
  { nodeId: 1, kind: "sequence", children: [2, 3] },
  { nodeId: 2, kind: "attempt", text: " 询问对方。\n", targetIndices: [0] },
  { nodeId: 3, kind: "attempt", text: "观察对方展示的物件", targetIndices: [1] },
  { nodeId: 4, kind: "if", condition: "对方愿意展示物件", targetIndices: [0, 1], thenNode: 5, elseNode: 6 },
  { nodeId: 5, kind: "attempt", text: "查看物件", targetIndices: [1] },
  { nodeId: 6, kind: "attempt", text: "结束询问", targetIndices: [0] },
  { nodeId: 7, kind: "while", condition: "仍在等待", targetIndices: [0], body: 8 },
  { nodeId: 8, kind: "attempt", text: "留意来往者", targetIndices: [0] },
  { nodeId: 9, kind: "await", condition: "对方作出答复", targetIndices: [0] },
] });
const text = INTENT_PROGRAM_PREFIX + JSON.stringify(program);
const action = (actor: string) => ({ actionRef: `ref:action:${actor}`, actorRef: `ref:agent:${actor}`, rawText: text, goal: text, means: null,
  targetRefs: [`ref:local_entity:${actor}::visitor`, `ref:local_entity:${actor}::item`] });
const activity = (actor: string) => ({ sourceActionRef: `ref:action:${actor}`, actorRef: `ref:agent:${actor}`, status: "active",
  startedAtSeconds: 0, updatedAtSeconds: 0, stageIndex: 0, progress: null as unknown,
  nextBoundaryAtSeconds: 300, plan: { startsAtSeconds: 0, progress: null, stages: [] as unknown[] } });
const context = () => ({ task: { stage: "plan" }, state: { actionSet: { initial: [action("a"), action("b")],
  available: [action("a"), action("b")], assigned: [action("a")] }, committedResolutionPlans: [] as unknown[], resolutionReceipts: [] as unknown[],
  temporalExecution: { contractVersion: "activity-temporal-evidence-v1", sourceHash: "source", boundary: { fromElapsedSeconds: 0, toElapsedSeconds: 10 },
    activities: { "ref:activity:a": activity("a") } as Record<string, ReturnType<typeof activity>> },
  canonicalTruth: { untouched: text }, actors: { a: { bindings: { item: ["ref:entity:one", "ref:entity:two"] } } } } });

it("preserves complete source and exposes only the assigned initial attempts and unevaluated conditions", () => {
  const source = context(), before = structuredClone(source), view = new InitialIntentFrontierView(source);
  expect(view.rows).toHaveLength(1); expect(view.rows[0]).toMatchObject({ actionRef: "ref:action:a", root: 0, nodeCount: 10,
    sourceActionHash: contentHash(source.state.actionSet.assigned[0]), programHash: contentHash(program),
    activityHash: contentHash(source.state.temporalExecution.activities["ref:activity:a"]) });
  expect(view.rows[0]!.frontier.map(node => node.nodeId)).toEqual([4, 7, 9, 2]);
  expect(view.rows[0]!.frontier[0]).toEqual({ nodeId: 4, kind: "if", condition: "对方愿意展示物件", thenNode: 5, elseNode: 6,
    localTargetRefs: ["ref:local_entity:a::visitor", "ref:local_entity:a::item"] });
  expect(view.rows[0]!.frontier[3]).toEqual({ nodeId: 2, kind: "attempt", text: " 询问对方。\n", localTargetRefs: ["ref:local_entity:a::visitor"] });
  expect((view.context as ReturnType<typeof context>).state).toEqual(before.state); expect(source).toEqual(before);
  expect(() => view.assertUnchanged()).not.toThrow();
});

it("keeps identical programs bound to their own action targets and leaves unknown binding resolution to truth", () => {
  const source = context(); source.state.actionSet.assigned.push(action("b")); source.state.temporalExecution.activities["ref:activity:b"] = activity("b");
  const view = new InitialIntentFrontierView(source);
  expect(view.rows[0]!.frontier[0]!.localTargetRefs).toEqual(["ref:local_entity:a::visitor", "ref:local_entity:a::item"]);
  expect(view.rows[1]!.frontier[0]!.localTargetRefs).toEqual(["ref:local_entity:b::visitor", "ref:local_entity:b::item"]);
  expect((view.context as ReturnType<typeof context>).state.actors).toEqual(source.state.actors);
});

it("never resets elapsed, progressed, staged, queued, previously adjudicated or ambiguous activities", () => {
  const changes: Array<(source: ReturnType<typeof context>) => void> = [
    s => { s.state.temporalExecution.boundary.fromElapsedSeconds = 1; },
    s => { s.state.temporalExecution.activities["ref:activity:a"]!.updatedAtSeconds = 1; },
    s => { s.state.temporalExecution.activities["ref:activity:a"]!.plan.startsAtSeconds = 1; },
    s => { s.state.temporalExecution.activities["ref:activity:a"]!.progress = { completed: 1 }; },
    s => { s.state.temporalExecution.activities["ref:activity:a"]!.plan.stages.push({ name: "work" }); },
    s => { s.state.temporalExecution.activities["ref:activity:a"]!.status = "queued"; },
    s => { s.state.temporalExecution.activities["ref:activity:a"]!.actorRef = "ref:agent:b"; },
    s => { s.state.temporalExecution.activities["ref:activity:duplicate"] = activity("a"); },
    s => { s.state.temporalExecution.activities = {}; },
    s => { s.state.committedResolutionPlans.push({ actionRef: "ref:action:a" }); },
    s => { s.state.resolutionReceipts.push({ actionRef: "ref:action:a" }); },
  ];
  for (const change of changes) { const source = context(); change(source); const view = new InitialIntentFrontierView(source);
    expect(view.rows).toEqual([]); expect(view.context).toEqual(source); }
  const atDeadline = context(); atDeadline.state.temporalExecution.boundary.toElapsedSeconds = 300;
  expect(new InitialIntentFrontierView(atDeadline).rows).toHaveLength(1);
});

it("retains arbitrary, malformed and foreign-local program text as opaque intentions", () => {
  for (const raw of ["Ask freely", INTENT_PROGRAM_PREFIX + "{broken", INTENT_PROGRAM_PREFIX + JSON.stringify(program, null, 2),
    INTENT_PROGRAM_PREFIX + JSON.stringify({ ...program, root: 100 })]) {
    const source = context(); for (const rows of Object.values(source.state.actionSet)) for (const a of rows) a.rawText = a.goal = raw;
    const view = new InitialIntentFrontierView(source); expect(view.rows).toEqual([]); expect(view.context).toEqual(source);
  }
  for (const targets of [["ref:local_entity:b::visitor", "ref:local_entity:b::item"], ["ref:local_entity:a::visitor", "ref:local_entity:a::visitor"]]) {
    const source = context(); for (const rows of Object.values(source.state.actionSet)) for (const a of rows) if (a.actorRef === "ref:agent:a") a.targetRefs = targets;
    expect(new InitialIntentFrontierView(source).rows).toEqual([]);
  }
});

it("fails closed on missing evidence, differing source copies and repeated application", () => {
  expect(() => new InitialIntentFrontierView({ ...context(), state: {} })).toThrow("complete logical actions");
  const differing = context(); differing.state.actionSet.assigned[0]!.targetRefs.reverse();
  expect(() => new InitialIntentFrontierView(differing)).toThrow("differs between worksets");
  expect(() => new InitialIntentFrontierView(new InitialIntentFrontierView(context()).context)).toThrow("already present");
});

it.each(["source", "view"])("rejects %s mutation even when the physical provider fails", async kind => {
  const source = context(), schema = z.object({ valid: z.boolean() }), preprocessOutput = (raw: unknown) => ({ value: raw, symbolRepairs: [] });
  const base = new ScriptedModelProvider(() => ({}));
  const provider = initialIntentFrontierProvider({ catalog: base.catalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => {},
    generateStructured: async request => {
      expect(request.schema).toBe(schema); expect(request.preprocessOutput).toBe(preprocessOutput); expect(request.promptVersion).toContain(INITIAL_INTENT_FRONTIER);
      const changed = kind === "source" ? source : request.context as ReturnType<typeof context>;
      changed.state.actionSet.assigned[0]!.targetRefs.reverse(); throw new Error("physical provider failed");
    } });
  await expect(provider.generateStructured({ role: "truth-resolution", schemaName: "truth_resolution_plan_commit", profileId: "truth-engine",
    workloadId: "world", batchId: "step", subjectId: "a", promptVersion: "source", system: "source", userPrompt: "plan",
    context: source, schema, preprocessOutput })).rejects.toThrow("source or view mutated");
});

it("restores logical audit identity while retaining physical provenance and passes other roles unchanged", async () => {
  const schema = z.object({ valid: z.boolean() }), base = new ScriptedModelProvider(() => ({}));
  const provider = initialIntentFrontierProvider({ catalog: base.catalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => {},
    generateStructured: async request => ({ value: request.schema.parse({ valid: true }), audit: { ...createTestModelAudit(request.role, request.subjectId, `sha256:${contentHash("frontier")}`), promptVersion: request.promptVersion } }) });
  const request = { role: "truth-resolution" as const, schemaName: "truth_resolution_plan_commit", profileId: "truth-engine", workloadId: "world",
    batchId: "step", subjectId: "a", promptVersion: "source", system: "source", userPrompt: "plan", context: context(), schema };
  expect((await provider.generateStructured(request)).audit.promptVersion).toBe("source");
  expect((await provider.generateStructured({ ...request, role: "causal-verifier", context: {} })).value).toEqual({ valid: true });
});

it.each([false, true])("retains canonical admission and rejection through TruthEngine and the real gateway (bad target=%s)", async invalid => {
  const catalog = createTestModelCatalog(), bodies: unknown[] = [];
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 31, modelCatalog: catalog });
  const state = structuredClone(definition.initialState), rawText = INTENT_PROGRAM_PREFIX + JSON.stringify({ root: 0,
    nodes: [{ nodeId: 0, kind: "attempt", text: "Observe the courtyard.", targetIndices: [] }] });
  const action = { id: `rt:action:${"a".repeat(64)}`, actorId: "player", baseRevision: state.revision, rawText, goal: rawText, means: null, targetIds: [] };
  const plan = materializeTemporalPlan({ id: "frontier-test", actionId: action.id, actorId: action.actorId, rawText,
    startsAtSeconds: 0, profiles: state.truth.mechanics.temporalProfiles, draft: { profileId: "ongoing-action", basis: { kind: "profile" },
      description: rawText, causes: [{ kind: "action", id: action.id }], continuationAssertions: [{ kind: "elapsed_seconds_compare", operator: "lt", value: 5000 }] } });
  const active = createActivity({ id: `rt:activity:${"b".repeat(64)}`, plan, sourceAction: action }); state.truth.activities = { [active.id]: active };
  const boundary = selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 10, activities: state.truth.activities, timers: {}, conditionExpiries: {} });
  const grounding = { kind: "action" as const, id: action.id, actorId: action.actorId, reads: [], writes: [], audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false };
  const before = contentHash({ state, action, grounding }); let admitted = 0, assignedActionRef = "";
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body); expect(JSON.stringify(body)).toContain("initialIntentFrontiers");
      const ref = assignedActionRef, output = { kind: "commit_plans", plans: [{ proposalKey: "observe", actionRef: ref,
        targetRefs: [invalid ? "ref:entity:does-not-exist" : "ref:entity:player"], means: [{ description: "Observe", source: { kind: "action", ref } }], factors: [],
        mode: "automatic", difficulty: null, actorRatingRef: null, risk: "safe", baseEffect: "none", primaryEffect: null,
        secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref }] }] };
      return Response.json({ id: "frontier-test", model: "fixture", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 30, completion_tokens: 40, total_tokens: 70 } });
    } });
  const viewProvider = initialIntentFrontierProvider(gateway);
  const logical: StructuredModelProvider = { catalog: gateway.catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async request => {
    if (request.role === "causal-verifier") { admitted++; throw new ModelConfigurationError("mechanical admission only"); }
    assignedActionRef = (request.context as { state: { actionSet: { assigned: Array<{ actionRef: string }> } } }).state.actionSet.assigned[0]!.actionRef;
    return viewProvider.generateStructured(request);
  } };
  const engine = new TruthEngine(logical, { repairAttempts: 0, includeActivityTemporalEvidence: true, includeResolutionMeansSources: true });
  const result = engine.resolve({ definition, state, initialActions: [action], groundings: [grounding], identityOwner: "frontier-test", temporalBoundary: boundary,
    modelWorkset: { state, initialActions: [action], availableActions: [action], availableDependencies: [grounding] },
    resolutionScope: { mode: "component", selectedActionIds: [action.id], totalActionCount: 1 },
    renderObservations: async () => { throw new Error("unexpected observations"); }, validateProposal: () => { throw new Error("unexpected commit"); },
  }, { workloadId: "test", batchId: "test", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  await expect(result).rejects.toThrow(invalid ? /reference|unknown|invalid|does-not-exist/i : "mechanical admission only");
  expect(bodies).toHaveLength(1); expect(admitted).toBe(invalid ? 0 : 1); expect(contentHash({ state, action, grounding })).toBe(before);
});
