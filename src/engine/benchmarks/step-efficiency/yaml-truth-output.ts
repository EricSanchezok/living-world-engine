import { isAlias, isNode, isPair, isScalar, parseDocument, stringify, visit } from "yaml";
import { assertJsonValue } from "../../runtime/json";
import { contentHash } from "../../models/model-audit";
import { recordedContext, scoreRepairTail, type RepairTailKind } from "./repair-tail";
import type { TemporalProbeBody } from "./temporal-diagnostic";
import { unwrapExperimentDocument } from "./document-wrapper";
import { FlatTruthBatchCodec } from "./flat-truth-batch";

const jsonCoreTags = new Set(["map", "seq", "str", "bool", "int", "float", "null"].map(name => `tag:yaml.org,2002:${name}`));

/** One strict YAML 1.2 document containing JSON values only. The explicit
 * json-core policy accepts standard JSON-compatible type declarations such as
 * !!map; it never infers or changes a field. Historical trials default to no
 * explicit tags. Neither policy accepts aliases, anchors, custom tags, syntax
 * repair, duplicate/non-string keys, nonfinite values or a second document. */
export function parseYamlTruthOutput(text: string, tagPolicy: "none" | "json-core" = "none") {
  const document = parseDocument(text, { version: "1.2", schema: "core", uniqueKeys: true, strict: true });
  if (document.errors.length || document.warnings.length || document.directives?.yaml.version !== "1.2") {
    throw new Error(`invalid YAML output: ${[...document.errors, ...document.warnings].map((e) => e.message).join("; ") || "YAML version mismatch"}`);
  }
  visit(document, (_key, node) => {
    if (isAlias(node) || (isNode(node) && (node.anchor || (node.tag && (tagPolicy !== "json-core" || !jsonCoreTags.has(node.tag)))))) throw new Error("YAML output cannot contain aliases, anchors or unsupported tags");
    if (isPair(node) && (!isScalar(node.key) || typeof node.key.value !== "string")) throw new Error("YAML output requires string object keys");
  });
  const value: unknown = document.toJS({ maxAliasCount: 0, mapAsMap: false });
  assertJsonValue(value, "YAML output");
  return value;
}

export function scoreYamlTruthOutput(text: string, kind: RepairTailKind, contexts: readonly unknown[]) {
  let rawJson = true;try { JSON.parse(text); } catch { rawJson = false; }
  try {
    const value = parseYamlTruthOutput(text);
    return { ...scoreRepairTail(JSON.stringify(value), kind, contexts), rawJson, rawYaml: true };
  } catch (error) {
    return { rawJson, rawYaml: false, schemaCoverageReferences: false, slots: 0, fullSemantics: "unassessed",
      error: error instanceof Error ? error.message : String(error) };
  }
}

/** Both arms receive the same lossless document-wrapper foundation. JSON
 * punctuation and YAML indentation are never repaired. */
export function scoreWrappedTruthOutput(text: string, format: "json" | "yaml", kind: RepairTailKind, contexts: readonly unknown[], decode: (value: unknown) => unknown = (value) => value) {
  let rawJson = true;try { JSON.parse(text); } catch { rawJson = false; }
  let rawYaml = false;
  if (format === "yaml") { try { parseYamlTruthOutput(text);rawYaml = true; } catch { /* Raw status stays false. */ } }
  const unwrapped = unwrapExperimentDocument(text);
  const raw = { rawJson, ...(format === "yaml" ? { rawYaml } : {}),
    rawFormatPassed: format === "json" ? rawJson : rawYaml, wrapperRecovery: unwrapped.recovery };
  let recoveredFormatPassed = false;
  try {
    const value: unknown = format === "json" ? JSON.parse(unwrapped.text) : parseYamlTruthOutput(unwrapped.text);
    assertJsonValue(value, "recovered output");
    recoveredFormatPassed = true;
    return { ...scoreRepairTail(JSON.stringify(decode(value)), kind, contexts), ...raw, recoveredFormatPassed: true };
  } catch (error) {
    return { ...raw, recoveredFormatPassed, schemaCoverageReferences: false, slots: 0, fullSemantics: "unassessed",
      error: error instanceof Error ? error.message : String(error) };
  }
}

export type YamlTruthBody = Omit<TemporalProbeBody, "response_format"> & { response_format: { type: "text" } };

/** Preserve the original nested object schema and complete source context.
 * Only output serialization and the matching provider response format change. */
export function yamlTruthBody(source: TemporalProbeBody): YamlTruthBody {
  if (source.thinking.type !== "disabled") throw new Error("YAML output keeps thinking disabled");
  const body: YamlTruthBody = { ...structuredClone(source), response_format: { type: "text" } };
  const message = body.messages[1]!.content, context = recordedContext(message);
  const directive = "Return exactly one JSON object matching the supplied schema. Do not use Markdown or explanatory prose.";
  const suffix = message.slice(context.end);
  if (suffix.split(directive).length !== 2 || suffix.split("\nExample JSON output shape: ").length !== 2) throw new Error("source output serialization instruction mismatch");
  const [beforeExample, exampleTail] = suffix.split("\nExample JSON output shape: ");
  const lineEnd = exampleTail!.indexOf("\n");
  if (lineEnd < 0) throw new Error("complete source example boundary required");
  const example = JSON.parse(exampleTail!.slice(0, lineEnd));
  const notice = "Return exactly one YAML 1.2 document encoding the object required by the supplied JSON Schema. Use block indentation for object/array nesting; empty arrays remain []. Keep every original field, slot, type, value, reference and action meaning. Quote strings when needed to distinguish them from numbers, booleans or null, or when they contain YAML punctuation. Do not use Markdown fences, explanatory prose, tags, anchors, aliases, duplicate keys or multiple documents. This changes serialization only; the original schema and task coverage remain mandatory.";
  body.messages[1]!.content = `${message.slice(0, context.end)}${beforeExample!.replace(directive, notice)}\nExample YAML output shape:\n${stringify(example)}${exampleTail!.slice(lineEnd)}`;
  if (contentHash(recordedContext(body.messages[1]!.content).value) !== contentHash(context.value)) throw new Error("YAML output changed source context");
  return body;
}

/** Compose two explicit output representations without changing the source task. */
export function flatYamlTruthBody(source: TemporalProbeBody, codec: FlatTruthBatchCodec): YamlTruthBody {
  const flat = codec.body(source);
  const label = "Example JSON output shape (columns only; real output must cover every assigned action): ";
  const message = flat.messages[1]!.content, context = recordedContext(message);
  const suffix = message.slice(context.end);
  if (suffix.split(label).length !== 2) throw new Error("flat example boundary mismatch");
  flat.messages[1]!.content = message.slice(0, context.end) + suffix.replace(label,
    "Example columns only; real output must cover every assigned action.\nExample JSON output shape: ");
  return yamlTruthBody(flat);
}
