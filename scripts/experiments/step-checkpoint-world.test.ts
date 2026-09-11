import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { ActionOutcome } from "../../src/engine/contracts/model";
import { prepareNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";
import { loadModelCatalog, ModelCatalog } from "../../src/engine/models/model-catalog";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { buildWorldDefinition, loadWorldTemplate } from "../../src/script/world-loader";
import { advanceTemporalState, cancelActivity, createActivity, materializeTemporalPlan, reconcileTemporalOutcomes,
  selectTemporalBoundary, validateActivityResources, validateActivityState, type TemporalPlanDraft, type TemporalProfileDefinition } from "../../src/engine/mechanics/temporal";
import { checkpointWorldTemplate, prepareCheckpointWorld, CHECKPOINT_PROFILE_IDS } from "./step-checkpoint-world";

it("prepares and reloads a complete immutable world with only two declared timing changes", () => {
  const root = mkdtempSync(path.join(tmpdir(), "checkpoint-world-"));
  try {
    const sourceRoot = path.join(root, "source"), destination = path.join(root, "candidate");
    const sourceCatalog = loadModelCatalog();
    const profiles = Object.fromEntries(Object.entries(sourceCatalog.profiles).map(([id, profile]) => [id,
      profile.account_id === "deepseek-api" ? { ...profile, selector: { kind: "exact" as const, model_id: STEP_E2_PROTOCOL.model } } : profile]));
    prepareNonthinkingWorld(sourceRoot, new ModelCatalog({ schema_version: sourceCatalog.schemaVersion,
      scheduler: sourceCatalog.scheduler, registry: sourceCatalog.registry, accounts: sourceCatalog.accounts,
      profiles, model_overrides: sourceCatalog.modelOverrides }));
    const result = prepareCheckpointWorld({ sourceRoot, destination });
    expect(prepareCheckpointWorld({ sourceRoot, destination })).toEqual(result);
    expect(result.manifest).toMatchObject({ paidHttp: 0, agents: 48, entities: 232, runtimePromoted: false });
    const source = loadWorldTemplate(path.join(sourceRoot, "worlds/blackmarsh/world"));
    const candidate = loadWorldTemplate(path.join(destination, "worlds/blackmarsh/world"));
    expect(candidate.mechanics.temporal_profiles).toHaveLength(source.mechanics.temporal_profiles.length);
    for (const profile of source.mechanics.temporal_profiles) {
      if (CHECKPOINT_PROFILE_IDS.some(id => id === profile.id)) continue;
      expect(candidate.mechanics.temporal_profiles.find(value => value.id === profile.id)).toEqual(profile);
    }
    expect(candidate.entities).toEqual(source.entities); expect(candidate.laws).toEqual(source.laws);
    expect(candidate.manifest).toEqual(source.manifest); expect(candidate.participation).toEqual(source.participation);
    expect(() => checkpointWorldTemplate(candidate)).toThrow("source contract changed");
    const file = path.join(destination, "worlds/blackmarsh/world/mechanics.yaml");
    writeFileSync(file, readFileSync(file, "utf8") + "\n# drift\n");
    expect(() => prepareCheckpointWorld({ sourceRoot, destination })).toThrow("frozen checkpoint world changed");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("makes a wrong short selection a checkpoint while preserving brief completion and explicit duration", () => {
  const template = loadWorldTemplate(path.resolve("worlds/blackmarsh/world"));
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  const baseline = buildWorldDefinition(template, { seed: 1, modelCatalog: catalog });
  const candidate = buildWorldDefinition(checkpointWorldTemplate(template), { seed: 1, modelCatalog: catalog });
  const resources = candidate.initialState.truth.mechanics.activityResources;
  function start(profiles: Record<string, TemporalProfileDefinition>, profileId: string, rawText: string,
    basis: TemporalPlanDraft["basis"] = { kind: "profile" }) {
    const plan = materializeTemporalPlan({ id: "plan", actionId: "action", actorId: "player", startsAtSeconds: 0, rawText,
      profiles, draft: { profileId, basis, description: rawText, continuationAssertions: [], causes: [{ kind: "action", id: "action" }] } });
    return createActivity({ id: "activity", plan, sourceAction: { id: "action", actorId: "player", baseRevision: 0,
      rawText, goal: rawText, means: null, targetIds: [] } });
  }
  function advance(activity: ReturnType<typeof start>, elapsedSeconds: number) {
    const boundary = selectTemporalBoundary({ elapsedSeconds, maxAutonomousSpanSeconds: 300, activities: { activity }, timers: {}, conditionExpiries: {} });
    return advanceTemporalState({ boundary, activities: { activity }, timers: {} });
  }
  const rawText = "Inspect the road, verify the obstruction, then return with the report.";
  const wrongShort = start(baseline.initialState.truth.mechanics.temporalProfiles, "brief-action", rawText);
  expect(advance(wrongShort, 0).activities.activity!.status).toBe("completed");
  const profiles = candidate.initialState.truth.mechanics.temporalProfiles;
  let activity = start(profiles, "brief-action", rawText);
  for (const elapsed of [0, 10, 20]) {
    const advanced = advance(activity, elapsed);
    expect(advanced.boundary.toElapsedSeconds).toBe(elapsed + 10);
    expect(advanced.activities.activity).toMatchObject({ status: "active", completionAtSeconds: null });
    expect(advanced.decisionPoints).toEqual([]);
    const continued = reconcileTemporalOutcomes(advanced, [{ proposalId: "action", status: "continuing" } as ActionOutcome]);
    activity = continued.activities.activity! as typeof activity;
    expect(activity.sourceAction.rawText).toBe(rawText);
    validateActivityState(activity, elapsed + 10, profiles, resources);
    validateActivityResources({ activity }, resources);
  }
  const completed = reconcileTemporalOutcomes(advance(activity, 30), [{ proposalId: "action", status: "succeeded" } as ActionOutcome]);
  expect(completed.activities.activity).toMatchObject({ status: "completed", completionAtSeconds: 40, nextBoundaryAtSeconds: null });
  const brief = start(profiles, "brief-action", "Say hello.");
  expect(() => validateActivityResources({ activity, brief }, resources)).toThrow("exceeds activity resource");
  expect(() => validateActivityResources({ activity: completed.activities.activity!, brief }, resources)).not.toThrow();
  expect(reconcileTemporalOutcomes(advance(brief, 0), [{ proposalId: "action", status: "succeeded" } as ActionOutcome]).activities.activity)
    .toMatchObject({ status: "completed", completionAtSeconds: 10 });
  expect(cancelActivity(activity, 30).activity).toMatchObject({ status: "cancelled", nextBoundaryAtSeconds: null });
  const explicit = start(profiles, "explicit-duration", "Wait for 5 minutes.", { kind: "explicit_duration", seconds: 300, sourceText: "5 minutes" });
  expect(advance(explicit, 0).activities.activity).toMatchObject({ status: "completed", completionAtSeconds: 300 });
});
