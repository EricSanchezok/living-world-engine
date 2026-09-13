import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { existingReferenceHandleSchemaFor } from "../../../contracts/model-context";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { canonicalize, contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import { combineModelExecutionAudits, modelInvocationIdentity, type StructuredModelProvider, type StructuredModelRequest } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry, noStimulusReportsForTargets } from "../../../testing/model-provider";
import { expandPerceptionCatalog } from "../perception-catalog-transport";
import { PerceptionEvidenceReader } from "../perception-evidence-reader";

it.each(["valid", "unread", "unknown"])("reads through the real gateway without weakening canonical validation (%s)", async mode => {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: catalog });
  const state = definition.initialState;
  const input = { definition, state, identityOwner: "evidence-reader", groundings: [],
    actions: [{ id: "move", actorId: "player", baseRevision: state.revision, rawText: "Start moving", goal: "Move", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "move" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input);
  let reader: PerceptionEvidenceReader, source: StructuredModelRequest<unknown>, fact: string, calls = 0;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (url, init) => {
      calls++;
      const body = await new Request(url, init).json(), bodyHash = contentHash(body), wire = reader.transformBody(body);
      expect(contentHash(body)).toBe(bodyHash);
      expect(wire).toEqual({ ...body, messages: expect.any(Array) });
      const user = (wire.messages as Array<{ role: string; content: string }>).find(message => message.role === "user")!;
      expect(user.content).toContain(JSON.stringify(canonicalize(reader.view())));
      expect(user.content).toContain('"read_evidence"');
      expect(user.content).not.toContain("top-level result kind must be exactly");
      expect(() => reader.transformBody(wire)).toThrow("does not match");
      let output: unknown;
      if (calls === 1 && mode !== "unread") output = { kind: "read_evidence", reads: [{ table: "facts", keys: [fact] }] };
      else {
        const reports = noStimulusReportsForTargets(input);
        const evidence = mode === "unknown"
          ? [{ kind: "entity", ref: existingReferenceHandleSchemaFor("entity").parse("ref:entity:not-a-real-observer") }]
          : [{ kind: "fact", ref: existingReferenceHandleSchemaFor("fact").parse(fact) }];
        output = { kind: "done", reports: reports.map((report, index) => index === 0 ? { ...report, evidence } : report) };
      }
      return new Response(JSON.stringify({ id: `read-${calls}`, model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }), { headers: { "content-type": "application/json" } });
    } });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids),
    generateStructured: async request => {
      source = request; reader = new PerceptionEvidenceReader(request.context, 2);
      const original = request.context as { state: { canonicalTruth: { facts: Record<string, unknown> } } };
      fact = Object.keys(original.state.canonicalTruth.facts)[0]!;
      const adapted = reader.request(request);
      expect(adapted.context).toBe(request.context);
      expect(() => adapted.preprocessOutput!({ kind: "done", reports: [{ evidence: [{ ref: fact }] }] })).toThrow("unread evidence");
      const audits = [];
      for (let round = 0; round < 3; round++) {
        const identity = modelInvocationIdentity({ ...request, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } }, request.role, request.subjectId, round + 1);
        const result = await gateway.generateStructured({ ...adapted, ...identity });
        audits.push(result.audit);
        const output = result.value as { kind: string };
        if (output.kind === "read_evidence") reader.read(output);
        else return { value: request.schema.parse(result.value), audit: combineModelExecutionAudits(audits) };
      }
      throw new Error("test read budget exhausted");
    } };
  const run = new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(input,
    { workloadId: "reader-world", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  if (mode !== "valid") await expect(run).rejects.toThrow();
  else {
    const result = await run;
    expect(result.receipts).toHaveLength(1); expect(result.modelAudit.invocations).toHaveLength(2);
    expect(result.rng).toEqual(state.truth.rng);
    const readerCopy = new PerceptionEvidenceReader(source!.context, 2), viewHash = contentHash(readerCopy.view());
    expect(() => readerCopy.read({ kind: "read_evidence", reads: [{ table: "facts", keys: [fact!] }, { table: "facts", keys: [fact!] }] })).toThrow("duplicate");
    expect(() => readerCopy.read({ kind: "read_evidence", reads: [{ table: "facts", keys: [fact!] }, { table: "entities", keys: ["missing"] }] })).toThrow("unknown evidence key");
    expect(contentHash(readerCopy.view())).toBe(viewHash);
    const original = source!.context as { state: { canonicalTruth: Record<string, unknown> } };
    const tables = Object.entries(original.state.canonicalTruth).filter(([, value]) => value && typeof value === "object" && !Array.isArray(value));
    const read = readerCopy.read({ kind: "read_evidence", reads: tables.map(([table]) => ({ table, keys: [] })) });
    expect(read.results.map(result => [result.table, result.records])).toEqual(tables);
    readerCopy.assertLoadedReferences({ evidence: fact! });
    const complete = readerCopy.read({ kind: "read_evidence", reads: [{ table: "source_context", keys: [] }] });
    expect(complete.results[0]!.records).toEqual(source!.context);
    const restored = readerCopy.view(); delete restored.evidenceAccess;
    expect(expandPerceptionCatalog(restored, contentHash(source!.context))).toEqual(source!.context);
    expect(() => readerCopy.read({ kind: "read_evidence", reads: [{ table: "source_context", keys: [] }] })).toThrow("read limit reached");
    (complete.results[0]!.records as Record<string, unknown>).state = {};
    expect(readerCopy.view()).not.toEqual(complete.results[0]!.records);
    const changed = structuredClone(source!.context) as Record<string, unknown>, bound = new PerceptionEvidenceReader(changed, 1);
    changed.task = {};
    expect(() => bound.view()).toThrow("source changed");
  }
  expect(calls).toBe(mode === "unread" ? 1 : 2);
  expect(contentHash(input)).toBe(before);
});
