import type { OnsetPerceptionReceipt } from "../mechanics/onset-receipts";
import type { PerceptionTarget } from "../contracts/perception-references";
import type { AgentMindOutput, ModelCausalAssertion } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import type {
  AgentActionProposal,
  AgentId,
  CausalAssertionResult,
  CausalVerification,
  CommitmentRound,
  D20CheckRequest,
  D20CheckResult,
  DiscreteRandomRequest,
  DiscreteRandomResult,
  MechanicResult,
  ModelExecutionAudit,
  ObservationPacket,
  ReactionDecision,
  ReactionRequest,
  SeededRngState,
  SimulationState,
  TransitionProposal,
} from "../contracts/model";
import type { ModelExecutionScope } from "../models/model-provider";
import type { StructuredModelProvider } from "../models/model-provider";
import type { AlgorithmInstrumentation, RuntimeObserver } from "./observability";
import type { RulePackageRegistry } from "../mechanics/rule-package";
import type { WorldDefinition } from "./world-definition";
import type { ResolutionPlan, ResolutionReceipt } from "../mechanics/resolution";
import type {
  ActivityDisposition,
  ActivityTransition,
  DecisionPoint,
  TemporalBoundary,
  TemporalPlan,
  TemporalPlanDraft,
  TemporalStateSnapshot,
} from "../mechanics/temporal";
import type { ExistingReferenceHandle, ModelCausalRef, ModelReference } from "../contracts/model-context";
import type {
  SharedActivityResourceClaim,
  SharedActivityResourceClaimDraft,
} from "../mechanics/shared-activity-resources";
import type { SharedResourceAdmission } from "../mechanics/shared-resource-allocation";
import type { ExecutionStageHooks } from "./stages";
import {
  AlgorithmRegistry,
  defineAlgorithmRef as defineCompositionRef,
  validateAlgorithmRef as validateCompositionRef,
  type AlgorithmDefinition,
  type AlgorithmImplementation,
  type AlgorithmRef,
  type AlgorithmRole,
  type ResolvedAlgorithm,
} from "../algorithms/composition";
import { z } from "zod";
import {
  assertJsonValue,
  frozenClone,
  type JsonObject,
} from "./json";

export type { JsonObject, JsonPrimitive, JsonValue } from "./json";
export type { AlgorithmRef } from "../algorithms/composition";

export type ExecutionKind = "interactive" | "diagnostic" | "benchmark" | "replay";

export const WORLD_EXECUTION_CONTRACT_VERSION = 9 as const;
export const ENGINE_OPERATION_CONTRACT_VERSION = 1 as const;
export const WORLD_STEP_CANDIDATE_SCHEMA_VERSION = 7 as const;
export const WORLD_STEP_PREPARATION_SCHEMA_VERSION = 6 as const;

export class StepPreparationInvalidatedError extends Error {
  constructor(message = "step preparation no longer matches its execution inputs") {
    super(message);
    this.name = "StepPreparationInvalidatedError";
  }
}

export interface AlgorithmManifest {
  kind: "algorithm";
  contractVersion: typeof WORLD_EXECUTION_CONTRACT_VERSION;
  role: "world-execution";
  id: string;
  version: string;
  config: JsonObject;
  children: Readonly<Record<string, AlgorithmRef>>;
  hash: string;
}

export interface EngineOperationManifest {
  kind: "engine-operation";
  contractVersion: typeof ENGINE_OPERATION_CONTRACT_VERSION;
  id: string;
  version: string;
  config: JsonObject;
  hash: string;
}

export type ExecutionProducerManifest = AlgorithmManifest | EngineOperationManifest;

const algorithmManifestFields = [
  "children", "config", "contractVersion", "hash", "id", "kind", "role", "version",
].sort();
const engineOperationManifestFields = ["config", "contractVersion", "hash", "id", "kind", "version"].sort();

function validateManifestFields(value: object, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} fields must be exactly: ${expected.join(", ")}`);
  }
}

function requireManifestText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
}

export function defineAlgorithmManifest(input: {
  id: string;
  version: string;
  config: JsonObject;
  children?: Readonly<Record<string, AlgorithmRef>>;
}): AlgorithmManifest {
  const ref = defineCompositionRef({
    role: "world-execution",
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION,
    ...input,
  });
  return frozenClone({
    kind: "algorithm" as const,
    role: ref.role,
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION,
    id: ref.id,
    version: ref.version,
    config: ref.config,
    children: ref.children,
    hash: ref.manifestHash,
  });
}

export function defineEngineOperationManifest(input: {
  id: string;
  version: string;
  config?: JsonObject;
}): EngineOperationManifest {
  requireManifestText(input.id, "engine operation id");
  requireManifestText(input.version, "engine operation version");
  const config = input.config ?? {};
  assertJsonValue(config, "engine operation config");
  const body = frozenClone({
    kind: "engine-operation" as const,
    contractVersion: ENGINE_OPERATION_CONTRACT_VERSION,
    id: input.id,
    version: input.version,
    config,
  });
  return frozenClone({ ...body, hash: contentHash(body) });
}

export function validateExecutionProducerManifest(manifest: ExecutionProducerManifest): void {
  if (!manifest || typeof manifest !== "object") throw new Error("execution producer manifest is required");
  requireManifestText(manifest.id, "execution producer id");
  requireManifestText(manifest.version, "execution producer version");
  assertJsonValue(manifest.config, "execution producer config");
  if (manifest.kind === "algorithm") {
    validateManifestFields(manifest, algorithmManifestFields, "execution algorithm manifest");
    const contractVersion = Number(manifest.contractVersion);
    if (contractVersion !== WORLD_EXECUTION_CONTRACT_VERSION) {
      throw new Error(`unsupported execution algorithm contract version: ${contractVersion}`);
    }
    validateCompositionRef(algorithmRef(manifest));
    return;
  } else if (manifest.kind === "engine-operation") {
    validateManifestFields(manifest, engineOperationManifestFields, "engine operation manifest");
    const contractVersion = Number(manifest.contractVersion);
    if (contractVersion !== ENGINE_OPERATION_CONTRACT_VERSION) {
      throw new Error(`unsupported engine operation contract version: ${contractVersion}`);
    }
  } else {
    throw new Error("execution producer manifest kind is invalid");
  }
  const { hash, ...body } = manifest;
  if (contentHash(body) !== hash) {
    throw new Error(`execution producer manifest hash mismatch: ${manifest.id}@${manifest.version}`);
  }
}

export function algorithmRef(manifest: AlgorithmManifest): AlgorithmRef<"world-execution"> {
  const ref = frozenClone({
    role: manifest.role,
    id: manifest.id,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    config: manifest.config,
    children: manifest.children,
    manifestHash: manifest.hash,
  });
  validateCompositionRef(ref);
  return ref;
}

export function algorithmManifest(ref: AlgorithmRef<"world-execution">): AlgorithmManifest {
  validateAlgorithmRef(ref);
  return frozenClone({
    kind: "algorithm",
    role: ref.role,
    contractVersion: WORLD_EXECUTION_CONTRACT_VERSION,
    id: ref.id,
    version: ref.version,
    config: ref.config,
    children: ref.children,
    hash: ref.manifestHash,
  });
}

export function validateAlgorithmRef(ref: AlgorithmRef): void {
  validateCompositionRef(ref);
  if (ref.role !== "world-execution" || ref.contractVersion !== WORLD_EXECUTION_CONTRACT_VERSION) {
    throw new Error(`unsupported world-execution algorithm contract: ${ref.role}#${ref.contractVersion}`);
  }
}

export interface ExecutionRef {
  executionId: string;
  terminalEventSequence: number;
  traceHash: string;
}

export interface ExecutionTraceWriter extends RuntimeObserver {
  readonly executionId: string;
  readonly traceId: string;
  artifact(kind: string, value: unknown): string;
  flush(): void;
}

export interface ExecutionContext {
  modelScope: ModelExecutionScope;
  instrumentation: AlgorithmInstrumentation;
  stages?: ExecutionStageHooks;
}

export interface BootstrapInput {
  definition: WorldDefinition;
  state: SimulationState;
}

export interface BootstrapCandidate {
  schemaVersion: typeof WORLD_STEP_CANDIDATE_SCHEMA_VERSION;
  sourceStateHash: string;
  agentCommits: Array<AgentMindOutput & { agentId: string }>;
  modelAudits: ModelExecutionAudit[];
  diagnostics: AlgorithmCandidateDiagnostics;
}

export interface WorldStepInput {
  definition: WorldDefinition;
  state: SimulationState;
  policyRoster: Readonly<Record<AgentId, PolicyBinding>>;
  request: Readonly<WorldAdvanceRequest>;
  decisionEligibleAgentIds: readonly AgentId[];
}

export type ParticipantId = string;

export type PolicyBinding =
  | {
      kind: "model";
      agentId: AgentId;
      profiles: Readonly<{ bootstrap: string; mind: string; reaction: string }>;
      resumeFromRevision?: number;
    }
  | { kind: "external"; agentId: AgentId; participantId: ParticipantId }
  | { kind: "idle"; agentId: AgentId; reason: "timeout" | "released" | "explicit" }
  | { kind: "replay"; agentId: AgentId; sourceExecutionId: string };

export interface ExternalActionInput {
  submissionId: string;
  agentId: AgentId;
  rawText: string;
  goal: string;
  means: string | null;
  targetIds: string[];
}

export type ExternalReactionInput =
  | {
      submissionId: string;
      requestId: string;
      agentId: AgentId;
      kind: "keep";
    }
  | {
      submissionId: string;
      requestId: string;
      agentId: AgentId;
      kind: "replace";
      rawText: string;
      goal: string;
      means: string | null;
      targetIds: string[];
    };

export interface WorldAdvanceRequest {
  expectedRevision: number;
  trigger: "manual" | "batch" | "realtime" | "participant_action";
  externalActions: readonly ExternalActionInput[];
}

export function decisionEligibleAgentIds(
  state: Readonly<SimulationState>,
  forcedAgentIds: readonly AgentId[] = [],
): AgentId[] {
  const decisionAgents = new Set(state.history.at(-1)?.decisionPoints.map((point) => point.agentId) ?? []);
  forcedAgentIds.forEach((agentId) => decisionAgents.add(agentId));
  const busyAgents = new Set(Object.values(state.truth.activities)
    .filter((activity) => activity.status === "active" || activity.status === "paused" ||
      activity.status === "queued" || activity.status === "ready")
    .flatMap((activity) => activity.participantAgentIds));
  return Object.keys(state.agents)
    .filter((agentId) => !busyAgents.has(agentId) || decisionAgents.has(agentId))
    .sort();
}

export interface WorldResolutionCandidate {
  proposal: TransitionProposal;
  initialActions: AgentActionProposal[];
  actions: AgentActionProposal[];
  reactionRequests: ReactionRequest[];
  reactionDecisions: ReactionDecision[];
  stimulusObservations: ObservationPacket[];
  requests: D20CheckRequest[];
  checks: D20CheckResult[];
  randomRequests: DiscreteRandomRequest[];
  randomResults: DiscreteRandomResult[];
  commitmentRounds: CommitmentRound[];
  resolutionPlans: ResolutionPlan[];
  resolutionReceipts: ResolutionReceipt[];
  rng: SeededRngState;
  mechanicResults: MechanicResult[];
  causalAssertionResults: CausalAssertionResult[];
  causalVerification: CausalVerification;
}

export function resolutionObservations(
  resolution: Readonly<WorldResolutionCandidate>,
): ObservationPacket[] {
  return [
    ...structuredClone(resolution.stimulusObservations),
    ...structuredClone(resolution.proposal.observations),
  ];
}

export interface AlgorithmCandidateDiagnostics {
  activatedAgentIds: AgentId[];
  reusedAgentIds: AgentId[];
  mindFallbackAgentIds: AgentId[];
}

export interface WorldStepDiagnostics extends AlgorithmCandidateDiagnostics {
  dependencyComponents: string[][];
  globalReadjudication: boolean;
  /** Deterministic summary of the ephemeral canonical conflict graph. */
  dependencyGraph?: {
    mode: "canonical";
    nodeCount: number;
    edgeCount: number;
    componentCount: number;
    maxComponentSize: number;
    globalFallbackNodeIds: string[];
    contentHash: string;
  };
}

export interface OnsetPerceptionTranscript {
  targets: PerceptionTarget[];
  receipts: OnsetPerceptionReceipt[];
  requests: D20CheckRequest[];
  checks: D20CheckResult[];
  commitmentRounds: CommitmentRound[];
  rng: SeededRngState;
}

export interface WorldStepCandidate {
  onsetPerception: OnsetPerceptionTranscript;
  schemaVersion: typeof WORLD_STEP_CANDIDATE_SCHEMA_VERSION;
  sourceStateHash: string;
  resolution: WorldResolutionCandidate;
  finalCausalReview: {
    contentHash: string;
    evidenceHash: string;
    promptVersion: string;
    invocationIds: string[];
  };
  mindCommits: Array<AgentMindOutput & { agentId: string }>;
  modelAudits: ModelExecutionAudit[];
  interactionDependencies: InteractionDependency[];
  diagnostics: WorldStepDiagnostics;
  temporalPlans: TemporalPlan[];
  temporalBoundary: TemporalBoundary;
  temporalState: TemporalStateSnapshot;
  activityTransitions: ActivityTransition[];
  activityDispositions: ActivityDisposition[];
  sharedResourceAdmissions: SharedResourceAdmission[];
  decisionPoints: DecisionPoint[];
}

/** Bind reviewed world behavior independently of subsequent cognition work. */
export function finalCausalReviewContentHash(candidate: Pick<WorldStepCandidate,
  "sourceStateHash" | "resolution" | "temporalBoundary" | "temporalState" | "onsetPerception">): string {
  return contentHash({ sourceStateHash: candidate.sourceStateHash, resolution: candidate.resolution, onsetPerception: candidate.onsetPerception,
    temporalBoundary: candidate.temporalBoundary, temporalState: candidate.temporalState });
}

export interface WorldStepPreparation {
  onsetPerception: OnsetPerceptionTranscript;
  reactionRequests: ReactionRequest[];
  schemaVersion: typeof WORLD_STEP_PREPARATION_SCHEMA_VERSION;
  id: string;
  sourceStateHash: string;
  algorithmManifestHash: string;
  policyRosterHash: string;
  requestHash: string;
  pendingReactionRequests: ReactionRequest[];
  preparedReactionDecisions: ReactionDecision[];
  modelAudits: ModelExecutionAudit[];
  payload: JsonObject;
}

export type FootprintRef =
  | { kind: "entity"; id: string }
  | { kind: "fact"; id: string }
  | { kind: "placement"; id: string }
  | { kind: "meter"; id: string }
  | { kind: "quantity"; id: string }
  | { kind: "rating"; id: string }
  | { kind: "condition"; id: string }
  | { kind: "activity"; id: string }
  | { kind: "shared_resource_pool"; id: string }
  | { kind: "global"; id: "world" };

export interface InteractionDependency {
  kind: "action" | "activity" | "timer" | "condition";
  id: string;
  actorId: AgentId | null;
  reads: FootprintRef[];
  writes: FootprintRef[];
  audienceAgentIds: AgentId[];
  sharedResourceClaims: SharedActivityResourceClaim[];
  globalFallback: boolean;
}

export type InteractionDependencyDraft = Omit<InteractionDependency, "kind" | "id" | "actorId" | "sharedResourceClaims"> & {
  sharedResourceClaims: SharedActivityResourceClaimDraft[];
};

/** Model-facing dependency vocabulary. It is resolved into InteractionDependency
 * only after candidate handles have been checked against the request catalog. */
export interface ActionGroundingModelOutput {
  stateDependencies: {
    requiredExistingRefs: ExistingReferenceHandle[];
    potentiallyAffectedExistingRefs: ExistingReferenceHandle[];
  };
  audienceAgentRefs: ExistingReferenceHandle[];
  sharedResourceClaims: ActionSharedResourceClaimModel[];
}

export interface ActionSharedResourceClaimModel {
  resourcePoolRef: ExistingReferenceHandle;
  basis:
    | { kind: "default" }
    | { kind: "explicit_quantity"; amount: number; unit: string; sourceText: string };
}

export interface ActionCompilationDraft {
  temporalPlan: Omit<TemporalPlanDraft, "profileId" | "basis" | "causes" | "continuationAssertions"> & {
    profileRef: ModelReference;
    basis: import("../mechanics/temporal").ModelTemporalPlanBasis;
    causes: ModelCausalRef[];
    continuationAssertions: ModelCausalAssertion[];
  };
  interactionDependency: ActionGroundingModelOutput;
}

export interface WorldExecutionAlgorithm {
  readonly manifest: AlgorithmManifest;

  bootstrap(
    input: Readonly<BootstrapInput>,
    context: ExecutionContext,
  ): Promise<BootstrapCandidate>;

  prepareStep(
    input: Readonly<WorldStepInput>,
    context: ExecutionContext,
  ): Promise<WorldStepPreparation>;

  completeStep(
    input: Readonly<WorldStepInput>,
    preparation: Readonly<WorldStepPreparation>,
    reactions: readonly ExternalReactionInput[],
    context: ExecutionContext,
  ): Promise<WorldStepCandidate>;
}

export interface WorldExecutionAlgorithmServices {
  provider: StructuredModelProvider;
  rulePackages?: RulePackageRegistry;
  resources?: {
    resolve<T>(kind: string, ref: AlgorithmRef): T | undefined;
  };
}

export type WorldExecutionAlgorithmFactory = (
  services: Readonly<WorldExecutionAlgorithmServices>,
) => WorldExecutionAlgorithm;

export type WorldExecutionAlgorithmDefinition = Omit<
  AlgorithmDefinition<"world-execution", WorldExecutionAlgorithmServices>,
  "create"
> & {
  create(
    context: Parameters<AlgorithmDefinition<"world-execution", WorldExecutionAlgorithmServices>["create"]>[0],
  ): WorldExecutionAlgorithm;
};

export class WorldExecutionAlgorithmRegistry {
  private readonly algorithms = new AlgorithmRegistry<WorldExecutionAlgorithmServices>();
  private readonly instances = new WeakSet<WorldExecutionAlgorithm>();

  register(manifest: AlgorithmManifest, factory: WorldExecutionAlgorithmFactory): void {
    validateExecutionProducerManifest(manifest);
    if (Object.keys(manifest.children).length > 0) {
      throw new Error("register supports only leaf world-execution algorithms; use typed child definitions for a Composition");
    }
    this.registerDefinition({
      role: "world-execution",
      id: manifest.id,
      version: manifest.version,
      contractVersion: manifest.contractVersion,
      maturity: "diagnostic",
      configSchema: z.custom<JsonObject>((config) => contentHash(config) === contentHash(manifest.config)),
      children: Object.entries(manifest.children).map(([name, child]) => ({ name, role: child.role })),
      create: ({ services }) => factory(services),
    });
  }

  registerDefinition(definition: WorldExecutionAlgorithmDefinition): void {
    this.algorithms.register({
      ...definition,
      create: (context) => ({
        algorithmIdentity: {
          role: definition.role,
          id: definition.id,
          version: definition.version,
          contractVersion: definition.contractVersion,
        },
        algorithm: definition.create(context),
      }),
    });
  }

  registerAlgorithmDefinition<R extends AlgorithmRole>(
    definition: AlgorithmDefinition<R, WorldExecutionAlgorithmServices>,
  ): void {
    if (definition.role === "world-execution") {
      throw new Error("register world-execution definitions with registerDefinition");
    }
    this.algorithms.register(definition);
  }

  catalog() {
    return this.algorithms.list();
  }

  has(ref: AlgorithmRef): boolean {
    return ref.role === "world-execution" && this.algorithms.has(ref);
  }

  validateExperimentComposition(ref: AlgorithmRef): void {
    if (ref.role !== "world-execution") throw new Error(`world-execution algorithm role is required, got ${ref.role}`);
    this.algorithms.validateTreeMaturity(ref, ["reference", "candidate"]);
  }

  create(ref: AlgorithmRef, services: Readonly<WorldExecutionAlgorithmServices>): WorldExecutionAlgorithm {
    validateAlgorithmRef(ref);
    if (ref.role !== "world-execution") throw new Error(`world-execution algorithm role is required, got ${ref.role}`);
    const resolved = this.algorithms.resolve(ref, services) as ResolvedAlgorithm<"world-execution">;
    const root = resolved.implementation as AlgorithmImplementation<"world-execution"> & { algorithm?: WorldExecutionAlgorithm };
    const algorithm = root.algorithm;
    const key = `${ref.role}/${ref.id}@${ref.version}`;
    if (!algorithm || typeof algorithm !== "object") {
      throw new Error(`execution algorithm factory did not return an algorithm instance: ${key}`);
    }
    if (typeof algorithm.bootstrap !== "function" || typeof algorithm.prepareStep !== "function" ||
      typeof algorithm.completeStep !== "function") {
      throw new Error(`execution algorithm factory returned an incomplete algorithm contract: ${key}`);
    }
    if (algorithm.manifest.hash !== ref.manifestHash) {
      throw new Error(`execution algorithm factory returned the wrong manifest: ${key}`);
    }
    validateExecutionProducerManifest(algorithm.manifest);
    if (this.instances.has(algorithm)) {
      throw new Error(`execution algorithm factory reused an algorithm instance: ${key}`);
    }
    this.instances.add(algorithm);
    return algorithm;
  }
}
