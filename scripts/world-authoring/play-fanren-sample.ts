import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { projectAgentPerspective } from "../../src/engine/cognition/agent-perspective";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";

const scenarios: Record<string, string[]> = {
  "han-li": ["我轻声对父母说：我现在不想离开村子拜师学武，我想留在家里学些谋生的手艺。", "我走到村边小路，看看通向山坡的路面。"],
  "herbal-apprentice": ["我把周荃刚才的报价告诉师父陈守拙，请他决定是否愿意单卖那株草；我继续保管好受托的药材。"],
  "spirit-merchant": ["我先逐箱清点仓院内已到的灵材，把实物数量同交接单核对，并把点数结果告诉岑玉和陶岐。", "我催动已学的御物法诀，将自己身上的青纹护身佩托起到眼前，再收回手中。"],
  "merchant-heir": ["我从自己的私房银里拿出五两交给阿柳，说明这是托她明早买家用茶点的费用，余款请带回；商号钱柜不动。"],
  "escort-apprentice": ["我保持货箱封签不动，试着像修士那样隔空把货箱托起。我想知道自己没有灵根和法力时，这样做会不会有效。"],
  "clan-junior": ["我对沈照说：这件器座仍是族产，我愿与你合作修补，先一起向沈从简提出分担材料与收益的方案，不先把器座据为己有。"],
  "foundation-independent": ["我用已经掌握的御物法诀，把随身飞行法器托到眼前检查外观，再收回手中。"],
  "core-clan-elder": ["我从自己的积蓄里取出一百枚低阶灵石交给许澄，说明这是我自愿给后辈修习的资助，不从族库支出。"],
  "spirit-array-master": ["我催动已学的御物法诀，把自己的定潮法盘托到眼前，再收回手中。顾清弦带来的阵片仍由他暂持，等双方提供凭据。"],
};

async function main() {
  const scenario = process.argv[2];
  if (!scenario || !scenarios[scenario]) throw new Error(`usage: npx tsx scripts/world-authoring/play-fanren-sample.ts ${Object.keys(scenarios).join("|")}`);
  const runId = `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${scenario}`;
  const root = path.resolve(".livingworld-cache/fanren-playtests", runId);
  mkdirSync(root, { recursive: true });
  const catalog = loadModelCatalog(path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml"));
  const registry = new ModelRegistry(catalog, path.join(root, "models"));
  const provider = createModelGateway(catalog, process.env, { registry, fetchForAccount: createModelFetchResolver(process.env) });
  await provider.assertProfilesAvailable(["decision-jev", "creation-deepseek", "decision-deepseek"]);
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  const imported = database.importWorld(readFileSync(path.resolve(".livingworld-cache/fanren-artifacts/opening-sample.zip")), catalog);
  const host = new WorldHost({ repository: database, store: database, ledger: database, provider });
  const startedAt = Date.now();
  const instance = await host.createInstance({ worldId: imported.id, title: `凡人样本实测：${scenario}`, seed: 20261017,
    start: { kind: "origin", originId: scenario, displayName: scenario === "han-li" ? "韩立" : "林知远", appearance: "", motivation: "" } });
  const id = instance.summary.id, participant = instance.participants[0]!;
  const actions: unknown[] = [];
  const save = (file: string, value: unknown) => writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  save("initial.json", database.readInstance(id).document);
  process.stdout.write(`${JSON.stringify({ runId, instanceId: id, scenario, status: "created" })}\n`);
  let failure: string | null = null;
  for (const text of scenarios[scenario]!) {
    const before = database.readInstance(id).document;
    const actionStarted = Date.now();
    try {
      await host.submitAction(id, participant.id, { submissionId: randomUUID(), expectedRevision: before.state.revision, text });
      let lastProgress = 0;
      for (;;) {
        const document = database.readInstance(id).document;
        const run = Object.values(document.runs).at(-1);
        if (run && ["failed", "preparation-invalidated"].includes(run.status)) throw new Error(run.error ?? run.stopReason ?? run.status);
        if (run?.servicePause) throw new Error(`service pause: ${JSON.stringify(run.servicePause)}`);
        const running = run && ["queued", "running", "pausing"].includes(run.status);
        const narrativeRunning = document.narratives.some(beat => ["queued", "generating"].includes(beat.status));
        if (document.state.revision > before.state.revision && !running && !narrativeRunning) break;
        if (Date.now() - actionStarted > 900000) throw new Error("action exceeded 15-minute observation budget; not recorded as a pass");
        if (Date.now() - lastProgress > 15000) {
          process.stdout.write(`${JSON.stringify({ scenario, revision: document.state.revision, run: run?.status, elapsedMs: Date.now() - actionStarted })}\n`);
          lastProgress = Date.now();
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      const after = database.readInstance(id).document;
      const playerEntityId = after.state.agents[participant.agentId]!.entityId;
      save(`after-${actions.length + 1}.json`, after);
      actions.push({ text, beforeRevision: before.state.revision, afterRevision: after.state.revision,
        durationMs: Date.now() - actionStarted, historyEntries: after.state.history.length - before.state.history.length,
        playerPlacement: after.state.truth.placements[playerEntityId],
        meters: Object.values(after.state.truth.meters).filter(meter => meter.entityId === playerEntityId),
        perspective: projectAgentPerspective(after.state, after.state.agents[participant.agentId]!) });
    } catch (error) { failure = error instanceof Error ? error.message : String(error); break; }
  }
  const final = database.readInstance(id).document;
  save("final.json", final);
  save("events.json", database.instanceEvents(id));
  const report = { runId, scenario, instanceId: id, worldHash: final.state.worldHash,
    profiles: final.state.agents[participant.agentId]!.modelProfiles,
    population: Object.keys(final.state.agents).length, durationMs: Date.now() - startedAt,
    status: failure ? "failed-needs-review" : "committed-needs-semantic-review", failure, actions,
    executionIds: database.executions({ instanceId: id }).map(execution => execution.id) };
  save("report.json", report);
  process.stdout.write(`${JSON.stringify({ runId, scenario, status: report.status, failure, population: report.population, durationMs: report.durationMs, actions: actions.length })}\n`);
  // Keep the Ledger available for diagnosis even when a model call fails.
  process.exitCode = failure ? 1 : 0;
  if (!Object.values(final.runs).some(run => ["queued", "running", "pausing"].includes(run.status))) database.close();
}

main().catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
