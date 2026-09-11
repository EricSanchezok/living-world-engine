import type { ActionCompilationDraft } from "../../runtime/execution";
import type { ActionCompilationModelOutput, ActionCompilationCausalAssertion } from "../../contracts/llm-schemas";
import type { ModelSymbolRepairAudit, SimulationState } from "../../contracts/model";
import { repairSymbol, type SymbolRepairPolicy } from "../../contracts/symbol-repair";
import {
  isProposalReference,
  type ExistingReferenceHandle,
  type ModelReference,
  type ModelReferenceKind,
  type ModelReferenceUse,
  type ModelRepairIssue,
  type ReferenceResolver,
  type ActionCompilationReferenceResolver,
} from "../../contracts/model-context";

const MAX_FIELD_ALTERNATIVES = 64;

function setPath(root: unknown, path: readonly (string | number)[], value: string): void {
  let current: unknown = root;
  for (const part of path.slice(0, -1)) {
    if (!current || typeof current !== "object") return;
    current = (current as Record<string | number, unknown>)[part];
  }
  const last = path.at(-1);
  if (last === undefined || !current || typeof current !== "object") return;
  (current as Record<string | number, unknown>)[last] = value;
}

/**
 * Apply the shared deterministic symbol policy to the model-only candidateKey
 * vocabulary before the Action Compilation Zod schema and materializer run.
 * Field contracts are enumerated explicitly so a natural-language string can
 * never be mistaken for a reference merely because its property is named
 * `ref`.
 */
export function preprocessActionCompilationSymbols(input: {
  value: unknown;
  resolver: ActionCompilationReferenceResolver;
  allowedCandidateKeysBySlot?: ReadonlyMap<number, readonly string[]>;
  policy?: Readonly<SymbolRepairPolicy>;
}): { value: unknown; symbolRepairs: ModelSymbolRepairAudit[] } {
  const value = structuredClone(input.value);
  const symbolRepairs: ModelSymbolRepairAudit[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, symbolRepairs };
  const slots = (value as { slots?: unknown }).slots;
  if (!Array.isArray(slots)) return { value, symbolRepairs };

  const repairField = (
    path: Array<string | number>,
    slot: number,
    raw: unknown,
    contract: ActionCompilationFieldContract,
  ): void => {
    if (typeof raw !== "string") return;
    const candidates = input.resolver.candidatesFor(contract.use)
      .filter((candidate) => candidate.scope.kind === "shared" || candidate.scope.slot === slot)
      .filter((candidate) => !input.allowedCandidateKeysBySlot || input.allowedCandidateKeysBySlot.get(slot)?.includes(candidate.candidateKey))
      .filter((candidate) => contract.kinds.includes(candidate.kind))
      .map((candidate) => ({
        value: candidate.candidateKey,
        kind: candidate.kind,
        allowedUses: candidate.allowedUses,
        slot: candidate.scope.kind === "slot" ? candidate.scope.slot : undefined,
      }));
    const result = repairSymbol({
      value: raw,
      candidates,
      ...(input.policy ? { policy: input.policy } : {}),
      context: {
        domain: "candidate-key",
        path: [...path],
        use: contract.use,
        slot,
        catalogHash: input.resolver.catalog.hash,
      },
    });
    if (result.status !== "exact") {
      symbolRepairs.push({
        ...result,
        domain: "candidate-key",
        path: [...path],
        catalogHash: input.resolver.catalog.hash,
        candidateCount: candidates.length,
      });
    }
    if ((result.status === "repaired" || result.status === "normalized") && result.correctedValue) {
      setPath(value, path, result.correctedValue);
    }
  };

  slots.forEach((slotValue, slotIndex) => {
    if (!slotValue || typeof slotValue !== "object" || Array.isArray(slotValue)) return;
    const slot = slotValue as Record<string, unknown>;
    const declaredSlot = Number.isSafeInteger(slot.slot) && Number(slot.slot) >= 0
      ? Number(slot.slot)
      : slotIndex;
    const temporalPlan = slot.temporalPlan;
    if (temporalPlan && typeof temporalPlan === "object" && !Array.isArray(temporalPlan)) {
      const plan = temporalPlan as Record<string, unknown>;
      repairField(
        ["slots", slotIndex, "temporalPlan", "profileRef"],
        declaredSlot,
        plan.profileRef,
        ACTION_COMPILATION_FIELD_USES.temporalProfile,
      );
      if (Array.isArray(plan.causes)) plan.causes.forEach((cause, causeIndex) => {
        if (!cause || typeof cause !== "object" || Array.isArray(cause)) return;
        repairField(
          ["slots", slotIndex, "temporalPlan", "causes", causeIndex, "ref"],
          declaredSlot,
          (cause as Record<string, unknown>).ref,
          ACTION_COMPILATION_FIELD_USES.cause,
        );
      });
      if (Array.isArray(plan.continuationAssertions)) plan.continuationAssertions.forEach((assertion, assertionIndex) => {
        if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) return;
        const item = assertion as Record<string, unknown>;
        const base = ["slots", slotIndex, "temporalPlan", "continuationAssertions", assertionIndex] as Array<string | number>;
        const field = (name: string, contract: ActionCompilationFieldContract) =>
          repairField([...base, name], declaredSlot, item[name], contract);
        switch (item.kind) {
          case "check_result": field("checkRef", ACTION_COMPILATION_FIELD_USES.assertionCheck); break;
          case "random_result":
            field("requestRef", ACTION_COMPILATION_FIELD_USES.assertionRandom);
            field("stepRef", ACTION_COMPILATION_FIELD_USES.assertionRandom);
            break;
          case "fact_matches":
            field("factRef", ACTION_COMPILATION_FIELD_USES.assertionFact);
            if (item.expected && typeof item.expected === "object" && !Array.isArray(item.expected) &&
              (item.expected as Record<string, unknown>).kind === "entity") {
              repairField([...base, "expected", "entityRef"], declaredSlot,
                (item.expected as Record<string, unknown>).entityRef,
                ACTION_COMPILATION_FIELD_USES.assertionEntity);
            }
            break;
          case "fact_absent": field("factRef", ACTION_COMPILATION_FIELD_USES.assertionFact); break;
          case "entity_absent":
          case "entity_lifecycle": field("entityRef", ACTION_COMPILATION_FIELD_USES.assertionEntity); break;
          case "placement_equals":
          case "placement_not_equals":
            field("entityRef", ACTION_COMPILATION_FIELD_USES.assertionEntity);
            if (item.placementRef !== null) field("placementRef", ACTION_COMPILATION_FIELD_USES.assertionPlacement);
            break;
          case "shared_placement":
            field("leftEntityRef", ACTION_COMPILATION_FIELD_USES.assertionEntity);
            field("rightEntityRef", ACTION_COMPILATION_FIELD_USES.assertionEntity);
            break;
          case "meter_compare": field("meterRef", ACTION_COMPILATION_FIELD_USES.assertionMeter); break;
          case "quantity_compare": field("quantityRef", ACTION_COMPILATION_FIELD_USES.assertionQuantity); break;
          case "rating_compare": field("ratingRef", ACTION_COMPILATION_FIELD_USES.assertionRating); break;
          case "shared_resource_capacity_compare": field("poolRef", ACTION_COMPILATION_FIELD_USES.assertionPool); break;
          default: break;
        }
      });
    }
    const dependency = slot.interactionDependency;
    if (!dependency || typeof dependency !== "object" || Array.isArray(dependency)) return;
    const interaction = dependency as Record<string, unknown>;
    const stateDependencies = interaction.stateDependencies;
    if (stateDependencies && typeof stateDependencies === "object" && !Array.isArray(stateDependencies)) {
      const state = stateDependencies as Record<string, unknown>;
      for (const fieldName of ["requiredExistingCandidateKeys", "potentiallyAffectedCandidateKeys"] as const) {
        if (!Array.isArray(state[fieldName])) continue;
        state[fieldName].forEach((raw, index) => repairField(
          ["slots", slotIndex, "interactionDependency", "stateDependencies", fieldName, index],
          declaredSlot,
          raw,
          ACTION_COMPILATION_FIELD_USES.stateDependency,
        ));
      }
    }
    if (Array.isArray(interaction.audienceAgentCandidateKeys)) interaction.audienceAgentCandidateKeys.forEach((raw, index) =>
      repairField(
        ["slots", slotIndex, "interactionDependency", "audienceAgentCandidateKeys", index],
        declaredSlot,
        raw,
        ACTION_COMPILATION_FIELD_USES.audience,
      ));
    if (Array.isArray(interaction.sharedResourceClaims)) interaction.sharedResourceClaims.forEach((claim, index) => {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) return;
      repairField(
        ["slots", slotIndex, "interactionDependency", "sharedResourceClaims", index, "resourcePoolCandidateKey"],
        declaredSlot,
        (claim as Record<string, unknown>).resourcePoolCandidateKey,
        ACTION_COMPILATION_FIELD_USES.resourcePool,
      );
    });
  });
  return { value, symbolRepairs };
}

const CONTEXT_ONLY_REFERENCE_KINDS = new Set([
  "agent",
  "entity",
  "placement",
  "meter",
  "quantity",
  "rating",
  "condition",
  "activity",
  "shared_resource_pool",
  "world",
  "temporal_profile",
]);

export function normalizeActionCompilationContextCauses(input: {
  value: unknown;
  expectedActionRef: string;
}): { value: unknown; removedCount: number } {
  const value = structuredClone(input.value);
  if (!value || typeof value !== "object") return { value, removedCount: 0 };
  const temporalPlan = (value as { temporalPlan?: unknown }).temporalPlan;
  if (!temporalPlan || typeof temporalPlan !== "object") return { value, removedCount: 0 };
  const causes = (temporalPlan as { causes?: unknown }).causes;
  if (!Array.isArray(causes)) return { value, removedCount: 0 };
  const hasExpectedActionCause = causes.some((cause) =>
    cause !== null && typeof cause === "object" &&
    (cause as { kind?: unknown }).kind === "action" &&
    (cause as { ref?: unknown }).ref === input.expectedActionRef);
  if (!hasExpectedActionCause) return { value, removedCount: 0 };

  const filtered = causes.filter((cause) => {
    if (!cause || typeof cause !== "object") return true;
    const kind = (cause as { kind?: unknown }).kind;
    return typeof kind !== "string" || !CONTEXT_ONLY_REFERENCE_KINDS.has(kind);
  });
  const removedCount = causes.length - filtered.length;
  if (removedCount > 0) (temporalPlan as { causes: unknown[] }).causes = filtered;
  return { value, removedCount };
}

interface ActionCompilationFieldContract {
  use: ModelReferenceUse;
  kinds: readonly ModelReferenceKind[];
}

const FOOTPRINT_KINDS = [
  "entity",
  "fact",
  "placement",
  "meter",
  "quantity",
  "rating",
  "condition",
  "activity",
  "shared_resource_pool",
  "world",
] as const satisfies readonly ModelReferenceKind[];

export const ACTION_COMPILATION_FIELD_USES = {
  temporalProfile: { use: "profile", kinds: ["temporal_profile"] },
  cause: { use: "cause", kinds: ["action", "check", "random", "event", "fact", "law", "mechanic"] },
  assertionEntity: { use: "assertion", kinds: ["entity"] },
  assertionPlacement: { use: "assertion", kinds: ["placement"] },
  assertionFact: { use: "assertion", kinds: ["fact"] },
  assertionCheck: { use: "assertion", kinds: ["check"] },
  assertionRandom: { use: "assertion", kinds: ["random"] },
  assertionMeter: { use: "assertion", kinds: ["meter"] },
  assertionQuantity: { use: "assertion", kinds: ["quantity"] },
  assertionRating: { use: "assertion", kinds: ["rating"] },
  assertionPool: { use: "assertion", kinds: ["shared_resource_pool"] },
  stateDependency: { use: "conflict", kinds: FOOTPRINT_KINDS },
  audience: { use: "audience", kinds: ["agent"] },
  resourcePool: { use: "conflict", kinds: ["shared_resource_pool"] },
} as const satisfies Record<string, ActionCompilationFieldContract>;

export class ActionCompilationValidationError extends Error {
  constructor(readonly issues: readonly ModelRepairIssue[]) {
    super(`action compilation contains ${issues.length} field-level reference issue(s)`);
    this.name = "ActionCompilationValidationError";
  }
}

export function validateActionCompilationShortlistMembership(input: {
  value: unknown;
  slot: number;
  allowedCandidateKeys: readonly string[];
}): void {
  const allowed = new Set(input.allowedCandidateKeys);
  const issues: ModelRepairIssue[] = [];
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (typeof value === "string") {
      if (/^candidate_[0-9a-f]+$/u.test(value) && !allowed.has(value)) {
        issues.push({
          code: "reference.out_of_shortlist",
          class: "reference",
          path,
          originalValue: value,
          allowedHandles: [...allowed].sort(),
          reason: `Slot ${input.slot} may reference only candidate keys present in its model-facing shortlist.`,
        });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) visit(entry, [...path, key]);
  };
  visit(input.value, []);
  if (issues.length > 0) throw new ActionCompilationValidationError(issues);
}

/** Convert the model-only candidateKey vocabulary into engine-owned handles.
 * This is the sole boundary where Action Compilation references become
 * resolvable runtime identities; all downstream validation remains unchanged. */
export function materializeActionCompilationCandidateKeys(input: {
  value: ActionCompilationModelOutput;
  resolver: ActionCompilationReferenceResolver;
}): { draft: ActionCompilationDraft; resolvedCandidateCount: number } {
  const value = structuredClone(input.value) as ActionCompilationModelOutput;
  let resolvedCandidateCount = 0;
  const resolve = (candidateKey: string, use: ModelReferenceUse, path?: Array<string | number>): ExistingReferenceHandle => {
    let handle: ExistingReferenceHandle;
    try {
      handle = input.resolver.handleForCandidateKey(candidateKey, use);
    } catch (error) {
      if (error instanceof Error) {
        error.message = `${error.message} (candidate use: ${use})`;
        if (path) (error as Error & { path?: Array<string | number> }).path = path;
      }
      throw error;
    }
    resolvedCandidateCount += 1;
    return handle;
  };
  value.temporalPlan.profileRef = resolve(value.temporalPlan.profileRef, "profile", ["temporalPlan", "profileRef"]) as never;
  value.temporalPlan.causes = value.temporalPlan.causes.map((cause, index) => ({
    ...cause,
    ref: resolve(cause.ref, "cause", ["temporalPlan", "causes", index, "ref"]) as never,
  }));
  const materializeAssertion = (assertion: ActionCompilationCausalAssertion, index: number): ActionCompilationCausalAssertion => {
    const reference = (key: string, ...field: string[]) => resolve(key, "assertion", ["temporalPlan", "continuationAssertions", index, ...field]);
    switch (assertion.kind) {
      case "check_result": return { ...assertion, checkRef: reference(assertion.checkRef, "checkRef") as never };
      case "random_result": return {
        ...assertion,
        requestRef: reference(assertion.requestRef, "requestRef") as never,
        stepRef: reference(assertion.stepRef, "stepRef") as never,
      };
      case "fact_matches": return {
        ...assertion,
        factRef: reference(assertion.factRef, "factRef") as never,
        expected: assertion.expected.kind === "entity"
          ? { ...assertion.expected, entityRef: reference(assertion.expected.entityRef, "expected", "entityRef") as never }
          : assertion.expected,
      };
      case "fact_absent": return { ...assertion, factRef: reference(assertion.factRef, "factRef") as never };
      case "entity_absent":
      case "entity_lifecycle": return { ...assertion, entityRef: reference(assertion.entityRef, "entityRef") as never };
      case "placement_equals":
      case "placement_not_equals": return {
        ...assertion,
        entityRef: reference(assertion.entityRef, "entityRef") as never,
        placementRef: assertion.placementRef === null ? null : reference(assertion.placementRef, "placementRef") as never,
      };
      case "shared_placement": return {
        ...assertion,
        leftEntityRef: reference(assertion.leftEntityRef, "leftEntityRef") as never,
        rightEntityRef: reference(assertion.rightEntityRef, "rightEntityRef") as never,
      };
      case "meter_compare": return { ...assertion, meterRef: reference(assertion.meterRef, "meterRef") as never };
      case "quantity_compare": return { ...assertion, quantityRef: reference(assertion.quantityRef, "quantityRef") as never };
      case "rating_compare": return { ...assertion, ratingRef: reference(assertion.ratingRef, "ratingRef") as never };
      case "shared_resource_capacity_compare": return { ...assertion, poolRef: reference(assertion.poolRef, "poolRef") as never };
      case "elapsed_seconds_compare": return assertion;
    }
  };
  value.temporalPlan.continuationAssertions = value.temporalPlan.continuationAssertions.map(materializeAssertion);
  const requiredRefs = value.interactionDependency.stateDependencies.requiredExistingCandidateKeys
    .map((key, index) => resolve(key, "conflict", ["interactionDependency", "stateDependencies", "requiredExistingCandidateKeys", index]));
  const potentiallyAffectedRefs = value.interactionDependency.stateDependencies.potentiallyAffectedCandidateKeys
    .map((key, index) => resolve(key, "conflict", ["interactionDependency", "stateDependencies", "potentiallyAffectedCandidateKeys", index]));
  const audienceAgentRefs = value.interactionDependency.audienceAgentCandidateKeys
    .map((key, index) => resolve(key, "audience", ["interactionDependency", "audienceAgentCandidateKeys", index]));
  const sharedResourceClaims = value.interactionDependency.sharedResourceClaims.map((claim, index) => ({
    resourcePoolRef: resolve(claim.resourcePoolCandidateKey, "conflict", ["interactionDependency", "sharedResourceClaims", index, "resourcePoolCandidateKey"]),
    basis: structuredClone(claim.basis),
  }));
  return {
    draft: {
      temporalPlan: value.temporalPlan as unknown as ActionCompilationDraft["temporalPlan"],
      interactionDependency: {
        stateDependencies: {
          requiredExistingRefs: requiredRefs,
          potentiallyAffectedExistingRefs: potentiallyAffectedRefs,
        },
        audienceAgentRefs,
        sharedResourceClaims,
      },
    },
    resolvedCandidateCount,
  };
}

export function normalizeActionCompilationDraftReferences(input: {
  draft: ActionCompilationDraft;
  resolver: ReferenceResolver;
  state: Readonly<SimulationState>;
}): { draft: ActionCompilationDraft; agentFootprintConversions: number } {
  const draft = structuredClone(input.draft);
  let agentFootprintConversions = 0;
  const normalizeFootprint = (handle: ExistingReferenceHandle): ExistingReferenceHandle => {
    try {
      const resolved = input.resolver.resolve(handle);
      if (resolved.kind !== "agent") return handle;
      const agent = input.state.agents[resolved.engineId];
      if (!agent) return handle;
      const entity = input.state.truth.entities[agent.entityId];
      if (!entity || entity.lifecycle !== "active") return handle;
      const bindings = Object.values(input.state.agents).filter((candidate) => candidate.entityId === agent.entityId);
      if (bindings.length !== 1) return handle;
      const entityHandle = input.resolver.handleFor("entity", agent.entityId);
      agentFootprintConversions += 1;
      return entityHandle;
    } catch {
      return handle;
    }
  };
  draft.interactionDependency.stateDependencies.requiredExistingRefs =
    draft.interactionDependency.stateDependencies.requiredExistingRefs.map(normalizeFootprint);
  draft.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs =
    draft.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs.map(normalizeFootprint);
  return { draft, agentFootprintConversions };
}

function allowedHandles(
  resolver: ReferenceResolver,
  contract: ActionCompilationFieldContract,
  eligibleProfileHandles?: ReadonlySet<string>,
): string[] {
  return resolver.candidatesFor(contract.use)
    .filter((candidate) => contract.kinds.includes(candidate.kind))
    .filter((candidate) => eligibleProfileHandles === undefined || eligibleProfileHandles.has(candidate.handle))
    .map((candidate) => candidate.handle)
    .sort()
    .slice(0, MAX_FIELD_ALTERNATIVES);
}

function validateReference(input: {
  value: ModelReference;
  path: Array<string | number>;
  contract: ActionCompilationFieldContract;
  resolver: ReferenceResolver;
  eligibleProfileHandles?: ReadonlySet<string>;
  ineligibleProfileReasons?: ReadonlyMap<string, string>;
}): ModelRepairIssue | null {
  const alternatives = allowedHandles(input.resolver, input.contract, input.eligibleProfileHandles);
  if (isProposalReference(input.value)) {
    return {
      code: "reference.proposal_disallowed",
      class: "reference",
      path: input.path,
      originalValue: structuredClone(input.value),
      allowedHandles: alternatives,
      reason: "Action Compilation may select only existing request-local candidate keys; proposal references are not allowed in this field.",
    };
  }
  try {
    const resolved = input.resolver.resolve(input.value, input.contract.use);
    if (!input.contract.kinds.includes(resolved.kind)) {
      return {
        code: "reference.wrong_field_kind",
        class: "reference",
        path: input.path,
        originalValue: input.value,
        allowedHandles: alternatives,
        reason: `This field accepts only ${input.contract.kinds.join(" | ")} candidate keys, not ${resolved.kind}.`,
      };
    }
    if (input.eligibleProfileHandles !== undefined && !input.eligibleProfileHandles.has(input.value)) {
      const rejectionCode = input.ineligibleProfileReasons?.get(input.value) ?? "ineligible";
      return {
        code: "temporal.profile_ineligible",
        class: "mechanic",
        path: input.path,
        originalValue: input.value,
        allowedHandles: alternatives,
        reason: `The selected temporal profile is not eligible for the exact evidence in this action text (${rejectionCode}).`,
      };
    }
    return null;
  } catch (error) {
    return {
      code: error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "reference.invalid",
      class: "reference",
      path: input.path,
      originalValue: input.value,
      allowedHandles: alternatives,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function assertionReferences(
  assertion: ActionCompilationDraft["temporalPlan"]["continuationAssertions"][number],
  index: number,
): Array<{
  value: ModelReference;
  path: Array<string | number>;
  contract: ActionCompilationFieldContract;
}> {
  const base = ["temporalPlan", "continuationAssertions", index] as Array<string | number>;
  switch (assertion.kind) {
    case "check_result": return [{ value: assertion.checkRef, path: [...base, "checkRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionCheck }];
    case "random_result": return [
      { value: assertion.requestRef, path: [...base, "requestRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionRandom },
      { value: assertion.stepRef, path: [...base, "stepRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionRandom },
    ];
    case "fact_matches":
    case "fact_absent": return [{ value: assertion.factRef, path: [...base, "factRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionFact }];
    case "entity_absent":
    case "entity_lifecycle": return [{ value: assertion.entityRef, path: [...base, "entityRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionEntity }];
    case "placement_equals":
    case "placement_not_equals": return [
      { value: assertion.entityRef, path: [...base, "entityRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionEntity },
      ...(assertion.placementRef === null ? [] : [{ value: assertion.placementRef, path: [...base, "placementRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionPlacement }]),
    ];
    case "shared_placement": return [
      { value: assertion.leftEntityRef, path: [...base, "leftEntityRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionEntity },
      { value: assertion.rightEntityRef, path: [...base, "rightEntityRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionEntity },
    ];
    case "meter_compare": return [{ value: assertion.meterRef, path: [...base, "meterRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionMeter }];
    case "quantity_compare": return [{ value: assertion.quantityRef, path: [...base, "quantityRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionQuantity }];
    case "rating_compare": return [{ value: assertion.ratingRef, path: [...base, "ratingRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionRating }];
    case "shared_resource_capacity_compare": return [{ value: assertion.poolRef, path: [...base, "poolRef"], contract: ACTION_COMPILATION_FIELD_USES.assertionPool }];
    case "elapsed_seconds_compare": return [];
  }
}

export function validateActionCompilationDraft(input: {
  draft: ActionCompilationDraft;
  resolver: ReferenceResolver;
  eligibleProfileHandles: ReadonlySet<string>;
  ineligibleProfileReasons: ReadonlyMap<string, string>;
  conditionalProfileHandles: ReadonlySet<string>;
  requiredActionHandle?: ExistingReferenceHandle;
}): ModelRepairIssue[] {
  const references: Array<{
    value: ModelReference;
    path: Array<string | number>;
    contract: ActionCompilationFieldContract;
    eligibleProfileHandles?: ReadonlySet<string>;
  }> = [{
    value: input.draft.temporalPlan.profileRef,
    path: ["temporalPlan", "profileRef"],
    contract: ACTION_COMPILATION_FIELD_USES.temporalProfile,
    eligibleProfileHandles: input.eligibleProfileHandles,
  }];
  input.draft.temporalPlan.causes.forEach((cause, index) => references.push({
    value: cause.ref,
    path: ["temporalPlan", "causes", index, "ref"],
    contract: ACTION_COMPILATION_FIELD_USES.cause,
  }));
  input.draft.temporalPlan.continuationAssertions.forEach((assertion, index) =>
    references.push(...assertionReferences(assertion, index)));
  input.draft.interactionDependency.stateDependencies.requiredExistingRefs.forEach((value, index) => references.push({
    value,
    path: ["interactionDependency", "stateDependencies", "requiredExistingRefs", index],
    contract: ACTION_COMPILATION_FIELD_USES.stateDependency,
  }));
  input.draft.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs.forEach((value, index) => references.push({
    value,
    path: ["interactionDependency", "stateDependencies", "potentiallyAffectedExistingRefs", index],
    contract: ACTION_COMPILATION_FIELD_USES.stateDependency,
  }));
  input.draft.interactionDependency.audienceAgentRefs.forEach((value, index) => references.push({
    value,
    path: ["interactionDependency", "audienceAgentRefs", index],
    contract: ACTION_COMPILATION_FIELD_USES.audience,
  }));
  input.draft.interactionDependency.sharedResourceClaims.forEach((claim, index) => references.push({
    value: claim.resourcePoolRef,
    path: ["interactionDependency", "sharedResourceClaims", index, "resourcePoolRef"],
    contract: ACTION_COMPILATION_FIELD_USES.resourcePool,
  }));
  const issues = references.flatMap((reference) => {
    const issue = validateReference({
      ...reference,
      resolver: input.resolver,
      ineligibleProfileReasons: reference.eligibleProfileHandles === undefined
        ? undefined
        : input.ineligibleProfileReasons,
    });
    return issue === null ? [] : [issue];
  });
  if (input.requiredActionHandle) {
    const actionCauseIndexes = input.draft.temporalPlan.causes
      .map((cause, index) => cause.kind === "action" && cause.ref === input.requiredActionHandle ? index : -1)
      .filter((index) => index >= 0);
    if (actionCauseIndexes.length === 0) {
      issues.push({
        code: "causal.action_cause_required",
        class: "causal",
        path: ["temporalPlan", "causes"],
        originalValue: structuredClone(input.draft.temporalPlan.causes),
        allowedHandles: allowedHandles(input.resolver, ACTION_COMPILATION_FIELD_USES.cause)
          .filter((handle) => input.resolver.resolve(handle).kind === "action"),
        reason: "temporalPlan.causes must include the assigned action's exact candidate key as its causal anchor.",
      });
    }
  }
  if (typeof input.draft.temporalPlan.profileRef === "string" &&
    input.conditionalProfileHandles.has(input.draft.temporalPlan.profileRef) &&
    input.draft.temporalPlan.continuationAssertions.length === 0) {
    issues.push({
      code: "temporal.continuation_condition_missing",
      class: "mechanic",
      path: ["temporalPlan", "continuationAssertions"],
      originalValue: [],
      allowedHandles: [],
      reason: "The selected conditional temporal profile requires at least one continuation assertion grounded in exact catalog candidate keys.",
    });
  }
  return issues;
}
