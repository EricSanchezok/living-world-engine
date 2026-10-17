import path from "node:path";
import AdmZip from "adm-zip";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate, parseWorldTemplate } from "../../../script/world-loader";
import { parseWorldArchive } from "../../../server/world-import";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { applyTransitionProposal, applyWorldDeltaOperation, replaySimulationState, validateSimulationState } from "../../runtime/transaction";
import type { PolicyBinding } from "../../runtime/execution";
import { directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { nextWorldClockBoundary } from "../clock";
import { nextPeriodicBoundary, periodicFact } from "../../mechanics/periodic-properties";

function template() {
  const result = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  const property = { id: "courtyard-daylight", subject_id: "courtyard", predicate: "daylight",
    access: { kind: "public" as const }, period_seconds: 86400, initial_phase_seconds: 54000,
    phases: [{ starts_at_seconds: 0, value: { kind: "text" as const, value: "day" }, description: "阳光照在院子里。" },
      { starts_at_seconds: 43200, value: { kind: "text" as const, value: "night" }, description: "院子上空是夜色。" }] };
  result.mechanics.periodic_properties = [property,
    { ...property, id: "private-cycle", predicate: "hidden-phase", access: { kind: "private" },
      phases: property.phases.map(phase => ({ ...phase, description: "不可见的封闭实验周期。" })) }];
  result.entities.push({ ...structuredClone(result.entities.find(entity => entity.id === "courtyard")!), id: "distant-realm", name: "远地", facts: [] });
  result.mechanics.periodic_properties.push({ ...property, id: "distant-daylight", subject_id: "distant-realm", period_seconds: 345600,
    initial_phase_seconds: 194400, phases: [{ ...property.phases[0]!, description: "远地七曜炽热。" },
      { ...property.phases[1]!, starts_at_seconds: 172800, description: "远地七曜清冷。" }] });
  return parseWorldTemplate(result);
}

async function fixture() {
  const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
    const values: Record<string, string> = { operation: "observe", target: "none", tool: "none", recipient: "none", observation_scope: "surroundings",
      resource: "none", amount: "unknown", timing: "default", duration: "d0", interruption: "none", goal: "none", speech: "none",
      progress_next: "complete", interaction: "world_action" };
    const value = values[id] ?? (id.includes("outcome") ? "succeeded" : id.includes("visible") ? "visible"
      : id.includes("belief_status") ? "unchanged" : id.includes("goal_status") ? "partial" : id.includes("fact") ? "unchanged"
      : id.includes("duration") ? "planned" : "none");
    return [id, nativeAnswer(question, id === "expression" ? 0 : value)];
  })));
  await f.registry.capture();
  const authored = template(), archive = new AdmZip();
  for (const [file, value] of [["script.yaml", authored.manifest], ["mechanics.yaml", authored.mechanics], ["laws.yaml", authored.laws],
    ...authored.entities.map(entity => [`entities/${entity.id}.yaml`, entity] as const)] as const) archive.addFile(file, Buffer.from(stringify(value)));
  if (authored.participation) archive.addFile("participation.yaml", Buffer.from(stringify(authored.participation)));
  const imported = parseWorldArchive(archive.toBuffer(), f.catalog);
  const world = buildWorldDefinition(authored, { seed: 7, modelCatalog: f.catalog });
  expect(imported.contentHash).toBe(world.contentHash);
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: false });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = Object.fromEntries(Object.keys(world.initialState.agents).map(agentId => [agentId,
    { kind: "external", participantId: "operator", agentId }]));
  await engine.bootstrapAgents();
  const request = (text: string, submissionId: string) => ({ expectedRevision: engine.snapshot.revision, trigger: "participant_action" as const,
    externalActions: [{ agentId: "player", submissionId, rawText: text, goal: "看清院子", means: null, targetIds: [] }] });
  return { ...f, world, engine, roster, request };
}

describe("authored periodic properties through world import and simulation", () => {
  it("advances an unobserved phase without a model call and preserves earlier observations", async () => {
    const f = await fixture();
    const initial = await f.engine.step(f.roster, f.request("用一秒看看院子", "night"));
    expect(initial.state.truth.elapsedSeconds).toBe(1);
    const oldObservation = structuredClone(initial.committed.observations);
    expect(JSON.stringify(oldObservation)).toContain("夜色");
    const calls = f.transport.mock.calls.length;
    const clock = await f.engine.step(f.roster, { expectedRevision: initial.state.revision, trigger: "manual", externalActions: [] });
    expect(clock.state.truth.elapsedSeconds).toBe(32400);
    expect(clock.state.truth.facts["courtyard-daylight"]!.value).toEqual({ kind: "text", value: "day" });
    expect(clock.state.truth.facts["distant-daylight"]!.value).toEqual({ kind: "text", value: "night" });
    expect(clock.committed.observations).toEqual([]);
    expect(f.transport.mock.calls.length).toBe(calls);
    const day = await f.engine.step(f.roster, f.request("用一秒看看院子", "day"));
    expect(JSON.stringify(day.committed.observations)).toContain("阳光照在院子里");
    expect(JSON.stringify(day.committed.observations)).not.toContain("不可见的封闭实验周期");
    expect(JSON.stringify(day.committed.observations)).not.toContain("远地七曜");
    expect(day.state.history[0]!.observations).toEqual(oldObservation);
    expect(replaySimulationState(day.state)).toEqual(day.state);
  });

  it("settles a long observation with the value at its actual completion boundary", async () => {
    const f = await fixture();
    const boundary = await f.engine.step(f.roster, f.request("观察院子十小时", "long-look"));
    expect(boundary.state.truth.elapsedSeconds).toBe(32400);
    expect(boundary.committed.observations).toEqual([]);
    const completed = await f.engine.step(f.roster, { expectedRevision: boundary.state.revision, trigger: "manual", externalActions: [] });
    expect(completed.state.truth.elapsedSeconds).toBe(36000);
    expect(JSON.stringify(completed.committed.observations)).toContain("阳光照在院子里");
    expect(JSON.stringify(completed.committed.observations)).not.toContain("院子上空是夜色");
    expect(replaySimulationState(completed.state)).toEqual(completed.state);
  });

  it("rejects invalid cycles, missing references and collisions on import", async () => {
    const f = await fixture();
    for (const corrupt of [
      (t: ReturnType<typeof template>) => { t.mechanics.periodic_properties[0]!.phases[1]!.starts_at_seconds = 0; },
      (t: ReturnType<typeof template>) => { t.mechanics.periodic_properties[0]!.initial_phase_seconds = 86400; },
      (t: ReturnType<typeof template>) => { t.mechanics.periodic_properties[0]!.subject_id = "missing"; },
      (t: ReturnType<typeof template>) => { t.mechanics.periodic_properties.push(structuredClone(t.mechanics.periodic_properties[0]!)); },
      (t: ReturnType<typeof template>) => { t.mechanics.periodic_properties[0]!.id = "gate-lock"; },
    ]) {
      const t = template(); corrupt(t);
      expect(() => buildWorldDefinition(t, { modelCatalog: f.catalog })).toThrow();
    }
  });

  it("keeps clock-owned facts immutable, validates drift and rolls back a failed transaction", async () => {
    const f = await fixture(), state = f.world.initialState, source = structuredClone(state), fact = state.truth.facts["courtyard-daylight"]!;
    const causes = [{ kind: "mechanic" as const, id: "clock-test" }];
    const assertions = [{ kind: "elapsed_seconds_compare" as const, operator: "gte" as const, value: 0 }];
    expect(() => applyWorldDeltaOperation(state, { kind: "set_fact", fact: { ...fact, value: { kind: "text", value: "wrong" } }, causes, assertions })).toThrow("clock-owned");
    expect(() => applyWorldDeltaOperation(state, { kind: "remove_fact", factId: fact.id, causes, assertions })).toThrow("clock-owned");
    expect(() => applyWorldDeltaOperation(state, { kind: "set_fact", fact: { ...fact, id: "replacement" }, causes, assertions })).toThrow("clock-owned");
    expect(() => applyTransitionProposal(state, { baseRevision: 0, outcomes: [], mechanicInvocations: [], observations: [], decisionRequests: [], events: [], operations: [
      { kind: "advance_time", seconds: 32400, causes, assertions }, { kind: "remove_fact", factId: fact.id, causes, assertions },
    ] })).toThrow("clock-owned");
    expect(state).toEqual(source);
    const gate = state.truth.facts["gate-lock"]!;
    const advanced = applyTransitionProposal(state, { baseRevision: 0, outcomes: [], mechanicInvocations: [], observations: [], decisionRequests: [], events: [], operations: [
      { kind: "set_fact", fact: { ...gate, value: { kind: "text", value: "open" } }, causes, assertions },
      { kind: "advance_time", seconds: 32400, causes, assertions },
    ] });
    expect(advanced.truth.facts[gate.id]!.value).toEqual({ kind: "text", value: "open" });
    expect(advanced.truth.facts[fact.id]!.value).toEqual({ kind: "text", value: "day" });
    const drift = structuredClone(state); drift.truth.facts[fact.id]!.value = { kind: "text", value: "wrong" };
    expect(() => validateSimulationState(drift, false)).toThrow("periodic property drift");
    const property = state.truth.mechanics.periodicProperties["courtyard-daylight"]!;
    expect(periodicFact(property, 32400 + 86400 * 30).value).toEqual({ kind: "text", value: "day" });
    expect(nextWorldClockBoundary(state)).toBe(32400);
    expect(() => nextPeriodicBoundary(property, Number.MAX_SAFE_INTEGER)).toThrow("overflow");
  });
});
