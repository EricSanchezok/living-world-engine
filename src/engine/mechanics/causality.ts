import { isDeepStrictEqual } from "node:util";
import type {
  CausalAssertion,
  CausalAssertionResult,
  CausalSource,
  CausalTarget,
  D20CheckResult,
  DiscreteRandomResult,
  NumericComparison,
  SimulationState,
  TransitionProposal,
} from "../contracts/model";
import { applyWorldDeltaOperation } from "../runtime/transaction";
import { quantityId } from "../runtime/runtime-id";

function compare(actual: number, operator: NumericComparison, expected: number): boolean {
  switch (operator) {
    case "eq": return actual === expected;
    case "ne": return actual !== expected;
    case "lt": return actual < expected;
    case "lte": return actual <= expected;
    case "gt": return actual > expected;
    case "gte": return actual >= expected;
  }
}

export function evaluateCausalAssertion(
  state: Readonly<SimulationState>,
  assertion: CausalAssertion,
  checks: ReadonlyMap<string, D20CheckResult> = new Map(),
  randomResults: ReadonlyMap<string, DiscreteRandomResult> = new Map(),
): Pick<CausalAssertionResult, "passed" | "observed"> {
  switch (assertion.kind) {
    case "check_result": {
      const check = checks.get(assertion.checkId);
      const observed = check ? (check.succeeded ? "succeeded" : "failed") : null;
      return { passed: observed === assertion.expected, observed };
    }
    case "random_result": {
      const result = randomResults.get(assertion.requestId);
      const step = result?.steps.find((candidate) => candidate.stepId === assertion.stepId);
      const observed = step && !step.skipped ? step.aggregate : null;
      return { passed: Boolean(step && !step.skipped && isDeepStrictEqual(observed, assertion.expected)), observed };
    }
    case "fact_matches": {
      const fact = state.truth.facts[assertion.factId];
      return {
        passed: Boolean(fact && isDeepStrictEqual(fact.value, assertion.expected)),
        observed: fact?.value ?? null,
      };
    }
    case "fact_absent": {
      const present = Boolean(state.truth.facts[assertion.factId]);
      return { passed: !present, observed: { present } };
    }
    case "entity_absent": {
      const present = Boolean(state.truth.entities[assertion.entityId]);
      return { passed: !present, observed: { present } };
    }
    case "entity_lifecycle": {
      const observed = state.truth.entities[assertion.entityId]?.lifecycle ?? null;
      return { passed: observed === assertion.expected, observed };
    }
    case "placement_equals": {
      const known = Boolean(state.truth.entities[assertion.entityId]);
      const placementId = known ? state.truth.placements[assertion.entityId] : undefined;
      return {
        passed: known && placementId === assertion.placementId,
        observed: { known, placementId: placementId ?? null },
      };
    }
    case "placement_not_equals": {
      const known = Boolean(state.truth.entities[assertion.entityId]);
      const placementId = known ? state.truth.placements[assertion.entityId] : undefined;
      return {
        passed: known && placementId !== assertion.placementId,
        observed: { known, placementId: placementId ?? null },
      };
    }
    case "shared_placement": {
      const left = state.truth.placements[assertion.leftEntityId];
      const right = state.truth.placements[assertion.rightEntityId];
      return {
        passed: left !== undefined && left !== null && left === right,
        observed: { left: left ?? null, right: right ?? null },
      };
    }
    case "meter_compare": {
      const actual = state.truth.meters[assertion.meterId]?.current;
      return {
        passed: actual !== undefined && compare(actual, assertion.operator, assertion.value),
        observed: actual ?? null,
      };
    }
    case "quantity_compare": {
      const id = quantityId(state.worldHash, assertion.definitionId, assertion.holderId);
      const definition = state.truth.mechanics.quantities[assertion.definitionId];
      const holder = state.truth.entities[assertion.holderId];
      const actual = state.truth.quantities[id]?.amount ?? 0;
      return {
        passed: Boolean(definition && holder && compare(actual, assertion.operator, assertion.value)),
        observed: definition && holder ? actual : null,
      };
    }
    case "rating_compare": {
      const actual = state.truth.ratings[assertion.ratingId]?.value;
      return {
        passed: actual !== undefined && compare(actual, assertion.operator, assertion.value),
        observed: actual ?? null,
      };
    }
    case "shared_resource_capacity_compare": {
      const actual = state.truth.sharedActivityResourcePools[assertion.poolId]?.capacity;
      return {
        passed: actual !== undefined && compare(actual, assertion.operator, assertion.value),
        observed: actual ?? null,
      };
    }
    case "elapsed_seconds_compare": {
      const actual = state.truth.elapsedSeconds;
      return { passed: compare(actual, assertion.operator, assertion.value), observed: actual };
    }
  }
}

function targetForOperation(index: number, kind: string): CausalTarget {
  return { kind: "operation", id: `${index}:${kind}` };
}

function evaluateSource(
  state: SimulationState,
  checks: ReadonlyMap<string, D20CheckResult>,
  randomResults: ReadonlyMap<string, DiscreteRandomResult>,
  target: CausalTarget,
  source: CausalSource,
): CausalAssertionResult[] {
  if (source.assertions.length === 0) throw new Error(`${target.kind} ${target.id} has no causal assertions`);
  for (const cause of source.causes) {
    if (cause.kind === "check") {
      const hasAssertion = source.assertions.some((assertion) =>
        assertion.kind === "check_result" && assertion.checkId === cause.id);
      if (!hasAssertion) {
        throw new Error(`${target.kind} ${target.id} cites check ${cause.id} without asserting its result`);
      }
    }
    if (cause.kind === "random") {
      const hasAssertion = source.assertions.some((assertion) =>
        assertion.kind === "random_result" && assertion.requestId === cause.id);
      if (!hasAssertion) {
        throw new Error(`${target.kind} ${target.id} cites random ${cause.id} without asserting its result`);
      }
    }
  }
  return source.assertions.map((assertion) => ({
    target,
    assertion: structuredClone(assertion),
    ...evaluateCausalAssertion(state, assertion, checks, randomResults),
  }));
}

export class CausalAssertionValidationError extends Error {
  readonly failures: readonly CausalAssertionResult[];

  constructor(failures: readonly CausalAssertionResult[]) {
    const labels = failures.map((result) => `${result.target.kind}:${result.target.id}:${result.assertion.kind}`);
    super(`causal assertions failed: ${labels.join(", ")}`);
    this.name = "CausalAssertionValidationError";
    this.failures = structuredClone(failures);
  }
}

export function evaluateProposalCausality(
  state: SimulationState,
  checkResults: readonly D20CheckResult[],
  discreteRandomResults: readonly DiscreteRandomResult[],
  proposal: TransitionProposal,
): CausalAssertionResult[] {
  const consumedRandomIds = new Set([
    ...proposal.mechanicInvocations.flatMap((invocation) => invocation.causes),
    ...proposal.operations.flatMap((operation) => operation.causes),
    ...proposal.events.flatMap((event) => event.causes),
    ...proposal.outcomes.flatMap((outcome) => outcome.causeRefs),
  ].filter((cause) => cause.kind === "random").map((cause) => cause.id));
  for (const result of discreteRandomResults) {
    if (!consumedRandomIds.has(result.requestId)) {
      throw new Error(`transition does not consume committed random ${result.requestId}`);
    }
  }
  const checks = new Map(checkResults.map((check) => [check.requestId, check]));
  const randomResults = new Map(discreteRandomResults.map((result) => [result.requestId, result]));
  const results: CausalAssertionResult[] = [];
  const working = structuredClone(state);

  proposal.operations.forEach((operation, index) => {
    if (operation.kind === "produce_quantity" || operation.kind === "consume_quantity") {
      const citesLaw = operation.causes.some((cause) => cause.kind === "law" && cause.id === operation.lawId);
      if (!citesLaw) throw new Error(`${operation.kind} must cite its authorizing law ${operation.lawId}`);
    }
    results.push(...evaluateSource(working, checks, randomResults, targetForOperation(index, operation.kind), operation));
    applyWorldDeltaOperation(working, operation);
  });
  for (const invocation of proposal.mechanicInvocations) {
    results.push(...evaluateSource(
      state,
      checks,
      randomResults,
      { kind: "mechanic", id: invocation.id },
      invocation,
    ));
  }
  for (const event of proposal.events) {
    results.push(...evaluateSource(working, checks, randomResults, { kind: "event", id: event.id }, event));
  }
  for (const outcome of proposal.outcomes) {
    if (!outcome.causeRefs.some((cause) => cause.kind === "action" && cause.id === outcome.proposalId)) {
      throw new Error(`outcome ${outcome.proposalId} does not cite its action`);
    }
    results.push(...evaluateSource(
      working,
      checks,
      randomResults,
      { kind: "outcome", id: outcome.id },
      { causes: outcome.causeRefs, assertions: outcome.assertions },
    ));
  }

  const failed = results.filter((result) => !result.passed);
  if (failed.length > 0) {
    throw new CausalAssertionValidationError(failed);
  }
  return results;
}
