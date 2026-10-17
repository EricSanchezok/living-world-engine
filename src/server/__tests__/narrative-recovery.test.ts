import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer, directCreationContext } from "../../engine/testing/direct-provider";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { contentHash } from "../../engine/models/model-audit";
import { validateWorldInstanceDocument } from "../world-instance-store";
import type { ScenePacket } from "../narrative/contracts";

const request = "等六十秒再问问检查员今晚最晚几点交货。";
const order = "请按约定付款，到账后告诉我。";
const qualifier = "检查员已经说出付款要求；这只是已送达的话，还不能确认到账。";
const pending = "六十秒已经等过了。你询问最晚交货时间的这一步未能执行，目前还没有这个问题的答复。";

describe("recovery receipt provenance through persisted publication", () => {
  it.each([false, true])("retains independent speech and its payment limit after a player failure; reject unsupported knowledge: %s", async rejectKnowledge => {
    const root = mkdtempSync(path.join(tmpdir(), "lwe-recovery-provenance-"));
    const scenes: Record<string, unknown>[] = [], checks: Record<string, unknown>[] = [];
    let inspectorReadings = 0, recoveryDrafts = 0;
    const f = directTestProvider(wire => {
      const context = wire.state as { perspective?: { agentId: string }; submittedAction?: { rawText: string }; paragraphs?: string[]; currentRequestReceipts?: unknown[] };
      const firstWait = Boolean(wire.questions.operation && context.submittedAction?.rawText === request && !context.currentRequestReceipts?.length);
      if (wire.questions.operation && context.submittedAction?.rawText === request && !firstWait) return new Response("unavailable", { status: 401 });
      const initialInspector = Boolean(wire.questions.operation && context.perspective?.agentId === "inspector" && inspectorReadings++ === 0);
      if (context.paragraphs) checks.push(wire.state as Record<string, unknown>);
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
        let choice = id.includes("outcome") ? "succeeded" : id.includes("delivery") ? "delivered" :
          id.includes("visible") || id.includes("entity") ? "visible" : id.includes("status") || id.includes("fact") ? "unchanged" :
          id.includes("progress") ? "complete" : "none";
        if (id === "operation") choice = initialInspector ? "speak" : "wait";
        if (id === "duration" && firstWait) choice = "d0";
        if (id === "progress_next" && firstWait) choice = "continue";
        if (id === "recipient") choice = "repair";
        if (id === "speech") choice = initialInspector ? "create" : "none";
        if (id.startsWith("paragraph")) choice = id.endsWith("_evidence") && context.paragraphs?.some(text => text.includes("检查员不知道")) ? "added_content" : "grounded";
        return [id, nativeAnswer(question, id === "expression" ? 0 : choice)];
      }));
    }, wire => {
      const context = directCreationContext(wire);
      if (context.scene) {
        const scene = context.scene as ScenePacket;
        if (scene.reply) {
          scenes.push(context);
          recoveryDrafts++;
          return { paragraphs: rejectKnowledge && recoveryDrafts === 1
            ? ["检查员不知道今晚最晚的交货时间。"] : [qualifier, pending] };
        }
        return { paragraphs: scene.speech.map(speech => `[[${speech.id}]]`) };
      }
      return { attempt: "说明结算要求", utterance: order, manner: null };
    });
    await f.registry.capture();
    const world = loadWorldScript(path.resolve("test/fixtures/station-program-world"), { seed: 1, modelCatalog: f.catalog });
    const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
    try {
      const host = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      const instance = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
      const id = instance.summary.id;
      await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "engineer" } });
      const participant = Object.values(database.readInstance(id).document.participants)[0]!;
      await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "failed-question", text: request });
      await expect.poll(() => Object.values(database.readInstance(id).document.runs).some(run => run.status === "failed")).toBe(true);
      await host.drainNarratives(id);
      const saved = database.readInstance(id).document;
      const frames = saved.state.history.flatMap(step => step.directEvent?.frames ?? []);
      expect(frames.map(frame => ({ actor: frame.actorId, submission: frame.submissionId, cause: frame.causeActionId, kind: frame.kind })))
        .toEqual(expect.arrayContaining([{ actor: "inspector", submission: null, cause: null, kind: "speak" },
          { actor: "engineer", submission: "failed-question", cause: null, kind: "wait" }]));
      expect(saved.state.truth.elapsedSeconds).toBe(60);
      expect(saved.state.truth.quantities).toEqual(world.initialState.truth.quantities);
      const recovery = saved.narratives.find(beat => beat.source.reply?.kind === "recovery")!;
      expect(recovery.status).toBe("complete");
      expect(recovery.source).toMatchObject({ priorObservedReceipts: expect.arrayContaining([expect.objectContaining({ requestRelation: "concurrent_event",
        scene: expect.objectContaining({ actionKind: "speak", speech: expect.objectContaining({ utterance: order }) }) })]) });
      const task = scenes[0]!.publicationTask as { executionBoundary: { earlierObservedEvents: unknown[] } };
      expect(task.executionBoundary.earlierObservedEvents).toEqual(expect.arrayContaining([expect.objectContaining({ requestRelation: "concurrent_event",
        actor: expect.any(String), actorLocalId: expect.any(String), operation: "speak", status: "succeeded", actualResult: null,
        deliveredSpeech: expect.objectContaining({ utterance: order }) })]));
      expect(task.executionBoundary).not.toHaveProperty("earlierCommittedSteps");
      expect(task.executionBoundary.earlierObservedEvents).toEqual(expect.arrayContaining([expect.objectContaining({
        requestRelation: "participant_step", actor: "你", operation: "wait", action: expect.objectContaining({ durationSeconds: 60 }) })]));
      const groundingTask = checks.find(check => (check.publicationTask as { kind: string }).kind === "recovery")!.publicationTask;
      expect(groundingTask).toEqual(scenes[0]!.publicationTask);
      expect(JSON.stringify(task.executionBoundary)).not.toContain(frames[0]!.id);
      expect(JSON.stringify(task.executionBoundary)).not.toContain('"inspector"');
      const finalText = host.instance(id).conversation!.turns.flatMap(turn => turn.responses?.map(response => response.text) ?? []).join("\n");
      expect(finalText).toContain(qualifier);
      expect(finalText).toContain(pending);
      expect(finalText).not.toContain("检查员不知道");
      expect(recovery.attempts).toBe(rejectKnowledge ? 2 : 1);
      expect(recovery.grounding.flatMap(check => check.choices)).toContain("grounded");
      if (rejectKnowledge) expect(recovery.grounding.flatMap(check => check.choices)).toContain("added_content");
      const malformed = structuredClone(saved);
      const badBeat = malformed.narratives.find(beat => beat.source.reply?.kind === "recovery")!;
      delete (badBeat.source.priorObservedReceipts![0] as { requestRelation?: string }).requestRelation;
      badBeat.sourceHash = contentHash(badBeat.source);
      expect(() => validateWorldInstanceDocument(malformed)).toThrow("invalid persisted narrative beat");
      expect(replaySimulationState(saved.state)).toEqual(saved.state);
      const calls = f.transport.mock.calls.length;
      const restarted = new WorldHost({ repository: new MemoryWorldRepository({ [world.id]: world }), store: database, ledger: database, provider: f.gateway });
      expect(restarted.instance(id).conversation).toEqual(host.instance(id).conversation);
      await restarted.drainNarratives(id);
      expect(f.transport).toHaveBeenCalledTimes(calls);
    } finally { database.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
