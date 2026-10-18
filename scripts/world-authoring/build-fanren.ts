import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, renameSync, existsSync } from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import AdmZip from "adm-zip";
import { compileAuthoredModule, assertFullCoverage } from "./authoring-build";
import { buildWorldDefinition } from "../../src/script/world-loader";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { parseWorldArchive } from "../../src/server/world-import";
import { assembleRegionalModules } from "./regional-composition";
import { contentHash } from "../../src/engine/models/model-audit";
import { assertFullSourceClosure } from "./source-closure-files";
import { bindRuntimeModels } from "./runtime-model-bindings";
import { capabilityModelsSchema } from "../../src/engine/models/capability-bindings";

const root = path.resolve("worlds/fanren/authoring");
const json = (file: string) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
const target = process.argv[2];
if (target !== "sample" && target !== "full") throw new Error("usage: npx tsx scripts/world-authoring/build-fanren.ts sample|full");
const integrity = json("sources/integrity-findings.json");
const sourceClosureReceipt = target === "full" ? assertFullSourceClosure({ root }) : null;
if (target === "full") {
  assertFullCoverage(json("coverage/world.json"), readFileSync(path.join(root, "coverage/chapters.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)),
    integrity.findings.filter((finding: { severity: string; status: string }) => finding.severity === "blocking" && finding.status !== "resolved").length);
}
const name = target === "sample" ? "opening-sample" : "full-world";
const authored = target === "full"
  ? assembleRegionalModules(json(`modules/${name}.json`), json(`claims/${name}.json`),
    json("coverage/regional-plan.json").modules.map((region: { id: string }) => {
      if (!/^[a-z][a-z0-9-]*$/u.test(region.id)) throw new Error(`invalid regional identity ${region.id}`);
      return { module: json(`regions/${region.id}/module.json`), claims: json(`regions/${region.id}/claims.json`), review: json(`regions/${region.id}/review.json`) };
    }))
  : { module: json(`modules/${name}.json`), claims: json(`claims/${name}.json`), receipts: [] };
const { template: approvedTemplate, receipt } = compileAuthoredModule(authored.module, authored.claims, json(`reviews/${name}.json`),
  id => {
    if (!/^qq-\d+$/.test(id)) throw new Error(`invalid chapter identity ${id}`);
    return readFileSync(path.resolve(".livingworld-cache/fanren-sources/chapters", `${id}.txt`), "utf8");
  }, new Set(integrity.blocked_chapters));
const catalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
const runtimeModels = capabilityModelsSchema.parse(JSON.parse(readFileSync(path.resolve("worlds/fanren/runtime-models.json"), "utf8")));
const template = bindRuntimeModels(approvedTemplate, runtimeModels);
const definition = buildWorldDefinition(template, { modelCatalog: catalog });
const files = new Map<string, string>([
  ["script.yaml", stringify(template.manifest)], ["laws.yaml", stringify(template.laws)],
  ["mechanics.yaml", stringify(template.mechanics)], ["participation.yaml", stringify(template.participation)],
  ...template.entities.map(entity => [`entities/${entity.id}.yaml`, stringify(entity)] as [string, string]),
]);
const zip = new AdmZip();
for (const [file, contents] of files) {
  zip.addFile(file, Buffer.from(contents));
  zip.getEntry(file)!.header.time = new Date("2000-01-01T00:00:00Z");
}
const archive = zip.toBuffer();
const parsed = parseWorldArchive(archive, catalog);
if (parsed.contentHash !== definition.contentHash) throw new Error("archive round-trip changed the world");
const destination = path.resolve(target === "sample" ? "worlds/fanren/samples/opening/world" : "worlds/fanren/world");
mkdirSync(path.dirname(destination), { recursive: true });
const stage = mkdtempSync(path.join(path.dirname(destination), ".build-"));
try {
  for (const [file, contents] of files) { const absolute = path.join(stage, file); mkdirSync(path.dirname(absolute), { recursive: true }); writeFileSync(absolute, contents); }
  const backup = `${destination}.previous`;
  if (existsSync(backup)) throw new Error("previous build backup requires inspection");
  if (existsSync(destination)) renameSync(destination, backup);
  try { renameSync(stage, destination); } catch (error) { if (existsSync(backup)) renameSync(backup, destination); throw error; }
  rmSync(backup, { recursive: true, force: true });
} finally { rmSync(stage, { recursive: true, force: true }); }
const artifacts = path.resolve(".livingworld-cache/fanren-artifacts");
mkdirSync(artifacts, { recursive: true });
writeFileSync(path.join(artifacts, `${name}.zip`), archive);
writeFileSync(path.join(root, "reviews", `${name}-build.json`), `${JSON.stringify({ ...receipt, sourceClosureReceipt, runtimeModels,
  worldHash: definition.contentHash, regionalReceipts: authored.receipts, files: Object.fromEntries([...files].map(([file, contents]) => [file, contentHash(contents)])),
  entities: Object.keys(definition.initialState.truth.entities).length, agents: Object.keys(definition.initialState.agents).length,
  originIds: definition.participation?.origins.map(origin => origin.id), archiveImportValidated: true,
}, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ world: definition.id, destination, entities: template.entities.length, origins: template.participation?.origins.length, imported: true })}\n`);
