import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { compileActions } from "../../algorithms/eager-reference/action-compiler";
import { contentHash } from "../../models/model-audit";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../testing/model-provider";
import { auditSemanticObservability, combineSemanticFindings } from "./semantic-observability-audit";

describe("semantic observability boundary", () => {
  it("never promotes empty, missing or conflicting evidence to success", () => {
    const finding = (verdict: "pass" | "fail" | "unresolved") => ({ ruleId: "fixture", verdict, evidencePaths: ["fixture"], explanation: "fixture" });
    expect(combineSemanticFindings([])).toBe("unresolved");
    expect(combineSemanticFindings([finding("pass"), finding("unresolved")])).toBe("unresolved");
    expect(combineSemanticFindings([finding("unresolved"), finding("fail")])).toBe("fail");
    expect(combineSemanticFindings([finding("pass")])).toBe("pass");
  });

  it("real compilation retains contradictory derived descriptions despite preserving the original action", async () => {
    const descriptions = [
      "Interview the newcomer before deciding whether to offer a trial and subsequent recommendation.",
      "The newcomer has already passed the trial and received the recommendation.",
      "Award the recommendation immediately without an interview or trial.",
    ];
    const outputs = [];
    for (const description of descriptions) {
      const provider = new ScriptedModelProvider(({ profileId, context }) =>
        deterministicActionCompilationBatch(profileId, context, (draft) => { draft.temporalPlan.description = description; }));
      const { initialState: state } = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
      const action = { id: "semantic-observability-action", actorId: "player", baseRevision: state.revision,
        rawText: descriptions[0]!, goal: "Assess the newcomer", means: null, targetIds: [] };
      const before = contentHash(state);
      const result = await compileActions(provider, state, [action], {
        workloadId: "semantic-observability", batchId: "same-input", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
      }, "truth-engine", 12);
      expect(provider.requests).toHaveLength(1);
      expect(result.compilations).toHaveLength(1);
      const compilation = result.compilations[0]!;
      expect(compilation.activity.sourceAction).toEqual(action);
      expect(compilation.plan.description).toBe(description);
      expect(compilation.activity.plan.description).toBe(description);
      expect(contentHash(state)).toBe(before);
      const oracle: Parameters<typeof auditSemanticObservability>[0] = {
        version: 1, preparedBeforeTreatmentOutputs: true, reviewMode: "fixture", scope: "fixture",
        globalMust: ["Retain intent"], globalMay: ["Equivalent wording"],
        globalForbidden: ["A medical treatment profile for these nonmedical actions, or a waiting profile for a current communication/administrative action merely because its text includes a future condition."],
        actions: [{ actor: action.actorId, source: "P01", slot: 0, actionId: action.id, actionHash: contentHash(action),
          stateHash: before, rawText: action.rawText, must: ["Interview first"], may: ["Different wording"], forbidden: ["Invent completed trial"] }],
      };
      const identity = { oracleHash: contentHash(oracle), stateHash: before, actionId: action.id, canonicalCompilationHash: contentHash(compilation) };
      const entry = { ...identity, reviewId: contentHash(identity), action, compilation };
      const audit = auditSemanticObservability(oracle, [entry]);
      expect(audit.counts).toEqual({ pass: 0, fail: 0, unresolved: 1 });
      expect(audit.allMandatoryObligationsCovered).toBe(false);
      expect(() => auditSemanticObservability(oracle, [entry, entry])).toThrow("duplicate");
      expect(() => auditSemanticObservability(oracle, [{ ...entry, stateHash: "wrong-state" }])).toThrow("identity");
      expect(() => auditSemanticObservability(oracle, [{ ...entry, compilation: {
        ...compilation, plan: { ...compilation.plan, description: "tampered" },
      } }])).toThrow("identity");
      const structural = structuredClone(compilation);
      structural.plan.description = "<excluded opaque description>";
      structural.activity.plan.description = "<excluded opaque description>";
      outputs.push(structural);
    }
    // Hash retention and identical temporal/dependency structure cannot distinguish
    // these meanings. The test does not claim a mocked Truth continuation proves intent.
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(outputs[0]);
  });
});
