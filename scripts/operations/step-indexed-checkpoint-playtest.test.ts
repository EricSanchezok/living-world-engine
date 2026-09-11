import { expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { assertMechanicalTransitionDiagnostic, assertOwnershipDiagnostic } from "./step-indexed-checkpoint-playtest";

it("requires exact diagnostic inputs and first-response accuracy before integrated testing", () => {
  const labels = Array.from({ length: 12 }, (_, i) => ({ expected: i % 2 ? "accept" : "reject" }));
  const manifest = { sourceHash: "bound", labels, requestHashes: ["original"] };
  const report = { ...manifest, status: "completed", dispatches: 1, rows: labels.map((label, slot) => ({ slot, verdict: label.expected, error: null })) };
  expect(() => assertOwnershipDiagnostic(report, manifest)).not.toThrow();
  expect(() => assertOwnershipDiagnostic({ ...report, sourceHash: "changed" }, manifest)).toThrow("has not passed");
  expect(() => assertOwnershipDiagnostic({ ...report, dispatches: 2 }, manifest)).toThrow("has not passed");
  expect(() => assertOwnershipDiagnostic({ ...report, rows: report.rows.map(row => ({ ...row, verdict: "accept" })) }, manifest)).toThrow("has not passed");
});

it("carries only an unchanged first HTTP evaluation across the named local batch-version change", () => {
  const fixture = () => {
    const labels = Array.from({ length: 12 }, (_, i) => ({ expected: i % 2 ? "accept" : "reject" }));
    const historicalRequest = { promptVersion: "verifier:physical-cardinality-no-example-v1",
      system: "Preserve the complete source", context: { actions: ["first", "second"] } };
    const currentRequest = { ...historicalRequest, promptVersion: "verifier:physical-cardinality-slot-repair-v2" };
    const body = { model: "deepseek-v4-flash", thinking: { type: "disabled" }, messages: ["same complete source"] };
    const manifest = { trialId: "review-test", sourceHash: "source", labels, requestHashes: ["logical"],
      initialPhysicalRequestHash: contentHash(currentRequest) };
    const report = { ...manifest, initialPhysicalRequestHash: contentHash(historicalRequest), status: "completed", dispatches: 1,
      rows: labels.map((label, slot) => ({ slot, verdict: label.expected, error: null })) };
    const wire = { historicalRequest, currentRequest,
      historicalTransport: { id: "review-test-http-001", body, bodyHash: contentHash(body) }, currentBody: JSON.stringify(body) };
    return { manifest, report, wire };
  };
  const original = fixture();
  const before = structuredClone(original);
  expect(() => assertOwnershipDiagnostic(original.report, original.manifest)).toThrow("has not passed");
  expect(assertOwnershipDiagnostic(original.report, original.manifest, original.wire)).toEqual({
    historicalPhysicalRequestHash: original.report.initialPhysicalRequestHash,
    currentPhysicalRequestHash: original.manifest.initialPhysicalRequestHash,
    bodyHash: original.wire.historicalTransport.bodyHash, scope: "first-response-only",
  });
  expect(original).toEqual(before);
  const mutations: Array<(value: ReturnType<typeof fixture>) => void> = [
    value => { value.wire.currentBody = value.wire.currentBody.replace("disabled", "enabled"); },
    value => { value.wire.historicalTransport.bodyHash = "corrupted"; },
    value => { value.wire.historicalTransport.id = "another-trial-http-001"; },
    value => { value.wire.currentRequest.context = { actions: ["first"] };
      value.manifest.initialPhysicalRequestHash = contentHash(value.wire.currentRequest); },
    value => { value.wire.currentRequest.promptVersion = "verifier:future-version";
      value.manifest.initialPhysicalRequestHash = contentHash(value.wire.currentRequest); },
    value => { value.manifest.sourceHash = "another-source"; },
    value => { value.manifest.requestHashes = ["different-logical-request"]; },
    value => { value.report.dispatches = 2; },
    value => { value.report.rows[0]!.verdict = "accept"; },
  ];
  for (const mutate of mutations) {
    const changed = fixture(); mutate(changed);
    expect(() => assertOwnershipDiagnostic(changed.report, changed.manifest, changed.wire)).toThrow();
  }
});

it("binds offline mechanical evidence to the selected commit, source, complete result and actual request", () => {
  const request = { frozen: "mechanical request" };
  const report = { commit: "checked", pipelineFingerprint: INDEXED_REVIEWED_PLANNING_PROMPT_VERSION,
    sourceHash: "94449d84514493f039d659e9dd5c72cf589ac2acc29e7e9f7e9f116b1de13934",
    canonicalHash: "ae90d7f4fbbaa8b3246b35c722683bba7ecd54932b1c74782f2fc8db65303ef4",
    slots: 12, actions: 43, fixtureCalls: 1, actualHttp: 0, mechanicalOnly: true, researchInterval: false,
    fixtureAuditUsageDiscarded: true, requestHash: contentHash(request) };
  expect(() => assertMechanicalTransitionDiagnostic(report, request, "checked")).not.toThrow();
  for (const changed of [{ commit: "stale" }, { actions: 42 }, { sourceHash: "different" }, { canonicalHash: "different" },
    { actualHttp: 1 }, { researchInterval: true }, { fixtureAuditUsageDiscarded: false }, { pipelineFingerprint: "stale" }]) {
    expect(() => assertMechanicalTransitionDiagnostic({ ...report, ...changed }, request, "checked")).toThrow();
  }
  expect(() => assertMechanicalTransitionDiagnostic(report, { frozen: "different" }, "checked")).toThrow();
});
