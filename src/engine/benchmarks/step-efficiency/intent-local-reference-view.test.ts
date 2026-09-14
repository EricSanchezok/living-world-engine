import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelAudit, deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { agentIntentProgramSchema, INTENT_PROGRAM_PREFIX } from "./agent-intent-program";
import { IntentLocalReferenceViewCodec, INTENT_LOCAL_REFERENCE_VIEW, INTENT_LOCAL_VIEW_PREFIX, intentLocalReferenceViewProvider } from "./intent-local-reference-view";

const program = agentIntentProgramSchema.parse({ root: 0, nodes: [
  { nodeId: 0, kind: "parallel", children: [1, 7] },
  { nodeId: 1, kind: "sequence", children: [2, 3, 4] },
  { nodeId: 2, kind: "attempt", text: " 询问对方；不要替他回答。\n", targetIndices: [0] },
  { nodeId: 3, kind: "await", condition: "对方作出可察觉的答复", targetIndices: [0] },
  { nodeId: 4, kind: "if", condition: "对方愿意出示物件", targetIndices: [0, 1], thenNode: 5, elseNode: 6 },
  { nodeId: 5, kind: "attempt", text: "观察对方展示的物件", targetIndices: [1] },
  { nodeId: 6, kind: "attempt", text: "结束询问", targetIndices: [0] },
  { nodeId: 7, kind: "while", condition: "仍在等待", targetIndices: [0], body: 8 },
  { nodeId: 8, kind: "attempt", text: "留意来往者", targetIndices: [0] },
] });
const text = INTENT_PROGRAM_PREFIX + JSON.stringify(program);
const action = (actor: string) => ({ actionRef: `ref:action:${actor}`, actorRef: `ref:agent:${actor}`, rawText: text, goal: text,
  targetRefs: [`ref:local_entity:${actor}::visitor`, `ref:local_entity:${actor}::item`] });
const context = () => ({ task: { stage: "plan" }, state: { actionSet: { initial: [action("a"), action("b")],
  available: [action("a"), action("b")], assigned: [action("a")] },
  actors: { a: { localEntityBindings: { visitor: [], item: ["ref:entity:key", "ref:entity:stone"] } } },
  canonicalTruth: { activities: { waiting: { description: text } } },
  temporalExecution: { activities: [{ sourceActionRef: "ref:action:a", description: text }] } },
  referenceCatalog: { candidates: [{ kind: "action", handle: "ref:action:a", meaning: text }] },
  repair: { previousOutput: { arbitraryText: "literal plain text" } } });

it("separates local symbols for complete nested intentions and restores all source copies", () => {
  const source = context(), codec = new IntentLocalReferenceViewCodec(source), before = structuredClone(source);
  expect(codec.domains).toHaveLength(2);
  expect(codec.domains[0]!.bindings[0]).toEqual({ symbol: "intent-local-0", localEntityRef: "ref:local_entity:a::visitor" });
  expect(codec.domains[1]!.bindings[0]).toEqual({ symbol: "intent-local-0", localEntityRef: "ref:local_entity:b::visitor" });
  expect(codec.replacements).toHaveLength(13);
  expect(JSON.stringify(codec.context)).not.toContain("targetIndices");
  const view = JSON.parse(codec.replacements[0]!.view.slice(INTENT_LOCAL_VIEW_PREFIX.length));
  expect(view.nodes.map((n: { kind: string }) => n.kind)).toEqual(program.nodes.map(n => n.kind));
  expect(view.nodes[2]).toEqual({ nodeId: 2, kind: "attempt", text: program.nodes[2]!.kind === "attempt" && program.nodes[2].text, intentTargets: ["intent-local-0"] });
  expect(view.nodes[4]).toMatchObject({ condition: "对方愿意出示物件", thenNode: 5, elseNode: 6, intentTargets: ["intent-local-0", "intent-local-1"] });
  expect(codec.restore()).toEqual(source); expect(source).toEqual(before);
  expect((codec.context as ReturnType<typeof context>).state.actors).toEqual(source.state.actors);
});

it.each(["foreign-domain", "duplicate-target"])("keeps unsupported program-looking text opaque: %s", kind => {
  const source = context();
  if (kind === "foreign-domain") for (const values of Object.values(source.state.actionSet)) for (const a of values) a.targetRefs.pop();
  if (kind === "duplicate-target") for (const values of Object.values(source.state.actionSet)) for (const a of values) a.targetRefs[1] = a.targetRefs[0]!;
  const codec = new IntentLocalReferenceViewCodec(source);
  expect(codec.domains).toEqual([]); expect(codec.context).toEqual(source);
});

it("rejects inconsistent workset copies and never binds identical opaque text through a different actor", () => {
  const source = context(); source.state.actionSet.assigned[0]!.targetRefs.reverse();
  expect(() => new IntentLocalReferenceViewCodec(source)).toThrow(/domain/);
  const mixed = context();
  for (const values of Object.values(mixed.state.actionSet)) for (const a of values) if (a.actorRef === "ref:agent:b") a.targetRefs.pop();
  const codec = new IntentLocalReferenceViewCodec(mixed);
  expect(codec.domains).toEqual([]); expect(codec.context).toEqual(mixed);
});

it("retains ordinary, malformed and noncanonical program-like text without interpretation", () => {
  const source = context();
  const plain = ["Just ask a question", INTENT_PROGRAM_PREFIX + "{broken", INTENT_PROGRAM_PREFIX + JSON.stringify(program, null, 2)];
  for (const rawText of plain) {
    for (const values of Object.values(source.state.actionSet)) for (const a of values) a.rawText = a.goal = rawText;
    const codec = new IntentLocalReferenceViewCodec(source);
    expect(codec.domains).toEqual([]); expect(codec.context).toEqual(source); expect(codec.restore()).toEqual(source);
  }
});

it.each(["source", "view"])("rejects %s drift before accepting a response and retains schema and preprocessor", async kind => {
  const source = context(), schema = z.object({ valid: z.boolean() }), preprocessOutput = (raw: unknown) => ({ value: raw, symbolRepairs: [] });
  const base = new ScriptedModelProvider(({ profileId, context }) => deterministicModelOutput(profileId, context));
  const provider = intentLocalReferenceViewProvider({ ...base, catalog: base.catalog,
    availableProfileSummaries: role => base.availableProfileSummaries(role), assertProfilesAvailable: ids => base.assertProfilesAvailable(ids),
    generateStructured: async request => {
      expect(request.schema).toBe(schema); expect(request.preprocessOutput).toBe(preprocessOutput);
      expect(request.promptVersion).toContain(INTENT_LOCAL_REFERENCE_VIEW);
      const changed = kind === "source" ? source : request.context as ReturnType<typeof context>;
      changed.state.actionSet.assigned[0]!.targetRefs.reverse();
      return { value: request.schema.parse({ valid: true }), audit: createTestModelAudit(request.role, request.subjectId, `sha256:${contentHash("scope-test")}`) };
    } });
  await expect(provider.generateStructured({ role: "truth-resolution", schemaName: "truth_resolution_plan_commit", profileId: "truth-engine",
    workloadId: "world", batchId: "step", subjectId: "a", promptVersion: "source", system: "source", userPrompt: "plan",
    context: source, schema, preprocessOutput })).rejects.toThrow(/mutated|changed before restoration/);
});

it.each([false, true])("keeps real SimulationEngine repair and canonical commits bound to original intentions: %s", repair => {
  return (async () => {
    let transformed = 0, attempts = 0;
    const original = new ScriptedModelProvider(({ role, profileId, context: raw }) => {
      if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, raw);
      if (role !== "truth-resolution") return deterministicModelOutput(profileId, raw);
      const input = raw as { state: { actionSet: { assigned: Array<{ actionRef: string; rawText: string }> }; committedResolutionPlans: unknown[] } };
      if (input.state.committedResolutionPlans.length) return { kind: "done" };
      transformed++; expect(input.state.actionSet.assigned[0]!.rawText).toContain(INTENT_LOCAL_VIEW_PREFIX);
      expect(JSON.stringify(raw)).not.toContain('\\"targetIndices\\"'); attempts++;
      const actionRef = input.state.actionSet.assigned[0]!.actionRef;
      return { kind: "commit_plans", plans: [{ proposalKey: "inspect", actionRef,
        targetRefs: ["ref:entity:gate"], means: [{ description: "Observe the gate", source: { kind: "action", ref: actionRef } }],
        factors: [], mode: "automatic", difficulty: null, actorRatingRef: null, risk: "safe", baseEffect: "minor",
        primaryEffect: { proposalKey: "pressure", targetRef: "ref:entity:gate", channel: "physical-harm", label: "Pressure", description: "Gate remains under light pressure.",
          sourceRefs: [{ kind: "action", id: actionRef }], magnitude: "minor",
          ...(repair && attempts === 1 ? { kind: "meter", meterRef: "ref:meter:health:player", impactProfileRef: "ref:mechanic:harm" }
            : { kind: "condition", conditionRef: { proposalKey: "pressure" }, conditionProfileRef: null, durationProfileRef: "ref:mechanic:brief", access: { kind: "public" } }) },
        secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] }] };
    });
    const provider = intentLocalReferenceViewProvider(original);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 17, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider)); await engine.bootstrapAgents();
    const source = engine.snapshot;
    const rawText = INTENT_PROGRAM_PREFIX + JSON.stringify(agentIntentProgramSchema.parse({ root: 0,
      nodes: [{ nodeId: 0, kind: "attempt", text: "Observe the gate while leaning lightly against it.", targetIndices: [0] }] }));
    const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "fixture" }, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } },
      { expectedRevision: source.revision, trigger: "participant_action", externalActions: [{ submissionId: "scope-view", agentId: "player", rawText, goal: rawText, means: null, targetIds: ["self"] }] });
    expect(transformed).toBe(repair ? 2 : 1);
    expect(result.committed.actions[0]!.rawText).toBe(rawText); expect(result.committed.resolutionPlans[0]!.goal).toBe(rawText);
    expect(result.committed.resolutionPlans[0]!.primaryEffect?.targetId).toBe("gate");
    expect(result.state.truth.meters["health:player"]).toEqual(source.truth.meters["health:player"]);
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  })();
});
