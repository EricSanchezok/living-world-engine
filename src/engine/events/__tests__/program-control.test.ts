import path from "node:path";
import { encodeProgramDraft } from "../../programs/creation-codec";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { decisionQuestionIds, decisionTestProvider } from "../../testing/decision-provider";
import type { ProgramDefinition } from "../../programs/definition";
import { contentHash } from "../../models/model-audit";
import { advanceProgramControls } from "../program-control";
import { initialDecisionEventState, readDecisionEventState, restoreOwnerPrograms } from "../runtime-state";
import type { PolicyBinding } from "../../runtime/execution";
import { EventScheduler } from "../scheduler";
import { programGoalSelection } from "../goal-selection";
import { projectAgentPerspective } from "../../cognition/agent-perspective";
import { ProgramLibrary } from "../../programs/library";

function fixture() {
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: createTestModelCatalog() });
  const definition: ProgramDefinition = { version: 1, id: "ask-at-gate", name: "Ask at the gate", owner: { kind: "agent", agentId: "keeper" },
    description: "Ask what the traveler wants before deciding what to do.", sourceIds: ["goal:guard-gate"],
    parameters: { recipient: { kind: "entity", description: "Known traveler" } }, reads: ["evidence"], writes: [],
    entry: "ask", startPredicateId: "ready", nodes: [{ id: "ask", kind: "attempt", intent: "Ask {recipient} why they are here.",
      entityTargetParameters: ["recipient"], speech: { kind: "create", purpose: "Ask their purpose" }, onFailure: "expand", onPartial: "wait" }],
    predicates: [{ id: "ready", description: "This is an available course of action.", reads: ["evidence"], sourceIds: ["goal:guard-gate"], unknown: "wait",
      test: { kind: "mechanical", operator: "eq", left: { kind: "literal", value: true }, right: { kind: "literal", value: true } } },
    { id: "guarded", description: "Guarding duty is complete.", reads: ["evidence"], sourceIds: ["goal:guard-gate"], unknown: "wait",
      test: { kind: "semantic", instructions: "Has guarding duty actually ended successfully?" } }], interrupts: [], milestones: [],
    goals: [{ goalId: "guard-gate", predicateId: "guarded" }] };
  const roster: Record<string, PolicyBinding> = {
    player: { kind: "external", agentId: "player", participantId: "human" },
    keeper: { kind: "model", agentId: "keeper", profiles: world.initialState.agents.keeper!.modelProfiles },
  };
  const counters = new Map<string, number>();
  const nextInvocation = (subjectId: string, slots = 1) => {
    const next = (counters.get(subjectId) ?? 0) + 1; counters.set(subjectId, next + slots - 1); return next;
  };
  return { world, definition, roster, options: { maxDependencyRounds: 32, nextInvocation } };
}
describe("durable private program control", () => {
  it("cancels an unbound attempt after a source-bound interruption and schedules a bounded revision", async () => {
    const f = fixture();
    f.definition.interrupts = ["invalidated"];
    f.definition.reads.push("observations");
    f.definition.predicates.push({ id: "invalidated", description: "A new observation invalidates this plan.", reads: ["observations"],
      sourceIds: ["goal:guard-gate"], unknown: "wait", test: { kind: "semantic", instructions: "Does the actual new observation invalidate this plan?" } });
    let interrupt = false;
    const configured = decisionTestProvider(body => {
      const wire = JSON.stringify(body);
      if (wire.includes("Compile a reusable private behavior program")) return encodeProgramDraft(f.definition, { recipient: "traveler" });
      if (wire.includes("Write the exact words this Agent")) return { text: "Why are you here?" };
      if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: "g0" } } };
      return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: interrupt ? "yes" : "no" }])) };
    });
    const registry = await configured.registry.capture(), source = f.world.initialState;
    const initial = initialDecisionEventState(source, { decision: "world-test", creation: "world-test", fallback: "world-test" }, configured.gateway.catalog.hash, registry.hash);
    const scope = { workloadId: "interrupt", batchId: "interrupt" };
    const first = await advanceProgramControls(configured.gateway, source, initial, f.roster, scope, f.options);
    expect(first.control.pending).toHaveLength(1);
    const awakened = structuredClone(first.control);
    // A real private observation changes both the decision cache key and its wake dependency.
    source.agents.keeper!.belief.evidence["interruption-observation"] = { id: "interruption-observation", step: 0,
      kind: "observation", description: "The traveler has left.", sourceId: null };
    const scheduler = new EventScheduler(0, awakened.scheduler);
    scheduler.schedule({ atSeconds: 0, subjectId: "keeper", kind: "control", inputHash: contentHash("new-observation"), payload: { reason: "observation" } });
    awakened.scheduler = scheduler.snapshot(); interrupt = true;
    const second = await advanceProgramControls(configured.gateway, source, awakened, f.roster, scope, f.options);
    expect(second.control.pending).toEqual([]);
    expect(restoreOwnerPrograms(second.control, "keeper")[0]!.status).toBe("interrupted");
    expect(second.control.scheduler.pending.some(event => event.kind === "control" && event.subjectId === "keeper")).toBe(true);
  });
  it("revises an unknown plan once, then stops same-input expansion across new instance IDs", async () => {
    const f = fixture();
    f.definition.predicates[0] = { ...f.definition.predicates[0]!, unknown: "expand",
      test: { kind: "semantic", instructions: "Is this course of action supported by the available evidence?" } };
    let created = 0;
    const configured = decisionTestProvider(body => {
      const wire = JSON.stringify(body);
      if (wire.includes("Compile a reusable private behavior program")) {
        created += 1;
        if (created > 1) expect(wire).toContain("priorProgram");
        return encodeProgramDraft(f.definition, { recipient: "traveler" });
      }
      if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: "g0" } } };
      return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "unknown" }])) };
    });
    const registry = await configured.registry.capture(), source = f.world.initialState;
    source.agents.keeper!.belief.evidence["first-report"] = { id: "first-report", step: 0,
      kind: "testimony", description: "The traveler has made the same offer.", sourceId: null };
    const initial = initialDecisionEventState(source, { decision: "world-test", creation: "world-test", fallback: "world-test" }, configured.gateway.catalog.hash, registry.hash);
    const scope = { workloadId: "expansion", batchId: "expansion" };
    const first = await advanceProgramControls(configured.gateway, source, initial, f.roster, scope, f.options);
    expect(first.control.scheduler.pending.some(event => event.kind === "control" && event.subjectId === "keeper")).toBe(true);
    const second = await advanceProgramControls(configured.gateway, source, first.control, f.roster, scope, f.options);
    expect(second.control.agents.keeper!.planning).toMatchObject({ attempts: 2, waitReason: "expansion-budget-exhausted" });
    const calls = configured.transport.mock.calls.length;
    const third = await advanceProgramControls(configured.gateway, source, second.control, f.roster, scope, f.options);
    expect(created).toBe(2); expect(configured.transport).toHaveBeenCalledTimes(calls);
    expect(third.control.pending).toEqual([]);
    expect(third.control.failures.some(failure => failure.reason.includes("one targeted plan revision"))).toBe(true);
    source.agents.keeper!.belief.evidence["duplicate-report"] = { id: "duplicate-report", step: 1,
      kind: "testimony", description: "The traveler has made the same offer.", sourceId: null };
    const duplicate = await advanceProgramControls(configured.gateway, source, third.control, f.roster, scope, f.options);
    expect(created).toBe(2);
    expect(duplicate.control.agents.keeper!.planning?.attempts).toBe(2);
  });
  it("excludes every invalidated version even after a fresh observation resets the revision budget", async () => {
    const f = fixture();
    const configured = decisionTestProvider(body => {
      const wire = JSON.stringify(body);
      if (wire.includes("Compile a reusable private behavior program")) return encodeProgramDraft(f.definition, { recipient: "traveler" });
      if (wire.includes("Write the exact words this Agent")) return { text: "Why are you here?" };
      if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: "g0" } } };
      return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "unknown" }])) };
    });
    const registry = await configured.registry.capture(), source = f.world.initialState;
    const initial = initialDecisionEventState(source, { decision: "world-test", creation: "world-test", fallback: "world-test" }, configured.gateway.catalog.hash, registry.hash);
    const result = await advanceProgramControls(configured.gateway, source, initial, f.roster, { workloadId: "no-restart", batchId: "no-restart" }, f.options);
    const programs = restoreOwnerPrograms(result.control, "keeper"), agent = source.agents.keeper!;
    programs[0]!.interrupt("plan-adaptation:needs-a-different-contribution", 0);
    const domain = programGoalSelection(agent, projectAgentPerspective(source, agent), result.control.agents.keeper!.resources.resources,
      programs, new ProgramLibrary(result.control.privateLibrary));
    expect(domain.reusable).toEqual([]);
    expect(Object.keys(domain.batch.questions.goal!.criteria)).not.toContain("p0");
  });
  it("selects a previously admitted private program without generating the definition again", async () => {
    const f = fixture();
    f.definition.nodes[0] = { ...f.definition.nodes[0]!, speech: { kind: "authored", text: "Why are you here?" } } as ProgramDefinition["nodes"][number];
    let created = 0, reuse = false;
    const configured = decisionTestProvider(body => {
      const wire = JSON.stringify(body);
      if (wire.includes("Compile a reusable private behavior program")) {
        created += 1; return encodeProgramDraft(f.definition, { recipient: "traveler" });
      }
      if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: reuse ? "p0" : "g0" } } };
      return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "unknown" }])) };
    });
    const registry = await configured.registry.capture(), source = f.world.initialState;
    const initial = initialDecisionEventState(source, { decision: "world-test", creation: "world-test", fallback: "world-test" }, configured.gateway.catalog.hash, registry.hash);
    const scope = { workloadId: "reuse", batchId: "reuse" };
    const first = await advanceProgramControls(configured.gateway, source, initial, f.roster, scope, f.options);
    const paused = await advanceProgramControls(configured.gateway, source, first.control, { ...f.roster,
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, scope, f.options);
    reuse = true;
    const resumed = await advanceProgramControls(configured.gateway, source, paused.control, f.roster, scope, f.options);
    expect(created).toBe(1); expect(resumed.modelAudits.every(audit => audit.role === "decision")).toBe(true);
    expect(resumed.control.agents.keeper!.instances).toHaveLength(2);
    expect(resumed.control.pending).toHaveLength(1);
  });
  it("uses the actual private goal, authors speech before issuing, and restores pending work without dispatching twice", async () => {
    const f = fixture();
    const configured = decisionTestProvider(body => {
      const wire = JSON.stringify(body); expect(wire).not.toContain("key-is-authentic"); expect(wire).not.toContain("canonicalEntityIds");
      if (wire.includes("Compile a reusable private behavior program")) return encodeProgramDraft(f.definition, { recipient: "traveler" });
      if (wire.includes("Write the exact words this Agent")) return { text: "Why are you here?" };
      if (wire.includes("Choose which actual active goal")) return { answers: { goal: { choice: "g0" } } };
      return { answers: Object.fromEntries(decisionQuestionIds(body).map(id => [id, { choice: "unknown" }])) };
    });
    const registry = await configured.registry.capture();
    const source = f.world.initialState, hash = contentHash(source);
    const initial = initialDecisionEventState(source, { decision: "world-test", creation: "world-test", fallback: "world-test" }, configured.gateway.catalog.hash, registry.hash);
    const scope = { workloadId: "program-control", batchId: "program-control", runtimeIdentity: { worldHash: source.worldHash, revision: 0 } };
    const first = await advanceProgramControls(configured.gateway, source, initial, f.roster, scope, f.options);
    expect(contentHash(source)).toBe(hash);
    expect(first.activatedAgentIds).toEqual(["keeper"]);
    expect(first.control.pending).toHaveLength(1);
    expect(first.control.pending[0]!.attempt).toMatchObject({ actorId: "keeper", actorEntityId: "keeper",
      utterance: "Why are you here?", targetEntityIds: ["player"] });
    expect(restoreOwnerPrograms(first.control, "keeper")[0]!.completion.goals).toEqual({});
    const persisted = readDecisionEventState({ producerHash: contentHash("native-test"), data: JSON.parse(JSON.stringify(first.control)) }, source);
    const count = configured.transport.mock.calls.length;
    const resumed = await advanceProgramControls(configured.gateway, source, persisted, f.roster, scope, f.options);
    expect(configured.transport).toHaveBeenCalledTimes(count);
    expect(resumed.control.pending).toEqual(first.control.pending);
    expect(resumed.control.agents.keeper!.instances).toEqual(first.control.agents.keeper!.instances);
    expect(first.modelAudits.map(audit => audit.role).sort()).toEqual(["creation", "creation", "decision", "decision"]);
    expect(new Set(first.modelAudits.flatMap(audit => audit.invocations.map(invocation => invocation.id))).size).toBe(4);
  });
  it("acknowledges external and idle wakeups without creating model work", async () => {
    const f = fixture(), configured = decisionTestProvider(), registry = await configured.registry.capture(), source = f.world.initialState;
    const initial = initialDecisionEventState(source, { decision: "world-test", creation: "world-test", fallback: "world-test" }, configured.gateway.catalog.hash, registry.hash);
    const result = await advanceProgramControls(configured.gateway, source, initial, { ...f.roster,
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, { workloadId: "idle", batchId: "idle" }, f.options);
    expect(result.control.pending).toEqual([]); expect(result.activatedAgentIds).toEqual([]);
    expect(configured.transport).not.toHaveBeenCalled();
  });
});
