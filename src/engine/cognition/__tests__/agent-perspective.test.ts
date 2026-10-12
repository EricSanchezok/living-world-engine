import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { projectAgentPerspective } from "../agent-perspective";
import { validateSelfConsequenceIntroductions } from "../../runtime/canonical-committer";
import type {
  AgentActionProposal,
  ObservationPacket,
  SimulationState,
  TransitionProposal,
  WorldEntity,
  WorldFact,
} from "../../contracts/model";
import { createTestModelCatalog } from "../../testing/model-provider";

const fixture = path.resolve("test/fixtures/open-world-script");

function state(): SimulationState {
  return structuredClone(loadWorldScript(fixture, {
    modelCatalog: createTestModelCatalog(),
  }).initialState);
}

function entity(id: string, name: string, description: string): WorldEntity {
  return { id, kind: "thing", name, description, lifecycle: "active", createdAtStep: 0 };
}

function fact(input: Omit<WorldFact, "provenance">): WorldFact {
  return { ...input, provenance: [{ kind: "world_seed", id: "perspective-test" }] };
}

describe("AgentPerspective", () => {
  it("combines exact self state with subjective knowledge without canonical identities", () => {
    const source = state();
    const perspective = projectAgentPerspective(source, source.agents.player);

    expect(perspective).toMatchObject({
      agentId: "player",
      revision: 0,
      step: 0,
      self: {
        localEntityId: "self",
        name: "旅人",
        location: { name: "石门前庭" },
      },
      mechanics: {
        meters: [{ name: "生命", current: 12, min: 0, max: 20 }],
        quantityCoverage: "complete-current-self-holdings",
        quantities: [{ name: "灵石", unit: "枚", amount: 3 }],
        ratings: [{ name: "决心", value: 2, min: -5, max: 10 }],
      },
    });
    expect(perspective.knowledge.containment).toContainEqual({
      entityRef: "local:copper-key",
      containerRef: "local:self",
      depth: 1,
      viaUnknownContainer: false,
    });
    expect(perspective.knowledge.claims).toContainEqual(expect.objectContaining({
      id: "key-is-authentic",
      stance: "suspected",
      value: { kind: "text", value: "real" },
    }));
    expect(perspective.knowledge.exactFacts).toEqual([]);
    expect(JSON.stringify(perspective)).not.toContain("key-authenticity");
    expect(JSON.stringify(perspective)).not.toContain("钥匙是仿制品");
  });

  it("projects authorized self relations and one related hop without remote placement", () => {
    const source = state();
    source.truth.entities.house = entity("house", "河岸小屋", "一栋登记在旅人名下的小屋。");
    source.truth.entities.friend = entity("friend", "旧友", "曾赠予旅人钥匙的人。");
    source.truth.entities.tavern = entity("tavern", "远岸酒馆", "远处的一间酒馆。");
    source.truth.placements.house = "tavern";
    source.truth.placements.friend = "tavern";
    source.truth.placements.tavern = null;
    source.truth.facts.ownership = fact({
      id: "ownership",
      subjectId: "house",
      predicate: "owned-by",
      value: { kind: "entity", entityId: "player" },
      description: "河岸小屋登记在旅人名下。",
      access: { kind: "agents", agentIds: ["player"] },
    });
    source.truth.facts.gift = fact({
      id: "gift",
      subjectId: "key",
      predicate: "gifted-by",
      value: { kind: "entity", entityId: "friend" },
      description: "这把钥匙来自一位旧友。",
      access: { kind: "public" },
    });
    source.truth.facts.secret = fact({
      id: "secret",
      subjectId: "player",
      predicate: "watched-by",
      value: { kind: "entity", entityId: "friend" },
      description: "旧友正在暗中观察旅人。",
      access: { kind: "private" },
    });

    const perspective = projectAgentPerspective(source, source.agents.player);
    const text = JSON.stringify(perspective);
    expect(perspective.knowledge.exactFacts.map((entry) => entry.predicate).sort()).toEqual([
      "gifted-by",
      "owned-by",
    ]);
    expect(perspective.knowledge.entities).toContainEqual(expect.objectContaining({
      name: "河岸小屋",
      status: "authorized",
      targetable: false,
    }));
    expect(text).toContain("这把钥匙来自一位旧友");
    expect(text).not.toContain("旧友正在暗中观察旅人");
    expect(text).not.toContain("远岸酒馆");
    expect(text).not.toContain("ownership");
    expect(text).not.toContain("gift\"");
  });

  it("shows unidentified self-contained presences without leaking their identity", () => {
    const source = state();
    source.truth.entities.hiddenGrass = entity("hiddenGrass", "月影草", "一株罕见的月影草。");
    source.truth.placements.hiddenGrass = "player";

    const perspective = projectAgentPerspective(source, source.agents.player);
    expect(perspective.knowledge.entities).toContainEqual(expect.objectContaining({
      name: "未识别的随身存在",
      status: "unidentified",
      targetable: false,
    }));
    expect(JSON.stringify(perspective)).not.toContain("hiddenGrass");
    expect(JSON.stringify(perspective)).not.toContain("月影草");
  });

  it("removes exact containment without exposing the known entity's remote location", () => {
    const source = state();
    source.truth.entities.tavern = entity("tavern", "远岸酒馆", "旅人已经离开的酒馆。");
    source.truth.entities.table = entity("table", "角落木桌", "酒馆角落的一张桌子。");
    source.truth.placements.tavern = null;
    source.truth.placements.table = "tavern";
    source.truth.placements.key = "table";
    source.truth.facts.keyOwnership = fact({
      id: "keyOwnership",
      subjectId: "player",
      predicate: "owns",
      value: { kind: "entity", entityId: "key" },
      description: "这把铜钥匙属于旅人。",
      access: { kind: "agents", agentIds: ["player"] },
    });

    const perspective = projectAgentPerspective(source, source.agents.player);
    expect(perspective.knowledge.containment.some((entry) => entry.entityRef === "local:copper-key"))
      .toBe(false);
    expect(perspective.knowledge.exactFacts).toContainEqual(expect.objectContaining({ predicate: "owns" }));
    expect(JSON.stringify(perspective)).not.toContain("远岸酒馆");
    expect(JSON.stringify(perspective)).not.toContain("角落木桌");
  });

  it("produces empty generic collections for a world without mechanics or history", () => {
    const source = state();
    source.truth.meters = {};
    source.truth.quantities = {};
    source.truth.ratings = {};
    source.truth.facts = {};
    source.truth.placements.key = null;
    source.agents.player.belief.claims = {};
    source.agents.player.belief.evidence = {};

    const perspective = projectAgentPerspective(source, source.agents.player);
    expect(perspective.mechanics).toEqual({ meters: [], quantityCoverage: "complete-current-self-holdings", quantities: [], ratings: [], conditions: [] });
    expect(perspective.knowledge.containment).toEqual([]);
    expect(perspective.knowledge.exactFacts).toEqual([]);
    expect(perspective.knowledge.claims).toEqual([]);
    expect(perspective.history).toEqual([]);
  });

  it("keeps self conditions exact while filtering private canonical state", () => {
    const source = state();
    const base = {
      subjectId: "player",
      magnitude: "minor" as const,
      durationProfileId: "brief",
      conditionProfileId: null,
      stackingKey: null,
      remainingUses: 1,
      nextImpactAtElapsedSeconds: null, expiresAtElapsedSeconds: null,
      provenance: [{ kind: "action" as const, id: "condition-test" }],
    };
    source.truth.conditions.visible = {
      ...base,
      id: "visible",
      label: "踉跄",
      description: "脚步暂时不稳。",
      access: { kind: "agents", agentIds: ["player"] },
    };
    source.truth.conditions.hidden = {
      ...base,
      id: "hidden",
      label: "隐藏印记",
      description: "主体尚未察觉的状态。",
      access: { kind: "private" },
    };

    const perspective = projectAgentPerspective(source, source.agents.player);

    expect(perspective.mechanics.conditions).toContainEqual(expect.objectContaining({ label: "踉跄", duration: "短暂" }));
    expect(JSON.stringify(perspective)).not.toContain('"id":"visible"');
    expect(JSON.stringify(perspective)).not.toContain("隐藏印记");
  });

  it("requires successful newly carried entities to be introduced to the acting Agent", () => {
    const source = state();
    const action: AgentActionProposal = {
      id: "gather-grass",
      actorId: "player",
      baseRevision: source.revision,
      rawText: "路边拔三颗草收起来",
      goal: "收集三颗草",
      means: null,
      targetIds: [],
    };
    const proposal: TransitionProposal = {
      baseRevision: source.revision,
      outcomes: [{
        id: "outcome-gather-grass",
        proposalId: action.id,
        status: "succeeded",
        summary: "旅人收起了三颗草。",
        causeRefs: [{ kind: "action", id: action.id }],
        assertions: [],
        knownAlternatives: [],
      }],
      mechanicInvocations: [],
      operations: [{
        kind: "create_entity",
        entity: entity("grass", "三颗草", "刚从路边拔下来的三颗草。"),
        placementId: "player",
        causes: [{ kind: "action", id: action.id }],
        assertions: [],
      }, {
        kind: "advance_time",
        seconds: 5,
        causes: [{ kind: "action", id: action.id }],
        assertions: [],
      }],
      events: [],
      observations: [],
      decisionRequests: [],
    };
    const transitioned = structuredClone(source);
    transitioned.truth.entities.grass = entity("grass", "三颗草", "刚从路边拔下来的三颗草。");
    transitioned.truth.placements.grass = "player";

    expect(() => validateSelfConsequenceIntroductions(source, transitioned, [action], proposal, []))
      .toThrow(/grass without an observer-local introduction/);

    const observation: ObservationPacket = {
      id: "observation-grass",
      observerId: "player",
      step: transitioned.step,
      kind: "outcome",
      summary: "你把刚拔下来的三颗草收在了身上。",
      introductions: [{
        localEntity: {
          id: "roadside-grass",
          name: "三颗草",
          description: "刚从路边拔下来的三颗草。",
          status: "observed",
        },
        canonicalEntityId: "grass",
      }],
      apparentClaims: [],
      sourceEventIds: [],
    };
    expect(() => validateSelfConsequenceIntroductions(
      source,
      transitioned,
      [action],
      proposal,
      [observation],
    )).not.toThrow();
  });

  it("requires newly authorized property relations to introduce the property", () => {
    const source = state();
    source.truth.entities.house = entity("house", "河岸小屋", "一栋可以买下的小屋。");
    source.truth.placements.house = "courtyard";
    const action: AgentActionProposal = {
      id: "buy-house",
      actorId: "player",
      baseRevision: source.revision,
      rawText: "买下河岸小屋",
      goal: "拥有河岸小屋",
      means: null,
      targetIds: [],
    };
    const ownership = fact({
      id: "house-ownership",
      subjectId: "house",
      predicate: "owned-by",
      value: { kind: "entity", entityId: "player" },
      description: "河岸小屋登记在旅人名下。",
      access: { kind: "agents", agentIds: ["player"] },
    });
    const proposal: TransitionProposal = {
      baseRevision: source.revision,
      outcomes: [{
        id: "outcome-buy-house",
        proposalId: action.id,
        status: "succeeded",
        summary: "交易完成。",
        causeRefs: [{ kind: "action", id: action.id }],
        assertions: [],
        knownAlternatives: [],
      }],
      mechanicInvocations: [],
      operations: [{
        kind: "set_fact",
        fact: ownership,
        causes: [{ kind: "action", id: action.id }],
        assertions: [],
      }, {
        kind: "advance_time",
        seconds: 60,
        causes: [{ kind: "action", id: action.id }],
        assertions: [],
      }],
      events: [],
      observations: [],
      decisionRequests: [],
    };
    const transitioned = structuredClone(source);
    transitioned.truth.facts[ownership.id] = ownership;
    expect(() => validateSelfConsequenceIntroductions(source, transitioned, [action], proposal, []))
      .toThrow(/house without an observer-local introduction/);
  });
});
