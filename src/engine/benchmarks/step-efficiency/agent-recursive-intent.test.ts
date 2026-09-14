import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { registerIntegratedPlayerAlgorithm } from "./integrated-player-algorithm";
import { recursivePlayerAlgorithmRef } from "./recursive-player-algorithm";
import { createActionCompilationRetrievalRuntimeProvider } from "../../../server/action-compilation-retrieval-runtime";
import { agentMindBatchOutputSchema } from "../../contracts/llm-schemas";
import { loadWorldScript } from "../../../script/world-loader";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";
import { agentRecursiveIntentRequest, decodeRecursiveIntent, expandIndexedIntent, lowerRecursiveIntent,
  recursiveIntentSchema, type RecursiveIntent } from "./agent-recursive-intent";

const attempt = (text: string, target = "self"): RecursiveIntent => ({ kind: "attempt", text, targetHandles: [`ref:local_entity:${target}`] });
const tree = recursiveIntentSchema.parse({ kind: "parallel", children: [
  { kind: "sequence", children: [attempt(" 询问旅人是否愿意出示钥匙；不同意也不阻拦。\n", "traveler"),
    { kind: "await", condition: "旅人作出可察觉的答复", targetHandles: ["ref:local_entity:traveler"] },
    { kind: "if", condition: "旅人愿意出示钥匙", targetHandles: ["ref:local_entity:traveler"],
      thenNode: attempt("查看他展示的钥匙", "traveler"), elseNode: attempt("结束询问并继续值守") }] },
  { kind: "while", condition: "我仍在值守", targetHandles: ["ref:local_entity:self"], body: attempt("观察门口情况") },
] });
const wire = { slots: [{ slot: 0, beliefChanges: { operations: [] }, characterChanges: { operations: [] }, nextActionIntent: { program: tree } }] };
const request = () => ({ workloadId: "world", batchId: "bootstrap", profileId: "agent-default", subjectId: "slots", promptVersion: "source",
  role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
  system: "Own perspective", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] },
  runtimeIdentity: { worldHash: `sha256:${contentHash("recursive-intent-fixture")}`, revision: 0 } });

it("preserves every nested branch and target order while exposing only unevaluated initial work", () => {
  const before = structuredClone(wire), lowered = lowerRecursiveIntent(tree);
  expect(lowered.targetHandles).toEqual(["ref:local_entity:traveler", "ref:local_entity:self"]);
  expect(lowered.program.nodes.map(node => node.nodeId)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  expect(expandIndexedIntent(lowered.program, lowered.targetHandles)).toEqual(tree);
  expect(inspectAgentIntentProgram(lowered.program, 2)).toEqual({ nodeCount: 9,
    frontier: [{ nodeId: 7, kind: "condition" }, { nodeId: 2, kind: "attempt" }] });
  const decoded = agentMindBatchOutputSchema.parse(decodeRecursiveIntent(wire));
  const action = decoded.slots[0]!.nextActionIntent;
  expect(JSON.parse(action.rawText.slice(INTENT_PROGRAM_PREFIX.length))).toEqual(lowered.program);
  expect(action.goal).toEqual(action.rawText); expect(action.means).toBeNull();
  expect(action.targetHandles).toEqual(lowered.targetHandles); expect(wire).toEqual(before);
  const compound = attempt("同时整理物资并观察访客；若有人求助就先记录，待交接后再跟随调查。");
  expect(expandIndexedIntent(lowerRecursiveIntent(compound).program, ["ref:local_entity:self"])).toEqual(compound);
});

it("keeps original private and non-action contracts and resolves every recursive wire reference", () => {
  const source = request(), original = z.toJSONSchema(source.schema, { target: "draft-07" }), candidate = agentRecursiveIntentRequest(source);
  type Obj = { definitions?: Record<string, { oneOf: { properties: Record<string, unknown> }[] }>;
    properties: { slots: { items: { properties: Record<string, { properties: Record<string, unknown> }> } } } };
  const restored = structuredClone(candidate.wireJsonSchema!) as Obj;
  const fields = restored.properties.slots.items.properties;
  const oldAction = (original as unknown as Obj).properties.slots.items.properties.nextActionIntent;
  for (const def of Object.values(restored.definitions!)) for (const alternative of def.oneOf) {
    if (alternative.properties.targetHandles) expect(alternative.properties.targetHandles).toEqual(oldAction.properties.targetHandles);
  }
  let refs = 0;
  const walk = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    if ("$ref" in v) {
      const ref = (v as { $ref: string }).$ref;
      expect(ref.startsWith("#/definitions/recursiveIntent_")).toBe(true);
      const resolved = ref.slice(2).split("/").reduce<unknown>((current, key) => (current as Record<string, unknown>)[key], restored);
      expect(resolved).toBeDefined(); refs++;
    }
    Object.values(v).forEach(walk);
  };
  walk(restored); expect(refs).toBeGreaterThan(3);
  fields.nextActionIntent = oldAction; delete restored.definitions;
  expect(restored).toEqual(original); expect(candidate.schema).toBe(source.schema);
  expect(candidate.context).toBe(source.context); expect(candidate.userPrompt).toBe(source.userPrompt);
  expect(candidate.preprocessOutput!(wire).symbolRepairs).toEqual([]);
  expect(() => agentRecursiveIntentRequest(candidate)).toThrow("already applied");
  source.context.slots.push({ slot: 1 }); expect(() => candidate.preprocessOutput!(wire)).toThrow("source or schema changed");
});

it.each([false, true])("uses registered recursive bootstrap and gateway with foreign local target=%s", async foreign => {
  const catalog = createTestModelCatalog(), definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: catalog });
  const state = definition.initialState;
  const agents = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id)), before = contentHash(state);
  const expected = agents.map(agent => ({ kind: "sequence" as const, children: [attempt("观察周围情况"),
    attempt("查看相关对象，不宣称已经成功", agent.id === "keeper" ? "traveler" : "copper-key")] }));
  let http = 0, calls = 0;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    maxTransportAttempts: 1, registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
      http++; const body = JSON.parse(String(init?.body));
      const output = { slots: expected.map((program, slot) => ({ slot, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
        nextActionIntent: { program: foreign && slot === 0 ? attempt("查看", "copper-key") : program } })) };
      return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } } });
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: source => {
      if (++calls > 1) throw new ModelConfigurationError("Foreign target stopped before repair HTTP");
      expect(source.promptVersion).toContain("agent-recursive-intent-v1");
      return gateway.generateStructured(source);
    } };
  const ref = recursivePlayerAlgorithmRef(), retrieval = createActionCompilationRetrievalRuntimeProvider();
  const algorithm = registerIntegratedPlayerAlgorithm().create(ref, { provider,
    resources: { resolve: <T,>() => retrieval.runtime(ref) as T } });
  const pending = algorithm.bootstrap({ definition, state }, {
    modelScope: { workloadId: "world", batchId: "bootstrap", observer,
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, instrumentation: { emit: () => undefined },
  });
  if (foreign) {
    await expect(pending).rejects.toThrow("Foreign target stopped");
    expect(JSON.stringify(observer.snapshot().filter(e => e.event === "model.semantic.rejected").map(e => e.payload))).toContain("reference.unknown_handle");
  } else {
    const result = await pending; expect(result.agentCommits).toHaveLength(agents.length);
    for (const [index, agent] of agents.entries()) {
      const output = result.agentCommits.find(commit => commit.agentId === agent.id)!, lowered = lowerRecursiveIntent(expected[index]!);
      expect(JSON.parse(output.nextAction.rawText.slice(INTENT_PROGRAM_PREFIX.length))).toEqual(lowered.program);
      expect(output.nextAction.targetIds).toEqual(lowered.targetHandles.map(h => h.replace("ref:local_entity:", "")));
      expect(output.nextAction.actorId).toBe(agent.id);
      expect(output.beliefPatch.operations).toEqual([]); expect(output.characterPatch.operations).toEqual([]);
    }
  }
  expect(http).toBe(1); expect(contentHash(state)).toEqual(before);
  expect(algorithm.manifest.hash).toBe(ref.manifestHash);
});

it.each(["duplicate-target", "missing-child", "index-reference", "blank-condition", "legacy-action"])("retains exact wire and billable audit for malformed tree: %s", async mode => {
  const raw = structuredClone(wire);
  if (mode === "duplicate-target") raw.slots[0]!.nextActionIntent.program = { ...attempt("询问"), targetHandles: ["ref:local_entity:self", "ref:local_entity:self"] } as RecursiveIntent;
  if (mode === "missing-child") raw.slots[0]!.nextActionIntent.program = { kind: "sequence", children: [] };
  if (mode === "index-reference") Object.assign(raw.slots[0]!.nextActionIntent.program, { nodeId: 0 });
  if (mode === "blank-condition") raw.slots[0]!.nextActionIntent.program = { kind: "await", condition: " \n", targetHandles: [] };
  if (mode === "legacy-action") Object.assign(raw.slots[0]!.nextActionIntent, { targetHandles: ["ref:local_entity:self"] });
  const catalog = createTestModelCatalog(); let http = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    maxTransportAttempts: 1, registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
      http++; const body = JSON.parse(String(init?.body));
      return Response.json({ id: "bad-tree", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(raw) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 29, completion_tokens: 41, total_tokens: 70, completion_tokens_details: { reasoning_tokens: 0 } } });
    } });
  const error = await gateway.generateStructured(agentRecursiveIntentRequest(request())).then(() => null, e => e);
  expect(error).toBeInstanceOf(ModelOutputError); expect(error.rawValue).toEqual(raw);
  expect(error.audit.invocations).toHaveLength(1);
  expect(error.audit.invocations[0].tokenUsage).toMatchObject({ input: 29, output: 41, reasoning: 0 }); expect(http).toBe(1);
});
