import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

type Value = Record<string, unknown>;
const object = (value: unknown): value is Value => value !== null && typeof value === "object" && !Array.isArray(value);
const aliasPattern = "^r[0-9]{3,}$";
const alias = new RegExp(aliasPattern, "u");
const referenceField = /^(?:ref|refs|candidateKey|candidateKeys|allowedHandles|.*(?:Ref|Refs|CandidateKey|CandidateKeys))$/u;
const instruction = loadPromptAsset("shared/typed-compilation-aliases.md");
export const TYPED_COMPILATION_ALIASES = `typed-compilation-aliases-v1@${contentHash(instruction).slice(0, 16)}`;
function fail(message: string): never { throw new ModelConfigurationError(`typed compilation aliases: ${message}`); }

/** Change declared reference fields only; prose and random literals are opaque. */
function contextReferences(value: unknown, map: (key: string) => string, field = ""): unknown {
  if (typeof value === "string") return referenceField.test(field) ? map(value) : value;
  if (Array.isArray(value)) return value.map(item => contextReferences(item, map, field));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    value.kind === "random_result" && key === "expected" ? structuredClone(item) : contextReferences(item, map, key)]));
}

const aliasLeaf = (schema: Value) => schema.pattern === aliasPattern || (typeof schema.const === "string" && alias.test(schema.const)) ||
  (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every(key => typeof key === "string" && alias.test(key)));

/** Collect before rewriting so overlapping union branches visit a leaf once. */
function outputReferences(value: unknown, schema: Value, map: (key: string) => string): unknown {
  const paths = new Map<string, Array<string | number>>();
  const collect = (value: unknown, schema: Value, path: Array<string | number>) => {
    if (aliasLeaf(schema) && typeof value === "string") { paths.set(JSON.stringify(path), path); return; }
    for (const union of [schema.oneOf, schema.anyOf, schema.allOf]) if (Array.isArray(union)) for (const branch of union) {
      if (!object(branch)) continue;
      const fields = object(branch.properties) ? branch.properties : undefined;
      if (fields && Object.entries(fields).some(([key, field]) => object(field) && field.const !== undefined &&
        !(typeof field.const === "string" && alias.test(field.const)) && (!object(value) || value[key] !== field.const))) continue;
      collect(value, branch, path);
    }
    if (Array.isArray(value) && object(schema.items)) value.forEach((item, index) => collect(item, schema.items as Value, [...path, index]));
    if (object(value) && object(schema.properties)) for (const [key, item] of Object.entries(value)) {
      const field = schema.properties[key]; if (object(field)) collect(item, field, [...path, key]);
    }
  };
  collect(value, schema, []);
  let result = structuredClone(value);
  for (const path of paths.values()) {
    if (!path.length) { result = map(String(result)); continue; }
    let parent = result as Record<string | number, unknown>;
    for (const key of path.slice(0, -1)) parent = parent[key] as Record<string | number, unknown>;
    const key = path.at(-1)!; parent[key] = map(String(parent[key]));
  }
  return result;
}

/** One exact visible alias dictionary; no Entity/Agent conversion or guessing. */
export class TypedCompilationAliases {
  readonly aliases: ReadonlyMap<string, string>;
  readonly inverse: ReadonlyMap<string, string>;
  readonly dictionaryHash: string;
  readonly wireJsonSchema: Value;
  private readonly sourceHash: string;
  constructor(readonly context: unknown, readonly schema: Value) {
    const catalog = object(context) && object(context.referenceCatalog) ? context.referenceCatalog.candidates : undefined;
    if (!Array.isArray(catalog) || !catalog.length) fail("missing actual catalog");
    const pairs = catalog.map(row => {
      if (!object(row) || typeof row.candidateKey !== "string" || !alias.test(row.candidateKey) ||
        typeof row.kind !== "string" || !/^[a-z]+(?:_[a-z]+)*$/u.test(row.kind)) return fail("invalid catalog binding");
      return [row.candidateKey, `${row.kind}_${row.candidateKey}`] as const;
    });
    if (new Set(pairs.map(([key]) => key)).size !== pairs.length) fail("duplicate catalog binding");
    this.aliases = new Map(pairs); this.inverse = new Map(pairs.map(([key, value]) => [value, key]));
    this.dictionaryHash = contentHash(pairs); this.sourceHash = contentHash(context);
    const kinds = [...new Set(catalog.map(row => String(row.kind)))].sort();
    const transform = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(transform);
      if (!object(value)) return value;
      const mapped = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transform(item)]));
      if (aliasLeaf(value)) {
        if (value.pattern === aliasPattern) mapped.pattern = `^(?:${kinds.join("|")})_r[0-9]{3,}$`;
        if (typeof value.const === "string") mapped.const = this.encodeKey(value.const);
        if (Array.isArray(value.enum)) mapped.enum = value.enum.map(key => this.encodeKey(String(key)));
        // Profile-choice descriptions contain structured projector evidence.
        // Parse that known envelope, never search/replace its prose strings.
        if (typeof value.description === "string" && typeof value.const === "string") {
          const evidence: unknown = JSON.parse(value.description);
          if (!object(evidence) || !Object.hasOwn(evidence, "label") || !object(evidence.details)) return fail("unrecognized profile evidence");
          mapped.description = JSON.stringify(contextReferences(evidence, this.encodeKey));
        }
      }
      return mapped;
    };
    this.wireJsonSchema = transform(schema) as Value;
  }
  private encodeKey = (key: string): string => this.aliases.get(key) ?? key;
  private assertSource() { if (contentHash(this.context) !== this.sourceHash) fail("source binding changed"); }
  encodeContext(): unknown { this.assertSource(); return contextReferences(this.context, this.encodeKey); }
  encodeOutput(value: unknown): unknown { this.assertSource(); return outputReferences(value, this.schema, this.encodeKey); }
  decodeOutput(value: unknown): unknown {
    this.assertSource();
    return outputReferences(value, this.schema, key => this.inverse.get(key) ?? `invalid-typed-alias:${key}`);
  }
  request<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
    if (request.context !== this.context || contentHash(request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" })) !== contentHash(this.schema)) return fail("request binding changed");
    const original = loadPromptAsset("shared/action-compilation-alias.md");
    if (request.system.split(original).length !== 2) return fail("source alias instruction drift");
    const system = request.system.replace(original, instruction);
    return { ...request, system, context: this.encodeContext(), wireJsonSchema: this.wireJsonSchema,
      promptVersion: `${request.promptVersion}/${TYPED_COMPILATION_ALIASES}@${this.dictionaryHash.slice(0, 16)}`,
      preprocessOutput: raw => {
        const value = this.decodeOutput(raw);
        return request.preprocessOutput?.(value) ?? { value, symbolRepairs: [] };
      } };
  }
}
