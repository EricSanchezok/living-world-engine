import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { ModelOutputError, type StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider, createTestModelRegistry, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { perceptionSemanticDraftRequest } from "../perception-semantic-draft";

it("screens a real source through the gateway without converting a semantic draft into perception", async () => {
  const provider = new ScriptedModelProvider(() => ({ kind: "done", reports: noStimulusReportsForTargets(input) }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const input = { definition, state, identityOwner: "semantic-draft", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve", goal: "Hide it", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), generate = provider.generateStructured.bind(provider);
  let captured: StructuredModelRequest<unknown> | undefined;
  provider.generateStructured = request => { captured = request; return generate(request); };
  await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "draft-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  const original = { ...captured!, jsonObjectPostlude: "Existing complete authored-law source." };
  const adapted = perceptionSemanticDraftRequest(original);
  const sourceContext = original.context as Record<string, unknown>, context = adapted.context as Record<string, unknown>;
  expect(contentHash({ ...context, roleContract: sourceContext.roleContract })).toBe(contentHash(sourceContext));
  expect(adapted.jsonObjectPostlude?.startsWith(original.jsonObjectPostlude)).toBe(true);
  expect(adapted.jsonObjectPostlude).toContain(input.actions[0]!.rawText);
  expect(adapted.system).toContain("intermediate analysis artifact");
  expect(adapted.system).not.toContain("Return only the requested check batch");
  expect(adapted.jsonExamplePolicy).toBe("omit");
  const draft = { assessments: [{ targetIndex: 0, observerRef: "ref:entity:keeper", sourceActionRef: "ref:action:conceal", sourceActorRef: "ref:entity:player",
    currentOnset: "A concealment attempt begins.", sensoryOrInformationRoute: "Whether the keeper sees the hand movement remains unresolved.",
    access: "unresolved", availableInformation: "", excludedFutureOrPrivateInformation: "Successful concealment and private intention.",
    evidence: [{ kind: "entity", ref: "ref:entity:keeper" }] }] };
  let response: unknown = draft;
  const physical: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const gateway = createModelGateway(provider.catalog, { TEST_MODEL_API_KEY: "test-only" }, {
    registry: createTestModelRegistry(provider.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      physical.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "draft-test", model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(response) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await gateway.generateStructured(adapted);
  expect(result.value).toEqual(draft);
  expect(result.value.assessments[0]!.access).toBe("unresolved");
  expect(physical[0]!.messages.find(message => message.role === "user")!.content).not.toContain("Example JSON output shape:");
  for (const mutate of [
    (copy: typeof draft) => { copy.assessments.push(structuredClone(copy.assessments[0]!)); },
    (copy: typeof draft) => { copy.assessments = []; },
    (copy: typeof draft) => { copy.assessments[0]!.sourceActorRef = "ref:entity:keeper"; },
    (copy: typeof draft) => { copy.assessments[0]!.sourceActionRef = "ref:action:invented"; },
    (copy: typeof draft) => { copy.assessments[0]!.evidence[0]!.ref = "ref:entity:invented"; },
  ]) {
    const changed = structuredClone(draft); mutate(changed); response = changed;
    await expect(gateway.generateStructured(adapted)).rejects.toMatchObject({ name: "ModelOutputError", rawValue: changed,
      audit: { invocations: [expect.objectContaining({ tokenUsage: expect.objectContaining({ input: 100, output: 20 }) })] } });
  }
  response = { kind: "done", reports: [] };
  await expect(gateway.generateStructured(adapted)).rejects.toBeInstanceOf(ModelOutputError);
  expect(() => perceptionSemanticDraftRequest(adapted)).toThrow("original perception task");
  expect(contentHash(input)).toBe(before);
  context.repair = { changed: true };
  expect(() => adapted.preprocessOutput!(draft)).toThrow("source changed");
});
