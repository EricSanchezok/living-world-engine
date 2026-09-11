import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";

type Node = Record<string, unknown>;
const object = (value: unknown): value is Node => value !== null && typeof value === "object" && !Array.isArray(value);
const reference = "#/definitions/causalAssertion";
const invalid = (): never => { throw new ModelConfigurationError("transition assertion schema reference contract changed"); };

/** Visit schema positions only; literal instance data must never be rewritten. */
function mapSchema(node: unknown, replace: (node: Node) => Node | null): unknown {
  if (!object(node)) return structuredClone(node);
  const replacement = replace(node);
  if (replacement) return replacement;
  const copy = structuredClone(node);
  for (const key of ["properties", "patternProperties"]) {
    if (object(copy[key])) copy[key] = Object.fromEntries(Object.entries(copy[key]).map(([name, schema]) => [name, mapSchema(schema, replace)]));
  }
  for (const key of ["items", "additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else"]) {
    if (object(copy[key])) copy[key] = mapSchema(copy[key], replace);
    else if (key === "items" && Array.isArray(copy[key])) copy[key] = copy[key].map(schema => mapSchema(schema, replace));
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(copy[key])) copy[key] = copy[key].map(schema => mapSchema(schema, replace));
  return copy;
}

export function expandTransitionAssertionReferences(schema: Node): Node {
  const definitions = schema.definitions;
  if (!object(definitions) || !object(definitions.causalAssertion)) return invalid();
  const original = structuredClone(schema), retained = structuredClone(definitions); delete retained.causalAssertion;
  if (Object.keys(retained).length) original.definitions = retained;
  else delete original.definitions;
  return mapSchema(original, node => {
    if (node.$ref !== reference) return null;
    if (Object.keys(node).length !== 1) return invalid();
    return structuredClone(definitions.causalAssertion) as Node;
  }) as Node;
}

export function compactTransitionAssertionSchema(schema: Node): Node {
  if (Object.hasOwn(schema, "$defs") || (Object.hasOwn(schema, "definitions") &&
    (!object(schema.definitions) || !Object.keys(schema.definitions).length || Object.hasOwn(schema.definitions, "causalAssertion")))) return invalid();
  const fields = schema.properties;
  const outcomes = object(fields) && fields.outcomes;
  const item = object(outcomes) && outcomes.items;
  const properties = object(item) && item.properties;
  const assertions = object(properties) && properties.assertions;
  const assertion = object(properties) && (properties.firstAssertion ?? (object(assertions) ? assertions.items : undefined));
  if (!object(assertion)) return invalid();
  const hash = contentHash(assertion);
  let count = 0;
  const compact = mapSchema(schema, node => {
    if (node.$ref === reference || Object.hasOwn(node, "$id")) return invalid();
    if (contentHash(node) !== hash) return null;
    count++; return { $ref: reference };
  }) as Node;
  if (count < 2) return invalid();
  compact.definitions = { ...(schema.definitions as Node | undefined), causalAssertion: structuredClone(assertion) };
  if (contentHash(expandTransitionAssertionReferences(compact)) !== contentHash(schema)) return invalid();
  return compact;
}
