import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { AgentMind } from "../../algorithms/eager-reference/agent-mind";
import { agentMindBatchOutputSchema } from "../../contracts/llm-schemas";
import { loadWorldScript } from "../../../script/world-loader";
import { contentHash } from "../../models/model-audit";
import { deterministicAgentMindBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { agentActionScopeRequest } from "./agent-action-scope";

it("preserves schema predicates, literal output and source binding on primary and repair", () => {
  const request = { workloadId: "world", batchId: "bootstrap", profileId: "agent", subjectId: "slots", promptVersion: "source",
    role: "agent-bootstrap" as const, schemaName: "agent_mind_batch_output", schema: agentMindBatchOutputSchema,
    system: "Existing role and isolation", userPrompt: "Initialize", context: { slots: [{ slot: 0 }] } };
  const source = z.toJSONSchema(request.schema, { target: "draft-07" }), candidate = agentActionScopeRequest(request);
  const stripped = structuredClone(candidate.wireJsonSchema!);
  const fields = (stripped.properties as { slots: { items: { properties: { nextActionIntent: { properties: Record<string, { description?: string }> } } } } }).slots.items.properties.nextActionIntent.properties;
  for (const key of ["rawText", "goal", "means"]) delete fields[key]!.description;
  expect(stripped).toEqual(source);
  expect(candidate.schema).toBe(request.schema); expect(candidate.context).toBe(request.context);
  expect(candidate.userPrompt).toBe(request.userPrompt);
  const historical = { slots: [{ slot: 0, beliefChanges: { operations: [] }, characterChanges: { operations: [] },
    nextActionIntent: { rawText: "Travel to the harbor", goal: "ref:goal:home-defense", means: "Prepare a village roster", targetHandles: [] } }] };
  expect(candidate.preprocessOutput!(historical).value).toBe(historical);
  expect(z.fromJSONSchema(candidate.wireJsonSchema!).safeParse(historical).success).toBe(true);
  expect(agentActionScopeRequest({ ...request, correlation: { semanticRepairAttempt: 1 } }).promptVersion).toBe(candidate.promptVersion);
  expect(agentActionScopeRequest({ ...request, role: "truth-resolution" })).toMatchObject({ system: request.system });
  expect(() => agentActionScopeRequest(candidate)).toThrow("already applied");
  request.context.slots.push({ slot: 1 });
  expect(() => candidate.preprocessOutput!(historical)).toThrow("source changed");
});

it("uses the real AgentMind materializer without changing private state, targets or action scope", async () => {
  const baseline = new ScriptedModelProvider(({ context }) => deterministicAgentMindBatch(context));
  const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: baseline.catalog });
  const before = contentHash(state), inputs = Object.values(state.agents).map(agent => ({ agent, observations: [], events: [], currentResolution: { action: null, outcome: null } }));
  const scope = { workloadId: "world", batchId: "bootstrap", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const original = await new AgentMind(baseline).thinkBatch(state, inputs, scope, "bootstrap", 8);
  const provider = new ScriptedModelProvider(({ context }) => deterministicAgentMindBatch(context));
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => generate(agentActionScopeRequest(request));
  const actual = await new AgentMind(provider).thinkBatch(state, inputs, scope, "bootstrap", 8);
  expect([...actual.outputs]).toEqual([...original.outputs]);
  expect(actual.failures).toEqual([]); expect(actual.metrics).toEqual(original.metrics);
  expect(provider.requests).toHaveLength(baseline.requests.length);
  expect(contentHash(state)).toBe(before);
});
