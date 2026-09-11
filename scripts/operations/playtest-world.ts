import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_ALGORITHM_REF } from "../../src/engine/algorithms/registry";
import { firstPassAlgorithmRef } from "../../src/engine/benchmarks/action-compilation/first-pass-protocol";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { AC_FP3_BUDGET } from "../../src/engine/benchmarks/action-compilation/semantic-first-pass-protocol";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { contentHash } from "../../src/engine/models/model-audit";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { installBundledWorlds } from "../../src/server/bundled-worlds";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";

// This acceptance run uses the registered candidate in a persisted instance;
// it does not promote an offline result to the global runtime default.
async function main(): Promise<void> {
  const root = path.resolve(".livingworld-benchmarks/playtests/b1-r5-t/v1");
  mkdirSync(root, { recursive: true });
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--resume")) throw new Error("usage: playtest-world.ts [--resume instance-id]");
  const resumeId = args[1];
  const previous = resumeId ? JSON.parse(readFileSync(path.join(root, "report.json"), "utf8")) : undefined;
  if (resumeId && (previous?.instanceId !== resumeId || previous?.status !== "stopped")) {
    throw new Error("resume requires this playtest's explicitly stopped instance");
  }
  if (!resumeId) closeSync(openSync(path.join(root, "started.lock"), "wx"));
  const dataRoot = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23");
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), {
    ...AC_FP3_BUDGET, maximumNanoCny: 50_000_000_000,
    phaseBudgets: [], maxHttpRequests: { trajectory: 400 },
    maxKnownTokens: { trajectory: 30_000_000 },
  });
  if (budget.summary.unsettled.length) throw new Error("unresolved billing blocks playtest resumption");
  if (previous) writeFileSync(path.join(root, `report-${contentHash(previous)}.json`), JSON.stringify(previous, null, 2));
  const catalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const registry = new ModelRegistry(catalog, dataRoot);
  const network = createModelFetchResolver(process.env);
  const account = catalog.accounts["deepseek-api"];
  if (!account) throw new Error("DeepSeek account is not configured");
  const transport = new FirstPassExperimentTransport(budget, {
    root, baseUrl: account.base_url, inputTokenCeiling: 1_000_000, outputTokenCeiling: 131_072,
    fetch: network("deepseek-api", account) ?? fetch,
    trialPattern: /^trajectory-playtest(?:-[a-f0-9-]+)?$/u, allowLowerOutputLimit: true,
    priceBinding: { accountId: "deepseek-api", modelId: "deepseek-v4-flash", priceId: "flash" },
  });
  transport.beginTrial(resumeId ? `trajectory-playtest-${randomUUID()}` : "trajectory-playtest", "trajectory");
  const provider = createModelGateway(catalog, process.env, {
    registry, maxTransportAttempts: 1,
    fetchForAccount: (id) => {
      if (id !== "deepseek-api") return async () => { throw new Error(`unapproved playtest account: ${id}`); };
      return transport.fetch;
    },
  });
  const database = new LocalDatabase(path.join(dataRoot, "livingworld.sqlite"));
  const algorithmRef = firstPassAlgorithmRef(DEFAULT_ALGORITHM_REF, "T");
  const host = new WorldHost({
    repository: database, store: database, ledger: database, provider,
    actionCompilationRetrievalProvider: createActionCompilationRetrievalRuntimeProvider(),
    defaultAlgorithmRef: algorithmRef, idFactory: randomUUID,
  });
  const startedAt = new Date().toISOString();
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  let instanceId: string | undefined = resumeId;
  let status = "preparing";
  let failure: string | undefined;
  const commits: Array<{ revision: number; step: number; elapsedMs: number; timeAdvanceSeconds: number }> = [];
  const report = () => {
    const document = instanceId ? database.readInstance(instanceId).document : undefined;
    const summary = { startedAt, updatedAt: new Date().toISOString(), commit, status, failure,
      instanceId, algorithmRef, worldHash: document?.state.worldHash,
      revision: document?.state.revision, step: document?.state.step,
      run: document ? Object.values(document.runs).at(-1) : undefined,
      commits, budget: budget.summary, httpScheduling: "serialized", transportStopReason: transport.stopReason };
    writeFileSync(path.join(root, "report.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({ status, instanceId, revision: summary.revision, step: summary.step,
      runStatus: summary.run?.status, http: budget.summary.phases.trajectory.httpRequests,
      estimatedCny: budget.summary.estimatedPeakNanoCny / 1e9, failure }));
  };
  const timer = setInterval(report, 10_000);
  try {
    installBundledWorlds(database, provider.catalog);
    status = "creating";
    report();
    if (!instanceId) {
      const instance = await host.createInstance({ worldId: "blackmarsh", seed: 20260906,
        title: "B1 + R5 + T 连续游玩验收", start: { kind: "observer" } }, "local", algorithmRef);
      instanceId = instance.summary.id;
    } else if (database.readInstance(instanceId).document.executionAlgorithm.manifestHash !== algorithmRef.manifestHash) {
      throw new Error("resume composition differs from the pinned candidate");
    }
    status = "running";
    report();
    while (database.readInstance(instanceId).document.state.step < 3) {
      const before = database.readInstance(instanceId).document.state;
      const started = Date.now();
      await host.advance(instanceId, { expectedRevision: before.revision, trigger: "batch", steps: 1 });
      for (;;) {
        const document = database.readInstance(instanceId).document;
        const run = Object.values(document.runs).at(-1);
        if (run && ["failed", "preparation-invalidated"].includes(run.status)) {
          throw new Error(run.error ?? run.stopReason ?? run.status);
        }
        if (document.state.revision > before.revision && run && !["queued", "running", "pausing"].includes(run.status)) {
          const entry = document.state.history.at(-1);
          const advances = entry?.operations.filter((operation) => operation.kind === "advance_time") ?? [];
          if (document.state.revision !== before.revision + 1 || document.state.step !== before.step + 1 ||
            entry?.revision !== document.state.revision || entry.step !== document.state.step ||
            advances.length !== 1 || advances[0]!.seconds <= 0) throw new Error("canonical step acceptance failed");
          commits.push({ revision: document.state.revision, step: document.state.step,
            elapsedMs: Date.now() - started, timeAdvanceSeconds: advances[0]!.seconds });
          report();
          break;
        }
        if (Date.now() - started > 20 * 60_000) {
          if (run) await host.pauseRun(instanceId, { runId: run.id, generation: run.generation });
          throw new Error("playtest step exceeded twenty minutes; run paused");
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    status = "passed-three-steps";
  } catch (error) {
    status = "stopped";
    failure = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    clearInterval(timer);
    report();
    database.close();
    registry.stopBackgroundRefresh();
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
