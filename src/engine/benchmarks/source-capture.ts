import { contentHash } from "../models/model-audit";
import type { RuntimeEvent, RuntimeObserver } from "../runtime/observability";
import { fullRuntimePayload } from "../runtime/observability";
import type { AgentActionProposal } from "../contracts/model";
import { validateAlgorithmRef, type AlgorithmRef } from "../algorithms/composition";

export const BENCHMARK_SOURCE_CAPTURE_EVENT = "model.action_compilation.context.captured" as const;

export interface RawBenchmarkSource {
  schemaVersion: 2;
  sourceExecutionId: string;
  sourceInvocationId: string;
  logicalInvocationId?: string;
  role: string;
  slotIndices: number[];
  fullContext: Record<string, unknown>;
  stateSnapshot: unknown;
  stateHash: string;
  actions: AgentActionProposal[];
  actionIds: string[];
  fullContextHash: string;
  modelContextHash?: string;
  shortlistHash?: string;
  captureAlgorithmRef: AlgorithmRef<"world-execution">;
  captureAlgorithmManifestHash: string;
  worldHash: string;
  candidateCatalogHash: string;
  modelCatalogHash: string;
  registrySnapshotHash: string;
  modelId: string;
  promptVersion: string;
  profileId: string;
  projectorVersion: string;
  candidateKeyVersion: number;
  candidateKeyPayloadLength: number;
  symbolRepairPolicyVersion: string;
  outputDisposition?: string;
  rawOutputHash?: string;
  normalizedOutputHash?: string;
  repairCount?: number;
}

export interface RegeneratedActionCompilationReference {
  fullContextHash: string;
  providerRequests: number;
  fullyValidated: true;
  slots: Array<{
    slotIndex: number;
    requiredCandidateKeys: string[];
    repairCount: number;
    rawOutputHash: string;
    normalizedOutputHash: string;
  }>;
}

export interface BenchmarkSourceAdapter<TCapture extends RawBenchmarkSource = RawBenchmarkSource, TReference = unknown> {
  readonly id: string;
  readonly role: string;
  captureLedgerEvidence(events: readonly RuntimeEvent[]): TCapture[];
  regenerateFullReference(source: TCapture): Promise<TReference>;
  validateReference(reference: TReference): void;
}

function hasSecret(value: unknown): boolean {
  const sensitiveKey = /^(?:authorization|proxy-authorization|api[_-]?key|x-api-key|cookie|set-cookie|access-token|refresh-token|client-secret)$/iu;
  const bearerValue = /^bearer\s+[A-Za-z0-9._~+/=-]+$/u;
  const visit = (current: unknown, parentKey?: string): boolean => {
    if (Array.isArray(current)) return current.some((item) => visit(item, parentKey));
    if (!current || typeof current !== "object") {
      return typeof current === "string" && (bearerValue.test(current) || Boolean(parentKey && sensitiveKey.test(parentKey)));
    }
    return Object.entries(current).some(([key, child]) => sensitiveKey.test(key) || visit(child, key));
  };
  return visit(value);
}

export function assertSafeBenchmarkSource(value: unknown): void {
  if (hasSecret(value)) throw new Error("benchmark source contains a credential-like field");
}

export function validateActionCompilationCapturedSource(value: unknown): RawBenchmarkSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Action Compilation capture must be an object");
  }
  const payload = value as RawBenchmarkSource;
  const strings: Array<keyof RawBenchmarkSource> = [
    "sourceExecutionId", "sourceInvocationId", "role", "fullContextHash", "stateHash",
    "captureAlgorithmManifestHash", "worldHash", "candidateCatalogHash", "modelCatalogHash",
    "registrySnapshotHash", "modelId", "promptVersion", "profileId", "projectorVersion",
    "symbolRepairPolicyVersion",
  ];
  if (payload.schemaVersion !== 2 || strings.some((key) => typeof payload[key] !== "string" || !(payload[key] as string).trim()) ||
    payload.role !== "action-compilation" || !payload.fullContext || typeof payload.fullContext !== "object" ||
    !payload.stateSnapshot || !Array.isArray(payload.actions) || !Array.isArray(payload.actionIds) ||
    !Array.isArray(payload.slotIndices) || payload.slotIndices.some((slot) => !Number.isSafeInteger(slot) || slot < 0) ||
    payload.actions.length === 0 || payload.actions.length !== payload.actionIds.length ||
    payload.actions.length !== payload.slotIndices.length ||
    !Number.isSafeInteger(payload.candidateKeyVersion) || !Number.isSafeInteger(payload.candidateKeyPayloadLength)) {
    throw new Error("Action Compilation capture schema v2 is incomplete");
  }
  validateAlgorithmRef(payload.captureAlgorithmRef);
  if (payload.captureAlgorithmRef.manifestHash !== payload.captureAlgorithmManifestHash ||
    contentHash(payload.fullContext) !== payload.fullContextHash ||
    contentHash(payload.stateSnapshot) !== payload.stateHash ||
    contentHash(payload.actions.map((action) => action.id)) !== contentHash(payload.actionIds)) {
    throw new Error("Action Compilation capture provenance hash mismatch");
  }
  assertSafeBenchmarkSource(payload);
  return structuredClone(payload);
}

export function emitActionCompilationFullContextCapture(
  observer: RuntimeObserver,
  source: Omit<RawBenchmarkSource, "fullContextHash"> & { fullContextHash?: string },
): RawBenchmarkSource {
  assertSafeBenchmarkSource(source.fullContext);
  const fullContextHash = source.fullContextHash ?? contentHash(source.fullContext);
  const captured = { ...source, fullContextHash };
  observer.emit({
    event: BENCHMARK_SOURCE_CAPTURE_EVENT,
    level: "debug",
    hashes: {
      fullContext: fullContextHash,
      ...(source.modelContextHash ? { modelContext: source.modelContextHash } : {}),
      ...(source.shortlistHash ? { shortlist: source.shortlistHash } : {}),
    },
    counts: { slots: source.slotIndices.length, actions: source.actionIds.length },
    payload: fullRuntimePayload(observer, captured),
  });
  return captured;
}

export function readActionCompilationCapturedSources(events: readonly RuntimeEvent[]): RawBenchmarkSource[] {
  const sources: RawBenchmarkSource[] = [];
  for (const event of events) {
    if (event.event !== BENCHMARK_SOURCE_CAPTURE_EVENT ||
      (event.correlation?.semanticRepairAttempt ?? 0) !== 0 ||
      !event.payload || typeof event.payload !== "object") continue;
    const payload = validateActionCompilationCapturedSource(event.payload);
    sources.push({
      ...payload,
      slotIndices: [...payload.slotIndices],
      actions: structuredClone(payload.actions),
      actionIds: [...payload.actionIds],
    });
  }
  return sources.sort((left, right) => left.fullContextHash.localeCompare(right.fullContextHash) || left.sourceInvocationId.localeCompare(right.sourceInvocationId));
}

export function createActionCompilationSourceAdapter(
  regenerate: (source: RawBenchmarkSource) => Promise<unknown>,
  validate: (reference: unknown) => void,
): BenchmarkSourceAdapter {
  return {
    id: "action-compilation-fullcatalog",
    role: "action-compilation",
    captureLedgerEvidence: readActionCompilationCapturedSources,
    regenerateFullReference: regenerate,
    validateReference: validate,
  };
}
