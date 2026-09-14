import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../../script/world-loader";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import { modelReferenceSchema } from "../../../contracts/model-context";
import { TruthEngine, materializeOnsetPerceptionChecks } from "../../../mechanics/truth-engine";
import { resolveD20Checks } from "../../../mechanics/random";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import { createModelGateway } from "../../../models/model-gateway";
import type { StructuredModelProvider } from "../../../models/model-provider";
import { createTestModelCatalog, createTestModelRegistry } from "../../../testing/model-provider";
import { PerceptionReportProgram, runPerceptionReportProgram, perceptionReportProgramSchema, type PerceptionProgramTrace } from "../perception-report-program";

function reportSchemaWithoutChecks(report: Extract<z.infer<typeof perceptionReportProgramSchema>["nodes"][number], { kind: "report" }>["report"]) {
  const { checkKeys, ...fields } = report;
  expect(checkKeys).toEqual(["notice"]);
  return fields;
}

function fixture(seed = 0) {
  const catalog = createTestModelCatalog();
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed, modelCatalog: catalog });
  definition.laws.push({ id: "onset-channel", severity: "hard", text: "Perceiving the raised hand behind this screen requires a normal easy check with the keeper's resolve. A failed check reveals no hand. The same uncertainty is never rerolled." });
  definition.initialState.lawIds.push("onset-channel");
  const source: OnsetPerceptionInput = { definition, state: structuredClone(definition.initialState), identityOwner: "onset", groundings: [],
    actions: [{ id: "raise-hand", actorId: "player", baseRevision: 0, rawText: "I raise a hand behind the screen.", goal: "Raise my hand", means: null, targetIds: [] }],
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "raise-hand" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const evidence = [{ kind: "law", ref: "ref:law:onset-channel" }];
  const program = perceptionReportProgramSchema.parse({ kind: "perception_program", requests: [{ proposalKey: "notice", actorRef: "ref:entity:keeper",
    targetRef: "ref:entity:player", ratingRef: "ref:rating:resolve:keeper", difficulty: { kind: "environment", band: "easy", source: evidence[0] },
    mode: "normal", stakes: "Whether the keeper sees the raised hand behind the screen.", visibility: "full",
    causes: [{ kind: "action", ref: "ref:action:raise-hand" }, ...evidence] }],
  roots: [{ targetIndex: 0, node: 0 }], nodes: [
    { kind: "branch", checkKey: "notice", succeeded: 1, failed: 2 },
    { kind: "report", report: { targetIndex: 0, kind: "perceived", reason: "The required check establishes visibility of this onset.", evidence, checkKeys: ["notice"],
      stimulus: { summary: "You see the raised hand behind the screen.", introductions: [], apparentClaims: [], sourceEventRefs: [] } } },
    { kind: "report", report: { targetIndex: 0, kind: "no_stimulus", reason: "The required check failed.", evidence, checkKeys: ["notice"] } },
  ] });
  return { catalog, source, program };
}

async function run(f: ReturnType<typeof fixture>, compiled: boolean, program = f.program) {
  let http = 0, output: unknown;
  const traces: PerceptionProgramTrace[] = [], contexts: unknown[] = [];
  const gateway = createModelGateway(f.catalog, { TEST_MODEL_API_KEY: "test-only" }, { registry: createTestModelRegistry(f.catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async () => {
      http++;
      return Response.json({ id: `perception-program-${http}`, model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } });
    } });
  const provider: StructuredModelProvider = { catalog: f.catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
    assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async request => {
      contexts.push(structuredClone(request.context));
      const state = (request.context as { state: { committedCheckRequests: Array<{ checkRef: string }>; checkResults: Array<{ succeeded: boolean }> } }).state;
      if (request.schemaName === "truth_perception_report_program") output = program;
      else if (!state.checkResults.length) output = { kind: "request_checks", requests: f.program.requests };
      else {
        const node = f.program.nodes[state.checkResults[0]!.succeeded ? 1 : 2]!;
        if (node.kind !== "report") throw new Error("fixture terminal report missing");
        const report = reportSchemaWithoutChecks(node.report);
        output = { kind: "done", reports: f.source.perceptionTargets!.map((_, targetIndex) => ({ ...report, targetIndex,
          checkRefs: state.committedCheckRequests.map(check => check.checkRef) })) };
      }
      return gateway.generateStructured(request);
    } };
  const before = contentHash(f.source);
  try {
    const scope = { workloadId: "program-fixture", batchId: "onset", runtimeIdentity: { worldHash: f.source.state.worldHash, revision: f.source.state.revision } };
    const result = compiled ? await runPerceptionReportProgram(provider, f.source, scope, trace => traces.push(trace))
      : await new TruthEngine(provider, { repairAttempts: 0 }).perceiveOnset(f.source, scope);
    expect(contentHash(f.source)).toBe(before);
    return { result, http, traces, contexts };
  } catch (error) {
    expect(contentHash(f.source)).toBe(before);
    throw Object.assign(error as Error, { observedHttp: http, programTraces: traces });
  }
}

it("preserves real successful and failed check transcripts with one HTTP instead of two", async () => {
  const outcomes = new Set<boolean>();
  for (const seed of [0, 1, 2]) {
    const f = fixture(seed), baseline = await run(f, false), candidate = await run(f, true);
    const { modelAudit: originalAudit, ...original } = baseline.result;
    const { modelAudit: candidateAudit, ...actual } = candidate.result;
    expect(actual).toEqual(original);
    expect(baseline.http).toBe(2); expect(candidate.http).toBe(1);
    expect(originalAudit.invocations).toHaveLength(2); expect(candidateAudit.invocations).toHaveLength(1);
    expect(candidateAudit.invocations[0]!.tokenUsage).toMatchObject({ input: 100, output: 30 });
    expect(candidate.traces.map(trace => trace.kind)).toEqual(["checks", "reports"]);
    expect(candidate.traces[1]!.visitedNodes).toEqual([0, actual.checks[0]!.succeeded ? 1 : 2]);
    expect(candidate.contexts[0]).toEqual(baseline.contexts[0]);
    expect(actual.rng.draws).toBe(1); outcomes.add(actual.checks[0]!.succeeded);
  }
  expect(outcomes).toEqual(new Set([false, true]));
});

it("preserves explicit deferral through ordinary full-context interpretation", async () => {
  const f = fixture();
  const deferred = { ...f.program, nodes: [{ kind: "defer" as const, checkKeys: ["notice"], reason: "Interpret the result through the original protocol." }] };
  const baseline = await run(f, false), candidate = await run(f, true, deferred);
  expect(candidate.http).toBe(2); expect(candidate.result.modelAudit.invocations).toHaveLength(2);
  expect(candidate.traces.map(trace => trace.kind)).toEqual(["checks", "defer"]);
  expect({ ...candidate.result, modelAudit: null }).toEqual({ ...baseline.result, modelAudit: null }); expect(candidate.contexts[1]).toEqual(baseline.contexts[1]);
});

it("finishes a source-bound no-check program without drawing", async () => {
  const f = fixture(), node = f.program.nodes[2]!;
  f.source.actions[0]!.rawText = "I privately consider raising my hand without moving.";
  f.source.actions[0]!.goal = "Privately consider a gesture";
  if (node.kind !== "report") throw new Error("fixture report missing");
  const program = { ...f.program, requests: [], nodes: [{ ...node, report: { ...node.report, reason: "No present onset reaches this observer.", checkKeys: [] } }] };
  const result = await run(f, true, program);
  expect(result.http).toBe(1); expect(result.result.requests).toEqual([]); expect(result.result.rng).toEqual(f.source.state.truth.rng);
  expect(result.traces.map(trace => trace.kind)).toEqual(["reports"]);
});

it.each(["cycle", "unknown-node", "wrong-owner", "missing-root", "unused-check", "unconditional-perceived"])("rejects %s before the first runtime draw and retains the paid audit", async mode => {
  const f = fixture(), program: z.infer<typeof perceptionReportProgramSchema> = structuredClone(f.program);
  if (mode === "cycle") program.nodes[0] = { kind: "branch", checkKey: "notice", succeeded: 0, failed: 2 };
  if (mode === "unknown-node") program.roots[0]!.node = 99;
  if (mode === "wrong-owner") {
    program.requests[0]!.actorRef = modelReferenceSchema.parse("ref:entity:player");
    program.requests[0]!.ratingRef = modelReferenceSchema.parse("ref:rating:resolve:player");
  }
  if (mode === "missing-root") program.roots = [];
  if (mode === "unused-check") {
    const node = program.nodes[2]!; if (node.kind !== "report") throw new Error("fixture report missing");
    program.nodes = [{ ...node, report: { ...node.report, checkKeys: [] } }];
  }
  if (mode === "unconditional-perceived") program.nodes = [program.nodes[1]!];
  await expect(run(f, true, program)).rejects.toMatchObject({ observedHttp: 1, programTraces: [], audit: { invocations: [expect.anything()] } });
});

it("rejects an invalid report source without generating a replacement or mutating the world", async () => {
  const f = fixture(), program = structuredClone(f.program), node = program.nodes[2]!;
  if (node.kind !== "report") throw new Error("fixture report missing");
  // Keep the reference kind syntactically legal so the original runtime resolver owns rejection.
  node.report.evidence = [{ kind: "law", ref: modelReferenceSchema.parse("ref:law:missing") }];
  await expect(run(f, true, program)).rejects.toMatchObject({ observedHttp: 1 });
});

it("binds result identity and rejects source mutation before local branch execution", () => {
  const f = fixture(), program = new PerceptionReportProgram(f.source, f.program);
  const requests = materializeOnsetPerceptionChecks({ ...f.source, requests: [], commitmentRound: 0 }, f.program.requests);
  const results = resolveD20Checks(f.source.state.truth.rng, requests).results;
  expect(() => program.finish(requests, [{ ...results[0]!, requestId: "foreign" }])).toThrow("exact committed");
  expect(program.finish(requests, results).directive?.kind).toBe("done");
  f.source.state.step++;
  expect(() => program.finish(requests, results)).toThrow("source changed");
});

it("preserves one shared check across two source actions of the same observer", async () => {
  const f = fixture(1);
  f.source.actions.push({ ...f.source.actions[0]!, id: "raise-other-hand", rawText: "I raise my other hand behind the same screen." });
  f.source.perceptionTargets = [...f.source.perceptionTargets!, { observerId: "keeper", sourceActionId: "raise-other-hand" }];
  f.program.requests[0]!.causes.push({ kind: "action", ref: modelReferenceSchema.parse("ref:action:raise-other-hand") });
  const program = structuredClone(f.program);
  program.roots.push({ targetIndex: 1, node: 3 });
  program.nodes.push({ kind: "branch", checkKey: "notice", succeeded: 4, failed: 5 });
  for (const index of [1, 2]) {
    const node = f.program.nodes[index]!; if (node.kind !== "report") throw new Error("fixture report missing");
    program.nodes.push({ ...node, report: { ...node.report, targetIndex: 1 } });
  }
  const baseline = await run(f, false), candidate = await run(f, true, program);
  expect(candidate.http).toBe(1); expect(candidate.result.requests).toHaveLength(1);
  expect(candidate.result.receipts).toEqual(baseline.result.receipts); expect(candidate.result.rng).toEqual(baseline.result.rng);
});

it("validates shared joins without enumerating outcome combinations or inventing success guarantees", () => {
  const f = fixture();
  const joined = structuredClone(f.program);
  joined.nodes = [{ kind: "branch", checkKey: "notice", succeeded: 1, failed: 1 }, joined.nodes[1]!];
  expect(() => new PerceptionReportProgram(f.source, joined)).toThrow("successful branch");
  const count = 26;
  f.source.actions[0]!.rawText = "Reveal a panel of 26 independently screened numbered signals.";
  f.source.definition.laws.find(law => law.id === "onset-channel")!.text = "Each numbered signal has an independent patterned screen and requires a separate normal easy resolve check to read. Interpreting the whole pattern can require further assessment.";
  const requests = Array.from({ length: count }, (_, index) => ({ ...f.program.requests[0]!, proposalKey: `signal-${index}`,
    stakes: `Whether the keeper reads numbered signal ${index}.` }));
  const program = perceptionReportProgramSchema.parse({ ...f.program, requests,
    nodes: [...requests.map((request, index) => ({ kind: "branch", checkKey: request.proposalKey, succeeded: index + 1, failed: index + 1 })),
      { kind: "defer", checkKeys: requests.map(request => request.proposalKey), reason: "Interpret the full observed pattern." }] });
  expect(new PerceptionReportProgram(f.source, program).materializedChecks()).toHaveLength(count);
});

it("retains all paid invocations when ordinary deferred interpretation fails", async () => {
  const f = fixture();
  const deferred = { ...f.program, nodes: [{ kind: "defer" as const, checkKeys: ["notice"], reason: "Interpret after the check." }] };
  for (const node of f.program.nodes) if (node.kind === "report") {
    node.report.evidence = [{ kind: "law", ref: modelReferenceSchema.parse("ref:law:missing") }];
  }
  await expect(run(f, true, deferred)).rejects.toMatchObject({ observedHttp: 2,
    audit: { invocations: [expect.anything(), expect.objectContaining({ outputDisposition: "rejected" })] } });
});
