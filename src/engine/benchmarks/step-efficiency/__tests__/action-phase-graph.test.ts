import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { referenceHandleFor } from "../../../contracts/model-context";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { type StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, createTestModelRegistry, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { buildPerceptionSourceIndex } from "../perception-source-index";
import { actionPhaseGraphRequest, actionPhaseGraphSchema, initialActionPhaseFrontier } from "../action-phase-graph";

it("keeps parallel attempts, completion edges and unknown prerequisites distinct through the real source and gateway", async () => {
  const provider = new ScriptedModelProvider(() => ({ kind: "done", reports: noStimulusReportsForTargets(input) }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  state.truth.entities.listener = { ...structuredClone(state.truth.entities.keeper!), id: "listener", name: "Another guard" };
  state.truth.placements.listener = state.truth.placements.keeper!;
  state.agents.listener = { ...structuredClone(state.agents.keeper!), id: "listener", entityId: "listener" };
  state.agents.listener.bindings.self!.canonicalEntityIds = ["listener"];
  const input = { definition, state, identityOwner: "phase-graph", groundings: [],
    actions: [{ id: "greet", actorId: "player", baseRevision: state.revision,
      rawText: "I greet the keeper while asking a witness to carry my message tomorrow. After delivery I ask about its arrival. If a reply arrives, I acknowledge it. The keeper may independently decide whether to respond.",
      goal: "I privately plan a surprise.", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "greet" }, { observerId: "listener", sourceActionId: "greet" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), generate = provider.generateStructured.bind(provider);
  let captured: StructuredModelRequest<unknown> | undefined;
  provider.generateStructured = request => { captured = request; return generate(request); };
  await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "graph-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  const original = { ...captured!, jsonObjectPostlude: "Original full world evidence." };
  const adapted = actionPhaseGraphRequest(original), source = original.context as Record<string, unknown>, context = adapted.context as Record<string, unknown>;
  expect({ ...context, roleContract: source.roleContract }).toEqual(source);
  expect(adapted.jsonObjectPostlude?.startsWith(original.jsonObjectPostlude)).toBe(true);
  expect(adapted.jsonObjectPostlude).toContain(JSON.stringify(buildPerceptionSourceIndex(source)));
  const actor = { entityRef: "ref:entity:player", description: "提议者" };
  const quote = [{ field: "rawText" as const, text: input.actions[0]!.rawText }];
  const step = (stepId: number, attempt: string) => ({ stepId, attempt, performer: actor,
    addressedParties: [{ entityRef: "ref:entity:keeper", description: "守卫" }], requiresCompletionOf: [] as number[],
    externalPrerequisites: [] as string[], sourceQuotes: quote });
  const draft = actionPhaseGraphSchema.parse({ graphs: [{ sourceActionRef: "ref:action:greet", sourceActorRef: "ref:entity:player",
    unspokenIntent: [input.actions[0]!.goal], steps: [step(0, "招呼守卫"), step(1, "请见证者稍后带话"),
      { ...step(2, "明天携带消息"), performer: { entityRef: null, description: "未命名见证者" }, requiresCompletionOf: [1], externalPrerequisites: ["明天到来并且愿意代送"] },
      { ...step(3, "追问是否送达"), requiresCompletionOf: [2] },
      { ...step(4, "收到回复后致谢"), externalPrerequisites: ["回复已到达"] },
      { ...step(5, "被问到的守卫考虑回应"), performer: { entityRef: "ref:entity:keeper", description: "守卫" } },
    ] }] });
  let response: unknown = draft;
  const physical: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const gateway = createModelGateway(provider.catalog, { TEST_MODEL_API_KEY: "test-only" }, {
    registry: createTestModelRegistry(provider.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      physical.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "graph-test", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(response) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
    },
  });
  const result = await gateway.generateStructured(adapted);
  expect(result.value).toEqual(draft);
  expect(result.value.graphs).toHaveLength(1);
  expect(initialActionPhaseFrontier(result.value.graphs[0]!)).toEqual([
    { stepId: 0, status: "candidate_attempt" }, { stepId: 1, status: "candidate_attempt" },
    { stepId: 2, status: "waiting_for_predecessor" }, { stepId: 3, status: "waiting_for_predecessor" },
    { stepId: 4, status: "waiting_for_external_evidence" }, { stepId: 5, status: "external_performance" },
  ]);
  expect(result.value).not.toHaveProperty("reports");
  expect(physical[0]!.messages.find(message => message.role === "user")!.content).not.toContain("Example JSON output shape:");
  for (const mutate of [
    (copy: typeof draft) => { copy.graphs.push(structuredClone(copy.graphs[0]!)); },
    (copy: typeof draft) => { copy.graphs = []; },
    (copy: typeof draft) => { copy.graphs[0]!.sourceActorRef = referenceHandleFor("entity", "keeper"); },
    (copy: typeof draft) => { copy.graphs[0]!.sourceActionRef = referenceHandleFor("action", "invented"); },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.performer.entityRef = referenceHandleFor("entity", "invented"); },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.addressedParties[0]!.entityRef = referenceHandleFor("entity", "invented"); },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.sourceQuotes[0]!.text = input.actions[0]!.goal; },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.sourceQuotes[0]!.field = "means"; },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.stepId = 1; },
    (copy: typeof draft) => { copy.graphs[0]!.steps = []; },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.requiresCompletionOf = [999]; },
    (copy: typeof draft) => { copy.graphs[0]!.steps[0]!.requiresCompletionOf = [0]; },
    (copy: typeof draft) => { copy.graphs[0]!.steps[1]!.requiresCompletionOf = [2]; },
    (copy: typeof draft) => { copy.graphs[0]!.steps[2]!.requiresCompletionOf = [1, 1]; },
  ]) {
    const changed = structuredClone(draft); mutate(changed); response = changed;
    await expect(gateway.generateStructured(adapted)).rejects.toMatchObject({ name: "ModelOutputError", rawValue: changed,
      audit: { invocations: [expect.objectContaining({ tokenUsage: expect.objectContaining({ input: 100, output: 20 }) })] } });
  }
  expect(() => actionPhaseGraphRequest(adapted)).toThrow("original perception");
  expect(contentHash(input)).toBe(before);
  context.repair = { changed: true };
  expect(() => adapted.preprocessOutput!(draft)).toThrow("context changed");
});
