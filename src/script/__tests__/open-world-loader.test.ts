import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { coreResolutionRulePackage, RulePackageRegistry } from "../../engine/mechanics/rule-package";
import {
  MAX_RANDOM_DISTRIBUTION_UTF8_BYTES,
  MAX_RANDOM_DISTRIBUTIONS_PER_WORLD,
  stableRandomUtf8Bytes,
} from "../../engine/mechanics/random-limits";
import type { DiscreteRandomDefinition } from "../../engine/contracts/model";
import { createTestModelCatalog } from "../../engine/testing/model-provider";
import { quantityId, sharedActivityResourcePoolId } from "../../engine/runtime/runtime-id";
import { loadWorldScript } from "../world-loader";

const fixture = path.resolve("test/fixtures/open-world-script");
const modelCatalog = createTestModelCatalog();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function copiedFixture(): string {
  const parent = mkdtempSync(path.join(tmpdir(), "livingworld-loader-"));
  temporaryDirectories.push(parent);
  const target = path.join(parent, "world");
  cpSync(fixture, target, { recursive: true });
  return target;
}

describe("open world script loader", () => {
  it("loads open facts, numeric mechanics, Agents and private knowledge", () => {
    const definition = loadWorldScript(fixture, { seed: 91, modelCatalog });

    expect(definition.id).toBe("open-world-fixture");
    expect(definition.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(definition.initialState.worldHash).toBe(definition.contentHash);
    expect(definition.initialState.truth.entities.key.description).toContain("假钥匙");
    expect(definition.initialState.truth.facts["key-authenticity"].value).toEqual({
      kind: "text",
      value: "fake",
    });
    expect(definition.initialState.truth.facts["key-authenticity"].provenance).toEqual([
      { kind: "world_seed", id: definition.contentHash },
    ]);
    expect(definition.initialState.agents.player.belief.claims["key-is-authentic"].value).toEqual({
      kind: "text",
      value: "real",
    });
    expect(definition.initialState.agents.keeper.nextAction).toBeNull();
    expect(definition.initialState.agents.keeper.character).toMatchObject({
      persona: { summary: expect.stringContaining("谨慎"), voice: expect.stringContaining("简短") },
      traits: { cautious: { strength: 0.8, status: "active", createdAtStep: 0 } },
      values: { duty: { strength: 0.9, status: "active" } },
      emotions: { alertness: { intensity: 0.4, status: "active" } },
      attitudes: { "toward-traveler": { subjectId: "traveler", intensity: 0.5 } },
      goals: { "guard-gate": { priority: 0.9, progress: 0 } },
      commitments: { "dawn-watch": { subjectIds: ["self"], priority: 0.8 } },
    });
    expect(definition.initialState.truth.quantities[
      quantityId(definition.contentHash, "spirit-stone", "keeper")
    ].amount).toBe(20);
    expect(definition.initialState.truth.rng.seed).toBe(91);
    expect(definition.rulePackages).toEqual([expect.objectContaining({
      id: "core-resolution",
      version: "2.0.0",
      config: {},
    })]);
    expect(definition.initialState.schemaVersion).toBe(16);
    expect(definition.initialState.truth.mechanics.sharedActivityResources["fixture-workbench"]).toEqual({
      id: "fixture-workbench",
      name: "庭院工作台",
      unit: "席",
      defaultClaimAmount: 1,
      allowExplicitAmount: true,
      contention: "queue",
      pausedRetention: "release",
    });
    const workbenchPoolId = sharedActivityResourcePoolId(
      definition.contentHash,
      "fixture-workbench",
      "courtyard",
    );
    expect(definition.initialState.truth.sharedActivityResourcePools[workbenchPoolId]).toEqual({
      id: workbenchPoolId,
      definitionId: "fixture-workbench",
      entityId: "courtyard",
      capacity: 1,
    });
    expect(definition.initialState.truth.mechanics.impactProfiles.harm.amounts).toEqual({
      none: 0, minor: 2, standard: 5, major: 10, decisive: 20,
    });
    expect(definition.participation?.origins[0].mechanicsProfileId).toBe("wanderer");
    expect(definition.randomDistributions).toEqual([
      expect.objectContaining({
        id: "four-six-sum",
        steps: [{
          id: "amount",
          count: 4,
          outcomes: [1, 2, 3, 4, 5, 6],
          aggregate: "sum",
          when: null,
        }],
      }),
      expect.objectContaining({ id: "five-ten-sum" }),
      expect.objectContaining({
        id: "hourly-four-four",
        steps: expect.arrayContaining([expect.objectContaining({
          id: "group-size",
          count: 4,
          outcomes: [1, 2, 3, 4],
          aggregate: "sum",
          when: { stepId: "triggered", equals: true },
        })]),
      }),
      expect.objectContaining({
        id: "three-six-four-two",
        steps: expect.arrayContaining([expect.objectContaining({
          id: "branch",
          outcomes: ["first", "first", "first", "first", "second", "second"],
          when: { stepId: "triggered", equals: true },
        })]),
      }),
    ]);
  });

  it("hashes normalized world content independently of entity file names", () => {
    const renamed = copiedFixture();
    renameSync(path.join(renamed, "entities/keeper.yaml"), path.join(renamed, "entities/z-keeper.yaml"));
    renameSync(path.join(renamed, "entities/key.yaml"), path.join(renamed, "entities/a-key.yaml"));

    expect(loadWorldScript(renamed, { modelCatalog }).contentHash)
      .toBe(loadWorldScript(fixture, { modelCatalog }).contentHash);
  });

  it("rejects unknown, duplicate, and negative Entity resource pools", () => {
    const unknown = copiedFixture();
    const unknownEntity = path.join(unknown, "entities/courtyard.yaml");
    writeFileSync(unknownEntity, readFileSync(unknownEntity, "utf8").replace(
      "definition_id: fixture-workbench",
      "definition_id: missing-workbench",
    ), "utf8");
    expect(() => loadWorldScript(unknown, { modelCatalog })).toThrow("unknown shared activity resource");

    const duplicate = copiedFixture();
    const duplicateEntity = path.join(duplicate, "entities/courtyard.yaml");
    writeFileSync(duplicateEntity, `${readFileSync(duplicateEntity, "utf8")}` +
      "  - { definition_id: fixture-workbench, capacity: 1 }\n", "utf8");
    expect(() => loadWorldScript(duplicate, { modelCatalog })).toThrow("repeats shared activity resource");

    const negative = copiedFixture();
    const negativeEntity = path.join(negative, "entities/courtyard.yaml");
    writeFileSync(negativeEntity, readFileSync(negativeEntity, "utf8").replace(
      "capacity: 1",
      "capacity: -1",
    ), "utf8");
    expect(() => loadWorldScript(negative, { modelCatalog })).toThrow();
  });

  it("materializes authored absolute timers only for known laws and Agents", () => {
    const world = copiedFixture();
    const mechanicsFile = path.join(world, "mechanics.yaml");
    writeFileSync(mechanicsFile, readFileSync(mechanicsFile, "utf8").replace(
      "world_timers: []",
      "world_timers:\n" +
      "  - id: gate-deadline\n" +
      "    description: 石门值守进入绝对截止。\n" +
      "    due_at_seconds: 120\n" +
      "    wake_agent_ids: [keeper]\n" +
      "    law_id: time-passes",
    ), "utf8");

    const timer = loadWorldScript(world, { modelCatalog }).initialState.truth.timers["gate-deadline"];
    expect(timer).toEqual({
      id: "gate-deadline",
      description: "石门值守进入绝对截止。",
      createdAtSeconds: 0,
      dueAtSeconds: 120,
      status: "scheduled",
      wakeAgentIds: ["keeper"],
      causes: [{ kind: "law", id: "time-passes" }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 120 }],
    });

    const invalidAgent = copiedFixture();
    const invalidMechanics = path.join(invalidAgent, "mechanics.yaml");
    writeFileSync(invalidMechanics, readFileSync(invalidMechanics, "utf8").replace(
      "world_timers: []",
      "world_timers:\n" +
      "  - id: invalid-deadline\n" +
      "    description: 无主截止。\n" +
      "    due_at_seconds: 120\n" +
      "    wake_agent_ids: [missing-agent]\n" +
      "    law_id: time-passes",
    ), "utf8");
    expect(() => loadWorldScript(invalidAgent, { modelCatalog })).toThrow("wakes unknown Agent");
  });

  it("defaults every optional character layer from only persona.summary", () => {
    const world = copiedFixture();
    const keeperFile = path.join(world, "entities/keeper.yaml");
    const keeper = readFileSync(keeperFile, "utf8").replace(
      /  character:\n[\s\S]*?  belief:\n/,
      "  character:\n    persona:\n      summary: 只保留最小人格摘要。\n  belief:\n",
    );
    writeFileSync(keeperFile, keeper, "utf8");

    expect(loadWorldScript(world, { modelCatalog }).initialState.agents.keeper.character).toEqual({
      persona: { summary: "只保留最小人格摘要。", voice: "", updatedAtStep: 0, evidenceIds: [] },
      traits: {},
      values: {},
      emotions: {},
      attitudes: {},
      goals: {},
      commitments: {},
    });
  });

  it("rejects schema v13 worlds and missing or duplicate Agent self bindings", () => {
    const oldWorld = copiedFixture();
    const manifestFile = path.join(oldWorld, "script.yaml");
    writeFileSync(
      manifestFile,
      readFileSync(manifestFile, "utf8").replace("schema_version: 14", "schema_version: 13"),
      "utf8",
    );
    expect(() => loadWorldScript(oldWorld, { modelCatalog })).toThrow();

    const duplicateSelf = copiedFixture();
    const keeperFile = path.join(duplicateSelf, "entities/keeper.yaml");
    writeFileSync(
      keeperFile,
      readFileSync(keeperFile, "utf8").replace(
        "canonical_entity_ids: [player]",
        "canonical_entity_ids: [keeper]",
      ),
      "utf8",
    );
    expect(() => loadWorldScript(duplicateSelf, { modelCatalog })).toThrow("exactly one self binding");
  });

  it("rejects temporal selection and coverage gaps before runtime", () => {
    const missingCoverage = copiedFixture();
    const missingCoverageFile = path.join(missingCoverage, "mechanics.yaml");
    writeFileSync(
      missingCoverageFile,
      readFileSync(missingCoverageFile, "utf8").replace(
        "required_semantic_tags: [short, explicit-duration, travel, staged-treatment, conditional-wait, open-ended, reconnaissance]",
        "required_semantic_tags: [short, explicit-duration, travel, staged-treatment, conditional-wait, open-ended, reconnaissance, diplomacy]",
      ),
      "utf8",
    );
    expect(() => loadWorldScript(missingCoverage, { modelCatalog }))
      .toThrow("temporal profile coverage is missing semantic tag diplomacy");

    const invalidRate = copiedFixture();
    const invalidRateFile = path.join(invalidRate, "mechanics.yaml");
    writeFileSync(
      invalidRateFile,
      readFileSync(invalidRateFile, "utf8").replace(
        "selection: { semantic_tags: [travel], evidence_requirement: explicit_profile_quantity }",
        "selection: { semantic_tags: [travel], evidence_requirement: none }",
      ),
      "utf8",
    );
    expect(() => loadWorldScript(invalidRate, { modelCatalog }))
      .toThrow("must require explicit profile quantity evidence");
  });

  it("loads only rule packages registered by the trusted server runtime", () => {
    const world = copiedFixture();
    const mechanicsFile = path.join(world, "mechanics.yaml");
    const mechanics = readFileSync(mechanicsFile, "utf8")
      .replace(
        "    config: {}\nmeters:",
        "    config: {}\n  - id: cultivation-resolution\n    version: 2.0.0\n    config: {}\nmeters:",
      );
    writeFileSync(mechanicsFile, mechanics, "utf8");

    expect(() => loadWorldScript(world, { modelCatalog })).toThrow("unknown rule package cultivation-resolution");

    const registry = new RulePackageRegistry([coreResolutionRulePackage, {
      id: "cultivation-resolution",
      version: "2.0.0",
      adjudication: "使用修仙世界检定。",
      configSchema: z.strictObject({}),
      rules: [],
    }]);
    expect(loadWorldScript(world, { seed: 1, rulePackages: registry, modelCatalog }).rulePackages[1]).toMatchObject({
      id: "cultivation-resolution",
      version: "2.0.0",
    });

    const missingCore = copiedFixture();
    const missingCoreFile = path.join(missingCore, "mechanics.yaml");
    writeFileSync(
      missingCoreFile,
      readFileSync(missingCoreFile, "utf8").replace("core-resolution", "cultivation-resolution"),
      "utf8",
    );
    expect(() => loadWorldScript(missingCore, { seed: 1, rulePackages: registry, modelCatalog }))
      .toThrow("schema v14 worlds require core-resolution@2.0.0");
  });

  it("enforces the exact canonical UTF-8 distribution budget during world loading", () => {
    const exact = copiedFixture();
    const definition: DiscreteRandomDefinition = {
      id: "loader-byte-boundary",
      description: "x",
      steps: [{
        id: "value",
        count: 1,
        outcomes: [0, 1],
        aggregate: "first",
        when: null,
      }],
    };
    definition.description += "x".repeat(
      MAX_RANDOM_DISTRIBUTION_UTF8_BYTES - stableRandomUtf8Bytes(definition),
    );
    expect(stableRandomUtf8Bytes(definition)).toBe(MAX_RANDOM_DISTRIBUTION_UTF8_BYTES);
    const appendDefinition = (directory: string, description: string) => {
      const file = path.join(directory, "mechanics.yaml");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n  - id: loader-byte-boundary\n` +
        `    description: ${description}\n` +
        "    steps:\n" +
        "      - id: value\n" +
        "        count: 1\n" +
        "        outcomes: [0, 1]\n" +
        "        aggregate: first\n", "utf8");
    };
    appendDefinition(exact, definition.description);
    expect(() => loadWorldScript(exact, { modelCatalog })).not.toThrow();

    const oversized = copiedFixture();
    appendDefinition(oversized, `${definition.description}x`);
    expect(() => loadWorldScript(oversized, { modelCatalog })).toThrow("exceeds byte limit");
  });

  it("enforces the world random catalog count at the loader boundary", () => {
    const appendDistributions = (directory: string, count: number) => {
      const file = path.join(directory, "mechanics.yaml");
      const additions = Array.from({ length: count }, (_, index) =>
        `  - id: loader-catalog-${index}\n` +
        "    description: loader catalog boundary\n" +
        "    steps:\n" +
        "      - id: value\n" +
        "        count: 1\n" +
        "        outcomes: [0, 1]\n" +
        "        aggregate: first\n").join("");
      writeFileSync(file, `${readFileSync(file, "utf8")}\n${additions}`, "utf8");
    };

    const fixtureDistributionCount = 4;
    const exact = copiedFixture();
    appendDistributions(exact, MAX_RANDOM_DISTRIBUTIONS_PER_WORLD - fixtureDistributionCount);
    expect(() => loadWorldScript(exact, { modelCatalog })).not.toThrow();

    const oversized = copiedFixture();
    appendDistributions(oversized, MAX_RANDOM_DISTRIBUTIONS_PER_WORLD - fixtureDistributionCount + 1);
    expect(() => loadWorldScript(oversized, { modelCatalog }))
      .toThrow("catalog exceeds distribution limit");
  });

  it("rejects unknown or role-incompatible Truth and Agent model profiles", () => {
    const unknownTruth = copiedFixture();
    const truthManifest = path.join(unknownTruth, "script.yaml");
    writeFileSync(
      truthManifest,
      readFileSync(truthManifest, "utf8").replace("truth-deepseek", "missing-truth-profile"),
      "utf8",
    );
    expect(() => loadWorldScript(unknownTruth, { modelCatalog })).toThrow("unknown model profile");

    const wrongTruthRole = copiedFixture();
    const wrongRoleManifest = path.join(wrongTruthRole, "script.yaml");
    writeFileSync(
      wrongRoleManifest,
      readFileSync(wrongRoleManifest, "utf8").replace("truth-deepseek", "agent-deepseek"),
      "utf8",
    );
    expect(() => loadWorldScript(wrongTruthRole, { modelCatalog })).toThrow("does not allow role truth-perception");

    const unknownAgent = copiedFixture();
    const keeper = path.join(unknownAgent, "entities/keeper.yaml");
    writeFileSync(
      keeper,
      readFileSync(keeper, "utf8").replace("agent-deepseek", "missing-agent-profile"),
      "utf8",
    );
    expect(() => loadWorldScript(unknownAgent, { modelCatalog })).toThrow("unknown model profile");
  });
});
