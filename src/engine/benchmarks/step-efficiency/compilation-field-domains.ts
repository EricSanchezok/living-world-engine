import { z } from "zod";
import { ACTION_COMPILATION_FIELD_USES } from "../../algorithms/eager-reference/action-compilation-validation";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (reason: string): never => { throw new ModelConfigurationError(`compilation field domains: ${reason}`); };
const record = (value: unknown): Value => object(value) ? value : fail("expected source object");
const contracts = {
  dependency: ACTION_COMPILATION_FIELD_USES.stateDependency,
  audience: ACTION_COMPILATION_FIELD_USES.audience,
  resource: ACTION_COMPILATION_FIELD_USES.resourcePool,
} as const;
export type CompilationFieldDomains = Record<keyof typeof contracts, string[]>;
const instruction = loadPromptAsset("shared/compilation-field-domains.md");
export const COMPILATION_FIELD_DOMAINS = `at-field-use-union-v1@${contentHash({ instruction, contracts }).slice(0, 16)}`;

/** Full physical union, with the original compiler retaining per-slot authority. */
export function compilationFieldDomains(context: unknown): CompilationFieldDomains {
  const source = record(context), slots = record(source.task).slots, candidates = record(source.referenceCatalog).candidates;
  if (!Array.isArray(slots) || !slots.length || !Array.isArray(candidates)) return fail("missing slots or catalog");
  const active = new Set(slots.map(slot => record(slot).slot));
  if (active.size !== slots.length || [...active].some(slot => !Number.isSafeInteger(slot))) return fail("invalid slots");
  const keys = new Set<string>(), domains: CompilationFieldDomains = { dependency: [], audience: [], resource: [] };
  for (const value of candidates) {
    const row = record(value), scope = record(row.scope);
    if (typeof row.candidateKey !== "string" || !/^r[0-9]{3,}$/u.test(row.candidateKey) || keys.has(row.candidateKey) ||
      typeof row.kind !== "string" || !Array.isArray(row.allowedUses) || row.allowedUses.some(use => typeof use !== "string") ||
      (scope.kind !== "shared" && (scope.kind !== "slot" || !Number.isSafeInteger(scope.slot)))) return fail("invalid candidate binding");
    keys.add(row.candidateKey);
    if (scope.kind === "slot" && !active.has(scope.slot)) continue;
    for (const key of Object.keys(contracts) as Array<keyof CompilationFieldDomains>) {
      const contract = contracts[key];
      if (row.allowedUses.includes(contract.use) && (contract.kinds as readonly string[]).includes(row.kind)) domains[key].push(row.candidateKey);
    }
  }
  for (const values of Object.values(domains)) values.sort();
  return domains;
}

/** Add shared finite domains without replacing any original predicate or shape. */
export function specializeCompilationFieldSchema(source: Value, domains: CompilationFieldDomains): Value {
  const schema = structuredClone(source), definitions = record(schema.definitions ?? {});
  schema.definitions = definitions;
  const constrain = (field: Value, domain: keyof CompilationFieldDomains) => {
    const name = `compilation_${domain}_domain`;
    if (!Object.hasOwn(definitions, name)) definitions[name] = domains[domain].length ? { enum: domains[domain] } : { not: {} };
    const prior = field.allOf ?? [];
    if (!Array.isArray(prior)) return fail("invalid source conjunction");
    field.allOf = [...prior, { $ref: `#/definitions/${name}` }];
  };
  if (Object.keys(definitions).some(key => /^compilation_(dependency|audience|resource)_domain$/u.test(key))) return fail("domain definition collision");
  const item = record(record(record(schema.properties).slots).items);
  const interaction = record(record(record(item.properties).interactionDependency).properties);
  const dependencies = record(record(interaction.stateDependencies).properties);
  for (const field of ["requiredExistingCandidateKeys", "potentiallyAffectedCandidateKeys"]) {
    constrain(record(record(dependencies[field]).items), "dependency");
  }
  constrain(record(record(interaction.audienceAgentCandidateKeys).items), "audience");
  const claims = record(interaction.sharedResourceClaims);
  if (claims.maxItems !== 0) {
    constrain(record(record(record(claims.items).properties).resourcePoolCandidateKey), "resource");
  } else if (domains.resource.length) return fail("visible pools conflict with the source schema");
  return schema;
}

/** JSON-mode schema guidance only; no decoder substitution or inferred identity. */
export function compilationFieldDomainsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "action-compilation" || request.schemaName !== "action_compilation_at_eligible_source_choice_v1") return request;
  if (request.promptVersion.includes(COMPILATION_FIELD_DOMAINS)) return fail("already applied");
  const domains = compilationFieldDomains(request.context), sourceHash = contentHash(request.context);
  const wireJsonSchema = specializeCompilationFieldSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }), domains);
  const system = [request.system, instruction].join("\n\n");
  return { ...request, system, wireJsonSchema,
    promptVersion: `${request.promptVersion}/${COMPILATION_FIELD_DOMAINS}@${contentHash(domains).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(request.context) !== sourceHash) return fail("source binding changed");
      return request.preprocessOutput?.(raw) ?? { value: raw, symbolRepairs: [] };
    } };
}
