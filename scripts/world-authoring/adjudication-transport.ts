import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import type { SourceParagraph } from "./extraction-contract";
import type { AdjudicationInput } from "./source-adjudication";

const sourceReference = z.object({
  chapterId: z.string(), paragraphId: z.string(), paragraphSha256: z.string(),
  start: z.number().int().nonnegative(), end: z.number().int().positive(),
  anchorSha256: z.string(), sourceVersion: z.string().optional(),
});

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Only evidence entries carry transport references; prose and source locators stay untouched. */
function mapReferences(value: unknown, references: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map(item => mapReferences(item, references));
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    key === "evidence" && Array.isArray(entry)
      ? entry.map(citation => isObject(citation) && typeof citation.paragraph === "string"
        ? { ...citation, paragraph: references.get(citation.paragraph) ?? citation.paragraph }
        : citation)
      : mapReferences(entry, references),
  ]));
}

type SchemaPosition = "ordinary" | "evidence" | "citation" | "paragraph";

/** Preserve shared definitions without changing an enum reused outside evidence. */
function wireJsonSchema(schema: z.ZodType, references: ReadonlyMap<string, string>) {
  const canonical = z.toJSONSchema(schema, { reused: "ref" });
  const definitions: Record<string, unknown> = {};
  const referenceNames = new Map<string, string>();
  const compositions = new Set(["allOf", "anyOf", "oneOf", "not", "if", "then", "else"]);
  const schemaChildren = new Set(["additionalProperties", "unevaluatedProperties", "propertyNames", "contains"]);
  const schemaMaps = new Set(["patternProperties", "dependentSchemas"]);

  function resolve(reference: string): unknown {
    let value: unknown = canonical;
    for (const token of reference.slice(2).split("/")) {
      if (!isObject(value)) throw new Error(`unresolvable adjudication schema reference ${reference}`);
      value = value[token.replace(/~1/gu, "/").replace(/~0/gu, "~")];
    }
    if (value === undefined) throw new Error(`unresolvable adjudication schema reference ${reference}`);
    return value;
  }

  function visit(value: unknown, position: SchemaPosition): unknown {
    if (Array.isArray(value)) return value.map(item => visit(item, position));
    if (!isObject(value)) return value;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$defs") continue;
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) {
        const identity = `${position}\0${child}`;
        let name = referenceNames.get(identity);
        if (!name) {
          name = `transport${referenceNames.size}`;
          referenceNames.set(identity, name);
          definitions[name] = visit(resolve(child), position);
        }
        output[key] = `#/$defs/${name}`;
      } else if (key === "properties" && isObject(child)) {
        output[key] = Object.fromEntries(Object.entries(child).map(([property, definition]) => [property,
          visit(definition, property === "evidence" ? "evidence"
            : position === "citation" && property === "paragraph" ? "paragraph" : "ordinary"),
        ]));
      } else if (key === "items" || key === "prefixItems") {
        output[key] = visit(child, position === "evidence" ? "citation" : "ordinary");
      } else if (position === "paragraph" && key === "enum" && Array.isArray(child)) {
        output[key] = child.map(item => typeof item === "string" ? references.get(item) ?? item : item);
      } else if (position === "paragraph" && key === "const" && typeof child === "string") {
        output[key] = references.get(child) ?? child;
      } else if (compositions.has(key)) {
        output[key] = visit(child, position);
      } else if (schemaChildren.has(key)) {
        output[key] = visit(child, "ordinary");
      } else if (schemaMaps.has(key) && isObject(child)) {
        output[key] = Object.fromEntries(Object.entries(child).map(([name, definition]) => [name, visit(definition, "ordinary")]));
      } else {
        output[key] = child;
      }
    }
    return output;
  }

  const result = visit(canonical, "ordinary") as typeof canonical;
  if (Object.keys(definitions).length) result.$defs = definitions as typeof result.$defs;
  return result;
}

export function createAdjudicationTransport<T extends AdjudicationInput>(report: T, paragraphs: SourceParagraph[]) {
  if (!paragraphs.length) throw new Error("adjudication transport requires complete source paragraphs");
  const byId = new Map<string, SourceParagraph>();
  const encoded = new Map<string, string>(), decoded = new Map<string, string>();
  for (const [index, paragraph] of paragraphs.entries()) {
    if (byId.has(paragraph.id)) throw new Error(`duplicate adjudication source paragraph ${paragraph.id}`);
    if (!Number.isSafeInteger(paragraph.start) || paragraph.start < 0 ||
      !Number.isSafeInteger(paragraph.end) || paragraph.end !== paragraph.start + [...paragraph.text].length ||
      contentHash(paragraph.text) !== paragraph.sha256) {
      throw new Error(`adjudication source paragraph drift ${paragraph.id}`);
    }
    byId.set(paragraph.id, paragraph);
    encoded.set(paragraph.id, `p${index}`);
    decoded.set(`p${index}`, paragraph.id);
  }

  function candidate<C extends { id: string }>(record: C) {
    const evidence = z.array(sourceReference).parse(Reflect.get(record, "evidence")).map(ref => {
      const paragraph = byId.get(ref.paragraphId);
      if (!paragraph || paragraph.chapterId !== ref.chapterId || paragraph.sha256 !== ref.paragraphSha256 ||
        (ref.sourceVersion !== undefined && ref.sourceVersion !== (paragraph.sourceVersion ?? "candidate-2fc16984")) ||
        !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) ||
        ref.start < paragraph.start || ref.end > paragraph.end || ref.end <= ref.start) {
        throw new Error(`adjudication candidate source drift ${record.id}: ${ref.paragraphId}`);
      }
      const quote = [...paragraph.text].slice(ref.start - paragraph.start, ref.end - paragraph.start).join("");
      if (contentHash(quote) !== ref.anchorSha256) {
        throw new Error(`adjudication candidate quote drift ${record.id}: ${ref.paragraphId}`);
      }
      return { paragraph: encoded.get(paragraph.id)!, quote };
    });
    return { ...structuredClone(record), evidence };
  }

  return {
    paragraphs: paragraphs.map(paragraph => ({ id: encoded.get(paragraph.id)!, chapterId: paragraph.chapterId, text: paragraph.text })),
    candidates: { chapters: [...report.chapters], objects: report.objects.map(candidate), facts: report.facts.map(candidate),
      issues: report.issues.map(candidate) },
    wireParagraphs: paragraphs.map(paragraph => ({ ...paragraph, id: encoded.get(paragraph.id)! })),
    encode: (value: unknown) => mapReferences(value, encoded),
    decode: (value: unknown) => mapReferences(value, decoded),
    jsonSchema: (schema: z.ZodType) => wireJsonSchema(schema, encoded),
  };
}
