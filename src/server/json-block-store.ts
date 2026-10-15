import { gzipSync, gunzipSync } from "node:zlib";
import type Database from "better-sqlite3";
import { canonicalize, contentHash, isSha256 } from "../engine/models/model-audit";
import type { JsonValue } from "../engine/runtime/json";

const LEAF_BYTES = 4_096;
type Block = { kind: "value"; value: JsonValue }
  | { kind: "array"; children: string[] }
  | { kind: "object"; children: Array<[string, string]> };

/** One immutable representation shared by instance roots and Ledger evidence.
 * Call put inside the transaction that publishes its root. Tags belong to the
 * codec, never to user JSON, so arbitrary world/model data round-trips exactly. */
export class JsonBlockStore {
  constructor(private readonly connection: Database.Database) {}

  put(input: unknown): { hash: string; rawBytes: number; writtenBytes: number } {
    const serialized = JSON.stringify(canonicalize(input));
    if (serialized === undefined) throw new Error("stored value must be JSON serializable");
    const value = JSON.parse(serialized) as JsonValue;
    let writtenBytes = 0;
    const visit = (value: JsonValue, serialized = JSON.stringify(value)): string => {
      const hash = contentHash(serialized);
      if (this.connection.prepare("SELECT 1 FROM json_blocks WHERE hash = ?").get(hash)) return hash;
      const large = Buffer.byteLength(serialized, "utf8") > LEAF_BYTES;
      const block: Block = large && Array.isArray(value)
        ? { kind: "array", children: value.map(child => visit(child)) }
        : large && value !== null && typeof value === "object" && !Array.isArray(value)
          ? { kind: "object", children: Object.entries(value).map(([key, child]) => [key, visit(child)]) }
          : { kind: "value", value };
      const body = gzipSync(JSON.stringify(block));
      this.connection.prepare("INSERT INTO json_blocks(hash, body) VALUES (?, ?)").run(hash, body);
      writtenBytes += body.byteLength;
      return hash;
    };
    return { hash: visit(value, serialized), rawBytes: Buffer.byteLength(serialized, "utf8"), writtenBytes };
  }

  read(hash: string): JsonValue {
    // Memoization is scoped to this read, so rollback or external corruption can
    // never be hidden by a process-wide block cache.
    const values = new Map<string, JsonValue>();
    const visiting = new Set<string>();
    const visit = (hash: string): JsonValue => {
      if (!isSha256(hash) || visiting.has(hash)) throw new Error(`invalid JSON block reference ${hash}`);
      // Equal stored values are distinct mutable JSON occurrences after hydration.
      if (values.has(hash)) return structuredClone(values.get(hash)!);
      const row = this.connection.prepare("SELECT body FROM json_blocks WHERE hash = ?").get(hash) as { body: Buffer } | undefined;
      if (!row) throw new Error(`missing JSON block ${hash}`);
      visiting.add(hash);
      const block = JSON.parse(gunzipSync(row.body).toString("utf8")) as Block;
      let value: JsonValue;
      if (block.kind === "value") value = block.value;
      else if (block.kind === "array") value = block.children.map(child => visit(child));
      else if (block.kind === "object") {
        if (new Set(block.children.map(([key]) => key)).size !== block.children.length) throw new Error(`duplicate JSON block keys ${hash}`);
        value = Object.fromEntries(block.children.map(([key, child]) => [key, visit(child)]));
      } else throw new Error(`unknown JSON block encoding ${hash}`);
      if (contentHash(JSON.stringify(canonicalize(value))) !== hash) throw new Error(`JSON block hash mismatch ${hash}`);
      visiting.delete(hash);
      values.set(hash, value);
      return value;
    };
    return structuredClone(visit(hash));
  }
}
