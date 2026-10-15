import Database from "better-sqlite3";
import { gzipSync, gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { JsonBlockStore } from "../json-block-store";

function fixture() {
  const connection = new Database(":memory:");
  connection.exec("CREATE TABLE json_blocks (hash TEXT PRIMARY KEY, body BLOB NOT NULL) STRICT");
  const blocks = new JsonBlockStore(connection);
  const put = connection.transaction((value: unknown) => blocks.put(value));
  const rows = () => connection.prepare("SELECT hash, body FROM json_blocks ORDER BY hash").all();
  return { connection, blocks, put, rows };
}

describe("immutable JSON storage", () => {
  it("shares history across snapshots and writes a paragraph independently of old history size", () => {
    const f = fixture();
    try {
      for (const length of [10, 1000]) {
        const state = { history: Array.from({ length }, (_, revision) => ({ revision, evidence: `record-${revision}:` + "界".repeat(2_000) })) };
        const first = { state, narratives: [{ segments: ["第一段"] }] };
        const root = f.put(first);
        const before = f.rows();
        const next = { ...first, narratives: [{ segments: ["第一段", "第二段"] }] };
        const changed = f.put(next);
        expect(changed.writtenBytes).toBeLessThan(1_000);
        expect(f.blocks.read(root.hash)).toEqual(first);
        expect(f.blocks.read(changed.hash)).toEqual(next);
        const after = new Map((f.rows() as Array<{ hash: string; body: Buffer }>).map(row => [row.hash, row.body]));
        for (const row of before as Array<{ hash: string; body: Buffer }>) expect(after.get(row.hash)).toEqual(row.body);
        expect(f.put(next).writtenBytes).toBe(0);
      }
    } finally { f.connection.close(); }
  });

  it("round-trips arbitrary model JSON without reference-tag or scalar collisions", () => {
    const f = fixture();
    try {
      const values = [null, "null", 123, "123", { kind: "array", children: ["fake"], $ref: "fake", text: "界".repeat(5_000) }];
      const roots = values.map(value => f.put(value));
      expect(new Set(roots.map(root => root.hash)).size).toBe(values.length);
      roots.forEach((root, index) => expect(f.blocks.read(root.hash)).toEqual(values[index]));
    } finally { f.connection.close(); }
  });

  it("hydrates equal blocks as independent mutable JSON occurrences", () => {
    const f = fixture();
    try {
      const root = f.put({ a: { items: [], padding: "x".repeat(5_000) }, b: { items: [], padding: "x".repeat(5_000) } });
      const value = f.blocks.read(root.hash) as { a: { items: string[] }; b: { items: string[] } };
      value.a.items.push("changed");
      expect(value.b.items).toEqual([]);
      expect((f.blocks.read(root.hash) as typeof value).a.items).toEqual([]);
    } finally { f.connection.close(); }
  });

  it.each(["missing", "changed", "reordered"])("rejects %s historical blocks", mode => {
    const f = fixture();
    try {
      const root = f.put(["a".repeat(5_000), "b".repeat(5_000)]);
      const row = f.connection.prepare("SELECT body FROM json_blocks WHERE hash = ?").get(root.hash) as { body: Buffer };
      const block = JSON.parse(gunzipSync(row.body).toString()) as { children: string[] };
      if (mode === "missing") f.connection.prepare("DELETE FROM json_blocks WHERE hash = ?").run(block.children[0]);
      if (mode === "changed") f.connection.prepare("UPDATE json_blocks SET body = ? WHERE hash = ?").run(gzipSync(JSON.stringify({ kind: "value", value: "changed" })), block.children[0]);
      if (mode === "reordered") f.connection.prepare("UPDATE json_blocks SET body = ? WHERE hash = ?").run(gzipSync(JSON.stringify({ ...block, kind: "array", children: block.children.toReversed() })), root.hash);
      expect(() => f.blocks.read(root.hash)).toThrow(/JSON block/);
    } finally { f.connection.close(); }
  });

  it("rolls new blocks back with their owner transaction and permits a later retry", () => {
    const f = fixture();
    try {
      f.put({ original: true });
      const before = f.rows();
      expect(() => f.connection.transaction(() => {
        f.blocks.put({ newEvidence: "evidence".repeat(5_000) });
        throw new Error("CAS conflict");
      })()).toThrow("CAS conflict");
      expect(f.rows()).toEqual(before);
      const saved = f.put({ newEvidence: "evidence".repeat(5_000) });
      expect(f.blocks.read(saved.hash)).toEqual({ newEvidence: "evidence".repeat(5_000) });
    } finally { f.connection.close(); }
  });
});
