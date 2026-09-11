import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { SOURCE_INDEXED_PLANNING } from "./source-indexed-planning";

type ObjectValue = Record<string, unknown>;
type Schema = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const instruction = loadPromptAsset("shared/compact-planning-records.md");
export const COMPACT_PLANNING_RECORDS = `compact-planning-records-v1@${contentHash(instruction).slice(0, 16)}`;
function fail(message: string): never { throw new ModelConfigurationError(`compact planning: ${message}`); }
const invalid = (message: string): never => { throw new z.ZodError([{ code: "custom", path: [], message: `compact planning: ${message}` }]); };
const validator = (schema: Schema) => z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
const planOrder = ["mode", "actionIndex", "proposalKey", "targetIndices", "means", "factors", "risk", "primaryEffect", "secondaryEffect", "threatenedEffect", "visibility", "causeIndices", "causes", "difficulty", "actorRatingRef", "actorRatingPosition", "additionalRandomness"];

interface Program {
  wire: Schema;
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
}

/** Repeated schema values are declared once; no schema predicate is removed. */
function shareSchemaDefinitions(source: Schema): Schema {
  const counts = new Map<string, number>();
  const eligible = (value: ObjectValue) => ["type", "oneOf", "anyOf"].some(key => Object.hasOwn(value, key)) && JSON.stringify(value).length >= 256;
  const count = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(count); return; }
    if (!object(value)) return;
    if (eligible(value)) { const key = contentHash(value); counts.set(key, (counts.get(key) ?? 0) + 1); }
    Object.values(value).forEach(count);
  };
  count(source);
  const names = new Map<string, string>(), definitions: ObjectValue = {};
  const map = (value: unknown, top = false): unknown => {
    if (Array.isArray(value)) return value.map(entry => map(entry));
    if (!object(value)) return value;
    const key = contentHash(value);
    if (!top && eligible(value) && (counts.get(key) ?? 0) > 1) {
      let name = names.get(key);
      if (!name) {
        name = `compact_record_${names.size}`; names.set(key, name);
        if (object(source.definitions) && Object.hasOwn(source.definitions, name)) return fail("shared schema name collision");
        definitions[name] = map(value, true);
      }
      return { $ref: `#/definitions/${name}` };
    }
    return Object.fromEntries(Object.entries(value).map(([field, entry]) => [field, map(entry)]));
  };
  const wire = map(source, true) as Schema;
  const result = { ...wire, definitions: { ...(object(wire.definitions) ? wire.definitions : {}), ...definitions } };
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (!object(value)) return value;
    const name = typeof value.$ref === "string" ? value.$ref.replace(/^#\/definitions\//, "") : "";
    if (Object.keys(value).length === 1 && Object.hasOwn(definitions, name)) return expand(definitions[name]);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, expand(entry)]));
  };
  const withoutGenerated = { ...result, definitions: wire.definitions } as Schema;
  if (!Object.hasOwn(source, "definitions")) delete withoutGenerated.definitions;
  if (contentHash(expand(withoutGenerated)) !== contentHash(source)) return fail("shared definitions changed schema predicates");
  return result;
}

/** Compile only the closed records owned by the indexed planning contract. */
function compile(schema: Schema): Program {
  for (const union of ["oneOf", "anyOf"] as const) if (Array.isArray(schema[union])) {
    const sources = schema[union] as Schema[], children = sources.map(compile);
    const sourceChecks = sources.map(validator), wireChecks = children.map(child => validator(child.wire));
    const map = (value: unknown, reverse: boolean): unknown => {
      const matches = (reverse ? wireChecks : sourceChecks).flatMap((check, i) => check.safeParse(value).success ? [i] : []);
      if (!matches.length || (union === "oneOf" && matches.length !== 1)) return invalid(`no unique ${union} record alternative`);
      const results = matches.map(i => reverse ? children[i]!.decode(value) : children[i]!.encode(value));
      if (results.some(result => contentHash(result) !== contentHash(results[0]))) return invalid("ambiguous record alternatives");
      return results[0];
    };
    return { wire: { ...schema, [union]: children.map(child => child.wire) }, encode: value => map(value, false), decode: value => map(value, true) };
  }
  if (schema.type === "array" && object(schema.items)) {
    const child = compile(schema.items);
    return { wire: { ...schema, items: child.wire },
      encode: value => Array.isArray(value) ? value.map(child.encode) : invalid("expected array"),
      decode: value => Array.isArray(value) ? value.map(child.decode) : invalid("expected array") };
  }
  if (schema.type !== "object" || !object(schema.properties)) return { wire: structuredClone(schema), encode: value => structuredClone(value), decode: value => structuredClone(value) };
  const properties = schema.properties, keys = Object.keys(properties);
  const children = Object.fromEntries(keys.map(key => {
    if (!object(properties[key])) return fail("unsupported property schema");
    return [key, compile(properties[key])];
  }));
  const isPlan = ["mode", "actionIndex", "targetIndices", "primaryEffect"].every(key => Object.hasOwn(properties, key));
  const isSource = keys.length === 2 && keys.includes("kind") && keys.includes("ref");
  const isMeans = keys.length === 2 && keys.includes("description") && (keys.includes("sourcePosition") || keys.includes("source"));
  const isFactor = ["factorType", "source", "channel", "explanation"].every(key => keys.includes(key));
  if (!isPlan && !isSource && !isMeans && !isFactor) {
    const map = (value: unknown, reverse: boolean): unknown => {
      if (!object(value)) return invalid("expected named record");
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
        children[key] ? reverse ? children[key].decode(entry) : children[key].encode(entry) : structuredClone(entry)]));
    };
    return { wire: { ...schema, properties: Object.fromEntries(keys.map(key => [key, children[key]!.wire])) }, encode: value => map(value, false), decode: value => map(value, true) };
  }
  if (Object.keys(schema).some(key => !["type", "properties", "required", "additionalProperties", "title", "description"].includes(key))) return fail("unsupported closed-record predicate");
  if (schema.additionalProperties !== false || !Array.isArray(schema.required) || schema.required.some(key => typeof key !== "string" || !keys.includes(key))) return fail("record must be closed with explicit required fields");
  const required = schema.required as string[];
  const implicit = isPlan ? required.filter(key => object(properties[key]) && properties[key].type === "null" && Object.keys(properties[key]).every(k => ["type", "description", "title"].includes(k))) : [];
  const order = isPlan ? planOrder : isSource ? ["kind", "ref"] : isMeans ? [keys.includes("sourcePosition") ? "sourcePosition" : "source", "description"] : ["factorType", "source", "channel", "explanation", "direction", "steps"];
  if (required.some(key => !order.includes(key))) return fail("unknown required record column");
  const columns = order.filter(key => required.includes(key) && !implicit.includes(key));
  const optional = keys.filter(key => !required.includes(key));
  if (!isPlan && optional.length) return fail("small record has optional fields");
  const tail = isPlan;
  const items: Schema[] = columns.map((key, i) => ({ ...children[key]!.wire, title: `${i}: ${key}` }));
  if (tail) items.push({ type: "object", properties: Object.fromEntries(optional.map(key => [key, children[key]!.wire])), additionalProperties: false, title: `${items.length}: optional plan fields` });
  const wire: Schema = { type: "array", items, minItems: items.length, maxItems: items.length, additionalItems: false,
    title: `Columns: ${[...columns, ...(tail ? ["optional"] : [])].join(", ")}`,
    ...(schema.description ? { description: schema.description } : {}) };
  const sourceCheck = validator(schema), wireCheck = validator(wire);
  return { wire,
    encode: value => {
      if (!sourceCheck.safeParse(value).success || !object(value)) return invalid("source record violates its schema");
      return [...columns.map(key => children[key]!.encode(value[key])), ...(tail ? [Object.fromEntries(optional.filter(key => Object.hasOwn(value, key)).map(key => [key, children[key]!.encode(value[key])]))] : [])];
    },
    decode: value => {
      if (!wireCheck.safeParse(value).success || !Array.isArray(value)) return invalid("wire record violates its columns");
      const restored = Object.fromEntries(columns.map((key, i) => [key, children[key]!.decode(value[i])]));
      for (const key of implicit) restored[key] = null;
      if (tail) for (const [key, entry] of Object.entries(value[columns.length] as ObjectValue)) restored[key] = children[key]!.decode(entry);
      if (!sourceCheck.safeParse(restored).success) return invalid("expanded record violates its schema");
      return restored;
    } };
}

export class CompactPlanningRecordCodec {
  readonly schema: Schema;
  private readonly original: Schema;
  private readonly program: Program;
  private readonly binding: string;
  constructor(schema: Schema) {
    this.original = structuredClone(schema);
    if (!object(schema.properties) || !object(schema.properties.plans) || !object(schema.properties.plans.items) || !Array.isArray(schema.properties.plans.items.oneOf)) fail("missing indexed plans schema");
    const branches = schema.properties.plans.items.oneOf as Schema[];
    if (branches.length !== 3 || branches.some(branch => !object(branch.properties) || !object(branch.properties.mode) || !object(branch.properties.actionIndex)) ||
      branches.map(branch => ((branch.properties as ObjectValue).mode as Schema).const).sort().join(",") !== "automatic,blocked,check") fail("mode domain changed");
    this.program = compile(schema.properties.plans.items);
    this.schema = shareSchemaDefinitions({ ...structuredClone(schema), properties: { ...structuredClone(schema.properties), plans: { ...structuredClone(schema.properties.plans), items: this.program.wire } } });
    this.binding = contentHash(this.schema);
  }
  private assertBinding() { if (contentHash(this.schema) !== this.binding) fail("wire schema changed"); }
  encode(value: unknown): unknown {
    this.assertBinding();
    if (!validator(this.original).safeParse(value).success || !object(value) || !Array.isArray(value.plans)) return invalid("source batch violates schema");
    const encoded = { ...structuredClone(value), plans: value.plans.map(this.program.encode) };
    if (contentHash(this.decode(encoded)) !== contentHash(value)) return invalid("source round trip changed");
    return encoded;
  }
  decode(value: unknown): unknown {
    this.assertBinding();
    if (!object(value) || value.kind !== "commit_plans" || !Array.isArray(value.plans)) return invalid("expected commit_plans root");
    return { ...structuredClone(value), plans: value.plans.map(row => {
      try { return this.program.decode(row); }
      catch (error) {
        if (!(error instanceof z.ZodError)) throw error;
        const actionIndex = Array.isArray(row) ? row[1] : undefined;
        if (typeof actionIndex !== "number" || !Number.isSafeInteger(actionIndex) || actionIndex < 0) return invalid("invalid row lacks explicit action identity");
        return { actionIndex, invalidCompactPlanningRecord: { rejectedRow: structuredClone(row), reason: error.message } };
      }
    }) };
  }
}

export function compactPlanningRecordsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (!request.wireJsonSchema || !request.promptVersion.includes(SOURCE_INDEXED_PLANNING) || request.promptVersion.includes(COMPACT_PLANNING_RECORDS)) return fail("requires indexed planning exactly once");
  const codec = new CompactPlanningRecordCodec(request.wireJsonSchema), context = structuredClone(request.context);
  const contextHash = contentHash(context), schemaHash = contentHash(codec.schema);
  const jsonObjectPostlude = [request.jsonObjectPostlude, instruction].filter(Boolean).join("\n\n");
  return { ...request, context, wireJsonSchema: codec.schema, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${COMPACT_PLANNING_RECORDS}@${contentHash({ contextHash, schemaHash }).slice(0, 16)}`,
    preprocessOutput: raw => {
      if (contentHash(context) !== contextHash) return fail("context changed before decoding");
      const value = codec.decode(raw);
      return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
    } };
}
