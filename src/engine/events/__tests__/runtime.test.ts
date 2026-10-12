import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { decisionQuestionIds, decisionTestProvider } from "../../testing/decision-provider";
import type { ProgramDefinition } from "../../programs/definition";
import type { WorldProgramDefinition } from "../world-program";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm, decisionEventAlgorithmRef, WorldQuiescentError } from "../algorithm";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";
import { restoreOwnerPrograms, readDecisionEventState } from "../runtime-state";
import type { PolicyBinding } from "../../runtime/execution";
import { contentHash } from "../../models/model-audit";

const config = { decision: "world-test", creation: "world-test", fallback: "world-test", maxDependencyRounds: 32 };
function fixture() {
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: createTestModelCatalog() });
  const program: ProgramDefinition = { version: 1, id: "ask-purpose", name: "Ask the purpose", description: "Ask and await evidence.", owner: { kind: "agent", agentId: "keeper" },
    sourceIds: ["goal:guard-gate"], parameters: { recipient: { kind: "entity", description: "Known traveler" } },
    reads: ["evidence"], writes: [], entry: "ask", startPredicateId: "ready", interrupts: [], milestones: [],
    goals: [{ goalId: "guard-gate", predicateId: "complete" }],
    nodes: [{ id: "ask", kind: "attempt", intent: "Spend 5 seconds asking {recipient} why they are here.", entityTargetParameters: ["recipient"],
      speech: { kind: "authored", text: "Why are you here?" }, onFailure: "expand", onPartial: "wait" }],
    predicates: [{ id: "ready", description: "Available plan", sourceIds: ["goal:guard-gate"], reads: ["evidence"], unknown: "wait",
      test: { kind: "mechanical", operator: "eq", left: { kind: "literal", value: true }, right: { kind: "literal", value: true } } },
    { id: "complete", description: "Duty complete", sourceIds: ["goal:guard-gate"], reads: ["evidence"], unknown: "wait",
      test: { kind: "semantic", instructions: "Is the actual guarding duty complete?" } }] };
  const rule: WorldProgramDefinition = { version: 1, namespace: "world", id: "ask-reachable", description: "Ask a nearby traveler a question.",
    sourceIds: ["world"], parameters: { actor: { kind: "entity", description: "Speaker" }, recipient: { kind: "entity", description: "Listener" },
      utterance: { kind: "text", description: "Exact words" } }, reads: ["entity:{actor}", "entity:{recipient}", "placement:{actor}", "placement:{recipient}"], writes: [],
    timing: { profileId: "explicit-duration", basis: { kind: "explicit_duration", seconds: { kind: "literal", value: 5 }, sourceText: "5 seconds" } }, random: [],
    predicates: [{ id: "reachable", description: "Speech can be heard", sourceIds: ["world"], reads: ["placement:{actor}", "placement:{recipient}"], unknown: "wait",
      test: { kind: "semantic", instructions: "Does the actual speaker address the reachable listener?" } }],
    branches: [{ id: "spoken", when: [{ predicateId: "reachable", equals: "yes" }], acknowledgement: "attempted", outcome: "succeeded",
      description: "The keeper asks a question.", effects: [], deliveries: [{ kind: "speech", recipientParameter: "recipient", text: "{utterance}" }] }] };
  const configured = decisionTestProvider(body => {
    const wire = (body.messages as Array<{ content: string }>).map(message => message.content).join("\n");
    if (wire.includes("Compile a reusable private behavior program")) return { definition: program, parameters: { recipient: "traveler" } };
    if (wire.includes("You compile authored world sources")) return { definition: rule, parameters: wire.includes("Hello keeper") ?
      { actor: "player", recipient: "keeper", utterance: "Hello keeper" } : { actor: "keeper", recipient: "player", utterance: "Why are you here?" } };
    if (wire.includes("Render the player's submitted action.")) return { utterance: "Hello keeper" };
    if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: wire.includes("guard-gate") ? "g0" : "wait" } } };
    const choice = wire.includes("You update an Agent's existing beliefs") ? "unchanged" : wire.includes("actual long-term goal") ? "unknown" : "yes";
    return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice }])) };
  });
  const roster: Record<string, PolicyBinding> = { keeper: { kind: "model", agentId: "keeper", profiles: world.initialState.agents.keeper!.modelProfiles },
    player: { kind: "external", agentId: "player", participantId: "human" } };
  return { world, configured, roster };
}

describe("native event runtime through SimulationEngine", () => {
  it("registers a pinned algorithm, commits actual speech, and replays/restarts without duplicate effects", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const registry = registerBuiltinAlgorithms();
    const algorithm = registry.create(decisionEventAlgorithmRef(config), { provider: f.configured.gateway });
    const engine = new SimulationEngine(f.world, algorithm);
    const boot = await engine.bootstrapAgents();
    expect(boot.truth.elapsedSeconds).toBe(0); expect(boot.revision).toBe(0);
    expect(boot.bootstrapAgentCommits).toEqual([]); expect(boot.bootstrapDecisionEvent).toBeDefined();
    expect(boot.bootstrapDecisionEvent!.control.coverage.find(row => row.ownerId === "keeper")!.status).toBe("waiting");
    validateSimulationState(boot, false, true);
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(5); expect(result.state.step).toBe(1); expect(result.state.revision).toBe(1);
    expect(result.committed.actions).toHaveLength(1); expect(result.committed.observations.map(packet => packet.observerId)).toContain("player");
    const control = readDecisionEventState(result.state.executionState!, result.state);
    expect(control.pending).toHaveLength(0); expect(control.receipts).toHaveLength(1);
    expect(restoreOwnerPrograms(control, "keeper")[0]!.completion).toMatchObject({ executionEnded: true, goals: {} });
    expect(f.configured.transport.mock.calls.every(call => !String(call[1]?.body).includes("causal-verifier"))).toBe(true);
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const restarted = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, config), JSON.parse(JSON.stringify(result.state)));
    expect(restarted.snapshot.truth.events).toEqual(result.state.truth.events);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });
  it("rejects edited private verdicts even if envelope hashes are recomputed", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, config));
    const boot = await engine.bootstrapAgents();
    const tampered = structuredClone(boot);
    const entry = tampered.bootstrapDecisionEvent!.control.agents.keeper!.instances[0]!.snapshot;
    const predicate = entry.events.find(event => event.kind === "predicate" && event.reason === "goal");
    if (!predicate || predicate.kind !== "predicate") throw new Error("missing test predicate");
    predicate.verdict = "yes";
    entry.hash = contentHash(Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "hash")));
    const control = tampered.bootstrapDecisionEvent!.control;
    control.hash = contentHash(Object.fromEntries(Object.entries(control).filter(([key]) => key !== "hash")));
    tampered.executionState!.data = JSON.parse(JSON.stringify(control));
    expect(() => validateSimulationState(tampered, false, true)).toThrow("predicate verdict");
  });
  it("commits a controller interruption without advancing world time and then sleeps without model work", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, config));
    await engine.bootstrapAgents();
    const roster: Record<string, PolicyBinding> = { ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } };
    const count = f.configured.transport.mock.calls.length;
    const result = await engine.step(roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.revision).toBe(1); expect(result.state.step).toBe(0); expect(result.state.truth.elapsedSeconds).toBe(0);
    expect(result.committed.decisionEvent!.event).toBeNull(); expect(replaySimulationState(result.state)).toEqual(result.state);
    await expect(engine.step(roster, { expectedRevision: 1, trigger: "manual", externalActions: [] })).rejects.toBeInstanceOf(WorldQuiescentError);
    expect(f.configured.transport).toHaveBeenCalledTimes(count);
  });
  it("takes a natural-language player submission through authored speech, world adjudication and canonical delivery", async () => {
    const f = fixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, config));
    await engine.bootstrapAgents();
    const heard = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const keeperRef = Object.values(heard.state.agents.player!.bindings).find(binding => binding.canonicalEntityIds[0] === "keeper")!.localEntityId;
    const roster: Record<string, PolicyBinding> = { ...f.roster, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } };
    const result = await engine.step(roster, { expectedRevision: 1, trigger: "participant_action", externalActions: [{
      agentId: "player", submissionId: "player-speech", rawText: 'Spend 5 seconds saying "Hello keeper" to the keeper.',
      goal: "Greet the keeper", means: null, targetIds: [keeperRef],
    }] });
    expect(result.state.truth.elapsedSeconds).toBe(10); expect(result.committed.actions[0]!.actorId).toBe("player");
    expect(result.committed.decisionEvent!.event!.deliveries).toContainEqual({
      attemptId: result.committed.actions[0]!.id, recipientEntityId: "keeper", kind: "speech", text: "Hello keeper",
    });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
});
