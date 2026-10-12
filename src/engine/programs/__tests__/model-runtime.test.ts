import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelGateway } from "../../models/model-gateway";
import { parseModelCatalog } from "../../models/model-catalog";
import { contentHash } from "../../models/model-audit";
import { createTestModelCatalog, createTestModelRegistry } from "../../testing/model-provider";
import { programFixture } from "../../testing/program";
import { compileAgentProgram, type ProgramCompilationRequest } from "../compiler";
import { DecisionRuntime, resolveProgramPredicates } from "../decision-runtime";
import { privateProgramResources } from "../private-resources";
import { loadWorldScript } from "../../../script/world-loader";
import { projectAgentPerspective } from "../../cognition/agent-perspective";
import { ProgramInterpreter, type ProgramPredicateWork } from "../interpreter";
import type { DecisionBatch } from "../../models/decision";
import { ProgramLibrary } from "../library";
import { admitProgram } from "../definition";

function provider(output: (body: Record<string, unknown>, attempt: number) => unknown) {
  const base = createTestModelCatalog(["program-test"]);
  const catalog = parseModelCatalog({ schema_version: 3, scheduler: base.scheduler, registry: base.registry, accounts: base.accounts,
    profiles: { "program-test": { ...base.profile("program-test"), allowed_roles: ["decision", "creation"] } } });
  const registry = createTestModelRegistry(catalog);
  let calls = 0;
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    const value = output(body, ++calls);
    return Response.json({ id: `request-${calls}`, model: "scripted:program-test", created: 1,
      choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(value) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  });
  return { gateway: new ModelGateway(catalog, { TEST_MODEL_API_KEY: "private-test-key" }, { registry, fetch: transport }), transport, registry };
}
function compilation(): ProgramCompilationRequest {
  const fixture = programFixture();
  return { workloadId: "compiler-test", batchId: "compiler-test", profileId: "program-test", ownerId: "agent-a", goalId: "deliver",
    intent: "Deliver after agreed trade", reason: "initial-coverage", perspective: { agentId: "agent-a", goal: "Deliver" },
    resources: Object.fromEntries(Object.entries(fixture.resources).map(([key, value]) => [key, value.value])),
    sources: { "goal:delivery": "deliver" }, goalIds: ["deliver"], entityIds: [...fixture.entities], invocationBase: 1,
    runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 0 } };
}
function batch(): DecisionBatch {
  const state = { answer: "No evidence of acceptance" };
  return { version: 1, view: { kind: "agent", agentId: "agent-a", projectionHash: contentHash(state) }, state,
    programHash: contentHash("program"), dependencies: { reply: 0 }, questions: { consent: { version: "1", sources: ["goal:trade"],
      instructions: "Did the other party accept?", criteria: { yes: "Accepted", unknown: "Insufficient evidence" } } } };
}

describe("program compilation through the model gateway", () => {
  it("indexes only the owner's immutable programs and reports actual startup coverage", async () => {
    const fixture = programFixture();
    const configured = provider(() => ({ definition: fixture.definition, parameters: fixture.parameters }));
    const result = await compileAgentProgram(configured.gateway, compilation());
    if (result.status !== "ready") throw new Error(result.reason);
    const library = new ProgramLibrary(); library.add(result);
    expect(library.forOwner("agent-b")).toEqual([]);
    expect(() => library.get("agent-b", result.program.hash, fixture.admission, fixture.entities)).toThrow("unavailable");
    expect(library.coverage("agent-a", ["deliver", "uncovered"], [fixture.interpreter], fixture.resources, 0).map(row => row.status))
      .toEqual(["needs-decision", "needs-generation"]);
    const start = fixture.interpreter.work(fixture.resources, 0)[0] as ProgramPredicateWork;
    fixture.interpreter.resolve(start, fixture.resources, "yes", contentHash(start), 0);
    expect(library.coverage("agent-a", ["deliver"], [fixture.interpreter], fixture.resources, 0)[0]!.status).toBe("startable");
    const restored = new ProgramLibrary(library.snapshot());
    expect(restored.get("agent-a", result.program.hash, fixture.admission, fixture.entities).parameters).toEqual(fixture.parameters);
    expect(() => restored.get("agent-a", result.program.hash, { ...fixture.admission,
      sources: new Map([["goal:delivery", contentHash("changed")]]) }, fixture.entities)).toThrow("sources changed");
  });
  it("repairs an invalid goal target once with exact rejection evidence", async () => {
    const fixture = programFixture();
    const { gateway, transport } = provider((body, attempt) => {
      if (attempt === 2) {
        expect(JSON.stringify(body.messages)).toContain("invalid entity parameter recipient");
        expect(JSON.stringify(body.messages)).toContain("claim-not-an-entity");
      }
      return { definition: fixture.definition, parameters: { recipient: attempt === 1 ? "claim-not-an-entity" : "local:recipient" } };
    });
    const result = await compileAgentProgram(gateway, compilation());
    expect(result.status).toBe("ready"); expect(transport).toHaveBeenCalledTimes(2);
    expect(result.audit?.invocations.map(invocation => invocation.outputDisposition)).toEqual(["rejected", "llm-repaired"]);
    if (result.status === "ready") expect(result.program.hash).toBe(fixture.program.hash);
  });
  it("retains a recoverable failure after one unsuccessful repair and rejects foreign perspective before dispatch", async () => {
    const fixture = programFixture();
    const { gateway, transport } = provider(() => ({ definition: fixture.definition, parameters: { recipient: "invalid" } }));
    const result = await compileAgentProgram(gateway, compilation());
    expect(result).toMatchObject({ status: "failed", recoverable: true, ownerId: "agent-a", goalId: "deliver" });
    expect(result.audit?.invocations).toHaveLength(2); expect(transport).toHaveBeenCalledTimes(2);
    await expect(compileAgentProgram(gateway, { ...compilation(), perspective: { agentId: "agent-b" } })).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

describe("versioned decision reuse", () => {
  it("reuses a proved condition across milestone, wait and later branch after restart", async () => {
    const fixture = programFixture();
    fixture.definition.nodes = [
      { id: "root", kind: "sequence", children: ["wait", "branch"] },
      { id: "wait", kind: "wait", predicateId: "accepted", deadlineSeconds: null },
      { id: "branch", kind: "branch", predicateId: "accepted", yes: "yes", no: "no" },
      { id: "yes", kind: "finish" }, { id: "no", kind: "finish" },
    ];
    const program = admitProgram(fixture.definition, fixture.admission);
    let interpreter = new ProgramInterpreter(program, "reuse-condition", fixture.parameters, fixture.entities);
    const configured = provider(() => ({ answers: { q0: { choice: "yes" } } }));
    const registry = await configured.registry.capture(); let ordinal = 1;
    const scope = { ...compilation(), modelRegistrySnapshotHash: registry.hash, nextInvocation: () => ordinal++ };
    const runtime = new DecisionRuntime(configured.gateway);
    await resolveProgramPredicates(runtime, interpreter, fixture.resources, 0, scope);
    await resolveProgramPredicates(runtime, interpreter, fixture.resources, 0, scope);
    expect(configured.transport).toHaveBeenCalledTimes(1);
    interpreter = ProgramInterpreter.restore(interpreter.snapshot(), program, fixture.entities, fixture.receipts);
    const reused = await resolveProgramPredicates(new DecisionRuntime(configured.gateway), interpreter, fixture.resources, 0, scope);
    expect(reused.decisions).toEqual([]);
    expect(configured.transport).toHaveBeenCalledTimes(1);
    expect(interpreter.status).toBe("ended");
    expect(interpreter.snapshot().events.some(event => event.kind === "predicate" && event.reusedFrom !== null)).toBe(true);
    expect(interpreter.completion.goals).toEqual({});
  });
  it("coalesces identical authorized requests and restores references without new model invocations", async () => {
    const configured = provider(() => ({ answers: { consent: { choice: "unknown" } } }));
    const registry = await configured.registry.capture();
    const runtime = new DecisionRuntime(configured.gateway);
    const request = { ...compilation(), subjectId: "agent-a", batch: batch(), modelRegistrySnapshotHash: registry.hash };
    const [first, second] = await Promise.all([runtime.decide(request), runtime.decide(request)]);
    expect(first.reused).toBe(false); expect(second.reused).toBe(true); expect(configured.transport).toHaveBeenCalledTimes(1);
    const restored = new DecisionRuntime(configured.gateway, runtime.snapshot());
    const cached = await restored.decide(request);
    expect(cached.evidenceHash).toBe(first.evidenceHash); expect(cached.reused).toBe(true);
    const changed = structuredClone(request); changed.batch.dependencies.reply = 1;
    await restored.decide(changed); expect(configured.transport).toHaveBeenCalledTimes(2);
    await expect(restored.decide({ ...request, subjectId: "agent-b" })).rejects.toThrow("ownership");
    const snapshot = runtime.snapshot(); snapshot.hash = contentHash("tampered");
    expect(() => new DecisionRuntime(configured.gateway, snapshot)).toThrow("checksum");
  });
  it("does not persist reuse when the registry snapshot is unpinned", async () => {
    const configured = provider(() => ({ answers: { consent: { choice: "unknown" } } }));
    const runtime = new DecisionRuntime(configured.gateway), request = { ...compilation(), subjectId: "agent-a", batch: batch() };
    await runtime.decide(request); await runtime.decide(request);
    expect(configured.transport).toHaveBeenCalledTimes(2); expect(runtime.snapshot().entries).toEqual([]);
  });
  it("evaluates arithmetic locally and batches each distinct semantic condition once", async () => {
    const fixture = programFixture();
    const configured = provider(body => {
      expect(JSON.stringify(body.messages)).not.toContain("another-agent-secret");
      return { answers: { q0: { choice: "unknown" } } };
    });
    const registry = await configured.registry.capture(); let ordinal = 1;
    const scope = { ...compilation(), modelRegistrySnapshotHash: registry.hash, nextInvocation: () => ordinal++ };
    const runtime = new DecisionRuntime(configured.gateway);
    const first = await resolveProgramPredicates(runtime, fixture.interpreter, fixture.resources, 0, scope);
    expect(first.decisions).toEqual([]); expect(first.mechanicalEvidence).toHaveLength(1);
    const second = await resolveProgramPredicates(runtime, fixture.interpreter, fixture.resources, 0, scope);
    expect(second.decisions).toHaveLength(1); expect(second.mechanicalEvidence).toHaveLength(1);
    const third = await resolveProgramPredicates(runtime, fixture.interpreter, fixture.resources, 0, scope);
    expect(third.decisions).toEqual([]); expect(configured.transport).toHaveBeenCalledTimes(1);
    expect(fixture.interpreter.completion.goals).toEqual({});
  });
});

describe("private program resource projection", () => {
  it("preserves authorized information while unrelated revisions leave dependencies unchanged", () => {
    const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { modelCatalog: createTestModelCatalog() });
    const state = world.initialState, view = projectAgentPerspective(state, state.agents.player!);
    const first = privateProgramResources(view);
    expect(JSON.stringify(first)).not.toContain("钥匙是仿制品");
    expect(JSON.stringify(first)).not.toContain("canonicalEntityIds");
    const second = privateProgramResources({ ...view, revision: 10, step: 8 }, first);
    expect(second).toEqual(first);
    const third = privateProgramResources({ ...view, elapsedSeconds: 30 }, second);
    expect(third.resources.clock!.version).toBe(1);
    for (const key of Object.keys(first.resources).filter(key => key !== "clock")) expect(third.resources[key]).toEqual(first.resources[key]);
    expect(() => privateProgramResources({ ...view, agentId: "another" }, first)).toThrow("owner");
  });
  it("reports no-progress repeats and subscriptions without short checkpoint polling", () => {
    const fixture = programFixture();
    const start = fixture.interpreter.work(fixture.resources, 0)[0] as ProgramPredicateWork;
    fixture.interpreter.resolve(start, fixture.resources, "yes", contentHash(start), 0);
    const restored = ProgramInterpreter.restore(fixture.interpreter.snapshot(), fixture.program, fixture.entities, fixture.receipts);
    expect(restored.subscriptions(fixture.resources, 0).resources).toEqual(["contact", "goal:deliver", "self", "task"]);
    expect(restored.subscriptions(fixture.resources, 0).deadline).toBeNull();
  });
});
