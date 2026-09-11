import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { semanticStepHash } from "../../runtime/canonical-committer";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { projectAgentPerspective } from "../../cognition/agent-perspective";
import type { AgentActionProposal, TransitionProposalDraft } from "../../contracts/model";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { dependentFieldsProvider, encodeResolutionDependentFields } from "../resolution-dependent-fields-codec";
import {
  createTestModelCatalog,
  deterministicModelOutput,
  deterministicGlobalActionCompilationBatch,
  ScriptedModelProvider,
  adaptScriptedResolutionOutput,
} from "../../testing/model-provider";

function statusFor(outcome: string | null) {
  if (outcome === "exceptional" || outcome === "full") return "succeeded";
  if (outcome === "mixed") return "partial";
  if (outcome === "miss") return "failed";
  return "blocked";
}

describe("resolution pipeline", () => {
  it.each([false, true])("commits a semantic plan before RNG, derives effects, atomically commits, and replays the receipt (dependent wire: %s)", async (dependentWire) => {
    const catalog = createTestModelCatalog();
    let planVerificationAttempts = 0;
    let transitionAttempts = 0;
    let mechanicRepairAttempts = 0;
    let causalVerificationAttempts = 0;
    const provider = new ScriptedModelProvider(({ role, profileId, context, schemaName }) => {
      if (role === "action-grounding") {
        const action = (context as { action: AgentActionProposal }).action;
        return {
          reads: [{ kind: "global", id: "world" }],
          writes: [{ kind: "global", id: "world" }],
          audienceAgentIds: [action.actorId],
          sharedResourceClaims: [],
          globalFallback: true,
        };
      }
      if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
      if (role === "truth-perception") return { kind: "done" };
      if (role === "truth-reaction-routing") return { requests: [] };
      if (role === "truth-resolution") {
        const input = context as {
          state: { actionSet: { assigned: Array<{ actionRef: string; actorRef: string; rawText: string; goal: string; means: string | null; targetRefs: string[] }> } };
          actors: Array<{ agentRef: string; entityRef: string }>;
          committedResolutionPlans: unknown[];
          repair?: { issues?: Array<{ code: string }> } | null;
          resolutionReceipts: Array<{ plan: { actionRef: string }; outcome: string | null; checkRef: string | null }>;
          checkResults: Array<{ checkRef: string; succeeded: boolean }>;
        };
        if (input.committedResolutionPlans.length > 0) return { kind: "done" };
        const repaired = input.repair?.issues?.some((issue) => issue.code === "impact-overstated") ?? false;
        const actorEntities = new Map(input.actors.map((actor) => [actor.agentRef, actor.entityRef]));
        const actions = input.state.actionSet.assigned.map((action) => ({
          id: action.actionRef.replace(/^ref:action:/u, ""),
          actorId: action.actorRef.replace(/^ref:agent:/u, ""),
          rawText: action.rawText,
          goal: action.goal,
          means: action.means,
          targetIds: action.targetRefs,
        }));
        const directive = {
          kind: "commit_plans",
          plans: actions.map((action, index) => action.actorId === "player" ? {
            id: `plan-${index}`,
            actionId: action.id,
            actorId: actorEntities.get(`ref:agent:${action.actorId}`) ?? "player",
            targetIds: ["keeper", "player"],
            goal: action.goal,
            means: [
              { description: "the carried copper key as an improvised edge", source: { kind: "entity", id: "key" } },
              { description: "loose sand from the courtyard ground", source: { kind: "fact", id: "courtyard-sandy-ground" } },
            ],
            mode: "check",
            difficulty: {
              kind: "opposed",
              targetId: "keeper",
              ratingId: "resolve:keeper",
              source: { kind: "rating", id: "resolve:keeper" },
            },
            actorRatingId: "resolve:player",
            factors: [{
              source: { kind: "fact", id: "courtyard-sandy-ground" },
              role: "secondary",
              direction: "neutral",
              steps: 0,
              authority: "semantic",
              channel: null,
              explanation: "The grounded sand can obscure vision after the strike.",
            }],
            risk: "risky",
            baseEffect: repaired ? "standard" : "major",
            primaryEffect: {
              kind: "meter",
              id: "improvised-harm",
              targetId: "keeper",
              channel: "physical-harm",
              label: "harm",
              description: "The improvised edge wounds the keeper.",
              sourceRefs: [{ kind: "entity", id: "key" }],
              meterId: "health:keeper",
              impactProfileId: "harm",
              magnitude: repaired ? "standard" : "major",
            },
            secondaryEffect: {
              kind: "condition",
              id: "sand-obscures-vision",
              targetId: "keeper",
              channel: "vision",
              label: "sand in eyes",
              description: "Loose sand obscures the keeper's vision.",
              sourceRefs: [{ kind: "fact", id: "courtyard-sandy-ground" }],
              conditionId: "keeper-sand-in-eyes",
              conditionProfileId: "obscured-vision",
              durationProfileId: "brief",
              access: { kind: "public" },
              magnitude: "minor",
            },
            threatenedEffect: {
              kind: "condition",
              id: "counter-opening",
              targetId: "player",
              channel: "position",
              label: "off balance",
              description: "The attempt may leave the traveler off balance.",
              sourceRefs: [{ kind: "action", id: action.id }],
              conditionId: "player-off-balance",
              conditionProfileId: null,
              durationProfileId: "brief",
              access: { kind: "public" },
            },
            visibility: "full",
            causes: [
              { kind: "action", id: action.id },
              { kind: "fact", id: "courtyard-sandy-ground" },
            ],
          } : {
            id: `plan-${index}`,
            actionId: action.id,
            actorId: actorEntities.get(`ref:agent:${action.actorId}`) ?? "player",
            targetIds: [actorEntities.get(`ref:agent:${action.actorId}`) ?? "player"],
            goal: action.goal,
            means: [],
            mode: "automatic",
            difficulty: null,
            actorRatingId: null,
            factors: [],
            risk: "safe",
            baseEffect: "none",
            primaryEffect: null,
            secondaryEffect: null,
            threatenedEffect: null,
            visibility: "full",
            causes: [{ kind: "action", id: action.id }],
          }),
        };
        return dependentWire ? encodeResolutionDependentFields(adaptScriptedResolutionOutput(directive)) : directive;
      }
      if (role === "causal-verifier" && schemaName === "resolution_plan_verification") {
        planVerificationAttempts += 1;
        const plans = (context as { state: { candidateResolutionPlans: Array<{
          planRef: string;
          actorRef: string;
          baseEffect: string;
        }>; priorCommitmentRounds: Array<{ kind: string; phase?: string }> } } ).state;
        expect(plans.priorCommitmentRounds).not.toContainEqual(
          expect.objectContaining({ kind: "check", phase: "resolution" }),
        );
        const playerPlan = plans.candidateResolutionPlans.find((plan) => plan.actorRef === "ref:entity:player")!;
        if (planVerificationAttempts === 1) {
          expect(playerPlan.baseEffect).toBe("major");
          return {
            verdict: "reject",
            findings: [{
              planRef: playerPlan.planRef,
              code: "impact-overstated",
              message: "The improvised key does not justify major harm.",
              repairHint: "Recalibrate the primary effect against the grounded improvised means.",
            }],
          };
        }
        expect(playerPlan.baseEffect).toBe("standard");
        return { verdict: "accept", findings: [] };
      }
      if (role === "truth-transition") {
        if (schemaName === "truth_transition_mechanic_repair") {
          mechanicRepairAttempts += 1;
          const repairContext = context as {
            mechanicRepair: { targetInvocation: { proposalKey: string }; mechanicRef: string };
          };
          const canonicalTruth = (context as { canonicalTruth: { quantities: Record<string, unknown> } }).canonicalTruth;
          const existingQuantityId = Object.keys(canonicalTruth.quantities)[0];
          if (!existingQuantityId) throw new Error("fixture must expose a quantity for mechanic repair");
          return {
            invocation: {
              id: repairContext.mechanicRepair.targetInvocation.proposalKey,
              mechanicRef: repairContext.mechanicRepair.mechanicRef,
              input: {
                entityRef: { proposalKey: "repaired-entity" },
                profileRef: "ref:entity_mechanics_profile:wanderer",
              },
              causes: [{ kind: "action", id: (context as { state: { actionSet: { assigned: Array<{ actionRef: string }> } } }).state.actionSet.assigned[0]!.actionRef.replace(/^ref:action:/u, "") }],
              assertions: [{ kind: "entity_lifecycle", entityId: "player", expected: "active" }],
            },
          };
        }
        transitionAttempts += 1;
        const input = context as {
          state: {
            actionSet: { assigned: Array<{ actionRef: string; actorRef: string; rawText: string; goal: string; means: string | null; targetRefs: string[] }> };
            world: { mechanicContracts: Array<{ mechanicRef: string }> };
          };
          committedResolutionPlans: Array<{ planRef: string; actionRef: string }>;
          resolutionReceipts: Array<{ plan: { planRef: string; actionRef: string }; outcome: string | null; checkRef: string | null }>;
          checkResults: Array<{ checkRef: string; succeeded: boolean }>;
        };
        expect(input.state.world.mechanicContracts.map((contract) => contract.mechanicRef))
          .not.toContain("ref:mechanic:core-resolution::apply-receipt");
        expect(input.state.world.mechanicContracts.map((contract) => contract.mechanicRef))
          .not.toContain("ref:mechanic:core-resolution::advance-conditions");
        const actions = input.state.actionSet.assigned.map((action) => ({
          id: action.actionRef.replace(/^ref:action:/u, ""),
          actorId: action.actorRef.replace(/^ref:agent:/u, ""),
          rawText: action.rawText,
          goal: action.goal,
          means: action.means,
          targetIds: action.targetRefs,
        }));
        const output: TransitionProposalDraft = {
          outcomes: actions.map((action) => {
            const plan = input.committedResolutionPlans.find((candidate) => candidate.actionRef === `ref:action:${action.id}`)!;
            const receipt = input.resolutionReceipts.find((candidate) => candidate.plan.planRef === plan.planRef)!;
            const check = receipt.checkRef
              ? input.checkResults.find((candidate) => candidate.checkRef === receipt.checkRef)
              : null;
            return {
              proposalId: action.id,
              status: statusFor(receipt.outcome),
              summary: `Resolved as ${receipt.outcome ?? "blocked"}.`,
              causeRefs: [{ kind: "action", id: action.id }],
              assertions: check ? [{
                kind: "check_result",
                checkId: check.checkRef.replace(/^ref:check:/u, ""),
                expected: check.succeeded ? "succeeded" : "failed",
              }] : [{
                kind: "placement_equals",
                entityId: action.actorId,
                placementId: "courtyard",
              }],
              knownAlternatives: [],
            };
          }),
          mechanicInvocations: [],
          operations: [],
          events: [],
          decisionRequests: [],
        };
        if (transitionAttempts === 1) {
          output.mechanicInvocations = [{
            id: "stale-transfer",
            packageId: "core-resolution",
            ruleId: "instantiate-entity-profile",
            input: {
              entityId: "repaired-entity",
              staleProfile: "wanderer",
            },
              causes: [{ kind: "action", id: actions[0]!.id }],
            assertions: [{ kind: "entity_lifecycle", entityId: "player", expected: "active" }],
          }];
          output.operations = [{
            kind: "create_entity",
            entity: {
              id: "repaired-entity",
              kind: "person",
              name: "修复出的旅人",
              description: "用于验证 invocation 局部修复。",
            },
            placementId: "courtyard",
            causes: [{ kind: "action", id: actions[0]!.id }],
            assertions: [{ kind: "entity_absent", entityId: "repaired-entity" }],
          }];
        }
        return output;
      }
      if (role === "causal-verifier") {
        if (schemaName === "causal_verification") {
          causalVerificationAttempts += 1;
          if (causalVerificationAttempts === 1) {
            const candidate = (context as { candidate: { observations: Array<{ observationRef: string }> } }).candidate;
            return {
              verdict: "reject",
              findings: [{
                target: { kind: "observation", ref: candidate.observations[0]!.observationRef },
                code: "observation-mismatch",
                message: "observer-local draft needs a more cautious rendering",
                repairHint: "Re-render only this observer using authorized evidence.",
              }],
            };
          }
        }
        return { verdict: "accept", findings: [] };
      }
      return deterministicModelOutput(profileId, context);
    }, catalog, false);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 2,
      modelCatalog: catalog,
    });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(dependentWire ? dependentFieldsProvider(provider) : provider));
    await engine.bootstrapAgents();
    const source = engine.snapshot;
    const result = await engine.step({
      player: { kind: "external", agentId: "player", participantId: "test-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" },
    }, {
      expectedRevision: source.revision,
      trigger: "participant_action",
      externalActions: [{
        submissionId: "sand-strike",
        agentId: "player",
        rawText: "我用铜钥匙划向守门人，同时抓起庭院边的沙土撒向他的眼睛。",
        goal: "伤到守门人并遮蔽他的视线",
        means: "铜钥匙和脚下已有的松散沙土",
        targetIds: [],
      }],
    });

    const committed = result.committed;
    expect(planVerificationAttempts).toBe(2);
    expect(transitionAttempts).toBe(1);
    expect(mechanicRepairAttempts).toBe(1);
    expect(causalVerificationAttempts).toBe(2);
    expect(committed.resolutionPlans).toHaveLength(1);
    expect(committed.resolutionReceipts).toHaveLength(1);
    const receipt = committed.resolutionReceipts.find((candidate) => candidate.plan.actorId === "player")!;
    expect(receipt.outcome).toBe("full");
    expect(receipt.checkRequestId).toBe(committed.checks.find((check) => check.requestId === receipt.checkRequestId)?.requestId);
    expect(committed.commitmentRounds).toContainEqual(expect.objectContaining({ kind: "check", phase: "resolution" }));
    expect(receipt.plan.difficulty).toMatchObject({ kind: "opposed", ratingId: "resolve:keeper" });
    expect(receipt.operations).toEqual(committed.mechanicResults
      .find((mechanic) => (mechanic.data as { receiptId?: string }).receiptId === receipt.id)?.operations);
    expect(committed.operations).toEqual(expect.arrayContaining(receipt.operations));

    const meterOperation = receipt.operations.find((operation) => operation.kind === "adjust_meter");
    const expectedVitality = 15 + (meterOperation?.kind === "adjust_meter" ? meterOperation.amount : 0);
    expect(result.state.truth.meters["health:keeper"].current).toBe(expectedVitality);
    const sandInEyes = Object.values(result.state.truth.conditions).find((condition) => condition.label === "sand in eyes");
    expect(sandInEyes).toMatchObject({
      subjectId: "keeper",
      label: "sand in eyes",
      magnitude: "minor",
    });
    const perspective = projectAgentPerspective(result.state, result.state.agents.player);
    expect(perspective.history.at(-1)?.resolutions).toContainEqual(expect.objectContaining({
      visibility: "full",
      outcome: "full",
    }));
    expect(JSON.stringify(perspective)).not.toContain(receipt.id);
    expect(replaySimulationState(result.state)).toEqual(result.state);

    const tampered = structuredClone(result.state);
    const tamperedStep = tampered.history[0];
    tamperedStep.rngAfter.draws += 1;
    tamperedStep.semanticHash = semanticStepHash(tamperedStep);
    const payload = structuredClone(tamperedStep) as Partial<typeof tamperedStep>;
    delete payload.contentHash;
    tamperedStep.contentHash = contentHash(payload);
    expect(() => replaySimulationState(tampered)).toThrow("RNG");

    const operationTampered = structuredClone(result.state);
    const operationStep = operationTampered.history[0];
    const operationReceipt = operationStep.resolutionReceipts
      .find((candidate) => candidate.plan.actorId === "player")!;
    const operationIndex = operationReceipt.operations
      .findIndex((operation) => operation.kind === "adjust_meter");
    const recordedOperation = operationReceipt.operations[operationIndex];
    if (!recordedOperation || recordedOperation.kind !== "adjust_meter") {
      throw new Error("expected a derived meter operation");
    }
    const falsifiedOperation = { ...recordedOperation, amount: recordedOperation.amount + 1 };
    operationReceipt.operations[operationIndex] = falsifiedOperation;
    const mechanicResult = operationStep.mechanicResults.find((candidate) =>
      (candidate.data as { receiptId?: string }).receiptId === operationReceipt.id)!;
    const mechanicOperationIndex = mechanicResult.operations.findIndex((operation) =>
      contentHash(operation) === contentHash(recordedOperation));
    mechanicResult.operations[mechanicOperationIndex] = structuredClone(falsifiedOperation);
    const stepOperationIndex = operationStep.operations.findIndex((operation) =>
      contentHash(operation) === contentHash(recordedOperation));
    operationStep.operations[stepOperationIndex] = structuredClone(falsifiedOperation);
    operationStep.semanticHash = semanticStepHash(operationStep);
    const operationPayload = structuredClone(operationStep) as Partial<typeof operationStep>;
    delete operationPayload.contentHash;
    operationStep.contentHash = contentHash(operationPayload);
    expect(() => replaySimulationState(operationTampered))
      .toThrow("non-deterministic core-resolution result");
  });
});
