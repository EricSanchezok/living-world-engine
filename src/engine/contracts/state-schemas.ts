import { z } from "zod";
import type {
  AgentActionProposal,
  AgentCharacterState,
  AgentCommitment,
  AgentGoal,
  AgentState,
  AttitudeState,
  BeliefClaim,
  BeliefEvidence,
  BeliefValue,
  CharacterFacet,
  EmotionState,
  FactValue,
  LocalEntity,
  MeterState,
  QuantityState,
  RatingState,
  WorldEntity,
  WorldFact,
  CausalAssertion,
  CommitmentRound,
  DiscreteRandomAggregate,
  DiscreteRandomDefinition,
  DiscreteRandomRequest,
  DiscreteRandomResult,
  DiscreteRandomValue,
  D20CheckResult,
} from "./model";
import { MAX_COMMITMENT_ROUNDS_PER_STEP } from "../mechanics/commitment-rounds";
import { MAX_RANDOM_REQUESTS_PER_ROUND } from "../mechanics/random-limits";
import { isRuntimeId } from "../runtime/runtime-id";
import type { ConditionState } from "../mechanics/resolution";
import type { SharedActivityResourcePool } from "../mechanics/shared-activity-resources";

const reservedRecordKeys = new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  "prototype",
]);

export function isSafeId(value: string): boolean {
  return value.length > 0 && !reservedRecordKeys.has(value);
}

export function isNormalizedBoundedId(value: string): boolean {
  return isSafeId(value) && value === value.normalize("NFC") && value === value.trim() &&
    !/\p{Cc}/u.test(value) && Buffer.byteLength(value, "utf8") <= 128;
}

export function isSemanticId(value: string): boolean {
  return isNormalizedBoundedId(value) && !value.startsWith("rt:");
}

export const safeIdSchema = z.string().min(1).refine(
  isSafeId,
  { message: "reserved object key cannot be used as an id" },
);

export const semanticIdSchema = z.string().min(1).refine(
  isSemanticId,
  { message: "semantic ids must be NFC, trimmed, control-free, at most 128 UTF-8 bytes, and not use rt:" },
);

export const runtimeIdSchema = z.string().refine(
  (value) => isRuntimeId(value),
  { message: "invalid engine-owned runtime id" },
);

export const causalRefSchema = z.strictObject({
  kind: z.enum(["action", "check", "random", "event", "fact", "law", "mechanic"]),
  id: safeIdSchema,
});

export const factProvenanceRefSchema = z.union([
  causalRefSchema,
  z.strictObject({
    kind: z.literal("world_seed"),
    id: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }),
]);

export const factValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), value: z.string() }),
  z.strictObject({ kind: z.literal("number"), value: z.number().finite() }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("entity"), entityId: safeIdSchema }),
  z.strictObject({ kind: z.literal("none") }),
]) as z.ZodType<FactValue>;

const numericComparisonSchema = z.enum(["eq", "ne", "lt", "lte", "gt", "gte"]);

const discreteRandomIntegerSchema = z.number().int().safe().refine(
  (value) => !Object.is(value, -0),
  { message: "negative zero is not a canonical random value" },
);

export const discreteRandomValueSchema = z.union([
  z.string().min(1),
  discreteRandomIntegerSchema,
  z.boolean(),
  z.null(),
]) as z.ZodType<DiscreteRandomValue>;

export const discreteRandomAggregateSchema = z.union([
  discreteRandomValueSchema,
  z.array(discreteRandomValueSchema).min(1),
]) as z.ZodType<DiscreteRandomAggregate>;

export const discreteRandomDefinitionSchema = z.strictObject({
  id: safeIdSchema,
  description: z.string().min(1),
  steps: z.array(z.strictObject({
    id: safeIdSchema,
    count: z.number().int().min(1).max(100),
    outcomes: z.array(discreteRandomValueSchema).min(2).max(100),
    aggregate: z.enum(["first", "sum", "values"]),
    when: z.strictObject({
      stepId: safeIdSchema,
      equals: discreteRandomValueSchema,
    }).nullable(),
  })).min(1).max(100),
}) as z.ZodType<DiscreteRandomDefinition>;

export const discreteRandomRequestSchema = z.strictObject({
  id: safeIdSchema,
  distributionId: safeIdSchema,
  distribution: discreteRandomDefinitionSchema,
  causes: z.array(causalRefSchema).min(1).max(16),
}) as z.ZodType<DiscreteRandomRequest>;

export const discreteRandomResultSchema = z.strictObject({
  requestId: safeIdSchema,
  distributionId: safeIdSchema,
  steps: z.array(z.strictObject({
    stepId: safeIdSchema,
    skipped: z.boolean(),
    draws: z.array(z.strictObject({
      outcomeIndex: z.number().int().nonnegative(),
      value: discreteRandomValueSchema,
    })),
    aggregate: discreteRandomAggregateSchema.nullable(),
  })).min(1),
}) as z.ZodType<DiscreteRandomResult>;

const commitmentRoundRequestIdsSchema = z.array(safeIdSchema).min(1).refine(
  (requestIds) => new Set(requestIds).size === requestIds.length,
  { message: "commitment round request ids must be unique" },
);
const randomCommitmentRoundRequestIdsSchema = z.array(safeIdSchema)
  .min(1)
  .max(MAX_RANDOM_REQUESTS_PER_ROUND)
  .refine(
    (requestIds) => new Set(requestIds).size === requestIds.length,
    { message: "commitment round request ids must be unique" },
  );

export const commitmentRoundSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("check"),
    phase: z.enum(["perception", "resolution"]),
    requestIds: commitmentRoundRequestIdsSchema,
  }),
  z.strictObject({
    kind: z.literal("random"),
    requestIds: randomCommitmentRoundRequestIdsSchema,
  }),
]) as z.ZodType<CommitmentRound>;

export const commitmentRoundsSchema = z.array(commitmentRoundSchema)
  .max(MAX_COMMITMENT_ROUNDS_PER_STEP);

export const d20CheckResultSchema = z.strictObject({
  requestId: runtimeIdSchema.refine((id) => isRuntimeId(id, "check")),
  dice: z.array(z.number().int().min(1).max(20)).min(1).max(2),
  kept: z.number().int().min(1).max(20),
  modifier: z.number().int(),
  total: z.number().int(),
  dc: z.number().int().min(0).max(100),
  succeeded: z.boolean(),
  margin: z.number().int(),
  visibility: z.enum(["full", "result_only", "hidden"]),
}) as z.ZodType<D20CheckResult>;

export const causalAssertionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("check_result"),
    checkId: safeIdSchema,
    expected: z.enum(["succeeded", "failed"]),
  }),
  z.strictObject({
    kind: z.literal("random_result"),
    requestId: safeIdSchema,
    stepId: safeIdSchema,
    expected: discreteRandomAggregateSchema,
  }),
  z.strictObject({ kind: z.literal("fact_matches"), factId: safeIdSchema, expected: factValueSchema }),
  z.strictObject({ kind: z.literal("fact_absent"), factId: safeIdSchema }),
  z.strictObject({ kind: z.literal("entity_absent"), entityId: safeIdSchema }),
  z.strictObject({
    kind: z.literal("entity_lifecycle"),
    entityId: safeIdSchema,
    expected: z.enum(["active", "retired"]),
  }),
  z.strictObject({
    kind: z.literal("placement_equals"),
    entityId: safeIdSchema,
    placementId: safeIdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("placement_not_equals"),
    entityId: safeIdSchema,
    placementId: safeIdSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("shared_placement"),
    leftEntityId: safeIdSchema,
    rightEntityId: safeIdSchema,
  }),
  z.strictObject({
    kind: z.literal("meter_compare"),
    meterId: safeIdSchema,
    operator: numericComparisonSchema,
    value: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("quantity_compare"),
    definitionId: safeIdSchema,
    holderId: safeIdSchema,
    operator: numericComparisonSchema,
    value: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("rating_compare"),
    ratingId: safeIdSchema,
    operator: numericComparisonSchema,
    value: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("shared_resource_capacity_compare"),
    poolId: runtimeIdSchema.refine((id) => isRuntimeId(id, "shared-resource-pool")),
    operator: numericComparisonSchema,
    value: z.number().finite(),
  }),
  z.strictObject({
    kind: z.literal("elapsed_seconds_compare"),
    operator: numericComparisonSchema,
    value: z.number().finite(),
  }),
]) as z.ZodType<CausalAssertion>;

export const beliefValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), value: z.string() }),
  z.strictObject({ kind: z.literal("number"), value: z.number().finite() }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("local_entity"), localEntityId: semanticIdSchema }),
  z.strictObject({ kind: z.literal("none") }),
]) as z.ZodType<BeliefValue>;

export const accessSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("public") }),
  z.strictObject({ kind: z.literal("private") }),
  z.strictObject({ kind: z.literal("agents"), agentIds: z.array(safeIdSchema) }),
]);

export const localEntitySchema = z.strictObject({
  id: semanticIdSchema,
  name: z.string().min(1),
  description: z.string(),
  status: z.enum(["observed", "reported", "hypothesized"]),
}) as z.ZodType<LocalEntity>;

const evidenceShape = {
  id: semanticIdSchema,
  kind: z.enum(["observation", "testimony", "inference", "assumption"]),
  description: z.string().min(1),
  sourceId: safeIdSchema.nullable(),
  step: z.number().int().nonnegative(),
};
export const evidenceSchema = z.strictObject(evidenceShape) as z.ZodType<BeliefEvidence>;

const beliefClaimShape = {
  id: semanticIdSchema,
  subjectId: semanticIdSchema,
  predicate: z.string().min(1),
  value: beliefValueSchema,
  description: z.string(),
  stance: z.enum(["believed", "suspected", "disbelieved"]),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(safeIdSchema),
};
export const beliefClaimSchema = z.strictObject(beliefClaimShape) as z.ZodType<BeliefClaim>;

const persistedEvidenceIdSchema = z.union([
  semanticIdSchema,
  runtimeIdSchema.refine((id) => isRuntimeId(id, "evidence")),
]);
const persistedClaimIdSchema = z.union([
  semanticIdSchema,
  runtimeIdSchema.refine((id) => isRuntimeId(id, "claim")),
]);

export const persistedEvidenceSchema = z.strictObject({
  ...evidenceShape,
  id: persistedEvidenceIdSchema,
}) as z.ZodType<BeliefEvidence>;

export const persistedBeliefClaimSchema = z.strictObject({
  ...beliefClaimShape,
  id: persistedClaimIdSchema,
}) as z.ZodType<BeliefClaim>;

export const actionProposalSchema = z.strictObject({
  id: runtimeIdSchema.refine((id) => isRuntimeId(id, "action")),
  actorId: semanticIdSchema,
  baseRevision: z.number().int().nonnegative(),
  rawText: z.string().min(1),
  goal: z.string().min(1),
  means: z.string().min(1).nullable(),
  targetIds: z.array(semanticIdSchema),
}) as z.ZodType<AgentActionProposal>;

export const entitySchema = z.strictObject({
  id: semanticIdSchema,
  kind: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  lifecycle: z.enum(["active", "retired"]),
  createdAtStep: z.number().int().nonnegative(),
}) as z.ZodType<WorldEntity>;

export const factSchema = z.strictObject({
  id: semanticIdSchema,
  subjectId: semanticIdSchema,
  predicate: z.string().min(1),
  value: factValueSchema,
  description: z.string(),
  access: accessSchema,
  provenance: z.array(factProvenanceRefSchema),
}) as z.ZodType<WorldFact>;

export const persistedFactIdSchema = z.union([
  semanticIdSchema,
  runtimeIdSchema.refine((id) => isRuntimeId(id, "fact")),
]);

export const persistedFactSchema = z.strictObject({
  id: persistedFactIdSchema,
  subjectId: semanticIdSchema,
  predicate: z.string().min(1),
  value: factValueSchema,
  description: z.string(),
  access: accessSchema,
  provenance: z.array(factProvenanceRefSchema),
}) as z.ZodType<WorldFact>;

export const meterSchema = z.strictObject({
  id: semanticIdSchema,
  definitionId: semanticIdSchema,
  entityId: semanticIdSchema,
  current: z.number().finite(),
  firedThresholdIds: z.array(safeIdSchema),
}) as z.ZodType<MeterState>;

export const ratingSchema = z.strictObject({
  id: semanticIdSchema,
  definitionId: semanticIdSchema,
  entityId: semanticIdSchema,
  value: z.number().finite(),
}) as z.ZodType<RatingState>;

export const quantityStateSchema = z.strictObject({
  id: runtimeIdSchema.refine((id) => isRuntimeId(id, "quantity")),
  definitionId: semanticIdSchema,
  holderId: semanticIdSchema,
  amount: z.number().finite().nonnegative(),
}) as z.ZodType<QuantityState>;

export const sharedActivityResourcePoolSchema = z.strictObject({
  id: runtimeIdSchema.refine((id) => isRuntimeId(id, "shared-resource-pool")),
  definitionId: semanticIdSchema,
  entityId: semanticIdSchema,
  capacity: z.number().finite().nonnegative(),
}) as z.ZodType<SharedActivityResourcePool>;

export const conditionStateSchema = z.strictObject({
  id: semanticIdSchema,
  subjectId: semanticIdSchema,
  label: z.string().min(1),
  description: z.string().min(1),
  magnitude: z.enum(["none", "minor", "standard", "major", "decisive"]),
  durationProfileId: semanticIdSchema,
  conditionProfileId: semanticIdSchema.nullable(),
  stackingKey: semanticIdSchema.nullable(),
  remainingUses: z.number().int().nonnegative().nullable(),
  expiresAtElapsedSeconds: z.number().int().nonnegative().nullable(),
  nextImpactAtElapsedSeconds: z.number().int().nonnegative().nullable(),
  access: accessSchema,
  provenance: z.array(causalRefSchema).min(1),
}) as z.ZodType<ConditionState>;

export const semanticBeliefStateSchema = z.strictObject({
  localEntities: z.record(semanticIdSchema, localEntitySchema),
  claims: z.record(semanticIdSchema, beliefClaimSchema),
  evidence: z.record(semanticIdSchema, evidenceSchema),
});

export const beliefStateSchema = z.strictObject({
  localEntities: z.record(semanticIdSchema, localEntitySchema),
  claims: z.record(persistedClaimIdSchema, persistedBeliefClaimSchema),
  evidence: z.record(persistedEvidenceIdSchema, persistedEvidenceSchema),
});

const characterRecordBase = {
  id: semanticIdSchema,
  description: z.string().min(1),
  createdAtStep: z.number().int().nonnegative(),
  updatedAtStep: z.number().int().nonnegative(),
  evidenceIds: z.array(safeIdSchema),
};

export const characterFacetSchema = z.strictObject({
  ...characterRecordBase,
  strength: z.number().min(0).max(1),
  status: z.enum(["active", "retired"]),
}) as z.ZodType<CharacterFacet>;

export const emotionStateSchema = z.strictObject({
  ...characterRecordBase,
  intensity: z.number().min(0).max(1),
  status: z.enum(["active", "resolved"]),
}) as z.ZodType<EmotionState>;

export const attitudeStateSchema = z.strictObject({
  ...characterRecordBase,
  subjectId: semanticIdSchema,
  intensity: z.number().min(0).max(1),
  status: z.enum(["active", "retired"]),
}) as z.ZodType<AttitudeState>;

export const agentGoalSchema = z.strictObject({
  ...characterRecordBase,
  priority: z.number().min(0).max(1),
  progress: z.number().min(0).max(1),
  targetIds: z.array(semanticIdSchema),
  parentGoalId: semanticIdSchema.optional(),
  motivatedByIds: z.array(semanticIdSchema),
  status: z.enum(["active", "suspended", "completed", "failed", "abandoned"]),
}) as z.ZodType<AgentGoal>;

export const agentCommitmentSchema = z.strictObject({
  ...characterRecordBase,
  priority: z.number().min(0).max(1),
  subjectIds: z.array(semanticIdSchema),
  status: z.enum(["active", "fulfilled", "broken", "released"]),
}) as z.ZodType<AgentCommitment>;

export const agentCharacterStateSchema = z.strictObject({
  persona: z.strictObject({
    summary: z.string().min(1),
    voice: z.string(),
    updatedAtStep: z.number().int().nonnegative(),
    evidenceIds: z.array(safeIdSchema),
  }),
  traits: z.record(semanticIdSchema, characterFacetSchema),
  values: z.record(semanticIdSchema, characterFacetSchema),
  emotions: z.record(semanticIdSchema, emotionStateSchema),
  attitudes: z.record(semanticIdSchema, attitudeStateSchema),
  goals: z.record(semanticIdSchema, agentGoalSchema),
  commitments: z.record(semanticIdSchema, agentCommitmentSchema),
}) as z.ZodType<AgentCharacterState>;

export const agentStateSchema = z.strictObject({
  id: semanticIdSchema,
  entityId: semanticIdSchema,
  modelProfiles: z.strictObject({
    creation: safeIdSchema,
    decision: safeIdSchema,
    fallback: safeIdSchema,
  }),
  character: agentCharacterStateSchema,
  belief: beliefStateSchema,
  bindings: z.record(
    semanticIdSchema,
    z.strictObject({
      localEntityId: semanticIdSchema,
      canonicalEntityIds: z.array(semanticIdSchema),
    }),
  ),
  observationCursorStep: z.number().int().nonnegative(),
  nextAction: actionProposalSchema.nullable(),
}) as z.ZodType<AgentState>;
