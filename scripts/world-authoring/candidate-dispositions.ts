import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().min(1);
const anchor = z.strictObject({ chapterId: identity, chapterSha256: fingerprint,
  start: z.number().int().nonnegative(), end: z.number().int().positive(), anchorSha256: fingerprint });
const decision = z.enum(["adopted", "corrected", "history-only", "later-only", "bounded-uncertainty", "transferred", "pending"]);
export const candidateDispositionSchema = z.strictObject({
  formatVersion: z.literal(1), moduleId: identity, queueInputHash: fingerprint,
  status: z.literal("editorial-dispositions-not-release-approval"), reviewer: identity,
  records: z.array(z.strictObject({
    candidateId: identity, batchId: identity, reportHash: fingerprint, disposition: decision,
    targetIds: z.array(identity), reason: identity, evidence: z.array(anchor).min(1),
    uncertainty: z.strictObject({ kind: z.enum(["source-underdetermined", "missing-evidence"]), boundary: identity }).nullable(),
    destinationModule: identity.nullable(),
  })),
});

export interface CandidateQueue {
  inputHash: string; moduleId: string;
  candidates: Array<{ id: string; kind: string; batchId: string; reportHash: string }>;
}

/** Completeness is an editorial queue property, never implicit runtime approval. */
export function validateCandidateDispositions(input: unknown, queue: CandidateQueue, context: {
  reports: ReadonlyMap<string, unknown>;
  targetIds: ReadonlySet<string>;
  readChapter: (id: string) => string;
}) {
  const report = candidateDispositionSchema.parse(input);
  if (report.moduleId !== queue.moduleId || report.queueInputHash !== queue.inputHash) throw new Error("candidate queue fingerprint drift");
  const expected = new Map(queue.candidates.map(candidate => [candidate.id, candidate]));
  if (expected.size !== queue.candidates.length) throw new Error("duplicate candidate in queue");
  const seen = new Set<string>();
  const counts: Record<z.infer<typeof decision>, number> = { adopted: 0, corrected: 0, "history-only": 0,
    "later-only": 0, "bounded-uncertainty": 0, transferred: 0, pending: 0 };
  const checkedReports = new Map<string, string>();
  const sources = new Map<string, string>();
  for (const row of report.records) {
    const candidate = expected.get(row.candidateId);
    if (!candidate) throw new Error(`unexpected candidate ${row.candidateId}`);
    if (seen.has(row.candidateId)) throw new Error(`duplicate disposition ${row.candidateId}`);
    seen.add(row.candidateId);
    if (row.batchId !== candidate.batchId || row.reportHash !== candidate.reportHash) throw new Error(`candidate reference drift ${row.candidateId}`);
    const extraction = context.reports.get(row.batchId);
    if (extraction === undefined) throw new Error(`extraction report drift ${row.batchId}`);
    if (!checkedReports.has(row.batchId)) checkedReports.set(row.batchId, contentHash(extraction));
    if (checkedReports.get(row.batchId) !== row.reportHash) throw new Error(`extraction report drift ${row.batchId}`);
    const original = extraction as Record<string, unknown>;
    const collection = original[{ object: "objects", fact: "facts", issue: "issues" }[candidate.kind] ?? ""];
    if (!Array.isArray(collection) || collection.filter(item => item?.id === row.candidateId).length !== 1) throw new Error(`candidate absent from extraction ${row.candidateId}`);
    const sourceCandidate = collection.find(item => item.id === row.candidateId);
    if (!Array.isArray(sourceCandidate.evidence) || !sourceCandidate.evidence.some((citation: { chapterId: string }) =>
      row.evidence.some(evidence => evidence.chapterId === citation.chapterId))) throw new Error(`missing candidate source context ${row.candidateId}`);
    if (new Set(row.targetIds).size !== row.targetIds.length) throw new Error(`duplicate target ${row.candidateId}`);
    for (const target of row.targetIds) if (!context.targetIds.has(target)) throw new Error(`unknown editorial target ${target}`);
    if (row.disposition !== "pending" && !row.targetIds.length) throw new Error(`missing editorial target ${row.candidateId}`);
    if (row.disposition === "bounded-uncertainty" && row.uncertainty?.kind !== "source-underdetermined") throw new Error(`unbounded uncertainty ${row.candidateId}`);
    if (row.uncertainty?.kind === "missing-evidence" && row.disposition !== "pending") throw new Error(`missing evidence cannot close ${row.candidateId}`);
    if (row.uncertainty?.kind === "source-underdetermined" && row.disposition !== "bounded-uncertainty") throw new Error(`uncertainty requires bounded disposition ${row.candidateId}`);
    if ((row.disposition === "transferred") !== (row.destinationModule !== null)) throw new Error(`invalid editorial transfer ${row.candidateId}`);
    if (row.destinationModule !== null && (!context.targetIds.has(row.destinationModule) || row.destinationModule === report.moduleId)) throw new Error(`unknown transfer destination ${row.candidateId}`);
    for (const evidence of row.evidence) {
      let text = sources.get(evidence.chapterId);
      if (text === undefined) { text = context.readChapter(evidence.chapterId); sources.set(evidence.chapterId, text); }
      const characters = [...text];
      if (contentHash(text) !== evidence.chapterSha256 || evidence.end > characters.length || evidence.end <= evidence.start
        || contentHash(characters.slice(evidence.start, evidence.end).join("")) !== evidence.anchorSha256) throw new Error(`source anchor drift ${row.candidateId}:${evidence.chapterId}:${evidence.start}`);
    }
    counts[row.disposition]++;
  }
  const missing = [...expected.keys()].filter(id => !seen.has(id));
  if (missing.length) throw new Error(`missing candidate dispositions: ${missing.join(", ")}`);
  return { moduleId: report.moduleId, candidates: expected.size, counts,
    completed: expected.size - counts.pending - counts.transferred,
    unresolved: counts.pending + counts.transferred,
    boundedUncertainty: counts["bounded-uncertainty"], approvedForRuntime: false as const,
    reportHash: contentHash(report) };
}
