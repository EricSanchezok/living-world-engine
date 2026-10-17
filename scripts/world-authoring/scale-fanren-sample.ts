import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ModelExecutionAudit, ModelTokenUsage } from "../../src/engine/contracts/model";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { readDirectState } from "../../src/engine/direct/state";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { buildWorldDefinition, hashWorldTemplate, loadWorldTemplate } from "../../src/script/world-loader";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { archiveScaleWorld, makeFanrenScaleWorld } from "./fanren-scale-world";

async function main() {
  const population = Number(process.argv[2]);
  if (population !== 150 && population !== 700) throw new Error("usage: npx tsx scripts/world-authoring/scale-fanren-sample.ts 150|700");
  const source = loadWorldTemplate(path.resolve("worlds/fanren/samples/opening/world"));
  const fixture = makeFanrenScaleWorld(source, population);
  const { template } = fixture;
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-scale-${population}`;
  const root = path.resolve(".livingworld-cache/fanren-playtests", runId);
  mkdirSync(root, { recursive: true });
  const save = (name: string, value: unknown) => writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`);
  const catalog = loadModelCatalog();
  const registry = new ModelRegistry(catalog, path.join(root, "models"));
  const provider = createModelGateway(catalog, process.env, { registry, fetchForAccount: createModelFetchResolver(process.env) });
  await provider.assertProfilesAvailable(["decision-jev", "creation-deepseek", "decision-deepseek"]);
  const definition = buildWorldDefinition(template, { seed: 20261017, modelCatalog: catalog });
  if (Object.keys(definition.initialState.agents).length !== population) throw new Error("population mismatch");
  const archive = archiveScaleWorld(template);
  writeFileSync(path.join(root, "world.zip"), archive);
  save("fixture.json", { sourceWorldHash: hashWorldTemplate(source), population, baseAgents: fixture.baseAgents,
    syntheticAgents: fixture.syntheticAgents, relationFacts: fixture.relationFacts,
    scope: "synthetic-scale-probe-not-canonical-coverage", worldHash: definition.contentHash });
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  const imported = database.importWorld(archive, catalog);
  const host = new WorldHost({ repository: database, store: database, ledger: database, provider });
  const started = Date.now();
  const instance = await host.createInstance({ worldId: imported.id, title: template.manifest.name, seed: 20261017, start: { kind: "observer" } });
  const id = instance.summary.id;
  const initial = database.readInstance(id).document;
  save("initial.json", initial);
  process.stdout.write(`${JSON.stringify({ runId, instanceId: id, population, status: "created" })}\n`);
  let failure: string | null = null;
  try { await host.advance(id, { expectedRevision: initial.state.revision, trigger: "manual" }); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const final = database.readInstance(id).document;
  save("final.json", final);
  const events = database.instanceEvents(id);
  save("events.json", events);
  const control = readDirectState(final.state.executionState!, final.state);
  const frames = final.state.history.flatMap(entry => entry.directEvent?.frames ?? []);
  const audits = events.filter(event => event.event === "model.audit.persisted").map(event => event.payload as ModelExecutionAudit);
  const invocations = audits.flatMap(audit => audit.invocations);
  const actorIds = [...new Set(frames.map(frame => frame.actorId))];
  const decisionIds = [...new Set(audits.map(audit => audit.subjectId).filter(subject => subject in final.state.agents))];
  const checks = {
    population: Object.keys(final.state.agents).length === population,
    canonicalHanCount: Object.values(final.state.truth.entities).filter(entity => entity.id === "canon-han-li").length,
    quantitiesUnchanged: contentHash(initial.state.truth.quantities) === contentHash(final.state.truth.quantities),
    relationsPreserved: template.entities.flatMap(entity => entity.facts).filter(fact => fact.id.startsWith("scale-resident-")).every(fact =>
      contentHash(final.state.truth.facts[fact.id]?.value ?? null) === contentHash(fact.value)),
    replayEqual: contentHash(replaySimulationState(final.state)) === contentHash(final.state),
  };
  save("perspective-samples.json", Object.keys(final.state.agents).filter(agent => agent.startsWith("scale-resident-")).slice(0, 3)
    .map(agent => projectAgentPerspective(final.state, final.state.agents[agent]!)));
  const tokenKeys: Array<keyof ModelTokenUsage> = ["input", "output", "reasoning", "cacheRead", "cacheWrite"];
  const report = { runId, instanceId: id, population, worldHash: final.state.worldHash, producer: final.executionAlgorithm,
    durationMs: Date.now() - started, failure,
    runStatuses: Object.values(final.runs).map(run => ({ status: run.status, error: run.error, stopReason: run.stopReason })),
    decisionSubjects: decisionIds.length, actorsWithCommittedActions: actorIds.length, committedFrames: frames.length,
    pendingActivities: control.activities.length,
    failedIntents: Object.entries(control.intents).filter(([, intent]) => intent.failure).map(([agentId, intent]) => ({ agentId, failure: intent.failure })),
    physicalRequests: events.filter(event => event.event === "model.transport.started").length,
    auditedInvocations: invocations.length,
    tokens: Object.fromEntries(tokenKeys.map(key => [key, { knownSum: invocations.reduce((sum, invocation) => sum + (invocation.tokenUsage[key] ?? 0), 0),
      unknownInvocations: invocations.filter(invocation => invocation.tokenUsage[key] === null).length }])), cost: null,
    errors: events.filter(event => event.level === "error").map(event => ({ sequence: event.sequence, event: event.event })), checks,
    limitations: ["Single autonomous world checkpoint, not a long-run stability qualification.",
      "Synthetic extra residents do not count as canonical world coverage.", "Observer mode does not test player narration or all nine Origins.",
      "The low-conflict inventory task does not exercise relationship disputes or every stored relationship.",
      "Costs are unknown where complete billing evidence is unavailable."] };
  save("report.json", report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  const passed = !failure && checks.population && checks.canonicalHanCount === 1 && checks.quantitiesUnchanged && checks.relationsPreserved && checks.replayEqual
    && !report.errors.length && !report.failedIntents.length && report.runStatuses.every(run => run.status === "completed");
  process.exitCode = passed ? 0 : 1;
  if (!Object.values(final.runs).some(run => ["queued", "running", "pausing"].includes(run.status))) database.close();
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
