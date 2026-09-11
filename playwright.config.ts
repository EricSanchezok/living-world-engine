import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.LIVINGWORLD_E2E_PORT ?? 32127);
const baseURL = `http://127.0.0.1:${port}`;
const dataRoot = path.resolve(process.env.LIVINGWORLD_E2E_DATA_ROOT ?? "e2e/artifacts/runtime-data");
const cacheRoot = path.resolve(process.env.LIVINGWORLD_E2E_CACHE_ROOT ?? ".livingworld-cache");
const modelCatalog = path.resolve(
  process.env.LIVINGWORLD_E2E_MODEL_CATALOG_PATH ?? "e2e/artifacts/runtime-models.yaml",
);
const modelPort = Number(process.env.LIVINGWORLD_E2E_MODEL_PORT ?? 32128);
const modelServerURL = `http://127.0.0.1:${modelPort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  globalSetup: "./e2e/support/global-setup.ts",
  outputDir: "e2e/artifacts/test-results",
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  reporter: process.env.CI
    ? [["github"], ["html", { outputFolder: "e2e/artifacts/report", open: "never" }]]
    : [["line"], ["html", { outputFolder: "e2e/artifacts/report", open: "never" }]],
  use: {
    baseURL,
    // Keep visual baselines independent of the host/runner locale. The
    // product's fixtures and existing snapshots use the project timezone.
    timezoneId: "Asia/Shanghai",
    colorScheme: "dark",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "tsx e2e/support/model-server.ts",
      url: `${modelServerURL}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { LIVINGWORLD_E2E_MODEL_PORT: String(modelPort) },
    },
    {
      command: `npm run start -- --port ${port}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        LIVINGWORLD_DATA_ROOT: dataRoot,
        LIVINGWORLD_CACHE_ROOT: cacheRoot,
        LIVINGWORLD_MODEL_CATALOG_PATH: modelCatalog,
        E2E_MODEL_API_KEY: "e2e-test-key",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
  projects: [
    {
      name: "e2e",
      testMatch: "flows/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "a11y",
      testMatch: "a11y/**/*.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
