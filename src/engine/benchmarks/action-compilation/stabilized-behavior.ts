import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  existsSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import { canonicalize, contentHash, isSha256 } from "../../models/model-audit";

export const ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION = 1 as const;
export const ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION_V2 = 2 as const;
export const ACTION_COMPILATION_REFERENCE_DATASET_KIND =
  "action-compilation-fullcatalog-stabilized" as const;

export type ActionCompilationReferenceDatasetStatus = "generated" | "frozen" | "superseded";

export interface BenchmarkArtifactShard {
  file: string;
  sha256: string;
  records: number;
  rawBytes: number;
  compressedBytes: number;
}

export interface ActionCompilationReferenceDatasetManifest {
  schemaVersion: typeof ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION |
    typeof ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION_V2;
  kind: typeof ACTION_COMPILATION_REFERENCE_DATASET_KIND;
  datasetId: string;
  version: number;
  status: ActionCompilationReferenceDatasetStatus;
  organization: string;
  project: string;
  purpose: "candidate-retrieval-recall";
  referenceSemantics: "behavioral-reference";
  semanticGroundTruth: false;
  source: {
    baseline: "C3";
    worldId: string;
    worldHash: string;
    initialStateHash: string;
    modelCatalogHash: string;
    registrySnapshotHash: string;
    profileId: string;
    modelId: string;
    algorithmManifestHash?: string;
    captureAlgorithmManifestHash?: string;
    referenceAlgorithmManifestHash?: string;
    promptVersion: string;
    candidateKeyVersion: string;
    symbolRepairPolicyVersion: string;
    semanticRepairAttempts: number;
  };
  lineage?: {
    baseDatasets: Array<{
      datasetId: string;
      version: number;
      manifestHash: string;
      cases: number;
    }>;
    sourceGroups: Array<{
      id: string;
      stratum: "base-v1" | "r5-captured";
      captureAlgorithmManifestHash: string;
      referenceAlgorithmManifestHash: string;
      sourceExecutionIds: string[];
      initialStateHashes: string[];
      cases: number;
    }>;
  };
  generation: {
    seed: number;
    targetCases: number;
    maxProviderRequests: number;
    providerRequests: number;
    logicalInvocations: number;
    transportAttempts: number;
    repairCalls: number;
    acceptedSlots: number;
    rejectedSlots: number;
    startedAt: string;
    completedAt: string;
  };
  /** Optional provenance for datasets exported from an existing Ledger. */
  export?: {
    mode: "ledger";
    sourceExecutionIds: string[];
    exportedAt: string;
    observedProviderRequests: number;
    observedTransportAttempts: number;
    observedLogicalInvocations: number;
    observedRepairCalls: number;
    observedAcceptedSlots: number;
    observedRejectedSlots: number;
  };
  counts: {
    cases: number;
    contexts: number;
    nonEmptyRequiredCases: number;
    emptyRequiredCases: number;
  };
  artifacts: {
    seeds: BenchmarkArtifactShard[];
    contexts: BenchmarkArtifactShard[];
    cases: BenchmarkArtifactShard[];
  };
  distributions: {
    batchSizes: Record<string, number>;
    categories: Record<string, number>;
    requiredKeyCardinality: Record<string, number>;
    repairCounts: Record<string, number>;
  };
}

export interface ActionCompilationReferenceContextRecord {
  contextHash: string;
  context: Record<string, unknown>;
  source?: {
    executionId?: string;
    invocationId?: string;
    catalogHash?: string;
  };
}

export interface ActionCompilationReferenceCase {
  caseId: string;
  contextHash: string;
  slotIndex: number;
  batchSize: number;
  category?: string;
  stratum?: "base-v1" | "r5-captured";
  requiredCandidateKeys: string[];
  source: {
    catalogHash: string;
    worldHash: string;
    algorithmManifestHash: string;
    captureAlgorithmManifestHash?: string;
    referenceAlgorithmManifestHash?: string;
  };
  provenance?: {
    sourceExecutionId?: string;
    sourceInvocationId?: string;
    repairCount?: number;
    rawOutputHash?: string;
    normalizedOutputHash?: string;
  };
}

export interface ActionCompilationReferenceDataset {
  root: string;
  manifest: ActionCompilationReferenceDatasetManifest;
  contexts: ReadonlyMap<string, ActionCompilationReferenceContextRecord>;
  cases: readonly ActionCompilationReferenceCase[];
}

export interface CandidateRetrieverInput {
  context: Readonly<Record<string, unknown>>;
  slotIndex: number;
}

export type CandidateRetriever = (input: CandidateRetrieverInput) => readonly string[];

export interface ActionCompilationRecallCaseResult {
  caseId: string;
  slotIndex: number;
  batchSize: number;
  stratum: "base-v1" | "r5-captured" | "unstratified";
  requiredCount: number;
  recalledCount: number;
  recall: number | null;
  missingKeys: string[];
  returnedCount: number;
  invalidKeys: string[];
  privateKeys: string[];
}

export interface ActionCompilationRecallReport {
  schemaVersion: 1;
  kind: "action-compilation-recall-report";
  datasetId: string;
  datasetVersion: number;
  retriever: string;
  cases: number;
  nonEmptyRequiredCases: number;
  emptyRequiredCases: number;
  requiredKeys: number;
  recalledKeys: number;
  microRecall: number | null;
  macroRecall: number | null;
  invalidOutputCases: number;
  invalidOutputKeys: number;
  byBatchSize: Record<string, { cases: number; requiredKeys: number; recalledKeys: number; recall: number | null }>;
  byCategory: Record<string, { cases: number; requiredKeys: number; recalledKeys: number; recall: number | null }>;
  byStratum: Record<string, {
    cases: number;
    requiredKeys: number;
    recalledKeys: number;
    microRecall: number | null;
    macroRecall: number | null;
  }>;
  byBatchUnion: Record<string, { batches: number; requiredKeys: number; recalledKeys: number; recall: number | null }>;
  caseResults: ActionCompilationRecallCaseResult[];
}

interface JsonRecord {
  [key: string]: unknown;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function sha256(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function jsonLine(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function encodeJsonlGzip(records: readonly unknown[]): { buffer: Buffer; rawBytes: number } {
  const raw = Buffer.from(records.map(jsonLine).join("\n") + (records.length > 0 ? "\n" : ""), "utf8");
  return {
    // Node's gzip writer emits a stable header; keep compression settings
    // explicit so shard hashes are reproducible across generator runs.
    buffer: gzipSync(raw, { level: 9 }),
    rawBytes: raw.byteLength,
  };
}

export function decodeJsonlGzip<T>(buffer: Uint8Array, label = "shard"): T[] {
  let raw: Buffer;
  try {
    raw = gunzipSync(buffer);
  } catch (error) {
    throw new Error(`${label} is not valid gzip: ${error instanceof Error ? error.message : String(error)}`);
  }
  const lines = raw.toString("utf8").split(/\r?\n/u).filter((line) => line.trim().length > 0);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line) as T;
    } catch (error) {
      throw new Error(`${label} line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function shardRecords<T>(records: readonly T[], size = 50): T[][] {
  positiveInteger(size, "shard size");
  const shards: T[][] = [];
  for (let index = 0; index < records.length; index += size) shards.push([...records.slice(index, index + size)]);
  return shards;
}

function artifactPath(root: string, artifact: BenchmarkArtifactShard): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, artifact.file);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`artifact path escapes dataset root: ${artifact.file}`);
  }
  return resolved;
}

function validateArtifact(artifact: unknown, root: string, label: string): BenchmarkArtifactShard {
  const value = record(artifact, label);
  const file = value.file;
  const hash = value.sha256;
  if (typeof file !== "string" || !file || path.isAbsolute(file)) throw new Error(`${label}.file is invalid`);
  if (typeof hash !== "string" || !isSha256(hash)) throw new Error(`${label}.sha256 is invalid`);
  const records = positiveInteger(value.records, `${label}.records`);
  const rawBytes = positiveInteger(value.rawBytes, `${label}.rawBytes`);
  const compressedBytes = positiveInteger(value.compressedBytes, `${label}.compressedBytes`);
  const resolved = artifactPath(root, { file, sha256: hash, records, rawBytes, compressedBytes });
  if (!existsSync(resolved)) throw new Error(`${label} file is missing: ${file}`);
  const bytes = readFileSync(resolved);
  if (bytes.byteLength !== compressedBytes) throw new Error(`${label}.compressedBytes does not match ${file}`);
  if (sha256(bytes) !== hash) throw new Error(`${label}.sha256 does not match ${file}`);
  return { file, sha256: hash, records, rawBytes, compressedBytes };
}

function validateExport(value: unknown): ActionCompilationReferenceDatasetManifest["export"] {
  const input = record(value, "manifest.export");
  if (input.mode !== "ledger" || !Array.isArray(input.sourceExecutionIds) ||
    input.sourceExecutionIds.some((id) => typeof id !== "string" || id.length === 0) ||
    typeof input.exportedAt !== "string" || input.exportedAt.length === 0) {
    throw new Error("manifest.export is invalid");
  }
  for (const key of [
    "observedProviderRequests",
    "observedTransportAttempts",
    "observedLogicalInvocations",
    "observedRepairCalls",
    "observedAcceptedSlots",
    "observedRejectedSlots",
  ]) {
    if (!Number.isSafeInteger(input[key]) || Number(input[key]) < 0) {
      throw new Error(`manifest.export.${key} is invalid`);
    }
  }
  return {
    mode: "ledger",
    sourceExecutionIds: [...input.sourceExecutionIds] as string[],
    exportedAt: input.exportedAt as string,
    observedProviderRequests: Number(input.observedProviderRequests),
    observedTransportAttempts: Number(input.observedTransportAttempts),
    observedLogicalInvocations: Number(input.observedLogicalInvocations),
    observedRepairCalls: Number(input.observedRepairCalls),
    observedAcceptedSlots: Number(input.observedAcceptedSlots),
    observedRejectedSlots: Number(input.observedRejectedSlots),
  };
}

function validateLineage(value: unknown): NonNullable<ActionCompilationReferenceDatasetManifest["lineage"]> {
  const input = record(value, "manifest.lineage");
  if (!Array.isArray(input.baseDatasets) || !Array.isArray(input.sourceGroups) || input.sourceGroups.length === 0) {
    throw new Error("manifest.lineage is invalid");
  }
  const baseDatasets = input.baseDatasets.map((entry, index) => {
    const item = record(entry, `manifest.lineage.baseDatasets[${index}]`);
    if (typeof item.datasetId !== "string" || !item.datasetId || !Number.isSafeInteger(item.version) ||
      Number(item.version) < 1 || typeof item.manifestHash !== "string" || !isSha256(item.manifestHash) ||
      !Number.isSafeInteger(item.cases) || Number(item.cases) < 0) {
      throw new Error(`manifest.lineage.baseDatasets[${index}] is invalid`);
    }
    return {
      datasetId: item.datasetId,
      version: Number(item.version),
      manifestHash: item.manifestHash,
      cases: Number(item.cases),
    };
  });
  const ids = new Set<string>();
  const sourceGroups = input.sourceGroups.map((entry, index) => {
    const item = record(entry, `manifest.lineage.sourceGroups[${index}]`);
    if (typeof item.id !== "string" || !item.id || ids.has(item.id) ||
      (item.stratum !== "base-v1" && item.stratum !== "r5-captured") ||
      typeof item.captureAlgorithmManifestHash !== "string" || !isSha256(item.captureAlgorithmManifestHash) ||
      typeof item.referenceAlgorithmManifestHash !== "string" || !isSha256(item.referenceAlgorithmManifestHash) ||
      !Array.isArray(item.sourceExecutionIds) || item.sourceExecutionIds.some((id) => typeof id !== "string" || !id) ||
      !Array.isArray(item.initialStateHashes) || item.initialStateHashes.length === 0 ||
      item.initialStateHashes.some((hash) => typeof hash !== "string" || !isSha256(hash)) ||
      !Number.isSafeInteger(item.cases) || Number(item.cases) < 0) {
      throw new Error(`manifest.lineage.sourceGroups[${index}] is invalid`);
    }
    ids.add(item.id);
    return {
      id: item.id,
      stratum: item.stratum as "base-v1" | "r5-captured",
      captureAlgorithmManifestHash: item.captureAlgorithmManifestHash,
      referenceAlgorithmManifestHash: item.referenceAlgorithmManifestHash,
      sourceExecutionIds: [...new Set(item.sourceExecutionIds as string[])].sort(),
      initialStateHashes: [...new Set(item.initialStateHashes as string[])].sort(),
      cases: Number(item.cases),
    };
  });
  return { baseDatasets, sourceGroups };
}

function validateManifest(input: unknown, root: string): ActionCompilationReferenceDatasetManifest {
  const value = record(input, "manifest");
  if ((value.schemaVersion !== ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION &&
    value.schemaVersion !== ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION_V2) ||
    value.kind !== ACTION_COMPILATION_REFERENCE_DATASET_KIND) {
    throw new Error("manifest schemaVersion/kind is invalid");
  }
  if (value.datasetId !== "action-compilation/fullcatalog-stabilized" ||
    !Number.isSafeInteger(value.version) || Number(value.version) < 1) {
    throw new Error("manifest datasetId/version is invalid");
  }
  if (value.organization !== "上海创智学院" || value.project !== "Living World Engine") {
    throw new Error("manifest organization/project is invalid");
  }
  if (value.purpose !== "candidate-retrieval-recall" || value.referenceSemantics !== "behavioral-reference" ||
    value.semanticGroundTruth !== false) {
    throw new Error("manifest reference semantics are invalid");
  }
  if (value.status !== "generated" && value.status !== "frozen" && value.status !== "superseded") {
    throw new Error("manifest status is invalid");
  }
  const source = record(value.source, "manifest.source");
  for (const key of ["worldHash", "initialStateHash", "modelCatalogHash", "registrySnapshotHash"]) {
    if (typeof source[key] !== "string" || !source[key]) throw new Error(`manifest.source.${key} is invalid`);
  }
  if (value.schemaVersion === 1) {
    if (typeof source.algorithmManifestHash !== "string" || !source.algorithmManifestHash) {
      throw new Error("manifest.source.algorithmManifestHash is invalid");
    }
  } else {
    for (const key of ["captureAlgorithmManifestHash", "referenceAlgorithmManifestHash"]) {
      if (typeof source[key] !== "string" || !source[key]) throw new Error(`manifest.source.${key} is invalid`);
    }
    validateLineage(value.lineage);
  }
  const generation = record(value.generation, "manifest.generation");
  for (const key of ["seed", "targetCases", "maxProviderRequests", "providerRequests", "logicalInvocations", "transportAttempts", "repairCalls", "acceptedSlots", "rejectedSlots"]) {
    if (!Number.isSafeInteger(generation[key]) || Number(generation[key]) < 0) throw new Error(`manifest.generation.${key} is invalid`);
  }
  const counts = record(value.counts, "manifest.counts");
  for (const key of ["cases", "contexts", "nonEmptyRequiredCases", "emptyRequiredCases"]) {
    if (!Number.isSafeInteger(counts[key]) || Number(counts[key]) < 0) throw new Error(`manifest.counts.${key} is invalid`);
  }
  const artifacts = record(value.artifacts, "manifest.artifacts");
  const groups: Record<keyof ActionCompilationReferenceDatasetManifest["artifacts"], BenchmarkArtifactShard[]> = {
    seeds: [], contexts: [], cases: [],
  };
  for (const group of Object.keys(groups) as Array<keyof typeof groups>) {
    if (!Array.isArray(artifacts[group])) throw new Error(`manifest.artifacts.${group} must be an array`);
    groups[group] = artifacts[group].map((item, index) => validateArtifact(item, root, `manifest.artifacts.${group}[${index}]`));
  }
  if (groups.contexts.length === 0 || groups.cases.length === 0) throw new Error("manifest must contain context and case shards");
  return {
    schemaVersion: value.schemaVersion as 1 | 2,
    kind: ACTION_COMPILATION_REFERENCE_DATASET_KIND,
    datasetId: value.datasetId as string,
    version: Number(value.version),
    status: value.status as ActionCompilationReferenceDatasetStatus,
    organization: value.organization as string,
    project: value.project as string,
    purpose: "candidate-retrieval-recall",
    referenceSemantics: "behavioral-reference",
    semanticGroundTruth: false,
    source: source as ActionCompilationReferenceDatasetManifest["source"],
    ...(value.lineage === undefined ? {} : {
      lineage: validateLineage(value.lineage),
    }),
    generation: generation as ActionCompilationReferenceDatasetManifest["generation"],
    ...(value.export === undefined ? {} : { export: validateExport(value.export) }),
    counts: counts as ActionCompilationReferenceDatasetManifest["counts"],
    artifacts: groups,
    distributions: record(value.distributions, "manifest.distributions") as ActionCompilationReferenceDatasetManifest["distributions"],
  };
}

function candidateEntries(context: Record<string, unknown>): Array<Record<string, unknown>> {
  const catalog = context.referenceCatalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) throw new Error("context.referenceCatalog is missing");
  const candidates = (catalog as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) throw new Error("context.referenceCatalog.candidates is missing");
  return candidates.map((value, index) => record(value, `context.referenceCatalog.candidates[${index}]`));
}

function candidateKey(value: Record<string, unknown>, label: string): string {
  if (typeof value.candidateKey !== "string" || !/^candidate_[0-9a-f]{12}$/u.test(value.candidateKey)) {
    throw new Error(`${label}.candidateKey is invalid`);
  }
  return value.candidateKey;
}

function candidateVisible(value: Record<string, unknown>, slotIndex: number): boolean {
  const scope = value.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return true;
  const kind = (scope as { kind?: unknown }).kind;
  if (kind === "shared") return true;
  return kind === "slot" && (scope as { slot?: unknown }).slot === slotIndex;
}

function containsRawReference(value: unknown): boolean {
  if (typeof value === "string") return value.includes("ref:");
  if (Array.isArray(value)) return value.some(containsRawReference);
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).some(containsRawReference);
}

function validateCase(
  value: unknown,
  contextMap: ReadonlyMap<string, ActionCompilationReferenceContextRecord>,
  index: number,
  schemaVersion: 1 | 2,
): ActionCompilationReferenceCase {
  const input = record(value, `case ${index}`);
  if (typeof input.caseId !== "string" || !input.caseId) throw new Error(`case ${index}.caseId is invalid`);
  if (typeof input.contextHash !== "string" || !isSha256(input.contextHash)) throw new Error(`case ${input.caseId}.contextHash is invalid`);
  const contextRecord = contextMap.get(input.contextHash);
  if (!contextRecord) throw new Error(`case ${input.caseId} references missing context ${input.contextHash}`);
  const slotIndex = input.slotIndex;
  if (!Number.isSafeInteger(slotIndex) || Number(slotIndex) < 0) throw new Error(`case ${input.caseId}.slotIndex is invalid`);
  const batchSize = positiveInteger(input.batchSize, `case ${input.caseId}.batchSize`);
  if (Number(slotIndex) >= batchSize) throw new Error(`case ${input.caseId}.slotIndex exceeds batchSize`);
  const task = contextRecord.context.task;
  if (task && typeof task === "object" && !Array.isArray(task)) {
    const slots = (task as { slots?: unknown }).slots;
    if (Array.isArray(slots) && Number(slotIndex) >= slots.length) {
      throw new Error(`case ${input.caseId}.slotIndex is outside context task slots`);
    }
  }
  if (!Array.isArray(input.requiredCandidateKeys) || input.requiredCandidateKeys.some((key) => typeof key !== "string")) {
    throw new Error(`case ${input.caseId}.requiredCandidateKeys is invalid`);
  }
  const requiredCandidateKeys = [...input.requiredCandidateKeys] as string[];
  const sortedKeys = [...new Set(requiredCandidateKeys)].sort();
  if (sortedKeys.length !== requiredCandidateKeys.length || JSON.stringify(sortedKeys) !== JSON.stringify(requiredCandidateKeys)) {
    throw new Error(`case ${input.caseId}.requiredCandidateKeys must be unique and sorted`);
  }
  const catalog = new Map(candidateEntries(contextRecord.context).map((entry, candidateIndex) => [
    candidateKey(entry, `case ${input.caseId}.catalog[${candidateIndex}]`), entry,
  ]));
  const contextCatalog = record(contextRecord.context.referenceCatalog, `case ${input.caseId}.referenceCatalog`);
  if (typeof contextCatalog.hash !== "string" || !contextCatalog.hash) {
    throw new Error(`case ${input.caseId}.referenceCatalog.hash is invalid`);
  }
  for (const key of requiredCandidateKeys) {
    const candidate = catalog.get(key);
    if (!candidate) throw new Error(`case ${input.caseId} required key is absent from catalog: ${key}`);
    if (!candidateVisible(candidate, Number(slotIndex))) throw new Error(`case ${input.caseId} required key is private to another slot: ${key}`);
  }
  if (containsRawReference(contextRecord.context)) throw new Error(`context ${input.contextHash} contains a raw ref: value`);
  const source = record(input.source, `case ${input.caseId}.source`);
  for (const key of ["catalogHash", "worldHash", "algorithmManifestHash"]) {
    if (typeof source[key] !== "string" || !source[key]) throw new Error(`case ${input.caseId}.source.${key} is invalid`);
  }
  if (source.catalogHash !== contextCatalog.hash) {
    throw new Error(`case ${input.caseId}.source.catalogHash disagrees with context catalog hash`);
  }
  if (schemaVersion === 2) {
    if (input.stratum !== "base-v1" && input.stratum !== "r5-captured") {
      throw new Error(`case ${input.caseId}.stratum is invalid`);
    }
    for (const key of ["captureAlgorithmManifestHash", "referenceAlgorithmManifestHash"]) {
      if (typeof source[key] !== "string" || !isSha256(source[key] as string)) {
        throw new Error(`case ${input.caseId}.source.${key} is invalid`);
      }
    }
    const provenance = record(input.provenance, `case ${input.caseId}.provenance`);
    if (input.stratum === "r5-captured" &&
      (typeof provenance.sourceExecutionId !== "string" || !provenance.sourceExecutionId ||
        typeof provenance.sourceInvocationId !== "string" || !provenance.sourceInvocationId)) {
      throw new Error(`case ${input.caseId}.provenance source identity is invalid`);
    }
    if (provenance.repairCount !== undefined && (!Number.isSafeInteger(provenance.repairCount) || Number(provenance.repairCount) < 0)) {
      throw new Error(`case ${input.caseId}.provenance.repairCount is invalid`);
    }
    for (const key of ["rawOutputHash", "normalizedOutputHash"]) {
      if (provenance[key] !== undefined && (typeof provenance[key] !== "string" || !isSha256(provenance[key] as string))) {
        throw new Error(`case ${input.caseId}.provenance.${key} is invalid`);
      }
    }
  }
  return {
    caseId: input.caseId,
    contextHash: input.contextHash,
    slotIndex: Number(slotIndex),
    batchSize,
    ...(typeof input.category === "string" ? { category: input.category } : {}),
    ...(input.stratum === "base-v1" || input.stratum === "r5-captured" ? { stratum: input.stratum } : {}),
    requiredCandidateKeys,
    source: source as ActionCompilationReferenceCase["source"],
    ...(input.provenance === undefined ? {} : { provenance: record(input.provenance, `case ${input.caseId}.provenance`) as ActionCompilationReferenceCase["provenance"] }),
  };
}

export function loadActionCompilationReferenceDataset(rootInput: string): ActionCompilationReferenceDataset {
  const root = path.resolve(rootInput);
  const manifestFile = path.join(root, "manifest.json");
  if (!existsSync(manifestFile)) throw new Error(`benchmark manifest is missing: ${manifestFile}`);
  const manifest = validateManifest(JSON.parse(readFileSync(manifestFile, "utf8")) as unknown, root);
  const contexts = new Map<string, ActionCompilationReferenceContextRecord>();
  for (const shard of manifest.artifacts.contexts) {
    const records = decodeJsonlGzip<ActionCompilationReferenceContextRecord>(readFileSync(artifactPath(root, shard)), shard.file);
    if (records.length !== shard.records) throw new Error(`${shard.file} record count does not match manifest`);
    for (const [index, value] of records.entries()) {
      const input = record(value, `${shard.file} line ${index + 1}`);
      if (typeof input.contextHash !== "string" || !isSha256(input.contextHash)) throw new Error(`${shard.file} contextHash is invalid`);
      const context = record(input.context, `${shard.file} context`);
      if (contentHash(context) !== input.contextHash) throw new Error(`${shard.file} contextHash does not match context`);
      if (contexts.has(input.contextHash)) throw new Error(`duplicate contextHash: ${input.contextHash}`);
      contexts.set(input.contextHash, {
        contextHash: input.contextHash,
        context,
        ...(input.source === undefined ? {} : { source: record(input.source, `${shard.file} source`) as ActionCompilationReferenceContextRecord["source"] }),
      });
    }
  }
  const cases: ActionCompilationReferenceCase[] = [];
  const caseIds = new Set<string>();
  for (const shard of manifest.artifacts.cases) {
    const records = decodeJsonlGzip<unknown>(readFileSync(artifactPath(root, shard)), shard.file);
    if (records.length !== shard.records) throw new Error(`${shard.file} record count does not match manifest`);
    for (const value of records) {
      const parsed = validateCase(value, contexts, cases.length, manifest.schemaVersion);
      if (caseIds.has(parsed.caseId)) throw new Error(`duplicate caseId: ${parsed.caseId}`);
      caseIds.add(parsed.caseId);
      cases.push(parsed);
    }
  }
  if (cases.length !== manifest.counts.cases || contexts.size !== manifest.counts.contexts) {
    throw new Error("manifest counts do not match dataset contents");
  }
  const nonEmptyCases = cases.filter((item) => item.requiredCandidateKeys.length > 0).length;
  if (nonEmptyCases !== manifest.counts.nonEmptyRequiredCases ||
    cases.length - nonEmptyCases !== manifest.counts.emptyRequiredCases) {
    throw new Error("manifest required-key cardinality counts do not match dataset contents");
  }
  if (manifest.generation.acceptedSlots < cases.length ||
    manifest.generation.providerRequests > manifest.generation.maxProviderRequests) {
    throw new Error("manifest generation counters are inconsistent");
  }
  if (cases.some((value, index) => value.caseId !== `ac-c3-v${manifest.version}-${String(index + 1).padStart(6, "0")}`)) {
    throw new Error("case IDs must be contiguous and stable");
  }
  if (manifest.schemaVersion === 2) {
    const groups = manifest.lineage!.sourceGroups;
    if (groups.reduce((sum, group) => sum + group.cases, 0) !== cases.length) {
      throw new Error("manifest lineage source-group counts do not match dataset cases");
    }
    for (const stratum of ["base-v1", "r5-captured"] as const) {
      const expected = groups.filter((group) => group.stratum === stratum).reduce((sum, group) => sum + group.cases, 0);
      if (cases.filter((item) => item.stratum === stratum).length !== expected) {
        throw new Error(`manifest lineage ${stratum} count does not match dataset cases`);
      }
    }
  }
  return { root, manifest, contexts, cases };
}

function aggregateRecall(values: readonly { requiredKeys: number; recalledKeys: number; recall: number | null }[]) {
  const requiredKeys = values.reduce((sum, value) => sum + value.requiredKeys, 0);
  const recalledKeys = values.reduce((sum, value) => sum + value.recalledKeys, 0);
  return {
    cases: values.length,
    requiredKeys,
    recalledKeys,
    recall: requiredKeys === 0 ? null : recalledKeys / requiredKeys,
  };
}

export function evaluateActionCompilationRecall(
  dataset: ActionCompilationReferenceDataset,
  retriever: CandidateRetriever,
  retrieverName = "anonymous",
): ActionCompilationRecallReport {
  const results: ActionCompilationRecallCaseResult[] = [];
  const byBatch = new Map<string, Array<{ requiredKeys: number; recalledKeys: number; recall: number | null }>>();
  const byCategory = new Map<string, Array<{ requiredKeys: number; recalledKeys: number; recall: number | null }>>();
  const byStratum = new Map<string, Array<{ requiredKeys: number; recalledKeys: number; recall: number | null }>>();
  const unionByContext = new Map<string, { required: Set<string>; returned: Set<string>; batchSize: number }>();
  let invalidOutputCases = 0;
  let invalidOutputKeys = 0;
  for (const item of dataset.cases) {
    const contextRecord = dataset.contexts.get(item.contextHash);
    if (!contextRecord) throw new Error(`case ${item.caseId} context disappeared during evaluation`);
    const candidates = candidateEntries(contextRecord.context);
    const catalog = new Map(candidates.map((candidate) => [candidateKey(candidate, item.caseId), candidate]));
    const visible = new Set(candidates.filter((candidate) => candidateVisible(candidate, item.slotIndex)).map((candidate) => candidateKey(candidate, item.caseId)));
    const returned = retriever({ context: structuredClone(contextRecord.context), slotIndex: item.slotIndex });
    if (!Array.isArray(returned) || returned.some((key) => typeof key !== "string")) throw new Error(`retriever returned invalid output for ${item.caseId}`);
    const uniqueReturned = [...new Set(returned)];
    const invalidKeys = uniqueReturned.filter((key) => !catalog.has(key));
    const privateKeys = uniqueReturned.filter((key) => catalog.has(key) && !visible.has(key));
    if (invalidKeys.length > 0 || privateKeys.length > 0) {
      invalidOutputCases += 1;
      invalidOutputKeys += invalidKeys.length + privateKeys.length;
    }
    const returnedSet = new Set(uniqueReturned.filter((key) => visible.has(key)));
    const required = new Set(item.requiredCandidateKeys);
    const unionKey = `${item.contextHash}:${item.batchSize}`;
    const union = unionByContext.get(unionKey) ?? {
      required: new Set<string>(),
      returned: new Set<string>(),
      batchSize: item.batchSize,
    };
    item.requiredCandidateKeys.forEach((key) => union.required.add(key));
    returnedSet.forEach((key) => union.returned.add(key));
    unionByContext.set(unionKey, union);
    const missingKeys = [...required].filter((key) => !returnedSet.has(key));
    const recalledCount = required.size - missingKeys.length;
    const recall = required.size === 0 ? null : recalledCount / required.size;
    const result: ActionCompilationRecallCaseResult = {
      caseId: item.caseId,
      slotIndex: item.slotIndex,
      batchSize: item.batchSize,
      stratum: item.stratum ?? "unstratified",
      requiredCount: required.size,
      recalledCount,
      recall,
      missingKeys,
      returnedCount: uniqueReturned.length,
      invalidKeys,
      privateKeys,
    };
    results.push(result);
    const aggregate = { requiredKeys: required.size, recalledKeys: recalledCount, recall };
    const batch = byBatch.get(String(item.batchSize)) ?? [];
    batch.push(aggregate);
    byBatch.set(String(item.batchSize), batch);
    const category = item.category ?? "uncategorized";
    const categoryValues = byCategory.get(category) ?? [];
    categoryValues.push(aggregate);
    byCategory.set(category, categoryValues);
    const stratum = item.stratum ?? "unstratified";
    const stratumValues = byStratum.get(stratum) ?? [];
    stratumValues.push(aggregate);
    byStratum.set(stratum, stratumValues);
  }
  const nonEmpty = results.filter((item) => item.requiredCount > 0);
  const micro = aggregateRecall(nonEmpty.map((item) => ({ requiredKeys: item.requiredCount, recalledKeys: item.recalledCount, recall: item.recall })));
  const macroValues = nonEmpty.map((item) => item.recall).filter((value): value is number => value !== null);
  const byBatchUnion = Object.fromEntries([...unionByContext.entries()]
    .filter(([, value]) => value.batchSize > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      const recalledKeys = [...value.required].filter((candidate) => value.returned.has(candidate)).length;
      return [key, {
        batches: 1,
        requiredKeys: value.required.size,
        recalledKeys,
        recall: value.required.size === 0 ? null : recalledKeys / value.required.size,
      }];
    }));
  return {
    schemaVersion: 1,
    kind: "action-compilation-recall-report",
    datasetId: dataset.manifest.datasetId,
    datasetVersion: dataset.manifest.version,
    retriever: retrieverName,
    cases: results.length,
    nonEmptyRequiredCases: nonEmpty.length,
    emptyRequiredCases: results.length - nonEmpty.length,
    requiredKeys: micro.requiredKeys,
    recalledKeys: micro.recalledKeys,
    microRecall: micro.recall,
    macroRecall: macroValues.length === 0 ? null : macroValues.reduce((sum, value) => sum + value, 0) / macroValues.length,
    invalidOutputCases,
    invalidOutputKeys,
    byBatchSize: Object.fromEntries([...byBatch].sort(([left], [right]) => Number(left) - Number(right)).map(([key, values]) => [key, aggregateRecall(values)])),
    byCategory: Object.fromEntries([...byCategory].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => [key, aggregateRecall(values)])),
    byStratum: Object.fromEntries([...byStratum].sort(([left], [right]) => left.localeCompare(right)).map(([key, values]) => {
      const nonEmptyValues = values.filter((value) => value.requiredKeys > 0);
      const aggregate = aggregateRecall(nonEmptyValues);
      const macros = nonEmptyValues.map((value) => value.recall).filter((value): value is number => value !== null);
      return [key, {
        cases: values.length,
        requiredKeys: aggregate.requiredKeys,
        recalledKeys: aggregate.recalledKeys,
        microRecall: aggregate.recall,
        macroRecall: macros.length === 0 ? null : macros.reduce((sum, value) => sum + value, 0) / macros.length,
      }];
    })),
    byBatchUnion,
    caseResults: results,
  };
}

export function allVisibleCandidateRetriever(input: CandidateRetrieverInput): readonly string[] {
  const catalog = input.context.referenceCatalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return [];
  const candidates = (catalog as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    return typeof item.candidateKey === "string" && candidateVisible(item, input.slotIndex) ? [item.candidateKey] : [];
  });
}

export function writeShardManifest(file: string, records: readonly unknown[]): BenchmarkArtifactShard {
  const encoded = encodeJsonlGzip(records);
  return {
    file,
    sha256: sha256(encoded.buffer),
    records: records.length,
    rawBytes: encoded.rawBytes,
    compressedBytes: encoded.buffer.byteLength,
  };
}

export function encodedShard(records: readonly unknown[]): { buffer: Buffer; rawBytes: number } {
  return encodeJsonlGzip(records);
}
