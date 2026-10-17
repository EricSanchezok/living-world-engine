import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SimulationState, WorldFact } from "../../engine/contracts/model";
import type { ActionFrame } from "../../engine/direct/contracts";
import type { PrivateInteraction } from "../../engine/direct/views";
import { ModelGateway } from "../../engine/models/model-gateway";
import { parseModelCatalog } from "../../engine/models/model-catalog";
import { replaySimulationState } from "../../engine/runtime/transaction";
import { directCreationContext, directTestProvider, nativeAnswer } from "../../engine/testing/direct-provider";
import { createTestModelRegistry } from "../../engine/testing/model-provider";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { LocalDatabase } from "../local-database";
import { WorldHost } from "../world-host";

const payment = "项目账户，给艾达支付6000欧元，采购首批6台控制器，记在项目采购上。";
const delivery = "艾达，首批6000欧元已经到账，请现在把这6台控制器交给我，放在公司的收货柜里，由我代公司保管。";
const unapprovedPayment = "项目账户，给艾达支付12000欧元采购控制器。我还没有取得米娜对这笔超额付款的批准。";
const paymentRefusal = "这笔12000欧元没有转出。单笔超过10000欧元，需要先取得米娜的确认。";

type ReadingContext = { submittedAction?: { rawText: string }; perspective?: {
  agentId: string; respondingTo: string | null; interactions: PrivateInteraction[];
}; actions?: ActionFrame[]; facts?: WorldFact[]; playerAuthorization?: Record<string, {
  originalSubmission: { rawText: string } | null; referenceDiscourse: unknown;
}> };

function quantities(state: SimulationState, holderId: string, definitionId = "eurodollar") {
  return Object.values(state.truth.quantities).filter(item => item.holderId === holderId && item.definitionId === definitionId)
    .reduce((sum, item) => sum + item.amount, 0);
}
function frames(state: SimulationState) { return state.history.flatMap(step => step.directEvent?.frames ?? []); }
function transfers(state: SimulationState) {
  return state.history.flatMap(step => step.operations).filter(operation => operation.kind === "transfer_quantity");
}

// Only the costly model boundary is scripted. Authority limits are world semantics, not a
// hard-coded numeric payment ACL: these tests check the supplied rule/evidence and the
// real Host/Direct/kernel effects of its verdict, not a model's semantic accuracy.
async function companyFixture() {
  const adjudicated: Array<{ actor: string; kind: string; amount: number | null; verdict: string }> = [];
  const f = directTestProvider(wire => {
    const context = wire.state as ReadingContext;
    const self = context.perspective?.agentId;
    const interactions = context.perspective?.interactions ?? [];
    const responding = interactions.find(item => item.id === context.perspective?.respondingTo);
    const addressed = responding?.relation === "addressed_to_self";
    const request = context.submittedAction?.rawText;
    const previousTransfer = interactions.findLast(item => item.relation === "self" && item.operation === "transfer");
    const handlingPayment = self === "lead-budget" && addressed && [payment, unapprovedPayment].includes(responding?.utterance ?? "");
    const handlingDelivery = self === "ada" && addressed && responding?.utterance === delivery;
    const operation = self === "lead" && request ? "speak"
      : handlingPayment ? previousTransfer ? previousTransfer.status === "failed" ? "speak" : "wait" : "transfer"
        : handlingDelivery && !previousTransfer ? "transfer" : "wait";
    const amount = handlingDelivery ? 6 : responding?.utterance === unapprovedPayment ? 12000 : 6000;
    for (const action of context.actions ?? []) {
      if (action.submissionId) {
        expect(context.playerAuthorization?.[action.id]?.originalSubmission?.rawText).toBe(action.utterance);
      }
      if (action.actorId === "lead-budget" && action.kind === "transfer") {
        const mandate = context.facts?.find(fact => fact.subjectId === "lead-budget" && fact.predicate === "spending-mandate");
        expect(mandate?.value).toEqual({ kind: "text", value: expect.stringContaining("10000") });
        expect(mandate?.value).toEqual({ kind: "text", value: expect.stringContaining("米娜确认") });
        expect(action).toMatchObject({ targetEntityId: "ada", quantityDefinitionId: "eurodollar" });
      }
      adjudicated.push({ actor: action.actorId, kind: action.kind, amount: action.amount,
        verdict: action.actorId === "lead-budget" && action.amount === 12000 ? "failed" : "succeeded" });
    }
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      const index = /^a(\d+)_/u.exec(id)?.[1];
      const action = index === undefined ? undefined : context.actions?.[Number(index)];
      let choice = "none";
      if (id.startsWith("paragraph")) choice = "grounded";
      if (id === "operation") choice = operation;
      if (id === "recipient") choice = self === "lead" ? request === delivery ? "known-ada" : "known-lead-budget"
        : operation === "transfer" && self === "lead-budget" ? "known-ada" : "known-lead";
      if (id === "resource") choice = operation === "transfer" ? handlingDelivery ? "control-unit" : "eurodollar" : "none";
      if (id === "amount" || id.startsWith("resource_amount_")) choice = operation === "transfer" ? `n${amount}` : "unknown";
      if (id === "speech") choice = "create";
      if (id === "timing") choice = "default";
      if (id === "transfer_authority") choice = "request";
      if (id.startsWith("progress_") || id.endsWith("_request_progress")) choice = action?.actorId === "lead-budget" && action.amount === 12000 ? "continue" : "complete";
      if (id.endsWith("_player_authorization")) choice = "authorized";
      if (id.endsWith("_outcome")) choice = action?.actorId === "lead-budget" && action.amount === 12000 ? "failed" : "succeeded";
      if (id.endsWith("_duration")) choice = "s30";
      if (id.includes("_delivery")) choice = "delivered";
      if (id.includes("_visible") || id.includes("_entity")) choice = "hidden";
      if (id.includes("_fact") || id.endsWith("_expression")) choice = "unchanged";
      return [id, nativeAnswer(question, id === "expression" ? 0 : choice)];
    }));
  }, wire => {
    const context = directCreationContext(wire);
    if (context.scene) {
      const speech = (context.scene as { speech: Array<{ id: string; speaker: string }> }).speech;
      return { paragraphs: speech.length ? speech.map(item => `${item.speaker}说：[[${item.id}]]`) : ["现场交易的结果已经记录。"] };
    }
    if (!context.playerControlled) {
      const perspective = context.perspective as NonNullable<ReadingContext["perspective"]>;
      expect(perspective.agentId).toBe("lead-budget");
      expect(perspective.interactions).toContainEqual(expect.objectContaining({ relation: "self", operation: "transfer", status: "failed" }));
      return { attempt: "说明本次转账失败及所缺的批准", utterance: paymentRefusal, manner: null };
    }
    return { attempt: String(context.currentPlayerRequest), utterance: String(context.currentPlayerRequest), manner: null };
  });
  // Keep the author's profile names; route them to deterministic HTTP fixtures.
  const snapshot = f.catalog.snapshot();
  snapshot.profiles["decision-deepseek-long"] = { ...snapshot.profiles["decision-deepseek"]! };
  const catalog = parseModelCatalog(snapshot), registry = createTestModelRegistry(catalog);
  await registry.capture();
  const gateway = new ModelGateway(catalog, { TYPESAFE_API_KEY: "test-private-key", TEST_MODEL_API_KEY: "test-private-key" },
    { registry, fetch: f.transport, maxTransportAttempts: 1 });
  const world = loadWorldScript(path.resolve("worlds/cyberpunk2077/world"), { seed: 1, modelCatalog: catalog });
  const root = mkdtempSync(path.join(tmpdir(), "lwe-company-settlement-"));
  const database = new LocalDatabase(path.join(root, "world.sqlite"), { heartbeat: false });
  const repository = new MemoryWorldRepository({ [world.id]: world });
  const makeHost = () => new WorldHost({ repository, store: database, ledger: database, provider: gateway });
  const host = makeHost();
  const created = await host.createInstance({ worldId: world.id, start: { kind: "observer" } }), id = created.summary.id;
  await host.transferControl(id, { expectedRevision: 0, target: { kind: "agent", agentId: "lead" } });
  const participant = Object.values(database.readInstance(id).document.participants)[0]!;
  const read = () => database.readInstance(id).document;
  const submit = async (submissionId: string, text: string) => {
    await host.submitAction(id, participant.id, { expectedRevision: read().state.revision, submissionId, text });
    await expect.poll(() => {
      const document = read(), intent = document.participantIntents.find(item => item.submissionId === submissionId);
      return intent ? document.runs[intent.runId]?.status : null;
    }, { timeout: 30_000, interval: 25 }).toBe("completed");
    await host.drainNarratives(id);
    return read().state;
  };
  return { makeHost, id, participant, read, submit, adjudicated, transport: f.transport,
    close: () => { database.close(); rmSync(root, { recursive: true, force: true }); } };
}

describe("current Cyberpunk company purchase through persistent WorldHost", () => {
  it("pays 6000 from the company, delivers six existing controllers and deduplicates the durable submission", async () => {
    const f = await companyFixture();
    try {
      const initial = f.read().state;
      expect([quantities(initial, "lead-budget"), quantities(initial, "ada"), quantities(initial, "lead")]).toEqual([48000, 1200, 9000]);
      expect([quantities(initial, "ada", "control-unit"), quantities(initial, "lead", "control-unit")]).toEqual([6, 0]);
      const paid = await f.submit("company-6000", payment);
      expect([quantities(paid, "lead-budget"), quantities(paid, "ada"), quantities(paid, "lead")]).toEqual([42000, 7200, 9000]);
      expect(transfers(paid)).toMatchObject([{ definitionId: "eurodollar", fromHolderId: "lead-budget", toHolderId: "ada", amount: 6000 }]);
      const request = frames(paid).find(frame => frame.submissionId === "company-6000")!;
      expect(frames(paid).filter(frame => frame.kind === "transfer")).toMatchObject([{ actorId: "lead-budget", causeActionId: request.id }]);
      expect([quantities(paid, "ada", "control-unit"), quantities(paid, "lead", "control-unit")]).toEqual([6, 0]);

      const received = await f.submit("company-receive", delivery);
      expect([quantities(received, "lead-budget"), quantities(received, "ada"), quantities(received, "lead")]).toEqual([42000, 7200, 9000]);
      expect([quantities(received, "ada", "control-unit"), quantities(received, "lead", "control-unit")]).toEqual([0, 6]);
      expect(transfers(received)).toMatchObject([
        { definitionId: "eurodollar", fromHolderId: "lead-budget", toHolderId: "ada", amount: 6000 },
        { definitionId: "control-unit", fromHolderId: "ada", toHolderId: "lead", amount: 6 },
      ]);
      expect(Object.values(received.truth.facts).filter(fact => fact.subjectId === "lead-received-stock" && ["owner", "custodian"].includes(fact.predicate)))
        .toEqual(Object.values(initial.truth.facts).filter(fact => fact.subjectId === "lead-received-stock" && ["owner", "custodian"].includes(fact.predicate)));
      expect(replaySimulationState(received)).toEqual(received);

      const calls = f.transport.mock.calls.length, saved = f.read();
      // Retry through a new Host against the same durable submission, even with its old revision.
      const restarted = f.makeHost();
      await restarted.submitAction(f.id, f.participant.id, { expectedRevision: 0, submissionId: "company-6000", text: payment });
      await restarted.drainNarratives(f.id);
      expect(f.read().state).toEqual(received);
      expect(f.read().participantIntents).toEqual(saved.participantIntents);
      expect(f.read().runs).toEqual(saved.runs);
      expect(f.transport.mock.calls.length).toBe(calls);
    } finally { f.close(); }
  }, 120_000);

  it("does not commit a proposed 12000 payment after the world rejects its missing approval", async () => {
    const f = await companyFixture();
    try {
      const initial = f.read().state;
      expect(quantities(initial, "lead-budget")).toBeGreaterThan(12000);
      const rejected = await f.submit("company-12000-unapproved", unapprovedPayment);
      // The NPC really proposes a transfer: a spoken refusal alone would not exercise settlement.
      const attempted = frames(rejected).find(frame => frame.actorId === "lead-budget" && frame.kind === "transfer");
      expect(attempted).toMatchObject({ targetEntityId: "ada", quantityDefinitionId: "eurodollar", amount: 12000 });
      expect(rejected.history.flatMap(step => step.outcomes).find(outcome => outcome.proposalId === attempted!.id)?.status).toBe("failed");
      expect(f.adjudicated).toContainEqual({ actor: "lead-budget", kind: "transfer", amount: 12000, verdict: "failed" });
      expect(transfers(rejected)).toEqual([]);
      expect(rejected.truth.quantities).toEqual(initial.truth.quantities);
      expect(rejected.truth.facts).toEqual(initial.truth.facts);
      expect(frames(rejected).some(frame => frame.actorId === "mina" && frame.kind !== "wait")).toBe(false);
      expect(frames(rejected).find(frame => frame.submissionId === "company-12000-unapproved"))
        .toMatchObject({ actorId: "lead", kind: "speak", targetEntityId: "lead-budget", utterance: unapprovedPayment });
      expect(rejected.history.flatMap(step => step.observations).some(observation => observation.observerId === "lead-budget" &&
        observation.scene?.actionKind === "transfer" && observation.scene.status === "failed")).toBe(true);
      const request = frames(rejected).find(frame => frame.submissionId === "company-12000-unapproved")!;
      expect(frames(rejected).filter(frame => frame.actorId === "lead-budget" && frame.kind === "speak"))
        .toMatchObject([{ utterance: paymentRefusal, causeActionId: request.id }]);
      expect(rejected.history.flatMap(step => step.observations)).toContainEqual(expect.objectContaining({ observerId: "lead",
        scene: expect.objectContaining({ speech: expect.objectContaining({ utterance: paymentRefusal }) }) }));
      expect(replaySimulationState(rejected)).toEqual(rejected);
    } finally { f.close(); }
  }, 120_000);
});
