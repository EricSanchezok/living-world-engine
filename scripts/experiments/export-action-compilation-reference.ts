import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACTION_COMPILATION_REFERENCE_DATASET_KIND,
  ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION,
  encodedShard,
  loadActionCompilationReferenceDataset,
  type ActionCompilationReferenceDatasetManifest,
} from "../../src/engine/benchmarks/action-compilation/stabilized-behavior";
import {
  exportActionCompilationFromLedger,
  type LedgerActionCompilationSource,
} from "../../src/engine/benchmarks/action-compilation/ledger-export";
import { LocalDatabase } from "../../src/server/local-database";
import type { RuntimeEvent } from "../../src/engine/runtime/observability";
import { FULL_CATALOG_ALGORITHM_REF } from "../../src/engine/algorithms/registry";

interface Options {
  database: string;
  executionIds: string[];
  instanceId?: string;
  output: string;
  version: number;
  dryRun: boolean;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function usage(): string {
  return `Usage: npm run benchmark:export:action-compilation-reference -- [options]

Options:
  --database <sqlite>       Ledger database (default: $LIVINGWORLD_DATA_ROOT/livingworld.sqlite)
  --execution <id>          Export one execution; may be repeated
  --instance <id>           Export all Action Compilation executions for an instance
  --output <directory>      Dataset output (default: benchmarks/.../v<version>)
  --version <n>             Dataset version (default: 1)
  --dry-run                 Read and validate without writing artifacts
  --help
`;
}

function parseOptions(argv: readonly string[]): Options {
  const executionIds: string[] = [];
  let database = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23", "livingworld.sqlite");
  let instanceId: string | undefined;
  let version = 1;
  let output: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--database") database = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--execution") executionIds.push(requiredValue(argv, ++index, argument));
    else if (argument === "--instance") instanceId = requiredValue(argv, ++index, argument);
    else if (argument === "--version") version = positiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--output") output = path.resolve(requiredValue(argv, ++index, argument));
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--help" || argument === "-h") throw new Error(usage());
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (executionIds.length > 0 && instanceId) throw new Error("--execution and --instance are mutually exclusive");
  if (executionIds.length === 0 && !instanceId) throw new Error("provide at least one --execution or an --instance");
  return {
    database,
    executionIds: [...new Set(executionIds)],
    ...(instanceId ? { instanceId } : {}),
    output: output ?? path.resolve(`benchmarks/action-compilation/fullcatalog-stabilized/v${version}`),
    version,
    dryRun,
  };
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeShards(root: string, prefix: string, records: readonly unknown[], size = 50) {
  const shards: Array<{
    file: string;
    sha256: string;
    records: number;
    rawBytes: number;
    compressedBytes: number;
  }> = [];
  for (let offset = 0, index = 0; offset < records.length; offset += size, index += 1) {
    const slice = records.slice(offset, offset + size);
    const encoded = encodedShard(slice);
    const file = `${prefix}-${String(index).padStart(3, "0")}.jsonl.gz`;
    writeFileSync(path.join(root, file), encoded.buffer);
    shards.push({
      file,
      sha256: sha256(encoded.buffer),
      records: slice.length,
      rawBytes: encoded.rawBytes,
      compressedBytes: encoded.buffer.byteLength,
    });
  }
  return shards;
}

function ensureNoSecrets(value: unknown): void {
  const sensitiveKey = /^(?:authorization|proxy-authorization|api[_-]?key|x-api-key|cookie|set-cookie|access-token|refresh-token|client-secret)$/iu;
  const bearerValue = /^bearer\s+[A-Za-z0-9._~+/=-]+$/u;
  const visit = (current: unknown, parentKey?: string): boolean => {
    if (Array.isArray(current)) return current.some((item) => visit(item, parentKey));
    if (!current || typeof current !== "object") {
      return typeof current === "string" && (bearerValue.test(current) || Boolean(parentKey && sensitiveKey.test(parentKey)));
    }
    return Object.entries(current).some(([key, child]) => sensitiveKey.test(key) || visit(child, key));
  };
  if (visit(value)) throw new Error("export contains a credential-like field");
}

function registryEntry(version: number, output: string): Record<string, unknown> {
  return {
    datasetId: "action-compilation/fullcatalog-stabilized",
    version,
    domain: "candidate-retrieval-recall",
    purpose: "Compare shortlist retrievers with the production Action Compilation C3 FullCatalog behavior.",
    status: "frozen",
    path: path.relative(process.cwd(), output),
    source: "Action Compilation C3 Ledger export",
    exporter: "npm run benchmark:export:action-compilation-reference -- --execution <id> --version <n>",
    evaluator: "npm run benchmark:evaluate:action-compilation-reference -- --dataset <path> --retriever <module>",
    maintainer: "Living World Engine team",
    notes: "Immutable behavioral reference; export reads recorded Ledger evidence and does not call a provider.",
  };
}

function updateRegistry(version: number, output: string): void {
  const file = path.resolve("benchmarks/registry.json");
  const registry = JSON.parse(readFileSync(file, "utf8")) as {
    benchmarks?: Array<Record<string, unknown>>;
  };
  const benchmarks = registry.benchmarks ?? [];
  const index = benchmarks.findIndex((entry) => entry.datasetId === "action-compilation/fullcatalog-stabilized" && entry.version === version);
  const entry = registryEntry(version, output);
  if (index >= 0) benchmarks[index] = entry;
  else benchmarks.push(entry);
  benchmarks.sort((left, right) => Number(left.version) - Number(right.version));
  registry.benchmarks = benchmarks;
  writeFileSync(file, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

function datasetReadme(version: number, result: ReturnType<typeof exportActionCompilationFromLedger>): string {
  return `# FullCatalog C3 stabilized behavior v${version}

This frozen dataset was exported from the Living World Engine Ledger. It is a behavioral reference to the production Action Compilation C3 FullCatalog path, not absolute semantic ground truth.

- Cases: ${result.cases.length}
- Deduplicated contexts: ${result.contexts.length}
- Source executions: ${result.stats.sourceExecutionIds.join(", ")}
- Provider requests during export: 0
- Provider requests observed in source executions: ${result.stats.providerRequests}

Each case is a slot-level output pair. The complete C3 context is stored once by ` + "`contextHash`" + ` and the final resolved ` + "`requiredCandidateKeys`" + ` are sorted and deduplicated.

Frozen versions are immutable. Export new Ledger evidence into the next dataset version instead of overwriting this directory.
`;
}

function manifestFor(
  version: number,
  result: ReturnType<typeof exportActionCompilationFromLedger>,
  sources: readonly LedgerActionCompilationSource[],
  artifacts: ActionCompilationReferenceDatasetManifest["artifacts"],
  startedAt: string,
  completedAt: string,
): ActionCompilationReferenceDatasetManifest {
  const first = sources[0]!.execution;
  const repairCounts = result.cases.reduce<Record<string, number>>((counts, item) => {
    const key = String(item.provenance?.repairCount ?? 0);
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  const distributions = {
    batchSizes: result.cases.reduce<Record<string, number>>((counts, item) => {
      const key = String(item.batchSize);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    categories: result.cases.reduce<Record<string, number>>((counts, item) => {
      const key = item.category ?? "uncategorized";
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    requiredKeyCardinality: result.cases.reduce<Record<string, number>>((counts, item) => {
      const key = String(item.requiredCandidateKeys.length);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {}),
    repairCounts,
  };
  const observed = result.stats;
  return {
    schemaVersion: ACTION_COMPILATION_REFERENCE_DATASET_SCHEMA_VERSION,
    kind: ACTION_COMPILATION_REFERENCE_DATASET_KIND,
    datasetId: "action-compilation/fullcatalog-stabilized",
    version,
    status: "frozen",
    organization: "上海创智学院",
    project: "Living World Engine",
    purpose: "candidate-retrieval-recall",
    referenceSemantics: "behavioral-reference",
    semanticGroundTruth: false,
    source: {
      baseline: "C3",
      worldId: result.source.worldId,
      worldHash: result.source.worldHash,
      initialStateHash: result.source.initialStateHash,
      modelCatalogHash: result.source.modelCatalogHash,
      registrySnapshotHash: result.source.registrySnapshotHash,
      profileId: result.source.profileId,
      modelId: result.source.modelId,
      algorithmManifestHash: result.source.algorithmManifestHash,
      promptVersion: result.source.promptVersion,
      candidateKeyVersion: result.source.candidateKeyVersion,
      symbolRepairPolicyVersion: result.source.symbolRepairPolicyVersion,
      semanticRepairAttempts: Math.max(...result.cases.map((item) => item.provenance?.repairCount ?? 0), 0),
    },
    generation: {
      seed: first.seed,
      targetCases: result.cases.length,
      maxProviderRequests: 0,
      providerRequests: 0,
      logicalInvocations: 0,
      transportAttempts: 0,
      repairCalls: 0,
      acceptedSlots: result.cases.length,
      rejectedSlots: observed.rejectedSlots,
      startedAt,
      completedAt,
    },
    export: {
      mode: "ledger",
      sourceExecutionIds: observed.sourceExecutionIds,
      exportedAt: completedAt,
      observedProviderRequests: observed.providerRequests,
      observedTransportAttempts: observed.transportAttempts,
      observedLogicalInvocations: observed.logicalInvocations,
      observedRepairCalls: observed.repairCalls,
      observedAcceptedSlots: observed.acceptedSlots,
      observedRejectedSlots: observed.rejectedSlots,
    },
    counts: {
      cases: result.cases.length,
      contexts: result.contexts.length,
      nonEmptyRequiredCases: result.cases.filter((item) => item.requiredCandidateKeys.length > 0).length,
      emptyRequiredCases: result.cases.filter((item) => item.requiredCandidateKeys.length === 0).length,
    },
    artifacts,
    distributions,
  };
}

function executionHasActionCompilation(events: readonly RuntimeEvent[]): boolean {
  return events.some((event) => event.event === "model.action_compilation.references" &&
    event.correlation?.modelRole === "action-compilation");
}

export function executionUsesFullCatalog(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const root = manifest as { kind?: unknown; children?: unknown };
  if (root.kind !== "algorithm" || !root.children || typeof root.children !== "object" || Array.isArray(root.children)) return false;
  const actionCompilation = (root.children as Record<string, unknown>).actionCompilation;
  if (!actionCompilation || typeof actionCompilation !== "object" || Array.isArray(actionCompilation)) return false;
  const children = (actionCompilation as { children?: unknown }).children;
  if (!children || typeof children !== "object" || Array.isArray(children)) return false;
  const candidateSelection = (children as Record<string, unknown>).candidateSelection;
  return Boolean(candidateSelection && typeof candidateSelection === "object" && !Array.isArray(candidateSelection) &&
    (candidateSelection as { manifestHash?: unknown }).manifestHash ===
      FULL_CATALOG_ALGORITHM_REF.children.actionCompilation!.children.candidateSelection!.manifestHash);
}

function main(argv: readonly string[]): number {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("Usage:")) {
      process.stdout.write(`${message}\n`);
      return 0;
    }
    process.stderr.write(`${message}\n`);
    return 2;
  }
  const database = new LocalDatabase(options.database, { readOnly: true, heartbeat: false });
  try {
    const ids = options.instanceId
      ? database.executions({ instanceId: options.instanceId }).filter((execution) => executionHasActionCompilation(database.executionEvents(execution.id))).map((execution) => execution.id)
      : options.executionIds;
    if (ids.length === 0) throw new Error("selected scope contains no Action Compilation evidence");
    const sources: LedgerActionCompilationSource[] = ids.map((id) => {
      const execution = database.execution(id);
      if (!execution) throw new Error(`execution not found: ${id}`);
      const events = database.executionEvents(id);
      if (!executionHasActionCompilation(events)) throw new Error(`execution has no Action Compilation evidence: ${id}`);
      if (!executionUsesFullCatalog(execution.manifest)) {
        throw new Error(`execution ${id} was not produced by FullCatalog; use benchmark:refresh:action-compilation-reference to capture and regenerate reference labels`);
      }
      return { execution, events };
    });
    const result = exportActionCompilationFromLedger(sources, options.version);
    const startedAt = sources.map((source) => source.execution.startedAt).sort()[0] ?? new Date().toISOString();
    const completedAt = new Date().toISOString();
    const outputSummary = {
      dataset: options.output,
      version: options.version,
      cases: result.cases.length,
      contexts: result.contexts.length,
      sourceExecutions: result.stats.sourceExecutionIds,
      providerRequestsDuringExport: 0,
      observedSourceProviderRequests: result.stats.providerRequests,
      observedSourceTransportAttempts: result.stats.transportAttempts,
      observedSourceLogicalInvocations: result.stats.logicalInvocations,
      observedSourceRepairCalls: result.stats.repairCalls,
      acceptedSlots: result.stats.acceptedSlots,
      rejectedSlots: result.stats.rejectedSlots,
      dryRun: options.dryRun,
    };
    if (options.dryRun) {
      process.stdout.write(`${JSON.stringify(outputSummary, null, 2)}\n`);
      return 0;
    }
    if (existsSync(options.output)) throw new Error(`refusing to overwrite existing dataset: ${options.output}`);
    mkdirSync(path.dirname(options.output), { recursive: true });
    const staging = mkdtempSync(path.join(path.dirname(options.output), `.v${options.version}-export-`));
    let published = false;
    try {
      const contextRecords = result.contexts;
      const cases = result.cases.map((item) => {
        const { actionId, ...record } = item;
        void actionId;
        return record;
      });
      const seeds = result.cases.map((item) => ({
        caseId: item.caseId,
        sourceExecutionId: item.provenance?.sourceExecutionId ?? null,
        sourceInvocationId: item.provenance?.sourceInvocationId ?? null,
        actionId: item.actionId,
        category: item.category ?? "runtime-action",
        slotIndex: item.slotIndex,
        batchSize: item.batchSize,
      }));
      const artifacts = {
        seeds: writeShards(staging, "seeds", seeds),
        contexts: writeShards(staging, "contexts", contextRecords),
        cases: writeShards(staging, "cases", cases),
      };
      const manifest = manifestFor(options.version, result, sources, artifacts, startedAt, completedAt);
      ensureNoSecrets({ manifest, contextRecords, cases, seeds });
      writeFileSync(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      writeFileSync(path.join(staging, "README.md"), datasetReadme(options.version, result), "utf8");
      const verified = loadActionCompilationReferenceDataset(staging);
      if (verified.cases.length !== result.cases.length || verified.contexts.size !== result.contexts.length) {
        throw new Error("post-export dataset count verification failed");
      }
      renameSync(staging, options.output);
      published = true;
      updateRegistry(options.version, options.output);
      process.stdout.write(`${JSON.stringify(outputSummary, null, 2)}\n`);
      return 0;
    } finally {
      if (!published) rmSync(staging, { recursive: true, force: true });
    }
  } catch (error) {
    process.stderr.write(`benchmark export failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
