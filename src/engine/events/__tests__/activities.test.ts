import { describe, expect, it } from "vitest";
import { sharedActivityResourcePoolId } from "../../runtime/runtime-id";
import { toWorldRuntimeContract } from "../../runtime/world-definition";
import { nativeProgramFixture } from "../../testing/native-program-world";
import { decisionQuestionIds, decisionTestProvider } from "../../testing/decision-provider";
import { DecisionRuntime } from "../../programs/decision-runtime";
import { admitWorldProgram } from "../world-program";
import { worldResources, worldProgramSources, programWorldResources } from "../resources";
import type { PendingProgramAttempt } from "../runtime-state";
import { admitProgramActivities, replayActivityAdmissions, settleProgramActivities, validateProgramActivities } from "../activities";
import { decodeWorldDraft, encodeWorldDraft, worldDraftSchema } from "../creation-codec";

function fixture(contention: "queue" | "reject" | "adjudicate" = "queue", capacity = 1) {
  const f = nativeProgramFixture(), state = structuredClone(f.world.initialState), definition = toWorldRuntimeContract(f.world);
  state.truth.mechanics.sharedActivityResources.console = { id: "console", name: "Console", unit: "seat", defaultClaimAmount: 1,
    allowExplicitAmount: false, contention, pausedRetention: "release" };
  const poolId = sharedActivityResourcePoolId(state.worldHash, "console", "keeper");
  state.truth.sharedActivityResourcePools[poolId] = { id: poolId, entityId: "keeper", definitionId: "console", capacity };
  const resources = worldResources(state, definition), rule = structuredClone(f.rule);
  rule.sourceIds.push("mechanics");
  rule.sharedResources = [{ poolId, basis: { kind: "default" } }];
  const program = admitWorldProgram(rule, worldProgramSources(definition, state));
  const pending: PendingProgramAttempt[] = ["keeper", "player"].map((actor, index) => {
    const attempt = { id: `attempt-${index}`, actorId: actor, actorEntityId: actor, intent: "Spend 5 seconds operating the console.",
      utterance: "Ready", targetEntityIds: ["keeper"], startedAtSeconds: 0, program: null };
    return { attempt, bound: { attempt: structuredClone(attempt), program, parameters: { actor, recipient: "keeper", utterance: "Ready" } },
      atSeconds: 5, dependencyHash: "", failure: null, recovery: null };
  });
  return { state, definition, resources, pending, poolId, rule };
}

async function provider(state: ReturnType<typeof fixture>["state"], choice = "p1") {
  const configured = decisionTestProvider(body => ({ answers: Object.fromEntries(decisionQuestionIds(body).map(id =>
    [id, { choice: id === "allocation" ? choice : "yes" }])) }));
  const registry = await configured.registry.capture(); let ordinal = 0;
  return { configured, runtime: new DecisionRuntime(configured.gateway), scope: {
    runtimeIdentity: { worldHash: state.worldHash, revision: state.revision }, profileId: "world-test", workloadId: "activity-test", batchId: "activity-test", modelRegistrySnapshotHash: registry.hash,
    nextInvocation: () => ++ordinal,
  } };
}

describe("program activity reservations", () => {
  it("queues shared contention, starts at release time and deterministically replays admissions", async () => {
    const f = fixture(), p = await provider(f.state);
    const first = await admitProgramActivities(p.runtime, f.state, f.definition, f.resources, f.pending, [], p.scope);
    const running = first.activities.find(value => value.status === "active")!, queued = first.activities.find(value => value.status === "queued")!;
    expect(running.dueAtSeconds).toBe(5); expect(queued.startedAtSeconds).toBeNull();
    expect(first.pending.find(value => value.attempt.id === queued.attemptId)!.atSeconds).toBeNull();
    expect(replayActivityAdmissions(f.state, f.definition, f.resources, f.pending, [], first.calls)).toEqual({ activities: first.activities, pending: first.pending });
    expect(() => replayActivityAdmissions(f.state, f.definition, f.resources, f.pending, [], [])).toThrow("exact authorized");
    f.state.truth.elapsedSeconds = 5;
    const activities = settleProgramActivities(first.activities, [running.attemptId], [], 5);
    const resources = programWorldResources(f.state, f.definition, activities, f.resources);
    const next = await admitProgramActivities(p.runtime, f.state, f.definition, resources,
      first.pending.filter(value => value.attempt.id !== running.attemptId), activities, p.scope);
    expect(next.activities.find(value => value.attemptId === queued.attemptId)).toMatchObject({ status: "active", startedAtSeconds: 5, dueAtSeconds: 10 });
    expect(p.configured.transport).toHaveBeenCalledTimes(1);
    validateProgramActivities(f.state, next.activities, next.pending);
  });
  it("serializes two instructions using the same actor's foreground capacity and frees cancelled work", async () => {
    const f = fixture("queue", 10), p = await provider(f.state);
    f.pending[1]!.attempt.actorId = "keeper"; f.pending[1]!.attempt.actorEntityId = "keeper";
    f.pending[1]!.bound!.attempt = structuredClone(f.pending[1]!.attempt); f.pending[1]!.bound!.parameters.actor = "keeper";
    const first = await admitProgramActivities(p.runtime, f.state, f.definition, f.resources, f.pending, [], p.scope);
    expect(first.activities.filter(value => value.status === "active")).toHaveLength(1);
    const running = first.activities.find(value => value.status === "active")!, queued = first.activities.find(value => value.status === "queued")!;
    f.state.truth.elapsedSeconds = 2;
    const next = await admitProgramActivities(p.runtime, f.state, f.definition, f.resources,
      first.pending.filter(value => value.attempt.id !== running.attemptId), first.activities, p.scope);
    expect(next.activities.find(value => value.attemptId === running.attemptId)).toMatchObject({ status: "cancelled", endedAtSeconds: 2 });
    expect(next.activities.find(value => value.attemptId === queued.attemptId)).toMatchObject({ status: "active", startedAtSeconds: 2, dueAtSeconds: 7 });
  });
  it("rejects insufficient capacity without executing an effect and binds the recoverable dependency", async () => {
    const f = fixture("reject"), p = await provider(f.state);
    const result = await admitProgramActivities(p.runtime, f.state, f.definition, f.resources, f.pending, [], p.scope);
    const rejected = result.pending.find(value => value.failure)!;
    expect(rejected.atSeconds).toBeNull(); expect(rejected.recovery!.disposition).toBe("wait");
    expect(Object.keys(rejected.recovery!.reads)).toEqual([`pool:${f.poolId}`, `program-pool:${f.poolId}`].sort());
    expect(result.activities.filter(value => value.status === "active")).toHaveLength(1);
    expect(f.state.truth.elapsedSeconds).toBe(0);
  });
  it("uses a source-bound decision to select a competing claimant and leaves unknown queued", async () => {
    const f = fixture("adjudicate"), p = await provider(f.state);
    const admitted = await admitProgramActivities(p.runtime, f.state, f.definition, f.resources, f.pending, [], p.scope);
    expect(admitted.calls).toHaveLength(2);
    const selection = admitted.calls[1]!.batch.state as unknown as { attempts: Array<{ attempt: { id: string } }> };
    expect(admitted.activities.find(value => value.status === "active")!.attemptId).toBe(selection.attempts[1]!.attempt.id);
    expect(replayActivityAdmissions(f.state, f.definition, f.resources, f.pending, [], admitted.calls).activities).toEqual(admitted.activities);
    const unknown = await provider(f.state, "unknown"), waiting = await admitProgramActivities(unknown.runtime, f.state, f.definition, f.resources, f.pending, [], unknown.scope);
    expect(waiting.activities.every(value => value.status === "queued")).toBe(true);
    expect(waiting.pending.every(value => value.atSeconds === null)).toBe(true);
    await admitProgramActivities(unknown.runtime, f.state, f.definition, f.resources, waiting.pending, waiting.activities, unknown.scope);
    expect(unknown.configured.transport).toHaveBeenCalledTimes(2);
  });
  it("does not ask for priority when the shared capacity accommodates both claims", async () => {
    const f = fixture("adjudicate", 2), p = await provider(f.state);
    const result = await admitProgramActivities(p.runtime, f.state, f.definition, f.resources, f.pending, [], p.scope);
    expect(result.activities.every(value => value.status === "active")).toBe(true);
    expect(p.configured.transport).toHaveBeenCalledTimes(1);
    const forged = structuredClone(result.activities); forged[0]!.sharedClaims[0]!.amount = 3;
    expect(() => validateProgramActivities(f.state, forged, result.pending)).toThrow("authored default");
    f.state.truth.sharedActivityResourcePools[f.poolId]!.capacity = 0;
    expect(() => validateProgramActivities(f.state, result.activities, result.pending)).toThrow("capacity");
  });
});

describe("world creation parameter codec", () => {
  it("binds entity declarations to exact canonical IDs while preserving reusable templates", () => {
    const f = fixture(), parameters = f.pending[0]!.bound!.parameters;
    const wire = encodeWorldDraft(f.rule, parameters);
    expect(decodeWorldDraft(wire, Object.keys(f.state.truth.entities))).toEqual({ definition: f.rule, parameters });
    const invalid = encodeWorldDraft(f.rule, { ...parameters, actor: "actor" });
    expect(worldDraftSchema(Object.keys(f.state.truth.entities)).safeParse(invalid).success).toBe(false);
    expect(wire.definition.parameters.actor).toMatchObject({ kind: "entity", value: "keeper" });
  });
});
