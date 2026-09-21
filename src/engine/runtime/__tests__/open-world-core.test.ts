import { describe, expect, it } from "vitest";
import { applyBeliefPatch } from "../../cognition/belief";
import type {
  AgentState,
  BeliefPatch,
  D20CheckRequest,
  SimulationState,
  TransitionProposal,
} from "../../contracts/model";
import { createSeededRng, resolveD20Checks } from "../../mechanics/random";
import { validateObservations } from "../../cognition/observation";
import {
  applyTransitionProposal,
  applyWorldDeltaOperation,
  createEmptyCharacter,
  createEmptyBelief,
  TransitionValidationError,
  validateSimulationState,
} from "../transaction";
import { TEST_WORLD_HASH } from "../../testing/world";
import { createTestModelAudit } from "../../testing/model-provider";
import { quantityId, runtimeId, sharedActivityResourcePoolId } from "../runtime-id";
import { evaluateCausalAssertion } from "../../mechanics/causality";
import { createHistoryReplayBase } from "../history-replay";
import { beliefClaimSchema, evidenceSchema, semanticIdSchema } from "../../contracts/state-schemas";
import { agentMindOutputSchema, characterPatchSchema } from "../../contracts/llm-schemas";

function worldState(): SimulationState {
  const workbenchPoolId = sharedActivityResourcePoolId(TEST_WORLD_HASH, "workbench", "gate");
  return {
    schemaVersion: 16,
    executionState: null,
    worldId: "test-world",
    worldHash: TEST_WORLD_HASH,
    lawIds: ["worldgen", "time-passes", "necromancy"],
    revision: 0,
    step: 0,
    truth: {
      elapsedSeconds: 0,
      rng: createSeededRng(42),
      events: [],
      entities: {
        player: {
          id: "player",
          kind: "person",
          name: "旅人",
          description: "一名旅人。",
          lifecycle: "active",
          createdAtStep: 0,
        },
        keeper: {
          id: "keeper",
          kind: "person",
          name: "守门人",
          description: "守门人。",
          lifecycle: "active",
          createdAtStep: 0,
        },
        gate: {
          id: "gate",
          kind: "door",
          name: "石门",
          description: "封闭的石门。",
          lifecycle: "active",
          createdAtStep: 0,
        },
        key: {
          id: "key",
          kind: "key",
          name: "铜钥匙",
          description: "仿制的铜钥匙。",
          lifecycle: "active",
          createdAtStep: 0,
        },
      },
      placements: { player: null, keeper: null, gate: null, key: "player" },
      factTombstones: [],
      facts: {
        "key-authenticity": {
          id: "key-authenticity",
          subjectId: "key",
          predicate: "authenticity",
          value: { kind: "text", value: "fake" },
          description: "这把钥匙是仿制品。",
          access: { kind: "private" },
          provenance: [{ kind: "law", id: "worldgen" }],
        },
      },
      mechanics: {
        meters: {
          health: {
            id: "health",
            name: "生命",
            min: 0,
            max: 20,
            thresholds: [
              {
                id: "death-at-zero",
                when: { operator: "lte", value: 0 },
                effects: [
                  { kind: "set_lifecycle", lifecycle: "retired" },
                  {
                    kind: "set_fact",
                    predicate: "condition",
                    value: { kind: "text", value: "dead" },
                    description: "生命已经终结。",
                  },
                ],
              },
            ],
          },
        },
        quantities: {
          spirit_stone: {
            id: "spirit_stone",
            name: "灵石",
            unit: "枚",
            productionLawIds: [],
            consumptionLawIds: ["necromancy"],
          },
        },
        ratings: {
          force: { id: "force", name: "力量", min: -5, max: 10 },
        },
        impactProfiles: {},
        durationProfiles: {},
        conditionProfiles: {},
        entityMechanicsProfiles: {},
        adjudicationCalibrations: [],
        activityResources: {},
        sharedActivityResources: {
          workbench: {
            id: "workbench",
            name: "工作台",
            unit: "席",
            defaultClaimAmount: 1,
            allowExplicitAmount: false,
            contention: "queue",
            pausedRetention: "release",
          },
        },
        temporalProfiles: {},
        temporalCalibrations: [],
      },
      meters: {
        "health:keeper": {
          id: "health:keeper",
          definitionId: "health",
          entityId: "keeper",
          current: 10,
          firedThresholdIds: [],
        },
      },
      quantities: {
        [quantityId(TEST_WORLD_HASH, "spirit_stone", "player")]: {
          id: quantityId(TEST_WORLD_HASH, "spirit_stone", "player"),
          definitionId: "spirit_stone",
          holderId: "player",
          amount: 3,
        },
        [quantityId(TEST_WORLD_HASH, "spirit_stone", "keeper")]: {
          id: quantityId(TEST_WORLD_HASH, "spirit_stone", "keeper"),
          definitionId: "spirit_stone",
          holderId: "keeper",
          amount: 7,
        },
      },
      ratings: {
        "force:player": {
          id: "force:player",
          definitionId: "force",
          entityId: "player",
          value: 2,
        },
      },
      conditions: {},
      activities: {},
      sharedActivityResourcePools: {
        [workbenchPoolId]: {
          id: workbenchPoolId,
          definitionId: "workbench",
          entityId: "gate",
          capacity: 1,
        },
      },
      timers: {},
    },
    agents: {
      keeper: {
        id: "keeper",
        entityId: "keeper",
        modelProfiles: { bootstrap: "agent-default", mind: "agent-default", reaction: "agent-default" },
        character: createEmptyCharacter("谨慎的守门人"),
        belief: {
          localEntities: {
            self: { id: "self", name: "我", description: "守门人自己", status: "observed" },
          },
          claims: {},
          evidence: {},
        },
        bindings: { self: { localEntityId: "self", canonicalEntityIds: ["keeper"] } },
        observationCursorStep: 0,
        nextAction: {
          id: runtimeId({
            worldHash: TEST_WORLD_HASH, revision: 0, kind: "action", stage: "prepared",
            owner: "keeper", round: 0, ordinal: 0,
          }),
          actorId: "keeper",
          baseRevision: 0,
          rawText: "继续看守石门",
          goal: "不让陌生人通过",
          means: null,
          targetIds: [],
        },
      },
    },
    admissions: [],
    history: [],
    bootstrapAgentCommits: [{
      agentId: "keeper",
      beliefPatch: { agentId: "keeper", baseRevision: 0, operations: [] },
      characterPatch: { agentId: "keeper", baseRevision: 0, operations: [] },
      nextAction: {
        id: runtimeId({
          worldHash: TEST_WORLD_HASH, revision: 0, kind: "action", stage: "prepared",
          owner: "keeper", round: 0, ordinal: 0,
        }),
        actorId: "keeper",
        baseRevision: 0,
        rawText: "继续看守石门",
        goal: "不让陌生人通过",
        means: null,
        targetIds: [],
      },
    }],
  };
}

function proposal(operations: TransitionProposal["operations"]): TransitionProposal {
  return {
    baseRevision: 0,
    outcomes: [],
    mechanicInvocations: [],
    operations: [
      ...operations,
      {
        kind: "advance_time",
        seconds: 1,
        causes: [{ kind: "law", id: "time-passes" }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 0 }],
      },
    ],
    events: [],
    observations: [],
    decisionRequests: [],
  };
}

const causalAction = [{ kind: "action" as const, id: "player-action" }];

describe("open world kernel", () => {
  it("reserves rt identities from every model-authored semantic namespace", () => {
    expect(quantityId(TEST_WORLD_HASH, "definition:a", "holder"))
      .not.toBe(quantityId(TEST_WORLD_HASH, "definition", "a:holder"));
    expect(agentMindOutputSchema.safeParse({
      beliefPatch: { agentId: "keeper", baseRevision: 0, operations: [] },
      characterPatch: { operations: [] },
      nextAction: { rawText: "等待", goal: "观察", means: null, targetIds: [] },
    }).success).toBe(false);
    expect(semanticIdSchema.safeParse("rt:claim:forged").success).toBe(false);
    expect(semanticIdSchema.safeParse("agent\u0085id").success).toBe(false);
    expect(beliefClaimSchema.safeParse({
      id: "rt:claim:forged",
      subjectId: "self",
      predicate: "identity",
      value: { kind: "text", value: "forged" },
      description: "不得占用内核命名空间。",
      stance: "believed",
      confidence: 1,
      evidenceIds: [],
    }).success).toBe(false);
    expect(evidenceSchema.safeParse({
      id: "rt:evidence:forged",
      kind: "assumption",
      description: "不得占用内核命名空间。",
      sourceId: null,
      step: 0,
    }).success).toBe(false);
    expect(characterPatchSchema.safeParse({
      agentId: "keeper",
      baseRevision: 0,
      operations: [{
        kind: "create_trait",
        facet: { id: "rt:trait:forged", description: "不得占用内核命名空间。", strength: 1 },
        sourceObservationIds: ["rt:observation:source"],
        evidenceIds: ["rt:evidence:source"],
      }],
    }).success).toBe(false);
  });

  it("rejects execution evidence injected into canonical state", () => {
    const state = worldState();
    validateSimulationState(state, true, true);
    Object.assign(state, {
      bootstrapModelAudits: [createTestModelAudit("agent-bootstrap", "keeper", TEST_WORLD_HASH)],
    });
    expect(() => validateSimulationState(state, true, true))
      .toThrow();
  });

  it("keeps observer-local identities tombstoned for the whole simulation lifetime", () => {
    const state = worldState();
    state.historyBase = createHistoryReplayBase(state);
    state.bootstrapAgentCommits[0].beliefPatch.operations.push({
      kind: "upsert_local_entity",
      entity: {
        id: "retired-witness",
        name: "旧见证人",
        description: "已经被移除的局部身份。",
        status: "observed",
      },
    }, { kind: "remove_local_entity", localEntityId: "retired-witness" });
    expect(() => validateObservations(state, [{
      id: "draft-observation",
      observerId: "keeper",
      step: 1,
      kind: "outcome",
      summary: "试图重新引入已退休的局部身份。",
      introductions: [{
        localEntity: {
          id: "retired-witness",
          name: "旧目击者",
          description: "同名身份已经在历史中使用过。",
          status: "reported",
        },
        canonicalEntityId: null,
      }],
      apparentClaims: [],
      sourceEventIds: [],
    }], 1)).toThrow("reintroduces local entity retired-witness");
  });
  it("keeps a false belief independent from canonical truth", () => {
    const source = createEmptyBelief();
    const patch: BeliefPatch = {
      agentId: "keeper",
      baseRevision: 0,
      operations: [
        {
          kind: "upsert_local_entity",
          entity: { id: "local-key", name: "铜钥匙", description: "真正的门钥匙", status: "observed" },
        },
        {
          kind: "upsert_evidence",
          evidence: {
            id: "merchant-claim",
            kind: "testimony",
            description: "商人声称钥匙是真的。",
            sourceId: null,
            step: 0,
          },
        },
        {
          kind: "upsert_claim",
          claim: {
            id: "key-is-real",
            subjectId: "local-key",
            predicate: "authenticity",
            value: { kind: "text", value: "real" },
            description: "我相信这是真钥匙。",
            stance: "believed",
            confidence: 0.9,
            evidenceIds: ["merchant-claim"],
          },
        },
      ],
    };

    const belief = applyBeliefPatch(source, patch);
    const truth = worldState();
    expect(belief.claims["key-is-real"].value).toEqual({ kind: "text", value: "real" });
    expect(truth.truth.facts["key-authenticity"].value).toEqual({ kind: "text", value: "fake" });
  });

  it("splits one uncertain local identity without creating canonical entities", () => {
    const source = createEmptyBelief();
    source.localEntities.masked = {
      id: "masked",
      name: "蒙面人",
      description: "可能是两个人中的任意一个。",
      status: "observed",
    };
    source.localEntities.letter = {
      id: "letter",
      name: "信件",
      description: "署名不清的信件。",
      status: "observed",
    };
    source.claims.identity = {
      id: "identity",
      subjectId: "masked",
      predicate: "carried",
      value: { kind: "local_entity", localEntityId: "letter" },
      description: "蒙面人携带信件。",
      stance: "suspected",
      confidence: 0.5,
      evidenceIds: [],
    };
    const patch: BeliefPatch = {
      agentId: "keeper",
      baseRevision: 0,
      operations: [{
        kind: "split_local_entity",
        fromId: "masked",
        entities: [
          { id: "masked-tall", name: "高个蒙面人", description: "较高的身影。", status: "hypothesized" },
          { id: "masked-short", name: "矮个蒙面人", description: "较矮的身影。", status: "hypothesized" },
        ],
        assignments: [{ claimId: "identity", subjectId: "masked-tall", valueId: null }],
      }],
    };

    const result = applyBeliefPatch(source, patch);

    expect(result.localEntities.masked).toBeUndefined();
    expect(result.claims.identity.subjectId).toBe("masked-tall");
    expect(result.localEntities["masked-short"]).toBeDefined();
    expect(worldState().truth.entities["masked-tall"]).toBeUndefined();
  });

  it("produces reproducible d20 results and applies advantage", () => {
    const request: D20CheckRequest = {
      id: "open-gate",
      actorId: "player",
      targetId: "gate",
      ratingId: "force:player",
      modifier: 2,
      modifierSources: [{ kind: "rating", id: "force:player", amount: 2 }],
      dc: 15,
      mode: "advantage",
      stakes: "推开石门，失败则发出巨响",
      visibility: "full",
      phase: "resolution",
      causes: causalAction,
    };

    const first = resolveD20Checks(createSeededRng(7), [request]);
    const second = resolveD20Checks(createSeededRng(7), [request]);
    expect(first).toEqual(second);
    expect(first.results[0].dice).toHaveLength(2);
    expect(first.results[0].kept).toBe(Math.max(...first.results[0].dice));
    expect(first.rng.draws).toBe(2);
  });

  it("transfers quantities conservatively without mutating the source", () => {
    const source = worldState();
    const next = applyTransitionProposal(
      source,
      proposal([
        {
          kind: "transfer_quantity",
          definitionId: "spirit_stone",
          fromHolderId: "keeper",
          toHolderId: "player",
          amount: 5,
          causes: causalAction,
          assertions: [{ kind: "quantity_compare", definitionId: "spirit_stone", holderId: "keeper", operator: "gte", value: 5 }],
        },
      ]),
    );

    expect(source.truth.quantities[quantityId(TEST_WORLD_HASH, "spirit_stone", "keeper")].amount).toBe(7);
    expect(next.truth.quantities[quantityId(TEST_WORLD_HASH, "spirit_stone", "keeper")].amount).toBe(2);
    expect(next.truth.quantities[quantityId(TEST_WORLD_HASH, "spirit_stone", "player")].amount).toBe(8);
  });

  it("changes typed shared capacity only through an asserted canonical operation", () => {
    const state = worldState();
    const pool = Object.values(state.truth.sharedActivityResourcePools)[0]!;
    expect(evaluateCausalAssertion(state, {
      kind: "shared_resource_capacity_compare",
      poolId: pool.id,
      operator: "eq",
      value: 1,
    })).toEqual({ passed: true, observed: 1 });

    applyWorldDeltaOperation(state, {
      kind: "set_shared_activity_resource_capacity",
      poolId: pool.id,
      capacity: 2,
      causes: [{ kind: "law", id: "worldgen" }],
      assertions: [{
        kind: "shared_resource_capacity_compare",
        poolId: pool.id,
        operator: "eq",
        value: 1,
      }],
    });
    expect(state.truth.sharedActivityResourcePools[pool.id]?.capacity).toBe(2);
    expect(() => applyWorldDeltaOperation(state, {
      kind: "set_shared_activity_resource_capacity",
      poolId: pool.id,
      capacity: -1,
      causes: [{ kind: "law", id: "worldgen" }],
      assertions: [{ kind: "entity_lifecycle", entityId: "gate", expected: "active" }],
    })).toThrow("capacity must be non-negative");
  });

  it("expires elapsed-time conditions atomically when their boundary is committed", () => {
    const source = worldState();
    source.truth.mechanics.durationProfiles.brief = {
      id: "brief",
      name: "短暂",
      kind: "elapsed",
      seconds: 1,
    };
    source.truth.conditions.fever = {
      id: "fever",
      subjectId: "player",
      label: "发热",
      description: "短暂发热。",
      magnitude: "minor",
      durationProfileId: "brief",
      conditionProfileId: null,
      stackingKey: null,
      remainingUses: null,
      expiresAtElapsedSeconds: 1,
      access: { kind: "private" },
      provenance: causalAction,
    };
    validateSimulationState(source);

    const next = applyTransitionProposal(source, proposal([]));

    expect(source.truth.conditions.fever).toBeDefined();
    expect(next.truth.elapsedSeconds).toBe(1);
    expect(next.truth.conditions.fever).toBeUndefined();
    expect(() => validateSimulationState(next)).not.toThrow();
  });

  it("rejects unsupported matter creation atomically", () => {
    const source = worldState();
    expect(() =>
      applyTransitionProposal(
        source,
        proposal([
          {
            kind: "produce_quantity",
            definitionId: "spirit_stone",
            holderId: "player",
            amount: 10_000,
            lawId: "wish",
            causes: causalAction,
            assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
          },
        ]),
      ),
    ).toThrow(TransitionValidationError);
    expect(source.truth.quantities[quantityId(TEST_WORLD_HASH, "spirit_stone", "player")].amount).toBe(3);
    expect(source.revision).toBe(0);
  });

  it("fires declared meter thresholds deterministically", () => {
    const next = applyTransitionProposal(
      worldState(),
      proposal([
        {
          kind: "adjust_meter",
          meterId: "health:keeper",
          amount: -10,
          causes: [{ kind: "check", id: "attack-roll" }],
          assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
        },
      ]),
    );

    expect(next.truth.entities.keeper.lifecycle).toBe("retired");
    const thresholdFactId = runtimeId({
      worldHash: TEST_WORLD_HASH,
      revision: 0,
      kind: "fact",
      stage: "threshold",
      owner: ["health:keeper", "death-at-zero"],
      round: 0,
      ordinal: 0,
    });
    expect(next.truth.facts[thresholdFactId].value).toEqual({
      kind: "text",
      value: "dead",
    });
  });

  it("keeps removed semantic and runtime Fact identities tombstoned for life", () => {
    const semantic = worldState();
    applyWorldDeltaOperation(semantic, {
      kind: "remove_fact",
      factId: "key-authenticity",
      causes: causalAction,
      assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
    });
    expect(() => applyWorldDeltaOperation(semantic, {
      kind: "set_fact",
      fact: {
        id: "key-authenticity",
        subjectId: "key",
        predicate: "authenticity",
        value: { kind: "text", value: "real" },
        description: "试图复用已经删除的 Fact identity。",
        access: { kind: "private" },
        provenance: causalAction,
      },
      causes: causalAction,
      assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
    })).toThrow("fact identity is tombstoned");

    const runtime = applyTransitionProposal(worldState(), proposal([{
      kind: "adjust_meter",
      meterId: "health:keeper",
      amount: -10,
      causes: [{ kind: "check", id: "attack-roll" }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
    }]));
    const thresholdFactId = Object.keys(runtime.truth.facts).find((id) => id.startsWith("rt:fact:"))!;
    applyWorldDeltaOperation(runtime, {
      kind: "remove_fact",
      factId: thresholdFactId,
      causes: causalAction,
      assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
    });
    expect(runtime.truth.factTombstones).toContain(thresholdFactId);
    expect(() => validateSimulationState(runtime)).not.toThrow();
  });

  it("rejects prototype-polluting record identifiers before state mutation", () => {
    const source = worldState();
    expect(() => applyTransitionProposal(
      source,
      proposal([{
        kind: "set_fact",
        fact: {
          id: "__proto__",
          subjectId: "player",
          predicate: "unsafe",
          value: { kind: "text", value: "must-not-be-written" },
          description: "恶意对象键不得进入状态字典。",
          access: { kind: "public" },
          provenance: [{ kind: "law", id: "worldgen" }],
        },
        causes: [{ kind: "law", id: "worldgen" }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
      }]),
    )).toThrow("semantic ids");
    expect(Object.getPrototypeOf(source.truth.facts)).toBe(Object.prototype);
    expect(Object.hasOwn(source.truth.facts, "__proto__")).toBe(false);
  });

  it("rejects identifiers inherited from Object.prototype before state mutation", () => {
    const source = worldState();
    expect(() => applyTransitionProposal(
      source,
      proposal([{
        kind: "set_fact",
        fact: {
          id: "toString",
          subjectId: "player",
          predicate: "unsafe",
          value: { kind: "boolean", value: true },
          description: "不得覆盖对象原型成员。",
          access: { kind: "public" },
          provenance: [{ kind: "law", id: "worldgen" }],
        },
        causes: [{ kind: "law", id: "worldgen" }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
      }]),
    )).toThrow("semantic ids");
    expect(Object.hasOwn(source.truth.facts, "toString")).toBe(false);
  });

  it("rejects observation introductions that overwrite an existing private identity", () => {
    const source = worldState();
    expect(() => validateObservations(source, [{
      id: "observation:rebind-self",
      observerId: "keeper",
      step: 1,
      kind: "outcome",
      summary: "试图用 introduction 重写既有 self。",
      introductions: [{
        localEntity: { id: "self", name: "伪造身份", description: "覆盖既有局部身份", status: "observed" },
        canonicalEntityId: "player",
      }],
      apparentClaims: [],
      sourceEventIds: [],
    }])).toThrow("reintroduces local entity self");
  });

  it("keeps removed observer-local identities tombstoned for live observations", () => {
    const source = worldState();
    source.historyBase = createHistoryReplayBase(source);
    delete source.agents.keeper.belief.localEntities.self;
    delete source.agents.keeper.bindings.self;

    expect(() => validateObservations(source, [{
      id: "observation:tombstone",
      observerId: "keeper",
      step: 1,
      kind: "outcome",
      summary: "试图重新占用已删除的局部身份。",
      introductions: [{
        localEntity: { id: "self", name: "伪造身份", description: "不允许复用", status: "observed" },
        canonicalEntityId: "player",
      }],
      apparentClaims: [],
      sourceEventIds: [],
    }])).toThrow("reintroduces local entity self");
  });

  it("rejects blank observation summaries", () => {
    const source = worldState();
    expect(() => validateObservations(source, [{
      id: "observation:blank-summary",
      observerId: "player",
      step: 1,
      kind: "outcome",
      summary: " \t\n ",
      introductions: [],
      apparentClaims: [],
      sourceEventIds: [],
    }])).toThrow("blank summary");
  });

  it("creates a dynamic autonomous entity without special-case code", () => {
    const skeleton: AgentState = {
      id: "skeleton-agent",
      entityId: "skeleton",
      modelProfiles: { bootstrap: "agent-default", mind: "agent-default", reaction: "agent-default" },
      character: createEmptyCharacter("受召唤者命令的骷髅"),
      belief: {
        localEntities: {
          self: { id: "self", name: "我", description: "骷髅自己", status: "observed" },
        },
        claims: {},
        evidence: {},
      },
      bindings: { self: { localEntityId: "self", canonicalEntityIds: ["skeleton"] } },
      observationCursorStep: 0,
      nextAction: null,
    };
    const next = applyTransitionProposal(
      worldState(),
      proposal([
        {
          kind: "create_entity",
          entity: {
            id: "skeleton",
            kind: "undead",
            name: "新生骷髅",
            description: "刚被唤起的骷髅。",
            lifecycle: "active",
            createdAtStep: 1,
          },
          placementId: "keeper",
          causes: [{ kind: "law", id: "necromancy" }],
          assertions: [{ kind: "entity_absent", entityId: "skeleton" }],
        },
        {
          kind: "create_agent",
          agent: skeleton,
          causes: [{ kind: "law", id: "necromancy" }],
          assertions: [{ kind: "entity_lifecycle", entityId: "skeleton", expected: "active" }],
        },
      ]),
    );

    expect(next.truth.entities.skeleton.kind).toBe("undead");
    expect(next.agents["skeleton-agent"].entityId).toBe("skeleton");
  });

  it("rejects containment cycles", () => {
    const state = worldState();
    state.truth.placements.player = "key";
    expect(() => validateSimulationState(state)).toThrow("placement cycle");
  });
});
