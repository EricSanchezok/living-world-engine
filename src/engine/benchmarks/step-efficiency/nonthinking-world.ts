import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadModelCatalog, ModelCatalog, type ModelCatalogDocument } from "../../models/model-catalog";
import { contentHash } from "../../models/model-audit";
import { worldModelProfileIds, type WorldDefinition } from "../../runtime/world-definition";
import { loadWorldScript } from "../../../script/world-loader";
import { FLASH41_COHORT, STEP_E2_PROTOCOL } from "./nonthinking-protocol";

/** Verify every world, initial-agent and selectable player-origin profile. */
export function assertNonthinkingWorld(definition: WorldDefinition, catalog: ModelCatalog,
  expectedModel: typeof STEP_E2_PROTOCOL.model | typeof FLASH41_COHORT.model = STEP_E2_PROTOCOL.model): string[] {
  const profiles = [...new Set([...worldModelProfileIds(definition),
    ...(definition.participation?.origins.flatMap((origin) => Object.values(origin.modelProfiles)) ?? []),
  ])].sort();
  for (const id of profiles) {
    const profile = catalog.profile(id);
    if (profile.account_id !== "deepseek-api" || profile.selector.kind !== "exact" || profile.selector.model_id !== expectedModel ||
      profile.inference.thinking !== "disabled" || profile.inference.effort !== "auto") {
      throw new Error(`E2 world profile is not the frozen non-thinking model: ${id}`);
    }
  }
  return profiles;
}

/** Freeze unchanged full-world assets and explicit non-thinking profile bindings.
 * This preparation makes no provider request and never rewrites an existing save. */
export function prepareNonthinkingWorld(root: string, base: ModelCatalog = loadModelCatalog(path.resolve("config/models.yaml"))) {
  const document: ModelCatalogDocument = { schema_version: base.schemaVersion, scheduler: base.scheduler, registry: base.registry,
    accounts: structuredClone(base.accounts), profiles: structuredClone(base.profiles), model_overrides: structuredClone(base.modelOverrides) };
  document.accounts["deepseek-api"] = { ...document.accounts["deepseek-api"]!, network: {
    ...document.accounts["deepseek-api"]!.network, dns_over_https_url: "https://1.1.1.1/dns-query", socket_connect_attempts: 2 } };
  const catalog = new ModelCatalog(document);
  const source = path.resolve("worlds/blackmarsh/world"), worldsRoot = path.join(root, "worlds");
  const sourceWorld = loadWorldScript(source, { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog });
  const profiles = assertNonthinkingWorld(sourceWorld, catalog);
  if (Object.keys(sourceWorld.initialState.agents).length !== 48 || Object.keys(sourceWorld.initialState.truth.entities).length !== 232) {
    throw new Error("full-world cardinality drift");
  }
  const files = new Map<string, Buffer>(), assetHashes: Record<string, string> = {};
  const collect = (directory: string, relative: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".env" || entry.name.startsWith(".env.")) throw new Error("world snapshot refuses secret files");
      const key = path.posix.join(relative, entry.name), file = path.join(directory, entry.name);
      if (entry.isDirectory()) { collect(file, key);continue; }
      if (!entry.isFile()) throw new Error("world snapshot requires regular assets");
      const bytes = readFileSync(file);
      files.set(path.join(worldsRoot, "blackmarsh/world", key), bytes);
      assetHashes[key] = contentHash(bytes.toString("base64"));
    }
  };
  collect(source, "");
  const manifest = { id: "STEP-E2-nonthinking-world", version: 1, seed: STEP_E2_PROTOCOL.seed,
    sourceCatalogHash: base.hash, catalogHash: catalog.hash, assetHashes, worldHash: sourceWorld.contentHash,
    initialStateHash: contentHash(sourceWorld.initialState), profiles: profiles.map((id) => ({ id, profile: catalog.profile(id) })),
    allowedChanges: ["deepseek-api.network.dns_over_https_url", "deepseek-api.network.socket_connect_attempts"],
    thinking: "disabled", agents: 48, entities: 232 };
  const catalogPath = path.join(root, "model-catalog.json");
  files.set(catalogPath, Buffer.from(JSON.stringify(document, null, 2)));
  files.set(path.join(root, "variant.json"), Buffer.from(JSON.stringify(manifest, null, 2)));
  for (const [file, bytes] of files) if (existsSync(file) && !readFileSync(file).equals(bytes)) throw new Error("frozen E2 world snapshot drift");
  for (const [file, bytes] of files) {
    if (existsSync(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true });writeFileSync(file, bytes, { flag: "wx" });
  }
  const loaded = loadWorldScript(path.join(worldsRoot, "blackmarsh/world"), { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog });
  if (contentHash(loaded) !== contentHash(sourceWorld)) throw new Error("E2 snapshot changed world semantics");
  return { catalogPath, worldsRoot, manifestHash: contentHash(manifest), catalogHash: catalog.hash,
    worldHash: loaded.contentHash, initialStateHash: manifest.initialStateHash, profileIds: profiles };
}
