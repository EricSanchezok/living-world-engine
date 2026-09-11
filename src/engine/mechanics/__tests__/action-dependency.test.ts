import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ActivityFootprintIndex,
  affectedActivityIdsExhaustive,
  interactionDependencyForCondition,
  interactionDependencyForTimer,
  interactionDependencyComponents,
  interactionDependencyComponentsExhaustive,
  buildInteractionDependencyGraph,
  normalizeInteractionDependency,
  resolutionExceedsDeclaredDependencies,
  resolvedComponentsConflict,
} from "../action-dependency";
import type { UnreviewedTruthResolution } from "../../algorithms/roles";
import type { InteractionDependency } from "../../runtime/execution";
import type { AgentActionProposal, SimulationState, WorldDeltaOperation } from "../../contracts/model";
import type { ActivityState } from "../temporal";
import { loadWorldScript } from "../../../script/world-loader";
import { DeterministicModelProvider } from "../../testing/model-provider";

function dependency(
  actorId: string,
  reads: InteractionDependency["reads"],
  writes: InteractionDependency["writes"],
  audienceAgentIds: string[] = [],
  globalFallback = false,
): InteractionDependency {
  return {
    kind: "action",
    id: `action-${actorId}`,
    actorId,
    reads,
    writes,
    audienceAgentIds,
    sharedResourceClaims: [],
    globalFallback,
  };
}

describe("action dependencies", () => {
  it("detects a write upgrade that crosses components even when the other action has no physical delta", () => {
    const provider = new DeterministicModelProvider();
    const state = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 47, modelCatalog: provider.catalog,
    }).initialState;
    const resolution = (operations: WorldDeltaOperation[]): UnreviewedTruthResolution => ({
      proposal: { baseRevision: state.revision, operations, outcomes: [], events: [],
        observations: [], decisionRequests: [], mechanicInvocations: [] },
      initialActions: [], actions: [], reactionRequests: [], reactionDecisions: [],
      stimulusObservations: [], requests: [], checks: [], randomRequests: [], randomResults: [],
      commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [], rng: state.truth.rng,
      mechanicResults: [], causalAssertionResults: [], modelAudits: [], reactionModelAudits: [],
    });
    const subject = { kind: "entity" as const, id: "keeper" };
    const destination = { kind: "entity" as const, id: "gate" };
    const mover = dependency("keeper", [subject, destination], []);
    const observer = dependency("player", [subject], []);
    const move = resolution([{ kind: "place_entity", entityId: subject.id, placementId: destination.id,
      causes: [{ kind: "law", id: "time-passes" }], assertions: [] }]);
    const observe = resolution([]);
    expect(interactionDependencyComponents([mover, observer])).toHaveLength(2);
    expect(resolvedComponentsConflict(state, move, observe)).toBe(false);
    expect(resolutionExceedsDeclaredDependencies(state, move, [mover])).toBe(true);
    expect(resolutionExceedsDeclaredDependencies(state, observe, [observer])).toBe(false);

    const declaredMover = dependency("keeper", [destination], [subject]);
    expect(interactionDependencyComponents([declaredMover, observer])).toHaveLength(1);
    expect(resolutionExceedsDeclaredDependencies(state, move, [declaredMover])).toBe(false);
    expect(resolutionExceedsDeclaredDependencies(state, move, [
      dependency("keeper", [], [subject, destination]),
    ])).toBe(false);
    expect(resolutionExceedsDeclaredDependencies(state, move, [
      dependency("keeper", [], [subject]),
    ])).toBe(true);
    expect(resolutionExceedsDeclaredDependencies(state, move, [
      dependency("keeper", [], [], [], true),
    ])).toBe(false);
  });

  it("keeps independent footprints separate and joins read/write or audience dependencies", () => {
    expect(interactionDependencyComponents([
      dependency("a", [], [{ kind: "entity", id: "entity-a" }]),
      dependency("b", [], [{ kind: "entity", id: "entity-b" }]),
    ])).toEqual([["action-a"], ["action-b"]]);

    expect(interactionDependencyComponents([
      dependency("a", [], [{ kind: "entity", id: "shared" }]),
      dependency("b", [{ kind: "entity", id: "shared" }], []),
    ])).toEqual([["action-a", "action-b"]]);

    expect(interactionDependencyComponents([
      dependency("a", [], [{ kind: "entity", id: "entity-a" }], ["b"]),
      dependency("b", [], [{ kind: "entity", id: "entity-b" }]),
    ], "notification")).toEqual([["action-a", "action-b"]]);

    expect(interactionDependencyComponents([
      dependency("a", [], [{ kind: "entity", id: "entity-a" }], ["b"]),
      dependency("b", [], [{ kind: "entity", id: "entity-b" }]),
    ])).toEqual([["action-a"], ["action-b"]]);
  });

  it("joins claimants and capacity writers through the shared resource pool key", () => {
    const claim = {
      poolId: "pool-workbench",
      definitionId: "workbench",
      entityId: "bench",
      amount: 1,
      basis: { kind: "default" as const },
    };
    const holder = {
      ...dependency("holder", [], []),
      kind: "activity" as const,
      id: "activity-holder",
      sharedResourceClaims: [claim],
    };
    const claimant = {
      ...dependency("claimant", [], []),
      sharedResourceClaims: [claim],
    };
    const capacityWriter = dependency(
      "mechanic",
      [],
      [{ kind: "shared_resource_pool", id: claim.poolId }],
    );

    expect(interactionDependencyComponents([holder, claimant, capacityWriter])).toEqual([
      ["action-claimant", "action-mechanic", "activity-holder"],
    ]);
    expect(new ActivityFootprintIndex({
      [holder.id]: {
        id: holder.id,
        actorId: holder.actorId,
        status: "active",
        interactionFootprint: holder,
      } as ActivityState,
    }).affectedBy([claimant])).toEqual([holder.id]);
  });

  it("puts every action in one component when any footprint requires global fallback", () => {
    expect(interactionDependencyComponents([
      dependency("a", [{ kind: "global", id: "world" }], [{ kind: "global", id: "world" }], [], true),
      dependency("b", [], [{ kind: "entity", id: "entity-b" }]),
      dependency("c", [], [{ kind: "entity", id: "entity-c" }]),
    ])).toEqual([["action-a", "action-b", "action-c"]]);
  });

  it("exposes a deterministic hard-conflict graph without treating audience as canonical conflict", () => {
    const graph = buildInteractionDependencyGraph([
      dependency("b", [], [{ kind: "entity", id: "shared" }]),
      dependency("a", [], [{ kind: "entity", id: "entity-a" }], ["b"]),
      dependency("c", [{ kind: "entity", id: "shared" }], []),
    ]);
    expect(graph.mode).toBe("canonical");
    expect(graph.components).toEqual([["action-a"], ["action-b", "action-c"]]);
    expect(graph.edges).toEqual([
      { from: "action-b", to: "action-c", kinds: ["read-write"] },
    ]);
    expect(graph.edgeCount).toBe(1);
    expect(graph.maxComponentSize).toBe(2);
    expect(graph.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(buildInteractionDependencyGraph([
      dependency("c", [{ kind: "entity", id: "shared" }], []),
      dependency("a", [], [{ kind: "entity", id: "entity-a" }], ["b"]),
      dependency("b", [], [{ kind: "entity", id: "shared" }]),
    ])).toEqual(graph);
  });

  it("matches the indexed graph components with the exhaustive oracle", () => {
    const agents = ["a", "b", "c", "d", "e", "f"];
    const resources = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"];
    let seed = 0x1badb002;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const choose = (values: readonly string[]): string[] => values.filter(() => random() < 0.28);
    for (let trial = 0; trial < 80; trial += 1) {
      const dependencies = Array.from({ length: 24 }, (_, index): InteractionDependency => {
        const actorId = agents[index % agents.length]!;
        const globalFallback = trial % 23 === 0 && index === 0;
        const global = { kind: "global" as const, id: "world" as const };
        return {
          ...dependency(
            actorId,
            globalFallback ? [global] : choose(resources).map((id) => ({ kind: "entity" as const, id })),
            globalFallback ? [global] : choose(resources).map((id) => ({ kind: "entity" as const, id })),
            choose(agents),
            globalFallback,
          ),
          id: `action-${trial}-${index}`,
        };
      });
      expect(buildInteractionDependencyGraph(dependencies, "canonical").components)
        .toEqual(interactionDependencyComponentsExhaustive(dependencies, "canonical"));
      expect(buildInteractionDependencyGraph(dependencies, "notification").components)
        .toEqual(interactionDependencyComponentsExhaustive(dependencies, "notification"));
    }
  });

  it("keeps unknown dependency hints local and exposes them for semantic repair", () => {
    const state = {
      agents: { a: { id: "a", entityId: "entity-a" } },
      truth: {
        entities: { "entity-a": { id: "entity-a" } },
        facts: {},
        meters: {},
        quantities: {},
        ratings: {},
      },
    } as unknown as SimulationState;
    const action = { id: "action-a", actorId: "a" } as AgentActionProposal;
    const normalized = normalizeInteractionDependency(state, action, dependency(
      "a",
      [{ kind: "entity", id: "weather" }],
      [],
      ["unknown-group"],
    ));

    expect(normalized.dependency).toEqual({
      kind: "action",
      id: "action-a",
      actorId: "a",
      reads: [],
      writes: [],
      audienceAgentIds: [],
      sharedResourceClaims: [],
      globalFallback: false,
    });
    expect(normalized.fallbackReasons).toEqual(["unknown_audience_agent", "unknown_entity"]);
  });

  it("treats a known Activity as a first-class dependency footprint", () => {
    const state = {
      agents: { a: { id: "a", entityId: "entity-a" } },
      truth: {
        entities: { "entity-a": { id: "entity-a" } },
        facts: {},
        placements: {},
        meters: {},
        quantities: {},
        ratings: {},
        conditions: {},
        activities: { "activity-watch": { id: "activity-watch" } },
        sharedActivityResourcePools: {},
      },
    } as unknown as SimulationState;
    const action = { id: "action-a", actorId: "a" } as AgentActionProposal;

    const normalized = normalizeInteractionDependency(state, action, dependency(
      "a",
      [],
      [{ kind: "activity", id: "activity-watch" }],
    ));

    expect(normalized.dependency.writes).toEqual([{ kind: "activity", id: "activity-watch" }]);
    expect(normalized.fallbackReasons).toEqual([]);
  });

  it("does not treat a non-canonical global reference as world scope", () => {
    const state = {
      agents: { a: { id: "a", entityId: "entity-a" } },
      truth: {
        entities: { "entity-a": { id: "entity-a" } },
        facts: {},
        meters: {},
        quantities: {},
        ratings: {},
        conditions: {},
        sharedActivityResourcePools: {},
      },
    } as unknown as SimulationState;
    const action = { id: "action-a", actorId: "a" } as AgentActionProposal;
    const malformed = dependency("a", [{ kind: "global", id: "not-world" } as never], [], [], false);

    const normalized = normalizeInteractionDependency(state, action, malformed);

    expect(normalized.dependency.globalFallback).toBe(false);
    expect(normalized.dependency.reads).toEqual([]);
    expect(normalized.fallbackReasons).toEqual(["invalid_global_reference"]);
  });

  it("grounds Timer and Condition context nodes from canonical state", () => {
    const state = {
      agents: { a: { id: "a", entityId: "entity-a" } },
      truth: {
        entities: { "entity-a": { id: "entity-a" } },
        facts: { dawn: { id: "dawn" } },
        meters: {},
        quantities: {},
        ratings: {},
        conditions: {
          alert: {
            id: "alert",
            subjectId: "entity-a",
            access: { kind: "agents", agentIds: ["a"] },
          },
        },
      },
    } as unknown as SimulationState;
    const timer = {
      id: "wake-up",
      wakeAgentIds: ["a"],
      assertions: [{ kind: "fact_matches", factId: "dawn", predicate: "phase", value: "morning" }],
    } as unknown as import("../temporal").WorldTimer;

    expect(interactionDependencyForTimer(state, timer)).toEqual({
      kind: "timer",
      id: "wake-up",
      actorId: null,
      reads: [{ kind: "fact", id: "dawn" }],
      writes: [],
      audienceAgentIds: ["a"],
      sharedResourceClaims: [],
      globalFallback: false,
    });
    expect(interactionDependencyForCondition(state, state.truth.conditions.alert!)).toEqual({
      kind: "condition",
      id: "alert",
      actorId: null,
      reads: [{ kind: "condition", id: "alert" }],
      writes: [{ kind: "condition", id: "alert" }],
      audienceAgentIds: ["a"],
      sharedResourceClaims: [],
      globalFallback: false,
    });
    const activity = {
      id: "activity-alert",
      actorId: "a",
      status: "active",
      interactionFootprint: {
        kind: "activity",
        id: "activity-alert",
        actorId: "a",
        reads: [{ kind: "condition", id: "alert" }],
        writes: [],
        audienceAgentIds: ["a"],
        sharedResourceClaims: [],
        globalFallback: false,
      },
    } as unknown as ActivityState;
    const conditionDependency = interactionDependencyForCondition(state, state.truth.conditions.alert!);
    expect(new ActivityFootprintIndex({ [activity.id]: activity }).affectedBy([conditionDependency]))
      .toEqual([activity.id]);
  });

  it("takes the fixed-point closure through multi-resource Activity footprints", () => {
    const claim = (poolId: string) => ({
      poolId,
      definitionId: poolId,
      entityId: `entity-${poolId}`,
      amount: 1,
      basis: { kind: "default" as const },
    });
    const bridge = {
      ...dependency("bridge", [], []),
      kind: "activity" as const,
      id: "activity-bridge",
      sharedResourceClaims: [claim("pool-a"), claim("pool-b")],
    };
    const downstream = {
      ...dependency("downstream", [], []),
      kind: "activity" as const,
      id: "activity-downstream",
      sharedResourceClaims: [claim("pool-b")],
    };
    const unrelated = {
      ...dependency("unrelated", [], []),
      kind: "activity" as const,
      id: "activity-unrelated",
      sharedResourceClaims: [claim("pool-c")],
    };
    const activities = Object.fromEntries([bridge, downstream, unrelated].map((footprint) => [footprint.id, {
      id: footprint.id,
      actorId: footprint.actorId,
      status: "active",
      interactionFootprint: footprint,
    } as ActivityState]));
    const incoming = [{
      ...dependency("incoming", [], []),
      sharedResourceClaims: [claim("pool-a")],
    }];

    expect(affectedActivityIdsExhaustive(activities, incoming)).toEqual([
      bridge.id,
      downstream.id,
    ]);
    expect(new ActivityFootprintIndex(activities).affectedBy(incoming)).toEqual([
      bridge.id,
      downstream.id,
    ]);
  });

  it("matches the exhaustive affected-Activity oracle across sparse, dense, audience, and global footprints", () => {
    let seed = 0x5eed;
    const random = (): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const agents = Array.from({ length: 8 }, (_, index) => `agent-${index}`);
    const refs = Array.from({ length: 12 }, (_, index) => ({
      kind: "entity" as const,
      id: `entity-${index}`,
    }));
    const choose = <T>(values: readonly T[]): T[] => values.filter(() => random() < 0.22);
    for (let trial = 0; trial < 100; trial += 1) {
      const activities = Object.fromEntries(Array.from({ length: 30 }, (_, index) => {
        const actorId = agents[index % agents.length]!;
        const globalFallback = trial % 17 === 0 && index === 0;
        const global = { kind: "global" as const, id: "world" as const };
        const footprint: InteractionDependency = {
          kind: "activity",
          id: `activity-${index}`,
          actorId,
          reads: globalFallback ? [global] : choose(refs),
          writes: globalFallback ? [global] : choose(refs),
          audienceAgentIds: [...new Set([actorId, ...choose(agents)])].sort(),
          sharedResourceClaims: [],
          globalFallback,
        };
        return [footprint.id, {
          id: footprint.id,
          actorId,
          status: index % 11 === 0 ? "paused" : "active",
          interactionFootprint: footprint,
        } as ActivityState];
      }));
      const incoming = Array.from({ length: 6 }, (_, index): InteractionDependency => {
        const actorId = agents[(index + trial) % agents.length]!;
        const globalFallback = trial % 19 === 0 && index === 5;
        const global = { kind: "global" as const, id: "world" as const };
        return {
          kind: "action",
          id: `incoming-${trial}-${index}`,
          actorId,
          reads: globalFallback ? [global] : choose(refs),
          writes: globalFallback ? [global] : choose(refs),
          audienceAgentIds: [...new Set([actorId, ...choose(agents)])].sort(),
          sharedResourceClaims: [],
          globalFallback,
        };
      });
      expect(new ActivityFootprintIndex(activities).affectedBy(incoming)).toEqual(
        affectedActivityIdsExhaustive(activities, incoming),
      );
    }
  });
});
