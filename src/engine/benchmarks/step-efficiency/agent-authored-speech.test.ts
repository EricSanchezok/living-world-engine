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
import { agentAuthoredSpeechRequest, authoredActionSchema, decodeAgentAuthoredSpeech, inspectAuthoredSpeechProposal, AUTHORED_SPEECH_PREFIX } from "./agent-authored-speech";

it("preserves unrestricted work and exact utterances while binding only a proposed speaker", () => {
  const text = "  若你明天愿意，我会帮忙。\n请先告诉我你的条件。 ";
  for (const kind of ["open", "speak"] as const) {
    const choice = authoredActionSchema.parse({ kind, text, targetHandles: ["ref:local_entity:visitor"] });
    const decoded = decodeAgentAuthoredSpeech({ slots: [{ nextActionIntent: choice }] }).slots[0]!.nextActionIntent;
    const action = { id: "action", actorId: "speaker", baseRevision: 7, ...decoded, targetIds: ["visitor"] };
    const descriptor = inspectAuthoredSpeechProposal(action, choice);
    if (kind === "open") { expect(decoded.rawText).toBe(text); expect(descriptor).toBeNull(); }
    else expect(descriptor).toEqual({ sourceActionId: "action", speakerAgentId: "speaker", baseRevision: 7,
      utterance: text, intendedAddresseeLocalIds: ["visitor"], delivery: "unadjudicated" });
    expect(() => inspectAuthoredSpeechProposal({ ...action, targetIds: ["someone-else"] }, choice)).toThrow("differs");
  }
  const textWithMarker = AUTHORED_SPEECH_PREFIX + JSON.stringify({ utterance: "The letter has arrived." });
  const choice = { kind: "open", text: textWithMarker, targetHandles: [] };
  const decoded = decodeAgentAuthoredSpeech({ slots: [{ nextActionIntent: choice }] }).slots[0]!.nextActionIntent;
  expect(inspectAuthoredSpeechProposal({ id: "literal", actorId: "speaker", baseRevision: 0, ...decoded, targetIds: [] }, choice)).toBeNull();
  const compound = "Wait until the road clears, then travel and deliver the letter while asking about supplies; if refused, return.";
  expect(decodeAgentAuthoredSpeech({ slots: [{ nextActionIntent: { ...choice, text: compound } }] }).slots[0]!.nextActionIntent.rawText).toBe(compound);
});

it("preserves every non-action field, context and target domain", () => {
  const request = { workloadId: "world", batchId: "bootstrap", profileId: "agent", subjectId: "slots", promptVersion: "source",
    role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
    system: "Original isolation", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] } };
  const original = z.toJSONSchema(request.schema, { target: "draft-07" }), candidate = agentAuthoredSpeechRequest(request);
  type Schema = { properties: { slots: { items: { properties: { nextActionIntent: { properties: Record<string, unknown> } } } } } };
  const restored = structuredClone(candidate.wireJsonSchema!) as unknown as Schema;
  const old = (original as unknown as Schema).properties.slots.items.properties.nextActionIntent;
  expect(restored.properties.slots.items.properties.nextActionIntent.properties.targetHandles).toEqual(old.properties.targetHandles);
  restored.properties.slots.items.properties.nextActionIntent = old;
  expect(restored).toEqual(original); expect(candidate.schema).toBe(request.schema);
  expect(candidate.context).toBe(request.context); expect(candidate.userPrompt).toBe(request.userPrompt);
  expect(agentAuthoredSpeechRequest({ ...request, role: "truth-resolution" as const }).promptVersion).toBe(request.promptVersion);
  expect(() => agentAuthoredSpeechRequest(candidate)).toThrow("already applied");
  request.context.slots.push({ slot: 1 });
  expect(() => candidate.preprocessOutput!({ slots: [] })).toThrow("source or schema changed");
});

it.each(["open", "speak", "foreign-target"])("uses real AgentMind and gateway for %s", async mode => {
  const catalog = createTestModelCatalog();
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: catalog });
  const before = contentHash(state), agents = Object.values(state.agents).sort((a, b) => a.id.localeCompare(b.id));
  const choices = agents.map(agent => ({ kind: mode === "open" ? "open" : "speak", text: mode === "open"
    ? "Wait for a reply, then inspect the route while asking about supplies." : "If you are willing, tell me about the road.",
    targetHandles: ["ref:local_entity:self", `ref:local_entity:${agent.id === "keeper" ? "traveler" : "copper-key"}`] }));
  let http = 0, calls = 0;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-only" }, {
    maxTransportAttempts: 1, registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
      http++; const body = JSON.parse(String(init?.body));
      const output = { slots: choices.map((choice, slot) => ({ slot, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
        nextActionIntent: mode === "foreign-target" && slot === 0 ? { ...choice, targetHandles: ["ref:local_entity:copper-key"] } : choice })) };
      return Response.json({ id: "fixture", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } } });
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: request => {
      if (++calls > 1) throw new ModelConfigurationError("Retain foreign target failure before repair HTTP");
      return gateway.generateStructured(agentAuthoredSpeechRequest(request));
    } };
  const pending = new AgentMind(provider).thinkBatch(state, agents.map(agent => ({ agent, observations: [], events: [],
    currentResolution: { action: null, outcome: null } })), { workloadId: "world", batchId: "bootstrap", observer,
    runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, "bootstrap", 8);
  if (mode === "foreign-target") {
    await expect(pending).rejects.toThrow("Retain foreign target failure");
    const rejected = observer.snapshot().filter(event => event.event === "model.semantic.rejected");
    expect(JSON.stringify(rejected.map(event => event.payload))).toContain("reference.unknown_handle");
  } else {
    const result = await pending;
    expect(result.failures).toEqual([]); expect(result.outputs.size).toBe(agents.length);
    for (const [index, agent] of agents.entries()) {
      const output = result.outputs.get(agent.id)!;
      expect(output.beliefPatch.operations).toEqual([]); expect(output.characterPatch.operations).toEqual([]);
      const descriptor = inspectAuthoredSpeechProposal(output.nextAction, choices[index]);
      if (mode === "speak") expect(descriptor).toMatchObject({ speakerAgentId: agent.id, utterance: choices[index]!.text, delivery: "unadjudicated" });
      else expect(descriptor).toBeNull();
    }
  }
  expect(http).toBe(1); expect(contentHash(state)).toBe(before);
});

it.each(["blank", "speaker-field", "unknown-kind", "legacy-text"])("retains complete rejected wire and billing for %s", async invalid => {
  const catalog = createTestModelCatalog();
  const choice: Record<string, unknown> = { kind: "speak", text: "Hello.", targetHandles: [] };
  if (invalid === "blank") choice.text = " \n";
  if (invalid === "speaker-field") choice.speaker = "someone-else";
  if (invalid === "unknown-kind") choice.kind = "delivered";
  if (invalid === "legacy-text") choice.rawText = "A competing action";
  const raw = { slots: [{ slot: 0, beliefChanges: { operations: [] }, characterChanges: { operations: [] }, nextActionIntent: choice }] };
  let http = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "fixture-only" }, { maxTransportAttempts: 1,
    registry: createTestModelRegistry(catalog), fetch: async (_url, init) => {
      http++;const body = JSON.parse(String(init?.body));
      return Response.json({ id: "rejected-speech", object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(raw) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 29, completion_tokens: 41, total_tokens: 70, completion_tokens_details: { reasoning_tokens: 0 } } });
    } });
  const request = { workloadId: "world", batchId: "bootstrap", profileId: "agent-default", subjectId: "slots", promptVersion: "source",
    role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
    system: "Own perspective", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] },
    runtimeIdentity: { worldHash: `sha256:${contentHash("speech-fixture")}`, revision: 0 } };
  const error = await gateway.generateStructured(agentAuthoredSpeechRequest(request)).then(() => null, error => error);
  expect(error).toBeInstanceOf(ModelOutputError); expect(error.rawValue).toEqual(raw);
  expect(error.audit.invocations).toHaveLength(1);
  expect(error.audit.invocations[0]).toMatchObject({ tokenUsage: { input: 29, output: 41, reasoning: 0 }, finishReason: "stop" });
  expect(http).toBe(1);
});
