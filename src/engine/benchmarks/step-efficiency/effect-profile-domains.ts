import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";
import { planningSourceContexts } from "./planning-source-contexts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const record = (value: unknown): Value => {
  if (!object(value)) throw new ModelConfigurationError("effect profile domains require a bound source object");
  return value;
};
const instruction = loadPromptAsset("shared/effect-profile-domains.md");
export const EFFECT_PROFILE_DOMAINS = `source-effect-profile-domains-v1@${contentHash(instruction).slice(0, 16)}`;
const collections = { durationProfileRef: "durationProfiles", conditionProfileRef: "conditionProfiles", impactProfileRef: "impactProfiles" } as const;
export type EffectProfileDomains = Record<keyof typeof collections, string[]>;

/** Enumerate existing legal profile handles; no reference or effect is synthesized. */
export function effectProfileDomains(contexts: readonly unknown[]): EffectProfileDomains {
  const domains: EffectProfileDomains = { durationProfileRef: [], conditionProfileRef: [], impactProfileRef: [] };
  for (const contextValue of contexts) {
    const context = record(contextValue), catalog = record(context.referenceCatalog);
    const mechanics = record(record(record(context.state).canonicalTruth).mechanics);
    if (!Array.isArray(catalog.candidates)) throw new ModelConfigurationError("effect profile domains require a complete reference catalog");
    for (const [field, collection] of Object.entries(collections) as Array<[keyof EffectProfileDomains, string]>) {
      const profiles = record(mechanics[collection]);
      for (const profileId of Object.keys(profiles)) {
        const rows = catalog.candidates.filter((value): value is Value => object(value) && value.kind === "mechanic" &&
          value.statePath === `state.truth.mechanics.${collection}.${profileId}` && Array.isArray(value.allowedUses) && value.allowedUses.includes("mechanic"));
        if (rows.length > 1 || rows.some(row => typeof row.handle !== "string")) throw new ModelConfigurationError("ambiguous effect profile reference binding");
        if (rows[0] && !domains[field].includes(rows[0].handle as string)) domains[field].push(rows[0].handle as string);
      }
    }
  }
  for (const values of Object.values(domains)) values.sort();
  return domains;
}

export function specializeEffectProfileSchema(source: Value, domains: EffectProfileDomains): Value {
  const schema = structuredClone(source);
  let fieldsChanged = 0;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!object(node)) return;
    if (object(node.properties)) for (const field of Object.keys(collections) as Array<keyof EffectProfileDomains>) {
      const original = node.properties[field];
      if (!object(original)) continue;
      const eligible: Array<string | null> = [...domains[field], ...(field === "conditionProfileRef" ? [null] : [])];
      const previousEnum = original.enum;
      const values = Array.isArray(previousEnum) ? eligible.filter(value => previousEnum.includes(value)) : eligible;
      node.properties[field] = { ...original, ...(values.length ? { enum: values } : { not: {} }) };
      fieldsChanged += 1;
    }
    Object.values(node).forEach(visit);
  };
  visit(schema);
  if (!fieldsChanged) throw new ModelConfigurationError("effect profile schema contains no profile fields");
  return schema;
}

/** The union is only a physical wire domain; original slot validators remain authoritative. */
export function effectProfileDomainsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || request.schemaName !== "truth_resolution_plan_commit_batch") return request;
  if (request.promptVersion.includes(EFFECT_PROFILE_DOMAINS)) throw new ModelConfigurationError("effect profile domains already applied");
  const domains = effectProfileDomains(planningSourceContexts(request.context));
  const wireJsonSchema = specializeEffectProfileSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }), domains);
  const system = [request.system, instruction].join("\n\n");
  return { ...request, system, wireJsonSchema,
    promptVersion: `${request.promptVersion}/${EFFECT_PROFILE_DOMAINS}@${contentHash(domains).slice(0, 16)}` };
}
