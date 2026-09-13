import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { referenceHandleFor } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import type { WorldStepCandidate, WorldExecutionAlgorithm } from "../../../runtime/execution";
import { historyReplayBaseHash } from "../../../runtime/history-replay";
import { SimulationEngine } from "../../../runtime/simulation";
import { replaySimulationState } from "../../../runtime/transaction";
import { deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, ScriptedModelProvider } from "../../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../eager-reference";

it.each([{ reader: false, repair: false }, { reader: true, repair: false }, { reader: false, repair: true }])(
  "commits a fresh condition with subject-reader and final-repair validation: %j", async ({ reader, repair }) => {
  let finalReviews = 0;
  const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context,
      (draft, { action }) => {
        draft.interactionDependency = deterministicInteractionDependency({
          reads: reader && action.actorId === "keeper" ? [{ kind: "condition", id: "existing-player-condition" }] : [],
          writes: [{ kind: "entity", id: action.actorId }], audienceAgentIds: [action.actorId], sharedResourceClaims: [],
        });
      });
    if (schemaName === "causal_verification") {
      finalReviews++;
      if (repair && finalReviews === 1) {
        const outcome = (context as { state: { candidate: { outcomes: Array<{ outcomeRef: string }> } } }).state.candidate.outcomes[0]!;
        return { verdict: "reject", findings: [{ target: { kind: "outcome", targetHandle: outcome.outcomeRef }, evidenceHandles: [],
          code: "effect-mismatch", message: "Controlled final review requires an outcome repair.", repairHint: "Retain the committed readiness effect." }] };
      }
    }
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
    if (role === "truth-resolution" && generated.kind === "commit_plans") {
      const plans = generated.plans as Array<Record<string, unknown> & { actionRef: string; targetRefs: string[] }>;
      for (const plan of plans) {
        if (!plan.targetRefs.includes(referenceHandleFor("entity", "player"))) continue;
        plan.baseEffect = "minor";
        plan.means = [{ description: "The player's own declaration of readiness", source: { kind: "action", ref: plan.actionRef } }];
        plan.primaryEffect = {
          kind: "condition", proposalKey: "readiness", conditionRef: { proposalKey: "readiness" },
          targetRef: referenceHandleFor("entity", "player"), channel: "readiness", label: "Ready",
          description: "The player has declared readiness.", sourceRefs: [{ kind: "action", id: plan.actionRef }],
          conditionProfileRef: null, durationProfileRef: referenceHandleFor("mechanic", "brief"),
          magnitude: "minor", access: { kind: "public" },
        };
      }
    }
    return generated;
  }, undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  definition.initialState.truth.conditions["existing-player-condition"] = {
    id: "existing-player-condition", subjectId: "player", label: "Standing", description: "The player is standing.",
    magnitude: "minor", durationProfileId: "brief", conditionProfileId: null, stackingKey: null,
    remainingUses: 1, expiresAtElapsedSeconds: null, access: { kind: "public" }, provenance: [{ kind: "law", id: "time-passes" }],
  };
  definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
  const delegate = new EagerReferenceAlgorithm(provider);
  let candidate: WorldStepCandidate | undefined;
  const algorithm: WorldExecutionAlgorithm = {
    manifest: delegate.manifest,
    bootstrap: (input, context) => delegate.bootstrap(input, context),
    prepareStep: (input, context) => delegate.prepareStep(input, context),
    completeStep: async (input, preparation, reactions, context) => {
      candidate = await delegate.completeStep(input, preparation, reactions, context);
      return candidate;
    },
  };
  const engine = new SimulationEngine(definition, algorithm);
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step({
    player: { kind: "external", agentId: "player", participantId: "test-player" },
    keeper: { kind: "external", agentId: "keeper", participantId: "test-keeper" },
  }, { expectedRevision: source.revision, trigger: "participant_action", externalActions: [
    { submissionId: "ready", agentId: "player", rawText: "Declare that I am ready.", goal: "Declare readiness", means: null, targetIds: [] },
    { submissionId: "observe", agentId: "keeper", rawText: reader ? "Observe the player's standing condition." : "Remain here.",
      goal: "Observe", means: null, targetIds: [] },
  ] });
  expect(candidate!.diagnostics.globalReadjudication).toBe(reader);
  expect(candidate!.diagnostics.dependencyComponents).toHaveLength(reader ? 1 : 2);
  expect(result.state.revision).toBe(source.revision + 1);
  expect(Object.values(result.state.truth.conditions).filter(condition => condition.label === "Ready")).toEqual([
    expect.objectContaining({ subjectId: "player", description: "The player has declared readiness." }),
  ]);
  expect(result.committed.checks).toHaveLength(0);
  expect(result.state.truth.rng).toEqual(source.truth.rng);
  expect(result.state.truth.conditions["existing-player-condition"]).toEqual(source.truth.conditions["existing-player-condition"]);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  expect(provider.requests.some(request => request.subjectId === "component-global")).toBe(reader);
  expect(finalReviews).toBe(repair ? 2 : 1);
});
