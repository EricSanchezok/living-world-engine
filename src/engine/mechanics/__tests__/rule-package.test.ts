import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { AgentActionProposal, MechanicInvocation, WorldDeltaOperation } from "../../contracts/model";
import { createCoreRulePackageRegistry, MechanicInputValidationError } from "../rule-package";
import { quantityId, runtimeId } from "../../runtime/runtime-id";
import { createTestModelCatalog } from "../../testing/model-provider";
import { deriveResolutionReceipt, type ResolutionPlan, type ResolutionReceipt } from "../resolution";

const fixture = path.resolve("test/fixtures/open-world-script");

function loaded() {
  return loadWorldScript(fixture, { seed: 7, modelCatalog: createTestModelCatalog() });
}

function action(worldHash: string): AgentActionProposal {
  return {
    id: runtimeId({
      worldHash,
      revision: 0,
      kind: "action",
      stage: "test",
      owner: "player",
      round: 0,
      ordinal: 0,
    }),
    actorId: "player",
    baseRevision: 0,
    rawText: "把 2 枚灵石交给守门人",
    goal: "支付两枚灵石",
    means: "交付 2 枚灵石",
    targetIds: [],
  };
}

function ruleContext(definition: ReturnType<typeof loaded>, actions: AgentActionProposal[]) {
  return {
    state: definition.initialState,
    actions,
    resolutionPlans: [],
    resolutionReceipts: [],
    checkRequests: [],
    checkResults: [],
    randomRequests: [],
    randomResults: [],
  };
}

describe("core-resolution trusted rules", () => {
  it.each([1, 3])("consumes a Condition once across repeated means and evidence annotations (uses=%s)", remainingUses => {
    const definition = loaded(), registry = createCoreRulePackageRegistry(), playerAction = action(definition.contentHash);
    const state = structuredClone(definition.initialState);
    state.truth.mechanics.durationProfiles["test-charge"] = { id: "test-charge", name: "Test charge", kind: "uses", uses: remainingUses };
    state.truth.conditions["test-charge"] = { id: "test-charge", subjectId: "player", label: "Charged focus", description: "A finite-use supporting focus.",
      magnitude: "minor", durationProfileId: "test-charge", conditionProfileId: null, stackingKey: null, remainingUses,
      expiresAtElapsedSeconds: null, access: { kind: "public" }, provenance: [{ kind: "action", id: playerAction.id }] };
    const source = { kind: "condition" as const, id: "test-charge" };
    const planId = runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "resolution-plan", stage: "test", owner: playerAction.id, round: 0, ordinal: 0 });
    const base: ResolutionPlan = { id: planId, actionId: playerAction.id, actorId: "player", targetIds: ["player"], goal: "Use the focus while observing.",
      means: [{ description: "Use the supporting focus.", source }, { description: "The same focus remains the source of concentration.", source }],
      factors: [], mode: "automatic", difficulty: null, actorRatingId: null, risk: "safe", baseEffect: "none", primaryEffect: null,
      secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", id: playerAction.id }] };
    const annotated: ResolutionPlan = { ...base, factors: [
      { source, role: "permission", direction: "neutral", steps: 0, authority: "semantic", channel: null, explanation: "The focus supports this attempt." },
      { source, role: "risk", direction: "neutral", steps: 0, authority: "semantic", channel: null, explanation: "The limited focus may be exhausted." },
    ] };
    const before = structuredClone({ state, annotated });
    const apply = (plan: ResolutionPlan) => {
      const receiptId = runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "resolution-receipt", stage: "test", owner: plan.id, round: 0, ordinal: 0 });
      const receipt = deriveResolutionReceipt({ receiptId, plan, checkRequestId: null, check: null, result: null });
      const invocation: MechanicInvocation = { id: runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "mechanic", stage: "test", owner: receiptId, round: 0, ordinal: 0 }),
        packageId: "core-resolution", ruleId: "apply-receipt", input: { receiptId: receipt.id },
        causes: [{ kind: "action", id: playerAction.id }], assertions: [{ kind: "entity_lifecycle", entityId: "player", expected: "active" }] };
      return registry.resolve(definition.rulePackages, { ...ruleContext(definition, [playerAction]), state, resolutionPlans: [plan], resolutionReceipts: [receipt] }, [invocation], []);
    };
    const baseline = apply(base), candidate = apply(annotated);
    expect(candidate.operations).toEqual(baseline.operations);
    expect(candidate.operations).toHaveLength(1);
    expect(candidate.operations[0]).toMatchObject(remainingUses === 1 ? { kind: "remove_condition", conditionId: "test-charge" }
      : { kind: "set_condition", condition: { id: "test-charge", remainingUses: remainingUses - 1 } });
    expect({ state, annotated }).toEqual(before);
  });

  it("projects runtime mechanic contracts without executable package details", () => {
    const definition = loaded();
    const contracts = createCoreRulePackageRegistry().promptContracts(definition.rulePackages);
    const transfer = contracts.find((contract) => contract.ruleId === "transfer-quantity");
    expect(transfer).toMatchObject({ packageId: "core-resolution", version: "2.0.0" });
    expect(transfer?.inputSchema).toMatchObject({
      type: "object",
      required: ["definitionRef", "fromHolderRef", "toHolderRef", "amountSource"],
    });
    expect(transfer?.inputSchema).toHaveProperty("properties.definitionRef.pattern", "^ref:");
    expect(transfer?.inputSchema).toHaveProperty("properties.fromHolderRef.pattern", "^ref:");
    expect(transfer).not.toHaveProperty("config");
    expect(transfer).not.toHaveProperty("resolve");
  });

  it("reports stale mechanic input as an invocation-local contract error", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const invocation: MechanicInvocation = {
      id: runtimeId({
        worldHash: definition.contentHash,
        revision: 0,
        kind: "mechanic",
        stage: "test",
        owner: "stale-transfer",
        round: 0,
        ordinal: 0,
      }),
      packageId: "core-resolution",
      ruleId: "transfer-quantity",
      input: {
        definitionId: "spirit-stone",
        holderId: "player",
        direction: "to",
        amountProvenance: { kind: "action", actionId: playerAction.id },
      },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [],
    };

    expect(() => registry.validateInvocationInputs(definition.rulePackages, [invocation]))
      .toThrowError(MechanicInputValidationError);
    try {
      registry.validateInvocationInputs(definition.rulePackages, [invocation]);
    } catch (error) {
      expect(error).toMatchObject({
        name: "MechanicInputValidationError",
        invocationId: invocation.id,
        packageId: "core-resolution",
        ruleId: "transfer-quantity",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["fromHolderId"], message: expect.any(String) }),
        ]),
      });
    }
  });

  it("instantiates a declared mechanics profile for a newly created entity", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const createEntity: WorldDeltaOperation = {
      kind: "create_entity",
      entity: {
        id: "new-wanderer",
        kind: "person",
        name: "新旅人",
        description: "刚进入庭院的人。",
        lifecycle: "active",
        createdAtStep: 1,
      },
      placementId: "courtyard",
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{ kind: "entity_absent", entityId: "new-wanderer" }],
    };
    const invocation: MechanicInvocation = {
      id: runtimeId({
        worldHash: definition.contentHash,
        revision: 0,
        kind: "mechanic",
        stage: "test",
        owner: "new-wanderer-profile",
        round: 0,
        ordinal: 0,
      }),
      packageId: "core-resolution",
      ruleId: "instantiate-entity-profile",
      input: { entityId: "new-wanderer", profileId: "wanderer" },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{ kind: "entity_absent", entityId: "new-wanderer" }],
    };

    const resolved = registry.resolve(
      definition.rulePackages,
      ruleContext(definition, [playerAction]),
      [invocation],
      [createEntity],
    );

    expect(resolved.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "set_meter", meter: expect.objectContaining({
        id: "new-wanderer-health", current: 20,
      }) }),
      expect.objectContaining({ kind: "set_quantity", quantity: expect.objectContaining({
        definitionId: "spirit-stone", holderId: "new-wanderer", amount: 1,
      }) }),
      expect.objectContaining({ kind: "set_rating", rating: expect.objectContaining({
        id: "new-wanderer-resolve", value: 1,
      }) }),
    ]));
  });

  it("instantiates a deterministic cohort of newly created entities with one trusted rule", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const entityIds = ["summon-3", "summon-1", "summon-2"];
    const createEntities: WorldDeltaOperation[] = entityIds.map((entityId) => ({
      kind: "create_entity",
      entity: {
        id: entityId,
        kind: "undead",
        name: entityId,
        description: "由死灵法术召唤的怪物。",
        lifecycle: "active",
        createdAtStep: 1,
      },
      placementId: "courtyard",
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{ kind: "entity_absent", entityId }],
    }));
    const invocation: MechanicInvocation = {
      id: runtimeId({
        worldHash: definition.contentHash,
        revision: 0,
        kind: "mechanic",
        stage: "test",
        owner: "summon-cohort",
        round: 0,
        ordinal: 0,
      }),
      packageId: "core-resolution",
      ruleId: "instantiate-entity-cohort",
      input: { entityIds, profileId: "wanderer" },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: entityIds.map((entityId) => ({ kind: "entity_absent" as const, entityId })),
    };

    const resolved = registry.resolve(
      definition.rulePackages,
      ruleContext(definition, [playerAction]),
      [invocation],
      createEntities,
    );

    expect(resolved.operations.filter((operation) => operation.kind === "set_meter")).toHaveLength(3);
    expect(resolved.operations.filter((operation) => operation.kind === "set_quantity")).toHaveLength(3);
    expect(resolved.operations.filter((operation) => operation.kind === "set_rating")).toHaveLength(3);
    expect(resolved.results[0]?.data).toEqual({
      entityIds: ["summon-1", "summon-2", "summon-3"],
      profileId: "wanderer",
      operationCount: 9,
    });
  });

  it("derives an explicit transfer amount from verbatim action text and rejects raw operations", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const invocation: MechanicInvocation = {
      id: runtimeId({
        worldHash: definition.contentHash,
        revision: 0,
        kind: "mechanic",
        stage: "test",
        owner: "transfer",
        round: 0,
        ordinal: 0,
      }),
      packageId: "core-resolution",
      ruleId: "transfer-quantity",
      input: {
        definitionId: "spirit-stone",
        fromHolderId: "player",
        toHolderId: "keeper",
        amountSource: {
          kind: "explicit_action_amount",
          actionId: playerAction.id,
          quotedText: "2",
          amount: 2,
        },
      },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{
        kind: "quantity_compare",
        definitionId: "spirit-stone",
        holderId: "player",
        operator: "gte",
        value: 2,
      }],
    };
    const resolved = registry.resolve(
      definition.rulePackages,
      ruleContext(definition, [playerAction]),
      [invocation],
      [],
    );
    expect(resolved.operations).toEqual([expect.objectContaining({
      kind: "transfer_quantity",
      definitionId: "spirit-stone",
      fromHolderId: "player",
      toHolderId: "keeper",
      amount: 2,
    })]);

    expect(() => registry.resolve(
      definition.rulePackages,
      ruleContext(definition, [playerAction]),
      [],
      [{
        kind: "transfer_quantity",
        definitionId: "spirit-stone",
        fromHolderId: "player",
        toHolderId: "keeper",
        amount: 2,
        causes: [{ kind: "action", id: playerAction.id }],
        assertions: [{
          kind: "quantity_compare",
          definitionId: "spirit-stone",
          holderId: "player",
          operator: "gte",
          value: 2,
        }],
      }],
    )).toThrow("amount must be derived");

    const twentyAction = {
      ...playerAction,
      rawText: "把 20 枚灵石交给守门人",
      goal: "支付 20 枚灵石",
      means: "交付 20 枚灵石",
    };
    expect(() => registry.resolve(
      definition.rulePackages,
      ruleContext(definition, [twentyAction]),
      [invocation],
      [],
    )).toThrow("not present verbatim");
  });

  it("derives and clamps Meter impact solely from a receipt and impact profile", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const state = structuredClone(definition.initialState);
    state.truth.meters["health:keeper"].current = 3;
    const planId = runtimeId({
      worldHash: definition.contentHash,
      revision: 0,
      kind: "resolution-plan",
      stage: "test",
      owner: playerAction.id,
      round: 0,
      ordinal: 0,
    });
    const plan: ResolutionPlan = {
      id: planId,
      actionId: playerAction.id,
      actorId: "player",
      targetIds: ["keeper", "player"],
      goal: playerAction.goal,
      means: [{ description: "an improvised strike", source: { kind: "entity", id: "player" } }],
      mode: "automatic",
      difficulty: null,
      actorRatingId: null,
      factors: [],
      risk: "safe",
      baseEffect: "standard",
      primaryEffect: {
        kind: "meter",
        id: "harm",
        targetId: "keeper",
        channel: "physical-harm",
        label: "harm",
        description: "The strike causes harm.",
        sourceRefs: [{ kind: "entity", id: "player" }],
        meterId: "health:keeper",
        impactProfileId: "harm",
        magnitude: "standard",
      },
      secondaryEffect: null,
      threatenedEffect: null,
      visibility: "full",
      causes: [{ kind: "action", id: playerAction.id }],
    };
    const receiptId = runtimeId({
      worldHash: definition.contentHash,
      revision: 0,
      kind: "resolution-receipt",
      stage: "test",
      owner: plan.id,
      round: 0,
      ordinal: 0,
    });
    const receipt: ResolutionReceipt = {
      id: receiptId,
      plan,
      settled: true,
      checkRequestId: null,
      dc: null,
      modifier: 0,
      checkMode: null,
      dice: [],
      kept: null,
      total: null,
      margin: null,
      outcome: "full",
      effects: [{ role: "primary", magnitude: "standard", intent: plan.primaryEffect! }],
      operations: [],
    };
    const invocation: MechanicInvocation = {
      id: runtimeId({
        worldHash: definition.contentHash,
        revision: 0,
        kind: "mechanic",
        stage: "test",
        owner: receipt.id,
        round: 0,
        ordinal: 0,
      }),
      packageId: "core-resolution",
      ruleId: "apply-receipt",
      input: { receiptId },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{ kind: "entity_lifecycle", entityId: "player", expected: "active" }],
    };
    const resolved = registry.resolve(
      definition.rulePackages,
      { ...ruleContext(definition, [playerAction]), state, resolutionPlans: [plan], resolutionReceipts: [receipt] },
      [invocation],
      [],
    );
    expect(resolved.operations).toEqual([expect.objectContaining({
      kind: "adjust_meter",
      meterId: "health:keeper",
      amount: -3,
    })]);
    expect(resolved.results[0].data).toMatchObject({
      receiptId,
      effects: [{ id: "harm", role: "primary", magnitude: "standard" }],
    });
    expect(quantityId(definition.contentHash, "spirit-stone", "player"))
      .toBe(Object.values(state.truth.quantities).find((quantity) => quantity.holderId === "player")?.id);
  });

  it("clamps cumulative receipt impacts against prior trusted results", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const state = structuredClone(definition.initialState);
    state.truth.meters["health:keeper"].current = 6;
    const makeReceipt = (ordinal: number): ResolutionReceipt => {
      const plan: ResolutionPlan = {
        id: runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "resolution-plan", stage: "test", owner: `plan-${ordinal}`, round: 0, ordinal }),
        actionId: playerAction.id,
        actorId: "player",
        targetIds: ["keeper"],
        goal: "伤害守门人",
        means: [{ description: "攻击", source: { kind: "entity", id: "player" } }],
        mode: "automatic",
        difficulty: null,
        actorRatingId: null,
        factors: [],
        risk: "safe",
        baseEffect: "standard",
        primaryEffect: {
          kind: "meter",
          id: `harm-${ordinal}`,
          targetId: "keeper",
          channel: "physical-harm",
          label: "伤害",
          description: "造成伤害。",
          sourceRefs: [{ kind: "entity", id: "player" }],
          meterId: "health:keeper",
          impactProfileId: "harm",
          magnitude: "standard",
        },
        secondaryEffect: null,
        threatenedEffect: null,
        visibility: "full",
        causes: [{ kind: "action", id: playerAction.id }],
      };
      return {
        id: runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "resolution-receipt", stage: "test", owner: plan.id, round: 0, ordinal }),
        plan,
        settled: true,
        checkRequestId: null,
        dc: null,
        modifier: 0,
        checkMode: null,
        dice: [],
        kept: null,
        total: null,
        margin: null,
        outcome: "full",
        effects: [{ role: "primary", magnitude: "standard", intent: plan.primaryEffect! }],
        operations: [],
      };
    };
    const receipts = [makeReceipt(0), makeReceipt(1)];
    const invocations = receipts.map((receipt, ordinal): MechanicInvocation => ({
      id: runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "mechanic", stage: "test", owner: receipt.id, round: 0, ordinal }),
      packageId: "core-resolution",
      ruleId: "apply-receipt",
      input: { receiptId: receipt.id },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{ kind: "entity_lifecycle", entityId: "player", expected: "active" }],
    }));

    const resolved = registry.resolve(
      definition.rulePackages,
      { ...ruleContext(definition, [playerAction]), state, resolutionPlans: receipts.map((entry) => entry.plan), resolutionReceipts: receipts },
      invocations,
      [],
    );

    expect(resolved.operations.filter((operation) => operation.kind === "adjust_meter"))
      .toEqual([
        expect.objectContaining({ amount: -5 }),
        expect.objectContaining({ amount: -1 }),
      ]);
  });

  it("settles recurring and elapsed condition profiles through the engine-owned time rule", () => {
    const definition = loaded();
    const registry = createCoreRulePackageRegistry();
    const playerAction = action(definition.contentHash);
    const state = structuredClone(definition.initialState);
    state.truth.meters["health:keeper"].current = 3;
    state.truth.mechanics.durationProfiles.moment = {
      id: "moment",
      name: "片刻",
      kind: "elapsed",
      seconds: 30,
    };
    state.truth.mechanics.conditionProfiles.burning = {
      id: "burning",
      name: "燃烧",
      stackingKey: "burning",
      defaultDurationProfileId: "moment",
      recurringImpactProfileId: "harm",
      recovery: "扑灭火焰",
      thresholds: [],
    };
    state.truth.conditions.burning = {
      id: "burning",
      subjectId: "keeper",
      label: "燃烧",
      description: "火焰仍在灼烧。",
      magnitude: "standard",
      durationProfileId: "moment",
      conditionProfileId: "burning",
      stackingKey: "burning",
      remainingUses: null,
      expiresAtElapsedSeconds: 30,
      access: { kind: "public" },
      provenance: [{ kind: "action", id: playerAction.id }],
    };
    const invocation: MechanicInvocation = {
      id: runtimeId({ worldHash: definition.contentHash, revision: 0, kind: "mechanic", stage: "test", owner: "condition-time", round: 0, ordinal: 0 }),
      packageId: "core-resolution",
      ruleId: "advance-conditions",
      input: { seconds: 60 },
      causes: [{ kind: "action", id: playerAction.id }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 0 }],
    };

    const resolved = registry.resolve(
      definition.rulePackages,
      { ...ruleContext(definition, [playerAction]), state },
      [invocation],
      [],
    );

    expect(resolved.operations).toEqual([
      expect.objectContaining({ kind: "adjust_meter", meterId: "health:keeper", amount: -3 }),
      expect.objectContaining({ kind: "remove_condition", conditionId: "burning" }),
    ]);
  });
});
