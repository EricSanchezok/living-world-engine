import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { indexSourceReports, indexableReport, type ReadingBatch } from "./authoring-index";

const auditSchema = z.object({
  subjectId: z.string(), profileId: z.string(), modelId: z.string(), modelMetadataHash: z.string(),
  modelCatalogHash: z.string(), promptVersion: z.string(),
  invocations: z.array(z.object({
    requestHash: z.string(), responseHash: z.string().nullable().optional(),
    rawOutputHash: z.string().nullable().optional(), resultKind: z.string().nullable(),
    context: z.object({ sections: z.object({ paragraphs: z.object({ itemCount: z.number().int(), utf8Bytes: z.number().int() }) }) }),
  }).passthrough()).min(1),
}).passthrough();

function sourceInput(batch: ReadingBatch, readChapter: (id: string) => string) {
  const paragraphs: Array<{ id: string; start: number; end: number; sha256: string }> = [];
  let characters = 0;
  for (const part of batch.parts) {
    const excerpt = [...readChapter(part.chapter_id)].slice(part.start, part.end).join("");
    if (contentHash(excerpt) !== part.sha256) throw new Error(`source evidence part drift ${part.chapter_id}`);
    characters += [...excerpt].length;
    let offset = part.start;
    for (const line of excerpt.split("\n")) {
      const end = offset + [...line].length;
      if (line.trim()) paragraphs.push({ id: `${part.chapter_id}:${offset}`, start: offset, end, sha256: contentHash(line) });
      offset = end + 1;
    }
  }
  return { characters, paragraphs: paragraphs.length, paragraphSetHash: contentHash(paragraphs) };
}

function auditedPasses(audits: unknown[], batch: ReadingBatch, paragraphCount: number) {
  return audits.map((input, index) => {
    const audit = auditSchema.parse(input);
    if (audit.subjectId !== batch.id || audit.invocations.some(invocation => invocation.context.sections.paragraphs.itemCount !== paragraphCount)) {
      throw new Error(`model audit does not cover the complete source input ${batch.id}`);
    }
    return { ordinal: index + 1, auditHash: contentHash(input), profileId: audit.profileId, modelId: audit.modelId,
      modelMetadataHash: audit.modelMetadataHash, modelCatalogHash: audit.modelCatalogHash, promptVersion: audit.promptVersion,
      invocations: audit.invocations.map(invocation => ({ requestHash: invocation.requestHash,
        responseHash: invocation.responseHash ?? null, rawOutputHash: invocation.rawOutputHash ?? null,
        resultKind: invocation.resultKind, sourceParagraphs: invocation.context.sections.paragraphs.itemCount,
        sourceContextUtf8Bytes: invocation.context.sections.paragraphs.utf8Bytes })) };
  });
}

/** Complete submitted input is observable; model attention and final canon are not. */
export function buildSourceReadingEvidence(input: unknown, batch: ReadingBatch, readChapter: (id: string) => string) {
  indexSourceReports([input], [batch], readChapter);
  const report = indexableReport.parse(input), source = sourceInput(batch, readChapter);
  const rawAudits = z.object({ audits: z.array(z.unknown()) }).parse(input).audits;
  const passes = auditedPasses(rawAudits, batch, source.paragraphs);
  if (passes.length < 2 || passes[0]!.invocations[0]!.requestHash === passes[1]!.invocations[0]!.requestHash) {
    throw new Error("source reading requires distinct extraction and source-review requests");
  }
  return { batchId: batch.id, status: "complete-source-input-processed" as const,
    sourceParts: structuredClone(batch.parts), source, reportHash: contentHash(input),
    policyHash: report.policyHash, schemaHash: report.schemaHash, passes,
    residualSourceIssues: report.issues.length, approvedForRuntime: false as const,
    interpretation: "完整输入经模型处理并形成可定位资料；不等于人工通读、语义正确或开篇设定审定。" };
}

const sourceRef = z.object({ chapterId: z.string(), paragraphId: z.string(), paragraphSha256: z.string(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), anchorSha256: z.string() });
const cited = z.object({ evidence: z.array(sourceRef) }).passthrough();
const adjudicationReportSchema = z.object({
  batchId: z.string(), identity: z.string(), sourceReportHash: z.string(),
  chapters: z.array(z.string()),
  sourceParts: z.array(z.record(z.string(), z.unknown())), policyHash: z.string(), schemaHash: z.string(),
  status: z.literal("source-semantic-review-not-runtime-approval"), approvedForRuntime: z.literal(false),
  records: z.array(cited.extend({ id: z.string(), verdict: z.enum(["supported", "unsupported", "ambiguous"]) })),
  aliases: z.array(cited.extend({ objectId: z.string(), alias: z.string(), verdict: z.enum(["supported", "unsupported", "ambiguous"]) })),
  issues: z.array(cited.extend({ id: z.string(), status: z.enum(["resolved-in-this-batch", "needs-cross-batch", "still-open"]) })),
  omissions: z.array(cited), identities: z.array(cited.extend({ relation: z.enum(["same-entity", "distinct-entity", "unresolved"]) })),
  audits: z.array(z.unknown()).min(1),
}).passthrough();

function sameIds(actual: string[], expected: string[]) {
  return actual.length === new Set(actual).size && [...actual].sort().join("\0") === [...expected].sort().join("\0");
}

export function buildSourceAdjudicationEvidence(input: unknown, sourceReport: unknown, batch: ReadingBatch, readChapter: (id: string) => string) {
  const reading = buildSourceReadingEvidence(sourceReport, batch, readChapter);
  const source = indexableReport.parse(sourceReport), report = adjudicationReportSchema.parse(input);
  if (report.batchId !== batch.id || report.sourceReportHash !== reading.reportHash ||
    contentHash(report.sourceParts) !== contentHash(batch.parts)) throw new Error("stale source adjudication evidence");
  if (!sameIds(report.chapters, source.chapters) ||
    !sameIds(report.records.map(record => record.id), [...source.objects, ...source.facts].map(record => record.id)) ||
    !sameIds(report.aliases.map(alias => `${alias.objectId}\0${alias.alias}`), source.objects.flatMap(object => object.aliases.map(alias => `${object.id}\0${alias}`))) ||
    !sameIds(report.issues.map(issue => issue.id), source.issues.map(issue => issue.id))) throw new Error("source adjudication evidence coverage mismatch");
  for (const record of [...report.records, ...report.aliases]) {
    if (record.verdict === "supported" && !record.evidence.length) throw new Error("supported adjudication lacks source evidence");
  }
  for (const record of [...report.records, ...report.aliases, ...report.issues, ...report.omissions, ...report.identities]) {
    for (const citation of record.evidence) {
      const part = batch.parts.find(part => part.chapter_id === citation.chapterId && part.start <= citation.start && part.end >= citation.end);
      if (!part) throw new Error("adjudication citation outside source input");
      const chars = [...readChapter(citation.chapterId)], start = Number(citation.paragraphId.slice(citation.chapterId.length + 1));
      const newline = chars.indexOf("\n", start), end = newline < 0 ? chars.length : newline;
      if (!citation.paragraphId.startsWith(`${citation.chapterId}:`) || !Number.isSafeInteger(start) || start < part.start ||
        citation.start < start || citation.end <= citation.start || citation.end > end ||
        contentHash(chars.slice(start, end).join("")) !== citation.paragraphSha256 ||
        contentHash(chars.slice(citation.start, citation.end).join("")) !== citation.anchorSha256) throw new Error("adjudication source citation drift");
    }
  }
  const passes = auditedPasses(report.audits, batch, reading.source.paragraphs);
  const first = auditSchema.parse(report.audits[0]);
  const expected = contentHash({ parts: batch.parts, sourceReportHash: reading.reportHash, policyHash: report.policyHash,
    schemaHash: report.schemaHash, profileId: first.profileId, catalogHash: first.modelCatalogHash });
  if (report.identity !== expected) throw new Error("source adjudication identity drift");
  return { batchId: batch.id, status: "source-semantic-evidence-produced" as const,
    sourceParts: structuredClone(batch.parts), source: reading.source, sourceReportHash: reading.reportHash,
    adjudicationReportHash: contentHash(input), policyHash: report.policyHash, schemaHash: report.schemaHash, passes,
    judgments: { supported: report.records.filter(record => record.verdict === "supported").length,
      unsupported: report.records.filter(record => record.verdict === "unsupported").length,
      ambiguous: report.records.filter(record => record.verdict === "ambiguous").length },
    residual: { unresolvedAliases: report.aliases.filter(alias => alias.verdict !== "supported").length,
      unresolvedIssues: report.issues.filter(issue => issue.status !== "resolved-in-this-batch").length, omissions: report.omissions.length,
      unresolvedIdentities: report.identities.filter(identity => identity.relation === "unresolved").length },
    approvedForRuntime: false as const };
}
