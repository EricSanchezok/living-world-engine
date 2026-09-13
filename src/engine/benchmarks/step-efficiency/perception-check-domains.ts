import { z } from "zod";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("Missing perception domain source");
  return value as Json;
};
const rows = (value: unknown): Json[] => {
  if (!Array.isArray(value)) throw new ModelConfigurationError("Missing perception domain rows");
  return value.map(object);
};
const domain = (values: unknown[]) => values.length ? { enum: values } : { not: {} };

/** Compile existing reference and ownership constraints; never select a check or edit its output. */
export function perceptionCheckDomainsSchema(context: unknown, originalSchema?: Record<string, unknown>): Record<string, unknown> {
  const input = object(context), state = object(input.state), truth = object(state.canonicalTruth);
  const candidates = rows(object(input.referenceCatalog).candidates);
  const byHandle = new Map(candidates.map(candidate => [candidate.handle, candidate]));
  if (byHandle.size !== candidates.length) throw new ModelConfigurationError("Duplicate perception references");
  const members = (kind: string, use: string) => candidates.filter(candidate => candidate.kind === kind &&
    Array.isArray(candidate.allowedUses) && candidate.allowedUses.includes(use)).map(candidate => String(candidate.handle));
  const entities = object(truth.entities), ratings = object(truth.ratings);
  for (const [handle, row] of Object.entries(ratings)) {
    if (byHandle.get(handle)?.kind !== "rating" || byHandle.get(object(row).entityRef)?.kind !== "entity") {
      throw new ModelConfigurationError("Incomplete Rating ownership source");
    }
  }
  if (candidates.filter(candidate => candidate.kind === "rating").length !== Object.keys(ratings).length) {
    throw new ModelConfigurationError("Missing displayed Rating source");
  }
  const actorHandles = members("entity", "actor").filter(handle => object(entities[handle]).lifecycle === "active");
  const modifierHandles = new Set(members("rating", "modifier"));
  const assigned = object(object(input.task).assignment).perceptionTargets;
  const assignments = assigned === undefined ? undefined : rows(assigned);
  for (const row of assignments ?? []) {
    if (!actorHandles.includes(String(row.observerRef)) || byHandle.get(row.sourceActionRef)?.kind !== "action") {
      throw new ModelConfigurationError("Invalid perception task source");
    }
  }
  const sourceSchema = originalSchema ?? z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" });
  const schema = structuredClone(sourceSchema);
  const requestBranch = rows(schema.oneOf).find(branch => object(object(branch.properties).kind).const === "request_checks");
  if (!requestBranch) throw new ModelConfigurationError("Missing perception check branch");
  const check = object(object(object(requestBranch.properties).requests).items);
  if (check.allOf) throw new ModelConfigurationError("Perception check constraints already applied");
  const properties = object(check.properties);
  const ownerBranches = actorHandles.flatMap(actor => {
    const actions = assignments?.filter(row => row.observerRef === actor).map(row => row.sourceActionRef);
    if (actions?.length === 0) return [];
    const owned = Object.entries(ratings).filter(([handle, rating]) => modifierHandles.has(handle) && object(rating).entityRef === actor).map(([handle]) => handle);
    return [{ properties: {
      actorRef: { const: actor }, ratingRef: domain([null, ...owned]),
      ...(actions ? { causes: { contains: { type: "object", properties: { kind: { const: "action" }, ref: domain(actions) }, required: ["kind", "ref"] } } } : {}),
    } }];
  });
  check.allOf = [ownerBranches.length ? { anyOf: ownerBranches } : { not: {} }];
  object(properties.targetRef).allOf = [domain([null, ...members("entity", "target")])];
  const difficulty = object(properties.difficulty);
  const opposition = rows(difficulty.oneOf).find(branch => object(object(branch.properties).kind).const === "opposed");
  if (!opposition) throw new ModelConfigurationError("Missing opposed difficulty branch");
  const opponents = new Set(members("entity", "target")), sources = new Set(members("rating", "source"));
  const oppositionBranches = Object.entries(ratings).filter(([handle, row]) => sources.has(handle) && opponents.has(String(object(row).entityRef))).map(([handle, row]) => ({
    properties: { targetRef: { const: object(row).entityRef }, ratingRef: { const: handle },
      source: { properties: { kind: { const: "rating" }, ref: { const: handle } } } },
  }));
  opposition.allOf = [oppositionBranches.length ? { anyOf: oppositionBranches } : { not: {} }];
  return schema;
}

export function perceptionCheckDomainsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.preprocessOutput) throw new ModelConfigurationError("Perception check domains require canonical output");
  const wireJsonSchema = perceptionCheckDomainsSchema(request.context, request.wireJsonSchema);
  return { ...request, wireJsonSchema,
    promptVersion: `${request.promptVersion}/perception-check-domains-v1@${contentHash(wireJsonSchema).slice(0, 16)}` };
}
