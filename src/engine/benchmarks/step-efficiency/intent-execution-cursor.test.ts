import path from "node:path";
import { expect, it } from "vitest";
import type { AgentActionProposal, SimulationState } from "../../contracts/model";
import { projectAgentPerspective } from "../../cognition/agent-perspective";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { DeterministicModelProvider, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { loadWorldScript } from "../../../script/world-loader";
import { agentIntentProgramSchema, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";
import { IntentExecutionCursor } from "./intent-execution-cursor";

const provider = new DeterministicModelProvider();
const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
const attempt = (nodeId: number, text = "我观察周围，不预先断言发现。") => ({ nodeId, kind: "attempt" as const, text, targetIndices: [0] });
const program = agentIntentProgramSchema.parse({ root: 0, nodes: [
  { nodeId: 0, kind: "sequence", children: [1, 2, 3] }, attempt(1),
  { nodeId: 2, kind: "await", condition: "我察觉到回复", targetIndices: [0] },
  { nodeId: 3, kind: "if", condition: "我相信对方愿意", targetIndices: [0], thenNode: 4, elseNode: 5 },
  attempt(4, "提出交换，但不假定对方接受。"), attempt(5, "结束交谈。"),
] });
function cursor(tree = program, baseRevision = 0) {
  const rawText = INTENT_PROGRAM_PREFIX + JSON.stringify(tree);
  return new IntentExecutionCursor({ worldHash: definition.contentHash, program: tree,
    action: { id: "source-intention", actorId: "player", baseRevision, rawText, goal: rawText, means: null, targetIds: ["self"] } });
}
const perspective = (state: SimulationState) => projectAgentPerspective(state, state.agents.player!);

/** Replay policy supplies the controlled intention through the real preparation
 * boundary. This exercises the compiler, Truth Engine, committer and restart
 * validation, but does not claim autonomous cognition or host integration. */
async function prepareAttempt(execution: IntentExecutionCursor, workId: string, source = definition.initialState, model = provider) {
  const work = execution.frontier().find(work => work.workId === workId)!;
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(model), source);
  const roster = { player: { kind: "replay", agentId: "player", sourceExecutionId: "intent-cursor-fixture" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } } as const;
  const request = { expectedRevision: source.revision, trigger: "manual" as const,
    externalActions: [{ submissionId: workId, agentId: "player", rawText: work.text, goal: work.text, means: null, targetIds: work.targetIds }] };
  const preparation = await engine.prepareStep(roster, request);
  const actions = (preparation.payload as unknown as { newActions: AgentActionProposal[] }).newActions;
  expect(actions).toHaveLength(1);
  const action = execution.issue(workId, actions[0]!);
  return { action, commit: async () => {
    await engine.completePreparedStep(roster, request, preparation, []);
    for (let step = 0; step < 3; step++) {
      const after = engine.snapshot;
      if (Object.values(after.truth.activities).some(activity => activity.sourceActionId === action.id && ["completed", "failed", "blocked", "cancelled"].includes(activity.status))) return after;
      await engine.step(roster, { expectedRevision: after.revision, trigger: "manual", externalActions: [] });
    }
    throw new Error("controlled world did not settle the issued attempt");
  } };
}

it("advances only after a matching real canonical commit and resumes without duplicate dispatch", async () => {
  const execution = cursor(), initial = execution.snapshot(), first = execution.frontier()[0]!;
  expect(first.nodeId).toBe(1);
  const prepared = await prepareAttempt(execution, first.workId), action = prepared.action;
  const unissued = IntentExecutionCursor.restore(initial);
  expect(() => unissued.issue(first.workId, { ...action, targetIds: ["keeper"] })).toThrow("differs");
  expect(() => unissued.issue(first.workId, { ...action, actorId: "keeper" })).toThrow("differs");
  expect(() => execution.issue("future-node", action)).toThrow("frontier");
  expect(action.rawText).toBe(program.nodes[1]!.kind === "attempt" ? program.nodes[1]!.text : "");
  expect(action.targetIds).toEqual(["self"]);
  const restored = IntentExecutionCursor.restore(JSON.parse(JSON.stringify(execution.snapshot())));
  expect(restored.frontier()).toEqual(execution.frontier());
  expect(() => restored.issue(first.workId, action)).toThrow("unissued");
  expect(() => restored.observe(first.workId, definition.initialState)).toThrow("later committed");
  const state = await prepared.commit(), before = contentHash(state);
  expect(restored.observe(first.workId, state)).toBe(true);
  expect(contentHash(state)).toBe(before);
  expect(restored.frontier().map(work => work.nodeId)).toEqual([2]);
  expect(() => restored.observe(first.workId, state)).toThrow("frontier");
  expect(restored.snapshot().source).toEqual(initial.source);
  expect(IntentExecutionCursor.restore(restored.snapshot()).frontier()).toEqual(restored.frontier());
});

it("rejects plausible terminal labels without commit evidence, wrong owners and altered source actions", async () => {
  const execution = cursor(), work = execution.frontier()[0]!, prepared = await prepareAttempt(execution, work.workId);
  const action = prepared.action, state = await prepared.commit();
  const noHistory = structuredClone(state); noHistory.history = [];
  expect(() => execution.observe(work.workId, noHistory)).toThrow("committed transition");
  const activityId = Object.values(state.truth.activities).find(activity => activity.sourceActionId === action.id)!.id;
  for (const status of ["active", "paused", "queued", "ready"] as const) {
    const candidate = structuredClone(state);
    Object.assign(candidate.truth.activities[activityId]!, { status });
    expect(execution.observe(work.workId, candidate)).toBe(false);
    expect(execution.frontier()[0]!.nodeId).toBe(1);
  }
  const wrongOwner = structuredClone(state); wrongOwner.truth.activities[activityId]!.actorId = "keeper";
  expect(() => execution.observe(work.workId, wrongOwner)).toThrow("source differs");
  const wrongText = structuredClone(state); wrongText.truth.activities[activityId]!.sourceAction.rawText += "并偷取物品";
  expect(() => execution.observe(work.workId, wrongText)).toThrow("source differs");
  const otherWorld = structuredClone(state); otherWorld.worldHash = `sha256:${"f".repeat(64)}`;
  expect(() => execution.observe(work.workId, otherWorld)).toThrow("world revision");
});

it("keeps unknown and false waits pending, binds private decisions and preserves the unchosen branch", () => {
  const tree = agentIntentProgramSchema.parse({ root: 2, nodes: [program.nodes[2]!] });
  const execution = cursor(tree), work = execution.frontier()[0]!, state = structuredClone(definition.initialState);
  const own = perspective(state);
  expect(() => execution.guardTicket(work.workId, projectAgentPerspective(state, state.agents.keeper!))).toThrow("owning Agent");
  const ticket = execution.guardTicket(work.workId, own);
  expect(JSON.stringify(ticket)).not.toContain("canonicalEntityIds");
  expect(() => execution.resolveGuard({ ...ticket, work: { ...ticket.work, text: "different condition" } }, own, "true")).toThrow("ticket");
  execution.resolveGuard(ticket, own, "unknown");
  expect(execution.status).toBe("running");
  expect(execution.frontier()[0]!.nodeId).toBe(2);
  expect(() => execution.guardTicket(work.workId, own)).toThrow("changed private perspective");
  state.revision++;
  const newer = perspective(state);
  execution.resolveGuard(execution.guardTicket(work.workId, newer), newer, "false");
  expect(execution.status).toBe("running");
  state.revision++;
  const latest = perspective(state);
  execution.resolveGuard(execution.guardTicket(work.workId, latest), latest, "true");
  expect(execution.status).toBe("completed");
  expect(IntentExecutionCursor.restore(execution.snapshot()).status).toBe("completed");
});

it.each(["true", "false"] as const)("selects only the explicit private branch: %s", verdict => {
  const tree = agentIntentProgramSchema.parse({ root: 3, nodes: program.nodes.slice(3) });
  const execution = cursor(tree), original = execution.snapshot().source;
  const work = execution.frontier()[0]!, own = perspective(definition.initialState);
  execution.resolveGuard(execution.guardTicket(work.workId, own), own, verdict);
  expect(execution.frontier().map(work => work.nodeId)).toEqual([verdict === "true" ? 4 : 5]);
  expect(execution.snapshot().source).toEqual(original);
});

it("joins parallel work before advancing the sequence and retains completion while suspended", async () => {
  const tree = agentIntentProgramSchema.parse({ root: 0, nodes: [
    { nodeId: 0, kind: "sequence", children: [1, 4] },
    { nodeId: 1, kind: "parallel", children: [2, 3] }, attempt(2), attempt(3),
    { nodeId: 4, kind: "sequence", children: [5] }, attempt(5),
  ] });
  const execution = cursor(tree), first = execution.frontier();
  expect(first.map(work => work.nodeId)).toEqual([2, 3]);
  const a = await prepareAttempt(execution, first[1]!.workId);
  execution.suspend("external interruption");
  expect(() => execution.issue(first[0]!.workId, a.action)).toThrow("suspended");
  let state = await a.commit();
  execution.observe(first[1]!.workId, state);
  expect(execution.status).toBe("suspended");
  expect(execution.frontier().map(work => work.nodeId)).toEqual([2]);
  const restored = IntentExecutionCursor.restore(execution.snapshot()); restored.resume();
  const b = await prepareAttempt(restored, first[0]!.workId, state);
  state = await b.commit(); restored.observe(first[0]!.workId, state);
  expect(restored.frontier().map(work => work.nodeId)).toEqual([5]);
});

it("rechecks each loop iteration and never reuses its previous action identity", async () => {
  const tree = agentIntentProgramSchema.parse({ root: 0, nodes: [
    { nodeId: 0, kind: "while", condition: "我选择继续观察", targetIndices: [0], body: 1 }, attempt(1),
  ] });
  const execution = cursor(tree), firstGuard = execution.frontier()[0]!, own = perspective(definition.initialState);
  execution.resolveGuard(execution.guardTicket(firstGuard.workId, own), own, "true");
  const firstWork = execution.frontier()[0]!, a = await prepareAttempt(execution, firstWork.workId);
  const state = await a.commit(); execution.observe(firstWork.workId, state);
  const nextGuard = execution.frontier()[0]!;
  expect(nextGuard.kind).toBe("while"); expect(nextGuard.workId).not.toBe(firstGuard.workId);
  expect(() => execution.guardTicket(firstGuard.workId, perspective(state))).toThrow("frontier");
  const current = perspective(state);
  execution.resolveGuard(execution.guardTicket(nextGuard.workId, current), current, "true");
  const secondWork = execution.frontier()[0]!;
  expect(() => execution.issue(secondWork.workId, { ...a.action, baseRevision: state.revision })).toThrow("already used");
  const b = await prepareAttempt(execution, secondWork.workId, state);
  expect(b.action.id).not.toBe(a.action.id); expect(secondWork.workId).not.toBe(firstWork.workId);
  const later = await b.commit(); execution.observe(secondWork.workId, later);
  const last = execution.frontier()[0]!, lastView = perspective(later);
  execution.resolveGuard(execution.guardTicket(last.workId, lastView), lastView, "false");
  expect(execution.status).toBe("completed");
});

it("does not confuse a completed time interval with a successful action", async () => {
  const failing = new ScriptedModelProvider(request => {
    const output = deterministicModelOutput(request.profileId, request.context) as {
      kind?: string; plans?: Array<{ mode: string }>; proposal?: { outcomes: Array<{ status: string; summary: string }> };
    };
    if (output.kind === "commit_plans") for (const plan of output.plans!) plan.mode = "blocked";
    if (output.kind === "transition") for (const outcome of output.proposal!.outcomes) {
      outcome.status = "blocked";
      outcome.summary = "行动未完成，不能继续原计划的后续步骤。";
    }
    return output;
  });
  const execution = cursor(), source = execution.snapshot().source, work = execution.frontier()[0]!;
  const prepared = await prepareAttempt(execution, work.workId, definition.initialState, failing);
  const state = await prepared.commit();
  expect(Object.values(state.truth.activities).find(activity => activity.sourceActionId === prepared.action.id)?.status).toBe("completed");
  expect(state.history.at(-1)!.outcomes.find(outcome => outcome.proposalId === prepared.action.id)?.status).toBe("blocked");
  expect(execution.observe(work.workId, state)).toBe(true);
  const restored = IntentExecutionCursor.restore(execution.snapshot());
  expect(restored.status).toBe("needs-replan");
  expect(restored.frontier().map(work => work.nodeId)).toEqual([1]);
  expect(restored.snapshot().source).toEqual(source);
  expect(() => restored.issue(work.workId, { ...prepared.action, baseRevision: state.revision })).toThrow("needs-replan");
  expect(() => restored.observe(work.workId, state)).toThrow("already settled");
});

it("rejects snapshot corruption, invalid replay and nonexact producer embeddings", () => {
  const execution = cursor(), snapshot = execution.snapshot();
  const changed = structuredClone(snapshot); changed.source.action.targetIds[0] = "other";
  expect(() => IntentExecutionCursor.restore(changed)).toThrow("hash mismatch");
  const invalid = { ...snapshot, events: [{ kind: "issue", workIds: ["future-work"], revision: 0, action: snapshot.source.action }] };
  invalid.hash = contentHash({ version: invalid.version, source: invalid.source, events: invalid.events });
  expect(() => IntentExecutionCursor.restore(invalid)).toThrow("frontier");
  const ordinary = structuredClone(snapshot.source); ordinary.action.rawText = "Just look around.";
  expect(() => new IntentExecutionCursor(ordinary)).toThrow("complete producer");
  const serialized = JSON.parse(JSON.stringify(snapshot));
  expect(IntentExecutionCursor.restore(serialized).snapshot()).toEqual(snapshot);
});
