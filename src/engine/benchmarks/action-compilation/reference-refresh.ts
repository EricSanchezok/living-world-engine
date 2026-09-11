import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { FULL_CATALOG_ALGORITHM_REF } from "../../algorithms/registry";
import { canonicalize, contentHash } from "../../models/model-audit";
import type { RawBenchmarkSource, RegeneratedActionCompilationReference } from "../source-capture";
import {
  ACTION_COMPILATION_REFERENCE_DATASET_KIND,
  ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION_V2,
  encodedShard,
  loadActionCompilationReferenceDataset,
  type ActionCompilationReferenceCase,
  type ActionCompilationReferenceContextRecord,
  type ActionCompilationReferenceDataset,
  type ActionCompilationReferenceDatasetManifest,
  type BenchmarkArtifactShard,
} from "./stabilized-behavior";

export interface RefreshedReferenceData {
  contexts: ActionCompilationReferenceContextRecord[];
  cases: ActionCompilationReferenceCase[];
  manifest: Omit<ActionCompilationReferenceDatasetManifest, "artifacts">;
  seeds: Array<Record<string, unknown>>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function sourceWorldId(source: RawBenchmarkSource): string {
  const execution = object(source.fullContext.execution, `source ${source.sourceInvocationId} execution`);
  if (typeof execution.worldId !== "string" || !execution.worldId) {
    throw new Error(`source ${source.sourceInvocationId} has no worldId`);
  }
  return execution.worldId;
}

export function assertReferenceRefreshCompatibility(
  base: ActionCompilationReferenceDataset,
  sources: readonly RawBenchmarkSource[],
): void {
  if (base.manifest.version !== 1 || base.manifest.schemaVersion !== 1) {
    throw new Error("--base must be the immutable schema-v1 dataset");
  }
  const expected = base.manifest.source;
  for (const source of sources) {
    const candidateKeyVersion = `${source.projectorVersion}@${source.candidateKeyVersion}`;
    if (source.captureAlgorithmRef.children.actionCompilation?.children.candidateSelection?.id !== "relational-rrf") {
      throw new Error(`source ${source.sourceInvocationId} is not an R5 relational-rrf capture`);
    }
    if (sourceWorldId(source) !== expected.worldId || source.worldHash !== expected.worldHash ||
      source.modelCatalogHash !== expected.modelCatalogHash || source.profileId !== expected.profileId ||
      source.modelId !== expected.modelId || source.promptVersion !== expected.promptVersion ||
      candidateKeyVersion !== expected.candidateKeyVersion ||
      source.symbolRepairPolicyVersion !== expected.symbolRepairPolicyVersion) {
      throw new Error(`source ${source.sourceInvocationId} is incompatible with base-v1 world/model/prompt/projector/key/repair provenance`);
    }
  }
  const captureHashes = new Set(sources.map((source) => source.captureAlgorithmManifestHash));
  if (captureHashes.size !== 1) throw new Error("captured sources use multiple R5 Composition manifests");
}

function candidateCatalogHash(context: Record<string, unknown>): string {
  const catalog = object(context.referenceCatalog, "referenceCatalog");
  if (typeof catalog.hash !== "string" || !catalog.hash) throw new Error("reference catalog hash is missing");
  return catalog.hash;
}

function validateReference(source: RawBenchmarkSource, reference: RegeneratedActionCompilationReference): void {
  if (reference.fullyValidated !== true || reference.fullContextHash !== source.fullContextHash ||
    !Number.isSafeInteger(reference.providerRequests) || reference.providerRequests < 1) {
    throw new Error(`invalid FullCatalog regeneration for ${source.sourceInvocationId}`);
  }
  const candidateValues = object(source.fullContext.referenceCatalog, "referenceCatalog").candidates;
  if (!Array.isArray(candidateValues)) throw new Error("referenceCatalog.candidates must be an array");
  const candidates = new Map(candidateValues.map((value, index) => {
    const candidate = object(value, `referenceCatalog.candidates[${index}]`);
    return [String(candidate.candidateKey), candidate] as const;
  }));
  const slots = new Set(source.slotIndices);
  const seen = new Set<number>();
  for (const slot of reference.slots) {
    if (!slots.has(slot.slotIndex) || seen.has(slot.slotIndex)) throw new Error(`invalid regenerated slot ${slot.slotIndex}`);
    seen.add(slot.slotIndex);
    if (contentHash(slot.requiredCandidateKeys) !== contentHash([...new Set(slot.requiredCandidateKeys)].sort())) {
      throw new Error(`regenerated keys are not sorted and unique for slot ${slot.slotIndex}`);
    }
    for (const key of slot.requiredCandidateKeys) {
      const candidate = candidates.get(key);
      const scope = candidate ? object(candidate.scope ?? { kind: "shared" }, "candidate scope") : undefined;
      if (!candidate || !(scope!.kind === "shared" || scope!.kind === "slot" && scope!.slot === slot.slotIndex)) {
        throw new Error(`regenerated key ${key} is absent or private to another slot`);
      }
    }
  }
}

export function countValues(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}

export function mergeActionCompilationReferenceData(input: {
  base: ActionCompilationReferenceDataset;
  sources: readonly RawBenchmarkSource[];
  references: readonly RegeneratedActionCompilationReference[];
  version: number;
  startedAt: string;
  completedAt: string;
}): RefreshedReferenceData {
  if (input.sources.length === 0 || input.sources.length !== input.references.length) {
    throw new Error("reference refresh requires one regeneration result per captured source");
  }
  assertReferenceRefreshCompatibility(input.base, input.sources);
  const referenceHash = FULL_CATALOG_ALGORITHM_REF.manifestHash;
  const captureHash = input.sources[0]!.captureAlgorithmManifestHash;
  const contexts = new Map(input.base.contexts);
  const merged = new Map<string, Omit<ActionCompilationReferenceCase, "caseId">>();
  const add = (item: Omit<ActionCompilationReferenceCase, "caseId">) => {
    const key = `${item.contextHash}:${item.slotIndex}`;
    const current = merged.get(key);
    if (current && contentHash(current.requiredCandidateKeys) !== contentHash(item.requiredCandidateKeys)) {
      throw new Error(`conflicting FullCatalog labels for ${key}`);
    }
    if (!current) merged.set(key, item);
  };
  for (const item of input.base.cases) {
    add({
      ...structuredClone(item),
      stratum: "base-v1",
      source: {
        ...structuredClone(item.source),
        captureAlgorithmManifestHash: input.base.manifest.source.algorithmManifestHash!,
        referenceAlgorithmManifestHash: input.base.manifest.source.algorithmManifestHash!,
      },
    });
  }
  for (const [index, source] of input.sources.entries()) {
    const reference = input.references[index]!;
    validateReference(source, reference);
    const existingContext = contexts.get(source.fullContextHash);
    if (existingContext && contentHash(existingContext.context) !== source.fullContextHash) {
      throw new Error(`context hash collision: ${source.fullContextHash}`);
    }
    contexts.set(source.fullContextHash, {
      contextHash: source.fullContextHash,
      context: structuredClone(source.fullContext),
      source: {
        executionId: source.sourceExecutionId,
        invocationId: source.sourceInvocationId,
        catalogHash: source.candidateCatalogHash,
      },
    });
    for (const slot of reference.slots) {
      add({
        contextHash: source.fullContextHash,
        slotIndex: slot.slotIndex,
        batchSize: source.slotIndices.length,
        category: "runtime-action",
        stratum: "r5-captured",
        requiredCandidateKeys: slot.requiredCandidateKeys,
        source: {
          catalogHash: candidateCatalogHash(source.fullContext),
          worldHash: source.worldHash,
          algorithmManifestHash: referenceHash,
          captureAlgorithmManifestHash: source.captureAlgorithmManifestHash,
          referenceAlgorithmManifestHash: referenceHash,
        },
        provenance: {
          sourceExecutionId: source.sourceExecutionId,
          sourceInvocationId: source.sourceInvocationId,
          repairCount: slot.repairCount,
          rawOutputHash: slot.rawOutputHash,
          normalizedOutputHash: slot.normalizedOutputHash,
        },
      });
    }
  }
  const cases = [...merged.values()]
    .sort((left, right) => left.contextHash.localeCompare(right.contextHash) || left.slotIndex - right.slotIndex)
    .map((item, index) => ({ ...item, caseId: `ac-c3-v${input.version}-${String(index + 1).padStart(6, "0")}` }));
  const contextRecords = [...contexts.values()].sort((left, right) => left.contextHash.localeCompare(right.contextHash));
  const sourceGroups = new Map<string, NonNullable<ActionCompilationReferenceDatasetManifest["lineage"]>["sourceGroups"][number]>();
  const groupMembers = new Map<string, Set<string>>();
  sourceGroups.set("base-v1", {
    id: "base-v1",
    stratum: "base-v1",
    captureAlgorithmManifestHash: input.base.manifest.source.algorithmManifestHash!,
    referenceAlgorithmManifestHash: input.base.manifest.source.algorithmManifestHash!,
    sourceExecutionIds: input.base.manifest.export?.sourceExecutionIds ?? [],
    initialStateHashes: [input.base.manifest.source.initialStateHash],
    cases: cases.filter((item) => item.stratum === "base-v1").length,
  });
  for (const source of input.sources) {
    const id = `r5-${source.captureAlgorithmManifestHash.slice(0, 8)}-${source.stateHash.slice(0, 8)}`;
    const group = sourceGroups.get(id) ?? {
      id,
      stratum: "r5-captured" as const,
      captureAlgorithmManifestHash: source.captureAlgorithmManifestHash,
      referenceAlgorithmManifestHash: referenceHash,
      sourceExecutionIds: [],
      initialStateHashes: [source.stateHash],
      cases: 0,
    };
    group.sourceExecutionIds = [...new Set([...group.sourceExecutionIds, source.sourceExecutionId])].sort();
    const members = groupMembers.get(id) ?? new Set<string>();
    members.add(`${source.sourceExecutionId}:${source.sourceInvocationId}`);
    groupMembers.set(id, members);
    sourceGroups.set(id, group);
  }
  for (const [id, members] of groupMembers) {
    const group = sourceGroups.get(id)!;
    group.cases = cases.filter((item) => item.stratum === "r5-captured" && members.has(
      `${item.provenance?.sourceExecutionId ?? ""}:${item.provenance?.sourceInvocationId ?? ""}`,
    )).length;
  }
  const providerRequests = input.references.reduce((sum, reference) => sum + reference.providerRequests, 0);
  const repairCalls = input.references.reduce((sum, reference) =>
    sum + reference.slots.reduce((slotSum, slot) => slotSum + slot.repairCount, 0), 0);
  const { algorithmManifestHash: _legacyAlgorithmHash, ...baseSource } = input.base.manifest.source;
  const manifest: Omit<ActionCompilationReferenceDatasetManifest, "artifacts"> = {
    schemaVersion: ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION_V2,
    kind: ACTION_COMPILATION_REFERENCE_DATASET_KIND,
    datasetId: "action-compilation/fullcatalog-stabilized",
    version: input.version,
    status: "frozen",
    organization: "上海创智学院",
    project: "Living World Engine",
    purpose: "candidate-retrieval-recall",
    referenceSemantics: "behavioral-reference",
    semanticGroundTruth: false,
    source: {
      ...baseSource,
      captureAlgorithmManifestHash: captureHash,
      referenceAlgorithmManifestHash: referenceHash,
      semanticRepairAttempts: Math.max(...cases.map((item) => item.provenance?.repairCount ?? 0), 0),
    },
    lineage: {
      baseDatasets: [{
        datasetId: input.base.manifest.datasetId,
        version: input.base.manifest.version,
        manifestHash: contentHash(input.base.manifest),
        cases: input.base.cases.length,
      }],
      sourceGroups: [...sourceGroups.values()].sort((left, right) => left.id.localeCompare(right.id)),
    },
    generation: {
      seed: 0,
      targetCases: cases.length,
      maxProviderRequests: providerRequests,
      providerRequests,
      logicalInvocations: input.sources.length,
      transportAttempts: providerRequests,
      repairCalls,
      acceptedSlots: cases.length,
      rejectedSlots: input.sources.reduce((sum, source) => sum + source.slotIndices.length, 0) -
        input.references.reduce((sum, reference) => sum + reference.slots.length, 0),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
    counts: {
      cases: cases.length,
      contexts: contextRecords.length,
      nonEmptyRequiredCases: cases.filter((item) => item.requiredCandidateKeys.length > 0).length,
      emptyRequiredCases: cases.filter((item) => item.requiredCandidateKeys.length === 0).length,
    },
    distributions: {
      batchSizes: countValues(cases.map((item) => String(item.batchSize))),
      categories: countValues(cases.map((item) => item.category ?? "uncategorized")),
      requiredKeyCardinality: countValues(cases.map((item) => String(item.requiredCandidateKeys.length))),
      repairCounts: countValues(cases.map((item) => String(item.provenance?.repairCount ?? 0))),
    },
  };
  void _legacyAlgorithmHash;
  const seeds = cases.map((item) => ({
    caseId: item.caseId,
    stratum: item.stratum,
    contextHash: item.contextHash,
    slotIndex: item.slotIndex,
    sourceExecutionId: item.provenance?.sourceExecutionId ?? null,
    sourceInvocationId: item.provenance?.sourceInvocationId ?? null,
  }));
  return { contexts: contextRecords, cases, manifest, seeds };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeArtifact(root: string, file: string, records: readonly unknown[]): BenchmarkArtifactShard {
  const encoded = encodedShard(records);
  writeFileSync(path.join(root, file), encoded.buffer);
  return {
    file,
    sha256: sha256(encoded.buffer),
    records: records.length,
    rawBytes: encoded.rawBytes,
    compressedBytes: encoded.buffer.byteLength,
  };
}

export function publishActionCompilationReferenceData(
  refreshed: RefreshedReferenceData,
  targetInput: string,
): ActionCompilationReferenceDataset {
  const target = path.resolve(targetInput);
  if (existsSync(target)) throw new Error(`frozen dataset output already exists: ${target}`);
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, `.${path.basename(target)}-staging-`));
  let published = false;
  try {
    const artifacts = {
      seeds: [writeArtifact(staging, "seeds-000.jsonl.gz", refreshed.seeds)],
      contexts: [writeArtifact(staging, "contexts-000.jsonl.gz", refreshed.contexts)],
      cases: [writeArtifact(staging, "cases-000.jsonl.gz", refreshed.cases)],
    };
    const manifest: ActionCompilationReferenceDatasetManifest = { ...refreshed.manifest, artifacts };
    writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(canonicalize(manifest), null, 2)}\n`, "utf8");
    const baseCases = manifest.lineage?.baseDatasets.reduce((sum, base) => sum + base.cases, 0) ?? 0;
    writeFileSync(path.join(staging, "README.md"), `# FullCatalog stabilized behavior v${manifest.version}\n\nImmutable schema-v2 dataset combining ${baseCases} base-v1 cases with manually selected R5 captures relabeled by the real FullCatalog Action Compilation path. This is behavioral reference data, not semantic ground truth.\n`, "utf8");
    const verified = loadActionCompilationReferenceDataset(staging);
    if (verified.cases.length !== refreshed.cases.length || verified.contexts.size !== refreshed.contexts.length) {
      throw new Error("staging verification counts do not match refresh output");
    }
    renameSync(staging, target);
    published = true;
    return { ...verified, root: target };
  } finally {
    if (!published) rmSync(staging, { recursive: true, force: true });
  }
}
