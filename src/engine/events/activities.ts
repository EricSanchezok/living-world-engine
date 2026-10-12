import { z } from "zod";
import type { SimulationState } from "../contracts/model";
import { materializeSharedActivityResourceClaims, validateSharedActivityResourceClaim, type SharedActivityResourceClaim } from "../mechanics/shared-activity-resources";
import { contentHash } from "../models/model-audit";
import type { DecisionBatch } from "../models/decision";
import type { DecisionUse, ProgramDecisionScope } from "../programs/decision-runtime";
import { DecisionRuntime } from "../programs/decision-runtime";
import type { ProgramResources } from "../programs/definition";
import type { JsonValue } from "../runtime/json";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { physicalReadKeys, worldProgramDuration, worldProgramTiming, type BoundWorldProgram } from "./adjudication";
import { captureReads, worldProgramSources } from "./resources";
import { evaluateWorldValue } from "./world-program";
import type { PendingProgramAttempt } from "./runtime-state";
import { deferWorldAttempt } from "./world-recovery";

const second = z.number().int().nonnegative();
export const programActivitySchema = z.object({
  id: z.string(), attemptId: z.string(), programHash: z.string(), actorId: z.string(),
  requestedAtSeconds: second, startedAtSeconds: second.nullable(), dueAtSeconds: second.nullable(), endedAtSeconds: second.nullable(),
  status: z.enum(["queued", "active", "completed", "cancelled", "blocked"]),
  actorClaims: z.array(z.object({ resourceId: z.string(), amount: z.number().positive() }).strict()),
  sharedClaims: z.array(z.unknown()), authorizationHash: z.string(), competitionHash: z.string().nullable(),
}).strict();
export type ProgramActivity = Omit<z.infer<typeof programActivitySchema>, "sharedClaims"> & { sharedClaims: SharedActivityResourceClaim[] };
const claimsProgram = contentHash("world-program-resource-authorization-v1");
const competitionProgram = contentHash("world-program-resource-competition-v1");

export function worldActivityClaims(bound: BoundWorldProgram, state: Readonly<SimulationState>, resources: ProgramResources) {
  const sharedClaims = materializeSharedActivityResourceClaims({
    drafts: bound.program.definition.sharedResources.map(claim => {
      const poolId = evaluateWorldValue(claim.poolId, bound.parameters, resources, bound.attempt);
      if (typeof poolId !== "string") throw new Error("activity pool must resolve to an actual pool ID");
      return { poolId, basis: claim.basis };
    }), rawText: bound.attempt.intent, pools: state.truth.sharedActivityResourcePools, definitions: state.truth.mechanics.sharedActivityResources,
  });
  return { actorClaims: worldProgramTiming(bound, resources).resourceClaims, sharedClaims };
}

function batch(state: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  bounds: BoundWorldProgram[], activities: ProgramActivity[], competition: boolean): DecisionBatch {
  const keys = [...new Set(["laws", "mechanics", "pools", ...physicalReadKeys(bounds.map(bound => bound.attempt), resources),
    ...(competition ? ["clock"] : [])])].sort();
  const context = { sources: worldProgramSources(definition, state),
    resources: Object.fromEntries(keys.map(key => [key, resources[key]!])),
    attempts: bounds.map(bound => ({ attempt: bound.attempt, program: bound.program, parameters: bound.parameters,
      claims: worldActivityClaims(bound, state, resources), timing: worldProgramTiming(bound, resources) })),
    activities: competition ? activities : [],
  };
  return { version: 1, view: { kind: "world", projectionHash: contentHash(context) },
    programHash: competition ? competitionProgram : claimsProgram, state: context as unknown as JsonValue,
    dependencies: Object.fromEntries(keys.map(key => [key, resources[key]!.version])),
    questions: competition ? { allocation: { version: competitionProgram,
      instructions: "Choose the one currently eligible competing attempt that the authored resource rules authorize to start first. Existing active holders keep their claims. This is resource priority, not proof of the action's eventual success. Choose unknown when the rules and evidence cannot decide.",
      criteria: { ...Object.fromEntries(bounds.map((bound, index) => [`p${index}`, `Admit attempt ${bound.attempt.id} first.`])),
        unknown: "Priority is unsupported; wait for relevant evidence." }, sources: ["mechanics", ...definition.laws.map(law => `law:${law.id}`)] } }
      : Object.fromEntries(bounds.map((bound, index) => [`q${index}`, { version: contentHash({ program: bound.program.hash, contract: claimsProgram }),
        instructions: `For attempts[${index}], are its temporal profile, participant resource claims and ALL required shared resource claims justified and complete for this exact executable attempt? An addressed listener does not perform or reserve the speaker's work. Asking about a resource does not occupy it. Check authored laws for required facilities. Do not judge future success, consent or eventual goal completion.`,
        criteria: { yes: "The duration profile and complete claims match the actual attempt and authored rules.",
          no: "The profile or claims violate a rule, or a required claim is omitted.", unknown: "Required evidence for interpreting the activity is absent." },
        sources: Object.keys(bound.program.sourceHashes) }])) };
}

function shortage(candidate: ProgramActivity, active: ProgramActivity[], state: Readonly<SimulationState>) {
  const actor = candidate.actorClaims.filter(claim => claim.amount + active.filter(other => other.actorId === candidate.actorId)
    .flatMap(other => other.actorClaims).filter(other => other.resourceId === claim.resourceId).reduce((sum, other) => sum + other.amount, 0)
    > (state.truth.mechanics.activityResources[claim.resourceId]?.capacity ?? 0)).map(claim => claim.resourceId);
  const pools = candidate.sharedClaims.filter(claim => {
    const pool = state.truth.sharedActivityResourcePools[claim.poolId];
    const capacity = pool && state.truth.entities[pool.entityId]?.lifecycle === "active" ? pool.capacity : 0;
    return claim.amount + active.flatMap(other => other.sharedClaims).filter(other => other.poolId === claim.poolId)
      .reduce((sum, other) => sum + other.amount, 0) > capacity;
  }).map(claim => claim.poolId);
  return { actor, pools };
}
const activityId = (pending: PendingProgramAttempt) => contentHash({ attemptId: pending.attempt.id, programHash: pending.bound!.program.hash });

/** A deterministic generator makes the same admissions with live or recorded decision evidence. */
export function* activityAdmissionSteps(state: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  input: PendingProgramAttempt[], prior: ProgramActivity[]): Generator<DecisionBatch, { pending: PendingProgramAttempt[]; activities: ProgramActivity[] }, DecisionUse> {
  const pending = structuredClone(input), activities = structuredClone(prior), now = state.truth.elapsedSeconds;
  for (const activity of activities) if (["active", "queued"].includes(activity.status) &&
    !pending.some(value => value.bound && !value.failure && activity.id === activityId(value))) {
    activity.status = "cancelled"; activity.endedAtSeconds = now;
  }
  const fresh = pending.filter(value => value.bound && !value.failure && !activities.some(activity => activity.id === activityId(value) && ["active", "queued"].includes(activity.status)))
    .sort((a, b) => a.attempt.id.localeCompare(b.attempt.id));
  if (fresh.length) {
    const call = yield batch(state, definition, resources, fresh.map(value => value.bound!), activities, false);
    for (const [index, value] of fresh.entries()) {
      const choice = call.result.answers[`q${index}`]!.choice;
      const claims = worldActivityClaims(value.bound!, state, resources);
      const record: ProgramActivity = { id: activityId(value), attemptId: value.attempt.id, programHash: value.bound!.program.hash,
        actorId: value.attempt.actorId, requestedAtSeconds: now, startedAtSeconds: null, dueAtSeconds: null, endedAtSeconds: null,
        status: choice === "yes" ? "queued" : "blocked", ...claims, authorizationHash: call.evidenceHash, competitionHash: null };
      if (choice !== "yes") record.endedAtSeconds = now;
      const old = activities.findIndex(activity => activity.id === record.id);
      if (old !== -1) activities.splice(old, 1);
      activities.push(record);
      if (choice !== "yes") deferWorldAttempt(value, resources, worldProgramSources(definition, state),
        `resource declaration requires ${choice === "no" ? "revision" : "evidence"}`, null,
        { disposition: choice === "no" ? "expand" : "wait", reads: captureReads(resources, Object.keys(call.batch.dependencies)), evidenceHash: call.evidenceHash });
    }
  }
  const queued = activities.filter(value => value.status === "queued").sort((a, b) => a.requestedAtSeconds - b.requestedAtSeconds || a.id.localeCompare(b.id));
  const active = activities.filter(value => value.status === "active");
  const waitingPools = new Set<string>();
  while (queued.length) {
    const first = queued.shift()!, waiting = pending.find(value => value.attempt.id === first.attemptId && !value.failure);
    if (!waiting?.bound) throw new Error("queued activity has no pending attempt");
    const lacking = shortage(first, active, state);
    const behindQueue = first.sharedClaims.some(claim => waitingPools.has(claim.poolId));
    if (lacking.actor.length || lacking.pools.length || behindQueue) {
      const reject = lacking.pools.some(id => state.truth.mechanics.sharedActivityResources[state.truth.sharedActivityResourcePools[id]!.definitionId]!.contention === "reject");
      if (reject) {
        first.status = "blocked"; first.endedAtSeconds = now;
        deferWorldAttempt(waiting, resources, worldProgramSources(definition, state), "shared resource capacity rejected this attempt", null,
          { disposition: "wait", reads: captureReads(resources, lacking.pools.flatMap(id => [`pool:${id}`, `program-pool:${id}`])), evidenceHash: contentHash({ first, lacking }) });
      }
      if (!reject) for (const claim of first.sharedClaims) if (state.truth.mechanics.sharedActivityResources[claim.definitionId]!.contention === "queue") waitingPools.add(claim.poolId);
      continue;
    }
    let selected = first;
    const adjudicated = new Set(first.sharedClaims.filter(claim => state.truth.mechanics.sharedActivityResources[claim.definitionId]!.contention === "adjudicate").map(claim => claim.poolId));
    const competitors = queued.filter(value => shortage(value, [...active, first], state).pools.some(id => adjudicated.has(id)) &&
      !shortage(value, active, state).actor.length && !shortage(value, active, state).pools.length);
    if (competitors.length) {
      const contenders = [first, ...competitors], bounds = contenders.map(value => pending.find(item => item.attempt.id === value.attemptId)!.bound!);
      const call = yield batch(state, definition, resources, bounds, active, true), choice = call.result.answers.allocation!.choice;
      if (choice === "unknown") {
        for (const contender of competitors) queued.splice(queued.indexOf(contender), 1);
        continue;
      }
      selected = contenders[Number(choice.slice(1))]!;
      if (!selected) throw new Error("invalid activity competition choice");
      selected.competitionHash = call.evidenceHash;
      if (selected !== first) { queued.splice(queued.indexOf(selected), 1); queued.unshift(first); }
    }
    const item = pending.find(value => value.attempt.id === selected.attemptId)!;
    item.attempt.startedAtSeconds = now; item.bound!.attempt.startedAtSeconds = now;
    selected.status = "active"; selected.startedAtSeconds = now;
    selected.dueAtSeconds = now + worldProgramDuration(item.bound!, resources); item.atSeconds = selected.dueAtSeconds;
    active.push(selected);
  }
  for (const value of pending.filter(value => value.bound && !value.failure)) {
    const activity = activities.find(item => item.id === activityId(value));
    if (!activity || activity.status !== "active") value.atSeconds = null;
  }
  return { pending, activities };
}

export async function admitProgramActivities(runtime: DecisionRuntime, state: Readonly<SimulationState>, definition: WorldRuntimeContract,
  resources: ProgramResources, pending: PendingProgramAttempt[], prior: ProgramActivity[], scope: ProgramDecisionScope) {
  const work = activityAdmissionSteps(state, definition, resources, pending, prior), calls: DecisionUse[] = [];
  let current = work.next();
  while (!current.done) {
    const call = await runtime.decide({ ...scope, batch: current.value, subjectId: "world", modelInvocation: scope.nextInvocation() });
    calls.push(call); current = work.next(call);
  }
  return { ...current.value, calls };
}

export function replayActivityAdmissions(state: Readonly<SimulationState>, definition: WorldRuntimeContract, resources: ProgramResources,
  pending: PendingProgramAttempt[], prior: ProgramActivity[], calls: DecisionUse[]) {
  const work = activityAdmissionSteps(state, definition, resources, pending, prior);
  let current = work.next();
  while (!current.done) {
    const expected = contentHash(current.value), call = calls.find(use => contentHash(use.batch) === expected);
    if (!call) throw new Error("activity admission has no exact authorized decision evidence");
    current = work.next(call);
  }
  return current.value;
}

export function settleProgramActivities(activities: ProgramActivity[], completedAttemptIds: string[], failedAttemptIds: string[], atSeconds: number) {
  const result = structuredClone(activities);
  for (const activity of result) if (["active", "queued"].includes(activity.status)) {
    if (completedAttemptIds.includes(activity.attemptId)) { activity.status = "completed"; activity.endedAtSeconds = atSeconds; }
    else if (failedAttemptIds.includes(activity.attemptId)) { activity.status = "blocked"; activity.endedAtSeconds = atSeconds; }
  }
  return result;
}

export function validateProgramActivities(state: Readonly<SimulationState>, activities: ProgramActivity[], pending: PendingProgramAttempt[], resources?: ProgramResources) {
  if (new Set(activities.map(activity => activity.id)).size !== activities.length) throw new Error("duplicate program activity");
  const active: ProgramActivity[] = [];
  for (const activity of activities) {
    programActivitySchema.parse(activity);
    for (const claim of activity.sharedClaims) validateSharedActivityResourceClaim(claim, state.truth.sharedActivityResourcePools, state.truth.mechanics.sharedActivityResources);
    if (activity.id !== contentHash({ attemptId: activity.attemptId, programHash: activity.programHash }) ||
      activity.requestedAtSeconds > state.truth.elapsedSeconds || activity.startedAtSeconds !== null && activity.startedAtSeconds > state.truth.elapsedSeconds ||
      activity.endedAtSeconds !== null && activity.endedAtSeconds > state.truth.elapsedSeconds) throw new Error("invalid program activity clock or identity");
    if (activity.status === "active" || activity.status === "queued") {
      const item = pending.find(value => value.attempt.id === activity.attemptId && value.bound?.program.hash === activity.programHash && !value.failure);
      if (!item || item.attempt.actorId !== activity.actorId) throw new Error("program activity has no live bound attempt");
      if (resources && contentHash(worldActivityClaims(item.bound!, state, resources)) !== contentHash({ actorClaims: activity.actorClaims, sharedClaims: activity.sharedClaims })) {
        throw new Error("program activity changed its authored resource claims");
      }
      if (activity.status === "queued" && (activity.startedAtSeconds !== null || activity.dueAtSeconds !== null) || activity.endedAtSeconds !== null) throw new Error("live activity has invalid lifecycle fields");
      if (activity.status === "active") {
        const missing = shortage(activity, active, state);
        if (missing.actor.length || missing.pools.length) throw new Error("program activity capacity exceeded");
        active.push(activity);
      }
    }
  }
}
