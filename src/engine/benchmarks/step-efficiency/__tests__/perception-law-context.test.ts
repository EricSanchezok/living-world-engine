import { noStimulusReportsForTargets } from "../../../testing/model-provider";
import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelProvider, StructuredModelRequest } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { perceptionLawContextPostlude, perceptionLawContextRequest, verifyOnlyPerceptionLawContextAdded } from "../perception-law-context";

it.each(["done", "check", "wrong-owner", "repair"])("isolates the complete law source index for a real %s directive, preserving original acceptance and RNG", async mode => {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
  const state = structuredClone(definition.initialState);
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "law-context-test", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key in my sleeve.", goal: "Hide the key", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), bodies: unknown[][] = [], contexts: unknown[][] = [];
  const results: Array<Awaited<ReturnType<TruthEngine["perceiveOnset"]>> | null> = [];
  for (const candidate of [false, true]) {
    const physical: unknown[] = [], logical: unknown[] = [];
    const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
      fetchForAccount: () => async (_url, init) => {
        physical.push(JSON.parse(String(init?.body)));
        const output = mode === "done" || physical.length > 1 ? { kind: "done", reports: noStimulusReportsForTargets(input) } : { kind: "request_checks", requests: [{
          proposalKey: "notice-key", actorRef: "ref:entity:keeper", targetRef: "ref:entity:key",
          ratingRef: (mode === "wrong-owner" || mode === "repair") ? "ref:rating:resolve:player" : "ref:rating:resolve:keeper",
          difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } },
          mode: "normal", stakes: "Whether the keeper notices the concealment at onset.", visibility: "full",
          causes: [{ kind: "action", ref: "ref:action:conceal" }, { kind: "law", ref: "ref:law:time-passes" }],
        }] };
        return new Response(JSON.stringify({ id: "law-context-test", model: "scripted:truth-deepseek",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
      } });
    const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
      generateStructured: request => {
        logical.push(request.context);
        const adapted = candidate ? perceptionLawContextRequest(request) : request;
        expect(adapted.context).toBe(request.context); expect(adapted.schema).toBe(request.schema);
        expect(adapted.system).toBe(request.system); expect(adapted.preprocessOutput).toBe(request.preprocessOutput);
        if (candidate) expect(() => perceptionLawContextRequest(adapted)).toThrow("unmodified");
        return gateway.generateStructured(adapted);
      } };
    const run = new TruthEngine(provider, { repairAttempts: mode === "repair" ? 1 : 0 }).perceiveOnset(input, { workloadId: "law-context-world", batchId: "law-context-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
    if (mode === "wrong-owner") { await expect(run).rejects.toThrow(); results.push(null); }
    else results.push(await run);
    expect(contentHash(input)).toBe(before); bodies.push(physical); contexts.push(logical);
  }
  expect(results[1]?.requests).toEqual(results[0]?.requests);
  expect(results[1]?.checks).toEqual(results[0]?.checks); expect(results[1]?.rng).toEqual(results[0]?.rng);
  expect(bodies[1]).toHaveLength(bodies[0]!.length);
  for (let i = 0; i < bodies[0]!.length; i++) {
    expect(() => verifyOnlyPerceptionLawContextAdded(bodies[0]![i], bodies[1]![i], contexts[0]![i])).not.toThrow();
    const damaged = structuredClone(bodies[1]![i]) as { messages: Array<{ content: string }>; model: string };
    damaged.messages[0]!.content += " Omit required checks.";
    expect(() => verifyOnlyPerceptionLawContextAdded(bodies[0]![i], damaged, contexts[0]![i])).toThrow("more than");
  }
});

it("leaves unrelated roles alone and refuses a combined layout experiment", () => {
  const request = { role: "truth-resolution", schemaName: "truth_resolution", promptVersion: "source", jsonExamplePolicy: "omit" } as StructuredModelRequest<unknown>;
  expect(perceptionLawContextRequest(request)).toBe(request);
  expect(() => perceptionLawContextRequest({ ...request, role: "truth-perception", schemaName: "truth_perception_directive" })).toThrow("unmodified");
  expect(() => perceptionLawContextRequest({ ...request, role: "truth-perception", schemaName: "truth_perception_directive", jsonExamplePolicy: undefined, jsonObjectPostlude: "Extra source layout" })).toThrow("unmodified");
});


it("keeps complete law records and refuses missing or ambiguous source bindings", () => {
  const context = { state: { world: { laws: [
    { id: "negative-channel", text: "No channel exists.", severity: "hard", extra: { future: false } },
    { id: "remote-channel", text: "An authored remote route may cross places.", severity: "hard" },
  ] } }, referenceCatalog: { candidates: [
    { kind: "law", handle: "ref:law:opaque-one", statePath: "state.world.laws.negative-channel" },
    { kind: "law", handle: "ref:law:opaque-two", statePath: "state.world.laws.remote-channel" },
  ] } };
  const before = contentHash(context), postlude = perceptionLawContextPostlude(context);
  const rows = JSON.parse(postlude.slice(postlude.indexOf("\n[") + 1));
  expect(rows.map((row: { source: unknown }) => row.source)).toEqual(context.state.world.laws);
  expect(rows.map((row: { lawRef: string }) => row.lawRef)).toEqual(["ref:law:opaque-one", "ref:law:opaque-two"]);
  expect(contentHash(context)).toBe(before);
  const missing = structuredClone(context); missing.referenceCatalog.candidates.pop();
  expect(() => perceptionLawContextPostlude(missing)).toThrow("incomplete");
  const wrong = structuredClone(context); wrong.referenceCatalog.candidates[1]!.statePath = "state.world.laws.negative-channel";
  expect(() => perceptionLawContextPostlude(wrong)).toThrow("one exact");
});
