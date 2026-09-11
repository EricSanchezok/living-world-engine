import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { TruthResolutionInput } from "../../algorithms/roles";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, ModelSemanticRepairError } from "../../models/model-provider";
import { PLAN_CAUSE_SCOPE } from "../../contracts/prompts";
import { deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { selectTemporalBoundary } from "../temporal";
import { TruthEngine } from "../truth-engine";

function fixture() {
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
    if (role === "truth-resolution" && generated.kind === "commit_plans") {
      return { ...generated, plans: (generated.plans as Array<Record<string, unknown>>).map(plan => ({
        ...plan, mode: "check", baseEffect: "minor",
        means: [{ description: "The actor's own exertion", source: { kind: "entity", id: "player" } }],
        difficulty: { kind: "environment", band: "trivial", source: { kind: "entity", id: "player" } },
        primaryEffect: { kind: "meter", id: "exertion", targetId: "player", channel: "physical-harm",
          label: "exertion", description: "Physical exertion consumes health.",
          sourceRefs: [{ kind: "entity", id: "player" }], meterId: "health:player", impactProfileId: "harm", magnitude: "minor" },
        threatenedEffect: { kind: "meter", id: "strain", targetId: "player", channel: "physical-harm",
          label: "strain", description: "Failed exertion strains the actor.",
          sourceRefs: [{ kind: "entity", id: "player" }], meterId: "health:player", impactProfileId: "harm", magnitude: "minor" },
      })) };
    }
    if (role === "truth-transition" && generated.kind === "transition") {
      const receipt = (context as { state: { resolutionReceipts: Array<{ outcome: string | null }> } }).state.resolutionReceipts[0]!;
      const proposal = generated.proposal as { outcomes: Array<{ status: string }> };
      for (const outcome of proposal.outcomes) {
        outcome.status = receipt.outcome === "miss" ? "failed" : receipt.outcome === "mixed" ? "partial" : "succeeded";
      }
    }
    return generated;
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const action = { id: "stage-action", actorId: "player", baseRevision: state.revision,
    rawText: "Exert myself in the courtyard.", goal: "Exercise", means: null, targetIds: [] };
  const ownership = { acquire: 0, finish: 0 };
  const input: TruthResolutionInput = {
    definition, state, initialActions: [action], groundings: [{ kind: "action", id: action.id, actorId: action.actorId,
      reads: [{ kind: "meter", id: "health:player" }], writes: [{ kind: "entity", id: "player" }, { kind: "meter", id: "health:player" }], audienceAgentIds: [action.actorId], sharedResourceClaims: [], globalFallback: false }],
    identityOwner: "candidate-component", enableReactionRouting: false,
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: state.truth.elapsedSeconds,
      maxAutonomousSpanSeconds: 1, activities: {}, timers: {}, conditionExpiries: {} }),
    orderedRandom: {
      acquire: async () => { ownership.acquire += 1; return structuredClone(state.truth.rng); },
      finish: async rng => { ownership.finish += 1; return structuredClone(rng); },
    },
    resolveReactions: async () => { throw new Error("closed reaction routing"); },
    renderObservations: async () => { throw new Error("candidate preparation must not render observations"); },
    validateProposal: () => { throw new Error("candidate preparation must not validate unrendered observations"); },
  };
  const controller = new AbortController();
  const scope = { workloadId: "stage-world", batchId: "stage-step", cancelPendingSignal: controller.signal,
    runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const session = new TruthEngine(provider, { repairAttempts: 1 }).prepare(input, scope);
  return { provider, input, ownership, controller, session, scope };
}

it("binds initial and targeted repair contexts to the same component action causes", async () => {
  const { input, scope } = fixture();
  const peer = { ...input.initialActions[0]!, id: "component-peer" };
  input.initialActions = [...input.initialActions, peer];
  input.groundings = [...input.groundings, { ...input.groundings[0]!, id: peer.id }];
  const foreign = { ...peer, id: "visible-foreign" };
  input.modelWorkset = { state: input.state, initialActions: [...input.initialActions, foreign],
    availableActions: [...input.initialActions, foreign], availableDependencies: input.groundings };
  const contexts: Array<{ task: { planCauseScope: { contract: string; actionRefs: string[] }; assignment: { targetHandles: string[]; availableHandles: string[] } } }> = [];
  const provider = new ScriptedModelProvider(({ schemaName, profileId, context }) => {
    if (schemaName === "truth_resolution_plan_commit" || schemaName === "truth_resolution_plan_repair") {
      contexts.push(context as typeof contexts[number]);
      if (schemaName === "truth_resolution_plan_repair") throw new ModelConfigurationError("scoped repair reached");
    }
    if (schemaName.startsWith("resolution_plan_verification")) {
      const plans = (context as { state: { candidateResolutionPlans: Array<{ planRef: string }> } }).state.candidateResolutionPlans;
      return { verdict: "reject", findings: [{ planRef: plans[0]!.planRef, code: "ungrounded-mean", message: "Controlled rejection", repairHint: "Recheck source" }] };
    }
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const session = new TruthEngine(provider, { includePlanCauseScope: true }).prepare(input, scope);
  await expect(session.next()).rejects.toThrow("scoped repair reached");
  expect(contexts).toHaveLength(2);
  const [initial, repair] = contexts;
  expect(initial!.task.planCauseScope.contract).toBe(PLAN_CAUSE_SCOPE);
  expect(initial!.task.planCauseScope.actionRefs).toHaveLength(2);
  expect(repair!.task.planCauseScope).toEqual(initial!.task.planCauseScope);
  expect(repair!.task.assignment.targetHandles).toHaveLength(1);
  expect(repair!.task.assignment.availableHandles).toHaveLength(3);
  expect(initial!.task.planCauseScope.actionRefs).toEqual(initial!.task.assignment.targetHandles);
});

it("yields an unreviewed candidate and resumes transition repair with the same actual random commitments", async () => {
  const { provider, input, ownership, session } = fixture();
  const sourceHash = contentHash(input.state);
  const first = await session.next();
  if (first.done) throw new Error("missing first candidate");
  const original = structuredClone(first.value);
  expect(original.resolution).not.toHaveProperty("causalVerification");
  expect(original.resolution.proposal.observations).toEqual([]);
  expect(original.resolution.checks).toHaveLength(1);
  expect(original.resolution.rng.draws).toBeGreaterThan(input.state.truth.rng.draws);
  const preparationCalls = provider.requests.filter(request => request.role !== "truth-transition").length;
  expect(provider.requests.some(request => request.schemaName === "causal_verification" || request.role === "observation-renderer")).toBe(false);
  first.value.resolution.actions[0]!.rawText = "Externally changed action";
  first.value.resolution.checks[0]!.succeeded = !first.value.resolution.checks[0]!.succeeded;
  first.value.reviewEvidence.state.truth.elapsedSeconds += 100;
  const previousReport = { verdict: "reject" as const, findings: [{
    target: { kind: "outcome" as const, id: original.resolution.proposal.outcomes[0]!.id },
    code: "effect-mismatch" as const, message: "The candidate overstates the realized effect.",
    repairHint: "Retain the committed receipt and correct the explanation.",
  }] };
  const repaired = await session.next({ kind: "repair", error: new Error("controlled candidate rejection"), previousReport });
  if (repaired.done) throw new Error("missing repaired candidate");
  expect(repaired.value.transitionAttempt).toBe(1);
  expect(repaired.value.reviewEvidence.previousReport).toEqual(previousReport);
  for (const field of ["actions", "checks", "rng", "resolutionPlans", "resolutionReceipts", "commitmentRounds"] as const) {
    expect(repaired.value.resolution[field]).toEqual(original.resolution[field]);
  }
  expect(provider.requests.filter(request => request.role !== "truth-transition")).toHaveLength(preparationCalls);
  expect(provider.requests.filter(request => request.role === "truth-transition")).toHaveLength(2);
  expect(ownership).toEqual({ acquire: 1, finish: 1 });
  expect(contentHash(input.state)).toBe(sourceHash);
  const beforeFinish = provider.requests.length;
  const completed = await session.next({ kind: "finish" });
  if (!completed.done || !completed.value) throw new Error("missing finished candidate");
  expect(completed.value).not.toHaveProperty("causalVerification");
  const invocations = completed.value.modelAudits.filter(audit => audit.role === "truth-transition")
    .flatMap(audit => audit.invocations);
  expect(invocations?.map(invocation => invocation.ordinal)).toEqual([1, 2]);
  expect(invocations?.[0]?.outputDisposition).toBe("rejected");
  expect(provider.requests).toHaveLength(beforeFinish);
});

it.each(["close", "cancel", "missing-feedback", "exhaust-repair"] as const)("retains a bounded suspended lifecycle: %s", async mode => {
  const { provider, session, ownership, controller, input } = fixture();
  const sourceHash = contentHash(input.state);
  await session.next();
  const initialCalls = provider.requests.length;
  if (mode === "close") {
    expect(await session.return(undefined)).toEqual({ done: true, value: undefined });
  } else if (mode === "cancel") {
    controller.abort(new DOMException("candidate cancelled", "AbortError"));
    await expect(session.next({ kind: "finish" })).rejects.toThrow("candidate cancelled");
  } else if (mode === "missing-feedback") {
    await expect(session.next()).rejects.toThrow("explicit feedback");
  } else {
    const feedback = { kind: "repair" as const, error: new Error("controlled rejection"), previousReport: null };
    await session.next(feedback);
    const beforeExhaustion = provider.requests.length;
    await expect(session.next(feedback)).rejects.toBeInstanceOf(ModelSemanticRepairError);
    expect(provider.requests).toHaveLength(beforeExhaustion);
  }
  if (mode !== "exhaust-repair") expect(provider.requests).toHaveLength(initialCalls);
  expect(ownership).toEqual({ acquire: 1, finish: 1 });
  expect(contentHash(input.state)).toBe(sourceHash);
  expect(await session.next()).toEqual({ done: true, value: undefined });
});
