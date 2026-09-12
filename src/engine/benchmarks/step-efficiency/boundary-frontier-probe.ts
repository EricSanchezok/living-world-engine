import path from "node:path";
import { buildWorldDefinition, loadWorldTemplate } from "../../../script/world-loader";
import type { PolicyBinding } from "../../runtime/execution";
import type { ExistingReferenceHandle } from "../../contracts/model-context";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { createTestModelCatalog, deterministicActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";

interface RequestCount {
  role: string;
  schema: string;
  calls: number;
  assignedActions: number;
  slots: number;
}

/** Controlled scheduling workload; scripted semantics do not measure provider latency or game quality. */
export async function probeBoundaryFrontier(keeperDurationSeconds: 1 | 10, keeperMode: "repeat" | "checkpoint" = "repeat") {
  let counts = new Map<string, RequestCount>();
  const provider = new ScriptedModelProvider(({ role, profileId, schemaName, context }) => {
    const input = context as {
      task?: { slots?: unknown[] };
      state?: { actionSet?: { assigned?: unknown[] }; slots?: unknown[] };
      slots?: unknown[];
    };
    const key = `${role}/${schemaName}`;
    const count = counts.get(key) ?? { role, schema: schemaName, calls: 0, assignedActions: 0, slots: 0 };
    count.calls++;
    count.assignedActions += input.state?.actionSet?.assigned?.length ?? 0;
    count.slots += input.task?.slots?.length ?? input.state?.slots?.length ?? input.slots?.length ?? 0;
    counts.set(key, count);
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, (compilation, slot) => {
      const duration = slot.action.actorId === "player" ? 10 : slot.action.actorId === "keeper" ? keeperDurationSeconds : 100;
      compilation.temporalPlan.profileRef = (slot.action.actorId === "keeper" && keeperMode === "checkpoint"
        ? "ref:temporal_profile:frontier-checkpoint" : `ref:temporal_profile:frontier-${duration}`) as ExistingReferenceHandle;
    });
    if (role === "action-grounding") return { stateDependencies: { requiredExistingRefs: [], potentiallyAffectedExistingRefs: [] },
      audienceAgentRefs: [], sharedResourceClaims: [] };
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    const output = deterministicModelOutput(profileId, context) as Record<string, unknown>;
    if (role === "truth-transition" && output.kind === "transition") {
      (output.proposal as { events: unknown[] }).events = [];
    }
    return output;
  }, createTestModelCatalog(undefined, { maxInputBytes: 8_000_000 }), false, false);
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  const keeper = template.entities.find(entity => entity.id === "keeper")!;
  for (let index = 0; index < 47; index++) {
    const id = `frontier-npc-${String(index).padStart(2, "0")}`;
    const entity = structuredClone(keeper);
    entity.id = id;
    entity.name = id;
    entity.agent!.id = id;
    entity.agent!.belief.bindings.find(binding => binding.local_entity_id === "self")!.canonical_entity_ids = [id];
    entity.meters!.forEach(meter => { meter.id = meter.id.replace("keeper", id); });
    entity.ratings!.forEach(rating => { rating.id = rating.id.replace("keeper", id); });
    template.entities.push(entity);
  }
  for (const entity of template.entities) if (entity.agent) entity.name = entity.id;
  const fixed = template.mechanics.temporal_profiles.find(profile => profile.id === "brief-action")!;
  if (fixed.kind !== "fixed") throw new Error("expected fixed fixture profile");
  template.mechanics.temporal_profiles.push(...[1, 10, 100].map(duration => ({ ...structuredClone(fixed),
    id: `frontier-${duration}`, name: `Controlled ${duration} second action`, duration_seconds: duration, checkpoint_seconds: duration,
  })));
  template.mechanics.temporal_profiles.push({ id: "frontier-checkpoint", name: "Controlled goal checkpoint",
    kind: "goal", check_every_seconds: keeperDurationSeconds, interruptible: true,
    reaction_fallback: fixed.reaction_fallback,
    resource_claims: structuredClone(fixed.resource_claims), selection: structuredClone(fixed.selection),
  });
  template.laws.laws.push({ id: "frontier-workload", severity: "hard", text:
    "Each character independently waits without changing any other state. The player waits ten seconds. " +
    (keeperMode === "repeat" ? "The keeper repeatedly waits for its selected profile duration. "
      : "The keeper undertakes one goal-based wait of one hundred seconds, remaining continuing at each earlier checkpoint. ") +
    "The other forty-seven characters wait for one hundred seconds. No observation changes these intentions. This controlled workload has no uncertain checks or intermediate effects." });
  const definition = buildWorldDefinition(template, { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider));
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const policies: Record<string, PolicyBinding> = Object.fromEntries(Object.values(source.agents).map(agent => [agent.id,
    agent.id === "player" ? { kind: "external", agentId: agent.id, participantId: "frontier-player" }
      : { kind: "model", agentId: agent.id, profiles: structuredClone(agent.modelProfiles) },
  ]));
  const rows = [];
  for (let index = 0; index < 10 && engine.snapshot.truth.elapsedSeconds < 10; index++) {
    counts = new Map();
    const before = engine.snapshot;
    const result = await engine.step(policies, { expectedRevision: before.revision,
      trigger: index === 0 ? "participant_action" : "manual",
      externalActions: index === 0 ? [{ submissionId: "frontier-wait", agentId: "player", rawText: "Wait for ten seconds.",
        goal: "Wait for ten seconds", means: null, targetIds: [] }] : [],
    });
    const step = result.committed;
    const replayMatches = contentHash(replaySimulationState(result.state).truth) === contentHash(result.state.truth);
    const player = Object.values(result.state.truth.activities).find(activity => activity.actorId === "player")!;
    if (player.status === "queued" || player.status === "ready") throw new Error("controlled player must have started");
    const previousActionIds = new Set(Object.values(before.truth.activities).map(activity => activity.sourceActionId));
    const backgroundSchedules = Object.values(result.state.truth.activities)
      .filter(activity => activity.actorId.startsWith("frontier-npc-"))
      .map(activity => {
        if (activity.status === "queued" || activity.status === "ready") throw new Error("controlled background action must have started");
        return { actorId: activity.actorId, status: activity.status, nextBoundaryAtSeconds: activity.nextBoundaryAtSeconds,
          completionAtSeconds: activity.completionAtSeconds };
      });
    rows.push({ time: result.state.truth.elapsedSeconds, revision: result.state.revision,
      newActors: step.initialActions.filter(action => !previousActionIds.has(action.id)).map(action => action.actorId).sort(),
      adjudicatedActors: step.actions.map(action => action.actorId).sort(),
      plans: step.resolutionPlans.length, checks: step.checks.length,
      player: { status: player.status, nextBoundaryAtSeconds: player.nextBoundaryAtSeconds, completionAtSeconds: player.completionAtSeconds },
      ongoing: Object.values(result.state.truth.activities).filter(activity => activity.status === "active").length,
      requests: [...counts.values()], replayMatches, backgroundSchedules,
      keeperActivities: Object.values(result.state.truth.activities).filter(activity => activity.actorId === "keeper")
        .map(activity => ({ id: activity.id, status: activity.status, sourceActionId: activity.sourceActionId })),
    });
  }
  return { contract: "boundary-frontier-probe-v1", oracle: "Scripted isolated waits; model boundaries replaced, zero HTTP. Counts are logical provider entries, not physical production batches or latency.",
    agents: Object.keys(source.agents).length, externalPlayers: 1, modelAgents: 48, keeperDurationSeconds, keeperMode,
    sourceHash: contentHash(source), worldHash: source.worldHash, rows, finalTruthHash: contentHash(engine.snapshot.truth) };
}
