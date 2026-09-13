import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { existingReferenceHandleSchemaFor } from "../../../contracts/model-context";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { canonicalize, contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelProvider } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { compactPerceptionCatalog, expandPerceptionCatalog, perceptionCatalogTransport } from "../perception-catalog-transport";

it("retains complete ordered records, absent fields, nulls and future metadata, rejecting corruption", () => {
  const source = { state: { secretFact: "Retained verbatim" }, referenceCatalog: { candidates: [
    { handle: "ref:fact:b", label: "B", statePath: null, allowedUses: ["cause"], future: { values: [2, 1] } },
    { handle: "ref:fact:a", label: "A", allowedUses: ["cause"], future: { values: [2, 1] } },
    {}, {},
  ] } };
  const before = contentHash(source), compact = compactPerceptionCatalog(source);
  expect(expandPerceptionCatalog(compact, before)).toEqual(source);
  const damaged = structuredClone(compact) as { referenceCatalog: { candidates: { templates: Record<string, unknown>[]; rows: unknown[] } } };
  damaged.referenceCatalog.candidates.templates[0]!.allowedUses = ["actor"];
  expect(() => expandPerceptionCatalog(damaged, before)).toThrow();
  const reordered = structuredClone(compact) as typeof damaged;
  reordered.referenceCatalog.candidates.rows.reverse();
  expect(() => expandPerceptionCatalog(reordered, before)).toThrow();
  expect(() => compactPerceptionCatalog(compact)).toThrow();
  expect(contentHash(source)).toBe(before);
});

it.each([false, true])("preserves real TruthEngine/gateway validation with unknown-reference output %s", async invalid => {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
  const state = definition.initialState;
  const input = { definition, state, identityOwner: "catalog-transport", groundings: [],
    actions: [{ id: "conceal", actorId: "player", baseRevision: state.revision, rawText: "Conceal the key", goal: "Hide it", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "conceal" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input);
  const results = [];
  for (const candidate of [false, true]) {
    let context: unknown, calls = 0;
    const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
      fetchForAccount: () => async (url, init) => {
        calls++;
        const request = new Request(url, init), body = await request.json();
        if (candidate) {
          const originalHash = contentHash(body), physical = perceptionCatalogTransport(body, context);
          const encoded = JSON.stringify(canonicalize(compactPerceptionCatalog(context)));
          const source = JSON.stringify(canonicalize(context));
          const users = (physical.messages as Array<{ role: string; content: string }>).filter(m => m.role === "user");
          expect(users[0]!.content).toContain(encoded);
          expect(users[0]!.content.startsWith(body.messages.find((m: { role: string }) => m.role === "user").content.replace(source, encoded))).toBe(true);
          expect(physical.model).toBe(body.model);
          expect(contentHash(body)).toBe(originalHash);
          expect(() => perceptionCatalogTransport(physical, context)).toThrow();
        }
        const output = { kind: "done", reports: noStimulusReportsForTargets(input) };
        if (invalid) output.reports[0]!.evidence = [{ kind: "entity", ref: existingReferenceHandleSchemaFor("entity").parse("ref:entity:unknown-person") }];
        return new Response(JSON.stringify({ id: "catalog-test", model: "scripted:truth-deepseek",
          choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
      } });
    const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
      assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
      generateStructured: request => { context = request.context; return gateway.generateStructured(request); } };
    const run = new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
      { workloadId: "catalog-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
    if (invalid) await expect(run).rejects.toThrow();
    else results.push(await run);
    expect(calls).toBe(1);
    expect(contentHash(input)).toBe(before);
  }
  if (!invalid) {
    expect(results[0]?.receipts).toEqual(results[1]?.receipts);
    expect(results[0]?.requests).toEqual(results[1]?.requests);
    expect(results[0]?.checks).toEqual(results[1]?.checks);
    expect(results[0]?.rng).toEqual(results[1]?.rng);
    expect(results[0]?.targets).toEqual(results[1]?.targets);
  }
});
