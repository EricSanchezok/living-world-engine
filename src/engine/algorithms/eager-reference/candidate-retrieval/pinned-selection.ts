import { contentHash } from "../../../models/model-audit";
import type { CandidateSelectionResult } from "../../roles";
import { shortlistEvidenceContext } from "./shortlist-evidence";
import { actionCompilationMandatoryKeys } from "./runtime";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
function rows(context: Readonly<RecordValue>, field: "slots" | "candidates"): RecordValue[] {
  const values = record(context[field === "slots" ? "task" : "referenceCatalog"])?.[field];
  if (!Array.isArray(values) || values.some((value) => !record(value))) throw new Error(`pinned selection requires ${field}`);
  return values as RecordValue[];
}
function actionKey(slot: RecordValue): string {
  const key = record(slot.actionReferences)?.actionCandidateKey;
  if (typeof key !== "string") throw new Error("pinned selection lost action identity");
  return key;
}
function meaning(candidate: RecordValue, includeDetails = true): string {
  const value = { ...candidate };
  delete value.scope;
  if (!includeDetails) delete value.details;
  return contentHash(value);
}

/** One immutable candidate selection per physical root, indexed by source action. */
export class PinnedActionCompilationSelection {
  private readonly byAction = new Map<string, { sourceHash: string; keys: readonly string[] }>();
  private readonly candidates: Map<string, RecordValue>;
  private readonly executionHash: string;
  private readonly rootSlots = new Map<number, string>();
  private readonly catalog: RecordValue;
  private readonly selected: CandidateSelectionResult;

  constructor(fullContext: Readonly<RecordValue>, selected: CandidateSelectionResult) {
    if (contentHash(fullContext) !== selected.fullContextHash) throw new Error("pinned selection full context mismatch");
    this.selected = structuredClone(selected);
    this.catalog = structuredClone(record(fullContext.referenceCatalog)!);
    this.executionHash = contentHash(fullContext.execution);
    this.candidates = new Map(rows(fullContext, "candidates").map((candidate) => [String(candidate.candidateKey), structuredClone(candidate)]));
    for (const slot of rows(fullContext, "slots")) {
      const key = actionKey(slot), keys = selected.selectedKeysBySlot.get(Number(slot.slot));
      if (this.byAction.has(key) || !keys || keys.some((key) => !this.candidates.has(key))) throw new Error("pinned selection invalid root assignment");
      this.byAction.set(key, { sourceHash: contentHash(slot.action), keys: [...keys] });
      this.rootSlots.set(Number(slot.slot), key);
    }
  }

  /** Restore root facts lost by the smaller batch's relevance projection.
   * Removed slots remain nonselectable; only their referenced snapshot evidence
   * can survive shortlist projection. No model text supplies these facts. */
  project(fullContext: Readonly<RecordValue>): RecordValue {
    if (contentHash(fullContext.execution) !== this.executionHash) throw new Error("pinned selection execution snapshot changed");
    const currentSlots = new Map(rows(fullContext, "slots").map((slot) => [actionKey(slot), Number(slot.slot)]));
    const currentCandidates = new Map(rows(fullContext, "candidates").map((candidate) => [String(candidate.candidateKey), candidate]));
    for (const [key, slot] of currentSlots) {
      const source = this.byAction.get(key);
      if (!source) throw new Error("pinned selection repair action mismatch");
      for (const selectedKey of source.keys) {
        const current = currentCandidates.get(selectedKey), original = this.candidates.get(selectedKey)!;
        const scope = record(current?.scope);
        if (!current || meaning(current, false) !== meaning(original, false) ||
          (current.details != null && original.details != null && contentHash(current.details) !== contentHash(original.details)) ||
          (scope?.kind !== "shared" && !(scope?.kind === "slot" && scope.slot === slot))) {
          throw new Error(`pinned selection lost or changed original candidate ${selectedKey}`);
        }
      }
    }
    const offset = Math.max(-1, ...currentSlots.values()) + 1;
    const candidates = [...this.candidates.values()].map((candidate) => {
      const scope = record(candidate.scope);
      if (scope?.kind !== "slot") return structuredClone(candidate);
      const rootSlot = Number(scope.slot), key = this.rootSlots.get(rootSlot);
      if (!key) throw new Error("pinned selection unknown private root owner");
      return { ...structuredClone(candidate), scope: { kind: "slot", slot: currentSlots.get(key) ?? offset + rootSlot } };
    });
    return { ...structuredClone(fullContext), referenceCatalog: { ...structuredClone(this.catalog), candidates, hash: contentHash(candidates) } };
  }

  reuse(fullContext: Readonly<RecordValue>): CandidateSelectionResult {
    if (contentHash(fullContext.execution) !== this.executionHash) throw new Error("pinned selection execution snapshot changed");
    const candidates = rows(fullContext, "candidates");
    const byKey = new Map(candidates.map((candidate) => [String(candidate.candidateKey), candidate]));
    const selectedKeysBySlot = new Map<number, readonly string[]>(), usedActions = new Set<string>();
    for (const slot of rows(fullContext, "slots")) {
      const key = actionKey(slot), source = this.byAction.get(key), index = Number(slot.slot);
      if (!source || source.sourceHash !== contentHash(slot.action) || usedActions.has(key) ||
        !Number.isInteger(index) || index < 0 || selectedKeysBySlot.has(index)) throw new Error("pinned selection repair action mismatch");
      usedActions.add(key);
      for (const selectedKey of source.keys) {
        const candidate = byKey.get(selectedKey), original = this.candidates.get(selectedKey)!;
        const scope = record(candidate?.scope);
        if (!candidate || meaning(candidate) !== meaning(original) ||
          (scope?.kind !== "shared" && !(scope?.kind === "slot" && scope.slot === index))) {
          throw new Error(`pinned selection lost or changed original candidate ${selectedKey}`);
        }
      }
      selectedKeysBySlot.set(index, [...source.keys]);
    }
    const keys = new Set([...selectedKeysBySlot.values()].flat());
    if (keys.size > this.selected.diagnostics.batchBudget) throw new Error("pinned selection exceeded root budget");
    const { context: modelContext } = shortlistEvidenceContext(fullContext, candidates.map((candidate) => String(candidate.candidateKey)).filter((key) => keys.has(key)));
    const rootSelection = { fullContextHash: this.selected.fullContextHash, shortlistHash: this.selected.shortlistHash,
      visibleCount: this.selected.diagnostics.visibleCount, selectedCount: this.selected.diagnostics.selectedCount,
      batchBudget: this.selected.diagnostics.batchBudget };
    return { modelContext, selectedKeysBySlot, fullContextHash: contentHash(fullContext), modelContextHash: contentHash(modelContext),
      shortlistHash: contentHash({ version: "action-compilation-pinned-selection-v1", rootSelection, selectedBySlot: [...selectedKeysBySlot] }),
      diagnostics: { selectedCount: keys.size, visibleCount: candidates.length, batchBudget: rootSelection.batchBudget,
        batchShortlistRatio: candidates.length ? keys.size / candidates.length : 0, prunedReferenceCount: 0,
        anchorCount: new Set([...selectedKeysBySlot.keys()].flatMap((slot) => actionCompilationMandatoryKeys(fullContext, slot))).size,
        nominalBatchBudget: this.selected.diagnostics.nominalBatchBudget,
        mandatoryBudgetFloorApplied: this.selected.diagnostics.mandatoryBudgetFloorApplied,
        budgetExceeded: false, rootSelection,
        perSlotSelectedCount: Object.fromEntries([...selectedKeysBySlot].map(([slot, values]) => [String(slot), values.length])),
        cache: { passageHits: 0, passageMisses: 0, queryHits: 0, queryMisses: 0, readMs: 0, passageEncodeMs: 0, queryEncodeMs: 0, queryBatchSize: 0 } },
    };
  }
}
