import { z } from "zod";
import { modelResolutionFactorSchema } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { expandSharedBatchContexts, factorSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";

export const RESOLUTION_FACTOR_TYPES = "resolution-factor-types-v1";
const instruction = loadPromptAsset("shared/resolution-factor-types.md");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (message: string): never => { throw new ModelConfigurationError(`factor types: ${message}`); };

function factorContract(fields: Record<string, unknown>) {
  if (!["source", "explanation", "authority", "role", "direction", "steps", "channel"].every(key => Object.hasOwn(fields, key))) return null;
  if (!object(fields.authority) || typeof fields.authority.const !== "string" || !object(fields.role) || typeof fields.role.const !== "string") return fail("canonical factor discriminator changed");
  const fixed = Object.fromEntries(["authority", "role", "direction", "steps"].flatMap(key => {
    const field = fields[key];
    return object(field) && Object.hasOwn(field, "const") ? [[key, field.const]] : [];
  }));
  return { type: `${fields.authority.const}:${fields.role.const}`, fixed };
}

const contracts = new Map<string, Record<string, unknown>>();
function visitSchema(node: unknown, onFactor: (node: Record<string, unknown>, fields: Record<string, unknown>, contract: NonNullable<ReturnType<typeof factorContract>>) => void): void {
  if (Array.isArray(node)) { node.forEach(entry => visitSchema(entry, onFactor)); return; }
  if (!object(node)) return;
  if (object(node.properties)) {
    const contract = factorContract(node.properties);
    if (contract) { onFactor(node, node.properties, contract); return; }
  }
  Object.values(node).forEach(entry => visitSchema(entry, onFactor));
}
visitSchema(z.toJSONSchema(modelResolutionFactorSchema, { target: "draft-07" }), (_node, _fields, contract) => {
  if (contracts.has(contract.type)) fail("duplicate canonical factor type");
  contracts.set(contract.type, contract.fixed);
});
if (contracts.size !== 12) fail("canonical factor alternatives changed");

/** Touch factors only within explicit plan envelopes, never source facts or unrelated records. */
function mapFactors(value: unknown, transform: (factor: unknown) => unknown): unknown {
  const copy: unknown = structuredClone(value);
  const visit = (entry: unknown): void => {
    if (!object(entry)) return;
    if (Array.isArray(entry.slots)) for (const slot of entry.slots) if (object(slot)) visit(slot.result);
    if (entry.kind !== "commit_plans" || !Array.isArray(entry.plans)) return;
    for (const plan of entry.plans) if (object(plan) && Array.isArray(plan.factors)) plan.factors = plan.factors.map(transform);
  };
  visit(copy);
  return copy;
}

function encodeFactor(factor: unknown, retainInvalid: boolean): unknown {
  if (!modelResolutionFactorSchema.safeParse(factor).success || !object(factor)) {
    if (retainInvalid) return factor;
    return fail("encoding requires a valid canonical factor");
  }
  const type = `${factor.authority}:${factor.role}`, fixed = contracts.get(type);
  if (!fixed) return fail("unregistered canonical factor");
  const encoded = { ...factor, factorType: type };
  for (const key of Object.keys(fixed)) delete (encoded as Record<string, unknown>)[key];
  return encoded;
}

export function encodeResolutionFactorTypes(value: unknown): unknown {
  return mapFactors(value, factor => encodeFactor(factor, false));
}

export function decodeResolutionFactorTypes(value: unknown): unknown {
  return mapFactors(value, factor => {
    if (!object(factor)) return factor;
    const fixed = typeof factor.factorType === "string" ? contracts.get(factor.factorType) : undefined;
    // Retain a wire-only field on invalid choices so canonical strict validation
    // rejects this factor while independent factors and slots can still decode.
    if (!fixed) return { ...factor, factorType: factor.factorType ?? null };
    if (Object.entries(fixed).some(([key, expected]) => Object.hasOwn(factor, key) && contentHash(factor[key]) !== contentHash(expected))) return factor;
    const decoded = { ...factor, ...structuredClone(fixed) };
    delete decoded.factorType;
    return decoded;
  });
}

export function resolutionFactorTypesWireSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(schema);
  let changed = 0;
  visitSchema(copy, (node, fields, contract) => {
    const required = node.required;
    if (contentHash(contracts.get(contract.type)) !== contentHash(contract.fixed) || !Array.isArray(required)) return fail("wire factor contract changed");
    for (const key of Object.keys(contract.fixed)) delete fields[key];
    fields.factorType = { type: "string", const: contract.type };
    node.required = [...required.filter(key => !Object.hasOwn(contract.fixed, String(key))), "factorType"];
    changed++;
  });
  if (!changed) fail("no canonical factors in wire schema");
  return copy;
}

function encodeRepair(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encodeRepair);
  if (!object(value)) return value;
  if (value.kind === "commit_plans" || Array.isArray(value.slots)) return mapFactors(value, factor => encodeFactor(factor, true));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, encodeRepair(entry)]));
}

export function factorTypesRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(`/${RESOLUTION_FACTOR_TYPES}@`)) return fail("repeated codec");
  const context = structuredClone(request.context);
  if (!object(context)) return fail("missing request context");
  if (isSharedBatchContext(context.state)) {
    context.state = factorSharedBatchContexts(expandSharedBatchContexts(context.state).map(slot => ({ ...slot,
      ...(slot.repair !== undefined ? { repair: encodeRepair(slot.repair) } : {}),
    })), context.state.codec);
  } else if (context.repair !== undefined) context.repair = encodeRepair(context.repair);
  if (context.batchRepair !== undefined) context.batchRepair = encodeRepair(context.batchRepair);
  const wire = resolutionFactorTypesWireSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  return { ...request, context, wireJsonSchema: wire, jsonExamplePolicy: "omit",
    system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}/${RESOLUTION_FACTOR_TYPES}@${contentHash({ instruction, wire }).slice(0, 16)}`,
    preprocessOutput: raw => {
      const value = decodeResolutionFactorTypes(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    },
  };
}

/** Physical representation beneath batching; canonical validation and review remain unchanged. */
export function factorTypesProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(factorTypesRequest(request)),
  };
}
