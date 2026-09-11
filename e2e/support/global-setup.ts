import { execFileSync } from "node:child_process";
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
      { type: "effort", values: ["high", "max"] },
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
  const cacheRoot = path.resolve(process.env.LIVINGWORLD_E2E_CACHE_ROOT ?? ".livingworld-cache");
  const modelCatalog = path.resolve(
    process.env.LIVINGWORLD_E2E_MODEL_CATALOG_PATH ?? "e2e/artifacts/runtime-models.yaml",
  );
  const modelPort = Number(process.env.LIVINGWORLD_E2E_MODEL_PORT ?? 32128);
  rmSync(dataRoot, { recursive: true, force: true });
  mkdirSync(path.dirname(modelCatalog), { recursive: true });
  const template = readFileSync(path.resolve("e2e/support/models.yaml"), "utf8");
  writeFileSync(modelCatalog, template.replace("http://127.0.0.1:32128", `http://127.0.0.1:${modelPort}`));

  const catalog = loadModelCatalog(modelCatalog);
  const registry = new ModelRegistry(catalog, dataRoot, {
    minimumRefreshIntervalMs: 0,
    fetch: async () => new Response(JSON.stringify({
      deepseek: {
        id: "deepseek",
        name: "E2E DeepSeek",
        models: {
          "e2e-truth": model("e2e-truth"),
          "e2e-agent": model("e2e-agent"),
        },
      },
    }), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"e2e-models-v1"' },
    }),
  });
  await registry.refresh({ reason: "capture" });

  const retrievalEnvironment = {
    ...process.env,
    LIVINGWORLD_CACHE_ROOT: cacheRoot,
    LIVINGWORLD_MODEL_CATALOG_PATH: modelCatalog,
  };
  const runRetrievalCommand = (script: string, args: readonly string[]): void => {
    execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
      cwd: process.cwd(),
      env: retrievalEnvironment,
      stdio: "inherit",
    });
  };
  runRetrievalCommand("scripts/operations/retrieval-model-install.ts", [
    "--model",
    "multilingual-e5-base",
  ]);
  runRetrievalCommand("scripts/operations/retrieval-cache-command.ts", [
    "warm",
    "--world",
    "test/fixtures/open-world-script",
    "--model",
    "multilingual-e5-base",
  ]);
}
