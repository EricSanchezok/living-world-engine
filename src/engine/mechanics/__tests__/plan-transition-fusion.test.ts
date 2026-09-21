import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { TruthPreparationInput } from "../../algorithms/roles";
import { contentHash } from "../../models/model-audit";
import { RecordingRuntimeObserver } from "../../runtime/observability";
import { createTestModelCatalog, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { PLAN_RANDOM_COMPLETION } from "../plan-random-completion";
import { PLAN_TRANSITION_FUSION } from "../plan-transition-fusion";
import { expandSharedBatchContexts, isSharedBatchContext, type SharedBatchContext } from "../shared-batch-context";
import { selectTemporalBoundary } from "../temporal";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { TruthEngine } from "../truth-engine";

type Scenario = "ordinary" | "defer" | "random" | "plan-review-repair" | "invalid-transition" | "missing-outcome" | "source-drift" | "workset-drift";
type Context = { state: { stageContexts?: SharedBatchContext; candidateResolutionPlans?: Array<{ planRef: string }>; randomResults?: unknown[] } };
function fixture(enabled: boolean, scenario: Scenario = "ordinary", batched = false) {
  let reviews = 0;
  function response(profileId: string, schemaName: string, context: unknown): unknown {
    const outer = context as Context;
    if (isSharedBatchContext(outer.state)) return { slots: expandSharedBatchContexts(outer.state)
      .map((entry, slot) => ({ slot, result: response(profileId, schemaName.replace(/_batch$/u, ""), entry) })) };
    if (schemaName === "resolution_plan_verification") {
      if (scenario === "source-drift") source.state.truth.elapsedSeconds += 1;
      if (scenario === "workset-drift") source.modelWorkset!.state.truth.elapsedSeconds += 1;
      if (scenario === "plan-review-repair" && ++reviews === 1) return { verdict: "reject", findings: [{
        planRef: outer.state.candidateResolutionPlans![0]!.planRef, code: "unsupported-means", message: "Controlled rejection", repairHint: "Use the exact original intent",
      }] };
      return { verdict: "accept", findings: [] };
    }
    const [planning, transition] = outer.state.stageContexts ? expandSharedBatchContexts(outer.state.stageContexts) : [context, context];
    if (schemaName === "truth_resolution_continuation" && scenario === "random" && !outer.state.randomResults?.length) return {
      kind: "request_random", requests: [{ proposalKey: "weather-draw", distributionRef: "ref:random_distribution:four-six-sum",
        causes: [{ kind: "action", ref: "ref:action:fusion-action" }] }],
    };
    const ordinary = deterministicModelOutput(profileId, planning) as { kind: string; plans?: Array<Record<string, unknown>> };
    if (ordinary.kind !== "commit_plans") {
      if (schemaName === "truth_transition" && scenario === "random") {
        const row = ordinary as unknown as { proposal: { outcomes: Array<{ causes: unknown[]; assertions: unknown[] }> } };
        for (const random of outer.state.randomResults as Array<{ randomRef: string; steps: Array<{ stepRef: string; aggregate: unknown }> }>) {
          row.proposal.outcomes[0]!.causes.push({ kind: "random", ref: random.randomRef });
          row.proposal.outcomes[0]!.assertions.push({ kind: "random_result", requestId: random.randomRef,
            stepId: random.steps[0]!.stepRef, expected: random.steps[0]!.aggregate });
        }
      }
      return ordinary;
    }
    const plans = ordinary.plans!.map(plan => ({ ...plan,
      ...(schemaName !== "truth_resolution_plan_repair" ? { additionalRandomness: scenario === "random" ? "defer" : "none" } : {}),
    }));
    if (schemaName !== "truth_resolution_fused_commit") return { ...ordinary, plans };
    const draft = (deterministicModelOutput(profileId, transition) as { proposal: {
      outcomes: Array<{ actionRef: string }>; operations: unknown[] } }).proposal;
    if (scenario === "invalid-transition") draft.outcomes[0]!.actionRef = "ref:action:does-not-exist";
    if (scenario === "missing-outcome") draft.outcomes = [];
    return { ...ordinary, plans, provisionalTransition: scenario === "defer" ? null : draft };
  }
  const provider = new ScriptedModelProvider(({ profileId, schemaName, context }) => response(profileId, schemaName, context),
    createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }), false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const source: TruthPreparationInput = { definition, state, identityOwner: "fusion-component", initialActions: [{ id: "fusion-action", actorId: "player",
    baseRevision: state.revision, rawText: "Wait for one second.", goal: "Wait", means: null, targetIds: [] }],
    groundings: [{ kind: "action", id: "fusion-action", actorId: "player", reads: [], writes: [], audienceAgentIds: ["player"], sharedResourceClaims: [], globalFallback: false }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: state.truth.elapsedSeconds, maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }) };
  source.modelWorkset = { state: structuredClone(state),
    initialActions: structuredClone(source.initialActions), availableActions: structuredClone(source.initialActions),
    availableDependencies: structuredClone(source.groundings) };
  const wire = batched ? new TruthBatchCoordinator(provider, 12, 0, "shared-json-v2", TRUTH_BATCH_REQUEST_CONTRACT) : provider;
  const engine = new TruthEngine(wire, { repairAttempts: 1, planRandomCompletion: PLAN_RANDOM_COMPLETION,
    ...(enabled ? { planTransitionFusion: PLAN_TRANSITION_FUSION } : {}) });
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const scope = { workloadId: "fusion-world", batchId: "fusion-step", observer, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  return { provider, engine, source, scope, observer, stateHash: contentHash(state), session: engine.prepare(source, scope) };
}

it("uses one joint generation, retains independent plan review and produces the same validated deterministic world candidate", async () => {
  const b = fixture(false), c = fixture(true);
  const [before, after] = await Promise.all([b.session.next(), c.session.next()]);
  if (before.done || after.done) throw new Error("candidate missing");
  for (const key of ["proposal", "resolutionPlans", "resolutionReceipts", "rng", "commitmentRounds"] as const) expect(after.value.resolution[key]).toEqual(before.value.resolution[key]);
  expect(c.provider.requests.map(r => r.schemaName)).toEqual(["truth_resolution_fused_commit", "resolution_plan_verification"]);
  expect(b.provider.requests).toHaveLength(3);
  expect(after.value.resolution.modelAudits.flatMap(a => a.invocations)).toHaveLength(2);
  expect(contentHash(c.source.state)).toBe(c.stateHash);
  await Promise.all([b.session.next({ kind: "finish" }), c.session.next({ kind: "finish" })]);
});

it.each(["defer", "random", "plan-review-repair"] as const)("uses ordinary transition after %s without changing the random contract", async scenario => {
  const b = fixture(false, scenario), c = fixture(true, scenario);
  const [before, after] = await Promise.all([b.session.next(), c.session.next()]);
  if (before.done || after.done) throw new Error("candidate missing");
  expect(c.provider.requests.filter(r => r.schemaName === "truth_transition")).toHaveLength(1);
  for (const key of ["rng", "randomRequests", "randomResults", "commitmentRounds"] as const) expect(after.value.resolution[key]).toEqual(before.value.resolution[key]);
  if (scenario === "random") expect(after.value.resolution.rng.draws).toBeGreaterThan(c.source.state.truth.rng.draws);
  expect(contentHash(c.source.state)).toBe(c.stateHash);
  await Promise.all([b.session.return(undefined), c.session.return(undefined)]);
});

it("retains outcome coverage and repairs a fused omission with its generating invocation", async () => {
  const c = fixture(true, "missing-outcome"), result = await c.session.next();
  if (result.done) throw new Error("candidate missing");
  const repair = c.provider.requests.find(r => r.schemaName === "truth_transition")!;
  expect(repair.correlation?.semanticRepairAttempt).toBe(1);
  expect(repair.correlation?.repairOf).toBe(c.provider.requests[0]!.modelInvocationId);
  const rejection = c.observer.events.find(event => event.event === "model.semantic.rejected" &&
    event.correlation?.modelInvocationId === c.provider.requests[0]!.modelInvocationId);
  expect(rejection?.correlation?.modelRole).toBe("truth-resolution");
  expect(rejection?.correlation?.logicalInvocationId).toBe(c.provider.requests[0]!.correlation?.logicalInvocationId);
  expect(result.value.transitionAttempt).toBe(1);
  expect(result.value.resolution.proposal.outcomes).toHaveLength(1);
  expect(contentHash(c.source.state)).toBe(c.stateHash);
  await c.session.return(undefined);
});

it("rejects a forged provisional reference at generation without accepting or executing its plan", async () => {
  const c = fixture(true, "invalid-transition");
  await expect(c.session.next()).rejects.toThrow("unknown_handle");
  expect(c.provider.requests.map(r => r.schemaName)).toEqual(["truth_resolution_fused_commit", "truth_resolution_fused_commit"]);
  expect(contentHash(c.source.state)).toBe(c.stateHash);
});

it.each(["source-drift", "workset-drift"] as const)("rejects %s before reusing the provisional transition", async scenario => {
  const c = fixture(true, scenario);
  await expect(c.session.next()).rejects.toThrow("fusion source changed");
  expect(c.provider.requests.some(r => r.role === "truth-transition")).toBe(false);
});

it("preserves independent logical plans in a real shared physical batch", async () => {
  const c = fixture(true, "ordinary", true);
  const peer = structuredClone(c.source);
  peer.identityOwner = "peer-component";
  peer.initialActions[0]!.id = "fusion-peer";
  peer.groundings[0]!.id = "fusion-peer";
  peer.modelWorkset = { state: peer.modelWorkset!.state, initialActions: peer.initialActions,
    availableActions: peer.initialActions, availableDependencies: peer.groundings };
  const second = c.engine.prepare(peer, c.scope);
  const results = await Promise.all([c.session.next(), second.next()]);
  expect(results.every(r => !r.done)).toBe(true);
  expect(c.provider.requests.map(r => r.schemaName)).toEqual(["truth_resolution_fused_commit_batch", "resolution_plan_verification_batch"]);
  for (const result of results) if (!result.done) expect(result.value.resolution.proposal.outcomes).toHaveLength(1);
  await Promise.all([c.session.return(undefined), second.return(undefined)]);
});
