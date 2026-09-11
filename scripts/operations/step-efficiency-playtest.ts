import { PLANNING_CATALOG_ENCODING } from "../../src/engine/mechanics/planning-catalog-encoding";
import { MECHANICAL_PLAN_REPAIR } from "../../src/engine/mechanics/mechanical-plan-repair";
import { TRUTH_RESOLUTION_CONTRACT_VERSION } from "../../src/engine/algorithms/roles";
import { EVENT_OUTCOME_SUMMARIES } from "../../src/engine/mechanics/event-outcome-summaries";
import { BOUNDARY_CLOCK_WITNESS } from "../../src/engine/mechanics/boundary-clock-witness";
import { ORDERED_RANDOM_SCHEDULING } from "../../src/engine/mechanics/ordered-random-stream";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { PLANNING_CONTRACT_TAIL } from "../../src/engine/mechanics/planning-contract-tail";
import { RESOLUTION_SOURCE_INVENTORY, RESOLUTION_FACT_EVIDENCE } from "../../src/engine/contracts/resolution-source-inventory";
import { RESOLUTION_DEPENDENT_FIELDS_CODEC, RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION } from "../../src/engine/mechanics/resolution-dependent-fields-codec";
import { WORKLIST_PLANNING_PIPELINE, WORKLIST_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/worklist-planning-pipeline";
import { INDEXED_REVIEWED_PLANNING_PIPELINE, INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { SHARED_BATCH_PROMPT_VERSION, TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";
import { SHARED_BATCH_CONTEXT_CODEC, SHARED_BATCH_ORDER_CODEC } from "../../src/engine/mechanics/shared-batch-context";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { UNMATCHED_CLOSER_RECOVERY } from "../../src/engine/models/unmatched-closer-recovery";
import { createEagerReferenceAlgorithmRef } from "../../src/engine/algorithms/eager-reference/eager-reference";
import { firstPassAlgorithmRef } from "../../src/engine/benchmarks/action-compilation/first-pass-protocol";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E1_BUDGET, STEP_E1_PROTOCOL, orderedRandomAlgorithmRef, sharedContextAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import type { ModelConnectionEvent } from "../../src/engine/models/model-connector";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { FairModelScheduler } from "../../src/engine/models/model-scheduler";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { loadWorldScript } from "../../src/script/world-loader";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { installBundledWorlds } from "../../src/server/bundled-worlds";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";

import { FLASH41_COHORT, FLASH41_PRICE, STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { assertNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";
import { countDeepSeekContext } from "../experiments/deepseek-context-admission";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { assertTrajectorySourceReview } from "../../src/engine/benchmarks/step-efficiency/trajectory-source-review";
import { SOURCE_INDEXED_PLAN_CAUSES } from "../../src/engine/mechanics/source-indexed-plan-causes";
import { SOURCE_INDEXED_PLAN_MEANS } from "../../src/engine/mechanics/source-indexed-planning";
import { PLANNING_RELATION_CHOICES } from "../../src/engine/mechanics/planning-relation-choices";
import { COMPACT_PLANNING_RECORDS } from "../../src/engine/mechanics/compact-planning-records";
import { OBSERVATION_EVIDENCE_LAYOUT } from "../../src/engine/mechanics/observation-evidence-layout";
import { OBSERVATION_CLAIM_ENCODING } from "../../src/engine/mechanics/observation-claim-encoding";
import { PERCEPTION_RATING_CHOICES } from "../../src/engine/mechanics/perception-rating-choices";
import { PLAN_RANDOM_COMPLETION } from "../../src/engine/mechanics/plan-random-completion";
import type { CreateInstanceInput } from "../../src/shared/world-api";
import { runPlayerFeedbackAction, type PlayerFeedbackResult } from "./player-feedback-playtest";

export interface StepEfficiencyVariant {
  compactPlanningRecords?: true;
  mechanicalPlanRepair?: true;
  dataRoot: string; catalogPath: string; worldsRoot: string; manifestHash: string;
  groundingProfileId: string; label: string;
  playerScenario?: { start: Extract<CreateInstanceInput["start"], { kind: "origin" }>;
    actions: string[]; reactionPolicy: "keep" };
  nonthinkingBaseline?: true;
  modelCohort?: typeof FLASH41_COHORT.id;
  directTruthContext?: true;
  sourceInventory?: true;
  compilation?: "source-owned-visible-choice-v1";
  resolutionRepresentation?: typeof RESOLUTION_DEPENDENT_FIELDS_CODEC;
  truthTransport?: "shared-state-first-v1";
  observationRepairBatching?: true;
  truthFlushBoundary?: "post-promise-v1";
  planRepairBatching?: "scoped-plans-v1";
  planningPartition?: "balanced-two-v1";
  planCauseChoices?: true;
  planMeansChoices?: true;
  planningRelationChoices?: true;
  planFactEvidence?: true;
  planningContractTail?: true;
  perceptionRatingChoices?: true;
  planningCatalogEncoding?: true;
  planRandomCompletion?: true;
  sourceBoundObservations?: true;
  observationEvidenceLayout?: true;
  observationUnconfirmedClaims?: true;
  eventOutcomeSummaries?: true;
  boundaryClockWitness?: true;
  planningPipeline?: typeof WORKLIST_PLANNING_PIPELINE | typeof INDEXED_REVIEWED_PLANNING_PIPELINE;
  truthTransportReviews?: Array<{ trialId: string; reportHash: string; preflightHash: string;
    initialRequestEquivalence?: { historicalPhysicalRequestHash: string; currentPhysicalRequestHash: string;
      bodyHash: string; scope: "first-response-only" } }>;
  continuation?: { id: string; authorization: string; deadlineUtc: string };
  admissionEvidence?: { trialId: string; reportHash: string; preflightHash: string };
  resolutionAdmissionEvidence?: { trialId: string; reportHash: string; preflightHash: string };
}

export function stepEfficiencyAlgorithmRef(variant?: Pick<StepEfficiencyVariant, "compactPlanningRecords" | "planningRelationChoices" | "mechanicalPlanRepair" | "directTruthContext" | "sourceInventory" | "compilation" | "resolutionRepresentation" | "truthTransport" | "planningPipeline" | "observationRepairBatching" | "truthFlushBoundary" | "planRepairBatching" | "planningPartition" | "planCauseChoices" | "planMeansChoices" | "planFactEvidence" | "planningContractTail" | "planningCatalogEncoding" | "perceptionRatingChoices" | "planRandomCompletion" | "sourceBoundObservations" | "observationEvidenceLayout" | "observationUnconfirmedClaims" | "eventOutcomeSummaries" | "boundaryClockWitness">) {
  if (variant?.compactPlanningRecords && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("compact planning records require the indexed reviewed pipeline");
  if (variant?.planningRelationChoices && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("planning relation choices require the indexed reviewed pipeline");
  if (variant?.mechanicalPlanRepair && (!variant.sourceInventory || (variant.resolutionRepresentation && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE))) throw new Error("mechanical plan repair requires source inventory and the indexed pipeline when represented");
  if (variant?.planRandomCompletion && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("plan random completion requires the indexed reviewed pipeline");
  if (variant?.planningCatalogEncoding && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("planning catalog encoding requires the indexed reviewed pipeline");
  if (variant?.observationUnconfirmedClaims && !variant.observationEvidenceLayout) throw new Error("unconfirmed claims require observation evidence layout");
  if (variant?.observationEvidenceLayout && !variant.sourceBoundObservations) throw new Error("observation evidence layout requires source-bound observation rendering");
  if (variant?.planningContractTail && (!variant.planCauseChoices || !variant.planMeansChoices)) throw new Error("planning contract tail requires indexed causes and means");
  if (variant?.planFactEvidence && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("plan fact evidence requires the indexed reviewed pipeline");
  if (variant?.planMeansChoices && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("plan means positions require the indexed reviewed pipeline");
  if (variant?.planCauseChoices && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("plan cause choices require the indexed reviewed pipeline");
  if (variant?.planRepairBatching && !variant.truthTransport) throw new Error("scoped plan repair batching requires the reviewed shared transport");
  if (variant?.planningPartition && !variant.truthTransport) throw new Error("balanced planning requires the reviewed shared transport");
  if (variant?.boundaryClockWitness && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("boundary clock witness requires the indexed reviewed pipeline");
  if (variant?.eventOutcomeSummaries && variant.planningPipeline !== INDEXED_REVIEWED_PLANNING_PIPELINE) throw new Error("event outcome summaries require the indexed reviewed pipeline");
  if (variant?.truthFlushBoundary && !variant.truthTransport) throw new Error("post-promise truth batching requires the reviewed shared transport");
  if (variant?.planningPipeline && (!variant.sourceInventory || !variant.resolutionRepresentation || !variant.truthTransport)) throw new Error("worklist planning requires its complete source, representation and transport foundation");
  if (variant?.truthTransport && !variant.resolutionRepresentation) throw new Error("reviewed truth transport requires the dependent representation");
  const control = createEagerReferenceAlgorithmRef();
  const compilationRef = variant?.compilation === "source-owned-visible-choice-v1"
    ? firstPassAlgorithmRef(control, "AT", true, true, true)
    : firstPassAlgorithmRef(control, "T");
  let base = orderedRandomAlgorithmRef(variant?.directTruthContext
    ? compilationRef : sharedContextAlgorithmRef(compilationRef));
  if (variant?.perceptionRatingChoices) {
    const reactionResolution = base.children.reactionResolution!;
    const onsetPerception = reactionResolution.children.onsetPerception!;
    base = defineAlgorithmRef({ ...base, children: { ...base.children,
      reactionResolution: defineAlgorithmRef({ ...reactionResolution, children: { ...reactionResolution.children,
        onsetPerception: defineAlgorithmRef({ ...onsetPerception, config: { ...onsetPerception.config, ratingChoices: PERCEPTION_RATING_CHOICES } }),
      } }),
    } });
  }
  if (variant?.observationRepairBatching) {
    const observationRendering = base.children.observationRendering!;
    const batching = observationRendering.children.batching!;
    if (batching.config.contextCodec !== SHARED_BATCH_CONTEXT_CODEC) throw new Error("observation repair batching requires the shared observation context codec");
    base = defineAlgorithmRef({ ...base, children: { ...base.children,
      observationRendering: defineAlgorithmRef({ ...observationRendering, children: { ...observationRendering.children,
        batching: defineAlgorithmRef({ ...batching, config: { ...batching.config,
          requestContract: TRUTH_BATCH_REQUEST_CONTRACT, repairPlacement: "tail-v1" } }),
      } }),
    } });
  }
  if (variant?.sourceBoundObservations) base = defineAlgorithmRef({ ...base, children: { ...base.children,
    observationRendering: defineAlgorithmRef({ ...base.children.observationRendering!, id: "source-bound-observation-rendering",
      config: { ...base.children.observationRendering!.config,
        ...(variant.observationEvidenceLayout ? { evidenceLayout: OBSERVATION_EVIDENCE_LAYOUT } : {}),
        ...(variant.observationUnconfirmedClaims ? { claimEncoding: OBSERVATION_CLAIM_ENCODING } : {}) } }),
  } });
  if (!variant?.sourceInventory && !variant?.resolutionRepresentation) return base;
  const original = base.children.truthResolution!;
  const batching = original.children.batching!;
  const children = variant.resolutionRepresentation ? { ...original.children, batching: defineAlgorithmRef({ ...batching,
    ...(variant.truthTransport ? { id: "shared-state-first-slot-batching", version: "1" } : {}),
    config: { ...batching.config, requestContract: TRUTH_BATCH_REQUEST_CONTRACT, repairPlacement: "tail-v1",
      ...(variant.truthTransport ? { contextCodec: SHARED_BATCH_ORDER_CODEC, promptVersion: SHARED_BATCH_PROMPT_VERSION,
        contextLayout: SHARED_STATE_FIRST_LAYOUT, jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY,
        ...(variant.truthFlushBoundary ? { flushBoundary: variant.truthFlushBoundary } : {}),
        ...(variant.planRepairBatching ? { planRepairBatching: variant.planRepairBatching } : {}),
        ...(variant.planningPartition ? { planningPartition: variant.planningPartition } : {}) } : {}) } }) } : original.children;
  const truthResolution = defineAlgorithmRef({ role: "truth-resolution",
    id: variant.planningPipeline === INDEXED_REVIEWED_PLANNING_PIPELINE ? "indexed-reviewed-truth-resolution"
      : variant.planningPipeline ? "worklist-truth-resolution" : variant.resolutionRepresentation ? "dependent-fields-truth-resolution" : "source-inventory-truth-resolution", version: variant.planningPipeline === INDEXED_REVIEWED_PLANNING_PIPELINE ? "5" : "1", contractVersion: TRUTH_RESOLUTION_CONTRACT_VERSION,
    config: { randomScheduling: ORDERED_RANDOM_SCHEDULING, ...(variant.sourceInventory ? { sourceInventory: RESOLUTION_SOURCE_INVENTORY } : {}),
      ...(variant.resolutionRepresentation ? { representation: RESOLUTION_DEPENDENT_FIELDS_CODEC, promptVersion: RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION } : {}),
      ...(variant.eventOutcomeSummaries ? { outcomeSummary: EVENT_OUTCOME_SUMMARIES } : {}),
      ...(variant.boundaryClockWitness ? { boundaryClockWitness: BOUNDARY_CLOCK_WITNESS } : {}),
      ...(variant.planCauseChoices ? { planCauseChoices: SOURCE_INDEXED_PLAN_CAUSES } : {}),
      ...(variant.planMeansChoices ? { planMeansChoices: SOURCE_INDEXED_PLAN_MEANS } : {}),
      ...(variant.planningRelationChoices ? { planningRelationChoices: PLANNING_RELATION_CHOICES } : {}),
      ...(variant.compactPlanningRecords ? { compactPlanningRecords: COMPACT_PLANNING_RECORDS } : {}),
      ...(variant.planFactEvidence ? { planFactEvidence: RESOLUTION_FACT_EVIDENCE } : {}),
      ...(variant.planningCatalogEncoding ? { planningCatalogEncoding: PLANNING_CATALOG_ENCODING } : {}),
      ...(variant.planRandomCompletion ? { planRandomCompletion: PLAN_RANDOM_COMPLETION } : {}),
      ...(variant.mechanicalPlanRepair ? { mechanicalPlanRepair: MECHANICAL_PLAN_REPAIR } : {}),
      ...(variant.planningContractTail ? { planningContractTail: PLANNING_CONTRACT_TAIL } : {}),
      ...(variant.planningPipeline ? { planningPipeline: variant.planningPipeline,
        pipelinePromptVersion: variant.planningPipeline === INDEXED_REVIEWED_PLANNING_PIPELINE ? INDEXED_REVIEWED_PLANNING_PROMPT_VERSION : WORKLIST_PLANNING_PROMPT_VERSION } : {}) },
    children });
  return defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution } });
}

/** Stop future dispatch while an awaited WorldHost advance drains its active HTTP. */
export async function withStepEfficiencyDeadline<T>(task: () => Promise<T>, onDeadline: () => void, timeoutMs = 20 * 60_000): Promise<T> {
  const timer = setTimeout(onDeadline, timeoutMs);
  try { return await task(); }
  finally { clearTimeout(timer); }
}

export function assertNonthinkingRunCapacity(knownNanoCny: number, activeHttp: number, dispatches: number) {
  const maximumRequest = STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken;
  if (dispatches >= 200 || knownNanoCny + (activeHttp + 1) * maximumRequest > 150_000_000_000) throw new Error("E2 trajectory run cap reached before dispatch");
}

/** Native SIGILL bypasses finally; reject the reproduced profiler/encoder combination before spending. */
export function assertStepEfficiencyInstrumentation(
  args: readonly string[] = process.execArgv, platform: string = process.platform, architecture: string = process.arch,
): void {
  if (platform === "darwin" && architecture === "arm64" && args.some(arg => /^--cpu-prof(?:=true)?$/u.test(arg))) {
    throw new Error("V8 CPU profiling is incompatible with this local ARM encoder workload; run without --cpu-prof and use external sampling");
  }
}

export async function runStepEfficiencyPlaytest(variant?: StepEfficiencyVariant): Promise<void> {
  assertStepEfficiencyInstrumentation();
  const nonthinking = variant?.nonthinkingBaseline === true;
  if (variant?.modelCohort && (!nonthinking || variant.modelCohort !== FLASH41_COHORT.id)) throw new Error("unsupported model cohort");
  const cohort = variant?.modelCohort ? FLASH41_COHORT : undefined;
  const protocol = nonthinking ? { ...STEP_E1_PROTOCOL, ...STEP_E2_PROTOCOL,
    ...(cohort ? { model: cohort.model, officialVersion: cohort.officialVersion } : {}), deadlineUtc: null } : STEP_E1_PROTOCOL;
  const budgetPolicy = nonthinking ? STEP_E2_BUDGET : STEP_E1_BUDGET;
  if (variant?.playerScenario && (!nonthinking || variant.playerScenario.actions.length !== protocol.targetConsecutiveSteps ||
    variant.playerScenario.actions.some(text => !text.trim() || text !== text.trim() || text.length > 4000) ||
    variant.playerScenario.reactionPolicy !== "keep")) throw new Error("player scenario requires three frozen actions and explicit keep reactions");
  const trialPattern = nonthinking ? /^(discovery|trajectory|confirmation)-e2-\d{2}$/u : /^(discovery|trajectory|confirmation)-e1-\d{2}$/u;
  const [command, trialId, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || !trialId || extra.length ||
    !trialPattern.test(trialId)) {
    throw new Error("usage: step-efficiency-playtest.ts prepare|run <discovery|trajectory|confirmation>-<e1|e2>-NN; family must match its launcher");
  }
  const phase = trialId.startsWith("discovery-") ? "discovery" : trialId.startsWith("trajectory-") ? "trajectory" : "confirmation";
  const root = path.resolve(protocol.root);
  const directory = path.join(root, "runs", trialId);
  const dataRoot = path.resolve(variant?.dataRoot ?? process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23");
  const algorithmRef = stepEfficiencyAlgorithmRef(variant);
  const deadlineUtc = nonthinking ? null : variant?.continuation?.deadlineUtc ?? protocol.deadlineUtc;
  const deadlineReached = () => deadlineUtc !== null && Date.now() >= Date.parse(deadlineUtc);
  if ((deadlineUtc !== null && !Number.isFinite(Date.parse(deadlineUtc))) || (variant?.continuation &&
    (!variant.continuation.id.trim() || !variant.continuation.authorization.trim()))) throw new Error("invalid continuation binding");
  const catalog = loadModelCatalog(path.resolve(variant?.catalogPath ?? process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const retrieval = createActionCompilationRetrievalRuntimeProvider();
  const preparedWorld = variant ? loadWorldScript(path.join(variant.worldsRoot, "blackmarsh/world"),
    { seed: protocol.seed, modelCatalog: catalog }) : undefined;
  if (nonthinking && (!preparedWorld || !variant)) throw new Error("E2 requires a frozen full-world variant");
  if (nonthinking) assertNonthinkingWorld(preparedWorld!, catalog, protocol.model);
  if (preparedWorld) await retrieval.preflight(algorithmRef,
    { worldContentHash: preparedWorld.contentHash, state: preparedWorld.initialState });
  const account = catalog.accounts["deepseek-api"];
  if (!account || !process.env[account.api_key_env]?.trim()) throw new Error("configured DeepSeek credential is unavailable to this process");
  if (deadlineReached()) throw new Error("experiment deadline has passed");
  const preparedRegistry = new ModelRegistry(catalog, dataRoot);
  const registrySnapshot = await preparedRegistry.capture();
  const profileBindings = Object.entries(catalog.profiles).filter(([, profile]) => profile.account_id === "deepseek-api")
    .map(([profileId]) => {
      const binding = resolveModelProfile(catalog, registrySnapshot, profileId);
      if (binding.modelId !== protocol.model || (nonthinking && binding.profile.inference.thinking !== "disabled")) throw new Error("experiment model binding drift");
      return { profileId, accountId: binding.accountId, modelId: binding.modelId,
        ...(binding.profile.response_transport ? { responseTransport: binding.profile.response_transport } : {}),
        metadataHash: binding.modelMetadataHash, inference: binding.profile.inference };
    });
  if (new Set(profileBindings.map(binding => binding.responseTransport)).size > 1) {
    throw new ModelConfigurationError("one experiment account must use one frozen response transport");
  }
  const responseTransport = profileBindings[0]?.responseTransport;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const contextAdmission = nonthinking ? await countDeepSeekContext({ model: protocol.model, thinking: { type: "disabled" },
    response_format: { type: "json_object" }, max_tokens: protocol.outputTokenCeiling,
    messages: [{ role: "system", content: "" }, { role: "user", content: "" }] }) : undefined;
  const manifest = { trialId, phase, commit, ...(contextAdmission ? { contextAdmission: {
    tokenizerSha256: contextAdmission.tokenizerSha256, counterHash: contextAdmission.counterHash,
    runtimeVersion: contextAdmission.runtimeVersion, protocolAllowance: contextAdmission.protocolAllowance,
    contextWindow: contextAdmission.contextWindow } } : {}), dataRoot, algorithmRef, catalogHash: catalog.hash,
    connectionPolicy: { maxSocketSetupAttempts: account.network?.socket_connect_attempts ?? 1,
      retriesAfterSocketHandoff: 0, maxHttpTransportAttempts: 1 },
    registrySnapshotHash: registrySnapshot.hash, profileBindings, ...(variant ? { variant } : {}),
    ...(preparedWorld ? { retrievalPreflight: { worldHash: preparedWorld.contentHash,
      stateHash: contentHash(preparedWorld.initialState), ready: true } } : {}),
    ...(variant?.continuation ? { continuation: variant.continuation, continuationHash: contentHash(variant.continuation) } : {}),
    protocol, protocolHash: contentHash(protocol), budgetHash: contentHash(budgetPolicy),
    ...(cohort ? { modelCohort: cohort, modelCohortHash: contentHash(cohort), priceHash: contentHash(FLASH41_PRICE) } : {}),
    worldId: "blackmarsh", seed: protocol.seed, targetSteps: protocol.targetConsecutiveSteps,
    ...(nonthinking ? { runLimits: { maximumNanoCny: 150_000_000_000, maxHttp: 200,
      reviewAfterEveryCommit: !variant?.playerScenario, reviewBeforeNextPlayerAction: Boolean(variant?.playerScenario) },
      ...(variant?.playerScenario ? { playerMeasurement: { pollMs: 250, targetActions: variant.playerScenario.actions.length,
        timing: "Submission to first persisted feedback and to action-run completion; review gaps between actions excluded" } } : {}),
      interpretation: "Current non-thinking production foundation includes source-faithful reference projection and deterministic temporal/early-validation guardrails. This does not certify model semantic improvement. All commits require independent source review and still do not establish fresh confirmation or browser usability." } : {}),
    design: "Frozen engineering exploration; no automatic resampling, first terminal failure stops the trajectory." };
  if (deadlineReached()) throw new Error("experiment deadline has passed");
  const connectionEvents: Array<ModelConnectionEvent & { accountId: string }> = [];
  const network = createModelFetchResolver(process.env, {
    onConnectionEvent: (event) => connectionEvents.push(event) });
  const accountFetch = network("deepseek-api", account) ?? fetch;
  if (command === "run" && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked code before full-world diagnostic");
  const preflight = await accountFetch(account.base_url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  if (preflight.status !== 401) throw new Error(`unexpected unauthenticated preflight status ${preflight.status}`);
  if (command === "prepare") {
    preparedRegistry.stopBackgroundRefresh();
    console.log(JSON.stringify({ ...manifest, preflight: preflight.status, connectionEvents }, null, 2));
    return;
  }

  if (existsSync(directory)) throw new Error("frozen trial cannot restart");
  mkdirSync(directory, { recursive: true });
  const lock = path.join(root, "writer.lock");
  closeSync(openSync(lock, "wx"));
  let database: LocalDatabase | undefined;
  let registry: ModelRegistry | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let status = "preparing";
  let failure: string | undefined;
  let instanceId: string | undefined;
  let stopRequested: string | undefined;
  let activeHttp = 0;
  const startedAt = new Date().toISOString();
  const commits: Array<{ revision: number; step: number; elapsedMs: number; timeAdvanceSeconds: number; truthHash: string; replayHash: string }> = [];
  const playerActions: PlayerFeedbackResult[] = [];
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), budgetPolicy);
  const runCostStart = budget.summary.estimatedPeakNanoCny;
  let runDispatches = 0;
  let contextChecks = 0;
  let transport: FirstPassExperimentTransport | undefined;
  const stop = () => { stopRequested ??= "operator interrupted the experiment"; };
  const report = () => {
    const document = instanceId && database ? database.readInstance(instanceId).document : undefined;
    const summary = { ...manifest, startedAt, updatedAt: new Date().toISOString(), status, failure, stopRequested,
      instanceId, worldHash: document?.state.worldHash, revision: document?.state.revision, step: document?.state.step,
      entities: document ? Object.keys(document.state.truth.entities).length : undefined,
      agents: document ? Object.keys(document.state.agents).length : undefined,
      run: document ? Object.values(document.runs).at(-1) : undefined, commits, playerActions,
      networkConnections: { attempts: connectionEvents.filter((event) => event.status === "started").length,
        secondAttempts: connectionEvents.filter((event) => event.status === "started" && event.attempt === 2).length,
        failures: connectionEvents.filter((event) => event.status === "failed").length,
        established: connectionEvents.filter((event) => event.status === "connected").length },
      budget: budget.summary, httpScheduling: "provider", activeHttp, transportStopReason: transport?.stopReason };
    writeFileSync(path.join(directory, "connection-events.json"), JSON.stringify(connectionEvents, null, 2));
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ trialId, status, instanceId, revision: summary.revision, step: summary.step,
      runStatus: summary.run?.status, http: budget.summary.phases[phase].httpRequests,
      estimatedPeakCny: budget.summary.estimatedPeakNanoCny / 1e9,
      unknown: budget.summary.unknown.length, activeHttp, failure, stopRequested }));
  };
  try {
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" });
    if (budget.summary.blockingUnknown.length) throw new Error("unreviewed unknown billing blocks further model calls");
    if (cohort && contentHash(budget.price(cohort.priceId)) !== contentHash(FLASH41_PRICE)) throw new Error("register the documented cohort price before dispatch");
    if (nonthinking) {
      budget.assertRunCapacity(phase, 150_000_000_000);
    }
    transport = new FirstPassExperimentTransport(budget, {
      root, baseUrl: account.base_url, inputTokenCeiling: protocol.inputTokenCeiling,
      outputTokenCeiling: protocol.outputTokenCeiling, fetch: accountFetch,
      trialPattern, requireThinkingDisabled: nonthinking, allowLowerOutputLimit: true, scheduling: "provider",
      ...(responseTransport ? { responseTransport } : {}),
      priceBinding: { accountId: "deepseek-api", modelId: protocol.model, priceId: cohort?.priceId ?? "flash" },
    });
    transport.beginTrial(trialId, phase);
    registry = preparedRegistry;
    const provider = createModelGateway(catalog, process.env, {
      registry: { capture: async (hash) => hash ? preparedRegistry.snapshot(hash) : registrySnapshot,
        catalog, refresh: (options) => preparedRegistry.refresh(options), status: () => preparedRegistry.status() },
      maxTransportAttempts: 1,
      scheduler: new FairModelScheduler({ globalConcurrency: protocol.maxConcurrent,
        maxQueuedRequests: 1024, queueTimeoutMs: 20 * 60_000,
        providerConcurrency: { "deepseek-api": protocol.maxConcurrent } }),
      fetchForAccount: (id) => async (input, init) => {
        if (id !== "deepseek-api") throw new Error(`unapproved experiment account: ${id}`);
        if (deadlineReached()) stopRequested ??= "experiment deadline reached";
        if (stopRequested) throw new Error(stopRequested);
        if (nonthinking) {
          // Account for requests that have entered transport but have not yet
          // reserved usage; transport reads the body asynchronously.
          assertNonthinkingRunCapacity(budget.summary.estimatedPeakNanoCny - runCostStart, activeHttp, runDispatches);
          const contextCheck = ++contextChecks;
          const countingStarted = performance.now();
          try {
            const admission = await countDeepSeekContext(JSON.parse(String(init?.body)));
            if (admission.counterHash !== contextAdmission!.counterHash) throw new ModelConfigurationError("frozen context counter changed");
            if (stopRequested) throw new ModelConfigurationError(stopRequested);
            // Admission yielded: another request may have consumed capacity or stopped the run.
            assertNonthinkingRunCapacity(budget.summary.estimatedPeakNanoCny - runCostStart, activeHttp, runDispatches);
            writeFileSync(path.join(directory, `http-context-${contextCheck}.json`), JSON.stringify({ ...admission,
              dispatchOrdinal: runDispatches + 1,
              countingElapsedMs: performance.now() - countingStarted }, null, 2), { flag: "wx" });
          } catch (error) {
            stopRequested = error instanceof Error ? error.message : String(error);
            writeFileSync(path.join(directory, `http-context-failure-${contextCheck}.json`), JSON.stringify({
              error: stopRequested, newHttpDispatched: false, countingElapsedMs: performance.now() - countingStarted }, null, 2));
            throw new ModelConfigurationError(stopRequested, { cause: error });
          }
        }
        runDispatches += 1;
        activeHttp += 1;
        try { return await transport!.fetch(input, init); }
        finally { activeHttp -= 1; }
      },
    });
    if (variant && !nonthinking) {
      const generate = provider.generateStructured.bind(provider);
      provider.generateStructured = (request) => {
        const grounding = ["action-compilation", "action-grounding"].includes(request.role);
        if (grounding !== (request.profileId === variant.groundingProfileId)) throw new Error("logical role/profile differs from frozen grounding variant");
        return generate(request);
      };
    }
    database = new LocalDatabase(path.join(dataRoot, "livingworld.sqlite"));
    const host = new WorldHost({ repository: database, store: database, ledger: database, provider,
      actionCompilationRetrievalProvider: retrieval,
      defaultAlgorithmRef: algorithmRef, idFactory: randomUUID });
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    timer = setInterval(report, 10_000);
    installBundledWorlds(database, provider.catalog, variant?.worldsRoot);
    const loadedWorld = database.load("blackmarsh", protocol.seed, provider.catalog);
    if (preparedWorld && loadedWorld.contentHash !== preparedWorld.contentHash) throw new Error("persisted world differs from retrieval preflight");
    if (variant && loadedWorld.modelProfiles.grounding !== variant.groundingProfileId) throw new Error("persisted world grounding profile differs from the frozen variant");
    status = "creating";
    report();
    const instance = await host.createInstance({ worldId: "blackmarsh", seed: protocol.seed,
      title: `${protocol.id} ${trialId}`, start: variant?.playerScenario?.start ?? { kind: "observer" } }, "local", algorithmRef);
    instanceId = instance.summary.id;
    const initial = database.readInstance(instanceId).document;
    writeFileSync(path.join(directory, "instance-binding.json"), JSON.stringify({ instanceId,
      worldHash: initial.state.worldHash, modelProfiles: loadedWorld.modelProfiles, catalogHash: catalog.hash,
      registrySnapshotHash: registrySnapshot.hash, profileBindings, algorithmRef }, null, 2), { flag: "wx" });
    const source = loadedWorld.initialState;
    if (Object.keys(source.agents).length !== 48 || Object.keys(source.truth.entities).length !== 232 ||
      Object.keys(source.agents).some(id => !initial.state.agents[id]) ||
      Object.keys(source.truth.entities).some(id => !initial.state.truth.entities[id]) ||
      Object.keys(initial.state.agents).length !== 48 + (variant?.playerScenario ? 1 : 0) ||
      (!variant?.playerScenario && Object.keys(initial.state.truth.entities).length !== 232)) {
      throw new Error("frozen full-world fixture cardinality changed");
    }
    status = "running";
    report();
    if (variant?.playerScenario) {
      const participant = instance.participants[0];
      if (instance.participants.length !== 1 || !participant) throw new Error("player scenario needs exactly one controlled participant");
      for (const [index, text] of variant.playerScenario.actions.entries()) {
        if (stopRequested) throw new Error(stopRequested);
        const checkpoints: Array<{ step: number; sourceStateHash: string; checkpointStateHash: string;
          actions: typeof initial.state.history[number]["actions"]; evidence: Parameters<typeof assertTrajectorySourceReview>[1]["evidence"] }> = [];
        const result = await withStepEfficiencyDeadline(() => runPlayerFeedbackAction({ host, instanceId: instanceId!,
          participantId: participant.id, submissionId: `${trialId}-action-${index + 1}`, text,
          read: () => database!.readInstance(instanceId!).document, stopReason: () => stopRequested,
          onStop: reason => { stopRequested ??= reason; },
          onUpdate: result => { playerActions[index] = structuredClone(result); report(); },
          onCheckpoint: (evidence, observedElapsedMs) => {
            const { source, checkpoint, committed } = evidence;
            const previousElapsedMs = playerActions[index]?.feedback.at(-1)?.observedElapsedMs ?? 0;
            const truthHash = contentHash(checkpoint.truth);
            commits.push({ revision: checkpoint.revision, step: checkpoint.step,
              elapsedMs: observedElapsedMs - previousElapsedMs,
              timeAdvanceSeconds: committed.temporalBoundary.toElapsedSeconds - committed.temporalBoundary.fromElapsedSeconds,
              truthHash, replayHash: truthHash });
            const actions = [...committed.initialActions, ...committed.actions.filter(action => !committed.initialActions.some(initial => initial.id === action.id))];
            const binding = { step: checkpoint.step, sourceStateHash: contentHash(source), checkpointStateHash: contentHash(checkpoint), actions };
            writeFileSync(path.join(directory, `step-${binding.step}-evidence.json`), JSON.stringify({ ...binding, ...evidence }), { flag: "wx" });
            checkpoints.push({ ...binding, evidence });
          },
        }), () => { stopRequested ??= "player action exceeded twenty minutes; draining active HTTP"; });
        if (result.status !== "completed") throw new Error(result.failure ?? "player action did not complete");
        status = "awaiting-source-review"; report();
        for (const checkpoint of checkpoints) {
          const reviewFile = path.join(directory, `step-${checkpoint.step}-review.json`);
          while (!existsSync(reviewFile)) {
            if (stopRequested) throw new Error(stopRequested);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          assertTrajectorySourceReview(JSON.parse(readFileSync(reviewFile, "utf8")), checkpoint);
        }
        status = "running"; report();
      }
      status = "three-player-actions-source-reviewed-confirmation-still-required";
      return;
    }
    while (database.readInstance(instanceId).document.state.step < protocol.targetConsecutiveSteps) {
      if (stopRequested) throw new Error(stopRequested);
      const before = database.readInstance(instanceId).document.state;
      const started = Date.now();
      const stepInstanceId = instanceId;
      await withStepEfficiencyDeadline(
        () => host.advance(stepInstanceId, { expectedRevision: before.revision, trigger: "batch", steps: 1 }),
        () => { stopRequested ??= "step exceeded twenty minutes; draining active HTTP"; },
      );
      for (;;) {
        const document = database.readInstance(instanceId).document;
        const run = Object.values(document.runs).at(-1);
        if (run && ["failed", "preparation-invalidated", "budget-paused", "paused", "awaiting-decision"].includes(run.status)) {
          throw new Error(run.error ?? run.stopReason ?? run.status);
        }
        if (document.state.revision > before.revision && run && !["queued", "running", "pausing"].includes(run.status)) {
          const entry = document.state.history.at(-1);
          const advances = entry?.operations.filter((operation) => operation.kind === "advance_time") ?? [];
          if (document.state.revision !== before.revision + 1 || document.state.step !== before.step + 1 ||
            entry?.revision !== document.state.revision || entry.step !== document.state.step ||
            advances.length !== 1 || advances[0]!.seconds <= 0) throw new Error("canonical step acceptance failed");
          const truthHash = contentHash(document.state.truth);
          const replayHash = contentHash(replaySimulationState(document.state).truth);
          if (truthHash !== replayHash) throw new Error("durable canonical replay diverged");
          commits.push({ revision: document.state.revision, step: document.state.step,
            elapsedMs: Date.now() - started, timeAdvanceSeconds: advances[0]!.seconds, truthHash, replayHash });
          report();
          if (nonthinking) {
            const sourceStateHash = contentHash(before), checkpointStateHash = contentHash(document.state);
            const actions = [...entry.initialActions, ...entry.actions.filter((action) => !entry.initialActions.some((initial) => initial.id === action.id))];
            const binding = { step: document.state.step, sourceStateHash, checkpointStateHash, actions };
            writeFileSync(path.join(directory, `step-${binding.step}-evidence.json`), JSON.stringify({ ...binding, source: before, checkpoint: document.state, committed: entry }), { flag: "wx" });
            status = "awaiting-source-review";report();
            const reviewFile = path.join(directory, `step-${binding.step}-review.json`);
            while (!existsSync(reviewFile)) {
              if (stopRequested) throw new Error(stopRequested);
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            assertTrajectorySourceReview(JSON.parse(readFileSync(reviewFile, "utf8")), { ...binding, evidence: { source: before, checkpoint: document.state, committed: entry } });
            status = "running";report();
          }
          break;
        }
        if (Date.now() - started > 20 * 60_000) stopRequested ??= "step exceeded twenty minutes; draining active HTTP";
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    status = nonthinking ? "three-commits-source-reviewed-confirmation-still-required" : "passed-three-steps";
  } catch (error) {
    status = "stopped";
    failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    if (timer) clearInterval(timer);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    // Engine failure drains component work; preserve unresolved reservations if an external send failed.
    while (activeHttp) await new Promise((resolve) => setTimeout(resolve, 100));
    report();
    database?.close();
    registry?.stopBackgroundRefresh();
    unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runStepEfficiencyPlaytest().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
