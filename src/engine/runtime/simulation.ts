import { performance } from "node:perf_hooks";
import { interactionDependencyEdgeCount, footprintRefKey } from "../mechanics/action-dependency";
import { CanonicalCommitter } from "./canonical-committer";
import type {
  ExecutionContext,
  ExecutionTraceWriter,
  AlgorithmManifest,
  AlgorithmRef,
  PolicyBinding,
  ExternalReactionInput,
  WorldAdvanceRequest,
  WorldExecutionAlgorithm,
  WorldStepCandidate,
  WorldStepPreparation,
} from "./execution";
import { algorithmRef, decisionEligibleAgentIds, resolutionObservations } from "./execution";
import { createHistoryReplayBase } from "./history-replay";
import type { CommittedStep, SimulationState } from "../contracts/model";
import type { ModelExecutionAudit } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { ModelExecutionScope } from "../models/model-provider";
import {
  NOOP_RUNTIME_OBSERVER,
  serializeRuntimeError,
  validateAlgorithmTelemetryEvent,
  type EngineStableRuntimeEventInput,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeObserver,
  type AlgorithmNodeRuntimeIdentity,
} from "./observability";
import { executionStage, type ExecutionStageHooks, type ExecutionStagePosition } from "./stages";
import { validateModelAudit, validateSimulationState } from "./transaction";
import type { WorldDefinition } from "./world-definition";
import { validateWorldDefinition } from "./world-definition";

export interface WorldStepResult {
  committed: CommittedStep;
  modelAudits: ModelExecutionAudit[];
  state: SimulationState;
  decisionRequests: CommittedStep["decisionRequests"];
}

export interface WorldAdvanceSequenceResult {
  status: "completed" | "awaiting_external" | "step_limit";
  steps: CommittedStep[];
  state: SimulationState;
}

export class StepReactionRequiredError extends Error {
  constructor(readonly preparation: WorldStepPreparation) {
    super("world step requires external reactions before completion");
    this.name = "StepReactionRequiredError";
  }
}

const validatedSnapshotHashes = new WeakMap<SimulationState, string>();

function consumeValidatedSnapshot(state: SimulationState): boolean {
  const expectedHash = validatedSnapshotHashes.get(state);
  validatedSnapshotHashes.delete(state);
  return expectedHash !== undefined && expectedHash === contentHash(state);
}

class ScopedTraceWriter implements ExecutionTraceWriter {
  readonly critical?: boolean;
  readonly degraded: boolean;
  readonly mode: RuntimeObserver["mode"];
  readonly traceId: string;

  constructor(
    readonly executionId: string,
    private readonly observer: RuntimeObserver,
    private readonly correlation: ModelExecutionScope["correlation"],
  ) {
    this.mode = observer.mode;
    this.degraded = observer.degraded;
    this.critical = observer.critical;
    this.traceId = "traceId" in observer && typeof observer.traceId === "string"
      ? observer.traceId
      : contentHash({ executionId }).slice("sha256:".length);
  }

  emit(input: RuntimeEventInput): RuntimeEvent | undefined {
    return this.observer.emit({
      ...input,
      traceId: input.traceId ?? this.traceId,
      correlation: { ...this.correlation, ...input.correlation, executionId: this.executionId },
    });
  }

  flush(): void {
    this.observer.flush?.();
  }

  artifact(kind: string, value: unknown): string {
    if ("artifact" in this.observer && typeof this.observer.artifact === "function") {
      return (this.observer as ExecutionTraceWriter).artifact(kind, value);
    }
    return contentHash(value);
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.observer.subscribe?.(listener) ?? (() => undefined);
  }

  snapshot(): RuntimeEvent[] {
    return this.observer.snapshot?.() ?? [];
  }
}

class ModelWorkAccumulator {
  modelCalls = 0;
  inputTokens = 0;
  outputTokens = 0;
  reasoningTokens = 0;
  modelExecutionMs = 0;

  observe(input: RuntimeEventInput): void {
    if (input.event === "model.invocation.started") this.modelCalls += 1;
    if (input.event === "model.structured_output.parsed" || input.event === "model.structured_output.rejected") {
      this.inputTokens += input.measurements?.inputTokens ?? 0;
      this.outputTokens += input.measurements?.outputTokens ?? 0;
      this.reasoningTokens += input.measurements?.reasoningTokens ?? 0;
    }
    if (input.event === "model.transport.completed" || input.event === "model.transport.failed") {
      this.modelExecutionMs += input.measurements?.executionMs ?? 0;
    }
  }
}

function compositionNodeIdentities(manifest: AlgorithmManifest): ReadonlyMap<string, AlgorithmNodeRuntimeIdentity> {
  const nodes = new Map<string, AlgorithmNodeRuntimeIdentity>();
  const visit = (
    path: string,
    ref: AlgorithmManifest | AlgorithmRef,
  ): void => {
    nodes.set(path, {
      path,
      role: ref.role,
      id: ref.id,
      version: ref.version,
      manifestHash: "manifestHash" in ref ? ref.manifestHash : ref.hash,
    });
    for (const [slot, child] of Object.entries(ref.children)) visit(`${path}.${slot}`, child);
  };
  visit("root", manifest);
  return nodes;
}

function algorithmPathForEvent(input: RuntimeEventInput): string {
  const event = input.event;
  const modelRole = input.correlation?.modelRole;
  if (event === "algorithm.eager_reference.slot_batch_completed") {
    const phase = input.attributes?.phase;
    if (phase === "action-compilation") return "root.actionCompilation.batching";
    if (phase === "agent-bootstrap" || phase === "agent-resume" || phase === "agent-mind") {
      return "root.agentCognition.batching";
    }
    if (phase === "observation") return "root.observationRendering.batching";
    if (typeof phase === "string" && phase.startsWith("truth-")) return "root.truthResolution.batching";
  }
  if (event === "algorithm.agent_mind.repair_exhausted" || event === "algorithm.agent_mind.repair_fallback") {
    return "root.agentCognition.recovery";
  }
  if (event === "algorithm.agent_reaction.repair_exhausted" || event === "algorithm.agent_reaction.repair_fallback" ||
    event === "algorithm.truth_perception.repair_exhausted" || event === "algorithm.truth_perception.repair_fallback") {
    return "root.reactionResolution.recovery";
  }
  if (event === "algorithm.observation.repair_fallback") return "root.observationRendering.recovery";
  if (event === "algorithm.observation.batch_split") return "root.observationRendering.batching";
  if (event.includes("action_compilation.retrieval") || event === "model.action_compilation.context.captured") {
    return "root.actionCompilation.candidateSelection";
  }
  if (modelRole === "action-compilation") return "root.actionCompilation";
  if (modelRole === "action-grounding") return "root.interactionGrounding";
  if (modelRole === "agent-bootstrap" || modelRole === "agent-mind" || modelRole === "arrival-generator") {
    return "root.agentCognition";
  }
  if (modelRole === "agent-reaction") return "root.reactionResolution.reactionDecision";
  if (modelRole === "truth-perception") return "root.reactionResolution.onsetPerception";
  if (modelRole === "observation-renderer") return "root.observationRendering";
  if (modelRole === "truth-resolution" || modelRole === "truth-transition" ||
    modelRole === "truth-reaction-routing" || modelRole === "causal-verifier") return "root.truthResolution";
  const phase = input.attributes?.phase;
  if (typeof phase === "string") {
    if (phase.startsWith("agent-")) return "root.agentCognition";
    if (phase === "action-compilation") return "root.actionCompilation";
    if (phase === "reaction" || phase === "reaction-preparation") return "root.reactionResolution";
    if (phase.startsWith("truth-")) return "root.truthResolution";
    if (phase === "observation") return "root.observationRendering";
  }
  if (event.startsWith("algorithm.agent_mind")) return "root.agentCognition";
  if (event.startsWith("algorithm.agent_reaction")) return "root.reactionResolution.reactionDecision";
  if (event.startsWith("algorithm.observation")) return "root.observationRendering";
  return "root";
}

class AlgorithmRuntimeObserver implements RuntimeObserver {
  readonly critical?: boolean;
  readonly degraded: boolean;
  readonly mode: RuntimeObserver["mode"];
  readonly traceId: string;

  constructor(
    private readonly delegate: ScopedTraceWriter,
    private readonly work: ModelWorkAccumulator,
    private readonly nodes: ReadonlyMap<string, AlgorithmNodeRuntimeIdentity>,
  ) {
    this.mode = delegate.mode;
    this.degraded = delegate.degraded;
    this.critical = delegate.critical;
    this.traceId = delegate.traceId;
  }

  emit(input: RuntimeEventInput): RuntimeEvent | undefined {
    if (input.algorithm) throw new Error("runtime algorithm node identity is engine-owned");
    if (input.event.startsWith("algorithm.")) {
      validateAlgorithmTelemetryEvent(input);
    } else if (!input.event.startsWith("model.")) {
      throw new Error(`runtime event is engine-owned: ${input.event}`);
    }
    const path = algorithmPathForEvent(input);
    const algorithm = this.nodes.get(path) ?? this.nodes.get("root");
    if (!algorithm) throw new Error(`runtime algorithm node is unavailable: ${path}`);
    const enriched = { ...input, algorithm };
    this.work.observe(enriched);
    return this.delegate.emit(enriched);
  }

  flush(): void {
    this.delegate.flush();
  }

  subscribe(listener: (event: RuntimeEvent) => void): () => void {
    return this.delegate.subscribe(listener);
  }

  snapshot(): RuntimeEvent[] {
    return this.delegate.snapshot();
  }
}

class TracedExecutionStageHooks implements ExecutionStageHooks {
  readonly enabled: boolean;
  current?: ExecutionStagePosition;

  constructor(
    private readonly delegate: ExecutionStageHooks,
    private readonly trace: ScopedTraceWriter,
    private readonly modelScope: ModelExecutionScope,
  ) {
    this.enabled = delegate.enabled;
  }

  private correlation(stage: ExecutionStagePosition) {
    return {
      ...this.modelScope.correlation,
      logicalStageIndex: stage.index,
      logicalStageKey: stage.key,
    };
  }

  private parallelGroupId(stage: ExecutionStagePosition): string {
    return `${this.modelScope.correlation?.executionId ?? this.modelScope.batchId}:stage:${stage.index}`;
  }

  async before(stage: ExecutionStagePosition): Promise<void> {
    this.current = stage;
    this.modelScope.logicalStage = structuredClone(stage);
    this.modelScope.correlation = this.correlation(stage);
    this.trace.emit({
      event: "stage.started",
      correlation: this.correlation(stage),
      attributes: {
        stageIndex: stage.index,
        stageKey: stage.key,
        label: stage.label,
        parallelGroupId: this.parallelGroupId(stage),
      },
    });
    // A pre-stage checkpoint must include the lifecycle marker that names the
    // stage it is waiting to execute.
    this.trace.flush();
    await this.delegate.before(stage);
  }

  async after(stage: ExecutionStagePosition): Promise<void> {
    this.current = stage;
    this.modelScope.logicalStage = structuredClone(stage);
    this.modelScope.correlation = this.correlation(stage);
    this.trace.emit({
      event: "stage.completed",
      correlation: this.correlation(stage),
      attributes: {
        stageIndex: stage.index,
        stageKey: stage.key,
        label: stage.label,
        parallelGroupId: this.parallelGroupId(stage),
      },
    });
    // Persist the lifecycle marker before a debug gate parks the worker so the
    // checkpoint's event range includes the stage boundary it represents.
    this.trace.flush();
    await this.delegate.after(stage);
    this.trace.flush();
  }

  failed(stage: ExecutionStagePosition, error: ReturnType<typeof serializeRuntimeError>): void {
    this.current = stage;
    this.modelScope.logicalStage = structuredClone(stage);
    this.modelScope.correlation = this.correlation(stage);
    this.trace.emit({
      event: "stage.failed",
      level: "error",
      correlation: this.correlation(stage),
      attributes: {
        stageIndex: stage.index,
        stageKey: stage.key,
        label: stage.label,
        parallelGroupId: this.parallelGroupId(stage),
      },
      error,
    });
    this.delegate.failed(stage, error);
    this.trace.flush();
  }
}

function createExecutionContext(scope: ModelExecutionScope, source: SimulationState, manifest: AlgorithmManifest): {
  context: ExecutionContext;
  trace: ScopedTraceWriter;
  work: ModelWorkAccumulator;
} {
  const executionId = scope.correlation?.executionId ?? `${scope.batchId}:${source.revision}:${source.step}`;
  const observer = scope.observer ?? NOOP_RUNTIME_OBSERVER;
  const trace = new ScopedTraceWriter(executionId, observer, scope.correlation);
  const work = new ModelWorkAccumulator();
  const algorithmObserver = new AlgorithmRuntimeObserver(trace, work, compositionNodeIdentities(manifest));
  const modelScope: ModelExecutionScope = {
    ...scope,
    correlation: { ...scope.correlation, executionId },
    observer: algorithmObserver,
    runtimeIdentity: { worldHash: source.worldHash, revision: source.revision },
    executionAlgorithmRef: algorithmRef(manifest),
  };
  const stages = scope.stageHooks
    ? new TracedExecutionStageHooks(scope.stageHooks, trace, modelScope)
    : undefined;
  return {
    trace,
    work,
    context: {
      modelScope,
      instrumentation: { emit: (input) => algorithmObserver.emit(input) },
      stages,
    },
  };
}

function resourceBaseline() {
  return { cpu: process.cpuUsage(), elu: performance.eventLoopUtilization() };
}

function resourceMeasurements(baseline: ReturnType<typeof resourceBaseline>): Record<string, number> {
  const cpu = process.cpuUsage(baseline.cpu);
  const elu = performance.eventLoopUtilization(baseline.elu);
  const memory = process.memoryUsage();
  return {
    cpuUserMs: cpu.user / 1_000,
    cpuSystemMs: cpu.system / 1_000,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    eventLoopUtilization: elu.utilization,
    eventLoopActiveMs: elu.active,
    eventLoopIdleMs: elu.idle,
  };
}

function validateCandidateModelAudits(
  audits: readonly ModelExecutionAudit[],
  source: Readonly<SimulationState>,
): void {
  const seenInvocationIds = new Set<string>();
  for (const [index, audit] of audits.entries()) {
    validateModelAudit(audit, `execution candidate model audit ${index + 1}`, source.worldHash, source.revision, seenInvocationIds);
  }
}

function emitEngineStableEvent(trace: ExecutionTraceWriter, input: EngineStableRuntimeEventInput): void {
  trace.emit(input);
}

function emitBootstrapMetrics(
  trace: ExecutionTraceWriter,
  source: Readonly<SimulationState>,
  candidate: Readonly<import("./execution").BootstrapCandidate>,
): void {
  emitEngineStableEvent(trace, {
    event: "algorithm.activation.completed",
    attributes: { phase: "bootstrap", policy: "engine-bootstrap-roster" },
    counts: {
      persistentAgents: Object.keys(source.agents).length,
      eligibleAgents: Object.keys(source.agents).length,
      activatedAgents: candidate.diagnostics.activatedAgentIds.length,
      skippedAgents: 0,
      reusedAgents: candidate.diagnostics.reusedAgentIds.length,
      noopAgents: 0,
      externalAgents: 0,
    },
  });
}

function emitStepMetrics(
  trace: ExecutionTraceWriter,
  source: Readonly<SimulationState>,
  policyRoster: Readonly<Record<string, PolicyBinding>>,
  eligibleAgentIds: readonly string[],
  trigger: WorldAdvanceRequest["trigger"],
  candidate: Readonly<WorldStepCandidate>,
): void {
  const observations = resolutionObservations(candidate.resolution);
  const policyCounts = Object.values(policyRoster).reduce((counts, binding) => {
    counts[binding.kind] = (counts[binding.kind] ?? 0) + 1;
    return counts;
  }, {} as Record<PolicyBinding["kind"], number>);
  const updated = new Set([
    ...candidate.diagnostics.activatedAgentIds,
    ...candidate.diagnostics.reusedAgentIds,
  ]);
  const eligibleModelAgents = eligibleAgentIds.filter((agentId) => policyRoster[agentId]?.kind === "model");
  emitEngineStableEvent(trace, {
    event: "algorithm.activation.completed",
    attributes: { phase: "step", policy: "engine-decision-eligibility" },
    counts: {
      persistentAgents: Object.keys(source.agents).length,
      eligibleAgents: eligibleAgentIds.length,
      activatedAgents: candidate.diagnostics.activatedAgentIds.length,
      skippedAgents: eligibleModelAgents.filter((agentId) => !updated.has(agentId)).length,
      reusedAgents: candidate.diagnostics.reusedAgentIds.length,
      noopAgents: policyCounts.idle ?? 0,
      externalAgents: policyCounts.external ?? 0,
    },
  });
  emitEngineStableEvent(trace, {
    event: "algorithm.candidate.completed",
    attributes: {
      phase: "step",
      dependencyAnalysis: "typed-action-dependencies",
      trigger,
    },
    counts: {
      updatedAgents: candidate.mindCommits.length,
      observedAgents: new Set(observations.map((observation) => observation.observerId)).size,
      actions: candidate.resolution.actions.length,
      reactions: candidate.resolution.reactionDecisions.length,
      checks: candidate.resolution.checks.length,
      randomResults: candidate.resolution.randomResults.length,
      resolutionPlans: candidate.resolution.resolutionPlans.length,
      settledResolutionReceipts: candidate.resolution.resolutionReceipts.filter((receipt) => receipt.settled).length,
      deferredResolutionReceipts: candidate.resolution.resolutionReceipts.filter((receipt) => !receipt.settled).length,
      mechanicInvocations: candidate.resolution.proposal.mechanicInvocations.length,
      mechanicResults: candidate.resolution.mechanicResults.length,
      outcomes: candidate.resolution.proposal.outcomes.length,
      operations: candidate.resolution.proposal.operations.length,
      events: candidate.resolution.proposal.events.length,
      observations: observations.length,
      mindCommits: candidate.mindCommits.length,
      mindFallbacks: candidate.diagnostics.mindFallbackAgentIds.length,
      temporalPlans: candidate.temporalPlans.length,
      activeActivities: Object.values(candidate.temporalState.activities)
        .filter((activity) => activity.status === "active" || activity.status === "paused" ||
          activity.status === "queued" || activity.status === "ready").length,
      activityTransitions: candidate.activityTransitions.length,
      dueActivities: candidate.temporalBoundary.dueActivityIds.length,
      dueTimers: candidate.temporalBoundary.dueTimerIds.length,
      dueConditions: candidate.temporalBoundary.dueConditionIds.length,
      decisionPoints: candidate.decisionPoints.length,
      temporalDeltaSeconds: candidate.temporalBoundary.deltaSeconds,
      dependencyNodes: candidate.interactionDependencies.length,
      dependencyEdges: interactionDependencyEdgeCount(candidate.interactionDependencies),
      dependencyComponents: candidate.diagnostics.dependencyComponents.length,
      maxDependencyComponent: Math.max(
        0,
        ...candidate.diagnostics.dependencyComponents.map((component) => component.length),
      ),
      globalDependencies: candidate.interactionDependencies.filter((dependency) => dependency.globalFallback).length,
      globalReadjudications: candidate.diagnostics.globalReadjudication ? 1 : 0,
      footprintCardinality: candidate.interactionDependencies.reduce((total, dependency) =>
        total + new Set([...dependency.reads, ...dependency.writes].map(footprintRefKey)).size, 0),
      audienceCardinality: candidate.interactionDependencies.reduce(
        (total, dependency) => total + dependency.audienceAgentIds.length,
        0,
      ),
    },
  });
  for (const reason of candidate.temporalBoundary.reasons) {
    emitEngineStableEvent(trace, { event: "temporal.boundary.reason", attributes: { reasonKind: reason.kind } });
  }
  for (const transition of candidate.activityTransitions) {
    emitEngineStableEvent(trace, {
      event: "temporal.activity.transition",
      attributes: { transitionKind: transition.kind },
    });
  }
  for (const outcome of candidate.resolution.proposal.outcomes) {
    emitEngineStableEvent(trace, {
      event: "resolution.outcome.recorded",
      attributes: { outcomeStatus: outcome.status },
    });
  }
  for (const operation of candidate.resolution.proposal.operations) {
    emitEngineStableEvent(trace, {
      event: "resolution.operation.recorded",
      attributes: { operationKind: operation.kind },
    });
  }
}

/** All candidate generation and commits share one algorithm/committer path. */
export class SimulationEngine {
  readonly definition: WorldDefinition;
  private state: SimulationState;
  private readonly algorithm: WorldExecutionAlgorithm;
  private readonly committer = new CanonicalCommitter();
  private bootstrapAudits: ModelExecutionAudit[] = [];

  constructor(
    definition: WorldDefinition,
    algorithm: WorldExecutionAlgorithm,
    initialState: SimulationState = definition.initialState,
  ) {
    this.definition = definition;
    validateWorldDefinition(definition);
    this.algorithm = algorithm;
    this.state = structuredClone(initialState);
    if (this.state.worldId !== definition.id) throw new Error("simulation state belongs to another world");
    if (!consumeValidatedSnapshot(this.state)) validateSimulationState(this.state, false, true);
    this.state.historyBase ??= createHistoryReplayBase(definition.initialState);
  }

  get snapshot(): SimulationState {
    const snapshot = structuredClone(this.state);
    validatedSnapshotHashes.set(snapshot, contentHash(snapshot));
    return snapshot;
  }

  get bootstrapModelAudits(): ModelExecutionAudit[] {
    return structuredClone(this.bootstrapAudits);
  }

  async bootstrapAgents(scope?: ModelExecutionScope): Promise<SimulationState> {
    const source = structuredClone(this.state);
    const executionScope = scope ?? {
      workloadId: `simulation:${source.worldId}`,
      batchId: `bootstrap:${source.revision}`,
    };
    const { context, trace, work } = createExecutionContext(executionScope, source, this.algorithm.manifest);
    const resources = resourceBaseline();
    const startedAt = Date.now();
    trace.emit({
      event: "execution.world_definition.persisted",
      hashes: { worldDefinition: contentHash(this.definition) },
      payload: this.definition,
    });
    trace.emit({
      event: "instance.bootstrap.started",
      counts: { persistentAgents: Object.keys(source.agents).length },
      hashes: { state: contentHash(source), algorithmManifest: this.algorithm.manifest.hash },
      payload: { state: source },
    });
    try {
      const candidate = await this.algorithm.bootstrap({
        definition: structuredClone(this.definition),
        state: structuredClone(source),
      }, context);
      validateCandidateModelAudits(candidate.modelAudits, source);
      trace.emit({
        event: "execution.resources.sampled",
        attributes: { phase: "bootstrap" },
        measurements: resourceMeasurements(resources),
      });
      trace.emit({
        event: "execution.candidate.persisted",
        attributes: { phase: "bootstrap" },
        hashes: { candidate: contentHash(candidate) },
        payload: candidate,
      });
      trace.flush();
      const validationStartedAt = performance.now();
      trace.emit({ event: "canonical.validation.started", attributes: { phase: "bootstrap" } });
      const committed = this.committer.bootstrap(source, candidate);
      trace.emit({
        event: "canonical.validation.completed",
        attributes: {
          phase: "bootstrap",
          status: "accepted",
          cognitionIsolation: "accepted",
          canonicalInvariants: "accepted",
        },
        durationMs: Math.max(0, performance.now() - validationStartedAt),
        hashes: { state: contentHash(committed) },
      });
      emitBootstrapMetrics(trace, source, candidate);
      this.bootstrapAudits = candidate.modelAudits.map((audit) => structuredClone(audit));
      this.state = committed;
      trace.emit({
        event: "instance.bootstrap.committed",
        durationMs: Math.max(0, Date.now() - startedAt),
        counts: { activatedAgents: candidate.agentCommits.length, updatedAgents: candidate.agentCommits.length },
        hashes: { state: contentHash(committed) },
      });
      trace.flush();
      return this.snapshot;
    } catch (error) {
      trace.emit({
        event: "instance.bootstrap.rolled_back",
        level: "error",
        durationMs: Math.max(0, Date.now() - startedAt),
        counts: { rollbacks: 1, discardedModelCalls: work.modelCalls },
        measurements: {
          discardedInputTokens: work.inputTokens,
          discardedOutputTokens: work.outputTokens,
          discardedReasoningTokens: work.reasoningTokens,
          discardedModelExecutionMs: work.modelExecutionMs,
        },
        attributes: { rollbackStateMatches: true },
        hashes: { state: contentHash(source) },
        error: serializeRuntimeError(error),
      });
      trace.flush();
      throw error;
    }
  }

  private async executeStep(
    policyRoster: Readonly<Record<string, PolicyBinding>>,
    request: Readonly<WorldAdvanceRequest>,
    scope?: ModelExecutionScope,
    prepared?: Readonly<{
      preparation: WorldStepPreparation;
      reactions: readonly ExternalReactionInput[];
    }>,
  ): Promise<WorldStepResult> {
    const source = structuredClone(this.state);
    if (request.expectedRevision !== source.revision) {
      throw new Error(`world advance expected revision ${request.expectedRevision}; current revision is ${source.revision}`);
    }
    const executionScope = scope ?? {
      workloadId: `simulation:${source.worldId}`,
      batchId: `step:${source.revision}:${source.step + 1}`,
    };
    const { context, trace, work } = createExecutionContext(executionScope, source, this.algorithm.manifest);
    const resources = resourceBaseline();
    const startedAt = Date.now();
    const eligibleAgentIds = decisionEligibleAgentIds(
      source,
      request.externalActions.map((action) => action.agentId),
    );
    let generatedModelCalls = 0;
    let discardedInputTokens = 0;
    let discardedOutputTokens = 0;
    let discardedReasoningTokens = 0;
    let discardedModelExecutionMs = 0;
    trace.emit({
      event: "execution.world_definition.persisted",
      hashes: { worldDefinition: contentHash(this.definition) },
      payload: this.definition,
    });
    trace.emit({
      event: "step.started",
      hashes: { state: contentHash(source), algorithmManifest: this.algorithm.manifest.hash },
      counts: { persistentAgents: Object.keys(source.agents).length },
      payload: {
        state: source,
        policyRoster: structuredClone(policyRoster),
        request: structuredClone(request),
        decisionEligibleAgentIds: eligibleAgentIds,
      },
    });
    try {
      if (!prepared) {
        const stage = executionStage("input-roster");
        await context.stages?.before(stage);
        await context.stages?.after(stage);
      }
      const stepInput = {
        definition: structuredClone(this.definition),
        state: structuredClone(source),
        policyRoster: structuredClone(policyRoster),
        request: structuredClone(request),
        decisionEligibleAgentIds: eligibleAgentIds,
      };
      const preparation = prepared?.preparation ?? await this.algorithm.prepareStep(stepInput, context);
      trace.emit({
        event: "execution.preparation.persisted",
        attributes: { phase: "step" },
        hashes: { preparation: contentHash(preparation) },
        payload: preparation,
      });
      if (!prepared && preparation.pendingReactionRequests.length > 0) {
        trace.flush();
        throw new StepReactionRequiredError(preparation);
      }
      const candidate = await this.algorithm.completeStep(
        stepInput,
        preparation,
        prepared?.reactions ?? [],
        context,
      );
      validateCandidateModelAudits(candidate.modelAudits, source);
      generatedModelCalls = candidate.modelAudits.reduce((sum, audit) => sum + audit.invocations.length, 0);
      const generatedInvocations = candidate.modelAudits.flatMap((audit) => audit.invocations);
      discardedInputTokens = generatedInvocations.reduce((sum, invocation) => sum + (invocation.tokenUsage.input ?? 0), 0);
      discardedOutputTokens = generatedInvocations.reduce((sum, invocation) => sum + (invocation.tokenUsage.output ?? 0), 0);
      discardedReasoningTokens = generatedInvocations.reduce((sum, invocation) =>
        sum + (invocation.tokenUsage.reasoning ?? 0), 0);
      discardedModelExecutionMs = generatedInvocations.flatMap((invocation) => invocation.transports)
        .reduce((sum, transport) => sum + transport.executionMs, 0);
      trace.emit({
        event: "execution.candidate.persisted",
        attributes: { phase: "step" },
        hashes: { candidate: contentHash(candidate) },
        payload: candidate,
      });
      trace.flush();
      const validationStartedAt = performance.now();
      trace.emit({ event: "canonical.validation.started", attributes: { phase: "step" } });
      const validationStage = executionStage("canonical-validation");
      await context.stages?.before(validationStage);
      const result = this.committer.step(
        source,
        candidate,
        policyRoster,
        this.definition.runtimeDefaults.maxAutonomousSpanSeconds,
      );
      if (context.stages) await context.stages.after(validationStage);
      trace.emit({
        event: "canonical.validation.completed",
        attributes: {
          phase: "step",
          status: "accepted",
          cognitionIsolation: "accepted",
          canonicalInvariants: "accepted",
        },
        durationMs: Math.max(0, performance.now() - validationStartedAt),
        hashes: { semantic: result.committed.semanticHash, state: contentHash(result.state) },
      });
      emitStepMetrics(trace, source, policyRoster, eligibleAgentIds, request.trigger, candidate);
      this.state = result.state;
      trace.emit({
        event: "execution.resources.sampled",
        attributes: { phase: "step" },
        measurements: resourceMeasurements(resources),
      });
      trace.emit({
        event: "step.committed",
        durationMs: Math.max(0, Date.now() - startedAt),
        counts: { modelExecutions: generatedModelCalls },
        hashes: { committedStep: result.committed.contentHash, state: contentHash(result.state) },
      });
      trace.flush();
      return {
        committed: result.committed,
        modelAudits: candidate.modelAudits.map((audit) => structuredClone(audit)),
        state: this.snapshot,
        decisionRequests: structuredClone(result.committed.decisionRequests),
      };
    } catch (error) {
      const currentStage = context.stages?.current;
      if (currentStage && context.stages && !(error instanceof Error && error.name === "AbortError")) {
        context.stages.failed(currentStage, serializeRuntimeError(error));
      }
      trace.emit({
        event: "step.rolled_back",
        level: "error",
        durationMs: Math.max(0, Date.now() - startedAt),
        counts: { rollbacks: 1, discardedModelCalls: Math.max(generatedModelCalls, work.modelCalls) },
        measurements: {
          discardedInputTokens: Math.max(discardedInputTokens, work.inputTokens),
          discardedOutputTokens: Math.max(discardedOutputTokens, work.outputTokens),
          discardedReasoningTokens: Math.max(discardedReasoningTokens, work.reasoningTokens),
          discardedModelExecutionMs: Math.max(discardedModelExecutionMs, work.modelExecutionMs),
        },
        attributes: { result: "rolled_back", rollbackStateMatches: true },
        hashes: { state: contentHash(source) },
        error: serializeRuntimeError(error),
      });
      trace.flush();
      throw error;
    }
  }

  async step(
    policyRoster: Readonly<Record<string, PolicyBinding>>,
    request: Readonly<WorldAdvanceRequest>,
    scope?: ModelExecutionScope,
  ): Promise<WorldStepResult> {
    return this.executeStep(policyRoster, request, scope);
  }

  async prepareStep(
    policyRoster: Readonly<Record<string, PolicyBinding>>,
    request: Readonly<WorldAdvanceRequest>,
    scope?: ModelExecutionScope,
  ): Promise<WorldStepPreparation> {
    const source = structuredClone(this.state);
    if (request.expectedRevision !== source.revision) {
      throw new Error(`world advance expected revision ${request.expectedRevision}; current revision is ${source.revision}`);
    }
    const executionScope = scope ?? {
      workloadId: `simulation:${source.worldId}`,
      batchId: `prepare:${source.revision}:${source.step + 1}`,
    };
    const { context, trace } = createExecutionContext(executionScope, source, this.algorithm.manifest);
    const eligibleAgentIds = decisionEligibleAgentIds(
      source,
      request.externalActions.map((action) => action.agentId),
    );
    const stepInput = {
      definition: structuredClone(this.definition),
      state: structuredClone(source),
      policyRoster: structuredClone(policyRoster),
      request: structuredClone(request),
      decisionEligibleAgentIds: eligibleAgentIds,
    };
    trace.emit({
      event: "step.preparation.started",
      hashes: { state: contentHash(source), algorithmManifest: this.algorithm.manifest.hash },
      payload: stepInput,
    });
    const stage = executionStage("input-roster");
    await context.stages?.before(stage);
    await context.stages?.after(stage);
    const preparation = await this.algorithm.prepareStep(stepInput, context);
    validateCandidateModelAudits(preparation.modelAudits, source);
    trace.emit({
      event: "execution.preparation.persisted",
      attributes: { phase: "step" },
      hashes: { preparation: contentHash(preparation) },
      payload: preparation,
    });
    trace.flush();
    return structuredClone(preparation);
  }

  async completePreparedStep(
    policyRoster: Readonly<Record<string, PolicyBinding>>,
    request: Readonly<WorldAdvanceRequest>,
    preparation: Readonly<WorldStepPreparation>,
    reactions: readonly ExternalReactionInput[],
    scope?: ModelExecutionScope,
  ): Promise<WorldStepResult> {
    return this.executeStep(policyRoster, request, scope, {
      preparation: structuredClone(preparation),
      reactions: structuredClone(reactions),
    });
  }

  async runUntilBoundary(
    policyRoster: Readonly<Record<string, PolicyBinding>>,
    request: Omit<WorldAdvanceRequest, "expectedRevision">,
    maxSteps = 100,
    onStep?: (result: WorldStepResult) => void | Promise<void>,
    scope?: ModelExecutionScope,
  ): Promise<WorldAdvanceSequenceResult> {
    if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0) throw new Error("maxSteps must be positive");
    const steps: CommittedStep[] = [];
    for (let index = 0; index < maxSteps; index += 1) {
      const result = await this.step(policyRoster, {
        ...structuredClone(request),
        expectedRevision: this.state.revision,
      }, scope);
      steps.push(result.committed);
      await onStep?.(result);
      if (result.decisionRequests.length > 0) {
        return { status: "awaiting_external", steps, state: this.snapshot };
      }
    }
    return { status: "step_limit", steps, state: this.snapshot };
  }
}
