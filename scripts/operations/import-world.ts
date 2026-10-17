import { readFileSync } from "node:fs";
import path from "node:path";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { LocalDatabase } from "../../src/server/local-database";

const archive = process.argv[2];
const replace = process.argv.includes("--replace");
if (!archive) {
  process.stderr.write("usage: npm run world:import -- <world.zip> [--replace]\n");
  process.exitCode = 2;
} else {
  try {
    const dataRoot = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v33");
    const database = new LocalDatabase(path.join(dataRoot, "livingworld.sqlite"));
    try {
      const result = database.importWorld(
        readFileSync(path.resolve(archive)),
        loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml")),
        replace,
      );
      process.stdout.write(`${result.id}: ${result.replaced ? "replaced" : "imported"}\n`);
      process.stdout.write(`Active goals: ${result.activeGoalCount}; initial decisions are queued when an instance is created.\n`);
    } finally {
      database.close();
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
