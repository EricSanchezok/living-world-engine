import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeterministicModelProvider } from "../../engine/testing/model-provider";
import { loadModelCatalog } from "../../engine/models/model-catalog";
import { installBundledWorlds } from "../bundled-worlds";
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
  it("installs Blackmarsh through the strict importer for a fresh database", () => {
    const provider = new DeterministicModelProvider(bundledWorldModelCatalog, false);
    const { database } = temporaryDatabase();

    expect(database.created).toBe(true);
    expect(installBundledWorlds(database, provider.catalog)).toEqual([
      expect.objectContaining({ id: "blackmarsh", name: "黑沼边境", replaced: false }),
    ]);
    expect(database.list()).toEqual([
      expect.objectContaining({ id: "blackmarsh", version: "1.2.0" }),
    ]);
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
    expect(reopened.list()).toEqual([]);
    reopened.close();
  });
});
