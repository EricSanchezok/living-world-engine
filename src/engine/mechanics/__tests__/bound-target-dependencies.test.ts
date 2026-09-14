import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import type { AgentActionProposal } from "../../contracts/model";
import { referenceHandleFor } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { deterministicActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { interactionDependencyComponents, materializeInteractionDependency } from "../action-dependency";

const fixture = () => loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47,
  modelCatalog: new ScriptedModelProvider(() => { throw new Error("no model expected"); }).catalog }).initialState;
const action = (targetIds: string[]): AgentActionProposal => ({ id: "inspect-key", actorId: "player", baseRevision: 0,
  rawText: "Inspect the referenced object.", goal: "Learn about its appearance", means: null, targetIds });
const draft = { reads: [], writes: [], audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false };

it("preserves every existing binding of original local targets as reads, without choosing an identity or granting writes", () => {
  const state = fixture(), agent = state.agents.player!;
  agent.belief.localEntities.ambiguous = { ...agent.belief.localEntities["copper-key"]!, id: "ambiguous" };
  agent.bindings.ambiguous = { localEntityId: "ambiguous", canonicalEntityIds: ["key", "gate"] };
  agent.belief.localEntities.unresolved = { ...agent.belief.localEntities["copper-key"]!, id: "unresolved" };
  agent.bindings.unresolved = { localEntityId: "unresolved", canonicalEntityIds: [] };
  state.agents.keeper!.bindings["foreign-only"] = { localEntityId: "foreign-only", canonicalEntityIds: ["keeper"] };
  const before = contentHash(state), proposal = action(["copper-key", "ambiguous", "unresolved", "missing", "foreign-only", "copper-key"]);
  const dependency = materializeInteractionDependency(state, proposal, draft);
  expect(dependency.reads.filter(ref => ref.kind === "entity").map(ref => ref.id)).toEqual(["gate", "key", "player"]);
  expect(dependency.writes).toEqual([{ kind: "entity", id: "player" }]);
  expect(dependency.globalFallback).toBe(false); expect(contentHash(state)).toBe(before);
  const other = { ...dependency, id: "move-gate", actorId: "keeper", reads: [], writes: [{ kind: "entity" as const, id: "gate" }] };
  expect(interactionDependencyComponents([dependency, other])).toEqual([["inspect-key", "move-gate"]]);
});

it("rejects a dangling canonical binding rather than silently dropping part of its possible identity", () => {
  const state = fixture(); state.agents.player!.bindings["copper-key"]!.canonicalEntityIds.push("missing-entity");
  expect(() => materializeInteractionDependency(state, action(["copper-key"]), draft)).toThrow(/bound target.*missing-entity/);
});

it.each([false, true])("uses an original bound target without repair while retaining rejection of unrelated means: %s", async unrelated => {
  let attempts = 0;
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, compilation => {
      compilation.interactionDependency.stateDependencies.requiredExistingRefs = [referenceHandleFor("entity", "player")];
      compilation.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs = [referenceHandleFor("entity", "player")];
    });
    if (role !== "truth-resolution") return deterministicModelOutput(profileId, context);
    const input = context as { state: { committedResolutionPlans: unknown[]; actionSet: { assigned: Array<{ actionRef: string }> } };
      repair?: { issues: Array<{ code: string; allowedHandles: string[] }> } };
    if (input.state.committedResolutionPlans.length) return { kind: "done" };
    attempts++; const actionRef = input.state.actionSet.assigned[0]!.actionRef;
    if (attempts > 1) {
      expect(input.repair!.issues[0]!.code).toBe("reference.outside_action_grounding");
      expect(input.repair!.issues[0]!.allowedHandles).toContain("ref:entity:key");
      expect(input.repair!.issues[0]!.allowedHandles).not.toContain("ref:entity:keeper");
    }
    return { kind: "commit_plans", plans: [{ proposalKey: "inspect", actionRef, targetRefs: ["ref:entity:key"],
      means: [{ description: "Inspect the referenced key", source: { kind: "entity", ref: unrelated && attempts === 1 ? "ref:entity:keeper" : "ref:entity:key" } }],
      mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", baseEffect: "none",
      primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] }] };
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider)); await engine.bootstrapAgents();
  const source = engine.snapshot, rawText = "看看那把铜钥匙的外形。";
  const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "fixture" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, { expectedRevision: source.revision, trigger: "participant_action",
    externalActions: [{ submissionId: "bound-key", agentId: "player", rawText, goal: rawText, means: null, targetIds: ["copper-key"] }] });
  expect(attempts).toBe(unrelated ? 2 : 1);
  expect(result.committed.actions[0]!.targetIds).toEqual(["copper-key"]);
  expect(result.committed.resolutionPlans[0]!.means[0]!.source).toEqual({ kind: "entity", id: "key" });
  expect(result.state.truth.meters).toEqual(source.truth.meters);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
