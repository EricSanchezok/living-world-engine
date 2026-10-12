import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { decisionQuestionIds, decisionTestProvider } from "../../testing/decision-provider";
import { contentHash } from "../../models/model-audit";
import { DecisionRuntime } from "../../programs/decision-runtime";
import { quantityId, runtimeId } from "../../runtime/runtime-id";
import { admitWorldProgram, type WorldProgramDefinition } from "../world-program";
import { adjudicateWorldPrograms, type BoundWorldProgram } from "../adjudication";
import { worldProgramSources, worldResources } from "../resources";
import { commitWorldEvent, createWorldEventCandidate } from "../kernel";
import { compileWorldProgram } from "../compiler";
import { WorldProgramLibrary } from "../library";

function fixture() {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: createTestModelCatalog() });
  const state = structuredClone(definition.initialState), sources = worldProgramSources(definition, state), resources = worldResources(state, definition);
  const from = `quantity:${quantityId(state.worldHash, "spirit-stone", "player")}`;
  const to = `quantity:${quantityId(state.worldHash, "spirit-stone", "keeper")}`;
  const raw: WorldProgramDefinition = { version: 1, namespace: "world", id: "voluntary-gift", description: "Transfer the actor's offered stones to a nearby recipient.",
    sourceIds: ["world", "law:no-free-spirit-stones"], parameters: { actor: { kind: "entity", description: "Giver" }, recipient: { kind: "entity", description: "Recipient" }, amount: { kind: "number", description: "Offered amount" } },
    reads: ["entity:{actor}", "entity:{recipient}", "placement:{actor}", "placement:{recipient}", from, to], writes: ["quantities"],
    durationSeconds: { kind: "literal", value: 5 },
    predicates: [{ id: "authorized", description: "The actor voluntarily offers their own stones to this reachable recipient.", reads: ["placement:{actor}", "placement:{recipient}"], sourceIds: ["world"],
      test: { kind: "semantic", instructions: "Check the actual offer and reach. Do not fabricate acceptance or an exchange promised in return." }, unknown: "wait" }],
    branches: [{ id: "give", when: [{ predicateId: "authorized", equals: "yes" }], outcome: "succeeded", description: "A voluntary transfer occurs.",
      effects: [{ kind: "transfer_quantity", fields: {
        definitionId: "spirit-stone",
        fromHolderId: { $expression: { kind: "parameter", name: "actor" } },
        toHolderId: { $expression: { kind: "parameter", name: "recipient" } },
        amount: { $expression: { kind: "parameter", name: "amount" } },
      } }], deliveries: [] }],
  };
  const program = admitWorldProgram(raw, sources);
  const bound: BoundWorldProgram = { program, parameters: { actor: "player", recipient: "keeper", amount: 2 }, attempt: {
    id: runtimeId({ worldHash: state.worldHash, revision: 0, kind: "action", stage: "program", owner: "player", round: 0, ordinal: 0 }),
    actorId: "player", actorEntityId: "player", intent: "Give the keeper two of my stones as a gift.", utterance: null, targetEntityIds: ["keeper"], startedAtSeconds: 0,
    program: { instanceId: "gift-1", workId: contentHash("work"), requestHash: contentHash("request") },
  } };
  return { definition, state, sources, resources, raw, bound, from, to };
}
async function adjudicate(f: ReturnType<typeof fixture>, programs = [f.bound], answer?: (id: string) => string) {
  const configured = decisionTestProvider(answer ? body => {
    return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: answer(id) }])) };
  } : undefined);
  const registry = await configured.registry.capture(); let ordinal = 0;
  const result = await adjudicateWorldPrograms(new DecisionRuntime(configured.gateway), programs, f.resources, f.sources, {
    profileId: "world-test", workloadId: "world-event-test", batchId: "world-event-test", modelRegistrySnapshotHash: registry.hash,
    runtimeIdentity: { worldHash: f.state.worldHash, revision: f.state.revision }, nextInvocation: () => ++ordinal,
  });
  return { result, configured };
}

describe("source-bound world event kernel", () => {
  it("compiles through real gateway validation with one repair and no private cognition in the world prompt", async () => {
    const f = fixture();
    const configured = decisionTestProvider((body, attempt) => {
      expect(JSON.stringify(body)).not.toContain(f.state.agents.keeper!.character.persona.summary);
      if (attempt === 2) expect(JSON.stringify(body)).toContain("world compiler changed the action owner");
      return { definition: f.raw, parameters: { ...f.bound.parameters, actor: attempt === 1 ? "keeper" : "player" } };
    });
    const result = await compileWorldProgram(configured.gateway, { workloadId: "world-compile", batchId: "world-compile", profileId: "world-test", invocationBase: 1,
      definition: f.definition, state: f.state, resources: f.resources, attempt: f.bound.attempt, reason: "new-intent",
      runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 } });
    expect(result.status).toBe("ready"); expect(configured.transport).toHaveBeenCalledTimes(2);
    expect(result.audit?.invocations.map(invocation => invocation.outputDisposition)).toEqual(["rejected", "llm-repaired"]);
    if (result.status === "ready") {
      expect(result.bound).toEqual(f.bound);
      const library = new WorldProgramLibrary(); library.add(result);
      const restarted = new WorldProgramLibrary(library.snapshot()), repeated = { ...f.bound.attempt, id: "different-attempt", startedAtSeconds: 20 };
      expect(restarted.lookup(repeated, f.sources, new Set(Object.keys(f.state.truth.entities)), f.resources)?.attempt).toEqual(repeated);
      expect(restarted.lookup(repeated, { ...f.sources, world: "changed sources" }, new Set(Object.keys(f.state.truth.entities)), f.resources)).toBeNull();
    }
  });
  it("retains an unsupported world program as a recoverable compilation failure", async () => {
    const f = fixture(), configured = decisionTestProvider(() => ({ definition: { ...f.raw, sourceIds: ["invented-law"] }, parameters: f.bound.parameters }));
    const result = await compileWorldProgram(configured.gateway, { workloadId: "world-compile", batchId: "world-compile", profileId: "world-test", invocationBase: 1,
      definition: f.definition, state: f.state, resources: f.resources, attempt: f.bound.attempt, reason: "new-intent",
      runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 } });
    expect(result).toMatchObject({ status: "failed", recoverable: true }); expect(configured.transport).toHaveBeenCalledTimes(2);
    expect(f.state.step).toBe(0);
  });
  it("executes a declared transfer through gateway decisions and commits exactly once", async () => {
    const f = fixture(), { result, configured } = await adjudicate(f);
    expect(configured.transport).toHaveBeenCalledTimes(1);
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    const options = { earliestPendingSeconds: 5, receipts: new Map() };
    const committed = commitWorldEvent(f.state, f.definition, f.resources, candidate, options);
    expect(committed.state.truth.quantities[quantityId(f.state.worldHash, "spirit-stone", "player")]!.amount).toBe(1);
    expect(committed.state.truth.quantities[quantityId(f.state.worldHash, "spirit-stone", "keeper")]!.amount).toBe(22);
    expect(f.state.truth.elapsedSeconds).toBe(0); expect(committed.state.truth.elapsedSeconds).toBe(5);
    expect(committed.receipt.programReceipts[0]).toMatchObject({ status: "succeeded", madeProgress: true, instanceId: "gift-1" });
    const again = commitWorldEvent(committed.state, f.definition, committed.resources, candidate,
      { ...options, receipts: new Map([[candidate.id, committed.receipt]]) });
    expect(again.replayed).toBe(true); expect(again.state).toEqual(committed.state);
    const replay = commitWorldEvent(f.state, f.definition, f.resources, JSON.parse(JSON.stringify(candidate)), options);
    expect(replay.receipt).toEqual(committed.receipt); expect(replay.state).toEqual(committed.state);
  });
  it("preserves independent preparation and rejects changes to actual inputs", async () => {
    const f = fixture(), { result } = await adjudicate(f);
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    const unrelated = structuredClone(f.state); unrelated.truth.entities.gate!.description += " Weathered.";
    expect(commitWorldEvent(unrelated, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() }).receipt.step).toBe(1);
    const changed = structuredClone(f.state); changed.truth.quantities[quantityId(f.state.worldHash, "spirit-stone", "player")]!.amount = 1;
    expect(() => commitWorldEvent(changed, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() })).toThrow("stale world read");
    expect(() => commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 3, receipts: new Map() })).toThrow("earlier world event");
  });
  it("rejects edited effects, substituted decision evidence, missing sources, and unowned targets", async () => {
    const f = fixture(), { result } = await adjudicate(f);
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    const edited = structuredClone(candidate); (edited.effects[0] as { amount: number }).amount = 1;
    const body = Object.fromEntries(Object.entries(edited).filter(([key]) => key !== "id")); edited.id = contentHash(body);
    expect(() => commitWorldEvent(f.state, f.definition, f.resources, edited, { earliestPendingSeconds: 5, receipts: new Map() })).toThrow("effects differ");
    const falsified = structuredClone(result); falsified.records[0]!.verdict = "no";
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], falsified, 5)).toThrow("condition does not match");
    const modifiedAnswer = structuredClone(result), evidence = modifiedAnswer.evidence[0]!, oldHash = evidence.hash;
    evidence.result.answers.q0!.choice = "no"; evidence.hash = contentHash({ batch: evidence.batch, result: evidence.result });
    for (const record of modifiedAnswer.records) if (record.evidenceHash === oldHash) { record.evidenceHash = evidence.hash; if (record.questionId === "q0") record.verdict = "no"; }
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], modifiedAnswer, 5)).toThrow("recorded model output");
    expect(() => admitWorldProgram({ ...f.raw, sourceIds: ["invented-law"] }, f.sources)).toThrow("unknown world program source");
    const impersonated = structuredClone(f.bound); impersonated.parameters.actor = "keeper";
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [impersonated], result, 5)).toThrow("ownership");
  });
  it("keeps unknown evidence out of state and atomically rolls back resource competition", async () => {
    const f = fixture(), { result } = await adjudicate(f, [f.bound], id => id === "q0" ? "unknown" : "yes");
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5)).toThrow("awaits evidence");
    const second = structuredClone(f.bound); second.attempt.id = runtimeId({ worldHash: f.state.worldHash, revision: 0, kind: "action", stage: "program", owner: "player", round: 0, ordinal: 1 });
    const joint = await adjudicate(f, [f.bound, second]);
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound, second], joint.result, 5);
    expect(() => commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() })).toThrow("insufficient quantity");
    expect(f.state.truth.quantities[quantityId(f.state.worldHash, "spirit-stone", "player")]!.amount).toBe(3);
    expect(f.state.step).toBe(0);
  });
  it("enforces declared writes and exact pre-action speech", async () => {
    const f = fixture(); f.raw.writes = []; f.bound.program = admitWorldProgram(f.raw, f.sources);
    const { result } = await adjudicate(f), candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    expect(() => commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() })).toThrow("undeclared resource");
    f.raw.writes = ["quantities"]; f.raw.branches[0]!.deliveries = [{ recipientParameter: "recipient", kind: "speech", text: "I accept your deal." }];
    f.bound.program = admitWorldProgram(f.raw, f.sources); const speech = await adjudicate(f);
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], speech.result, 5)).toThrow("pre-action utterance");
  });
  it("does not label a no-op effect as committed progress", async () => {
    const f = fixture(); f.raw.writes = ["placements"];
    f.raw.branches[0]!.effects = [{ kind: "place_entity", fields: { entityId: { $expression: { kind: "parameter", name: "actor" } }, placementId: "courtyard" } }];
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    const { result } = await adjudicate(f), candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    const committed = commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() });
    expect(committed.receipt.programReceipts[0]!.madeProgress).toBe(false);
  });
});
