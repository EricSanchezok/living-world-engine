import type {
  ExecutionKind,
  ExecutionProducerManifest,
  ExecutionRef,
  ExecutionTraceWriter,
} from "../engine/runtime/execution";
import type {
  RuntimeEvent,
  RuntimeEventInput,
} from "../engine/runtime/observability";

export type ExecutionStatus = "running" | "succeeded" | "failed" | "cancelled";

export interface BeginExecutionInput {
  id: string;
  kind: ExecutionKind;
  parentExecutionId?: string;
  instanceId?: string;
  advanceId?: string;
  step?: number;
  manifest: ExecutionProducerManifest;
  worldHash: string;
  codeRevision: string;
  codeDirty: boolean;
  modelCatalogHash: string;
  seed: number;
  runtimeConfig: Readonly<Record<string, unknown>>;
  startedAt?: string;
}

export interface FinishExecutionInput {
  status: Exclude<ExecutionStatus, "running">;
  semanticHash?: string;
  stateHash?: string;
  commitRevision?: number;
  error?: unknown;
  finishedAt?: string;
}

export interface ExecutionRecord extends BeginExecutionInput {
  status: ExecutionStatus;
  traceId: string;
  semanticHash?: string;
  stateHash?: string;
  commitRevision?: number;
  terminalEventSequence?: number;
  traceHash?: string;
  errorArtifactHash?: string;
  finishedAt?: string;
}

export interface ExecutionArtifactRecord {
  hash: string;
  executionId: string;
  kind: string;
  mediaType: string;
  encoding: "json-blocks";
  rawBytes: number;
  /** Compressed block bytes first inserted for this artifact; shared content is counted once. */
  storedBytes: number;
  createdAt: string;
  value: unknown;
}

/** Live query notifications omit bodies; complete payloads remain in the Ledger. */
export interface ExecutionEventSummary extends Omit<RuntimeEvent, "payload"> {
  hasPayload: boolean;
}

export interface ExecutionLedger {
  beginExecution(input: BeginExecutionInput): ExecutionTraceWriter;
  finishExecution(executionId: string, input: FinishExecutionInput): ExecutionRef;
  execution(executionId: string): ExecutionRecord | undefined;
  executions(input?: { kind?: ExecutionKind; parentExecutionId?: string; instanceId?: string }): ExecutionRecord[];
  executionEvents(executionId: string): RuntimeEvent[];
  instanceEvents(instanceId: string): RuntimeEvent[];
  artifact(hash: string): ExecutionArtifactRecord | undefined;
  appendExecutionEvent(executionId: string, input: RuntimeEventInput): RuntimeEvent;
  appendExecutionEvents(executionId: string, inputs: readonly RuntimeEventInput[]): RuntimeEvent[];
  putExecutionArtifact(executionId: string, kind: string, value: unknown): string;
  subscribe(listener: (event: RuntimeEvent) => void): () => void;
  subscribeSummaries(listener: (event: ExecutionEventSummary) => void, filter?: { instanceId: string }): () => void;
}
