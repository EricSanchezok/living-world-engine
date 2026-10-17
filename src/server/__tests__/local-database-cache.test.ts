import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FULL_CATALOG_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { parseModelCatalog } from "../../engine/models/model-catalog";
import { RecordingRuntimeObserver } from "../../engine/runtime/observability";
import { toWorldRuntimeContract } from "../../engine/runtime/world-definition";
import { createTestModelCatalog, DeterministicModelProvider } from "../../engine/testing/model-provider";
import * as loader from "../../script/world-loader";
import { JsonBlockStore } from "../json-block-store";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function fixture(count = 0) {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-read-cache-"));
  roots.push(root);
  const catalog = createTestModelCatalog();
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  const archive = new AdmZip();
  archive.addLocalFolder(path.resolve("test/fixtures/open-world-script"), "world");
  const result = database.importWorld(archive.toBuffer(), catalog);
  const imported = { ...result, contentHash: database.list()[0]!.contentHash };
  const provider = new DeterministicModelProvider(catalog);
  const host = new WorldHost({ repository: database, store: database, provider,
    defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF });
  const ids: string[] = [];
  for (let index = 0; index < count; index++) {
    ids.push((await host.createInstance({ worldId: imported.id, seed: 47, start: { kind: "observer" } })).summary.id);
  }
  return { database, catalog, imported, ids };
}

describe("bounded validated local reads", () => {
  it("keeps nine real instances warm across repeated reads and lists without sharing mutations", async () => {
    const f = await fixture(9);
    const observer = new RecordingRuntimeObserver();
    const reader = new LocalDatabase(f.database.file, { readOnly: true, observer });
    const blocks = vi.spyOn(JsonBlockStore.prototype, "read");
    try {
      const original = f.ids.map(id => reader.readInstance(id));
      expect(blocks).toHaveBeenCalledTimes(9);
      blocks.mockClear();
      expect(f.ids.map(id => reader.readInstance(id))).toEqual(original);
      const listed = reader.listInstances();
      expect(listed).toHaveLength(9);
      expect(blocks).not.toHaveBeenCalled();
      listed[0]!.document.title = "Caller mutation";
      listed[0]!.document.state.truth.events.push({} as never);
      expect(reader.readInstance(listed[0]!.document.id)).toEqual(original.find(item => item.document.id === listed[0]!.document.id));
      const reads = observer.events.filter(event => event.event === "persistence.read.completed");
      expect(reads.filter(event => event.attributes?.cacheHit === false)).toHaveLength(9);
      expect(reads.filter(event => event.attributes?.cacheHit === true)).toHaveLength(19);
    } finally { reader.close(); f.database.close(); }
  });

  it("evicts by byte budget and returns valid uncached documents larger than the budget", async () => {
    const f = await fixture(3);
    const docs = f.ids.map(id => f.database.readInstance(id));
    const maxBytes = Math.max(...docs.map(item => Buffer.byteLength(JSON.stringify(item.document), "utf8")));
    const reader = new LocalDatabase(f.database.file, { readOnly: true, instanceCacheByteBudget: maxBytes * 2 });
    const oversized = new LocalDatabase(f.database.file, { readOnly: true, instanceCacheByteBudget: 1 });
    const blocks = vi.spyOn(JsonBlockStore.prototype, "read");
    try {
      reader.readInstance(f.ids[0]!); reader.readInstance(f.ids[1]!);
      reader.readInstance(f.ids[0]!); reader.readInstance(f.ids[2]!);
      blocks.mockClear();
      expect(reader.readInstance(f.ids[0]!)).toEqual(docs[0]);
      expect(blocks).not.toHaveBeenCalled();
      expect(reader.readInstance(f.ids[1]!)).toEqual(docs[1]);
      expect(blocks).toHaveBeenCalledTimes(1);
      blocks.mockClear();
      const one = oversized.readInstance(f.ids[0]!);
      one.document.title = "Not retained";
      expect(oversized.readInstance(f.ids[0]!)).toEqual(docs[0]);
      expect(blocks).toHaveBeenCalledTimes(2);
    } finally { reader.close(); oversized.close(); f.database.close(); }
  });

  it("rejects external damage to a warm instance instead of serving cached truth", async () => {
    const f = await fixture(1);
    const reader = new LocalDatabase(f.database.file, { readOnly: true });
    const sql = new Database(f.database.file);
    try {
      reader.readInstance(f.ids[0]!);
      sql.pragma("foreign_keys = OFF");
      sql.prepare("DELETE FROM json_blocks WHERE hash = (SELECT document_hash FROM world_instances WHERE id = ?)").run(f.ids[0]);
      expect(() => reader.readInstance(f.ids[0]!)).toThrow("missing JSON block");
    } finally { sql.close(); reader.close(); f.database.close(); }
  });

  it("bounds the number of retained instances even when their byte total is small", async () => {
    const f = await fixture(1);
    const original = f.database.readInstance(f.ids[0]!).document;
    const ids = Array.from({ length: 65 }, (_, index) => `cache-count-${index}`);
    const blocks = vi.spyOn(JsonBlockStore.prototype, "read");
    try {
      for (const id of ids) f.database.createInstance({ ...original, id });
      blocks.mockClear();
      expect(f.database.readInstance(ids.at(-1)!).document.id).toBe(ids.at(-1));
      expect(blocks).not.toHaveBeenCalled();
      expect(f.database.readInstance(ids[0]!).document.id).toBe(ids[0]);
      expect(blocks).toHaveBeenCalledTimes(1);
    } finally { f.database.close(); }
  });

  it("reuses verified definitions only for the same source, seed, catalog and rule runtime", async () => {
    const f = await fixture();
    const build = vi.spyOn(loader, "buildWorldDefinition");
    try {
      const first = f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog);
      const original = structuredClone(first);
      first.laws[0]!.text = "Caller mutation";
      Object.values(first.initialState.truth.entities)[0]!.name = "Changed entity";
      expect(f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog)).toEqual(original);
      expect(build).toHaveBeenCalledTimes(1);
      expect(f.database.loadVersion(f.imported.id, f.imported.contentHash, 48, f.catalog).initialState.truth.rng.seed).toBe(48);
      expect(build).toHaveBeenCalledTimes(2);
      const changedCatalog = createTestModelCatalog(undefined, { maxInputBytes: 2_000_000 });
      f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, changedCatalog);
      expect(build).toHaveBeenCalledTimes(3);
      const invalid = f.catalog.snapshot();
      delete invalid.profiles[original.modelProfiles.decision];
      expect(() => f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, parseModelCatalog(invalid))).toThrow("unknown model profile");
      f.database.rulePackages.register({ id: "custom-validation", version: "1.0.0", configSchema: z.strictObject({}), adjudication: "Custom runtime", rules: [] });
      build.mockClear();
      f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog);
      f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog);
      expect(build).toHaveBeenCalledTimes(2);
    } finally { f.database.close(); }
  });

  it("rejects external template corruption after a successful cached load", async () => {
    const f = await fixture();
    const sql = new Database(f.database.file);
    try {
      f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog);
      const row = sql.prepare("SELECT template_json FROM world_versions WHERE world_id = ?").get(f.imported.id) as { template_json: string };
      const template = JSON.parse(row.template_json);
      template.manifest.description = "Changed without updating content identity";
      sql.prepare("UPDATE world_versions SET template_json = ? WHERE world_id = ?").run(JSON.stringify(template), f.imported.id);
      expect(() => f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog)).toThrow("content hash mismatch");
    } finally { sql.close(); f.database.close(); }
  });

  it("bounds definition variants and bypasses a definition larger than its byte budget", async () => {
    const f = await fixture();
    const reader = new LocalDatabase(f.database.file, { readOnly: true, definitionCacheByteBudget: 1 });
    const build = vi.spyOn(loader, "buildWorldDefinition");
    try {
      for (let seed = 1; seed <= 17; seed++) f.database.loadVersion(f.imported.id, f.imported.contentHash, seed, f.catalog);
      build.mockClear();
      f.database.loadVersion(f.imported.id, f.imported.contentHash, 17, f.catalog);
      expect(build).not.toHaveBeenCalled();
      f.database.loadVersion(f.imported.id, f.imported.contentHash, 1, f.catalog);
      expect(build).toHaveBeenCalledTimes(1);
      build.mockClear();
      const first = reader.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog);
      expect(reader.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog)).toEqual(first);
      expect(build).toHaveBeenCalledTimes(2);
    } finally { reader.close(); f.database.close(); }
  });

  it("revalidates mutable custom rule validators instead of caching their prior result", async () => {
    const f = await fixture();
    let valid = true;
    try {
      f.database.rulePackages.register({ id: "mutable-rule", version: "1.0.0",
        configSchema: z.strictObject({}).refine(() => valid, "Custom validation changed"),
        adjudication: "Custom runtime", rules: [] });
      const archive = new AdmZip();
      const directory = path.resolve("test/fixtures/open-world-script");
      archive.addLocalFolder(directory, "world");
      archive.updateFile("world/mechanics.yaml", Buffer.from(readFileSync(path.join(directory, "mechanics.yaml"), "utf8")
        .replace("    config: {}\nmeters:", "    config: {}\n  - id: mutable-rule\n    version: 1.0.0\n    config: {}\nmeters:")));
      f.database.importWorld(archive.toBuffer(), f.catalog, true);
      const hash = f.database.list()[0]!.contentHash;
      expect(f.database.loadVersion(f.imported.id, hash, 47, f.catalog).rulePackages[1]!.id).toBe("mutable-rule");
      valid = false;
      expect(() => f.database.loadVersion(f.imported.id, hash, 47, f.catalog)).toThrow("Custom validation changed");
    } finally { f.database.close(); }
  });

  it("projects the same runtime contract without cloning excluded initial state or sharing contract values", async () => {
    const f = await fixture();
    try {
      const definition = f.database.loadVersion(f.imported.id, f.imported.contentHash, 47, f.catalog);
      const expected = structuredClone(definition) as Partial<typeof definition>;
      delete expected.initialState; delete expected.assetData;
      const clone = vi.spyOn(globalThis, "structuredClone");
      const contract = toWorldRuntimeContract(definition);
      expect(contract).toEqual(expected);
      expect(clone).toHaveBeenCalledTimes(1);
      expect(clone.mock.calls[0]![0]).not.toHaveProperty("initialState");
      expect(clone.mock.calls[0]![0]).not.toHaveProperty("assetData");
      contract.laws[0]!.text = "Changed contract";
      contract.modelProfiles.decision = "Changed profile";
      expect(definition.laws[0]!.text).toBe(expected.laws![0]!.text);
      expect(definition.modelProfiles.decision).toBe(expected.modelProfiles!.decision);
    } finally { f.database.close(); }
  });
});
