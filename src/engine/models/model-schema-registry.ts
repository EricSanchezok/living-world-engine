import { z } from "zod";
import {
  actionCompilationBatchSchema,
  actionGroundingSchema,
  agentMindBatchOutputSchema,
  arrivalDraftSchema,
  causalVerificationBatchSchema,
  causalVerificationSchema,
  mechanicInvocationRepairSchema,
  observationProjectionBatchSchema,
  observationRenderSchema,
  perceptionDirectiveSchema,
  reactionDecisionDraftSchema,
  resolutionDirectiveSchema,
  resolutionPlanCommitDirectiveSchema,
  resolutionPlanVerificationBatchSchema,
  resolutionPlanVerificationSchema,
  truthResolutionBatchSchema,
  truthTransitionBatchSchema,
  transitionProposalSchema,
} from "../contracts/llm-schemas";

/**
 * The Ledger stores the JSON Schema emitted by the model gateway, while the
 * gateway itself accepts a typed Zod schema. Keep the production mapping
 * explicit so a probe never silently validates a request against a weaker or
 * unrelated schema.
 */
const schemas: Readonly<Record<string, z.ZodTypeAny>> = Object.freeze({
  action_compilation_batch: actionCompilationBatchSchema,
  action_grounding: actionGroundingSchema,
  agent_mind_batch_output: agentMindBatchOutputSchema,
  agent_reaction_decision: reactionDecisionDraftSchema,
  arrival: arrivalDraftSchema,
  causal_verification: causalVerificationSchema,
  causal_verification_batch: causalVerificationBatchSchema,
  observation_projection_batch: observationProjectionBatchSchema,
  observation_render: observationRenderSchema,
  resolution_plan_verification: resolutionPlanVerificationSchema,
  resolution_plan_verification_batch: resolutionPlanVerificationBatchSchema,
  truth_perception_directive: perceptionDirectiveSchema,
  truth_resolution_continuation: resolutionDirectiveSchema,
  truth_resolution_directive: resolutionDirectiveSchema,
  truth_resolution_batch: truthResolutionBatchSchema,
  truth_resolution_plan_commit: resolutionPlanCommitDirectiveSchema,
  truth_resolution_plan_repair: resolutionPlanCommitDirectiveSchema,
  truth_transition: transitionProposalSchema,
  truth_transition_batch: truthTransitionBatchSchema,
  truth_transition_mechanic_repair: mechanicInvocationRepairSchema,
});

export function modelSchemaForName(schemaName: string): z.ZodTypeAny | undefined {
  return schemas[schemaName];
}

export function modelSchemaNames(): string[] {
  return Object.keys(schemas).sort();
}
