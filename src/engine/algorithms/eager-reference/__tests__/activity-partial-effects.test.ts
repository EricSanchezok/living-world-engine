import path from "node:path";
import { expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate } from "../../../../script/world-loader";
import { referenceHandleFor } from "../../../contracts/model-context";
import { contentHash } from "../../../models/model-audit";
import { SimulationEngine } from "../../../runtime/simulation";
import { replaySimulationState } from "../../../runtime/transaction";
import { deterministicActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../eager-reference";

it.each(["progress", "early-completion", "false-witness", "rejected-event"] as const)(
  "preserves scheduled completion and causal review for partial activity effects: %s", async (mode) => {
    let reviewedProgress = 0;
    const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
      if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (draft, { action }) => {
        draft.temporalPlan = {
          profileRef: referenceHandleFor("temporal_profile", "brief-action"), basis: { kind: "profile" },
          description: action.rawText, continuationAssertions: [],
          causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
        };
      });
      if (schemaName === "causal_verification") {
        const candidate = (context as { state: { candidate: { events: Array<{ eventRef: string; description: string }> } } }).state.candidate;
        const event = candidate.events.find(entry => entry.description === "At the gate, still watching; the ten-second task is unfinished.");
        if (event) reviewedProgress++;
        if (event && mode === "rejected-event") return {
          verdict: "reject", findings: [{ target: { kind: "event", targetHandle: event.eventRef }, evidenceHandles: [],
            code: "effect-mismatch", message: "Controlled semantic review rejects this proposed occurrence.",
            repairHint: "Keep the complete task and return only supported interval effects." }],
        };
        return { verdict: "accept", findings: [] };
      }
      if (role === "causal-verifier") return { verdict: "accept", findings: [] };
      const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
      if (role === "truth-transition" && generated.kind === "transition") {
        const proposal = generated.proposal as {
          outcomes: Array<{ actionRef: string; status: string }>;
          operations: unknown[]; events: unknown[];
        };
        const actionRef = proposal.outcomes[0]!.actionRef;
        proposal.outcomes[0]!.status = mode === "early-completion" ? "succeeded" : "continuing";
        proposal.operations = [{ kind: "place_entity", entityId: "player", placementId: "gate",
          causes: [{ kind: "action", ref: actionRef }],
          assertions: [{ kind: "placement_equals", entityId: "player", placementId: "courtyard" }],
        }];
        proposal.events = [{ proposalKey: "partial-arrival",
          description: "At the gate, still watching; the ten-second task is unfinished.", impact: "ordinary",
          causes: [{ kind: "action", ref: actionRef }], assertions: [
            { kind: "placement_equals", entityId: "player", placementId: "gate" },
            { kind: "elapsed_seconds_compare", operator: "eq", value: mode === "false-witness" ? 10 : 1 },
          ],
        }];
      }
      return generated;
    }, undefined, false);
    const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
    const profile = template.mechanics.temporal_profiles.find(entry => entry.id === "brief-action");
    if (!profile || profile.kind !== "fixed") throw new Error("fixture fixed profile missing");
    profile.duration_seconds = 10;
    profile.checkpoint_seconds = 1;
    template.laws.laws.push({ id: "partial-watch-timing", severity: "hard", text:
      "In this controlled task the player reaches the gate after one second, then watches until ten seconds have elapsed. Arrival is only partial progress; the complete task ends at ten seconds." });
    const definition = buildWorldDefinition(template, { seed: 47, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const execute = () => engine.step({
      player: { kind: "external", agentId: "player", participantId: "test-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, { expectedRevision: source.revision, trigger: "participant_action", externalActions: [{
      submissionId: "partial-watch", agentId: "player", rawText: "Go to the gate, then watch there until ten seconds have elapsed.",
      goal: "Complete the journey and watch", means: null, targetIds: [],
    }] });
    if (mode !== "progress") {
      await expect(execute()).rejects.toThrow(mode === "early-completion" ? /must remain continuing/u
        : mode === "false-witness" ? /causal assertions failed/u : /final candidate component repairs batch failed/u);
      expect(contentHash(engine.snapshot)).toBe(contentHash(source));
      if (mode === "rejected-event") expect(reviewedProgress).toBeGreaterThan(0);
      return;
    }
    const result = await execute();
    expect(result.state.revision).toBe(source.revision + 1);
    expect(result.state.truth.elapsedSeconds).toBe(1);
    expect(result.state.truth.placements.player).toBe("gate");
    expect(Object.values(result.state.truth.activities)).toContainEqual(expect.objectContaining({
      status: "active", completionAtSeconds: 10, nextBoundaryAtSeconds: 2,
    }));
    expect(result.committed.outcomes).toEqual([expect.objectContaining({ status: "continuing" })]);
    expect(result.committed.resolutionReceipts).toEqual([expect.objectContaining({ settled: false, operations: [] })]);
    expect(result.committed.mechanicInvocations.some(invocation => invocation.packageId === "core-resolution" && invocation.ruleId === "apply-receipt")).toBe(false);
    expect(result.committed.events).toContainEqual(expect.objectContaining({ description: "At the gate, still watching; the ten-second task is unfinished." }));
    expect(reviewedProgress).toBeGreaterThan(0);
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  },
);
