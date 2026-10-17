import { z } from "zod";
import { entityDocumentSchema, lawsFileSchema } from "../../src/script/contract";
import { parseWorldTemplate } from "../../src/script/world-loader";
import { contentHash } from "../../src/engine/models/model-audit";
import { authoredClaimSchema, authoredModuleSchema, moduleApprovalSchema } from "./authoring-build";

const references = z.record(z.string(), z.array(z.string()).min(1));
export const regionalModuleSchema = z.strictObject({
  id: z.string().min(1), entities: z.array(entityDocumentSchema),
  existingEntityFacts: z.array(z.strictObject({ entityId: z.string(), facts: entityDocumentSchema.shape.facts })),
  placements: z.array(z.strictObject({ entityId: z.string(), expected: z.string().nullable(), value: z.string().nullable() })),
  entityDescriptions: z.array(z.strictObject({ entityId: z.string(), expected: z.string(), value: z.string() })),
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
  const entities = new Map(template.entities.map(entity => [entity.id, entity]));
  const factIds = new Set(template.entities.flatMap(entity => entity.facts.map(fact => fact.id)));
  const lawIds = new Set(template.laws.laws.map(law => law.id));
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
      if (claim.status !== "reviewed" || !claim.validAtOpening) throw new Error(`unreviewed regional claim ${claim.id}`);
      claimIds.add(claim.id); claims.push(claim);
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
    for (const law of region.laws) {
      if (lawIds.has(law.id)) throw new Error(`duplicate regional law ${law.id}`);
      lawIds.add(law.id); template.laws.laws.push(law); required.set(`law:${law.id}`, `law:${law.id}`);
    }
    for (const key of Object.keys(region.provenance)) if (!required.has(key)) throw new Error(`stale regional provenance ${key}`);
    for (const [key, destination] of required) {
      const refs = region.provenance[key];
      if (!refs?.length || refs.some(ref => !claimIds.has(ref))) throw new Error(`missing regional provenance ${key}`);
      provenance[destination] = [...new Set([...(provenance[destination] ?? []), ...refs])];
    }
    receipts.push({ moduleId: region.id, moduleHash: review.moduleHash, claimsHash: review.claimsHash, reviewer: review.reviewer });
  }
  return { module: { ...base, template: parseWorldTemplate(template), provenance }, claims, receipts };
}
