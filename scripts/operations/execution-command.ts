import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { aggregateMetricPoints, deriveExecutionWork, EXECUTION_METRICS } from "../../src/engine/runtime/execution-metrics";
import {
  algorithmRef,
  resolutionObservations,
  BootstrapCandidate,
  PolicyBinding,
  type WorldExecutionAlgorithmRegistry,
  WorldAdvanceRequest,
  WorldStepCandidate,
} from "../../src/engine/runtime/execution";
import { ModelCatalog, type ModelCatalogDocument, type ModelRole } from "../../src/engine/models/model-catalog";
import type { ModelExecutionAudit, ModelInvocationAudit, SimulationState } from "../../src/engine/contracts/model";
import { contentHash } from "../../src/engine/models/model-audit";
import { redactRuntimePayload, type RuntimeEvent } from "../../src/engine/runtime/observability";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider, type StructuredModelRequest, type StructuredModelResult } from
  "../../src/engine/models/model-provider";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import type { WorldDefinition } from "../../src/engine/runtime/world-definition";
import { LocalDatabase } from "../../src/server/local-database";
import { runtimeCodeIdentity } from "../../src/server/code-identity";
import {
  loadInvocationProbeReport,
  sanitizeInvocationProbeReport,
  type InvocationProbeReplayOverride,
} from "../../src/engine/models/model-invocation-probe";

function argumentsFor(argv: readonly string[]): {
  executionIds: string[];
  database: string;
  output?: string;
  probeReport?: string;
  trial: number;
} {
  const executionIds: string[] = [];
  let database = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23", "livingworld.sqlite");
  let output: string | undefined;
  let probeReport: string | undefined;
  let trial = 1;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--database") database = path.resolve(argv[++index] ?? "");
    else if (value === "--output") output = path.resolve(argv[++index] ?? "");
    else if (value === "--probe-report") probeReport = path.resolve(argv[++index] ?? "");
    else if (value === "--trial") {
      const parsed = Number(argv[++index] ?? "");
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("--trial must be a positive integer");
      trial = parsed;
    }
    else if (value.startsWith("--")) throw new Error(`unknown argument: ${value}`);
    else executionIds.push(value);
  }
  if (executionIds.length === 0) throw new Error("at least one execution id is required");
  return { executionIds, database, output, probeReport, trial };
}

function event(events: readonly RuntimeEvent[], name: string, phase?: string): RuntimeEvent {
  const found = events.find((candidate) => candidate.event === name &&
    (phase === undefined || candidate.attributes?.phase === phase));
  if (!found) throw new Error(`recorded execution is missing ${name}${phase ? ` (${phase})` : ""}`);
  return found;
}

interface RecordedOutput {
  event: RuntimeEvent;
  value: unknown;
  audit: ModelExecutionAudit;
}

interface ReplayProbeBinding {
  override: InvocationProbeReplayOverride;
  targetAudit: ModelExecutionAudit;
  targetInvocation: ModelInvocationAudit;
}

function recordedCatalog(audits: readonly ModelExecutionAudit[]): ModelCatalog {
  const accounts: ModelCatalogDocument["accounts"] = {};
  const profiles: ModelCatalogDocument["profiles"] = {};
  for (const audit of audits) {
    accounts[audit.accountId] ??= {
      channel: audit.accountChannel,
      region: "replay",
      protocol: audit.protocol,
      dialect: audit.dialect,
      models_dev_provider_id: audit.providerId,
      base_url: "https://recorded.invalid",
      api_key_env: "RECORDED_REPLAY_API_KEY",
      max_concurrency: 1024,
    };
    const current = profiles[audit.profileId];
    const roles = new Set<ModelRole>(current?.allowed_roles ?? []);
    roles.add(audit.role);
    profiles[audit.profileId] = {
      account_id: audit.accountId,
      selector: { kind: "exact", model_id: audit.modelId },
      description: "Recorded execution replay",
      allowed_roles: [...roles],
      request_timeout_ms: 1_000,
      max_output_tokens: 1,
      max_input_bytes: 128 * 1024 * 1024,
      inference: structuredClone(audit.requestedInference),
    };
  }
  return new ModelCatalog({
    schema_version: 3,
    scheduler: { global_concurrency: 1024, max_queued_requests: 4096, queue_timeout_ms: 1_000 },
    registry: {
      refresh_interval_ms: 3_600_000,
      request_timeout_ms: 10_000,
      stale_after_ms: 86_400_000,
    },
    accounts,
    profiles,
    model_overrides: {},
  });
}

class RecordedModelProvider implements StructuredModelProvider {
  readonly catalog: ModelCatalog;
  private readonly outputs = new Map<string, RecordedOutput>();
  private readonly consumed = new Set<string>();
  private readonly lineage = new Map<string, RuntimeEvent["correlation"]>();
  private readonly overlay?: ReplayProbeBinding;
  private overlayConsumed = false;
  private overlayOutcome: "accepted" | "rejected" | "not-reached" = "not-reached";
  private readonly allowedOverlayLineage = new Set<string>();

  constructor(
    events: readonly RuntimeEvent[],
    candidates: readonly (BootstrapCandidate | WorldStepCandidate)[],
    overlay?: ReplayProbeBinding,
  ) {
    this.overlay = overlay;
    // Candidate audits are logical projections: several slots can share one
    // physical invocation while owning different subjects and result shapes.
    const replayedInvocations = new Set(candidates.flatMap((candidate) => candidate.modelAudits)
      .flatMap((audit) => audit.invocations.map((invocation) => invocation.id)));
    const audits = events.filter((event) => event.event === "model.audit.persisted")
      .map((event) => event.payload as ModelExecutionAudit)
      .filter((audit) => audit.invocations.some((invocation) => replayedInvocations.has(invocation.id)));
    this.catalog = recordedCatalog(audits);
    const auditByInvocation = new Map<string, { audit: ModelExecutionAudit; invocation: ModelInvocationAudit }>();
    for (const audit of audits) {
      for (const invocation of audit.invocations) auditByInvocation.set(invocation.id, { audit, invocation });
    }
    for (const event of events) {
      if (event.event !== "model.structured_output.parsed" && event.event !== "model.structured_output.rejected") continue;
      const invocationId = event.correlation?.modelInvocationId;
      if (!invocationId || event.payload === undefined) continue;
      if (!replayedInvocations.has(invocationId)) continue;
      const recorded = auditByInvocation.get(invocationId);
      if (!recorded) throw new ModelConfigurationError(`recorded model output has no physical audit: ${invocationId}`);
      this.outputs.set(invocationId, {
        event,
        value: structuredClone(event.payload),
        audit: { ...structuredClone(recorded.audit), invocations: [structuredClone(recorded.invocation)] },
      });
      this.lineage.set(invocationId, event.correlation);
    }
    if (overlay) {
      const target = overlay.targetInvocation.id;
      const targetLogical = this.lineage.get(target)?.logicalInvocationId;
      for (const [id, correlation] of this.lineage) {
        if (id === target || (targetLogical && correlation?.logicalInvocationId === targetLogical)) {
          this.allowedOverlayLineage.add(id);
        }
      }
      // Older traces may omit logicalInvocationId on one repair event; follow
      // explicit parent/repair links to retain the same logical lineage.
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, correlation] of this.lineage) {
          if (this.allowedOverlayLineage.has(id)) continue;
          if (correlation?.parentInvocationId && this.allowedOverlayLineage.has(correlation.parentInvocationId) ||
            correlation?.repairOf && this.allowedOverlayLineage.has(correlation.repairOf)) {
            this.allowedOverlayLineage.add(id);
            changed = true;
          }
        }
      }
    }
  }

  availableProfileSummaries(role?: ModelRole) {
    return this.catalog.profileSummaries(role);
  }

  async assertProfilesAvailable(profileIds: readonly string[]): Promise<void> {
    for (const profileId of profileIds) this.catalog.assertProfile(profileId);
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    const invocationId = request.modelInvocationId;
    if (!invocationId) throw new ModelConfigurationError("recorded replay requires canonical model invocation identity");
    const isOverlayTarget = this.overlay?.targetInvocation.id === invocationId;
    if (isOverlayTarget) {
      if (this.overlayConsumed) throw new Error(`probe overlay was consumed twice: ${invocationId}`);
      const target = this.overlay!;
      if (target.targetAudit.role !== request.role || target.targetAudit.subjectId !== request.subjectId ||
        target.targetAudit.profileId !== request.profileId) {
        throw new Error(`probe overlay identity mismatch: ${invocationId}`);
      }
      this.overlayConsumed = true;
      const trial = target.override.trial;
      const audit = reboundAudit(trial.audit!, target.targetInvocation);
      request.observer?.emit({
        event: "model.replay_output.consumed",
        correlation: { ...request.correlation, modelInvocationId: invocationId },
        hashes: { response: audit.invocations[0]?.responseHash ?? contentHash(trial.status === "accepted" ? trial.output : trial.rawOutput) },
        payload: trial.status === "accepted" ? trial.output : trial.rawOutput,
        attributes: {
          replayMode: "probe-overlay",
          probeId: target.override.report.probeId,
          trial: trial.trial,
        },
      });
      if (trial.status === "rejected") {
        this.overlayOutcome = "rejected";
        throw new ModelOutputError(
          typeof trial.error === "object" && trial.error && "message" in trial.error
            ? String((trial.error as { message: unknown }).message)
            : "probe trial supplied a rejected model output",
          audit,
          { rawValue: trial.rawOutput },
        );
      }
      const parsed = request.schema.safeParse(trial.output);
      if (!parsed.success) {
        this.overlayOutcome = "rejected";
        throw new ModelOutputError(parsed.error.message, audit, { rawValue: trial.output });
      }
      this.overlayOutcome = "accepted";
      return { value: parsed.data, audit };
    }
    const output = this.outputs.get(invocationId);
    if (!output) throw new ModelConfigurationError(`recorded model output not found: ${invocationId}`);
    if (this.consumed.has(invocationId)) throw new ModelConfigurationError(`recorded model output was consumed twice: ${invocationId}`);
    if (output.audit.role !== request.role || output.audit.subjectId !== request.subjectId ||
      output.audit.profileId !== request.profileId) {
      throw new ModelConfigurationError(`recorded model output identity mismatch: ${invocationId}`);
    }
    this.consumed.add(invocationId);
    request.observer?.emit({
      event: "model.replay_output.consumed",
      correlation: { ...request.correlation, modelInvocationId: invocationId },
      links: output.event.traceId && output.event.spanId
        ? [{ traceId: output.event.traceId, spanId: output.event.spanId }]
        : [],
      hashes: { response: output.audit.invocations[0].responseHash ?? contentHash(output.value) },
      payload: output.value,
    });
    const parsed = request.schema.safeParse(output.value);
    if (!parsed.success) throw new ModelOutputError(parsed.error.message, output.audit);
    return { value: parsed.data, audit: structuredClone(output.audit) };
  }

  assertFullyConsumed(): { consumedRecordedInvocationIds: string[]; skippedRecordedInvocationIds: string[] } {
    if (this.overlay && !this.overlayConsumed) throw new Error(`probe overlay invocation was not reached: ${this.overlay.targetInvocation.id}`);
    const missing = [...this.outputs.keys()].filter((id) => !this.consumed.has(id) && !this.allowedOverlayLineage.has(id));
    if (missing.length > 0) {
      throw new Error(this.overlay
        ? `recorded replay left ${missing.length} unrelated model outputs unused`
        : `recorded replay left ${missing.length} model outputs unused`);
    }
    return {
      consumedRecordedInvocationIds: [...this.consumed].sort(),
      skippedRecordedInvocationIds: [...this.outputs.keys()].filter((id) => !this.consumed.has(id)).sort(),
    };
  }

  overlaySemantic(): "accepted" | "rejected" | "not-reached" {
    return this.overlayOutcome;
  }

  overlayWasConsumed(): boolean {
    return this.overlayConsumed;
  }

  consumptionSnapshot(): { consumedRecordedInvocationIds: string[]; skippedRecordedInvocationIds: string[] } {
    return {
      consumedRecordedInvocationIds: [...this.consumed].sort(),
      skippedRecordedInvocationIds: [...this.outputs.keys()].filter((id) => !this.consumed.has(id)).sort(),
    };
  }
}

function reboundAudit(audit: ModelExecutionAudit, target: ModelInvocationAudit): ModelExecutionAudit {
  const invocation = audit.invocations.at(-1);
  if (!invocation) throw new Error("probe trial audit has no invocation");
  return {
    ...structuredClone(audit),
    invocations: [{ ...structuredClone(invocation), id: target.id, ordinal: target.ordinal }],
  };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateProbeBinding(
  original: NonNullable<ReturnType<LocalDatabase["execution"]>>,
  events: readonly RuntimeEvent[],
  override: InvocationProbeReplayOverride,
): ReplayProbeBinding {
  const { report, trial } = override;
  const sanitizedReport = sanitizeInvocationProbeReport(report);
  if (override.reportHash !== contentHash(redactRuntimePayload(sanitizedReport))) {
    throw new Error("probe report hash is invalid");
  }
  if (report.source.executionId !== original.id || report.source.publicInvocationId !==
    `${original.id}::${report.source.sourceInvocationId}`) {
    throw new Error("probe report source execution does not match the replay execution");
  }
  const replayPhase = events.some((candidate) => candidate.event === "step.started") ? "step" : "bootstrap";
  const candidates = events.filter((candidate) => candidate.event === "execution.candidate.persisted" &&
    candidate.attributes?.phase === replayPhase)
    .map((candidate) => candidate.payload as BootstrapCandidate | WorldStepCandidate);
  const audits = candidates.flatMap((candidate) => candidate.modelAudits);
  let targetAudit: ModelExecutionAudit | undefined;
  let targetInvocation: ModelInvocationAudit | undefined;
  for (const audit of audits) {
    const invocation = audit.invocations.find((entry) => entry.id === report.source.sourceInvocationId);
    if (invocation) {
      targetAudit = audit;
      targetInvocation = invocation;
      break;
    }
  }
  if (!targetAudit || !targetInvocation) throw new Error(`probe target invocation not found in Ledger: ${report.source.sourceInvocationId}`);
  if (typeof report.source.requestHash !== "string" || report.source.requestHash !== targetInvocation.requestHash ||
    trial.requestHash !== targetInvocation.requestHash) {
    throw new Error("probe request hash does not match the recorded invocation");
  }
  if (report.source.modelCatalogHash !== targetAudit.modelCatalogHash ||
    report.source.registrySnapshotHash !== targetAudit.registrySnapshotHash ||
    report.profile.catalogHash !== targetAudit.modelCatalogHash ||
    report.profile.registrySnapshotHash !== targetAudit.registrySnapshotHash) {
    throw new Error("probe report model profile snapshot differs from the recorded invocation");
  }
  if (report.profile.sourceProfileId !== targetAudit.profileId || report.profile.effectiveProfileId !== targetAudit.profileId ||
    report.profile.overridden || report.profile.drift.length > 0) {
    throw new Error("probe report profile drift is not overlayable");
  }
  const probeInvocation = trial.audit?.invocations.at(-1);
  if (!probeInvocation || probeInvocation.requestHash !== targetInvocation.requestHash ||
    trial.audit?.role !== targetAudit.role || trial.audit.subjectId !== targetAudit.subjectId ||
    trial.audit.profileId !== targetAudit.profileId || trial.audit.accountId !== targetAudit.accountId ||
    trial.audit.accountChannel !== targetAudit.accountChannel || trial.audit.protocol !== targetAudit.protocol ||
    trial.audit.dialect !== targetAudit.dialect || trial.audit.providerId !== targetAudit.providerId ||
    trial.audit.modelId !== targetAudit.modelId ||
    trial.audit.promptVersion !== targetAudit.promptVersion ||
    trial.audit.modelCatalogHash !== targetAudit.modelCatalogHash ||
    trial.audit.registrySnapshotHash !== targetAudit.registrySnapshotHash ||
    trial.audit.modelMetadataHash !== targetAudit.modelMetadataHash ||
    trial.audit.structuredOutputMode !== targetAudit.structuredOutputMode ||
    contentHash(trial.audit.selector) !== contentHash(targetAudit.selector) ||
    contentHash(trial.audit.requestedInference) !== contentHash(targetAudit.requestedInference) ||
    contentHash(trial.audit.resolvedInference) !== contentHash(targetAudit.resolvedInference)) {
    throw new Error("probe trial audit identity does not match the recorded invocation");
  }
  const sourceContextEvent = events.find((candidate) => candidate.event === "model.context.serialized" &&
    candidate.correlation?.modelInvocationId === targetInvocation!.id && candidate.payload !== undefined);
  const sourceContext = objectRecord(sourceContextEvent?.payload);
  if (!sourceContext) throw new Error("recorded invocation has no complete model context for exact probe matching");
  const expectedRequest = {
    role: sourceContext.role,
    subjectId: sourceContext.subjectId,
    promptVersion: sourceContext.promptVersion,
    schemaName: sourceContext.schemaName,
    workloadId: sourceContext.workloadId,
    batchId: sourceContext.batchId,
    system: sourceContext.system,
    userPrompt: sourceContext.userPrompt,
    context: sourceContext.context,
    schema: sourceContext.schema,
  };
  if (contentHash(report.request) !== contentHash(expectedRequest)) {
    throw new Error("probe report request differs from the recorded model context");
  }
  const expectedTrialRequest = {
    profileId: sourceContext.profileId,
    role: expectedRequest.role,
    subjectId: expectedRequest.subjectId,
    promptVersion: expectedRequest.promptVersion,
    schemaName: expectedRequest.schemaName,
    workloadId: expectedRequest.workloadId,
    batchId: expectedRequest.batchId,
    system: expectedRequest.system,
    userPrompt: expectedRequest.userPrompt,
    context: expectedRequest.context,
  };
  if (contentHash(trial.request) !== contentHash(expectedTrialRequest)) {
    throw new Error("probe trial request differs from the recorded model context");
  }
  return { override, targetAudit, targetInvocation };
}

function engineSemantic(
  events: readonly RuntimeEvent[],
  target: ReplayProbeBinding | undefined,
  fallback: "accepted" | "rejected" | "not-reached" = "not-reached",
): "accepted" | "rejected" | "not-reached" {
  if (!target) return "not-reached";
  const targetId = target.targetInvocation.id;
  const targetLogical = events.find((event) => event.correlation?.modelInvocationId === targetId)
    ?.correlation?.logicalInvocationId;
  const relevant = events.filter((event) => event.correlation?.modelInvocationId === targetId ||
    (targetLogical !== undefined && event.correlation?.logicalInvocationId === targetLogical));
  if (relevant.some((event) => event.event === "model.semantic.accepted")) return "accepted";
  if (relevant.some((event) => event.event === "model.semantic.rejected" || event.event === "model.structured_output.rejected")) {
    return "rejected";
  }
  return fallback;
}

export async function replayThroughAlgorithm(
  database: LocalDatabase,
  original: NonNullable<ReturnType<LocalDatabase["execution"]>>,
  events: readonly RuntimeEvent[],
  algorithmRegistryOrOptions?: WorldExecutionAlgorithmRegistry | { probe?: InvocationProbeReplayOverride },
  options: { probe?: InvocationProbeReplayOverride } = {},
): Promise<{
  replayExecutionId: string;
  semanticHash?: string;
  stateHash?: string;
  revision?: number;
  mode: "recorded" | "probe-overlay";
  replayStatus: "succeeded" | "failed";
  engineSemantic: "accepted" | "rejected" | "not-reached";
  probeId?: string;
  reportHash?: string;
  trial?: number;
  targetInvocation?: string;
  consumedRecordedInvocationIds: string[];
  skippedRecordedInvocationIds: string[];
  error?: unknown;
}> {
  const algorithmRegistry = algorithmRegistryOrOptions && "create" in algorithmRegistryOrOptions
    ? algorithmRegistryOrOptions
    : undefined;
  const replayOptions: { probe?: InvocationProbeReplayOverride } = algorithmRegistry
    ? options
    : algorithmRegistryOrOptions && "probe" in algorithmRegistryOrOptions
      ? algorithmRegistryOrOptions
      : options;
  if (original.manifest.kind !== "algorithm") {
    throw new Error(`recorded replay requires an algorithm producer; found ${original.manifest.kind}`);
  }
  const definitionEvent = event(events, "execution.world_definition.persisted");
  const definition = definitionEvent.payload as WorldDefinition;
  const stepInputs = events.filter((candidate) => candidate.event === "step.started")
    .map((candidate) => candidate.payload as {
      state: SimulationState;
      policyRoster: Record<string, PolicyBinding>;
      request: WorldAdvanceRequest;
    });
  const candidates = events.filter((candidate) => candidate.event === "execution.candidate.persisted" &&
    candidate.attributes?.phase === (stepInputs.length > 0 ? "step" : "bootstrap"))
    .map((candidate) => candidate.payload as BootstrapCandidate | WorldStepCandidate);
  const overlay = replayOptions.probe ? validateProbeBinding(original, events, replayOptions.probe) : undefined;
  const provider = new RecordedModelProvider(events, candidates, overlay);
  const registry = registerBuiltinAlgorithms(algorithmRegistry);
  const recordedRef = algorithmRef(original.manifest);
  const createAlgorithm = () => registry.create(recordedRef, {
    provider,
    rulePackages: database.rulePackages,
  });
  const code = runtimeCodeIdentity();
  const replayExecutionId = randomUUID();
  const trace = database.beginExecution({
    id: replayExecutionId,
    kind: "replay",
    parentExecutionId: original.id,
    instanceId: original.instanceId,
    advanceId: original.advanceId,
    step: original.step,
    manifest: original.manifest,
    worldHash: original.worldHash,
    codeRevision: code.revision,
    codeDirty: code.dirty,
    modelCatalogHash: original.modelCatalogHash,
    seed: original.seed,
    runtimeConfig: {
      sourceExecutionId: original.id,
      recordedModelOutputs: true,
      networkAccessed: false,
      replayMode: overlay ? "probe-overlay" : "recorded",
      ...(overlay ? {
        probeNetworkAccessed: true,
        replayNetworkAccessed: false,
        probeId: overlay.override.report.probeId,
        reportHash: overlay.override.reportHash,
        probeReportHash: overlay.override.reportHash,
        probeTrial: overlay.override.trial.trial,
        probeTargetInvocation: overlay.targetInvocation.id,
        requestExactMatch: overlay.override.trial.requestExactMatch,
      } : {}),
    },
  });
  let integrityCheckStarted = false;
  try {
    if (overlay) {
      trace.artifact("debug.model-invocation-probe.report", redactRuntimePayload(sanitizeInvocationProbeReport(overlay.override.report)));
      trace.emit({
        event: "debug.probe.overlay.applied",
        correlation: { executionId: replayExecutionId, modelInvocationId: overlay.targetInvocation.id },
        attributes: {
          replayMode: "probe-overlay",
          probeId: overlay.override.report.probeId,
          reportHash: overlay.override.reportHash,
          trial: overlay.override.trial.trial,
          targetInvocation: overlay.targetInvocation.id,
          requestExactMatch: overlay.override.trial.requestExactMatch,
          probeNetworkAccessed: true,
          replayNetworkAccessed: false,
        },
        hashes: { report: overlay.override.reportHash, request: overlay.targetInvocation.requestHash },
      });
    }
    const semanticHashes: string[] = [];
    let finalState: SimulationState | undefined;
    if (stepInputs.length > 0) {
      for (const [index, input] of stepInputs.entries()) {
        const engine = new SimulationEngine(definition, createAlgorithm(), input.state);
        const result = await engine.step(input.policyRoster, input.request, {
          workloadId: `replay:${original.id}`,
          batchId: `replay:${original.id}:${index + 1}`,
          correlation: {
            executionId: replayExecutionId,
            instanceId: original.instanceId,
            advanceId: original.advanceId,
            revision: input.state.revision,
            step: input.state.step + 1,
          },
          observer: trace,
        });
        semanticHashes.push(result.committed.semanticHash);
        finalState = result.state;
      }
    } else {
      const source = (event(events, "instance.bootstrap.started").payload as { state: SimulationState }).state;
      const engine = new SimulationEngine(definition, createAlgorithm(), source);
      finalState = await engine.bootstrapAgents({
        workloadId: `replay:${original.id}`,
        batchId: `replay:${original.id}:bootstrap`,
        correlation: { executionId: replayExecutionId, revision: source.revision, step: source.step },
        observer: trace,
      });
    }
    if (!finalState) throw new Error("recorded replay produced no state");
    integrityCheckStarted = true;
    const consumption = provider.assertFullyConsumed();
    const semanticHash = semanticHashes.length > 0
      ? original.kind === "benchmark" ? contentHash(semanticHashes) : semanticHashes.at(-1)!
      : contentHash({ bootstrapAgentCommits: finalState.bootstrapAgentCommits });
    const stateHash = contentHash(finalState);
    database.finishExecution(replayExecutionId, {
      status: "succeeded",
      semanticHash,
      stateHash,
      commitRevision: finalState.revision,
    });
    const childEvents = database.executionEvents(replayExecutionId);
    return {
      replayExecutionId,
      semanticHash,
      stateHash,
      revision: finalState.revision,
      mode: overlay ? "probe-overlay" : "recorded",
      replayStatus: "succeeded",
      engineSemantic: engineSemantic(childEvents, overlay, provider.overlaySemantic()),
      ...(overlay ? {
        probeId: overlay.override.report.probeId,
        reportHash: overlay.override.reportHash,
        trial: overlay.override.trial.trial,
        targetInvocation: overlay.targetInvocation.id,
      } : {}),
      ...consumption,
    };
  } catch (error) {
    if (database.execution(replayExecutionId)?.status === "running") {
      database.finishExecution(replayExecutionId, { status: "failed", error });
    }
    if (overlay) {
      if (integrityCheckStarted) throw error;
      if (!provider.overlayWasConsumed()) {
        throw new Error(`probe overlay invocation was not reached: ${overlay.targetInvocation.id}`);
      }
      const childEvents = database.executionEvents(replayExecutionId);
      return {
        replayExecutionId,
        mode: "probe-overlay",
        replayStatus: "failed",
        engineSemantic: engineSemantic(childEvents, overlay, provider.overlaySemantic()),
        probeId: overlay.override.report.probeId,
        reportHash: overlay.override.reportHash,
        trial: overlay.override.trial.trial,
        targetInvocation: overlay.targetInvocation.id,
        ...provider.consumptionSnapshot(),
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
      };
    }
    throw error;
  }
}

export function candidatePartitions(events: readonly RuntimeEvent[]) {
  const recorded = events.filter((candidate) => candidate.event === "execution.candidate.persisted");
  const selected = recorded.findLast((candidate) => candidate.attributes?.phase === "step") ?? recorded.at(-1);
  if (!selected) throw new Error("recorded execution is missing execution.candidate.persisted");
  const candidate = selected.payload as WorldStepCandidate | BootstrapCandidate;
  if (!("resolution" in candidate)) {
    return { bootstrap: candidate.agentCommits };
  }
  return {
    resolution: {
      plans: candidate.resolution.resolutionPlans,
      receipts: candidate.resolution.resolutionReceipts,
      checkRequests: candidate.resolution.requests,
      checks: candidate.resolution.checks,
      randomRequests: candidate.resolution.randomRequests,
      randomResults: candidate.resolution.randomResults,
      mechanicInvocations: candidate.resolution.proposal.mechanicInvocations,
      mechanicResults: candidate.resolution.mechanicResults,
      causalAssertionResults: candidate.resolution.causalAssertionResults,
      causalVerification: candidate.resolution.causalVerification,
    },
    temporal: {
      plans: candidate.temporalPlans,
      boundary: candidate.temporalBoundary,
      state: candidate.temporalState,
      activityTransitions: candidate.activityTransitions,
      decisionPoints: candidate.decisionPoints,
    },
    transition: {
      actions: candidate.resolution.actions,
      outcomes: candidate.resolution.proposal.outcomes,
      operations: candidate.resolution.proposal.operations,
      events: candidate.resolution.proposal.events,
    },
    observation: resolutionObservations(candidate.resolution),
    mind: candidate.mindCommits,
  };
}

function comparePartitions(left: ReturnType<typeof candidatePartitions>, right: ReturnType<typeof candidatePartitions>) {
  const names = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  return Object.fromEntries(names.map((name) => {
    const leftValue = left[name as keyof typeof left] ?? null;
    const rightValue = right[name as keyof typeof right] ?? null;
    return [name, {
      equal: contentHash(leftValue) === contentHash(rightValue),
      leftHash: contentHash(leftValue),
      rightHash: contentHash(rightValue),
      ...(contentHash(leftValue) === contentHash(rightValue) ? {} : { left: leftValue, right: rightValue }),
    }];
  }));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const parsed = argumentsFor(process.argv.slice(3));
  const database = new LocalDatabase(parsed.database);
  try {
    if (command === "replay") {
      if (parsed.executionIds.length !== 1) throw new Error("replay accepts exactly one execution id");
      const execution = database.execution(parsed.executionIds[0]);
      if (!execution) throw new Error(`execution not found: ${parsed.executionIds[0]}`);
      const events = database.executionEvents(execution.id);
      if (!parsed.probeReport && parsed.trial !== 1) throw new Error("--trial requires --probe-report");
      const probe = parsed.probeReport ? loadInvocationProbeReport(parsed.probeReport, parsed.trial) : undefined;
      const result = await replayThroughAlgorithm(database, execution, events, undefined, { probe });
      const output = {
        executionId: execution.id,
        recordedSemanticHash: execution.semanticHash,
        recordedStateHash: execution.stateHash,
        ...result,
        semanticMatch: result.semanticHash !== undefined && execution.semanticHash === result.semanticHash,
        stateMatch: result.stateHash !== undefined && execution.stateHash === result.stateHash,
        semanticHashComparison: {
          original: execution.semanticHash ?? null,
          replay: result.semanticHash ?? null,
          equal: result.semanticHash !== undefined && execution.semanticHash === result.semanticHash,
        },
        stateHashComparison: {
          original: execution.stateHash ?? null,
          replay: result.stateHash ?? null,
          equal: result.stateHash !== undefined && execution.stateHash === result.stateHash,
        },
        networkAccessed: false,
        replayNetworkAccessed: false,
        probeNetworkAccessed: Boolean(probe),
      };
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
      if (!probe && (!output.semanticMatch || !output.stateMatch)) process.exitCode = 2;
      if (probe && result.replayStatus === "failed") process.exitCode = 0;
      return;
    }
    if (command === "compare") {
      if (parsed.executionIds.length !== 2) throw new Error("compare requires exactly two execution ids");
      const [leftId, rightId] = parsed.executionIds;
      const left = database.execution(leftId);
      const right = database.execution(rightId);
      if (!left || !right) throw new Error("one or both executions do not exist");
      process.stdout.write(`${JSON.stringify({
        left: { id: left.id, semanticHash: left.semanticHash },
        right: { id: right.id, semanticHash: right.semanticHash },
        semanticEqual: left.semanticHash === right.semanticHash,
        partitions: comparePartitions(
          candidatePartitions(database.executionEvents(left.id)),
          candidatePartitions(database.executionEvents(right.id)),
        ),
      }, null, 2)}\n`);
      return;
    }
    if (command === "export") {
      if (parsed.executionIds.length !== 1) throw new Error("export accepts exactly one execution id");
      const execution = database.execution(parsed.executionIds[0]);
      if (!execution) throw new Error(`execution not found: ${parsed.executionIds[0]}`);
      const events = database.executionEvents(execution.id);
      const artifactHashes = [...new Set(events.flatMap((candidate) =>
        candidate.payload === undefined ? [] : [contentHash(candidate.payload)]))];
      const output = {
        schemaVersion: 1,
        execution,
        events,
        artifacts: artifactHashes.map((hash) => {
          const artifact = database.artifact(hash);
          if (!artifact) throw new Error(`execution artifact is missing: ${hash}`);
          return {
            hash: artifact.hash,
            executionId: artifact.executionId,
            kind: artifact.kind,
            mediaType: artifact.mediaType,
            encoding: artifact.encoding,
            rawBytes: artifact.rawBytes,
            storedBytes: artifact.storedBytes,
            createdAt: artifact.createdAt,
          };
        }),
        metrics: aggregateMetricPoints(EXECUTION_METRICS.derive(events)),
        work: deriveExecutionWork(events),
      };
      const serialized = `${JSON.stringify(output, null, 2)}\n`;
      if (parsed.output) writeFileSync(parsed.output, serialized, "utf8");
      else process.stdout.write(serialized);
      return;
    }
    throw new Error(`unknown execution command: ${command}`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    process.stderr.write(`execution command failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
