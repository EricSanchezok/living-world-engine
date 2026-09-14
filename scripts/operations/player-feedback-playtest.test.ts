import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { FULL_CATALOG_ALGORITHM_REF } from "../../src/engine/algorithms/registry";
import { createTestModelCatalog, deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, deterministicOnsetReports, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { buildWorldDefinition, loadWorldTemplate } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { runPlayerFeedbackAction, type PlayerFeedbackResult } from "./player-feedback-playtest";

it.each(["completed", "failed", "awaiting-decision", "budget-paused"] as const)("measures persisted player feedback at %s", async outcome => {
  const root = mkdtempSync(path.join(tmpdir(), "player-feedback-"));
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (outcome === "awaiting-decision" && role === "truth-perception") {
      return { kind: "done", reports: deterministicOnsetReports(context, "no_stimulus") };
    }
    if (outcome === "awaiting-decision" && role === "action-grounding") {
      return deterministicInteractionDependency({
        reads: [{ kind: "global", id: "world" }], writes: [{ kind: "global", id: "world" }],
        audienceAgentIds: ["courtyard-wanderer-1"],
      });
    }
    if (outcome === "awaiting-decision" && role === "action-compilation") {
      return deterministicActionCompilationBatch(profileId, context, compilation => {
        compilation.interactionDependency = deterministicInteractionDependency({
          reads: [{ kind: "global", id: "world" }], writes: [{ kind: "global", id: "world" }],
          audienceAgentIds: ["courtyard-wanderer-1"],
        });
      });
    }
    const output = deterministicModelOutput(profileId, context);
    if (outcome === "awaiting-decision" && role === "truth-transition") {
      const transition = output as { kind?: string; proposal?: { events: unknown[] } };
      const action = (context as { state: { actionSet: { assigned: { actionRef: string; actorRef: string }[] } } })
        .state.actionSet.assigned.find(action => action.actorRef === "ref:agent:keeper");
      if (transition.kind === "transition" && transition.proposal && action) {
        transition.proposal.events = [{ proposalKey: "keeper-call", description: "守门人在庭院中发出呼喊。", impact: "ordinary",
          causes: [{ kind: "action", ref: action.actionRef }], assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }] }];
      }
    }
    return output;
  }, createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  if (outcome === "awaiting-decision" || outcome === "budget-paused") {
    template.mechanics.temporal_profiles = template.mechanics.temporal_profiles.map(profile => {
      if (profile.id !== "brief-action" || profile.kind !== "fixed") return profile;
      const { duration_seconds, checkpoint_seconds, ...common } = profile;
      expect(duration_seconds).toBe(checkpoint_seconds);
      return { ...common, kind: "goal", check_every_seconds: checkpoint_seconds };
    });
  }
  const definition = buildWorldDefinition(template, { seed: 47, modelCatalog: provider.catalog });
  const repository = new MemoryWorldRepository({ [definition.id]: definition });
  const options = { repository, store: database, ledger: database, provider, defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
    runLeaseMaxCommits: 3 };
  const host = new WorldHost(options);
  try {
    const created = await host.createInstance({ worldId: definition.id, start: { kind: "origin", originId: "courtyard-wanderer",
      displayName: "旅人", appearance: "背着旅行包。", motivation: "了解庭院。" } });
    const generate = provider.generateStructured.bind(provider);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    provider.generateStructured = async request => {
      entered(); await gate;
      if (outcome === "failed") throw new ModelConfigurationError("injected unavailable model");
      return generate(request);
    };
    const updates: PlayerFeedbackResult[] = [];
    const checkpoints: number[] = [];
    let stopped: string | undefined;
    const promise = runPlayerFeedbackAction({ host, instanceId: created.summary.id, participantId: created.participants[0]!.id,
      submissionId: "watch-courtyard", text: "我观察石门和守门人。", read: () => database.readInstance(created.summary.id).document,
      onUpdate: result => updates.push(structuredClone(result)), onCheckpoint: value => checkpoints.push(value.checkpoint.revision),
      stopReason: () => stopped, onStop: reason => { stopped = reason; }, pollMs: 5 });
    await waiting;
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ status: "running", firstFeedbackElapsedMs: null, completedElapsedMs: null, feedback: [] });
    expect(host.instance(created.summary.id).summary.revision).toBe(created.summary.revision);
    release();
    const result = await promise;
    if (outcome === "failed") {
      expect(result).toMatchObject({ status: "stopped", firstFeedbackElapsedMs: null, completedElapsedMs: null, feedback: [] });
      expect(result.failure).toBeTruthy();
      expect(checkpoints).toEqual([]);
      expect(host.instance(created.summary.id).summary.revision).toBe(created.summary.revision);
    } else if (outcome === "awaiting-decision") {
      const final = database.readInstance(created.summary.id).document;
      const intent = final.participantIntents.find(value => value.submissionId === result.submissionId)!;
      expect(final.runs[intent.runId]!.status).toBe("awaiting-decision");
      expect(Object.values(final.state.truth.activities).find(activity => activity.actorId === intent.agentId))
        .toMatchObject({ status: "paused", completionAtSeconds: null });
      expect(result).toMatchObject({ status: "awaiting-decision", completedElapsedMs: null });
      expect(result.firstFeedbackElapsedMs).toBeGreaterThan(0);
      expect(result.endedElapsedMs).toBeGreaterThanOrEqual(result.firstFeedbackElapsedMs!);
      expect(result.feedback.at(-1)!.response.activity?.status).toBe("paused");
    } else if (outcome === "budget-paused") {
      expect(result).toMatchObject({ status: "stopped", completedElapsedMs: null });
      expect(result.feedback).toHaveLength(3);
      expect(result.feedback.at(-1)!.response.activity?.status).toBe("active");
    } else {
      expect(result.status).toBe("completed");
      expect(result.feedback).toHaveLength(1);
      expect(checkpoints).toEqual([created.summary.revision + 1]);
      expect(result.firstFeedbackElapsedMs).toBeGreaterThan(0);
      expect(result.completedElapsedMs).toBeGreaterThanOrEqual(result.firstFeedbackElapsedMs!);
      expect(result.endedElapsedMs).toBe(result.completedElapsedMs);
      expect(result.feedback[0]!.observationCount).toBeGreaterThan(0);
      const refreshed = new WorldHost(options).instance(created.summary.id);
      expect(refreshed.conversation!.turns[1]!.response).toEqual(result.feedback[0]!.response);
      expect(refreshed.conversation!.turns[1]!.action!.submissionId).toBe(result.submissionId);
    }
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 30_000);
