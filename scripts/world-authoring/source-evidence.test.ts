import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { buildSourceAdjudicationEvidence, buildSourceReadingEvidence } from "./source-evidence";

function fixture() {
  const body = "村医陈伯保存旧药方。\n";
  const batch = { id: "batch-0001", parts: [{ chapter_id: "chapter-a", start: 0, end: [...body].length, sha256: contentHash(body) }] };
  const audit = (pass: string) => ({ subjectId: batch.id, profileId: "profile", modelId: "model", modelMetadataHash: "metadata",
    modelCatalogHash: "catalog", promptVersion: "policy-v1", invocations: [{ requestHash: contentHash(pass), responseHash: "response",
      rawOutputHash: "output", resultKind: null, context: { sections: { paragraphs: { itemCount: 1, utf8Bytes: 80 } } } }] });
  const report = { batchId: batch.id, chapters: ["chapter-a"], approvedForRuntime: false, policyHash: "policy", schemaHash: "schema",
    identity: contentHash({ parts: batch.parts, policyHash: "policy", schemaHash: "schema", profileId: "profile", catalogHash: "catalog" }),
    audits: [audit("extract"), audit("review")],
    objects: [{ id: `${batch.id}-object-1`, label: "陈伯", aliases: ["村医"], kind: "person", status: "machine-reviewed-needs-adjudication",
      evidence: [{ chapterId: "chapter-a", paragraphId: "chapter-a:0", paragraphSha256: contentHash(body.trim()), start: 2, end: 4, anchorSha256: contentHash("陈伯") }] }],
    facts: [], issues: [] };
  const adjudication = { batchId: batch.id, chapters: report.chapters, identity: contentHash({ parts: batch.parts, sourceReportHash: contentHash(report),
    policyHash: "audit-policy", schemaHash: "audit-schema", profileId: "profile", catalogHash: "catalog" }),
    sourceReportHash: contentHash(report), sourceParts: batch.parts, policyHash: "audit-policy", schemaHash: "audit-schema",
    status: "source-semantic-review-not-runtime-approval", approvedForRuntime: false,
    records: [{ id: `${batch.id}-object-1`, verdict: "supported", evidence: structuredClone(report.objects[0]!.evidence) }],
    aliases: [{ objectId: `${batch.id}-object-1`, alias: "村医", verdict: "ambiguous", evidence: [] }], issues: [],
    omissions: [{ subject: "药方", evidence: structuredClone(report.objects[0]!.evidence) }], identities: [], audits: [audit("semantic")] };
  return { body, batch, report, adjudication };
}

describe("evidence-level source coverage", () => {
  it("binds full input ranges and distinct model passes without granting canon approval", () => {
    const f = fixture(), result = buildSourceReadingEvidence(f.report, f.batch, () => f.body);
    expect(result.status).toBe("complete-source-input-processed");
    expect(result.source.characters).toBe([...f.body].length);
    expect(result.source.paragraphs).toBe(1);
    expect(result.passes.map(pass => pass.invocations[0]?.requestHash)).toEqual([contentHash("extract"), contentHash("review")]);
    expect(result.reportHash).toBe(contentHash(f.report));
    expect(result.approvedForRuntime).toBe(false);
    expect(result).not.toHaveProperty("reviewed");
    expect(result).not.toHaveProperty("read");
  });

  it("rejects reduced source context, duplicated pass evidence, and stale chapter bytes", () => {
    const f = fixture();
    f.report.audits[1]!.invocations[0]!.context.sections.paragraphs.itemCount = 0;
    expect(() => buildSourceReadingEvidence(f.report, f.batch, () => f.body)).toThrow("complete source input");
    const same = fixture();
    same.report.audits[1] = same.report.audits[0]!;
    expect(() => buildSourceReadingEvidence(same.report, same.batch, () => same.body)).toThrow("distinct");
    expect(() => buildSourceReadingEvidence(same.report, same.batch, () => `改${same.body}`)).toThrow("source part drift");
  });

  it("retains residual semantic problems and refuses source-report or coverage drift", () => {
    const f = fixture();
    const result = buildSourceAdjudicationEvidence(f.adjudication, f.report, f.batch, () => f.body);
    expect(result.residual).toEqual({ unresolvedAliases: 1, unresolvedIssues: 0, omissions: 1, unresolvedIdentities: 0 });
    expect(result.approvedForRuntime).toBe(false);
    f.adjudication.sourceReportHash = "stale";
    expect(() => buildSourceAdjudicationEvidence(f.adjudication, f.report, f.batch, () => f.body)).toThrow("stale");
    const missing = fixture();
    missing.adjudication.aliases = [];
    expect(() => buildSourceAdjudicationEvidence(missing.adjudication, missing.report, missing.batch, () => missing.body)).toThrow("coverage mismatch");
  });

  it("rechecks persisted semantic evidence against the actual source characters", () => {
    const f = fixture();
    f.adjudication.records[0]!.evidence[0]!.anchorSha256 = contentHash("韩立");
    expect(() => buildSourceAdjudicationEvidence(f.adjudication, f.report, f.batch, () => f.body)).toThrow("citation drift");
    const absent = fixture();
    absent.adjudication.records[0]!.evidence = [];
    expect(() => buildSourceAdjudicationEvidence(absent.adjudication, absent.report, absent.batch, () => absent.body)).toThrow("lacks source evidence");
  });
});
