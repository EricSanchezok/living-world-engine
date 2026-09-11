import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { TruthResolutionInput } from "../../algorithms/roles";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";
import { contentHash } from "../../models/model-audit";
import { deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { selectTemporalBoundary } from "../temporal";
import { TruthEngine } from "../truth-engine";
import { PLAN_RANDOM_COMPLETION } from "../plan-random-completion";
import { stepEfficiencyAlgorithmRef } from "../../../../scripts/operations/step-efficiency-playtest";
import { INDEXED_REVIEWED_PLANNING_PIPELINE } from "../indexed-reviewed-planning-pipeline";
import { RESOLUTION_DEPENDENT_FIELDS_CODEC } from "../resolution-dependent-fields-codec";
import { OrderedRandomStream } from "../ordered-random-stream";

type Scenario = "none" | "defer" | "mixed" | "wrong-result" | "check" | "logical-repair" | "targeted-repair";

function fixture(enabled: boolean, scenario: Scenario = "none", id = "completion-action") {
  let initialCalls = 0, reviews = 0;
  const requiresRandom = scenario === "defer" || scenario === "mixed" || scenario === "wrong-result";
  const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
    const input = context as { state: { committedResolutionPlans?: unknown[]; randomResults?: Array<{ randomRef: string; steps: Array<{ stepRef: string; aggregate: unknown }> }>;
      candidateResolutionPlans?: Array<{ planRef: string }> } };
    if (schemaName === "resolution_plan_verification") {
      if (++reviews === 1 && scenario === "targeted-repair") return { verdict: "reject", findings: [{
        planRef: input.state.candidateResolutionPlans![0]!.planRef, code: "ungrounded-mean",
        message: "Controlled unsupported means", repairHint: "Use only the original action's evidence",
      }] };
      return { verdict: "accept", findings: [] };
    }
    if (schemaName === "truth_resolution_continuation" && requiresRandom && !input.state.randomResults?.length) {
      return { kind: "request_random", requests: [{ proposalKey: "required-random",
        distributionRef: "ref:random_distribution:four-six-sum", causes: [{ kind: "action", ref: `ref:action:${id}` }] }] };
    }
    const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
    if (role === "truth-transition" && generated.kind === "transition" && input.state.randomResults?.length) {
      const proposal = generated.proposal as { outcomes: Array<{ causes: unknown[]; assertions: unknown[] }> };
      for (const result of input.state.randomResults) {
        proposal.outcomes[0]!.causes.push({ kind: "random", ref: result.randomRef });
        proposal.outcomes[0]!.assertions.push({ kind: "random_result", requestId: result.randomRef,
          stepId: result.steps[0]!.stepRef, expected: scenario === "wrong-result" ? "not-the-drawn-value" : result.steps[0]!.aggregate });
      }
    }
    if (role === "truth-resolution" && generated.kind === "commit_plans") {
      if (schemaName === "truth_resolution_plan_commit") initialCalls += 1;
      const missing = scenario === "logical-repair" && initialCalls === 1;
      return { ...generated, plans: (generated.plans as Array<Record<string, unknown>>).map((plan, index) => ({
        ...plan,
        ...(enabled && schemaName === "truth_resolution_plan_commit" && !missing ? {
          additionalRandomness: requiresRandom && !(scenario === "mixed" && index === 0) ? "defer" : "none",
        } : {}),
        ...(scenario === "check" ? {
          mode: "check", baseEffect: "minor",
          means: [{ description: "The actor's own exertion", source: { kind: "entity", id: "player" } }],
          difficulty: { kind: "environment", band: "trivial", source: { kind: "entity", id: "player" } },
          primaryEffect: { kind: "meter", id: "exertion", targetId: "player", channel: "physical-harm",
            label: "exertion", description: "Physical exertion consumes health.", sourceRefs: [{ kind: "entity", id: "player" }],
            meterId: "health:player", impactProfileId: "harm", magnitude: "minor" },
          threatenedEffect: { kind: "meter", id: "strain", targetId: "player", channel: "physical-harm",
            label: "strain", description: "Failed exertion strains the actor.", sourceRefs: [{ kind: "entity", id: "player" }],
            meterId: "health:player", impactProfileId: "harm", magnitude: "minor" },
        } : {}),
      })) };
    }
    return generated;
  }, undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState), stateHash = contentHash(state);
  const action = { id, actorId: "player", baseRevision: state.revision,
    rawText: "Continue exercising in the courtyard, retaining my original conditions.", goal: "Exercise", means: null, targetIds: [] };
  const ownership = { acquire: 0, finish: 0 };
  const controller = new AbortController();
  const input: TruthResolutionInput = { definition, state, initialActions: [action],
    groundings: [{ kind: "action", id, actorId: "player", reads: [{ kind: "meter", id: "health:player" }],
      writes: [{ kind: "entity", id: "player" }, { kind: "meter", id: "health:player" }], audienceAgentIds: ["player"],
      sharedResourceClaims: [], globalFallback: false }],
    identityOwner: `component-${id}`,
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: state.truth.elapsedSeconds, maxAutonomousSpanSeconds: 1,
      activities: {}, timers: {}, conditionExpiries: {} }),
    orderedRandom: { acquire: async () => { ownership.acquire += 1; return structuredClone(state.truth.rng); },
      finish: async rng => { ownership.finish += 1; return structuredClone(rng); } },
    renderObservations: async () => { throw new Error("preparation cannot render"); },
    validateProposal: () => { throw new Error("preparation cannot commit"); },
  };
  if (scenario === "mixed") {
    input.initialActions = [...input.initialActions, { ...action, id: `${id}-peer` }];
    input.groundings = [...input.groundings, { ...input.groundings[0]!, id: `${id}-peer` }];
  }
  const scope = { workloadId: "completion-world", batchId: "completion-step", cancelPendingSignal: controller.signal,
    runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const session = new TruthEngine(provider, { repairAttempts: 1, ...(enabled ? { planRandomCompletion: PLAN_RANDOM_COMPLETION } : {}) }).prepare(input, scope);
  return { provider, input, scope, session, ownership, stateHash, controller };
}

it("removes only the termination request after complete reviewed plans and retains identical canonical results", async () => {
  const base = fixture(false), candidate = fixture(true);
  const [before, after] = await Promise.all([base.session.next(), candidate.session.next()]);
  if (before.done || after.done) throw new Error("missing candidate");
  expect(base.provider.requests.filter(r => r.schemaName === "truth_resolution_continuation")).toHaveLength(1);
  expect(candidate.provider.requests.filter(r => r.schemaName === "truth_resolution_continuation")).toHaveLength(0);
  expect(candidate.provider.requests.filter(r => r.schemaName === "resolution_plan_verification")).toHaveLength(1);
  for (const field of ["actions", "checks", "rng", "resolutionPlans", "resolutionReceipts", "commitmentRounds", "proposal"] as const) {
    expect(after.value.resolution[field]).toEqual(before.value.resolution[field]);
  }
  expect(candidate.ownership).toEqual(base.ownership);
  expect(candidate.ownership).toEqual({ acquire: 0, finish: 1 });
  expect(contentHash(candidate.input.state)).toBe(candidate.stateHash);
  expect(candidate.provider.requests[0]!.promptVersion).toContain(PLAN_RANDOM_COMPLETION);
  expect(base.provider.requests[0]!.userPrompt).not.toContain("additionalRandomness");
  candidate.controller.abort(new DOMException("controlled cancellation", "AbortError"));
  await expect(candidate.session.next({ kind: "finish" })).rejects.toThrow("controlled cancellation");
  expect(candidate.ownership.finish).toBe(1);
  await base.session.return(undefined);
});

it.each(["defer", "mixed", "check", "logical-repair", "targeted-repair"] as const)("preserves real continuation and commitment ownership for %s", async scenario => {
  const run = fixture(true, scenario), first = await run.session.next();
  if (first.done) throw new Error("missing candidate");
  const continuations = run.provider.requests.filter(r => r.schemaName === "truth_resolution_continuation");
  const random = scenario === "defer" || scenario === "mixed";
  expect(continuations).toHaveLength(random ? 2 : 1);
  expect(contentHash(run.input.state)).toBe(run.stateHash);
  expect(run.ownership).toEqual({ acquire: random || scenario === "check" ? 1 : 0, finish: 1 });
  if (random || scenario === "check") {
    const base = fixture(false, scenario), before = await base.session.next();
    if (before.done) throw new Error("missing baseline candidate");
    for (const field of ["checks", "randomRequests", "randomResults", "rng", "resolutionReceipts", "commitmentRounds"] as const) {
      expect(first.value.resolution[field]).toEqual(before.value.resolution[field]);
    }
    expect(first.value.resolution.rng.draws).toBeGreaterThan(run.input.state.truth.rng.draws);
    await base.session.return(undefined);
  }
  if (scenario === "targeted-repair") {
    const repair = run.provider.requests.find(r => r.schemaName === "truth_resolution_plan_repair")!;
    expect(repair).toBeDefined();
    expect(repair.userPrompt).not.toContain("additionalRandomness");
    expect(run.provider.requests.filter(r => r.schemaName === "resolution_plan_verification")).toHaveLength(2);
  }
  await run.session.return(undefined);
});

it("rejects a false assertion about the actual random result without drawing again during transition repairs", async () => {
  const run = fixture(true, "wrong-result");
  await expect(run.session.next()).rejects.toThrow("causal assertions failed");
  expect(run.provider.requests.filter(r => r.schemaName === "truth_resolution_continuation")).toHaveLength(2);
  expect(run.provider.requests.filter(r => r.role === "truth-transition")).toHaveLength(2);
  expect(run.ownership).toEqual({ acquire: 1, finish: 1 });
  expect(contentHash(run.input.state)).toBe(run.stateHash);
});

it("does not transfer termination between independent components", async () => {
  const done = fixture(true, "none", "component-a"), deferred = fixture(true, "defer", "component-b");
  const results = await Promise.all([done.session.next(), deferred.session.next()]);
  expect(results.every(r => !r.done)).toBe(true);
  expect(done.provider.requests.some(r => r.schemaName === "truth_resolution_continuation")).toBe(false);
  expect(deferred.provider.requests.filter(r => r.schemaName === "truth_resolution_continuation")).toHaveLength(2);
  await Promise.all([done.session.return(undefined), deferred.session.return(undefined)]);
});

it("preserves the serial random stream when a concurrent middle component finishes without continuation", async () => {
  const setup = (enabled: boolean) => {
    const runs = (["defer", "none", "defer"] as const).map((scenario, index) => fixture(enabled, scenario, `ordered-${index}`));
    const stream = new OrderedRandomStream(runs[0]!.input.state.truth.rng, runs.length);
    const reached = runs.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>(done => { resolve = done; });
      return { promise, resolve };
    });
    for (const [index, run] of runs.entries()) run.input.orderedRandom = {
      acquire: () => { run.ownership.acquire += 1; reached[index]!.resolve(); return stream.acquire(index); },
      finish: rng => { run.ownership.finish += 1; reached[index]!.resolve(); return stream.finish(index, rng); },
    };
    return { runs, reached };
  };
  const baseline = setup(false), candidate = setup(true);
  const before = [];
  for (const run of baseline.runs) before.push(await run.session.next());

  // Hold the first component back until both successors are waiting on the real stream.
  const last = candidate.runs[2]!.session.next();
  await candidate.reached[2]!.promise;
  const middle = candidate.runs[1]!.session.next();
  await candidate.reached[1]!.promise;
  const after = await Promise.all([candidate.runs[0]!.session.next(), middle, last]);
  for (const [index, result] of after.entries()) {
    const original = before[index]!;
    if (result.done || original.done) throw new Error("missing ordered candidate");
    for (const field of ["checks", "randomRequests", "randomResults", "rng", "resolutionReceipts", "commitmentRounds", "proposal"] as const) {
      expect(result.value.resolution[field]).toEqual(original.value.resolution[field]);
    }
    expect(contentHash(candidate.runs[index]!.input.state)).toBe(candidate.runs[index]!.stateHash);
  }
  const randomStates = after.map(result => {
    if (result.done) throw new Error("missing ordered candidate");
    return result.value.resolution.rng;
  });
  expect(randomStates[1]).toEqual(randomStates[0]);
  expect(randomStates[2]!.draws).toBeGreaterThan(randomStates[1]!.draws);
  expect(candidate.runs.map(run => run.ownership)).toEqual([
    { acquire: 1, finish: 1 }, { acquire: 0, finish: 1 }, { acquire: 1, finish: 1 },
  ]);
  expect(candidate.runs[1]!.provider.requests.some(r => r.schemaName === "truth_resolution_continuation")).toBe(false);
  expect(baseline.runs[1]!.provider.requests.filter(r => r.schemaName === "truth_resolution_continuation")).toHaveLength(1);
  await Promise.all([...baseline.runs, ...candidate.runs].map(run => run.session.return(undefined)));
});

it("pins the experiment through the production registry and leaves default Compositions unchanged", () => {
  const foundation = { sourceInventory: true, resolutionRepresentation: RESOLUTION_DEPENDENT_FIELDS_CODEC,
    truthTransport: "shared-state-first-v1", planningPipeline: INDEXED_REVIEWED_PLANNING_PIPELINE } as const;
  const base = stepEfficiencyAlgorithmRef(foundation), candidate = stepEfficiencyAlgorithmRef({ ...foundation, planRandomCompletion: true });
  expect(registerBuiltinAlgorithms().has(candidate)).toBe(true);
  expect(candidate.children.truthResolution!.config.planRandomCompletion).toBe(PLAN_RANDOM_COMPLETION);
  expect(base.children.truthResolution!.config.planRandomCompletion).toBeUndefined();
  expect(candidate.manifestHash).not.toBe(base.manifestHash);
  expect(() => stepEfficiencyAlgorithmRef({ planRandomCompletion: true })).toThrow("requires the indexed reviewed pipeline");
});
