import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { AgentMind } from "../../algorithms/eager-reference/agent-mind";
import { agentMindBatchOutputSchema } from "../../contracts/llm-schemas";
import { loadWorldScript } from "../../../script/world-loader";
import { contentHash } from "../../models/model-audit";
import { deterministicAgentMindBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { agentActionTextRequest, decodeAgentActionText } from "./agent-action-text";

const intent = "先核对名册；若渡口开放，再请求租船以接应两户人家，否则留守并持续观察，不把租船请求当作已获准。";
const wire = { slots: [{ slot: 0, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
  nextActionIntent: { rawText: intent, targetHandles: [] } }] };

it("embeds one complete authored text exactly and rejects old extra text rather than losing intent", () => {
  const before = structuredClone(wire), result = decodeAgentActionText(wire);
  expect(result.slots[0]!.nextActionIntent).toEqual({ rawText: intent, goal: intent, means: null, targetHandles: [] });
  expect(wire).toEqual(before);
  expect(agentMindBatchOutputSchema.safeParse(result).success).toBe(true);
  for (const extra of [{ goal: "A different outcome" }, { means: "A method absent from the text" }]) {
    expect(() => decodeAgentActionText({ slots: [{ ...wire.slots[0], nextActionIntent: { ...wire.slots[0]!.nextActionIntent, ...extra } }] })).toThrow(z.ZodError);
  }
  expect(() => decodeAgentActionText({ slots: [{ ...wire.slots[0], nextActionIntent: { rawText: "", targetHandles: [] } }] })).toThrow();
  expect(agentMindBatchOutputSchema.safeParse(decodeAgentActionText({ ...wire, unrelated: "must remain rejectable" })).success).toBe(false);
});

it("preserves every other schema predicate and binds the unchanged private source", () => {
  const request = { workloadId: "world", batchId: "bootstrap", profileId: "agent", subjectId: "slots", promptVersion: "source",
    role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
    system: "Original isolation", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] } };
  const original = z.toJSONSchema(request.schema, { target: "draft-07" }), candidate = agentActionTextRequest(request);
  type Schema = { properties: { slots: { items: { properties: { nextActionIntent: { properties: Record<string, { description?: string }>; required: string[] } } } } } };
  const restored = structuredClone(candidate.wireJsonSchema!) as unknown as Schema;
  const oldAction = (original as unknown as Schema).properties.slots.items.properties.nextActionIntent;
  const newAction = restored.properties.slots.items.properties.nextActionIntent;
  delete newAction.properties.rawText!.description;
  newAction.properties.goal = oldAction.properties.goal!; newAction.properties.means = oldAction.properties.means!;
  newAction.required = oldAction.required;
  expect(restored).toEqual(original);
  expect(candidate.schema).toBe(request.schema); expect(candidate.context).toBe(request.context);
  expect(candidate.userPrompt).toBe(request.userPrompt);
  expect(z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(wire).success).toBe(true);
  expect(candidate.preprocessOutput!(wire).symbolRepairs).toEqual([]);
  const otherRole = { ...request, role: "truth-resolution" as const };
  expect(agentActionTextRequest(otherRole)).toBe(otherRole);
  expect(() => agentActionTextRequest(candidate)).toThrow("already applied");
  request.context.slots.push({ slot: 1 });
  expect(() => candidate.preprocessOutput!(wire)).toThrow("source changed");
});

it("materializes the same complete text, original targets and private patches through real AgentMind", async () => {
  const provider = new ScriptedModelProvider(({ context }) => {
    const original = agentMindBatchOutputSchema.parse(deterministicAgentMindBatch(context));
    return { slots: original.slots.map(slot => ({ ...slot, nextActionIntent: {
      rawText: intent, targetHandles: slot.nextActionIntent.targetHandles,
    } })) };
  });
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => generate(agentActionTextRequest(request));
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: provider.catalog });
  const before = contentHash(state), inputs = Object.values(state.agents).map(agent => ({ agent, observations: [], events: [], currentResolution: { action: null, outcome: null } }));
  const result = await new AgentMind(provider).thinkBatch(state, inputs,
    { workloadId: "world", batchId: "bootstrap", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, "bootstrap", 8);
  expect(result.failures).toEqual([]); expect(result.outputs.size).toBe(inputs.length);
  for (const [id, output] of result.outputs) {
    expect(output.nextAction).toMatchObject({ actorId: id, rawText: intent, goal: intent, means: null, baseRevision: state.revision });
    expect(output.beliefPatch.operations).toEqual([]); expect(output.characterPatch.operations).toEqual([]);
    expect(output.nextAction.targetIds.every(target => Boolean(state.agents[id]!.belief.localEntities[target]))).toBe(true);
  }
  expect(provider.requests).toHaveLength(1); expect(contentHash(state)).toBe(before);
});
