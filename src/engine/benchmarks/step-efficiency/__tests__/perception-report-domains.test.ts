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
import { perceptionLawContextRequest } from "../perception-law-context";
import { perceptionReportDomainsRequest, perceptionReportDomainsSchema, verifyOnlyPerceptionReportDomainsChanged } from "../perception-report-domains";

it.each(["done", "new-identity", "check", "wrong-owner", "repair"])("isolates the terminal field schema after the complete law index for a real %s directive, preserving original acceptance and RNG", async mode => {
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
        const output = mode === "done" || mode === "new-identity" || physical.length > 1 ? { kind: "done", reports: noStimulusReportsForTargets(input) } : { kind: "request_checks", requests: [{
          proposalKey: "notice-key", actorRef: "ref:entity:keeper", targetRef: "ref:entity:key",
          ratingRef: (mode === "wrong-owner" || mode === "repair") ? "ref:rating:resolve:player" : "ref:rating:resolve:keeper",
          difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } },
          mode: "normal", stakes: "Whether the keeper notices the concealment at onset.", visibility: "full",
          causes: [{ kind: "action", ref: "ref:action:conceal" }, { kind: "law", ref: "ref:law:time-passes" }],
        }] };
        if (mode === "new-identity" && "reports" in output && output.reports) Object.assign(output.reports[0]!, {
          kind: "perceived", stimulus: { summary: "A visible detail.", introductions: [{ localEntity: {
            proposalKey: "new-detail", name: "A visible detail", description: "A distinct local referent.", status: "observed",
          }, canonicalEntityRef: null }], apparentClaims: [{ subjectRef: { proposalKey: "new-detail" }, predicate: "visible",
            value: { kind: "boolean", value: true }, description: "An observed detail." }], sourceEventRefs: [] },
        });
        return new Response(JSON.stringify({ id: "law-context-test", model: "scripted:truth-deepseek",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { status: 200, headers: { "content-type": "application/json" } });
      } });
    const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role), assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
      generateStructured: request => {
        logical.push(request.context);
        const context = request.context as { referenceCatalog: { candidates: Array<{ handle: string; kind: string; allowedUses: string[] }> }; state: { canonicalTruth: { entities: Record<string, unknown> } } };
        const wire = perceptionReportDomainsSchema(context);
        const expected = context.referenceCatalog.candidates.filter(row => row.kind === "entity" && row.allowedUses.includes("assertion")).map(row => row.handle);
        const reports = (wire.oneOf as Array<{ properties: { kind: { const: string }; reports?: { items: { oneOf: Array<{ properties: { evidence: { items: { oneOf: Array<{ properties: { kind: { const: string }; ref: { allOf: Array<{ $ref: string }> } } }> } } } }> } } } }>)[1]!.properties.reports!.items.oneOf;
        for (const report of reports) {
          const ref = report.properties.evidence.items.oneOf.find(row => row.properties.kind.const === "entity")!.properties.ref.allOf[0]!.$ref;
          expect((wire.$defs as Record<string, { enum: string[] }>)[ref.slice("#/$defs/".length)]!.enum).toEqual(expected);
        }
        const missing = structuredClone(context); missing.referenceCatalog.candidates = missing.referenceCatalog.candidates.filter(row => row.handle !== expected[0]);
        expect(() => perceptionReportDomainsSchema(missing)).toThrow("incomplete");
        const duplicate = structuredClone(context); duplicate.referenceCatalog.candidates.push(duplicate.referenceCatalog.candidates[0]!);
        expect(() => perceptionReportDomainsSchema(duplicate)).toThrow("duplicate");
        const baseline = perceptionLawContextRequest(request);
        const adapted = candidate ? perceptionReportDomainsRequest(baseline) : baseline;
        expect(adapted.context).toBe(request.context); expect(adapted.schema).toBe(request.schema);
        expect(adapted.system).toBe(request.system); expect(adapted.preprocessOutput).toBe(request.preprocessOutput);
        if (candidate) expect(() => perceptionReportDomainsRequest(adapted)).toThrow("unmodified");
        return gateway.generateStructured(adapted);
      } };
    const run = new TruthEngine(provider, { repairAttempts: mode === "repair" ? 1 : 0 }).perceiveOnset(input, { workloadId: "law-context-world", batchId: "law-context-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
    if (mode === "wrong-owner") { await expect(run).rejects.toThrow(); results.push(null); }
    else results.push(await run);
    expect(contentHash(input)).toBe(before); bodies.push(physical); contexts.push(logical);
  }
  expect(results[1]?.receipts).toEqual(results[0]?.receipts);
  expect(results[1]?.requests).toEqual(results[0]?.requests);
  expect(results[1]?.checks).toEqual(results[0]?.checks); expect(results[1]?.rng).toEqual(results[0]?.rng);
  expect(bodies[1]).toHaveLength(bodies[0]!.length);
  for (let i = 0; i < bodies[0]!.length; i++) {
    expect(() => verifyOnlyPerceptionReportDomainsChanged(bodies[0]![i], bodies[1]![i], contexts[0]![i])).not.toThrow();
    const damaged = structuredClone(bodies[1]![i]) as { messages: Array<{ content: string }>; model: string };
    damaged.messages[0]!.content += " Omit required checks.";
    expect(() => verifyOnlyPerceptionReportDomainsChanged(bodies[0]![i], damaged, contexts[0]![i])).toThrow("more than");
  }
});

it("leaves unrelated roles alone and refuses incompatible output adaptations", () => {
  const request = { role: "truth-resolution", schemaName: "truth_resolution", promptVersion: "source", jsonExamplePolicy: "omit" } as StructuredModelRequest<unknown>;
  expect(perceptionReportDomainsRequest(request)).toBe(request);
  expect(() => perceptionReportDomainsRequest({ ...request, role: "truth-perception", schemaName: "truth_perception_directive" })).toThrow("unmodified");
  expect(() => perceptionReportDomainsRequest({ ...request, role: "truth-perception", schemaName: "truth_perception_directive", jsonExamplePolicy: undefined, wireJsonSchema: {} })).toThrow("unmodified");
});
