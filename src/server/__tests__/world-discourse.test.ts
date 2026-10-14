import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer, directCreationContext, directDecisionContext } from "../../engine/testing/direct-provider";
import { replaySimulationState } from "../../engine/runtime/transaction";
import type { ParticipantDiscourse } from "../../engine/contracts/discourse";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { participantDiscourse } from "../world-discourse";
import type { ScenePacket } from "../narrative/contracts";

describe("published discourse through the persistent entry path", () => {
  it("shares introduced identity across explanation, an elliptical follow-up, reload and replay", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-shared-discourse-"));
    let phase = "introduction";
    const f = directTestProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string } };
      const player = context.perspective?.agentId === "player";
      return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => {
        let value = id.startsWith("paragraph") ? "grounded" : id.includes("outcome") ? "succeeded" :
          id.includes("delivery") ? "delivered" : id.includes("actor_visibility") || /_entity\d+$/u.test(id) ? "visible" :
          id.includes("goal_status") || id.includes("belief_status") || id.includes("fact") ? "unchanged" : "none";
        if (id === "interaction") value = phase === "explanation" ? "clarification" : "world_action";
        if (id === "operation") value = player && phase !== "follow-up" ? "observe" : "speak";
        if (id === "observation_scope") value = "surroundings";
        if (id === "target" || id === "recipient") value = player && phase !== "introduction" && q.type === "choice"
          ? Object.entries(q.criteria).find(([, item]) => (item as { name?: string })?.name === "附近的人")?.[0] ?? "none"
          : player ? "none" : "traveler";
        if (id === "speech") value = player ? "q0" : "create";
        if (id === "dialogue") value = player ? "ask_information" : "answer";
        if (id.startsWith("progress_")) value = phase === "follow-up" ? "wait" : "complete";
        if (id.endsWith("request_progress")) value = "complete";
        return [id, nativeAnswer(q, id === "expression" ? 0 : value)];
      }));
    }, wire => {
      const context = directCreationContext(wire), scene = context.scene as ScenePacket | undefined;
      if (!scene) return { attempt: "回答刚才的问题", utterance: "我在看守这里。", manner: null };
      const other = scene.knownEntities.find(entity => entity.name === "附近的人")!;
      if (scene.reply) return { paragraphs: [`刚才说的是[[entity:${other.localEntityId}|站在这里的那个人]]，他的名字还没有被告知。`] };
      if (scene.speech.length) return { paragraphs: scene.speech.map(speech => `${speech.speaker === "你" ? "你" : `[[entity:${speech.speakerLocalId}|他]]`}说：[[${speech.id}]]`) };
      return { paragraphs: [`这里有[[entity:${other.localEntityId}|一个人]]。`] };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
    const repository = new MemoryWorldRepository({ [world.id]: world });
    let database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clearTimers = () => { for (const timer of timers) clearTimeout(timer); timers.clear(); };
    const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: f.gateway,
      setTimer: (callback, delay) => { const timer = setTimeout(callback, delay); timer.unref(); timers.add(timer); return timer; },
      clearTimer: timer => { clearTimeout(timer); timers.delete(timer); } });
    let host = makeHost();
    try {
      const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
      const participantId = host.instance(id).conversation!.participantId;
      const submit = async (submissionId: string, text: string) => {
        const revision = database.readInstance(id).document.state.revision;
        await host.submitAction(id, participantId, { expectedRevision: revision, submissionId, text });
        for (let i = 0; i < 200; i++) {
          const document = database.readInstance(id).document, intent = document.participantIntents.find(item => item.submissionId === submissionId);
          if (intent && !["queued", "running", "pausing"].includes(document.runs[intent.runId]!.status)) break;
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await host.drainNarratives(id);
        return database.readInstance(id).document;
      };
      const first = await submit("look", "看看周围的人");
      const introduced = participantDiscourse(first, participantId);
      expect(introduced.exchanges[0]!.paragraphs[0]!.text).toBe("这里有一个人。");
      expect(introduced.entities.some(entity => entity.surfaces.includes("一个人"))).toBe(true);
      phase = "explanation";
      const second = await submit("explain", "你说的这个人是指谁？");
      expect(second.state.truth).toEqual(first.state.truth);
      expect(second.state.history.at(-1)!.directEvent!.frames).toEqual([]);
      expect(second.narratives.at(-1)).toMatchObject({ status: "complete", source: { reply: { kind: "clarification" } } });
      expect(host.instance(id).conversation!.turns.at(-1)!.responses?.[0]?.text).toContain("名字还没有被告知");
      phase = "follow-up";
      const third = await submit("ask", '接着问他：“你在做什么？”');
      expect(third.state.history.at(-1)!.observations.find(item => item.observerId === "player")?.scene?.speech?.utterance).toBe("我在看守这里。");
      const requests = f.transport.mock.calls.map(([, init]) => directDecisionContext(JSON.parse(String(init?.body))));
      const input = requests.findLast(wire => (wire?.state as { submittedAction?: { submissionId?: string } })?.submittedAction?.submissionId === "ask");
      const shared = (input!.state as { discourse: ParticipantDiscourse }).discourse;
      expect(shared.arrival).toEqual(introduced.arrival);
      expect(shared.entities[0]!.localEntityId).toBe(introduced.entities[0]!.localEntityId);
      expect(shared.exchanges.map(exchange => exchange.submissionId)).toEqual(["look", "explain"]);
      const finalDiscourse = participantDiscourse(third, participantId), calls = f.transport.mock.calls.length;
      expect(finalDiscourse.exchanges.at(-1)!.speakers.map(speaker => speaker.utterance)).toContain("我在看守这里。");
      expect(JSON.stringify(finalDiscourse)).not.toContain("canonicalEntityIds");
      expect(replaySimulationState(third.state)).toEqual(third.state);
      clearTimers(); database.close(); database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false }); host = makeHost();
      host.instance(id); await host.drainNarratives(id);
      expect(participantDiscourse(database.readInstance(id).document, participantId)).toEqual(finalDiscourse);
      expect(f.transport).toHaveBeenCalledTimes(calls);
      await host.submitAction(id, participantId, { expectedRevision: second.state.revision, submissionId: "ask", text: '接着问他：“你在做什么？”' });
      expect(database.readInstance(id).document.state).toEqual(third.state); expect(f.transport).toHaveBeenCalledTimes(calls);
    } finally { clearTimers(); database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
