import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { assertJsonValue, type JsonValue } from "./json";

const pathSchema = z.array(z.string());
const changeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), path: pathSchema, value: z.json() }).strict(),
  z.object({ kind: z.literal("remove"), path: pathSchema }).strict(),
  z.object({ kind: z.literal("splice"), path: pathSchema, start: z.number().int().nonnegative(),
    deleteCount: z.number().int().nonnegative(), values: z.array(z.json()) }).strict(),
]);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const deltaSchema = z.object({ version: z.literal(1), baseHash: hashSchema, resultHash: hashSchema,
  changes: z.array(changeSchema) }).strict();
type JsonChange = { kind: "set"; path: string[]; value: JsonValue } | { kind: "remove"; path: string[] } |
  { kind: "splice"; path: string[]; start: number; deleteCount: number; values: JsonValue[] };
export interface JsonDelta { version: 1; baseHash: string; resultHash: string; changes: JsonChange[] }
const record = (value: JsonValue): value is Record<string, JsonValue> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Deterministic, lossless journal encoding; this is never a model-authored world operation. */
export function createJsonDelta(before: JsonValue, after: JsonValue): JsonDelta {
  assertJsonValue(before, "delta base"); assertJsonValue(after, "delta result");
  const changes: JsonDelta["changes"] = [];
  const visit = (left: JsonValue, right: JsonValue, path: string[]) => {
    if (left === right) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const common = Math.min(left.length, right.length);
      for (let i = 0; i < common; i++) visit(left[i]!, right[i]!, [...path, String(i)]);
      if (left.length !== right.length) changes.push({ kind: "splice", path, start: common,
        deleteCount: left.length - common, values: structuredClone(right.slice(common)) });
    } else if (record(left) && record(right)) {
      for (const key of Object.keys(left).sort()) if (!Object.hasOwn(right, key)) changes.push({ kind: "remove", path: [...path, key] });
      for (const key of Object.keys(right).sort()) {
        if (Object.hasOwn(left, key)) visit(left[key]!, right[key]!, [...path, key]);
        else changes.push({ kind: "set", path: [...path, key], value: structuredClone(right[key]!) });
      }
    } else changes.push({ kind: "set", path, value: structuredClone(right) });
  };
  visit(before, after, []);
  return { version: 1, baseHash: contentHash(before), resultHash: contentHash(after), changes };
}

export function applyJsonDelta(before: JsonValue, input: JsonDelta): JsonValue {
  assertJsonValue(before, "delta base");
  const delta = deltaSchema.parse(input);
  if (contentHash(before) !== delta.baseHash) throw new Error("journal delta base mismatch");
  let result = structuredClone(before);
  const at = (path: string[]): JsonValue => {
    let value = result;
    for (const key of path) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key) || Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(key)) {
        throw new Error("journal delta path is absent");
      }
      value = (value as Record<string, JsonValue>)[key]!;
    }
    return value;
  };
  for (const change of delta.changes) {
    if (change.kind === "splice") {
      const target = at(change.path);
      if (!Array.isArray(target) || change.start + change.deleteCount > target.length) throw new Error("invalid journal array splice");
      target.splice(change.start, change.deleteCount, ...structuredClone(change.values));
    } else if (!change.path.length) {
      if (change.kind !== "set") throw new Error("cannot remove the journal root");
      result = structuredClone(change.value);
    } else {
      const target = at(change.path.slice(0, -1)), key = change.path.at(-1)!;
      if (!target || typeof target !== "object") throw new Error("journal delta parent is not a container");
      if (Array.isArray(target) && (!/^(0|[1-9][0-9]*)$/u.test(key) || Number(key) >= target.length || change.kind !== "set")) {
        throw new Error("journal array entries require existing indexed replacements");
      }
      if (change.kind === "remove") {
        if (!Object.hasOwn(target, key)) throw new Error("journal removal is absent");
        delete (target as Record<string, JsonValue>)[key];
      } else Object.defineProperty(target, key, { value: structuredClone(change.value), enumerable: true, configurable: true, writable: true });
    }
  }
  assertJsonValue(result, "delta result");
  if (contentHash(result) !== delta.resultHash) throw new Error("journal delta result mismatch");
  return result;
}
