import { expect, it } from "vitest";
import { observationRenderSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import type { StructuredModelRequest } from "../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { promptBundle } from "../../prompts";
import { decodeObservationClaims, encodeObservationClaims, observationClaimEncodingRequest, OBSERVATION_CLAIM_ENCODING } from "../observation-claim-encoding";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";

const draft = { sourceEventRefs: [], introductions: [], summary: "Receipt is unresolved.", apparentClaims: [
  { subjectRef: "ref:local_entity:observer::father", predicate: "received", value: { kind: "boolean", value: false }, description: "Receipt was not established." },
] };
const unresolved = { ...draft, apparentClaims: [{ epistemicStatus: "unconfirmed", subjectRef: "ref:local_entity:observer::father", predicate: "received",
  description: "父亲是否收到信件，目前没有得到确认。" }] };

it.each([false, true])("round trips all existing canonical claim values without reinterpreting prose (%s)", batch => {
  const values = [{ kind: "boolean", value: false }, { kind: "boolean", value: true }, { kind: "none" }, { kind: "text", value: "unknown" },
    { kind: "number", value: 0 }, { kind: "local_entity", entityRef: "ref:local_entity:observer::self" }];
  const source = { ...draft, apparentClaims: values.map(value => ({ ...draft.apparentClaims[0]!, value })) };
  const canonical = batch ? { slots: [{ slot: 1, result: source }, { slot: 0, result: { ...source, apparentClaims: [] } }] } : source;
  const before = contentHash(canonical);
  expect(decodeObservationClaims(encodeObservationClaims(canonical, batch), batch)).toEqual(canonical);
  expect(contentHash(canonical)).toBe(before);
  // An asserted false with an uncertain description stays false; this codec is not a semantic rewrite.
  expect((decodeObservationClaims(encodeObservationClaims(draft, false), false) as typeof draft).apparentClaims[0]!.value).toEqual({ kind: "boolean", value: false });
});

it("materializes only an explicitly selected unresolved proposition as labeled text", () => {
  const before = contentHash(unresolved);
  const output = observationRenderSchema.parse(decodeObservationClaims(unresolved, false));
  expect(output.apparentClaims).toEqual([{ subjectRef: unresolved.apparentClaims[0]!.subjectRef, predicate: "received",
    value: { kind: "text", value: "尚未确认：父亲是否收到信件，目前没有得到确认。" }, description: "尚未确认：父亲是否收到信件，目前没有得到确认。" }]);
  expect(output.summary).toBe(draft.summary);
  expect(output.sourceEventRefs).toEqual([]);
  expect(contentHash(unresolved)).toBe(before);
  const claim = unresolved.apparentClaims[0]!;
  for (const invalid of [{ ...claim, value: { kind: "boolean", value: false } }, { ...claim, epistemicStatus: "unknown" },
    { ...claim, description: " " }, { subjectRef: claim.subjectRef, predicate: claim.predicate, description: claim.description }]) {
    expect(() => decodeObservationClaims({ ...unresolved, apparentClaims: [invalid] }, false)).toThrow();
  }
});

function request(): StructuredModelRequest<unknown> {
  const bundle = promptBundle("observation-renderer");
  return { profileId: "truth-deepseek", role: "observation-renderer", subjectId: "test", workloadId: "world", batchId: "step",
    schemaName: "observation_render", schema: observationRenderSchema,
    promptVersion: bundle.version, system: bundle.system, userPrompt: bundle.userPrompt,
    context: { fullOriginalEvidence: ["unchanged"] }, runtimeIdentity: { worldHash: `sha256:${"1".repeat(64)}`, revision: 0 } };
}

it("decodes the declared branch through real HTTP and production validation without changing public output shape", async () => {
  const source = request(), next = observationClaimEncodingRequest(source), catalog = createTestModelCatalog(["truth-deepseek"]);
  expect(next.schema).toBe(source.schema); expect(next.context).toBe(source.context);
  expect(next.system).toBe(source.system); expect(next.userPrompt).toBe(source.userPrompt);
  expect(next.promptVersion).toContain(OBSERVATION_CLAIM_ENCODING);
  expect(() => observationClaimEncodingRequest(next)).toThrow("existing output codec");
  let body: { messages: Array<{ content: string }> } | undefined;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "claim-encoding", model: "scripted:truth-deepseek", choices: [{ index: 0,
        message: { role: "assistant", content: JSON.stringify(unresolved) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }), { status: 200, headers: { "content-type": "application/json" } });
    } });
  const result = await gateway.generateStructured(next);
  expect(result.value).toEqual(observationRenderSchema.parse(decodeObservationClaims(unresolved, false)));
  expect(body!.messages[1]!.content).toContain('JSON Schema: '+JSON.stringify(next.wireJsonSchema));
  expect(body!.messages[1]!.content.endsWith(next.jsonObjectPostlude!)).toBe(true);
});

it("requires a separately pinned experimental encoding and its full evidence layout", () => {
  const ref = stepEfficiencyAlgorithmRef({ sourceBoundObservations: true, observationEvidenceLayout: true, observationUnconfirmedClaims: true });
  expect(registerBuiltinAlgorithms().has(ref)).toBe(true);
  expect(ref.children.observationRendering!.config.claimEncoding).toBe(OBSERVATION_CLAIM_ENCODING);
  expect(() => stepEfficiencyAlgorithmRef({ observationUnconfirmedClaims: true })).toThrow("evidence layout");
});
