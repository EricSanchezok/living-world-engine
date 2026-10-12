import { describe, expect, it } from "vitest";
import { programFixture } from "../../testing/program";
import { contentHash } from "../../models/model-audit";
import { admitProgram, bindProgram, evaluateExpression, type ProgramDefinition, type ProgramResources } from "../definition";
import { ProgramInterpreter, type ProgramAttemptWork, type ProgramPredicateWork, type ProgramReceipt } from "../interpreter";


function resolve(interpreter: ProgramInterpreter, resources: ProgramResources, work: ProgramPredicateWork, verdict: "yes" | "no" | "unknown", time = 0) {
  interpreter.resolve(work, resources, verdict, contentHash({ work, verdict }), time);
}
function start(fixture: ReturnType<typeof programFixture>) {
  const work = fixture.interpreter.work(fixture.resources, 0)[0] as ProgramPredicateWork;
  resolve(fixture.interpreter, fixture.resources, work, "yes");
  for (const work of fixture.interpreter.work(fixture.resources, 0)) if (work.kind === "predicate") {
    resolve(fixture.interpreter, fixture.resources, work, work.mechanicalVerdict ?? "unknown");
  }
}
function settle(fixture: ReturnType<typeof programFixture>, status: ProgramReceipt["status"], time: number) {
  const work = fixture.interpreter.work(fixture.resources, time).find(work => work.kind === "attempt") as ProgramAttemptWork;
  const requestHash = fixture.interpreter.issue(work, fixture.resources, time);
  const receipt: ProgramReceipt = { id: contentHash({ work, time, status }), instanceId: "instance-a", workId: work.id, requestHash,
    atSeconds: time + 1, status, eventIds: [`event-${time}`], effectHash: contentHash(status), madeProgress: status === "succeeded" };
  fixture.receipts.set(receipt.id, receipt); fixture.interpreter.settle(receipt.id, fixture.receipts, fixture.resources);
  return receipt;
}

describe("private program admission", () => {
  it("binds source contents and rejects wrong owners, nonexistent goals, inaccessible reads and invalid target parameters", () => {
    const fixture = programFixture();
    for (const mutate of [
      (definition: ProgramDefinition) => { definition.owner.agentId = "agent-b"; },
      (definition: ProgramDefinition) => { definition.goals[0]!.goalId = "claim-pretending-to-be-goal"; },
      (definition: ProgramDefinition) => { definition.reads.push("agent-b:hidden"); },
      (definition: ProgramDefinition) => { definition.parameters.recipient!.kind = "text"; },
      (definition: ProgramDefinition) => { definition.predicates[0]!.reads.push("missing"); },
    ]) {
      const definition = structuredClone(fixture.definition); mutate(definition);
      expect(() => admitProgram(definition, fixture.admission)).toThrow();
    }
    const changed = admitProgram(fixture.definition, { ...fixture.admission, sources: new Map([["goal:delivery", contentHash("changed")]]) });
    expect(changed.hash).not.toBe(fixture.program.hash);
    expect(() => bindProgram(fixture.program, { recipient: "claim:accepted" }, fixture.entities)).toThrow("invalid entity");
  });
  it("rejects cycles, unreachable nodes and missing completion predicates", () => {
    const fixture = programFixture();
    for (const nodes of [
      [{ id: "root", kind: "sequence" as const, children: ["root"] }],
      [...fixture.definition.nodes, { id: "unused", kind: "finish" as const }],
    ]) expect(() => admitProgram({ ...fixture.definition, nodes }, fixture.admission)).toThrow();
    expect(() => admitProgram({ ...fixture.definition, goals: [{ goalId: "deliver", predicateId: "missing" }] }, fixture.admission)).toThrow("unknown predicate");
    expect(() => admitProgram({ ...fixture.definition, interrupts: [fixture.definition.startPredicateId] }, fixture.admission))
      .toThrow("startPredicateId cannot also interrupt");
  });
  it("computes finite arithmetic in code", () => {
    expect(evaluateExpression({ kind: "arithmetic", operation: "subtract", values: [{ kind: "parameter", name: "stock" }, { kind: "literal", value: 3 }] }, { stock: 8 }, {})).toBe(5);
    expect(() => evaluateExpression({ kind: "arithmetic", operation: "divide", values: [{ kind: "literal", value: 1 }, { kind: "literal", value: 0 }] }, {}, {})).toThrow("finite");
  });
});

describe("persistent program interpreter", () => {
  it("binds semantic conditions and wake subscriptions to the actual private evidence envelope", () => {
    const fixture = programFixture();
    fixture.definition.predicates[0]!.test = { kind: "semantic", instructions: "Is the recipient available here?" };
    fixture.program = admitProgram(fixture.definition, fixture.admission);
    fixture.interpreter = new ProgramInterpreter(fixture.program, "instance-a", fixture.parameters, fixture.entities);
    const resources: ProgramResources = { ...fixture.resources,
      self: { version: 1, value: { location: "local-bay" } },
      containment: { version: 2, value: [{ entity: "local-peer", container: "local-bay" }] },
      observations: { version: 3, value: ["An actual delivery was observed."] },
    };
    const initial = fixture.interpreter.work(resources, 0).find(work => work.kind === "predicate") as ProgramPredicateWork;
    expect(initial.state).toMatchObject({ self: resources.self, containment: resources.containment,
      observations: resources.observations });
    expect(fixture.interpreter.subscriptions(resources, 0).resources).toContain("observations");
    const changed: ProgramResources = { ...resources, observations: { version: 4, value: ["The peer explicitly refused."] } };
    expect(() => resolve(fixture.interpreter, changed, initial, "yes")).toThrow("stale");
  });
  it("waits without polling, rejects stale evidence and keeps execution, milestone and goal completion distinct", () => {
    const fixture = programFixture(); start(fixture); settle(fixture, "succeeded", 0);
    const wait = fixture.interpreter.work(fixture.resources, 1).find(work => work.kind === "predicate" && work.reason === "flow") as ProgramPredicateWork;
    resolve(fixture.interpreter, fixture.resources, wait, "unknown", 1);
    expect(fixture.interpreter.work(fixture.resources, 10)).toEqual([]);
    fixture.resources.contact = { version: 1, value: { reply: "I accept" } };
    expect(() => resolve(fixture.interpreter, fixture.resources, wait, "yes", 10)).toThrow("stale");
    for (const work of fixture.interpreter.work(fixture.resources, 10)) if (work.kind === "predicate") resolve(fixture.interpreter, fixture.resources, work, "yes", 10);
    expect(fixture.interpreter.completion.milestones).toHaveProperty("terms-accepted");
    settle(fixture, "succeeded", 10);
    expect(fixture.interpreter.status).toBe("ended");
    expect(fixture.interpreter.completion.goals).toEqual({});
    fixture.resources.task = { version: 1, value: { delivered: true } };
    const goal = fixture.interpreter.work(fixture.resources, 11)[0] as ProgramPredicateWork;
    resolve(fixture.interpreter, fixture.resources, goal, "yes", 11);
    expect(fixture.interpreter.completion.goals).toHaveProperty("deliver");
  });

  it("restarts with the exact frontier and never issues a settled attempt twice", () => {
    const fixture = programFixture(); start(fixture);
    const receipt = settle(fixture, "succeeded", 0);
    const restored = ProgramInterpreter.restore(fixture.interpreter.snapshot(), fixture.program, fixture.entities, fixture.receipts);
    expect(restored.snapshot()).toEqual(fixture.interpreter.snapshot());
    expect(restored.work(fixture.resources, 1)).toEqual(fixture.interpreter.work(fixture.resources, 1));
    expect(() => restored.settle(receipt.id, fixture.receipts, fixture.resources)).toThrow("already settled");
    expect(() => ProgramInterpreter.restore(fixture.interpreter.snapshot(), fixture.program, fixture.entities, new Map())).toThrow("canonical receipt");
  });

  it("persists an issued attempt before its receipt and rejects a receipt for different work", () => {
    const fixture = programFixture(); start(fixture);
    const work = fixture.interpreter.work(fixture.resources, 0)[0] as ProgramAttemptWork;
    fixture.interpreter.issue(work, fixture.resources, 0);
    const restored = ProgramInterpreter.restore(fixture.interpreter.snapshot(), fixture.program, fixture.entities, fixture.receipts);
    expect(restored.work(fixture.resources, 0)).toEqual([]);
    const receipt: ProgramReceipt = { id: contentHash("bad"), instanceId: "other", workId: work.id, requestHash: contentHash("bad"),
      status: "succeeded", atSeconds: 1, eventIds: ["event"], effectHash: contentHash("effects"), madeProgress: true };
    expect(() => restored.settle(receipt.id, new Map([[receipt.id, receipt]]), fixture.resources)).toThrow("does not settle");
  });

  it("retains partial completion and rearms only after a relevant change with a new work identity", () => {
    const fixture = programFixture(); start(fixture); const receipt = settle(fixture, "partial", 0);
    expect(fixture.interpreter.work(fixture.resources, 1)).toEqual([]);
    fixture.resources.contact = { version: 1, value: { reply: "please repeat" } };
    const work = fixture.interpreter.work(fixture.resources, 1).find(work => work.kind === "attempt")!;
    expect(work.id).not.toBe(receipt.workId);
    expect(fixture.interpreter.completion.executionEnded).toBe(false);
  });

  it("starts a wait deadline when that node is reached, and preserves interruption across restart", () => {
    const fixture = programFixture(); start(fixture); settle(fixture, "succeeded", 100);
    expect(fixture.interpreter.work(fixture.resources, 101).some(work => work.kind === "deadline")).toBe(false);
    fixture.interpreter.interrupt("new hazard", 102);
    const restored = ProgramInterpreter.restore(fixture.interpreter.snapshot(), fixture.program, fixture.entities, fixture.receipts);
    expect(restored.work(fixture.resources, 102)).toEqual([]); restored.resume(130);
    expect(restored.work(fixture.resources, 130).some(work => work.kind === "deadline")).toBe(false);
    const deadline = restored.work(fixture.resources, 131).find(work => work.kind === "deadline") as ProgramAttemptWork;
    restored.expire(deadline, 131);
    expect(restored.status).toBe("needs-expansion");
  });

  it("authors testimony before action dispatch", () => {
    const fixture = programFixture(); const definition = structuredClone(fixture.definition);
    const ask = definition.nodes.find(node => node.id === "ask")!;
    if (ask.kind !== "attempt") throw new Error("fixture"); ask.speech = { kind: "create", purpose: "Make a delivery promise" };
    fixture.program = admitProgram(definition, fixture.admission);
    fixture.interpreter = new ProgramInterpreter(fixture.program, "instance-a", fixture.parameters, fixture.entities); start(fixture);
    const work = fixture.interpreter.work(fixture.resources, 0)[0] as ProgramAttemptWork;
    expect(work.kind).toBe("utterance"); expect(() => fixture.interpreter.issue(work, fixture.resources, 0)).toThrow("creation");
    fixture.interpreter.supplyUtterance(work, "I promise to deliver it personally.", fixture.resources, 0);
    const attempt = fixture.interpreter.work(fixture.resources, 0)[0] as ProgramAttemptWork;
    expect(attempt.utterance).toBe("I promise to deliver it personally.");
    fixture.interpreter.issue(attempt, fixture.resources, 0);
  });

  it("stops an unchanged repeat loop without another decision and advances independent parallel attempts", () => {
    const fixture = programFixture();
    const loop = admitProgram({ ...fixture.definition, entry: "loop", nodes: [
      { id: "loop", kind: "repeat", predicateId: "accepted", body: "finish" }, { id: "finish", kind: "finish" },
    ] }, fixture.admission);
    fixture.program = loop; fixture.interpreter = new ProgramInterpreter(loop, "instance-a", fixture.parameters, fixture.entities); start(fixture);
    const work = fixture.interpreter.work(fixture.resources, 1).find(work => work.kind === "predicate" && work.reason === "flow");
    // start() already resolved the first loop guard as unknown; new evidence wakes it once.
    expect(work).toBeUndefined();
    fixture.resources.contact = { version: 1, value: { reply: "yes" } };
    for (const ticket of fixture.interpreter.work(fixture.resources, 1)) if (ticket.kind === "predicate") resolve(fixture.interpreter, fixture.resources, ticket, "yes", 1);
    expect(fixture.interpreter.work(fixture.resources, 1)).toEqual([]);
    expect(fixture.interpreter.subscriptions(fixture.resources, 1).reason).toBe("no-progress");
    const definition = structuredClone(programFixture().definition);
    definition.nodes = [ { id: "root", kind: "parallel", children: ["ask", "trade"] }, ...definition.nodes.filter(node => node.kind === "attempt") ];
    const parallel = new ProgramInterpreter(admitProgram(definition, fixture.admission), "parallel", fixture.parameters, fixture.entities);
    const first = parallel.work(fixture.resources, 1)[0] as ProgramPredicateWork; resolve(parallel, fixture.resources, first, "yes", 1);
    expect(parallel.work(fixture.resources, 1).filter(work => work.kind === "attempt")).toHaveLength(2);
  });
});
