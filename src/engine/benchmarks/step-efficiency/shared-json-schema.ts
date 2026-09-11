import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";

type Schema = Record<string, unknown>;
const object = (value: unknown): value is Schema => value !== null && typeof value === "object" && !Array.isArray(value);
const maps = new Set(["properties", "patternProperties", "definitions", "$defs", "dependentSchemas"]);
const arrays = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
const singles = new Set(["additionalProperties", "additionalItems", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]);

/** Visit schema positions only: defaults, enum/const values and examples are data. */
function mapChildren(node: Schema, visit: (value: unknown) => unknown): Schema {
  return Object.fromEntries(Object.entries(node).map(([key, value]) => {
    if (maps.has(key) && object(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child)]))];
    if (arrays.has(key) && Array.isArray(value)) return [key, value.map(visit)];
    if (key === "items") return [key, Array.isArray(value) ? value.map(visit) : visit(value)];
    if (singles.has(key)) return [key, visit(value)];
    if (key === "dependencies" && object(value)) return [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, Array.isArray(child) ? child : visit(child)]))];
    return [key, structuredClone(value)];
  }));
}

export function expandSharedJsonSchema(wire: Schema, generatedNames: readonly string[], hadDefinitions: boolean): Schema {
  const definitions = wire.definitions;
  if (!object(definitions)) throw new Error("shared schema definitions missing");
  const names = new Set(generatedNames), active = new Set<string>();
  const expand = (node: unknown): unknown => {
    if (!object(node)) return structuredClone(node);
    const name = typeof node.$ref === "string" && node.$ref.startsWith("#/definitions/") ? node.$ref.slice(14) : undefined;
    if (name && names.has(name)) {
      if (Object.keys(node).length !== 1 || !object(definitions[name]) || active.has(name)) throw new Error("invalid or cyclic generated schema reference");
      active.add(name);const result = expand(definitions[name]);active.delete(name);return result;
    }
    return mapChildren(node, expand);
  };
  const root = structuredClone(wire);
  root.definitions = Object.fromEntries(Object.entries(definitions).filter(([name]) => !names.has(name)));
  if (!hadDefinitions) delete root.definitions;
  return expand(root) as Schema;
}

/** Standard draft-07 references for byte-identical repeated sub-schemas.
 * Expansion must reproduce the complete original schema, including ordering. */
export function factorSharedJsonSchema(source: Schema) {
  if (source.$schema !== "http://json-schema.org/draft-07/schema#") throw new Error("shared schema requires draft-07");
  const counts = new Map<string, number>();
  const collect = (node: unknown): unknown => {
    if (!object(node)) return node;
    if (Object.hasOwn(node, "$id") || Object.hasOwn(node, "$anchor") || Object.hasOwn(node, "$dynamicAnchor") || Object.hasOwn(node, "$dynamicRef")) throw new Error("schema scope changes cannot be factored");
    if (node.$schema !== undefined && node.$schema !== source.$schema) throw new Error("mixed schema dialects cannot be factored");
    // A pointer into a relocated schema's interior could stop resolving after
    // replacement. The actual Zod schemas use direct root definition refs only.
    if (node.$ref !== undefined) {
      const match = typeof node.$ref === "string" ? /^#\/(definitions|\$defs)\/([^/~]+)$/u.exec(node.$ref) : null;
      const definitions = match ? source[match[1]!] : undefined;
      if (!match || !object(definitions) || !Object.hasOwn(definitions, match[2]!)) throw new Error("schema reference is not a direct existing root definition");
    }
    const key = JSON.stringify(node);counts.set(key, (counts.get(key) ?? 0) + 1);
    mapChildren(node, collect);return node;
  };
  collect(source);
  const selected = new Map([...counts].filter(([key, count]) => count > 1 && Buffer.byteLength(key) >= 512)
    .map(([key]) => [key, `cw_shared_${contentHash(key).slice(0, 16)}`]));
  const hadDefinitions = Object.hasOwn(source, "definitions");
  if (hadDefinitions && !object(source.definitions)) throw new Error("invalid original definitions");
  const originalDefinitions = (source.definitions ?? {}) as Schema;
  if (new Set(selected.values()).size !== selected.size || [...selected.values()].some((name) => Object.hasOwn(originalDefinitions, name))) throw new Error("shared schema name collision");
  const replace = (node: unknown): unknown => {
    if (!object(node)) return structuredClone(node);
    const name = selected.get(JSON.stringify(node));
    return name ? { $ref: `#/definitions/${name}` } : mapChildren(node, replace);
  };
  const schema = mapChildren(source, replace);
  schema.definitions = { ...(schema.definitions as Schema | undefined), ...Object.fromEntries([...selected].map(([key, name]) =>
    [name, mapChildren(JSON.parse(key) as Schema, replace)])) };
  const generatedNames = [...selected.values()];
  const restored = expandSharedJsonSchema(schema, generatedNames, hadDefinitions);
  if (JSON.stringify(restored) !== JSON.stringify(source)) throw new Error("schema roundtrip changed constraints or order");
  return { schema, generatedNames, hadDefinitions,
    sourceHash: contentHash(JSON.stringify(source)), restoredHash: contentHash(JSON.stringify(restored)), wireHash: contentHash(JSON.stringify(schema)),
    originalBytes: Buffer.byteLength(JSON.stringify(source)), wireBytes: Buffer.byteLength(JSON.stringify(schema)) };
}

export function sharedSchemaRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  const proof = factorSharedJsonSchema(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
  if (proof.wireBytes >= proof.originalBytes) throw new Error("shared schema does not reduce this request");
  return { ...request, wireJsonSchema: proof.schema,
    promptVersion: `${request.promptVersion}/shared-schema-v1@${proof.wireHash.slice(0, 16)}` };
}
