import { nativeProgramFixture, nativeProgramTestConfig } from "../../testing/native-program-world";
import { describe, expect, it } from "vitest";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import { DecisionEventAlgorithm, decisionEventAlgorithmRef, WorldQuiescentError } from "../algorithm";
import { registerBuiltinAlgorithms } from "../../algorithms/registry";
import { restoreOwnerPrograms, readDecisionEventState } from "../runtime-state";
import type { PolicyBinding } from "../../runtime/execution";
import { contentHash } from "../../models/model-audit";
import { quantityId } from "../../runtime/runtime-id";
import { restoreDecisionEventStep } from "../journal";
import { replayDecisionEventStep } from "../canonical";


describe("native event runtime through SimulationEngine", () => {
  it.each(["wait", "unknown"] as const)("preserves a %s assessment without converting unknown into false or polling again", async adaptation => {
    const f = nativeProgramFixture({ adaptation });
    // Only the start condition is evaluated, and absence of a historical receipt stays unknown.
    f.program.predicates[0]!.test = { kind: "semantic", instructions: "Is the actual long-term goal already achieved?" };
    f.program.predicates[0]!.description = "Is the actual long-term goal already achieved?";
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const program = restoreOwnerPrograms(boot.bootstrapDecisionEvent!.control, "keeper")[0]!;
    expect(program.status).toBe("waiting");
    expect(program.snapshot().events.filter(event => event.kind === "predicate").map(event => event.verdict)).toEqual(["unknown"]);
    const calls = f.configured.transport.mock.calls.length;
    const policyChange = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(policyChange.state.truth).toEqual(boot.truth);
    await expect(engine.step(f.roster, { expectedRevision: 1, trigger: "manual", externalActions: [] })).rejects.toBeInstanceOf(WorldQuiescentError);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
    expect(replaySimulationState(boot)).toEqual(boot);
  });
  it("revises an unjustified private wait with bound decision evidence and then executes through the real entry", async () => {
    const f = nativeProgramFixture({ adaptation: "revise" });
    const ready = structuredClone(f.program.predicates[0]!);
    f.program.predicates[0]!.test = { kind: "semantic", instructions: "Is the actual long-term goal already achieved?" };
    f.program.predicates[0]!.description = "Is the actual long-term goal already achieved?";
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const interrupted = restoreOwnerPrograms(boot.bootstrapDecisionEvent!.control, "keeper")[0]!;
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.snapshot().events.at(-1)).toMatchObject({ kind: "interrupt", reason: expect.stringMatching(/^plan-adaptation:/u) });
    expect(boot.truth).toEqual(f.world.initialState.truth);
    expect(replaySimulationState(boot)).toEqual(boot);
    const edited = structuredClone(boot), proof = edited.bootstrapDecisionEvent!;
    const snapshot = proof.control.agents.keeper!.instances[0]!.snapshot;
    const interruption = snapshot.events.at(-1)!;
    if (interruption.kind !== "interrupt") throw new Error("missing interruption");
    interruption.reason = `plan-adaptation:${contentHash("unrelated-decision")}`;
    snapshot.hash = contentHash(Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== "hash")));
    proof.control.hash = contentHash(Object.fromEntries(Object.entries(proof.control).filter(([key]) => key !== "hash")));
    edited.executionState!.data = JSON.parse(JSON.stringify(proof.control));
    expect(() => validateSimulationState(edited, false, true)).toThrow("stalled-frontier decision");
    f.program.predicates[0] = ready;
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.truth.elapsedSeconds).toBe(5);
    const owner = readDecisionEventState(result.state.executionState!, result.state).agents.keeper!;
    expect(owner.instances).toHaveLength(2);
    expect(owner.planning?.attempts).toBe(2);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("persists trusted numeric derivation through the canonical entry and replays it without duplication", async () => {
    const f = nativeProgramFixture();
    f.program.nodes[0] = { ...f.program.nodes[0]!, intent: "Spend 5 seconds giving two spirit stones to {recipient}." } as typeof f.program.nodes[number];
    f.rule.sourceIds.push("mechanics"); f.rule.writes.push("quantities");
    f.rule.branches[0]!.mechanics = [{ id: "gift", packageId: "core-resolution", ruleId: "transfer-quantity", input: {
      definitionId: "spirit-stone", fromHolderId: { $expression: { kind: "parameter", name: "actor" } },
      toHolderId: { $expression: { kind: "parameter", name: "recipient" } },
      amountSource: { kind: "explicit_action_amount", actionId: { $attempt: "id" }, quotedText: "two", amount: 2 },
    } }];
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const holder = quantityId(boot.worldHash, "spirit-stone", "keeper");
    expect(result.state.truth.quantities[holder]!.amount).toBe(boot.truth.quantities[holder]!.amount - 2);
    expect(result.committed.mechanicResults[0]!.code).toBe("quantity-transfer-derived");
    expect(result.committed.mechanicInvocations[0]!.input).toMatchObject({ amountSource: { actionId: result.committed.actions[0]!.id } });
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(result.state)).toEqual(result.state);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });
  it("reuses an immutable plan after new private evidence without requiring its original admission environment", async () => {
    const options = { reuse: false };
    const f = nativeProgramFixture(options); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const first = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    const keeperRef = Object.values(first.state.agents.player!.bindings).find(binding => binding.canonicalEntityIds[0] === "keeper")!.localEntityId;
    const idle = { ...f.roster, keeper: { kind: "idle" as const, agentId: "keeper", reason: "explicit" as const } };
    const heard = await engine.step(idle, { expectedRevision: first.state.revision, trigger: "participant_action", externalActions: [{ agentId: "player",
      submissionId: "new-evidence-before-reuse", rawText: 'Spend 5 seconds saying "Hello keeper" to the keeper.', goal: "Greet", means: null, targetIds: [keeperRef] }] });
    const before = readDecisionEventState(heard.state.executionState!, heard.state);
    options.reuse = true;
    const result = await engine.step(f.roster, { expectedRevision: heard.state.revision, trigger: "manual", externalActions: [] });
    const after = readDecisionEventState(result.state.executionState!, result.state);
    expect(after.privateLibrary).toEqual(before.privateLibrary);
    expect(after.agents.keeper!.instances).toHaveLength(2);
    expect(result.committed.decisionEvent!.modelAudits.filter(audit => audit.role === "creation")).toEqual([]);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("keeps a new private goal conclusion separate from simultaneous delivered observations", async () => {
    const options: { goalVerdict: "yes" | "unknown" } = { goalVerdict: "unknown" };
    const f = nativeProgramFixture(options); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const heard = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    options.goalVerdict = "yes";
    const keeperRef = Object.values(heard.state.agents.player!.bindings).find(binding => binding.canonicalEntityIds[0] === "keeper")!.localEntityId;
    const result = await engine.step(f.roster, { expectedRevision: 1, trigger: "participant_action", externalActions: [{ agentId: "player",
      submissionId: "goal-and-speech", rawText: 'Spend 5 seconds saying "Hello keeper" to the keeper.', goal: "Greet", means: null, targetIds: [keeperRef] }] });
    expect(result.state.agents.keeper!.character.goals["guard-gate"]!.status).toBe("completed");
    expect(result.committed.characterPatches.flatMap(patch => patch.operations).some(operation => operation.kind === "set_goal_status")).toBe(true);
    expect(result.committed.decisionEvent!.beliefRevisions.filter(revision => revision.agentId === "keeper")).toHaveLength(1);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("persists a separately proved goal judgment as private cognition without claiming a physical effect", async () => {
    const f = nativeProgramFixture({ goalVerdict: "yes" }); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const goal = boot.agents.keeper!.character.goals["guard-gate"]!;
    expect(goal).toMatchObject({ status: "completed", progress: 1 });
    expect(boot.agents.keeper!.belief.evidence[goal.evidenceIds[0]!]).toMatchObject({ kind: "inference" });
    expect(boot.truth).toEqual(f.world.initialState.truth);
    expect(restoreOwnerPrograms(boot.bootstrapDecisionEvent!.control, "keeper")[0]!.completion.executionEnded).toBe(false);
    expect(replaySimulationState(boot)).toEqual(boot);
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(result.state.agents.keeper!.character.goals["guard-gate"]!.evidenceIds).toEqual(goal.evidenceIds);
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("canonically replays a condition reused by a later branch without another decision", async () => {
    const f = nativeProgramFixture();
    const ask = f.program.nodes[0]!;
    f.program.entry = "sequence";
    f.program.predicates[1]!.test = { kind: "mechanical", operator: "eq", left: { kind: "literal", value: false }, right: { kind: "literal", value: true } };
    f.program.predicates.push({ id: "available", description: "The known traveler is available", reads: ["evidence"], sourceIds: ["goal:guard-gate"],
      unknown: "wait", test: { kind: "semantic", instructions: "Is the traveler available?" } });
    f.program.milestones = [{ id: "available", predicateId: "available" }];
    f.program.nodes = [{ id: "sequence", kind: "sequence", children: ["wait", "branch"] },
      { id: "wait", kind: "wait", predicateId: "available", deadlineSeconds: null },
      { id: "branch", kind: "branch", predicateId: "available", yes: ask.id, no: "finish" }, ask, { id: "finish", kind: "finish" }];
    await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    const boot = await engine.bootstrapAgents();
    const events = boot.bootstrapDecisionEvent!.control.agents.keeper!.instances[0]!.snapshot.events;
    expect(events.filter(event => event.kind === "predicate" && event.reusedFrom)).toHaveLength(1);
    expect(boot.bootstrapDecisionEvent!.decisions.filter(use => use.programInstanceId)).toHaveLength(1);
    expect(replaySimulationState(boot)).toEqual(boot);
    const result = await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] });
    expect(replaySimulationState(result.state)).toEqual(result.state);
  });
  it("exposes every ordered debug stage around native model work and canonical validation", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
    await engine.bootstrapAgents();
    const entered: number[] = [], completed: number[] = [];
    await engine.step(f.roster, { expectedRevision: 0, trigger: "manual", externalActions: [] }, {
      workloadId: "native-stages", batchId: "native-stages", stageHooks: { enabled: true,
        before: async stage => { entered.push(stage.index); }, after: async stage => { completed.push(stage.index); },
        failed: () => { throw new Error("unexpected stage failure"); } },
    });
    expect(entered).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(completed).toEqual(entered);
  });
  it("registers a pinned algorithm, commits actual speech, and replays/restarts without duplicate effects", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const registry = registerBuiltinAlgorithms();
    const algorithm = registry.create(decisionEventAlgorithmRef(nativeProgramTestConfig), { provider: f.configured.gateway });
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
    expect(result.committed.decisionEvent!.version).toBe(2);
    expect(result.committed.executionState!.data).toEqual({ kind: "decision-event-reference", hash: control.hash });
    const proof = restoreDecisionEventStep(boot, result.committed.decisionEvent!);
    expect(proof.finalControl).toEqual(control);
    expect(JSON.stringify(result.committed.decisionEvent).length).toBeLessThan(JSON.stringify(proof).length);
    const damaged = structuredClone(result.committed);
    damaged.decisionEvent!.settled.resultHash = contentHash("a different execution state");
    expect(() => replayDecisionEventStep(boot, damaged)).toThrow("delta result mismatch");
    expect(restoreOwnerPrograms(control, "keeper")[0]!.completion).toMatchObject({ executionEnded: true, goals: {} });
    expect(f.configured.transport.mock.calls.every(call => !String(call[1]?.body).includes("causal-verifier"))).toBe(true);
    const calls = f.configured.transport.mock.calls.length;
    expect(replaySimulationState(result.state)).toEqual(result.state);
    const restarted = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig), JSON.parse(JSON.stringify(result.state)));
    expect(restarted.snapshot.truth.events).toEqual(result.state.truth.events);
    expect(f.configured.transport).toHaveBeenCalledTimes(calls);
  });
  it("rejects edited private verdicts even if envelope hashes are recomputed", async () => {
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
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
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
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
    const f = nativeProgramFixture(); await f.configured.registry.capture();
    const engine = new SimulationEngine(f.world, new DecisionEventAlgorithm(f.configured.gateway, nativeProgramTestConfig));
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
