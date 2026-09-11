import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadModelCatalog, ModelCatalog } from "../../models/model-catalog";
import { loadWorldScript } from "../../../script/world-loader";
import { LocalDatabase } from "../../../server/local-database";
import { installBundledWorlds } from "../../../server/bundled-worlds";
import { assertNonthinkingWorld, prepareNonthinkingWorld } from "./nonthinking-world";
import { FLASH41_COHORT, STEP_E2_PROTOCOL } from "./nonthinking-protocol";

it("imports the unchanged full world and rejects thinking, model and frozen asset drift", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-e2-world-"));
  let database: LocalDatabase | undefined;
  try {
    const source = loadModelCatalog();
    const profiles = Object.fromEntries(Object.entries(source.profiles).map(([id, profile]) => [id,
      profile.account_id === "deepseek-api" ? { ...profile, selector: { kind: "exact" as const, model_id: STEP_E2_PROTOCOL.model } } : profile]));
    const baseline = new ModelCatalog({ schema_version: source.schemaVersion, scheduler: source.scheduler,
      registry: source.registry, accounts: source.accounts, profiles, model_overrides: source.modelOverrides });
    expect(() => prepareNonthinkingWorld(root, source)).toThrow("non-thinking model");
    const frozen = prepareNonthinkingWorld(root, baseline), catalog = loadModelCatalog(frozen.catalogPath);
    expect(prepareNonthinkingWorld(root, baseline)).toEqual(frozen);
    database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    expect(installBundledWorlds(database, catalog, frozen.worldsRoot)).toHaveLength(1);
    const world = database.load("blackmarsh", STEP_E2_PROTOCOL.seed, catalog);
    expect(world.contentHash).toBe(frozen.worldHash);
    expect(Object.keys(world.initialState.agents)).toHaveLength(48);
    expect(Object.keys(world.initialState.truth.entities)).toHaveLength(232);
    expect(assertNonthinkingWorld(world, catalog)).toEqual(frozen.profileIds);
    expect(world.initialState).toEqual(loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog }).initialState);
    const original = JSON.parse(readFileSync(frozen.catalogPath, "utf8"));
    const current = structuredClone(original);
    for (const id of frozen.profileIds) current.profiles[id].selector.model_id = FLASH41_COHORT.model;
    const currentCatalog = new ModelCatalog(current);
    expect(assertNonthinkingWorld(world, currentCatalog, FLASH41_COHORT.model)).toEqual(frozen.profileIds);
    expect(() => assertNonthinkingWorld(world, currentCatalog)).toThrow("non-thinking model");
    expect(() => assertNonthinkingWorld(world, catalog, FLASH41_COHORT.model)).toThrow("non-thinking model");
    const currentThinking = structuredClone(current); currentThinking.profiles[frozen.profileIds[0]!].inference.thinking = "enabled";
    expect(() => assertNonthinkingWorld(world, new ModelCatalog(currentThinking), FLASH41_COHORT.model)).toThrow("non-thinking model");
    expect(JSON.parse(readFileSync(frozen.catalogPath, "utf8"))).toEqual(original);
    for (const id of frozen.profileIds) {
      const changed = structuredClone(original);changed.profiles[id].inference.thinking = "enabled";
      expect(() => assertNonthinkingWorld(world, new ModelCatalog(changed))).toThrow("non-thinking model");
    }
    const differentModel = structuredClone(original);differentModel.profiles[frozen.profileIds[0]!].selector.model_id = "different-model";
    expect(() => assertNonthinkingWorld(world, new ModelCatalog(differentModel))).toThrow("non-thinking model");
    const asset = path.join(frozen.worldsRoot, "blackmarsh/world/script.yaml");
    writeFileSync(asset, readFileSync(asset, "utf8") + "\n# changed\n");
    expect(() => prepareNonthinkingWorld(root, baseline)).toThrow("snapshot drift");
  } finally { database?.close();rmSync(root, { recursive: true, force: true }); }
});
