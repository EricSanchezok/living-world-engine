import path from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { EagerReferenceAlgorithm } from "../../algorithms/eager-reference/eager-reference";
import { contentHash } from "../../models/model-audit";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { loadWorldScript } from "../../../script/world-loader";
import { deterministicGlobalActionCompilationBatch, deterministicModelOutput, ScriptedModelProvider } from "../../testing/model-provider";
import { repairReferenceWitnessRequest } from "./repair-reference-witness";

const source = () => ({ state: { canonicalTruth: {
  entities: { "ref:entity:crew": { name: "Crew" }, "ref:entity:captain": { name: "Captain" }, "ref:entity:stranger": { name: "Stranger" } },
  meters: { "ref:meter:health:captain": { entityRef: "ref:entity:captain", current: 7 },
    "ref:meter:fatigue:captain": { entityRef: "ref:entity:captain", current: 2 },
    "ref:meter:health:stranger": { entityRef: "ref:entity:stranger", current: 9 } },
  ratings: { "ref:rating:sailing:captain": { entityRef: "ref:entity:captain", value: 3 } },
} }, repair: { issues: [{ code: "reference.invalid_meter_ownership" }], previousOutput: {
  targetRef: "ref:entity:crew", meterRef: "ref:meter:health:captain", ratingRef: "ref:rating:sailing:captain",
  sourceRefs: [{ ref: "ref:entity:crew" }], unknown: "ref:entity:missing", description: "Mention ref:entity:stranger in ordinary prose.",
} } });
const request = () => ({ role: "truth-resolution" as const, schemaName: "truth_resolution_plan_repair", profileId: "truth-engine",
  workloadId: "world", batchId: "step", subjectId: "crew", promptVersion: "original", system: "source", userPrompt: "repair",
  context: source(), schema: z.object({ valid: z.boolean() }), preprocessOutput: (value: unknown) => ({ value, symbolRepairs: [] }) });

it("repeats complete ownership records and empty domains without changing context or output authority", () => {
  const original = request(), before = structuredClone(original.context), projected = repairReferenceWitnessRequest(original);
  expect(projected.context).toBe(original.context); expect(projected.context).toEqual(before);
  expect(projected.schema).toBe(original.schema); expect(projected.preprocessOutput).toBe(original.preprocessOutput);
  const view = JSON.parse(projected.jsonObjectPostlude!.split("\n\n").at(-1)!);
  expect(view.sourceContextHash).toBe(contentHash(before)); expect(view.candidateHash).toBe(contentHash(before.repair.previousOutput));
  expect(view.entities.map((row: { entityRef: string }) => row.entityRef)).toEqual(["ref:entity:crew", "ref:entity:captain"]);
  expect(view.entities[0].meters).toEqual([]); expect(view.entities[0].ratings).toEqual([]);
  expect(view.entities[1].meters.map((row: { meterRef: string }) => row.meterRef)).toEqual(["ref:meter:health:captain", "ref:meter:fatigue:captain"]);
  expect(view.entities[1].meters[1].record).toEqual(before.state.canonicalTruth.meters["ref:meter:fatigue:captain"]);
  expect(view.references.find((row: { ref: string }) => row.ref === "ref:entity:crew").candidatePaths).toHaveLength(2);
  expect(view.references.find((row: { ref: string }) => row.ref === "ref:entity:missing")).toMatchObject({ present: false });
  expect(view.references.find((row: { ref: string }) => row.ref === "ref:entity:missing")).not.toHaveProperty("record");
});

it("leaves other stages untouched and rejects incompatible postludes or incomplete source", () => {
  const initial = { ...request(), schemaName: "truth_resolution_plan_commit", context: { ...source(), repair: null } };
  expect(repairReferenceWitnessRequest(initial)).toBe(initial);
  expect(() => repairReferenceWitnessRequest({ ...request(), jsonObjectPostlude: "existing" })).toThrow(/postlude/);
  const complete = repairReferenceWitnessRequest(request());
  expect(() => repairReferenceWitnessRequest(complete)).toThrow(/postlude/);
  expect(() => repairReferenceWitnessRequest({ ...request(), context: { repair: {} } })).toThrow(/complete canonical/);
});

it("exposes the actual rejected gate effect and commits only the model's independently chosen condition", async () => {
  let attempts = 0, witnessed = 0;
  const base = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicGlobalActionCompilationBatch(profileId, context);
    if (role !== "truth-resolution") return deterministicModelOutput(profileId, context);
    const input = context as { state: { committedResolutionPlans: unknown[]; actionSet: { assigned: Array<{ actionRef: string }> } } };
    if (input.state.committedResolutionPlans.length) return { kind: "done" };
    attempts++; const actionRef = input.state.actionSet.assigned[0]!.actionRef;
    const common = { proposalKey: "pressure", targetRef: "ref:entity:gate", channel: "physical-harm", label: "Pressure",
      description: "The gate is under sustained physical pressure.", sourceRefs: [{ kind: "action", id: actionRef }], magnitude: "minor" };
    return { kind: "commit_plans", plans: [{ proposalKey: "lean", actionRef, targetRefs: ["ref:entity:gate"],
      means: [{ description: "Apply physical effort", source: { kind: "action", ref: actionRef } }], factors: [], mode: "automatic",
      difficulty: null, actorRatingRef: null, risk: "safe", baseEffect: "minor", primaryEffect: attempts === 1
        ? { ...common, kind: "meter", meterRef: "ref:meter:health:player", impactProfileRef: "ref:mechanic:harm" }
        : { ...common, kind: "condition", conditionRef: { proposalKey: "pressure" }, conditionProfileRef: null,
          durationProfileRef: "ref:mechanic:brief", access: { kind: "public" } },
      secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: actionRef }] }] };
  });
  const provider: typeof base = Object.assign(Object.create(base), { generateStructured: async <T>(original: Parameters<typeof base.generateStructured<T>>[0]) => {
    const projected = repairReferenceWitnessRequest(original);
    if (projected !== original) {
      witnessed++; const view = JSON.parse(projected.jsonObjectPostlude!.split("\n\n").at(-1)!);
      expect(view.entities.find((row: { entityRef: string }) => row.entityRef === "ref:entity:gate").meters).toEqual([]);
      expect(view.entities.find((row: { entityRef: string }) => row.entityRef === "ref:entity:player").meters).not.toEqual([]);
      expect(view.issues[0].code).toBe("reference.invalid_meter_ownership");
    }
    const result = await base.generateStructured(projected);
    return { ...result, audit: { ...result.audit, promptVersion: original.promptVersion } };
  } });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider)); await engine.bootstrapAgents();
  const before = engine.snapshot;
  const text = "倚靠石门练习发力，持续给石门施加压力。";
  const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "fixture" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, { expectedRevision: before.revision, trigger: "participant_action",
    externalActions: [{ submissionId: "witness", agentId: "player", rawText: text, goal: text, means: null, targetIds: [] }] });
  expect(attempts).toBe(2); expect(witnessed).toBe(1);
  expect(result.committed.actions[0]!.rawText).toBe(text);
  expect(result.committed.resolutionPlans[0]!.primaryEffect).toMatchObject({ kind: "condition", targetId: "gate" });
  expect(result.state.truth.meters).toEqual(before.truth.meters);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
