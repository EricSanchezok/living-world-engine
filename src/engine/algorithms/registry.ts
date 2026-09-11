import { PLANNING_CATALOG_ENCODING, planningCatalogEncodingProvider } from "../mechanics/planning-catalog-encoding";
import { standardEagerReferenceAlgorithmRef } from "./standard-composition";
import { PLAN_RANDOM_COMPLETION } from "../mechanics/plan-random-completion";
import { PERCEPTION_RATING_CHOICES, perceptionRatingChoiceProvider } from "../mechanics/perception-rating-choices";
import { PLANNING_CONTRACT_TAIL } from "../mechanics/planning-contract-tail";
import { OBSERVATION_EVIDENCE_LAYOUT, observationEvidenceProvider } from "../mechanics/observation-evidence-layout";
import { OBSERVATION_CLAIM_ENCODING } from "../mechanics/observation-claim-encoding";
import { TRUTH_RESOLUTION_CONTRACT_VERSION } from "./roles";
import { ORDERED_RANDOM_SCHEDULING } from "../mechanics/ordered-random-stream";
import { z } from "zod";
import { RESOLUTION_SOURCE_INVENTORY, RESOLUTION_FACT_EVIDENCE } from "../contracts/resolution-source-inventory";
import {
  ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH,
  ACTION_COMPILATION_CANDIDATE_KEY_VERSION,
} from "../contracts/model-context";
import {
  createEagerReferenceAlgorithmRef,
  EagerReferenceAlgorithm,
  FULL_CATALOG_EAGER_REFERENCE_CONFIG,
  type EagerReferenceComponents,
  type EagerReferenceAlgorithmConfig,
} from "./eager-reference/eager-reference";
import { compileActions } from "./eager-reference/action-compiler";
import { constrainedActionCompiler, constrainedCompilationPrompt, type ConstrainedCompilationOptions } from "./eager-reference/constrained-action-compiler";
import { CONSTRAINED_COMPILATION_CODEC_VERSION } from "./eager-reference/constrained-action-compilation-codec";
import { representedActionCompiler, representedActionCompilationPrompt } from "./eager-reference/represented-action-compiler";
import { ACTION_COMPILATION_REPRESENTATION_VERSION, type ActionCompilationRepresentation } from "./eager-reference/action-compilation-representation";
import { AgentMind } from "./eager-reference/agent-mind";
import { DEFAULT_EAGER_OUTPUT_RECOVERY } from "./eager-reference/eager-slot-batching";
import { generateInteractionDependency } from "../mechanics/action-dependency";
import { TruthEngine } from "../mechanics/truth-engine";
import { TruthBatchCoordinator, SHARED_BATCH_PROMPT_VERSION, TRUTH_BATCH_REQUEST_CONTRACT } from "../mechanics/truth-batch-provider";
import { SHARED_BATCH_CONTEXT_CODEC, SHARED_BATCH_ORDER_CODEC, type SharedBatchContext } from "../mechanics/shared-batch-context";
import { withTruthRequestPolicy } from "../mechanics/truth-request-policy";
import { SHARED_STATE_FIRST_LAYOUT } from "../prompts/context-layout";
import { UNMATCHED_CLOSER_RECOVERY } from "../models/unmatched-closer-recovery";
import { RESOLUTION_DEPENDENT_FIELDS_CODEC, RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION, dependentFieldsProvider } from "../mechanics/resolution-dependent-fields-codec";
import { WORKLIST_PLANNING_PIPELINE, WORKLIST_PLANNING_PROMPT_VERSION, worklistPlanningProvider } from "../mechanics/worklist-planning-pipeline";
import { INDEXED_REVIEWED_PLANNING_PIPELINE, INDEXED_REVIEWED_PLANNING_PROMPT_VERSION, indexedReviewedPlanningProvider } from "../mechanics/indexed-reviewed-planning-pipeline";
import { SOURCE_INDEXED_PLAN_CAUSES } from "../mechanics/source-indexed-plan-causes";
import { SOURCE_INDEXED_PLAN_MEANS } from "../mechanics/source-indexed-planning";
import { PLANNING_RELATION_CHOICES } from "../mechanics/planning-relation-choices";
import { COMPACT_PLANNING_RECORDS } from "../mechanics/compact-planning-records";
import { MECHANICAL_PLAN_REPAIR } from "../mechanics/mechanical-plan-repair";
import { sourceIntentReviewProvider } from "../mechanics/plan-review-ownership";
import { ObservationRenderer } from "../cognition/observation-renderer";
import { EVENT_OUTCOME_SUMMARIES } from "../mechanics/event-outcome-summaries";
import { BOUNDARY_CLOCK_WITNESS } from "../mechanics/boundary-clock-witness";
import { createCoreRulePackageRegistry } from "../mechanics/rule-package";
import { DEFAULT_SYMBOL_REPAIR_POLICY } from "../contracts/symbol-repair";
import {
  algorithmManifest,
  WorldExecutionAlgorithmRegistry,
  type AlgorithmRef,
  type JsonObject,
  type WorldExecutionAlgorithmServices,
} from "../runtime/execution";
import type {
  AlgorithmDefinition,
  AlgorithmIdentity,
  AlgorithmImplementation,
  AlgorithmRole,
  ResolvedAlgorithm,
} from "./composition";
import type {
  ActionCompilationRoleAlgorithm,
  AgentCognitionRoleAlgorithm,
  CandidateAllocationRoleAlgorithm,
  CandidateRankingRoleAlgorithm,
  CandidateSelectionCapability,
  CandidateSelectionRoleAlgorithm,
  ConfiguredRoleAlgorithm,
  InteractionGroundingRoleAlgorithm,
  ObservationRenderingRoleAlgorithm,
  OnsetPerceptionRoleAlgorithm,
  OutputRecoveryCapability,
  OutputRecoveryRoleAlgorithm,
  ReactionDecisionRoleAlgorithm,
  SymbolRepairRoleAlgorithm,
  TruthResolutionRoleAlgorithm,
  WorkBatchingRoleAlgorithm,
  WorkSchedulingRoleAlgorithm,
} from "./roles";
import {
  ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
} from "./eager-reference/candidate-retrieval/runtime";
import {
  RELATIONAL_RRF_ENCODER_FINGERPRINT,
  RELATIONAL_RRF_ENCODER_MODEL_ID,
} from "./eager-reference/candidate-retrieval/relational-rrf";

export { ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION } from "./eager-reference/candidate-retrieval/runtime";

class ConfiguredAlgorithm<R extends AlgorithmRole> implements ConfiguredRoleAlgorithm<R> {
  constructor(
    readonly algorithmIdentity: AlgorithmIdentity<R>,
    readonly config: JsonObject,
    readonly children: Readonly<Record<string, ResolvedAlgorithm>>,
  ) {}
}

class WorkBatchingAlgorithm extends ConfiguredAlgorithm<"work-batching"> implements WorkBatchingRoleAlgorithm {
  readonly maxSlots: number;

  constructor(
    algorithmIdentity: AlgorithmIdentity<"work-batching">,
    config: JsonObject,
    children: Readonly<Record<string, ResolvedAlgorithm>>,
  ) {
    super(algorithmIdentity, config, children);
    this.maxSlots = Number(config.maxSlots);
  }
}

class WorkSchedulingAlgorithm extends ConfiguredAlgorithm<"work-scheduling"> implements WorkSchedulingRoleAlgorithm {
  readonly maxConcurrent: number;

  constructor(
    algorithmIdentity: AlgorithmIdentity<"work-scheduling">,
    config: JsonObject,
    children: Readonly<Record<string, ResolvedAlgorithm>>,
  ) {
    super(algorithmIdentity, config, children);
    this.maxConcurrent = Number(config.maxConcurrent);
  }
}

class OutputRecoveryAlgorithm extends ConfiguredAlgorithm<"output-recovery"> implements OutputRecoveryRoleAlgorithm {
  readonly policy: Readonly<OutputRecoveryCapability>;

  constructor(
    algorithmIdentity: AlgorithmIdentity<"output-recovery">,
    config: JsonObject,
    children: Readonly<Record<string, ResolvedAlgorithm>>,
  ) {
    super(algorithmIdentity, config, children);
    this.policy = Object.freeze({
      maxRepairs: Number(config.maxRepairs),
      exhaustion: "fail-step" as const,
      splitAt: DEFAULT_EAGER_OUTPUT_RECOVERY.splitAt,
    });
  }
}

class AgentCognitionAlgorithm extends ConfiguredAlgorithm<"agent-cognition"> implements AgentCognitionRoleAlgorithm {
  create(provider: WorldExecutionAlgorithmServices["provider"], recovery: Readonly<OutputRecoveryCapability>) {
    return new AgentMind(provider, recovery);
  }
}

class ActionCompilationAlgorithm extends ConfiguredAlgorithm<"action-compilation"> implements ActionCompilationRoleAlgorithm {
  readonly compile = compileActions;
}

class RepresentedActionCompilationAlgorithm extends ConfiguredAlgorithm<"action-compilation"> implements ActionCompilationRoleAlgorithm {
  readonly compile;

  constructor(algorithmIdentity: AlgorithmIdentity<"action-compilation">, config: JsonObject, children: Readonly<Record<string, ResolvedAlgorithm>>) {
    super(algorithmIdentity, config, children);
    const representation = config.representation as ActionCompilationRepresentation;
    const sourceOwned = config.descriptionPolicy === "original-action-v1" || config.descriptionPolicy === "original-action-omitted-v2";
    const omittedDescription = config.descriptionPolicy === "original-action-omitted-v2";
    const profileChoices = config.profileChoiceEvidence === "visible-schema-v1";
    const namedContracts = config.temporalContractSelection === "named-operators-v1";
    if (config.promptVersion !== representedActionCompilationPrompt(representation, sourceOwned, profileChoices, namedContracts, omittedDescription).version) {
      throw new Error("AC-FP1 prompt identity does not match its representation");
    }
    this.compile = representedActionCompiler(representation, config.eligibleProfileSchema === "batch-union-v1", sourceOwned, profileChoices, namedContracts, omittedDescription);
  }
}

class ConstrainedActionCompilationAlgorithm extends ConfiguredAlgorithm<"action-compilation"> implements ActionCompilationRoleAlgorithm {
  readonly compile;
  constructor(algorithmIdentity: AlgorithmIdentity<"action-compilation">, config: JsonObject, children: Readonly<Record<string, ResolvedAlgorithm>>) {
    super(algorithmIdentity, config, children);
    const options: ConstrainedCompilationOptions = { capabilities: config.capabilities as boolean, snapshots: config.snapshots as boolean,
      structuredOutputMode: config.structuredOutputMode as ConstrainedCompilationOptions["structuredOutputMode"] };
    if (config.promptVersion !== constrainedCompilationPrompt(options).version) throw new Error("AC-FP2 prompt identity drift");
    this.compile = constrainedActionCompiler(options);
  }
}

class CandidateSelectionAlgorithm extends ConfiguredAlgorithm<"candidate-selection"> implements CandidateSelectionRoleAlgorithm {
  constructor(
    algorithmIdentity: AlgorithmIdentity<"candidate-selection">,
    config: JsonObject,
    children: Readonly<Record<string, ResolvedAlgorithm>>,
    readonly runtime: CandidateSelectionCapability | undefined,
  ) {
    super(algorithmIdentity, config, children);
  }
}

class CandidateRankingAlgorithm extends ConfiguredAlgorithm<"candidate-ranking"> implements CandidateRankingRoleAlgorithm {
  readonly rankingVersion = "typed-channel-rrf-v1" as const;
}

class CandidateAllocationAlgorithm extends ConfiguredAlgorithm<"candidate-allocation"> implements CandidateAllocationRoleAlgorithm {
  readonly allocationVersion = "coverage-aware-joint-budget-v1" as const;
}

class SymbolRepairAlgorithm extends ConfiguredAlgorithm<"symbol-repair"> implements SymbolRepairRoleAlgorithm {
  readonly policy = DEFAULT_SYMBOL_REPAIR_POLICY;
}

class InteractionGroundingAlgorithm extends ConfiguredAlgorithm<"interaction-grounding"> implements InteractionGroundingRoleAlgorithm {
  readonly ground = generateInteractionDependency;
}

class OnsetPerceptionAlgorithm extends ConfiguredAlgorithm<"onset-perception"> implements OnsetPerceptionRoleAlgorithm {
  create(provider: WorldExecutionAlgorithmServices["provider"], rulePackages: NonNullable<WorldExecutionAlgorithmServices["rulePackages"]>, recovery: Readonly<OutputRecoveryCapability>) {
    return new TruthEngine(this.config.ratingChoices === PERCEPTION_RATING_CHOICES ? perceptionRatingChoiceProvider(provider) : provider,
      { rulePackages, repairAttempts: recovery.maxRepairs });
  }
}

class ReactionDecisionAlgorithm extends ConfiguredAlgorithm<"reaction-decision"> implements ReactionDecisionRoleAlgorithm {
  create(provider: WorldExecutionAlgorithmServices["provider"], recovery: Readonly<OutputRecoveryCapability>) {
    return new AgentMind(provider, recovery);
  }
}

class TruthResolutionAlgorithm extends ConfiguredAlgorithm<"truth-resolution"> implements TruthResolutionRoleAlgorithm {
  create(provider: WorldExecutionAlgorithmServices["provider"], rulePackages: NonNullable<WorldExecutionAlgorithmServices["rulePackages"]>, recovery: Readonly<OutputRecoveryCapability>) {
    return new TruthEngine(provider, { rulePackages, repairAttempts: recovery.maxRepairs,
      ...(this.config.mechanicalPlanRepair === MECHANICAL_PLAN_REPAIR ? { mechanicalPlanRepair: MECHANICAL_PLAN_REPAIR } : {}),
      ...(this.config.planRandomCompletion === PLAN_RANDOM_COMPLETION ? { planRandomCompletion: PLAN_RANDOM_COMPLETION } : {}),
      includeActivityTemporalEvidence: this.config.planningPipeline === WORKLIST_PLANNING_PIPELINE || this.config.planningPipeline === INDEXED_REVIEWED_PLANNING_PIPELINE,
      includeResolutionMeansSources: this.config.sourceInventory === RESOLUTION_SOURCE_INVENTORY,
      includePlanCauseScope: this.config.planCauseChoices === SOURCE_INDEXED_PLAN_CAUSES,
      includeResolutionFactEvidence: this.config.planFactEvidence === RESOLUTION_FACT_EVIDENCE });
  }
}

class ObservationRenderingAlgorithm extends ConfiguredAlgorithm<"observation-rendering"> implements ObservationRenderingRoleAlgorithm {
  create(provider: WorldExecutionAlgorithmServices["provider"], recovery: Readonly<OutputRecoveryCapability>) {
    return new ObservationRenderer(provider, recovery.maxRepairs,
      this.algorithmIdentity.id === "source-bound-observation-rendering");
  }
}

const positiveSlots = z.number().int().min(1).max(64);
const noChildren = [] as const;

function identity<R extends AlgorithmRole>(
  role: R,
  id: string,
  version = "1",
  contractVersion = role === "truth-resolution" ? TRUTH_RESOLUTION_CONTRACT_VERSION : 1,
): AlgorithmIdentity<R> {
  return { role, id, version, contractVersion };
}

function configuredDefinition<R extends AlgorithmRole>(input: Omit<
  AlgorithmDefinition<R, WorldExecutionAlgorithmServices>,
  "create"
>, create: (
  identity: AlgorithmIdentity<R>,
  config: JsonObject,
  children: Readonly<Record<string, ResolvedAlgorithm>>,
  services: Readonly<WorldExecutionAlgorithmServices>,
  ref: AlgorithmRef<R>,
) => AlgorithmImplementation<R> = (algorithmIdentity, config, children) =>
    new ConfiguredAlgorithm(algorithmIdentity, config, children)
): AlgorithmDefinition<R, WorldExecutionAlgorithmServices> {
  return {
    ...input,
    create: ({ ref, children, services }) => create(input, ref.config, children, services, ref as AlgorithmRef<R>),
  };
}

function candidateSelectionRuntime(
  services: Readonly<WorldExecutionAlgorithmServices>,
  ref: AlgorithmRef<"candidate-selection">,
): CandidateSelectionCapability {
  const runtime = services.resources?.resolve<CandidateSelectionCapability>("candidate-selection-runtime", ref);
  if (!runtime) throw new Error(`${ref.id} candidate selection requires its pinned runtime`);
  if (runtime.role !== "candidate-selection" ||
    runtime.version !== ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION ||
    typeof runtime.retrieveBatch !== "function") {
    throw new Error(`${ref.id} candidate selection received an incompatible runtime`);
  }
  return runtime;
}

const definitions = [
  configuredDefinition({
    ...identity("truth-resolution", "indexed-reviewed-truth-resolution", "5"),
    maturity: "reference",
    configSchema: z.strictObject({ randomScheduling: z.literal(ORDERED_RANDOM_SCHEDULING),
      representation: z.literal(RESOLUTION_DEPENDENT_FIELDS_CODEC), promptVersion: z.literal(RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION),
      sourceInventory: z.literal(RESOLUTION_SOURCE_INVENTORY), planningPipeline: z.literal(INDEXED_REVIEWED_PLANNING_PIPELINE),
      pipelinePromptVersion: z.literal(INDEXED_REVIEWED_PLANNING_PROMPT_VERSION), outcomeSummary: z.literal(EVENT_OUTCOME_SUMMARIES).optional(),
      boundaryClockWitness: z.literal(BOUNDARY_CLOCK_WITNESS).optional(), planCauseChoices: z.literal(SOURCE_INDEXED_PLAN_CAUSES).optional(),
      planMeansChoices: z.literal(SOURCE_INDEXED_PLAN_MEANS).optional(),
      planningRelationChoices: z.literal(PLANNING_RELATION_CHOICES).optional(),
      compactPlanningRecords: z.literal(COMPACT_PLANNING_RECORDS).optional(),
      planFactEvidence: z.literal(RESOLUTION_FACT_EVIDENCE).optional(),
      planningCatalogEncoding: z.literal(PLANNING_CATALOG_ENCODING).optional(),
      planRandomCompletion: z.literal(PLAN_RANDOM_COMPLETION).optional(),
      mechanicalPlanRepair: z.literal(MECHANICAL_PLAN_REPAIR).optional(),
      planningContractTail: z.literal(PLANNING_CONTRACT_TAIL).optional() }).refine(config => !config.planningContractTail ||
        (config.planCauseChoices === SOURCE_INDEXED_PLAN_CAUSES && config.planMeansChoices === SOURCE_INDEXED_PLAN_MEANS),
      "planning contract tail requires indexed causes and means"),
    children: [{ name: "batching", role: "work-batching" }, { name: "recovery", role: "output-recovery" }],
  }, (algorithmIdentity, config, children) => new TruthResolutionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("truth-resolution", "worklist-truth-resolution"),
    maturity: "candidate",
    configSchema: z.strictObject({ randomScheduling: z.literal(ORDERED_RANDOM_SCHEDULING),
      representation: z.literal(RESOLUTION_DEPENDENT_FIELDS_CODEC), promptVersion: z.literal(RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION),
      sourceInventory: z.literal(RESOLUTION_SOURCE_INVENTORY), planningPipeline: z.literal(WORKLIST_PLANNING_PIPELINE),
      pipelinePromptVersion: z.literal(WORKLIST_PLANNING_PROMPT_VERSION) }),
    children: [{ name: "batching", role: "work-batching" }, { name: "recovery", role: "output-recovery" }],
  }, (algorithmIdentity, config, children) => new TruthResolutionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("truth-resolution", "source-inventory-truth-resolution"),
    maturity: "candidate",
    configSchema: z.strictObject({ randomScheduling: z.literal(ORDERED_RANDOM_SCHEDULING),
      sourceInventory: z.literal(RESOLUTION_SOURCE_INVENTORY), mechanicalPlanRepair: z.literal(MECHANICAL_PLAN_REPAIR).optional() }),
    children: [{ name: "batching", role: "work-batching" }, { name: "recovery", role: "output-recovery" }],
  }, (algorithmIdentity, config, children) => new TruthResolutionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("truth-resolution", "dependent-fields-truth-resolution"),
    maturity: "candidate",
    configSchema: z.strictObject({ randomScheduling: z.literal(ORDERED_RANDOM_SCHEDULING),
      representation: z.literal(RESOLUTION_DEPENDENT_FIELDS_CODEC), promptVersion: z.literal(RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION),
      sourceInventory: z.literal(RESOLUTION_SOURCE_INVENTORY).optional() }),
    children: [{ name: "batching", role: "work-batching" }, { name: "recovery", role: "output-recovery" }],
  }, (algorithmIdentity, config, children) => new TruthResolutionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("truth-resolution", "ordered-rng-truth-resolution"),
    maturity: "candidate",
    configSchema: z.strictObject({ randomScheduling: z.literal(ORDERED_RANDOM_SCHEDULING) }),
    children: [{ name: "batching", role: "work-batching" }, { name: "recovery", role: "output-recovery" }],
  }, (algorithmIdentity, config, children) => new TruthResolutionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("work-batching", "shared-context-slot-batching"),
    version: "2",
    maturity: "reference",
    configSchema: z.strictObject({ maxSlots: positiveSlots,
      contextCodec: z.literal(SHARED_BATCH_CONTEXT_CODEC), promptVersion: z.literal(SHARED_BATCH_PROMPT_VERSION),
      requestContract: z.literal(TRUTH_BATCH_REQUEST_CONTRACT).optional(), repairPlacement: z.literal("tail-v1").optional() }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new WorkBatchingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("work-batching", "shared-state-first-slot-batching"),
    maturity: "reference",
    configSchema: z.strictObject({ maxSlots: positiveSlots,
      contextCodec: z.literal(SHARED_BATCH_ORDER_CODEC), promptVersion: z.literal(SHARED_BATCH_PROMPT_VERSION),
      requestContract: z.literal(TRUTH_BATCH_REQUEST_CONTRACT), repairPlacement: z.literal("tail-v1"),
      flushBoundary: z.literal("post-promise-v1").optional(),
      planRepairBatching: z.literal("scoped-plans-v1").optional(),
      planningPartition: z.literal("balanced-two-v1").optional(),
      contextLayout: z.literal(SHARED_STATE_FIRST_LAYOUT), jsonSyntaxRecovery: z.literal(UNMATCHED_CLOSER_RECOVERY) }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new WorkBatchingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("work-batching", "bounded-slot-batching"),
    maturity: "reference",
    configSchema: z.strictObject({ maxSlots: positiveSlots }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new WorkBatchingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("work-scheduling", "bounded-concurrency"),
    maturity: "reference",
    configSchema: z.strictObject({ maxConcurrent: positiveSlots }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new WorkSchedulingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("output-recovery", "localized-repair-bisect"),
    maturity: "reference",
    configSchema: z.strictObject({
      maxRepairs: z.number().int().min(0).max(8),
      exhaustion: z.literal("fail-step"),
      split: z.literal("bisect"),
    }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new OutputRecoveryAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("candidate-selection", "full-catalog"),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: noChildren,
  }, (algorithmIdentity, config, children) =>
    new CandidateSelectionAlgorithm(algorithmIdentity, config, children, undefined)),
  configuredDefinition({
    ...identity("candidate-ranking", "typed-channel-rrf"),
    maturity: "reference",
    configSchema: z.strictObject({
      encoderFingerprint: z.literal(RELATIONAL_RRF_ENCODER_FINGERPRINT),
      encoderModel: z.literal(RELATIONAL_RRF_ENCODER_MODEL_ID),
      graphDepth: z.literal(3),
      pseudoSeedCount: z.literal(16),
      channels: z.tuple([
        z.literal("identity"),
        z.literal("state"),
        z.literal("fact"),
        z.literal("temporal"),
      ]),
      passageSchemaVersion: z.literal(1),
      querySchemaVersion: z.literal(1),
      rrfSchemaVersion: z.literal(1),
    }),
    children: noChildren,
  }, (algorithmIdentity, config, children) =>
    new CandidateRankingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("candidate-allocation", "coverage-aware-joint-budget"),
    maturity: "reference",
    configSchema: z.strictObject({ compactKindRatio: z.literal(0.15) }),
    children: noChildren,
  }, (algorithmIdentity, config, children) =>
    new CandidateAllocationAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("candidate-selection", "relational-rrf", "2"),
    maturity: "reference",
    configSchema: z.strictObject({
      budgetRatio: z.literal(0.2),
      budgetPolicy: z.literal("mandatory-floor-v1"),
      cacheSchemaVersion: z.literal(1),
      dynamicPassageWrites: z.literal(true),
    }),
    children: [
      { name: "ranking", role: "candidate-ranking" },
      { name: "allocation", role: "candidate-allocation" },
    ],
    preflight: ({ services, ref }) => {
      candidateSelectionRuntime(services, ref as AlgorithmRef<"candidate-selection">);
    },
  }, (algorithmIdentity, config, children, services, ref) =>
    new CandidateSelectionAlgorithm(
      algorithmIdentity,
      config,
      children,
      candidateSelectionRuntime(services, ref),
    )),
  configuredDefinition({
    ...identity("symbol-repair", "bounded-symbol-repair"),
    maturity: "reference",
    configSchema: z.strictObject({
      mode: z.literal("auto"),
      policyVersion: z.literal("symbol-repair-v2"),
      maxDistance: z.literal(3),
      minDistanceMargin: z.literal(1),
      minPayloadLength: z.literal(8),
      allowAdjacentTransposition: z.literal(true),
      maxAuditCandidates: z.literal(8),
    }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new SymbolRepairAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("onset-perception", "model-onset-perception", "4"),
    maturity: "reference",
    configSchema: z.strictObject({ fallback: z.literal("global"), contextMode: z.literal("full"), ratingChoices: z.literal(PERCEPTION_RATING_CHOICES).optional() }),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new OnsetPerceptionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("reaction-decision", "model-reaction-decision"),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: noChildren,
  }, (algorithmIdentity, config, children) => new ReactionDecisionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("agent-cognition", "model-agent-cognition"),
    maturity: "reference",
    configSchema: z.strictObject({ externalUpdates: z.literal(false) }),
    children: [
      { name: "batching", role: "work-batching" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new AgentCognitionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("action-compilation", "model-action-compilation", "2"),
    maturity: "reference",
    configSchema: z.strictObject({
      candidateKeyVersion: z.literal(ACTION_COMPILATION_CANDIDATE_KEY_VERSION),
      candidateKeyPayloadLength: z.literal(ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH),
    }),
    children: [
      { name: "candidateSelection", role: "candidate-selection" },
      { name: "symbolRepair", role: "symbol-repair" },
      { name: "batching", role: "work-batching" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new ActionCompilationAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("action-compilation", "represented-action-compilation", "2"),
    maturity: "reference",
    configSchema: z.strictObject({
      representation: z.enum(["B1", "A", "T", "AT"]),
      eligibleProfileSchema: z.literal("batch-union-v1").optional(),
      descriptionPolicy: z.enum(["original-action-v1", "original-action-omitted-v2"]).optional(),
      profileChoiceEvidence: z.literal("visible-schema-v1").optional(),
      temporalContractSelection: z.literal("named-operators-v1").optional(),
      codecVersion: z.literal(ACTION_COMPILATION_REPRESENTATION_VERSION),
      promptVersion: z.string().min(1),
      candidateKeyVersion: z.literal(ACTION_COMPILATION_CANDIDATE_KEY_VERSION),
      candidateKeyPayloadLength: z.literal(ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH),
      aliasPolicy: z.literal("sorted-root-union-reserved-tail-exact-only"),
      temporalPolicy: z.literal("script-conditional-first-rest"),
    }),
    children: [
      { name: "candidateSelection", role: "candidate-selection" },
      { name: "symbolRepair", role: "symbol-repair" },
      { name: "batching", role: "work-batching" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new RepresentedActionCompilationAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("action-compilation", "constrained-action-compilation"),
    maturity: "candidate",
    configSchema: z.strictObject({ capabilities: z.boolean(), snapshots: z.boolean(),
      structuredOutputMode: z.enum(["json-object-zod", "json-schema-strict"]),
      codecVersion: z.literal(CONSTRAINED_COMPILATION_CODEC_VERSION), promptVersion: z.string().min(1),
      candidateKeyVersion: z.literal(ACTION_COMPILATION_CANDIDATE_KEY_VERSION),
      candidateKeyPayloadLength: z.literal(ACTION_COMPILATION_CANDIDATE_KEY_SUFFIX_LENGTH),
    }),
    children: [{ name: "candidateSelection", role: "candidate-selection" }, { name: "symbolRepair", role: "symbol-repair" },
      { name: "batching", role: "work-batching" }, { name: "recovery", role: "output-recovery" }],
  }, (algorithmIdentity, config, children) => new ConstrainedActionCompilationAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("interaction-grounding", "model-interaction-grounding"),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: [
      { name: "scheduling", role: "work-scheduling" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new InteractionGroundingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("reaction-resolution", "onset-reaction"),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: [
      { name: "onsetPerception", role: "onset-perception" },
      { name: "reactionDecision", role: "reaction-decision" },
      { name: "scheduling", role: "work-scheduling" },
      { name: "recovery", role: "output-recovery" },
    ],
  }),
  configuredDefinition({
    ...identity("truth-resolution", "model-truth-resolution"),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: [
      { name: "batching", role: "work-batching" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new TruthResolutionAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("observation-rendering", "model-observation-rendering", "2"),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: [
      { name: "batching", role: "work-batching" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new ObservationRenderingAlgorithm(algorithmIdentity, config, children)),
  configuredDefinition({
    ...identity("observation-rendering", "source-bound-observation-rendering", "2"),
    maturity: "reference",
    configSchema: z.strictObject({ evidenceLayout: z.literal(OBSERVATION_EVIDENCE_LAYOUT).optional(),
      claimEncoding: z.literal(OBSERVATION_CLAIM_ENCODING).optional() }).refine(config => !config.claimEncoding || Boolean(config.evidenceLayout),
      "unconfirmed claims require the observation evidence layout"),
    children: [
      { name: "batching", role: "work-batching" },
      { name: "recovery", role: "output-recovery" },
    ],
  }, (algorithmIdentity, config, children) => new ObservationRenderingAlgorithm(algorithmIdentity, config, children)),
] as const;

function configured(node: ResolvedAlgorithm | undefined, label: string): ConfiguredRoleAlgorithm {
  const implementation = node?.implementation as Partial<ConfiguredRoleAlgorithm> | undefined;
  if (!implementation || !implementation.config || !implementation.children) {
    throw new Error(`${label} did not resolve a configured algorithm implementation`);
  }
  return implementation as ConfiguredRoleAlgorithm;
}

function child(algorithm: ConfiguredRoleAlgorithm, slot: string): ConfiguredRoleAlgorithm {
  return configured(algorithm.children[slot], `${algorithm.algorithmIdentity.role}.${slot}`);
}

function batchLimit(algorithm: ConfiguredRoleAlgorithm): number {
  const batching = algorithm as Partial<WorkBatchingRoleAlgorithm>;
  if (!Number.isSafeInteger(batching.maxSlots) || Number(batching.maxSlots) < 1) {
    throw new Error(`${algorithm.algorithmIdentity.role}/${algorithm.algorithmIdentity.id} must expose a positive maxSlots capability`);
  }
  return Number(batching.maxSlots);
}

function concurrencyLimit(algorithm: ConfiguredRoleAlgorithm): number {
  const scheduling = algorithm as Partial<WorkSchedulingRoleAlgorithm>;
  if (!Number.isSafeInteger(scheduling.maxConcurrent) || Number(scheduling.maxConcurrent) < 1) {
    throw new Error(`${algorithm.algorithmIdentity.role}/${algorithm.algorithmIdentity.id} must expose a positive maxConcurrent capability`);
  }
  return Number(scheduling.maxConcurrent);
}

function recoveryPolicy(algorithm: ConfiguredRoleAlgorithm): Readonly<OutputRecoveryCapability> {
  const recovery = (algorithm as Partial<OutputRecoveryRoleAlgorithm>).policy;
  if (!recovery || !Number.isSafeInteger(recovery.maxRepairs) || recovery.maxRepairs < 0 ||
    recovery.exhaustion !== "fail-step" || typeof recovery.splitAt !== "function") {
    throw new Error(`${algorithm.algorithmIdentity.role}/${algorithm.algorithmIdentity.id} must expose a valid recovery capability`);
  }
  return recovery;
}

function eagerAlgorithms(children: Readonly<Record<string, ResolvedAlgorithm>>) {
  const actionCompilation = configured(children.actionCompilation, "actionCompilation");
  const agentCognition = configured(children.agentCognition, "agentCognition");
  const interactionGrounding = configured(children.interactionGrounding, "interactionGrounding");
  const reactionResolution = configured(children.reactionResolution, "reactionResolution");
  const truthResolution = configured(children.truthResolution, "truthResolution");
  const observationRendering = configured(children.observationRendering, "observationRendering");
  const candidateSelection = child(actionCompilation, "candidateSelection") as CandidateSelectionRoleAlgorithm;
  if (!("runtime" in candidateSelection)) {
    throw new Error("candidate-selection implementation must expose its selected runtime");
  }
  return { actionCompilation, agentCognition, interactionGrounding, reactionResolution, truthResolution, observationRendering, candidateSelection };
}

function eagerConfig(children: Readonly<Record<string, ResolvedAlgorithm>>): EagerReferenceAlgorithmConfig {
  const algorithms = eagerAlgorithms(children);
  const ranking = algorithms.candidateSelection.runtime
    ? child(algorithms.candidateSelection, "ranking") as CandidateRankingRoleAlgorithm
    : undefined;
  if (ranking && ranking.rankingVersion !== "typed-channel-rrf-v1") {
    throw new Error("candidate-ranking implementation is incompatible with relational candidate selection");
  }
  const candidateRetrieval = algorithms.candidateSelection.runtime
    ? {
        mode: "runtime" as const,
        runtimeVersion: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
        encoderFingerprint: String(ranking!.config.encoderFingerprint),
        budgetRatio: 0.2 as const,
      }
    : { mode: "off" as const };
  return {
    actionCompilationMaxSlots: batchLimit(child(algorithms.actionCompilation, "batching")),
    agentMindMaxSlots: batchLimit(child(algorithms.agentCognition, "batching")),
    reactionMaxSlots: concurrencyLimit(child(algorithms.reactionResolution, "scheduling")),
    groundingMaxSlots: concurrencyLimit(child(algorithms.interactionGrounding, "scheduling")),
    truthBatchMaxSlots: batchLimit(child(algorithms.truthResolution, "batching")),
    candidateRetrieval,
  };
}

function eagerComponents(
  children: Readonly<Record<string, ResolvedAlgorithm>>,
  services: Readonly<WorldExecutionAlgorithmServices>,
): EagerReferenceComponents {
  const algorithms = eagerAlgorithms(children);
  const agentCognition = algorithms.agentCognition as AgentCognitionRoleAlgorithm;
  const actionCompilation = algorithms.actionCompilation as ActionCompilationRoleAlgorithm;
  const interactionGrounding = algorithms.interactionGrounding as InteractionGroundingRoleAlgorithm;
  const truthResolution = algorithms.truthResolution as TruthResolutionRoleAlgorithm;
  const observationRendering = algorithms.observationRendering as ObservationRenderingRoleAlgorithm;
  if (typeof agentCognition.create !== "function" || typeof actionCompilation.compile !== "function" ||
    typeof interactionGrounding.ground !== "function" || typeof truthResolution.create !== "function" ||
    typeof observationRendering.create !== "function") {
    throw new Error("eager-reference composition resolved incompatible Role implementations");
  }
  const onsetPerception = child(algorithms.reactionResolution, "onsetPerception") as OnsetPerceptionRoleAlgorithm;
  const reactionDecision = child(algorithms.reactionResolution, "reactionDecision") as ReactionDecisionRoleAlgorithm;
  if (typeof onsetPerception.create !== "function" || typeof reactionDecision.create !== "function") {
    throw new Error("eager-reference reaction or candidate composition is incompatible");
  }
  const symbolRepair = child(algorithms.actionCompilation, "symbolRepair") as SymbolRepairRoleAlgorithm;
  if (!symbolRepair.policy) throw new Error("symbol-repair implementation must expose its policy");
  const rulePackages = services.rulePackages ?? createCoreRulePackageRegistry();
  const actionCompilationRecovery = recoveryPolicy(child(algorithms.actionCompilation, "recovery"));
  const interactionGroundingRecovery = recoveryPolicy(child(algorithms.interactionGrounding, "recovery"));
  const reactionRecovery = recoveryPolicy(child(algorithms.reactionResolution, "recovery"));
  const truthRecovery = recoveryPolicy(child(algorithms.truthResolution, "recovery"));
  const observationRecovery = recoveryPolicy(child(algorithms.observationRendering, "recovery"));
  const truthBatching = child(algorithms.truthResolution, "batching");
  const indexed = truthResolution.config.planningPipeline === INDEXED_REVIEWED_PLANNING_PIPELINE;
  const catalogProvider = truthResolution.config.planningCatalogEncoding === PLANNING_CATALOG_ENCODING
    ? planningCatalogEncodingProvider(services.provider) : services.provider;
  const planningProvider = indexed ? indexedReviewedPlanningProvider(catalogProvider, truthResolution.config.outcomeSummary === EVENT_OUTCOME_SUMMARIES,
    truthResolution.config.boundaryClockWitness === BOUNDARY_CLOCK_WITNESS, truthResolution.config.planCauseChoices === SOURCE_INDEXED_PLAN_CAUSES,
    truthResolution.config.planMeansChoices === SOURCE_INDEXED_PLAN_MEANS, truthResolution.config.planningContractTail === PLANNING_CONTRACT_TAIL,
    truthResolution.config.planningRelationChoices === PLANNING_RELATION_CHOICES, truthResolution.config.compactPlanningRecords === COMPACT_PLANNING_RECORDS)
    : truthResolution.config.planningPipeline === WORKLIST_PLANNING_PIPELINE ? worklistPlanningProvider(services.provider) : services.provider;
  const representedTruth = truthResolution.config.representation === RESOLUTION_DEPENDENT_FIELDS_CODEC
    ? dependentFieldsProvider(planningProvider) : planningProvider;
  const truthProvider = new TruthBatchCoordinator(
    withTruthRequestPolicy(representedTruth, {
      contextLayout: truthBatching.config.contextLayout as typeof SHARED_STATE_FIRST_LAYOUT | undefined,
      jsonSyntaxRecovery: truthBatching.config.jsonSyntaxRecovery as typeof UNMATCHED_CLOSER_RECOVERY | undefined,
    }),
    batchLimit(child(algorithms.truthResolution, "batching")),
    2,
    truthBatching.config.contextCodec as SharedBatchContext["codec"] | undefined,
    child(algorithms.truthResolution, "batching").config.requestContract as typeof TRUTH_BATCH_REQUEST_CONTRACT | undefined,
    child(algorithms.truthResolution, "batching").config.repairPlacement as "tail-v1" | undefined,
    truthBatching.config.flushBoundary as "post-promise-v1" | undefined,
    truthBatching.config.planRepairBatching as "scoped-plans-v1" | undefined,
    truthBatching.config.planningPartition as "balanced-two-v1" | undefined,
  );
  const observationProvider = new TruthBatchCoordinator(
    observationRendering.config.evidenceLayout === OBSERVATION_EVIDENCE_LAYOUT
      ? observationEvidenceProvider(services.provider, observationRendering.config.claimEncoding === OBSERVATION_CLAIM_ENCODING) : services.provider,
    batchLimit(child(algorithms.observationRendering, "batching")),
    2,
    child(algorithms.observationRendering, "batching").config.contextCodec as typeof SHARED_BATCH_CONTEXT_CODEC | undefined,
    child(algorithms.observationRendering, "batching").config.requestContract as typeof TRUTH_BATCH_REQUEST_CONTRACT | undefined,
    child(algorithms.observationRendering, "batching").config.repairPlacement as "tail-v1" | undefined,
  );
  return {
    provider: services.provider,
    agentCognition: agentCognition.create(
      services.provider,
      recoveryPolicy(child(agentCognition, "recovery")),
    ),
    actionCompilation: actionCompilation.compile,
    interactionGrounding: interactionGrounding.ground,
    onsetPerception: onsetPerception.create(services.provider, rulePackages, reactionRecovery),
    reactionDecision: reactionDecision.create(services.provider, reactionRecovery),
    truthResolution: truthResolution.create(indexed ? sourceIntentReviewProvider(truthProvider) : truthProvider, rulePackages, truthRecovery),
    orderedComponentRandom: truthResolution.config.randomScheduling === ORDERED_RANDOM_SCHEDULING,
    observationRendering: observationRendering.create(observationProvider, observationRecovery),
    symbolRepair: symbolRepair.policy,
    actionCompilationRecovery,
    interactionGroundingRecovery,
  };
}

export const FULL_CATALOG_ALGORITHM_REF: AlgorithmRef<"world-execution"> = createEagerReferenceAlgorithmRef(
  FULL_CATALOG_EAGER_REFERENCE_CONFIG,
);

export const DEFAULT_ALGORITHM_REF: AlgorithmRef<"world-execution"> = standardEagerReferenceAlgorithmRef();

export function eagerReferenceAlgorithmRef(
  config: Readonly<EagerReferenceAlgorithmConfig>,
): AlgorithmRef<"world-execution"> {
  return createEagerReferenceAlgorithmRef(config);
}

export function registerBuiltinAlgorithms(
  registry: WorldExecutionAlgorithmRegistry = new WorldExecutionAlgorithmRegistry(),
): WorldExecutionAlgorithmRegistry {
  if (registry.has(DEFAULT_ALGORITHM_REF)) return registry;
  for (const definition of definitions) registry.registerAlgorithmDefinition(definition);
  registry.registerDefinition({
    ...identity("world-execution", "eager-reference", "18", 7),
    maturity: "reference",
    configSchema: z.strictObject({}),
    children: [
      { name: "agentCognition", role: "agent-cognition" },
      { name: "actionCompilation", role: "action-compilation" },
      { name: "interactionGrounding", role: "interaction-grounding" },
      { name: "reactionResolution", role: "reaction-resolution" },
      { name: "truthResolution", role: "truth-resolution" },
      { name: "observationRendering", role: "observation-rendering" },
    ],
    create: ({ ref, children, services }) => {
      const config = eagerConfig(children);
      const algorithms = eagerAlgorithms(children);
      const candidateSelection = algorithms.candidateSelection;
      return new EagerReferenceAlgorithm(
        services.provider,
        services.rulePackages,
        config,
        candidateSelection.runtime,
        eagerComponents(children, services),
        algorithmManifest(ref as AlgorithmRef<"world-execution">),
      );
    },
  });
  if (!registry.has(DEFAULT_ALGORITHM_REF)) throw new Error("built-in eager-reference composition did not register");
  return registry;
}
