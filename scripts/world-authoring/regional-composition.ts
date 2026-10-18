import { z } from "zod";
import { entityDocumentSchema, lawsFileSchema, mechanicsFileSchema, originInitializationSchema } from "../../src/script/contract";
import { parseWorldTemplate } from "../../src/script/world-loader";
import { contentHash } from "../../src/engine/models/model-audit";
import { authoredClaimSchema, authoredModuleSchema, moduleApprovalSchema } from "./authoring-build";
import { periodicPropertySchema } from "../../src/script/periodic-property-contract";

const references = z.record(z.string(), z.array(z.string()).min(1));
export const regionalModuleSchema = z.strictObject({
  id: z.string().min(1), entities: z.array(entityDocumentSchema),
  existingEntityFacts: z.array(z.strictObject({ entityId: z.string(), facts: entityDocumentSchema.shape.facts })),
  placements: z.array(z.strictObject({ entityId: z.string(), expected: z.string().nullable(), value: z.string().nullable() })),
  entityDescriptions: z.array(z.strictObject({ entityId: z.string(), expected: z.string(), value: z.string() })),
  agentCognition: originInitializationSchema.shape.cognition,
  periodicProperties: z.array(periodicPropertySchema).default([]),
  quantityDefinitions: mechanicsFileSchema.shape.quantities.default([]),
  laws: z.array(lawsFileSchema.shape.laws.element), provenance: references,
});
export interface ReviewedRegion { module: unknown; claims: unknown[]; review: unknown }

/** Merge approved regional deltas without overwrites, implicit identities, or invented links. */
export function assembleRegionalModules(baseInput: unknown, baseClaimInput: unknown[], inputs: ReviewedRegion[]) {
  const base = authoredModuleSchema.parse(baseInput);
  const template = structuredClone(parseWorldTemplate(base.template));
  const claims = z.array(authoredClaimSchema).parse(baseClaimInput);
  const provenance = structuredClone(base.provenance);
  const claimIds = new Set(claims.map(claim => claim.id));
  const openingClaimIds = new Set(claims.filter(claim => claim.validAtOpening).map(claim => claim.id));
  const entities = new Map(template.entities.map(entity => [entity.id, entity]));
  const factIds = new Set(template.entities.flatMap(entity => entity.facts.map(fact => fact.id)));
  const lawIds = new Set(template.laws.laws.map(law => law.id));
  const periodicIds = new Set(template.mechanics.periodic_properties.map(property => property.id));
  const quantityIds = new Set(template.mechanics.quantities.map(quantity => quantity.id));
  const moduleIds = new Set([base.id]);
  const changedPlacements = new Set<string>(), changedDescriptions = new Set<string>();
  const receipts: Array<{ moduleId: string; moduleHash: string; claimsHash: string; reviewer: string }> = [];
  for (const input of inputs) {
    const region = regionalModuleSchema.parse(input.module);
    const regionClaims = z.array(authoredClaimSchema).parse(input.claims);
    const review = moduleApprovalSchema.parse(input.review);
    if (review.scope !== "full" || review.moduleHash !== contentHash(input.module) || review.claimsHash !== contentHash(regionClaims)) {
      throw new Error(`regional review drift ${region.id}`);
    }
    if (moduleIds.has(region.id)) throw new Error(`duplicate regional module ${region.id}`);
    moduleIds.add(region.id);
    for (const claim of regionClaims) {
      if (claimIds.has(claim.id)) throw new Error(`duplicate regional claim ${claim.id}`);
      if (claim.status !== "reviewed") throw new Error(`unreviewed regional claim ${claim.id}`);
      claimIds.add(claim.id); claims.push(claim);
      if (claim.validAtOpening) openingClaimIds.add(claim.id);
    }
    const required = new Map<string, string>();
    for (const entity of region.entities) {
      if (entities.has(entity.id)) throw new Error(`duplicate regional entity ${entity.id}`);
      entities.set(entity.id, entity); template.entities.push(entity);
      required.set(`entity:${entity.id}`, `entity:${entity.id}`);
      for (const fact of entity.facts) {
        if (factIds.has(fact.id)) throw new Error(`duplicate regional fact ${fact.id}`);
        factIds.add(fact.id); required.set(`fact:${fact.id}`, `fact:${fact.id}`);
      }
    }
    for (const addition of region.existingEntityFacts) {
      const entity = entities.get(addition.entityId);
      if (!entity) throw new Error(`unknown regional fact owner ${addition.entityId}`);
      for (const fact of addition.facts) {
        if (factIds.has(fact.id)) throw new Error(`duplicate regional fact ${fact.id}`);
        factIds.add(fact.id); entity.facts.push(fact); required.set(`fact:${fact.id}`, `fact:${fact.id}`);
      }
    }
    for (const patch of region.placements) {
      const entity = entities.get(patch.entityId);
      if (!entity || entity.placement !== patch.expected || changedPlacements.has(entity.id)) throw new Error(`regional placement conflict ${patch.entityId}`);
      entity.placement = patch.value; changedPlacements.add(entity.id);
      required.set(`placement:${entity.id}`, `entity:${entity.id}`);
    }
    for (const patch of region.entityDescriptions) {
      const entity = entities.get(patch.entityId);
      if (!entity || entity.description !== patch.expected || changedDescriptions.has(entity.id)) throw new Error(`regional description conflict ${patch.entityId}`);
      entity.description = patch.value; changedDescriptions.add(entity.id);
      required.set(`description:${entity.id}`, `entity:${entity.id}`);
    }
    const cognitiveOwners = new Set<string>();
    for (const addition of region.agentCognition) {
      const entity = [...entities.values()].find(entity => entity.agent?.id === addition.agent_id);
      if (!entity?.agent || cognitiveOwners.has(addition.agent_id)) throw new Error(`regional cognition owner conflict ${addition.agent_id}`);
      cognitiveOwners.add(addition.agent_id);
      const belief = entity.agent.belief;
      for (const key of ["local_entities", "evidence", "claims", "bindings"] as const) {
        const identity = (entry: { id: string } | { local_entity_id: string }) => "id" in entry ? entry.id : entry.local_entity_id;
        const ids = new Set(belief[key].map(identity));
        for (const entry of addition.belief[key]) {
          const id = identity(entry);
          if (ids.has(id)) throw new Error(`regional cognition identity conflict ${addition.agent_id}/${key}/${id}`);
          ids.add(id);
        }
      }
      belief.local_entities.push(...addition.belief.local_entities);
      belief.evidence.push(...addition.belief.evidence);
      belief.claims.push(...addition.belief.claims);
      belief.bindings.push(...addition.belief.bindings);
      required.set(`cognition:${addition.agent_id}`, `entity:${entity.id}`);
    }
    for (const law of region.laws) {
      if (lawIds.has(law.id)) throw new Error(`duplicate regional law ${law.id}`);
      lawIds.add(law.id); template.laws.laws.push(law); required.set(`law:${law.id}`, `law:${law.id}`);
    }
    for (const property of region.periodicProperties) {
      if (periodicIds.has(property.id)) throw new Error(`duplicate regional periodic property ${property.id}`);
      periodicIds.add(property.id);
      template.mechanics.periodic_properties.push(property);
      required.set(`periodic:${property.id}`, "mechanics");
    }
    for (const quantity of region.quantityDefinitions) {
      if (quantityIds.has(quantity.id)) throw new Error(`duplicate regional quantity definition ${quantity.id}`);
      if ([...quantity.production_law_ids, ...quantity.consumption_law_ids].some(id => !lawIds.has(id))) {
        throw new Error(`unknown regional quantity law ${quantity.id}`);
      }
      quantityIds.add(quantity.id);
      template.mechanics.quantities.push(quantity);
      required.set(`quantity:${quantity.id}`, "mechanics");
    }
    for (const key of Object.keys(region.provenance)) if (!required.has(key)) throw new Error(`stale regional provenance ${key}`);
    for (const [key, destination] of required) {
      const refs = region.provenance[key];
      if (!refs?.length || refs.some(ref => !claimIds.has(ref))) throw new Error(`missing regional provenance ${key}`);
      if (refs.some(ref => !openingClaimIds.has(ref))) throw new Error(`post-opening regional provenance ${key}`);
      provenance[destination] = [...new Set([...(provenance[destination] ?? []), ...refs])];
    }
    receipts.push({ moduleId: region.id, moduleHash: review.moduleHash, claimsHash: review.claimsHash, reviewer: review.reviewer });
  }
  return { module: { ...base, template: parseWorldTemplate(template), provenance }, claims, receipts };
}
