import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import type { ParticipantDiscourse } from "../../contracts/discourse";
import { contentHash } from "../../models/model-audit";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import type { ExternalActionInput, PolicyBinding } from "../../runtime/execution";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { directCreationContext, directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import type { ActionFrame } from "../contracts";
import { readDirectState } from "../state";

const historicalRequest = "先别动门闩，问守门人为什么不愿开门。";
const currentRequest = "现在检查并抬开门闩，看看是否完全打开。";
function discourse(requested = historicalRequest): ParticipantDiscourse {
  const source = { version: 1 as const, participantId: "human", agentId: "player", asOfRevision: 0,
    arrival: { id: "arrival", text: "你和守门人站在门边。" }, entities: [],
    exchanges: [{ id: "earlier-exchange", submissionId: "earlier-submission", requested,
      paragraphs: [{ id: "earlier-paragraph", worldTimeSeconds: 0, text: "守门人说：先告诉我你愿意付多少钱。", mentions: [] }],
      speakers: [{ localEntityId: "guard", label: "守门人", utterance: "先告诉我你愿意付多少钱。" }] }], unresolved: [] };
  return { ...source, hash: contentHash({ ...source, hash: "" }) };
}
interface AuthorizationView {
  originalSubmission: Omit<ExternalActionInput, "discourse"> | null;
  referenceDiscourse: ParticipantDiscourse | null;
  completedSteps: unknown[];
  deliveredSpeechSinceSubmission: unknown[];
}
interface WorldView {
  actions: ActionFrame[];
  playerAuthorization: Record<string, AuthorizationView>;
  adjudicationRules: Record<string, string>;
  adjudicationPolicy: string;
}

async function fixture(options: { decision: string; authorization?: "authorized" | "outside_scope" | "unknown";
  operation?: "use" | "speak" | "transfer"; attempt?: string; utterance?: string; outcome?: "succeeded" | "failed" } ) {
  const worldViews: WorldView[] = [];
  const f = directTestProvider(wire => {
    if (!wire.questions) {
      expect(directCreationContext(wire).chosenDirection).toBeDefined();
      return { attempt: options.attempt ?? "用手抬开门闩并查看是否完全打开。", utterance: options.utterance ?? null, manner: null };
    }
    const context = wire.state as Partial<WorldView>;
    if (context.actions) worldViews.push(context as WorldView);
    const picks: Record<string, string> = { operation: options.operation ?? "use", target: "door", recipient: "guard", tool: "none",
      resource: "spirit-stone", amount: "n3", timing: "default", speech: "none", interaction: "world_action", goal: "none",
      transfer_authority: "give", observation_scope: "target" };
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      let value = picks[id] ?? "none";
      if (id.endsWith("_outcome")) value = options.outcome ?? "succeeded";
      if (id.endsWith("_player_authorization")) value = options.authorization ?? "authorized";
      if (id.endsWith("_duration")) value = "s1";
      if (id.includes("visible")) value = "visible";
      if (id.includes("delivery")) value = "delivered";
      if (id.startsWith("progress_") || id.endsWith("_request_progress")) value = "complete";
      if (id.endsWith("_expression")) value = "existing";
      if (id.includes("goal_status") || id.includes("belief_status")) value = "unchanged";
      if (/_fact\d+$/u.test(id) && question.type === "choice") value = Object.entries(question.criteria)
        .find(([, candidate]) => (candidate as { value?: string })?.value === "open")?.[0] ?? "unchanged";
      return [id, nativeAnswer(question, id === "expression" ? 0 : value)];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
  for (const [local, canonical] of [["door", "gate"], ["guard", "keeper"]] as const) {
    world.initialState.agents.player!.belief.localEntities[local] = { id: local, name: world.initialState.truth.entities[canonical]!.name,
      description: "已见的对象", status: "observed" };
    world.initialState.agents.player!.bindings[local] = { localEntityId: local, canonicalEntityIds: [canonical] };
  }
  world.historyBaseHash = historyReplayBaseHash(world.initialState);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: options.decision, creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = { player: { kind: "external", agentId: "player", participantId: "human" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } };
  await engine.bootstrapAgents();
  const act = (rawText = currentRequest, reference = discourse()) => {
    const submission: ExternalActionInput = { submissionId: "current-submission", agentId: "player", rawText, goal: rawText,
      means: null, targetIds: [], discourse: reference };
    return { submission, result: engine.step(roster, { expectedRevision: 0, trigger: "participant_action", externalActions: [submission] }) };
  };
  return { ...f, world, engine, roster, worldViews, act };
}

function assertSeparatedSource(view: WorldView, submission: ExternalActionInput) {
  const action = view.actions.find(frame => frame.actorId === "player")!;
  const auth = view.playerAuthorization[action.id]!;
  const { discourse: reference, ...request } = submission;
  expect(auth.originalSubmission).toEqual(request);
  expect(auth.referenceDiscourse).toEqual(reference);
  expect({ ...auth.originalSubmission, discourse: auth.referenceDiscourse }).toEqual(submission);
  expect(auth.completedSteps).toEqual([]);
  expect(auth.deliveredSpeechSinceSubmission).toEqual([]);
  expect(Object.values(view.adjudicationRules).some(rule => rule.includes("originalSubmission.rawText") && rule.includes("referenceDiscourse"))).toBe(true);
}

describe("player authorization source ownership through real model HTTP and simulation", () => {
  it.each(["decision-jev", "decision-deepseek"])("separates the current physical request from a conflicting earlier request on %s", async decision => {
    const f = await fixture({ decision });
    const { submission, result: pending } = f.act();
    const result = await pending;
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(f.worldViews).toHaveLength(1);
    assertSeparatedSource(f.worldViews[0]!, submission);
    expect(result.state.truth.facts["gate-lock"]!.value).toEqual({ kind: "text", value: "open" });
    expect(result.committed.directEvent.frames).toMatchObject([{ actorId: "player", kind: "use", targetEntityId: "gate" }]);
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(f.transport).toHaveBeenCalledTimes(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it.each(["outside_scope", "unknown"] as const)("does not turn a historical quote or NPC demand into current authority: %s", async authorization => {
    const f = await fixture({ decision: "decision-deepseek", operation: "speak", authorization,
      attempt: "向守门人承诺付款和期限", utterance: "我给你三枚灵石，十分钟内付清。" });
    const { submission, result: pending } = f.act("现在只检查门闩，不报价、不承诺付款。", discourse("我愿意付三枚灵石。"));
    const result = await pending;
    assertSeparatedSource(f.worldViews[0]!, submission);
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed.directEvent.frames).toEqual([]);
    expect(result.committed.observations).toEqual([]);
    expect(readDirectState(result.state.executionState!, result.state).intents.player).toMatchObject({ status: "failed",
      failure: { recoverable: true, message: expect.stringContaining(`player authorization (${authorization})`) } });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("still rejects a concrete transfer above the current player's permission", async () => {
    const f = await fixture({ decision: "decision-jev", operation: "transfer", authorization: "outside_scope" });
    const { submission, result: pending } = f.act("把一枚灵石交给守门人；若他要三枚，先征求我同意。", discourse("付三枚灵石。"));
    const result = await pending;
    assertSeparatedSource(f.worldViews[0]!, submission);
    expect(f.worldViews[0]!.actions[0]).toMatchObject({ kind: "transfer", amount: 3, targetEntityId: "keeper" });
    expect(result.state.truth).toEqual(f.world.initialState.truth);
    expect(result.committed.operations).toEqual([]);
    expect(result.committed.observations).toEqual([]);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });

  it("does not make an authorized request physically succeed or commit an unadmitted effect", async () => {
    const f = await fixture({ decision: "decision-deepseek", outcome: "failed" });
    const { submission, result: pending } = f.act();
    const result = await pending;
    assertSeparatedSource(f.worldViews[0]!, submission);
    expect(result.committed.outcomes).toMatchObject([{ status: "failed" }]);
    expect(result.state.truth.facts["gate-lock"]).toEqual(f.world.initialState.truth.facts["gate-lock"]);
    expect(result.committed.operations.some(operation => operation.kind === "set_fact")).toBe(false);
    expect(readDirectState(result.state.executionState!, result.state).intents.player!.failure).toBeNull();
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
