import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { loadWorldScript } from "../../src/script/world-loader";
import { MemoryWorldRepository } from "../../src/script/world-repository";
import { loadModelCatalog, parseModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { LocalDatabase } from "../../src/server/local-database";
import { WorldHost } from "../../src/server/world-host";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { contentHash } from "../../src/engine/models/model-audit";
import { readAgentMemory } from "../../src/engine/cognition/memory";
import { readDirectState } from "../../src/engine/direct/state";
import { replayThroughAlgorithm } from "./execution-command";

function checkRecall(speech: string) {
  return { helper: /林舟|你/.test(speech), rescue: /救|拉[^。]*上来/.test(speech), amount: /17|十七/.test(speech),
    deadline: /三日|三天/.test(speech) && /傍晚/.test(speech), place: /石门/.test(speech), oldCode: /青鹭归巢/.test(speech),
    newItem: /蓝(?:色)?围巾/.test(speech), newCode: /竹影九声/.test(speech) };
}
// A scripted prehistory exercises repeated compression using the production model capacities.
async function main() {
  if (process.argv[2] === "--verify") {
    const file = path.resolve(process.argv[3]!, "report.json"), report = JSON.parse(readFileSync(file, "utf8"));
    const last = report.turns.findLast((turn: { recall: boolean }) => turn.recall);
    report.recall = checkRecall(last?.npcLines.join("\n") ?? "");
    report.completed = report.finalMemoryVersion >= 3 && Object.values(report.recall).every(Boolean) &&
      report.replay?.replayStatus === "succeeded" && report.turns.every((turn: { failures: unknown[] }) => !turn.failures.length);
    writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ completed: report.completed, recall: report.recall }));
    if (!report.completed) throw new Error("Recorded memory qualification did not pass");
    return;
  }
  const root = path.resolve(process.argv[2] ?? `.livingworld-benchmarks/agent-memory-${Date.now()}`);
  mkdirSync(root, { recursive: true });
  const worldRoot = path.join(root, "world"); cpSync("test/fixtures/open-world-script", worldRoot, { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Fixture YAML is validated by the real world loader below.
  const edit = (file: string, change: (value: Record<string, any>) => void) => { // Authored fixture YAML, validated by the real loader.
    const name = path.join(worldRoot, file), value = parse(readFileSync(name, "utf8")); change(value); writeFileSync(name, stringify(value));
  };
  edit("script.yaml", value => { value.id = "memory-qualification"; value.name = "石门旧约 · 长期记忆验证";
    value.description = "真实模型的连续压缩与回忆验证，使用预先积累的历史加速触发，模型容量与生产配置一致。"; });
  edit("entities/player.yaml", value => { value.name = "林舟"; value.description = "与石门守卫江渡相识的旅人。";
    value.agent.belief.local_entities.push({ id: "gatekeeper", name: "江渡", description: "熟识的石门守卫。", status: "observed" });
    value.agent.belief.bindings.push({ local_entity_id: "gatekeeper", canonical_entity_ids: ["keeper"] }); });
  edit("entities/keeper.yaml", value => { value.name = "江渡"; value.description = "当值的石门守卫江渡。";
    value.agent.character.persona.summary = "石门守卫，熟识林舟，重情守信，乐于和他谈起共同经历。";
    value.agent.character.attitudes[0].description = "信任救过自己性命的林舟。";
    value.agent.character.goals = value.agent.character.goals.slice(0, 1);
    value.agent.belief.local_entities[1] = { id: "traveler", name: "林舟", description: "熟识的救命恩人。", status: "observed" };
    value.agent.belief.evidence = Array.from({ length: 28 }, (_, index) => ({ id: `past-${String(index).padStart(3, "0")}`,
      kind: "observation", sourceId: null, step: 0, description: index === 0
        ? "两日前，林舟把我从涨水的沟渠中救出。我向他借了 17 枚灵石，承诺三日后傍晚在石门归还；我们约定的辨认暗号是青鹭归巢。这笔借款尚未归还。"
        : `第 ${index} 次日常值守：${"院子与石门都没有异常变化。我照常站在门边，听见附近人的脚步和交谈，只是天气与日常起居的闲话，没有新的约定、姓名或待办，也没有发现值得追查的线索。".repeat(5)}` })); });
  const config = loadModelCatalog(path.resolve("config/models.yaml")).snapshot();
  const catalog = parseModelCatalog(config); writeFileSync(path.join(root, "models.yaml"), stringify(config));
  const registry = new ModelRegistry(catalog, root), provider = createModelGateway(catalog, process.env, {
    registry, maxTransportAttempts: 1, fetchForAccount: createModelFetchResolver(process.env),
  });
  await provider.assertProfilesAvailable(["decision-jev", "creation-deepseek", "decision-deepseek"]);
  const world = loadWorldScript(worldRoot, { seed: 4242, modelCatalog: catalog });
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider });
  const observer = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
  const created = await host.transferControl(observer.summary.id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
  const id = created.summary.id, participantId = created.conversation!.participantId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- The qualification report includes evolving engine evidence.
  const report: Record<string, any> = { instanceId: id, world: world.id, root, modelCatalogHash: catalog.hash,
    capacityOverrides: false, nativeQuestionLimit: config.profiles["decision-jev"]!.max_question_tokens, productionThreshold: 0.8, turns: [], checkpoints: [] };
  const save = () => writeFileSync(path.join(root, "report.json"), JSON.stringify(report, null, 2));
  const read = () => database.readInstance(id).document;
  for (let round = 0; round < 24; round++) {
    const version = read().agentMemories.keeper?.checkpoint?.version ?? 0;
    // Leave enough unrelated turns to move both agreements beyond the recent raw tail.
    const recall = round === 0 || round >= 11 && version >= 3 || round === 23;
    const text = recall ? "江渡，还记得我曾经怎样帮过你吗？我们之间尚未办完的约定具体是什么，何时何地办，辨认暗号又是什么？请按你记得的说，不知道的就说不知道。" + (round > 1 ? "另外，我后来告诉你的寄存物品和另一句口令是什么？分开说，不要混淆。" : "")
      : round === 1 ? "江渡，另外告诉你一件新事：我把一条蓝色围巾寄存在院子里，取回时认的口令是竹影九声。这与我们原来的借款和暗号是两回事，别混淆。"
      : `江渡，先聊聊日常吧。${[
        "你站一整天会不会累？轮到你歇脚时，你一般怎么放松？",
        "我早晨喜欢听风声，午后喜欢晒太阳，你更喜欢什么时辰当值？",
        "我走路时会数脚步，很容易走神。你值守时怎么让自己保持精神？",
        "我想起小时候路过的村子，早晨有炊烟，晚上有灯火。你平时喜欢安静还是热闹？",
        "天气冷时，我会搓搓手，活动一下肩膀。你站在门边会怎么御寒？",
        "我觉得热饭比干粮舒服，你忙完值守之后最想吃些什么？",
        "有时候一整天都很平淡，也挺好的。今天有没有让你觉得舒心的小事？",
        "我想学会更有耐心地等候。你怎样熬过当值时那些很安静的时刻？",
        "我看见有人走路总低着头，有人总环顾四周。你平时更容易留意什么？",
      ][(round - 2) % 9]}`;
    const started = Date.now(), submissionId = `memory-turn-${round}`;
    console.log(JSON.stringify({ round, phase: "submit", version, recall }));
    await host.submitAction(id, participantId, { expectedRevision: read().state.revision, submissionId, text });
    for (;;) {
      const document = read(), intent = document.participantIntents.find(item => item.submissionId === submissionId), run = intent ? document.runs[intent.runId] : null;
      if (run && !["queued", "running"].includes(run.status)) {
        if (["failed", "paused", "budget-paused"].includes(run.status)) throw new Error(`Turn stopped: ${run.error ?? run.stopReason}`);
        break;
      }
      if (Date.now() - started > 300000) throw new Error("Turn exceeded five minutes");
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    await host.drainNarratives(id); await host.drainMemories(id);
    const document = read(), checkpoint = document.agentMemories.keeper?.checkpoint;
    const turn = host.instance(id).conversation!.turns.find(item => item.action?.submissionId === submissionId);
    const npcLines = document.state.history.filter(step => step.revision > (report.turns.at(-1)?.revision ?? 0))
      .flatMap(step => step.directEvent?.frames ?? []).filter(frame => frame.actorId === "keeper" && frame.utterance).map(frame => frame.utterance);
    const memory = readAgentMemory(document.state, document.state.agents.keeper!, checkpoint);
    report.turns.push({ round, recall, text, elapsedMs: Date.now() - started, revision: document.state.revision,
      failures: Object.entries(readDirectState(document.state.executionState!, document.state).intents).filter(([, intent]) => intent.failure).map(([agent, intent]) => ({ agent, failure: intent.failure })),
      memoryVersion: checkpoint?.version ?? 0, response: turn?.responses?.map(response => response.text), npcLines,
      important: memory.important, memoryAttempt: document.agentMemories.keeper?.attempt });
    if (checkpoint && !report.checkpoints.some((item: { version: number }) => item.version === checkpoint.version)) report.checkpoints.push(checkpoint);
    save(); console.log(JSON.stringify({ round, phase: "complete", version: checkpoint?.version ?? 0, npcLines, elapsedMs: Date.now() - started }));
    if (contentHash(replaySimulationState(document.state)) !== contentHash(document.state)) throw new Error("World replay diverged");
    if (report.turns.at(-1).failures.length) throw new Error("Direct intent failed; inspect the recorded report");
    if (recall && !npcLines.length) throw new Error("Recall has no committed NPC speech");
    if (recall && version >= 3 && round >= 11) break;
  }
  const document = read();
  const memoryExecutions = database.executions({ instanceId: id }).filter(item => item.manifest.id === "agent-memory").map(item => {
    const events = database.executionEvents(item.id);
    const startRevision = events.find(event => event.event === "model.invocation.started")?.correlation?.revision;
    const usage = events.find(event => event.event === "model.structured_output.parsed")?.measurements;
    return { id: item.id, status: item.status, startRevision, endRevision: item.commitRevision,
      inputTokens: usage?.inputTokens, outputTokens: usage?.outputTokens };
  });
  const elapsed = report.turns.map((turn: { elapsedMs: number }) => turn.elapsedMs).sort((a: number, b: number) => a - b);
  report.evidence = { memoryExecutions, turnLatencyMs: { min: elapsed[0], median: elapsed[Math.floor(elapsed.length / 2)], max: elapsed.at(-1) },
    concurrentCompactions: memoryExecutions.filter(item => item.startRevision !== undefined && item.endRevision !== undefined && item.endRevision > item.startRevision).length };
  const executionId = Object.values(document.runs).flatMap(run => run.executionIds).findLast(id => database.executionEvents(id).some(event => event.event === "execution.candidate.persisted"));
  if (executionId) report.replay = await replayThroughAlgorithm(database, database.execution(executionId)!, database.executionEvents(executionId));
  report.finalMemoryVersion = document.agentMemories.keeper?.checkpoint?.version ?? 0;
  const lastRecall = report.turns.findLast((turn: { recall: boolean }) => turn.recall);
  const speech = lastRecall?.npcLines.join("\n") ?? "";
  report.recall = checkRecall(speech);
  report.completed = report.finalMemoryVersion >= 3 && Object.values(report.recall).every(Boolean) && report.replay?.replayStatus === "succeeded";
  save(); console.log(JSON.stringify({ report: path.join(root, "report.json"), memoryVersion: report.finalMemoryVersion, replay: report.replay?.replayStatus }));
  database.close();
  if (!report.completed) throw new Error("Memory qualification did not pass all recall and replay checks");
}
main().catch(error => { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1; });
