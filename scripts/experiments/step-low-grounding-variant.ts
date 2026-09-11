import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog, ModelCatalog, type ModelCatalogDocument } from "../../src/engine/models/model-catalog";
import { loadWorldScript, loadWorldTemplate } from "../../src/script/world-loader";

export const LOW_GROUNDING_PROFILE = "truth-deepseek-low-grounding";
export const LOW_TRANSITION_PROFILE = "truth-deepseek-low-transition";
export const LOW_RESOLUTION_PROFILE = "truth-deepseek-low-resolution";
export const LOW_OBSERVATION_PROFILE = "truth-deepseek-low-observation";

/** Prepare a separately persisted full world; source assets and defaults stay intact. */
export function prepareLowGroundingVariant(root: string, options: { dnsEndpoint?: string; socketConnectAttempts?: 1 | 2; transitionThinkingLow?: true; resolutionThinkingLow?: true; observationThinkingLow?: true } = {}) {
  const base = loadModelCatalog(path.resolve("config/models.yaml"));
  const profile = base.profile("truth-deepseek");
  const accounts = { ...structuredClone(base.accounts) };
  if (options.dnsEndpoint || options.socketConnectAttempts) accounts["deepseek-api"] = { ...accounts["deepseek-api"]!,
    network: { ...accounts["deepseek-api"]!.network,
      ...(options.dnsEndpoint ? { dns_over_https_url: options.dnsEndpoint } : {}),
      ...(options.socketConnectAttempts ? { socket_connect_attempts: options.socketConnectAttempts } : {}) } };
  const document = { schema_version: base.schemaVersion, scheduler: base.scheduler, registry: base.registry,
    accounts, profiles: { ...base.profiles, [LOW_GROUNDING_PROFILE]: { ...profile,
      allowed_roles: ["action-compilation", "action-grounding"], inference: { ...profile.inference, thinking: "enabled", effort: "low" } },
      ...(options.transitionThinkingLow ? { [LOW_TRANSITION_PROFILE]: { ...profile,
        allowed_roles: ["truth-transition"], inference: { ...profile.inference, thinking: "enabled", effort: "low" } } } : {}),
      ...(options.resolutionThinkingLow ? { [LOW_RESOLUTION_PROFILE]: { ...profile,
        allowed_roles: ["truth-resolution"], inference: { ...profile.inference, thinking: "enabled", effort: "low" } } } : {}),
      ...(options.observationThinkingLow ? { [LOW_OBSERVATION_PROFILE]: { ...profile,
        allowed_roles: ["observation-renderer"], inference: { ...profile.inference, thinking: "enabled", effort: "low" } } } : {}) },
    model_overrides: base.modelOverrides } as ModelCatalogDocument;
  const catalog = new ModelCatalog(document);
  const source = path.resolve("worlds/blackmarsh/world");
  const worldsRoot = path.join(root, "worlds"), worldDirectory = path.join(worldsRoot, "blackmarsh/world");
  const sourceHashes: Record<string, string> = {}, candidateHashes: Record<string, string> = {};
  const files = new Map<string, Buffer>();
  const collect = (directory: string, relative: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".env" || entry.name.startsWith(".env.")) throw new Error("world asset collection refuses secret files");
      const key = path.posix.join(relative, entry.name), absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { collect(absolute, key);continue; }
      if (!entry.isFile()) throw new Error("world asset must be a regular file");
      const original = readFileSync(absolute);
      let candidate = original;
      if (key === "script.yaml") {
        const text = original.toString("utf8"), marker = "  grounding: truth-deepseek\n";
        if (text.split(marker).length !== 2) throw new Error("bundled grounding profile binding drift");
        candidate = Buffer.from(text.replace(marker, `  grounding: ${LOW_GROUNDING_PROFILE}\n`));
        if (options.transitionThinkingLow) {
          const transitionMarker = "  transition: truth-deepseek\n";
          if (text.split(transitionMarker).length !== 2) throw new Error("bundled transition profile binding drift");
          candidate = Buffer.from(candidate.toString("utf8").replace(transitionMarker, `  transition: ${LOW_TRANSITION_PROFILE}\n`));
        }
        if (options.resolutionThinkingLow) {
          const resolutionMarker = "  resolution: truth-deepseek\n";
          if (text.split(resolutionMarker).length !== 2) throw new Error("bundled resolution profile binding drift");
          candidate = Buffer.from(candidate.toString("utf8").replace(resolutionMarker, `  resolution: ${LOW_RESOLUTION_PROFILE}\n`));
        }
        if (options.observationThinkingLow) {
          const observationMarker = "  observation: truth-deepseek\n";
          if (text.split(observationMarker).length !== 2) throw new Error("bundled observation profile binding drift");
          candidate = Buffer.from(candidate.toString("utf8").replace(observationMarker, `  observation: ${LOW_OBSERVATION_PROFILE}\n`));
        }
      }
      sourceHashes[key] = contentHash(original.toString("base64"));
      candidateHashes[key] = contentHash(candidate.toString("base64"));
      files.set(path.join(worldDirectory, key), candidate);
    }
  };
  collect(source, "");
  const catalogPath = path.join(root, "model-catalog.json");
  files.set(catalogPath, Buffer.from(JSON.stringify(document, null, 2)));
  const manifest = { version: 1, profileId: LOW_GROUNDING_PROFILE, roles: ["action-compilation", "action-grounding"],
    sourceCatalogHash: base.hash, catalogHash: catalog.hash, sourceHashes, candidateHashes,
    ...(options.dnsEndpoint || options.socketConnectAttempts ? { accountNetworkOverride: {
      accountId: "deepseek-api", ...(options.dnsEndpoint ? { dnsEndpoint: options.dnsEndpoint } : {}),
      ...(options.socketConnectAttempts ? { socketConnectAttempts: options.socketConnectAttempts } : {}) } } : {}),
    ...(options.transitionThinkingLow ? { transitionProfileId: LOW_TRANSITION_PROFILE, additionalRoles: ["truth-transition"] } : {}),
    ...(options.resolutionThinkingLow ? { resolutionProfileId: LOW_RESOLUTION_PROFILE, resolutionRoles: ["truth-resolution"] } : {}),
    ...(options.observationThinkingLow ? { observationProfileId: LOW_OBSERVATION_PROFILE, observationRoles: ["observation-renderer"] } : {}),
    allowedWorldChanges: ["script.yaml:model_profiles.grounding", ...(options.transitionThinkingLow ? ["script.yaml:model_profiles.transition"] : []),
      ...(options.resolutionThinkingLow ? ["script.yaml:model_profiles.resolution"] : []),
      ...(options.observationThinkingLow ? ["script.yaml:model_profiles.observation"] : [])] };
  files.set(path.join(root, "variant.json"), Buffer.from(JSON.stringify(manifest, null, 2)));
  for (const [file, contents] of files) {
    if (existsSync(file) && !readFileSync(file).equals(contents)) throw new Error("frozen low-grounding variant drift");
  }
  for (const [file, contents] of files) {
    if (existsSync(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true });writeFileSync(file, contents, { flag: "wx" });
  }
  const baseline = loadWorldScript(source, { seed: 20260906, modelCatalog: base });
  const candidate = loadWorldScript(worldDirectory, { seed: 20260906, modelCatalog: catalog });
  const restoredTemplate = loadWorldTemplate(worldDirectory);
  restoredTemplate.manifest.model_profiles.grounding = "truth-deepseek";
  if (options.transitionThinkingLow) restoredTemplate.manifest.model_profiles.transition = "truth-deepseek";
  if (options.resolutionThinkingLow) restoredTemplate.manifest.model_profiles.resolution = "truth-deepseek";
  if (options.observationThinkingLow) restoredTemplate.manifest.model_profiles.observation = "truth-deepseek";
  // The new world hash legitimately changes seed provenance and derived resource IDs.
  // Compare all template semantics after undoing only the declared profile binding.
  if (candidate.modelProfiles.grounding !== LOW_GROUNDING_PROFILE ||
    candidate.modelProfiles.resolution !== (options.resolutionThinkingLow ? LOW_RESOLUTION_PROFILE : "truth-deepseek") ||
    candidate.modelProfiles.transition !== (options.transitionThinkingLow ? LOW_TRANSITION_PROFILE : "truth-deepseek") ||
    candidate.modelProfiles.observation !== (options.observationThinkingLow ? LOW_OBSERVATION_PROFILE : "truth-deepseek") ||
    contentHash(restoredTemplate) !== contentHash(loadWorldTemplate(source)) ||
    contentHash(candidate.initialState.agents) !== contentHash(baseline.initialState.agents)) throw new Error("variant changed initial world state");
  return { catalogPath, worldsRoot, manifestHash: contentHash(manifest), catalogHash: catalog.hash,
    sourceCatalogHash: base.hash, initialTruthHash: contentHash(candidate.initialState.truth),
    baselineTruthHash: contentHash(baseline.initialState.truth), worldHash: candidate.contentHash,
    profileId: LOW_GROUNDING_PROFILE, roles: manifest.roles,
    ...(options.transitionThinkingLow ? { transitionProfileId: LOW_TRANSITION_PROFILE } : {}),
    ...(options.resolutionThinkingLow ? { resolutionProfileId: LOW_RESOLUTION_PROFILE } : {}),
    ...(options.observationThinkingLow ? { observationProfileId: LOW_OBSERVATION_PROFILE } : {}) };
}
