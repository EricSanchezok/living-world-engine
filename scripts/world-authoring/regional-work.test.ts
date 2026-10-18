import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { routeRegionalCandidates } from "./regional-work";

function fixture() {
  const source = "东城商人曾到西城。同名人甲与乙无关系。\n";
  const batch = { id: "batch-0001", parts: [{ chapter_id: "qq-1", start: 0, end: [...source].length, sha256: contentHash(source) }] };
  const evidence = [{ chapterId: "qq-1", paragraphId: "qq-1:0", paragraphSha256: contentHash(source.trim()),
    start: 0, end: 4, anchorSha256: contentHash(source.slice(0, 4)) }];
  const report = { batchId: batch.id, chapters: ["qq-1"], approvedForRuntime: false, policyHash: "policy", schemaHash: "schema",
    identity: contentHash({ parts: batch.parts, policyHash: "policy", schemaHash: "schema", profileId: "p", catalogHash: "c" }),
    audits: [{ profileId: "p", modelCatalogHash: "c" }, { profileId: "p", modelCatalogHash: "c" }],
    objects: ["东城商人曾到西城", "另一个同名人"].map((description, index) => ({ id: `${batch.id}-object-${index}`, label: "同名人", aliases: [], kind: "person",
      description, status: "machine-reviewed-needs-adjudication", evidence })), facts: [], issues: [] };
  const regions = [{ id: "east", realm: "human", search_terms: ["东城"] }, { id: "west", realm: "human", search_terms: ["西城"] }];
  return { source, batch, report, regions };
}

describe("regional production queues", () => {
  it("keeps cross-region evidence in both queues and unmatched same-name people for editorial routing", () => {
    const f = fixture(), result = routeRegionalCandidates([f.report], f.regions, [f.batch], () => f.source);
    expect(result.queues.map(queue => queue.candidates.map(candidate => candidate.id))).toEqual([["batch-0001-object-0"], ["batch-0001-object-0"]]);
    expect(result.unassigned.map(candidate => candidate.id)).toEqual(["batch-0001-object-1"]);
    expect(f.report.approvedForRuntime).toBe(false);
    expect(result.queues.every(queue => queue.status === "lexical-review-queue-not-canonical")).toBe(true);
  });
  it("binds routes to complete report content and rejects stale source evidence", () => {
    const f = fixture();
    const before = routeRegionalCandidates([f.report], f.regions, [f.batch], () => f.source);
    f.report.objects[0]!.description = "只在东城";
    const after = routeRegionalCandidates([f.report], f.regions, [f.batch], () => f.source);
    expect(after.inputHash).not.toBe(before.inputHash);
    expect(after.queues[0]!.inputHash).not.toBe(before.queues[0]!.inputHash);
    expect(after.queues[1]!.inputHash).not.toBe(before.queues[1]!.inputHash);
    expect(after.queues[1]!.candidates).toEqual([]);
    expect(() => routeRegionalCandidates([f.report], f.regions, [f.batch], () => `错${f.source}`)).toThrow("source part drift");
  });
  it("retains a region's review fingerprint when unrelated regions are added or reordered", () => {
    const f = fixture();
    const before = routeRegionalCandidates([f.report], f.regions, [f.batch], () => f.source);
    const after = routeRegionalCandidates([f.report], [
      { id: "north", realm: "spirit", search_terms: ["北境"] }, ...f.regions.toReversed(),
    ], [f.batch], () => f.source);
    expect(after.inputHash).not.toBe(before.inputHash);
    for (const queue of before.queues) {
      expect(after.queues.find(item => item.moduleId === queue.moduleId)).toEqual(queue);
    }
  });
  it("invalidates a region when its routing scope changes, even with the same matching candidates", () => {
    const f = fixture();
    const before = routeRegionalCandidates([f.report], f.regions, [f.batch], () => f.source);
    const after = routeRegionalCandidates([f.report], [
      { ...f.regions[0]!, search_terms: ["东城", "北境"] }, f.regions[1]!,
    ], [f.batch], () => f.source);
    expect(after.queues[0]!.candidates).toEqual(before.queues[0]!.candidates);
    expect(after.queues[0]!.inputHash).not.toBe(before.queues[0]!.inputHash);
    expect(after.queues[1]!.inputHash).toBe(before.queues[1]!.inputHash);
  });
  it("ignores a homonymous phrase without dropping a separate real match or unassigned evidence", () => {
    const f = fixture();
    f.report.objects[0]!.description = "修仙界的凡人后来飞升仙界";
    f.report.objects[1]!.description = "修仙界的凡人";
    const result = routeRegionalCandidates([f.report], [
      { id: "external", realm: "shared", search_terms: ["仙界"], ignore_phrases: ["修仙界"] },
    ], [f.batch], () => f.source);
    expect(result.queues[0]!.candidates.map(item => item.id)).toEqual(["batch-0001-object-0"]);
    expect(result.unassigned.map(item => item.id)).toEqual(["batch-0001-object-1"]);
    expect(f.report.objects).toHaveLength(2);
    const withoutExclusion = routeRegionalCandidates([f.report], [
      { id: "external", realm: "shared", search_terms: ["仙界"] },
    ], [f.batch], () => f.source);
    expect(withoutExclusion.queues[0]!.candidates).toHaveLength(2);
    expect(result.queues[0]!.inputHash).not.toBe(withoutExclusion.queues[0]!.inputHash);
  });
});
