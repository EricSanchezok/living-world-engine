import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { mechanicsFileSchema } from "../../src/script/contract";
import { parseWorldTemplate, type NormalizedWorldTemplate } from "../../src/script/world-loader";
import { contentHash } from "../../src/engine/models/model-audit";

const fragmentSchema = mechanicsFileSchema.pick({ temporal_profiles: true, temporal_profile_coverage: true, temporal_calibrations: true }).strict();
const fragment = () => fragmentSchema.parse(parse(readFileSync(new URL("./world-fragments/finite-work-goal.yaml", import.meta.url), "utf8")));

/** Require the complete authored prerequisite rather than inferring it from a world hash. */
export function assertFiniteWorkWorld(source: NormalizedWorldTemplate): void {
  const expected = fragment();
  for (const profile of expected.temporal_profiles) {
    if (contentHash(source.mechanics.temporal_profiles.find(value => value.id === profile.id) ?? null) !== contentHash(profile)) {
      throw new Error(`finite-work experiment requires its exact authored profile: ${profile.id}`);
    }
  }
  for (const tag of expected.temporal_profile_coverage.required_semantic_tags) {
    if (!source.mechanics.temporal_profile_coverage.required_semantic_tags.includes(tag)) throw new Error(`finite-work experiment missing coverage: ${tag}`);
  }
  for (const calibration of expected.temporal_calibrations) {
    if (contentHash(source.mechanics.temporal_calibrations.find(value => value.id === calibration.id) ?? null) !== contentHash(calibration)) {
      throw new Error(`finite-work experiment missing or changed calibration: ${calibration.id}`);
    }
  }
}

/** Apply only the explicit script fragment; every source action and other world field survives. */
export function finiteWorkWorldTemplate(source: NormalizedWorldTemplate): NormalizedWorldTemplate {
  const addition = fragment();
  const profileIds = new Set(addition.temporal_profiles.map(profile => profile.id));
  const calibrationIds = new Set(addition.temporal_calibrations.map(calibration => calibration.id));
  if (source.mechanics.temporal_profiles.some(profile => profileIds.has(profile.id)) ||
    source.mechanics.temporal_calibrations.some(calibration => calibrationIds.has(calibration.id)) ||
    addition.temporal_profile_coverage.required_semantic_tags.some(tag => source.mechanics.temporal_profile_coverage.required_semantic_tags.includes(tag))) {
    throw new Error("finite-work fragment collides with source world");
  }
  const candidate = structuredClone(source);
  candidate.mechanics.temporal_profiles.push(...addition.temporal_profiles);
  candidate.mechanics.temporal_calibrations.push(...addition.temporal_calibrations);
  candidate.mechanics.temporal_profile_coverage.required_semantic_tags.push(...addition.temporal_profile_coverage.required_semantic_tags);
  const validated = parseWorldTemplate(candidate);
  assertFiniteWorkWorld(validated);
  const restored = structuredClone(validated);
  restored.mechanics.temporal_profiles = restored.mechanics.temporal_profiles.filter(profile => !profileIds.has(profile.id));
  restored.mechanics.temporal_calibrations = restored.mechanics.temporal_calibrations.filter(calibration => !calibrationIds.has(calibration.id));
  restored.mechanics.temporal_profile_coverage = structuredClone(source.mechanics.temporal_profile_coverage);
  if (contentHash(restored) !== contentHash(source)) throw new Error("finite-work fragment changed unrelated source fields");
  return validated;
}
