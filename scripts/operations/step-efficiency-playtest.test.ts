import { RESOLUTION_SOURCE_ROLE_INSTRUCTION } from "../../src/engine/mechanics/resolution-source-role-contract";
import { expect, it, vi } from "vitest";
import path from "node:path";
import { FULL_CATALOG_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { createEagerReferenceAlgorithmRef } from "../../src/engine/algorithms/eager-reference/eager-reference";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { loadWorldScript } from "../../src/script/world-loader";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { replaySimulationState } from "../../src/engine/runtime/transaction";
import { contentHash } from "../../src/engine/models/model-audit";
import { deterministicModelOutput, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import type { StructuredModelProvider } from "../../src/engine/models/model-provider";
import { isSharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { assertPhysicalPlanningWorklist, type PhysicalPlanningWorklist } from "../../src/engine/mechanics/physical-planning-worklist";
import { WORKLIST_PLANNING_PIPELINE, WORKLIST_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/worklist-planning-pipeline";
import { INDEXED_REVIEWED_PLANNING_PIPELINE, INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { assertIndexedPlanningContext } from "../../src/engine/mechanics/source-indexed-planning";
import { WorldExecutionAlgorithmRegistry } from "../../src/engine/runtime/execution";
import { firstPassAlgorithmRef } from "../../src/engine/benchmarks/action-compilation/first-pass-protocol";
import { orderedRandomAlgorithmRef, sharedContextAlgorithmRef } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { assertNonthinkingRunCapacity, assertStepEfficiencyInstrumentation, runStepEfficiencyPlaytest, stepEfficiencyAlgorithmRef, withStepEfficiencyDeadline } from "./step-efficiency-playtest";

it("rejects the reproduced native profiler crash before playtest setup or model dispatch", async () => {
  expect(() => assertStepEfficiencyInstrumentation(["--cpu-prof"], "darwin", "arm64")).toThrow("external sampling");
  expect(() => assertStepEfficiencyInstrumentation(["--cpu-prof=true"], "darwin", "arm64")).toThrow("external sampling");
  expect(() => assertStepEfficiencyInstrumentation(["--cpu-prof-dir=/tmp", "--cpu-prof=false"], "darwin", "arm64")).not.toThrow();
  expect(() => assertStepEfficiencyInstrumentation([], "darwin", "arm64")).not.toThrow();
  expect(() => assertStepEfficiencyInstrumentation(["--cpu-prof"], "linux", "x64")).not.toThrow();
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  vi.spyOn(process, "arch", "get").mockReturnValue("arm64");
  const original = process.execArgv;
  process.execArgv = ["--cpu-prof"];
  try { await expect(runStepEfficiencyPlaytest()).rejects.toThrow("external sampling"); }
  finally { process.execArgv = original; vi.restoreAllMocks(); }
});

it.each([{ pipeline: WORKLIST_PLANNING_PIPELINE, version: WORKLIST_PLANNING_PROMPT_VERSION },
  { pipeline: INDEXED_REVIEWED_PLANNING_PIPELINE, version: INDEXED_REVIEWED_PLANNING_PROMPT_VERSION }] as const)("pins the complete foundation and rejects drift: $pipeline", ({ pipeline, version }) => {
  const foundation = { sourceInventory: true as const, resolutionRepresentation: "resolution-dependent-fields-v1" as const, truthTransport: "shared-state-first-v1" as const };
  const before = stepEfficiencyAlgorithmRef(foundation);
  const candidate = stepEfficiencyAlgorithmRef({ ...foundation, planningPipeline: pipeline });
  const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
  expect(registry.has(candidate)).toBe(true);
  expect(candidate.children.truthResolution!.config.pipelinePromptVersion).toBe(version);
  expect(candidate.children.truthResolution!.version).toBe(pipeline === INDEXED_REVIEWED_PLANNING_PIPELINE ? "5" : "1");
  if (pipeline === INDEXED_REVIEWED_PLANNING_PIPELINE) {
    const stale = defineAlgorithmRef({ ...candidate.children.truthResolution!, version: "4" });
    expect(registry.has(defineAlgorithmRef({ ...candidate, children: { ...candidate.children, truthResolution: stale } }))).toBe(false);
  }
  expect(candidate.children.truthResolution!.children).toEqual(before.children.truthResolution!.children);
  expect(candidate.children.actionCompilation).toEqual(before.children.actionCompilation);
  expect(() => stepEfficiencyAlgorithmRef({ planningPipeline: pipeline })).toThrow("complete");
  const truthResolution = candidate.children.truthResolution!;
  const invalid = defineAlgorithmRef({ ...truthResolution, config: { ...truthResolution.config, pipelinePromptVersion: "drift" } });
  expect(registry.has(defineAlgorithmRef({ ...candidate, children: { ...candidate.children, truthResolution: invalid } }))).toBe(false);
});

it.each([false, true])("runs registered planning, canonical source restoration and temporal review through an actual step (indexed=%s)", async indexed => {
  const scripted = new ScriptedModelProvider(({ profileId, context }) => deterministicModelOutput(profileId, context));
  let planned = 0, reviewed = 0, transitioned = 0;
  const planning = new ScriptedModelProvider(({ context }) => {
    const worklist = (context as { task: { planningWorklist: PhysicalPlanningWorklist } }).task.planningWorklist;
    return { kind: "commit_plans", plans: worklist.actions.map(({ action, slot }, index) => {
      const source = (action.allowedMeansSources as Array<{ kind: string; ref: string; sourceSelector: string }>).find(value => value.kind === "action" && value.ref === action.actionRef)!;
      const target = worklist.targetChoices.find(value => value.slots.includes(slot))!;
      return { proposalKey: `observe-${index}`, ...(indexed ? { actionIndex: index, targetIndices: [(target as typeof target & { targetIndex: number }).targetIndex] }
        : { actionRef: action.actionRef, targetRefs: [target.targetSelector] }),
        means: [{ description: "Observe the immediate surroundings", source: source.sourceSelector }], factors: [], risk: "safe",
        primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: action.actionRef }],
        mode: "automatic", difficulty: null, actorRatingRef: null };
    }) };
  }, scripted.catalog, false);
  const provider: StructuredModelProvider = { catalog: scripted.catalog,
    availableProfileSummaries: role => scripted.availableProfileSummaries(role), assertProfilesAvailable: ids => scripted.assertProfilesAvailable(ids),
    generateStructured: request => {
      const context = request.context as { task: { planningWorklist?: PhysicalPlanningWorklist }; state: { temporalExecution?: unknown; candidateResolutionPlans?: Array<{ targetRefs: string[]; means: Array<{ source: { kind: string } }> }> } };
      if (context.task?.planningWorklist) {
        expect(request.system.split(RESOLUTION_SOURCE_ROLE_INSTRUCTION).length - 1).toBe(indexed ? 1 : 0);
        planned++; if (indexed) assertIndexedPlanningContext(request.context); else assertPhysicalPlanningWorklist(request.context);
        expect(context.state.temporalExecution).toBeDefined();
        expect(request.promptVersion).toContain("physical-planning-worklist-v1");
        return planning.generateStructured(request);
      }
      if (request.schemaName === "resolution_plan_verification") {
        reviewed++; expect(context.state.temporalExecution).toBeDefined();
        expect(request.system.includes("The planner cannot rewrite this field.")).toBe(indexed);
        expect(request.promptVersion.includes(":source-intent-")).toBe(indexed);
        for (const plan of context.state.candidateResolutionPlans!) {
          expect(plan.targetRefs.every(ref => ref.startsWith("ref:entity:"))).toBe(true);
          expect(plan.means[0]!.source.kind).toBe("action");
        }
      }
      if (request.role === "truth-transition") {
        expect(request.system).not.toContain(RESOLUTION_SOURCE_ROLE_INSTRUCTION);
        transitioned++; expect(context.state.temporalExecution).toBeDefined(); }
      return scripted.generateStructured(request);
    } };
  const candidate = stepEfficiencyAlgorithmRef({ sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1",
    planningPipeline: indexed ? INDEXED_REVIEWED_PLANNING_PIPELINE : WORKLIST_PLANNING_PIPELINE });
  const composition = defineAlgorithmRef({ ...FULL_CATALOG_ALGORITHM_REF, children: { ...FULL_CATALOG_ALGORITHM_REF.children, truthResolution: candidate.children.truthResolution! } });
  const algorithm = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).create(composition, { provider });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 19, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, algorithm);
  await engine.bootstrapAgents();
  const before = engine.snapshot;
  const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "test-player" }, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, {
    expectedRevision: before.revision, trigger: "participant_action", externalActions: [{ submissionId: "watch", agentId: "player", rawText: "观察庭院", goal: "确认庭院状况", means: null, targetIds: [] }] });
  expect({ planned, reviewed, transitioned }).toEqual({ planned: 1, reviewed: 1, transitioned: 1 });
  expect(result.state.revision).toBe(before.revision + 1);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});

it("reserves room for active asynchronous requests before admitting another E2 dispatch", () => {
  expect(() => assertNonthinkingRunCapacity(140_000_000_000, 0, 0)).not.toThrow();
  expect(() => assertNonthinkingRunCapacity(140_000_000_000, 2, 0)).toThrow("run cap");
  expect(() => assertNonthinkingRunCapacity(0, 0, 200)).toThrow("run cap");
});

it("stops new requests while an awaited advance remains pending and drains its existing request", async () => {
  vi.useFakeTimers();
  try {
    let stopped = false;
    let completed = false;
    let release!: () => void;
    const activeHttp = new Promise<void>(resolve => { release = resolve; });
    const dispatch = vi.fn(() => { if (stopped) throw new Error("deadline reached"); });
    const advance = withStepEfficiencyDeadline(async () => {
      dispatch();
      await activeHttp;
      completed = true;
      dispatch();
    }, () => { stopped = true; }, 1000);
    const rejected = expect(advance).rejects.toThrow("deadline reached");
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(true);
    expect(completed).toBe(false);
    expect(dispatch).toHaveBeenCalledTimes(1);
    release();
    await rejected;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("clears the deadline after an advance finishes or rejects", async () => {
  vi.useFakeTimers();
  try {
    const stop = vi.fn();
    await expect(withStepEfficiencyDeadline(async () => 7, stop)).resolves.toBe(7);
    await expect(withStepEfficiencyDeadline(async () => { throw new Error("failed step"); }, stop)).rejects.toThrow("failed step");
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("preserves reference trial compositions and changes only the selected resolution inventory", () => {
  const base = firstPassAlgorithmRef(createEagerReferenceAlgorithmRef(), "T");
  expect(stepEfficiencyAlgorithmRef()).toEqual(orderedRandomAlgorithmRef(sharedContextAlgorithmRef(base)));
  const direct = orderedRandomAlgorithmRef(base);
  expect(stepEfficiencyAlgorithmRef({ directTruthContext: true })).toEqual(direct);
  const candidate = stepEfficiencyAlgorithmRef({ directTruthContext: true, sourceInventory: true });
  expect(candidate.children.truthResolution!.id).toBe("source-inventory-truth-resolution");
  expect(candidate.children.truthResolution!.children).toEqual(direct.children.truthResolution!.children);
  const { truthResolution: candidateTruth, ...candidateRest } = candidate.children;
  const { truthResolution: baselineTruth, ...baselineRest } = direct.children;
  expect(candidateRest).toEqual(baselineRest);
  expect(candidateTruth!.manifestHash).not.toBe(baselineTruth!.manifestHash);
  expect(registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).has(candidate)).toBe(true);
});

it("pins the admitted source-owned choice compiler without changing scheduling or recovery", () => {
  const base = stepEfficiencyAlgorithmRef({ sourceInventory: true });
  const candidate = stepEfficiencyAlgorithmRef({ sourceInventory: true, compilation: "source-owned-visible-choice-v1" });
  const { actionCompilation, ...rest } = candidate.children;
  const { actionCompilation: original, ...baseRest } = base.children;
  expect(rest).toEqual(baseRest);
  expect(actionCompilation!.children).toEqual(original!.children);
  expect(actionCompilation!.config).toMatchObject({ representation: "AT", descriptionPolicy: "original-action-v1",
    eligibleProfileSchema: "batch-union-v1", profileChoiceEvidence: "visible-schema-v1" });
  expect(registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).has(candidate)).toBe(true);
});

it("pins the admitted dependent representation and physical contract while retaining compiler and recovery", () => {
  const variant = { sourceInventory: true as const, compilation: "source-owned-visible-choice-v1" as const };
  const baseline = stepEfficiencyAlgorithmRef(variant);
  const candidate = stepEfficiencyAlgorithmRef({ ...variant, resolutionRepresentation: "resolution-dependent-fields-v1" });
  const { truthResolution, ...rest } = candidate.children;
  const { truthResolution: original, ...baseRest } = baseline.children;
  expect(rest).toEqual(baseRest);
  expect(truthResolution!.id).toBe("dependent-fields-truth-resolution");
  expect(truthResolution!.children.recovery).toEqual(original!.children.recovery);
  expect(truthResolution!.children.batching!.config).toMatchObject({ ...original!.children.batching!.config,
    requestContract: "physical-cardinality-slot-repair-v2", repairPlacement: "tail-v1" });
  expect(truthResolution!.config.sourceInventory).toBe(original!.config.sourceInventory);
  expect(registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).has(candidate)).toBe(true);
});

it("pins reviewed truth transport without changing the compiler, observations or recovery", () => {
  const variant = { sourceInventory: true as const, resolutionRepresentation: "resolution-dependent-fields-v1" as const };
  const baseline = stepEfficiencyAlgorithmRef(variant);
  const candidate = stepEfficiencyAlgorithmRef({ ...variant, truthTransport: "shared-state-first-v1" });
  const { truthResolution, ...rest } = candidate.children;
  const { truthResolution: original, ...originalRest } = baseline.children;
  expect(rest).toEqual(originalRest);
  expect(truthResolution!.config).toEqual(original!.config);
  expect(truthResolution!.children.recovery).toEqual(original!.children.recovery);
  expect(truthResolution!.children.batching!.config).toMatchObject({ maxSlots: 12, contextCodec: "shared-json-v3",
    contextLayout: "shared-state-first-v1", jsonSyntaxRecovery: "unmatched-closers-v1" });
  expect(registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).has(candidate)).toBe(true);
  expect(() => stepEfficiencyAlgorithmRef({ truthTransport: "shared-state-first-v1" })).toThrow("requires");
});

it("uses the registered truth policy through a real step and preserves singleton rendering and replay", async () => {
  const scripted = new ScriptedModelProvider(({ profileId, context }) => deterministicModelOutput(profileId, context));
  const seen: string[] = [];
  const provider: StructuredModelProvider = { catalog: scripted.catalog,
    availableProfileSummaries: role => scripted.availableProfileSummaries(role), assertProfilesAvailable: ids => scripted.assertProfilesAvailable(ids),
    generateStructured: request => {
      if (request.jsonSyntaxRecovery) {
        seen.push(request.schemaName);
        expect(request.jsonSyntaxRecovery).toBe("unmatched-closers-v1");
        const shared = isSharedBatchContext((request.context as { state?: unknown }).state);
        expect(request.contextLayout).toBe(shared ? "shared-state-first-v1" : undefined);
      }
      return scripted.generateStructured(request);
    } };
  const candidate = stepEfficiencyAlgorithmRef({ sourceInventory: true, resolutionRepresentation: "resolution-dependent-fields-v1", truthTransport: "shared-state-first-v1" });
  const composition = defineAlgorithmRef({ ...FULL_CATALOG_ALGORITHM_REF,
    children: { ...FULL_CATALOG_ALGORITHM_REF.children, truthResolution: candidate.children.truthResolution! } });
  const algorithm = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry()).create(composition, { provider });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 19, modelCatalog: provider.catalog });
  const engine = new SimulationEngine(definition, algorithm);
  await engine.bootstrapAgents();
  const before = engine.snapshot;
  const result = await engine.step({ player: { kind: "external", agentId: "player", participantId: "test-player" },
    keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } }, {
    expectedRevision: before.revision, trigger: "participant_action", externalActions: [{ submissionId: "watch", agentId: "player",
      rawText: "观察庭院", goal: "确认庭院状况", means: null, targetIds: [] }] });
  expect(result.state.revision).toBe(before.revision + 1);
  expect(seen).toContain("truth_resolution_plan_commit");
  expect(seen).toContain("resolution_plan_verification");
  expect(seen.some(name => name.includes("transition"))).toBe(true);
  expect(contentHash(replaySimulationState(result.state).truth)).toBe(contentHash(result.state.truth));
});
