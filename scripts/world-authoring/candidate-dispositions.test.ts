import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { validateCandidateDispositions } from "./candidate-dispositions";

function fixture() {
  const source = "甲说乙未曾来过。\r\n丙后来抵达。";
  const extraction = { batchId: "batch-1", objects: [], facts: [{ id: "fact-1", evidence: [{ chapterId: "ch-1" }] }], issues: [] };
  const hash = contentHash(extraction);
  const queue = { inputHash: contentHash("queue"), moduleId: "region", candidates: [{ id: "fact-1", kind: "fact", batchId: "batch-1", reportHash: hash }] };
  const input = { formatVersion: 1, moduleId: "region", queueInputHash: queue.inputHash,
    status: "editorial-dispositions-not-release-approval", reviewer: "editor",
    records: [{ candidateId: "fact-1", batchId: "batch-1", reportHash: hash, disposition: "corrected",
      targetIds: ["claim-1"], reason: "Distinguish the speaker from the subject.",
      evidence: [{ chapterId: "ch-1", chapterSha256: contentHash(source), start: 0, end: source.length, anchorSha256: contentHash(source) }],
      uncertainty: null as null | { kind: string; boundary: string }, destinationModule: null as string | null }] };
  const context = { reports: new Map<string, unknown>([["batch-1", extraction]]), targetIds: new Set(["claim-1", "other-region"]), readChapter: () => source };
  return { input, queue, context };
}

describe("candidate editorial dispositions", () => {
  it("validates a complete source-bound queue without approving runtime", () => {
    const f = fixture(); expect(validateCandidateDispositions(f.input, f.queue, f.context)).toMatchObject({ completed: 1, unresolved: 0, approvedForRuntime: false });
  });
  it("rejects missing, duplicate, unexpected and mismatched candidates", () => {
    const f = fixture();
    expect(() => validateCandidateDispositions({ ...f.input, records: [] }, f.queue, f.context)).toThrow("missing candidate");
    expect(() => validateCandidateDispositions({ ...f.input, records: [...f.input.records, ...f.input.records] }, f.queue, f.context)).toThrow("duplicate disposition");
    f.input.records[0].candidateId = "extra";
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("unexpected candidate");
    f.input.records[0].candidateId = "fact-1"; f.input.records[0].batchId = "batch-2";
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("candidate reference drift");
  });
  it("rejects queue, extraction, source and newline-normalization drift", () => {
    const f = fixture();
    expect(() => validateCandidateDispositions({ ...f.input, queueInputHash: contentHash("new") }, f.queue, f.context)).toThrow("queue fingerprint");
    expect(() => validateCandidateDispositions(f.input, f.queue, { ...f.context, reports: new Map() })).toThrow("extraction report drift");
    expect(() => validateCandidateDispositions(f.input, f.queue, { ...f.context, readChapter: () => f.context.readChapter().replaceAll("\r\n", "\n") })).toThrow("source anchor drift");
    f.input.records[0].evidence[0].start = 1;
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("source anchor drift");
  });
  it("does not count transfer or missing evidence as completed", () => {
    const f = fixture(); const row = f.input.records[0];
    row.disposition = "transferred"; row.destinationModule = "other-region";
    expect(validateCandidateDispositions(f.input, f.queue, f.context)).toMatchObject({ completed: 0, unresolved: 1 });
    row.disposition = "pending"; row.destinationModule = null; row.uncertainty = { kind: "missing-evidence", boundary: "Need the earlier birth date." };
    expect(validateCandidateDispositions(f.input, f.queue, f.context)).toMatchObject({ completed: 0 });
    row.disposition = "bounded-uncertainty";
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("unbounded uncertainty");
    row.uncertainty = { kind: "source-underdetermined", boundary: "The narration deliberately does not establish the original disguise owner." };
    expect(validateCandidateDispositions(f.input, f.queue, f.context)).toMatchObject({ completed: 1, boundedUncertainty: 1, approvedForRuntime: false });
  });
  it("requires existing targets and a non-self transfer destination", () => {
    const f = fixture(); f.input.records[0].targetIds = ["invented"];
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("unknown editorial target");
    f.input.records[0].targetIds = [];
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("missing editorial target");
  });
});
