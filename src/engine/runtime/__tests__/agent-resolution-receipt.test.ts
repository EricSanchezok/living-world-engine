import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { ResolutionReceipt } from "../../mechanics/resolution";
import { projectAgentResolutionReceipt } from "../../cognition/agent-perspective";
import { createTestModelCatalog } from "../../testing/model-provider";

const fixture = path.resolve("test/fixtures/open-world-script");

function receipt(visibility: "full" | "result_only" | "hidden"): ResolutionReceipt {
  return {
    id: `receipt-${visibility}`,
    plan: {
      id: `plan-${visibility}`,
      actionId: "player-action",
      actorId: "player",
      targetIds: ["keeper"],
      goal: "让守门人开门",
      means: [
        { description: "使用随身铜钥匙", source: { kind: "entity", id: "key" } },
        { description: "利用钥匙其实是仿制品", source: { kind: "fact", id: "key-authenticity" } },
      ],
      mode: "check",
      difficulty: { kind: "opposed", targetId: "keeper", ratingId: "resolve:keeper", source: { kind: "rating", id: "resolve:keeper" } },
      actorRatingId: "resolve:player",
      factors: [{
        source: { kind: "fact", id: "key-authenticity" },
        role: "risk",
        direction: "neutral",
        steps: 0,
        authority: "semantic",
        channel: null,
        explanation: "钥匙是假的，揭穿后会失去信任。",
      }],
      risk: "risky",
      baseEffect: "standard",
      primaryEffect: {
        id: "opened",
        kind: "condition",
        targetId: "keeper",
        channel: "social",
        label: "愿意开门",
        description: "守门人同意放行。",
        sourceRefs: [{ kind: "action", id: "player-action" }],
        conditionId: "keeper-willing",
        conditionProfileId: null,
        durationProfileId: "brief",
        access: { kind: "public" },
        magnitude: "standard",
      },
      secondaryEffect: null,
      threatenedEffect: {
        id: "distrusted",
        kind: "condition",
        targetId: "player",
        channel: "social",
        label: "不被信任",
        description: "守门人看穿了欺骗。",
        sourceRefs: [{ kind: "fact", id: "key-authenticity" }],
        conditionId: "player-distrusted",
        conditionProfileId: null,
        durationProfileId: "brief",
        access: { kind: "public" },
      },
      visibility,
      causes: [{ kind: "action", id: "player-action" }],
    },
    settled: true,
    checkRequestId: "check-1",
    dc: 13,
    modifier: 2,
    checkMode: "normal",
    dice: [15],
    kept: 15,
    total: 17,
    margin: 4,
    outcome: "full",
    effects: [],
    operations: [],
  };
}

describe("AgentPerspective resolution receipt projection", () => {
  it("retains both visible annotation roles while independently filtering hidden evidence", () => {
    const definition = loadWorldScript(fixture, { seed: 1, modelCatalog: createTestModelCatalog() });
    const annotated = receipt("full");
    annotated.plan.factors.push(
      { source: { kind: "entity", id: "key" }, role: "permission", direction: "neutral", steps: 0, authority: "semantic", channel: null, explanation: "The carried key provides the attempted means." },
      { source: { kind: "entity", id: "key" }, role: "risk", direction: "neutral", steps: 0, authority: "semantic", channel: null, explanation: "The visible key can draw attention." },
    );
    const view = projectAgentResolutionReceipt(definition.initialState, definition.initialState.agents.player, annotated);
    expect(view).toMatchObject({ visibility: "full", plan: { factors: [
      { role: "permission", direction: "neutral", steps: 0, explanation: "The carried key provides the attempted means." },
      { role: "risk", direction: "neutral", steps: 0, explanation: "The visible key can draw attention." },
    ] } });
    expect(JSON.stringify(view)).not.toContain("key-authenticity");
    expect(JSON.stringify(view)).not.toContain("ref:entity:key");
    expect(projectAgentResolutionReceipt(definition.initialState, definition.initialState.agents.player, { ...annotated, plan: { ...annotated.plan, visibility: "result_only" } }))
      .not.toHaveProperty("plan");
  });

  it("shows a full adjudication chain without hidden canonical evidence", () => {
    const definition = loadWorldScript(fixture, { seed: 1, modelCatalog: createTestModelCatalog() });
    const view = projectAgentResolutionReceipt(
      definition.initialState,
      definition.initialState.agents.player,
      receipt("full"),
    );

    expect(view).toMatchObject({
      visibility: "full",
      plan: {
        means: ["使用随身铜钥匙"],
        actorRating: { name: "决心", value: 2 },
        factors: [],
      },
      check: { dc: null, dice: [15], total: 17, margin: 4 },
    });
  });

  it("honors result-only and hidden visibility", () => {
    const definition = loadWorldScript(fixture, { seed: 1, modelCatalog: createTestModelCatalog() });
    const agent = definition.initialState.agents.player;
    expect(projectAgentResolutionReceipt(definition.initialState, agent, receipt("result_only")))
      .toEqual(expect.objectContaining({ visibility: "result_only", outcome: "full" }));
    expect(projectAgentResolutionReceipt(definition.initialState, agent, receipt("hidden"))).toBeNull();
  });

  it("does not expose another actor's Rating math or private effects to a target", () => {
    const definition = loadWorldScript(fixture, { seed: 1, modelCatalog: createTestModelCatalog() });
    const privateEffectReceipt = receipt("full");
    const primaryEffect = privateEffectReceipt.plan.primaryEffect;
    if (!primaryEffect || primaryEffect.kind !== "condition") {
      throw new Error("fixture receipt must use a condition primary effect");
    }
    privateEffectReceipt.effects = [{
      role: "primary",
      magnitude: "standard",
      intent: {
        ...primaryEffect,
        access: { kind: "private" },
      },
    }];
    const view = projectAgentResolutionReceipt(
      definition.initialState,
      definition.initialState.agents.keeper,
      privateEffectReceipt,
    );

    expect(view).toMatchObject({
      visibility: "full",
      effects: [],
      plan: { actorRating: null },
      check: { dc: 13, modifier: null, total: null, margin: null },
    });
  });

  it("does not treat a local identity binding as permission to reveal remote canonical placement", () => {
    const definition = loadWorldScript(fixture, { seed: 1, modelCatalog: createTestModelCatalog() });
    const source = structuredClone(definition.initialState);
    source.truth.placements.key = "courtyard";
    const value = receipt("full");
    value.plan.means.push({
      description: "铜钥匙已经落在远处庭院",
      source: { kind: "placement", id: "key" },
    });

    const view = projectAgentResolutionReceipt(source, source.agents.player, value);

    expect(view?.visibility).toBe("full");
    if (view?.visibility !== "full") throw new Error("expected a full receipt view");
    expect(view.plan.means).not.toContain("铜钥匙已经落在远处庭院");
  });
});
