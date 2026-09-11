import path from "node:path";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { buildWorldDefinition, loadWorldTemplate } from "../../../script/world-loader";
import { SimulationEngine } from "../../runtime/simulation";
import { ScriptedModelProvider, deterministicActionCompilationBatch, deterministicModelOutput } from "../../testing/model-provider";
import { referenceHandleFor } from "../../contracts/model-context";
import { contentHash } from "../../models/model-audit";
import type { AgentActionProposal, SimulationState } from "../../contracts/model";
import type { StructuredModelRequest, StructuredModelResult } from "../../models/model-provider";
import type { FrozenBehaviorOracle } from "./behavior-oracle";

export type ConditionalCompletionScenario = "continuing" | "arrived" | "invalid" | "false-success";
export type ConditionalModelBoundary = <T>(request: StructuredModelRequest<T>, fallback: () => Promise<StructuredModelResult<T>>) => Promise<StructuredModelResult<T>>;

/** Controlled world task: only the expensive transition model boundary may be
 * replaced; loader, compilation materialization, engine, committer and replay are real.
 * Scripted surrounding roles do not establish whole-game semantic correctness. */
export async function runConditionalCompletionScenario(scenario: ConditionalCompletionScenario,
  boundary?: ConditionalModelBoundary, authoredTiming = false, profileKind: "conditional" | "goal" = "conditional") {
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (compilation, { action }) => {
      compilation.temporalPlan = {
        profileRef: referenceHandleFor("temporal_profile", "wait-condition"), basis: { kind: "profile" }, description: action.rawText,
        continuationAssertions: profileKind === "goal" ? [] : [
          { kind: "placement_not_equals", entityRef: referenceHandleFor("entity", "player"), placementRef: referenceHandleFor("placement", "gate") },
          { kind: "entity_lifecycle", entityRef: referenceHandleFor("entity", "gate"), expected: "active" },
        ], causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
      };
    });
    const generated = deterministicModelOutput(profileId, context) as Record<string, unknown>;
    if (scenario === "invalid" && role === "truth-resolution" && generated.kind === "commit_plans") {
      for (const plan of generated.plans as Array<{ mode: string }>) plan.mode = "blocked";
    }
    if (role === "truth-transition" && generated.kind === "transition") {
      const proposal = generated.proposal as { outcomes: Array<{ status: string; actionRef: string }>; operations: unknown[] };
      const outcome = proposal.outcomes[0]!;
      outcome.status = scenario === "continuing" ? "continuing" : scenario === "invalid" ? "blocked" : "succeeded";
      if (scenario === "arrived") proposal.operations.push({ kind: "place_entity", entityId: "player", placementId: "gate",
        causes: [{ kind: "action", ref: outcome.actionRef }], assertions: [{ kind: "placement_equals", entityId: "player", placementId: "courtyard" }] });
      if (scenario === "invalid") proposal.operations.push({ kind: "retire_entity", entityId: "gate",
        causes: [{ kind: "law", ref: referenceHandleFor("law", "scripted-gate-collapse") }], assertions: [{ kind: "entity_lifecycle", entityId: "gate", expected: "active" }] });
    }
    return generated;
  });
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = (request) => {
    if (request.role === "truth-transition" && boundary) return boundary(request, () => generate(request));
    return generate(request);
  };
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  if (profileKind === "goal") {
    const index = template.mechanics.temporal_profiles.findIndex((profile) => profile.id === "wait-condition");
    const profile = template.mechanics.temporal_profiles[index];
    if (!profile || profile.kind !== "conditional") throw new Error("controlled temporal profile missing");
    template.mechanics.temporal_profiles[index] = { ...profile, kind: "goal" };
  }
  if (authoredTiming) template.laws.laws.push({ id: "controlled-travel-time", severity: "hard",
    text: scenario === "continuing"
      ? "Walking from the courtyard to the gate requires exactly 120 seconds; at the first 60-second checkpoint the traveller is still on the courtyard side and must continue."
      : "Walking from the courtyard to the gate requires exactly 60 seconds; absent obstruction the traveller reaches and occupies the gate at that checkpoint." });
  if (scenario === "invalid") template.laws.laws.push({ id: "scripted-gate-collapse", severity: "hard",
    text: "At the first sixty-second checkpoint the unstable gate collapses and becomes retired before the traveller can enter it." });
  const definition = buildWorldDefinition(template, { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "player-participant" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, {
    expectedRevision: source.revision, trigger: "participant_action",
    externalActions: [{ submissionId: "conditional-arrival", agentId: "player", rawText: "Walk to the gate; continue until I arrive there.",
      goal: "Reach the gate", means: null, targetIds: [] }],
  });
  const action = result.committed.initialActions[0]!;
  const oracle = conditionalArrivalOracle(source, action);
  if (authoredTiming) {
    const status = scenario === "continuing" ? "continuing" : scenario === "invalid" ? "blocked" : "succeeded";
    oracle.branches = { [status]: oracle.branches[status]! };
    if (status === "succeeded") {
      oracle.earliestSuccessAtSeconds = source.truth.elapsedSeconds + 60;
      oracle.mustSucceedBySeconds = source.truth.elapsedSeconds + 60;
    }
  }
  return { source, result, action, oracle };
}

export function conditionalArrivalOracle(source: SimulationState, action: AgentActionProposal): FrozenBehaviorOracle {
  return {
    id: "conditional-arrival", worldHash: source.worldHash, sourceStateHash: contentHash(source), sourceActionHash: contentHash(action),
    preconditions: [{ kind: "placement_equals", entityId: "player", placementId: "courtyard" }, { kind: "entity_lifecycle", entityId: "gate", expected: "active" }],
    branches: {
      succeeded: { assertions: [{ kind: "placement_equals", entityId: "player", placementId: "gate" }] },
      continuing: { assertions: [{ kind: "placement_equals", entityId: "player", placementId: "courtyard" }], requireLiveSourceActivity: true },
      blocked: { assertions: [{ kind: "entity_lifecycle", entityId: "gate", expected: "retired" }] },
    },
  };
}
