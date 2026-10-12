import type { D20CheckRequest, D20CheckResult, DiscreteRandomRequest, DiscreteRandomResult, SeededRngState, SimulationState } from "../contracts/model";
import { resolveD20Checks, resolveDiscreteRandomRequests, validateDiscreteRandomCommitmentBudget } from "../mechanics/random";
import { MAX_RANDOM_RNG_WORDS_PER_STEP } from "../mechanics/random-limits";
import { contentHash } from "../models/model-audit";
import type { DecisionBatch, DecisionResult } from "../models/decision";
import { DecisionRuntime, type DecisionUse, type ProgramDecisionScope } from "../programs/decision-runtime";
import type { ProgramResources } from "../programs/definition";
import { loadPromptAsset } from "../prompts";
import { frozenClone, type JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { runtimeId } from "../runtime/runtime-id";
import { physicalReadKeys, validateWorldEvidence, worldProvenance, type BoundWorldProgram } from "./adjudication";
import { admitWorldProgram, bindWorldProgram, renderWorldText } from "./world-program";
import { captureReads, validateReads, worldProgramSources, type ReadSet } from "./resources";
import { materializeWorldResolutions } from "./resolutions";

export interface WorldRandomPlan {
  version: 2; hash: string; sourceRevision: number; before: SeededRngState; programHashes: string[]; attemptHashes: string[];
  requests: DiscreteRandomRequest[]; resourceKeys: string[]; reads: ReadSet; batch: DecisionBatch;
  checkRequests: D20CheckRequest[]; checkKeys: string[];
}
export interface WorldRandomCommitment {
  version: 2; hash: string; plan: WorldRandomPlan; authorization: DecisionResult;
  after: SeededRngState; results: DiscreteRandomResult[]; checks: D20CheckResult[];
}
export interface WorldRandomReservation {
  version: 1; hash: string; sourceRevision: number; atSeconds: number; commitment: WorldRandomCommitment;
}

export function reserveWorldRandomness(sourceRevision: number, atSeconds: number, commitment: WorldRandomCommitment): WorldRandomReservation {
  const body = { version: 1 as const, sourceRevision, atSeconds, commitment };
  return frozenClone({ ...body, hash: contentHash(body) });
}

export function validateRandomReservation(reservation: WorldRandomReservation): void {
  const { hash, ...body } = reservation;
  if (reservation.version !== 1 || hash !== contentHash(body) || !Number.isSafeInteger(reservation.sourceRevision) ||
    reservation.sourceRevision < 0 || !Number.isSafeInteger(reservation.atSeconds) || reservation.atSeconds < 1) throw new Error("invalid random reservation");
  const { hash: commitmentHash, ...commitment } = reservation.commitment;
  if (commitmentHash !== contentHash(commitment)) throw new Error("edited reserved random commitment");
  verifyAuthorization(commitment.plan, commitment.authorization);
  const outcome = drawWorldRandomPlan(commitment.plan);
  if (contentHash(outcome.rng) !== contentHash(commitment.after) || contentHash(outcome.results) !== contentHash(commitment.results) || contentHash(outcome.checks) !== contentHash(commitment.checks)) {
    throw new Error("reserved random result does not replay");
  }
}

export function activeRandomReservation(state: Readonly<SimulationState>): WorldRandomReservation | null {
  const value = state.executionState?.data.kind === "decision-event" ? state.executionState.data.randomReservation : null;
  if (!value) return null;
  const reservation = value as unknown as WorldRandomReservation;
  validateRandomReservation(reservation); return reservation;
}

/** Fix stakes and source distributions without extracting or exposing any RNG word. */
export function prepareWorldRandomPlan(state: Readonly<SimulationState>, definition: WorldRuntimeContract,
  resources: ProgramResources, programs: BoundWorldProgram[]): WorldRandomPlan | null {
  const resolutions = programs.flatMap(bound => materializeWorldResolutions(state, definition, resources, bound)
    .map(value => ({ ...value, actor: bound.attempt.actorEntityId })));
  const checks = resolutions.filter(value => value.check);
  if (!programs.some(bound => bound.program.definition.random.length) && !checks.length) return null;
  if (checks.length > 32) throw new Error("world check commitment exceeds the named resolution budget");
  const sources = worldProgramSources(definition, state), entities = new Set(Object.keys(state.truth.entities));
  const requests: DiscreteRandomRequest[] = [], resourceKeys: string[] = [];
  for (const bound of programs) {
    if (admitWorldProgram(bound.program.definition, sources).hash !== bound.program.hash) throw new Error("random program sources changed");
    bindWorldProgram(bound.program, bound.parameters, entities);
    if (bound.parameters.actor !== bound.attempt.actorEntityId || state.agents[bound.attempt.actorId]?.entityId !== bound.attempt.actorEntityId) throw new Error("random attempt ownership mismatch");
    for (const request of bound.program.definition.random) {
      const distribution = definition.randomDistributions.find(value => value.id === request.distributionId);
      if (!distribution) throw new Error("random program references an unauthored distribution");
      requests.push({ id: runtimeId({ worldHash: state.worldHash, revision: state.revision, kind: "random",
        stage: "world-program", owner: [bound.attempt.id, bound.program.hash, request.id], round: 0, ordinal: requests.length }),
        distributionId: distribution.id, distribution: structuredClone(distribution), causes: worldProvenance(bound).causes });
      resourceKeys.push(`random:${bound.attempt.actorEntityId}:${request.id}`);
    }
  }
  if (new Set(resourceKeys).size !== resourceKeys.length) throw new Error("random program resources collide");
  validateDiscreteRandomCommitmentBudget(requests);
  const keys = [...new Set([...physicalReadKeys(programs.map(bound => bound.attempt), resources), "distributions",
    ...(resolutions.length ? ["mechanics", "entities", "placements", "facts", "ratings", "conditions", "meters"] : []),
    ...programs.flatMap(bound => bound.program.definition.reads.filter(key => !/^(random|check):/u.test(key)).map(key => renderWorldText(key, bound.parameters)))])].sort();
  const reads = captureReads(resources, [...keys, "rng"]), instruction = loadPromptAsset("shared/world-program-random.md");
  const input = JSON.parse(JSON.stringify({ programs, requests, resolutions, resources: Object.fromEntries(keys.map(key => [key, resources[key]])),
    sources: Object.fromEntries([...new Set(programs.flatMap(bound => Object.keys(bound.program.sourceHashes)))].map(id => [id, sources[id]])) })) as JsonValue;
  const batch: DecisionBatch = { version: 1, view: { kind: "world", projectionHash: contentHash(input) }, state: input,
    programHash: contentHash(programs.map(bound => bound.program.hash)), dependencies: Object.fromEntries(keys.map(key => [key, resources[key]!.version])),
    questions: Object.fromEntries(programs.filter(bound => bound.program.definition.random.length || resolutions.some(value => value.plan.actionId === bound.attempt.id && value.check)).map((bound, index) => [`q${index}`, {
      version: contentHash({ instruction, program: bound.program.hash }), instructions: `${instruction}\nEvaluate the random requests and complete stakes for attempt ${bound.attempt.id}.`,
      criteria: { yes: "The authored sources and actual attempt justify these exact random requests and their complete branch stakes.",
        no: "A distribution, applicability condition or proposed stake contradicts the authored world or attempt.",
        unknown: "Required applicability or stakes evidence is missing; do not draw." }, sources: Object.keys(bound.program.sourceHashes) }])) };
  const body = { version: 2 as const, sourceRevision: state.revision, before: structuredClone(state.truth.rng), programHashes: programs.map(bound => bound.program.hash),
    attemptHashes: programs.map(bound => contentHash(bound.attempt)), requests, resourceKeys, reads, batch,
    checkRequests: checks.map(value => value.check!), checkKeys: checks.map(value => `check:${value.actor}:${value.key}`) };
  if (new Set(body.checkKeys).size !== body.checkKeys.length) throw new Error("named check resources collide");
  return frozenClone({ ...body, hash: contentHash(body) });
}

function drawWorldRandomPlan(plan: WorldRandomPlan) {
  const checked = resolveD20Checks(plan.before, plan.checkRequests), random = resolveDiscreteRandomRequests(checked.rng, plan.requests);
  if (random.rng.draws - plan.before.draws > MAX_RANDOM_RNG_WORDS_PER_STEP) throw new Error("combined random commitment exceeds RNG budget");
  return { ...random, checks: checked.results };
}

function verifyAuthorization(plan: WorldRandomPlan, authorization: DecisionResult): void {
  const { hash, ...body } = plan;
  if (hash !== contentHash(body)) throw new Error("random stakes changed after preparation");
  validateWorldEvidence({ batch: plan.batch, result: authorization, hash: contentHash({ batch: plan.batch, result: authorization }) });
  if (Object.values(authorization.answers).some(answer => answer.choice !== "yes")) throw new Error("random commitment lacks affirmative applicability and stakes evidence");
}

/** No randomness is extracted before this source-bound authorization has passed. */
export async function authorizeWorldRandomness(runtime: DecisionRuntime, plan: WorldRandomPlan, scope: ProgramDecisionScope):
Promise<{ commitment: WorldRandomCommitment | null; call: DecisionUse; disposition: "authorized" | "wait" | "expand" }> {
  const call = await runtime.decide({ ...scope, batch: plan.batch, subjectId: "world", modelInvocation: scope.nextInvocation() });
  validateWorldEvidence({ batch: plan.batch, result: call.result, hash: contentHash({ batch: plan.batch, result: call.result }) });
  if (Object.values(call.result.answers).some(answer => answer.choice !== "yes")) {
    return { commitment: null, call, disposition: Object.values(call.result.answers).some(answer => answer.choice === "no") ? "expand" : "wait" };
  }
  verifyAuthorization(plan, call.result);
  const outcome = drawWorldRandomPlan(plan);
  const body = { version: 2 as const, plan, authorization: call.result, after: outcome.rng, results: outcome.results, checks: outcome.checks };
  return { commitment: frozenClone({ ...body, hash: contentHash(body) }), call, disposition: "authorized" };
}

/** Reconstruct requests, sources, inputs and seeded results during commit/recovery; never ask a model to roll. */
export function validateWorldRandomness(state: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  programs: BoundWorldProgram[], commitment: WorldRandomCommitment | null): ProgramResources {
  const reservation = activeRandomReservation(state);
  if (reservation && state.revision > reservation.sourceRevision) {
    if (!commitment || commitment.hash !== reservation.commitment.hash || contentHash(state.truth.rng) !== contentHash(commitment.after)) {
      throw new Error("world randomness differs from the durable reservation");
    }
    // Rebuild the pre-draw input with its original identity. Every other actual read must still match.
    const before = structuredClone(state) as SimulationState;
    before.revision = reservation.sourceRevision; before.truth.rng = structuredClone(commitment.plan.before);
    const original = { ...resources, rng: { version: commitment.plan.reads.rng!.version, value: commitment.plan.before as unknown as JsonValue } };
    const expected = prepareWorldRandomPlan(before, definition, original, programs);
    if (contentHash(expected) !== contentHash(commitment.plan)) throw new Error("reserved random stakes or dependencies changed");
    validateReads(original, commitment.plan.reads);
    return worldRandomResources(resources, commitment);
  }
  const plan = prepareWorldRandomPlan(state, definition, resources, programs);
  if (!plan) { if (commitment !== null) throw new Error("unexpected world randomness"); return resources; }
  if (!commitment) throw new Error("missing world random commitment");
  const { hash, ...body } = commitment;
  if (hash !== contentHash(body) || contentHash(plan) !== contentHash(commitment.plan)) throw new Error("stale or edited world random commitment");
  validateReads(resources, plan.reads); verifyAuthorization(plan, commitment.authorization);
  const expected = drawWorldRandomPlan(plan);
  if (contentHash(expected.rng) !== contentHash(commitment.after) || contentHash(expected.results) !== contentHash(commitment.results) || contentHash(expected.checks) !== contentHash(commitment.checks)) throw new Error("world random result does not replay");
  return worldRandomResources(resources, commitment);
}

export function worldRandomResources(resources: ProgramResources, commitment: WorldRandomCommitment): ProgramResources {
  const { hash, ...body } = commitment;
  if (hash !== contentHash(body)) throw new Error("world random commitment checksum mismatch");
  return { ...resources, ...Object.fromEntries([...commitment.plan.resourceKeys.map((key, index) => [key, commitment.results[index]] as const),
    ...commitment.plan.checkKeys.map((key, index) => [key, commitment.checks[index]] as const)].map(([key, result]) => [key,
    { version: commitment.plan.before.draws, value: JSON.parse(JSON.stringify(result)) as JsonValue }])) };
}
