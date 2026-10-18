import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicModelProvider } from "../../engine/testing/model-provider";
import { loadModelCatalog } from "../../engine/models/model-catalog";
import { installBundledWorlds, type BundledWorldId } from "../bundled-worlds";
import { LocalDatabase } from "../local-database";

const temporaryRoots: string[] = [];
const bundledWorldModelCatalog = loadModelCatalog();

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDatabase(): { database: LocalDatabase; file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "livingworld-bundled-worlds-test-"));
  temporaryRoots.push(root);
  const file = path.join(root, "livingworld.sqlite");
  return { database: new LocalDatabase(file, { heartbeat: false }), file };
}

describe("bundled world installation", () => {
  it("installs the bundled worlds through the strict importer for a fresh database", () => {
    const provider = new DeterministicModelProvider(bundledWorldModelCatalog, false);
    const { database } = temporaryDatabase();

    expect(database.created).toBe(true);
    expect(installBundledWorlds(database, provider.catalog)).toEqual([
      expect.objectContaining({ id: "blackmarsh", name: "黑沼边境", replaced: false }),
      expect.objectContaining({ id: "fanren", name: "凡人修仙传", replaced: false }),
    ]);
    expect(database.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "blackmarsh", version: "1.2.0" }),
      expect.objectContaining({ id: "fanren", version: "1.0.0" }),
    ]));
    expect(database.list()).toHaveLength(2);
    database.close();
  });

  it("does not restore a bundled world after the database has been established", () => {
    const provider = new DeterministicModelProvider(bundledWorldModelCatalog, false);
    const initial = temporaryDatabase();
    installBundledWorlds(initial.database, provider.catalog);
    initial.database.deleteWorld("blackmarsh");
    initial.database.close();

    const reopened = new LocalDatabase(initial.file, { heartbeat: false });
    expect(reopened.created).toBe(false);
    expect(installBundledWorlds(reopened, provider.catalog)).toEqual([]);
    expect(reopened.list()).toEqual([
      expect.objectContaining({ id: "fanren", version: "1.0.0" }),
    ]);
    reopened.close();
  });

  it("installs only the selected snapshot and does not restore it after reopening", () => {
    const { database, file } = temporaryDatabase();
    const worldsRoot = path.join(path.dirname(file), "snapshot-worlds");
    cpSync(path.resolve("worlds/blackmarsh/world"), path.join(worldsRoot, "blackmarsh/world"), { recursive: true });
    try {
      expect(installBundledWorlds(database, bundledWorldModelCatalog, worldsRoot, ["blackmarsh"]))
        .toEqual([expect.objectContaining({ id: "blackmarsh", replaced: false })]);
      expect(database.list().map(world => world.id)).toEqual(["blackmarsh"]);
      database.deleteWorld("blackmarsh");
    } finally {
      database.close();
    }
    rmSync(worldsRoot, { recursive: true, force: true });
    const reopened = new LocalDatabase(file, { heartbeat: false });
    try {
      expect(installBundledWorlds(reopened, bundledWorldModelCatalog, worldsRoot, ["blackmarsh"])).toEqual([]);
      expect(reopened.list()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("rejects invalid selections before importing and never skips selected missing files", () => {
    const { database, file } = temporaryDatabase();
    const worldsRoot = path.join(path.dirname(file), "missing-worlds");
    try {
      expect(() => installBundledWorlds(database, bundledWorldModelCatalog, worldsRoot,
        ["blackmarsh", "unknown" as BundledWorldId])).toThrow("unknown bundled world");
      expect(() => installBundledWorlds(database, bundledWorldModelCatalog, worldsRoot,
        ["blackmarsh", "blackmarsh"])).toThrow("duplicate bundled world selection");
      expect(() => installBundledWorlds(database, bundledWorldModelCatalog, worldsRoot,
        ["blackmarsh"])).toThrow("ENOENT");
      expect(database.list()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
