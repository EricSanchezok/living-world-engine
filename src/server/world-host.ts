import { z } from "zod";
import { loadPromptAsset } from "../engine/prompts";
import { agentCapabilityModels } from "../engine/models/capability-bindings";
import { enqueueNarrative, nextNarrative, completeParagraphs, renderNarrativeSegment, explicitNarrativeMentions, narrativeContinuation, requireDeliveredSpeech, assertSpeechMultiplicity, assertSpeechOrder, narrativeFallback, narrativeEvidence, narrativeTask, narrativeDiscourse, deliveredDialogue, checkNarrativeGrounding, narrativeGroundingChoices, type NarrativeBeat } from "./world-narrative";
import { participantDiscourse } from "./world-discourse";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import { projectAgentPerspective } from "../engine/cognition/agent-perspective";
import { DEFAULT_ALGORITHM_REF, registerBuiltinAlgorithms } from "../engine/algorithms/registry";
import { CanonicalCommitter } from "../engine/runtime/canonical-committer";
import type {
  AlgorithmRef,
  ExecutionProducerManifest,
  ExternalActionInput,
  ExternalReactionInput,
  PolicyBinding,
  WorldAdvanceRequest,
  WorldStepPreparation,
} from "../engine/runtime/execution";
import {
  defineEngineOperationManifest,
  StepPreparationInvalidatedError,
  WORLD_STEP_PREPARATION_SCHEMA_VERSION,
  WorldExecutionAlgorithmRegistry,
} from "../engine/runtime/execution";
import {
  EXECUTION_STAGES,
  executionStage,
  type ExecutionStageHooks,
  type ExecutionStagePosition,
} from "../engine/runtime/stages";
import { arrivalDraftSchema } from "../engine/contracts/llm-schemas";
import { loadModelCatalog } from "../engine/models/model-catalog";
import { createModelGateway } from "../engine/models/model-gateway";
import { qualificationModelFetchResolver } from "./jev-qualification-budget";
import { contentHash } from "../engine/models/model-audit";
import { AlgorithmExperimentRegistry } from "../engine/runtime/experiments";
import { ModelRegistry } from "../engine/models/model-registry";
import { modelServicePause, type ModelServicePause } from "../engine/models/service-failure";
import {
  modelInvocationCorrelation,
  modelInvocationIdentity,
  modelInvocationLogicalId,
  type ModelRegistryDiagnostics,
  type ModelRegistryRefreshDiagnostics,
  type StructuredModelProvider,
} from "../engine/models/model-provider";
import { MODEL_CONTEXT_CONTRACT_VERSION, projectAgentPerspectiveForModel } from "../engine/contracts/prompts";
import { createAgentReferenceResolver, modelRoleContract } from "../engine/contracts/model-context";
import { promptBundle } from "../engine/prompts";
import {
  NOOP_RUNTIME_OBSERVER,
  serializeRuntimeError,
  type RuntimeCorrelation,
  type RuntimeObserver,
} from "../engine/runtime/observability";
import { quantityId, runtimeId } from "../engine/runtime/runtime-id";
import { SimulationEngine } from "../engine/runtime/simulation";
import { WorldQuiescentError } from "../engine/runtime/execution";
import type { DirectRuntimeState } from "../engine/direct/contracts";
import { participantReactionIds } from "../engine/direct/foreground";
import {
  toWorldRuntimeContract,
  validateWorldModelProfiles,
  worldModelProfileIds,
  type WorldDefinition,
  type WorldOrigin,
} from "../engine/runtime/world-definition";
import type { AgentState, SimulationState } from "../engine/contracts/model";
import type { WorldRepository } from "../script/world-repository";
import type {
  AdvanceWorldInput,
  ArrivalView,
  ControlTransferInput,
  ControlOptions,
  CreateInstanceInput,
  PublicConversation,
  PublicConversationTurn,
  PublicInstanceDetail,
  PublicInstanceSummary,
  PublicWorldRun,
  DebugModeInput,
  DebugNextInput,
  SubmitExternalActionInput,
  SubmitExternalReactionInput,
  WorldRunControlInput,
  WorldStartOptions,
} from "../shared/world-api";
import { sharedResourceQueuePositions } from "../engine/mechanics/shared-resource-allocation";
import type {
  ObserverAgentPerspective,
  ObserverAgentSummary,
  WorldObserverDetail,
} from "../shared/world-observer-api";
import type {
  DebugArtifact,
  DebugDoctorReport,
  DebugInspection,
  DebugQuery,
  DebugSearchResult,
} from "../shared/debug-api";
import { runtimeCodeIdentity } from "./code-identity";
import { installBundledWorlds } from "./bundled-worlds";
import { loadAlgorithmExperimentRegistry } from "./experiment-catalog";
import {
  createActionCompilationRetrievalRuntimeProvider,
  type ActionCompilationRetrievalRuntimeProvider,
} from "./action-compilation-retrieval-runtime";
import {
  DebugCheckpointModelProvider,
  EXECUTION_CHECKPOINT_SCHEMA_VERSION,
  debugCheckpointReplayValidationError,
  type ExecutionCheckpoint,
} from "./debug-checkpoint-provider";
import type { ExecutionLedger, ExecutionRecord, FinishExecutionInput } from "./execution-ledger";
import { LocalDatabase } from "./local-database";
import type { WorldImportResult } from "./world-import";
import {
  buildWorldInspectorAttemptDetail,
  buildWorldInspectorModelInvocationDetail,
  buildWorldInspectorReplay,
  buildWorldInspectorRuntimeEventDetail,
  buildWorldInspectorStepDetail,
  buildWorldInspectorWindow,
  queryWorldInspectorModelInvocations,
  summarizeRuntimeEvent,
} from "./world-inspector";
import {
  WorldInstanceConflictError,
  WorldInstanceNotFoundError,
  type WorldInstanceStore,
} from "./world-instance-store";
import type {
  ActionWindow,
  ParticipantArrivalRecord,
  ParticipantRecord,
  StoredWorldInstance,
  WorldRunRecord,
  WorldInstanceDocument,
} from "./world-instance-types";

interface WorldCatalogManager {
  importWorld(
    buffer: Buffer,
    modelCatalog: StructuredModelProvider["catalog"],
    replace?: boolean,
    expectedWorldId?: string,
  ): WorldImportResult;
  deleteWorld(worldId: string): void;
}

interface AtomicExecutionInstanceStore extends WorldInstanceStore {
  createInstanceAndFinishExecution(
    document: WorldInstanceDocument,
    executionId: string,
    finish: FinishExecutionInput,
    correlation?: RuntimeCorrelation,
  ): { instance: StoredWorldInstance };
  compareAndSwapInstanceAndFinishExecution(
    instanceId: string,
    expectedGeneration: number,
    document: WorldInstanceDocument,
    executionId: string,
    finish: FinishExecutionInput,
    phase?: "step" | "admission" | "instance",
    correlation?: RuntimeCorrelation,
  ): { instance: StoredWorldInstance };
}

interface InspectorLedgerSnapshot {
  key: string;
  records: ExecutionRecord[];
  events: import("../engine/runtime/observability").RuntimeEvent[];
}

function isAtomicStore(store: WorldInstanceStore): store is AtomicExecutionInstanceStore {
  const candidate = store as Partial<AtomicExecutionInstanceStore>;
  return typeof candidate.createInstanceAndFinishExecution === "function" &&
    typeof candidate.compareAndSwapInstanceAndFinishExecution === "function";
}

class DebugStageGate implements ExecutionStageHooks {
  readonly enabled = true;
  private permits = 0;
  private waiters: Array<() => void> = [];
  private currentStageValue?: ExecutionStagePosition;
  private cancelled = false;
  private readonly completedStageIndex: number;
  private authorizedStageIndex: number | undefined;

  constructor(
    private readonly onPause: (stage: ExecutionStagePosition) => Promise<void>,
    recoveredCompletedStageIndex?: number,
  ) {
    this.completedStageIndex = recoveredCompletedStageIndex ?? -1;
    this.authorizedStageIndex = recoveredCompletedStageIndex === undefined
      ? undefined
      : recoveredCompletedStageIndex + 1;
  }

  get current(): ExecutionStagePosition | undefined {
    return this.currentStageValue;
  }

  private waitForPermit(): Promise<void> {
    if (this.cancelled) {
      const error = new Error("debug stage gate cancelled");
      error.name = "AbortError";
      return Promise.reject(error);
    }
    if (this.permits > 0) {
      this.permits -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => this.waiters.push(() => {
      if (this.cancelled) {
        const error = new Error("debug stage gate cancelled");
        error.name = "AbortError";
        reject(error);
      } else resolve();
    }));
  }

  release(): void {
    if (this.cancelled) return;
    const resolve = this.waiters.shift();
    if (resolve) resolve();
    else this.permits += 1;
  }

  cancel(): void {
    this.cancelled = true;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async before(stage: ExecutionStagePosition): Promise<void> {
    this.currentStageValue = stage;
    if (stage.index <= this.completedStageIndex || this.authorizedStageIndex === stage.index) return;
    await this.onPause(stage);
    await this.waitForPermit();
    this.authorizedStageIndex = stage.index;
  }

  async after(stage: ExecutionStagePosition): Promise<void> {
    this.currentStageValue = stage;
    if (stage.index <= this.completedStageIndex) return;
    if (stage.index >= 9) return;
    const next = EXECUTION_STAGES[stage.index + 1];
    if (!next) throw new Error(`debug stage ${stage.index} has no successor`);
    await this.onPause(executionStage(next.key));
    await this.waitForPermit();
    this.authorizedStageIndex = next.index;
  }

  failed(stage: ExecutionStagePosition): void {
    this.currentStageValue = stage;
  }
}

export interface WorldHostOptions {
  repository: WorldRepository;
  store: WorldInstanceStore;
  provider: StructuredModelProvider;
  catalogManager?: WorldCatalogManager;
  ledger?: ExecutionLedger;
  algorithmRegistry?: WorldExecutionAlgorithmRegistry;
  experimentRegistry?: AlgorithmExperimentRegistry;
  actionCompilationRetrievalProvider?: ActionCompilationRetrievalRuntimeProvider;
  defaultAlgorithmRef?: AlgorithmRef;
  now?: () => Date;
  idFactory?: () => string;
  observer?: RuntimeObserver;
  maxActiveParticipants?: number;
  runLeaseMaxCommits?: number;
  runLeaseMaxWallTimeMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

interface DebugLedger extends ExecutionLedger {
  debugQuery(input?: DebugQuery): DebugSearchResult;
  debugInspect(invocationId: string, includePayload?: boolean): DebugInspection | undefined;
  debugArtifact(hash: string): DebugArtifact | undefined;
  debugExplain(code: string): unknown;
  debugDoctor(): DebugDoctorReport;
  debugRebuildIndex(): void;
}

function debugLedger(ledger: ExecutionLedger | undefined): DebugLedger {
  if (!ledger || typeof (ledger as Partial<DebugLedger>).debugQuery !== "function") {
    throw new WorldHostError("local debug query is unavailable", 501);
  }
  return ledger as DebugLedger;
}

export class WorldHostError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "WorldHostError";
  }
}

const NARRATIVE_SYSTEM = loadPromptAsset("system/scene-narrative.md");
const NARRATIVE_USER = loadPromptAsset("user/scene-narrative.md");
const NARRATIVE_PROMPT_VERSION = `scene-narrative-${contentHash([NARRATIVE_SYSTEM, NARRATIVE_USER])}`;
const NARRATIVE_MANIFEST = defineEngineOperationManifest({ id: "scene-narrative", version: "1", config: { promptVersion: NARRATIVE_PROMPT_VERSION } });
const ARRIVAL_PROMPT = promptBundle("arrival-generator");

const ARRIVAL_PRODUCER_MANIFEST = defineEngineOperationManifest({
  id: "arrival-generator",
  version: "3",
  config: { promptVersion: ARRIVAL_PROMPT.version },
});

function policyRoster(state: Readonly<SimulationState>): Record<string, PolicyBinding> {
  return Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
    kind: "model" as const,
    agentId: agent.id,
    profiles: structuredClone(agent.modelProfiles),
  }]));
}

function currentRun(document: WorldInstanceDocument): WorldRunRecord | undefined {
  return Object.values(document.runs)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
}

function externalDecisionAgentIds(document: WorldInstanceDocument, deferForReactions = true): string[] {
  if (document.state.executionState?.data.kind === "direct-world") {
    const control = document.state.executionState.data as unknown as DirectRuntimeState;
    const busy = new Set([...control.activities.filter(frame => frame.dueAtSeconds !== null).map(frame => frame.actorId),
      ...Object.entries(control.intents).filter(([, intent]) => intent.activeSubmission && ["ready", "active"].includes(intent.status)).map(([id]) => id)]);
    const participants = Object.values(document.policyBindings).filter(binding => binding.kind === "external").map(binding => binding.agentId);
    const roots = currentRun(document)?.rootIntents;
    const reacting = participantReactionIds(document.state, control, participants, roots?.length ? roots.map(root => root.submissionId) : undefined);
    if ([...reacting].some(id => document.policyBindings[id]?.kind === "model") && deferForReactions) return [];
    return Object.values(document.policyBindings).filter(binding => binding.kind === "external" && !busy.has(binding.agentId)).map(binding => binding.agentId).sort();
  }
  const decisionAgents = new Set(document.state.history.at(-1)?.decisionPoints.map((point) => point.agentId) ?? []);
  const busyAgents = new Set(Object.values(document.state.truth.activities)
    .filter((activity) => activity.status === "active" || activity.status === "paused" ||
      activity.status === "queued" || activity.status === "ready")
    .flatMap((activity) => activity.participantAgentIds));
  return Object.values(document.policyBindings)
    .filter((binding): binding is Extract<PolicyBinding, { kind: "external" }> => binding.kind === "external")
    .map((binding) => binding.agentId)
    .filter((agentId) => !busyAgents.has(agentId) || decisionAgents.has(agentId))
    .sort();
}

function publicActivity(
  document: Readonly<WorldInstanceDocument>,
  activity: Readonly<SimulationState["truth"]["activities"][string]>,
): PublicWorldRun["activity"] {
  const deferred = activity.status === "queued" || activity.status === "ready";
  const queuePosition = activity.status === "queued"
    ? sharedResourceQueuePositions(document.state.truth.activities).get(activity.id) ?? null
    : null;
  return {
    id: activity.id,
    status: activity.status,
    description: deferred ? activity.planDraft.description : activity.plan.description,
    stage: deferred ? null : activity.plan.stages[activity.stageIndex]?.name ?? null,
    progress: deferred ? null : structuredClone(activity.progress),
    nextBoundaryAtSeconds: deferred ? null : activity.nextBoundaryAtSeconds,
    completionAtSeconds: deferred ? null : activity.completionAtSeconds,
    queuePosition,
    resourceNames: [...new Set(activity.sharedResourceClaims.map((claim) =>
      document.state.truth.mechanics.sharedActivityResources[claim.definitionId]?.name)
      .filter((name): name is string => Boolean(name)))].sort(),
  };
}

function activeParticipants(document: WorldInstanceDocument): ParticipantRecord[] {
  return Object.values(document.participants)
    .filter((participant) => participant.status === "active")
    .sort((left, right) => left.id.localeCompare(right.id));
}

function publicSummary(document: WorldInstanceDocument): PublicInstanceSummary {
  return {
    id: document.id,
    worldId: document.world.id,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    revision: document.state.revision,
    step: document.state.step,
    elapsedSeconds: document.state.truth.elapsedSeconds,
    participantCount: activeParticipants(document).length,
    schedulerMode: document.scheduler.mode,
    debugSteppingEnabled: document.runtime.debugSteppingEnabled,
    ...(currentRun(document) ? { runStatus: currentRun(document)!.status } : {}),
  };
}

function publicWorld(document: WorldInstanceDocument) {
  return {
    id: document.world.id,
    name: document.world.name,
    version: document.world.manifestVersion,
    contentHash: document.world.contentHash,
    description: document.world.description,
    participation: document.world.participation ? "open" as const : "headless" as const,
  };
}

function agentPerspective(document: WorldInstanceDocument, agentId: string) {
  const agent = document.state.agents[agentId];
  if (!agent) throw new WorldHostError(`Agent not found: ${agentId}`, 404);
  return projectAgentPerspective(document.state, agent);
}

function conversationFor(
  document: WorldInstanceDocument,
  participant: ParticipantRecord,
): PublicConversation {
  const arrival = participant.arrival;
  const turns: PublicConversationTurn[] = [{
    id: arrival.id,
    agentId: participant.agentId,
    baseRevision: arrival.revision,
    createdAt: arrival.createdAt,
    status: "committed",
    response: {
      revision: arrival.revision,
      step: arrival.step,
      title: arrival.title,
      text: arrival.scene,
      possibleNextActions: [...arrival.possibleNextActions],
      generated: arrival.generated,
    },
  }];
  for (const intent of document.participantIntents.filter((entry) => entry.participantId === participant.id)) {
    const run = document.runs[intent.runId];
    const beats = document.narratives.filter(beat => beat.participantId === participant.id && beat.submissionId === intent.submissionId);
    const responses = beats.filter(beat => beat.segments.length > 0).map(beat => {
      const last = beat.source.boundary;
      const committed = document.state.history.find(step => step.revision === last.revision);
      const activity = Object.values(committed?.temporalState.activities ?? {})
        .filter(item => item.actorId === intent.agentId).sort((a, b) => b.updatedAtSeconds - a.updatedAtSeconds || b.id.localeCompare(a.id))[0];
      return { id: beat.id, revision: last.revision, step: last.step, text: beat.segments.map(segment => segment.text).join("\n\n"),
        worldTimeSeconds: last.worldTimeSeconds, narrativeStatus: beat.status, segmentCount: beat.segments.length,
        sourceRevisions: [...new Set(beat.source.observations.map(observation => observation.revision))],
        activity: activity ? publicActivity(document, activity) : null };
    });
    const status: PublicConversationTurn["status"] = beats.some(beat => ["queued", "generating"].includes(beat.status)) ? "running" : run?.status === "completed" ||
      run?.status === "awaiting-decision" && run.committedRevisions.length > 0
      ? "committed"
      : run?.status === "failed"
        ? "failed"
        : run?.status === "paused" || run?.status === "budget-paused" || run?.status === "debug-paused" ||
          run?.status === "preparation-invalidated"
          ? "paused"
        : run?.status === "running" || run?.status === "queued" || run?.status === "pausing"
          ? "running"
          : "awaiting";
    turns.push({
      id: `intent:${intent.submissionId}`,
      agentId: intent.agentId,
      baseRevision: intent.revision,
      createdAt: intent.submittedAt,
      status,
      ...(run?.servicePause ? { servicePause: structuredClone(run.servicePause) } : {}),
      action: { submissionId: intent.submissionId, text: intent.text },
      ...(responses.length > 0 ? { response: responses.at(-1), responses } : {}),
    });
  }
  for (const beat of document.narratives.filter(item => item.participantId === participant.id && !item.submissionId && item.segments.length)) {
    const last = beat.source.boundary;
    turns.push({ id: beat.id, agentId: participant.agentId, baseRevision: last.revision, createdAt: beat.createdAt,
      status: ["queued", "generating"].includes(beat.status) ? "running" : "committed",
      response: { id: beat.id, revision: last.revision, step: last.step, text: beat.segments.map(segment => segment.text).join("\n\n"),
        worldTimeSeconds: last.worldTimeSeconds, narrativeStatus: beat.status, segmentCount: beat.segments.length } });
  }
  turns.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { participantId: participant.id, agentId: participant.agentId, turns };
}

function observerAgent(document: WorldInstanceDocument, agentId: string): ObserverAgentSummary {
  const agent = document.state.agents[agentId];
  const perspective = projectAgentPerspective(document.state, agent);
  const binding = document.policyBindings[agentId];
  return {
    id: agentId,
    name: perspective.self.name,
    description: perspective.self.description,
    location: perspective.self.location?.name ?? null,
    policy: binding.kind === "external" ? "model" : binding.kind,
  };
}

function observerPerspective(document: WorldInstanceDocument, agentId: string): ObserverAgentPerspective {
  const agent = document.state.agents[agentId];
  if (!agent) throw new WorldHostError(`Agent not found: ${agentId}`, 404);
  return {
    agent: observerAgent(document, agentId),
    perspective: projectAgentPerspective(document.state, agent),
  };
}

function agentStateFromOrigin(
  state: Readonly<SimulationState>,
  origin: WorldOrigin,
  agentId: string,
  displayName: string,
  appearance: string,
  motivation: string,
): AgentState {
  const selfId = `${agentId}-self`;
  const locationId = `${agentId}-location`;
  return {
    id: agentId,
    entityId: agentId,
    modelProfiles: structuredClone(origin.modelProfiles),
    character: {
      persona: {
        summary: appearance ? `${origin.persona}\n外观：${appearance}` : origin.persona,
        voice: "",
        updatedAtStep: state.step,
        evidenceIds: [],
      },
      traits: {},
      values: {},
      emotions: {},
      attitudes: {},
      goals: {
        [`${agentId}-motivation`]: {
          id: `${agentId}-motivation`,
          description: motivation || origin.defaultGoal,
          priority: 0.8,
          progress: 0,
          targetIds: [],
          motivatedByIds: [],
          status: "active",
          createdAtStep: state.step,
          updatedAtStep: state.step,
          evidenceIds: [],
        },
      },
      commitments: {},
    },
    belief: {
      localEntities: {
        [selfId]: {
          id: selfId,
          name: displayName,
          description: appearance || origin.persona,
          status: "observed",
        },
        [locationId]: {
          id: locationId,
          name: state.truth.entities[origin.spawnEntityId].name,
          description: state.truth.entities[origin.spawnEntityId].description,
          status: "observed",
        },
      },
      claims: {},
      evidence: {},
    },
    bindings: {
      [selfId]: { localEntityId: selfId, canonicalEntityIds: [agentId] },
      [locationId]: { localEntityId: locationId, canonicalEntityIds: [origin.spawnEntityId] },
    },
    observationCursorStep: state.step,
    nextAction: null,
  };
}

export class WorldHost {
  private readonly narrativeWorkers = new Map<string, Promise<void>>();
  private readonly instanceListeners = new Map<string, Set<() => void>>();

  private notifyInstance(id: string) { for (const listener of this.instanceListeners.get(id) ?? []) listener(); }

  private scheduleNarrative(document: WorldInstanceDocument): void {
    if (currentRun(document)?.servicePause || this.narrativeWorkers.has(document.id) || !nextNarrative(document)) return;
    const job = Promise.resolve().then(() => this.generateNarratives(document.id));
    this.narrativeWorkers.set(document.id, job);
    let failed = false;
    void job.catch(() => { failed = true; }).finally(() => {
      this.narrativeWorkers.delete(document.id);
      if (!failed) try { this.scheduleNarrative(this.read(document.id).document); } catch { /* Closed/deleted instances retain their durable outbox for recovery. */ }
    });
  }

  /** Wait for presentation work without advancing the world or creating a model request. */
  async drainNarratives(id: string): Promise<void> {
    while (this.narrativeWorkers.has(id)) await this.narrativeWorkers.get(id);
  }

  private updateNarrative(id: string, beatId: string, update: (beat: NarrativeBeat) => void): void {
    const stored = this.read(id), document = structuredClone(stored.document);
    const beat = document.narratives.find(item => item.id === beatId);
    if (!beat) return;
    update(beat);
    document.updatedAt = this.now().toISOString();
    if (!currentRun(document)?.servicePause && document.actionWindow && document.runtime.actionWindowMs > 0 && !document.actionWindow.deadlineAt &&
      !document.narratives.some(item => ["queued", "generating"].includes(item.status) && document.actionWindow!.requiredAgentIds.includes(item.agentId))) {
      document.actionWindow.deadlineAt = new Date(this.now().getTime() + document.runtime.actionWindowMs).toISOString();
    }
    const saved = this.persist(stored, document);
    this.scheduleWindowDeadline(saved.document);
  }

  private async generateNarratives(id: string): Promise<void> {
    for (;;) {
      const document = this.read(id).document;
      if (currentRun(document)?.servicePause) return;
      const beat = nextNarrative(document);
      if (!beat) return;
      const discourse = participantDiscourse(document, beat.participantId, beat.id);
      const dialogue = beat.attempts === 0 && !beat.segments.length ? deliveredDialogue(beat.source, discourse) : null;
      if (dialogue) {
        this.updateNarrative(id, beat.id, item => {
          const at = this.now().toISOString();
          item.segments = dialogue.map((paragraph, sequence) => ({ ...paragraph, sequence, publishedAt: at }));
          item.status = "complete"; item.error = null; item.firstParagraphAt = at; item.completedAt = at;
        });
        continue;
      }
      if (beat.attempts >= 2) {
        this.updateNarrative(id, beat.id, item => {
          const fallback = narrativeFallback(item.source, item.segments.map(segment => segment.text));
          if (fallback) item.segments.push({ sequence: item.segments.length, text: fallback, mentions: explicitNarrativeMentions(fallback, item.source), publishedAt: this.now().toISOString() });
          item.status = "fallback"; item.completedAt = this.now().toISOString(); item.firstParagraphAt ??= item.completedAt;
        });
        continue;
      }
      const execution = this.beginExecution(document, "interactive", "narrative", NARRATIVE_MANIFEST);
      this.updateNarrative(id, beat.id, item => { item.status = "generating"; item.attempts += 1; if (execution) item.executionIds.push(execution.id); });
      const prefix = beat.segments.map(segment => segment.text);
      let published = 0;
      const control = document.state.executionState?.data.kind === "direct-world" ? document.state.executionState.data as unknown as DirectRuntimeState : null;
      const scope = { workloadId: `${id}:foreground`, batchId: beat.id,
        ...(control ? { modelRegistrySnapshotHash: control.registryHash } : {}),
        correlation: { executionId: execution?.id, instanceId: id, revision: document.state.revision },
        observer: execution?.trace ?? this.runtimeObserver,
        runtimeIdentity: { worldHash: document.state.worldHash, revision: document.state.revision } };
      const models = control ? agentCapabilityModels(document.state, control, beat.agentId) : document.state.agents[beat.agentId]!.modelProfiles;
      this.updateNarrative(id, beat.id, item => { item.producer = { profileId: models.creation, modelId: null, promptVersion: NARRATIVE_PROMPT_VERSION, registryHash: control?.registryHash ?? null }; });
      let publication = Promise.resolve(), publicationError: unknown, scheduled = 0;
      const publish = async (paragraphs: string[]) => {
        if (published >= paragraphs.length) return;
        const rendered = paragraphs.slice(published).map(paragraph => renderNarrativeSegment(paragraph, beat.source));
        const ready = rendered.map(paragraph => narrativeContinuation(paragraph.text, prefix));
        if (ready.every(text => !text)) { published = paragraphs.length; return; }
        const completeText = [...this.read(id).document.narratives.find(item => item.id === beat.id)!.segments.map(segment => segment.text), ...ready];
        assertSpeechMultiplicity(beat.source, completeText);
        assertSpeechOrder(beat.source, completeText);
        const decision = await checkNarrativeGrounding(this.options.provider, scope, beat.source, ready, models.fallback, models.fallback,
          Number.parseInt(contentHash([beat.id, beat.attempts, prefix.length + published]).slice(0, 10), 16),
          participantDiscourse(this.read(id).document, beat.participantId, beat.id));
        const choices = narrativeGroundingChoices(decision.answers, ready.length);
        this.updateNarrative(id, beat.id, item => item.grounding.push({ start: item.segments.length, inputHash: decision.inputHash,
          choices, invocationIds: decision.audits.flatMap(audit => audit.invocations.map(invocation => invocation.id)) }));
        let checked = 0;
        while (published < paragraphs.length) {
          if (ready[checked] && choices[checked] !== "grounded") throw new Error(`Paragraph contains ${choices[checked]}: ${ready[checked]}. Continue using only the supplied scene; omit unsupported content.`);
          const mentions = rendered[checked]!.mentions.filter(mention => ready[checked]!.includes(mention.surface));
          const text = ready[checked++]!;
          if (text) this.updateNarrative(id, beat.id, item => {
            const sequence = item.segments.length;
            const at = this.now().toISOString();
            item.segments.push({ sequence, text, mentions, publishedAt: at }); item.firstParagraphAt ??= at;
          });
          published++;
        }
      };
      try {
        const result = await this.options.provider.generateStructured({
          ...scope, role: "creation", subjectId: beat.agentId,
          profileId: models.creation,
          ...(control ? { modelRegistrySnapshotHash: control.registryHash } : {}),
          correlation: { executionId: execution?.id, instanceId: id, revision: document.state.revision },
          observer: execution?.trace ?? this.runtimeObserver,
          runtimeIdentity: { worldHash: document.state.worldHash, revision: document.state.revision },
          modelInvocation: beat.attempts + 1,
          modelInvocationId: runtimeId({ worldHash: document.state.worldHash, revision: document.state.revision,
            kind: "model-audit", stage: "scene-narrative", owner: beat.id, round: 0, ordinal: beat.attempts + 1 }),
          promptVersion: NARRATIVE_PROMPT_VERSION, schemaName: "SceneNarrativeV1",
          system: NARRATIVE_SYSTEM, userPrompt: NARRATIVE_USER,
          context: { discourse: narrativeDiscourse(discourse),
            publishedPrefix: prefix, scene: narrativeEvidence(beat.source),
            publicationTask: narrativeTask(beat.source, participantDiscourse(document, beat.participantId, beat.id)),
            repair: beat.error },
          schema: z.object({
            reading: z.object({ currentResults: z.array(z.string()), remainingUnconfirmed: z.array(z.string()),
              dialogueSpeakersInOrder: z.array(z.string()) }).optional()
              .describe("Brief source reading BEFORE prose: what these new receipts establish, what they leave unconfirmed, and actual speakers in order. This is diagnostic, not a new world event."),
            paragraphs: z.array(z.string().trim().min(1)).min(1),
          }), jsonExamplePolicy: "omit",
          onOutputText: async text => {
            const paragraphs = completeParagraphs(text);
            if (paragraphs.length <= scheduled) return;
            scheduled = paragraphs.length;
            publication = publication.then(async () => {
              if (publicationError === undefined) await publish(paragraphs);
            }).catch(error => { publicationError = error; });
          },
        });
        this.updateNarrative(id, beat.id, item => { if (item.producer) item.producer.modelId = result.audit.modelId; });
        await publication;
        if (publicationError !== undefined) throw publicationError;
        await publish(completeParagraphs(JSON.stringify(result.value)));
        requireDeliveredSpeech(beat.source, this.read(id).document.narratives.find(item => item.id === beat.id)!.segments.map(segment => segment.text));
        execution?.trace.flush();
        if (execution && this.options.ledger) this.options.ledger.finishExecution(execution.id,
          { status: "succeeded", semanticHash: contentHash(result.value), stateHash: contentHash(this.read(id).document.state) });
        this.updateNarrative(id, beat.id, item => { item.status = "complete"; item.error = null; item.completedAt = this.now().toISOString(); });
      } catch (error) {
        await publication;
        this.failExecution(execution?.id, error);
        const pause = modelServicePause(error);
        if (pause) {
          const stored = this.read(id), paused = structuredClone(stored.document);
          const item = paused.narratives.find(value => value.id === beat.id)!;
          const fallback = narrativeFallback(item.source, item.segments.map(segment => segment.text));
          const at = this.now().toISOString();
          if (fallback) item.segments.push({ sequence: item.segments.length, text: fallback, mentions: explicitNarrativeMentions(fallback, item.source), publishedAt: at });
          item.status = "fallback"; item.error = error instanceof Error ? error.message : String(error);
          item.completedAt = at; if (item.segments.length) item.firstParagraphAt ??= at;
          const origin = paused.participantIntents.find(intent => intent.submissionId === beat.submissionId)?.runId;
          this.pauseModelService(paused, pause, origin);
          paused.updatedAt = at; this.persist(stored, paused);
          return;
        }
        this.updateNarrative(id, beat.id, item => { item.status = "queued"; item.error = error instanceof Error ? error.message : String(error); });
      }
    }
  }

  /** Preserve settled effects and fence unfinished work when a shared service cannot accept calls. */
  private pauseModelService(document: WorldInstanceDocument, pause: ModelServicePause, originRunId?: string): void {
    for (const run of new Set([currentRun(document), originRunId ? document.runs[originRunId] : null])) {
      if (!run) continue;
      if (["queued", "running", "pausing"].includes(run.status)) {
        run.generation += 1; this.runControllers.get(run.id)?.abort();
        const timer = this.runTimers.get(run.id);
        if (timer) this.clearTimer(timer);
        this.runTimers.delete(run.id);
      }
      run.status = "failed"; run.stopReason = "model-service-paused";
      run.servicePause = structuredClone(pause); run.error = pause.message; run.updatedAt = this.now().toISOString();
    }
    document.scheduler = { mode: "paused", generation: document.scheduler.generation + 1, nextTickAt: null };
    if (document.actionWindow) document.actionWindow.deadlineAt = null;
    this.cancelTimer(document.id);
  }

  private static singleton: WorldHost | undefined;
  private readonly registry: WorldExecutionAlgorithmRegistry;
  private readonly defaultAlgorithmRef: AlgorithmRef;
  private readonly experiments: AlgorithmExperimentRegistry;
  private readonly committer: CanonicalCommitter;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly maxActiveParticipants: number;
  private readonly runLeaseMaxCommits: number;
  private readonly runLeaseMaxWallTimeMs: number;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runControllers = new Map<string, AbortController>();
  private readonly debugStageGates = new Map<string, DebugStageGate>();
  private readonly debugRecoveries = new Map<string, { executionId: string; completedStageIndex: number }>();
  private readonly inspectorLedgerSnapshots = new Map<string, InspectorLedgerSnapshot>();
  private readonly inspectorWindowProjections = new Map<string, { inputKey: string; sourceKey: string; value: ReturnType<typeof buildWorldInspectorWindow> }>();
  private readonly inspectorInvocationProjections = new Map<string, { inputKey: string; sourceKey: string; value: ReturnType<typeof queryWorldInspectorModelInvocations> }>();
  private readonly inspectorLedgerUnsubscribe?: () => void;
  private readonly setTimer: WorldHostOptions["setTimer"];
  private readonly clearTimer: NonNullable<WorldHostOptions["clearTimer"]>;
  readonly runtimeObserver: RuntimeObserver;

  constructor(private readonly options: WorldHostOptions) {
    this.committer = new CanonicalCommitter(options.repository.rulePackages);
    if (options.ledger && !isAtomicStore(options.store)) {
      throw new Error("Execution Ledger requires atomic instance/execution persistence");
    }
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.maxActiveParticipants = options.maxActiveParticipants ?? 1;
    this.runLeaseMaxCommits = options.runLeaseMaxCommits ?? 100;
    this.runLeaseMaxWallTimeMs = options.runLeaseMaxWallTimeMs ?? 15 * 60 * 1_000;
    if (!Number.isSafeInteger(this.runLeaseMaxCommits) || this.runLeaseMaxCommits < 1 ||
      !Number.isSafeInteger(this.runLeaseMaxWallTimeMs) || this.runLeaseMaxWallTimeMs < 1) {
      throw new Error("world run lease budgets must be positive integers");
    }
    this.runtimeObserver = options.observer ?? NOOP_RUNTIME_OBSERVER;
    this.inspectorLedgerUnsubscribe = options.ledger?.subscribe((event) => {
      const instanceId = event.correlation?.instanceId;
      if (instanceId) {
        this.inspectorLedgerSnapshots.delete(instanceId);
        this.inspectorWindowProjections.delete(instanceId);
        this.inspectorInvocationProjections.delete(instanceId);
      }
    });
    this.registry = registerBuiltinAlgorithms(options.algorithmRegistry ?? new WorldExecutionAlgorithmRegistry());
    this.experiments = options.experimentRegistry ?? new AlgorithmExperimentRegistry(this.registry);
    this.defaultAlgorithmRef = structuredClone(options.defaultAlgorithmRef ?? DEFAULT_ALGORITHM_REF);
    if (!this.registry.has(this.defaultAlgorithmRef)) {
      throw new Error(
        `default execution algorithm is not registered: ${this.defaultAlgorithmRef.id}@${this.defaultAlgorithmRef.version}`,
      );
    }
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    const storedInstances = options.store.listInstances();
    for (const stored of storedInstances) {
      this.assertExecutionAlgorithmAvailable(stored.document);
      this.definition(stored.document);
    }
    for (const stored of storedInstances) { this.restoreSchedule(stored); this.scheduleNarrative(this.read(stored.document.id).document); }
  }

  static get(): WorldHost {
    if (!this.singleton) {
      const catalog = loadModelCatalog(path.resolve(
        /* turbopackIgnore: true */ process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml",
      ));
      const dataRoot = path.resolve(
        /* turbopackIgnore: true */ process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v27",
      );
      const modelRegistry = new ModelRegistry(catalog, dataRoot);
      modelRegistry.startBackgroundRefresh();
      const provider = createModelGateway(catalog, process.env, {
        registry: modelRegistry,
        fetchForAccount: qualificationModelFetchResolver(process.env),
      });
      const databaseFile = path.join(dataRoot, "livingworld.sqlite");
      const database = new LocalDatabase(databaseFile);
      try {
        installBundledWorlds(database, provider.catalog);
        const algorithmRegistry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
        const experimentRegistry = loadAlgorithmExperimentRegistry(algorithmRegistry, undefined, database);
        const retrievalProvider = createActionCompilationRetrievalRuntimeProvider({
          onSafetyViolation: (ref, reason) => {
            if (experimentRegistry.active()?.variants.some(
              (variant) => variant.algorithmRef.manifestHash === ref.manifestHash,
            )) {
              experimentRegistry.stopNewEnrollment(`candidate retrieval runtime failure: ${reason}`);
            }
          },
        });
        this.singleton = new WorldHost({
          repository: database,
          store: database,
          catalogManager: database,
          provider,
          ledger: database,
          algorithmRegistry,
          experimentRegistry,
          actionCompilationRetrievalProvider: retrievalProvider,
        });
      } catch (error) {
        modelRegistry.stopBackgroundRefresh();
        database.close();
        if (database.created) {
          for (const suffix of ["", "-shm", "-wal"]) rmSync(`${databaseFile}${suffix}`, { force: true });
        }
        throw error;
      }
    }
    return this.singleton;
  }

  static observer(): RuntimeObserver {
    return this.singleton?.runtimeObserver ?? NOOP_RUNTIME_OBSERVER;
  }

  static setForTests(host: WorldHost | undefined): void {
    this.singleton = host;
  }

  listWorlds() {
    return this.options.repository.list();
  }

  async modelRegistryDiagnostics(): Promise<ModelRegistryDiagnostics> {
    const diagnostics = this.options.provider.modelRegistryDiagnostics;
    if (!diagnostics) throw new WorldHostError("model registry diagnostics are unavailable", 501);
    return diagnostics.call(this.options.provider);
  }

  async refreshModelRegistry(): Promise<ModelRegistryRefreshDiagnostics> {
    const refresh = this.options.provider.refreshModelRegistry;
    if (!refresh) throw new WorldHostError("model registry refresh is unavailable", 501);
    try {
      return await refresh.call(this.options.provider);
    } catch (error) {
      const message = error instanceof Error ? error.message : "model registry refresh failed";
      if (message.includes("rate limited")) throw new WorldHostError(message, 429);
      if (message.includes("no valid snapshot")) throw new WorldHostError(message, 503);
      throw new WorldHostError("model registry refresh failed", 502);
    }
  }

  importWorld(buffer: Buffer, replace = false, expectedWorldId?: string): WorldImportResult {
    if (!this.options.catalogManager) throw new WorldHostError("world import is unavailable", 501);
    return this.options.catalogManager.importWorld(buffer, this.options.provider.catalog, replace, expectedWorldId);
  }

  deleteWorld(worldId: string): void {
    if (!this.options.catalogManager) throw new WorldHostError("world management is unavailable", 501);
    this.options.catalogManager.deleteWorld(worldId);
  }

  worldAsset(worldId: string, hash: string): { mime: string; bytes: Buffer } {
    const definition = this.options.repository.load(worldId, 1, this.options.provider.catalog);
    const asset = definition.assetData[hash];
    if (!asset) throw new WorldHostError("world asset not found", 404);
    return { mime: asset.mime, bytes: Buffer.from(asset.bytesBase64, "base64") };
  }

  private definition(document: WorldInstanceDocument): WorldDefinition {
    const seed = document.state.historyBase?.truth.rng.seed ?? document.state.truth.rng.seed;
    const definition = this.options.repository.loadVersion(
      document.world.id,
      document.world.contentHash,
      seed,
      this.options.provider.catalog,
    );
    if (contentHash(toWorldRuntimeContract(definition)) !== contentHash(document.world)) {
      throw new Error("instance world contract does not match its pinned world version");
    }
    validateWorldModelProfiles(definition, this.options.provider.catalog);
    return definition;
  }

  private algorithmServices(ref: AlgorithmRef) {
    const retrieval = this.options.actionCompilationRetrievalProvider?.runtime(ref);
    return {
      provider: this.options.provider,
      rulePackages: this.options.repository.rulePackages,
      ...(retrieval ? {
        resources: {
          resolve<T>(kind: string): T | undefined {
            return kind === "candidate-selection-runtime" ? retrieval as T : undefined;
          },
        },
      } : {}),
    };
  }

  private requiresActionCompilationRetrieval(ref: AlgorithmRef): boolean {
    return ref.children.actionCompilation?.children.candidateSelection?.id === "relational-rrf";
  }

  private assertExecutionAlgorithmAvailable(document: WorldInstanceDocument): void {
    if (!this.registry.has(document.executionAlgorithm)) {
      throw new Error(
        `execution algorithm is not registered: ${document.executionAlgorithm.id}` +
        `@${document.executionAlgorithm.version}`,
      );
    }
    if (document.experimentEnrollment) {
      try {
        this.experiments.validateEnrollment(document.id, document.experimentEnrollment);
      } catch (error) {
        this.experiments.stopNewEnrollment(
          `historical experiment enrollment validation failure: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    }
  }

  private read(id: string): StoredWorldInstance {
    try {
      const stored = this.options.store.readInstance(id, { instanceId: id });
      this.assertExecutionAlgorithmAvailable(stored.document);
      this.definition(stored.document);
      return stored;
    } catch (error) {
      if (error instanceof WorldInstanceNotFoundError) throw new WorldHostError(`world instance not found: ${id}`, 404);
      throw error;
    }
  }

  private inspectorSources(id: string, stored: StoredWorldInstance): InspectorLedgerSnapshot {
    const instanceKey = [stored.generation, stored.document.updatedAt, stored.document.state.revision].join(":");
    const cached = this.inspectorLedgerSnapshots.get(id);
    if (cached?.key.startsWith(`${instanceKey}|`)) return cached;
    const events = this.options.ledger?.instanceEvents(id) ?? [];
    const records = this.options.ledger?.executions({ instanceId: id }) ?? [];
    const key = `${instanceKey}|${[
      events.at(-1)?.sequence ?? 0,
      records.length,
      records.at(-1)?.status ?? "",
    ].join(":")}`;
    const snapshot = { key, records, events };
    this.inspectorLedgerSnapshots.set(id, snapshot);
    return snapshot;
  }

  private persist(stored: StoredWorldInstance, document: WorldInstanceDocument): StoredWorldInstance {
    try {
      enqueueNarrative(document, this.now().toISOString());
      const saved = this.options.store.compareAndSwapInstance(document.id, stored.generation, document, { instanceId: document.id });
      this.notifyInstance(document.id); this.scheduleNarrative(saved.document);
      return saved;
    } catch (error) {
      if (error instanceof WorldInstanceConflictError) throw new WorldHostError("world instance changed concurrently", 409);
      throw error;
    }
  }

  private async serialized<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.catch(() => undefined).then(() => gate);
    this.locks.set(id, queued);
    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.locks.get(id) === queued) this.locks.delete(id);
    }
  }

  private beginExecution(
    document: WorldInstanceDocument,
    kind: "interactive" | "diagnostic" | "benchmark" | "replay",
    trigger: string,
    manifest: ExecutionProducerManifest,
    policyBindings: Readonly<Record<string, PolicyBinding>> = document.policyBindings,
    parentExecutionId?: string,
  ) {
    if (!this.options.ledger) return undefined;
    const id = randomUUID();
    const code = runtimeCodeIdentity();
    const bindings = Object.values(policyBindings);
    const trace = this.options.ledger.beginExecution({
      id,
      kind,
      ...(parentExecutionId ? { parentExecutionId } : {}),
      instanceId: document.id,
      step: document.state.step,
      manifest,
      worldHash: document.state.worldHash,
      codeRevision: code.revision,
      codeDirty: code.dirty,
      modelCatalogHash: this.options.provider.catalog.hash,
      seed: document.state.historyBase?.truth.rng.seed ?? document.state.truth.rng.seed,
      runtimeConfig: {
        trigger,
        realtimeIntervalMs: document.runtime.realtimeIntervalMs,
        actionWindowMs: document.runtime.actionWindowMs,
        policyRosterHash: contentHash(policyBindings),
        participants: activeParticipants(document).length,
        autonomousAgents: bindings.filter((binding) => binding.kind === "model").length,
        externalAgents: bindings.filter((binding) => binding.kind === "external").length,
        idleAgents: bindings.filter((binding) => binding.kind === "idle").length,
        experimentId: document.experimentEnrollment?.experimentId ?? null,
        experimentVersion: document.experimentEnrollment?.experimentVersion ?? null,
        experimentVariant: document.experimentEnrollment?.variantId ?? null,
        experimentAssignmentHash: document.experimentEnrollment?.assignmentHash ?? null,
      },
    });
    if (document.experimentEnrollment) {
      trace.emit({
        event: "experiment.instance.enrolled",
        correlation: { executionId: id, instanceId: document.id, revision: document.state.revision, step: document.state.step },
        attributes: {
          experimentId: document.experimentEnrollment.experimentId,
          experimentVersion: document.experimentEnrollment.experimentVersion,
          variantId: document.experimentEnrollment.variantId,
          bucket: document.experimentEnrollment.bucket,
        },
        hashes: {
          experimentManifest: document.experimentEnrollment.experimentManifestHash,
          assignment: document.experimentEnrollment.assignmentHash,
          algorithmManifest: document.experimentEnrollment.algorithmRef.manifestHash,
        },
      });
    }
    return { id, trace };
  }

  private failExecution(executionId: string | undefined, error: unknown): void {
    if (!executionId || !this.options.ledger || this.options.ledger.execution(executionId)?.status !== "running") return;
    this.options.ledger.finishExecution(executionId, {
      status: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
      error,
    });
  }

  private debugCheckpointValidationError(
    document: Readonly<WorldInstanceDocument>,
    run: Readonly<WorldRunRecord>,
    validateActiveSource = true,
  ): string | null {
    const checkpoint = run.debugCheckpoint;
    if (!checkpoint) return "debug checkpoint metadata is missing";
    if (!this.options.ledger) return "debug checkpoint ledger is unavailable";
    const artifact = this.options.ledger.artifact(checkpoint.artifactHash);
    if (!artifact || artifact.hash !== checkpoint.artifactHash) return "debug checkpoint artifact is missing";
    if (artifact.kind !== "world-debug-checkpoint" || artifact.executionId !== checkpoint.executionId) {
      return "debug checkpoint artifact ownership does not match";
    }
    if (!artifact.value || typeof artifact.value !== "object" || Array.isArray(artifact.value)) {
      return "debug checkpoint artifact payload is invalid";
    }
    const value = artifact.value as Record<string, unknown>;
    if (value.schemaVersion !== EXECUTION_CHECKPOINT_SCHEMA_VERSION || value.id !== checkpoint.id ||
      value.executionId !== checkpoint.executionId ||
      value.runId !== run.id || value.generation !== run.generation ||
      value.boundaryIndex !== checkpoint.boundaryIndex ||
      value.stageIndex !== checkpoint.stageIndex || value.stageKey !== checkpoint.stageKey) {
      return "debug checkpoint artifact does not match the active run";
    }
    if (validateActiveSource && (value.sourceRevision !== document.state.revision ||
      value.sourceStateHash !== contentHash(document.state) || value.boundaryIndex !== run.committedRevisions.length)) {
      return "debug checkpoint source state does not match the active run";
    }
    const eventRange = value.eventRange;
    if (!eventRange || typeof eventRange !== "object" || Array.isArray(eventRange)) {
      return "debug checkpoint event range is invalid";
    }
    const range = eventRange as Record<string, unknown>;
    if ((range.fromSequence !== null && (!Number.isSafeInteger(range.fromSequence) || Number(range.fromSequence) < 1)) ||
      (range.toSequence !== null && (!Number.isSafeInteger(range.toSequence) || Number(range.toSequence) < 1)) ||
      (typeof range.fromSequence === "number" && typeof range.toSequence === "number" &&
        range.fromSequence > range.toSequence)) {
      return "debug checkpoint event range is invalid";
    }
    const sourceEvents = this.options.ledger.executionEvents(checkpoint.executionId);
    if (range.fromSequence !== (sourceEvents[0]?.sequence ?? null) ||
      !sourceEvents.some((event) => event.sequence === range.toSequence)) {
      return "debug checkpoint event range does not match the execution";
    }
    if (!Array.isArray(value.priorArtifactRefs) ||
      value.priorArtifactRefs.some((hash) => typeof hash !== "string" || !hash.trim())) {
      return "debug checkpoint artifact references are invalid";
    }
    if (value.priorArtifactRefs.some((hash) => !this.options.ledger!.artifact(String(hash)))) {
      return "debug checkpoint artifact references are missing";
    }
    const continuation = value.continuation;
    if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
      return "debug checkpoint continuation is invalid";
    }
    const envelope = continuation as Record<string, unknown>;
    if (envelope.schemaVersion !== 1 || envelope.kind !== "recorded-stage-replay" ||
      !Number.isSafeInteger(envelope.nextStageIndex) || Number(envelope.nextStageIndex) < 0 ||
      Number(envelope.nextStageIndex) >= 10 || envelope.nextStageIndex !== checkpoint.stageIndex) {
      return "debug checkpoint continuation is invalid";
    }
    const sourceExecution = this.options.ledger.execution(checkpoint.executionId);
    if (!sourceExecution || sourceExecution.instanceId !== document.id ||
      envelope.producerManifestHash !== sourceExecution.manifest.hash ||
      envelope.worldHash !== sourceExecution.worldHash ||
      envelope.modelCatalogHash !== sourceExecution.modelCatalogHash ||
      envelope.codeRevision !== sourceExecution.codeRevision ||
      envelope.codeDirty !== sourceExecution.codeDirty) {
      return "debug checkpoint continuation ownership does not match";
    }
    if (validateActiveSource) {
      const code = runtimeCodeIdentity();
      if (sourceExecution.manifest.hash !== document.executionAlgorithm.manifestHash ||
        sourceExecution.worldHash !== document.state.worldHash ||
        sourceExecution.modelCatalogHash !== this.options.provider.catalog.hash ||
        sourceExecution.codeRevision !== code.revision || sourceExecution.codeDirty !== code.dirty) {
        return "debug checkpoint continuation runtime does not match";
      }
    }
    return null;
  }

  private async persistDebugCheckpoint(
    instanceId: string,
    runId: string,
    executionId: string | undefined,
    stage: ExecutionStagePosition,
  ): Promise<void> {
    if (!executionId || !this.options.ledger) {
      throw new WorldHostError("single-step debugging requires an execution ledger", 503);
    }
    const checkpointId = this.idFactory();
    const stored = this.read(instanceId);
    const run = stored.document.runs[runId];
    if (!run || run.debugMode !== "step") throw new WorldHostError("debug run changed", 409);
    const priorArtifactRefs = stored.document.actionWindow?.kind === "reaction"
      ? [stored.document.actionWindow.preparationArtifactHash]
      : [];
    const executionEvents = this.options.ledger.executionEvents(executionId);
    const sourceExecution = this.options.ledger.execution(executionId);
    if (!sourceExecution) throw new WorldHostError("debug execution is missing", 409);
    const checkpoint = {
      schemaVersion: EXECUTION_CHECKPOINT_SCHEMA_VERSION,
      id: checkpointId,
      executionId,
      runId,
      generation: run.generation,
      sourceRevision: stored.document.state.revision,
      sourceStateHash: contentHash(stored.document.state),
      boundaryIndex: run.committedRevisions.length,
      stageIndex: stage.index,
      stageKey: stage.key,
      eventRange: {
        fromSequence: executionEvents[0]?.sequence ?? null,
        toSequence: executionEvents.at(-1)?.sequence ?? null,
      },
      priorArtifactRefs,
      continuation: {
        schemaVersion: 1,
        kind: "recorded-stage-replay" as const,
        nextStageIndex: stage.index,
        producerManifestHash: sourceExecution.manifest.hash,
        worldHash: sourceExecution.worldHash,
        modelCatalogHash: sourceExecution.modelCatalogHash,
        codeRevision: sourceExecution.codeRevision,
        codeDirty: sourceExecution.codeDirty,
      },
      createdAt: this.now().toISOString(),
    } satisfies ExecutionCheckpoint;
    const artifactHash = this.options.ledger.putExecutionArtifact(executionId, "world-debug-checkpoint", checkpoint);
    const next = structuredClone(stored.document);
    const nextRun = next.runs[runId];
    if (!nextRun || nextRun.debugMode !== "step" ||
      !["running", "debug-paused"].includes(nextRun.status)) {
      throw new WorldHostError("debug run changed", 409);
    }
    nextRun.status = "debug-paused";
    nextRun.stopReason = "debug-stage-paused";
    if (!nextRun.executionIds.includes(executionId)) nextRun.executionIds.push(executionId);
    nextRun.debugCheckpoint = {
      id: checkpointId,
      executionId,
      artifactHash,
      boundaryIndex: checkpoint.boundaryIndex,
      stageIndex: stage.index,
      stageKey: stage.key,
      updatedAt: checkpoint.createdAt,
    };
    nextRun.updatedAt = checkpoint.createdAt;
    next.updatedAt = checkpoint.createdAt;
    this.persist(stored, next);
  }

  worldStartOptions(worldId: string): WorldStartOptions {
    const definition = this.options.repository.load(worldId, 1, this.options.provider.catalog);
    return {
      world: {
        id: definition.id,
        name: definition.name,
        version: definition.manifestVersion,
        contentHash: definition.contentHash,
        description: definition.description,
        participation: definition.participation ? "open" : "headless",
      },
      origins: (definition.participation?.origins ?? []).map((origin) => ({
        id: origin.id,
        title: origin.title,
        fantasy: origin.fantasy,
        description: origin.description,
        location: definition.initialState.truth.entities[origin.spawnEntityId].name,
        relationshipHooks: [...origin.relationshipHooks],
        risks: [...origin.risks],
        ...(origin.image ? { image: structuredClone(origin.image) } : {}),
      })),
      observerAvailable: true,
    };
  }

  async createInstance(
    input: CreateInstanceInput,
    principalId = "local",
    executionAlgorithm?: AlgorithmRef,
  ): Promise<PublicInstanceDetail> {
    const definition = this.options.repository.load(input.worldId, input.seed ?? 1, this.options.provider.catalog);
    await this.options.provider.assertProfilesAvailable(worldModelProfileIds(definition));
    const id = this.idFactory();
    const experiment = this.experiments.enrollment({
      instanceId: id,
      worldContentHash: definition.contentHash,
      defaultAlgorithmRef: executionAlgorithm ?? this.defaultAlgorithmRef,
      explicitExecutionTuning: executionAlgorithm !== undefined,
    });
    const retrievalProvider = this.options.actionCompilationRetrievalProvider;
    const retrievalRuntime = retrievalProvider?.runtime(experiment.algorithmRef);
    if (this.requiresActionCompilationRetrieval(experiment.algorithmRef) &&
      (!retrievalProvider || !retrievalRuntime)) {
      const reason = `candidate retrieval dependencies are missing for ${experiment.algorithmRef.manifestHash}`;
      if (experiment.enrollment) this.experiments.stopNewEnrollment(reason);
      throw new WorldHostError(`candidate selection is not ready: ${reason}`, 503);
    }
    if (retrievalRuntime) {
      try {
        await retrievalProvider!.preflight(experiment.algorithmRef, {
          worldContentHash: definition.contentHash,
          state: definition.initialState,
        });
      } catch (error) {
        throw new WorldHostError(
          `candidate selection is not ready: ${error instanceof Error ? error.message : String(error)}`,
          503,
        );
      }
    }
    const now = this.now().toISOString();
    const initial: WorldInstanceDocument = {
      schemaVersion: 27,
      id,
      world: toWorldRuntimeContract(definition),
      executionAlgorithm: structuredClone(experiment.algorithmRef),
      experimentEnrollment: structuredClone(experiment.enrollment),
      experimentExclusion: experiment.exclusionReason
        ? { reason: experiment.exclusionReason, detail: experiment.exclusionDetail ?? null }
        : null,
      title: input.title?.trim() || definition.name,
      createdAt: now,
      updatedAt: now,
      state: structuredClone(definition.initialState),
      participants: {},
      policyBindings: policyRoster(definition.initialState),
      actionWindow: null,
      runtime: { ...structuredClone(definition.runtimeDefaults), debugSteppingEnabled: false },
      scheduler: { mode: "paused", generation: 1, nextTickAt: null },
      runs: {},
      narratives: [],
      participantIntents: [],
      reactionSubmissions: [],
    };
    if (!this.registry.has(initial.executionAlgorithm)) {
      throw new WorldHostError(
        `execution algorithm is not registered: ${initial.executionAlgorithm.id}@${initial.executionAlgorithm.version}`,
        400,
      );
    }
    const algorithm = this.registry.create(initial.executionAlgorithm, this.algorithmServices(initial.executionAlgorithm));
    const execution = this.beginExecution(initial, "interactive", "bootstrap", algorithm.manifest);
    const engine = new SimulationEngine(
      definition,
      algorithm,
    );
    try {
      initial.state = await engine.bootstrapAgents({
        workloadId: id,
        batchId: `bootstrap:${id}`,
        correlation: { executionId: execution?.id, instanceId: id, revision: 0, step: 0 },
        observer: execution?.trace ?? this.runtimeObserver,
      });
      initial.policyBindings = policyRoster(initial.state);
      if (input.start.kind === "origin") {
        const start = input.start;
        if (!definition.participation) throw new WorldHostError("this world does not define Origins", 409);
        const origin = definition.participation.origins.find((entry) => entry.id === start.originId);
        if (!origin) throw new WorldHostError("origin not found", 404);
        const displayName = start.displayName.trim();
        const appearance = start.appearance.trim();
        const motivation = start.motivation.trim();
        if (!displayName || displayName.length > 80 || appearance.length > 500 || motivation.length > 500) {
          throw new WorldHostError("participant customization is invalid", 400);
        }
        let ordinal = 1;
        let agentId: string;
        do agentId = `${origin.id}-${ordinal++}`; while (initial.state.agents[agentId]);
        const agent = agentStateFromOrigin(initial.state, origin, agentId, displayName, appearance, motivation);
        const mechanicsProfile = initial.state.truth.mechanics.entityMechanicsProfiles[origin.mechanicsProfileId];
        if (!mechanicsProfile) throw new WorldHostError("origin mechanics profile is unavailable", 500);
        const admitted = this.committer.admit(initial.state, {
          entity: {
            id: agentId,
            kind: origin.entityKind,
            name: displayName,
            description: appearance ? `${origin.description}\n外观：${appearance}` : origin.description,
            lifecycle: "active",
            createdAtStep: initial.state.step,
          },
          placementId: origin.spawnEntityId,
          agent,
          meters: mechanicsProfile.meters.map((entry) => ({
            id: `${agentId}-${entry.definitionId}`,
            definitionId: entry.definitionId,
            entityId: agentId,
            current: entry.current,
            firedThresholdIds: [],
          })),
          quantities: mechanicsProfile.quantities.map((entry) => ({
            id: quantityId(initial.state.worldHash, entry.definitionId, agentId),
            definitionId: entry.definitionId,
            holderId: agentId,
            amount: entry.amount,
          })),
          ratings: mechanicsProfile.ratings.map((entry) => ({
            id: `${agentId}-${entry.definitionId}`,
            definitionId: entry.definitionId,
            entityId: agentId,
            value: entry.value,
          })),
          conditions: [],
        });
        initial.state = admitted.state;
        initial.policyBindings = policyRoster(initial.state);
        const participantId = this.idFactory();
        const joinedAt = this.now().toISOString();
        const fallback: ParticipantArrivalRecord = {
          id: this.idFactory(),
          revision: initial.state.revision,
          step: initial.state.step,
          title: `此刻，你是${displayName}`,
          scene: origin.fallbackArrival,
          knownEntities: Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description })),
          possibleNextActions: ["观察四周", "确认自己所在的位置", "寻找一个可以交谈的人"],
          generated: false,
          createdAt: joinedAt,
        };
        initial.participants[participantId] = {
          id: participantId,
          principalId,
          displayName,
          agentId,
          status: "active",
          joinedAt,
          updatedAt: joinedAt,
          controlledSinceRevision: initial.state.revision,
          ...(agent.nextAction ? { suppressedActionId: agent.nextAction.id } : {}),
          arrival: fallback,
        };
        initial.policyBindings[agentId] = { kind: "external", agentId, participantId };
        const arrival = initial.state.executionState?.data.kind === "direct-world" ? fallback : await this.generateArrival(initial, participantId, origin.fallbackArrival);
        initial.participants[participantId].arrival = {
          ...fallback,
          title: arrival.title,
          scene: arrival.scene,
          possibleNextActions: [...arrival.possibleNextActions],
          generated: arrival.generated,
        };
      }
      const finish: FinishExecutionInput = {
        status: "succeeded",
        semanticHash: contentHash(initial.state),
        stateHash: contentHash(initial.state),
        commitRevision: initial.state.revision,
      };
      const stored = execution && this.options.ledger && isAtomicStore(this.options.store)
        ? this.options.store.createInstanceAndFinishExecution(initial, execution.id, finish).instance
        : this.options.store.createInstance(initial);
      if (execution && this.options.ledger && !isAtomicStore(this.options.store)) {
        this.options.ledger.finishExecution(execution.id, finish);
      }
      return this.project(stored.document, principalId);
    } catch (error) {
      this.failExecution(execution?.id, error);
      throw error;
    }
  }

  listInstances(): PublicInstanceSummary[] {
    return this.options.store.listInstances().map(({ document }) => publicSummary(document));
  }

  inspectorWindow(id: string, input: { beforeRevision?: number; limit: number }) {
    const stored = this.read(id);
    const snapshot = this.inspectorSources(id, stored);
    const inputKey = JSON.stringify(input);
    const cached = this.inspectorWindowProjections.get(id);
    if (cached?.sourceKey === snapshot.key && cached.inputKey === inputKey) return cached.value;
    const value = buildWorldInspectorWindow(stored.document, snapshot.records, snapshot.events, input, this.options.repository.rulePackages);
    this.inspectorWindowProjections.set(id, { inputKey, sourceKey: snapshot.key, value });
    return value;
  }

  inspectorStep(id: string, revision: number) {
    const stored = this.read(id);
    const snapshot = this.inspectorSources(id, stored);
    const detail = buildWorldInspectorStepDetail(
      stored.document,
      revision,
      snapshot.events,
      this.options.repository.rulePackages,
    );
    if (!detail) throw new WorldHostError(`committed revision not found: ${revision}`, 404);
    return detail;
  }

  inspectorReplay(id: string, executionId: string) {
    const document = this.read(id).document;
    const record = this.options.ledger?.execution(executionId);
    if (!record || record.instanceId !== id) throw new WorldHostError(`execution not found: ${executionId}`, 404);
    const checkpointRun = Object.values(document.runs)
      .find((run) => run.debugCheckpoint?.executionId === executionId);
    const checkpoint = checkpointRun && !this.debugCheckpointValidationError(document, checkpointRun, false)
      ? checkpointRun.debugCheckpoint
      : null;
    const replay = buildWorldInspectorReplay(
      document,
      executionId,
      record,
      this.options.ledger?.executionEvents(executionId) ?? [],
      checkpoint ? { id: checkpoint.id, artifactHash: checkpoint.artifactHash } : undefined,
    );
    if (!replay) throw new WorldHostError(`execution not found: ${executionId}`, 404);
    return replay;
  }

  inspectorAttempt(id: string, executionId: string) {
    const stored = this.read(id);
    const snapshot = this.inspectorSources(id, stored);
    const record = this.options.ledger?.execution(executionId);
    if (!record || record.instanceId !== id) throw new WorldHostError("execution not found", 404);
    const detail = buildWorldInspectorAttemptDetail(
      executionId,
      record,
      snapshot.events.filter((event) => event.correlation?.executionId === executionId),
      Object.keys(stored.document.state.agents),
    );
    if (!detail) throw new WorldHostError("execution not found", 404);
    return detail;
  }

  inspectorModelInvocations(
    id: string,
    input: import("../shared/world-inspector-api").WorldInspectorModelInvocationQuery = {},
  ) {
    const stored = this.read(id);
    const snapshot = this.inspectorSources(id, stored);
    const inputKey = JSON.stringify(input);
    const cached = this.inspectorInvocationProjections.get(id);
    if (cached?.sourceKey === snapshot.key && cached.inputKey === inputKey) return cached.value;
    const value = queryWorldInspectorModelInvocations(
      snapshot.records,
      snapshot.events,
      input,
    );
    this.inspectorInvocationProjections.set(id, { inputKey, sourceKey: snapshot.key, value });
    return value;
  }

  inspectorModelInvocation(id: string, executionId: string, invocationId: string) {
    const stored = this.read(id);
    const snapshot = this.inspectorSources(id, stored);
    const record = this.options.ledger?.execution(executionId);
    if (!record || record.instanceId !== id) throw new WorldHostError("execution not found", 404);
    const detail = buildWorldInspectorModelInvocationDetail(
      executionId,
      invocationId,
      record,
      snapshot.events.filter((event) => event.correlation?.executionId === executionId),
    );
    if (!detail) throw new WorldHostError("model invocation not found", 404);
    return detail;
  }

  inspectorRuntimeEvent(id: string, eventId: string) {
    const stored = this.read(id);
    const snapshot = this.inspectorSources(id, stored);
    const detail = buildWorldInspectorRuntimeEventDetail(
      eventId,
      snapshot.events,
    );
    if (!detail) throw new WorldHostError("runtime event not found", 404);
    return detail;
  }

  debugQuery(input: DebugQuery = {}): DebugSearchResult {
    return debugLedger(this.options.ledger).debugQuery(input);
  }

  debugInspect(invocationId: string, includePayload = false): DebugInspection {
    const result = debugLedger(this.options.ledger).debugInspect(invocationId, includePayload);
    if (!result) throw new WorldHostError(`model invocation not found: ${invocationId}`, 404);
    return result;
  }

  debugArtifact(hash: string): DebugArtifact {
    const result = debugLedger(this.options.ledger).debugArtifact(hash);
    if (!result) throw new WorldHostError(`execution artifact not found: ${hash}`, 404);
    return result;
  }

  debugExplain(code: string) {
    return debugLedger(this.options.ledger).debugExplain(code);
  }

  debugDoctor(): DebugDoctorReport {
    return debugLedger(this.options.ledger).debugDoctor();
  }

  debugRebuildIndex(): DebugDoctorReport {
    const ledger = debugLedger(this.options.ledger);
    ledger.debugRebuildIndex();
    return ledger.debugDoctor();
  }

  subscribeInspectorEvents(id: string, listener: (event: ReturnType<typeof summarizeRuntimeEvent>) => void): () => void {
    this.read(id);
    return this.options.ledger?.subscribe((event) => {
      if (event.correlation?.instanceId === id) listener(summarizeRuntimeEvent(event));
    }) ?? (() => undefined);
  }

  subscribeInstanceChanges(id: string, listener: () => void): () => void {
    this.read(id);
    const listeners = this.instanceListeners.get(id) ?? new Set<() => void>();
    listeners.add(listener); this.instanceListeners.set(id, listeners);
    const unsubscribe = this.options.ledger?.subscribe((event) => { if (event.correlation?.instanceId === id) listener(); });
    return () => { unsubscribe?.(); listeners.delete(listener); if (!listeners.size) this.instanceListeners.delete(id); };
  }

  instance(id: string, principalId = "local"): PublicInstanceDetail {
    return this.project(this.read(id).document, principalId);
  }

  observer(id: string, agentId?: string): WorldObserverDetail {
    const document = this.read(id).document;
    if (activeParticipants(document).length > 0) {
      throw new WorldHostError("detach before opening the observer console", 409);
    }
    const agents = Object.keys(document.state.agents)
      .filter((candidate) => document.state.truth.entities[document.state.agents[candidate].entityId]?.lifecycle === "active")
      .sort((left, right) => {
        const leftName = document.state.truth.entities[document.state.agents[left].entityId].name;
        const rightName = document.state.truth.entities[document.state.agents[right].entityId].name;
        return leftName.localeCompare(rightName) || left.localeCompare(right);
      })
      .map((candidate) => observerAgent(document, candidate));
    const selectedId = agentId ?? agents[0]?.id;
    if (selectedId && !agents.some((agent) => agent.id === selectedId)) {
      throw new WorldHostError(`Agent not found: ${selectedId}`, 404);
    }
    return {
      summary: publicSummary(document),
      world: publicWorld(document),
      agents,
      ...(selectedId ? { selected: observerPerspective(document, selectedId) } : {}),
    };
  }

  controlOptions(id: string): ControlOptions {
    const document = this.read(id).document;
    return {
      agents: Object.keys(document.state.agents)
        .filter((agentId) => {
          const agent = document.state.agents[agentId];
          const entity = document.state.truth.entities[agent.entityId];
          const binding = document.policyBindings[agentId];
          return entity?.lifecycle === "active" && binding?.kind !== "external";
        })
        .map((agentId) => {
          const agent = document.state.agents[agentId];
          const entity = document.state.truth.entities[agent.entityId];
          const placementId = document.state.truth.placements[agent.entityId];
          return {
            id: agentId,
            name: entity.name,
            location: placementId ? document.state.truth.entities[placementId]?.name ?? null : null,
          };
        })
        .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    };
  }

  renameInstance(id: string, title: string): PublicInstanceDetail {
    const normalized = title.trim();
    if (!normalized || normalized.length > 80) throw new WorldHostError("title must contain 1–80 characters", 400);
    const stored = this.read(id);
    const document = structuredClone(stored.document);
    document.title = normalized;
    document.updatedAt = this.now().toISOString();
    return this.project(this.persist(stored, document).document);
  }

  deleteInstance(id: string): void {
    const stored = this.read(id);
    this.cancelTimer(id);
    this.options.store.deleteInstance(id, stored.generation, { instanceId: id });
    this.inspectorLedgerSnapshots.delete(id);
    this.inspectorWindowProjections.delete(id);
    this.inspectorInvocationProjections.delete(id);
  }

  private project(document: WorldInstanceDocument, principalId = "local"): PublicInstanceDetail {
    const definition = this.definition(document);
    const observedBy = new Map<string, Set<string>>();
    for (const step of document.state.history) {
      for (const observation of step.observations) {
        for (const eventId of observation.sourceEventIds) {
          const observers = observedBy.get(eventId) ?? new Set<string>();
          observers.add(observation.observerId);
          observedBy.set(eventId, observers);
        }
      }
    }
    const allAgents = Object.keys(document.state.agents).length;
    const active = activeParticipants(document);
    const controlled = active.find((participant) => participant.principalId === principalId);
    const visibleReactionAgentId = document.actionWindow?.kind === "reaction" && controlled &&
      document.actionWindow.requests[controlled.agentId]
      ? controlled.agentId
      : null;
    const run = currentRun(document);
    const activity = controlled ? Object.values(document.state.truth.activities)
      .filter((candidate) => candidate.actorId === controlled.agentId)
      .sort((left, right) => right.updatedAtSeconds - left.updatedAtSeconds || right.id.localeCompare(left.id))[0] : undefined;
    return {
      summary: publicSummary(document),
      world: publicWorld(document),
      publicEvents: document.state.truth.events
        .filter((event) => allAgents > 0 && (observedBy.get(event.id)?.size ?? 0) === allAgents)
        .map(({ id, step, description, impact }) => ({ id, step, description, impact })),
      participants: active.map(({ id, displayName, agentId, status, joinedAt }) => ({
        id, displayName, agentId, status, joinedAt,
      })),
      actionWindow: document.actionWindow && document.actionWindow.status !== "committed" &&
        document.actionWindow.status !== "cancelled" ? {
          kind: document.actionWindow.kind,
          id: document.actionWindow.id,
          generation: document.actionWindow.generation,
          baseRevision: document.actionWindow.baseRevision,
          requiredAgentIds: document.actionWindow.kind === "reaction"
            ? visibleReactionAgentId ? [visibleReactionAgentId] : []
            : [...document.actionWindow.requiredAgentIds],
          submittedAgentIds: document.actionWindow.kind === "reaction"
            ? visibleReactionAgentId && document.actionWindow.submissions[visibleReactionAgentId]
              ? [visibleReactionAgentId]
              : []
            : Object.keys(document.actionWindow.submissions).sort(),
          deadlineAt: document.actionWindow.deadlineAt,
          status: document.actionWindow.status,
          ...(document.actionWindow.kind === "reaction" && visibleReactionAgentId ? {
              reaction: {
                requestId: document.actionWindow.requests[visibleReactionAgentId].id,
                preparedStepId: document.actionWindow.preparedStepId,
                stimulus: document.actionWindow.requests[visibleReactionAgentId].stimulus.summary,
              },
            } : {}),
        } : null,
      origins: (definition.participation?.origins ?? []).map((origin) => ({
        id: origin.id,
        title: origin.title,
        fantasy: origin.fantasy,
        description: origin.description,
        location: document.state.truth.entities[origin.spawnEntityId].name,
        relationshipHooks: [...origin.relationshipHooks],
        risks: [...origin.risks],
        ...(origin.image ? { image: structuredClone(origin.image) } : {}),
      })),
      ...(run ? {
        run: {
          id: run.id,
          generation: run.generation,
          updatedAt: run.updatedAt,
          status: run.status,
          committedRevisions: [...run.committedRevisions],
          stopReason: run.stopReason,
          lease: run.lease ? {
            commitCount: run.lease.commitCount,
            maxCommits: run.lease.maxCommits,
            maxWallTimeMs: run.lease.maxWallTimeMs,
            startedAt: run.lease.startedAt,
            suspendedDurationMs: run.lease.suspendedDurationMs ?? 0,
          } : null,
          activity: activity ? publicActivity(document, activity) : null,
          debug: {
            mode: run.debugMode,
            boundaryIndex: run.debugCheckpoint?.boundaryIndex ?? run.committedRevisions.length,
            stageIndex: run.debugCheckpoint?.stageIndex ?? 0,
            stageCount: 10,
            stageKey: run.debugCheckpoint?.stageKey ?? null,
            stageLabel: run.debugCheckpoint ? executionStage(run.debugCheckpoint.stageKey).label : null,
            checkpointId: run.debugCheckpoint?.id ?? null,
            canAdvance: run.status === "debug-paused",
          },
        },
      } : {}),
      ...(controlled ? {
        controlledView: agentPerspective(document, controlled.agentId),
        conversation: conversationFor(document, controlled),
      } : {}),
      ...(run?.servicePause ? { servicePause: structuredClone(run.servicePause) } : {}),
    };
  }

  async advance(id: string, input: AdvanceWorldInput): Promise<PublicInstanceDetail> {
    const started = await this.serialized(id, async () => {
      const stored = this.read(id);
      if (input.expectedRevision !== stored.document.state.revision) {
        throw new WorldHostError("world revision changed; refresh before advancing", 409);
      }
      const document = structuredClone(stored.document);
      const existing = currentRun(document);
      if (existing && [
        "queued",
        "running",
        "pausing",
        "paused",
        "debug-paused",
        "budget-paused",
        "awaiting-decision",
        "awaiting-reaction",
      ].includes(existing.status)) {
        throw new WorldHostError("another world run is already in progress", 409);
      }
      const requiredAgentIds = externalDecisionAgentIds(document);
      const run = this.createRun(document, input.trigger, input.trigger === "batch"
        ? Math.max(1, Math.min(100, input.steps ?? 1))
        : 1, requiredAgentIds.length > 0 ? "awaiting-decision" : "queued");
      if (requiredAgentIds.length > 0) document.actionWindow = this.openWindow(document, requiredAgentIds);
      document.updatedAt = run.updatedAt;
      return this.persist(stored, document).document;
    });
    const run = currentRun(started)!;
    if (run.status === "queued") {
      if (run.debugMode === "step") {
        void this.driveRun(id, run.id).catch(() => undefined);
      } else {
        await this.driveRun(id, run.id);
      }
    }
    const document = this.read(id).document;
    if (document.actionWindow) this.scheduleWindowDeadline(document);
    if (document.scheduler.mode === "realtime") this.scheduleRealtime(document);
    return this.project(document);
  }

  async setDebugMode(
    instanceId: string,
    input: DebugModeInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    if (input.enabled && !this.options.ledger) {
      throw new WorldHostError("single-step debugging requires an execution ledger", 503);
    }
    const document = await this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      if (input.expectedRevision !== stored.document.state.revision) {
        throw new WorldHostError("world revision changed", 409);
      }
      const next = structuredClone(stored.document);
      next.runtime.debugSteppingEnabled = input.enabled;
      next.updatedAt = this.now().toISOString();
      return this.persist(stored, next).document;
    });
    return this.project(document, principalId);
  }

  async advanceDebugStep(
    instanceId: string,
    input: DebugNextInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    let duplicateRequest = false;
    let invalidCheckpoint: string | null = null;
    const liveGate = this.debugStageGates.get(input.runId);
    const document = await this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const run = stored.document.runs[input.runId];
      if (!run || run.generation !== input.generation) {
        throw new WorldHostError("debug checkpoint changed; refresh before advancing", 409);
      }
      if (run.lastDebugRequestId === input.requestId) {
        duplicateRequest = true;
        return stored.document;
      }
      if (run.status !== "debug-paused" || run.debugCheckpoint?.id !== input.checkpointId) {
        throw new WorldHostError("debug checkpoint changed; refresh before advancing", 409);
      }
      const next = structuredClone(stored.document);
      const nextRun = next.runs[input.runId]!;
      invalidCheckpoint = this.debugCheckpointValidationError(stored.document, run);
      if (!invalidCheckpoint && !liveGate) {
        invalidCheckpoint = debugCheckpointReplayValidationError(
          this.options.ledger!.executionEvents(run.debugCheckpoint!.executionId),
          run.debugCheckpoint!.stageIndex - 1,
        );
      }
      if (invalidCheckpoint) {
        nextRun.generation += 1;
        nextRun.status = "preparation-invalidated";
        nextRun.stopReason = "debug-checkpoint-invalid";
        nextRun.lease = null;
        nextRun.error = invalidCheckpoint;
        next.actionWindow = null;
        nextRun.updatedAt = this.now().toISOString();
        next.updatedAt = nextRun.updatedAt;
        return this.persist(stored, next).document;
      }
      const transitionAt = this.now();
      if (!liveGate) {
        nextRun.status = "queued";
        nextRun.lease = null;
      } else {
        const pausedAt = Date.parse(run.debugCheckpoint.updatedAt);
        if (nextRun.lease && Number.isFinite(pausedAt)) {
          nextRun.lease.suspendedDurationMs = (nextRun.lease.suspendedDurationMs ?? 0) +
            Math.max(0, transitionAt.getTime() - pausedAt);
        }
        nextRun.status = "running";
      }
      nextRun.stopReason = null;
      nextRun.lastDebugRequestId = input.requestId;
      nextRun.updatedAt = transitionAt.toISOString();
      next.updatedAt = nextRun.updatedAt;
      return this.persist(stored, next).document;
    });
    if (duplicateRequest) return this.project(document, principalId);
    if (invalidCheckpoint) {
      this.runControllers.get(input.runId)?.abort("debug-checkpoint-invalid");
      this.debugStageGates.get(input.runId)?.cancel();
      this.debugStageGates.delete(input.runId);
      throw new WorldHostError(invalidCheckpoint, 409);
    }
    if (!liveGate) {
      const checkpoint = document.runs[input.runId]?.debugCheckpoint;
      if (!checkpoint) throw new WorldHostError("debug checkpoint is no longer active", 409);
      const recovery = {
        executionId: checkpoint.executionId,
        completedStageIndex: checkpoint.stageIndex - 1,
      };
      this.debugRecoveries.set(input.runId, recovery);
      const interrupted = new Error("debug checkpoint continuation moved to a recovered execution");
      interrupted.name = "AbortError";
      this.failExecution(recovery.executionId, interrupted);
      this.scheduleRun(instanceId, input.runId);
      return this.project(document, principalId);
    }
    liveGate.release();
    return this.project(document, principalId);
  }

  private openWindow(document: WorldInstanceDocument, requiredAgentIds: string[]): ActionWindow {
    const deadlineAt = !currentRun(document)?.servicePause && document.runtime.actionWindowMs > 0
      ? new Date(this.now().getTime() + document.runtime.actionWindowMs).toISOString()
      : null;
    return {
      kind: "decision",
      id: this.idFactory(),
      generation: 1,
      baseRevision: document.state.revision,
      requiredAgentIds,
      submissions: {},
      deadlineAt,
      status: "open",
    };
  }

  private createRun(
    document: WorldInstanceDocument,
    trigger: WorldRunRecord["trigger"],
    requestedBoundaryCount: number | null,
    status: WorldRunRecord["status"],
  ): WorldRunRecord {
    const now = this.now().toISOString();
    const run: WorldRunRecord = {
      id: this.idFactory(),
      generation: 1,
      trigger,
      status,
      rootIntents: [],
      activityIds: [],
      requestedBoundaryCount,
      createdAt: now,
      startedAtWorldSeconds: document.state.truth.elapsedSeconds,
      updatedAt: now,
      executionIds: [],
      committedRevisions: [],
      stopReason: status === "awaiting-decision" ? "external-decision-required" : null,
      lease: null,
      debugMode: document.runtime.debugSteppingEnabled ? "step" : "off",
      debugCheckpoint: null,
      lastDebugRequestId: null,
    };
    document.runs[run.id] = run;
    return run;
  }

  private scheduleRun(instanceId: string, runId: string): void {
    const existing = this.runTimers.get(runId);
    if (existing) this.clearTimer(existing);
    const timer = this.setTimer!(async () => {
      this.runTimers.delete(runId);
      await this.driveRun(instanceId, runId).catch(() => undefined);
    }, 0);
    this.runTimers.set(runId, timer);
  }

  private async driveRun(instanceId: string, runId: string): Promise<void> {
    while (true) {
      const prepared = await this.serialized(instanceId, async () => {
        const stored = this.read(instanceId);
        const document = structuredClone(stored.document);
        const run = document.runs[runId];
        if (!run || run.status !== "queued") return null;
        if (!run.lease) {
          run.lease = {
            id: this.idFactory(),
            generation: run.generation,
            startedAt: this.now().toISOString(),
            maxCommits: this.runLeaseMaxCommits,
            maxWallTimeMs: this.runLeaseMaxWallTimeMs,
            commitCount: 0,
            suspendedDurationMs: 0,
          };
        }
        run.status = "running";
        run.stopReason = null;
        run.updatedAt = this.now().toISOString();
        if (document.actionWindow?.status === "open") document.actionWindow.status = "resolving";
        document.updatedAt = run.updatedAt;
        return this.persist(stored, document);
      });
      if (!prepared) return;
      const committed = await this.executeRunBoundary(prepared, runId);
      const run = committed.document.runs[runId];
      if (!run || run.status !== "queued") {
        if (committed.document.actionWindow) this.scheduleWindowDeadline(committed.document);
        if (committed.document.scheduler.mode === "realtime") this.scheduleRealtime(committed.document);
        return;
      }
    }
  }

  private async executeRunBoundary(
    stored: StoredWorldInstance,
    runId: string,
  ): Promise<StoredWorldInstance> {
    const document = structuredClone(stored.document);
    const runRecord = document.runs[runId];
    if (!runRecord || runRecord.status !== "running" || !runRecord.lease) {
      throw new WorldHostError("world run is not executable", 409);
    }
    const runGeneration = runRecord.generation;
    const window = document.actionWindow;
    const effectiveRoster = structuredClone(
      window?.kind === "reaction" ? window.policyRoster : document.policyBindings,
    );
    const externalActions: ExternalActionInput[] = [];
    const externalReactions: ExternalReactionInput[] = [];
    let timeoutNoops = 0;
    if (window?.kind === "decision") {
      window.status = "resolving";
      for (const agentId of window.requiredAgentIds) {
        const submission = window.submissions[agentId];
        if (submission) externalActions.push(structuredClone(submission));
        else {
          effectiveRoster[agentId] = { kind: "idle", agentId, reason: "timeout" };
          timeoutNoops += 1;
        }
      }
    } else if (window?.kind === "reaction") {
      window.status = "resolving";
      externalReactions.push(...window.requiredAgentIds.flatMap((agentId) => {
        const submission = window.submissions[agentId];
        if (submission) return [structuredClone(submission)];
        timeoutNoops += 1;
        return [];
      }));
    }
    const recovery = this.debugRecoveries.get(runId);
    this.debugRecoveries.delete(runId);
    const executionProvider = recovery && this.options.ledger
      ? new DebugCheckpointModelProvider(
          this.options.provider,
          this.options.ledger.executionEvents(recovery.executionId),
          recovery.completedStageIndex,
        )
      : this.options.provider;
    const services = this.algorithmServices(document.executionAlgorithm);
    const algorithm = this.registry.create(document.executionAlgorithm, {
      ...services,
      provider: executionProvider,
    });
    const execution = this.beginExecution(
      document,
      "interactive",
      runRecord.trigger,
      algorithm.manifest,
      effectiveRoster,
      window?.kind === "reaction" ? window.preparationExecutionId : undefined,
    );
    if (execution) runRecord.executionIds.push(execution.id);
    const definition = this.definition(document);
    const engine = new SimulationEngine(
      definition,
      algorithm,
      document.state,
    );
    const request: WorldAdvanceRequest = {
      expectedRevision: document.state.revision,
      trigger: runRecord.trigger,
      ...(!runRecord.rootIntents.length && ["participant_action", "realtime"].includes(runRecord.trigger)
        ? { autonomousUntilSeconds: runRecord.startedAtWorldSeconds + document.runtime.maxAutonomousSpanSeconds } : {}),
      externalActions: window?.kind === "reaction"
        ? structuredClone(window.advanceRequest.externalActions)
        : window?.kind === "decision"
          ? externalActions
          : runRecord.committedRevisions.length === 0
            ? structuredClone(runRecord.rootIntents)
          : [],
    };
    const controller = new AbortController();
    this.runControllers.set(runId, controller);
    const debugGate = runRecord.debugMode === "step"
      ? new DebugStageGate(
          async (stage) => {
            execution?.trace.emit({
              event: "stage.paused",
              correlation: {
                executionId: execution?.id,
                instanceId: document.id,
                revision: request.expectedRevision,
                step: document.state.step + 1,
                logicalStageIndex: stage.index,
                logicalStageKey: stage.key,
              },
              attributes: {
                stageIndex: stage.index,
                stageKey: stage.key,
                label: stage.label,
                parallelGroupId: `${execution?.id}:stage:${stage.index}`,
              },
            });
            execution?.trace.flush();
            await this.persistDebugCheckpoint(document.id, runId, execution?.id, stage);
          },
          recovery?.completedStageIndex,
        )
      : undefined;
    if (debugGate) this.debugStageGates.set(runId, debugGate);
    const modelScope = {
      workloadId: document.id,
      batchId: window?.kind === "reaction"
        ? `complete:${window.preparedStepId}`
        : `prepare:${document.state.revision + 1}`,
      correlation: {
        executionId: execution?.id,
        instanceId: document.id,
        revision: document.state.revision,
        step: document.state.step + 1,
      },
      observer: execution?.trace ?? this.runtimeObserver,
      abortSignal: controller.signal,
      ...(debugGate ? { stageHooks: debugGate } : {}),
    };
    let atomicStageEntered = false;
    try {
      execution?.trace.emit({
        event: "action_window.resolved",
        attributes: { trigger: request.trigger },
        counts: {
          requiredExternalAgents: window?.requiredAgentIds.length ?? 0,
          submittedExternalActions: externalActions.length,
          timeoutNoops,
        },
        measurements: {
          actionWindowWaitMs: window?.deadlineAt
            ? Math.max(0, document.runtime.actionWindowMs - (Date.parse(window.deadlineAt) - this.now().getTime()))
            : 0,
        },
      });
      let preparation: WorldStepPreparation;
      if (window?.kind === "reaction") {
        const artifact = this.options.ledger?.artifact(window.preparationArtifactHash);
        const value = artifact?.value as WorldStepPreparation | undefined;
        const valid = artifact?.executionId === window.preparationExecutionId && value &&
          value.schemaVersion === WORLD_STEP_PREPARATION_SCHEMA_VERSION &&
          value.id === window.preparedStepId && value.sourceStateHash === window.sourceStateHash &&
          value.algorithmManifestHash === window.algorithmManifestHash &&
          value.policyRosterHash === window.policyRosterHash &&
          value.sourceStateHash === contentHash(document.state) &&
          value.algorithmManifestHash === algorithm.manifest.hash &&
          value.policyRosterHash === contentHash(effectiveRoster) &&
          value.requestHash === contentHash(request);
        if (!valid) {
          throw new StepPreparationInvalidatedError(
            "persisted step preparation no longer matches the canonical run",
          );
        }
        preparation = structuredClone(value);
      } else {
        preparation = await engine.prepareStep(effectiveRoster, request, modelScope);
        if (preparation.pendingReactionRequests.length > 0) {
          if (!execution || !this.options.ledger || !isAtomicStore(this.options.store)) {
            throw new Error("external reaction preparation requires an atomic Execution Ledger");
          }
          const artifactHash = this.options.ledger.putExecutionArtifact(
            execution.id,
            "world-step-preparation",
            preparation,
          );
          const requiredAgentIds = preparation.pendingReactionRequests.map((entry) => entry.agentId).sort();
          const deadlineAt = document.runtime.actionWindowMs > 0
            ? new Date(this.now().getTime() + document.runtime.actionWindowMs).toISOString()
            : null;
          document.actionWindow = {
            kind: "reaction",
            id: this.idFactory(),
            generation: 1,
            baseRevision: document.state.revision,
            requiredAgentIds,
            submissions: {},
            deadlineAt,
            status: "open",
            preparedStepId: preparation.id,
            preparationArtifactHash: artifactHash,
            preparationExecutionId: execution.id,
            sourceStateHash: preparation.sourceStateHash,
            algorithmManifestHash: preparation.algorithmManifestHash,
            policyRosterHash: preparation.policyRosterHash,
            policyRoster: structuredClone(effectiveRoster),
            advanceRequest: structuredClone(request),
            requests: Object.fromEntries(preparation.pendingReactionRequests.map((entry) => [
              entry.agentId,
              structuredClone(entry),
            ])),
          };
          runRecord.status = "awaiting-reaction";
          runRecord.stopReason = "external-reaction-required";
          runRecord.updatedAt = this.now().toISOString();
          document.updatedAt = runRecord.updatedAt;
          this.runControllers.delete(runId);
          this.debugStageGates.delete(runId);
          const finish: FinishExecutionInput = {
            status: "succeeded",
            stateHash: contentHash(document.state),
          };
          const latest = this.read(document.id);
          const latestRun = latest.document.runs[runId];
          if (!latestRun || latestRun.generation !== runGeneration || latestRun.status !== "running" ||
            latest.document.state.revision !== request.expectedRevision) {
            const cancelled = new Error("world run generation changed before preparation persisted");
            cancelled.name = "AbortError";
            this.failExecution(execution.id, cancelled);
            return latest;
          }
          return this.options.store.compareAndSwapInstanceAndFinishExecution(
            document.id,
            latest.generation,
            document,
            execution.id,
            finish,
            "instance",
          ).instance;
        }
      }
      const result = await engine.completePreparedStep(
        effectiveRoster,
        request,
        preparation,
        externalReactions,
        modelScope,
      );
      this.runControllers.delete(runId);
      document.state = result.state;
      for (const agent of Object.values(document.state.agents)) {
        if (!document.policyBindings[agent.id]) {
          document.policyBindings[agent.id] = {
            kind: "model",
            agentId: agent.id,
            profiles: structuredClone(agent.modelProfiles),
          };
        }
      }
      for (const agentId of Object.keys(document.policyBindings)) {
        if (!document.state.agents[agentId]) delete document.policyBindings[agentId];
      }
      for (const binding of Object.values(document.policyBindings)) {
        if (binding.kind === "model") delete binding.resumeFromRevision;
      }
      runRecord.committedRevisions.push(document.state.revision);
      runRecord.activityIds = [...new Set([
        ...runRecord.activityIds,
        ...result.committed.temporalPlans.flatMap((plan) => Object.values(document.state.truth.activities)
          .filter((activity) => activity.status !== "queued" && activity.status !== "ready" &&
            activity.plan.id === plan.id)
          .map((activity) => activity.id)),
        ...result.committed.sharedResourceAdmissions.map((admission) => admission.activityId),
      ])].sort();
      runRecord.lease.commitCount += 1;
      runRecord.updatedAt = this.now().toISOString();
      document.actionWindow = null;
      if (document.scheduler.mode === "realtime") {
        document.scheduler.nextTickAt = new Date(
          this.now().getTime() + document.runtime.realtimeIntervalMs,
        ).toISOString();
      }
      const requestedComplete = runRecord.requestedBoundaryCount !== null &&
        runRecord.committedRevisions.filter(revision => document.state.history.some(step => step.revision === revision &&
          step.temporalBoundary.deltaSeconds > 0)).length >= runRecord.requestedBoundaryCount;
      const directControl = document.state.executionState?.data.kind === "direct-world" ? document.state.executionState.data as unknown as DirectRuntimeState : null;
      const directRootFailures = runRecord.rootIntents.flatMap(intent => {
        const task = directControl?.intents[intent.agentId];
        return task?.status === "failed" && task.failure ? [task.failure] : [];
      });
      const servicePause = Object.values(directControl?.intents ?? {}).find(intent =>
        intent.failure?.atRevision === document.state.revision - 1 && intent.failure.servicePause)?.failure?.servicePause;
      const directRootComplete = directControl && runRecord.rootIntents.length > 0 && runRecord.rootIntents.every(intent =>
        directControl.completedSubmissionIds.includes(intent.submissionId)) &&
        ![...participantReactionIds(document.state, directControl, runRecord.rootIntents.map(intent => intent.agentId),
          runRecord.rootIntents.map(intent => intent.submissionId))].some(id => document.policyBindings[id]?.kind === "model");
      const rootComplete = directRootComplete || runRecord.activityIds.length > 0 && runRecord.activityIds.every((activityId) => {
        const status = document.state.truth.activities[activityId]?.status;
        return status !== "active" && status !== "paused" && status !== "queued" && status !== "ready";
      });
      const requiredAgentIds = externalDecisionAgentIds(document);
      const budgetReached = runRecord.lease.commitCount >= runRecord.lease.maxCommits ||
        this.now().getTime() - Date.parse(runRecord.lease.startedAt) -
          (runRecord.lease.suspendedDurationMs ?? 0) >= runRecord.lease.maxWallTimeMs;
      if (servicePause) {
        runRecord.status = "failed"; runRecord.stopReason = "model-service-paused";
        runRecord.servicePause = structuredClone(servicePause); runRecord.error = servicePause.message;
        document.scheduler = { mode: "paused", generation: document.scheduler.generation + 1, nextTickAt: null };
        if (requiredAgentIds.length) document.actionWindow = this.openWindow(document, requiredAgentIds);
        if (document.actionWindow) document.actionWindow.deadlineAt = null;
      } else if (directRootFailures.length) {
        runRecord.status = "failed"; runRecord.stopReason = "local-model-task-failed";
        runRecord.error = directRootFailures.map(failure => failure.message).join("; ");
        if (requiredAgentIds.length) document.actionWindow = this.openWindow(document, requiredAgentIds);
      } else if (requestedComplete) {
        runRecord.status = "completed";
        runRecord.stopReason = "requested-boundaries-completed";
      } else if (rootComplete && runRecord.trigger === "participant_action") {
        runRecord.status = "completed";
        runRecord.stopReason = "root-activity-completed";
        if (requiredAgentIds.length > 0) {
          const decisionRun = this.createRun(document, "participant_action", null, "awaiting-decision");
          decisionRun.stopReason = "external-decision-required";
          document.actionWindow = this.openWindow(document, requiredAgentIds);
        }
      } else if (requiredAgentIds.length > 0) {
        runRecord.status = "awaiting-decision";
        runRecord.stopReason = "external-decision-required";
        document.actionWindow = this.openWindow(document, requiredAgentIds);
      } else if (budgetReached) {
        runRecord.status = "budget-paused";
        runRecord.stopReason = runRecord.lease.commitCount >= runRecord.lease.maxCommits
          ? "commit-budget-exhausted"
          : "wall-time-budget-exhausted";
      } else {
        runRecord.status = "queued";
        runRecord.stopReason = null;
      }
      document.updatedAt = runRecord.updatedAt;
      const finish: FinishExecutionInput = {
        status: "succeeded",
        semanticHash: result.committed.semanticHash,
        stateHash: contentHash(document.state),
        commitRevision: document.state.revision,
      };
      const commitStage = executionStage("atomic-commit");
      if (debugGate) {
        atomicStageEntered = true;
        execution?.trace.emit({
          event: "stage.started",
          correlation: {
            executionId: execution?.id,
            instanceId: document.id,
            revision: request.expectedRevision,
            step: document.state.step,
            logicalStageIndex: commitStage.index,
            logicalStageKey: commitStage.key,
          },
          attributes: {
            stageIndex: commitStage.index,
            stageKey: commitStage.key,
            label: commitStage.label,
            parallelGroupId: `${execution?.id}:stage:${commitStage.index}`,
          },
        });
        execution?.trace.flush();
        await debugGate.before(commitStage);
        execution?.trace.emit({
          event: "stage.completed",
          correlation: {
            executionId: execution?.id,
            instanceId: document.id,
            revision: request.expectedRevision,
            step: document.state.step,
            logicalStageIndex: commitStage.index,
            logicalStageKey: commitStage.key,
          },
          attributes: {
            stageIndex: commitStage.index,
            stageKey: commitStage.key,
            label: commitStage.label,
            parallelGroupId: `${execution?.id}:stage:${commitStage.index}`,
          },
        });
        await debugGate.after(commitStage);
      }
      execution?.trace.flush();
      const latest = this.read(document.id);
      const latestRun = latest.document.runs[runId];
      if (!latestRun || latestRun.generation !== runGeneration || latestRun.status !== "running" ||
        latest.document.state.revision !== request.expectedRevision) {
        const cancelled = new Error("world run generation changed before commit");
        cancelled.name = "AbortError";
        this.failExecution(execution?.id, cancelled);
        this.debugStageGates.delete(runId);
        return latest;
      }
      // Checkpoint controls are persisted while this boundary is parked. Carry
      // those CAS-owned fields into the final document instead of overwriting
      // them with the boundary's original in-memory run snapshot.
      runRecord.debugCheckpoint = structuredClone(latestRun.debugCheckpoint);
      runRecord.lastDebugRequestId = latestRun.lastDebugRequestId;
      document.narratives = structuredClone(latest.document.narratives);
      enqueueNarrative(document, this.now().toISOString());
      const committed = execution && this.options.ledger && isAtomicStore(this.options.store)
        ? this.options.store.compareAndSwapInstanceAndFinishExecution(
            document.id,
            latest.generation,
            document,
            execution.id,
            finish,
          ).instance
        : this.persist(latest, document);
      if (execution && this.options.ledger && !isAtomicStore(this.options.store)) {
        this.options.ledger.finishExecution(execution.id, finish);
      }
      this.debugStageGates.delete(runId);
      this.notifyInstance(document.id); this.scheduleNarrative(committed.document);
      return committed;
    } catch (error) {
      this.runControllers.delete(runId);
      this.debugStageGates.delete(runId);
      if (error instanceof WorldQuiescentError) {
        const latest = this.read(document.id), waiting = structuredClone(latest.document);
        const waitingRun = waiting.runs[runId];
        if (!waitingRun || waitingRun.generation !== runGeneration || waiting.state.revision !== request.expectedRevision) return latest;
        waitingRun.status = "paused"; waitingRun.stopReason = "waiting-for-event"; delete waitingRun.error;
        waitingRun.updatedAt = this.now().toISOString(); waiting.updatedAt = waitingRun.updatedAt; waiting.actionWindow = null;
        waiting.scheduler = { mode: "paused", generation: waiting.scheduler.generation + 1, nextTickAt: null };
        execution?.trace.emit({ event: "step.waiting", attributes: { reason: "no-new-event-or-evidence" },
          hashes: { state: contentHash(waiting.state) } });
        execution?.trace.flush();
        const finish: FinishExecutionInput = { status: "succeeded", stateHash: contentHash(waiting.state) };
        if (execution && this.options.ledger && isAtomicStore(this.options.store)) return this.options.store.compareAndSwapInstanceAndFinishExecution(
          document.id, latest.generation, waiting, execution.id, finish, "instance").instance;
        if (execution) this.options.ledger?.finishExecution(execution.id, finish);
        return this.persist(latest, waiting);
      }
      if (atomicStageEntered && !(error instanceof Error && error.name === "AbortError")) {
        const stage = executionStage("atomic-commit");
        execution?.trace.emit({
          event: "stage.failed",
          level: "error",
          correlation: {
            executionId: execution?.id,
            instanceId: document.id,
            revision: request.expectedRevision,
            step: document.state.step,
            logicalStageIndex: stage.index,
            logicalStageKey: stage.key,
          },
          attributes: {
            stageIndex: stage.index,
            stageKey: stage.key,
            label: stage.label,
            parallelGroupId: `${execution?.id}:stage:${stage.index}`,
          },
          error: serializeRuntimeError(error),
        });
        execution?.trace.flush();
      }
      this.failExecution(execution?.id, error);
      const latest = this.read(document.id);
      const failed = structuredClone(latest.document);
      const failedRun = failed.runs[runId];
      if (!failedRun || failedRun.generation !== runGeneration) return latest;
      const invalidated = error instanceof StepPreparationInvalidatedError;
      failedRun.status = invalidated
        ? "preparation-invalidated"
        : error instanceof Error && error.name === "AbortError" ? "paused" : "failed";
      failedRun.stopReason = invalidated
        ? "step-preparation-invalidated"
        : error instanceof Error && error.name === "AbortError" ? "user-paused" : "execution-failed";
      const failureMessage = error instanceof Error ? error.message : String(error);
      failedRun.error = failureMessage.trim() ? failureMessage
        : error instanceof Error && error.name.trim() ? error.name : "World execution failed";
      const servicePause = modelServicePause(error);
      failedRun.updatedAt = this.now().toISOString();
      failed.actionWindow = null;
      failed.updatedAt = failedRun.updatedAt;
      if (failed.scheduler.mode === "realtime") {
        failed.scheduler.nextTickAt = new Date(
          this.now().getTime() + failed.runtime.realtimeIntervalMs,
        ).toISOString();
      }
      if (servicePause) this.pauseModelService(failed, servicePause, failedRun.id);
      try {
        return this.persist(latest, failed);
      } catch {
        throw error;
      }
    }
  }

  async submitAction(
    instanceId: string,
    participantId: string,
    input: SubmitExternalActionInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    const accepted = await this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const document = structuredClone(stored.document);
      const participant = document.participants[participantId];
      if (!participant || participant.status !== "active" || participant.principalId !== principalId) {
        throw new WorldHostError("active participant not found", 404);
      }
      const submissionId = input.submissionId.trim();
      if (!submissionId || submissionId.length > 128) throw new WorldHostError("invalid action submission identity", 400);
      const text = input.text.trim();
      if (!text || text.length > 4_000) throw new WorldHostError("action must contain 1–4000 characters", 400);
      const existingIntent = document.participantIntents.find((intent) =>
        intent.participantId === participantId && intent.submissionId === submissionId);
      if (existingIntent) {
        if (existingIntent.text !== text || existingIntent.agentId !== participant.agentId) {
          throw new WorldHostError("submission identity was already used for a different action", 409);
        }
        return { document, runId: existingIntent.runId, complete: false };
      }
      if (input.expectedRevision !== document.state.revision) throw new WorldHostError("world revision changed", 409);

      const previousRun = currentRun(document);
      // A debug checkpoint may be invalidated after its action window has
      // already moved to `resolving`. That window belongs to the discarded
      // preparation and must not block the next participant action.
      if (previousRun?.status === "preparation-invalidated" && document.actionWindow?.status === "resolving") {
        document.actionWindow = null;
      }
      let requiredAgentIds = externalDecisionAgentIds(document, !["awaiting-decision", "completed"].includes(previousRun?.status ?? "completed"));
      if (previousRun && (previousRun.status === "paused" || previousRun.status === "budget-paused" ||
        previousRun.status === "debug-paused" || previousRun.status === "failed") &&
        document.policyBindings[participant.agentId]?.kind === "external") {
        // A terminal failure can leave the participant's Activity busy.
        // Accept a distinct intent without rewriting the failed run's evidence.
        if (previousRun.status !== "failed") {
          previousRun.status = "completed";
          previousRun.stopReason = "replaced-by-external-action";
          previousRun.updatedAt = this.now().toISOString();
        }
        document.actionWindow = null;
        requiredAgentIds = [participant.agentId];
        this.createRun(document, "participant_action", null, "awaiting-decision");
      }
      if (!requiredAgentIds.includes(participant.agentId)) {
        throw new WorldHostError("participant does not control an external policy", 409);
      }
      let run = currentRun(document);
      if (!run || run.status !== "awaiting-decision") {
        run = this.createRun(document, "participant_action", null, "awaiting-decision");
      }
      if (run.status !== "awaiting-decision") throw new WorldHostError("another world run is already in progress", 409);
      if (!document.actionWindow) document.actionWindow = this.openWindow(document, requiredAgentIds);
      const window = document.actionWindow;
      if (window.kind !== "decision" || window.status !== "open" || window.baseRevision !== input.expectedRevision) {
        throw new WorldHostError("the current action window is not accepting actions", 409);
      }
      const existing = window.submissions[participant.agentId];
      if (existing) throw new WorldHostError("this Agent already submitted an action", 409);
      window.submissions[participant.agentId] = {
        submissionId,
        agentId: participant.agentId,
        rawText: text,
        goal: text,
        means: null,
        targetIds: [],
        discourse: participantDiscourse(document, participant.id),
      };
      window.generation += 1;
      document.participantIntents.push({
        participantId,
        agentId: participant.agentId,
        runId: run.id,
        submissionId,
        revision: document.state.revision,
        text,
        submittedAt: this.now().toISOString(),
      });
      const complete = window.requiredAgentIds.every((agentId) => window.submissions[agentId]);
      if (complete) {
        run.rootIntents = window.requiredAgentIds.map((agentId) => structuredClone(window.submissions[agentId]!));
        run.status = "queued";
        run.stopReason = null;
        run.lease = null;
        run.generation += 1;
      }
      run.updatedAt = this.now().toISOString();
      document.updatedAt = run.updatedAt;
      const persisted = this.persist(stored, document).document;
      return { document: persisted, runId: run.id, complete };
    });
    if (accepted.complete) this.scheduleRun(instanceId, accepted.runId);
    else if (accepted.document.actionWindow) this.scheduleWindowDeadline(accepted.document);
    return this.project(accepted.document, principalId);
  }

  async submitReaction(
    instanceId: string,
    participantId: string,
    input: SubmitExternalReactionInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    const accepted = await this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const document = structuredClone(stored.document);
      const participant = document.participants[participantId];
      if (!participant || participant.status !== "active" || participant.principalId !== principalId) {
        throw new WorldHostError("active participant not found", 404);
      }
      const submissionId = input.submissionId.trim();
      if (!submissionId || submissionId.length > 128) {
        throw new WorldHostError("invalid reaction submission identity", 400);
      }
      const text = input.kind === "replace" ? input.text.trim() : null;
      if (input.kind === "replace" && (!text || text.length > 4_000)) {
        throw new WorldHostError("reaction must contain 1–4000 characters", 400);
      }
      const prior = document.reactionSubmissions.find((entry) => entry.submissionId === submissionId);
      if (prior) {
        if (prior.participantId !== participantId || prior.preparedStepId !== input.preparedStepId ||
          prior.kind !== input.kind || prior.text !== text) {
          throw new WorldHostError("submission identity was already used for another reaction", 409);
        }
        return { document, runId: prior.runId, complete: false };
      }
      const window = document.actionWindow;
      const run = currentRun(document);
      if (!window || window.kind !== "reaction" || !run || run.status !== "awaiting-reaction" ||
        window.status !== "open" || window.id !== input.windowId || window.generation !== input.generation ||
        window.preparedStepId !== input.preparedStepId || window.baseRevision !== input.expectedRevision ||
        document.state.revision !== input.expectedRevision) {
        throw new WorldHostError("the reaction window is stale or closed", 409);
      }
      const request = window.requests[participant.agentId];
      if (!request || !window.requiredAgentIds.includes(participant.agentId)) {
        throw new WorldHostError("participant has no private reaction request", 409);
      }
      if (window.submissions[participant.agentId]) {
        throw new WorldHostError("this Agent already submitted a reaction", 409);
      }
      window.submissions[participant.agentId] = input.kind === "keep" ? {
        submissionId,
        requestId: request.id,
        agentId: participant.agentId,
        kind: "keep",
      } : {
        submissionId,
        requestId: request.id,
        agentId: participant.agentId,
        kind: "replace",
        rawText: text!,
        goal: text!,
        means: null,
        targetIds: [],
      };
      document.reactionSubmissions.push({
        participantId,
        agentId: participant.agentId,
        runId: run.id,
        preparedStepId: window.preparedStepId,
        requestId: request.id,
        submissionId,
        kind: input.kind,
        text,
        submittedAt: this.now().toISOString(),
      });
      const complete = window.requiredAgentIds.every((agentId) => Boolean(window.submissions[agentId]));
      if (complete) {
        run.status = "queued";
        run.stopReason = null;
        run.lease = null;
        run.generation += 1;
      }
      run.updatedAt = this.now().toISOString();
      document.updatedAt = run.updatedAt;
      const persisted = this.persist(stored, document).document;
      return { document: persisted, runId: run.id, complete };
    });
    if (accepted.complete) this.scheduleRun(instanceId, accepted.runId);
    else if (accepted.document.actionWindow) this.scheduleWindowDeadline(accepted.document);
    return this.project(accepted.document, principalId);
  }

  async pauseRun(
    instanceId: string,
    input: WorldRunControlInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    const document = await this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const next = structuredClone(stored.document);
      const run = next.runs[input.runId];
      if (!run || run.generation !== input.generation) throw new WorldHostError("world run changed", 409);
      if (run.debugMode === "step") {
        throw new WorldHostError("single-step runs use next-step control and cannot be manually paused", 409);
      }
      if (!["queued", "running", "pausing", "debug-paused"].includes(run.status)) {
        if (run.status === "paused") return next;
        throw new WorldHostError("world run cannot be paused", 409);
      }
      run.generation += 1;
      run.status = "paused";
      run.stopReason = "user-paused";
      run.lease = null;
      run.updatedAt = this.now().toISOString();
      next.updatedAt = run.updatedAt;
      return this.persist(stored, next).document;
    });
    const timer = this.runTimers.get(input.runId);
    if (timer) this.clearTimer(timer);
    this.runTimers.delete(input.runId);
    this.runControllers.get(input.runId)?.abort("user-paused");
    this.debugStageGates.get(input.runId)?.cancel();
    this.debugStageGates.delete(input.runId);
    return this.project(document, principalId);
  }

  async resumeRun(
    instanceId: string,
    input: WorldRunControlInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    const document = await this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const next = structuredClone(stored.document);
      const run = next.runs[input.runId];
      if (!run || run.generation !== input.generation) throw new WorldHostError("world run changed", 409);
      if (run.debugMode === "step") {
        throw new WorldHostError("single-step runs cannot be resumed; use next-step or start a new run", 409);
      }
      if (run.status !== "paused" && run.status !== "budget-paused" &&
        run.status !== "preparation-invalidated") {
        throw new WorldHostError("world run cannot be resumed", 409);
      }
      run.generation += 1;
      run.status = "queued";
      run.stopReason = null;
      run.lease = null;
      delete run.error;
      run.updatedAt = this.now().toISOString();
      next.updatedAt = run.updatedAt;
      return this.persist(stored, next).document;
    });
    this.scheduleRun(instanceId, input.runId);
    return this.project(document, principalId);
  }

  async transferControl(
    instanceId: string,
    input: ControlTransferInput,
    principalId = "local",
  ): Promise<PublicInstanceDetail> {
    return this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const document = structuredClone(stored.document);
      if (input.expectedRevision !== document.state.revision) {
        throw new WorldHostError("world revision changed", 409);
      }
      const activeRun = currentRun(document);
      if (["queued", "running", "pausing", "debug-paused"].includes(activeRun?.status ?? "") ||
        (document.actionWindow && document.actionWindow.status !== "open")) {
        throw new WorldHostError("control can change only at a committed revision boundary", 409);
      }
      const current = activeParticipants(document)
        .find((participant) => participant.principalId === principalId);
      if (input.target.kind === "agent" && current?.agentId === input.target.agentId) {
        return this.project(document, principalId);
      }
      const reconcileActionWindow = (): string | null => {
        const window = document.actionWindow;
        if (!window) return null;
        if (window.kind === "reaction") {
          document.actionWindow = null;
          if (activeRun?.status === "awaiting-reaction") {
            activeRun.status = "preparation-invalidated";
            activeRun.stopReason = "control-transferred-during-reaction";
            activeRun.updatedAt = this.now().toISOString();
          }
          return null;
        }
        const requiredAgentIds = externalDecisionAgentIds(document, false);
        if (requiredAgentIds.length === 0) {
          document.actionWindow = null;
          if (activeRun?.status === "awaiting-decision") {
            activeRun.status = "completed";
            activeRun.stopReason = "control-transferred";
            activeRun.updatedAt = this.now().toISOString();
          }
          return null;
        }
        window.requiredAgentIds = requiredAgentIds;
        window.submissions = Object.fromEntries(Object.entries(window.submissions)
          .filter(([agentId]) => requiredAgentIds.includes(agentId)));
        window.generation += 1;
        const complete = requiredAgentIds.every((agentId) => window.submissions[agentId]);
        if (!complete || activeRun?.status !== "awaiting-decision") return null;
        window.status = "resolving";
        activeRun.rootIntents = requiredAgentIds.map((agentId) => structuredClone(window.submissions[agentId]!));
        activeRun.status = "queued";
        activeRun.stopReason = null;
        activeRun.lease = null;
        activeRun.generation += 1;
        activeRun.updatedAt = this.now().toISOString();
        return activeRun.id;
      };
      if (current) {
        current.status = "released";
        current.updatedAt = this.now().toISOString();
        const releasedAgent = document.state.agents[current.agentId];
        document.policyBindings[current.agentId] = {
          kind: "model",
          agentId: releasedAgent.id,
          profiles: structuredClone(releasedAgent.modelProfiles),
          resumeFromRevision: current.controlledSinceRevision,
        };
      }
      if (input.target.kind === "observer") {
        const runToSchedule = reconcileActionWindow();
        document.updatedAt = this.now().toISOString();
        const persisted = this.persist(stored, document).document;
        if (runToSchedule) this.scheduleRun(instanceId, runToSchedule);
        return this.project(persisted, principalId);
      }
      const agentId = input.target.agentId;
      const agent = document.state.agents[agentId];
      const entity = agent ? document.state.truth.entities[agent.entityId] : undefined;
      if (!agent || !entity || entity.lifecycle !== "active") {
        throw new WorldHostError("only a living Agent can be controlled", 409);
      }
      const binding = document.policyBindings[agentId];
      if (binding.kind === "external") throw new WorldHostError("Agent is already controlled", 409);
      if (activeParticipants(document).length - (current ? 1 : 0) >= this.maxActiveParticipants) {
        throw new WorldHostError("this instance has reached its active participant limit", 409);
      }
      const participantId = this.idFactory();
      const joinedAt = this.now().toISOString();
      const fallbackText = `你把注意力放回 ${entity.name} 的此刻。`;
      const fallback: ParticipantArrivalRecord = {
        id: this.idFactory(),
        revision: document.state.revision,
        step: document.state.step,
        title: `此刻，你是${entity.name}`,
        scene: fallbackText,
        knownEntities: Object.values(agent.belief.localEntities).map(entity => ({ localEntityId: entity.id, name: entity.name, description: entity.description })),
        possibleNextActions: ["观察四周", "回想刚才发生的事", "确认自己接下来要做什么"],
        generated: false,
        createdAt: joinedAt,
      };
      document.participants[participantId] = {
        id: participantId,
        principalId,
        displayName: entity.name,
        agentId,
        status: "active",
        joinedAt,
        updatedAt: joinedAt,
        controlledSinceRevision: document.state.revision,
        ...(agent.nextAction ? { suppressedActionId: agent.nextAction.id } : {}),
        arrival: fallback,
      };
      document.policyBindings[agentId] = { kind: "external", agentId, participantId };
      const runToSchedule = reconcileActionWindow();
      document.scheduler.mode = "paused";
      document.scheduler.generation += 1;
      document.scheduler.nextTickAt = null;
      this.cancelTimer(instanceId);
      const arrival = document.state.executionState?.data.kind === "direct-world" ? fallback : await this.generateArrival(document, participantId, fallbackText);
      document.participants[participantId].arrival = {
        ...fallback,
        title: arrival.title,
        scene: arrival.scene,
          possibleNextActions: [...arrival.possibleNextActions],
        generated: arrival.generated,
      };
      document.updatedAt = this.now().toISOString();
      const persisted = this.persist(stored, document).document;
      if (runToSchedule) this.scheduleRun(instanceId, runToSchedule);
      return this.project(persisted, principalId);
    });
  }

  private async generateArrival(
    document: WorldInstanceDocument,
    participantId: string,
    fallback: string,
  ): Promise<ArrivalView> {
    const participant = document.participants[participantId];
    const creationProfile = document.state.agents[participant.agentId]!.modelProfiles.creation;
    const execution = this.beginExecution(document, "interactive", "arrival", ARRIVAL_PRODUCER_MANIFEST);
    try {
      const scope = {
        workloadId: document.id,
        batchId: `arrival:${participantId}`,
        correlation: { executionId: execution?.id, instanceId: document.id, revision: document.state.revision },
        observer: execution?.trace ?? this.runtimeObserver,
        runtimeIdentity: { worldHash: document.state.worldHash, revision: document.state.revision },
      };
      const identity = modelInvocationIdentity(scope, "creation", participant.agentId, 1);
      const correlation = modelInvocationCorrelation(scope, "creation", participant.agentId, identity, {
        logicalInvocationId: modelInvocationLogicalId(scope, "creation", participant.agentId),
        semanticRepairAttempt: 0,
      });
      const referenceResolver = createAgentReferenceResolver(document.state.agents[participant.agentId], []);
      const result = await this.options.provider.generateStructured({
        ...scope,
        ...identity,
        correlation,
        profileId: creationProfile,
        role: "creation",
        subjectId: participant.agentId,
        promptVersion: ARRIVAL_PROMPT.version,
        schemaName: "arrival",
        system: ARRIVAL_PROMPT.system,
        userPrompt: ARRIVAL_PROMPT.userPrompt,
        context: {
          contractVersion: MODEL_CONTEXT_CONTRACT_VERSION,
          roleContract: modelRoleContract("arrival-generator"),
          execution: {
            worldId: document.state.worldId,
            instanceId: document.id,
            advanceId: `arrival:${participantId}`,
            revision: document.state.revision,
            step: document.state.step,
          },
          task: {
            kind: "arrival",
            assignment: {
              targetHandles: [referenceResolver.handleFor("agent", participant.agentId)],
              availableHandles: referenceResolver.catalog.candidates.map((candidate) => candidate.handle),
              allowedProposalKinds: [],
            },
            constraints: ["Write only from this Agent's private perspective; possibleNextActions are suggestions, not executed actions."],
          },
          state: {
            perspective: projectAgentPerspectiveForModel(
              document.state,
              document.state.agents[participant.agentId],
              referenceResolver,
            ),
          },
          referenceCatalog: referenceResolver.catalog,
          repair: null,
        },
        schema: arrivalDraftSchema,
      });
      execution?.trace.emit({ event: "arrival.generated", attributes: { status: "accepted" }, payload: result.value });
      if (execution && this.options.ledger) {
        this.options.ledger.finishExecution(execution.id, {
          status: "succeeded",
          semanticHash: contentHash(result.value),
          stateHash: contentHash(document.state),
          commitRevision: document.state.revision,
        });
      }
      return { ...result.value, generated: true };
    } catch (error) {
      this.failExecution(execution?.id, error);
      return {
        title: "你已进入世界",
        scene: fallback,
        possibleNextActions: ["观察四周", "确认自己所在的位置", "寻找一个可以交谈的人"],
        generated: false,
      };
    }
  }

  async setRealtime(instanceId: string, enabled: boolean): Promise<PublicInstanceDetail> {
    return this.serialized(instanceId, async () => {
      const stored = this.read(instanceId);
      const document = structuredClone(stored.document);
      document.scheduler.mode = enabled ? "realtime" : "paused";
      document.scheduler.generation += 1;
      document.scheduler.nextTickAt = enabled
        ? new Date(this.now().getTime() + document.runtime.realtimeIntervalMs).toISOString()
        : null;
      document.updatedAt = this.now().toISOString();
      const committed = this.persist(stored, document);
      if (enabled) this.scheduleRealtime(committed.document);
      else this.cancelTimer(instanceId);
      return this.project(committed.document);
    });
  }

  private cancelTimer(instanceId: string): void {
    const timer = this.timers.get(instanceId);
    if (timer) this.clearTimer(timer);
    this.timers.delete(instanceId);
  }

  private scheduleAt(instanceId: string, at: string, task: () => Promise<void>): void {
    this.cancelTimer(instanceId);
    const delay = Math.max(0, Date.parse(at) - this.now().getTime());
    const timer = this.setTimer!(async () => {
      this.timers.delete(instanceId);
      await task().catch(() => undefined);
    }, delay);
    this.timers.set(instanceId, timer);
  }

  private scheduleWindowDeadline(document: WorldInstanceDocument): void {
    if (currentRun(document)?.servicePause) { this.cancelTimer(document.id); return; }
    if (!document.actionWindow?.deadlineAt) return;
    this.scheduleAt(document.id, document.actionWindow.deadlineAt, async () => {
      const runId = await this.serialized(document.id, async () => {
        const stored = this.read(document.id);
        const next = structuredClone(stored.document);
        const window = next.actionWindow;
        if (!window || window.id !== document.actionWindow!.id || window.status !== "open" ||
          !window.deadlineAt || window.deadlineAt !== document.actionWindow!.deadlineAt) return;
        const run = currentRun(next);
        if (!run ||
          (window.kind === "decision" && run.status !== "awaiting-decision") ||
          (window.kind === "reaction" && run.status !== "awaiting-reaction")) return;
        if (window.kind === "decision") {
          run.rootIntents = window.requiredAgentIds.flatMap((agentId) =>
            window.submissions[agentId] ? [structuredClone(window.submissions[agentId]!)] : []);
        }
        run.status = "queued";
        run.stopReason = null;
        run.lease = null;
        run.generation += 1;
        run.updatedAt = this.now().toISOString();
        next.updatedAt = run.updatedAt;
        this.persist(stored, next);
        return run.id;
      });
      if (runId) this.scheduleRun(document.id, runId);
    });
  }

  private scheduleRealtime(document: WorldInstanceDocument): void {
    if (currentRun(document)?.servicePause) { this.cancelTimer(document.id); return; }
    if (document.scheduler.mode !== "realtime") return;
    const generation = document.scheduler.generation;
    const at = document.scheduler.nextTickAt ??
      new Date(this.now().getTime() + document.runtime.realtimeIntervalMs).toISOString();
    this.scheduleAt(document.id, at, async () => {
      const current = this.read(document.id).document;
      if (current.scheduler.mode !== "realtime" || current.scheduler.generation !== generation) return;
      await this.advance(document.id, {
        expectedRevision: current.state.revision,
        trigger: "realtime",
        steps: 1,
      });
    });
  }

  private restoreSchedule(stored: StoredWorldInstance): void {
    let current = stored;
    const recovered = structuredClone(stored.document);
    let changed = false;
    for (const run of Object.values(recovered.runs)) {
      if (!["queued", "running", "pausing", "debug-paused"].includes(run.status)) continue;
      let checkpointError = run.debugMode === "step"
        ? this.debugCheckpointValidationError(stored.document, run)
        : null;
      if (!checkpointError && run.debugMode === "step" && run.debugCheckpoint) {
        checkpointError = debugCheckpointReplayValidationError(
          this.options.ledger!.executionEvents(run.debugCheckpoint.executionId),
          run.debugCheckpoint.stageIndex - 1,
        );
      }
      if (run.debugMode === "step" && run.status === "debug-paused" && !checkpointError) {
        // The persisted source state, model outputs, audit payloads, and stage
        // cursor are sufficient to rebuild the continuation on the next CAS.
        continue;
      }
      run.generation += 1;
      run.status = run.debugMode === "step"
        ? "preparation-invalidated"
        : "paused";
      run.stopReason = run.status === "preparation-invalidated"
        ? checkpointError ? "debug-checkpoint-invalid" : "debug-checkpoint-continuation-unavailable"
        : "process-recovered";
      if (run.status === "preparation-invalidated") {
        run.error = checkpointError ?? "单步调试的 continuation 无法在进程重启后恢复；该次推演未提交。";
        if (recovered.actionWindow?.status === "resolving") recovered.actionWindow = null;
      }
      run.lease = null;
      run.updatedAt = this.now().toISOString();
      recovered.updatedAt = run.updatedAt;
      changed = true;
    }
    if (changed) current = this.persist(stored, recovered);
    const document = current.document;
    if (document.actionWindow?.status === "open" && document.actionWindow.deadlineAt) {
      this.scheduleWindowDeadline(document);
    } else if (document.scheduler.mode === "realtime") {
      const restored = structuredClone(document);
      restored.scheduler.generation += 1;
      restored.scheduler.nextTickAt = new Date(this.now().getTime() + restored.runtime.realtimeIntervalMs).toISOString();
      restored.updatedAt = this.now().toISOString();
      this.scheduleRealtime(this.persist(current, restored).document);
    }
  }
}
