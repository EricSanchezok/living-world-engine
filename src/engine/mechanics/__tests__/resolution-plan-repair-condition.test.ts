import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { contentHash } from "../../models/model-audit";
import { deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";

type PriorPlan = { planRef: string; actionRef: string; actorRef: string;
  primaryEffect: { conditionRef: string; targetRef: string; channel: string } | null };
type RepairMode = "own" | "foreign" | "retarget" | "channel" | "means" | "source";

it.each<RepairMode>(["own", "foreign", "retarget", "channel", "means", "source"])(
  "keeps pending condition ownership through real targeted plan repair: %s", async mode => {
    let requestedRepair = false, pendingConditionRef = "";
    const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
      if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
      if (schemaName === "resolution_plan_verification" && !requestedRepair) {
        const plans = (context as { state: { candidateResolutionPlans: PriorPlan[] } }).state.candidateResolutionPlans;
        const player = plans.find(plan => plan.actorRef === "ref:entity:player")!;
        expect(player.primaryEffect).not.toBeNull();
        pendingConditionRef = player.primaryEffect!.conditionRef;
        requestedRepair = true;
        return { verdict: "reject", findings: [{ planRef: player.planRef, code: "impact-overstated",
          message: "Clarify the player's own readiness declaration.", repairHint: "Keep the same subject and readiness channel." }] };
      }
      if (role === "causal-verifier") return { verdict: "accept", findings: [] };
      const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
      if (role !== "truth-resolution" || generated.kind !== "commit_plans") return generated;
      const plans = generated.plans as Array<Record<string, unknown> & { actionRef: string; targetRefs: string[] }>;
      const previous = (context as { state: { candidateResolutionPlans?: PriorPlan[] } }).state.candidateResolutionPlans;
      for (const plan of plans) {
        const target = plan.targetRefs[0]!;
        const own = previous?.find(prior => prior.actionRef === plan.actionRef);
        const foreign = previous?.find(prior => prior.actionRef !== plan.actionRef);
        const proposalKey = target.endsWith(":player") ? "ready-player" : "ready-keeper";
        plan.baseEffect = "minor";
        plan.means = [{ description: "This actor declares readiness", source: { kind: "action", ref: plan.actionRef } }];
        const effect: Record<string, unknown> = {
          kind: "condition", proposalKey, conditionRef: own?.primaryEffect?.conditionRef ?? { proposalKey },
          targetRef: target, channel: "readiness", label: proposalKey, description: "This actor has declared readiness.",
          sourceRefs: [{ kind: "action", id: plan.actionRef }], conditionProfileRef: null,
          durationProfileRef: "ref:mechanic:brief", magnitude: "minor", access: { kind: "public" },
        };
        if (own) {
          expect(own.primaryEffect!.conditionRef).toBe(pendingConditionRef);
          expect((context as { state: { canonicalTruth: { conditions: Record<string, unknown> } } }).state.canonicalTruth.conditions)
            .not.toHaveProperty(pendingConditionRef);
          if (mode === "foreign") effect.conditionRef = foreign!.primaryEffect!.conditionRef;
          if (mode === "retarget") { effect.targetRef = "ref:entity:keeper"; plan.targetRefs = ["ref:entity:keeper"]; }
          if (mode === "channel") effect.channel = "obedience";
          if (mode === "means") plan.means = [{ description: "Treat a planned condition as established readiness",
            source: { kind: "condition", ref: pendingConditionRef } }];
          if (mode === "source") effect.sourceRefs = [{ kind: "condition", id: pendingConditionRef }];
        }
        plan.primaryEffect = effect;
      }
      return generated;
    }, undefined, false);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot, before = contentHash(source);
    const run = engine.step({
      player: { kind: "external", agentId: "player", participantId: "test-player" },
      keeper: { kind: "external", agentId: "keeper", participantId: "test-keeper" },
    }, { expectedRevision: source.revision, trigger: "participant_action", externalActions: ["player", "keeper"].map(agentId => ({
      submissionId: `ready-${agentId}`, agentId, rawText: "Declare that I am ready.", goal: "Declare readiness", means: null, targetIds: [],
    })) });
    if (mode === "own") {
      const result = await run;
      const conditionId = pendingConditionRef.slice("ref:condition:".length);
      expect(result.state.truth.conditions[conditionId]).toMatchObject({ subjectId: "player", label: "ready-player" });
      expect(Object.values(result.state.truth.conditions).filter(condition => condition.label.startsWith("ready-"))).toHaveLength(2);
      expect(result.committed.resolutionPlans.find(plan => plan.actorId === "player")!.primaryEffect)
        .toMatchObject({ conditionId, targetId: "player", channel: "readiness" });
      expect(result.state.revision).toBe(source.revision + 1);
      expect(replaySimulationState(result.state)).toEqual(result.state);
      expect(provider.requests.filter(request => request.schemaName === "truth_resolution_plan_repair")).toHaveLength(1);
    } else {
      await expect(run).rejects.toThrow();
      expect(contentHash(engine.snapshot)).toBe(before);
      expect(provider.requests.some(request => request.schemaName === "truth_resolution_plan_repair")).toBe(true);
    }
    expect(requestedRepair).toBe(true);
    expect(contentHash(source)).toBe(before);
  });
