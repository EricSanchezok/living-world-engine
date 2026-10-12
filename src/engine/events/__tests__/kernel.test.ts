import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { decisionQuestionIds, decisionTestProvider } from "../../testing/decision-provider";
import { contentHash } from "../../models/model-audit";
import { DecisionRuntime } from "../../programs/decision-runtime";
import { quantityId, runtimeId } from "../../runtime/runtime-id";
import { admitWorldProgram, type WorldProgramDefinition } from "../world-program";
import { adjudicateWorldPrograms, worldProgramComponents, type BoundWorldProgram } from "../adjudication";
import { worldProgramSources, worldResources } from "../resources";
import { commitWorldEvent, createWorldEventCandidate } from "../kernel";
import { compileWorldProgram } from "../compiler";
import { encodeWorldDraft } from "../creation-codec";
import { WorldProgramLibrary } from "../library";
import { projectEventPerception } from "../perception";
import { applyEventBeliefs, reviseEventBeliefs } from "../cognition";
import { worldProgramDuration } from "../adjudication";
import { authorizeWorldRandomness, prepareWorldRandomPlan, validateWorldRandomness, worldRandomResources } from "../randomness";
import { nextWorldClockBoundary } from "../clock-boundary";
import { createHistoryReplayBase } from "../../runtime/history-replay";

function fixture() {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: createTestModelCatalog() });
  const state = structuredClone(definition.initialState), sources = worldProgramSources(definition, state), resources = worldResources(state, definition);
  const from = `quantity:${quantityId(state.worldHash, "spirit-stone", "player")}`;
  const to = `quantity:${quantityId(state.worldHash, "spirit-stone", "keeper")}`;
  const raw: WorldProgramDefinition = { version: 5, namespace: "world", id: "voluntary-gift", description: "Transfer the actor's offered stones to a nearby recipient.",
    sourceIds: ["world", "law:no-free-spirit-stones", "mechanics"], parameters: { actor: { kind: "entity", description: "Giver" }, recipient: { kind: "entity", description: "Recipient" }, amount: { kind: "number", description: "Offered amount" } },
    reads: ["entity:{actor}", "entity:{recipient}", "placement:{actor}", "placement:{recipient}", from, to], writes: ["quantities"],
    timing: { completionPredicateId: null, profileId: "explicit-duration", basis: { kind: "explicit_duration", seconds: { kind: "literal", value: 5 }, sourceText: "5 seconds" } }, random: [], resolutions: [], sharedResources: [],
    predicates: [{ id: "authorized", description: "The actor voluntarily offers their own stones to this reachable recipient.", reads: ["placement:{actor}", "placement:{recipient}"], sourceIds: ["world"],
      test: { kind: "semantic", instructions: "Check the actual offer and reach. Do not fabricate acceptance or an exchange promised in return." }, unknown: "wait" }],
    branches: [{ id: "give", when: [{ predicateId: "authorized", equals: "yes" }], outcome: "succeeded", acknowledgement: "attempted", description: "A voluntary transfer occurs.",
      resolutions: [], effects: [], mechanics: [{ id: "gift", packageId: "core-resolution", ruleId: "transfer-quantity", input: {
        definitionId: "spirit-stone",
        fromHolderId: { $expression: { kind: "parameter", name: "actor" } },
        toHolderId: { $expression: { kind: "parameter", name: "recipient" } },
        amountSource: { kind: "explicit_action_amount", actionId: { $attempt: "id" }, quotedText: "2", amount: { $expression: { kind: "parameter", name: "amount" } } },
      } }], deliveries: [] }],
  };
  const program = admitWorldProgram(raw, sources);
  const bound: BoundWorldProgram = { program, parameters: { actor: "player", recipient: "keeper", amount: 2 }, attempt: {
    id: runtimeId({ worldHash: state.worldHash, revision: 0, kind: "action", stage: "program", owner: "player", round: 0, ordinal: 0 }),
    actorId: "player", actorEntityId: "player", intent: "Spend 5 seconds giving the keeper 2 of my stones as a gift.", utterance: null, targetEntityIds: ["keeper"], startedAtSeconds: 0,
    program: { instanceId: "gift-1", definitionHash: contentHash("private"), nodeId: "give", parameterHash: contentHash("parameters"),
      workId: contentHash("work"), requestHash: contentHash("request") },
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
  }, { state: f.state, definition: f.definition });
  return { result, configured };
}

describe("source-bound world event kernel", () => {
  it("derives shared-resource components from actual effects even if generated write declarations omit them", () => {
    const f = fixture(); f.raw.writes = [];
    f.bound.program = admitWorldProgram(f.raw, f.sources); f.bound.attempt.targetEntityIds = [];
    const other = structuredClone(f.bound);
    other.parameters.actor = "keeper"; other.parameters.recipient = "player";
    Object.assign(other.attempt, { id: "other-gift", actorId: "keeper", actorEntityId: "keeper",
      intent: "Spend 5 seconds giving the player 2 of my stones.", targetEntityIds: [] });
    const groups = worldProgramComponents([f.bound, other], f.resources, f);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map(bound => bound.attempt.id).sort()).toEqual([f.bound.attempt.id, other.attempt.id].sort());
  });
  it("packs independent components together when they fit and keeps full partners when they do not", async () => {
    const f = fixture(); f.raw.reads = ["entity:{actor}"]; f.raw.writes = [];
    f.raw.predicates[0]!.reads = ["entity:{actor}"];
    f.raw.branches[0]!.mechanics = []; f.bound.program = admitWorldProgram(f.raw, f.sources);
    f.bound.attempt.targetEntityIds = [];
    const other = structuredClone(f.bound);
    other.parameters.actor = "keeper"; other.parameters.recipient = "player";
    Object.assign(other.attempt, { id: "other", actorId: "keeper", actorEntityId: "keeper", targetEntityIds: [] });
    other.attempt.program = null;
    const programs = [f.bound, other];
    expect(worldProgramComponents(programs, f.resources, f)).toHaveLength(2);
    const small = await adjudicate(f, programs);
    expect(small.configured.transport).toHaveBeenCalledTimes(1);
    expect(small.result.evidence[0]!.batch.state).toHaveProperty("attempts", [other.attempt, f.bound.attempt].sort((a, b) => a.id.localeCompare(b.id)));
    createWorldEventCandidate(f.state, f.definition, f.resources, programs, small.result, 5);
    for (const bound of programs) bound.attempt.intent = "Spend 5 seconds here. " + "An independently situated action. ".repeat(300);
    const large = await adjudicate(f, programs);
    expect(large.result.evidence).toHaveLength(2);
    for (const proof of large.result.evidence) expect((proof.batch.state as { attempts: unknown[] }).attempts).toHaveLength(1);
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, programs, large.result, 5);
    expect(candidate.components).toHaveLength(2);
    expect(commitWorldEvent(f.state, f.definition, f.resources, candidate,
      { earliestPendingSeconds: 5, receipts: new Map() }).state.truth.elapsedSeconds).toBe(5);
    other.attempt.targetEntityIds = ["player"];
    const coupled = await adjudicate(f, programs);
    expect(worldProgramComponents(programs, f.resources, f)).toHaveLength(1);
    for (const proof of coupled.result.evidence) expect((proof.batch.state as { attempts: unknown[] }).attempts).toHaveLength(2);
    createWorldEventCandidate(f.state, f.definition, f.resources, programs, coupled.result, 5);
  });
  it("shows exact Chinese number evidence and repairs a classifier quote through the actual compiler", async () => {
    const f = fixture(); f.bound.attempt.intent = "花 5 秒把两个灵石交给守门人。";
    const input = f.raw.branches[0]!.mechanics[0]!.input as Record<string, import("../../runtime/json").JsonValue>;
    const amount = input.amountSource as Record<string, import("../../runtime/json").JsonValue>;
    f.raw.timing = { completionPredicateId: null, profileId: "explicit-duration", basis: { kind: "explicit_duration", seconds: { kind: "literal", value: 5 }, sourceText: "5 秒" } };
    const configured = decisionTestProvider((body, attempt) => {
      expect(JSON.stringify(body)).toContain("explicitNumbers");
      if (attempt === 2) {
        expect(JSON.stringify(body)).toContain("Actual numeric quotes");
        expect(JSON.stringify(body)).toContain("excluding units");
      }
      amount.quotedText = attempt === 1 ? "两个" : "两";
      return encodeWorldDraft(f.raw, f.bound.parameters);
    });
    const result = await compileWorldProgram(configured.gateway, { profileId: "world-test", invocationBase: 1,
      workloadId: "numeric-evidence", batchId: "numeric-evidence", definition: f.definition, state: f.state,
      resources: f.resources, attempt: f.bound.attempt, reason: "new-intent", runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 } });
    expect(result.status).toBe("ready"); expect(configured.transport).toHaveBeenCalledTimes(2);
    input.fromHolderId = { kind: "parameter", name: "actor" };
    expect(() => admitWorldProgram(f.raw, f.sources)).toThrow("unwrapped world expression");
  });
  it("keeps authored fact sources immutable while actual fact dependencies change", () => {
    const f = fixture();
    f.state.historyBase = createHistoryReplayBase(f.state);
    const sourceId = Object.keys(f.sources).find(id => id.startsWith("fact:"))!;
    const factId = sourceId.slice(5);
    f.state.truth.facts[factId]!.description += " Its current condition changed.";
    const changed = worldResources(f.state, f.definition, f.resources);
    expect(worldProgramSources(f.definition, f.state)).toEqual(f.sources);
    expect(changed[sourceId]!.version).toBe(f.resources[sourceId]!.version + 1);
    delete f.state.truth.facts[factId];
    expect(worldProgramSources(f.definition, f.state)[sourceId]).toEqual(f.sources[sourceId]);
    expect(worldResources(f.state, f.definition, changed)[sourceId]!.value).toBeNull();
  });
  it("repairs unsupported observed acknowledgements during compilation before execution", async () => {
    const f = fixture(); f.raw.branches[0]!.acknowledgement = "observed-outcome";
    const configured = decisionTestProvider((body, attempt) => {
      if (attempt === 2) {
        expect(JSON.stringify(body)).toContain("committed observation to its actor");
        f.raw.branches[0]!.deliveries.push({ recipientParameter: "actor", kind: "observation", text: "You hand over the offered stones." });
      }
      return encodeWorldDraft(f.raw, f.bound.parameters);
    });
    const result = await compileWorldProgram(configured.gateway, { profileId: "world-test", invocationBase: 1,
      workloadId: "acknowledgement", batchId: "acknowledgement", definition: f.definition, state: f.state,
      resources: f.resources, attempt: f.bound.attempt, reason: "new-intent", runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 } });
    expect(result.status).toBe("ready"); expect(configured.transport).toHaveBeenCalledTimes(2);
    expect(result.audit?.invocations.map(invocation => invocation.outputDisposition)).toEqual(["rejected", "llm-repaired"]);
  });
  it("closes explicitly referenced nested sources before admission without inventing rule authority", async () => {
    const f = fixture(), fact = Object.keys(f.sources).find(id => id.startsWith("fact:"))!;
    f.raw.predicates[0]!.sourceIds.push(fact);
    const configured = decisionTestProvider(() => encodeWorldDraft(f.raw, f.bound.parameters));
    const result = await compileWorldProgram(configured.gateway, { profileId: "world-test", invocationBase: 1,
      workloadId: "source-closure", batchId: "source-closure", definition: f.definition, state: f.state,
      resources: f.resources, attempt: f.bound.attempt, reason: "initial-coverage", runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 } });
    if (result.status !== "ready") throw new Error(result.reason);
    expect(result.bound.program.definition.sourceIds).toContain(fact);
    expect(result.bound.program.sourceHashes[fact]).toBe(contentHash(f.sources[fact]));
    expect(configured.transport).toHaveBeenCalledTimes(1);
  });
  it("rejects raw numeric effects and amounts that are absent from the actual action", async () => {
    const f = fixture();
    f.raw.branches[0]!.mechanics = [];
    f.raw.branches[0]!.effects = [{ kind: "transfer_quantity", fields: {
      definitionId: "spirit-stone", fromHolderId: "player", toHolderId: "keeper", amount: 2,
    } }];
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    await expect(adjudicate(f)).rejects.toThrow("trusted core-resolution rule");
    const invented = fixture(); invented.bound.parameters.amount = 3;
    await expect(adjudicate(invented)).rejects.toThrow("not present verbatim");
    expect(invented.state.truth.quantities[quantityId(invented.state.worldHash, "spirit-stone", "player")]!.amount).toBe(3);
  });
  it("requires semantic effect authorization even when every branch prerequisite is mechanical", async () => {
    const f = fixture();
    f.raw.predicates[0]!.test = { kind: "mechanical", operator: "eq", left: { kind: "literal", value: true }, right: { kind: "literal", value: true } };
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    const unknown = await adjudicate(f, [f.bound], () => "unknown");
    expect(unknown.result.evidence[0]!.batch.questions.q0!.instructions).toContain("Are all candidate effects");
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], unknown.result, 5)).toThrow("awaits evidence");
    const accepted = await adjudicate(f);
    const missing = structuredClone(accepted.result); missing.evidence = [];
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], missing, 5)).toThrow("incomplete");
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], accepted.result, 5);
    expect(commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() }).state.step).toBe(1);
  });
  it("compiles through real gateway validation with one repair and no private cognition in the world prompt", async () => {
    const f = fixture();
    const configured = decisionTestProvider((body, attempt) => {
      expect(JSON.stringify(body)).not.toContain(f.state.agents.keeper!.character.persona.summary);
      if (attempt === 2) expect(JSON.stringify(body)).toContain("world compiler changed the action owner");
      return encodeWorldDraft(f.raw, { ...f.bound.parameters, actor: attempt === 1 ? "keeper" : "player" });
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
    const f = fixture(), configured = decisionTestProvider(() => encodeWorldDraft({ ...f.raw, sourceIds: ["invented-law"] }, f.bound.parameters));
    const result = await compileWorldProgram(configured.gateway, { workloadId: "world-compile", batchId: "world-compile", profileId: "world-test", invocationBase: 1,
      definition: f.definition, state: f.state, resources: f.resources, attempt: f.bound.attempt, reason: "new-intent",
      runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 } });
    expect(result).toMatchObject({ status: "failed", recoverable: true }); expect(configured.transport).toHaveBeenCalledTimes(2);
    expect(f.state.step).toBe(0);
  });
  it("reuses a compiled private program node when only its pre-action words change", async () => {
    const f = fixture();
    f.bound.attempt.utterance = "Please accept this gift.";
    f.raw.parameters.utterance = { kind: "text", description: "The concrete pre-action utterance." };
    f.bound.parameters.utterance = f.bound.attempt.utterance;
    f.raw.branches[0]!.deliveries = [{ recipientParameter: "recipient", kind: "speech", text: "{utterance}" }];
    const configured = decisionTestProvider(() => encodeWorldDraft(f.raw, f.bound.parameters));
    const compiled = await compileWorldProgram(configured.gateway, { profileId: "world-test", invocationBase: 1,
      workloadId: "reusable-speech", batchId: "reusable-speech", runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 },
      definition: f.definition, state: f.state, resources: f.resources, attempt: f.bound.attempt, reason: "initial-coverage" });
    if (compiled.status !== "ready") throw new Error(compiled.reason);
    const library = new WorldProgramLibrary(); library.add(compiled);
    const next = { ...f.bound.attempt, id: "next-attempt", utterance: "These are for you.", startedAtSeconds: 5 };
    const reused = library.lookup(next, f.sources, new Set(Object.keys(f.state.truth.entities)), f.resources);
    expect(reused!.parameters.utterance).toBe(next.utterance);
    expect(reused!.program.hash).toBe(compiled.bound.program.hash);
    expect(configured.transport).toHaveBeenCalledTimes(1);
    next.program = { ...next.program!, parameterHash: contentHash("changed-quantity") };
    expect(library.lookup(next, f.sources, new Set(Object.keys(f.state.truth.entities)), f.resources)).toBeNull();
  });
  it("executes a declared transfer through gateway decisions and commits exactly once", async () => {
    const f = fixture(), { result, configured } = await adjudicate(f);
    expect(configured.transport).toHaveBeenCalledTimes(1);
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    expect(candidate.mechanicResults[0]).toMatchObject({ code: "quantity-transfer-derived", data: { amount: 2, provenance: "explicit_action_amount" } });
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
    f.raw.branches[0]!.mechanics = [];
    f.raw.branches[0]!.effects = [{ kind: "place_entity", fields: { entityId: { $expression: { kind: "parameter", name: "actor" } }, placementId: "courtyard" } }];
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    const { result } = await adjudicate(f), candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    const committed = commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() });
    expect(committed.receipt.programReceipts[0]!.madeProgress).toBe(false);
  });
  it("does not reveal hidden outcomes or hidden progress through a private program receipt", async () => {
    const f = fixture(); f.raw.writes = ["facts"];
    f.raw.branches[0]!.mechanics = [];
    f.raw.branches[0]!.outcome = "failed";
    f.raw.branches[0]!.effects = [{ kind: "set_fact", fields: { fact: { id: "hidden-result", subjectId: "keeper", predicate: "secret-result",
      value: { kind: "text", value: "failure" }, description: "An unobserved result.", access: { kind: "private" } } } }];
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    const judged = await adjudicate(f), candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], judged.result, 5);
    const result = commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() });
    expect(result.state.truth.facts["hidden-result"]!.value).toEqual({ kind: "text", value: "failure" });
    expect(result.receipt.programReceipts[0]).toMatchObject({ status: "succeeded", madeProgress: false });
    f.raw.branches[0]!.acknowledgement = "observed-outcome"; f.bound.program = admitWorldProgram(f.raw, f.sources);
    const unsupported = await adjudicate(f);
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], unsupported.result, 5)).toThrow("committed observation");
  });
  it("binds duration to authored profiles and exact action evidence", () => {
    const f = fixture();
    expect(worldProgramDuration(f.bound, f.resources)).toBe(5);
    const forged = structuredClone(f.bound); forged.attempt.intent = "Give a gift.";
    expect(() => worldProgramDuration(forged, f.resources)).toThrow("grounded");
    f.raw.timing = { completionPredicateId: null, profileId: "brief-action", basis: { kind: "profile" } };
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    expect(worldProgramDuration(f.bound, f.resources)).toBe(1);
    f.raw.timing.profileId = "invented-profile"; f.bound.program = admitWorldProgram(f.raw, f.sources);
    expect(() => worldProgramDuration(f.bound, f.resources)).toThrow("authored temporal profile");
  });
  it("projects only committed deliveries without exposing a speaker's hidden identity", async () => {
    const f = fixture(); f.raw.writes = []; f.raw.branches[0]!.effects = []; f.raw.branches[0]!.mechanics = [];
    f.bound.attempt.utterance = "I am the rightful king.";
    f.raw.branches[0]!.deliveries = [{ recipientParameter: "recipient", kind: "speech", text: f.bound.attempt.utterance }];
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    for (const [id, binding] of Object.entries(f.state.agents.keeper!.bindings)) if (binding.canonicalEntityIds.includes("player")) delete f.state.agents.keeper!.bindings[id];
    const { result } = await adjudicate(f), candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5);
    const committed = commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() });
    expect(() => projectEventPerception(f.state, candidate, committed.receipt)).toThrow("committed world receipt");
    const tampered = structuredClone(candidate); tampered.deliveries[0]!.text = "A fabricated statement.";
    expect(() => projectEventPerception(committed.state, tampered, committed.receipt)).toThrow("committed world receipt");
    const projected = projectEventPerception(committed.state, candidate, committed.receipt);
    expect(projected.observations).toHaveLength(1);
    expect(projected.observations[0]).toMatchObject({ observerId: "keeper", summary: "说话者说：“I am the rightful king.”", apparentClaims: [] });
    expect(projected.observations[0]!.introductions[0]!.localEntity.name).toBe("说话者");
    expect(projected.agents.player).toEqual(committed.state.agents.player);
    expect(projected.agents.keeper!.belief.claims).toEqual(committed.state.agents.keeper!.belief.claims);
    expect(Object.values(projected.agents.keeper!.belief.evidence).some(value => value.kind === "testimony" && value.sourceId === projected.observations[0]!.id)).toBe(true);
    expect(committed.state.agents.keeper!.belief.evidence).toEqual(f.state.agents.keeper!.belief.evidence);
  });
  it("revises existing beliefs from the owner's evidence, with deterministic proof-checked replay", async () => {
    const f = fixture(), agent = f.state.agents.keeper!;
    const localId = Object.keys(agent.belief.localEntities)[0]!;
    agent.belief.evidence.new = { id: "new", kind: "testimony", description: "A stranger says the gate is open.", sourceId: null, step: 0 };
    agent.belief.claims.test = { id: "test", subjectId: localId, predicate: "gate-open", value: { kind: "boolean", value: true },
      description: "The gate is open", stance: "suspected", confidence: 0.5, evidenceIds: [] };
    const configured = decisionTestProvider(body => {
      const wire = JSON.stringify(body); expect(wire).not.toContain(f.state.agents.player!.character.persona.summary);
      expect(wire).not.toContain("canonicalEntityIds");
      return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "supported" }])) };
    });
    const registry = await configured.registry.capture(); let ordinal = 0;
    const output = await reviseEventBeliefs(new DecisionRuntime(configured.gateway), f.state, "keeper", ["new"], undefined,
      { profileId: "world-test", workloadId: "belief-test", batchId: "belief-test", modelRegistrySnapshotHash: registry.hash,
        runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 }, nextInvocation: () => ++ordinal });
    const revised = applyEventBeliefs(f.state, output.revision);
    expect(revised.belief.claims.test).toMatchObject({ stance: "believed", confidence: 0.5, evidenceIds: ["new"] });
    expect(f.state.agents.keeper!.belief.claims.test!.stance).toBe("suspected");
    expect(applyEventBeliefs(f.state, JSON.parse(JSON.stringify(output.revision)))).toEqual(revised);
    const forged = structuredClone(output.revision); forged.patch.operations = [];
    forged.hash = contentHash(Object.fromEntries(Object.entries(forged).filter(([key]) => key !== "hash")));
    expect(() => applyEventBeliefs(f.state, forged)).toThrow("differs from its decisions");
    f.state.agents.keeper!.belief.evidence.new!.description = "Different testimony.";
    expect(() => applyEventBeliefs(f.state, output.revision)).toThrow("private input");
  });
  it("freezes authored random stakes before drawing and replays the exact result through atomic commit", async () => {
    const f = fixture();
    f.definition.randomDistributions = [{ id: "gift-size", description: "An offered gift uses one or two stones with equal chance.",
      steps: [{ id: "amount", count: 1, outcomes: [1, 2], aggregate: "first", when: null }] }];
    f.sources = worldProgramSources(f.definition, f.state); f.resources = worldResources(f.state, f.definition);
    f.raw.random = [{ id: "gift", distributionId: "gift-size", purpose: "Choose the offered gift amount." }];
    f.raw.reads.push("random:{actor}:gift");
    (f.raw.branches[0]!.mechanics[0]!.input as Record<string, import("../../runtime/json").JsonValue>).amountSource = {
      kind: "random_result", requestId: { $expression: { kind: "read", resource: "random:{actor}:gift", path: ["requestId"] } }, stepId: "amount" };
    f.bound.attempt.intent = "Spend 5 seconds giving the keeper the authored randomly sized gift.";
    f.bound.program = admitWorldProgram(f.raw, f.sources);
    const plan = prepareWorldRandomPlan(f.state, f.definition, f.resources, [f.bound])!;
    expect(plan.before).toEqual(f.state.truth.rng); expect(plan).not.toHaveProperty("results");
    expect(JSON.stringify(plan.batch.state)).not.toContain('"rng"');
    const configured = decisionTestProvider(), registry = await configured.registry.capture(); let ordinal = 0;
    const scope = { profileId: "world-test", workloadId: "random-test", batchId: "random-test", modelRegistrySnapshotHash: registry.hash,
      runtimeIdentity: { worldHash: f.state.worldHash, revision: 0 }, nextInvocation: () => ++ordinal };
    const runtime = new DecisionRuntime(configured.gateway);
    const { commitment } = await authorizeWorldRandomness(runtime, plan, scope);
    if (!commitment) throw new Error("test random authorization was deferred");
    expect(f.state.truth.rng).toEqual(plan.before); expect(commitment.after.draws).toBe(plan.before.draws + 1);
    const expanded = validateWorldRandomness(f.state, f.definition, f.resources, [f.bound], commitment);
    expect(expanded).toEqual(worldRandomResources(f.resources, commitment));
    const judgments = await adjudicateWorldPrograms(runtime, [f.bound], expanded, f.sources, scope, { state: f.state, definition: f.definition, randomness: commitment });
    const candidate = createWorldEventCandidate(f.state, f.definition, expanded, [f.bound], judgments, 5, commitment);
    const result = commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() });
    const amount = commitment.results[0]!.steps[0]!.aggregate as number;
    expect(result.state.truth.quantities[quantityId(f.state.worldHash, "spirit-stone", "player")]!.amount).toBe(3 - amount);
    expect(result.state.truth.rng).toEqual(commitment.after);
    expect(result.receipt.writes).toContain("rng");
    expect(commitWorldEvent(f.state, f.definition, f.resources, JSON.parse(JSON.stringify(candidate)),
      { earliestPendingSeconds: 5, receipts: new Map() }).receipt).toEqual(result.receipt);
    expect(commitWorldEvent(result.state, f.definition, result.resources, candidate,
      { earliestPendingSeconds: 5, receipts: new Map([[candidate.id, result.receipt]]) }).state.truth.rng).toEqual(commitment.after);
    const edited = structuredClone(commitment); edited.after.draws += 1;
    edited.hash = contentHash(Object.fromEntries(Object.entries(edited).filter(([key]) => key !== "hash")));
    expect(() => validateWorldRandomness(f.state, f.definition, f.resources, [f.bound], edited)).toThrow("does not replay");
    const stale = structuredClone(f.state); stale.truth.rng = commitment.after;
    expect(() => commitWorldEvent(stale, f.definition, f.resources, candidate, { earliestPendingSeconds: 5, receipts: new Map() })).toThrow("random commitment");
    const refused = decisionTestProvider(body => ({ answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "unknown" }])) }));
    const refusedRegistry = await refused.registry.capture();
    const deferred = await authorizeWorldRandomness(new DecisionRuntime(refused.gateway), plan,
      { ...scope, modelRegistrySnapshotHash: refusedRegistry.hash });
    expect(deferred.commitment).toBeNull(); expect(deferred.disposition).toBe("wait");
    expect(deferred.call.result.answers.q0!.choice).toBe("unknown");
    expect(f.state.truth.rng).toEqual(plan.before);
    expect(() => createWorldEventCandidate(f.state, f.definition, expanded, [f.bound], judgments, 5)).toThrow("missing world random commitment");
    expect(() => admitWorldProgram({ ...f.raw, reads: [...f.raw.reads, "rng"] }, f.sources)).toThrow("owned by the engine");
    const changedStakes = structuredClone(f.bound); changedStakes.program.definition.branches[0]!.description = "Different stakes.";
    expect(() => prepareWorldRandomPlan(f.state, f.definition, f.resources, [changedStakes])).toThrow("sources changed");
  });
  it("commits an authored timer without a model call and prevents crossing an earlier deadline", async () => {
    const f = fixture();
    f.state.truth.timers.deadline = { id: "deadline", description: "The gate deadline has arrived.", createdAtSeconds: 0, dueAtSeconds: 3,
      status: "scheduled", wakeAgentIds: ["keeper"], causes: [{ kind: "law", id: f.state.lawIds[0]! }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 3 }] };
    f.resources = worldResources(f.state, f.definition);
    expect(nextWorldClockBoundary(f.state)).toBe(3);
    const { result } = await adjudicate(f);
    expect(() => createWorldEventCandidate(f.state, f.definition, f.resources, [f.bound], result, 5)).toThrow("earlier canonical timer");
    const candidate = createWorldEventCandidate(f.state, f.definition, f.resources, [], { records: [], evidence: [], calls: [] }, 3);
    const committed = commitWorldEvent(f.state, f.definition, f.resources, candidate, { earliestPendingSeconds: 3, receipts: new Map() });
    expect(committed.state.truth.timers.deadline!.status).toBe("fired");
    expect(committed.state.truth.elapsedSeconds).toBe(3);
    expect(committed.receipt.programReceipts).toEqual([]);
    expect(candidate.clockBoundary.timers[0]!.wakeAgentIds).toEqual(["keeper"]);
    expect(committed.state.truth.events.at(-1)!.description).toBe(f.state.truth.timers.deadline!.description);
    expect(committed.state.truth.rng).toEqual(f.state.truth.rng);
    expect(commitWorldEvent(f.state, f.definition, f.resources, JSON.parse(JSON.stringify(candidate)),
      { earliestPendingSeconds: 3, receipts: new Map() }).receipt).toEqual(committed.receipt);
    expect(() => createWorldEventCandidate(committed.state, f.definition, committed.resources, [], { records: [], evidence: [], calls: [] }, 4)).toThrow("actual clock boundary");
    f.state.truth.timers.deadline!.assertions.push({ kind: "entity_lifecycle", entityId: "keeper", expected: "retired" });
    f.resources = worldResources(f.state, f.definition, f.resources);
    const cancelled = createWorldEventCandidate(f.state, f.definition, f.resources, [], { records: [], evidence: [], calls: [] }, 3);
    expect(cancelled.clockBoundary.timers[0]).toMatchObject({ status: "cancelled", wakeAgentIds: [] });
  });
});
