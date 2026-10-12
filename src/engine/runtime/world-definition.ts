import type { DiscreteRandomDefinition, SimulationState } from "../contracts/model";
import { historyReplayBaseHash } from "./history-replay";
import type { ModelCatalog } from "../models/model-catalog";
import { validateDiscreteRandomDefinitions } from "../mechanics/random";
import type { RulePackageReference } from "../mechanics/rule-package";

export interface WorldLaw {
  id: string;
  text: string;
  severity: "hard" | "soft";
}

export interface MechanicalDisclosurePolicy {
  defaultCheckVisibility: "full" | "result_only" | "hidden";
}

export interface WorldRuntimeDefaults {
  maxAutonomousSpanSeconds: number;
  realtimeIntervalMs: number;
  actionWindowMs: number;
}

export interface WorldOrigin {
  id: string;
  title: string;
  fantasy: string;
  description: string;
  entityKind: string;
  spawnEntityId: string;
  persona: string;
  defaultGoal: string;
  relationshipHooks: string[];
  risks: string[];
  mechanicsProfileId: string;
  modelProfiles: { bootstrap: string; mind: string; reaction: string };
  image?: { hash: string; alt: string };
  fallbackArrival: string;
}

export interface WorldParticipation {
  origins: WorldOrigin[];
}

export interface WorldRuntimeContract {
  id: string;
  name: string;
  manifestVersion: string;
  description: string;
  runtimeDefaults: WorldRuntimeDefaults;
  participation: WorldParticipation | null;
  contentHash: string;
  modelProfiles: {
    perception: string;
    reactionRouting: string;
    resolution: string;
    transition: string;
    causalVerifier: string;
    grounding: string;
    observation: string;
    arrival: string;
    dynamicAgent: {
      bootstrap: string;
      mind: string;
      reaction: string;
    };
  };
  laws: WorldLaw[];
  disclosure: MechanicalDisclosurePolicy;
  rulePackages: RulePackageReference[];
  randomDistributions: DiscreteRandomDefinition[];
  historyBaseHash: string;
}

export interface WorldDefinition extends WorldRuntimeContract {
  initialState: SimulationState;
  assetData: Record<string, { mime: "image/png" | "image/webp" | "image/avif"; bytesBase64: string }>;
}

export function toWorldRuntimeContract(definition: WorldDefinition): WorldRuntimeContract {
  const contract = structuredClone(definition);
  delete (contract as Partial<WorldDefinition>).initialState;
  delete (contract as Partial<WorldDefinition>).assetData;
  return contract;
}

export function validateWorldDefinition(definition: WorldDefinition): void {
  if (!definition.id.trim() || !definition.name.trim()) throw new Error("world id and name are required");
  if (!definition.manifestVersion.trim()) throw new Error("world manifest version is required");
  for (const value of Object.values(definition.runtimeDefaults)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("world runtime defaults must be positive integers");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(definition.contentHash)) throw new Error("invalid world content hash");
  if (!/^[a-f0-9]{64}$/.test(definition.historyBaseHash) ||
    definition.historyBaseHash !== historyReplayBaseHash(definition.initialState)) {
    throw new Error("world history replay base mismatch");
  }
  if (worldModelProfileIds(definition).some((profileId) => !profileId.trim())) {
    throw new Error("world model profiles are required");
  }
  const ids = new Set<string>();
  for (const law of definition.laws) {
    if (!law.id.trim() || !law.text.trim()) throw new Error("world laws require id and text");
    if (ids.has(law.id)) throw new Error(`duplicate world law ${law.id}`);
    ids.add(law.id);
  }
  if (definition.initialState.worldId !== definition.id) {
    throw new Error("initial state world id does not match definition");
  }
  if (definition.initialState.worldHash !== definition.contentHash) {
    throw new Error("initial state world hash does not match definition");
  }
  if (definition.initialState.lawIds.length !== ids.size ||
    definition.initialState.lawIds.some((lawId) => !ids.has(lawId))) {
    throw new Error("initial state law ids do not match world definition");
  }
  if (definition.rulePackages.length === 0) throw new Error("at least one rule package is required");
  const packageIds = new Set<string>();
  for (const rulePackage of definition.rulePackages) {
    if (!rulePackage.id.trim() || !rulePackage.version.trim() || packageIds.has(rulePackage.id)) {
      throw new Error(`invalid rule package reference ${rulePackage.id}`);
    }
    packageIds.add(rulePackage.id);
  }
  const coreResolution = definition.rulePackages.find((rulePackage) => rulePackage.id === "core-resolution");
  if (coreResolution?.version !== "3.0.0") {
    throw new Error("schema v15 worlds require core-resolution@3.0.0");
  }
  validateDiscreteRandomDefinitions(definition.randomDistributions);
  if (definition.participation) {
    const origins = new Set<string>();
    for (const origin of definition.participation.origins) {
      if (origins.has(origin.id)) throw new Error(`duplicate origin ${origin.id}`);
      origins.add(origin.id);
      if (!(origin.spawnEntityId in definition.initialState.truth.entities)) {
        throw new Error(`origin ${origin.id} has unknown spawn entity ${origin.spawnEntityId}`);
      }
      if (!(origin.mechanicsProfileId in definition.initialState.truth.mechanics.entityMechanicsProfiles)) {
        throw new Error(`origin ${origin.id} has unknown mechanics profile ${origin.mechanicsProfileId}`);
      }
      if (origin.image && !(origin.image.hash in definition.assetData)) {
        throw new Error(`origin ${origin.id} has unknown image ${origin.image.hash}`);
      }
    }
  }
}

export function validateWorldModelProfiles(definition: WorldDefinition, catalog: ModelCatalog): void {
  catalog.assertProfile(definition.modelProfiles.perception, "truth-perception");
  catalog.assertProfile(definition.modelProfiles.reactionRouting, "truth-reaction-routing");
  catalog.assertProfile(definition.modelProfiles.resolution, "truth-resolution");
  catalog.assertProfile(definition.modelProfiles.transition, "truth-transition");
  catalog.assertProfile(definition.modelProfiles.causalVerifier, "causal-verifier");
  catalog.assertProfile(definition.modelProfiles.grounding, "action-compilation");
  catalog.assertProfile(definition.modelProfiles.grounding, "action-grounding");
  catalog.assertProfile(definition.modelProfiles.observation, "observation-renderer");
  catalog.assertProfile(definition.modelProfiles.arrival, "arrival-generator");
  catalog.assertProfile(definition.modelProfiles.dynamicAgent.bootstrap, "agent-bootstrap");
  catalog.assertProfile(definition.modelProfiles.dynamicAgent.mind, "agent-mind");
  catalog.assertProfile(definition.modelProfiles.dynamicAgent.reaction, "agent-reaction");
  for (const agent of Object.values(definition.initialState.agents)) {
    catalog.assertProfile(agent.modelProfiles.bootstrap, "agent-bootstrap");
    catalog.assertProfile(agent.modelProfiles.mind, "agent-mind");
    catalog.assertProfile(agent.modelProfiles.reaction, "agent-reaction");
  }
}

export function worldModelProfileIds(definition: WorldDefinition): string[] {
  return [...new Set([
    definition.modelProfiles.perception,
    definition.modelProfiles.reactionRouting,
    definition.modelProfiles.resolution,
    definition.modelProfiles.transition,
    definition.modelProfiles.causalVerifier,
    definition.modelProfiles.grounding,
    definition.modelProfiles.observation,
    definition.modelProfiles.arrival,
    ...Object.values(definition.modelProfiles.dynamicAgent),
    ...Object.values(definition.initialState.agents)
      .flatMap((agent) => Object.values(agent.modelProfiles)),
  ])].sort();
}
