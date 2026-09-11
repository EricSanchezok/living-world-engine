import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { dependentFieldsRequest } from "../../mechanics/resolution-dependent-fields-codec";
import { factorSharedBatchContexts, SHARED_BATCH_ORDER_CODEC } from "../../mechanics/shared-batch-context";
import { compactSharedCatalogPrefix } from "../../mechanics/shared-catalog-prefix";
import { compactSharedCatalogRecords } from "../../mechanics/shared-catalog-records";
import { promptBundle } from "../../prompts";
import { effectProfileDomains, effectProfileDomainsRequest, specializeEffectProfileSchema } from "./effect-profile-domains";

function context(duration: string) {
  const profiles = { durationProfiles: { [duration]: {} }, conditionProfiles: { afraid: {} }, impactProfiles: { harm: {} } };
  return { state: { canonicalTruth: { mechanics: profiles } }, referenceCatalog: {
    candidates: Object.entries(profiles).flatMap(([collection, values]) => Object.keys(values).map(id => ({
      kind: "mechanic", handle: `ref:mechanic:${id}`, statePath: `state.truth.mechanics.${collection}.${id}`, allowedUses: ["mechanic"],
    }))),
  } };
}

it("joins all authored eligible profiles across slots without inventing handles or accepting unrelated catalog rows", () => {
  const first = context("brief"), second = context("ongoing");
  first.referenceCatalog.candidates.push({ kind: "mechanic", handle: "ref:mechanic:unbound", statePath: "state.truth.mechanics.durationProfiles.missing", allowedUses: ["mechanic"] });
  second.referenceCatalog.candidates.find(row => row.handle === "ref:mechanic:harm")!.allowedUses = [];
  const domains = effectProfileDomains([first, second]);
  expect(domains).toEqual({ durationProfileRef: ["ref:mechanic:brief", "ref:mechanic:ongoing"], conditionProfileRef: ["ref:mechanic:afraid"], impactProfileRef: ["ref:mechanic:harm"] });
  expect(effectProfileDomains([second]).impactProfileRef).toEqual([]);
  first.referenceCatalog.candidates.push({ ...first.referenceCatalog.candidates[0]!, handle: "ref:mechanic:ambiguous" });
  expect(() => effectProfileDomains([first])).toThrow("ambiguous");
});

it("only narrows existing predicates and retains open conditions even when no named condition is eligible", () => {
  const schema = { properties: {
    durationProfileRef: { type: "string", pattern: "^ref:mechanic:", enum: ["ref:mechanic:brief"] },
    conditionProfileRef: { anyOf: [{ type: "string" }, { type: "null" }] },
    impactProfileRef: { type: "string", minLength: 1 },
  }, required: ["durationProfileRef"], additionalProperties: false };
  const before = structuredClone(schema);
  const result = specializeEffectProfileSchema(schema, { durationProfileRef: ["ref:mechanic:brief", "ref:mechanic:ongoing"], conditionProfileRef: [], impactProfileRef: [] });
  expect(result).toEqual({ ...schema, properties: {
    durationProfileRef: schema.properties.durationProfileRef,
    conditionProfileRef: { ...schema.properties.conditionProfileRef, enum: [null] },
    impactProfileRef: { ...schema.properties.impactProfileRef, not: {} },
  } });
  expect(schema).toEqual(before);
});

it("uses the production lossless context codecs and keeps the canonical output validator and decoder authoritative", () => {
  const state = compactSharedCatalogRecords(compactSharedCatalogPrefix(factorSharedBatchContexts([context("brief"), context("ongoing")], SHARED_BATCH_ORDER_CODEC)));
  const prompt = promptBundle("truth-resolution");
  const source = dependentFieldsRequest({ ...prompt, promptVersion: prompt.version, workloadId: "world", batchId: "step",
    profileId: "truth-engine", subjectId: "component", role: "truth-resolution", schemaName: "truth_resolution_plan_commit",
    schema: resolutionPlanCommitDirectiveSchema, context: { state, repair: null } });
  const request = { ...source, schemaName: "truth_resolution_plan_commit_batch" };
  const before = JSON.stringify(request.context);
  const candidate = effectProfileDomainsRequest(request);
  expect(candidate.schema).toBe(request.schema);
  expect(candidate.preprocessOutput).toBe(request.preprocessOutput);
  expect(candidate.context).toBe(request.context);
  expect(candidate.userPrompt).toBe(request.userPrompt);
  expect(JSON.stringify(request.context)).toBe(before);
  expect(JSON.stringify(candidate.wireJsonSchema)).toContain('"enum":["ref:mechanic:brief","ref:mechanic:ongoing"]');
  const invalid = { kind: "commit_plans", plans: [{ mode: "check", primaryEffect: null, threatenedEffect: null }] };
  expect(candidate.schema.safeParse(candidate.preprocessOutput!(invalid).value).success).toBe(false);
  expect(() => effectProfileDomainsRequest(candidate)).toThrow("already applied");
  const unrelated = { ...request, schemaName: "truth_transition" };
  expect(effectProfileDomainsRequest(unrelated)).toBe(unrelated);
  expect(() => specializeEffectProfileSchema(z.toJSONSchema(z.object({ done: z.boolean() })), effectProfileDomains([context("brief")]))).toThrow("no profile fields");
});
