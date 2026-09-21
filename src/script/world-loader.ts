import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  AgentBeliefState,
  AgentCharacterState,
  AgentState,
  DiscreteRandomDefinition,
  MechanicsCatalog,
  SimulationState,
} from "../engine/contracts/model";
import { historyReplayBaseHash } from "../engine/runtime/history-replay";
import { createSeededRng, validateDiscreteRandomDefinitions } from "../engine/mechanics/random";
import { validateImpactProfile } from "../engine/mechanics/resolution";
import { validateTemporalProfile, type TemporalProfileDefinition } from "../engine/mechanics/temporal";
import { quantityId } from "../engine/runtime/runtime-id";
import { sharedActivityResourcePoolId } from "../engine/runtime/runtime-id";
import {
  validateSharedActivityResourceDefinition,
  type SharedActivityResourceDefinition,
} from "../engine/mechanics/shared-activity-resources";
import { createCoreRulePackageRegistry, type RulePackageRegistry } from "../engine/mechanics/rule-package";
import { validateSimulationState } from "../engine/runtime/transaction";
import type { WorldDefinition } from "../engine/runtime/world-definition";
import { validateWorldDefinition, validateWorldModelProfiles } from "../engine/runtime/world-definition";
import type { ModelCatalog } from "../engine/models/model-catalog";
import { canonicalize, contentHash } from "../engine/models/model-audit";
import {
  entityDocumentSchema,
  lawsFileSchema,
  mechanicsFileSchema,
  participationFileSchema,
  scriptManifestSchema,
  type EntityDocument,
  type LawsDocument,
  type MechanicsDocument,
  type ParticipationDocument,
  type ScriptManifestDocument,
} from "./contract";
import {
  inspectImageAsset,
  MAX_WORLD_ASSET_TOTAL_BYTES,
  type InspectedImageAsset,
} from "./image-asset";

export class WorldScriptError extends Error {
  constructor(readonly file: string, message: string) {
    super(`${file}: ${message}`);
    this.name = "WorldScriptError";
  }
}

function readYaml(file: string): unknown {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new WorldScriptError(file, "required file is missing");
  }
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new WorldScriptError(file, error instanceof Error ? error.message : String(error));
  }
}

function parseDocument<T>(
  file: string,
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { message: string } } },
): T {
  const parsed = schema.safeParse(readYaml(file));
  if (!parsed.success) throw new WorldScriptError(file, parsed.error.message);
  return parsed.data;
}

function uniqueRecord<T extends { id: string }>(entries: T[], label: string): Record<string, T> {
  const result: Record<string, T> = {};
  for (const entry of entries) {
    if (result[entry.id]) throw new Error(`duplicate ${label} id ${entry.id}`);
    result[entry.id] = entry;
  }
  return result;
}

function mechanicsCatalog(document: MechanicsDocument): MechanicsCatalog {
  for (const meter of document.meters) {
    if (meter.max <= meter.min) throw new Error(`meter ${meter.id} requires max > min`);
    for (const threshold of meter.thresholds) {
      if (threshold.when.value < meter.min || threshold.when.value > meter.max) {
        throw new Error(`meter threshold ${threshold.id} is outside ${meter.id} range`);
      }
    }
  }
  for (const rating of document.ratings) {
    if (rating.max < rating.min) throw new Error(`rating ${rating.id} requires max >= min`);
  }
  const impactProfiles = document.impact_profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    meterDefinitionId: profile.meter_definition_id,
    direction: profile.direction,
    amounts: structuredClone(profile.amounts),
  }));
  for (const profile of impactProfiles) validateImpactProfile(profile);
  const durationProfiles = document.duration_profiles.map((profile) => structuredClone(profile));
  const activityResources = document.activity_resources.map((resource) => ({
    id: resource.id,
    name: resource.name,
    capacity: resource.capacity,
  }));
  const activityResourceRecord = uniqueRecord(activityResources, "activity resource");
  const sharedActivityResources = document.shared_activity_resources.map((resource): SharedActivityResourceDefinition => ({
    id: resource.id,
    name: resource.name,
    unit: resource.unit,
    defaultClaimAmount: resource.default_claim_amount,
    allowExplicitAmount: resource.allow_explicit_amount,
    contention: resource.contention,
    pausedRetention: resource.paused_retention,
  }));
  const sharedActivityResourceRecord = uniqueRecord(sharedActivityResources, "shared activity resource");
  sharedActivityResources.forEach(validateSharedActivityResourceDefinition);
  const temporalProfiles = document.temporal_profiles.map((profile): TemporalProfileDefinition => {
    const base = {
      id: profile.id,
      name: profile.name,
      interruptible: profile.interruptible,
      reactionFallback: profile.reaction_fallback,
      selection: {
        semanticTags: [...profile.selection.semantic_tags],
        evidenceRequirement: profile.selection.evidence_requirement,
      },
      resourceClaims: profile.resource_claims.map((claim) => ({
        resourceId: claim.resource_id,
        amount: claim.amount,
      })),
    };
    if (profile.kind === "fixed") return {
      ...base,
      kind: profile.kind,
      durationSeconds: profile.duration_seconds,
      checkpointSeconds: profile.checkpoint_seconds,
    };
    if (profile.kind === "rate") return {
      ...base,
      kind: profile.kind,
      unit: profile.unit,
      unitAliases: [...profile.unit_aliases],
      unitsPerPeriod: profile.units_per_period,
      periodSeconds: profile.period_seconds,
      checkpointUnits: profile.checkpoint_units,
    };
    if (profile.kind === "staged") return {
      ...base,
      kind: profile.kind,
      stages: profile.stages.map((stage) => ({
        id: stage.id,
        name: stage.name,
        durationSeconds: stage.duration_seconds,
        checkpointSeconds: stage.checkpoint_seconds,
      })),
    };
    if (profile.kind === "conditional" || profile.kind === "goal") return {
      ...base,
      kind: profile.kind,
      checkEverySeconds: profile.check_every_seconds,
    };
    return { ...base, kind: profile.kind, checkpointSeconds: profile.checkpoint_seconds };
  });
  const temporalProfileRecord = uniqueRecord(temporalProfiles, "temporal profile");
  for (const profile of temporalProfiles) validateTemporalProfile(profile, activityResourceRecord);
  const requiredTemporalTags = document.temporal_profile_coverage.required_semantic_tags;
  if (new Set(requiredTemporalTags).size !== requiredTemporalTags.length) {
    throw new Error("temporal profile coverage repeats a semantic tag");
  }
  const coveredTemporalTags = new Set(temporalProfiles.flatMap((profile) => profile.selection.semanticTags));
  for (const tag of requiredTemporalTags) {
    if (!coveredTemporalTags.has(tag)) throw new Error(`temporal profile coverage is missing semantic tag ${tag}`);
  }
  const conditionProfiles = document.condition_profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    stackingKey: profile.stacking_key,
    defaultDurationProfileId: profile.default_duration_profile_id,
    recurringImpactProfileId: profile.recurring_impact_profile_id,
    recovery: profile.recovery,
    thresholds: structuredClone(profile.thresholds),
  }));
  const entityMechanicsProfiles = document.entity_mechanics_profiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    meters: profile.meters.map((entry) => ({ definitionId: entry.definition_id, current: entry.current })),
    quantities: profile.quantities.map((entry) => ({ definitionId: entry.definition_id, amount: entry.amount })),
    ratings: profile.ratings.map((entry) => ({ definitionId: entry.definition_id, value: entry.value })),
  }));
  const catalog: MechanicsCatalog = {
    meters: uniqueRecord(document.meters, "meter"),
    quantities: uniqueRecord(
      document.quantities.map((quantity) => ({
        id: quantity.id,
        name: quantity.name,
        unit: quantity.unit,
        productionLawIds: quantity.production_law_ids,
        consumptionLawIds: quantity.consumption_law_ids,
      })),
      "quantity",
    ),
    ratings: uniqueRecord(document.ratings, "rating"),
    impactProfiles: uniqueRecord(impactProfiles, "impact profile"),
    durationProfiles: uniqueRecord(durationProfiles, "duration profile"),
    conditionProfiles: uniqueRecord(conditionProfiles, "condition profile"),
    entityMechanicsProfiles: uniqueRecord(entityMechanicsProfiles, "entity mechanics profile"),
    adjudicationCalibrations: document.adjudication_calibrations.map((calibration) => ({
      id: calibration.id,
      situation: calibration.situation,
      difficulty: calibration.difficulty,
      risk: calibration.risk,
      effect: calibration.effect,
      explanation: calibration.explanation,
    })),
    activityResources: activityResourceRecord,
    sharedActivityResources: sharedActivityResourceRecord,
    temporalProfiles: temporalProfileRecord,
    temporalCalibrations: document.temporal_calibrations.map((calibration) => ({
      id: calibration.id,
      situation: calibration.situation,
      profileId: calibration.profile_id,
      explanation: calibration.explanation,
    })),
  };
  const calibrationIds = catalog.adjudicationCalibrations.map((calibration) => calibration.id);
  if (new Set(calibrationIds).size !== calibrationIds.length) throw new Error("duplicate adjudication calibration id");
  const temporalCalibrationIds = catalog.temporalCalibrations.map((calibration) => calibration.id);
  if (new Set(temporalCalibrationIds).size !== temporalCalibrationIds.length) {
    throw new Error("duplicate temporal calibration id");
  }
  for (const calibration of catalog.temporalCalibrations) {
    if (!catalog.temporalProfiles[calibration.profileId]) {
      throw new Error(`temporal calibration ${calibration.id} has unknown profile ${calibration.profileId}`);
    }
  }
  for (const profile of Object.values(catalog.impactProfiles)) {
    if (!catalog.meters[profile.meterDefinitionId]) {
      throw new Error(`impact profile ${profile.id} has unknown meter ${profile.meterDefinitionId}`);
    }
  }
  for (const profile of Object.values(catalog.conditionProfiles)) {
    if (!catalog.durationProfiles[profile.defaultDurationProfileId]) {
      throw new Error(`condition profile ${profile.id} has unknown duration ${profile.defaultDurationProfileId}`);
    }
    if (profile.recurringImpactProfileId && !catalog.impactProfiles[profile.recurringImpactProfileId]) {
      throw new Error(`condition profile ${profile.id} has unknown recurring impact ${profile.recurringImpactProfileId}`);
    }
  }
  for (const profile of Object.values(catalog.entityMechanicsProfiles)) {
    const meterIds = profile.meters.map((entry) => entry.definitionId);
    const quantityIds = profile.quantities.map((entry) => entry.definitionId);
    const ratingIds = profile.ratings.map((entry) => entry.definitionId);
    if (new Set(meterIds).size !== meterIds.length || new Set(quantityIds).size !== quantityIds.length ||
      new Set(ratingIds).size !== ratingIds.length) throw new Error(`mechanics profile ${profile.id} repeats a definition`);
    for (const entry of profile.meters) {
      const definition = catalog.meters[entry.definitionId];
      if (!definition || entry.current < definition.min || entry.current > definition.max) {
        throw new Error(`mechanics profile ${profile.id} has invalid meter ${entry.definitionId}`);
      }
    }
    for (const entry of profile.quantities) {
      if (!catalog.quantities[entry.definitionId]) {
        throw new Error(`mechanics profile ${profile.id} has unknown quantity ${entry.definitionId}`);
      }
    }
    for (const entry of profile.ratings) {
      const definition = catalog.ratings[entry.definitionId];
      if (!definition || entry.value < definition.min || entry.value > definition.max) {
        throw new Error(`mechanics profile ${profile.id} has invalid rating ${entry.definitionId}`);
      }
    }
  }
  return catalog;
}

function randomDistributions(document: MechanicsDocument): DiscreteRandomDefinition[] {
  const definitions = document.random_distributions.map((distribution) => ({
    id: distribution.id,
    description: distribution.description,
    steps: distribution.steps.map((step) => ({
      id: step.id,
      count: step.count,
      outcomes: structuredClone(step.outcomes),
      aggregate: step.aggregate,
      when: step.when ? { stepId: step.when.step_id, equals: structuredClone(step.when.equals) } : null,
    })),
  }));
  validateDiscreteRandomDefinitions(definitions);
  return definitions;
}

function beliefFrom(document: EntityDocument["agent"]): AgentBeliefState {
  if (!document) return { localEntities: {}, claims: {}, evidence: {} };
  return {
    localEntities: uniqueRecord(document.belief.local_entities, "local entity"),
    claims: uniqueRecord(document.belief.claims, "belief claim"),
    evidence: uniqueRecord(document.belief.evidence, "belief evidence"),
  };
}

function characterFrom(document: NonNullable<EntityDocument["agent"]>): AgentCharacterState {
  const atStepZero = <T extends { id: string; evidence_ids: string[] }>({ evidence_ids, ...entry }: T) => ({
    ...entry,
    evidenceIds: evidence_ids,
    createdAtStep: 0,
    updatedAtStep: 0,
  });
  return {
    persona: {
      summary: document.character.persona.summary,
      voice: document.character.persona.voice,
      updatedAtStep: 0,
      evidenceIds: document.character.persona.evidence_ids,
    },
    traits: uniqueRecord(document.character.traits.map(atStepZero), "trait"),
    values: uniqueRecord(document.character.values.map(atStepZero), "value"),
    emotions: uniqueRecord(document.character.emotions.map(atStepZero), "emotion"),
    attitudes: uniqueRecord(document.character.attitudes.map((entry) => {
      const { subject_id, ...attitude } = atStepZero(entry);
      return { ...attitude, subjectId: subject_id };
    }), "attitude"),
    goals: uniqueRecord(document.character.goals.map((entry) => {
      const {
        target_ids,
        parent_goal_id,
        motivated_by_ids,
        ...goal
      } = atStepZero(entry);
      return {
        ...goal,
        targetIds: target_ids,
        parentGoalId: parent_goal_id,
        motivatedByIds: motivated_by_ids,
      };
    }), "goal"),
    commitments: uniqueRecord(document.character.commitments.map((entry) => {
      const { subject_ids, ...commitment } = atStepZero(entry);
      return { ...commitment, subjectIds: subject_ids };
    }), "commitment"),
  };
}

function agentFrom(document: EntityDocument): AgentState | undefined {
  if (!document.agent) return undefined;
  return {
    id: document.agent.id,
    entityId: document.id,
    modelProfiles: {
      bootstrap: document.agent.model_profiles.bootstrap,
      mind: document.agent.model_profiles.mind,
      reaction: document.agent.model_profiles.reaction,
    },
    character: characterFrom(document.agent),
    belief: beliefFrom(document.agent),
    bindings: Object.fromEntries(
      document.agent.belief.bindings.map((binding) => [
        binding.local_entity_id,
        {
          localEntityId: binding.local_entity_id,
          canonicalEntityIds: binding.canonical_entity_ids,
        },
      ]),
    ),
    observationCursorStep: 0,
    nextAction: null,
  };
}

function entityFiles(scriptDir: string): string[] {
  const directory = path.join(scriptDir, "entities");
  if (!existsSync(directory) || !statSync(directory).isDirectory()) {
    throw new WorldScriptError(directory, "entities directory is missing");
  }
  return readdirSync(directory)
    .filter((name) => name.endsWith(".yaml") || name.endsWith(".yml"))
    .sort()
    .map((name) => path.join(directory, name));
}

interface NormalizedImageAsset extends InspectedImageAsset {
  path: string;
  bytesBase64: string;
}

function assetFiles(scriptDir: string): string[] {
  const root = path.join(scriptDir, "assets");
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink()) throw new WorldScriptError(absolute, "symbolic links are not allowed");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(absolute);
      else throw new WorldScriptError(absolute, "assets may contain regular files only");
    }
  };
  visit(root);
  return files.sort();
}

function loadAssets(scriptDir: string): NormalizedImageAsset[] {
  let total = 0;
  return assetFiles(scriptDir).map((file) => {
    const bytes = readFileSync(file);
    total += bytes.byteLength;
    if (total > MAX_WORLD_ASSET_TOTAL_BYTES) {
      throw new WorldScriptError(file, "world assets exceed 32 MiB in total");
    }
    try {
      return {
        path: path.relative(path.join(scriptDir, "assets"), file).split(path.sep).join("/"),
        ...inspectImageAsset(bytes),
        bytesBase64: bytes.toString("base64"),
      };
    } catch (error) {
      throw new WorldScriptError(file, error instanceof Error ? error.message : String(error));
    }
  });
}

export function validateWorldScriptLayout(scriptDir: string): void {
  const root = path.resolve(scriptDir);
  const rootFiles = new Set(["script.yaml", "laws.yaml", "mechanics.yaml", "participation.yaml"]);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const stats = lstatSync(absolute);
    if (stats.isSymbolicLink()) throw new WorldScriptError(absolute, "symbolic links are not allowed");
    if (entry.isDirectory()) {
      if (entry.name !== "entities" && entry.name !== "assets") throw new WorldScriptError(absolute, "unexpected directory");
      if (entry.name === "assets") {
        assetFiles(root);
        continue;
      }
      for (const entityEntry of readdirSync(absolute, { withFileTypes: true })) {
        const entityFile = path.join(absolute, entityEntry.name);
        if (!entityEntry.isFile() || !/\.ya?ml$/.test(entityEntry.name)) {
          throw new WorldScriptError(entityFile, "entities may contain YAML files only");
        }
      }
      continue;
    }
    if (!entry.isFile() || !rootFiles.has(entry.name)) {
      throw new WorldScriptError(absolute, "unexpected world script file");
    }
  }
}

export interface LoadWorldScriptOptions {
  modelCatalog: ModelCatalog;
  seed?: number;
  rulePackages?: RulePackageRegistry;
}

export interface NormalizedWorldTemplate {
  manifest: ScriptManifestDocument;
  laws: LawsDocument;
  mechanics: MechanicsDocument;
  entities: EntityDocument[];
  participation: ParticipationDocument | null;
  assets: NormalizedImageAsset[];
}

const normalizedWorldTemplateSchema = z.strictObject({
  manifest: scriptManifestSchema,
  laws: lawsFileSchema,
  mechanics: mechanicsFileSchema,
  entities: z.array(entityDocumentSchema).min(1),
  participation: participationFileSchema.nullable(),
  assets: z.array(z.strictObject({
    path: z.string().min(1),
    hash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mime: z.enum(["image/png", "image/webp", "image/avif"]),
    width: z.number().int().min(1).max(4096),
    height: z.number().int().min(1).max(4096),
    bytesBase64: z.string().min(1),
  })),
});

export function parseWorldTemplate(value: unknown): NormalizedWorldTemplate {
  const template = normalizedWorldTemplateSchema.parse(value);
  template.entities.sort((left, right) => left.id.localeCompare(right.id));
  template.assets.sort((left, right) => left.path.localeCompare(right.path));
  return template;
}

export function hashWorldTemplate(template: NormalizedWorldTemplate): string {
  return `sha256:${contentHash(canonicalize(template))}`;
}

export function loadWorldTemplate(scriptDir: string): NormalizedWorldTemplate {
  const root = path.resolve(scriptDir);
  validateWorldScriptLayout(root);
  const entities = entityFiles(root)
    .map((file) => parseDocument(file, entityDocumentSchema))
    .sort((left, right) => left.id.localeCompare(right.id));
  if (entities.length === 0) {
    throw new WorldScriptError(path.join(root, "entities"), "at least one entity is required");
  }
  return parseWorldTemplate({
    manifest: parseDocument(path.join(root, "script.yaml"), scriptManifestSchema),
    laws: parseDocument(path.join(root, "laws.yaml"), lawsFileSchema),
    mechanics: parseDocument(path.join(root, "mechanics.yaml"), mechanicsFileSchema),
    entities,
    participation: existsSync(path.join(root, "participation.yaml"))
      ? parseDocument(path.join(root, "participation.yaml"), participationFileSchema)
      : null,
    assets: loadAssets(root),
  });
}

export function buildWorldDefinition(
  template: NormalizedWorldTemplate,
  options: LoadWorldScriptOptions,
): WorldDefinition {
  const seed = options.seed ?? 1;
  const rulePackages = options.rulePackages ?? createCoreRulePackageRegistry();
  const { manifest, laws, mechanics: mechanicsDocument, entities: documents } = template;
  const worldHash = hashWorldTemplate(template);
  try {
    const mechanics = mechanicsCatalog(mechanicsDocument);
    const state: SimulationState = {
      schemaVersion: 16,
      executionState: null,
      worldId: manifest.id,
      worldHash,
      lawIds: laws.laws.map((law) => law.id),
      revision: 0,
      step: 0,
      truth: {
        elapsedSeconds: 0,
        rng: createSeededRng(seed),
        events: [],
        entities: {},
        placements: {},
        facts: {},
        factTombstones: [],
        mechanics,
        meters: {},
        quantities: {},
        ratings: {},
        conditions: {},
        activities: {},
        sharedActivityResourcePools: {},
        timers: {},
      },
      agents: {},
      admissions: [],
      history: [],
      bootstrapAgentCommits: [],
    };

    for (const document of documents) {
      if (state.truth.entities[document.id]) throw new Error(`duplicate entity id ${document.id}`);
      state.truth.entities[document.id] = {
        id: document.id,
        kind: document.kind,
        name: document.name,
        description: document.description,
        lifecycle: "active",
        createdAtStep: 0,
      };
      state.truth.placements[document.id] = document.placement;
      for (const fact of document.facts) {
        if (state.truth.facts[fact.id]) throw new Error(`duplicate fact id ${fact.id}`);
        state.truth.facts[fact.id] = {
          ...fact,
          subjectId: document.id,
          provenance: [{ kind: "world_seed", id: worldHash }],
        };
      }
      for (const meter of document.meters) {
        if (state.truth.meters[meter.id]) throw new Error(`duplicate meter id ${meter.id}`);
        state.truth.meters[meter.id] = {
          id: meter.id,
          definitionId: meter.definition_id,
          entityId: document.id,
          current: meter.current,
          firedThresholdIds: [],
        };
      }
      for (const quantity of document.quantities) {
        const id = quantityId(worldHash, quantity.definition_id, document.id);
        if (state.truth.quantities[id]) throw new Error(`duplicate quantity id ${id}`);
        state.truth.quantities[id] = {
          id,
          definitionId: quantity.definition_id,
          holderId: document.id,
          amount: quantity.amount,
        };
      }
      for (const rating of document.ratings) {
        if (state.truth.ratings[rating.id]) throw new Error(`duplicate rating id ${rating.id}`);
        state.truth.ratings[rating.id] = {
          id: rating.id,
          definitionId: rating.definition_id,
          entityId: document.id,
          value: rating.value,
        };
      }
      const sharedDefinitionIds = new Set<string>();
      for (const resource of document.shared_activity_resources) {
        if (sharedDefinitionIds.has(resource.definition_id)) {
          throw new Error(`entity ${document.id} repeats shared activity resource ${resource.definition_id}`);
        }
        sharedDefinitionIds.add(resource.definition_id);
        if (!mechanics.sharedActivityResources[resource.definition_id]) {
          throw new Error(`entity ${document.id} has unknown shared activity resource ${resource.definition_id}`);
        }
        const id = sharedActivityResourcePoolId(worldHash, resource.definition_id, document.id);
        if (state.truth.sharedActivityResourcePools[id]) throw new Error(`duplicate shared activity resource pool ${id}`);
        state.truth.sharedActivityResourcePools[id] = {
          id,
          definitionId: resource.definition_id,
          entityId: document.id,
          capacity: resource.capacity,
        };
      }
      const agent = agentFrom(document);
      if (agent) {
        if (state.agents[agent.id]) throw new Error(`duplicate agent id ${agent.id}`);
        state.agents[agent.id] = agent;
      }
    }

    for (const timer of mechanicsDocument.world_timers) {
      if (state.truth.timers[timer.id]) throw new Error(`duplicate world timer id ${timer.id}`);
      if (!state.lawIds.includes(timer.law_id)) {
        throw new Error(`world timer ${timer.id} references unknown law ${timer.law_id}`);
      }
      for (const agentId of timer.wake_agent_ids) {
        if (!state.agents[agentId]) throw new Error(`world timer ${timer.id} wakes unknown Agent ${agentId}`);
      }
      state.truth.timers[timer.id] = {
        id: timer.id,
        description: timer.description,
        createdAtSeconds: 0,
        dueAtSeconds: timer.due_at_seconds,
        status: "scheduled",
        wakeAgentIds: [...timer.wake_agent_ids],
        causes: [{ kind: "law", id: timer.law_id }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: timer.due_at_seconds }],
      };
    }

    const definition: WorldDefinition = {
      id: manifest.id,
      name: manifest.name,
      manifestVersion: manifest.version,
      description: manifest.description,
      runtimeDefaults: {
        maxAutonomousSpanSeconds: manifest.runtime_defaults.max_autonomous_span_seconds,
        realtimeIntervalMs: manifest.runtime_defaults.realtime_interval_ms,
        actionWindowMs: manifest.runtime_defaults.action_window_ms,
      },
      participation: template.participation ? {
        origins: template.participation.origins.map((origin) => {
          const image = origin.image
            ? template.assets.find((asset) => asset.path === origin.image!.path)
            : undefined;
          if (origin.image && !image) throw new Error(`origin ${origin.id} image not found: ${origin.image.path}`);
          return {
            id: origin.id,
            title: origin.title,
            fantasy: origin.fantasy,
            description: origin.description,
            entityKind: origin.entity_kind,
            spawnEntityId: origin.spawn_entity_id,
            persona: origin.persona,
            defaultGoal: origin.default_goal,
            relationshipHooks: [...origin.relationship_hooks],
            risks: [...origin.risks],
            mechanicsProfileId: origin.mechanics_profile_id,
            modelProfiles: origin.model_profiles ?? {
              bootstrap: manifest.model_profiles.dynamic_agent.bootstrap,
              mind: manifest.model_profiles.dynamic_agent.mind,
              reaction: manifest.model_profiles.dynamic_agent.reaction,
            },
            ...(image ? { image: { hash: image.hash, alt: origin.image!.alt } } : {}),
            fallbackArrival: origin.fallback_arrival,
          };
        }),
      } : null,
      contentHash: worldHash,
      modelProfiles: {
        perception: manifest.model_profiles.perception,
        reactionRouting: manifest.model_profiles.reaction_routing,
        resolution: manifest.model_profiles.resolution,
        transition: manifest.model_profiles.transition,
        causalVerifier: manifest.model_profiles.causal_verifier,
        grounding: manifest.model_profiles.grounding,
        observation: manifest.model_profiles.observation,
        arrival: manifest.model_profiles.arrival,
        dynamicAgent: {
          bootstrap: manifest.model_profiles.dynamic_agent.bootstrap,
          mind: manifest.model_profiles.dynamic_agent.mind,
          reaction: manifest.model_profiles.dynamic_agent.reaction,
        },
      },
      laws: laws.laws,
      disclosure: { defaultCheckVisibility: laws.disclosure.default_check_visibility },
      rulePackages: rulePackages.validate(mechanicsDocument.rule_packages.map((reference) => ({
        id: reference.id,
        version: reference.version,
        config: reference.config,
      }))),
      randomDistributions: randomDistributions(mechanicsDocument),
      historyBaseHash: historyReplayBaseHash(state),
      initialState: state,
      assetData: Object.fromEntries(template.assets.map((asset) => [
        asset.hash,
        { mime: asset.mime, bytesBase64: asset.bytesBase64 },
      ])),
    };
    validateWorldDefinition(definition);
    validateWorldModelProfiles(definition, options.modelCatalog);
    validateSimulationState(state, false);
    return definition;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

export function loadWorldScript(scriptDir: string, options: LoadWorldScriptOptions): WorldDefinition {
  const root = path.resolve(scriptDir);
  try {
    return buildWorldDefinition(loadWorldTemplate(root), options);
  } catch (error) {
    if (error instanceof WorldScriptError) throw error;
    throw new WorldScriptError(root, error instanceof Error ? error.message : String(error));
  }
}
