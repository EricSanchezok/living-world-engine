import { withNoStimulusCompletion, noStimulusReportsForTargets } from "../../testing/model-provider";
import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { loadWorldScript } from "../../../script/world-loader";
import type { OnsetPerceptionInput } from "../../algorithms/roles";
import { perceptionDirectiveSchema } from "../../contracts/llm-schemas";
import type { ModelReferenceCatalog } from "../../contracts/model-context";
import { buildTruthContext, createTruthReferenceResolver } from "../../contracts/prompts";
import { contentHash } from "../../models/model-audit";
import { createModelGateway } from "../../models/model-gateway";
import { loadPromptAsset, promptBundle } from "../../prompts";
import { ScriptedModelProvider, createTestModelRegistry, type ScriptedModelHandler } from "../../testing/model-provider";
import { selectTemporalBoundary } from "../temporal";
import { TruthEngine } from "../truth-engine";

function fixture(handler: ScriptedModelHandler, repairAttempts = 0) {
  const provider = new ScriptedModelProvider(withNoStimulusCompletion(handler), undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const state = structuredClone(definition.initialState);
  const input: OnsetPerceptionInput = {
    definition, state, identityOwner: "perception-component", groundings: [],
    actions: [{ id: "inspect-key", actorId: "player", baseRevision: state.revision,
      rawText: "Examine the key's teeth without trying the lock.", goal: "See whether its teeth are worn", means: "Look closely", targetIds: ["copper-key"] }],
    temporalBoundary: selectTemporalBoundary({ elapsedSeconds: state.truth.elapsedSeconds, maxAutonomousSpanSeconds: 1,
      activities: {}, timers: {}, conditionExpiries: {} }),
  };
  const scope = { workloadId: "perception-world", batchId: "perception-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  return { provider, input, scope, run: () => new TruthEngine(provider, { repairAttempts }).perceiveOnset(input, scope) };
}

function request(overrides: Record<string, unknown> = {}) {
  return { proposalKey: "inspect-teeth", actorRef: "ref:entity:player", targetRef: "ref:entity:key",
    ratingRef: "ref:rating:resolve:player",
    difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:time-passes" } },
    mode: "normal", stakes: "Whether the existing wear on the key's teeth can be seen without using the lock.", visibility: "full",
    causes: [{ kind: "action", ref: "ref:action:inspect-key" }], ...overrides };
}

function directive(check: Record<string, unknown>) { return { kind: "request_checks", requests: [check] }; }

const independentStakes = [
  "Whether the keeper sees wear on the key's teeth while the player examines it.",
  "Whether the keeper sees the key's engraving while the player examines it.",
  "Whether the keeper sees corrosion on the key's shaft while the player examines it.",
];

it.each(["references", "schema"])("retains independent perception diagnostics after a gateway %s rejection", async mode => {
  const good = independentStakes.map((stakes, i) => request({ proposalKey: `notice-${i}`, stakes, actorRef: "ref:entity:keeper", ratingRef: "ref:rating:resolve:keeper" }));
  const bad = structuredClone(good);
  Object.assign(bad[0]!, { ratingRef: "ref:rating:resolve:ghost" });
  Object.assign(bad[1]!, { ratingRef: "ref:rating:resolve:player" });
  Object.assign(bad[2]!, { actorRef: "ref:entity:player", ratingRef: "ref:rating:resolve:player" });
  const rejected = mode === "references" ? { kind: "request_checks", requests: bad } : { kind: "request_checks", requests: "malformed" };
  const repaired = fixture(() => ({ kind: "done" }), 1);
  repaired.input.perceptionTargets = [{ observerId: "keeper", sourceActionId: "inspect-key" }];
  const before = contentHash(repaired.input), contexts: unknown[] = [], bodies: string[] = [];
  let calls = 0;
  const catalog = repaired.provider.catalog;
  const gateway = createModelGateway(catalog, { TEST_MODEL_API_KEY: "test-only" }, {
    registry: createTestModelRegistry(catalog), maxTransportAttempts: 1,
    fetchForAccount: () => async (_url, init) => {
      bodies.push(String(init?.body));
      const output = calls++ === 0 ? rejected : calls === 2 ? { kind: "request_checks", requests: good } : { kind: "done", reports: noStimulusReportsForTargets(repaired.input) };
      return new Response(JSON.stringify({ id: `perception-diagnostics-${calls}`, model: "scripted:truth-deepseek",
        choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify(output) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  repaired.provider.generateStructured = request => { contexts.push(structuredClone(request.context)); return gateway.generateStructured(request); };
  let cleanCalls = 0;
  const clean = fixture(() => cleanCalls++ === 0 ? { kind: "request_checks", requests: good } : { kind: "done" });
  clean.input.perceptionTargets = structuredClone(repaired.input.perceptionTargets);
  const a = await clean.run(), b = await repaired.run();
  expect(calls).toBe(3);
  expect(b.requests).toEqual(a.requests); expect(b.checks).toEqual(a.checks); expect(b.rng).toEqual(a.rng);
  expect(contentHash(repaired.input)).toBe(before);
  const repair = (contexts[1] as { repair: { previousOutput: unknown; issues: Array<{ code: string; path: unknown; allowedHandles?: string[] }> }; state: { committedCheckRequests: unknown[] } });
  expect(repair.repair.previousOutput).toEqual(rejected);
  expect(repair.state.committedCheckRequests).toEqual([]);
  if (mode === "references") {
    expect(repair.repair.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "reference.unknown_handle", path: ["requests", 0, "ratingRef"] }),
      expect.objectContaining({ code: "perception.actor_rating_owner", path: ["requests", 1, "ratingRef"], allowedHandles: ["ref:rating:resolve:keeper"] }),
      expect.objectContaining({ code: "perception.unassigned_observer", path: ["requests", 2, "actorRef"] }),
    ]));
    expect(bodies[1]).toContain("perception.actor_rating_owner");
  } else {
    expect(repair.repair.issues.some(issue => issue.code.startsWith("perception."))).toBe(false);
  }
  expect(b.modelAudit.invocations).toHaveLength(3);
  expect(b.modelAudit.invocations[0]!.outputDisposition).toBe("rejected");
  expect(b.modelAudit.invocations.every(invocation => invocation.tokenUsage.input === 100 && invocation.tokenUsage.output === 20)).toBe(true);
});

it.each(["observer", "source-action", "missing-action", "empty-assignment"])(
  "rejects a mechanically valid check outside focused work before RNG (%s)", async mode => {
    const check = request({ actorRef: mode === "observer" ? "ref:entity:player" : "ref:entity:keeper", ratingRef: null,
      causes: mode === "missing-action" ? [{ kind: "law", ref: "ref:law:time-passes" }]
        : [{ kind: "action", ref: mode === "source-action" ? "ref:action:other-action" : "ref:action:inspect-key" }] });
    const f = fixture(() => directive(check));
    f.input.actions.push({ ...structuredClone(f.input.actions[0]!), id: "other-action" });
    f.input.perceptionTargets = mode === "empty-assignment" ? [] : [{ observerId: "keeper", sourceActionId: "inspect-key" }];
    const before = contentHash(f.input);
    await expect(f.run()).rejects.toThrow(mode === "observer" || mode === "empty-assignment" ? "no assigned perception task" : "source action assigned");
    expect(f.provider.requests).toHaveLength(1);
    expect(contentHash(f.input)).toBe(before);
  },
);

it.each(["unfocused", "focused-with-extra-evidence", "coalesced"])(
  "preserves legal task scope and complete extra action evidence (%s)", async mode => {
    let calls = 0;
    const check = request({ actorRef: "ref:entity:keeper", ratingRef: null, causes: [
      { kind: "action", ref: "ref:action:inspect-key" }, { kind: "action", ref: "ref:action:other-action" },
      { kind: "law", ref: "ref:law:time-passes" },
    ] });
    const f = fixture(() => calls++ === 0 ? directive(check) : { kind: "done" });
    f.input.actions.push({ ...structuredClone(f.input.actions[0]!), id: "other-action" });
    if (mode !== "unfocused") f.input.perceptionTargets = [
      { observerId: "keeper", sourceActionId: "inspect-key" },
      ...(mode === "coalesced" ? [{ observerId: "keeper", sourceActionId: "other-action" }] : []),
    ];
    const before = contentHash(f.input), result = await f.run();
    expect(result.requests[0]!.causes).toEqual([
      { kind: "action", id: "inspect-key" }, { kind: "action", id: "other-action" }, { kind: "law", id: "time-passes" },
    ]);
    expect(result.requests[0]!.stakes).toBe(check.stakes);
    expect(contentHash(f.input)).toBe(before);
  },
);

it("collects owner, opposing-source, task and independent materialization failures into one real repair", async () => {
  const good = independentStakes.map((stakes, i) => request({ proposalKey: `notice-${i}`, stakes, actorRef: "ref:entity:keeper", ratingRef: "ref:rating:resolve:keeper", visibility: "hidden" }));
  const bad = structuredClone(good);
  Object.assign(bad[0]!, { ratingRef: "ref:rating:resolve:player", difficulty: { kind: "opposed", targetRef: "ref:entity:keeper",
    ratingRef: "ref:rating:resolve:player", source: { kind: "law", ref: "ref:law:time-passes" } } });
  Object.assign(bad[1]!, { actorRef: "ref:entity:player" });
  Object.assign(bad[2]!, { visibility: "full" });
  let calls = 0;
  const repaired = fixture(r => {
    calls++;
    if (calls === 1) return { kind: "request_checks", requests: bad };
    if (calls === 2) {
      const context = r.context as { repair: { previousOutput: unknown; issues: Array<{ code: string; path: unknown; allowedHandles: string[] }> }; state: { committedCheckRequests: unknown[] } };
      expect(context.repair.previousOutput).toEqual({ kind: "request_checks", requests: bad });
      expect(context.state.committedCheckRequests).toEqual([]);
      const issues = context.repair.issues;
      expect(issues.map(issue => issue.path)).toEqual([
        ["requests", 0, "ratingRef"], ["requests", 0, "difficulty", "ratingRef"], ["requests", 0, "difficulty", "source"],
        ["requests", 1, "actorRef"], ["requests", 1, "ratingRef"], ["requests", 2],
      ]);
      expect(issues[0]!.allowedHandles).toEqual(["ref:rating:resolve:keeper"]);
      expect(issues[1]!.allowedHandles).toEqual(["ref:rating:resolve:keeper"]);
      expect(issues[2]!.allowedHandles).toEqual(["ref:rating:resolve:keeper"]);
      expect(issues[3]!.allowedHandles).toEqual(["ref:entity:keeper"]);
      expect(issues[4]!.allowedHandles).toEqual(["ref:rating:resolve:player"]);
      return { kind: "request_checks", requests: good };
    }
    return { kind: "done" };
  }, 1);
  let cleanCalls = 0;
  const clean = fixture(() => cleanCalls++ === 0 ? { kind: "request_checks", requests: good } : { kind: "done" });
  for (const f of [clean, repaired]) {
    f.input.perceptionTargets = [{ observerId: "keeper", sourceActionId: "inspect-key" }];
    f.input.definition.disclosure.defaultCheckVisibility = "hidden";
  }
  const before = contentHash(repaired.input), a = await clean.run(), b = await repaired.run();
  expect(calls).toBe(3);
  expect(b.requests).toEqual(a.requests); expect(b.checks).toEqual(a.checks); expect(b.rng).toEqual(a.rng);
  expect(contentHash(repaired.input)).toBe(before);
});

function contextFor(input: OnsetPerceptionInput, stage: "perception" | "resolution", full = true) {
  return buildTruthContext({ definition: input.definition, state: input.state,
    workset: { ...(full ? { mode: "full" as const } : {}), state: input.state, initialActions: input.actions, availableActions: input.actions, assignedActions: input.actions,
      availableDependencies: input.groundings, assignedDependencies: input.groundings },
    reactionRequests: [], reactionDecisions: [], reactionWindow: "open", committedCheckRequests: [], checkResults: [],
    committedRandomRequests: [], randomResults: [], commitmentRounds: [], resolutionPlans: [], resolutionReceipts: [],
    perceptionTargets: input.perceptionTargets,
    temporalBoundary: input.temporalBoundary, instanceId: "perception-world", advanceId: "perception-step", issues: [], stage,
  }) as { referenceCatalog: ModelReferenceCatalog; state: Record<string, unknown> };
}

it("delivers onset-only responsibility with unchanged evidence through repair and committed-check continuation", async () => {
  let calls = 0;
  const stakes = "Whether the keeper notices the player concealing the key before choosing a reaction.";
  const check = request({ actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
    stakes });
  const f = fixture(() => {
    calls++;
    if (calls === 1) return directive({ ...check, actorRef: "ref:agent:keeper" });
    return calls === 2 ? directive(check) : { kind: "done" };
  }, 1);
  f.input.actions[0]!.rawText = "Conceal the key in my sleeve before anyone can react.";
  f.input.actions[0]!.goal = "Hide the key without being noticed";
  f.input.perceptionTargets = [{ observerId: "keeper", sourceActionId: "inspect-key" }];
  const sourceHash = contentHash(f.input), expectedContext = contextFor(f.input, "perception");
  const expectedTruth = expectedContext.state.canonicalTruth as { facts: Record<string, unknown> };
  const scopedTruth = contextFor(f.input, "perception", false).state.canonicalTruth as { facts: Record<string, unknown> };
  expect(scopedTruth.facts).not.toHaveProperty("ref:fact:courtyard-sandy-ground");
  expect(expectedTruth.facts).toHaveProperty("ref:fact:courtyard-sandy-ground");
  const result = await f.run();
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ actorId: "keeper", targetId: "player", stakes });
  expect(result.checks).toHaveLength(1);
  expect(result.rng.draws).toBeGreaterThan(f.input.state.truth.rng.draws);
  expect(contentHash(f.input)).toBe(sourceHash);
  expect(f.provider.requests).toHaveLength(3);
  for (const invocation of f.provider.requests) {
    expect(invocation.system).toBe(promptBundle("truth-perception").system);
    expect(invocation.system).toContain(loadPromptAsset("system/truth-perception.md"));
    expect(invocation.system).not.toContain("actions this response must cover");
    expect(invocation.system).not.toContain("make a concrete, proportionate ruling");
    expect(invocation.system).toContain("may differ from the actor attempting the source action");
    expect(invocation.system).toContain("do not declare completion merely to avoid a required or invalid check");
    expect(invocation.userPrompt).not.toContain("every modifier source must");
    expect(invocation.userPrompt).toContain("including private facts");
    const ownership = (invocation.context as { roleContract: { modelOwns: string[]; engineOwns: string[]; existingReferenceRule: string } }).roleContract;
    expect(ownership.modelOwns).not.toContain("modifier sources");
    expect(ownership.modelOwns).toContain("grounded named or opposed difficulty");
    expect(ownership.engineOwns).toEqual(expect.arrayContaining(["numeric DC and modifier", "modifierSources"]));
    expect(ownership.existingReferenceRule).toContain("cites that same rating as its source");
    const context = invocation.context as { state: Record<string, unknown> };
    expect(invocation.context).toMatchObject({ task: { assignment: { perceptionTargets: [
      { observerRef: "ref:entity:keeper", sourceActionRef: "ref:action:inspect-key" },
    ] } } });
    expect(context.state.actionSet).toEqual(expectedContext.state.actionSet);
    expect(context.state.canonicalTruth).toEqual(expectedContext.state.canonicalTruth);
    const catalog = (invocation.context as { referenceCatalog: ModelReferenceCatalog }).referenceCatalog;
    expect(catalog.candidates.filter(candidate => candidate.kind === "fact").map(candidate => candidate.handle).sort())
      .toEqual(Object.keys(expectedTruth.facts).sort());
  }
  for (const id of ["truth-reaction-routing", "truth-resolution", "truth-transition"] as const) {
    expect(promptBundle(id).system).toContain(loadPromptAsset("system/truth.md"));
    expect(promptBundle(id).system).not.toContain(loadPromptAsset("system/truth-perception.md"));
  }
});

it.each([{ targets: [] }, { targets: [{ observerId: "keeper", sourceActionId: "inspect-key" }] }])(
  "adds the exact focused task and observer identities while preserving canonical evidence ($targets)", async ({ targets }) => {
    const baseline = fixture(() => ({ kind: "done" }));
    await baseline.run();
    const focused = fixture(() => ({ kind: "done" }));
    focused.input.perceptionTargets = targets;
    await focused.run();
    expect(focused.provider.requests).toHaveLength(1);
    const context = structuredClone(focused.provider.requests[0]!.context) as {
      task: { assignment: { perceptionTargets?: unknown } };
      referenceCatalog: ModelReferenceCatalog;
      state: Record<string, unknown>;
    };
    expect(context.task.assignment.perceptionTargets).toEqual(targets.map((_, targetIndex) => ({
      targetIndex, observerRef: "ref:entity:keeper", sourceActionRef: "ref:action:inspect-key",
    })));
    delete context.task.assignment.perceptionTargets;
    const original = baseline.provider.requests[0]!.context as typeof context;
    const comparable = structuredClone(context);
    comparable.referenceCatalog = original.referenceCatalog;
    comparable.state.actors = original.state.actors;
    comparable.state.perceptionCheckConstraints = original.state.perceptionCheckConstraints;
    expect(comparable).toEqual(original);
    for (const candidate of original.referenceCatalog.candidates) {
      expect(context.referenceCatalog.candidates.find(entry => entry.handle === candidate.handle)).toEqual(candidate);
    }
    expect(contextFor(focused.input, "resolution")).toEqual(contextFor(baseline.input, "resolution"));
  },
);

it.each([
  { targets: [{ observerId: "missing", sourceActionId: "inspect-key" }], reason: "observer" },
  { targets: [{ observerId: "keeper", sourceActionId: "missing" }], reason: "source action" },
  { targets: [{ observerId: "player", sourceActionId: "inspect-key" }], reason: "own action" },
  { targets: [0, 1].map(() => ({ observerId: "keeper", sourceActionId: "inspect-key" })), reason: "repeats" },
])("rejects invalid focused input before model HTTP ($reason)", async ({ targets, reason }) => {
  const f = fixture(() => ({ kind: "done" }));
  f.input.perceptionTargets = targets;
  const before = contentHash(f.input);
  await expect(f.run()).rejects.toThrow(reason);
  expect(f.provider.requests).toHaveLength(0);
  expect(contentHash(f.input)).toBe(before);
});

it("rejects an inactive focused observer before model HTTP", async () => {
  const f = fixture(() => ({ kind: "done" }));
  f.input.state.truth.entities.keeper!.lifecycle = "retired";
  f.input.perceptionTargets = [{ observerId: "keeper", sourceActionId: "inspect-key" }];
  await expect(f.run()).rejects.toThrow("inactive observer");
  expect(f.provider.requests).toHaveLength(0);
});

it("retains all evidence rows while removing field uses that perception cannot materialize, without mutating shared stages", () => {
  const { input } = fixture(() => ({ kind: "done" }));
  input.state.truth.entities.keeper!.lifecycle = "retired";
  const resolution = contextFor(input, "resolution"), before = contentHash(resolution);
  const perception = contextFor(input, "perception");
  expect(contextFor(input, "resolution")).toEqual(resolution);
  expect(contentHash(resolution)).toBe(before);
  expect(perception.referenceCatalog.hash).toBe(contentHash(perception.referenceCatalog.candidates));
  expect(perception.referenceCatalog.hash).not.toBe(resolution.referenceCatalog.hash);
  const withoutUses = (catalog: ModelReferenceCatalog) => catalog.candidates.map(candidate => ({ ...candidate, allowedUses: [] }));
  expect(withoutUses(perception.referenceCatalog)).toEqual(withoutUses(resolution.referenceCatalog));
  expect(perception.state).toMatchObject(resolution.state);
  const local = perception.referenceCatalog.candidates.find(candidate => candidate.kind === "local_entity")!;
  expect(local).toBeDefined();
  expect(local.allowedUses).toContain("target");
  expect(resolution.referenceCatalog.candidates.find(candidate => candidate.handle === local.handle)!.allowedUses).toContain("target");
  const resolver = createTruthReferenceResolver(input);
  for (const candidate of perception.referenceCatalog.candidates) {
    if (candidate.allowedUses.includes("actor")) {
      const resolved = resolver.resolve(candidate.handle, "actor");
      expect(resolved.kind).toBe("entity");
      expect(input.state.truth.entities[resolved.engineId]!.lifecycle).toBe("active");
    }
    if (candidate.allowedUses.includes("target")) expect(["entity", "local_entity"]).toContain(resolver.resolve(candidate.handle, "target").kind);
    if (candidate.allowedUses.includes("modifier")) expect(resolver.resolve(candidate.handle, "modifier").kind).toBe("rating");
    expect(candidate.allowedUses).not.toContain("distribution");
  }
});

it.each([
  { name: "Agent actor", change: { actorRef: "ref:agent:player" }, path: ["actorRef"] },
  { name: "local target", change: { targetRef: "ref:local_entity:player::copper-key" }, path: ["targetRef"] },
  { name: "placement target", change: { targetRef: "ref:placement:courtyard" }, path: ["targetRef"] },
  { name: "proposal target", change: { targetRef: { proposalKey: "inspect-teeth" } }, path: ["targetRef"] },
  { name: "entity rating", change: { ratingRef: "ref:entity:player" }, path: ["ratingRef"] },
  { name: "proposal cause", change: { causes: [{ kind: "check", ref: { proposalKey: "inspect-teeth" } }] }, path: ["causes", 0, "ref"] },
  { name: "random cause", change: { causes: [{ kind: "random", ref: "ref:random:roll" }] }, path: ["causes", 0, "kind"] },
  { name: "mechanic cause", change: { causes: [{ kind: "mechanic", ref: "ref:mechanic:rule" }] }, path: ["causes", 0, "kind"] },
])("rejects $name at its exact schema path without rewriting the check", async ({ change, path: fieldPath }) => {
  const output = directive(request(change)), before = structuredClone(output);
  const parsed = perceptionDirectiveSchema.safeParse(output);
  if (parsed.success) throw new Error("invalid check accepted by schema");
  expect(parsed.error.issues).toContainEqual(expect.objectContaining({ path: ["requests", 0, ...fieldPath] }));
  const f = fixture(() => output), source = contentHash(f.input.state);
  await expect(f.run()).rejects.toThrow();
  expect(f.provider.requests).toHaveLength(1);
  expect(contentHash(f.input.state)).toBe(source);
  expect(output).toEqual(before);
});

it.each(["ref:entity:key", null])("materializes the explicit target %s and exact stakes through the real check/RNG entry", async targetRef => {
  let calls = 0;
  const check = request({ targetRef });
  const f = fixture(() => calls++ === 0 ? directive(check) : { kind: "done" });
  const source = contentHash(f.input.state), result = await f.run();
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ actorId: "player", targetId: targetRef === null ? null : "key", ratingId: "resolve:player",
    modifier: 2, modifierSources: [{ kind: "rating", id: "resolve:player", amount: 2 }], stakes: check.stakes,
    causes: [{ kind: "action", id: "inspect-key" }], phase: "perception" });
  expect(result.checks).toHaveLength(1);
  expect(result.rng.draws).toBeGreaterThan(f.input.state.truth.rng.draws);
  expect(contentHash(f.input.state)).toBe(source);
  expect(f.provider.requests).toHaveLength(2);
});

it("preserves the rejected target and source action for repair, with no extra RNG draws", async () => {
  let calls = 0;
  const bad = request({ targetRef: "ref:local_entity:player::copper-key" });
  const f = fixture(() => calls++ === 0 ? directive(bad) : calls === 2 ? directive(request()) : { kind: "done" }, 1);
  const repaired = await f.run();
  let cleanCalls = 0;
  const clean = await fixture(() => cleanCalls++ === 0 ? directive(request()) : { kind: "done" }).run();
  expect(repaired.requests).toEqual(clean.requests);
  expect(repaired.checks).toEqual(clean.checks);
  expect(repaired.rng).toEqual(clean.rng);
  expect(f.provider.requests).toHaveLength(3);
  const initial = f.provider.requests[0]!.context as { referenceCatalog: ModelReferenceCatalog; state: unknown };
  const repair = f.provider.requests[1]!.context as { referenceCatalog: ModelReferenceCatalog; state: unknown; repair: unknown };
  expect(repair.referenceCatalog).toEqual(initial.referenceCatalog);
  expect(repair.state).toEqual(initial.state);
  expect(JSON.stringify(repair.repair)).toContain("ref:local_entity:player::copper-key");
  expect(JSON.stringify(repair.state)).toContain(f.input.actions[0]!.rawText);
});

it("resolves a committed prior-round check from the exact inventory advertised in the next request", async () => {
  let calls = 0;
  const f = fixture(({ context }) => {
    calls++;
    if (calls === 1) return directive(request());
    if (calls === 3) return { kind: "done" };
    const catalog = (context as { referenceCatalog: ModelReferenceCatalog }).referenceCatalog;
    const check = catalog.candidates.find(candidate => candidate.kind === "check" && candidate.allowedUses.includes("cause"))!;
    expect(check).toBeDefined();
    return directive(request({ proposalKey: "follow-up", causes: [{ kind: "check", ref: check.handle }] }));
  });
  const result = await f.run();
  expect(result.requests).toHaveLength(2);
  expect(result.requests[1]!.causes).toEqual([{ kind: "check", id: result.requests[0]!.id }]);
  expect(result.commitmentRounds).toHaveLength(2);
  expect(f.provider.requests).toHaveLength(3);
});

it.each([
  { change: { targetRef: "ref:entity:missing" }, reason: "unknown" },
  { change: { actorRef: "ref:entity:keeper", ratingRef: "ref:rating:resolve:player" }, reason: "actor rating is not owned" },
  { change: { difficulty: { kind: "environment", band: "hard", source: { kind: "fact", ref: "ref:fact:missing" } } }, reason: "unknown" },
])("still rejects a typed reference that violates runtime evidence ($reason)", async ({ change, reason }) => {
  const output = directive(request(change));
  expect(perceptionDirectiveSchema.safeParse(output).success).toBe(true);
  const f = fixture(() => output), before = contentHash(f.input.state);
  await expect(f.run()).rejects.toThrow(reason);
  expect(contentHash(f.input.state)).toBe(before);
});

it("exports concrete type patterns to the actual model schema", () => {
  const json = z.toJSONSchema(perceptionDirectiveSchema);
  const branch = json.oneOf![0] as { properties: { requests: { items: { properties: Record<string, unknown> } } } };
  const fields = branch.properties.requests.items.properties;
  expect(fields.actorRef).toMatchObject({ type: "string", pattern: "^ref:entity:" });
  expect(JSON.stringify(fields.targetRef)).toContain("^ref:entity:");
  expect(JSON.stringify(fields.ratingRef)).toContain("^ref:rating:");
  expect(JSON.stringify(fields.targetRef)).not.toContain("proposalKey");
  expect(fields).not.toHaveProperty("dc");
  expect(fields).not.toHaveProperty("modifier");
  expect(fields).not.toHaveProperty("modifierSources");
  expect(JSON.stringify(fields.difficulty)).toContain("opposed");
});

it.each([
  ["trivial", 5], ["easy", 10], ["challenging", 15], ["hard", 20], ["extreme", 25],
])("derives the existing %s difficulty rule through perception without model numbers", async (band, dc) => {
  let calls = 0;
  const f = fixture(() => calls++ === 0 ? directive(request({
    difficulty: { kind: "environment", band, source: { kind: "law", ref: "ref:law:time-passes" } },
  })) : { kind: "done" });
  const result = await f.run();
  expect(result.requests[0]).toMatchObject({ dc, modifier: 2, modifierSources: [{ kind: "rating", id: "resolve:player", amount: 2 }] });
  expect(result.checks[0]!.total).toBe(result.checks[0]!.kept + 2);
  expect(f.provider.requests[0]!.context).toMatchObject({ state: { perceptionCheckConstraints: { numericRules: {
    environmentDc: { trivial: 5, easy: 10, challenging: 15, hard: 20, extreme: 25 }, opposedBaseDc: 10,
  } } } });
});

it.each([null, -2, 5])("uses the selected observer aptitude exactly once (%s)", async value => {
  let calls = 0;
  const f = fixture(() => calls++ === 0 ? directive(request({ ratingRef: value === null ? null : "ref:rating:resolve:player" })) : { kind: "done" });
  if (value !== null) f.input.state.truth.ratings["resolve:player"]!.value = value;
  const before = contentHash(f.input), result = await f.run();
  expect(result.requests[0]).toMatchObject({ modifier: value ?? 0,
    modifierSources: value === null ? [] : [{ kind: "rating", id: "resolve:player", amount: value }] });
  expect(result.checks[0]!.total).toBe(result.checks[0]!.kept + (value ?? 0));
  expect(contentHash(f.input)).toBe(before);
});

it("derives opposed difficulty from the exact target-owned rating", async () => {
  let calls = 0;
  const f = fixture(() => calls++ === 0 ? directive(request({ actorRef: "ref:entity:keeper", targetRef: "ref:entity:player", ratingRef: null,
    difficulty: { kind: "opposed", targetRef: "ref:entity:player", ratingRef: "ref:rating:resolve:player",
      source: { kind: "rating", ref: "ref:rating:resolve:player" } },
  })) : { kind: "done" });
  const result = await f.run();
  expect(result.requests[0]).toMatchObject({ actorId: "keeper", targetId: "player", ratingId: null, dc: 12, modifier: 0, modifierSources: [] });
});

it("preserves a perceived object separately from the entity supplying opposition", async () => {
  let calls = 0;
  const f = fixture(() => calls++ === 0 ? directive(request({ actorRef: "ref:entity:keeper", targetRef: "ref:entity:key", ratingRef: "ref:rating:resolve:keeper",
    difficulty: { kind: "opposed", targetRef: "ref:entity:player", ratingRef: "ref:rating:resolve:player",
      source: { kind: "rating", ref: "ref:rating:resolve:player" } },
    stakes: "Whether the keeper notices the key that the player is concealing.",
  })) : { kind: "done" });
  const result = await f.run();
  expect(result.requests[0]).toMatchObject({ actorId: "keeper", targetId: "key", ratingId: "resolve:keeper", dc: 12, modifier: 3 });
});

it.each([
  { name: "wrong target owner", difficulty: { kind: "opposed", targetRef: "ref:entity:key", ratingRef: "ref:rating:resolve:player", source: { kind: "rating", ref: "ref:rating:resolve:player" } }, reason: "invalid opposed rating" },
  { name: "missing opponent", difficulty: { kind: "opposed", targetRef: "ref:entity:missing", ratingRef: "ref:rating:resolve:player", source: { kind: "rating", ref: "ref:rating:resolve:player" } }, reason: "unknown" },
  { name: "wrong opposed evidence", difficulty: { kind: "opposed", targetRef: "ref:entity:key", ratingRef: "ref:rating:key-salience", source: { kind: "law", ref: "ref:law:time-passes" } }, reason: "does not cite its rating" },
  { name: "aptitude reused as difficulty", difficulty: { kind: "environment", band: "easy", source: { kind: "rating", ref: "ref:rating:resolve:player" } }, reason: "more than one mechanical role" },
])("rejects %s before consuming any source randomness", async ({ difficulty, reason }) => {
  const f = fixture(() => directive(request({ difficulty })));
  f.input.state.truth.ratings["key-salience"] = { ...f.input.state.truth.ratings["resolve:player"]!, id: "key-salience", entityId: "key", value: 3 };
  const before = contentHash(f.input);
  await expect(f.run()).rejects.toThrow(reason);
  expect(contentHash(f.input)).toBe(before);
});

it.each([{ dc: 0 }, { modifier: 0 }, { modifierSources: [] }])("rejects model-authored numbers and repairs without changing RNG ($dc $modifier)", async field => {
  const bad = request(field);
  expect(perceptionDirectiveSchema.safeParse(directive(bad)).success).toBe(false);
  let attempts = 0, cleanAttempts = 0;
  const repaired = fixture(() => attempts++ === 0 ? directive(bad) : attempts === 2 ? directive(request()) : { kind: "done" }, 1);
  const clean = fixture(() => cleanAttempts++ === 0 ? directive(request()) : { kind: "done" });
  const repairedResult = await repaired.run(), cleanResult = await clean.run();
  expect(repairedResult.requests).toEqual(cleanResult.requests);
  expect(repairedResult.checks).toEqual(cleanResult.checks);
  expect(repairedResult.rng).toEqual(cleanResult.rng);
  expect(repaired.provider.requests).toHaveLength(3);
  expect(JSON.stringify(repaired.provider.requests[1]!.context)).toContain(Object.keys(field)[0]!);
});
