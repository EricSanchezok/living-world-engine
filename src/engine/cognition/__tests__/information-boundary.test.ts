import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import type { SimulationState, TransitionProposal } from "../../contracts/model";
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

function validate(state: SimulationState, summary: string) {
  const proposal: TransitionProposal = {
    baseRevision: state.revision, outcomes: [], mechanicInvocations: [], operations: [], events: [], decisionRequests: [],
    observations: [{ id: "observation-player", observerId: "player", step: state.step + 1, kind: "outcome",
      summary, introductions: [], apparentClaims: [], sourceEventIds: [] }],
  };
  validatePublicInformationBoundary(state, [], proposal);
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

  it("retains substring protection for private text values, even when they also name an alias", () => {
    const state = stateWithPrivateAliases();
    const fact = Object.values(state.truth.facts).find(entry => entry.access.kind !== "public")!;
    fact.value = { kind: "text", value: "hold" };
    expect(() => validate(state, "households")).toThrow("protected information");
    fact.value = { kind: "text", value: "绝密指令" };
    expect(() => validate(state, "此前绝密指令已经公开")).toThrow("protected information");
  });
});
