import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { ModelOutputError, type StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, createTestModelRegistry, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { buildPerceptionSourceIndex } from "../perception-source-index";
import { perceptionSourceFramesRequest } from "../perception-source-frames";

it("factors two real observer assignments into one untrusted source frame and preserves rejected gateway evidence", async () => {
  const provider = new ScriptedModelProvider(() => ({ kind: "done", reports: noStimulusReportsForTargets(input) }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  state.truth.entities.listener = { ...structuredClone(state.truth.entities.keeper!), id: "listener", name: "Another guard" };
  state.truth.placements.listener = state.truth.placements.keeper!;
  state.agents.listener = { ...structuredClone(state.agents.keeper!), id: "listener", entityId: "listener" };
  state.agents.listener.bindings.self!.canonicalEntityIds = ["listener"];
  const input = { definition, state, identityOwner: "source-frames", groundings: [],
    actions: [{ id: "greet", actorId: "player", baseRevision: state.revision,
      rawText: "I greet the keeper. I ask a witness to tell the keeper tomorrow.",
      goal: "I privately plan a surprise.", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "greet" }, { observerId: "listener", sourceActionId: "greet" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), generate = provider.generateStructured.bind(provider);
  let captured: StructuredModelRequest<unknown> | undefined;
  provider.generateStructured = request => { captured = request; return generate(request); };
  await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "frames-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  const original = { ...captured!, jsonObjectPostlude: "Complete existing authored-law source." };
  const adapted = perceptionSourceFramesRequest(original), source = original.context as Record<string, unknown>, context = adapted.context as Record<string, unknown>;
  expect({ ...context, roleContract: source.roleContract }).toEqual(source);
  expect(adapted.jsonObjectPostlude?.startsWith(original.jsonObjectPostlude)).toBe(true);
  expect(adapted.jsonObjectPostlude).toContain(JSON.stringify(buildPerceptionSourceIndex(source)));
  expect(adapted.jsonObjectPostlude).toContain('"targetIndices":[0,1]');
  expect(adapted.system).toContain("before any observer-specific perception projection");
  expect(adapted.system).not.toContain("Return only the requested check batch");
  const draft = { frames: [{ sourceActionRef: "ref:action:greet", sourceActorRef: "ref:entity:player", currentOnset: "向守卫打招呼，并请求见证者稍后带话。",
    firstRecipients: [{ entityRef: "ref:entity:keeper" as string | null, description: "眼前的守卫" }, { entityRef: null, description: "未命名的见证者" }],
    laterOrConditional: ["见证者明天向守卫带话"], privateIntentNotSpoken: ["策划惊喜的私人动机"], uncertainty: "见证者是否已经在场仍不明确。",
    sourceQuotes: [{ field: "rawText", text: "I greet the keeper." }], evidence: [{ kind: "entity", ref: "ref:entity:player" }] }] };
  let response: unknown = draft;
  const physical: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const gateway = createModelGateway(provider.catalog, { TEST_MODEL_API_KEY: "test-only" }, {
    registry: createTestModelRegistry(provider.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      physical.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "frames-test", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(response) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
    },
  });
  const result = await gateway.generateStructured(adapted);
  expect(result.value).toEqual(draft);
  expect(result.value.frames).toHaveLength(1);
  expect(result.value.frames[0]!.firstRecipients[1]!.entityRef).toBeNull();
  expect(result.value.frames[0]!.uncertainty).toBe(draft.frames[0]!.uncertainty);
  expect(result.value).not.toHaveProperty("reports");
  expect(physical[0]!.messages.find(message => message.role === "user")!.content).not.toContain("Example JSON output shape:");
  for (const mutate of [
    (copy: typeof draft) => { copy.frames.push(structuredClone(copy.frames[0]!)); },
    (copy: typeof draft) => { copy.frames = []; },
    (copy: typeof draft) => { copy.frames[0]!.sourceActorRef = "ref:entity:keeper"; },
    (copy: typeof draft) => { copy.frames[0]!.sourceActionRef = "ref:action:invented"; },
    (copy: typeof draft) => { copy.frames[0]!.firstRecipients[0]!.entityRef = "ref:entity:invented"; },
    (copy: typeof draft) => { copy.frames[0]!.sourceQuotes[0]!.text = input.actions[0]!.goal; },
    (copy: typeof draft) => { copy.frames[0]!.sourceQuotes[0]!.field = "means"; },
    (copy: typeof draft) => { copy.frames[0]!.evidence[0]!.ref = "ref:entity:invented"; },
  ]) {
    const changed = structuredClone(draft); mutate(changed); response = changed;
    await expect(gateway.generateStructured(adapted)).rejects.toMatchObject({ name: "ModelOutputError", rawValue: changed,
      audit: { invocations: [expect.objectContaining({ tokenUsage: expect.objectContaining({ input: 100, output: 20 }) })] } });
  }
  response = { kind: "done", reports: [] };
  await expect(gateway.generateStructured(adapted)).rejects.toBeInstanceOf(ModelOutputError);
  expect(() => perceptionSourceFramesRequest(adapted)).toThrow("original perception");
  expect(contentHash(input)).toBe(before);
  context.repair = { changed: true };
  expect(() => adapted.preprocessOutput!(draft)).toThrow("context changed");
});
