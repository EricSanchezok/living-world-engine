import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { coreResolutionRulePackage, RulePackageRegistry } from "../../engine/mechanics/rule-package";
import { createTestModelCatalog, DeterministicModelProvider } from "../../engine/testing/model-provider";
import { FULL_CATALOG_ALGORITHM_REF } from "../../engine/algorithms/registry";
import { loadWorldScript } from "../../script/world-loader";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import {
  parseWorldArchive,
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_COUNT,
  MAX_EXPANDED_BYTES,
  WorldImportError,
} from "../world-import";

const fixture = path.resolve("test/fixtures/open-world-script");
const modelCatalog = createTestModelCatalog();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function zipDirectory(directory: string, prefix = "world"): AdmZip {
  const zip = new AdmZip();
  const walk = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const nextRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) walk(absolute, nextRelative);
      else zip.addFile(path.posix.join(prefix, nextRelative), readFileSync(absolute));
    }
  };
  walk(directory, "");
  return zip;
}

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "livingworld-import-test-"));
  temporaryRoots.push(root);
  return root;
}

function traversalArchive(): Buffer {
  const zip = new AdmZip();
  zip.addFile("aa/outside.txt", Buffer.from("no"));
  const buffer = zip.toBuffer();
  const safeName = Buffer.from("aa/outside.txt");
  const unsafeName = Buffer.from("../outside.txt");
  for (let offset = 0; offset <= buffer.length - safeName.length; offset += 1) {
    if (buffer.subarray(offset, offset + safeName.length).equals(safeName)) {
      unsafeName.copy(buffer, offset);
    }
  }
  return buffer;
}

function oversizedDeclaredArchive(): Buffer {
  const zip = new AdmZip();
  zip.addFile("world/script.yaml", Buffer.from("small"));
  const buffer = zip.toBuffer();
  for (let offset = 0; offset <= buffer.length - 28; offset += 1) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x04034b50) buffer.writeUInt32LE(MAX_EXPANDED_BYTES + 1, offset + 22);
    if (signature === 0x02014b50) buffer.writeUInt32LE(MAX_EXPANDED_BYTES + 1, offset + 24);
  }
  return buffer;
}

describe("world import", () => {
  it("atomically imports one validated schema v14 world", () => {
    const root = temporaryRoot();
    const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    const result = database.importWorld(zipDirectory(fixture).toBuffer(), modelCatalog);

    expect(result).toMatchObject({ id: "open-world-fixture", replaced: false });
    expect(database.list()).toEqual([
      expect.objectContaining({ id: "open-world-fixture", contentHash: expect.stringMatching(/^sha256:/) }),
    ]);
    const imported = database.load(result.id, 9, modelCatalog);
    expect(imported).toMatchObject({
      id: "open-world-fixture",
      initialState: { truth: { rng: { seed: 9 } } },
    });
    expect(imported.randomDistributions).toEqual(
      loadWorldScript(fixture, { modelCatalog }).randomDistributions,
    );
    database.close();
  });

  it("uses one injected rule registry for import, catalog load, and instance recovery", async () => {
    const root = temporaryRoot();
    const archive = zipDirectory(fixture);
    const mechanics = readFileSync(path.join(fixture, "mechanics.yaml"), "utf8")
      .replace(
        "    config: {}\nmeters:",
        "    config: {}\n  - id: test-rules\n    version: 1.0.0\n    config: {}\nmeters:",
      );
    archive.updateFile("world/mechanics.yaml", Buffer.from(mechanics));
    const rulePackages = new RulePackageRegistry([coreResolutionRulePackage, {
      id: "test-rules",
      version: "1.0.0",
      configSchema: z.strictObject({}),
      adjudication: "测试规则目录。",
      rules: [],
    }]);
    const provider = new DeterministicModelProvider();
    const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), {
      heartbeat: false,
      rulePackages,
    });
    database.importWorld(archive.toBuffer(), provider.catalog);
    expect(database.load("open-world-fixture", 9, provider.catalog).rulePackages[1])
      .toMatchObject({ id: "test-rules", rules: [] });

    const host = new WorldHost({ repository: database, store: database, provider, defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF });
    const instance = await host.createInstance({ worldId: "open-world-fixture", start: { kind: "observer" } });
    expect(host.instance(instance.summary.id).world.contentHash).toBe(instance.world.contentHash);
    database.close();
  });

  it("rejects legacy action files instead of silently ignoring them", () => {
    const zip = zipDirectory(fixture);
    zip.addFile("world/actions.yaml", Buffer.from("actions: []\n"));

    try {
      parseWorldArchive(zip.toBuffer(), modelCatalog);
      throw new Error("legacy archive unexpectedly imported");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("unexpected world script file");
      expect(message).toContain("<world>");
      expect(message).not.toContain(tmpdir());
    }
  });

  it("rejects an archive whose world references an unknown model profile before installation", () => {
    const source = mkdtempSync(path.join(tmpdir(), "livingworld-import-profile-"));
    temporaryRoots.push(source);
    const world = path.join(source, "world");
    cpSync(fixture, world, { recursive: true });
    const manifest = path.join(world, "script.yaml");
    writeFileSync(
      manifest,
      readFileSync(manifest, "utf8").replace("truth-deepseek", "missing-profile"),
      "utf8",
    );
    expect(() => parseWorldArchive(zipDirectory(world).toBuffer(), modelCatalog))
      .toThrow("unknown model profile missing-profile");
  });

  it("rejects traversal entries", () => {
    expect(() => parseWorldArchive(traversalArchive(), modelCatalog)).toThrow(WorldImportError);
  });

  it("requires explicit replacement for an existing world", () => {
    const root = temporaryRoot();
    const archive = zipDirectory(fixture).toBuffer();
    const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    database.importWorld(archive, modelCatalog);

    expect(() => database.importWorld(archive, modelCatalog)).toThrow("already exists");
    expect(database.importWorld(archive, modelCatalog, true).replaced).toBe(true);
    database.close();
  });

  it("rejects an update archive for a different world before mutating the catalog", () => {
    const root = temporaryRoot();
    const archive = zipDirectory(fixture).toBuffer();
    const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    database.importWorld(archive, modelCatalog);

    expect(() => database.importWorld(archive, modelCatalog, true, "another-world"))
      .toThrow("does not match expected world");
    expect(database.list()).toEqual([expect.objectContaining({ id: "open-world-fixture", version: "1.0.0" })]);
    database.close();
  });

  it("uninstalls only worlds with no saved instances", async () => {
    const root = temporaryRoot();
    const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
    const provider = new DeterministicModelProvider();
    const archive = zipDirectory(fixture).toBuffer();
    database.importWorld(archive, provider.catalog);
    const host = new WorldHost({ repository: database, store: database, catalogManager: database, provider, defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF });
    const instance = await host.createInstance({ worldId: "open-world-fixture", start: { kind: "observer" } });

    expect(() => host.deleteWorld("open-world-fixture")).toThrow("still has instances");
    expect(host.listWorlds()).toEqual([expect.objectContaining({ id: "open-world-fixture" })]);
    host.deleteInstance(instance.summary.id);
    host.deleteWorld("open-world-fixture");

    expect(host.listWorlds()).toEqual([]);
    expect(() => host.deleteWorld("open-world-fixture")).toThrow("not found");
    database.close();
  });

  it("pins existing instances to their embedded world contract after replacement and restart", async () => {
    const root = temporaryRoot();
    const databaseFile = path.join(root, "livingworld.sqlite");
    let database = new LocalDatabase(databaseFile, { heartbeat: false });
    const provider = new DeterministicModelProvider();
    let nextId = 0;
    const createHost = () => new WorldHost({
      repository: database,
      store: database,
      catalogManager: database,
      provider,
      defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
      idFactory: () => `id-${++nextId}`,
    });

    try {
      database.importWorld(zipDirectory(fixture).toBuffer(), provider.catalog);
      const firstHost = createHost();
      const original = await firstHost.createInstance({
        worldId: "open-world-fixture",
        seed: 47,
        start: { kind: "observer" },
      });

      const replacement = path.join(root, "replacement");
      cpSync(fixture, replacement, { recursive: true });
      const manifest = path.join(replacement, "script.yaml");
      writeFileSync(
        manifest,
        readFileSync(manifest, "utf8")
          .replace("version: 1.0.0", "version: 2.0.0")
          .replace("最小测试数据", "替换后的测试数据"),
        "utf8",
      );
      database.importWorld(zipDirectory(replacement).toBuffer(), provider.catalog, true);

      database.close();
      database = new LocalDatabase(databaseFile, { heartbeat: false });
      const restartedHost = createHost();
      const restored = restartedHost.instance(original.summary.id);
      const current = await restartedHost.createInstance({
        worldId: "open-world-fixture",
        start: { kind: "observer" },
      });

      expect(restored).toMatchObject({
        summary: { id: original.summary.id },
        world: { version: "1.0.0", contentHash: original.world.contentHash },
      });
      expect(current.world.version).toBe("2.0.0");
      expect(current.world.contentHash).not.toBe(original.world.contentHash);
    } finally {
      database.close();
    }
  });

  it("rejects compressed archives, declared expansion and entry counts above their exact limits", () => {
    expect(() => parseWorldArchive(Buffer.alloc(MAX_ARCHIVE_BYTES + 1), modelCatalog))
      .toThrow("archive exceeds 50 MiB");
    expect(() => parseWorldArchive(oversizedDeclaredArchive(), modelCatalog))
      .toThrow("archive expands beyond 100 MiB");

    const zip = new AdmZip();
    for (let index = 0; index <= MAX_ENTRY_COUNT; index += 1) {
      zip.addFile(`world/entities/${index}.yaml`, Buffer.alloc(0));
    }
    expect(() => parseWorldArchive(zip.toBuffer(), modelCatalog)).toThrow("too many entries");
  });

  it("rejects symbolic links and files outside the single world root", () => {
    const linkZip = zipDirectory(fixture);
    linkZip.addFile("world/link", Buffer.from("script.yaml"));
    const link = linkZip.getEntry("world/link");
    if (!link) throw new Error("test archive did not contain link entry");
    link.header.attr = (0o120777 << 16) >>> 0;
    expect(() => parseWorldArchive(linkZip.toBuffer(), modelCatalog)).toThrow("symbolic links");

    const extraZip = zipDirectory(fixture);
    extraZip.addFile("unrelated.txt", Buffer.from("not part of the world"));
    expect(() => parseWorldArchive(extraZip.toBuffer(), modelCatalog)).toThrow("outside its single world root");
  });

  it("rejects archive names that collide on case-insensitive filesystems", () => {
    const zip = zipDirectory(fixture);
    zip.addFile("world/entities/KEY.yaml", readFileSync(path.join(fixture, "entities/key.yaml")));

    expect(() => parseWorldArchive(zip.toBuffer(), modelCatalog)).toThrow("duplicate archive entry");
  });
});
