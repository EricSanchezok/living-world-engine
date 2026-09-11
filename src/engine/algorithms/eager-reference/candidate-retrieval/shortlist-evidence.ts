import { contentHash } from "../../../models/model-audit";

type RecordValue = Record<string, unknown>;
const isRecord = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const isCandidate = (value: unknown): value is string => typeof value === "string" && /^candidate_[0-9a-f]{12}$/u.test(value);

/** Preserve source facts without expanding the executable reference namespace. */
export function shortlistEvidenceContext(full: RecordValue, selectedKeys: readonly string[]) {
  const catalog = full.referenceCatalog;
  if (!isRecord(catalog) || !Array.isArray(catalog.candidates)) throw new Error("missing full source catalog");
  const candidates = catalog.candidates.map((value) => {
    if (!isRecord(value) || !isCandidate(value.candidateKey)) throw new Error("invalid source candidate");
    return value;
  });
  const byKey = new Map(candidates.map((value) => [value.candidateKey as string, value]));
  const selected = new Set(selectedKeys);
  if (selected.size !== selectedKeys.length || byKey.size !== candidates.length || selectedKeys.some((key) => !byKey.has(key))) {
    throw new Error("duplicate or unknown source selection");
  }
  const evidence = new Map<string, RecordValue>();
  const originals = new Map<string, string>();
  const encode = (value: unknown): unknown => {
    if (isCandidate(value) && !selected.has(value)) {
      const source = byKey.get(value);
      if (!source) throw new Error("source detail refers outside the full catalog");
      const stateReference = `snapshot_${value.slice("candidate_".length)}`;
      evidence.set(stateReference, { stateReference, kind: source.kind, label: source.label,
        meaning: source.meaning ?? "", scope: structuredClone(source.scope) });
      originals.set(stateReference, value);
      return { stateReference };
    }
    if (Array.isArray(value)) return value.map(encode);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]));
    return value;
  };
  const originalCandidates = selectedKeys.map((key) => byKey.get(key)!);
  const projectedCandidates = originalCandidates.map(encode);
  const decode = (value: unknown): unknown => {
    if (isRecord(value) && Object.keys(value).length === 1 && typeof value.stateReference === "string") {
      const original = originals.get(value.stateReference);
      if (!original) throw new Error("unknown evidence identity");
      return original;
    }
    if (Array.isArray(value)) return value.map(decode);
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
    return value;
  };
  if (JSON.stringify(projectedCandidates.map(decode)) !== JSON.stringify(originalCandidates)) {
    throw new Error("selected source facts failed exact inverse proof");
  }
  const context = structuredClone(full);
  context.referenceCatalog = { ...structuredClone(catalog), candidates: projectedCandidates };
  context.referenceEvidence = { sourceContextHash: contentHash(full),
    entries: [...evidence.values()].sort((a, b) => String(a.stateReference).localeCompare(String(b.stateReference))) };
  return { context, restoredReferenceCount: originals.size, selectedSourceHash: contentHash(originalCandidates) };
}
