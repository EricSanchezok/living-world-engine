import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";

const ref = z.object({ chapterId: z.string(), paragraphId: z.string(), paragraphSha256: z.string(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(), anchorSha256: z.string() });
const record = z.object({ id: z.string(), evidence: z.array(ref), status: z.literal("machine-reviewed-needs-adjudication") });
export const indexableReport = z.object({ batchId: z.string(), chapters: z.array(z.string()), approvedForRuntime: z.literal(false),
  identity: z.string(), policyHash: z.string(), schemaHash: z.string(),
  objects: z.array(record.extend({ label: z.string(), kind: z.string(), aliases: z.array(z.string()), evidence: z.array(ref).min(1) })),
  facts: z.array(record.extend({ subject: z.string(), related: z.array(z.string()), opening: z.string(), evidence: z.array(ref).min(1) })),
  issues: z.array(record.extend({ subject: z.string() })),
  audits: z.array(z.object({ profileId: z.string(), modelCatalogHash: z.string() })).min(2),
}).passthrough();
export interface ReadingBatch { id: string; parts: Array<{ chapter_id: string; start: number; end: number; sha256: string }> }

/** Index candidates without turning matching names or citation matches into canon. */
export function indexSourceReports(inputs: unknown[], batches: ReadingBatch[], readChapter: (id: string) => string) {
  const sourceCache = new Map<string, string[]>();
  const source = (id: string) => {
    if (!sourceCache.has(id)) sourceCache.set(id, [...readChapter(id)]);
    return sourceCache.get(id)!;
  };
  const batchMap = new Map(batches.map(batch => [batch.id, batch]));
  const seen = new Set<string>(), acceptedBatches = new Set<string>();
  const names = new Map<string, Set<string>>();
  const subjects: Array<{ id: string; batchId: string; reportHash: string; label: string; kind: string; canonicalId: null; status: string }> = [];
  const facts: Array<{ id: string; batchId: string; reportHash: string; names: string[]; opening: string; status: string }> = [];
  const issues: Array<{ id: string; batchId: string; reportHash: string; subject: string }> = [];
  for (const input of inputs) {
    const report = indexableReport.parse(input), batch = batchMap.get(report.batchId);
    if (!batch || acceptedBatches.has(batch.id)) throw new Error(`unknown or duplicate report batch ${report.batchId}`);
    const expected = contentHash({ parts: batch.parts, policyHash: report.policyHash, schemaHash: report.schemaHash,
      profileId: report.audits[0]!.profileId, catalogHash: report.audits[0]!.modelCatalogHash });
    if (report.identity !== expected || [...new Set(batch.parts.map(part => part.chapter_id))].sort().join("|") !== [...report.chapters].sort().join("|")) {
      throw new Error(`source identity drift ${report.batchId}`);
    }
    for (const part of batch.parts) if (contentHash(source(part.chapter_id).slice(part.start, part.end).join("")) !== part.sha256) {
      throw new Error(`source part drift ${part.chapter_id}`);
    }
    const reportHash = contentHash(input);
    for (const item of [...report.objects, ...report.facts, ...report.issues]) {
      if (seen.has(item.id) || !item.id.startsWith(`${batch.id}-`)) throw new Error(`invalid candidate identity ${item.id}`);
      seen.add(item.id);
      for (const citation of item.evidence) {
        if (!batch.parts.some(part => part.chapter_id === citation.chapterId)) throw new Error(`citation outside batch ${item.id}`);
        const chars = source(citation.chapterId), paragraphStart = Number(citation.paragraphId.slice(citation.chapterId.length + 1));
        const paragraphEnd = chars.indexOf("\n", paragraphStart);
        const paragraph = chars.slice(paragraphStart, paragraphEnd < 0 ? chars.length : paragraphEnd).join("");
        if (!citation.paragraphId.startsWith(`${citation.chapterId}:`) || !Number.isSafeInteger(paragraphStart) || paragraphStart < 0 ||
          citation.start < paragraphStart || citation.end <= citation.start || citation.end > (paragraphEnd < 0 ? chars.length : paragraphEnd) ||
          !batch.parts.some(part => part.chapter_id === citation.chapterId && part.start <= citation.start && part.end >= citation.end) ||
          contentHash(paragraph) !== citation.paragraphSha256 || contentHash(chars.slice(citation.start, citation.end).join("")) !== citation.anchorSha256) {
          throw new Error(`citation drift ${item.id}`);
        }
      }
    }
    for (const object of report.objects) {
      subjects.push({ id: object.id, batchId: batch.id, reportHash, label: object.label, kind: object.kind, canonicalId: null, status: "identity-and-opening-unadjudicated" });
      for (const name of new Set([object.label, ...object.aliases])) {
        if (!names.has(name)) names.set(name, new Set());
        names.get(name)!.add(object.id);
      }
    }
    facts.push(...report.facts.map(fact => ({ id: fact.id, batchId: batch.id, reportHash,
      names: [...new Set([fact.subject, ...fact.related])], opening: fact.opening, status: "source-candidate-not-runtime-fact" })));
    issues.push(...report.issues.map(issue => ({ id: issue.id, batchId: batch.id, reportHash, subject: issue.subject })));
    acceptedBatches.add(batch.id);
  }
  return { subjects, facts, issues, acceptedBatchIds: [...acceptedBatches].sort(),
    names: [...names].sort(([a], [b]) => a.localeCompare(b)).map(([name, ids]) => ({ name, candidateIds: [...ids].sort(), resolution: "unresolved-do-not-merge" })) };
}

export function fullyExtractedChapters(batches: ReadingBatch[], acceptedBatchIds: string[], chapters: Array<{ id: string; characters: number }>) {
  const accepted = new Set(acceptedBatchIds), intervals = new Map<string, Array<[number, number]>>();
  for (const batch of batches) if (accepted.has(batch.id)) for (const part of batch.parts) {
    if (!intervals.has(part.chapter_id)) intervals.set(part.chapter_id, []);
    intervals.get(part.chapter_id)!.push([part.start, part.end]);
  }
  return new Set(chapters.filter(chapter => {
    let covered = 0;
    for (const [start, end] of (intervals.get(chapter.id) ?? []).sort(([a], [b]) => a - b)) {
      if (start > covered) return false;
      covered = Math.max(covered, end);
    }
    return covered >= chapter.characters && chapter.characters > 0;
  }).map(chapter => chapter.id));
}
