import { TRUTH_RESOLUTION_CONTRACT_VERSION } from "../../algorithms/roles";
import { ORDERED_RANDOM_SCHEDULING } from "../ordered-random-stream";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { loadWorldScript } from "../../../script/world-loader";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../algorithms/registry";
import { defineAlgorithmRef } from "../../algorithms/composition";
import { WorldExecutionAlgorithmRegistry } from "../../runtime/execution";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { contentHash } from "../../models/model-audit";
import { type StructuredModelRequest } from "../../models/model-provider";
import { deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { loadPromptAsset, promptBundle } from "../../prompts";
import { TruthBatchCoordinator } from "../truth-batch-provider";
import { RESOLUTION_SOURCE_INVENTORY } from "../../contracts/resolution-source-inventory";
import { SHARED_BATCH_CONTEXT_CODEC } from "../shared-batch-context";
import { decodeResolutionDependentFields, encodeResolutionDependentFields, resolutionDependentFieldsWireSchema,
  RESOLUTION_DEPENDENT_FIELDS_CODEC, RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION, dependentFieldsProvider } from "../resolution-dependent-fields-codec";

function plan(magnitude = "none", kind = "meter", mode = "automatic") {
  const primary = magnitude === "none" ? null : {
    proposalKey: "effect", kind, targetRef: "ref:entity:player", channel: "health", label: "Effect",
    description: "The stated effect", sourceRefs: [{ kind: "action", ref: "ref:action:act" }], magnitude,
    ...(kind === "meter" ? { meterRef: "ref:meter:health", impactProfileRef: "ref:mechanic:impact" }
      : { conditionRef: { proposalKey: "condition" }, conditionProfileRef: null, durationProfileRef: "ref:mechanic:duration", access: { kind: "public" } }),
  };
  return { proposalKey: "plan", actionRef: "ref:action:act", targetRefs: ["ref:entity:player"],
    means: [{ description: "The action", source: { kind: "action", ref: "ref:action:act" } }],
    mode, difficulty: mode === "check" ? { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:gravity" } } : null,
    actorRatingRef: null, factors: [], risk: "safe", baseEffect: magnitude, primaryEffect: primary,
    secondaryEffect: null, threatenedEffect: mode === "check" && primary ? Object.fromEntries(Object.entries(primary).filter(([key]) => key !== "magnitude")) : null,
    visibility: "full", causes: [{ kind: "action", ref: "ref:action:act" }] };
}
const commit = (plans: unknown[]) => ({ kind: "commit_plans", plans });

describe("dependent resolution fields", () => {
  it("round trips canonical effect choices, slot assignments and null effects without changing other data", () => {
    const values = [plan(), plan("none", "meter", "blocked"), ...["minor", "standard", "major", "decisive"]
      .flatMap(magnitude => ["meter", "condition"].flatMap(kind => [plan(magnitude, kind), plan(magnitude, kind, "check")]))];
    for (const value of values) {
      const canonical = resolutionPlanCommitDirectiveSchema.parse(commit([value]));
      const sourceHash = contentHash(canonical);
      const wire = encodeResolutionDependentFields(canonical);
      expect(wire).not.toHaveProperty("plans.0.baseEffect");
      expect(decodeResolutionDependentFields(wire)).toEqual(canonical);
      expect(contentHash(canonical)).toBe(sourceHash);
    }
    const batch = { slots: [{ slot: 7, result: commit([plan("major")]) }, { slot: 2, result: commit([plan()]) }] };
    expect(decodeResolutionDependentFields(encodeResolutionDependentFields(batch))).toEqual(batch);
    const schema = z.toJSONSchema(resolutionPlanCommitDirectiveSchema, { target: "draft-07" });
    const wireSchema = resolutionDependentFieldsWireSchema(schema);
    expect(JSON.stringify(wireSchema)).toContain("Optional exact copy");
    expect(JSON.stringify(schema)).toContain('"baseEffect"');
  });

  it("does not correct conflicting canonical output or malformed wire effects", () => {
    expect(() => encodeResolutionDependentFields(commit([{ ...plan("major"), baseEffect: "minor" }]))).toThrow("consistent");
    expect(decodeResolutionDependentFields(commit([plan()]))).toEqual(commit([plan()]));
    expect(() => decodeResolutionDependentFields(commit([{ ...plan(), baseEffect: "major" }]))).toThrow("conflicts");
    for (const primaryEffect of [undefined, {}, { magnitude: "invented" }]) {
      const value = encodeResolutionDependentFields(commit([plan()] )) as { plans: Record<string, unknown>[] };
      if (primaryEffect === undefined) delete value.plans[0]!.primaryEffect;
      else value.plans[0]!.primaryEffect = primaryEffect;
      expect(resolutionPlanCommitDirectiveSchema.safeParse(decodeResolutionDependentFields(value)).success).toBe(false);
    }
  });

  it("restores only the selected opposed rating source, retaining target and independent environment choices", () => {
    const opposed = { ...plan("standard", "meter", "check"), difficulty: { kind: "opposed",
      targetRef: "ref:entity:keeper", ratingRef: "ref:rating:resolve:keeper",
      source: { kind: "rating", ref: "ref:rating:resolve:keeper" } } };
    const canonical = resolutionPlanCommitDirectiveSchema.parse(commit([opposed]));
    const wire = encodeResolutionDependentFields(canonical);
    expect(wire).not.toHaveProperty("plans.0.difficulty.source");
    expect(wire).toHaveProperty("plans.0.difficulty.targetRef", opposed.difficulty.targetRef);
    expect(decodeResolutionDependentFields(wire)).toEqual(canonical);
    expect(decodeResolutionDependentFields(canonical)).toEqual(canonical);
    const conflicting = commit([{ ...opposed, difficulty: { ...opposed.difficulty,
      source: { kind: "fact", ref: "ref:fact:weather" } } }]);
    expect(() => encodeResolutionDependentFields(conflicting)).toThrow("selected rating");
    expect(() => decodeResolutionDependentFields(conflicting)).toThrow("selected ratingRef");
    const environmentPlan = plan("minor", "meter", "check");
    const environment = commit([environmentPlan]);
    expect(encodeResolutionDependentFields(environment)).toHaveProperty("plans.0.difficulty.source", environmentPlan.difficulty!.source);
    const malformed = structuredClone(wire) as { plans: Array<{ difficulty: Record<string, unknown> }> };
    delete malformed.plans[0]!.difficulty.ratingRef;
    expect(resolutionPlanCommitDirectiveSchema.safeParse(decodeResolutionDependentFields(malformed)).success).toBe(false);
    const originalHash = contentHash(wire);
    decodeResolutionDependentFields(wire);
    expect(contentHash(wire)).toBe(originalHash);
  });

  it("preserves physical batching and expands before canonical slot validation", async () => {
    const captured: StructuredModelRequest<unknown>[] = [];
    const provider = new ScriptedModelProvider(input => {
      const context = input.context as { task: { slots: { slot: number }[] } };
      return { slots: context.task.slots.map(slot => ({ slot: slot.slot, result: encodeResolutionDependentFields(commit([plan()])) })) };
    });
    const generate = provider.generateStructured.bind(provider);
    provider.generateStructured = request => { captured.push(request); return generate(request); };
    const coordinator = new TruthBatchCoordinator(dependentFieldsProvider(provider), 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const prompt = promptBundle("truth-resolution");
    const context = { contractVersion: 17, roleContract: { role: "truth-resolution" },
      execution: { worldId: "world", instanceId: "instance", advanceId: "step", revision: 0, step: 0 },
      task: { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [] },
      state: {}, referenceCatalog: { version: 2, hash: "test", candidates: [] }, repair: null };
    const results = await Promise.all(["first", "second"].map(subjectId => coordinator.generateStructured({
      profileId: "truth-engine", workloadId: "instance", batchId: "step", role: "truth-resolution", subjectId,
      schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
      promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt, context,
    })));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.schemaName).toBe("truth_resolution_plan_commit_batch");
    expect(captured[0]!.system.split(loadPromptAsset("shared/resolution-condition-references.md"))).toHaveLength(2);
    expect(JSON.stringify(captured[0]!.wireJsonSchema)).toContain("Optional exact copy");
    expect(results.map(r => r.value.plans[0]!.baseEffect)).toEqual(["none", "none"]);
    expect(context.state).toEqual({});
  });

  it.each(["dependent-fields", "source-inventory"])("runs the registered %s candidate through a full engine step and canonical replay", async (candidate) => {
    let resolutionRequests = 0;
    const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
      if (role === "truth-perception") return { kind: "done" };
      if (role === "truth-reaction-routing") return { requests: [] };
      if (role === "truth-resolution") {
        resolutionRequests++;
        const input = context as { state: { committedResolutionPlans: unknown[]; actionSet: { assigned: { actionRef: string; allowedMeansSources?: {kind: string; ref: string}[] }[] } } };
        if (input.state.committedResolutionPlans.length) return { kind: "done" };
        const plans = input.state.actionSet.assigned.map(({ actionRef }) => ({ ...plan(), actionRef,
          means: [{ description: "Look around", source: { kind: "action", ref: actionRef } }],
          causes: [{ kind: "action", ref: actionRef }] }));
        for (const action of input.state.actionSet.assigned) {
          expect(action.allowedMeansSources).toContainEqual({kind: "action", ref: action.actionRef});
        }
        return candidate === "dependent-fields" ? encodeResolutionDependentFields(commit(plans)) : commit(plans);
      }
      return deterministicModelOutput(profileId, context);
    });
    const base = FULL_CATALOG_ALGORITHM_REF;
    const truth = defineAlgorithmRef({ role: "truth-resolution", id: `${candidate}-truth-resolution`, version: "1", contractVersion: TRUTH_RESOLUTION_CONTRACT_VERSION,
      config: candidate === "dependent-fields" ? { randomScheduling: ORDERED_RANDOM_SCHEDULING, representation: RESOLUTION_DEPENDENT_FIELDS_CODEC,
        promptVersion: RESOLUTION_DEPENDENT_FIELDS_PROMPT_VERSION, sourceInventory: RESOLUTION_SOURCE_INVENTORY } : {randomScheduling: ORDERED_RANDOM_SCHEDULING, sourceInventory: RESOLUTION_SOURCE_INVENTORY}, children: base.children.truthResolution!.children });
    const composition = defineAlgorithmRef({ ...base, children: { ...base.children, truthResolution: truth } });
    const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    const engine = new SimulationEngine(definition, registry.create(composition, { provider }));
    await engine.bootstrapAgents();
    const before = engine.snapshot;
    const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "test-player" },
      keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, {
      expectedRevision: before.revision, trigger: "participant_action", externalActions: [{ submissionId: "look", agentId: "player",
        rawText: "观察庭院", goal: "确认庭院状况", means: null, targetIds: [] }],
    });
    expect(resolutionRequests).toBeGreaterThan(0);
    expect(result.state.revision).toBe(before.revision + 1);
    expect(result.state.truth.elapsedSeconds).toBeGreaterThan(before.truth.elapsedSeconds);
    expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
  });
});
