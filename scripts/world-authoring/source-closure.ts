import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { type ReadingBatch, indexableReport } from "./authoring-index";
import { buildSourceAdjudicationEvidence } from "./source-evidence";
import { candidateDispositionSchema, type CandidateQueue, validateCandidateDispositions } from "./candidate-dispositions";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1);
const anchor = z.object({ chapterId: identity, chapterSha256: fingerprint, start: z.number().int().nonnegative(),
  end: z.number().int().positive(), anchorSha256: fingerprint });
const resolutionRecord = z.object({ id: identity, batchId: identity, sourceReportHash: fingerprint,
  adjudicationReportHash: fingerprint, findingHash: fingerprint, status: z.literal("source-semantics-resolved"),
  disposition: identity, statement: identity, evidence: z.array(anchor),
  candidateId: identity.optional(), targetIds: z.array(identity).optional(),
}).passthrough();
const resolutionReport = z.object({ recordsHash: fingerprint, records: z.array(resolutionRecord) }).passthrough();
const adjudicationRows = z.object({ records: z.array(z.object({ id: identity, verdict: identity }).passthrough()),
  aliases: z.array(z.object({ objectId: identity, verdict: identity }).passthrough()),
  issues: z.array(z.object({ id: identity, status: identity }).passthrough()),
  omissions: z.array(z.record(z.string(), z.unknown())),
  identities: z.array(z.object({ relation: identity }).passthrough()),
}).passthrough();

export interface SourceClosureContext {
  chapters: Array<{ id: string; characters: number; sha256: string }>;
  batches: ReadingBatch[];
  extractions: ReadonlyMap<string, unknown>;
  adjudications: ReadonlyMap<string, unknown>;
  readChapter: (id: string) => string;
  recoveryAccess?: (batch: ReadingBatch) => Parameters<typeof buildSourceAdjudicationEvidence>[4];
  resolutions: Array<{ path: string; report: unknown }>;
  dispositions: Array<{ path: string; report: unknown; queue: CandidateQueue; queuePath?: string }>;
  inputArtifacts?: Array<{ path: string; value: unknown }>;
  targetIds: ReadonlySet<string>;
  readArtifact?: (path: string) => unknown;
}

type FindingKind = "unsupported" | "ambiguous" | "alias" | "issue" | "omission" | "identity";
interface Finding {
  batchId: string; kind: FindingKind; findingHash: string; sourceReportHash: string;
  adjudicationReportHash: string; candidateId: string | null;
  sourceEvidenceCount: number;
}

/** Recompute evidence, never promote a saved status or a lexical routing proposal. */
export function buildSourceClosure(context: SourceClosureContext) {
  if (!context.chapters.length || !context.batches.length) throw new Error("source closure requires nonempty chapter and batch inventories");
  const chapterIds = new Set<string>(), batchIds = new Set<string>();
  const bodies = new Map<string, string>(), chapterIntervals = new Map<string, Array<[number, number]>>();
  for (const chapter of context.chapters) {
    if (chapterIds.has(chapter.id)) throw new Error(`duplicate source chapter ${chapter.id}`);
    chapterIds.add(chapter.id);
    const body = context.readChapter(chapter.id);
    if (contentHash(body) !== chapter.sha256 || [...body].length !== chapter.characters) throw new Error(`chapter baseline drift ${chapter.id}`);
    bodies.set(chapter.id, body);
  }
  const readChapter = (id: string) => {
    const body = bodies.get(id);
    if (body === undefined) throw new Error(`unknown source chapter ${id}`);
    return body;
  };
  const candidates = new Map<string, { kind: string; batchId: string; reportHash: string }>();
  const findings = new Map<string, Finding>();
  const passes: Array<ReturnType<typeof buildSourceAdjudicationEvidence>> = [];
  const missingExtractions: string[] = [], missingAdjudications: string[] = [];
  for (const batch of context.batches) {
    if (batchIds.has(batch.id)) throw new Error(`duplicate reading batch ${batch.id}`);
    batchIds.add(batch.id);
    for (const part of batch.parts) {
      const body = readChapter(part.chapter_id), chars = [...body];
      if (part.start < 0 || part.end <= part.start || part.end > chars.length ||
        contentHash(chars.slice(part.start, part.end).join("")) !== part.sha256) throw new Error(`source part drift ${batch.id}`);
      const intervals = chapterIntervals.get(part.chapter_id) ?? [];
      intervals.push([part.start, part.end]); chapterIntervals.set(part.chapter_id, intervals);
    }
    const extraction = context.extractions.get(batch.id);
    if (extraction === undefined) { missingExtractions.push(batch.id); missingAdjudications.push(batch.id); continue; }
    const parsed = indexableReport.parse(extraction), reportHash = contentHash(extraction);
    if (parsed.batchId !== batch.id) throw new Error(`extraction batch drift ${batch.id}`);
    for (const [kind, rows] of [["object", parsed.objects], ["fact", parsed.facts], ["issue", parsed.issues]] as const) {
      for (const row of rows) {
        if (candidates.has(row.id)) throw new Error(`duplicate global candidate ${row.id}`);
        candidates.set(row.id, { kind, batchId: batch.id, reportHash });
      }
    }
    const review = context.adjudications.get(batch.id);
    if (review === undefined) { missingAdjudications.push(batch.id); continue; }
    passes.push(buildSourceAdjudicationEvidence(review, extraction, batch, readChapter, context.recoveryAccess?.(batch)));
    const adjudicationReportHash = contentHash(review), rows = adjudicationRows.parse(review);
    const add = (kind: FindingKind, row: unknown, candidateId: string | null) => {
      const findingHash = contentHash(row), key = `${batch.id}:${findingHash}`;
      if (findings.has(key)) throw new Error(`duplicate source finding ${key}`);
      findings.set(key, { batchId: batch.id, kind, findingHash, sourceReportHash: reportHash, adjudicationReportHash, candidateId,
        sourceEvidenceCount: z.object({ evidence: z.array(z.unknown()) }).parse(row).evidence.length });
    };
    for (const row of rows.records) if (row.verdict === "unsupported" || row.verdict === "ambiguous") add(row.verdict, row, row.id);
    for (const row of rows.aliases) if (row.verdict !== "supported") add("alias", row, row.objectId);
    for (const row of rows.issues) if (row.status !== "resolved-in-this-batch") add("issue", row, row.id);
    for (const row of rows.omissions) add("omission", row, null);
    for (const row of rows.identities) if (row.relation === "unresolved") add("identity", row, null);
  }
  for (const id of context.extractions.keys()) if (!batchIds.has(id)) throw new Error(`unplanned extraction ${id}`);
  for (const id of context.adjudications.keys()) if (!batchIds.has(id)) throw new Error(`unplanned adjudication ${id}`);
  const incompleteChapters: string[] = [];
  for (const chapter of context.chapters) {
    let cursor = 0;
    for (const [start, end] of (chapterIntervals.get(chapter.id) ?? []).sort((a, b) => a[0] - b[0])) {
      if (start < cursor) throw new Error(`overlapping source input ${chapter.id}`);
      if (start !== cursor) break;
      cursor = end;
    }
    if (cursor !== chapter.characters) incompleteChapters.push(chapter.id);
  }
  const inputPins: Array<{ path: string; hash: string }> = (context.inputArtifacts ?? []).map(({ path, value }) => ({ path, hash: contentHash(value) }));
  const dispositionBindings = new Map<string, Array<{ path: string; recordHash: string; disposition: string; targetIds: string[] }>>();
  const pendingDispositions: Array<{ path: string; candidateId: string }> = [];
  const uniquePaths = new Set<string>();
  for (const unit of context.dispositions) {
    if (uniquePaths.has(unit.path)) throw new Error(`duplicate disposition artifact ${unit.path}`);
    uniquePaths.add(unit.path);
    validateCandidateDispositions(unit.report, unit.queue, { reports: context.extractions, targetIds: context.targetIds, readChapter });
    const report = candidateDispositionSchema.parse(unit.report);
    inputPins.push({ path: unit.path, hash: contentHash(unit.report) });
    inputPins.push({ path: unit.queuePath ?? `${unit.path}#queue`, hash: contentHash(unit.queue) });
    for (const row of report.records) {
      const expected = candidates.get(row.candidateId);
      const queued = unit.queue.candidates.find(candidate => candidate.id === row.candidateId);
      if (!expected || !queued || queued.kind !== expected.kind || row.batchId !== expected.batchId || row.reportHash !== expected.reportHash) {
        throw new Error(`foreign global candidate ${row.candidateId}`);
      }
      if (row.disposition === "pending" || row.disposition === "transferred") {
        pendingDispositions.push({ path: unit.path, candidateId: row.candidateId }); continue;
      }
      const bindings = dispositionBindings.get(row.candidateId) ?? [];
      bindings.push({ path: unit.path, recordHash: contentHash(row), disposition: row.disposition, targetIds: row.targetIds });
      dispositionBindings.set(row.candidateId, bindings);
    }
  }
  const resolved = new Map<string, { path: string; recordHash: string }>();
  const artifacts = new Map<string, unknown>();
  const artifact = (file: string) => {
    if (!context.readArtifact) throw new Error(`source closure needs referenced artifact access ${file}`);
    if (!artifacts.has(file)) artifacts.set(file, context.readArtifact(file));
    return artifacts.get(file);
  };
  const verifyReferences = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) verifyReferences(item); return; }
    if (!value || typeof value !== "object") return;
    const ref = value as Record<string, unknown>;
    if (typeof ref.path === "string" && (ref.claimHash || ref.reportHash || ref.recordHash)) {
      const document = artifact(ref.path);
      const documentRows = Array.isArray(document) ? document : z.object({ records: z.array(z.record(z.string(), z.unknown())) }).parse(document).records;
      const rows = z.array(z.record(z.string(), z.unknown())).parse(documentRows);
      if (ref.reportHash && contentHash(document) !== ref.reportHash) throw new Error(`referenced report drift ${ref.path}`);
      if (ref.recordsHash && contentHash(documentRows) !== ref.recordsHash) throw new Error(`referenced records drift ${ref.path}`);
      if (ref.claimsHash && contentHash(documentRows) !== ref.claimsHash) throw new Error(`referenced claims drift ${ref.path}`);
      const id = ref.claimId ?? ref.recordId ?? ref.id;
      const matches = rows.filter(row => row.id === id || row.candidateId === id);
      if (matches.length !== 1 || contentHash(matches[0]) !== (ref.claimHash ?? ref.recordHash)) throw new Error(`referenced row drift ${ref.path}:${String(id)}`);
      if (Array.isArray(ref.claims)) {
        const claimPath = ref.path.replace(/[^/]+$/u, "claims.json");
        const claims = z.array(z.object({ id: identity }).passthrough()).parse(artifact(claimPath));
        for (const claim of z.array(z.object({ id: identity, hash: fingerprint })).parse(ref.claims)) {
          if (claims.filter(row => row.id === claim.id).length !== 1 || contentHash(claims.find(row => row.id === claim.id)) !== claim.hash) {
            throw new Error(`referenced claim drift ${claimPath}:${claim.id}`);
          }
        }
      }
    }
    for (const item of Object.values(ref)) verifyReferences(item);
  };
  let checkedAnchors = 0;
  for (const unit of context.resolutions) {
    if (uniquePaths.has(unit.path)) throw new Error(`duplicate resolution artifact ${unit.path}`);
    uniquePaths.add(unit.path);
    const report = resolutionReport.parse(unit.report);
    const original = (unit.report as { records: unknown[] }).records;
    if (report.recordsHash !== contentHash(original)) throw new Error(`resolution records drift ${unit.path}`);
    inputPins.push({ path: unit.path, hash: contentHash(unit.report) });
    for (const [recordIndex, row] of report.records.entries()) {
      const key = `${row.batchId}:${row.findingHash}`, finding = findings.get(key);
      if (!finding || finding.sourceReportHash !== row.sourceReportHash || finding.adjudicationReportHash !== row.adjudicationReportHash) {
        throw new Error(`unknown or stale source resolution ${row.id}`);
      }
      if (resolved.has(key)) throw new Error(`duplicate source resolution ${row.id}`);
      verifyReferences(original[recordIndex]);
      if (row.candidateId && row.candidateId !== finding.candidateId) throw new Error(`source resolution candidate drift ${row.id}`);
      if (!row.evidence.length) {
        const metadataKinds = new Set(["authoring-metadata-not-lore", "editorial-note-not-world-fact",
          "editorial-note-resolved-as-nonlore", "temporal-editorial-scope", "chapter-time-not-global-exclusion",
          "editorial-correction-not-lore", "taxonomy-edit-not-world-mutation"]);
        const extraction = context.extractions.get(row.batchId);
        const sourceIssue = indexableReport.parse(extraction).issues.find(issue => issue.id === finding.candidateId);
        // An extractor may attach an incidental scene anchor to its own process note.
        // The independent finding must itself be evidence-free and the editor must
        // explicitly classify the note as metadata, not a missing lore citation.
        if (finding.kind !== "issue" || finding.sourceEvidenceCount !== 0 || !sourceIssue ||
          row.validAtOpening !== false || !metadataKinds.has(row.disposition)) throw new Error(`unjustified evidence-free resolution ${row.id}`);
      }
      for (const target of row.targetIds ?? []) if (!context.targetIds.has(target)) throw new Error(`unknown resolution target ${target}`);
      for (const citation of row.evidence) {
        const text = readChapter(citation.chapterId), chars = [...text];
        if (contentHash(text) !== citation.chapterSha256 || citation.end > chars.length || citation.end <= citation.start ||
          contentHash(chars.slice(citation.start, citation.end).join("")) !== citation.anchorSha256) throw new Error(`resolution anchor drift ${row.id}`);
        checkedAnchors++;
      }
      resolved.set(key, { path: unit.path, recordHash: contentHash(original[recordIndex]) });
    }
  }
  const unresolvedFindings = [...findings].filter(([key]) => !resolved.has(key)).map(([, finding]) => finding);
  const unassignedCandidates = [...candidates].filter(([id]) => !dispositionBindings.has(id)).map(([candidateId, value]) => ({ candidateId, ...value }));
  const sourceComplete = missingExtractions.length === 0 && missingAdjudications.length === 0 && incompleteChapters.length === 0;
  const semanticComplete = sourceComplete && unresolvedFindings.length === 0;
  const candidateComplete = sourceComplete && unassignedCandidates.length === 0 && pendingDispositions.length === 0;
  return { formatVersion: 1, status: semanticComplete && candidateComplete ? "source-and-candidate-evidence-complete" : "source-closure-in-progress",
    approvedForRuntime: false, sourceComplete, semanticComplete, candidateComplete,
    counts: { chapters: context.chapters.length, batches: context.batches.length, verifiedBatches: passes.length,
      candidates: candidates.size, dispositionBoundCandidates: dispositionBindings.size,
      findings: findings.size, resolvedFindings: resolved.size, checkedResolutionAnchors: checkedAnchors },
    inputHash: contentHash({ chapters: context.chapters.map(({ id, characters, sha256 }) => ({ id, characters, sha256 })),
      batches: context.batches.map(({ id, parts }) => ({ id, parts })), passes, inputPins: inputPins.sort((a, b) => a.path.localeCompare(b.path)) }),
    evidence: { inputPins, referencedArtifacts: [...artifacts].map(([path, value]) => ({ path, hash: contentHash(value) })).sort((a, b) => a.path.localeCompare(b.path)),
      sourcePassesHash: contentHash(passes), resolutionBindingsHash: contentHash([...resolved]),
      candidateBindingsHash: contentHash([...dispositionBindings]) },
    residual: { missingExtractions, missingAdjudications, incompleteChapters, unresolvedFindings, unassignedCandidates, pendingDispositions },
    interpretation: "完整正文输入、来源语义处置、全部候选归属分开复验。该证据不替代地区正文与运行审签、存活/知识/资源一致性或真实游玩验收。",
  };
}

/** A consumer must supply current inputs; saved flags alone never authorize a seal. */
export function validateSourceClosure(input: unknown, context: SourceClosureContext) {
  const actual = buildSourceClosure(context);
  if (contentHash(input) !== contentHash(actual)) throw new Error("source closure input or evidence drift");
  return { passed: actual.sourceComplete && actual.semanticComplete && actual.candidateComplete,
    reportHash: contentHash(actual), inputHash: actual.inputHash, counts: actual.counts, residual: actual.residual,
    approvedForRuntime: false as const };
}
