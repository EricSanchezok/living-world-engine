import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { fullyExtractedChapters, indexSourceReports } from "./authoring-index";

function fixture() {
  const body = "甲名韩立，乙也叫韩立。\n";
  const batch = { id: "batch-0001", parts: [{ chapter_id: "qq-1", start: 0, end: [...body].length, sha256: contentHash(body) }] };
  const report = { batchId: batch.id, chapters: ["qq-1"], approvedForRuntime: false, policyHash: "policy", schemaHash: "schema",
    identity: contentHash({ parts: batch.parts, policyHash: "policy", schemaHash: "schema", profileId: "profile", catalogHash: "catalog" }),
    audits: [{ profileId: "profile", modelCatalogHash: "catalog" }, { profileId: "profile", modelCatalogHash: "catalog" }],
    objects: [2, 8].map((start, index) => ({ id: `${batch.id}-object-${index}`, label: "韩立", aliases: ["小韩"], kind: "person",
      status: "machine-reviewed-needs-adjudication", evidence: [{ chapterId: "qq-1", paragraphId: "qq-1:0", paragraphSha256: contentHash(body.trim()),
        start, end: start + 2, anchorSha256: contentHash([...body].slice(start, start + 2).join("")) }] })),
    facts: [], issues: [] };
  return { body, batch, report };
}

describe("candidate index and honest coverage", () => {
  it("retains same-name and shared-alias candidates as separate unadjudicated identities", () => {
    const f = fixture(), index = indexSourceReports([f.report], [f.batch], () => f.body);
    expect(index.subjects).toHaveLength(2);
    expect(index.subjects.every(subject => subject.canonicalId === null)).toBe(true);
    expect(index.names.find(item => item.name === "韩立")?.candidateIds).toHaveLength(2);
    expect(index.names.find(item => item.name === "小韩")?.resolution).toBe("unresolved-do-not-merge");
  });
  it("rejects stale source parts and citation hashes before indexing", () => {
    const f = fixture();
    expect(() => indexSourceReports([f.report], [f.batch], () => `${f.body}改`)).not.toThrow();
    expect(() => indexSourceReports([f.report], [f.batch], () => `改${f.body}`)).toThrow("source part drift");
    f.report.objects[0]!.evidence[0]!.anchorSha256 = "bad";
    expect(() => indexSourceReports([f.report], [f.batch], () => f.body)).toThrow("citation drift");
  });
  it("counts complete interval coverage, not a single citation or overlapping part", () => {
    const batches = [
      { id: "a", parts: [{ chapter_id: "c", start: 0, end: 8, sha256: "a" }] },
      { id: "b", parts: [{ chapter_id: "c", start: 4, end: 8, sha256: "b" }] },
      { id: "c", parts: [{ chapter_id: "c", start: 8, end: 12, sha256: "c" }] },
    ];
    expect(fullyExtractedChapters(batches, ["a", "b"], [{ id: "c", characters: 12 }]).size).toBe(0);
    expect([...fullyExtractedChapters(batches, ["a", "c"], [{ id: "c", characters: 12 }])]).toEqual(["c"]);
    expect(fullyExtractedChapters(batches, ["b", "c"], [{ id: "c", characters: 12 }]).size).toBe(0);
  });
});
