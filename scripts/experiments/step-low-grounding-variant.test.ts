import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { LocalDatabase } from "../../src/server/local-database";
import { installBundledWorlds } from "../../src/server/bundled-worlds";
import { LOW_GROUNDING_PROFILE, LOW_TRANSITION_PROFILE, LOW_RESOLUTION_PROFILE, LOW_OBSERVATION_PROFILE, prepareLowGroundingVariant } from "./step-low-grounding-variant";

it("imports the full isolated variant with the two explicit roles and rejects frozen asset drift", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-low-grounding-"));
  let database: LocalDatabase | undefined;
  const sourceFile = path.resolve("worlds/blackmarsh/world/script.yaml"), original = readFileSync(sourceFile);
  try {
    const variant = prepareLowGroundingVariant(root), catalog = loadModelCatalog(variant.catalogPath);
    expect(prepareLowGroundingVariant(root)).toEqual(variant);
    expect(catalog.profile(LOW_GROUNDING_PROFILE)).toMatchObject({ allowed_roles: ["action-compilation", "action-grounding"], inference: { thinking: "enabled", effort: "low" } });
    expect(catalog.profile("truth-deepseek").inference.thinking).toBe("disabled");
    database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    expect(installBundledWorlds(database, catalog, variant.worldsRoot)).toHaveLength(1);
    const world = database.load("blackmarsh", 20260906, catalog);
    expect(world.modelProfiles.grounding).toBe(LOW_GROUNDING_PROFILE);
    expect(world.modelProfiles.resolution).toBe("truth-deepseek");
    expect(Object.keys(world.initialState.agents)).toHaveLength(48);
    expect(Object.keys(world.initialState.truth.entities)).toHaveLength(232);
    expect(readFileSync(sourceFile)).toEqual(original);
    const frozen = path.join(variant.worldsRoot, "blackmarsh/world/script.yaml");
    writeFileSync(frozen, readFileSync(frozen, "utf8") + "\n# changed\n");
    expect(() => prepareLowGroundingVariant(root)).toThrow("variant drift");
  } finally { database?.close();rmSync(root, { recursive: true, force: true }); }
});

it("pins an explicit resolver override without changing model settings or world identity", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-direct-dns-"));
  try {
    const original = prepareLowGroundingVariant(path.join(root, "original"), { dnsEndpoint: "https://cloudflare-dns.com/dns-query", socketConnectAttempts: 1 });
    const direct = prepareLowGroundingVariant(path.join(root, "direct"), { dnsEndpoint: "https://1.1.1.1/dns-query", socketConnectAttempts: 2 });
    const base = loadModelCatalog(original.catalogPath), candidate = loadModelCatalog(direct.catalogPath);
    expect(candidate.profiles).toEqual(base.profiles);
    expect(candidate.accounts).toEqual({ ...base.accounts, "deepseek-api": { ...base.accounts["deepseek-api"],
      network: { ...base.accounts["deepseek-api"]!.network, dns_over_https_url: "https://1.1.1.1/dns-query", socket_connect_attempts: 2 } } });
    expect(direct.worldHash).toBe(original.worldHash);
    expect(direct.initialTruthHash).toBe(original.initialTruthHash);
    expect(direct.catalogHash).not.toBe(original.catalogHash);
    expect(() => prepareLowGroundingVariant(path.join(root, "direct"))).toThrow("variant drift");
    const invalid = JSON.parse(readFileSync(direct.catalogPath, "utf8"));
    invalid.accounts["deepseek-api"].network.socket_connect_attempts = 3;
    writeFileSync(direct.catalogPath, JSON.stringify(invalid));
    expect(() => loadModelCatalog(direct.catalogPath)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("binds low thinking only to the selected transition role in a new complete world", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-low-transition-"));
  let database: LocalDatabase | undefined;
  try {
    const base = prepareLowGroundingVariant(path.join(root, "base"));
    const candidate = prepareLowGroundingVariant(path.join(root, "candidate"), { transitionThinkingLow: true });
    const catalog = loadModelCatalog(candidate.catalogPath), baseline = loadModelCatalog(base.catalogPath);
    expect(catalog.profiles).toEqual({ ...baseline.profiles, [LOW_TRANSITION_PROFILE]: {
      ...baseline.profile("truth-deepseek"), allowed_roles: ["truth-transition"],
      inference: { ...baseline.profile("truth-deepseek").inference, thinking: "enabled", effort: "low" },
    } });
    database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    installBundledWorlds(database, catalog, candidate.worldsRoot);
    const world = database.load("blackmarsh", 20260906, catalog);
    expect(world.modelProfiles.transition).toBe(LOW_TRANSITION_PROFILE);
    expect(world.modelProfiles.resolution).toBe("truth-deepseek");
    expect(world.modelProfiles.observation).toBe("truth-deepseek");
    expect(Object.keys(world.initialState.agents)).toHaveLength(48);
    expect(Object.keys(world.initialState.truth.entities)).toHaveLength(232);
    expect(() => prepareLowGroundingVariant(path.join(root, "base"), { transitionThinkingLow: true })).toThrow("variant drift");
  } finally { database?.close();rmSync(root, { recursive: true, force: true }); }
});


it("pins low reasoning to resolution without changing verifier, perception or world semantics", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-low-resolution-"));
  try {
    const variant = prepareLowGroundingVariant(root, { transitionThinkingLow: true, resolutionThinkingLow: true });
    const catalog = loadModelCatalog(variant.catalogPath);
    expect(prepareLowGroundingVariant(root, { transitionThinkingLow: true, resolutionThinkingLow: true })).toEqual(variant);
    expect(catalog.profile(LOW_RESOLUTION_PROFILE)).toMatchObject({ allowed_roles: ["truth-resolution"],
      inference: { thinking: "enabled", effort: "low" } });
    expect(catalog.profile("truth-deepseek").inference.thinking).toBe("disabled");
    const database = new LocalDatabase(path.join(root, "game.sqlite"), { heartbeat: false });
    try {
      installBundledWorlds(database, catalog, variant.worldsRoot);
      const world = database.load("blackmarsh", 20260906, catalog);
      expect(world.modelProfiles.resolution).toBe(LOW_RESOLUTION_PROFILE);
      expect(world.modelProfiles.causalVerifier).toBe("truth-deepseek");
      expect(Object.keys(world.initialState.agents)).toHaveLength(48);
      expect(Object.keys(world.initialState.truth.entities)).toHaveLength(232);
    } finally { database.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("isolates the admitted observation profile from every other role and immutable world", () => {
  const root = mkdtempSync(path.join(tmpdir(), "step-low-observation-"));
  try {
    const options = { transitionThinkingLow: true, resolutionThinkingLow: true } as const;
    const base = prepareLowGroundingVariant(path.join(root, "base"), options);
    const candidate = prepareLowGroundingVariant(path.join(root, "candidate"), { ...options, observationThinkingLow: true });
    const baseline = loadModelCatalog(base.catalogPath), catalog = loadModelCatalog(candidate.catalogPath);
    expect(catalog.profiles).toEqual({ ...baseline.profiles, [LOW_OBSERVATION_PROFILE]: {
      ...baseline.profile("truth-deepseek"), allowed_roles: ["observation-renderer"],
      inference: { ...baseline.profile("truth-deepseek").inference, thinking: "enabled", effort: "low" },
    } });
    const database = new LocalDatabase(path.join(root, "game.sqlite"), { heartbeat: false });
    try {
      installBundledWorlds(database, catalog, candidate.worldsRoot);
      const world = database.load("blackmarsh", 20260906, catalog);
      expect(world.modelProfiles.observation).toBe(LOW_OBSERVATION_PROFILE);
      expect(world.modelProfiles.resolution).toBe(LOW_RESOLUTION_PROFILE);
      expect(world.modelProfiles.causalVerifier).toBe("truth-deepseek");
      expect(Object.keys(world.initialState.agents)).toHaveLength(48);
      expect(Object.keys(world.initialState.truth.entities)).toHaveLength(232);
    } finally { database.close(); }
    expect(() => prepareLowGroundingVariant(path.join(root, "base"), { ...options, observationThinkingLow: true })).toThrow("variant drift");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
