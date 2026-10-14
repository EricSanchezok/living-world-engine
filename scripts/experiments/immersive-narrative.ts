import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createJevLiveBudget } from "../../src/engine/benchmarks/jev/live-budget";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog, parseModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { loadWorldScript } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { qualificationCatalogDocument } from "./jev-qualification-protocol";

import { createHash } from "node:crypto";
import { CONTINUITY_AXES, CONTINUITY_CASES, CONTINUITY_SEEDS, type ContinuityCase } from "../../src/engine/benchmarks/conversation-continuity/cases";
import { CONTINUITY_CORPUS_SHA256 } from "../../src/engine/benchmarks/conversation-continuity/qualification";

export function selectContinuityFlows(phase: string, selected?: string) {
  if (!["development", "confirmation", "continuous"].includes(phase)) throw new Error("Choose development, confirmation or continuous");
  if (selected && phase !== "development") throw new Error("Confirmation and continuous runs require the entire frozen cohort");
  const ids = selected?.split(",");
  const flows = CONTINUITY_CASES.filter(flow => flow.phase === phase && (!ids || ids.includes(flow.id)));
  if (!flows.length || ids?.some(id => !flows.some(flow => flow.id === id))) throw new Error("Unknown scenario selection");
  return flows;
}

export function plannedContinuityRounds(flows: ContinuityCase[], recorded: ReadonlySet<string>) {
  return flows.flatMap(flow => flow.turns.map(({ text, expectation }, index) => ({
    flowId: flow.id, turn: index + 1, submissionId: `${flow.id}-${index + 1}`, text, expectation,
    evidenceFile: `${flow.id}-${index + 1}.json`,
    status: recorded.has(`${flow.id}-${index + 1}`) ? "recorded" : "not-run",
  })));
}

async function main() {
  const phase = process.argv[2] ?? "development", selected = process.argv[3];
  const flows = selectContinuityFlows(phase, selected);
  const seed = Number(process.argv[4] ?? CONTINUITY_SEEDS[0]);
  if (!CONTINUITY_SEEDS.some(value => value === seed)) throw new Error("Use a frozen evaluation seed");
  const corpus = readFileSync("src/engine/benchmarks/conversation-continuity/cases.ts");
  if (createHash("sha256").update(corpus).digest("hex") !== CONTINUITY_CORPUS_SHA256) throw new Error("Frozen scenario corpus changed");
  const root = path.resolve(".livingworld-benchmarks/jev-engine"), trial = `continuity-${phase}-${seed}-${Date.now()}`;
  const directory = path.join(root, trial); mkdirSync(directory);
  const save = (name: string, value: unknown) => writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2), { flag: "wx", flush: true });
  const diff = execFileSync("git", ["diff", "HEAD"], { encoding: "utf8" });
  if (phase !== "development" && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Freeze a clean producer for confirmation");
  const promptHashes = Object.fromEntries(execFileSync("rg", ["--files", "src/engine/prompts"], { encoding: "utf8" }).trim().split("\n")
    .filter(file => file.endsWith(".md")).sort().map(file => [file, contentHash(readFileSync(file, "utf8"))]));
  let stopped: string | undefined;
  const live = createJevLiveBudget(root, () => stopped ?? (phase === "development" && live.budget.summary.tranche &&
    live.budget.summary.tranche.knownNanoCny + live.budget.summary.tranche.reservedNanoCny > 30_000_000_000 ? "development allocation ceiling" : undefined));
  if (live.budget.summary.tranche?.id !== "conversation-continuity-20261014") {
    live.close(); throw new Error("The separate conversational-continuity grant must be active");
  }
  live.beginTrial(trial);
  const catalog = parseModelCatalog(qualificationCatalogDocument(loadModelCatalog(), "C"));
  const registry = new ModelRegistry(catalog, directory), resolver = createModelFetchResolver(process.env);
  const gateway = new ModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
    fetchForAccount: (id, account) => live.transport(id, resolver(id, account) ?? fetch) });
  let database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false });
  const worlds = [loadWorldScript(path.resolve("worlds/blackmarsh/world"), { seed, modelCatalog: catalog }),
    loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed, modelCatalog: catalog })];
  const repository = new MemoryWorldRepository(Object.fromEntries(worlds.map(world => [world.id, world])));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clearHostTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
  const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: gateway,
    setTimer(callback, delayMs) {
      const timer = setTimeout(() => { timers.delete(timer); callback(); }, delayMs); timers.add(timer); return timer;
    },
    clearTimer(timer) { clearTimeout(timer); timers.delete(timer); },
  });
  let host = makeHost();
  const manifest = { trial, phase, flows, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    diffHash: contentHash(diff), driverHash: contentHash(readFileSync(import.meta.filename, "utf8")),
    worlds: worlds.map(world => ({ id: world.id, hash: world.contentHash })), catalogHash: catalog.hash, promptInventoryHash: contentHash(promptHashes),
    beforeBudget: live.budget.summary, seed, corpusHash: CONTINUITY_CORPUS_SHA256,
    protocolHash: contentHash(readFileSync("docs/research/2026-10-14-conversation-continuity-protocol.md", "utf8")),
    rubric: { axes: CONTINUITY_AXES, requiredRate: 0.9, perWorld: true, continuousPerSession: true }, review: "Unscored until persisted state and full text are reviewed. Latency is observed presentation time, not proof of useful feedback." };
  save("manifest.json", manifest); writeFileSync(path.join(directory, "producer.diff"), diff);
  save("prompt-assets.json", promptHashes); save("model-catalog.json", catalog.snapshot());
  writeFileSync(path.join(directory, "driver.ts"), readFileSync(import.meta.filename));
  const reports: unknown[] = [];
  try {
    for (const flow of flows) {
      const flowBudget = live.budget.summary;
      const coldStarted = performance.now();
      const created = await host.createInstance({ worldId: flow.world, seed, start: flow.world === "blackmarsh"
        ? { kind: "origin", originId: "harbor-wayfarer", displayName: "林舟", appearance: "穿深色旅行外衣，背着帆布包。", motivation: "认识这里的人，找到落脚之处。" }
        : { kind: "observer" } });
      const id = created.summary.id;
      if (flow.world !== "blackmarsh") await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "engineer" } });
      const initial = database.readInstance(id).document, participant = Object.values(initial.participants).find(item => item.status === "active")!;
      save(`${flow.id}-initial.json`, initial);
      const rows: unknown[] = [];
      const coldMs = performance.now() - coldStarted;
      const coldRequests = live.budget.summary.phases.trajectory.httpRequests - flowBudget.phases.trajectory.httpRequests;
      const coldCostCny = (live.budget.summary.estimatedPeakNanoCny - flowBudget.estimatedPeakNanoCny) / 1e9;
      for (const [index, { text, expectation }] of flow.turns.entries()) {
        const before = database.readInstance(id).document, beforeBudget = live.budget.summary;
        const submissionId = `${flow.id}-${index + 1}`, started = performance.now();
        let failure: string | null = null, firstParagraphMs: number | null = null;
        try {
          await host.submitAction(id, participant.id, { expectedRevision: before.state.revision, submissionId, text });
          for (;;) {
            const doc = database.readInstance(id).document, intent = doc.participantIntents.find(item => item.submissionId === submissionId);
            const run = intent && doc.runs[intent.runId], beats = doc.narratives.filter(beat => beat.submissionId === submissionId);
            if (!run) throw new Error("Missing durable run");
            if (beats.some(beat => beat.segments.length)) firstParagraphMs ??= performance.now() - started;
            if (!["running", "queued", "pausing"].includes(run.status) && !beats.some(beat => ["queued", "generating"].includes(beat.status))) break;
            if (performance.now() - started > 240_000) {
              stopped = "trial censored after four minutes without actionable feedback";
              if (["running", "queued", "pausing"].includes(run.status)) await host.pauseRun(id, { runId: run.id, generation: run.generation });
              throw new Error(stopped);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          await host.drainNarratives(id);
        } catch (error) { failure = String(error); }
        await live.drain();
        const document = database.readInstance(id).document, intent = document.participantIntents.find(item => item.submissionId === submissionId);
        const run = intent && document.runs[intent.runId];
        const row = { text, expectation, submissionId, failure, status: run?.status, stopReason: run?.stopReason, firstParagraphMs,
          completeMs: performance.now() - started, replayEqual: contentHash(replaySimulationState(document.state)) === contentHash(document.state),
          fromWorldSeconds: before.state.truth.elapsedSeconds, toWorldSeconds: document.state.truth.elapsedSeconds,
          httpRequests: live.budget.summary.phases.trajectory.httpRequests - beforeBudget.phases.trajectory.httpRequests,
          costCny: (live.budget.summary.estimatedPeakNanoCny - beforeBudget.estimatedPeakNanoCny) / 1e9,
          reservedCny: (live.budget.summary.reservedNanoCny - beforeBudget.reservedNanoCny) / 1e9,
          feedback: host.instance(id).conversation?.turns.find(turn => turn.action?.submissionId === submissionId),
          beats: document.narratives.filter(beat => beat.submissionId === submissionId),
          sameEventTemplate: document.state.history.filter(step => step.revision > before.state.revision)
            .flatMap(step => step.observations.filter(observation => observation.observerId === participant.agentId).map(observation => observation.summary)),
          newEntities: Object.keys(document.state.truth.entities).filter(entityId => !before.state.truth.entities[entityId]),
          newAgents: Object.keys(document.state.agents).filter(agentId => !before.state.agents[agentId]) };
        rows.push(row); save(`${flow.id}-${index + 1}.json`, { ...row, document });
        console.log(JSON.stringify({ trial, flow: flow.id, input: index + 1, status: row.status, failure, firstParagraphMs,
          completeMs: row.completeMs, requests: row.httpRequests, costCny: row.costCny, replay: row.replayEqual }));
        if (failure || run?.status === "failed" || stopped || live.budget.summary.blockingUnknown.length) break;
      }
      const saved = database.readInstance(id).document;
      const calls = live.budget.summary.phases.trajectory.httpRequests;
      clearHostTimers(); database.close(); database = new LocalDatabase(path.join(directory, "world.sqlite"), { heartbeat: false }); host = makeHost();
      await host.drainNarratives(id); host.instance(id); host.instance(id); await live.drain();
      reports.push({ id: flow.id, instanceId: id, initialSubjects: Object.keys(initial.state.agents).length, coldMs, coldRequests, coldCostCny, rows,
        restartStateEqual: contentHash(database.readInstance(id).document.state) === contentHash(saved.state),
        restartNarrativeEqual: contentHash(database.readInstance(id).document.narratives) === contentHash(saved.narratives),
        extraReadCalls: live.budget.summary.phases.trajectory.httpRequests - calls });
      await host.transferControl(id, { expectedRevision: saved.state.revision, target: { kind: "observer" } });
      if (phase === "continuous" && flow.world === "blackmarsh" && !stopped && !live.budget.summary.blockingUnknown.length) {
        const beforeAutonomy = live.budget.summary, autonomyStarted = performance.now();
        let failure: string | null = null;
        try { await host.advance(id, { expectedRevision: saved.state.revision, trigger: "batch", steps: 1 }); }
        catch (error) { failure = String(error); }
        await live.drain();
        const autonomous = database.readInstance(id).document;
        const evidence = { failure, elapsedMs: performance.now() - autonomyStarted,
          subjects: Object.keys(autonomous.state.agents).length,
          httpRequests: live.budget.summary.phases.trajectory.httpRequests - beforeAutonomy.phases.trajectory.httpRequests,
          costCny: (live.budget.summary.estimatedPeakNanoCny - beforeAutonomy.estimatedPeakNanoCny) / 1e9,
          replayEqual: contentHash(replaySimulationState(autonomous.state)) === contentHash(autonomous.state) };
        save("full-roster.json", { ...evidence, document: autonomous });
        console.log(JSON.stringify({ trial, fullRoster: evidence }));
      }
      if (stopped || live.budget.summary.blockingUnknown.length) break;
    }
  } finally {
    const stopReason = stopped ?? null;
    stopped = "experiment closed"; clearHostTimers(); await live.drain();
    const plannedRounds = plannedContinuityRounds(flows, new Set(flows.flatMap(flow => flow.turns
      .map((_, index) => `${flow.id}-${index + 1}`).filter(id => existsSync(path.join(directory, `${id}.json`))))));
    save("result.json", { ...manifest, reports, plannedRounds, stopped: stopReason, afterBudget: live.budget.summary, doctor: database.debugDoctor() });
    database.close(); registry.stopBackgroundRefresh(); live.close();
    console.log(JSON.stringify({ result: path.join(directory, "result.json") }));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  void main().catch(error => { console.error(String(error)); process.exitCode = 1; });
}
