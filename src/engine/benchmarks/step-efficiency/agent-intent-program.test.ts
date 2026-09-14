import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { AgentMind } from "../../algorithms/eager-reference/agent-mind";
import { agentMindBatchOutputSchema } from "../../contracts/llm-schemas";
import { loadWorldScript } from "../../../script/world-loader";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider } from "../../models/model-provider";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { agentIntentProgramRequest, agentIntentProgramSchema, decodeAgentIntentProgram,
  inspectAgentIntentProgram, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";

const program = agentIntentProgramSchema.parse({ root: 0, nodes: [
  { nodeId: 0, kind: "parallel", children: [1, 4] },
  { nodeId: 1, kind: "sequence", children: [2, 3, 5] },
  { nodeId: 2, kind: "attempt", text: " 询问旅人是否愿意展示钥匙；若他说不愿意，也不阻拦。\n", targetIndices: [1] },
  { nodeId: 3, kind: "await", condition: "旅人作出可察觉的答复", targetIndices: [1] },
  { nodeId: 4, kind: "while", condition: "我仍在值守", targetIndices: [0], body: 6 },
  { nodeId: 5, kind: "if", condition: "旅人愿意展示钥匙", targetIndices: [1], thenNode: 7, elseNode: 8 },
  { nodeId: 6, kind: "attempt", text: "观察门口情况", targetIndices: [0] },
  { nodeId: 7, kind: "attempt", text: "仔细查看所展示的钥匙，不接过它", targetIndices: [1] },
  { nodeId: 8, kind: "attempt", text: "结束询问并继续值守", targetIndices: [0] },
] });
const wire = { slots: [{ slot: 0, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
  nextActionIntent: { targetHandles: ["ref:local_entity:self", "ref:local_entity:traveler"], program } }] };

it("retains the complete chosen program and stops initial inspection at unevaluated conditions", () => {
  const before = structuredClone(wire), decoded = decodeAgentIntentProgram(wire);
  const action = decoded.slots[0]!.nextActionIntent;
  expect(JSON.parse(action.rawText.slice(INTENT_PROGRAM_PREFIX.length))).toEqual(program);
  expect(action.goal).toBe(action.rawText); expect(action.means).toBeNull();
  expect(action.targetHandles).toEqual(wire.slots[0]!.nextActionIntent.targetHandles);
  expect(wire).toEqual(before);
  expect(inspectAgentIntentProgram(program, 2)).toEqual({ nodeCount: 9,
    frontier: [{ nodeId: 4, kind: "condition" }, { nodeId: 2, kind: "attempt" }] });
  expect(agentMindBatchOutputSchema.safeParse(decoded).success).toBe(true);
  expect(agentMindBatchOutputSchema.safeParse(decodeAgentIntentProgram({ ...wire, unknown: true })).success).toBe(false);
  expect(() => decodeAgentIntentProgram({ slots: [{ ...wire.slots[0], nextActionIntent: {
    ...wire.slots[0]!.nextActionIntent, rawText: "a contradictory second intention" } }] })).toThrow();
});

it("rejects dropped work, cyclic or shared control flow and incorrect local target ordinals", () => {
  const attempt = { nodeId: 0, kind: "attempt", text: "观察", targetIndices: [0] };
  for (const invalid of [
    { root: 9, nodes: [attempt] },
    { root: 0, nodes: [attempt, attempt] },
    { root: 0, nodes: [attempt, { ...attempt, nodeId: 1 }] },
    { root: 0, nodes: [{ nodeId: 0, kind: "sequence", children: [0] }] },
    { root: 0, nodes: [{ nodeId: 0, kind: "sequence", children: [1] }] },
    { root: 1, nodes: [attempt, { nodeId: 1, kind: "parallel", children: [0, 0] }] },
    { root: 0, nodes: [{ ...attempt, targetIndices: [1] }] },
    { root: 0, nodes: [{ ...attempt, targetIndices: [0, 0] }] },
    { root: 0, nodes: [{ ...attempt, targetIndices: [] }] },
    { root: 0, nodes: [{ ...attempt, text: " \n" }] },
  ]) expect(() => decodeAgentIntentProgram({ slots: [{ nextActionIntent: {
    targetHandles: ["ref:local_entity:self"], program: invalid } }] })).toThrow();
  expect(() => decodeAgentIntentProgram({ slots: [{ nextActionIntent: {
    targetHandles: ["ref:local_entity:self", "ref:local_entity:self"], program } }] })).toThrow("duplicate target handles");
});

it("preserves the private source, target predicate and all non-action schema fields", () => {
  const request = { workloadId: "world", batchId: "bootstrap", profileId: "agent", subjectId: "slots", promptVersion: "source",
    role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
    system: "Original isolation", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] } };
  const original = z.toJSONSchema(request.schema, { target: "draft-07" }), candidate = agentIntentProgramRequest(request);
  type Schema = { properties: { slots: { items: { properties: { nextActionIntent: { properties: Record<string, unknown> } } } } } };
  const restored = structuredClone(candidate.wireJsonSchema!) as unknown as Schema;
  const oldAction = (original as unknown as Schema).properties.slots.items.properties.nextActionIntent;
  expect(restored.properties.slots.items.properties.nextActionIntent.properties.targetHandles).toEqual(oldAction.properties.targetHandles);
  restored.properties.slots.items.properties.nextActionIntent = oldAction;
  expect(restored).toEqual(original);
  expect(candidate.schema).toBe(request.schema); expect(candidate.context).toBe(request.context);
  expect(candidate.userPrompt).toBe(request.userPrompt);
  const newAction = (candidate.wireJsonSchema! as unknown as Schema).properties.slots.items.properties.nextActionIntent;
  const wireResult = z.fromJSONSchema(newAction.properties.program as Record<string, unknown>).safeParse(program);
  expect(wireResult.success, JSON.stringify(wireResult)).toBe(true);
  expect(candidate.preprocessOutput!(wire).symbolRepairs).toEqual([]);
  const otherRole = { ...request, role: "truth-resolution" as const };
  expect(agentIntentProgramRequest(otherRole)).toBe(otherRole);
  expect(() => agentIntentProgramRequest(candidate)).toThrow("already applied");
  request.context.slots.push({ slot: 1 });
  expect(() => candidate.preprocessOutput!(wire)).toThrow("source or schema changed");
});

it.each([false, true])("materializes full programs through real AgentMind/gateway and rejects a foreign slot target=%s", async foreignTarget => {
  const catalog = createTestModelCatalog();
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: catalog });
  const before = contentHash(state), agents = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id));
  const expected = agents.map(agent => ({ targetHandles: ["ref:local_entity:self", `ref:local_entity:${agent.id === "keeper" ? "traveler" : "copper-key"}`], program }));
  let http = 0, calls = 0;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    maxTransportAttempts: 1, registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
      http++;
      const body = JSON.parse(String(init?.body));
      const output = { slots: expected.map((action, slot) => ({ slot, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
        nextActionIntent: foreignTarget && slot === 0 ? { ...action, targetHandles: ["ref:local_entity:self", "ref:local_entity:copper-key"] } : action })) };
      return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } } });
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: request => {
      if (++calls > 1) throw new ModelConfigurationError("Retain foreign target failure before repair HTTP");
      return gateway.generateStructured(agentIntentProgramRequest(request));
    } };
  const pending = new AgentMind(provider).thinkBatch(state, agents.map(agent => ({ agent, observations: [], events: [],
    currentResolution: { action: null, outcome: null } })), { workloadId: "world", batchId: "bootstrap", observer,
    runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, "bootstrap", 8);
  if (foreignTarget) {
    await expect(pending).rejects.toThrow("Retain foreign target failure");
    const rejections = observer.snapshot().filter(event => event.event === "model.semantic.rejected");
    expect(JSON.stringify(rejections.map(event => event.payload))).toContain("ref:local_entity:copper-key");
    expect(JSON.stringify(rejections.map(event => event.payload))).toContain("reference.unknown_handle");
  } else {
    const result = await pending;
    expect(result.failures).toEqual([]); expect(result.outputs.size).toBe(agents.length);
    for (const [index, agent] of agents.entries()) {
      const output = result.outputs.get(agent.id)!;
      expect(JSON.parse(output.nextAction.rawText.slice(INTENT_PROGRAM_PREFIX.length))).toEqual(program);
      expect(output.nextAction).toMatchObject({ actorId: agent.id, goal: output.nextAction.rawText, means: null,
        targetIds: expected[index]!.targetHandles.map(handle => handle.replace("ref:local_entity:", "")) });
      expect(output.beliefPatch.operations).toEqual([]); expect(output.characterPatch.operations).toEqual([]);
    }
    expect(calls).toBe(1);
  }
  expect(http).toBe(1); expect(contentHash(state)).toBe(before);
});

it.each(["unused-target", "cycle", "out-of-range", "legacy-fields"])("retains billable usage and exact rejected wire for invalid program: %s", async invalid => {
  const catalog = createTestModelCatalog(), raw = structuredClone(wire);
  const action = raw.slots[0]!.nextActionIntent;
  if (invalid === "unused-target") action.targetHandles.push("ref:local_entity:ship");
  else if (invalid === "cycle") action.program.nodes = [{ nodeId: 0, kind: "sequence", children: [0] }];
  else if (invalid === "out-of-range") action.program.nodes = [{ nodeId: 0, kind: "attempt", text: "观察", targetIndices: [2] }];
  else Object.assign(action, { rawText: "a competing legacy intention" });
  let http = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    maxTransportAttempts: 1, registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
      http++;
      const body = JSON.parse(String(init?.body));
      return Response.json({ id: "rejected-fixture", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(raw) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 29, completion_tokens: 41, total_tokens: 70, completion_tokens_details: { reasoning_tokens: 0 } } });
    } });
  const request = { workloadId: "world", batchId: "bootstrap", profileId: "agent-default", subjectId: "slots", promptVersion: "source",
    role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
    system: "Own perspective", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] },
    runtimeIdentity: { worldHash: `sha256:${contentHash("intent-program-fixture")}`, revision: 0 } };
  const error = await gateway.generateStructured(agentIntentProgramRequest(request)).then(() => null, error => error);
  expect(error).toBeInstanceOf(ModelOutputError);
  expect(error.rawValue).toEqual(raw);
  expect(error.audit.invocations).toHaveLength(1);
  expect(error.audit.invocations[0]).toMatchObject({ tokenUsage: { input: 29, output: 41, reasoning: 0 }, finishReason: "stop" });
  expect(http).toBe(1);
});
