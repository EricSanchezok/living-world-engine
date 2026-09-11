import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import type { ApparentClaim, BeliefValue, FactValue, ObservationPacket, SimulationState, TransitionProposal } from "../../contracts/model";
import { validatePublicInformationBoundary } from "../information-boundary";

function stateWithPrivateAliases() {
  const state = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 1, modelCatalog: createTestModelCatalog(),
  }).initialState;
  for (const id of ["thil", "hold", "keep", "grain", "father", "family", "column", "collector", "warriors"]) state.agents.keeper!.belief.localEntities[id] = {
    id, name: `Unknown ${id}`, description: `Unrevealed entity ${id}`, status: "observed",
  };
  return state;
}

function validate(state: SimulationState, summary: string, details: Partial<Pick<ObservationPacket, "introductions" | "apparentClaims">> = {}) {
  const proposal: TransitionProposal = {
    baseRevision: state.revision, outcomes: [], mechanicInvocations: [], operations: [], events: [], decisionRequests: [],
    observations: [{ id: "observation-player", observerId: "player", step: state.step + 1, kind: "outcome",
      summary, introductions: [], apparentClaims: [], sourceEventIds: [], ...details }],
  };
  validatePublicInformationBoundary(state, [], proposal);
}

function claim(value: BeliefValue, subjectId = "copper-key", predicate = "authenticity"): ApparentClaim {
  return { id: "observed-relation", subjectId, predicate, value, description: "可见关系记录" };
}

describe("public information identifier boundaries", () => {
  it("does not treat private aliases as substrings of unrelated words", () => {
    expect(() => validate(stateWithPrivateAliases(), "Patrol the foothills and visit the households.")).not.toThrow();
  });

  it.each(["ref:local_entity:keeper::thil", "REF:LOCAL_ENTITY:KEEPER::HOLD", "秘密ref:local_entity:keeper::grain仍未知"])("still rejects a qualified foreign local identifier: %s", summary => {
    expect(() => validate(stateWithPrivateAliases(), summary)).toThrow("protected information");
  });

  it("does not make a canonical identifier visible merely because known prose contains a longer word", () => {
    const state = stateWithPrivateAliases();
    state.truth.entities.thil = { ...structuredClone(state.truth.entities.gate!), id: "thil", name: "Unrevealed figure" };
    state.agents.player!.belief.localEntities["copper-key"]!.description += " foothills households";
    expect(() => validate(state, "thil")).toThrow("protected information");
  });

  it("does not turn another Agent's private aliases into global vocabulary bans", () => {
    const state = stateWithPrivateAliases();
    expect(() => validate(state, "Keep watch over the grain. My father and family remain with the column of warriors; I asked the collector to wait.")).not.toThrow();
    // A local-entity-valued claim must use the same owner namespace rule.
    state.agents.keeper!.belief.claims["private-family"] = { id: "private-family", subjectId: "family",
      predicate: "relation", value: { kind: "local_entity", localEntityId: "family" },
      description: "An unrevealed family association", stance: "believed", confidence: 1, evidenceIds: [] };
    expect(() => validate(state, "My family can keep watch.")).not.toThrow();
    expect(() => validate(state, "ref:local_entity:keeper::family")).toThrow("protected information");
    expect(() => validate(state, "Unrevealed entity family")).toThrow("protected information");
  });

  it("does not authorize a foreign qualified handle when the observer has the same bare alias", () => {
    const state = stateWithPrivateAliases();
    state.agents.player!.belief.localEntities.grain = { id: "grain", name: "My grain", description: "My own supplies", status: "observed" };
    expect(() => validate(state, "My grain is ready.")).not.toThrow();
    expect(() => validate(state, "ref:local_entity:keeper::grain")).toThrow("protected information");
  });

  it("does not change ordinary text admission when only an unrelated hidden scalar changes", () => {
    const state = stateWithPrivateAliases();
    const fact = state.truth.facts["key-authenticity"]!;
    expect(() => validate(state, "households")).not.toThrow();
    fact.value = { kind: "text", value: "hold" };
    expect(() => validate(state, "households")).not.toThrow();
    fact.value = { kind: "text", value: "in-progress" };
    expect(() => validate(state, "进展记录", { apparentClaims: [claim({ kind: "text", value: "in-progress" }, "self", "activity-state")] })).not.toThrow();
    expect(() => validate(state, fact.description)).toThrow("protected information");
  });

  it("distinguishes a private cognition reference from the same ordinary word", () => {
    const state = stateWithPrivateAliases();
    const summary = "fishery-preservation-and-hull-repair-arranged";
    expect(() => validate(state, summary)).not.toThrow();
    const facet = { ...structuredClone(Object.values(state.agents.keeper!.character.values)[0]!), id: "preservation" };
    state.agents.keeper!.character.values.preservation = facet;
    expect(() => validate(state, summary)).not.toThrow();
    expect(() => validate(state, "ref:character_facet:preservation")).toThrow("protected information");
    expect(() => validate(state, facet.description)).toThrow("protected information");
    state.agents.player!.character.values.preservation = structuredClone(facet);
    expect(() => validate(state, "ref:character_facet:preservation")).not.toThrow();
  });

  it("does not globally ban another Agent's belief value or bare claim key", () => {
    const state = stateWithPrivateAliases();
    state.agents.keeper!.belief.claims.preservation = { ...claim({ kind: "text", value: "in-progress" }, "self"),
      id: "preservation", description: "Unrevealed private belief description", stance: "believed", confidence: 1, evidenceIds: [] };
    expect(() => validate(state, "preservation in-progress")).not.toThrow();
    expect(() => validate(state, "ref:claim:preservation")).toThrow("protected information");
    expect(() => validate(state, "Unrevealed private belief description")).toThrow("protected information");
  });

  it.each<[FactValue, BeliefValue]>([
    [{ kind: "text", value: "fake" }, { kind: "text", value: "fake" }],
    [{ kind: "number", value: 42 }, { kind: "number", value: 42 }],
    [{ kind: "boolean", value: true }, { kind: "boolean", value: true }],
    [{ kind: "entity", entityId: "key" }, { kind: "local_entity", localEntityId: "copper-key" }],
    [{ kind: "none" }, { kind: "none" }],
  ])("rejects an explicit unauthorized fact relation for %j", (factValue, beliefValue) => {
    const state = stateWithPrivateAliases();
    state.truth.facts["key-authenticity"]!.value = factValue;
    expect(() => validate(state, "观察记录", { apparentClaims: [claim(beliefValue)] })).toThrow("protected information");
    expect(() => validate(state, "观察记录", { apparentClaims: [claim(beliefValue, "self")] })).not.toThrow();
    expect(() => validate(state, "观察记录", { apparentClaims: [claim(beliefValue, "copper-key", "other-predicate")] })).not.toThrow();
  });

  it.each(["public", "authorized", "known"])("permits a %s proposition without granting unrelated private access", access => {
    const state = stateWithPrivateAliases(), fact = state.truth.facts["key-authenticity"]!;
    if (access === "public") fact.access = { kind: "public" };
    if (access === "authorized") fact.access = { kind: "agents", agentIds: ["player"] };
    if (access === "known") state.agents.player!.belief.claims["key-is-authentic"]!.value = { kind: "text", value: "fake" };
    expect(() => validate(state, fact.description, { apparentClaims: [claim({ kind: "text", value: "fake" })] })).not.toThrow();
    fact.access = { kind: "agents", agentIds: ["keeper"] };
    state.agents.player!.belief.claims["key-is-authentic"]!.value = { kind: "text", value: "real" };
    expect(() => validate(state, "观察记录", { apparentClaims: [claim({ kind: "text", value: "fake" })] })).toThrow("protected information");
  });

  it("checks newly introduced bindings but never guesses an ambiguous subject", () => {
    const state = stateWithPrivateAliases();
    const details = { introductions: [{ localEntity: { id: "new-object", name: "眼前物品", description: "新见到的物品", status: "observed" as const }, canonicalEntityId: "key" }],
      apparentClaims: [claim({ kind: "text", value: "fake" }, "new-object")] };
    expect(() => validate(state, "观察记录", details)).toThrow("protected information");
    state.agents.player!.bindings["copper-key"]!.canonicalEntityIds = ["key", "gate"];
    expect(() => validate(state, "观察记录", { apparentClaims: [claim({ kind: "text", value: "fake" })] })).not.toThrow();
  });

  it("does not authorize a private fact from a known scalar about another subject", () => {
    const state = stateWithPrivateAliases();
    state.agents.player!.belief.claims["unrelated-known"] = { ...claim({ kind: "text", value: "fake" }, "self"),
      id: "unrelated-known", stance: "believed", confidence: 1, evidenceIds: [] };
    expect(() => validate(state, "观察记录", { apparentClaims: [claim({ kind: "text", value: "fake" })] })).toThrow("protected information");
  });

  it("does not learn authorization from another uncommitted observation packet", () => {
    const state = stateWithPrivateAliases();
    const proposal: TransitionProposal = { baseRevision: state.revision, outcomes: [], mechanicInvocations: [], operations: [], events: [], decisionRequests: [],
      observations: ["first", "second"].map(id => ({ id, observerId: "player", step: 1, kind: "outcome",
        summary: "观察记录", introductions: [], apparentClaims: [claim({ kind: "text", value: "fake" })], sourceEventIds: [] })) };
    expect(() => validatePublicInformationBoundary(state, [], proposal)).toThrow("protected information");
  });
});
