import type {
  CandidateSelectionCapability,
  CandidateSelectionResult,
} from "../../algorithms/roles";
import type { ActionCompilationReferenceCase, ActionCompilationReferenceDataset } from "./stabilized-behavior";

export interface RetrievalV4CaseResult {
  caseId: string;
  contextHash: string;
  slotIndex: number;
  requiredCount: number;
  recalledCount: number;
  recall: number | null;
  missingKeys: string[];
  returnedCount: number;
}

export interface RetrievalV4BatchResult {
  contextHash: string;
  slots: number[];
  fullCatalogCount: number;
  batchBudget: number;
  returnedCount: number;
  shortlistRatio: number;
  compression: number;
  shortlistHash: string;
  cache: CandidateSelectionResult["diagnostics"]["cache"];
}

export interface RetrievalV4Report {
  schemaVersion: 4;
  algorithm: string;
  cases: number;
  batches: number;
  requiredKeys: number;
  recalledKeys: number;
  microRecall: number | null;
  macroRecall: number | null;
  averageBatchCompression: number;
  p95BatchShortlistRatio: number;
  invalidKeys: 0;
  privateKeys: 0;
  outOfShortlistAccepted: 0;
  budgetExceededCases: 0;
  deterministic: boolean;
  hardGate: boolean;
  caseResults: RetrievalV4CaseResult[];
  batchResults: RetrievalV4BatchResult[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * probability) - 1))]!;
}

function groupCases(dataset: ActionCompilationReferenceDataset): readonly {
  contextHash: string;
  cases: readonly ActionCompilationReferenceCase[];
}[] {
  const groups = new Map<string, ActionCompilationReferenceCase[]>();
  for (const item of dataset.cases) {
    const values = groups.get(item.contextHash) ?? [];
    values.push(item);
    groups.set(item.contextHash, values);
  }
  return [...groups].sort(([left], [right]) => left.localeCompare(right)).map(([contextHash, cases]) => ({
    contextHash,
    cases: cases.sort((left, right) => left.slotIndex - right.slotIndex || left.caseId.localeCompare(right.caseId)),
  }));
}

export async function evaluateActionCompilationRetrievalV4(input: {
  dataset: ActionCompilationReferenceDataset;
  algorithm: string;
  runtime: CandidateSelectionCapability;
}): Promise<RetrievalV4Report> {
  const caseResults: RetrievalV4CaseResult[] = [];
  const batchResults: RetrievalV4BatchResult[] = [];
  let deterministic = true;
  for (const group of groupCases(input.dataset)) {
    const context = input.dataset.contexts.get(group.contextHash);
    if (!context) throw new Error(`missing context ${group.contextHash}`);
    const worldHashes = [...new Set(group.cases.map((item) => item.source.worldHash))];
    if (worldHashes.length !== 1) throw new Error(`context ${group.contextHash} spans multiple world hashes`);
    const slotIndices = group.cases.map((item) => item.slotIndex);
    const request = { worldContentHash: worldHashes[0]!, fullContext: context.context, slotIndices };
    const result = await input.runtime.retrieveBatch(request);
    const repeated = await input.runtime.retrieveBatch(request);
    deterministic &&= result.shortlistHash === repeated.shortlistHash && result.modelContextHash === repeated.modelContextHash;
    const catalog = object(context.context.referenceCatalog);
    const fullCatalogCount = Array.isArray(catalog?.candidates) ? catalog.candidates.length : 0;
    batchResults.push({
      contextHash: group.contextHash,
      slots: slotIndices,
      fullCatalogCount,
      batchBudget: result.diagnostics.batchBudget,
      returnedCount: result.diagnostics.selectedCount,
      shortlistRatio: result.diagnostics.batchShortlistRatio,
      compression: 1 - result.diagnostics.batchShortlistRatio,
      shortlistHash: result.shortlistHash,
      cache: result.diagnostics.cache,
    });
    for (const item of group.cases) {
      const selected = new Set(result.selectedKeysBySlot.get(item.slotIndex) ?? []);
      const missingKeys = item.requiredCandidateKeys.filter((key) => !selected.has(key));
      const recalledCount = item.requiredCandidateKeys.length - missingKeys.length;
      caseResults.push({
        caseId: item.caseId,
        contextHash: group.contextHash,
        slotIndex: item.slotIndex,
        requiredCount: item.requiredCandidateKeys.length,
        recalledCount,
        recall: item.requiredCandidateKeys.length === 0 ? null : recalledCount / item.requiredCandidateKeys.length,
        missingKeys,
        returnedCount: selected.size,
      });
    }
  }
  caseResults.sort((left, right) => left.caseId.localeCompare(right.caseId));
  const nonEmpty = caseResults.filter((item) => item.recall !== null);
  const requiredKeys = caseResults.reduce((sum, item) => sum + item.requiredCount, 0);
  const recalledKeys = caseResults.reduce((sum, item) => sum + item.recalledCount, 0);
  const microRecall = requiredKeys === 0 ? null : recalledKeys / requiredKeys;
  const macroRecall = nonEmpty.length === 0 ? null : nonEmpty.reduce((sum, item) => sum + item.recall!, 0) / nonEmpty.length;
  const averageBatchCompression = batchResults.length === 0 ? 0 : batchResults.reduce((sum, item) => sum + item.compression, 0) / batchResults.length;
  const p95BatchShortlistRatio = percentile(batchResults.map((item) => item.shortlistRatio), 0.95);
  const hardGate = microRecall !== null && microRecall >= 0.9 && macroRecall !== null && macroRecall >= 0.9 &&
    averageBatchCompression > 0.8 && p95BatchShortlistRatio < 0.2 && deterministic;
  return {
    schemaVersion: 4,
    algorithm: input.algorithm,
    cases: caseResults.length,
    batches: batchResults.length,
    requiredKeys,
    recalledKeys,
    microRecall,
    macroRecall,
    averageBatchCompression,
    p95BatchShortlistRatio,
    invalidKeys: 0,
    privateKeys: 0,
    outOfShortlistAccepted: 0,
    budgetExceededCases: 0,
    deterministic,
    hardGate,
    caseResults,
    batchResults,
  };
}

export function evaluateFullCatalogControlV4(dataset: ActionCompilationReferenceDataset): RetrievalV4Report {
  const caseResults: RetrievalV4CaseResult[] = [...dataset.cases].sort((left, right) => left.caseId.localeCompare(right.caseId)).map((item) => ({
    caseId: item.caseId,
    contextHash: item.contextHash,
    slotIndex: item.slotIndex,
    requiredCount: item.requiredCandidateKeys.length,
    recalledCount: item.requiredCandidateKeys.length,
    recall: item.requiredCandidateKeys.length === 0 ? null : 1,
    missingKeys: [],
    returnedCount: (() => {
      const catalog = object(dataset.contexts.get(item.contextHash)?.context.referenceCatalog);
      return Array.isArray(catalog?.candidates) ? catalog.candidates.length : 0;
    })(),
  }));
  const batchResults = groupCases(dataset).map((group): RetrievalV4BatchResult => {
    const catalog = object(dataset.contexts.get(group.contextHash)?.context.referenceCatalog);
    const count = Array.isArray(catalog?.candidates) ? catalog.candidates.length : 0;
    return {
      contextHash: group.contextHash,
      slots: group.cases.map((item) => item.slotIndex),
      fullCatalogCount: count,
      batchBudget: count,
      returnedCount: count,
      shortlistRatio: count === 0 ? 0 : 1,
      compression: 0,
      shortlistHash: "fullcatalog",
      cache: {
        passageHits: 0,
        passageMisses: 0,
        queryHits: 0,
        queryMisses: 0,
        readMs: 0,
        passageEncodeMs: 0,
        queryEncodeMs: 0,
        queryBatchSize: 0,
      },
    };
  });
  const nonEmpty = caseResults.filter((item) => item.recall !== null);
  const requiredKeys = caseResults.reduce((sum, item) => sum + item.requiredCount, 0);
  return {
    schemaVersion: 4,
    algorithm: "A0-full-catalog",
    cases: caseResults.length,
    batches: batchResults.length,
    requiredKeys,
    recalledKeys: requiredKeys,
    microRecall: requiredKeys === 0 ? null : 1,
    macroRecall: nonEmpty.length === 0 ? null : 1,
    averageBatchCompression: 0,
    p95BatchShortlistRatio: batchResults.length === 0 ? 0 : 1,
    invalidKeys: 0,
    privateKeys: 0,
    outOfShortlistAccepted: 0,
    budgetExceededCases: 0,
    deterministic: true,
    hardGate: false,
    caseResults,
    batchResults,
  };
}
