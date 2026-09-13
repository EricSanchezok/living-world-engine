import Ajv from "ajv";
import path from "node:path";
import { expect, it } from "vitest";
import type { OnsetPerceptionInput } from "../../../algorithms/roles";
import { perceptionDirectiveSchema } from "../../../contracts/llm-schemas";
import { TruthEngine } from "../../../mechanics/truth-engine";
import { selectTemporalBoundary } from "../../../mechanics/temporal";
import { contentHash } from "../../../models/model-audit";
import type { StructuredModelRequest } from "../../../models/model-provider";
import { ScriptedModelProvider } from "../../../testing/model-provider";
import { loadWorldScript } from "../../../../script/world-loader";
import { perceptionReportDomainsRequest, perceptionReportDomainsSchema } from "../perception-report-domains";
import { perceptionObserverGroups } from "../perception-observer-groups";

it("binds fixed checks to their assigned pairs and diagnoses all original report positions through actual repair", async () => {
  const captured: StructuredModelRequest<unknown>[] = [];
  const checks = (context: unknown) => (context as { state: { committedCheckRequests: Array<{ checkRef: string }> } }).state.committedCheckRequests;
  const report = (targetIndex: number, checkRefs: string[], perceived: boolean) => ({
    targetIndex, checkRefs, kind: perceived ? "perceived" : "no_stimulus", reason: "The fixed check resolves the authored uncertainty.",
    evidence: [{ kind: "law", ref: "ref:law:time-passes" }],
    ...(perceived ? { stimulus: { summary: "The present movement is visible.", introductions: [], apparentClaims: [], sourceEventRefs: [] } } : {}),
  });
  const good = (context: unknown) => {
    const [shared, failed] = checks(context);
    return { kind: "done", reports: [report(2, [failed!.checkRef], false), report(0, [shared!.checkRef], true), report(1, [shared!.checkRef], true)] };
  };
  let ordinal = 0;
  const provider = new ScriptedModelProvider(request => {
    ordinal++;
    if (ordinal === 1) return { kind: "request_checks", requests: [
      { proposalKey: "shared", actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
        difficulty: { kind: "environment", band: "trivial", source: { kind: "law", ref: "ref:law:time-passes" } },
        mode: "normal", stakes: "Notice the two simultaneous movements", visibility: "full",
        causes: [{ kind: "action", ref: "ref:action:a" }, { kind: "action", ref: "ref:action:b" }, { kind: "law", ref: "ref:law:time-passes" }] },
      { proposalKey: "failed", actorRef: "ref:entity:player", targetRef: "ref:entity:keeper", ratingRef: null,
        difficulty: { kind: "environment", band: "extreme", source: { kind: "law", ref: "ref:law:time-passes" } },
        mode: "normal", stakes: "Notice the keeper's concealed movement", visibility: "full",
        causes: [{ kind: "action", ref: "ref:action:c" }, { kind: "law", ref: "ref:law:time-passes" }] },
    ] };
    const [shared, failed] = checks(request.context);
    if (ordinal === 2) return { kind: "done", reports: [
      report(2, [shared!.checkRef], true), report(0, [], true), report(1, [failed!.checkRef], false),
    ] };
    const issues = (request.context as { repair: { issues: Array<{ code: string; path: unknown[]; allowedHandles: string[] }> } }).repair.issues;
    expect(issues.map(issue => ({ code: issue.code, path: issue.path, allowed: issue.allowedHandles }))).toEqual([
      { code: "perception.report_check_binding", path: ["reports", 0, "checkRefs", 0], allowed: [] },
      { code: "perception.report_missing_check", path: ["reports", 1, "checkRefs"], allowed: [shared!.checkRef] },
      { code: "perception.report_check_binding", path: ["reports", 2, "checkRefs", 0], allowed: [shared!.checkRef] },
    ]);
    return good(request.context);
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const input: OnsetPerceptionInput = { definition, state, identityOwner: "report-check-binding", groundings: [],
    actions: ["a", "b", "c"].map(id => ({ id, actorId: id === "c" ? "keeper" : "player", baseRevision: state.revision,
      rawText: "Begin a movement", goal: "Move", means: null, targetIds: [] })),
    perceptionTargets: [{ observerId: "keeper", sourceActionId: "a" }, { observerId: "keeper", sourceActionId: "b" }, { observerId: "player", sourceActionId: "c" }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  const before = contentHash(input), generate = provider.generateStructured.bind(provider);
  provider.generateStructured = request => {
    const adapted = perceptionReportDomainsRequest(request);
    expect(adapted.context).toBe(request.context); expect(adapted.schema).toBe(request.schema);
    captured.push(adapted); return generate(adapted);
  };
  const result = await new TruthEngine(provider, { repairAttempts: 1 }).perceiveOnset(input,
    { workloadId: "bindings", batchId: "onset", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } });
  expect(captured).toHaveLength(3);
  expect(result.checks.map(check => check.succeeded)).toEqual([true, false]);
  expect(result.requests).toHaveLength(2); expect(result.rng.draws).toBe(state.truth.rng.draws + 2);
  expect(result.receipts.map(receipt => [receipt.targetIndex, receipt.kind])).toEqual([[0, "perceived"], [1, "perceived"], [2, "no_stimulus"]]);
  expect(contentHash(input)).toBe(before);
  // Zod owns Unicode reference patterns; Ajv 6 checks the relational Draft-07 constraints.
  const wire = JSON.parse(JSON.stringify(captured[1]!.wireJsonSchema), (key, value) =>
    key === "pattern" && typeof value === "string" && value.includes("\\p{") ? undefined : value);
  const validate = new Ajv({ schemaId: "auto", unknownFormats: "ignore" }).compile(wire);
  const valid = good(captured[1]!.context);
  expect(perceptionDirectiveSchema.safeParse(valid).success).toBe(true); expect(validate(valid)).toBe(true);
  const [shared, failed] = checks(captured[1]!.context);
  for (const invalid of [
    { ...valid, reports: valid.reports.slice(1) },
    { ...valid, reports: [valid.reports[1], valid.reports[1], valid.reports[0]] },
    { ...valid, reports: [report(2, [shared!.checkRef], false), ...valid.reports.slice(1)] },
    { ...valid, reports: [report(2, [failed!.checkRef], true), ...valid.reports.slice(1)] },
    { ...valid, reports: [report(2, [], true), ...valid.reports.slice(1)] },
    { ...valid, reports: [valid.reports[0], report(0, [], true), valid.reports[2]] },
    { ...valid, reports: [valid.reports[0], report(0, [shared!.checkRef, shared!.checkRef], true), valid.reports[2]] },
  ]) expect(validate(invalid)).toBe(false);
  expect(validate({ ...valid, reports: [report(2, [], false), ...valid.reports.slice(1)] })).toBe(true);
  const groups = perceptionObserverGroups(captured[1]!.context, 1);
  expect(groups).toHaveLength(2);
  for (const [ordinal, group] of groups.entries()) {
    const groupWire = JSON.parse(JSON.stringify(perceptionReportDomainsSchema(group)), (key, value) =>
      key === "pattern" && typeof value === "string" && value.includes("\\p{") ? undefined : value);
    const acceptsGroup = new Ajv({ schemaId: "auto", unknownFormats: "ignore" }).compile(groupWire);
    const selected = ordinal === 0 ? valid.reports.slice(1) : valid.reports.slice(0, 1);
    expect(acceptsGroup({ kind: "done", reports: selected })).toBe(true);
    expect(acceptsGroup(valid)).toBe(false);
    expect(group.state).toEqual((captured[1]!.context as { state: unknown }).state);
    expect(group.referenceCatalog).toEqual((captured[1]!.context as { referenceCatalog: unknown }).referenceCatalog);
  }
  const missing = structuredClone(captured[1]!.context) as { state: { checkResults: unknown[] } };
  missing.state.checkResults.pop();
  expect(() => perceptionReportDomainsSchema(missing)).toThrow("incomplete committed check results");
});
