import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import type { ModelCatalog } from "../engine/models/model-catalog";
import { createCoreRulePackageRegistry, type RulePackageRegistry } from "../engine/mechanics/rule-package";
import {
  buildWorldDefinition,
  loadWorldTemplate,
  type NormalizedWorldTemplate,
  WorldScriptError,
} from "../script/world-loader";

export const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
export const MAX_ENTRY_COUNT = 5_000;
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;

export class WorldImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "WorldImportError";
  }
}

function safeEntryName(name: string): string {
  if (name.includes("\\") || name.includes("\0")) throw new WorldImportError(`unsafe archive entry: ${name}`);
  const segments = name.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new WorldImportError(`unsafe archive entry: ${name}`);
  }
  const normalized = path.posix.normalize(name);
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new WorldImportError(`unsafe archive entry: ${name}`);
  }
  return normalized.replace(/\/$/, "");
}

function locateRoot(staging: string): string {
  if (existsSync(path.join(staging, "script.yaml"))) return staging;
  const topLevelEntries = readdirSync(staging, { withFileTypes: true });
  const candidates = new Set<string>();
  for (const entry of topLevelEntries) {
    if (entry.isDirectory() && existsSync(path.join(staging, entry.name, "script.yaml"))) {
      candidates.add(path.join(staging, entry.name));
    }
  }
  if (candidates.size !== 1) {
    throw new WorldImportError("archive must contain one world root with script.yaml");
  }
  const root = [...candidates][0];
  if (topLevelEntries.length !== 1 || path.join(staging, topLevelEntries[0].name) !== root) {
    throw new WorldImportError("archive contains files outside its single world root");
  }
  return root;
}

function isSymbolicLinkEntry(entry: AdmZip.IZipEntry): boolean {
  const unixMode = (entry.header.attr >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

function extractArchive(buffer: Buffer, staging: string): string {
  if (buffer.byteLength > MAX_ARCHIVE_BYTES) throw new WorldImportError("archive exceeds 50 MiB");
  let zip: AdmZip;
  try {
    zip = new AdmZip(buffer);
  } catch (error) {
    throw new WorldImportError(`invalid zip archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRY_COUNT) throw new WorldImportError("archive contains too many entries");
  const declaredExpandedBytes = entries.reduce((total, entry) => total + Number(entry.header.size), 0);
  if (!Number.isSafeInteger(declaredExpandedBytes) || declaredExpandedBytes > MAX_EXPANDED_BYTES) {
    throw new WorldImportError("archive expands beyond 100 MiB");
  }
  let expandedBytes = 0;
  const portableNames = new Set<string>();
  for (const entry of entries) {
    const name = safeEntryName(entry.entryName);
    if (!name) continue;
    const portableName = name.normalize("NFC").toLowerCase();
    if (portableNames.has(portableName)) throw new WorldImportError(`duplicate archive entry: ${name}`);
    portableNames.add(portableName);
    if (isSymbolicLinkEntry(entry)) throw new WorldImportError(`symbolic links are not allowed: ${name}`);
    const target = path.join(staging, ...name.split("/"));
    if (entry.isDirectory) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      throw new WorldImportError(`invalid compressed data in archive entry: ${name}`);
    }
    expandedBytes += data.byteLength;
    if (expandedBytes > MAX_EXPANDED_BYTES) throw new WorldImportError("archive expands beyond 100 MiB");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, data);
  }
  return locateRoot(staging);
}

export interface WorldImportResult {
  id: string;
  name: string;
  description: string;
  replaced: boolean;
  activeGoalCount: number;
}

/** Import reports authored goal counts without exposing private goal identities. */
export function publicWorldImportResult(result: WorldImportResult) {
  return { id: result.id, name: result.name, description: result.description, replaced: result.replaced,
    activeGoalCount: result.activeGoalCount };
}

export interface ParsedWorldArchive {
  template: NormalizedWorldTemplate;
  id: string;
  name: string;
  version: string;
  description: string;
  contentHash: string;
  activeGoalCount: number;
}

export function parseWorldArchive(
  buffer: Buffer,
  modelCatalog: ModelCatalog,
  rulePackages: RulePackageRegistry = createCoreRulePackageRegistry(),
): ParsedWorldArchive {
  const staging = mkdtempSync(path.join(tmpdir(), "livingworld-world-import-"));
  try {
    const source = extractArchive(buffer, staging);
    const template = loadWorldTemplate(source);
    let definition;
    try {
      definition = buildWorldDefinition(template, { seed: 1, modelCatalog, rulePackages });
    } catch (error) {
      throw new WorldScriptError(source, error instanceof Error ? error.message : String(error));
    }
    const activeGoalCount = Object.values(definition.initialState.agents).reduce((count, agent) => count +
      Object.values(agent.character.goals).filter(goal => goal.status === "active").length, 0);
    return {
      template,
      id: definition.id,
      name: definition.name,
      version: definition.manifestVersion,
      description: definition.description,
      contentHash: definition.contentHash,
      activeGoalCount,
    };
  } catch (error) {
    if (error instanceof WorldImportError) throw error;
    if (error instanceof WorldScriptError) {
      throw new WorldImportError(error.message.replaceAll(staging, "<world>"));
    }
    throw new WorldImportError("world archive could not be installed", 500);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
