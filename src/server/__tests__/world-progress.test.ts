import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { directTestProvider, nativeAnswer } from "../../engine/testing/direct-provider";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";
import { WorldProgress } from "../world-progress";

it("publishes real execution and reply stages without extra inference, persistent state, or stale progress", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "lwe-live-progress-"));
  const phases = ["interpreting", "resolving", "composing", "verifying"] as const;
  const started = new Set<string>();
  const gates = Object.fromEntries(phases.map(phase => {
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    return [phase, { wait, release }];
  })) as Record<typeof phases[number], { wait: Promise<void>; release: () => void }>;
  const hold = async (phase: typeof phases[number]) => { started.add(phase); await gates[phase].wait; };
  const f = directTestProvider(async wire => {
    if ("operation" in wire.questions) await hold("interpreting");
    else if (Object.keys(wire.questions).some(key => key.startsWith("paragraph"))) await hold("verifying");
    else if (Object.keys(wire.questions).some(key => key.endsWith("_outcome"))) await hold("resolving");
    return Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q,
      id === "expression" ? 0 : id.startsWith("paragraph") ? "grounded" : id === "operation" ? "observe" :
        id === "target" ? "self" : id.includes("outcome") ? "succeeded" : "none")]));
  }, async () => { await hold("composing"); return { paragraphs: ["石门仍在眼前。"] }; });
  await f.registry.capture();
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const repository = new MemoryWorldRepository({ [world.id]: world });
  const host = new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
  let unsubscribe = () => {};
  try {
    const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } });
    const id = created.summary.id;
    // Arrival can fall back without waiting on a reply-generation latch.
    gates.composing.release();
    await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "player" } });
    let release!: () => void;
    gates.composing = { wait: new Promise<void>(resolve => { release = resolve; }), release: () => release() };
    started.clear();
    const initial = database.readInstance(id);
    const participant = Object.values(initial.document.participants)[0]!;
    const calls = f.transport.mock.calls.length;
    const changes: Array<string | null> = [];
    unsubscribe = host.subscribeInstanceChanges(id, () => changes.push(host.instance(id).progress?.stage ?? null));
    await host.submitAction(id, participant.id, { expectedRevision: 0, submissionId: "live-progress", text: "观察四周" });
    for (const phase of phases) {
      await expect.poll(() => started.has(phase)).toBe(true);
      const detail = host.instance(id);
      expect(detail.progress).toMatchObject({ stage: phase });
      expect(Object.keys(detail.progress!).sort()).toEqual(["stage", "startedAt"]);
      const before = database.readInstance(id), count = f.transport.mock.calls.length;
      expect(host.instance(id).progress).toEqual(detail.progress);
      expect(host.instance(id).progress).toEqual(detail.progress);
      expect(f.transport.mock.calls).toHaveLength(count);
      expect(database.readInstance(id)).toEqual(before);
      if (phase === "interpreting" || phase === "resolving") expect(before.document.state).toEqual(initial.document.state);
      if (phase === "composing" || phase === "verifying") {
        expect(detail.run?.status).not.toMatch(/^(queued|running|pausing)$/);
        expect(detail.conversation?.turns.at(-1)?.status).toBe("running");
      }
      gates[phase].release();
    }
    await host.drainNarratives(id);
    expect(host.instance(id).progress).toBeNull();
    expect(host.instance(id).conversation?.turns.at(-1)?.status).toBe("committed");
    expect(changes).toEqual(expect.arrayContaining([...phases, "settling", "checking", "saving", null]));
    expect(f.transport.mock.calls.length - calls).toBe(4);

    const saved = database.readInstance(id).document;
    const run = Object.values(saved.runs)[0]!;
    const tracker = new WorldProgress(() => new Date(), () => {});
    const work = tracker.start(id, { kind: "run", runId: run.id, generation: run.generation, revision: saved.state.revision }, "interpreting");
    expect(tracker.project(saved, run, participant.id)).toBeNull();
    expect(tracker.project(saved, { ...run, status: "running" }, participant.id)?.stage).toBe("interpreting");
    expect(tracker.project(saved, { ...run, status: "running", generation: run.generation + 1 }, participant.id)?.stage).toBe("preparing");
    work.finish(); work.stage("direct-adjudication");
    expect(tracker.project(saved, { ...run, status: "running" }, participant.id)?.stage).toBe("preparing");
    const pending = structuredClone(saved);
    pending.narratives[0]!.status = "generating";
    const reply = tracker.start(id, { kind: "reply", beatId: pending.narratives[0]!.id, participantId: participant.id }, "verifying");
    expect(tracker.project(pending, run, participant.id)?.stage).toBe("verifying");
    expect(tracker.project(pending, run, "another-participant")).toBeNull();
    reply.finish();
    expect(tracker.project(pending, run, participant.id)?.stage).toBe("reply-pending");
    const restored = new WorldHost({ repository, store: database, ledger: database, provider: f.gateway });
    expect(restored.instance(id).progress).toBeNull();
    expect(f.transport.mock.calls.length - calls).toBe(4);
  } finally {
    unsubscribe();
    for (const gate of Object.values(gates)) gate.release();
    database.close(); rmSync(root, { recursive: true, force: true });
  }
});
