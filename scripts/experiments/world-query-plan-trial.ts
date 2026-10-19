import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJevLiveBudget } from "../../src/engine/benchmarks/jev/live-budget";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { archiveWorldDirectory } from "../../src/server/bundled-worlds";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";

/** Run from each frozen checkout, sharing one cumulative paid-budget directory. */
async function main() {
  const [output, budgetDirectory, scenario = "listen"] = process.argv.slice(2);
  if (!output || !budgetDirectory || !["listen", "handling"].includes(scenario)) {
    throw new Error("usage: tsx scripts/experiments/world-query-plan-trial.ts <new-output-directory> <shared-budget-directory> [listen|handling]");
  }
  const root = path.resolve(output);
  mkdirSync(root, { recursive: false });
  const save = (name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2));
  const started = Date.now(), deadlineMs = 12 * 60_000, maximumCalls = 45;
  let stopped = false, calls = 0;
  const budget = createJevLiveBudget(path.resolve(budgetDirectory), () =>
    stopped || calls >= maximumCalls || Date.now() - started >= deadlineMs ? "bounded query-plan trial dispatch limit" : undefined);
  budget.beginTrial(path.basename(root));
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  const registry = new ModelRegistry(catalog, path.join(root, "models"));
  const network = createModelFetchResolver(process.env);
  const provider = createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
    fetchForAccount: (id, account) => {
      const transport = budget.transport(id, network(id, account) ?? fetch);
      return async (url, init) => { const pending = transport(url, init); calls++; return pending; };
    } });
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  const world = database.importWorld(archiveWorldDirectory(path.resolve("worlds/fanren/world")), catalog);
  const host = new WorldHost({ repository: database, store: database, ledger: database, provider });
  const seed = 20261020;
  const originId = scenario === "listen" ? "han-li" : "herbal-apprentice";
  const text = scenario === "listen" ? "睡前留个心，听听父母低声在说什么。"
    : "我把受托的十二包药材重新扎紧，仔细整理药篓，只整理包扎，不取用或转交任何药材。";
  const provenance = {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    trackedDiffHash: contentHash(execFileSync("git", ["diff", "HEAD"], { encoding: "utf8", maxBuffer: 20_000_000 })),
    harnessHash: contentHash(readFileSync(fileURLToPath(import.meta.url), "utf8")),
    modelCatalogHash: contentHash(catalog.snapshot()), seed, originId, text,
    limits: { maximumCalls, deadlineMs, budgetDirectory: path.resolve(budgetDirectory) },
  };
  save("provenance.json", provenance);
  const instance = await host.createInstance({ worldId: world.id, title: `Query plan trial ${scenario}`, seed,
    start: { kind: "origin", originId, displayName: originId === "han-li" ? "韩立" : "林知远", appearance: "", motivation: "" } });
  const id = instance.summary.id, participant = instance.participants[0]!;
  const initial = database.readInstance(id).document;
  save("initial.json", initial);
  console.log(JSON.stringify({ status: "started", root, instanceId: id, producer: provenance.commit, scenario }));
  const submitted = Date.now(), beforeCalls = calls;
  let failure: string | null = null, worldSettledAt: number | null = null;
  let observedRevision = initial.state.revision, nextProgress = Date.now() + 20_000;
  try {
    await host.submitAction(id, participant.id, { submissionId: `query-plan-${scenario}`, expectedRevision: initial.state.revision, text });
    for (;;) {
      const doc = database.readInstance(id).document, run = Object.values(doc.runs).at(-1);
      const active = run && ["queued", "running", "pausing"].includes(run.status);
      if (run && !active && worldSettledAt === null) worldSettledAt = Date.now();
      if (Date.now() >= nextProgress || doc.state.revision !== observedRevision) {
        console.log(JSON.stringify({ status: "progress", calls, revision: doc.state.revision, run: run?.status, elapsedSeconds: (Date.now() - submitted) / 1000 }));
        observedRevision = doc.state.revision; nextProgress = Date.now() + 20_000;
      }
      if (run && ["failed", "paused", "budget-paused", "preparation-invalidated"].includes(run.status)) throw new Error(run.error ?? run.stopReason ?? run.status);
      if (run && !active && !doc.narratives.some(beat => ["queued", "generating"].includes(beat.status))) break;
      if (Date.now() - started >= deadlineMs || calls >= maximumCalls) {
        stopped = true;
        if (active) await host.pauseRun(id, { runId: run!.id, generation: run!.generation });
        throw new Error("bounded query-plan trial observation limit");
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const ended = Date.now();
  stopped = true;
  await budget.drain();
  const final = database.readInstance(id).document;
  save("final.json", final);
  let replayMatches = false, replayError: string | null = null;
  try { replayMatches = contentHash(replaySimulationState(final.state)) === contentHash(final.state); }
  catch (error) { replayError = error instanceof Error ? error.message : String(error); }
  const beats = final.narratives.filter(beat => beat.submissionId === `query-plan-${scenario}`);
  const first = beats.flatMap(beat => beat.segments.map(segment => Date.parse(segment.publishedAt))).sort((a, b) => a - b)[0];
  const completed = beats.flatMap(beat => beat.completedAt ? [Date.parse(beat.completedAt)] : []).sort((a, b) => b - a)[0];
  const report = { ...provenance, instanceId: id, worldHash: final.state.worldHash, algorithm: final.executionAlgorithm,
    population: Object.keys(final.state.agents).length, calls, turnCalls: calls - beforeCalls, failure,
    submittedAt: new Date(submitted).toISOString(), observedCompleteMs: ended - submitted,
    worldSettledObservedMs: worldSettledAt === null ? null : worldSettledAt - submitted,
    firstPublishedMs: first === undefined ? null : first - submitted, narrativeCompleteMs: completed === undefined ? null : completed - submitted,
    worldSeconds: final.state.truth.elapsedSeconds - initial.state.truth.elapsedSeconds,
    fromRevision: initial.state.revision, toRevision: final.state.revision, replayMatches, replayError,
    runs: Object.values(final.runs), narratives: beats, executions: database.executions({ instanceId: id }).map(row => row.id) };
  save("report.json", report);
  console.log(JSON.stringify({ status: "finished", root, failure, calls, seconds: report.observedCompleteMs / 1000, replayMatches }));
  registry.stopBackgroundRefresh(); budget.close();
  if (!Object.values(final.runs).some(run => ["queued", "running", "pausing"].includes(run.status))) database.close();
  process.exit(failure ? 1 : 0);
}
void main().catch(error => { console.error(error); process.exit(1); });
