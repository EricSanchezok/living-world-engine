import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { buildSourceClosure, validateSourceClosure, type SourceClosureContext } from "./source-closure";
import { assertFullSourceClosure, loadSourceClosureContext } from "./source-closure-files";

function fixture() {
  const body = "村医陈伯保存旧药方。😀\n", chapter = "qq-1", candidate = "batch-0001-object-1";
  const batch = { id: "batch-0001", parts: [{ chapter_id: chapter, start: 0, end: [...body].length, sha256: contentHash(body) }] };
  const audit = (pass: string) => ({ subjectId: batch.id, profileId: "profile", modelId: "model", modelMetadataHash: "metadata",
    modelCatalogHash: "catalog", promptVersion: "policy-v1", invocations: [{ requestHash: contentHash(pass), responseHash: "response",
      rawOutputHash: "output", resultKind: null, context: { sections: { paragraphs: { itemCount: 1, utf8Bytes: 80 } } } }] });
  const sourceRef = { chapterId: chapter, paragraphId: `${chapter}:0`, paragraphSha256: contentHash(body.trim()), start: 2, end: 4, anchorSha256: contentHash("陈伯") };
  const report = { batchId: batch.id, chapters: [chapter], approvedForRuntime: false, policyHash: "policy", schemaHash: "schema",
    identity: contentHash({ parts: batch.parts, policyHash: "policy", schemaHash: "schema", profileId: "profile", catalogHash: "catalog" }),
    audits: [audit("extract"), audit("review")], objects: [{ id: candidate, label: "陈伯", aliases: ["村医"], kind: "person",
      status: "machine-reviewed-needs-adjudication", evidence: [sourceRef] }], facts: [], issues: [] };
  const finding = { objectId: candidate, alias: "村医", verdict: "ambiguous", evidence: [sourceRef] };
  const adjudication = { batchId: batch.id, chapters: report.chapters, identity: contentHash({ parts: batch.parts, sourceReportHash: contentHash(report),
    policyHash: "audit-policy", schemaHash: "audit-schema", profileId: "profile", catalogHash: "catalog" }),
    sourceReportHash: contentHash(report), sourceParts: batch.parts, policyHash: "audit-policy", schemaHash: "audit-schema",
    status: "source-semantic-review-not-runtime-approval", approvedForRuntime: false,
    records: [{ id: candidate, verdict: "supported", evidence: [sourceRef] }], aliases: [finding], issues: [], omissions: [], identities: [], audits: [audit("semantic")] };
  const anchor = { chapterId: chapter, chapterSha256: contentHash(body), start: 0, end: [...body].length, anchorSha256: contentHash(body) };
  const records = [{ id: "alias-review-1", batchId: batch.id, sourceReportHash: contentHash(report), adjudicationReportHash: contentHash(adjudication),
    findingHash: contentHash(finding), candidateId: candidate, status: "source-semantics-resolved", disposition: "same-referent",
    statement: "该句村医陈伯明确是同一人。", evidence: [anchor] }];
  const queue = { moduleId: "global-candidate-closure", inputHash: contentHash("queue"), candidates: [{ id: candidate, kind: "object", batchId: batch.id, reportHash: contentHash(report) }] };
  const disposition = { formatVersion: 1, moduleId: queue.moduleId, queueInputHash: queue.inputHash, status: "editorial-dispositions-not-release-approval",
    reviewer: "editor", records: [{ candidateId: candidate, batchId: batch.id, reportHash: contentHash(report), disposition: "adopted", targetIds: ["canon-doctor"],
      reason: "同一正文身份已由当地人物档案承接。", evidence: [anchor], uncertainty: null, destinationModule: null }] };
  const context: SourceClosureContext = { chapters: [{ id: chapter, characters: [...body].length, sha256: contentHash(body) }], batches: [batch],
    extractions: new Map([[batch.id, report]]), adjudications: new Map([[batch.id, adjudication]]), readChapter: () => body,
    resolutions: [{ path: "resolutions.json", report: { records, recordsHash: contentHash(records) } }],
    dispositions: [{ path: "global.json", report: disposition, queue }], targetIds: new Set(["canon-doctor"]) };
  return { context, report, adjudication, records, disposition, queue, body };
}

describe("full source and candidate closure", () => {
  it("refuses vacuous completeness from empty source inventories", () => {
    const f = fixture(); f.context.chapters = []; f.context.batches = [];
    expect(() => buildSourceClosure(f.context)).toThrow("nonempty");
  });

  it("pins the actual queue and manifest even when a queue edit leaves every candidate unchanged", () => {
    const f = fixture();
    f.context.inputArtifacts = [{ path: "manifest.json", value: [{ report: "global.json", queue: "queue.json" }] }];
    const saved = buildSourceClosure(f.context);
    f.context.dispositions[0]!.queue = { ...f.queue, reviewNote: "a changed queue annotation" } as typeof f.queue;
    expect(() => validateSourceClosure(saved, f.context)).toThrow("evidence drift");
    f.context.dispositions[0]!.queue = f.queue;
    f.context.inputArtifacts[0]!.value = [];
    expect(() => validateSourceClosure(saved, f.context)).toThrow("evidence drift");
  });

  it("loads the full-build gate from files and rejects missing, incomplete and stale evidence", () => {
    const folder = mkdtempSync(path.join(tmpdir(), "fanren-source-closure-"));
    const root = path.join(folder, "authoring"), sourceCache = path.join(folder, "cache"), f = fixture();
    const save = (file: string, value: unknown) => {
      mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value));
    };
    try {
      expect(() => assertFullSourceClosure({ root, sourceCache })).toThrow("requires the source closure report");
      mkdirSync(path.join(root, "regions"), { recursive: true });
      save(path.join(root, "modules/opening-sample.json"), { id: "sample", template: { entities: [{ id: "canon-doctor" }] } });
      save(path.join(root, "claims/opening-sample.json"), []);
      save(path.join(root, "coverage/batches.json"), f.context.batches);
      save(path.join(root, "coverage/chapters.jsonl"), f.context.chapters[0]);
      mkdirSync(path.join(sourceCache, "chapters"), { recursive: true });
      writeFileSync(path.join(sourceCache, "chapters/qq-1.txt"), f.body);
      save(path.join(root, "extractions/batch-0001.json"), f.report);
      save(path.join(root, "adjudications/batch-0001.json"), f.adjudication);
      save(path.join(root, "reviews/source-test-resolutions.json"), f.context.resolutions[0]!.report);
      const report = path.join(root, "coverage/source-closure.json"), globalManifest = path.join(root, "reviews/global-candidate-manifest.json");
      save(globalManifest, []);
      save(report, buildSourceClosure(loadSourceClosureContext({ root, sourceCache, globalManifest })));
      expect(() => assertFullSourceClosure({ root, sourceCache })).toThrow("complete source, semantic and candidate");
      const queuePath = path.join(root, "reviews/global.queue.json"), dispositionPath = path.join(root, "reviews/global.json");
      save(queuePath, f.queue); save(dispositionPath, f.disposition);
      const proofPath = path.join(root, "reviews/global.proofs.json"), proof = { candidateId: "batch-0001-object-1", sourceReportHash: contentHash(f.report) };
      const manifest = [{ report: dispositionPath, queue: queuePath, proofs: [{ path: proofPath, contentHash: contentHash(proof) }] }];
      save(proofPath, proof); save(globalManifest, manifest);
      save(report, buildSourceClosure(loadSourceClosureContext({ root, sourceCache, globalManifest })));
      expect(assertFullSourceClosure({ root, sourceCache }).passed).toBe(true);
      const changedProof = { ...proof, reviewNote: "changed proof evidence" };
      save(proofPath, changedProof);
      expect(() => assertFullSourceClosure({ root, sourceCache })).toThrow("global proof fingerprint drift");
      save(globalManifest, [{ ...manifest[0]!, proofs: [{ path: proofPath, contentHash: contentHash(changedProof) }] }]);
      expect(() => assertFullSourceClosure({ root, sourceCache })).toThrow("evidence drift");
      save(proofPath, proof); save(globalManifest, manifest);
      save(queuePath, { ...f.queue, reviewNote: "a later revision" });
      expect(() => assertFullSourceClosure({ root, sourceCache })).toThrow("evidence drift");
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it("recomputes all three evidence layers without granting runtime approval", () => {
    const f = fixture(), result = buildSourceClosure(f.context);
    expect(result.sourceComplete).toBe(true);
    expect(result.semanticComplete).toBe(true);
    expect(result.candidateComplete).toBe(true);
    expect(result.counts).toMatchObject({ chapters: 1, verifiedBatches: 1, candidates: 1, findings: 1, resolvedFindings: 1 });
    expect(validateSourceClosure(result, f.context).passed).toBe(true);
    expect(result.approvedForRuntime).toBe(false);
    expect(result).not.toHaveProperty("read");
    expect(result).not.toHaveProperty("reviewed");
  });

  it("does not treat supported model judgments as editorial routing or residual closure", () => {
    const f = fixture(); f.context.resolutions = []; f.context.dispositions = [];
    const result = buildSourceClosure(f.context);
    expect(result.sourceComplete).toBe(true);
    expect(result.semanticComplete).toBe(false);
    expect(result.candidateComplete).toBe(false);
    expect(result.residual.unresolvedFindings).toHaveLength(1);
    expect(result.residual.unassignedCandidates).toHaveLength(1);
    expect(validateSourceClosure(result, f.context).passed).toBe(false);
  });

  it("rejects stale source, report, finding, and codepoint evidence", () => {
    const bytes = fixture(); bytes.context.readChapter = () => `${bytes.body}x`;
    expect(() => buildSourceClosure(bytes.context)).toThrow("chapter baseline drift");
    for (const field of ["sourceReportHash", "adjudicationReportHash", "findingHash"] as const) {
      const f = fixture(); f.records[0]![field] = contentHash("changed");
      f.context.resolutions[0]!.report = { records: f.records, recordsHash: contentHash(f.records) };
      expect(() => buildSourceClosure(f.context)).toThrow("unknown or stale");
    }
    const offset = fixture(); offset.records[0]!.evidence[0]!.end++;
    offset.context.resolutions[0]!.report = { records: offset.records, recordsHash: contentHash(offset.records) };
    expect(() => buildSourceClosure(offset.context)).toThrow("anchor drift");
  });

  it("refuses duplicated chapters, overlapping inputs and unknown targets", () => {
    const f = fixture(); f.context.chapters.push(f.context.chapters[0]!);
    expect(() => buildSourceClosure(f.context)).toThrow("duplicate source chapter");
    const overlap = fixture(); overlap.context.batches.push({ id: "extra", parts: overlap.context.batches[0]!.parts });
    expect(() => buildSourceClosure(overlap.context)).toThrow("overlapping source input");
    const target = fixture(); target.context.targetIds = new Set();
    expect(() => buildSourceClosure(target.context)).toThrow("unknown editorial target");
  });

  it("does not close transferred or pending candidates, and rejects saved flag forgery", () => {
    const f = fixture(); f.disposition.records[0]!.disposition = "pending";
    const result = buildSourceClosure(f.context);
    expect(result.candidateComplete).toBe(false);
    expect(result.residual.pendingDispositions).toHaveLength(1);
    expect(() => validateSourceClosure({ ...result, candidateComplete: true }, f.context)).toThrow("evidence drift");
  });

  it("requires both passes and a report for every complete source batch", () => {
    const f = fixture(); f.context.adjudications = new Map(); f.context.resolutions = [];
    const result = buildSourceClosure(f.context);
    expect(result.sourceComplete).toBe(false);
    expect(result.residual.missingAdjudications).toEqual(["batch-0001"]);
    const same = fixture(); same.report.audits[1] = same.report.audits[0]!;
    expect(() => buildSourceClosure(same.context)).toThrow("distinct");
  });

  it("checks the exact reused claim instead of trusting an existing target name", () => {
    const f = fixture(), claim = { id: "canon-doctor", statement: "这是同一村医。" };
    const records = f.records.map(row => ({ ...row, reusedEditorialEvidence: [{ path: "claims.json", claimId: claim.id, claimHash: contentHash(claim) }] }));
    f.context.resolutions[0]!.report = { records, recordsHash: contentHash(records) };
    f.context.readArtifact = () => [claim];
    expect(buildSourceClosure(f.context).semanticComplete).toBe(true);
    f.context.readArtifact = () => [{ ...claim, statement: "改过而未复签。" }];
    expect(() => buildSourceClosure(f.context)).toThrow("referenced row drift");
  });

  it("refuses evidence-free lore even when the editor labels its disposition as metadata", () => {
    const f = fixture();
    const records = f.records.map(row => ({ ...row, disposition: "authoring-metadata-not-lore", validAtOpening: false, evidence: [] }));
    f.context.resolutions[0]!.report = { records, recordsHash: contentHash(records) };
    expect(() => buildSourceClosure(f.context)).toThrow("unjustified evidence-free");
  });
});
