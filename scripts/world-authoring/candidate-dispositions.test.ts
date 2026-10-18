import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { candidateEditorialTargets, validateCandidateDispositions } from "./candidate-dispositions";

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

function unanchoredIssueFixture() {
  const f = fixture();
  const extraction = { batchId: "batch-1", chapters: ["ch-1"], objects: [], facts: [],
    issues: [{ id: "issue-1", description: "Opening applicability is not directly stated.", evidence: [] }] };
  const hash = contentHash(extraction);
  f.context.reports.set("batch-1", extraction);
  f.queue.candidates = [{ id: "issue-1", kind: "issue", batchId: "batch-1", reportHash: hash }];
  const row = { ...f.input.records[0], candidateId: "issue-1", reportHash: hash,
    evidenceRepair: { kind: "unanchored-issue-context", reason: "Read the batch's original chronology passage and retain the original empty citation list." } };
  return { ...f, extraction, input: { ...f.input, records: [row] } };
}

describe("candidate editorial dispositions", () => {
  it("resolves base identities without admitting facts or laws as editorial targets", () => {
    const targets = candidateEditorialTargets({ id: "opening", template: { entities: [{ id: "han", facts: [{ id: "own-rank" }] }] } }, [{ id: "opening-night" }],
      [{ id: "north", module: { entities: [{ id: "person" }], laws: [{ id: "law" }] }, claims: [{ id: "claim" }], subjects: [{ id: "historical-person" }] }]);
    expect([...targets]).toEqual(["opening", "han", "opening-night", "north", "person", "claim", "historical-person"]);
    expect(targets.has("own-rank")).toBe(false); expect(targets.has("law")).toBe(false);
  });
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
  it("accepts an explicit source-bound repair for an originally unanchored issue without changing the extraction", () => {
    const f = unanchoredIssueFixture(); const before = contentHash(f.extraction);
    expect(validateCandidateDispositions(f.input, f.queue, f.context)).toMatchObject({ completed: 1, approvedForRuntime: false });
    expect(contentHash(f.extraction)).toBe(before);
    expect(f.extraction.issues[0].evidence).toEqual([]);
  });
  it("requires the repair annotation and rejects out-of-batch replacement anchors", () => {
    const f = unanchoredIssueFixture();
    const { evidenceRepair: omitted, ...row } = f.input.records[0];
    expect(omitted.kind).toBe("unanchored-issue-context");
    expect(() => validateCandidateDispositions({ ...f.input, records: [row] }, f.queue, f.context)).toThrow("missing candidate source context");
    f.input.records[0].evidence.push({ ...row.evidence[0], chapterId: "unrelated-chapter" });
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("invalid unanchored issue repair");
  });
  it("does not use issue repair to bypass existing citations or repair object and fact evidence", () => {
    const f = fixture();
    const evidenceRepair = { kind: "unanchored-issue-context", reason: "Invalid attempt to replace source evidence." };
    expect(() => validateCandidateDispositions({ ...f.input, records: [{ ...f.input.records[0], evidenceRepair }] }, f.queue, f.context)).toThrow("invalid unanchored issue repair");
    const issue = unanchoredIssueFixture();
    const extraction = { ...issue.extraction, issues: [{ ...issue.extraction.issues[0], evidence: [{ chapterId: "ch-1" }] }] };
    const hash = contentHash(extraction);
    issue.context.reports.set("batch-1", extraction); issue.queue.candidates[0].reportHash = hash; issue.input.records[0].reportHash = hash;
    expect(() => validateCandidateDispositions(issue.input, issue.queue, issue.context)).toThrow("invalid unanchored issue repair");
  });
  it("still rejects empty or corrupted replacement evidence", () => {
    const f = unanchoredIssueFixture(); const row = f.input.records[0];
    expect(() => validateCandidateDispositions({ ...f.input, records: [{ ...row, evidence: [] }] }, f.queue, f.context)).toThrow();
    row.evidence[0].anchorSha256 = contentHash("fabricated");
    expect(() => validateCandidateDispositions(f.input, f.queue, f.context)).toThrow("source anchor drift");
  });
});
