import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";

function model(id: string) {
  return {
    id,
    name: id,
    family: "e2e",
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low"] },
    ],
    tool_call: true,
    structured_output: true,
    temperature: true,
    release_date: "2026-01-01",
    last_updated: "2026-01-01",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 262_144, output: 32_768 },
  };
}

export default async function globalSetup(): Promise<void> {
  const dataRoot = path.resolve(process.env.LIVINGWORLD_E2E_DATA_ROOT ?? "e2e/artifacts/runtime-data");
  const modelCatalog = path.resolve(
    process.env.LIVINGWORLD_E2E_MODEL_CATALOG_PATH ?? "e2e/artifacts/runtime-models.yaml",
  );
  const modelPort = Number(process.env.LIVINGWORLD_E2E_MODEL_PORT ?? 32128);
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(modelCatalog), { recursive: true });
  const template = readFileSync(path.resolve("e2e/support/models.yaml"), "utf8");
  writeFileSync(modelCatalog, template.replaceAll("http://127.0.0.1:32128", `http://127.0.0.1:${modelPort}`));

  const catalog = loadModelCatalog(modelCatalog);
  const registry = new ModelRegistry(catalog, dataRoot, {
    minimumRefreshIntervalMs: 0,
    fetch: async () => new Response(JSON.stringify({
      typesafe: { id: "typesafe", name: "E2E TypeSafe", models: { "jev-1.13.0": {
        ...model("jev-1.13.0"), family: "jev", reasoning: false, reasoning_options: [], temperature: false,
      } } },
      deepseek: {
        id: "deepseek",
        name: "E2E DeepSeek",
        models: {
          "deepseek-flash": model("deepseek-flash"),
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"e2e-models-v1"' },
    }),
  });
  await registry.refresh({ reason: "capture" });

}
