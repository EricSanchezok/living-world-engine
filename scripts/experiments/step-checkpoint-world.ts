import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stringify } from "yaml";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { assertNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { buildWorldDefinition, loadWorldTemplate, parseWorldTemplate, type NormalizedWorldTemplate } from "../../src/script/world-loader";

export const CHECKPOINT_PROFILE_IDS = ["momentary-action", "brief-action"] as const;

/** This is an explicit experiment-world edit, never runtime action classification. */
export function checkpointWorldTemplate(source: NormalizedWorldTemplate): NormalizedWorldTemplate {
  const candidate = structuredClone(source);
  for (const id of CHECKPOINT_PROFILE_IDS) {
    const index = candidate.mechanics.temporal_profiles.findIndex(profile => profile.id === id);
    const profile = candidate.mechanics.temporal_profiles[index];
    if (!profile || profile.kind !== "fixed" || profile.selection.evidence_requirement !== "none" ||
      profile.duration_seconds !== profile.checkpoint_seconds) throw new Error(`checkpoint source contract changed: ${id}`);
    const { duration_seconds, checkpoint_seconds, ...common } = profile;
    if (checkpoint_seconds !== duration_seconds) throw new Error("short profile has multiple scheduled stages");
    candidate.mechanics.temporal_profiles[index] = { ...common, kind: "goal", check_every_seconds: duration_seconds,
      name: `${profile.name}（进度检查）` };
    for (const calibration of candidate.mechanics.temporal_calibrations.filter(value => value.profile_id === id)) {
      calibration.explanation = `在 ${duration_seconds} 秒边界检查进度；整个原始行动已有充分状态和效果支持时才完成，否则继续、受阻或失败。边界本身不是完成证明。`;
    }
  }
  const validated = parseWorldTemplate(candidate), restored = structuredClone(validated);
  for (const id of CHECKPOINT_PROFILE_IDS) {
    const index = restored.mechanics.temporal_profiles.findIndex(profile => profile.id === id);
    restored.mechanics.temporal_profiles[index] = structuredClone(source.mechanics.temporal_profiles.find(profile => profile.id === id)!);
  }
  restored.mechanics.temporal_calibrations = structuredClone(source.mechanics.temporal_calibrations);
  if (contentHash(restored) !== contentHash(source)) throw new Error("checkpoint experiment changed unrelated world semantics");
  return validated;
}

export function prepareCheckpointWorld(options: { sourceRoot?: string; destination?: string } = {}) {
  const root = path.resolve(STEP_E2_PROTOCOL.root);
  const sourceRoot = options.sourceRoot ?? path.join(root, "variants/finite-work-goal-02");
  const destination = options.destination ?? path.join(root, "variants/short-action-checkpoints-01");
  const sourceDirectory = path.join(sourceRoot, "worlds/blackmarsh/world");
  const template = loadWorldTemplate(sourceDirectory), candidate = checkpointWorldTemplate(template);
  const catalogPath = path.join(sourceRoot, "model-catalog.json"), catalog = loadModelCatalog(catalogPath);
  const baseline = buildWorldDefinition(template, { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog });
  const world = buildWorldDefinition(candidate, { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog });
  assertNonthinkingWorld(baseline, catalog); assertNonthinkingWorld(world, catalog);
  if (Object.keys(world.initialState.agents).length !== 48 || Object.keys(world.initialState.truth.entities).length !== 232 ||
    contentHash(world.initialState.agents) !== contentHash(baseline.initialState.agents)) throw new Error("complete source world changed");
  const files = new Map<string, Buffer>(), sourceHashes: Record<string, string> = {}, candidateHashes: Record<string, string> = {};
  const collect = (directory: string, relative: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === ".env" || entry.name.startsWith(".env.")) throw new Error("world collection refuses secret files");
      const key = path.posix.join(relative, entry.name), absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) { collect(absolute, key); continue; }
      if (!entry.isFile()) throw new Error("world assets must be regular files");
      const bytes = readFileSync(absolute), changed = key === "mechanics.yaml" ? Buffer.from(stringify(candidate.mechanics)) : bytes;
      sourceHashes[key] = contentHash(bytes.toString("base64")); candidateHashes[key] = contentHash(changed.toString("base64"));
      files.set(path.join(destination, "worlds/blackmarsh/world", key), changed);
    }
  };
  collect(sourceDirectory, "");
  files.set(path.join(destination, "model-catalog.json"), readFileSync(catalogPath));
  const manifest = { id: "STEP-E2-short-action-checkpoints-01", paidHttp: 0, runtimePromoted: false,
    seed: STEP_E2_PROTOCOL.seed, model: STEP_E2_PROTOCOL.model, thinking: "disabled", catalogHash: catalog.hash,
    sourceWorldHash: baseline.contentHash, worldHash: world.contentHash, sourceTemplateHash: contentHash(template),
    templateHash: contentHash(candidate), initialStateHash: contentHash(world.initialState), sourceHashes, candidateHashes,
    agents: 48, entities: 232, changedProfiles: CHECKPOINT_PROFILE_IDS,
    contract: "Only the two explicitly named generic short profiles and their calibration explanations change. Their existing1/10-second boundaries become goal checkpoints. Explicit durations, rates, stages, continuation prerequisites, resources and every source action retain their contracts. Existing outcome adjudication owns completion; no kernel-inferred meaning or new online model call. This does not certify semantics or cost: spurious completion, endless no-effect continuation and extra checkpoint calls remain vetoes. No failed indexed planning trial is promoted by this preparation." };
  files.set(path.join(destination, "manifest.json"), Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  for (const [file, bytes] of files) if (existsSync(file) && !readFileSync(file).equals(bytes)) throw new Error("frozen checkpoint world changed");
  for (const [file, bytes] of files) {
    if (existsSync(file)) continue;
    mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, bytes, { flag: "wx" });
  }
  if (contentHash(loadWorldTemplate(path.join(destination, "worlds/blackmarsh/world"))) !== contentHash(candidate)) throw new Error("persisted checkpoint world differs");
  return { destination, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error("usage: step-checkpoint-world.ts (offline preparation only)");
  console.log(JSON.stringify(prepareCheckpointWorld(), null, 2));
}
