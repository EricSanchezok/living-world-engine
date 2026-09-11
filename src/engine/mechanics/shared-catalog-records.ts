import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";
import { expandSharedCatalogPrefix, SHARED_CATALOG_PREFIX_CODEC } from "./shared-catalog-prefix";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);
const variableKeys = ["handle", "label", "statePath"];
const fail = (): never => { throw new ModelConfigurationError("shared catalog records: invalid source or template binding"); };
export const SHARED_CATALOG_RECORDS_CODEC = "shared-json-v3-catalog-v1";

function catalog(value: ObjectValue): ObjectValue | undefined {
  return object(value.shared) && object(value.shared.referenceCatalog) ? value.shared.referenceCatalog : undefined;
}

/** Factor equal record fields only; even absent fields and partial shared records retain their meaning. */
export function compactSharedCatalogRecords(value: unknown): ObjectValue {
  if (!object(value) || value.codec !== SHARED_CATALOG_PREFIX_CODEC) return fail();
  expandSharedCatalogPrefix(value);
  const copy = structuredClone(value), target = catalog(copy);
  if (!target || !object(target.candidates)) return copy;
  const templates: ObjectValue[] = [], ids = new Map<string, number>();
  const rows = Object.fromEntries(Object.keys(target.candidates).sort().map(handle => {
    const record = (target.candidates as ObjectValue)[handle];
    if (!object(record)) return fail();
    const template = Object.fromEntries(Object.entries(record).filter(([key]) => !variableKeys.includes(key)));
    const fields = Object.fromEntries(Object.entries(record).filter(([key]) => variableKeys.includes(key)));
    const hash = contentHash(template);
    if (!ids.has(hash)) { ids.set(hash, templates.length); templates.push(template); }
    return [handle, [ids.get(hash)!, fields]];
  }));
  target.candidates = { templates, rows };
  return { ...copy, codec: SHARED_CATALOG_RECORDS_CODEC };
}

/** Expand templates before applying the original slot deltas and checking every logical source hash. */
export function expandSharedCatalogRecords(value: unknown): ObjectValue {
  if (!object(value)) return fail();
  if (value.codec === SHARED_CATALOG_PREFIX_CODEC) {
    expandSharedCatalogPrefix(value);
    if (contentHash(compactSharedCatalogRecords(value)) !== contentHash(value)) return fail();
    return structuredClone(value);
  }
  if (value.codec !== SHARED_CATALOG_RECORDS_CODEC) return fail();
  const copy = structuredClone(value), target = catalog(copy), table = target?.candidates;
  if (!target || !object(table) || Object.keys(table).sort().join(",") !== "rows,templates" ||
    !Array.isArray(table.templates) || !object(table.rows) || table.templates.some(template =>
      !object(template) || Object.keys(template).some(key => variableKeys.includes(key)))) return fail();
  const templates = table.templates;
  target.candidates = Object.fromEntries(Object.entries(table.rows).map(([handle, row]) => {
    if (!Array.isArray(row) || row.length !== 2 || !Number.isSafeInteger(row[0]) || row[0] < 0 || !templates[row[0]] ||
      !object(row[1]) || Object.keys(row[1]).some(key => !variableKeys.includes(key))) return fail();
    return [handle, { ...templates[row[0]], ...row[1] }];
  }));
  copy.codec = SHARED_CATALOG_PREFIX_CODEC;
  expandSharedCatalogPrefix(copy);
  if (contentHash(compactSharedCatalogRecords(copy)) !== contentHash(value)) return fail();
  return copy;
}
