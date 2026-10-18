import { contentHash } from "../../src/engine/models/model-audit";
import { indexableReport, indexSourceReports, type ReadingBatch } from "./authoring-index";

export interface RegionalScope { id: string; realm: string; search_terms: string[]; ignore_phrases?: string[] }

export interface RegionalQueueContent {
  moduleId: string; realm: string; searchTerms: string[]; ignoredPhrases?: string[];
  candidates: Array<{ id: string; kind: string; batchId: string; reportHash: string; matchingTerms: string[] }>;
}

/** Review dependencies belong to this region, not to unrelated production queues. */
export function regionalQueueHash(queue: RegionalQueueContent) {
  return contentHash({ moduleId: queue.moduleId, realm: queue.realm,
    searchTerms: queue.searchTerms, ignoredPhrases: queue.ignoredPhrases ?? [], candidates: queue.candidates });
}

/** Lexical routing creates review queues, never canonical identities or opening states. */
export function routeRegionalCandidates(inputs: unknown[], regions: RegionalScope[], batches: ReadingBatch[], readChapter: (id: string) => string) {
  const sourceIndex = indexSourceReports(inputs, batches, readChapter);
  if (new Set(regions.map(region => region.id)).size !== regions.length) throw new Error("duplicate regional identity");
  const reports = inputs.map(input => {
    const report = indexableReport.parse(input);
    const raw = input as Record<string, Array<Record<string, unknown>>>;
    const records = new Map([...(raw.objects ?? []), ...(raw.facts ?? []), ...(raw.issues ?? [])].map(record => [record.id as string, record]));
    return { report, reportHash: contentHash(input), records };
  });
  const queues = regions.map(region => ({ moduleId: region.id, realm: region.realm,
    status: "lexical-review-queue-not-canonical" as const,
    searchTerms: region.search_terms, ignoredPhrases: region.ignore_phrases ?? [],
    candidates: [] as Array<{ id: string; kind: string; batchId: string; reportHash: string; matchingTerms: string[] }> }));
  const unassigned: Array<{ id: string; kind: string; batchId: string; reportHash: string }> = [];
  for (const { report, reportHash, records: originals } of reports) {
    for (const [kind, records] of [["object", report.objects], ["fact", report.facts], ["issue", report.issues]] as const) {
      for (const item of records) {
        // The validated index strips narrative fields; routing reads the pinned report.
        const original = originals.get(item.id)!;
        const searchable = Object.entries(original).filter(([key]) => !["id", "evidence", "status"].includes(key))
          .map(([, value]) => typeof value === "string" ? value : Array.isArray(value) ? value.filter(entry => typeof entry === "string").join("\n") : "").join("\n");
        let matched = false;
        for (const queue of queues) {
          const regionalText = queue.ignoredPhrases.reduce((text, phrase) => phrase ? text.replaceAll(phrase, "\n") : text, searchable);
          const matchingTerms = queue.searchTerms.filter(term => term.length > 0 && regionalText.includes(term));
          if (!matchingTerms.length) continue;
          queue.candidates.push({ id: item.id, kind, batchId: report.batchId, reportHash, matchingTerms }); matched = true;
        }
        if (!matched) unassigned.push({ id: item.id, kind, batchId: report.batchId, reportHash });
      }
    }
  }
  return { formatVersion: 1, sourceBatchIds: sourceIndex.acceptedBatchIds,
    inputHash: contentHash({ reports: reports.map(({ report, reportHash }) => ({ batchId: report.batchId, reportHash })), regions }),
    queues: queues.map(queue => ({ ...queue, inputHash: regionalQueueHash(queue) })),
    unassigned, note: "命中只是制作线索；同一条可供多个地区复核。未命中条目必须另行归属，不能因未命中而删除。" };
}
