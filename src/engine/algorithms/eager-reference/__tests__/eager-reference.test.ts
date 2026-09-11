import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolutionObservations,
  type WorldExecutionAlgorithm,
} from "../../../runtime/execution";
import {
  EagerReferenceAlgorithm,
  DEFAULT_EAGER_REFERENCE_CONFIG,
} from "../eager-reference";
import { historyReplayBaseHash } from "../../../runtime/history-replay";
import { replaySimulationState } from "../../../runtime/transaction";
import type { AgentActionProposal, SimulationState } from "../../../contracts/model";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor, type ExistingReferenceHandle } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import { ModelOutputError, ModelSemanticRepairError, ModelTransportError } from "../../../models/model-provider";
import { SimulationEngine } from "../../../runtime/simulation";
import { CanonicalCommitter } from "../../../runtime/canonical-committer";
import {
  DeterministicModelProvider,
  deterministicActionCompilationBatch,
  deterministicInteractionDependency,
  deterministicAgentMindBatch,
  deterministicModelOutput,
  ScriptedModelProvider,
} from "../../../testing/model-provider";
import {
  normalizeObservationLocalReferences,
  normalizeObservationSourceEventIds,
} from "../../../cognition/observation-renderer";
import { AgentMind } from "../agent-mind";
import { normalizeOutcomeAlternativeEvidence } from "../../../mechanics/truth-engine";
import { loadWorldScript } from "../../../../script/world-loader";
import { ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION } from "../candidate-retrieval/runtime";
import { RELATIONAL_RRF_ENCODER_FINGERPRINT } from "../candidate-retrieval/relational-rrf";
import { registerBuiltinAlgorithms, FULL_CATALOG_ALGORITHM_REF } from "../../registry";
import { WorldExecutionAlgorithmRegistry } from "../../../runtime/execution";
import { sharedContextAlgorithmRef, orderedRandomAlgorithmRef } from "../../../benchmarks/step-efficiency/protocol";

type AssignedModelAction = {
  actionRef: string;
  actorRef: string;
  rawText: string;
  goal: string;
  means: string | null;
  targetRefs: string[];
};

it("fails closed when a retrieval-enabled algorithm has no pinned runtime", () => {
  const provider = new DeterministicModelProvider();
  expect(() => new EagerReferenceAlgorithm(provider, undefined, {
    ...DEFAULT_EAGER_REFERENCE_CONFIG,
    candidateRetrieval: {
      mode: "runtime",
      runtimeVersion: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
      encoderFingerprint: RELATIONAL_RRF_ENCODER_FINGERPRINT,
      budgetRatio: 0.2,
    },
  })).toThrow(/runtime is required/u);
});

function assignedActions(context: unknown): AgentActionProposal[] {
  const state = (context as { state?: { actionSet?: { assigned?: AssignedModelAction[] } } }).state;
  return (state?.actionSet?.assigned ?? []).map((action) => ({
    id: action.actionRef.replace(/^ref:action:/u, ""),
    actorId: action.actorRef.replace(/^ref:agent:/u, ""),
    baseRevision: 0,
    rawText: action.rawText,
    goal: action.goal,
    means: action.means,
    targetIds: action.targetRefs.map((target) => target.replace(/^ref:local_entity:[^:]+::/u, "")),
  }));
}

function actorEntities(context: unknown): Record<string, { entityId: string }> {
  const actors = (context as { actors?: Array<{ agentRef: string; entityRef: string }> }).actors ?? [];
  return Object.fromEntries(actors.map((actor) => [
    actor.agentRef.replace(/^ref:agent:/u, ""),
    { entityId: actor.entityRef.replace(/^ref:entity:/u, "") },
  ]));
}

describe("eager reference safeguards", () => {
  it.each([false, true])("releases the canonical stream before transitions and preserves replay or atomic failure (terminal failure: %s)", async (terminalFailure) => {
    const run = async (ordered: boolean) => {
      let commits = 0;
      const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
        if (role === "action-compilation") {
          return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
            compilation.interactionDependency = deterministicInteractionDependency({
              reads: [{ kind: "meter", id: `health:${action.actorId}` }],
              writes: [{ kind: "entity", id: action.actorId }, { kind: "meter", id: `health:${action.actorId}` }],
              audienceAgentIds: [action.actorId], sharedResourceClaims: [],
            });
          });
        }
        const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
        if (role === "truth-resolution" && generated.kind === "commit_plans") {
          commits += 1;
          const actions = assignedActions(context);
          return { ...generated, plans: (generated.plans as Array<Record<string, unknown>>).map((plan, index) => {
            const actor = actions[index]!.actorId;
            return { ...plan, mode: "check", baseEffect: "minor",
              means: [{ description: "The actor's own physical exertion", source: { kind: "entity", id: actor } }],
              difficulty: { kind: "environment", band: "trivial", source: { kind: "entity", id: actor } },
              threatenedEffect: { kind: "meter", id: `strain-${actor}`, targetId: actor, channel: "physical-harm",
                label: "strain", description: "Failed exertion strains the actor.",
                sourceRefs: [{ kind: "entity", id: actor }], meterId: `health:${actor}`, impactProfileId: "harm", magnitude: "minor" },
              primaryEffect: { kind: "meter", id: `exertion-${actor}`, targetId: actor, channel: "physical-harm",
                label: "exertion", description: "The isolated exertion consumes the actor's own health.",
                sourceRefs: [{ kind: "entity", id: actor }], meterId: `health:${actor}`, impactProfileId: "harm", magnitude: "minor" },
            };
          }) };
        }
        if (role === "truth-transition" && generated.kind === "transition") {
          const receipts = (context as { state: { resolutionReceipts: Array<{ plan: { actionRef: string }; outcome: string | null; checkRef: string | null }> } }).state.resolutionReceipts;
          const proposal = generated.proposal as { outcomes: Array<{ actionRef: string; status: string; causes: Array<{ kind: string; ref: string }>; assertions: Array<unknown> }> };
          for (const outcome of proposal.outcomes) {
            const receipt = receipts.find((entry) => entry.plan.actionRef === outcome.actionRef)!;
            if (outcome.status !== "continuing") outcome.status = receipt.outcome === "miss" ? "failed" : receipt.outcome === "mixed" ? "partial" : "succeeded";
            if (receipt.checkRef) {
              outcome.causes.push({ kind: "check", ref: receipt.checkRef });
              const check = (context as { state: { checkResults: Array<{ checkRef: string; succeeded: boolean }> } }).state.checkResults.find((item) => item.checkRef === receipt.checkRef)!;
              outcome.assertions.push({ kind: "check_result", checkId: receipt.checkRef, expected: check.succeeded ? "succeeded" : "failed" });
            }
          }
        }
        return generated;
      });
      let transitionsOverlap = !ordered;
      let firstWaiting = false;
      const generate = provider.generateStructured.bind(provider);
      let firstTransitionSubject: string | undefined;
      let releaseFirst!: () => void;
      const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
      let finalReviews = 0;
      const finalReviewer = new ScriptedModelProvider(({ context }) => {
        finalReviews += 1;
        if (finalReviews === 1) {
          const candidate = (context as { state: { candidate: { operations: Array<{ kind: string; operationRef: string }> } } }).state.candidate;
          const operation = candidate.operations.filter(value => value.kind !== "advance_time").at(-1)!;
          return { verdict: "reject", findings: [{ target: { kind: "operation", targetHandle: operation.operationRef },
            evidenceHandles: [], code: "effect-mismatch", message: "Correct the interval explanation.",
            repairHint: "Keep the actual committed checks and receipts." }] };
        }
        return { verdict: "accept", findings: [] };
      }, provider.catalog, false);
      provider.generateStructured = async request => {
        if (ordered && request.schemaName === "causal_verification") return finalReviewer.generateStructured(request);
        if (ordered && request.role === "truth-transition") {
          if (firstTransitionSubject === undefined) {
            firstTransitionSubject = request.subjectId;
            // Fail the ordering assertion without leaving a hung test process.
            firstWaiting = true;
            const deadline = setTimeout(releaseFirst, 3000);
            await firstRelease;
            firstWaiting = false;
            clearTimeout(deadline);
            if (terminalFailure) throw new ModelTransportError("controlled failure after releasing random commitments");
          } else if (request.subjectId !== firstTransitionSubject) {
            transitionsOverlap ||= firstWaiting;
            releaseFirst();
          }
        }
        return generate(request);
      };
      const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
      definition.initialState.truth.placements.keeper = "gate";
      definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
      const algorithm = ordered
        ? registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).create(orderedRandomAlgorithmRef(FULL_CATALOG_ALGORITHM_REF), { provider })
        : new EagerReferenceAlgorithm(provider);
      const engine = new SimulationEngine(definition, algorithm);
      await engine.bootstrapAgents();
      const state = engine.snapshot;
      const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
        kind: "model" as const, agentId: agent.id, profiles: structuredClone(agent.modelProfiles),
      }]));
      if (terminalFailure) {
        await expect(engine.step(roster, { expectedRevision: state.revision, trigger: "manual", externalActions: [] }))
          .rejects.toMatchObject({ errors: expect.arrayContaining([expect.objectContaining({
            name: "ModelTransportError", message: "controlled failure after releasing random commitments",
          })]) });
        expect(transitionsOverlap).toBe(true);
        expect(contentHash(engine.snapshot)).toBe(contentHash(state));
        return null;
      }
      const result = await engine.step(roster, { expectedRevision: state.revision, trigger: "manual", externalActions: [] });
      expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
      expect(transitionsOverlap).toBe(true);
      if (ordered) expect(finalReviews).toBe(2);
      return { result, commits };
    };
    if (terminalFailure) {
      expect(await run(true)).toBeNull();
      return;
    }
    const baseline = await run(false);
    const candidate = await run(true);
    if (!baseline || !candidate) throw new Error("expected committed comparison runs");
    expect(baseline.commits).toBe(4);
    expect(candidate.commits).toBe(2);
    expect(candidate.result.state.truth.rng).toEqual(baseline.result.state.truth.rng);
    expect(candidate.result.committed.checks).toEqual(baseline.result.committed.checks);
    expect(contentHash(candidate.result.state.truth)).toBe(contentHash(baseline.result.state.truth));
  });

  it("stops sibling follow-up calls after terminal component failure and preserves the source state", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [], writes: [{ kind: "entity", id: action.actorId }],
            audienceAgentIds: [action.actorId], sharedResourceClaims: [],
          });
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const generate = provider.generateStructured.bind(provider);
    let failingCalls = 0;
    let siblingStarted = false;
    let siblingSignal: AbortSignal | undefined;
    let releaseSibling!: () => void;
    const siblingRelease = new Promise<void>((resolve) => { releaseSibling = resolve; });
    let terminal = false;
    let lateCalls = 0;
    provider.generateStructured = async (request) => {
      if (terminal) lateCalls += 1;
      if (request.role === "truth-resolution" && request.subjectId.includes("component-keeper")) {
        failingCalls += 1;
        if (failingCalls === 3) {
          terminal = true;
          setTimeout(releaseSibling, 0);
        }
        throw new ModelOutputError("injected irrecoverable component output");
      }
      if (request.role === "truth-resolution" && request.subjectId.includes("component-player")) {
        siblingStarted = true;
        siblingSignal = request.cancelPendingSignal;
        await siblingRelease;
      }
      return generate(request);
    };
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: provider.catalog,
    });
    definition.initialState.truth.placements.keeper = "gate";
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const state = engine.snapshot;
    const before = contentHash(state);
    const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
      kind: "model" as const, agentId: agent.id, profiles: structuredClone(agent.modelProfiles),
    }]));
    const failure = await engine.step(roster, { expectedRevision: state.revision, trigger: "manual", externalActions: [] })
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBeInstanceOf(ModelSemanticRepairError);
    expect(failingCalls).toBe(3);
    expect(siblingStarted).toBe(true);
    expect(siblingSignal?.aborted).toBe(true);
    expect(lateCalls).toBe(0);
    expect(contentHash(engine.snapshot)).toBe(before);
  });

  it("adjudicates a unique resource with its incumbent and commits only a capacity-legal winner", async () => {
    let poolId = "";
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          compilation.temporalPlan = {
            profileRef: referenceHandleFor("temporal_profile", "ongoing-action"),
            basis: { kind: "profile" },
            description: action.rawText,
            continuationAssertions: [],
            causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
          };
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [{ kind: "shared_resource_pool", id: poolId }],
            writes: [{ kind: "shared_resource_pool", id: poolId }],
            audienceAgentIds: ["keeper", "player"],
            sharedResourceClaims: [{ poolId, basis: { kind: "default" } }],
          });
        });
      }
      if (role === "truth-resolution") {
        const input = context as {
          committedResolutionPlans?: unknown[];
          task: { assignedActions: Array<{ actionRef: string; actorRef: string; goal: string }> };
          actors: Array<{ agentRef: string; entityRef: string }>;
          world: { disclosure: { defaultCheckVisibility: "full" | "result_only" | "hidden" } };
        };
        if (input.committedResolutionPlans?.length) return { kind: "done" };
        const actions = assignedActions(context);
        const actors = actorEntities(context);
        return {
          kind: "commit_plans",
          plans: actions.map((action, index) => ({
            id: `resource-plan-${index}`,
            actionId: action.id,
            actorId: actors[action.actorId]!.entityId,
            targetIds: [actors[action.actorId]!.entityId],
            goal: action.goal,
            means: [],
            mode: action.actorId === "keeper" ? "blocked" : "automatic",
            difficulty: null,
            actorRatingId: null,
            factors: [],
            risk: "safe",
            baseEffect: "none",
            primaryEffect: null,
            secondaryEffect: null,
            threatenedEffect: null,
            visibility: input.world.disclosure.defaultCheckVisibility,
            causes: [{ kind: "action", id: action.id }],
          })),
        };
      }
      const output = deterministicModelOutput(profileId, context);
      if (role === "truth-transition") {
        const transition = structuredClone(output) as {
          proposal: { outcomes: Array<{ actionRef: string; status: string; summary: string }> };
        };
        const actions = assignedActions(context);
        const contender = actions.find((action) => action.actorId === "keeper");
        const outcome = contender && transition.proposal.outcomes.find((entry) => entry.actionRef === referenceHandleFor("action", contender.id));
        if (outcome) {
          outcome.status = "blocked";
          outcome.summary = "现有持有者保住了唯一资源。";
        }
        return transition;
      }
      return output;
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const sharedDefinition = definition.initialState.truth.mechanics.sharedActivityResources["fixture-workbench"]!;
    sharedDefinition.contention = "adjudicate";
    sharedDefinition.pausedRetention = "retain";
    poolId = Object.values(definition.initialState.truth.sharedActivityResourcePools)[0]!.id;
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const held = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "player-participant" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "hold-unique-resource",
        agentId: "player",
        rawText: "持续占用唯一工作台",
        goal: "占用工作台",
        means: "工作台",
        targetIds: [],
      }],
    });
    const holder = Object.values(held.state.truth.activities).find((activity) => activity.actorId === "player")!;
    const contested = await engine.step({
      player: { kind: "idle", agentId: "player", reason: "explicit" },
      keeper: { kind: "external", agentId: "keeper", participantId: "keeper-participant" },
    }, {
      expectedRevision: held.state.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "contest-unique-resource",
        agentId: "keeper",
        rawText: "争夺唯一工作台并持续使用",
        goal: "取得工作台",
        means: "争夺",
        targetIds: [],
      }],
    });
    const contender = Object.values(contested.state.truth.activities).find((activity) => activity.actorId === "keeper")!;
    expect(contested.committed.sharedResourceAdmissions).toContainEqual(expect.objectContaining({
      kind: "adjudicate",
      activityId: contender.id,
      competingActivityIds: [holder.id],
    }));
    expect(contested.committed.actions.map((action) => action.id)).toEqual(expect.arrayContaining([
      holder.sourceActionId,
      contender.sourceActionId,
    ]));
    expect(contested.state.truth.activities[holder.id]?.status).toBe("active");
    expect(contested.state.truth.activities[contender.id]?.status).toBe("blocked");
    expect(provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(2);
    expect(() => replaySimulationState(contested.state)).not.toThrow();
  });

  it("commits a capacity-safe FIFO queue without sending the blocked contender to Truth", async () => {
    let workbenchPoolId = "";
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          const claims = action.rawText.includes("工作台")
            ? [{ poolId: workbenchPoolId, basis: { kind: "default" as const } }]
            : [];
          if (action.rawText.includes("工作台")) {
            compilation.temporalPlan = {
              profileRef: referenceHandleFor("temporal_profile", "ongoing-action"),
              basis: { kind: "profile" },
              description: action.rawText,
              continuationAssertions: [],
              causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
            };
          }
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: claims.map((claim) => ({ kind: "shared_resource_pool" as const, id: claim.poolId })),
            writes: claims.map((claim) => ({ kind: "shared_resource_pool" as const, id: claim.poolId })),
            audienceAgentIds: [action.actorId],
            sharedResourceClaims: claims,
          });
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    workbenchPoolId = Object.values(definition.initialState.truth.sharedActivityResourcePools)[0]!.id;
    const delegate = new EagerReferenceAlgorithm(provider);
    let latestCandidate: import("../../../runtime/execution").WorldStepCandidate | undefined;
    const algorithm: WorldExecutionAlgorithm = {
      manifest: delegate.manifest,
      bootstrap: (input, context) => delegate.bootstrap(input, context),
      prepareStep: (input, context) => delegate.prepareStep(input, context),
      completeStep: async (input, preparation, reactions, context) => {
        latestCandidate = await delegate.completeStep(input, preparation, reactions, context);
        return latestCandidate;
      },
    };
    const engine = new SimulationEngine(definition, algorithm);
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const first = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "player-participant" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "take-workbench",
        agentId: "player",
        rawText: "持续使用工作台修理工具",
        goal: "修理工具",
        means: "工作台",
        targetIds: [],
      }],
    });
    const holder = Object.values(first.state.truth.activities).find((activity) => activity.actorId === "player")!;
    expect(holder).toMatchObject({ status: "active", sharedResourceClaims: [{ poolId: workbenchPoolId, amount: 1 }] });

    const secondRoster = {
      player: { kind: "idle", agentId: "player", reason: "explicit" },
      keeper: { kind: "external", agentId: "keeper", participantId: "keeper-participant" },
    } as const;
    const second = await engine.step(secondRoster, {
      expectedRevision: first.state.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "queue-workbench",
        agentId: "keeper",
        rawText: "持续使用工作台打磨零件",
        goal: "打磨零件",
        means: "工作台",
        targetIds: [],
      }],
    });

    const queued = Object.values(second.state.truth.activities).find((activity) => activity.actorId === "keeper")!;
    expect(queued).toMatchObject({ status: "queued", enqueuedAtSeconds: first.state.truth.elapsedSeconds });
    expect(second.committed.sharedResourceAdmissions).toContainEqual(expect.objectContaining({
      kind: "queue",
      activityId: queued.id,
      shortagePoolIds: [workbenchPoolId],
    }));
    expect(second.committed.outcomes).toContainEqual(expect.objectContaining({
      proposalId: queued.sourceActionId,
      status: "continuing",
      summary: "等待共享资源：庭院工作台",
    }));
    expect(second.committed.resolutionPlans.some((plan) => plan.actionId === queued.sourceActionId)).toBe(false);
    expect(() => replaySimulationState(second.state)).not.toThrow();
    if (!latestCandidate) throw new Error("test algorithm did not capture its candidate");
    const forged = structuredClone(latestCandidate);
    const queueAdmission = forged.sharedResourceAdmissions.find((admission) => admission.activityId === queued.id)!;
    if (queueAdmission.kind !== "queue") throw new Error("test candidate did not queue its contender");
    forged.sharedResourceAdmissions = forged.sharedResourceAdmissions.map((admission) =>
      admission.activityId === queued.id
        ? { kind: "reject" as const, activityId: admission.activityId, shortagePoolIds: queueAdmission.shortagePoolIds }
        : admission);
    expect(() => new CanonicalCommitter().step(
      first.state,
      forged,
      secondRoster,
      definition.runtimeDefaults.maxAutonomousSpanSeconds,
    )).toThrow("admissions do not match trusted capacity allocation");

    const released = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "player-participant" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: second.state.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "release-workbench",
        agentId: "player",
        rawText: "停止修理并在一旁休息",
        goal: "结束修理",
        means: null,
        targetIds: [],
      }],
    });
    const ready = released.state.truth.activities[queued.id]!;
    expect(ready).toMatchObject({ status: "ready", reservedAtSeconds: released.state.truth.elapsedSeconds });
    expect(released.committed.activityTransitions.map((transition) => transition.kind)).toContain("reserved");

    const started = await engine.step({
      player: { kind: "idle", agentId: "player", reason: "explicit" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: released.state.revision,
      trigger: "manual",
      externalActions: [],
    });
    const resumed = started.state.truth.activities[queued.id]!;
    expect(resumed).toMatchObject({ status: "active", startedAtSeconds: released.state.truth.elapsedSeconds });
    expect(started.committed.temporalPlans).toContainEqual(expect.objectContaining({
      actionId: queued.sourceActionId,
      startsAtSeconds: released.state.truth.elapsedSeconds,
    }));
    expect(resumed.updatedAtSeconds).toBeGreaterThan(released.state.truth.elapsedSeconds);
    expect(() => replaySimulationState(started.state)).not.toThrow();
  });

  it("drops invalid or duplicate observation event references without changing narration", () => {
    const normalized = normalizeObservationSourceEventIds([{
      summary: "钟声从港口传来。",
      introductions: [],
      apparentClaims: [],
      sourceEventIds: ["event-valid", "action-invalid", "event-valid"],
    }], new Set(["event-valid"]));

    expect(normalized).toEqual({
      drafts: [{
        summary: "钟声从港口传来。",
        introductions: [],
        apparentClaims: [],
        sourceEventIds: ["event-valid"],
      }],
      droppedReferences: 2,
    });
  });

  it("keeps only observation claims grounded in the observer local entity graph", () => {
    const state = {
      agents: {
        a: {
          belief: { localEntities: { self: { id: "self" } } },
          bindings: { self: { localEntityId: "self", canonicalEntityIds: ["entity-a"] } },
        },
      },
      truth: { entities: { "entity-a": { id: "entity-a" }, place: { id: "place" } } },
    } as unknown as SimulationState;
    const normalized = normalizeObservationLocalReferences(state, ["a"], [{
      summary: "港口仍在下雨。",
      introductions: [
        {
          localEntity: { id: "harbor", name: "港口", description: "雨中的港口", status: "observed" },
          canonicalEntityId: "place",
        },
        {
          localEntity: { id: "self", name: "我", description: "重复引入", status: "observed" },
          canonicalEntityId: "entity-a",
        },
      ],
      apparentClaims: [
        { subjectId: "harbor", predicate: "weather", value: { kind: "text", value: "rain" }, description: "下雨" },
        { subjectId: "city-orders", predicate: "status", value: { kind: "text", value: "unknown" }, description: "无局部主体" },
      ],
      sourceEventIds: [],
    }]);

    expect(normalized.drafts[0].introductions.map((entry) => entry.localEntity.id)).toEqual(["harbor"]);
    expect(normalized.drafts[0].apparentClaims.map((claim) => claim.subjectId)).toEqual(["harbor"]);
    expect(normalized).toMatchObject({ droppedClaims: 1, droppedIntroductions: 1, clearedCanonicalBindings: 0 });
  });

  it("keeps deterministic canonical semantics identical for singleton and larger slot limits", async () => {
    const execute = async (actionCompilationMaxSlots: number, agentMindMaxSlots: number) => {
      const provider = new DeterministicModelProvider();
      const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
        seed: 47,
        modelCatalog: provider.catalog,
      });
      const engine = new SimulationEngine(
        definition,
        new EagerReferenceAlgorithm(provider, undefined, {
          actionCompilationMaxSlots,
          agentMindMaxSlots,
          reactionMaxSlots: 8,
          groundingMaxSlots: 16,
          truthBatchMaxSlots: 12,
          candidateRetrieval: { mode: "off" },
        }),
      );
      await engine.bootstrapAgents();
      const source = engine.snapshot;
      const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
        kind: "model" as const,
        agentId: agent.id,
        profiles: structuredClone(agent.modelProfiles),
      }]));
      const result = await engine.step(roster, {
        expectedRevision: source.revision,
        trigger: "manual",
        externalActions: [],
      });
      return { provider, result };
    };

    const [singleton, batched] = await Promise.all([execute(1, 1), execute(12, 8)]);
    expect(singleton.result.committed.semanticHash).toBe(batched.result.committed.semanticHash);
    expect(contentHash(singleton.result.state.truth)).toBe(contentHash(batched.result.state.truth));
    expect(singleton.provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(2);
    expect(batched.provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(1);
    expect(singleton.provider.requests.filter((request) => request.role === "agent-mind")).toHaveLength(2);
    expect(batched.provider.requests.filter((request) => request.role === "agent-mind")).toHaveLength(1);
    const batchedCompilationRequest = batched.provider.requests.find((request) => request.role === "action-compilation");
    const batchedContext = batchedCompilationRequest?.context as {
      referenceCatalog?: {
        version: number;
        candidates?: Array<{ candidateKey: string; scope?: { kind: "shared" } | { kind: "slot"; slot: number }; details?: unknown }>;
      };
      referenceCatalogs?: unknown[];
      state?: { canonicalTruth?: unknown };
    };
    expect(batchedContext.referenceCatalog?.version).toBe(2);
    expect(batchedContext.referenceCatalog?.candidates?.length).toBeGreaterThan(0);
    expect(new Set(batchedContext.referenceCatalog?.candidates?.map((candidate) => candidate.candidateKey)).size)
      .toBe(batchedContext.referenceCatalog?.candidates?.length);
    expect(batchedContext.referenceCatalog?.candidates?.filter((candidate) => candidate.scope?.kind === "slot"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ scope: { kind: "slot", slot: 0 } }),
        expect.objectContaining({ scope: { kind: "slot", slot: 1 } }),
      ]));
    expect(batchedContext.referenceCatalogs).toBeUndefined();
    expect(batchedContext.state?.canonicalTruth).toBeUndefined();
    expect(JSON.stringify(batchedContext)).not.toContain("availableHandles");
  });

  it("starts known action compilation before a resumed AgentMind completes", async () => {
    const events: string[] = [];
    let releaseMind!: () => void;
    const mindGate = new Promise<void>((resolve) => { releaseMind = resolve; });
    const provider = new ScriptedModelProvider(async ({ role, profileId, context }) => {
      if (role === "action-compilation") {
        events.push("compile:start");
        await mindGate;
        events.push("compile:end");
        return deterministicModelOutput(profileId, context);
      }
      if (role === "agent-mind") {
        events.push("mind:start");
        releaseMind();
        events.push("mind:end");
        return deterministicModelOutput(profileId, context);
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const bootstrapEngine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await bootstrapEngine.bootstrapAgents();
    const source = bootstrapEngine.snapshot;
    source.agents.keeper!.nextAction = null;
    const algorithm = new EagerReferenceAlgorithm(provider);
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await algorithm.prepareStep({
      definition,
      state: source,
      policyRoster: roster,
      request: {
        expectedRevision: source.revision,
        trigger: "manual",
        externalActions: [],
      },
      decisionEligibleAgentIds: Object.keys(source.agents).sort(),
    }, {
      modelScope: {
        workloadId: "overlap-test",
        batchId: "prepare-overlap-test",
        runtimeIdentity: { worldHash: source.worldHash, revision: source.revision },
      },
      instrumentation: { emit: () => undefined },
    });

    expect(events.indexOf("compile:start")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("mind:start")).toBeGreaterThan(events.indexOf("compile:start"));
    expect(events.indexOf("compile:end")).toBeGreaterThan(events.indexOf("mind:end"));
  });

  it.each([false, true])("pipelines resumed compilation while known work is pending, preserving complete preparation (failed known work: %s)", async (failKnown) => {
    const bootstrapProvider = new DeterministicModelProvider();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: bootstrapProvider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(bootstrapProvider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    source.agents.keeper!.nextAction = null;
    const sourceHash = contentHash(source);
    const input = {
      definition, state: source,
      policyRoster: Object.fromEntries(Object.values(source.agents).map(agent => [agent.id, {
        kind: "model" as const, agentId: agent.id, profiles: structuredClone(agent.modelProfiles),
      }])),
      request: { expectedRevision: source.revision, trigger: "manual" as const, externalActions: [] },
      decisionEligibleAgentIds: Object.keys(source.agents).sort(),
    };
    const context = {
      modelScope: { workloadId: "pipeline-test", batchId: "prepare-pipeline-test",
        runtimeIdentity: { worldHash: source.worldHash, revision: source.revision } },
      instrumentation: { emit: () => undefined },
    };
    let releaseKnown!: () => void;
    const knownGate = new Promise<void>(resolve => { releaseKnown = resolve; });
    let releaseMind!: () => void;
    const mindGate = new Promise<void>(resolve => { releaseMind = resolve; });
    let compilationCalls = 0, mindStarted = false;
    const failure = new ModelTransportError("known compilation unavailable");
    const provider = new ScriptedModelProvider(async request => {
      if (request.role === "agent-mind") {
        mindStarted = true;
        if (failKnown) await mindGate;
      }
      if (request.role === "action-compilation") {
        if (++compilationCalls === 1) {
          await knownGate;
          if (failKnown) throw failure;
        }
      }
      return deterministicModelOutput(request.profileId, request.context);
    });
    const pending = new EagerReferenceAlgorithm(provider).prepareStep(input, context);
    // Attach the failure observer immediately while independent model work is pending.
    const outcome = pending.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
    try {
      if (failKnown) {
        await expect.poll(() => mindStarted).toBe(true);
        releaseKnown();
        expect((await outcome).error).toBe(failure);
        releaseMind();
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(compilationCalls).toBe(1);
      } else {
        await expect.poll(() => compilationCalls).toBe(2);
        releaseKnown();
        const actual = await pending;
        const reference = new ScriptedModelProvider(request => deterministicModelOutput(request.profileId, request.context));
        const expected = await new EagerReferenceAlgorithm(reference).prepareStep(input, context);
        expect(actual.payload).toEqual(expected.payload);
        expect(actual.pendingReactionRequests).toEqual(expected.pendingReactionRequests);
        expect(actual.preparedReactionDecisions).toEqual(expected.preparedReactionDecisions);
        const requests = (p: ScriptedModelProvider) => p.requests.map(request => contentHash({
          role: request.role, profileId: request.profileId, schemaName: request.schemaName,
          system: request.system, userPrompt: request.userPrompt, context: request.context,
        })).sort();
        expect(requests(provider)).toEqual(requests(reference));
      }
      expect(contentHash(source)).toBe(sourceHash);
    } finally {
      releaseKnown();
      releaseMind();
      await outcome;
    }
  });

  it("recovers a compressed multi-action resolution response with one-action scopes", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "truth-resolution") {
        const generated = deterministicModelOutput(profileId, context) as {
          kind: string;
          plans?: unknown[];
        };
        const actions = assignedActions(context);
        if (generated.kind === "commit_plans" && actions.length > 1) {
          return { ...generated, plans: generated.plans?.slice(0, 1) };
        }
        return generated;
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));
    const result = await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(result.committed.actions).toHaveLength(Object.keys(source.agents).length);
    expect(result.committed.resolutionPlans).toHaveLength(result.committed.actions.length);
    expect(result.committed.outcomes).toHaveLength(result.committed.actions.length);
    expect(result.committed.operations.filter((operation) => operation.kind === "advance_time")).toHaveLength(1);
    const truthResolutionRequests = provider.requests.filter((request) => request.role === "truth-resolution");
    expect(truthResolutionRequests.length).toBeGreaterThan(0);
    expect(truthResolutionRequests.every((request) =>
      [
        "truth_resolution_plan_commit",
        "truth_resolution_continuation",
        "truth_resolution_plan_repair",
        "truth_resolution_batch",
      ].includes(request.schemaName)))
      .toBe(true);
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });

  it("retains valid AgentMind slots and retries only the invalid Agent", async () => {
    let rejectedKeeper = false;
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "agent-mind") {
        return deterministicAgentMindBatch(context, (output, slot) => {
          if (!rejectedKeeper && slot.state.perspective.agentRef === "ref:agent:keeper") {
          output.nextActionIntent.targetHandles = ["ref:local_entity:unknown-local-target" as ExistingReferenceHandle];
            rejectedKeeper = true;
          }
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    const requests = provider.requests.filter((request) => request.role === "agent-mind");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) =>
      (request.context as { slots: Array<{ agentState: { perspective: { agentRef: string } } }> }).slots
        .map((slot) => slot.agentState.perspective.agentRef.replace(/^ref:agent:/u, "")))).toEqual([
      ["keeper", "player"],
      ["keeper"],
    ]);
    expect(requests[0]!.context).toMatchObject({
      slots: expect.arrayContaining([expect.objectContaining({
        agentState: expect.any(Object),
        task: expect.any(Object),
        referenceCatalog: expect.any(Object),
        allowedTargetHandles: expect.any(Array),
        repair: null,
      })]),
    });
    expect(requests[0]!.context).not.toHaveProperty("state");
    expect(requests[0]!.context).not.toHaveProperty("referenceCatalogs");
    const audits = result.modelAudits.filter((audit) => audit.role === "agent-mind");
    expect(audits).toHaveLength(2);
    expect(new Set(audits.flatMap((audit) => audit.invocations.map((invocation) => invocation.id))).size).toBe(2);
    expect(audits[0]!.invocations[0]).toMatchObject({
      referenceCatalogVersion: 2,
      referenceCatalogHash: expect.any(String),
    });
  });

  it("isolates all three AgentMind purposes and model profiles", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const state = structuredClone(definition.initialState);
    state.agents.keeper!.modelProfiles.bootstrap = "agent-openai";
    state.agents.keeper!.modelProfiles.mind = "agent-xai";
    const mind = new AgentMind(provider);
    const inputs = Object.values(state.agents).map((agent) => ({
      agent,
      observations: [],
      currentResolution: { action: null, outcome: null },
      events: [],
    }));
    const scope = {
      workloadId: "purpose-profile-test",
      batchId: "purpose-profile-test",
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
    };

    await mind.thinkBatch(state, inputs, scope, "bootstrap", 8);
    await mind.thinkBatch(state, inputs, scope, "resume", 8);
    await mind.thinkBatch(state, inputs, scope, "mind", 8);

    const requests = provider.requests.filter((request) =>
      request.role === "agent-bootstrap" || request.role === "agent-mind");
    expect(requests).toHaveLength(6);
    expect(requests.map((request) => {
      const context = request.context as {
        roleContract: { role: "agent-bootstrap" | "agent-mind" };
        slots: Array<{ agentState: { perspective: { agentRef: string } } }>;
      };
      return {
        role: context.roleContract.role,
        profileId: request.profileId,
        agents: context.slots.map((slot) => slot.agentState.perspective.agentRef.replace(/^ref:agent:/u, "")),
      };
    })).toEqual([
      { role: "agent-bootstrap", profileId: "agent-deepseek", agents: ["player"] },
      { role: "agent-bootstrap", profileId: "agent-openai", agents: ["keeper"] },
      { role: "agent-mind", profileId: "agent-deepseek", agents: ["player"] },
      { role: "agent-mind", profileId: "agent-xai", agents: ["keeper"] },
      { role: "agent-mind", profileId: "agent-deepseek", agents: ["player"] },
      { role: "agent-mind", profileId: "agent-xai", agents: ["keeper"] },
    ]);
  });

  it("retains valid Action Compilation slots and retries only the invalid action", async () => {
    let rejectedKeeper = false;
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          if (!rejectedKeeper && action.actorId === "keeper") {
            compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "missing-temporal-profile");
            rejectedKeeper = true;
          }
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    const requests = provider.requests.filter((request) => request.role === "action-compilation");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) =>
      (request.context as { task: { slots: Array<{ actionReferences: { actor: { agentCandidateKey: string } } }> } }).task.slots
        .map((slot) => slot.actionReferences.actor.agentCandidateKey))).toEqual([
      [expect.stringMatching(/^candidate_/u), expect.stringMatching(/^candidate_/u)],
      [expect.stringMatching(/^candidate_/u)],
    ]);
    const initialContext = requests[0]!.context as {
      referenceCatalog: { candidates: unknown[] };
    };
    const repairContext = requests[1]!.context as {
      task: { slots: Array<{
        previousAttempt: unknown;
        issues: Array<{ code: string; path: unknown[]; allowedHandles: string[] }>;
      }> };
      referenceCatalog: { candidates: unknown[] };
    };
    expect(repairContext.task.slots[0]?.previousAttempt).toEqual(expect.objectContaining({
      temporalPlan: expect.objectContaining({ profileRef: actionCompilationCandidateKeyForHandle("ref:temporal_profile:missing-temporal-profile") }),
    }));
    expect(repairContext.task.slots[0]?.issues[0]).toEqual(expect.objectContaining({
      code: "reference.unknown_candidate_key",
      path: ["temporalPlan", "profileRef"],
    }));
    expect(repairContext.task.slots[0]!.issues[0]!.allowedHandles.length).toBeLessThanOrEqual(64);
    expect(repairContext.referenceCatalog.candidates.length)
      .toBeLessThan(initialContext.referenceCatalog.candidates.length);
  });

  it("auto-repairs a one-character candidateKey typo without singleton retry", async () => {
    let malformed = false;
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        const output = deterministicActionCompilationBatch(profileId, context);
        const first = output.slots[0];
        if (!malformed && first && typeof first.temporalPlan.profileRef === "string") {
          malformed = true;
          const temporalPlan = first.temporalPlan as { profileRef: string };
          temporalPlan.profileRef = temporalPlan.profileRef.slice(0, -1);
        }
        return output;
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    const requests = provider.requests.filter((request) => request.role === "action-compilation");
    expect(requests).toHaveLength(1);
    const audit = result.modelAudits.find((entry) => entry.role === "action-compilation");
    expect(audit?.invocations[0]).toMatchObject({
      outputDisposition: "auto-normalized",
      normalization: expect.objectContaining({
        symbolRepairCount: 1,
        symbolRepairAcceptedCount: 1,
      }),
      symbolRepairs: [expect.objectContaining({
        status: "repaired",
        bestDistance: 1,
        domain: "candidate-key",
      })],
    });
  });

  it("projects rate profiles as ineligible without quantity evidence and repairs only that slot", async () => {
    let selectedIneligibleRate = false;
    let repairedConstraint = "";
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        const stateSlots = (context as {
          task: { slots: Array<{
            action: { actorRef: string };
            temporalEvidence: unknown[];
            temporalProfileEligibility: Array<{
              profileRef: string;
              eligible: boolean;
              rejectionCode: string | null;
            }>;
            issues: Array<{ reason: string }>;
          }> };
        }).task.slots;
        const keeper = stateSlots.find((slot) => slot.action.actorRef === "ref:agent:keeper");
        if (keeper) {
          expect(keeper.temporalEvidence).toEqual([]);
          expect(keeper.temporalProfileEligibility).toContainEqual(expect.objectContaining({
            profileRef: "ref:temporal_profile:measured-travel",
            eligible: false,
            rejectionCode: "missing_explicit_quantity",
          }));
        }
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          if (!selectedIneligibleRate && action.actorId === "keeper") {
            selectedIneligibleRate = true;
            compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "measured-travel");
            compilation.temporalPlan.basis = { kind: "profile" };
          } else if (action.actorId === "keeper") {
            const taskSlots = (context as { task: { slots: Array<{ issues: Array<{ reason: string }> }> } }).task.slots;
            repairedConstraint = taskSlots[0]?.issues[0]?.reason ?? "";
          }
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(2);
    expect(repairedConstraint).toContain("missing_explicit_quantity");
  });

  it("repairs a structural resource-pool error with compact catalog guidance", async () => {
    let firstCompilation = true;
    let repairContext: {
      task: { slots: Array<{ issues: Array<{ code: string; path: unknown[]; allowedHandles: string[] }> }> };
    } | null = null;
    const provider = new ScriptedModelProvider(({ role, profileId, context, system }) => {
      if (role === "action-compilation") {
        expect(system).toContain("concurrency footprint");
        const output = deterministicActionCompilationBatch(profileId, context);
        if (firstCompilation) {
          firstCompilation = false;
          output.slots[0]!.interactionDependency.sharedResourceClaims = [{
            resourcePoolRef: output.slots[0]!.temporalPlan.profileRef as ExistingReferenceHandle,
            basis: { kind: "default" },
          }];
        } else {
          repairContext = context as typeof repairContext;
        }
        return output;
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(2);
    expect(repairContext).not.toBeNull();
    const issue = repairContext!.task.slots[0]!.issues[0]!;
    expect(issue).toMatchObject({
      code: "reference.shared_resource_pool_required",
      path: ["interactionDependency", "sharedResourceClaims", 0, "resourcePoolCandidateKey"],
    });
    expect(issue.allowedHandles.length).toBeLessThanOrEqual(64);
  });

  it("normalizes a unique active Agent footprint to its canonical Entity without repair", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          const agentHandle = referenceHandleFor("agent", action.actorId);
          compilation.interactionDependency.stateDependencies.requiredExistingRefs = [agentHandle];
          compilation.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs = [agentHandle];
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(1);
  });

  it("rolls back when an Action Compilation singleton exhausts semantic repair", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          if (action.actorId === "keeper") compilation.temporalPlan.profileRef = referenceHandleFor("temporal_profile", "missing-temporal-profile");
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await expect(engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    })).rejects.toBeInstanceOf(ModelSemanticRepairError);

    expect(contentHash(engine.snapshot)).toBe(contentHash(source));
    expect(provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(2);
  });

  it("rolls back when an AgentMind singleton exhausts semantic repair", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "agent-mind") {
        return deterministicAgentMindBatch(context, (output, slot) => {
          if (slot.state.perspective.agentRef === "ref:agent:keeper") output.nextActionIntent.targetHandles = ["ref:local_entity:unknown-local-target" as ExistingReferenceHandle];
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await expect(engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    })).rejects.toBeInstanceOf(ModelSemanticRepairError);
    expect(contentHash(engine.snapshot)).toBe(contentHash(source));
    expect(provider.requests.filter((request) => request.role === "agent-mind")).toHaveLength(3);
  });

  it("keeps outcome alternatives only when their evidence belongs to the acting Agent", () => {
    const state = {
      agents: {
        a: { belief: { evidence: { "seen-rain": { id: "seen-rain" } } } },
      },
    } as unknown as SimulationState;
    const action = { id: "action-a", actorId: "a" } as AgentActionProposal;
    const proposal = {
      outcomes: [{
        proposalId: action.id,
        knownAlternatives: [
          {
            description: "可以去避雨。",
            basis: { kind: "knowledge", evidenceIds: ["seen-rain", "weather-fact", "seen-rain"] },
          },
          {
            description: "可以遵守未知命令。",
            basis: { kind: "knowledge", evidenceIds: ["ochre-expedition-command"] },
          },
        ],
      }],
    } as unknown as import("../../../contracts/model").TransitionProposal;

    const normalized = normalizeOutcomeAlternativeEvidence(state, [action], proposal);

    expect(normalized.proposal.outcomes[0].knownAlternatives).toEqual([{
      description: "可以去避雨。",
      basis: { kind: "knowledge", evidenceIds: ["seen-rain"] },
    }]);
    expect(normalized).toMatchObject({ droppedReferences: 3, droppedAlternatives: 1 });
  });

  it.each(["expanded", "shared"] as const)("projects the merged candidate through %s batching to every Agent", async (mode) => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [],
            writes: [{ kind: "entity", id: action.actorId }],
            audienceAgentIds: [action.actorId],
            sharedResourceClaims: [],
          });
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.initialState.truth.placements.keeper = "gate";
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const algorithm = mode === "shared"
      ? registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).create(sharedContextAlgorithmRef(FULL_CATALOG_ALGORITHM_REF), { provider })
      : new EagerReferenceAlgorithm(provider);
    const engine = new SimulationEngine(definition, algorithm);
    await engine.bootstrapAgents();
    const state = engine.snapshot;
    const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: state.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(result.committed.observations.map((observation) => observation.observerId).sort())
      .toEqual(["keeper", "player"]);
    const globalProjections = provider.requests.filter((request) =>
      request.role === "observation-renderer" && request.schemaName === "observation_projection_batch");
    expect(globalProjections.length).toBeGreaterThan(0);
    expect(globalProjections.reduce((total, request) =>
      total + ((request.context as { state?: { slots?: unknown[] } }).state?.slots?.length ?? 0), 0)).toBeGreaterThanOrEqual(2);
    if (mode === "shared") {
      expect(provider.requests.filter((request) => request.schemaName === "truth_resolution_plan_commit_batch")).toHaveLength(1);
      expect(provider.requests.filter((request) => request.schemaName === "truth_resolution_continuation_batch")).toHaveLength(1);
      expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
    }
  });

  it("creates and bootstraps multiple dynamic Agents with a cohort profile", async () => {
    const summoned = ["skeleton-1", "skeleton-2", "skeleton-3"];
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role !== "truth-transition") return deterministicModelOutput(profileId, context);
      const action = assignedActions(context)[0];
      if (!action) throw new Error("cohort test expected one action");
      const draftAgent = (index: number) => ({
        id: `skeleton-agent-${index + 1}`,
        entityId: summoned[index],
        character: {
          persona: { summary: "受召唤者命令的骷髅。", voice: "", evidenceIds: [] },
          traits: {}, values: {}, emotions: {}, attitudes: {}, goals: {}, commitments: {},
        },
        belief: {
          localEntities: {
            self: { id: "self", name: "我", description: "骷髅自己", status: "observed" },
          },
          claims: {}, evidence: {},
        },
        bindings: { self: { localEntityId: "self", canonicalEntityIds: [summoned[index]] } },
      });
      return {
        outcomes: [{
          proposalId: action.id,
          status: "succeeded",
          summary: "召唤行动完成。",
          causeRefs: [{ kind: "action", id: action.id }],
          assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
          knownAlternatives: [],
        }],
        mechanicInvocations: [{
          id: "summon-cohort",
          packageId: "core-resolution",
          ruleId: "instantiate-entity-cohort",
          input: { entityIds: summoned, profileId: "wanderer" },
          causes: [{ kind: "action", id: action.id }],
          assertions: summoned.map((entityId) => ({ kind: "entity_absent", entityId })),
        }],
        operations: [
          ...summoned.map((entityId) => ({
            kind: "create_entity" as const,
            entity: { id: entityId, kind: "undead", name: entityId, description: "刚被召唤的骷髅。" },
            placementId: "courtyard",
            causes: [{ kind: "action" as const, id: action.id }],
            assertions: [{ kind: "entity_absent" as const, entityId }],
          })),
          ...summoned.map((_entityId, index) => ({
            kind: "create_agent" as const,
            agent: draftAgent(index),
            causes: [{ kind: "action" as const, id: action.id }],
            assertions: [{ kind: "entity_lifecycle" as const, entityId: summoned[index], expected: "active" as const }],
          })),
        ],
        events: [{
          id: "summon-event",
          description: "三个骷髅在庭院中出现。",
          impact: "significant",
          causes: [{ kind: "action", id: action.id }],
          assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
        }],
        decisionRequests: [],
      };
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const result = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "summoner" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "summon-three",
        agentId: "player",
        rawText: "死灵法师召唤三个骷髅守卫庭院。",
        goal: "召唤三个骷髅",
        means: "死灵法术",
        targetIds: [],
      }],
    });

    const summonedAgents = Object.entries(result.state.agents)
      .filter(([agentId]) => agentId.startsWith("agent-") && result.state.agents[agentId]?.entityId !== "player" && result.state.agents[agentId]?.entityId !== "keeper")
      .sort(([left], [right]) => left.localeCompare(right));
    const summonedEntityIds = summonedAgents.map(([, agent]) => agent.entityId);
    for (const entityId of summonedEntityIds) {
      const actualAgent = Object.values(result.state.agents).find((agent) => agent.entityId === entityId)!;
      expect(result.state.truth.entities[entityId]).toMatchObject({ kind: "undead", lifecycle: "active" });
      expect(actualAgent).toMatchObject({ entityId, nextAction: expect.any(Object) });
      expect(result.state.truth.meters[`${entityId}-health`]?.current).toBe(20);
      expect(result.committed.nextActions).toContainEqual(expect.objectContaining({ actorId: actualAgent.id }));
    }
    expect(result.committed.observations.map((observation) => observation.observerId))
      .toEqual(expect.arrayContaining(summonedAgents.map(([agentId]) => agentId)));
    const cohortInvocation = result.committed.mechanicInvocations.find((invocation) => invocation.ruleId === "instantiate-entity-cohort");
    expect(cohortInvocation).toEqual(expect.objectContaining({
      ruleId: "instantiate-entity-cohort",
      input: expect.objectContaining({ profileId: "wanderer" }),
    }));
    const cohortInput = cohortInvocation?.input as { entityIds?: unknown[] };
    expect(cohortInput.entityIds).toEqual(expect.arrayContaining(summonedEntityIds));
    expect(cohortInput.entityIds).toHaveLength(summonedEntityIds.length);
    expect(result.committed.temporalBoundary.deltaSeconds).toBeGreaterThan(0);
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });

  it("uses the earliest authored activity checkpoint instead of a fixed step duration", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action, temporalEvidence }) => {
          if (action.rawText.includes("100公里")) {
            const evidence = temporalEvidence.find((candidate) => candidate.kind === "quantity");
            if (!evidence) throw new Error("test action is missing quantity evidence");
            compilation.temporalPlan = {
              profileRef: referenceHandleFor("temporal_profile", "measured-travel"),
              basis: {
                kind: "action_text_evidence",
                evidenceKey: evidence.key,
              },
              description: "沿道路逐段前往一百公里外的地点",
              continuationAssertions: [],
              causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
            };
          }
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.runtimeDefaults.maxAutonomousSpanSeconds = 100_000;
    const travelProfile = definition.initialState.truth.mechanics.temporalProfiles["measured-travel"];
    if (!travelProfile || travelProfile.kind !== "rate") throw new Error("fixture travel profile is missing");
    travelProfile.checkpointUnits = 50;
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const result = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "participant-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "travel-100km",
        agentId: "player",
        rawText: "沿道路走到100公里外的城镇",
        goal: "抵达一百公里外的城镇",
        means: "步行",
        targetIds: [],
      }],
    });

    expect(result.committed.temporalBoundary.deltaSeconds).toBe(36_000);
    expect(result.state.truth.elapsedSeconds).toBe(36_000);
    const activity = Object.values(result.state.truth.activities)[0]!;
    expect(activity).toMatchObject({ status: "active", progress: { current: 50, target: 100, unit: "km" } });
    expect(result.committed.outcomes).toHaveLength(1);
    expect(result.committed.outcomes[0]!.status).toBe("continuing");
    expect(result.committed.resolutionReceipts).toEqual([
      expect.objectContaining({ settled: false, operations: [] }),
    ]);
    expect(result.committed.mechanicInvocations.some((invocation) =>
      invocation.packageId === "core-resolution" && invocation.ruleId === "apply-receipt"))
      .toBe(false);
    expect(result.committed.decisionPoints).toEqual([]);
    expect(result.committed.beliefPatches).toEqual([]);

    const second = await engine.step({
      player: {
        kind: "model",
        agentId: "player",
        profiles: structuredClone(result.state.agents.player.modelProfiles),
      },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: result.state.revision,
      trigger: "batch",
      externalActions: [],
    });
    expect(second.committed.temporalPlans).toEqual([]);
    expect(second.committed.resolutionReceipts).toEqual([
      expect.objectContaining({ settled: true }),
    ]);
    expect(second.committed.temporalBoundary.deltaSeconds).toBe(36_000);
    expect(second.state.truth.elapsedSeconds).toBe(72_000);
    expect(Object.values(second.state.truth.activities)[0]).toMatchObject({
      status: "completed",
      progress: { current: 100, target: 100, unit: "km" },
    });
    expect(second.committed.decisionPoints).toEqual([{
      agentId: "player",
      reason: "activity_completed",
      activityId: activity.id,
      timerId: null,
    }]);
    expect(second.committed.beliefPatches).toHaveLength(1);
    expect(provider.requests.filter((request) => request.role === "action-compilation")).toHaveLength(1);
    const finalMind = provider.requests.filter((request) => request.role === "agent-mind").at(-1);
    const playerSlot = (finalMind?.context as {
      slots?: Array<{ agentState: { perspective: { agentRef: string }; observations: unknown[] } }>;
    }).slots?.find((slot) => slot.agentState.perspective.agentRef === "ref:agent:player");
    expect(playerSlot?.agentState.observations).toHaveLength(2);
    expect(second.state.agents.player.observationCursorStep).toBe(2);

    const replayed = replaySimulationState(second.state);
    expect(contentHash(replayed.truth)).toBe(contentHash(second.state.truth));
    expect(contentHash(replayed.agents)).toBe(contentHash(second.state.agents));

    const overrideEngine = new SimulationEngine(
      definition,
      new EagerReferenceAlgorithm(provider),
      result.state,
    );
    const overridden = await overrideEngine.step({
      player: { kind: "external", agentId: "player", participantId: "participant-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: result.state.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "stop-travel",
        agentId: "player",
        rawText: "停止赶路，留在原地观察",
        goal: "停止当前活动",
        means: null,
        targetIds: [],
      }],
    });
    expect(overridden.committed.temporalBoundary.deltaSeconds).toBe(1);
    expect(overridden.state.truth.activities[activity.id]!.status).toBe("cancelled");
    expect(overridden.committed.activityTransitions).toContainEqual(expect.objectContaining({
      activityId: activity.id,
      kind: "cancelled",
    }));
  });

  it("rejects a candidate that relabels an authored due boundary as an arbitrary horizon", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const delegate = new EagerReferenceAlgorithm(provider);
    const forgingAlgorithm: WorldExecutionAlgorithm = {
      manifest: delegate.manifest,
      bootstrap: (input, context) => delegate.bootstrap(input, context),
      prepareStep: (input, context) => delegate.prepareStep(input, context),
      completeStep: async (input, preparation, reactions, context) => {
        const candidate = await delegate.completeStep(input, preparation, reactions, context);
        candidate.temporalBoundary.reasons = [{ kind: "safety_horizon" }];
        candidate.temporalBoundary.dueActivityIds = [];
        return candidate;
      },
    };
    const engine = new SimulationEngine(definition, forgingAlgorithm);
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const before = contentHash(source);

    await expect(engine.step({
      player: { kind: "external", agentId: "player", participantId: "participant-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "boundary-forgery",
        agentId: "player",
        rawText: "挥剑一次",
        goal: "挥剑",
        means: null,
        targetIds: [],
      }],
    })).rejects.toThrow("earliest trusted temporal boundary");
    expect(contentHash(engine.snapshot)).toBe(before);
  });

  it("records continuation assertions before and after an affected boundary", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
          compilation.temporalPlan = {
            profileRef: referenceHandleFor("temporal_profile", "brief-action"),
            basis: { kind: "profile" },
            description: action.rawText,
            continuationAssertions: [{
              kind: "elapsed_seconds_compare",
              operator: "lte",
              value: 1,
            }],
            causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
          };
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const profile = definition.initialState.truth.mechanics.temporalProfiles["brief-action"];
    if (!profile || profile.kind !== "fixed") throw new Error("fixture brief profile is missing");
    profile.durationSeconds = 10;
    profile.checkpointSeconds = 10;
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;

    const result = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "participant-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "assertion-boundary",
        agentId: "player",
        rawText: "坚持当前动作",
        goal: "保持动作",
        means: null,
        targetIds: [],
      }],
    });

    expect(result.committed.temporalBoundary).toMatchObject({
      deltaSeconds: 2,
      reasons: [expect.objectContaining({ kind: "activity_assertion" })],
    });
    expect(result.committed.activityDispositions).toContainEqual(expect.objectContaining({
      actorId: "player",
      kind: "block",
      reason: "continuation_assertion_failed",
      assertionResults: [
        expect.objectContaining({ phase: "pre_transition", passed: true }),
        expect.objectContaining({ phase: "post_transition", passed: false }),
      ],
    }));
  });

  it("settles a due Condition through a context-only interaction boundary", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.initialState.truth.conditions.alert = {
      id: "alert",
      subjectId: definition.initialState.agents.player!.entityId,
      label: "短暂警觉",
      description: "在下一个世界秒到期。",
      magnitude: "minor",
      durationProfileId: "brief",
      conditionProfileId: null,
      stackingKey: null,
      remainingUses: null,
      expiresAtElapsedSeconds: 1,
      access: { kind: "public" },
      provenance: [{ kind: "law", id: definition.laws[0]!.id }],
    };
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;

    const result = await engine.step({
      player: { kind: "idle", agentId: "player", reason: "explicit" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(result.committed.actions).toEqual([]);
    expect(result.committed.temporalBoundary).toMatchObject({
      deltaSeconds: 1,
      dueConditionIds: ["alert"],
    });
    expect(result.committed.mechanicInvocations).toContainEqual(expect.objectContaining({
      packageId: "core-resolution",
      ruleId: "advance-conditions",
    }));
    expect(result.state.truth.conditions.alert).toBeUndefined();
  });

  it("rejects a candidate whose dependency evidence does not cover final actions", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const delegate = new EagerReferenceAlgorithm(provider);
    const forgingAlgorithm: WorldExecutionAlgorithm = {
      manifest: delegate.manifest,
      bootstrap: (input, context) => delegate.bootstrap(input, context),
      prepareStep: (input, context) => delegate.prepareStep(input, context),
      completeStep: async (input, preparation, reactions, context) => {
        const candidate = await delegate.completeStep(input, preparation, reactions, context);
        candidate.interactionDependencies = candidate.interactionDependencies.slice(1);
        return candidate;
      },
    };
    const engine = new SimulationEngine(definition, forgingAlgorithm);
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const before = contentHash(source);
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await expect(engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    })).rejects.toThrow("action dependencies must cover every final action exactly once");
    expect(contentHash(engine.snapshot)).toBe(before);
  });

  it("rejects dependency component diagnostics that disagree with the final dependency graph", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 48,
      modelCatalog: provider.catalog,
    });
    const delegate = new EagerReferenceAlgorithm(provider);
    const forgingAlgorithm: WorldExecutionAlgorithm = {
      manifest: delegate.manifest,
      bootstrap: (input, context) => delegate.bootstrap(input, context),
      prepareStep: (input, context) => delegate.prepareStep(input, context),
      completeStep: async (input, preparation, reactions, context) => {
        const candidate = await delegate.completeStep(input, preparation, reactions, context);
        const dependency = candidate.interactionDependencies[0]!;
        dependency.reads = [{ kind: "global", id: "world" }];
        dependency.writes = [{ kind: "global", id: "world" }];
        dependency.globalFallback = true;
        candidate.diagnostics.dependencyComponents = candidate.interactionDependencies
          .map((entry) => [entry.id]);
        candidate.diagnostics.globalReadjudication = false;
        return candidate;
      },
    };
    const engine = new SimulationEngine(definition, forgingAlgorithm);
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const before = contentHash(source);
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    await expect(engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    })).rejects.toThrow("do not match the final interaction dependency graph");
    expect(contentHash(engine.snapshot)).toBe(before);
  });

  it("jointly commits an authored Timer with every activity due at the same instant", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.initialState.truth.timers["gate-deadline"] = {
      id: "gate-deadline",
      description: "石门值守截止。",
      createdAtSeconds: 0,
      dueAtSeconds: 1,
      status: "scheduled",
      wakeAgentIds: ["keeper"],
      causes: [{ kind: "law", id: "time-passes" }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }],
    };
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(result.committed.temporalBoundary).toMatchObject({
      deltaSeconds: 1,
      dueTimerIds: ["gate-deadline"],
    });
    expect(result.committed.temporalBoundary.dueActivityIds).toHaveLength(2);
    expect(result.state.truth.timers["gate-deadline"]!.status).toBe("fired");
    expect(result.committed.decisionPoints).toContainEqual({
      agentId: "keeper",
      reason: "timer",
      activityId: null,
      timerId: "gate-deadline",
    });
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });

  it("adjudicates a Timer trigger without prematurely settling a longer new Activity", async () => {
    const provider = new ScriptedModelProvider(({ profileId, context }) =>
      deterministicModelOutput(profileId, context));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const brief = definition.initialState.truth.mechanics.temporalProfiles["brief-action"];
    if (!brief || brief.kind !== "fixed") throw new Error("fixture brief profile is missing");
    brief.durationSeconds = 10;
    brief.checkpointSeconds = 10;
    definition.initialState.truth.timers["gate-deadline"] = {
      id: "gate-deadline",
      description: "石门值守截止。",
      createdAtSeconds: 0,
      dueAtSeconds: 1,
      status: "scheduled",
      wakeAgentIds: ["keeper"],
      causes: [{ kind: "law", id: "time-passes" }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }],
    };
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    const keeperActivity = Object.values(result.state.truth.activities)
      .find((activity) => activity.actorId === "keeper")!;
    expect(result.committed.temporalBoundary).toMatchObject({ deltaSeconds: 1, dueActivityIds: [] });
    expect(result.committed.actions).toContainEqual(expect.objectContaining({
      actorId: "keeper",
      rawText: expect.stringContaining("石门值守截止"),
    }));
    expect(result.committed.actions.map((action) => action.id)).not.toContain(keeperActivity.sourceActionId);
    expect(keeperActivity).toMatchObject({ status: "paused", nextBoundaryAtSeconds: null });
    expect(result.committed.decisionPoints).toContainEqual(expect.objectContaining({
      agentId: "keeper",
      reason: "timer",
    }));
  });

  it("creates a decision point when another action produces an authorized relevant observation", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action, temporalEvidence }) => {
          if (action.rawText.includes("100公里")) {
            const evidence = temporalEvidence.find((candidate) => candidate.kind === "quantity");
            if (!evidence) throw new Error("test action is missing quantity evidence");
            compilation.temporalPlan = {
              profileRef: referenceHandleFor("temporal_profile", "measured-travel"),
              basis: {
                kind: "action_text_evidence",
                evidenceKey: evidence.key,
              },
              description: "持续前往远方",
              continuationAssertions: [],
              causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
            };
          }
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [],
            writes: [{ kind: "entity", id: action.actorId }],
            audienceAgentIds: action.actorId === "keeper" ? ["keeper", "player"] : [action.actorId],
            sharedResourceClaims: [],
          });
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    definition.runtimeDefaults.maxAutonomousSpanSeconds = 100_000;
    const travel = definition.initialState.truth.mechanics.temporalProfiles["measured-travel"];
    if (!travel || travel.kind !== "rate") throw new Error("fixture travel profile is missing");
    travel.checkpointUnits = 25;
    definition.initialState.truth.facts = {};
    definition.initialState.truth.placements[definition.initialState.agents.keeper!.entityId] = "gate";
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const delegate = new EagerReferenceAlgorithm(provider);
    let latestCandidate: import("../../../runtime/execution").WorldStepCandidate | undefined;
    const algorithm: WorldExecutionAlgorithm = {
      manifest: delegate.manifest,
      bootstrap: (input, context) => delegate.bootstrap(input, context),
      prepareStep: (input, context) => delegate.prepareStep(input, context),
      completeStep: async (input, preparation, reactions, context) => {
        latestCandidate = await delegate.completeStep(input, preparation, reactions, context);
        return latestCandidate;
      },
    };
    const engine = new SimulationEngine(definition, algorithm);
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const first = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "participant-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "travel-for-interruption",
        agentId: "player",
        rawText: "沿道路走到100公里外的城镇",
        goal: "抵达远方城镇",
        means: "步行",
        targetIds: [],
      }],
    });
    const activity = Object.values(first.state.truth.activities)
      .find((candidate) => candidate.actorId === "player")!;
    expect(activity).toMatchObject({ status: "active", progress: { current: 25, target: 100 } });

    const second = await engine.step({
      player: {
        kind: "model",
        agentId: "player",
        profiles: structuredClone(first.state.agents.player.modelProfiles),
      },
      keeper: {
        kind: "model",
        agentId: "keeper",
        profiles: structuredClone(first.state.agents.keeper.modelProfiles),
      },
    }, {
      expectedRevision: first.state.revision,
      trigger: "batch",
      externalActions: [],
    });

    const interrupted = Object.values(second.state.truth.activities)
      .find((candidate) => candidate.id === activity.id)!;
    expect(interrupted).toMatchObject({ status: "paused", progress: { target: 100 } });
    const finalReview = provider.requests.filter(request => request.schemaName === "causal_verification").at(-1)!;
    const reviewedTemporal = (finalReview.context as { state: { candidateTemporalExecution: {
      sourceHash: string; temporalExecution: { activities: Record<string, { sourceActionRef: string; status: string }> };
    } } }).state.candidateTemporalExecution;
    expect(reviewedTemporal.sourceHash).toBe(contentHash(latestCandidate!.temporalState));
    expect(Object.values(reviewedTemporal.temporalExecution.activities)).toContainEqual(expect.objectContaining({
      sourceActionRef: referenceHandleFor("action", activity.sourceActionId), status: "paused",
    }));

    if (interrupted.status !== "paused") throw new Error("interrupted Activity did not remain scheduled");
    expect(interrupted.progress!.current).toBeGreaterThan(25);
    expect(interrupted.progress!.current).toBeLessThan(26);
    expect(latestCandidate?.interactionDependencies).toContainEqual(expect.objectContaining({
      actorId: "keeper",
      audienceAgentIds: ["keeper", "player"],
    }));
    expect(latestCandidate && resolutionObservations(latestCandidate.resolution)
      .map((observation) => observation.observerId)).toContain("player");
    expect(latestCandidate && "observations" in latestCandidate).toBe(false);
    expect(latestCandidate && "modelAudits" in latestCandidate.resolution).toBe(false);
    expect(latestCandidate && "reactionModelAudits" in latestCandidate.resolution).toBe(false);
    expect(second.committed.decisionPoints).toContainEqual({
      agentId: "player",
      reason: "activity_interrupted",
      activityId: activity.id,
      timerId: null,
    });
    expect(second.committed.beliefPatches).toContainEqual(expect.objectContaining({ agentId: "player" }));

    const third = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "participant-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: second.state.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "resume-after-decision",
        agentId: "player",
        rawText: "继续沿道路走完剩余100公里",
        goal: "继续前往远方城镇",
        means: "步行",
        targetIds: [],
      }],
    });
    expect(third.state.revision).toBe(second.state.revision + 1);
    expect(Object.values(third.state.truth.activities)).toContainEqual(expect.objectContaining({
      actorId: "player",
      status: "active",
    }));
  });

  it("re-grounds an Agent action that is replaced during the reaction window", async () => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation) => {
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [{ kind: "global", id: "world" }],
            writes: [{ kind: "global", id: "world" }],
            audienceAgentIds: ["keeper", "player"],
            sharedResourceClaims: [],
          });
        });
      }
      if (role === "truth-perception") {
        const playerAction = assignedActions(context)
          .find((action) => action.actorId === "player")!;
        return {
          kind: "request_reactions",
          requests: [{
            agentRef: referenceHandleFor("agent", "keeper"),
            sourceActionRef: referenceHandleFor("action", playerAction.id),
            stimulus: {
              summary: "旅人突然有所动作。",
              introductions: [],
              apparentClaims: [],
              sourceEventRefs: [],
            },
            basis: [{ kind: "shared_placement", placementRef: referenceHandleFor("placement", "courtyard") }],
          }],
        };
      }
      if (role === "agent-reaction") {
        return {
          kind: "replace",
          replacementAction: {
            rawText: "抓起庭院沙土戒备",
            goal: "利用现场沙土做好防备",
            means: "庭院地面的沙土",
            targetHandles: [],
          },
        };
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const state = engine.snapshot;
    const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: state.revision,
      trigger: "manual",
      externalActions: [],
    });

    const replacement = result.committed.actions.find((action) => action.actorId === "keeper")!;
    expect(replacement.rawText).toBe("抓起庭院沙土戒备");
    const reviews = provider.requests.filter(request => request.schemaName === "causal_verification");
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      expect(review.context).toMatchObject({ state: { reactionEvidence: {
        status: "provided", sourceHash: contentHash(result.committed.reactionDecisions),
        decisions: expect.arrayContaining([expect.objectContaining({
          agentRef: referenceHandleFor("agent", "keeper"), source: "model", kind: "replace",
          replacementAction: expect.objectContaining({ rawText: "抓起庭院沙土戒备" }),
        })]),
      } } });
    }
    const replacementPlan = result.committed.temporalPlans
      .find((plan) => plan.actorId === "keeper")!;
    expect(replacementPlan.actionId).toBe(replacement.id);
    const replacementActivity = Object.values(result.state.truth.activities)
      .find((activity) => activity.status !== "queued" && activity.status !== "ready" &&
        activity.plan.id === replacementPlan.id)!;
    expect(replacementActivity).toMatchObject({
      sourceActionId: replacement.id,
      sourceAction: { id: replacement.id, rawText: "抓起庭院沙土戒备" },
      plan: { actionId: replacement.id },
    });
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
    expect(provider.requests.filter((request) => request.role === "action-compilation"))
      .toHaveLength(2);
    expect(provider.requests.filter((request) => request.role === "action-compilation")
      .flatMap((request) => (request.context as { task: { slots: Array<{ action: AgentActionProposal }> } }).task.slots)
      .map((slot) => slot.action.rawText))
      .toContain("抓起庭院沙土戒备");
  });

  it.each([
    { replacementSeconds: 1, expectedBoundary: 1 },
    { replacementSeconds: 5, expectedBoundary: 2 },
  ])("reselects the temporal boundary for a $replacementSeconds-second onset replacement", async ({
    replacementSeconds,
    expectedBoundary,
  }) => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation, { action, temporalEvidence }) => {
          if (action.rawText === `进行${replacementSeconds}秒的紧急戒备`) {
            const evidence = temporalEvidence.find((candidate) => candidate.kind === "duration");
            if (!evidence) throw new Error("test action is missing duration evidence");
            compilation.temporalPlan = {
              profileRef: referenceHandleFor("temporal_profile", "explicit-duration"),
              basis: {
                kind: "action_text_evidence",
                evidenceKey: evidence.key,
              },
              description: `进行${replacementSeconds}秒的紧急戒备`,
              continuationAssertions: [],
              causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
            };
          }
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [{ kind: "global", id: "world" }],
            writes: [{ kind: "global", id: "world" }],
            audienceAgentIds: ["keeper", "player"],
            sharedResourceClaims: [],
          });
        });
      }
      if (role === "agent-reaction") {
        return {
          kind: "replace",
          replacementAction: {
            rawText: `进行${replacementSeconds}秒的紧急戒备`,
            goal: "立即戒备",
            means: null,
            targetHandles: [],
          },
        };
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const brief = definition.initialState.truth.mechanics.temporalProfiles["brief-action"];
    if (!brief || brief.kind !== "fixed") throw new Error("fixture brief profile is missing");
    brief.durationSeconds = 2;
    brief.checkpointSeconds = 2;
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const state = engine.snapshot;
    const roster = {
      player: { kind: "external" as const, agentId: "player", participantId: "participant-player" },
      keeper: {
        kind: "model" as const,
        agentId: "keeper",
        profiles: structuredClone(state.agents.keeper!.modelProfiles),
      },
    };

    const request = {
      expectedRevision: state.revision,
      trigger: "participant_action" as const,
      externalActions: [{
        submissionId: `trigger-${replacementSeconds}`,
        agentId: "player",
        rawText: "向前走一步",
        goal: "向前移动",
        means: null,
        targetIds: [],
      }],
    };
    const preparation = await engine.prepareStep(roster, request);
    const result = await engine.completePreparedStep(roster, request, preparation,
      preparation.pendingReactionRequests.map((reaction) => ({
        submissionId: `keep-${reaction.id}`,
        requestId: reaction.id,
        agentId: reaction.agentId,
        kind: "keep" as const,
      })));
    expect(result.committed.temporalBoundary).toMatchObject({
      fromElapsedSeconds: 0,
      toElapsedSeconds: expectedBoundary,
      deltaSeconds: expectedBoundary,
    });
    expect(result.committed.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ rawText: `进行${replacementSeconds}秒的紧急戒备` }),
      expect.objectContaining({ rawText: "向前走一步" }),
    ]));
    const playerActivity = Object.values(result.state.truth.activities)
      .find((activity) => activity.actorId === "player" && activity.sourceAction.rawText === "向前走一步")!;
    expect(playerActivity.status).toBe(replacementSeconds === 1 ? "active" : "completed");
  });

  it("opens an onset reaction only after a committed perception check succeeds", async () => {
    let perceptionRounds = 0;
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation) => {
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [{ kind: "global", id: "world" }],
            writes: [{ kind: "global", id: "world" }],
            audienceAgentIds: ["keeper", "player"],
            sharedResourceClaims: [],
          });
        });
      }
      if (role === "truth-perception") {
        perceptionRounds += 1;
        const playerAction = assignedActions(context)
          .find((action) => action.actorId === "player")!;
        const keeperAction = assignedActions(context)
          .find((action) => action.actorId === "keeper")!;
        expect(context).toMatchObject({ task: { assignment: { perceptionTargets: [
          { observerRef: referenceHandleFor("entity", "keeper"), sourceActionRef: referenceHandleFor("action", playerAction.id) },
          { observerRef: referenceHandleFor("entity", "player"), sourceActionRef: referenceHandleFor("action", keeperAction.id) },
        ] } } });
        if (perceptionRounds > 1) return { kind: "done" };
        return {
          kind: "request_checks",
          requests: [{
            proposalKey: "notice-player-action",
            actorRef: referenceHandleFor("entity", "keeper"),
            targetRef: referenceHandleFor("entity", "player"),
            ratingRef: null,
            difficulty: { kind: "environment", band: "trivial", source: { kind: "law", ref: referenceHandleFor("law", "time-passes") } },
            mode: "normal",
            stakes: "守门人是否察觉远处旅人的行动开始",
            visibility: "full",
            causes: [
              { kind: "action", ref: referenceHandleFor("action", playerAction.id) },
              { kind: "law", ref: referenceHandleFor("law", "time-passes") },
            ],
          }],
        };
      }
      if (role === "agent-reaction") {
        return { kind: "keep" };
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const brief = definition.initialState.truth.mechanics.temporalProfiles["brief-action"];
    if (!brief || brief.kind !== "fixed") throw new Error("fixture brief profile is missing");
    brief.durationSeconds = 2;
    brief.checkpointSeconds = 2;
    definition.initialState.truth.facts = {};
    definition.initialState.truth.placements[definition.initialState.agents.keeper!.entityId] = "gate";
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: source.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(perceptionRounds).toBe(2);
    const reviews = provider.requests.filter(request => request.schemaName === "causal_verification");
    expect(reviews.length).toBeGreaterThan(0);
    for (const review of reviews) {
      expect(review.context).toMatchObject({ state: { reactionEvidence: {
        status: "provided", sourceHash: contentHash(result.committed.reactionDecisions),
        decisions: expect.arrayContaining([expect.objectContaining({
          agentRef: referenceHandleFor("agent", "keeper"), source: "model", kind: "keep",
          ongoingActivityDisposition: "continue",
        })]),
      } } });
    }
    expect(result.committed.reactionRequests).toContainEqual(expect.objectContaining({
      agentId: "keeper",
      basis: [expect.objectContaining({ kind: "perception_check" })],
    }));
    const checkId = result.committed.reactionRequests
      .find((request) => request.agentId === "keeper")!.basis
      .find((basis) => basis.kind === "perception_check")!.checkId;
    expect(result.committed.checkRequests).toContainEqual(expect.objectContaining({
      id: checkId,
      actorId: "keeper",
      phase: "perception",
    }));
    expect(result.committed.checks).toContainEqual(expect.objectContaining({
      requestId: checkId,
      succeeded: true,
    }));
    expect(result.committed.commitmentRounds[0]).toEqual({
      kind: "check",
      phase: "perception",
      requestIds: [checkId],
    });
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });

  it.each([
    { mode: "imperceptible" as const, interruptible: true },
    { mode: "non-interruptible" as const, interruptible: false },
  ])("does not open a reaction round for a $mode action onset", async ({ mode, interruptible }) => {
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "action-compilation") {
        return deterministicActionCompilationBatch(profileId, context, (compilation) => {
          compilation.interactionDependency = deterministicInteractionDependency({
            reads: [{ kind: "global", id: "world" }],
            writes: [{ kind: "global", id: "world" }],
            audienceAgentIds: ["keeper", "player"],
            sharedResourceClaims: [],
          });
        });
      }
      return deterministicModelOutput(profileId, context);
    });
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47,
      modelCatalog: provider.catalog,
    });
    const brief = definition.initialState.truth.mechanics.temporalProfiles["brief-action"];
    if (!brief || brief.kind !== "fixed") throw new Error("fixture brief profile is missing");
    brief.durationSeconds = 2;
    brief.checkpointSeconds = 2;
    brief.interruptible = interruptible;
    if (mode === "imperceptible") {
      definition.initialState.truth.facts = {};
      definition.initialState.truth.placements[definition.initialState.agents.keeper!.entityId] = "gate";
    }
    definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const state = engine.snapshot;
    const roster = Object.fromEntries(Object.values(state.agents).map((agent) => [agent.id, {
      kind: "model" as const,
      agentId: agent.id,
      profiles: structuredClone(agent.modelProfiles),
    }]));

    const result = await engine.step(roster, {
      expectedRevision: state.revision,
      trigger: "manual",
      externalActions: [],
    });

    expect(result.committed.reactionRequests).toEqual([]);
    expect(result.committed.temporalBoundary.deltaSeconds).toBe(2);
    expect(provider.requests.filter((request) => request.role === "agent-reaction")).toEqual([]);
    for (const point of result.committed.decisionPoints) {
      expect(Object.values(result.state.truth.activities).some((activity) =>
        activity.status === "active" && activity.participantAgentIds.includes(point.agentId))).toBe(false);
    }
  });
});
