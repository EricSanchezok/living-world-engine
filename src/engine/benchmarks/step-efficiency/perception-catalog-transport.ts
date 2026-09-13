import { compactCatalogRecords, expandCatalogRecords } from "../../mechanics/shared-catalog-records";
import { canonicalize, contentHash } from "../../models/model-audit";
import { ModelConfigurationError } from "../../models/model-provider";

type Value = Record<string, unknown>;
const object = (v: unknown): v is Value => v !== null && typeof v === "object" && !Array.isArray(v);
const codec = "ordered-catalog-records-v1";
const instruction = `\n\nLossless reference catalog representation: referenceCatalog.candidates uses ${codec}. Read rows in their original order. Each row [templateIndex, fields] means the complete original candidate { ...templates[templateIndex], ...fields }. Templates contain all original kind, meaning, allowedUses, visibility and other shared fields; fields retains the original handle, label and statePath when present. Nothing is omitted. The original catalog hash describes the expanded candidates. Choose exact original handles with their original allowedUses, never template or row indices. All other context, source assignments, evidence and the output schema are unchanged.`;
export const PERCEPTION_CATALOG_TRANSPORT = `${codec}@${contentHash(instruction).slice(0, 16)}`;

export function compactPerceptionCatalog(context: unknown): Value {
  if (!object(context) || !object(context.referenceCatalog) || !Array.isArray(context.referenceCatalog.candidates)) {
    throw new ModelConfigurationError("perception catalog requires the complete original catalog");
  }
  const copy = structuredClone(context);
  const catalog = copy.referenceCatalog as Value;
  catalog.candidates = { codec, ...compactCatalogRecords(context.referenceCatalog.candidates) };
  if (contentHash(expandPerceptionCatalog(copy, contentHash(context))) !== contentHash(context)) {
    throw new ModelConfigurationError("perception catalog round trip changed the complete source");
  }
  return copy;
}

export function expandPerceptionCatalog(context: unknown, sourceHash: string): Value {
  if (!object(context) || !object(context.referenceCatalog) || !object(context.referenceCatalog.candidates) ||
    context.referenceCatalog.candidates.codec !== codec) throw new ModelConfigurationError("unknown perception catalog codec");
  const copy = structuredClone(context), catalog = copy.referenceCatalog as Value;
  const { codec: _codec, ...table } = catalog.candidates as Value;
  void _codec;
  catalog.candidates = expandCatalogRecords(table);
  if (contentHash(copy) !== sourceHash) throw new ModelConfigurationError("perception catalog source binding changed");
  return copy;
}

/** Physical-only experiment: the original gateway still validates the complete canonical catalog. */
export function perceptionCatalogTransport(body: unknown, sourceContext: unknown): Value {
  if (!object(body) || !Array.isArray(body.messages)) throw new ModelConfigurationError("missing perception HTTP messages");
  const source = JSON.stringify(canonicalize(sourceContext));
  const encoded = JSON.stringify(canonicalize(compactPerceptionCatalog(sourceContext)));
  const copy = structuredClone(body);
  const users = (copy.messages as unknown[]).filter(message => object(message) && message.role === "user");
  if (users.length !== 1 || !object(users[0]) || typeof users[0].content !== "string") throw new ModelConfigurationError("ambiguous perception user message");
  const user = users[0], content = user.content as string;
  if (content.split(source).length !== 2 || content.includes(instruction)) throw new ModelConfigurationError("perception HTTP source mismatch");
  user.content = content.replace(source, encoded) + instruction;
  return copy;
}
