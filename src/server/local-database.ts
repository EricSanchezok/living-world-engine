import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { JsonBlockStore } from "./json-block-store";
import Database from "better-sqlite3";
import { canonicalize, contentHash } from "../engine/models/model-audit";
import { attachExecutionRef } from "../engine/runtime/canonical-committer";
import type { ModelCatalog } from "../engine/models/model-catalog";
import {
  validateExecutionProducerManifest,
} from "../engine/runtime/execution";
import {
  NOOP_RUNTIME_OBSERVER,
  materializeRuntimeEvent,
  redactRuntimePayload,
  runtimeEventEmitter,
  serializeRuntimeError,
  type RuntimeCorrelation,
  type RuntimeError,
  type RuntimeObserver,
  type RuntimeEvent,
  type RuntimeEventInput,
} from "../engine/runtime/observability";
import type { ExecutionTraceWriter } from "../engine/runtime/execution";
import { createCoreRulePackageRegistry, type RulePackageRegistry } from "../engine/mechanics/rule-package";
import { buildWorldDefinition, hashWorldTemplate, parseWorldTemplate } from "../script/world-loader";
import type { WorldCatalogEntry, WorldRepository } from "../script/world-repository";
import { parseWorldArchive, WorldImportError, type WorldImportResult } from "./world-import";
import {
  validateWorldInstanceDocument,
  WorldInstanceConflictError,
  WorldInstanceNotFoundError,
  type WorldInstanceStore,
} from "./world-instance-store";
import type { StoredWorldInstance, WorldInstanceDocument } from "./world-instance-types";
import type {
  BeginExecutionInput,
  ExecutionArtifactRecord,
  ExecutionLedger,
  ExecutionRecord,
  FinishExecutionInput,
} from "./execution-ledger";
import {
  DEBUG_API_VERSION,
  DEBUG_INDEX_VERSION,
  type DebugArtifact,
  type DebugDiagnostic,
  type DebugDoctorReport,
  type DebugEventSummary,
  type DebugInspection,
  type DebugInvocationSummary,
  type DebugLineageRef,
  type DebugQuery,
  type DebugSearchResult,
} from "../shared/debug-api";
import {
  diagnosticCodeFor,
  diagnosticDefinition,
  publicDiagnostic,
} from "./debug-diagnostics";
import { currentRuntimeCorrelation } from "./request-context";

const INSTANCE_HEARTBEAT_MS = 5_000;
const INSTANCE_LEASE_MS = 15_000;
const VALIDATED_INSTANCE_CACHE_LIMIT = 8;
const MAX_PENDING_EXECUTION_EVENTS = 64;
const EXECUTION_ROOT_EVENTS = new Set([
  "benchmark.matrix.started",
  "instance.bootstrap.started",
  "step.started",
]);

function executionError(value: unknown): RuntimeError {
  if (value instanceof Error) return serializeRuntimeError(value);
  if (value && typeof value === "object") {
    const candidate = value as Partial<RuntimeError>;
    if (typeof candidate.name === "string" && typeof candidate.message === "string") {
      return structuredClone(candidate as RuntimeError);
    }
  }
  return serializeRuntimeError(value);
}

interface LocalDatabaseOptions {
  ownerId?: string;
  now?: () => number;
  heartbeat?: boolean;
  /** Open the Ledger without migrations, recovery, or the singleton writer lease. */
  readOnly?: boolean;
  isProcessAlive?: (pid: number) => boolean;
  rulePackages?: RulePackageRegistry;
  observer?: RuntimeObserver;
}

interface WorldRow {
  id: string;
  name: string;
  version: string;
  content_hash: string;
  description: string;
  template_json: string;
}

interface InstanceRow {
  generation: number;
  document_hash: string;
}

interface ListedInstanceRow extends InstanceRow {
  id: string;
}

interface ValidatedInstanceCacheEntry {
  generation: number;
  documentHash: string;
  documentUtf8Bytes: number;
  document: WorldInstanceDocument;
}

interface LockRow {
  owner_id: string;
  pid: number;
  expires_at: number;
}

interface ExecutionRow {
  id: string;
  kind: BeginExecutionInput["kind"];
  parent_execution_id: string | null;
  instance_id: string | null;
  advance_id: string | null;
  step: number | null;
  manifest_json: string;
  world_hash: string;
  code_revision: string;
  code_dirty: number;
  model_catalog_hash: string;
  seed: number;
  runtime_config_json: string;
  status: ExecutionRecord["status"];
  trace_id: string;
  semantic_hash: string | null;
  state_hash: string | null;
  commit_revision: number | null;
  terminal_event_sequence: number | null;
  trace_hash: string | null;
  error_artifact_hash: string | null;
  started_at: string;
  finished_at: string | null;
}

interface ExecutionEventRow {
  sequence: number;
  event_json: string;
  artifact_hash: string | null;
}

interface ExecutionArtifactRow {
  hash: string;
  execution_id: string;
  kind: string;
  media_type: string;
  encoding: "json-blocks";
  raw_bytes: number;
  stored_bytes: number;
  root_hash: string;
  created_at: string;
}

interface DebugEventIndexRow {
  sequence: number;
  execution_id: string;
  instance_id: string | null;
  timestamp: string;
  event_name: string;
  level: string;
  phase: string | null;
  component: string | null;
  operation: string | null;
  request_id: string | null;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  model_invocation_id: string | null;
  logical_invocation_id: string | null;
  parent_invocation_id: string | null;
  repair_of: string | null;
  model_role: string | null;
  model_subject: string | null;
  transport_attempt: number | null;
  provider_id: string | null;
  profile_id: string | null;
  model_id: string | null;
  artifact_hash: string | null;
  diagnostic_code: string | null;
  has_payload: number;
}

interface DebugInvocationIndexRow {
  id: string;
  execution_id: string;
  instance_id: string | null;
  source_invocation_id: string;
  logical_invocation_id: string | null;
  parent_invocation_id: string | null;
  repair_of: string | null;
  role: string | null;
  subject_id: string | null;
  provider_id: string | null;
  profile_id: string | null;
  model_id: string | null;
  status: "active" | "accepted" | "rejected" | "failed";
  first_sequence: number;
  last_sequence: number;
  event_count: number;
  retry_count: number;
  issue_codes_json: string;
  artifact_hashes_json: string;
  started_at: string | null;
  finished_at: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function publicInvocationId(executionId: string, sourceInvocationId: string): string {
  return `${executionId}::${sourceInvocationId}`;
}

function debugInvocationStatus(events: readonly DebugEventIndexRow[]): DebugInvocationSummary["status"] {
  if (events.some((event) => event.event_name === "model.semantic.rejected" || event.event_name === "model.structured_output.rejected")) {
    return "rejected";
  }
  if (events.some((event) => event.event_name === "model.invocation.failed" || event.event_name === "model.transport.failed")) {
    return "failed";
  }
  if (events.some((event) => event.event_name === "model.semantic.accepted" || event.event_name === "model.structured_output.parsed")) {
    return "accepted";
  }
  return "active";
}

class LocalExecutionTraceWriter implements ExecutionTraceWriter {
  readonly mode = "full" as const;
  readonly degraded = false;
  readonly critical = true;
  private readonly pendingEvents: RuntimeEventInput[] = [];

  constructor(
    private readonly ledger: ExecutionLedger,
    readonly executionId: string,
    readonly traceId: string,
    private readonly parentLink?: { traceId: string; spanId: string },
  ) {}

  private rootSpanId(): string {
    return this.traceId.slice(0, 16);
  }

  private phaseSpanId(phase: string): string {
    return contentHash({ executionId: this.executionId, phase }).slice(0, 16);
  }

  private spanId(input: RuntimeEventInput): string {
    const correlation = input.correlation;
    if (correlation?.transportAttempt !== undefined && correlation.modelInvocationId) {
      return contentHash({
        executionId: this.executionId,
        invocation: correlation.modelInvocationId,
        transportAttempt: correlation.transportAttempt,
      }).slice(0, 16);
    }
    if (correlation?.modelInvocationId) {
      return contentHash({ executionId: this.executionId, invocation: correlation.modelInvocationId }).slice(0, 16);
    }
    if (EXECUTION_ROOT_EVENTS.has(input.event)) return this.rootSpanId();
    return contentHash({
      executionId: this.executionId,
      phase: input.attributes?.phase ?? input.event.split(".").slice(0, 2).join("."),
    }).slice(0, 16);
  }

  private parentSpanId(input: RuntimeEventInput, spanId = this.spanId(input)): string | undefined {
    const correlation = input.correlation;
    if (correlation?.transportAttempt !== undefined && correlation.modelInvocationId) {
      return contentHash({ executionId: this.executionId, invocation: correlation.modelInvocationId }).slice(0, 16);
    }
    if (correlation?.modelInvocationId) {
      return this.phaseSpanId(correlation.step === 0 ? "bootstrap" : "step");
    }
    const rootSpanId = this.rootSpanId();
    return spanId === rootSpanId ? undefined : rootSpanId;
  }

  emit(input: RuntimeEventInput): RuntimeEvent | undefined {
    const spanId = input.spanId ?? this.spanId(input);
    const inheritedCorrelation = currentRuntimeCorrelation();
    this.pendingEvents.push(structuredClone({
      ...input,
      traceId: input.traceId ?? this.traceId,
      spanId,
      parentSpanId: input.parentSpanId ?? this.parentSpanId(input, spanId),
      links: input.links ?? (spanId === this.rootSpanId() && this.parentLink ? [this.parentLink] : undefined),
      correlation: { ...inheritedCorrelation, ...input.correlation, executionId: this.executionId },
    }));
    if (this.pendingEvents.length < MAX_PENDING_EXECUTION_EVENTS) return undefined;
    return this.flushEvents().at(-1);
  }

  private flushEvents(): RuntimeEvent[] {
    if (this.pendingEvents.length === 0) return [];
    const batch = this.pendingEvents.splice(0);
    try {
      return this.ledger.appendExecutionEvents(this.executionId, batch);
    } catch (error) {
      this.pendingEvents.unshift(...batch);
      throw error;
    }
  }

  flush(): void {
    this.flushEvents();
  }

  artifact(kind: string, value: unknown): string {
    this.flush();
    return this.ledger.putExecutionArtifact(this.executionId, kind, value);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.ledger.subscribe(listener);
  }
}

export class LocalDatabaseInUseError extends Error {
  constructor(file: string) {
    super(`local database is already owned by another Living World Engine instance: ${file}`);
    this.name = "LocalDatabaseInUseError";
  }
}

export class LocalDatabaseReadOnlyError extends Error {
  constructor(file: string) {
    super(`local database is read-only: ${file}`);
    this.name = "LocalDatabaseReadOnlyError";
  }
}

function isLocalProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class LocalDatabase implements WorldRepository, WorldInstanceStore, ExecutionLedger {
  readonly created: boolean;
  readonly rulePackages: RulePackageRegistry;
  private readonly connection: Database.Database;
  private readonly blocks: JsonBlockStore;
  private dataVersion = 0;
  private readonly ownerId: string;
  private readonly readOnly: boolean;
  private readonly now: () => number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly heartbeatTimer?: NodeJS.Timeout;
  private readonly observer: RuntimeObserver;
  private readonly observe: ReturnType<typeof runtimeEventEmitter>;
  private readonly validatedInstances = new Map<string, ValidatedInstanceCacheEntry>();
  private readonly executionListeners = new Set<(event: RuntimeEvent) => void>();
  private readonly executionWriters = new Map<string, LocalExecutionTraceWriter>();
  private closed = false;

  constructor(readonly file: string, options: LocalDatabaseOptions = {}) {
    this.readOnly = options.readOnly === true;
    if (!this.readOnly) mkdirSync(path.dirname(file), { recursive: true });
    this.connection = new Database(file, {
      timeout: 5_000,
      ...(this.readOnly ? { readonly: true, fileMustExist: true } : {}),
    });
    this.blocks = new JsonBlockStore(this.connection);
    this.ownerId = options.ownerId ?? `${process.pid}:${randomUUID()}`;
    this.now = options.now ?? Date.now;
    this.isProcessAlive = options.isProcessAlive ?? isLocalProcessAlive;
    this.rulePackages = options.rulePackages ?? createCoreRulePackageRegistry();
    this.observer = options.observer ?? NOOP_RUNTIME_OBSERVER;
    this.observe = runtimeEventEmitter(this.observer);
    try {
      if (!this.readOnly) {
        this.connection.pragma("journal_mode = WAL");
        this.connection.pragma("synchronous = FULL");
        this.connection.pragma("foreign_keys = ON");
      } else {
        this.connection.pragma("query_only = ON");
      }
      this.connection.pragma("busy_timeout = 5000");
      if (!this.readOnly) {
        this.connection.pragma("trusted_schema = OFF");
        this.created = this.migrate();
        this.acquireInstanceLease();
        this.recoverInterruptedExecutions();
      } else {
        this.created = false;
        this.requireSchemaVersion();
      }
    } catch (error) {
      this.connection.close();
      throw error;
    }
    this.dataVersion = this.connection.pragma("data_version", { simple: true }) as number;
    if (!this.readOnly && options.heartbeat !== false) {
      this.heartbeatTimer = setInterval(() => this.renewInstanceLease(), INSTANCE_HEARTBEAT_MS);
      this.heartbeatTimer.unref();
    }
  }

  private requireSchemaVersion(): void {
    const row = this.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
    if (row.version !== 9) throw new Error("local database schema v9 required; use a new LIVINGWORLD_DATA_ROOT");
  }

  private invalidateExternalChanges(): void {
    const version = this.connection.pragma("data_version", { simple: true }) as number;
    if (version !== this.dataVersion) this.validatedInstances.clear();
    this.dataVersion = version;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new LocalDatabaseReadOnlyError(this.file);
  }

  private cacheValidatedInstance(
    instanceId: string,
    generation: number,
    documentHash: string,
    document: WorldInstanceDocument,
  ): ValidatedInstanceCacheEntry {
    const entry = {
      generation,
      documentHash,
      documentUtf8Bytes: Buffer.byteLength(JSON.stringify(document), "utf8"),
      document: structuredClone(document),
    };
    this.validatedInstances.delete(instanceId);
    this.validatedInstances.set(instanceId, entry);
    while (this.validatedInstances.size > VALIDATED_INSTANCE_CACHE_LIMIT) {
      const oldestInstanceId = this.validatedInstances.keys().next().value;
      if (oldestInstanceId === undefined) break;
      this.validatedInstances.delete(oldestInstanceId);
    }
    return entry;
  }

  private cachedInstance(
    instanceId: string,
    row: InstanceRow,
    promote = true,
  ): ValidatedInstanceCacheEntry | undefined {
    const cached = this.validatedInstances.get(instanceId);
    if (!cached || cached.generation !== row.generation || cached.documentHash !== row.document_hash) {
      if (cached) this.validatedInstances.delete(instanceId);
      return undefined;
    }
    if (promote) {
      this.validatedInstances.delete(instanceId);
      this.validatedInstances.set(instanceId, cached);
    }
    return cached;
  }

  private observeCachedRead(
    instanceId: string,
    cached: ValidatedInstanceCacheEntry,
    startedAt: number,
    correlation?: RuntimeCorrelation,
  ): void {
    this.observe?.({
      event: "persistence.read.completed",
      correlation: { ...correlation, instanceId },
      durationMs: Math.max(0, Date.now() - startedAt),
      attributes: { sink: "sqlite", cacheHit: true },
      measurements: { documentUtf8Bytes: cached.documentUtf8Bytes },
      counts: {
        history: cached.document.state.history.length,
        participants: Object.keys(cached.document.participants).length,
      },
    });
  }

  private migrate(): boolean {
    return this.connection.transaction(() => {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        ) STRICT;
      `);
      const current = this.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get() as { version: number | null };
      const currentVersion = current.version ?? 0;
      if (currentVersion > 9) throw new Error("local database schema is newer than this application");
      if (currentVersion > 0 && currentVersion < 9) {
        throw new Error("local database schema is older than v9; use a new LIVINGWORLD_DATA_ROOT");
      }
      if (currentVersion === 0) this.connection.exec(`
        CREATE TABLE instance_lock (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          owner_id TEXT NOT NULL,
          pid INTEGER NOT NULL,
          acquired_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE world_versions (
          world_id TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          name TEXT NOT NULL,
          manifest_version TEXT NOT NULL,
          description TEXT NOT NULL,
          template_json TEXT NOT NULL,
          imported_at TEXT NOT NULL,
          PRIMARY KEY (world_id, content_hash)
        ) STRICT;
        CREATE TABLE world_catalog (
          world_id TEXT PRIMARY KEY,
          current_content_hash TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (world_id, current_content_hash)
            REFERENCES world_versions(world_id, content_hash)
        ) STRICT;
        CREATE TABLE executions (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('interactive', 'diagnostic', 'benchmark', 'replay')),
          parent_execution_id TEXT,
          instance_id TEXT,
          advance_id TEXT,
          step INTEGER,
          manifest_json TEXT NOT NULL,
          world_hash TEXT NOT NULL,
          code_revision TEXT NOT NULL,
          code_dirty INTEGER NOT NULL CHECK (code_dirty IN (0, 1)),
          model_catalog_hash TEXT NOT NULL,
          seed INTEGER NOT NULL,
          runtime_config_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          trace_id TEXT NOT NULL UNIQUE,
          semantic_hash TEXT,
          state_hash TEXT,
          commit_revision INTEGER,
          terminal_event_sequence INTEGER,
          trace_hash TEXT,
          error_artifact_hash TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          FOREIGN KEY (parent_execution_id) REFERENCES executions(id)
        ) STRICT;
        CREATE INDEX executions_instance_step ON executions(instance_id, step, started_at);
        CREATE INDEX executions_parent ON executions(parent_execution_id, started_at);
        CREATE TABLE json_blocks (
          hash TEXT PRIMARY KEY,
          body BLOB NOT NULL
        ) STRICT;
        CREATE TABLE execution_artifacts (
          hash TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          media_type TEXT NOT NULL,
          encoding TEXT NOT NULL CHECK (encoding = 'json-blocks'),
          raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0),
          stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
          root_hash TEXT NOT NULL REFERENCES json_blocks(hash),
          created_at TEXT NOT NULL,
          FOREIGN KEY (execution_id) REFERENCES executions(id)
        ) STRICT;
        CREATE TABLE execution_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          execution_id TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          parent_span_id TEXT,
          event_name TEXT NOT NULL,
          phase TEXT,
          level TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          duration_ms REAL,
          attributes_json TEXT NOT NULL,
          measurements_json TEXT NOT NULL,
          counts_json TEXT NOT NULL,
          hashes_json TEXT NOT NULL,
          links_json TEXT NOT NULL,
          correlation_json TEXT NOT NULL,
          artifact_hash TEXT,
          error_json TEXT,
          event_json TEXT NOT NULL,
          FOREIGN KEY (execution_id) REFERENCES executions(id),
          FOREIGN KEY (artifact_hash) REFERENCES execution_artifacts(hash)
        ) STRICT;
        CREATE INDEX execution_events_execution_sequence ON execution_events(execution_id, sequence);
        CREATE INDEX execution_events_instance ON execution_events(
          json_extract(correlation_json, '$.instanceId'), sequence
        );
        CREATE TABLE execution_event_index (
          sequence INTEGER PRIMARY KEY,
          execution_id TEXT NOT NULL,
          instance_id TEXT,
          timestamp TEXT NOT NULL,
          event_name TEXT NOT NULL,
          level TEXT NOT NULL,
          phase TEXT,
          component TEXT,
          operation TEXT,
          request_id TEXT,
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          parent_span_id TEXT,
          model_invocation_id TEXT,
          logical_invocation_id TEXT,
          parent_invocation_id TEXT,
          repair_of TEXT,
          model_role TEXT,
          model_subject TEXT,
          transport_attempt INTEGER,
          provider_id TEXT,
          profile_id TEXT,
          model_id TEXT,
          artifact_hash TEXT,
          diagnostic_code TEXT,
          has_payload INTEGER NOT NULL CHECK (has_payload IN (0, 1)),
          FOREIGN KEY (sequence) REFERENCES execution_events(sequence) ON DELETE CASCADE,
          FOREIGN KEY (execution_id) REFERENCES executions(id),
          FOREIGN KEY (artifact_hash) REFERENCES execution_artifacts(hash)
        ) STRICT;
        CREATE INDEX execution_event_index_invocation ON execution_event_index(model_invocation_id, execution_id, sequence);
        CREATE INDEX execution_event_index_request ON execution_event_index(request_id, sequence);
        CREATE INDEX execution_event_index_trace ON execution_event_index(trace_id, sequence);
        CREATE INDEX execution_event_index_execution ON execution_event_index(execution_id, sequence);
        CREATE INDEX execution_event_index_instance_time ON execution_event_index(instance_id, timestamp, sequence);
        CREATE INDEX execution_event_index_event_time ON execution_event_index(event_name, timestamp, sequence);
        CREATE INDEX execution_event_index_diagnostic ON execution_event_index(diagnostic_code, timestamp, sequence);
        CREATE INDEX execution_event_index_artifact ON execution_event_index(artifact_hash);
        CREATE TABLE execution_issue_index (
          execution_id TEXT NOT NULL,
          event_sequence INTEGER NOT NULL,
          code TEXT NOT NULL,
          issue_class TEXT,
          path_json TEXT NOT NULL,
          message TEXT,
          PRIMARY KEY (event_sequence, code, path_json),
          FOREIGN KEY (execution_id) REFERENCES executions(id),
          FOREIGN KEY (event_sequence) REFERENCES execution_events(sequence) ON DELETE CASCADE
        ) STRICT;
        CREATE INDEX execution_issue_index_code ON execution_issue_index(code, event_sequence);
        CREATE INDEX execution_issue_index_execution ON execution_issue_index(execution_id, code, event_sequence);
        CREATE TABLE execution_invocation_index (
          id TEXT PRIMARY KEY,
          execution_id TEXT NOT NULL,
          instance_id TEXT,
          source_invocation_id TEXT NOT NULL,
          logical_invocation_id TEXT,
          parent_invocation_id TEXT,
          repair_of TEXT,
          role TEXT,
          subject_id TEXT,
          provider_id TEXT,
          profile_id TEXT,
          model_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('active', 'accepted', 'rejected', 'failed')),
          first_sequence INTEGER NOT NULL,
          last_sequence INTEGER NOT NULL,
          event_count INTEGER NOT NULL,
          retry_count INTEGER NOT NULL,
          issue_codes_json TEXT NOT NULL,
          artifact_hashes_json TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT,
          FOREIGN KEY (execution_id) REFERENCES executions(id)
        ) STRICT;
        CREATE INDEX execution_invocation_index_execution ON execution_invocation_index(execution_id, first_sequence, id);
        CREATE INDEX execution_invocation_index_instance ON execution_invocation_index(instance_id, first_sequence, id);
        CREATE INDEX execution_invocation_index_status ON execution_invocation_index(status, first_sequence, id);
        CREATE INDEX execution_invocation_index_issue ON execution_invocation_index(issue_codes_json);
        CREATE TABLE debug_index_meta (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          version INTEGER NOT NULL,
          rebuilt_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE world_instances (
          id TEXT PRIMARY KEY,
          generation INTEGER NOT NULL CHECK (generation > 0),
          world_id TEXT NOT NULL,
          world_hash TEXT NOT NULL,
          document_hash TEXT NOT NULL REFERENCES json_blocks(hash),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX world_instances_world_version ON world_instances(world_id, world_hash);
        CREATE TABLE experiment_enrollment_stops (
          experiment_id TEXT NOT NULL,
          experiment_version TEXT NOT NULL,
          reason TEXT NOT NULL,
          stopped_at TEXT NOT NULL,
          PRIMARY KEY (experiment_id, experiment_version)
        ) STRICT;
      `);
      if (currentVersion === 0) {
        this.connection.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (9, ?)")
          .run(new Date(this.now()).toISOString());
        this.connection.prepare("INSERT INTO debug_index_meta(singleton, version, rebuilt_at) VALUES (1, ?, ?)")
          .run(DEBUG_INDEX_VERSION, new Date(this.now()).toISOString());
      }
      return currentVersion === 0;
    })();
  }

  readExperimentEnrollmentStop(experimentId: string, experimentVersion: string): string | undefined {
    const row = this.connection.prepare(`
      SELECT reason FROM experiment_enrollment_stops
      WHERE experiment_id = ? AND experiment_version = ?
    `).get(experimentId, experimentVersion) as { reason: string } | undefined;
    return row?.reason;
  }

  writeExperimentEnrollmentStop(experimentId: string, experimentVersion: string, reason: string): void {
    this.assertWritable();
    this.assertInstanceLease();
    if (!experimentId.trim() || !experimentVersion.trim() || !reason.trim()) {
      throw new Error("experiment enrollment stop requires id, version, and reason");
    }
    this.connection.prepare(`
      INSERT OR IGNORE INTO experiment_enrollment_stops(
        experiment_id, experiment_version, reason, stopped_at
      ) VALUES (?, ?, ?, ?)
    `).run(experimentId, experimentVersion, reason, new Date(this.now()).toISOString());
  }

  beginExecution(input: BeginExecutionInput): ExecutionTraceWriter {
    this.assertWritable();
    this.assertInstanceLease();
    validateExecutionProducerManifest(input.manifest);
    const traceId = randomUUID().replaceAll("-", "");
    const startedAt = input.startedAt ?? new Date(this.now()).toISOString();
    const parentTrace = input.parentExecutionId
      ? this.connection.prepare("SELECT trace_id FROM executions WHERE id = ?")
          .get(input.parentExecutionId) as { trace_id: string } | undefined
      : undefined;
    if (input.parentExecutionId && !parentTrace) {
      throw new Error(`parent execution not found: ${input.parentExecutionId}`);
    }
    this.connection.prepare(`
      INSERT INTO executions(
        id, kind, parent_execution_id, instance_id, advance_id, step, manifest_json,
        world_hash, code_revision, code_dirty, model_catalog_hash, seed,
        runtime_config_json, status, trace_id, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      input.id,
      input.kind,
      input.parentExecutionId ?? null,
      input.instanceId ?? null,
      input.advanceId ?? null,
      input.step ?? null,
      JSON.stringify(canonicalize(input.manifest)),
      input.worldHash,
      input.codeRevision,
      input.codeDirty ? 1 : 0,
      input.modelCatalogHash,
      input.seed,
      JSON.stringify(canonicalize(input.runtimeConfig)),
      traceId,
      startedAt,
    );
    const writer = new LocalExecutionTraceWriter(
      this,
      input.id,
      traceId,
      parentTrace ? { traceId: parentTrace.trace_id, spanId: parentTrace.trace_id.slice(0, 16) } : undefined,
    );
    this.executionWriters.set(input.id, writer);
    return writer;
  }

  private requireRunningExecution(executionId: string): { trace_id: string } {
    const execution = this.connection.prepare(
      "SELECT trace_id, status FROM executions WHERE id = ?",
    ).get(executionId) as { trace_id: string; status: string } | undefined;
    if (!execution) throw new Error(`execution not found: ${executionId}`);
    if (execution.status !== "running") throw new Error(`execution is already terminal: ${executionId}`);
    return { trace_id: execution.trace_id };
  }

  private persistExecutionArtifact(executionId: string, kind: string, value: unknown): string {
    if (!kind.trim()) throw new Error("execution artifact kind cannot be empty");
    const normalized = canonicalize(value);
    const stored = this.blocks.put(normalized);
    const hash = contentHash(normalized);
    this.connection.prepare(`
      INSERT OR IGNORE INTO execution_artifacts(
        hash, execution_id, kind, media_type, encoding, raw_bytes, stored_bytes, root_hash, created_at
      ) VALUES (?, ?, ?, 'application/json', 'json-blocks', ?, ?, ?, ?)
    `).run(hash, executionId, kind, stored.rawBytes, stored.writtenBytes, stored.hash, new Date(this.now()).toISOString());
    return hash;
  }

  putExecutionArtifact(executionId: string, kind: string, value: unknown): string {
    this.assertWritable();
    return this.connection.transaction(() => {
      this.assertInstanceLease();
      this.requireRunningExecution(executionId);
      return this.persistExecutionArtifact(executionId, kind, value);
    })();
  }

  appendExecutionEvent(executionId: string, input: RuntimeEventInput): RuntimeEvent {
    return this.appendExecutionEvents(executionId, [input])[0];
  }

  private persistExecutionEvents(executionId: string, inputs: readonly RuntimeEventInput[]): RuntimeEvent[] {
    this.assertInstanceLease();
    const execution = this.requireRunningExecution(executionId);
    const writeStartedAt = performance.now();
    const persistedEvents = inputs.map((input) => {
        const safeInput = redactRuntimePayload(input) as RuntimeEventInput;
        const artifactHash = safeInput.payload === undefined
          ? null
          : this.persistExecutionArtifact(executionId, `${safeInput.event}.payload`, safeInput.payload);
        const artifactSize = artifactHash
          ? this.connection.prepare("SELECT raw_bytes, stored_bytes FROM execution_artifacts WHERE hash = ?")
              .get(artifactHash) as { raw_bytes: number; stored_bytes: number }
          : undefined;
        const timestamp = new Date(this.now());
        const provisional = materializeRuntimeEvent({
          ...safeInput,
          payload: undefined,
          traceId: safeInput.traceId ?? execution.trace_id,
          spanId: safeInput.spanId ?? randomUUID().replaceAll("-", "").slice(0, 16),
          correlation: { ...safeInput.correlation, executionId },
        }, 0, timestamp, "full");
        const measurements = {
          ...provisional.measurements,
          ledgerArtifactRawBytes: artifactSize?.raw_bytes ?? 0,
          ledgerArtifactStoredBytes: artifactSize?.stored_bytes ?? 0,
          ledgerSqliteWriteMs: 0,
        };
        const persisted = { ...provisional, measurements };
        const result = this.connection.prepare(`
          INSERT INTO execution_events(
            execution_id, trace_id, span_id, parent_span_id, event_name, phase, level,
            timestamp, duration_ms, attributes_json, measurements_json, counts_json,
            hashes_json, links_json, correlation_json, artifact_hash, error_json, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          executionId,
          provisional.traceId,
          provisional.spanId,
          provisional.parentSpanId ?? null,
          provisional.event,
          typeof provisional.attributes?.phase === "string" ? provisional.attributes.phase : null,
          provisional.level,
          provisional.timestamp,
          provisional.durationMs ?? null,
          JSON.stringify(canonicalize(provisional.attributes ?? {})),
          JSON.stringify(canonicalize(measurements)),
          JSON.stringify(canonicalize(provisional.counts ?? {})),
          JSON.stringify(canonicalize(provisional.hashes ?? {})),
          JSON.stringify(canonicalize(provisional.links ?? [])),
          JSON.stringify(canonicalize(provisional.correlation ?? {})),
          artifactHash,
          provisional.error ? JSON.stringify(canonicalize(provisional.error)) : null,
          JSON.stringify(canonicalize(persisted)),
        );
        const sequence = Number(result.lastInsertRowid);
        this.indexRuntimeEvent(executionId, provisional, sequence, artifactHash, safeInput.payload);
        return {
          ...provisional,
          sequence,
          measurements,
          ...(safeInput.payload === undefined ? {} : { payload: structuredClone(safeInput.payload) }),
        } satisfies RuntimeEvent;
    });
    const lastEvent = persistedEvents.at(-1)!;
    const measurements = {
      ...lastEvent.measurements,
      ledgerSqliteWriteMs: Math.max(0, performance.now() - writeStartedAt),
    };
    const completed = { ...lastEvent, measurements };
    const result = this.connection.prepare(`
        UPDATE execution_events
        SET measurements_json = ?, event_json = ?
        WHERE sequence = ?
      `).run(
      JSON.stringify(canonicalize(measurements)),
      JSON.stringify(canonicalize({ ...completed, payload: undefined })),
      lastEvent.sequence,
    );
    if (result.changes !== 1) throw new Error("execution event batch measurement update failed");
    persistedEvents[persistedEvents.length - 1] = completed;
    this.refreshInvocationIndex(executionId);
    return persistedEvents;
  }

  private indexRuntimeEvent(
    executionId: string,
    event: RuntimeEvent,
    sequence: number,
    artifactHash: string | null,
    payload: unknown,
  ): void {
    const executionRow = this.connection.prepare("SELECT instance_id FROM executions WHERE id = ?")
      .get(executionId) as { instance_id: string | null } | undefined;
    const correlation = record(event.correlation);
    const attributes = record(event.attributes);
    const error = record(event.error);
    const diagnosticCode = stringValue(error.code) ??
      (event.level === "error" || event.event.includes("failed") || event.event.includes("rejected")
        ? diagnosticCodeFor(stringValue(error.name), event.event)
        : undefined);
    this.connection.prepare(`
      INSERT OR REPLACE INTO execution_event_index(
        sequence, execution_id, instance_id, timestamp, event_name, level, phase,
        component, operation, request_id, trace_id, span_id, parent_span_id,
        model_invocation_id, logical_invocation_id, parent_invocation_id, repair_of,
        model_role, model_subject, transport_attempt, provider_id, profile_id, model_id,
        artifact_hash, diagnostic_code, has_payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence,
      executionId,
      stringValue(correlation.instanceId) ?? executionRow?.instance_id ?? null,
      event.timestamp,
      event.event,
      event.level,
      stringValue(attributes.phase) ?? null,
      stringValue(correlation.component) ?? stringValue(attributes.component) ?? null,
      stringValue(correlation.operation) ?? stringValue(attributes.operation) ?? null,
      stringValue(correlation.requestId) ?? null,
      event.traceId ?? "",
      event.spanId ?? "",
      event.parentSpanId ?? null,
      stringValue(correlation.modelInvocationId) ?? null,
      stringValue(correlation.logicalInvocationId) ?? null,
      stringValue(correlation.parentInvocationId) ?? null,
      stringValue(correlation.repairOf) ?? null,
      stringValue(correlation.modelRole) ?? null,
      stringValue(correlation.modelSubject) ?? null,
      numberValue(correlation.transportAttempt) ?? null,
      stringValue(attributes.providerId) ?? null,
      stringValue(attributes.profileId) ?? null,
      stringValue(attributes.modelId) ?? null,
      artifactHash,
      diagnosticCode ?? null,
      payload === undefined ? 0 : 1,
    );

    const issueValues: Array<{ code: string; issueClass?: string; path: unknown[]; message?: string }> = [];
    if (diagnosticCode) {
      issueValues.push({ code: diagnosticCode, path: [], message: stringValue(error.message) });
    }
    const payloadRecord = record(payload);
    const issues = Array.isArray(payloadRecord.issues) ? payloadRecord.issues : [];
    for (const issue of issues) {
      const entry = record(issue);
      const code = stringValue(entry.code);
      if (!code) continue;
      issueValues.push({
        code,
        issueClass: stringValue(entry.class),
        path: Array.isArray(entry.path) ? entry.path : [],
        message: stringValue(entry.message) ?? stringValue(entry.reason),
      });
    }
    const insertIssue = this.connection.prepare(`
      INSERT OR REPLACE INTO execution_issue_index(
        execution_id, event_sequence, code, issue_class, path_json, message
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const issue of issueValues) {
      insertIssue.run(
        executionId,
        sequence,
        issue.code,
        issue.issueClass ?? null,
        JSON.stringify(issue.path),
        issue.message ?? null,
      );
    }
  }

  private refreshInvocationIndex(executionId: string): void {
    const rows = this.connection.prepare(`
      SELECT * FROM execution_event_index
      WHERE execution_id = ? AND model_invocation_id IS NOT NULL
      ORDER BY sequence
    `).all(executionId) as DebugEventIndexRow[];
    const groups = new Map<string, DebugEventIndexRow[]>();
    for (const row of rows) {
      const id = publicInvocationId(executionId, row.model_invocation_id!);
      const group = groups.get(id) ?? [];
      group.push(row);
      groups.set(id, group);
    }
    this.connection.prepare("DELETE FROM execution_invocation_index WHERE execution_id = ?").run(executionId);
    const insert = this.connection.prepare(`
      INSERT INTO execution_invocation_index(
        id, execution_id, instance_id, source_invocation_id, logical_invocation_id,
        parent_invocation_id, repair_of, role, subject_id, provider_id, profile_id,
        model_id, status, first_sequence, last_sequence, event_count, retry_count,
        issue_codes_json, artifact_hashes_json, started_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const [id, group] of groups) {
      const first = group[0]!;
      const last = group.at(-1)!;
      const issueCodes = this.connection.prepare(`
        SELECT DISTINCT code FROM execution_issue_index
        WHERE execution_id = ? AND event_sequence BETWEEN ? AND ?
          AND event_sequence IN (SELECT sequence FROM execution_event_index WHERE execution_id = ? AND model_invocation_id = ?)
        ORDER BY code
      `).all(executionId, first.sequence, last.sequence, executionId, first.model_invocation_id) as Array<{ code: string }>;
      const artifactHashes = [...new Set(group.flatMap((row) => row.artifact_hash ? [row.artifact_hash] : []))].sort();
      const attempts = group.map((row) => row.transport_attempt ?? 1);
      const completed = group.filter((row) => row.event_name === "model.structured_output.parsed" ||
        row.event_name === "model.structured_output.rejected" || row.event_name === "model.invocation.failed" ||
        row.event_name === "model.semantic.accepted" || row.event_name === "model.semantic.rejected");
      insert.run(
        id,
        executionId,
        first.instance_id ?? null,
        first.model_invocation_id!,
        first.logical_invocation_id ?? null,
        first.parent_invocation_id ? publicInvocationId(executionId, first.parent_invocation_id) : null,
        first.repair_of ? publicInvocationId(executionId, first.repair_of) : null,
        first.model_role ?? null,
        first.model_subject ?? null,
        first.provider_id ?? null,
        first.profile_id ?? null,
        first.model_id ?? null,
        debugInvocationStatus(group),
        first.sequence,
        last.sequence,
        group.length,
        Math.max(0, Math.max(...attempts) - 1),
        JSON.stringify(issueCodes.map((issue) => issue.code)),
        JSON.stringify(artifactHashes),
        first.timestamp,
        completed.at(-1)?.timestamp ?? null,
      );
    }
  }

  private publishExecutionEvents(events: readonly RuntimeEvent[]): void {
    for (const event of events) {
      for (const listener of this.executionListeners) {
        try {
          listener(structuredClone(event));
        } catch {
          // Query projections cannot change execution persistence.
        }
      }
    }
  }

  appendExecutionEvents(executionId: string, inputs: readonly RuntimeEventInput[]): RuntimeEvent[] {
    this.assertWritable();
    if (inputs.length === 0) return [];
    const events = this.connection.transaction(() => this.persistExecutionEvents(executionId, inputs))();
    this.publishExecutionEvents(events);
    return events;
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    this.executionListeners.add(listener);
    return () => this.executionListeners.delete(listener);
  }

  finishExecution(executionId: string, input: FinishExecutionInput): import("../engine/runtime/execution").ExecutionRef {
    this.assertWritable();
    this.executionWriters.get(executionId)?.flush();
    const terminalError = input.error === undefined ? undefined : executionError(input.error);
    let terminalEvents: RuntimeEvent[] = [];
    const reference = this.connection.transaction(() => {
      this.assertInstanceLease();
      const current = this.connection.prepare("SELECT status FROM executions WHERE id = ?")
        .get(executionId) as { status: string } | undefined;
      if (!current) throw new Error(`execution not found: ${executionId}`);
      if (current.status !== "running") throw new Error(`execution is already terminal: ${executionId}`);
      if (terminalError) {
        terminalEvents = this.persistExecutionEvents(executionId, [{
          event: `execution.${input.status}`,
          level: input.status === "cancelled" ? "warn" : "error",
          attributes: { terminalStatus: input.status },
          error: terminalError,
        }]);
      }
      const errorArtifactHash = terminalError === undefined
        ? null
        : this.persistExecutionArtifact(
            executionId,
            "execution.error",
            terminalError,
          );
      const currentReference = this.currentExecutionRef(executionId);
      const result = this.connection.prepare(`
        UPDATE executions SET
          status = ?, semantic_hash = ?, state_hash = ?, commit_revision = ?,
          terminal_event_sequence = ?, trace_hash = ?, error_artifact_hash = ?, finished_at = ?
        WHERE id = ? AND status = 'running'
      `).run(
        input.status,
        input.semanticHash ?? null,
        input.stateHash ?? null,
        input.commitRevision ?? null,
        currentReference.terminalEventSequence,
        currentReference.traceHash,
        errorArtifactHash,
        input.finishedAt ?? new Date(this.now()).toISOString(),
        executionId,
      );
      if (result.changes !== 1) throw new Error(`execution terminal update failed: ${executionId}`);
      return currentReference;
    })();
    this.executionWriters.delete(executionId);
    this.publishExecutionEvents(terminalEvents);
    return reference;
  }

  private currentExecutionRef(executionId: string): import("../engine/runtime/execution").ExecutionRef {
    const rows = this.connection.prepare(`
      SELECT sequence, trace_id, span_id, parent_span_id, event_name, level, timestamp,
             attributes_json, counts_json, hashes_json, links_json, correlation_json,
             artifact_hash, error_json
      FROM execution_events WHERE execution_id = ? ORDER BY sequence
    `).all(executionId) as Array<{
      sequence: number;
      trace_id: string;
      span_id: string;
      parent_span_id: string | null;
      event_name: string;
      level: string;
      timestamp: string;
      attributes_json: string;
      counts_json: string;
      hashes_json: string;
      links_json: string;
      correlation_json: string;
      artifact_hash: string | null;
      error_json: string | null;
    }>;
    const terminalEventSequence = rows.at(-1)?.sequence ?? 0;
    if (terminalEventSequence <= 0) throw new Error(`execution has no durable events: ${executionId}`);
    const traceHash = contentHash(rows.map((row) => ({
      sequence: row.sequence,
      traceId: row.trace_id,
      spanId: row.span_id,
      parentSpanId: row.parent_span_id,
      event: row.event_name,
      level: row.level,
      timestamp: row.timestamp,
      attributes: JSON.parse(row.attributes_json),
      counts: JSON.parse(row.counts_json),
      hashes: JSON.parse(row.hashes_json),
      links: JSON.parse(row.links_json),
      correlation: JSON.parse(row.correlation_json),
      artifactHash: row.artifact_hash,
      error: row.error_json ? JSON.parse(row.error_json) : null,
    })));
    return { executionId, terminalEventSequence, traceHash };
  }

  private recoverInterruptedExecutions(): void {
    const interrupted = this.connection.prepare(
      "SELECT id FROM executions WHERE status = 'running' ORDER BY started_at, id",
    ).all() as Array<{ id: string }>;
    for (const { id } of interrupted) {
      this.appendExecutionEvent(id, {
        event: "execution.recovered_as_failed",
        level: "error",
        attributes: { reason: "process_interrupted" },
        error: {
          name: "ExecutionInterruptedError",
          message: "execution was running when the prior database owner stopped",
        },
      });
      this.finishExecution(id, {
        status: "failed",
        error: {
          name: "ExecutionInterruptedError",
          message: "execution was running when the prior database owner stopped",
        },
      });
    }
  }

  execution(executionId: string): ExecutionRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM executions WHERE id = ?")
      .get(executionId) as ExecutionRow | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      kind: row.kind,
      ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      ...(row.advance_id ? { advanceId: row.advance_id } : {}),
      ...(row.step === null ? {} : { step: row.step }),
      manifest: JSON.parse(row.manifest_json),
      worldHash: row.world_hash,
      codeRevision: row.code_revision,
      codeDirty: row.code_dirty === 1,
      modelCatalogHash: row.model_catalog_hash,
      seed: row.seed,
      runtimeConfig: JSON.parse(row.runtime_config_json),
      status: row.status,
      traceId: row.trace_id,
      startedAt: row.started_at,
      ...(row.semantic_hash ? { semanticHash: row.semantic_hash } : {}),
      ...(row.state_hash ? { stateHash: row.state_hash } : {}),
      ...(row.commit_revision === null ? {} : { commitRevision: row.commit_revision }),
      ...(row.terminal_event_sequence === null ? {} : { terminalEventSequence: row.terminal_event_sequence }),
      ...(row.trace_hash ? { traceHash: row.trace_hash } : {}),
      ...(row.error_artifact_hash ? { errorArtifactHash: row.error_artifact_hash } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    };
  }

  executions(input: {
    kind?: import("../engine/runtime/execution").ExecutionKind;
    parentExecutionId?: string;
    instanceId?: string;
  } = {}): ExecutionRecord[] {
    const clauses: string[] = [];
    const parameters: string[] = [];
    if (input.kind) {
      clauses.push("kind = ?");
      parameters.push(input.kind);
    }
    if (input.parentExecutionId) {
      clauses.push("parent_execution_id = ?");
      parameters.push(input.parentExecutionId);
    }
    if (input.instanceId) {
      clauses.push("instance_id = ?");
      parameters.push(input.instanceId);
    }
    const rows = this.connection.prepare(`
      SELECT id FROM executions
      ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY started_at, id
    `).all(...parameters) as Array<{ id: string }>;
    return rows.map((row) => this.execution(row.id)!);
  }

  private eventsFor(where: string, value: string): RuntimeEvent[] {
    const rows = this.connection.prepare(`
      SELECT events.sequence, events.event_json, events.artifact_hash
      FROM execution_events AS events
      JOIN executions ON executions.id = events.execution_id
      WHERE ${where} = ? ORDER BY events.sequence
    `).all(value) as ExecutionEventRow[];
    return rows.map((row) => {
      const event = JSON.parse(row.event_json) as RuntimeEvent;
      event.sequence = row.sequence;
      if (row.artifact_hash) event.payload = this.artifact(row.artifact_hash)?.value;
      return event;
    });
  }

  executionEvents(executionId: string): RuntimeEvent[] {
    this.executionWriters.get(executionId)?.flush();
    return this.eventsFor("executions.id", executionId);
  }

  instanceEvents(instanceId: string): RuntimeEvent[] {
    const runningIds = this.connection.prepare(
      "SELECT id FROM executions WHERE instance_id = ? AND status = 'running'",
    ).all(instanceId) as Array<{ id: string }>;
    for (const { id } of runningIds) this.executionWriters.get(id)?.flush();
    return this.eventsFor("executions.instance_id", instanceId);
  }

  private debugEventSummary(row: DebugEventIndexRow, includePayload = false): DebugEventSummary {
    const diagnosticCodes = [
      ...(row.diagnostic_code ? [row.diagnostic_code] : []),
      ...(this.connection.prepare(
        "SELECT code FROM execution_issue_index WHERE event_sequence = ? ORDER BY code",
      ).all(row.sequence) as Array<{ code: string }>).map((issue) => issue.code),
    ];
    const summary: DebugEventSummary = {
      sequence: row.sequence,
      executionId: row.execution_id,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      timestamp: row.timestamp,
      eventName: row.event_name,
      level: row.level,
      ...(row.phase ? { phase: row.phase } : {}),
      ...(row.component ? { component: row.component } : {}),
      ...(row.operation ? { operation: row.operation } : {}),
      ...(row.request_id ? { requestId: row.request_id } : {}),
      traceId: row.trace_id,
      spanId: row.span_id,
      ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
      ...(row.model_invocation_id ? { modelInvocationId: row.model_invocation_id } : {}),
      ...(row.logical_invocation_id ? { logicalInvocationId: row.logical_invocation_id } : {}),
      ...(row.model_role ? { modelRole: row.model_role } : {}),
      ...(row.model_subject ? { modelSubject: row.model_subject } : {}),
      ...(row.transport_attempt !== null ? { transportAttempt: row.transport_attempt } : {}),
      ...(row.artifact_hash ? { artifactHash: row.artifact_hash } : {}),
      hasPayload: row.has_payload === 1,
      diagnosticCodes: [...new Set(diagnosticCodes)],
    };
    if (includePayload && row.artifact_hash) {
      summary.payload = this.artifact(row.artifact_hash)?.value;
    }
    return summary;
  }

  private debugInvocationSummary(row: DebugInvocationIndexRow): DebugInvocationSummary {
    const lineage: DebugLineageRef[] = [];
    if (row.parent_invocation_id) {
      lineage.push({ kind: "parent", id: row.parent_invocation_id, executionId: row.execution_id });
    }
    if (row.repair_of) {
      lineage.push({ kind: "repair", id: row.repair_of, executionId: row.execution_id });
    }
    const children = this.connection.prepare(`
      SELECT id, execution_id, source_invocation_id
      FROM execution_invocation_index
      WHERE parent_invocation_id = ? OR repair_of = ?
      ORDER BY first_sequence, id
    `).all(row.id, row.id) as Array<{ id: string; execution_id: string; source_invocation_id: string }>;
    for (const child of children) {
      lineage.push({ kind: "child", id: child.id, executionId: child.execution_id, sourceInvocationId: child.source_invocation_id });
    }
    const issueCodes = JSON.parse(row.issue_codes_json) as string[];
    const artifactHashes = JSON.parse(row.artifact_hashes_json) as string[];
    return {
      id: row.id,
      executionId: row.execution_id,
      ...(row.instance_id ? { instanceId: row.instance_id } : {}),
      sourceInvocationId: row.source_invocation_id,
      ...(row.logical_invocation_id ? { logicalInvocationId: row.logical_invocation_id } : {}),
      ...(row.parent_invocation_id ? { parentInvocationId: row.parent_invocation_id } : {}),
      ...(row.repair_of ? { repairOf: row.repair_of } : {}),
      ...(row.role ? { role: row.role } : {}),
      ...(row.subject_id ? { subjectId: row.subject_id } : {}),
      ...(row.provider_id ? { providerId: row.provider_id } : {}),
      ...(row.profile_id ? { profileId: row.profile_id } : {}),
      ...(row.model_id ? { modelId: row.model_id } : {}),
      status: row.status,
      firstSequence: row.first_sequence,
      lastSequence: row.last_sequence,
      eventCount: row.event_count,
      retryCount: row.retry_count,
      issueCodes,
      artifactHashes,
      ...(row.started_at ? { startedAt: row.started_at } : {}),
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      lineage,
    };
  }

  private debugCursorValue(cursor: string | undefined): number {
    if (!cursor) return 0;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { firstSequence?: unknown };
      return typeof parsed.firstSequence === "number" && Number.isSafeInteger(parsed.firstSequence)
        ? parsed.firstSequence
        : 0;
    } catch {
      return 0;
    }
  }

  private debugCursor(firstSequence: number): string {
    return Buffer.from(JSON.stringify({ firstSequence }), "utf8").toString("base64url");
  }

  private flushExecutionWriters(): void {
    for (const writer of this.executionWriters.values()) writer.flush();
  }

  debugQuery(input: DebugQuery = {}): DebugSearchResult {
    this.flushExecutionWriters();
    const limit = Math.min(100, Math.max(1, input.limit ?? 50));
    const parameters: Array<string | number> = [];
    const clauses: string[] = [];
    if (input.executionId) { clauses.push("v.execution_id = ?"); parameters.push(input.executionId); }
    if (input.instanceId) { clauses.push("v.instance_id = ?"); parameters.push(input.instanceId); }
    if (input.sourceInvocationId) { clauses.push("v.source_invocation_id = ?"); parameters.push(input.sourceInvocationId); }
    if (input.invocationId) { clauses.push("v.id = ?"); parameters.push(input.invocationId); }
    const invocationEventFilter = (condition: string, ...values: Array<string | number>): void => {
      clauses.push(`EXISTS (
        SELECT 1 FROM execution_event_index event
        WHERE event.execution_id = v.execution_id
          AND event.model_invocation_id = v.source_invocation_id
          AND ${condition}
      )`);
      parameters.push(...values);
    };
    if (input.requestId) invocationEventFilter("event.request_id = ?", input.requestId);
    if (input.traceId) invocationEventFilter("event.trace_id = ?", input.traceId);
    if (input.spanId) invocationEventFilter("event.span_id = ?", input.spanId);
    if (input.eventSequence !== undefined) invocationEventFilter("event.sequence = ?", input.eventSequence);
    if (input.artifactHash) invocationEventFilter("event.artifact_hash = ?", input.artifactHash);
    if (input.eventName) invocationEventFilter("event.event_name = ?", input.eventName);
    if (input.component) invocationEventFilter("event.component = ?", input.component);
    if (input.operation) invocationEventFilter("event.operation = ?", input.operation);
    if (input.diagnosticCode) {
      clauses.push(`EXISTS (
        SELECT 1 FROM execution_event_index event
        WHERE event.execution_id = v.execution_id
          AND event.model_invocation_id = v.source_invocation_id
          AND (event.diagnostic_code = ? OR EXISTS (
            SELECT 1 FROM execution_issue_index issue
            WHERE issue.event_sequence = event.sequence AND issue.code = ?
          ))
      )`);
      parameters.push(input.diagnosticCode, input.diagnosticCode);
    }
    if (input.from) { clauses.push("COALESCE(v.started_at, '') >= ?"); parameters.push(input.from); }
    if (input.to) { clauses.push("COALESCE(v.started_at, '') <= ?"); parameters.push(input.to); }
    const cursor = this.debugCursorValue(input.cursor);
    if (cursor > 0) { clauses.push("v.first_sequence > ?"); parameters.push(cursor); }
    const invocationWhere = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const invocationTotal = Number((this.connection.prepare(`
      SELECT COUNT(*) AS count FROM execution_invocation_index v ${invocationWhere}
    `).get(...parameters) as { count: number }).count);
    const invocationSql = `
      SELECT v.* FROM execution_invocation_index v
      ${invocationWhere}
      ORDER BY v.first_sequence, v.id
      LIMIT ?
    `;
    const rawInvocationRows = this.connection.prepare(invocationSql).all(...parameters, limit + 1) as DebugInvocationIndexRow[];
    const hasMoreInvocations = rawInvocationRows.length > limit;
    const invocationRows = rawInvocationRows.slice(0, limit);
    const invocationSummaries = invocationRows.map((row) => this.debugInvocationSummary(row));
    const invocationIds = invocationRows.map((row) => row.source_invocation_id);

    const eventParameters: Array<string | number> = [];
    const eventClauses: string[] = [];
    if (input.executionId) { eventClauses.push("e.execution_id = ?"); eventParameters.push(input.executionId); }
    if (input.instanceId) { eventClauses.push("e.instance_id = ?"); eventParameters.push(input.instanceId); }
    if (input.invocationId) {
      eventClauses.push(`EXISTS (
        SELECT 1 FROM execution_invocation_index invocation
        WHERE invocation.id = ?
          AND invocation.execution_id = e.execution_id
          AND invocation.source_invocation_id = e.model_invocation_id
      )`);
      eventParameters.push(input.invocationId);
    }
    if (input.sourceInvocationId) { eventClauses.push("e.model_invocation_id = ?"); eventParameters.push(input.sourceInvocationId); }
    if (input.requestId) { eventClauses.push("e.request_id = ?"); eventParameters.push(input.requestId); }
    if (input.traceId) { eventClauses.push("e.trace_id = ?"); eventParameters.push(input.traceId); }
    if (input.spanId) { eventClauses.push("e.span_id = ?"); eventParameters.push(input.spanId); }
    if (input.eventSequence !== undefined) { eventClauses.push("e.sequence = ?"); eventParameters.push(input.eventSequence); }
    if (input.artifactHash) { eventClauses.push("e.artifact_hash = ?"); eventParameters.push(input.artifactHash); }
    if (input.eventName) { eventClauses.push("e.event_name = ?"); eventParameters.push(input.eventName); }
    if (input.component) { eventClauses.push("e.component = ?"); eventParameters.push(input.component); }
    if (input.operation) { eventClauses.push("e.operation = ?"); eventParameters.push(input.operation); }
    if (input.diagnosticCode) {
      eventClauses.push(`(e.diagnostic_code = ? OR EXISTS (
        SELECT 1 FROM execution_issue_index issue
        WHERE issue.event_sequence = e.sequence AND issue.code = ?
      ))`);
      eventParameters.push(input.diagnosticCode, input.diagnosticCode);
    }
    if (input.from) { eventClauses.push("e.timestamp >= ?"); eventParameters.push(input.from); }
    if (input.to) { eventClauses.push("e.timestamp <= ?"); eventParameters.push(input.to); }
    if (cursor > 0) { eventClauses.push("e.sequence > ?"); eventParameters.push(cursor); }
    const eventWhere = eventClauses.length > 0 ? `WHERE ${eventClauses.join(" AND ")}` : "";
    const eventTotal = Number((this.connection.prepare(`
      SELECT COUNT(*) AS count FROM execution_event_index e ${eventWhere}
    `).get(...eventParameters) as { count: number }).count);
    const rawEventRows = this.connection.prepare(`
      SELECT e.* FROM execution_event_index e
      ${eventWhere}
      ORDER BY e.sequence
      LIMIT ?
    `).all(...eventParameters, limit + 1) as DebugEventIndexRow[];
    const hasMoreEvents = rawEventRows.length > limit;
    const eventRows = rawEventRows.slice(0, limit);
    const events = eventRows.map((row) => this.debugEventSummary(row, input.includePayload === true));

    const executionIds = new Set<string>([
      ...invocationRows.map((row) => row.execution_id),
      ...eventRows.map((row) => row.execution_id),
    ]);
    const executions = [...executionIds].flatMap((id) => {
      const row = this.connection.prepare(`
        SELECT id, instance_id, parent_execution_id, status, kind, trace_id, started_at, finished_at
        FROM executions WHERE id = ?
      `).get(id) as {
        id: string; instance_id: string | null; parent_execution_id: string | null; status: string;
        kind: string; trace_id: string; started_at: string; finished_at: string | null;
      } | undefined;
      return row ? [{
        id: row.id,
        ...(row.instance_id ? { instanceId: row.instance_id } : {}),
        ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
        status: row.status,
        kind: row.kind,
        traceId: row.trace_id,
        startedAt: row.started_at,
        ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      }] : [];
    });
    const total = invocationTotal > 0 ? invocationTotal : eventTotal > 0 ? eventTotal : executions.length;
    const hasMore = invocationRows.length > 0 ? hasMoreInvocations : hasMoreEvents;
    const lastSequence = invocationRows.at(-1)?.first_sequence ?? eventRows.at(-1)?.sequence ?? 0;
    return {
      apiVersion: DEBUG_API_VERSION,
      query: structuredClone(input),
      total,
      invocations: invocationSummaries,
      executions,
      events,
      ...(hasMore && lastSequence > 0 ? { nextCursor: this.debugCursor(lastSequence) } : {}),
      warnings: invocationIds.length === 0 && Object.keys(input).length > 0 && total === 0
        ? ["no matching durable debug evidence"]
        : [],
    };
  }

  debugInspect(invocationId: string, includePayload = false): DebugInspection | undefined {
    this.flushExecutionWriters();
    const row = this.connection.prepare(
      "SELECT * FROM execution_invocation_index WHERE id = ?",
    ).get(invocationId) as DebugInvocationIndexRow | undefined;
    if (!row) return undefined;
    const summary = this.debugInvocationSummary(row);
    const eventRows = this.connection.prepare(`
      SELECT * FROM execution_event_index
      WHERE execution_id = ? AND model_invocation_id = ?
      ORDER BY sequence
    `).all(row.execution_id, row.source_invocation_id) as DebugEventIndexRow[];
    const diagnostics: DebugDiagnostic[] = [];
    const diagnosticCodes = new Set<string>();
    for (const event of eventRows) {
      const codes = [
        ...(event.diagnostic_code ? [event.diagnostic_code] : []),
        ...(this.connection.prepare(
          "SELECT code FROM execution_issue_index WHERE event_sequence = ? ORDER BY code",
        ).all(event.sequence) as Array<{ code: string }>).map((issue) => issue.code),
      ];
      for (const code of codes) {
        if (diagnosticCodes.has(code)) continue;
        diagnosticCodes.add(code);
        diagnostics.push(publicDiagnostic(diagnosticDefinition(code), {
          eventSequence: event.sequence,
          artifactHash: event.artifact_hash ?? undefined,
        }));
      }
    }
    return {
      apiVersion: DEBUG_API_VERSION,
      ...summary,
      events: eventRows.map((event) => this.debugEventSummary(event, includePayload)),
      diagnostics,
    };
  }

  debugArtifact(hash: string): DebugArtifact | undefined {
    const artifact = this.artifact(hash);
    if (!artifact) return undefined;
    return {
      apiVersion: DEBUG_API_VERSION,
      hash: artifact.hash,
      executionId: artifact.executionId,
      kind: artifact.kind,
      mediaType: artifact.mediaType,
      encoding: artifact.encoding,
      rawBytes: artifact.rawBytes,
      storedBytes: artifact.storedBytes,
      createdAt: artifact.createdAt,
      value: artifact.value,
    };
  }

  debugExplain(code: string): {
    apiVersion: typeof DEBUG_API_VERSION;
    code: string;
    definition: ReturnType<typeof diagnosticDefinition>;
    suggestedCommands: string[];
  } {
    const definition = diagnosticDefinition(code);
    return {
      apiVersion: DEBUG_API_VERSION,
      code,
      definition,
      suggestedCommands: [
        `npm run debug -- find --issue ${code}`,
        ...definition.sourcePaths.map((source) => `rg -n "${code}" ${source}`),
      ],
    };
  }

  debugRebuildIndex(): void {
    this.assertWritable();
    this.flushExecutionWriters();
    this.connection.transaction(() => {
      this.connection.exec("DELETE FROM execution_issue_index; DELETE FROM execution_invocation_index; DELETE FROM execution_event_index;");
      const rows = this.connection.prepare(`
        SELECT sequence, execution_id, event_json, artifact_hash
        FROM execution_events ORDER BY sequence
      `).all() as Array<{ sequence: number; execution_id: string; event_json: string; artifact_hash: string | null }>;
      const executions = new Set<string>();
      for (const row of rows) {
        const event = JSON.parse(row.event_json) as RuntimeEvent;
        const payload = row.artifact_hash ? this.artifact(row.artifact_hash)?.value : undefined;
        this.indexRuntimeEvent(row.execution_id, event, row.sequence, row.artifact_hash, payload);
        executions.add(row.execution_id);
      }
      for (const executionId of executions) this.refreshInvocationIndex(executionId);
      this.connection.prepare(`
        INSERT INTO debug_index_meta(singleton, version, rebuilt_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET version = excluded.version, rebuilt_at = excluded.rebuilt_at
      `).run(DEBUG_INDEX_VERSION, new Date(this.now()).toISOString());
    })();
  }

  debugDoctor(): DebugDoctorReport {
    this.flushExecutionWriters();
    const scalar = (sql: string): number => Number((this.connection.prepare(sql).get() as { count: number }).count);
    const schemaVersion = Number((this.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version);
    const executionCount = scalar("SELECT COUNT(*) AS count FROM executions");
    const eventCount = scalar("SELECT COUNT(*) AS count FROM execution_events");
    const artifactCount = scalar("SELECT COUNT(*) AS count FROM execution_artifacts");
    const indexedEventCount = scalar("SELECT COUNT(*) AS count FROM execution_event_index");
    const indexedInvocationCount = scalar("SELECT COUNT(*) AS count FROM execution_invocation_index");
    const issueCount = scalar("SELECT COUNT(*) AS count FROM execution_issue_index");
    const indexVersion = Number((this.connection.prepare("SELECT version FROM debug_index_meta WHERE singleton = 1").get() as { version?: number } | undefined)?.version ?? 0);
    const orphanedIndexRows = scalar(`
      SELECT COUNT(*) AS count FROM execution_event_index idx
      LEFT JOIN execution_events event ON event.sequence = idx.sequence
      WHERE event.sequence IS NULL
    `) + scalar(`
      SELECT COUNT(*) AS count FROM execution_invocation_index idx
      LEFT JOIN executions execution ON execution.id = idx.execution_id
      WHERE execution.id IS NULL
    `);
    const missingIndexRows = scalar(`
      SELECT COUNT(*) AS count FROM execution_events event
      LEFT JOIN execution_event_index idx ON idx.sequence = event.sequence
      WHERE idx.sequence IS NULL
    `);
    const orphanedArtifacts = scalar(`
      SELECT COUNT(*) AS count FROM execution_artifacts artifact
      LEFT JOIN executions execution ON execution.id = artifact.execution_id
      WHERE execution.id IS NULL
    `);
    const warnings: string[] = [];
    if (schemaVersion !== 9) warnings.push(`expected database schema v9, found v${schemaVersion}`);
    if (indexVersion !== DEBUG_INDEX_VERSION) warnings.push(`expected debug index v${DEBUG_INDEX_VERSION}, found v${indexVersion}`);
    if (indexedEventCount !== eventCount) warnings.push(`event index count ${indexedEventCount} differs from Ledger count ${eventCount}`);
    if (orphanedIndexRows > 0) warnings.push(`${orphanedIndexRows} orphaned debug index row(s)`);
    if (missingIndexRows > 0) warnings.push(`${missingIndexRows} Ledger event(s) are missing debug index rows`);
    if (orphanedArtifacts > 0) warnings.push(`${orphanedArtifacts} orphaned artifact row(s)`);
    return {
      apiVersion: DEBUG_API_VERSION,
      indexVersion,
      database: this.file,
      schemaVersion,
      indexFresh: warnings.length === 0,
      executionCount,
      eventCount,
      artifactCount,
      indexedEventCount,
      indexedInvocationCount,
      issueCount,
      orphanedIndexRows,
      missingIndexRows,
      orphanedArtifacts,
      warnings,
    };
  }

  artifact(hash: string): ExecutionArtifactRecord | undefined {
    const row = this.connection.prepare("SELECT * FROM execution_artifacts WHERE hash = ?")
      .get(hash) as ExecutionArtifactRow | undefined;
    if (!row) return undefined;
    const value = this.blocks.read(row.root_hash);
    if (contentHash(value) !== row.hash) throw new Error(`execution artifact hash mismatch ${hash}`);
    return {
      hash: row.hash,
      executionId: row.execution_id,
      kind: row.kind,
      mediaType: row.media_type,
      encoding: row.encoding,
      rawBytes: row.raw_bytes,
      storedBytes: row.stored_bytes,
      createdAt: row.created_at,
      value,
    };
  }

  private acquireInstanceLease(): void {
    this.connection.transaction(() => {
      const now = this.now();
      const lock = this.connection.prepare("SELECT owner_id, pid, expires_at FROM instance_lock WHERE singleton = 1")
        .get() as LockRow | undefined;
      if (lock && lock.owner_id !== this.ownerId && lock.expires_at > now && this.isProcessAlive(lock.pid)) {
        throw new LocalDatabaseInUseError(this.file);
      }
      this.connection.prepare(`
        INSERT INTO instance_lock(singleton, owner_id, pid, acquired_at, heartbeat_at, expires_at)
        VALUES (1, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          owner_id = excluded.owner_id,
          pid = excluded.pid,
          acquired_at = excluded.acquired_at,
          heartbeat_at = excluded.heartbeat_at,
          expires_at = excluded.expires_at
      `).run(this.ownerId, process.pid, now, now, now + INSTANCE_LEASE_MS);
    })();
  }

  private assertInstanceLease(): void {
    const lock = this.connection.prepare("SELECT owner_id, expires_at FROM instance_lock WHERE singleton = 1")
      .get() as LockRow | undefined;
    if (!lock || lock.owner_id !== this.ownerId) {
      throw new LocalDatabaseInUseError(this.file);
    }
    const now = this.now();
    if (lock.expires_at > now) return;
    const renewed = this.connection.prepare(`
      UPDATE instance_lock SET heartbeat_at = ?, expires_at = ?
      WHERE singleton = 1 AND owner_id = ?
    `).run(now, now + INSTANCE_LEASE_MS, this.ownerId);
    if (renewed.changes !== 1) throw new LocalDatabaseInUseError(this.file);
  }

  private renewInstanceLease(): void {
    if (this.closed) return;
    const now = this.now();
    const result = this.connection.prepare(`
      UPDATE instance_lock
      SET heartbeat_at = ?, expires_at = ?
      WHERE singleton = 1 AND owner_id = ?
    `).run(now, now + INSTANCE_LEASE_MS, this.ownerId);
    if (result.changes !== 1) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    }
  }

  list(): WorldCatalogEntry[] {
    const rows = this.connection.prepare(`
      SELECT versions.world_id AS id,
             versions.name,
             versions.manifest_version AS version,
             versions.content_hash,
             versions.description,
             versions.template_json
      FROM world_catalog AS catalog
      JOIN world_versions AS versions
        ON versions.world_id = catalog.world_id
       AND versions.content_hash = catalog.current_content_hash
      ORDER BY versions.world_id
    `).all() as WorldRow[];
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      version: row.version,
      contentHash: row.content_hash,
      description: row.description,
      participation: parseWorldTemplate(JSON.parse(row.template_json)).participation ? "open" as const : "headless" as const,
    }));
  }

  load(worldId: string, seed: number | undefined, modelCatalog: ModelCatalog) {
    const row = this.connection.prepare(`
      SELECT versions.world_id AS id,
             versions.name,
             versions.manifest_version AS version,
             versions.content_hash,
             versions.description,
             versions.template_json
      FROM world_catalog AS catalog
      JOIN world_versions AS versions
        ON versions.world_id = catalog.world_id
       AND versions.content_hash = catalog.current_content_hash
      WHERE catalog.world_id = ?
    `).get(worldId) as WorldRow | undefined;
    if (!row) throw new Error(`world not found: ${worldId}`);
    return this.definitionFromWorldRow(row, seed, modelCatalog);
  }

  loadVersion(
    worldId: string,
    contentHash: string,
    seed: number | undefined,
    modelCatalog: ModelCatalog,
  ) {
    const row = this.connection.prepare(`
      SELECT world_id AS id,
             name,
             manifest_version AS version,
             content_hash,
             description,
             template_json
      FROM world_versions
      WHERE world_id = ? AND content_hash = ?
    `).get(worldId, contentHash) as WorldRow | undefined;
    if (!row) throw new Error(`world version not found: ${worldId}@${contentHash}`);
    return this.definitionFromWorldRow(row, seed, modelCatalog);
  }

  private definitionFromWorldRow(
    row: WorldRow,
    seed: number | undefined,
    modelCatalog: ModelCatalog,
  ) {
    const template = parseWorldTemplate(JSON.parse(row.template_json));
    if (hashWorldTemplate(template) !== row.content_hash) throw new Error(`world ${row.id} content hash mismatch`);
    return buildWorldDefinition(template, { seed, modelCatalog, rulePackages: this.rulePackages });
  }

  importWorld(
    buffer: Buffer,
    modelCatalog: ModelCatalog,
    replace = false,
    expectedWorldId?: string,
  ): WorldImportResult {
    this.assertWritable();
    const archive = parseWorldArchive(buffer, modelCatalog, this.rulePackages);
    return this.connection.transaction(() => {
      this.assertInstanceLease();
      if (expectedWorldId !== undefined && archive.id !== expectedWorldId) {
        throw new WorldImportError(
          `archive world ${archive.id} does not match expected world ${expectedWorldId}`,
          409,
        );
      }
      const current = this.connection.prepare("SELECT current_content_hash FROM world_catalog WHERE world_id = ?")
        .get(archive.id) as { current_content_hash: string } | undefined;
      if (current && !replace) throw new WorldImportError(`world ${archive.id} already exists`, 409);
      this.connection.prepare(`
        INSERT OR IGNORE INTO world_versions(
          world_id, content_hash, name, manifest_version, description, template_json, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        archive.id,
        archive.contentHash,
        archive.name,
        archive.version,
        archive.description,
        JSON.stringify(canonicalize(archive.template)),
        new Date(this.now()).toISOString(),
      );
      this.connection.prepare(`
        INSERT INTO world_catalog(world_id, current_content_hash, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(world_id) DO UPDATE SET
          current_content_hash = excluded.current_content_hash,
          updated_at = excluded.updated_at
      `).run(archive.id, archive.contentHash, new Date(this.now()).toISOString());
      return {
        id: archive.id,
        name: archive.name,
        description: archive.description,
        replaced: Boolean(current),
        activeGoalCount: archive.activeGoalCount,
      };
    })();
  }

  deleteWorld(worldId: string): void {
    this.assertWritable();
    this.connection.transaction(() => {
      this.assertInstanceLease();
      const installed = this.connection.prepare("SELECT 1 FROM world_catalog WHERE world_id = ?")
        .get(worldId) as { 1: number } | undefined;
      if (!installed) throw new WorldImportError(`world ${worldId} not found`, 404);
      const instance = this.connection.prepare("SELECT 1 FROM world_instances WHERE world_id = ? LIMIT 1")
        .get(worldId) as { 1: number } | undefined;
      if (instance) throw new WorldImportError(`world ${worldId} still has instances`, 409);
      this.connection.prepare("DELETE FROM world_catalog WHERE world_id = ?").run(worldId);
      this.connection.prepare("DELETE FROM world_versions WHERE world_id = ?").run(worldId);
    })();
  }

  createInstance(document: WorldInstanceDocument, correlation?: RuntimeCorrelation): StoredWorldInstance {
    this.assertWritable();
    const startedAt = Date.now();
    validateWorldInstanceDocument(document, this.rulePackages);
    let documentHash = "";
    try {
      this.connection.transaction(() => {
        this.assertInstanceLease();
        documentHash = this.blocks.put(document).hash;
        try {
          this.connection.prepare(`
            INSERT INTO world_instances(
              id, generation, world_id, world_hash, document_hash, created_at, updated_at
            ) VALUES (?, 1, ?, ?, ?, ?, ?)
          `).run(
            document.id,
            document.world.id,
            document.world.contentHash,
            documentHash,
            document.createdAt,
            document.updatedAt,
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
            throw new WorldInstanceConflictError(document.id);
          }
          throw error;
        }
      })();
      const cached = this.cacheValidatedInstance(document.id, 1, documentHash, document);
      this.observe?.({
        event: "persistence.write.completed",
        correlation: { ...correlation, instanceId: document.id },
        durationMs: Math.max(0, Date.now() - startedAt),
        measurements: { documentUtf8Bytes: cached.documentUtf8Bytes },
        attributes: { sink: "sqlite", operation: "create" },
      });
      return { generation: 1, document: structuredClone(cached.document) };
    } catch (error) {
      this.observe?.({
        event: "persistence.write.failed",
        level: "error",
        correlation: { ...correlation, instanceId: document.id },
        durationMs: Math.max(0, Date.now() - startedAt),
        attributes: { sink: "sqlite", operation: "create" },
        error: serializeRuntimeError(error),
      });
      throw error;
    }
  }

  private readInstanceDocument(hash: string, expectedId: string): WorldInstanceDocument {
    const document = this.blocks.read(hash) as unknown as WorldInstanceDocument;
    validateWorldInstanceDocument(document, this.rulePackages);
    if (document.id !== expectedId) throw new Error("world instance id mismatch");
    return document;
  }

  readInstance(instanceId: string, correlation?: RuntimeCorrelation): StoredWorldInstance {
    this.invalidateExternalChanges();
    const startedAt = Date.now();
    const row = this.connection.prepare(
      "SELECT generation, document_hash FROM world_instances WHERE id = ?",
    ).get(instanceId) as InstanceRow | undefined;
    if (!row) throw new WorldInstanceNotFoundError(instanceId);
    const cached = this.cachedInstance(instanceId, row);
    if (cached) {
      this.observeCachedRead(instanceId, cached, startedAt, correlation);
      return { generation: cached.generation, document: structuredClone(cached.document) };
    }
    const document = this.readInstanceDocument(row.document_hash, instanceId);
    this.cacheValidatedInstance(instanceId, row.generation, row.document_hash, document);
    return {
      generation: row.generation,
      document,
    };
  }

  compareAndSwapInstance(
    instanceId: string,
    expectedGeneration: number,
    document: WorldInstanceDocument,
    correlation?: RuntimeCorrelation,
  ): StoredWorldInstance {
    this.assertWritable();
    if (document.id !== instanceId) throw new Error("instance document id mismatch");
    const startedAt = Date.now();
    validateWorldInstanceDocument(document, this.rulePackages);
    let documentHash = "";
    try {
      this.connection.transaction(() => {
        this.assertInstanceLease();
        documentHash = this.blocks.put(document).hash;
        const result = this.connection.prepare(`
          UPDATE world_instances
          SET generation = generation + 1,
              world_id = ?,
              world_hash = ?,
              document_hash = ?,
              updated_at = ?
          WHERE id = ? AND generation = ?
        `).run(
          document.world.id,
          document.world.contentHash,
          documentHash,
          document.updatedAt,
          instanceId,
          expectedGeneration,
        );
        if (result.changes !== 1) {
          const exists = this.connection.prepare("SELECT 1 FROM world_instances WHERE id = ?").get(instanceId);
          if (!exists) throw new WorldInstanceNotFoundError(instanceId);
          throw new WorldInstanceConflictError(instanceId);
        }
      })();
      const generation = expectedGeneration + 1;
      const cached = this.cacheValidatedInstance(instanceId, generation, documentHash, document);
      this.observe?.({
        event: "persistence.write.completed",
        correlation: { ...correlation, instanceId },
        durationMs: Math.max(0, Date.now() - startedAt),
        measurements: { documentUtf8Bytes: cached.documentUtf8Bytes },
        attributes: { sink: "sqlite", operation: "compare_and_swap" },
      });
      return { generation, document: structuredClone(cached.document) };
    } catch (error) {
      this.observe?.({
        event: "persistence.write.failed",
        level: "error",
        correlation: { ...correlation, instanceId },
        durationMs: Math.max(0, Date.now() - startedAt),
        attributes: { sink: "sqlite", operation: "compare_and_swap" },
        error: serializeRuntimeError(error),
      });
      throw error;
    }
  }

  private completeAtomicCommitEvent(
    event: RuntimeEvent,
    durationMs: number,
    documentUtf8Bytes: number,
  ): void {
    const measurements = {
      ...event.measurements,
      documentUtf8Bytes,
      sqliteWriteMs: durationMs,
    };
    const completed = { ...event, durationMs, measurements, payload: undefined };
    const result = this.connection.prepare(`
      UPDATE execution_events
      SET duration_ms = ?, measurements_json = ?, event_json = ?
      WHERE sequence = ? AND event_name = 'persistence.atomic_commit'
    `).run(
      durationMs,
      JSON.stringify(canonicalize(measurements)),
      JSON.stringify(canonicalize(completed)),
      event.sequence,
    );
    if (result.changes !== 1) throw new Error("atomic commit event update failed");
  }

  createInstanceAndFinishExecution(
    document: WorldInstanceDocument,
    executionId: string,
    finish: FinishExecutionInput,
    correlation?: RuntimeCorrelation,
  ): { instance: StoredWorldInstance; executionRef: import("../engine/runtime/execution").ExecutionRef } {
    this.assertWritable();
    this.executionWriters.get(executionId)?.flush();
    return this.connection.transaction(() => {
      const commitEvent = this.appendExecutionEvent(executionId, {
        event: "persistence.atomic_commit",
        attributes: { operation: "create", sink: "sqlite", phase: "commit", status: "completed" },
      });
      const expectedRef = this.currentExecutionRef(executionId);
      const finalizedDocument = structuredClone(document);
      finalizedDocument.state = attachExecutionRef(finalizedDocument.state, expectedRef, "bootstrap", this.rulePackages);
      const documentUtf8Bytes = Buffer.byteLength(JSON.stringify(canonicalize(finalizedDocument)), "utf8");
      const writeStartedAt = performance.now();
      const instance = this.createInstance(finalizedDocument, correlation);
      this.completeAtomicCommitEvent(
        commitEvent,
        Math.max(0, performance.now() - writeStartedAt),
        documentUtf8Bytes,
      );
      const executionRef = this.finishExecution(executionId, finish);
      if (contentHash(executionRef) !== contentHash(expectedRef)) throw new Error("execution reference changed during commit");
      return { instance, executionRef };
    })();
  }

  compareAndSwapInstanceAndFinishExecution(
    instanceId: string,
    expectedGeneration: number,
    document: WorldInstanceDocument,
    executionId: string,
    finish: FinishExecutionInput,
    phase: "step" | "admission" | "instance" = "step",
    correlation?: RuntimeCorrelation,
  ): { instance: StoredWorldInstance; executionRef: import("../engine/runtime/execution").ExecutionRef } {
    this.assertWritable();
    this.executionWriters.get(executionId)?.flush();
    return this.connection.transaction(() => {
      const commitEvent = this.appendExecutionEvent(executionId, {
        event: "persistence.atomic_commit",
        attributes: { operation: "compare_and_swap", sink: "sqlite", phase: "commit", status: "completed" },
      });
      const expectedRef = this.currentExecutionRef(executionId);
      const finalizedDocument = structuredClone(document);
      if (phase !== "instance") {
        finalizedDocument.state = attachExecutionRef(finalizedDocument.state, expectedRef, phase, this.rulePackages);
      }
      const documentUtf8Bytes = Buffer.byteLength(JSON.stringify(canonicalize(finalizedDocument)), "utf8");
      const writeStartedAt = performance.now();
      const instance = this.compareAndSwapInstance(
        instanceId,
        expectedGeneration,
        finalizedDocument,
        correlation,
      );
      this.completeAtomicCommitEvent(
        commitEvent,
        Math.max(0, performance.now() - writeStartedAt),
        documentUtf8Bytes,
      );
      const executionRef = this.finishExecution(executionId, finish);
      if (contentHash(executionRef) !== contentHash(expectedRef)) throw new Error("execution reference changed during commit");
      return { instance, executionRef };
    })();
  }

  listInstances(correlation?: RuntimeCorrelation): StoredWorldInstance[] {
    this.invalidateExternalChanges();
    const rows = this.connection.prepare(
      "SELECT id, generation, document_hash FROM world_instances ORDER BY id",
    ).all() as ListedInstanceRow[];
    const persistedIds = new Set(rows.map((row) => row.id));
    for (const instanceId of this.validatedInstances.keys()) {
      if (!persistedIds.has(instanceId)) this.validatedInstances.delete(instanceId);
    }
    const misses: Array<{ row: ListedInstanceRow; document: WorldInstanceDocument }> = [];
    const instances = rows.map((row): StoredWorldInstance => {
      const startedAt = Date.now();
      const cached = this.cachedInstance(row.id, row, false);
      if (cached) {
        this.observeCachedRead(row.id, cached, startedAt, correlation);
        return { generation: cached.generation, document: structuredClone(cached.document) };
      }
      const document = this.readInstanceDocument(row.document_hash, row.id);
      misses.push({ row, document });
      return { generation: row.generation, document };
    });
    for (const { row, document } of misses) {
      if (this.validatedInstances.size >= VALIDATED_INSTANCE_CACHE_LIMIT) break;
      this.cacheValidatedInstance(row.id, row.generation, row.document_hash, document);
    }
    return instances;
  }

  deleteInstance(instanceId: string, expectedGeneration: number, correlation?: RuntimeCorrelation): void {
    this.assertWritable();
    const startedAt = Date.now();
    try {
      this.connection.transaction(() => {
        this.assertInstanceLease();
        const result = this.connection.prepare(
          "DELETE FROM world_instances WHERE id = ? AND generation = ?",
        ).run(instanceId, expectedGeneration);
        if (result.changes === 1) return;
        const exists = this.connection.prepare("SELECT 1 FROM world_instances WHERE id = ?").get(instanceId);
        if (!exists) throw new WorldInstanceNotFoundError(instanceId);
        throw new WorldInstanceConflictError(instanceId);
      })();
      this.validatedInstances.delete(instanceId);
      this.observe?.({
        event: "persistence.delete.completed",
        correlation: { ...correlation, instanceId },
        durationMs: Math.max(0, Date.now() - startedAt),
        attributes: { sink: "sqlite" },
      });
    } catch (error) {
      this.observe?.({
        event: "persistence.delete.failed",
        level: "error",
        correlation: { ...correlation, instanceId },
        durationMs: Math.max(0, Date.now() - startedAt),
        attributes: { sink: "sqlite" },
        error: serializeRuntimeError(error),
      });
      throw error;
    }
  }

  close(): void {
    if (this.closed) return;
    for (const writer of this.executionWriters.values()) writer.flush();
    this.executionWriters.clear();
    this.closed = true;
    this.validatedInstances.clear();
    this.executionListeners.clear();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    try {
      if (!this.readOnly) {
        this.connection.prepare("DELETE FROM instance_lock WHERE singleton = 1 AND owner_id = ?").run(this.ownerId);
      }
    } finally {
      this.connection.close();
    }
  }
}
