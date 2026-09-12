import path from "node:path";
import { expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate } from "../../../../script/world-loader";
import type { CommittedStep } from "../../../contracts/model";
import { contentHash } from "../../../models/model-audit";
import { semanticStepHash } from "../../../runtime/canonical-committer";
import { SimulationEngine } from "../../../runtime/simulation";
import { replaySimulationState } from "../../../runtime/transaction";
import { deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../eager-reference";

it.each(["success", "miss", "early-completion", "future-effect"] as const)(
  "settles interval receipts independently of whole-task lifetime: %s", async mode => {
    let rejectedFuturePlans = 0;
    const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
      if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
      if (schemaName === "resolution_plan_verification" && mode === "future-effect") {
        const input = context as { state: { temporalBoundary: { toElapsedSeconds: number }; candidateResolutionPlans: Array<{ planRef: string; primaryEffect: { description: string } }> } };
        expect(input.state.temporalBoundary.toElapsedSeconds).toBe(1);
        const plan = input.state.candidateResolutionPlans[0]!;
        expect(plan.primaryEffect.description).toBe("Completing the three-second task consumes health.");
        rejectedFuturePlans++;
        return { verdict: "reject", findings: [{ planRef: plan.planRef, code: "premature-completion-effect",
          message: "The controlled law permits this completion effect only after the third second.",
          repairHint: "Retain the full task and supply only current-interval stakes." }] };
      }
      if (role === "causal-verifier") return { verdict: "accept", findings: [] };
      const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
      if (role === "truth-resolution" && generated.kind === "commit_plans") {
        generated.plans = (generated.plans as Array<Record<string, unknown>>).map(plan => ({ ...plan,
          mode: "check", baseEffect: "minor", risk: "safe",
          means: [{ description: "Exertion in this interval", source: { kind: "entity", id: "player" } }],
          difficulty: { kind: "environment", band: mode === "miss" ? "extreme" : "trivial", source: { kind: "entity", id: "player" } },
          primaryEffect: { kind: "meter", id: "interval-exertion", targetId: "player", channel: "physical-harm",
            label: "exertion", description: mode === "future-effect" ? "Completing the three-second task consumes health." : "Current-interval exertion consumes health.",
            sourceRefs: [{ kind: "entity", id: "player" }], meterId: "health:player", impactProfileId: "harm", magnitude: "minor" },
          threatenedEffect: { kind: "meter", id: "interval-strain", targetId: "player", channel: "physical-harm",
            label: "strain", description: "Failure causes strain in this interval.",
            sourceRefs: [{ kind: "entity", id: "player" }], meterId: "health:player", impactProfileId: "harm", magnitude: "minor" },
        }));
      }
      if (role === "truth-transition" && generated.kind === "transition") {
        const input = context as { state: { temporalBoundary: { toElapsedSeconds: number }; resolutionReceipts: Array<{ outcome: string | null }> } };
        const proposal = generated.proposal as { outcomes: Array<{ status: string }>; events: unknown[] };
        const grade = input.state.resolutionReceipts[0]!.outcome;
        proposal.outcomes[0]!.status = input.state.temporalBoundary.toElapsedSeconds < 3 && mode !== "early-completion"
          ? "continuing" : grade === "full" || grade === "exceptional" ? "succeeded" : grade === "mixed" ? "partial" : "failed";
        proposal.events = [];
      }
      return generated;
    }, undefined, false);
    const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
    const profile = template.mechanics.temporal_profiles.find(item => item.id === "brief-action");
    if (!profile || profile.kind !== "fixed") throw new Error("missing fixture profile");
    profile.duration_seconds = 3;
    profile.checkpoint_seconds = 1;
    template.laws.laws.push({ id: "interval-exercise", severity: "hard", text:
      "Exercise lasts three seconds. Each one-second interval requires its own check and immediate physical-harm effect. The complete task cannot finish before the third second." });
    const definition = buildWorldDefinition(template, { seed: 47, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const allCheckIds = new Set<string>();
    const source = engine.snapshot;
    for (let index = 0; index < 3; index++) {
      const before = engine.snapshot;
      const execute = () => engine.step({
        player: { kind: "external", agentId: "player", participantId: "interval-player" },
        keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
      }, { expectedRevision: before.revision, trigger: index === 0 ? "participant_action" : "manual",
        externalActions: index === 0 ? [{ submissionId: "interval-exercise", agentId: "player",
          rawText: "Exercise for three seconds, resolving exertion or strain each second.", goal: "Exercise for three seconds", means: null, targetIds: [] }] : [],
      });
      if (mode === "early-completion" || mode === "future-effect") {
        await expect(execute()).rejects.toThrow();
        expect(contentHash(engine.snapshot)).toBe(contentHash(source));
        if (mode === "future-effect") {
          expect(rejectedFuturePlans).toBeGreaterThan(0);
          expect(provider.requests.some(request => request.schemaName === "truth_resolution_continuation")).toBe(false);
        }
        return;
      }
      const result = await execute();
      expect(result.state.truth.elapsedSeconds).toBe(index + 1);
      const [receipt] = result.committed.resolutionReceipts;
      expect(receipt.settled).toBe(true);
      expect(result.committed.checks).toHaveLength(1);
      expect(result.committed.checks[0].succeeded).toBe(mode === "success");
      expect(allCheckIds.has(result.committed.checks[0].requestId)).toBe(false);
      allCheckIds.add(result.committed.checks[0].requestId);
      const effect = receipt.operations.find(operation => operation.kind === "adjust_meter");
      expect(effect?.kind).toBe("adjust_meter");
      if (effect?.kind !== "adjust_meter") throw new Error("missing interval harm");
      expect(effect.amount).toBeLessThan(0);
      expect(result.state.truth.meters["health:player"].current).toBe(before.truth.meters["health:player"].current + effect.amount);
      expect(result.state.truth.rng.draws).toBe(before.truth.rng.draws + 1);
      expect(result.committed.outcomes[0].status).toBe(index < 2 ? "continuing" : mode === "success" ? "succeeded" : "failed");
      expect(Object.values(result.state.truth.activities)[0].status).toBe(index < 2 ? "active" : "completed");
      expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
      if (index === 0) for (const mutation of ["defer", "check", "duplicate"] as const) {
        const tampered = structuredClone(result.state);
        const step = tampered.history.at(-1)!;
        if (mutation === "defer") step.resolutionReceipts[0].settled = false;
        if (mutation === "check") step.checks[0].total++;
        if (mutation === "duplicate") step.mechanicInvocations.push(structuredClone(step.mechanicInvocations[0]));
        step.semanticHash = semanticStepHash(step);
        const payload: Partial<CommittedStep> = structuredClone(step);
        delete payload.contentHash;
        step.contentHash = contentHash(payload);
        expect(() => replaySimulationState(tampered)).toThrow(mutation === "defer" ? /temporal settlement/u
          : mutation === "check" ? /receipt .* is not deterministic/u : /invocation/u);
      }
    }
    expect(allCheckIds.size).toBe(3);
  },
);
