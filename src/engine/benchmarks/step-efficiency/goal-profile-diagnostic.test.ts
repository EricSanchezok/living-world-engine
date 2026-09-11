import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import { loadModelCatalog } from "../../models/model-catalog";
import { actionCompilationContext } from "../../algorithms/eager-reference/action-compiler";
import { shortlistEvidenceContext } from "../../algorithms/eager-reference/candidate-retrieval/shortlist-evidence";
import { contentHash } from "../../models/model-audit";
import { bindGoalDiagnostic, goalDiagnosticBody, scoreGoalDiagnostic, type GoalDiagnosticSource } from "./goal-profile-diagnostic";

function fixture(): GoalDiagnosticSource {
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  const { initialState: state } = loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed: 47, modelCatalog: catalog });
  const actions = Object.keys(state.agents).sort().slice(0, 12).map((actorId, i) => ({ id: `action-${String(i).padStart(2, "0")}`, actorId, baseRevision: 0,
    rawText: "Say ready once.", goal: "Say ready", means: null, targetIds: [] }));
  const scope = { workloadId: "goal-diagnostic-test", batchId: "source" };
  const fullContext = actionCompilationContext(state, actions.map((action) => ({ key: action.id, payload: { action }, issues: [] })), scope);
  const candidates = z.array(z.object({ candidateKey: z.string(), kind: z.string(),
    scope: z.object({ kind: z.string(), slot: z.number().optional() }), details: z.record(z.string(), z.unknown()).nullish(),
  })).parse(fullContext.referenceCatalog.candidates);
  const kept = candidates.filter((candidate) => candidate.kind === "temporal_profile" && candidate.details?.kind === "fixed");
  const modelContext = shortlistEvidenceContext(fullContext, kept.map((candidate) => candidate.candidateKey)).context;
  const selectedKeysBySlot: Array<[number, string[]]> = actions.map((_, i) => [i, kept.filter((c) => c.scope.kind === "shared" || c.scope.slot === i).map((c) => c.candidateKey)]);
  const arm = { state, fullContext, selected: { modelContext, selectedKeysBySlot,
    diagnostics: { selectedCount: kept.length, visibleCount: candidates.length } } };
  const proof = { stateHash: contentHash(state), fullContextHash: contentHash(fullContext), modelContextHash: contentHash(modelContext) };
  return { proof: { index: 4, kind: "test-control", actionsHash: contentHash(actions), arms: { B: proof, P: structuredClone(proof) } },
    actions, scope, profileId: "truth-deepseek", arms: { B: arm, P: structuredClone(arm) } };
}

describe("goal diagnostic source authority", () => {
  it("binds real projection and output settings, rejecting changed state and slot scope", () => {
    const source = fixture();
    expect(goalDiagnosticBody(source, "B")).toMatchObject({ model: "deepseek-v4-flash", thinking: { type: "disabled" }, max_tokens: 131072 });
    const changed = structuredClone(source);changed.arms.P.state.truth.elapsedSeconds += 1;
    expect(() => bindGoalDiagnostic(changed, "P")).toThrow(/source binding/);
    changed.proof.arms.P.stateHash = contentHash(changed.arms.P.state);
    expect(() => bindGoalDiagnostic(changed, "P")).toThrow(/state\/context/);
    const scope = structuredClone(source);scope.arms.P.selected.selectedKeysBySlot[0]![1].push("candidate_ffffffffffff");
    expect(() => bindGoalDiagnostic(scope, "P")).toThrow(/reference scope/);
  });

  it("rejects altered model evidence even if its stored model hash was rewritten", () => {
    const source = fixture();source.arms.P.selected.modelContext.currentElapsedSeconds = 100;
    source.proof.arms.P.modelContextHash = contentHash(source.arms.P.selected.modelContext);
    expect(() => bindGoalDiagnostic(source, "P")).toThrow(/model evidence/);
  });

  it("keeps empty output a complete-batch failure with zero replay HTTP", async () => {
    expect(await scoreGoalDiagnostic('{"slots":[]}', fixture(), "B", loadModelCatalog(path.resolve("config/models.yaml")))).toMatchObject({
      rawJson: true, recoveredJson: true, formalPassed: false, plans: [], replayHttp: 0, fullSemantics: "unassessed",
    });
  });
});
