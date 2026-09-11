import { defineAlgorithmRef } from "./composition";
import { createEagerReferenceAlgorithmRef, DEFAULT_EAGER_REFERENCE_CONFIG, type EagerReferenceAlgorithmConfig } from "./eager-reference/eager-reference";
import { ACTION_COMPILATION_REPRESENTATION_VERSION } from "./eager-reference/action-compilation-representation";
import { representedActionCompilationPrompt } from "./eager-reference/represented-action-compiler";
import { RESOLUTION_SOURCE_INVENTORY, RESOLUTION_FACT_EVIDENCE } from "../contracts/resolution-source-inventory";
import { ORDERED_RANDOM_SCHEDULING } from "../mechanics/ordered-random-stream";
import { RESOLUTION_DEPENDENT_FIELDS_CODEC, RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION } from "../mechanics/resolution-dependent-fields-codec";
import { INDEXED_REVIEWED_PLANNING_PIPELINE, INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../mechanics/indexed-reviewed-planning-pipeline";
import { EVENT_OUTCOME_SUMMARIES } from "../mechanics/event-outcome-summaries";
import { BOUNDARY_CLOCK_WITNESS } from "../mechanics/boundary-clock-witness";
import { SOURCE_INDEXED_PLAN_CAUSES } from "../mechanics/source-indexed-plan-causes";
import { SOURCE_INDEXED_PLAN_MEANS } from "../mechanics/source-indexed-planning";
import { PLANNING_CATALOG_ENCODING } from "../mechanics/planning-catalog-encoding";
import { PLAN_RANDOM_COMPLETION } from "../mechanics/plan-random-completion";
import { PLANNING_CONTRACT_TAIL } from "../mechanics/planning-contract-tail";
import { SHARED_BATCH_PROMPT_VERSION, TRUTH_BATCH_REQUEST_CONTRACT } from "../mechanics/truth-batch-provider";
import { SHARED_BATCH_CONTEXT_CODEC, SHARED_BATCH_ORDER_CODEC } from "../mechanics/shared-batch-context";
import { SHARED_STATE_FIRST_LAYOUT } from "../prompts/context-layout";
import { UNMATCHED_CLOSER_RECOVERY } from "../models/unmatched-closer-recovery";
import { OBSERVATION_EVIDENCE_LAYOUT } from "../mechanics/observation-evidence-layout";

/** Maintained host selection; explicit controls use the basic composition factory.
 * @see ../../../docs/decisions/0169-standard-integrated-execution-composition.md */
export function standardEagerReferenceAlgorithmRef(config: Readonly<EagerReferenceAlgorithmConfig> = DEFAULT_EAGER_REFERENCE_CONFIG) {
  const base = createEagerReferenceAlgorithmRef(config);
  const compiler = base.children.actionCompilation!;
  const truth = base.children.truthResolution!;
  const observation = base.children.observationRendering!;
  const sharedBatch = {
    maxSlots: config.truthBatchMaxSlots,
    promptVersion: SHARED_BATCH_PROMPT_VERSION,
    requestContract: TRUTH_BATCH_REQUEST_CONTRACT,
    repairPlacement: "tail-v1",
  };
  return defineAlgorithmRef({ ...base, children: {
    ...base.children,
    actionCompilation: defineAlgorithmRef({ ...compiler, id: "represented-action-compilation", config: {
      ...compiler.config,
      representation: "AT",
      codecVersion: ACTION_COMPILATION_REPRESENTATION_VERSION,
      eligibleProfileSchema: "batch-union-v1",
      descriptionPolicy: "original-action-v1",
      profileChoiceEvidence: "visible-schema-v1",
      promptVersion: representedActionCompilationPrompt("AT", true, true).version,
      aliasPolicy: "sorted-root-union-reserved-tail-exact-only",
      temporalPolicy: "script-conditional-first-rest",
    } }),
    truthResolution: defineAlgorithmRef({ ...truth, id: "indexed-reviewed-truth-resolution", version: "5", config: {
      randomScheduling: ORDERED_RANDOM_SCHEDULING,
      sourceInventory: RESOLUTION_SOURCE_INVENTORY,
      representation: RESOLUTION_DEPENDENT_FIELDS_CODEC,
      promptVersion: RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION,
      planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE,
      pipelinePromptVersion: INDEXED_REVIEWED_PLANNING_PROMPT_VERSION,
      outcomeSummary: EVENT_OUTCOME_SUMMARIES,
      boundaryClockWitness: BOUNDARY_CLOCK_WITNESS,
      planCauseChoices: SOURCE_INDEXED_PLAN_CAUSES,
      planMeansChoices: SOURCE_INDEXED_PLAN_MEANS,
      planFactEvidence: RESOLUTION_FACT_EVIDENCE,
      planningCatalogEncoding: PLANNING_CATALOG_ENCODING,
      planRandomCompletion: PLAN_RANDOM_COMPLETION,
      planningContractTail: PLANNING_CONTRACT_TAIL,
    }, children: { ...truth.children,
      batching: defineAlgorithmRef({ ...truth.children.batching!, id: "shared-state-first-slot-batching", config: {
        ...sharedBatch,
        contextCodec: SHARED_BATCH_ORDER_CODEC,
        contextLayout: SHARED_STATE_FIRST_LAYOUT,
        jsonSyntaxRecovery: UNMATCHED_CLOSER_RECOVERY,
        flushBoundary: "post-promise-v1",
        planRepairBatching: "scoped-plans-v1",
      } }),
    } }),
    observationRendering: defineAlgorithmRef({ ...observation, id: "source-bound-observation-rendering",
      config: { evidenceLayout: OBSERVATION_EVIDENCE_LAYOUT }, children: { ...observation.children,
        batching: defineAlgorithmRef({ ...observation.children.batching!, id: "shared-context-slot-batching", version: "2",
          config: { ...sharedBatch, contextCodec: SHARED_BATCH_CONTEXT_CODEC } }),
      },
    }),
  } });
}
