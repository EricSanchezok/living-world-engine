import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { buildWorldDefinition, loadWorldTemplate } from "../../src/script/world-loader";
import { LocalDatabase } from "../../src/server/local-database";
import { parseWorldArchive } from "../../src/server/world-import";
import { archiveScaleWorld, makeFanrenScaleWorld } from "./fanren-scale-world";

it.each([150, 700] as const)("imports the %s-person probe with every synthetic belief bound and original source intact", population => {
  const source = loadWorldTemplate(path.resolve("worlds/fanren/samples/opening/world"));
  const before = structuredClone(source);
  const fixture = makeFanrenScaleWorld(source, population);
  const catalog = loadModelCatalog();
  const definition = buildWorldDefinition(fixture.template, { modelCatalog: catalog });
  const root = mkdtempSync(path.join(tmpdir(), "fanren-scale-"));
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  try {
    const imported = database.importWorld(archiveScaleWorld(fixture.template), catalog);
    expect(imported.id).toBe(`fanren-scale-${population}`);
    expect(source).toEqual(before);
    expect(Object.keys(definition.initialState.agents)).toHaveLength(population);
    expect(fixture.template.manifest.narrative.expansion).toBe(false);
    expect(fixture.template.entities.filter(entity => entity.id.startsWith("scale-court-")).every(entity => entity.description.startsWith("天渊城"))).toBe(true);
    for (const agent of Object.values(definition.initialState.agents).filter(agent => agent.id.startsWith("scale-resident-"))) {
      for (const local of ["self", "location", "partner", "kin"]) {
        expect(definition.initialState.truth.entities).toHaveProperty(agent.bindings[local]!.canonicalEntityIds[0]!);
      }
      expect(Object.keys(agent.belief.claims)).toEqual(["trade-partner", "kinship"]);
    }
    expect(definition.initialState.truth.entities).toHaveProperty("canon-han-li");
    expect(parseWorldArchive(archiveScaleWorld(fixture.template), catalog).contentHash).toBe(definition.contentHash);
  } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
