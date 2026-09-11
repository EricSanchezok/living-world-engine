import { shortlistEvidenceContext } from "./shortlist-evidence";
import { contentHash } from "../../../models/model-audit";
import type {
  CandidateSelectionCapability,
  CandidateSelectionResult,
} from "../../roles";

export const ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION = "action-compilation-retrieval-runtime-v6";

export interface RankedCandidate {
  candidateKey: string;
  score: number;
}

export interface SlotRetrievalResult {
  candidates: readonly RankedCandidate[];
  cache?: {
    passageHits: number;
    passageMisses: number;
    queryHit: boolean;
    readMs: number;
    passageEncodeMs?: number;
    queryEncodeMs: number;
  };
}

export interface BatchRetrievalCache {
  passageHits: number;
  passageMisses: number;
  queryHits: number;
  queryMisses: number;
  readMs: number;
  passageEncodeMs: number;
  queryEncodeMs: number;
  queryBatchSize: number;
}

export interface BatchSlotRetrievalResult {
  perSlot: ReadonlyMap<number, SlotRetrievalResult>;
  cache: BatchRetrievalCache;
}

export interface BatchSelectionCandidate {
  candidateKey: string;
  kind: string;
  allowedUses: readonly string[];
}

export interface BatchCandidateSelectorInput {
  candidates: readonly BatchSelectionCandidate[];
  perSlot: ReadonlyMap<number, SlotRetrievalResult>;
  mandatoryKeys: ReadonlySet<string>;
  budget: number;
}

export type BatchCandidateSelector = (input: BatchCandidateSelectorInput) => readonly string[];

export interface ActionCompilationRetrievalRuntimeOptions {
  version: string;
  budgetRatio?: number;
  selectBatch?: BatchCandidateSelector;
  retrieveSlot?(input: {
    worldContentHash: string;
    context: Readonly<Record<string, unknown>>;
    slotIndex: number;
    signal?: AbortSignal;
  }): Promise<SlotRetrievalResult>;
  retrievePhysicalBatch?(input: {
    worldContentHash: string;
    context: Readonly<Record<string, unknown>>;
    slotIndices: readonly number[];
    signal?: AbortSignal;
  }): Promise<BatchSlotRetrievalResult>;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function visible(candidate: Record<string, unknown>, slotIndex: number): boolean {
  const scope = object(candidate.scope);
  if (!scope || scope.kind === "shared") return true;
  return scope.kind === "slot" && scope.slot === slotIndex;
}

function candidateKey(value: unknown): value is string {
  return typeof value === "string" && /^candidate_[0-9a-f]+$/u.test(value);
}

function slotContext(fullContext: Readonly<Record<string, unknown>>, slotIndex: number): Record<string, unknown> {
  const task = object(fullContext.task);
  const slots = Array.isArray(task?.slots) ? task.slots : [];
  return object(slots.find((value) => object(value)?.slot === slotIndex)) ?? object(slots[slotIndex]) ?? {};
}

export function actionCompilationMandatoryKeys(context: Readonly<Record<string, unknown>>, slotIndex: number): readonly string[] {
  const slot = slotContext(context, slotIndex);
  const references = object(slot.actionReferences);
  const result: string[] = [];
  const add = (value: unknown): void => { if (candidateKey(value)) result.push(value); };
  add(references?.actionCandidateKey);
  const actor = object(references?.actor);
  if (actor?.status === "unique") { add(actor.agentCandidateKey); add(actor.boundEntityCandidateKey); }
  if (Array.isArray(references?.targets)) for (const targetValue of references.targets) {
    const target = object(targetValue);
    if (target?.status === "unique" && Array.isArray(target.candidateKeys)) target.candidateKeys.forEach(add);
  }
  if (Array.isArray(slot.temporalProfileEligibility)) for (const profileValue of slot.temporalProfileEligibility) {
    const profile = object(profileValue);
    if (profile?.eligible === true) add(profile.profileRef);
  }
  return [...new Set(result)].sort();
}

function strictBudget(count: number, ratio: number): number {
  return Math.min(Math.floor(count * ratio), Math.max(0, Math.ceil(count * ratio) - 1));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("candidate retrieval aborted");
}

function defaultBatchSelection(input: BatchCandidateSelectorInput): readonly string[] {
  const selected = new Set(input.mandatoryKeys);
  const aggregates = new Map<string, { coverage: number; score: number; bestRank: number }>();
  for (const result of input.perSlot.values()) result.candidates.forEach((candidate, rank) => {
    const value = aggregates.get(candidate.candidateKey) ?? {
      coverage: 0,
      score: Number.NEGATIVE_INFINITY,
      bestRank: Number.MAX_SAFE_INTEGER,
    };
    value.coverage += 1;
    value.score = Math.max(value.score, candidate.score);
    value.bestRank = Math.min(value.bestRank, rank);
    aggregates.set(candidate.candidateKey, value);
  });
  const ranked = [...aggregates.entries()].sort(([leftKey, left], [rightKey, right]) =>
    right.coverage - left.coverage || right.score - left.score ||
    left.bestRank - right.bestRank || leftKey.localeCompare(rightKey));
  for (const [key] of ranked) {
    if (selected.size >= input.budget) break;
    selected.add(key);
  }
  return [...selected];
}

function validateBatchSelection(
  keys: readonly string[],
  input: BatchCandidateSelectorInput,
): Set<string> {
  const selected = new Set<string>();
  const catalogKeys = new Set(input.candidates.map((candidate) => candidate.candidateKey));
  const scoredKeys = new Set([...input.perSlot.values()].flatMap((result) =>
    result.candidates.map((candidate) => candidate.candidateKey)));
  for (const key of keys) {
    if (!candidateKey(key) || !catalogKeys.has(key) || !scoredKeys.has(key)) {
      throw new Error(`batch candidate selector returned an invalid or unscored key: ${String(key)}`);
    }
    if (selected.has(key)) throw new Error(`batch candidate selector returned duplicate key ${key}`);
    selected.add(key);
  }
  if (selected.size > input.budget) {
    throw new Error(`batch candidate selector exceeded budget: ${selected.size} > ${input.budget}`);
  }
  const missing = [...input.mandatoryKeys].filter((key) => !selected.has(key));
  if (missing.length > 0) throw new Error(`batch candidate selector dropped mandatory keys: ${missing.join(",")}`);
  return selected;
}

export function createActionCompilationRetrievalRuntime(
  options: ActionCompilationRetrievalRuntimeOptions,
): CandidateSelectionCapability {
  const budgetRatio = options.budgetRatio ?? 0.2;
  if (!Number.isFinite(budgetRatio) || budgetRatio <= 0 || budgetRatio > 0.2) {
    throw new Error("runtime budgetRatio must be in (0, 0.2]");
  }
  if (Boolean(options.retrieveSlot) === Boolean(options.retrievePhysicalBatch)) {
    throw new Error("runtime requires exactly one slot or physical-batch retriever");
  }
  return {
    version: options.version,
    role: "candidate-selection",
    async retrieveBatch({ worldContentHash, fullContext, slotIndices, signal }) {
      throwIfAborted(signal);
      const catalog = object(fullContext.referenceCatalog);
      const catalogCandidates = Array.isArray(catalog?.candidates) ? catalog.candidates.flatMap((entry) => {
        const candidate = object(entry);
        return candidate && candidateKey(candidate.candidateKey) ? [candidate] : [];
      }) : [];
      const byKey = new Map(catalogCandidates.map((candidate) => [candidate.candidateKey as string, candidate]));
      const slots = [...new Set(slotIndices)].sort((left, right) => left - right);
      const retrievedBatch = options.retrievePhysicalBatch
        ? await options.retrievePhysicalBatch({
            worldContentHash,
            context: fullContext,
            slotIndices: slots,
            signal,
          })
        : undefined;
      if (retrievedBatch) {
        const actualSlots = [...retrievedBatch.perSlot.keys()].sort((left, right) => left - right);
        if (JSON.stringify(actualSlots) !== JSON.stringify(slots)) {
          throw new Error("physical-batch retriever returned the wrong slot set");
        }
      }
      const perSlot = new Map<number, SlotRetrievalResult>();
      const mandatoryBySlot = new Map<number, readonly string[]>();
      const cache: BatchRetrievalCache = retrievedBatch
        ? { ...retrievedBatch.cache }
        : {
            passageHits: 0,
            passageMisses: 0,
            queryHits: 0,
            queryMisses: 0,
            readMs: 0,
            passageEncodeMs: 0,
            queryEncodeMs: 0,
            queryBatchSize: 0,
          };
      for (const slotIndex of slots) {
        throwIfAborted(signal);
        const result = retrievedBatch?.perSlot.get(slotIndex) ?? await options.retrieveSlot!({
          worldContentHash,
          context: fullContext,
          slotIndex,
          signal,
        });
        const seen = new Set<string>();
        for (const candidate of result.candidates) {
          if (!candidateKey(candidate.candidateKey) || !Number.isFinite(candidate.score)) {
            throw new Error(`candidate retriever returned invalid output for slot ${slotIndex}`);
          }
          if (seen.has(candidate.candidateKey)) throw new Error(`candidate retriever returned duplicate key ${candidate.candidateKey} for slot ${slotIndex}`);
          seen.add(candidate.candidateKey);
          const catalogCandidate = byKey.get(candidate.candidateKey);
          if (!catalogCandidate || !visible(catalogCandidate, slotIndex)) {
            throw new Error(`candidate retriever returned invalid/private key for slot ${slotIndex}: ${candidate.candidateKey}`);
          }
        }
        const mandatory = actionCompilationMandatoryKeys(fullContext, slotIndex);
        const missing = mandatory.filter((key) => !seen.has(key));
        if (missing.length > 0) throw new Error(`candidate retrieval anchor missing for slot ${slotIndex}: ${missing.join(",")}`);
        mandatoryBySlot.set(slotIndex, mandatory);
        perSlot.set(slotIndex, result);
        if (!retrievedBatch && result.cache) {
          cache.passageHits += result.cache.passageHits;
          cache.passageMisses += result.cache.passageMisses;
          cache.queryHits += result.cache.queryHit ? 1 : 0;
          cache.queryMisses += result.cache.queryHit ? 0 : 1;
          cache.readMs += result.cache.readMs;
          cache.passageEncodeMs += result.cache.passageEncodeMs ?? 0;
          cache.queryEncodeMs += result.cache.queryEncodeMs;
          cache.queryBatchSize += 1;
        }
      }

      const selected = new Set([...mandatoryBySlot.values()].flat());
      const nominalBatchBudget = strictBudget(catalogCandidates.length, budgetRatio);
      // Required identities and eligible temporal profiles are a semantic floor.
      // Small catalogs can have more anchors than the proportional shortlist.
      const batchBudget = Math.max(nominalBatchBudget, selected.size);
      const selectorInput: BatchCandidateSelectorInput = {
        candidates: catalogCandidates.map((candidate) => ({
          candidateKey: candidate.candidateKey as string,
          kind: typeof candidate.kind === "string" ? candidate.kind : "unknown",
          allowedUses: Array.isArray(candidate.allowedUses)
            ? candidate.allowedUses.filter((use): use is string => typeof use === "string")
            : [],
        })),
        perSlot,
        mandatoryKeys: selected,
        budget: batchBudget,
      };
      const selectedByPolicy = options.selectBatch
        ? options.selectBatch(selectorInput)
        : defaultBatchSelection(selectorInput);
      const validatedSelection = validateBatchSelection(selectedByPolicy, selectorInput);
      selected.clear();
      validatedSelection.forEach((key) => selected.add(key));
      const selectedKeysBySlot = new Map<number, readonly string[]>();
      for (const slotIndex of slots) {
        const eligible = new Set(perSlot.get(slotIndex)!.candidates.map((candidate) => candidate.candidateKey));
        const keys = [...selected].filter((key) => eligible.has(key)).sort();
        for (const mandatory of mandatoryBySlot.get(slotIndex) ?? []) {
          if (!keys.includes(mandatory)) throw new Error(`joint candidate selection dropped anchor ${mandatory} from slot ${slotIndex}`);
        }
        selectedKeysBySlot.set(slotIndex, keys);
      }

      const { context: modelContext } = shortlistEvidenceContext(fullContext, catalogCandidates
        .filter((candidate) => selected.has(candidate.candidateKey as string))
        .map((candidate) => candidate.candidateKey as string));
      const fullContextHash = contentHash(fullContext);
      const modelContextHash = contentHash(modelContext);
      const shortlistHash = contentHash({ version: options.version, selectedBySlot: [...selectedKeysBySlot.entries()] });
      return {
        modelContext,
        selectedKeysBySlot,
        fullContextHash,
        modelContextHash,
        shortlistHash,
        diagnostics: {
          selectedCount: selected.size,
          visibleCount: catalogCandidates.length,
          batchBudget,
          nominalBatchBudget,
          mandatoryBudgetFloorApplied: batchBudget > nominalBatchBudget,
          batchShortlistRatio: catalogCandidates.length === 0 ? 0 : selected.size / catalogCandidates.length,
          prunedReferenceCount: 0,
          anchorCount: new Set([...mandatoryBySlot.values()].flat()).size,
          budgetExceeded: false,
          perSlotSelectedCount: Object.fromEntries([...selectedKeysBySlot].map(([slot, keys]) => [String(slot), keys.length])),
          cache,
        },
      } satisfies CandidateSelectionResult;
    },
  };
}
