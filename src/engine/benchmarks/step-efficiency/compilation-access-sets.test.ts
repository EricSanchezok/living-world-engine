import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { ActionCompilationCodec } from "../../algorithms/eager-reference/action-compilation-representation";
import { representedActionCompiler } from "../../algorithms/eager-reference/represented-action-compiler";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { ModelConfigurationError, type StructuredModelRequest, type StructuredModelProvider } from "../../models/model-provider";
import { deterministicActionCompilationBatch, ScriptedModelProvider, createTestModelRegistry } from "../../testing/model-provider";
import { compilationAccessSetsRequest } from "./compilation-access-sets";

const schema = z.strictObject({ slots: z.array(z.strictObject({ slot: z.number().int(), temporalPlan: z.string(),
  interactionDependency: z.strictObject({ stateDependencies: z.strictObject({
    requiredExistingCandidateKeys: z.array(z.enum(["r000", "r001"])),
    potentiallyAffectedCandidateKeys: z.array(z.enum(["r000", "r001"])),
  }), audienceAgentCandidateKeys: z.array(z.string()), sharedResourceClaims: z.array(z.unknown()) }),
})) });
const request = (): StructuredModelRequest<z.infer<typeof schema>> => ({ role: "action-compilation", workloadId: "access", batchId: "batch", subjectId: "slots", profileId: "truth-engine",
  schemaName: "action_compilation_at_v1", promptVersion: "test", schema, system: "original duties", userPrompt: "original task",
  context: { fullWorld: { kept: "all original source" }, task: { slots: [{ slot: 0, issues: [], previousAttempt: null }] } },
});
const output = (reads: string[], writes: string[]) => ({ slots: [{ slot: 0, temporalPlan: "preserved exactly",
  interactionDependency: { stateDependencies: { readCandidateKeys: reads, writeCandidateKeys: writes }, audienceAgentCandidateKeys: [], sharedResourceClaims: [] },
}] });

it("preserves empty, overlapping and duplicate access sets through the original canonical schema", () => {
  const source = request(), adapted = compilationAccessSetsRequest(source);
  expect(adapted.context).toBe(source.context); expect(adapted.schema).toBe(source.schema);
  for (const [reads, writes] of [[[], []], [["r000"], []], [[], ["r001"]], [["r000", "r000"], ["r000", "r001"]]]) {
    const raw = output(reads!, writes!), before = contentHash(raw);
    const canonical = source.schema.parse(adapted.preprocessOutput!(raw).value);
    expect(canonical.slots[0]!.interactionDependency.stateDependencies).toEqual({ requiredExistingCandidateKeys: reads, potentiallyAffectedCandidateKeys: writes });
    expect(canonical.slots[0]!.temporalPlan).toBe("preserved exactly"); expect(contentHash(raw)).toBe(before);
  }
  const original = JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" }));
  expect(JSON.stringify(adapted.wireJsonSchema).replaceAll("readCandidateKeys", "requiredExistingCandidateKeys").replaceAll("writeCandidateKeys", "potentiallyAffectedCandidateKeys")).toBe(original);
});

it("rejects mixed wire fields and retains original domain validation", () => {
  const adapted = compilationAccessSetsRequest(request()), mixed = output([], []);
  Object.assign(mixed.slots[0]!.interactionDependency.stateDependencies, { requiredExistingCandidateKeys: [] });
  expect(() => adapted.preprocessOutput!(mixed)).toThrow("mixed original syntax");
  expect(() => adapted.schema.parse(adapted.preprocessOutput!(output(["r999"], [])).value)).toThrow();
});

it("rejects repair requests, schema mismatch, repeated adaptation and source drift", () => {
  const source = request(), adapted = compilationAccessSetsRequest(source);
  expect(() => compilationAccessSetsRequest(adapted)).toThrow("unadapted");
  expect(() => compilationAccessSetsRequest({ ...request(), wireJsonSchema: { type: "object" } })).toThrow("no dependency");
  expect(() => compilationAccessSetsRequest({ ...request(), context: { task: { slots: [{ slot: 0, issues: ["repair"], previousAttempt: {} }] } } })).toThrow("initial compilation");
  source.system += " changed duties";
  expect(() => adapted.preprocessOutput!(output([], []))).toThrow("source or physical schema changed");
});

it("preserves the real represented compiler result through controlled gateway HTTP", async () => {
  const original = new ScriptedModelProvider(({ profileId, context }) => deterministicActionCompilationBatch(profileId, context));
  const { initialState: state } = loadWorldScript("test/fixtures/open-world-script", { seed: 48, modelCatalog: original.catalog });
  const actions = [{ id: "inspect-key", actorId: "player", baseRevision: state.revision, rawText: "Examine the copper key.", goal: "Inspect the copper key", means: null, targetIds: ["copper-key"] }];
  const scope = { workloadId: "access", batchId: "batch", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const expected = await compileActions(original, state, actions, scope, "truth-engine", 12);
  const canonical = deterministicActionCompilationBatch("truth-engine", original.requests[0]!.context);
  const wire = JSON.parse(JSON.stringify(new ActionCompilationCodec("AT", original.requests[0]!.context).encodeOutput(canonical))
    .replaceAll('"requiredExistingCandidateKeys":', '"readCandidateKeys":').replaceAll('"potentiallyAffectedCandidateKeys":', '"writeCandidateKeys":'));
  let calls = 0;
  const gateway = createModelGateway(original.catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(original.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_input, init) => {
      calls++; const body = JSON.parse(String(init?.body));
      expect(body.messages[1].content).toContain('"readCandidateKeys"');
      return Response.json({ id: "access-test", model: "scripted:truth-deepseek", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(wire) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    } });
  const provider: StructuredModelProvider = { catalog: gateway.catalog, assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
    availableProfileSummaries: role => gateway.availableProfileSummaries(role), generateStructured: request => gateway.generateStructured(compilationAccessSetsRequest(request)) };
  const result = await representedActionCompiler("AT", true, true, true)(provider, state, actions, scope, "truth-engine", 12, { maxRepairs: 0, exhaustion: "fail-step", splitAt: count => Math.ceil(count / 2) });
  expect(calls).toBe(1); expect(result.compilations).toEqual(expected.compilations);
  expect(result.modelAudits[0]!.invocations).toHaveLength(1);
});

it("preserves unrelated roles and fails before network when bound schema is mutated", () => {
  const source = { ...request(), role: "truth-resolution" as const };
  expect(compilationAccessSetsRequest(source)).toBe(source);
  const adapted = compilationAccessSetsRequest(request());
  (adapted.wireJsonSchema as Record<string, unknown>).additionalProperties = true;
  expect(() => adapted.preprocessOutput!(output([], []))).toThrow(ModelConfigurationError);
});
