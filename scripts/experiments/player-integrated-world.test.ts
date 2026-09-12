import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { expect, it } from "vitest";
import { loadWorldScript, loadWorldTemplate } from "../../src/script/world-loader";
import { contentHash } from "../../src/engine/models/model-audit";
import { createTestModelCatalog } from "../../src/engine/testing/model-provider";
import { buildIntegratedPlayerWorld, INTEGRATED_PLAYER_WORLD_RECIPE } from "./player-integrated-world";
import { checkpointWorldTemplate } from "./step-checkpoint-world";
import { assertFiniteWorkWorld, finiteWorkWorldTemplate } from "./step-finite-work-world";

it("constructs and reloads the complete player experiment from the bundled world", () => {
  const source = loadWorldTemplate("worlds/blackmarsh/world");
  const before = contentHash(source);
  const catalog = createTestModelCatalog();
  const { candidate, baseline, world } = buildIntegratedPlayerWorld(source, 47, catalog);
  expect(INTEGRATED_PLAYER_WORLD_RECIPE).toBe("finite-work-then-short-checkpoints-v1");
  expect(Object.keys(world.initialState.agents)).toHaveLength(48);
  expect(world.initialState.agents).toEqual(baseline.initialState.agents);
  expect(contentHash(source)).toBe(before);
  expect(world.contentHash).not.toBe(baseline.contentHash);
  for (const [id, interval] of [["momentary-action", 1], ["brief-action", 10], ["work-until-objective", 300]] as const) {
    expect(world.initialState.truth.mechanics.temporalProfiles[id]).toMatchObject({ kind: "goal", checkEverySeconds: interval });
  }
  expect(candidate.mechanics.temporal_profile_coverage.required_semantic_tags).toContain("finite-work");
  expect(candidate.mechanics.temporal_calibrations.find(value => value.id === "finite-work-objective-time"))
    .toMatchObject({ profile_id: "work-until-objective" });
  const restored = structuredClone(candidate);
  restored.mechanics.temporal_profiles = restored.mechanics.temporal_profiles.filter(profile => profile.id !== "work-until-objective")
    .map(profile => ["momentary-action", "brief-action"].includes(profile.id)
      ? structuredClone(source.mechanics.temporal_profiles.find(original => original.id === profile.id)!) : profile);
  restored.mechanics.temporal_profile_coverage = structuredClone(source.mechanics.temporal_profile_coverage);
  restored.mechanics.temporal_calibrations = structuredClone(source.mechanics.temporal_calibrations);
  expect(restored).toEqual(source);
  const root = mkdtempSync(path.join(tmpdir(), "integrated-world-"));
  try {
    cpSync("worlds/blackmarsh/world", root, { recursive: true });
    writeFileSync(path.join(root, "mechanics.yaml"), stringify(candidate.mechanics));
    assertFiniteWorkWorld(loadWorldTemplate(root));
    const reloaded = loadWorldScript(root, { seed: 47, modelCatalog: catalog });
    expect(contentHash(reloaded)).toBe(contentHash(world));
    expect(readFileSync(path.join(root, "script.yaml"))).toEqual(readFileSync("worlds/blackmarsh/world/script.yaml"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("rejects an incomplete or changed finite-work prerequisite before short-profile transformation", () => {
  const source = loadWorldTemplate("worlds/blackmarsh/world");
  expect(() => checkpointWorldTemplate(source)).toThrow("finite-work experiment requires");
  const complete = finiteWorkWorldTemplate(source);
  expect(() => finiteWorkWorldTemplate(complete)).toThrow("collides");
  for (const mutation of ["profile", "interval", "coverage", "calibration"] as const) {
    const changed = structuredClone(complete);
    if (mutation === "profile") changed.mechanics.temporal_profiles = changed.mechanics.temporal_profiles.filter(profile => profile.id !== "work-until-objective");
    if (mutation === "interval") {
      const profile = changed.mechanics.temporal_profiles.find(profile => profile.id === "work-until-objective")!;
      if (profile.kind !== "goal") throw new Error("expected goal profile");
      profile.check_every_seconds = 1;
    }
    if (mutation === "coverage") changed.mechanics.temporal_profile_coverage.required_semantic_tags = changed.mechanics.temporal_profile_coverage.required_semantic_tags.filter(tag => tag !== "finite-work");
    if (mutation === "calibration") changed.mechanics.temporal_calibrations = changed.mechanics.temporal_calibrations.filter(calibration => calibration.id !== "finite-work-objective-time");
    expect(() => checkpointWorldTemplate(changed)).toThrow("finite-work experiment");
  }
});
