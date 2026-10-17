import path from "node:path";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "status" && command !== "refresh") {
    throw new Error("usage: model-registry-command.ts <status|refresh>");
  }
  const catalog = loadModelCatalog(path.resolve(
    process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml",
  ));
  const dataRoot = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v36");
  const registry = new ModelRegistry(catalog, dataRoot, { minimumRefreshIntervalMs: 0 });
  const gateway = createModelGateway(catalog, process.env, { registry });
  const result = command === "refresh"
    ? await gateway.refreshModelRegistry()
    : await gateway.modelRegistryDiagnostics();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
