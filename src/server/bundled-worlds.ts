import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import type { ModelCatalog } from "../engine/models/model-catalog";
import type { WorldImportResult } from "./world-import";

const BUNDLED_WORLDS = [{
  id: "blackmarsh",
  directory: "blackmarsh/world",
}, {
  id: "fanren",
  directory: "fanren/world",
}] as const;

export type BundledWorldId = typeof BUNDLED_WORLDS[number]["id"];

interface FreshWorldCatalog {
  readonly created: boolean;
  importWorld(
    buffer: Buffer,
    modelCatalog: ModelCatalog,
    replace?: boolean,
    expectedWorldId?: string,
  ): WorldImportResult;
}

export function archiveWorldDirectory(directory: string): Buffer {
  const archive = new AdmZip();
  const addDirectory = (current: string, relative: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const entryRelative = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) addDirectory(absolute, entryRelative);
      else archive.addFile(path.posix.join("world", entryRelative), readFileSync(absolute));
    }
  };
  addDirectory(directory, "");
  return archive.toBuffer();
}

export function installBundledWorlds(
  catalog: FreshWorldCatalog,
  modelCatalog: ModelCatalog,
  worldsRoot = path.resolve("worlds"),
  worldIds: readonly BundledWorldId[] = BUNDLED_WORLDS.map(world => world.id),
): WorldImportResult[] {
  if (!catalog.created) return [];
  if (new Set(worldIds).size !== worldIds.length) throw new Error("duplicate bundled world selection");
  const worlds = worldIds.map(id => {
    const world = BUNDLED_WORLDS.find(candidate => candidate.id === id);
    if (!world) throw new Error(`unknown bundled world: ${id}`);
    return world;
  });
  return worlds.map((world) => catalog.importWorld(
    archiveWorldDirectory(path.join(/* turbopackIgnore: true */ worldsRoot, world.directory)),
    modelCatalog,
    false,
    world.id,
  ));
}
