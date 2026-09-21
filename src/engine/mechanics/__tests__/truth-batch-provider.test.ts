import { describe, expect, it } from "vitest";
import {
  ScriptedModelProvider,
  createTestModelCatalog,
} from "../../testing/model-provider";
import {
  ContextLimitExceededError,
  ModelOutputError,
  ModelConfigurationError,
  combineModelExecutionAudits,
  type StructuredModelRequest,
} from "../../models/model-provider";
import { observationRenderSchema, resolutionDirectiveSchema, resolutionContinuationDirectiveSchema, resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../truth-batch-provider";
import { expandSharedBatchContexts, SHARED_BATCH_CONTEXT_CODEC, type SharedBatchContext } from "../shared-batch-context";
import { validationIssues } from "../../contracts/prompts";
import { runSemanticRepairLoop, semanticIssue } from "../../models/semantic-repair";
import { promptBundle } from "../../prompts";
import { repairPromptLayout } from "../../prompts/repair-layout";
import { canonicalize } from "../../models/model-audit";
import { declaredRandomPlanSchema } from "../plan-random-completion";
import { MECHANICAL_PLAN_REPAIR } from "../mechanical-plan-repair";

function request(
  subjectId: string,
  context: Record<string, unknown>,
): StructuredModelRequest<unknown> {
  const task = context.task && typeof context.task === "object"
    ? context.task
    : { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [] };
  const state = context.state && typeof context.state === "object"
    ? context.state
    : context;
  return {
    profileId: "truth-engine",
    workloadId: "instance",
    batchId: "advance",
    role: "truth-resolution",
    subjectId,
    promptVersion: "truth-v1",
    schemaName: "truth_resolution_directive",
    system: "system",
    userPrompt: "resolve",
    context: {
      contractVersion: 17,
      roleContract: { role: "truth-resolution", purpose: "test", modelOwns: [], engineOwns: [], existingReferenceRule: "", proposalRule: "", failureRule: "" },
      execution: { worldId: "world", instanceId: "instance", advanceId: "advance", revision: 0, step: 0 },
      task,
      state,
      referenceCatalog: { version: 2, hash: "test", candidates: [] },
      repair: null,
    },
    schema: resolutionDirectiveSchema,
    runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 0 },
  };
}

function capturePhysicalRequests(provider: ScriptedModelProvider) {
  const physical: StructuredModelRequest<unknown>[] = [];
  const generate = provider.generateStructured.bind(provider);
  provider.generateStructured = async input => { physical.push(input); return generate(input); };
  return physical;
}

describe("TruthBatchCoordinator", () => {
  function targetedPlan(id: string): StructuredModelRequest<unknown> {
    const input = request(id, { task: { assignment: { targetHandles: [] }, constraints: [`repair only ${id}`],
      resolutionScope: { mode: "repair", selectedActionRefs: [`ref:action:${id}`], totalActionCount: 2 } },
      state: { actionSet: { assigned: [{ actionRef: `ref:action:${id}`, rawText: `Original action ${id}` }] },
        canonicalTruth: { facts: "complete shared source" } } });
    input.schemaName = "truth_resolution_plan_repair";
    input.schema = resolutionPlanCommitDirectiveSchema;
    (input.context as Record<string, unknown>).repair = { target: { kind: "plan", ref: `ref:plan:${id}` },
      issues: [{ reason: `unsupported claim for ${id}` }], previousOutput: { description: `rejected-${id}` } };
    return input;
  }

  function scopedPlan(context: unknown, invalid = false) {
    const ref = (context as { state: { actionSet: { assigned: { actionRef: string }[] } } }).state.actionSet.assigned[0]!.actionRef;
    return { kind: "commit_plans", plans: [{ proposalKey: "plan", actionRef: ref, targetRefs: [], means: [], mode: "automatic",
      difficulty: null, actorRatingRef: null, factors: [], risk: "safe", baseEffect: invalid ? "invalid" : "none",
      primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref }] }] };
  }

  it.each(["mechanical", "unmarked", "foreign-contract"])("coalesces compatible component recovery without merging logical responsibilities: %s", async variant => {
    const inputs = [targetedPlan("local"), targetedPlan("whole")];
    inputs.forEach(input => { input.schemaName = "truth_resolution_plan_commit"; });
    const first = inputs[0]!.context as Record<string, unknown>, second = inputs[1]!.context as Record<string, unknown>;
    first.repair = { issues: [{ path: ["plans", 1], reason: "invalid local plan" }], previousOutput: { retained: "original full candidate" },
      ...(variant === "unmarked" ? {} : { planReplacement: { contractVersion: variant === "mechanical" ? MECHANICAL_PLAN_REPAIR : "unknown", retainedPlanCount: 1 } }) };
    second.repair = { issues: [{ path: ["plans", 0], reason: "invalid whole component" }], previousOutput: { retained: "different candidate" } };
    (second.task as { resolutionScope: { mode: string } }).resolutionScope.mode = "component";
    const provider = new ScriptedModelProvider(input => input.schemaName.endsWith("_batch")
      ? { slots: expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state)
        .map((context, slot) => ({ slot, result: scopedPlan(context) })) }
      : scopedPlan(input.context), createTestModelCatalog(), false);
    const physical = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
      "tail-v1", "post-promise-v1", "scoped-plans-v1");
    const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(physical).toHaveLength(variant === "mechanical" ? 1 : 2);
    expect(results.map(result => (result.value as { plans: Array<{ actionRef: string }> }).plans[0]!.actionRef)).toEqual(["ref:action:local", "ref:action:whole"]);
    if (variant === "mechanical") expect(expandSharedBatchContexts((physical[0]!.context as { state: SharedBatchContext }).state))
      .toEqual(inputs.map(input => input.context));
  });

  it("carries the exact selected plan schema and separates otherwise identical logical contracts", async () => {
    const inputs = ["a", "b", "base"].map(id => ({ ...targetedPlan(id), schemaName: "truth_resolution_plan_commit",
      schema: id === "base" ? resolutionPlanCommitDirectiveSchema : declaredRandomPlanSchema }));
    const respond = (context: unknown) => {
      const result = scopedPlan(context), ref = result.plans[0]!.actionRef;
      return { ...result, plans: result.plans.map(plan => ({ ...plan,
        ...(ref.endsWith(":base") ? {} : { additionalRandomness: ref.endsWith(":a") ? "none" : "defer" }) })) };
    };
    const provider = new ScriptedModelProvider(input => input.schemaName.endsWith("_batch")
      ? { slots: expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state)
        .map((context, slot) => ({ slot, result: respond(context) })) }
      : respond(input.context), createTestModelCatalog(), false);
    const physical = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
      "tail-v1", "post-promise-v1", "scoped-plans-v1");
    const result = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(physical).toHaveLength(2);
    expect(result.map(r => (r.value as { plans: Array<{ additionalRandomness?: string }> }).plans[0]!.additionalRandomness))
      .toEqual(["none", "defer", undefined]);
    const batch = physical.find(r => r.schemaName.endsWith("_batch"))!;
    expect(expandSharedBatchContexts((batch.context as { state: SharedBatchContext }).state)).toEqual(inputs.slice(0, 2).map(r => r.context));
    const incomplete = { slots: inputs.slice(0, 2).map((r, slot) => ({ slot, result: scopedPlan(r.context) })) };
    expect(batch.schema.safeParse(incomplete).success).toBe(false);
  });

  it("retains scoped plan contexts and rejects only the malformed neighbor", async () => {
    const inputs = [targetedPlan("first"), targetedPlan("second")];
    const provider = new ScriptedModelProvider(input => ({ slots: expandSharedBatchContexts(
      (input.context as { state: SharedBatchContext }).state).map((context, slot) => ({ slot, result: scopedPlan(context, slot === 1) })) }), createTestModelCatalog(), false);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
      "tail-v1", "post-promise-v1", "scoped-plans-v1");
    const result = await Promise.allSettled(inputs.map(input => coordinator.generateStructured(input)));
    expect(provider.requests).toHaveLength(1);
    expect(expandSharedBatchContexts((provider.requests[0]!.context as { state: SharedBatchContext }).state)).toEqual(inputs.map(i => i.context));
    expect(result[0]).toMatchObject({ status: "fulfilled", value: { value: { plans: [{ actionRef: "ref:action:first" }] } } });
    expect(result[1]).toMatchObject({ status: "rejected", reason: expect.any(ModelOutputError) });
  });

  it("keeps scoped repairs separate across profile, execution, signals and initial planning boundaries", async () => {
    for (const boundary of ["revision", "profile", "abort", "cancel-pending", "initial"]) {
      const inputs = [targetedPlan("first"), targetedPlan("second")], second = inputs[1]!;
      if (boundary === "revision") second.runtimeIdentity = { ...second.runtimeIdentity!, revision: 1 };
      if (boundary === "profile") second.profileId = "truth-deepseek";
      if (boundary === "abort") second.abortSignal = new AbortController().signal;
      if (boundary === "cancel-pending") second.cancelPendingSignal = new AbortController().signal;
      if (boundary === "initial") second.schemaName = "truth_resolution_plan_commit";
      const provider = new ScriptedModelProvider(input => scopedPlan(input.context), createTestModelCatalog(), false);
      const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
        "tail-v1", "post-promise-v1", "scoped-plans-v1");
      await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests.map(r => r.schemaName)).toEqual(inputs.map(r => r.schemaName));
    }
    const provider = new ScriptedModelProvider(() => ({}));
    expect(() => new TruthBatchCoordinator(provider, 12, 0, undefined, undefined, undefined, undefined, "scoped-plans-v1"))
      .toThrow("requires shared contexts");
  });

  function initialComponent(id: string, count: number): StructuredModelRequest<unknown> {
    const input = targetedPlan(id);
    input.schemaName = "truth_resolution_plan_commit";
    const context = input.context as { repair: unknown; task: { resolutionScope: { mode: string; selectedActionRefs: string[] } };
      state: { actionSet: { assigned: Array<{ actionRef: string; rawText: string }> } } };
    context.repair = null;
    context.task.resolutionScope.mode = "component";
    context.state.actionSet.assigned = Array.from({ length: count }, (_, index) => ({ actionRef: `ref:action:${id}-${index}`, rawText: `Complete source ${id}-${index}` }));
    context.task.resolutionScope.selectedActionRefs = context.state.actionSet.assigned.map(action => action.actionRef);
    return input;
  }

  function completeComponent(context: unknown) {
    const result = scopedPlan(context);
    const actions = (context as { state: { actionSet: { assigned: { actionRef: string }[] } } }).state.actionSet.assigned;
    return { ...result, plans: actions.map(({ actionRef }, index) => ({ ...result.plans[0]!, proposalKey: `plan-${index}`,
      actionRef, causes: [{ kind: "action", ref: actionRef }] })) };
  }

  function physicalContexts(input: Pick<StructuredModelRequest<unknown>, "schemaName" | "context">) {
    return input.schemaName.endsWith("_batch")
      ? expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state) : [input.context];
  }

  function componentResponse(input: Pick<StructuredModelRequest<unknown>, "schemaName" | "context">) {
    const results = physicalContexts(input).map(completeComponent);
    return input.schemaName.endsWith("_batch") ? { slots: results.map((result, slot) => ({ slot, result })) } : results[0];
  }

  it("balances the complete ready wave without adding calls or dividing conflict components", async () => {
    const counts = [2, 3, 22, 1, 1, 3, 2, 2, 1, 1, 1, 1, ...Array<number>(9).fill(1)];
    const inputs = counts.map((count, index) => initialComponent(`component-${String(index).padStart(2, "0")}`, count));
    const groups: unknown[][][] = [];
    for (const reversed of [false, true]) {
      const order = reversed ? [...inputs].reverse() : inputs;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const provider = new ScriptedModelProvider(async input => { await gate; return componentResponse(input); }, createTestModelCatalog(), false);
      const physical = capturePhysicalRequests(provider);
      const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
        "tail-v1", "post-promise-v1", "scoped-plans-v1", "ready-wave-work-v1");
      const pending = Promise.all(order.map(async (input, index) => {
        if (index >= 12) await Promise.resolve();
        return coordinator.generateStructured(input);
      }));
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(physical).toHaveLength(2);
        const grouped = physical.map(physicalContexts);
        expect(grouped.map(contexts => contexts.length)).toEqual([9, 12]);
        expect(grouped.map(contexts => contexts.reduce<number>((sum, context) => sum +
          (context as { state: { actionSet: { assigned: unknown[] } } }).state.actionSet.assigned.length, 0))).toEqual([30, 19]);
        const normalized = (contexts: unknown[]) => contexts.map(canonicalize).map(value => JSON.stringify(value)).sort();
        expect(normalized(grouped.flat())).toEqual(normalized(inputs.map(input => input.context)));
        groups.push(grouped);
      } finally { release(); }
      const results = await pending;
      expect(results.map(result => result.value)).toEqual(order.map(input => completeComponent(input.context)));
    }
    expect(groups[1]).toEqual(groups[0]);
  });

  it.each([1, 2, 12, 13, 25])("uses the minimum physical request count for a ready wave of %i components", async count => {
    const inputs = Array.from({ length: count }, (_, index) => initialComponent(`component-${index}`, 1));
    const provider = new ScriptedModelProvider(componentResponse, createTestModelCatalog(), false);
    const physical = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
      "tail-v1", "post-promise-v1", "scoped-plans-v1", "ready-wave-work-v1");
    await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(physical).toHaveLength(Math.ceil(count / 12));
    expect(physical.every(input => physicalContexts(input).length <= 12)).toBe(true);
  });

  it("balances whole components deterministically and dispatches both groups before either finishes", async () => {
    const inputs = [18, 20, 2, 1, 1, 1, 1, 1, 2, 1, 1].map((count, index) => initialComponent(`component-${String(index).padStart(2, "0")}`, count));
    const original = structuredClone(inputs.map(input => input.context));
    const runs: unknown[][] = [];
    for (const order of [inputs, [...inputs].reverse()]) {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const provider = new ScriptedModelProvider(async input => { await gate; return componentResponse(input); }, createTestModelCatalog(), false);
      const physical = capturePhysicalRequests(provider);
      const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
        "tail-v1", "post-promise-v1", "scoped-plans-v1", "balanced-two-v1");
      const pending = Promise.all(order.map(input => coordinator.generateStructured(input)));
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(physical).toHaveLength(2);
        const grouped = physical.map(physicalContexts);
        expect(grouped.map(contexts => contexts.reduce<number>((total, context) => total +
          (context as { state: { actionSet: { assigned: unknown[] } } }).state.actionSet.assigned.length, 0))).toEqual([25, 24]);
        expect(grouped.map(contexts => contexts.length)).toEqual([5, 6]);
        const sorted = (contexts: unknown[]) => [...contexts].sort((a, b) => JSON.stringify(canonicalize(a)).localeCompare(JSON.stringify(canonicalize(b))));
        expect(sorted(grouped.flat())).toEqual(sorted(original));
        runs.push(grouped);
      } finally { release(); }
      const results = await pending;
      expect(results.map(result => result.value)).toEqual(order.map(input => completeComponent(input.context)));
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(inputs.map(input => input.context)).toEqual(original);
  });

  it.each(["balanced-two-v1", "ready-wave-work-v1"] as const)("keeps repair and global grouping, unsupported workloads and the original default intact: %s", async policy => {
    for (const mode of ["default", "repair", "global", "missing"]) {
      const inputs = [initialComponent("a", 2), initialComponent("b", 3)];
      for (const input of inputs) {
        const context = input.context as { repair: unknown; task: { resolutionScope: { mode: string } }; state: { actionSet?: unknown } };
        if (mode === "repair") context.repair = { issues: [{ reason: "repair original component" }] };
        if (mode === "global") context.task.resolutionScope.mode = "global";
        if (mode === "missing") delete context.state.actionSet;
      }
      const provider = new ScriptedModelProvider(() => ({ slots: [0, 1].map(slot => ({ slot,
        result: completeComponent(initialComponent(String(slot), 1).context) })) }), createTestModelCatalog(), false);
      const physical = capturePhysicalRequests(provider);
      const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
        "tail-v1", "post-promise-v1", "scoped-plans-v1", mode === "default" ? undefined : policy);
      await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
      expect(physical).toHaveLength(1);
      expect(physicalContexts(physical[0]!)).toEqual(inputs.map(input => input.context));
    }
  });

  it.each(["balanced-two-v1", "ready-wave-work-v1"] as const)("keeps the slot ceiling and malformed result ownership under balanced planning: %s", async policy => {
    const inputs = Array.from({ length: 13 }, (_, index) => initialComponent(`component-${String(index).padStart(2, "0")}`, 1));
    const provider = new ScriptedModelProvider(input => {
      const response = componentResponse(input)!;
      if ("slots" in response) {
        for (const slot of response.slots) if (slot.result.plans[0]!.actionRef.endsWith("component-03-0")) slot.result.plans[0]!.baseEffect = "invalid";
      }
      return response;
    }, createTestModelCatalog(), false);
    const physical = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
      "tail-v1", "post-promise-v1", "scoped-plans-v1", policy);
    const results = await Promise.allSettled(inputs.map(input => coordinator.generateStructured(input)));
    expect(physical.map(input => physicalContexts(input).length)).toEqual(policy === "balanced-two-v1" ? [6, 6, 1] : [7, 6]);
    expect(results.map(result => result.status)).toEqual(inputs.map((_, index) => index === 3 ? "rejected" : "fulfilled"));
    expect(results[3]).toMatchObject({ reason: expect.any(ModelOutputError) });
    if (policy === "balanced-two-v1") expect(physical[2]!.context).toEqual(inputs[12]!.context);
  });

  it.each(["balanced-two-v1", "ready-wave-work-v1"] as const)("preserves execution and signal boundaries before balancing: %s", async policy => {
    for (const boundary of ["revision", "profile", "abort", "cancel-pending"]) {
      const inputs = ["a", "b", "c", "d"].map(id => initialComponent(id, 2));
      const signal = new AbortController().signal;
      for (const input of inputs.slice(2)) {
        if (boundary === "revision") input.runtimeIdentity = { ...input.runtimeIdentity!, revision: 1 };
        if (boundary === "profile") input.profileId = "truth-deepseek";
        if (boundary === "abort") input.abortSignal = signal;
        if (boundary === "cancel-pending") input.cancelPendingSignal = signal;
      }
      const provider = new ScriptedModelProvider(componentResponse, createTestModelCatalog(), false);
      const physical = capturePhysicalRequests(provider);
      const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
        "tail-v1", "post-promise-v1", "scoped-plans-v1", policy);
      await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
      expect(physical).toHaveLength(policy === "balanced-two-v1" ? 4 : 2);
      expect(physical.flatMap(physicalContexts)).toEqual(inputs.map(input => input.context));
    }
    expect(() => new TruthBatchCoordinator(new ScriptedModelProvider(() => ({})), 12, 0, undefined, undefined,
      undefined, undefined, undefined, "balanced-two-v1")).toThrow("requires shared contexts");
  });

  function targetedObservation(id: string): StructuredModelRequest<unknown> {
    const input = request(id, {
      task: { assignment: { targetHandles: [`ref:agent:${id}`] }, constraints: [`repair only ${id}`] },
      state: { sourceEvidence: { owner: id, privateFact: `visible-to-${id}` },
        observationSlots: [{ observer: { agentRef: `ref:agent:${id}`, selfEntityRef: `ref:entity:${id}`,
          localEntities: [{ ref: `ref:local_entity:${id}`, canonicalEntityRefs: [`ref:entity:${id}`] }] } }],
        actionSet: { assigned: [{ actionRef: `ref:action:${id}`, actorRef: `ref:agent:${id}` }] },
        outcomes: [{ actionRef: `ref:action:${id}`, status: "continuing", summary: "No confirmed result" }], currentEvents: [],
      },
    });
    input.role = "observation-renderer";
    input.schemaName = "observation_render";
    input.schema = observationRenderSchema;
    (input.context as Record<string, unknown>).repair = {
      target: `ref:agent:${id}`, issues: [{ path: ["summary"], reason: `unsupported claim for ${id}` }],
      previousOutput: { summary: `rejected-${id}` },
    };
    return input;
  }

  it.each(["shared-json-v2", "shared-json-v3"] as const)("coalesces targeted observation repairs without sharing ownership using %s", async codec => {
    const provider = new ScriptedModelProvider(input => {
      const draft = (id: string) => ({ summary: id, introductions: [], apparentClaims: [], sourceEventRefs: [] });
      if (input.schemaName === "observation_render") return draft(input.subjectId);
      const contexts = expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state);
      return { slots: contexts.map((context, slot) => ({ slot, result: draft(
        ((context as { repair: { target: string } }).repair.target).replace("ref:agent:", "")) })) };
    }, createTestModelCatalog(), false);
    const inputs = Array.from({ length: 6 }, (_, index) => targetedObservation(`observer-${index}`));
    const coordinator = new TruthBatchCoordinator(provider, 12, 2, codec, TRUTH_BATCH_REQUEST_CONTRACT);
    const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(provider.requests).toHaveLength(1);
    expect(expandSharedBatchContexts((provider.requests[0]!.context as { state: SharedBatchContext }).state))
      .toEqual(inputs.map(input => input.context));
    expect(results.map(result => (result.value as { summary: string }).summary)).toEqual(inputs.map(input => input.subjectId));
  });

  it.each([undefined, "post-promise-v1"] as const)("rejects only the malformed targeted repair slot under %s scheduling", async flushBoundary => {
    const provider = new ScriptedModelProvider(() => ({ slots: [
      { slot: 0, result: { summary: "first", introductions: [], apparentClaims: [], sourceEventRefs: [] } },
      { slot: 1, result: { summary: "second", introductions: [], apparentClaims: "invalid", sourceEventRefs: [] } },
    ] }), createTestModelCatalog(), false);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, undefined, flushBoundary);
    const results = await Promise.allSettled(["first", "second"].map(id => coordinator.generateStructured(targetedObservation(id))));
    expect(provider.requests).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "fulfilled", value: { value: { summary: "first" } } });
    expect(results[1]).toMatchObject({ status: "rejected", reason: expect.any(ModelOutputError) });
  });

  it.each([undefined, "post-promise-v1"] as const)("keeps every targeted repair boundary under %s scheduling", async flushBoundary => {
    for (const boundary of ["revision", "profile", "abort", "cancel-pending", "normal"]) {
    const provider = new ScriptedModelProvider(() => ({ summary: "visible", introductions: [], apparentClaims: [], sourceEventRefs: [] }), createTestModelCatalog(), false);
    const inputs = [targetedObservation("first"), targetedObservation("second")];
    const second = inputs[1]!;
    if (boundary === "revision") second.runtimeIdentity = { ...second.runtimeIdentity!, revision: 1 };
    if (boundary === "profile") second.profileId = "truth-deepseek";
    if (boundary === "abort") second.abortSignal = new AbortController().signal;
    if (boundary === "cancel-pending") second.cancelPendingSignal = new AbortController().signal;
    if (boundary === "normal") (second.context as Record<string, unknown>).repair = null;
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, undefined, flushBoundary);
    await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.map(input => input.schemaName)).toEqual(["observation_render", "observation_render"]);
    }
  });

  it("flushes partial post-promise batches and retains the twelve-slot ceiling", async () => {
    const provider = new ScriptedModelProvider(input => input.schemaName.endsWith("_batch")
      ? { slots: (input.context as { task: { slots: Array<{ slot: number }> } }).task.slots.map(({ slot }) => ({ slot, result: { kind: "done" } })) }
      : { kind: "done" }, createTestModelCatalog(), false);
    const physical = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 0, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, undefined, "post-promise-v1");
    await coordinator.generateStructured(request("alone", {}));
    expect(physical).toHaveLength(1);
    await Promise.all(Array.from({ length: 13 }, (_, index) => coordinator.generateStructured(request(`slot-${index}`, {}))));
    expect(physical.slice(1).map(input => (input.context as { task: { slots?: unknown[] } }).task.slots?.length ?? 1)).toEqual([12, 1]);
    expect(() => new TruthBatchCoordinator(provider, 12, 0, undefined, undefined, undefined, "post-promise-v1")).toThrow("requires shared contexts");
  });

  it.each([undefined, "shared-json-v2", "shared-json-v3"] as const)("preserves complete logical repair evidence in %s batches", async codec => {
    const provider = new ScriptedModelProvider(() => ({ slots: [0, 1].map(slot => ({ slot, result: { kind: "done" } })) }), createTestModelCatalog(), false);
    const inputs = ["a", "b"].map(id => {
      const input = request(id, { state: { source: id } });
      (input.context as Record<string, unknown>).repair = { issues: [{ path: ["plans", 0], reason: id }],
        previousOutputAvailable: true, previousOutput: { kind: "commit_plans", plans: [{ actionRef: `ref:action:${id}` }] },
        candidateBinding: { sourceContextHash: id, logicalInvocationId: id } };
      return input;
    });
    const batch = new TruthBatchCoordinator(provider, 12, 2, codec);
    await Promise.all(inputs.map(input => batch.generateStructured(input)));
    expect(provider.requests).toHaveLength(1);
    const physical = provider.requests[0]!.context as { state: SharedBatchContext; task: { slots: { repair: unknown }[] } };
    const repairs = codec ? expandSharedBatchContexts(physical.state).map(context => context.repair) : physical.task.slots.map(slot => slot.repair);
    expect(repairs).toEqual(inputs.map(input => (input.context as { repair: unknown }).repair));
  });

  it.each([2, 5, 12])("binds the opt-in output contract to %i real slots without changing logical data", async (count) => {
    const provider = new ScriptedModelProvider(input => ({ slots:
      expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state)
        .map((_, slot) => ({ slot, result: { kind: "done" } })),
    }), createTestModelCatalog(), false);
    const physicalRequests = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC, TRUTH_BATCH_REQUEST_CONTRACT);
    const inputs = Array.from({ length: count }, (_, slot) => request(`component-${String(slot).padStart(2, "0")}`, { state: { source: `unchanged-${slot}` } }));
    const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(results).toHaveLength(count);
    const physical = physicalRequests[0]!;
    expect(physical.jsonExamplePolicy).toBe("omit");
    expect(physical.promptVersion).toContain(TRUTH_BATCH_REQUEST_CONTRACT);
    expect(physical.schema.safeParse({ slots: [] }).success).toBe(false);
    const output = { slots: Array.from({ length: count }, (_, slot) => ({ slot, result: { kind: "done" } })) };
    expect(physical.schema.safeParse(output).success).toBe(true);
    output.slots[0]!.slot = count;
    expect(physical.schema.safeParse(output).success).toBe(false);
    expect(expandSharedBatchContexts((physical.context as { state: SharedBatchContext }).state)).toEqual(inputs.map(input => input.context));
  });

  it("retains source scope and exact cardinality after missing and duplicate physical slot outputs", async () => {
    let attempts = 0;
    const provider = new ScriptedModelProvider(() => {
      attempts++;
      const slots = attempts === 1 ? [0] : attempts === 2 ? [0, 0] : [0, 1];
      return { slots: slots.map(slot => ({ slot, result: { kind: "done" } })) };
    }, createTestModelCatalog(), false);
    const physicalRequests = capturePhysicalRequests(provider);
    const coordinator = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC, TRUTH_BATCH_REQUEST_CONTRACT);
    const inputs = [request("first", { state: { source: "first-full-action" } }), request("second", { state: { source: "second-full-action" } })];
    const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(results).toHaveLength(2);
    expect(provider.requests).toHaveLength(3);
    for (const physical of physicalRequests) {
      expect(physical.jsonExamplePolicy).toBe("omit");
      expect(physical.schema.safeParse({ slots: [{ slot: 0, result: { kind: "done" } }] }).success).toBe(false);
      expect(expandSharedBatchContexts((physical.context as { state: SharedBatchContext }).state)).toEqual(inputs.map(input => input.context));
    }
  });

  it("composes the shipped observation instructions for six isolated tasks and direct repair", async () => {
    const bundle = promptBundle("observation-renderer");
    const provider = new ScriptedModelProvider(input => {
      const draft = (id: string) => ({ summary: `Visible result for ${id}`, introductions: [], apparentClaims: [], sourceEventRefs: [] });
      if (input.schemaName === "observation_projection_batch") {
        const contexts = expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state);
        return { slots: contexts.map((context, slot) => ({ slot, result: draft((context as { state: { observer: string } }).state.observer) })) };
      }
      return draft((input.context as { state: { observer: string } }).state.observer);
    }, createTestModelCatalog(), false);
    const coordinator = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const inputs = Array.from({ length: 6 }, (_, index) => ({
      ...request(`observer-${index}`, {
        task: { assignment: { targetHandles: [`ref:agent:observer-${index}`] }, constraints: [] },
        state: { observer: `observer-${index}`, privateClaim: `only-${index}`,
          observationSlots: [{ observer: { agentRef: `ref:agent:observer-${index}`, selfEntityRef: `ref:entity:observer-${index}`,
            localEntities: [{ ref: `ref:local_entity:observer-${index}::self`, canonicalEntityRefs: [`ref:entity:observer-${index}`] }] } }],
          actionSet: { assigned: [{ actionRef: `ref:action:action-${index}`, actorRef: index === 5 ? "ref:agent:someone-else" : `ref:agent:observer-${index}`, rawText: `Ask first; do not assume consent ${index}`, goal: "Preserve the whole task", targetRefs: ["ref:entity:keeper"] }] },
          outcomes: [{ actionRef: "ref:action:foreign", status: "succeeded", summary: "Another actor result" },
            { actionRef: `ref:action:action-${index}`, status: "continuing", summary: `Pending ${index}` }], currentEvents: [],
        },
      }),
      role: "observation-renderer" as const, schemaName: "observation_render", schema: observationRenderSchema,
      system: bundle.system, userPrompt: bundle.userPrompt, promptVersion: bundle.version,
    }));
    const results = await Promise.all(inputs.map(input => coordinator.generateStructured(input)));
    expect(results.map(result => (result.value as { summary: string }).summary))
      .toEqual(inputs.map(input => `Visible result for ${input.subjectId}`));
    expect(provider.requests).toHaveLength(1);
    const physical = provider.requests[0]!;
    expect(expandSharedBatchContexts((physical.context as { state: SharedBatchContext }).state))
      .toEqual(inputs.map(input => input.context));
    expect(physical.system).toContain("When the schema has a `slots` envelope");
    expect(physical.system).toContain("including tasks with no observable change");
    expect(physical.system).toContain("another slot's context grants no knowledge or references");
    expect(`${physical.system}\n${physical.userPrompt}`).not.toMatch(/never a batch wrapper|rather than a batch wrapper|This request owns exactly one observer/u);
    expect(physical.userPrompt).toContain("return exactly one {slot,result} entry per slot");
    expect((physical.context as { task: { slots: unknown[] } }).task.slots[5]).toMatchObject({
      observerBinding: { observerRef: "ref:agent:observer-5", selfLocalRefs: ["ref:local_entity:observer-5::self"],
        existingLocalEntityRefs: ["ref:local_entity:observer-5::self"], ownActionRefs: [], ownAttempts: [], currentEventCount: 0,
        otherActionActors: [{ actionRef: "ref:action:action-5", actorRef: "ref:agent:someone-else" }] },
    });
    expect((physical.context as { task: { slots: unknown[] } }).task.slots[0]).toMatchObject({
      observerBinding: { ownActionRefs: ["ref:action:action-0"], otherActionActors: [] },
    });
    const owned = (physical.context as { task: { slots: Array<{ observerBinding: { ownAttempts: unknown[] } }> } }).task.slots[0]!.observerBinding.ownAttempts;
    expect(owned).toEqual([{ action: (inputs[0]!.context as { state: { actionSet: { assigned: unknown[] } } }).state.actionSet.assigned[0],
      outcomes: [{ actionRef: "ref:action:action-0", status: "continuing", summary: "Pending 0" }] }]);
    await coordinator.generateStructured(inputs[4]!);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]).toMatchObject({ schemaName: "observation_render", context: inputs[4]!.context });
    expect(provider.requests[1]!.system).toContain("For a single task, return its observation draft directly");
  });

  it("replaces a physical schema diagnostic with the rejected logical slot's field error", async () => {
    const provider = new ScriptedModelProvider(() => ({ slots: [
      { slot: 0, result: { kind: "commit_plans", plans: [{ proposalKey: "plan", actionRef: "ref:action:action",
        targetRefs: [], means: [], mode: "automatic", difficulty: null, actorRatingRef: null, factors: [],
        risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
        visibility: "full", causes: [{ kind: "action", ref: "ref:action:action" }] }] } },
      { slot: 1, result: { kind: "commit_plans", plans: "invalid" } },
    ] }), createTestModelCatalog(), false);
    const original = provider.generateStructured.bind(provider);
    provider.generateStructured = async (input) => {
      try { return await original(input); } catch (error) {
        if (error instanceof ModelOutputError && error.audit?.invocations.at(-1)) {
          error.audit.invocations.at(-1)!.issues = [{ code: "ModelOutputError", class: "structure", path: [], message: "physical batch schema failed" }];
        }
        throw error;
      }
    };
    const batch = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const results = await Promise.allSettled(["a", "b"].map(id => batch.generateStructured({
      ...request(id, { value: id }), schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
    })));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const rejected = (results.find(r => r.status === "rejected") as PromiseRejectedResult).reason as ModelOutputError;
    let repairIssues: unknown;
    await expect(runSemanticRepairLoop({ role: "truth-resolution", repairScope: "step", targetIds: ["b"], maxRepairs: 1,
      invoke: async (context) => {
        if (context.attempt === 0) throw rejected;
        repairIssues = context.issues;
        throw new ModelConfigurationError("repair context captured");
      }, classify: error => validationIssues(error).map(issue => semanticIssue(issue.code, issue.message, { path: issue.path, class: issue.class ?? "structure" })),
    })).rejects.toThrow("repair context captured");
    expect(repairIssues).toMatchObject([{ code: "invalid_type", path: ["plans"], class: "structure" }]);
    expect(JSON.stringify(repairIssues)).not.toContain("physical batch schema failed");
    expect(provider.requests).toHaveLength(1);
  });

  it("keeps proposal declarations local while salvaging structurally valid results", async () => {
    const plan = (index: number) => ({ proposalKey: "local-plan", actionRef: "ref:action:action",
      targetRefs: ["ref:entity:actor"], means: [], mode: "automatic", difficulty: null,
      actorRatingRef: null, factors: [], risk: "safe", baseEffect: "minor", visibility: "full",
      causes: [{ kind: "action", ref: "ref:action:action" }], secondaryEffect: null, threatenedEffect: null,
      primaryEffect: { kind: "condition", proposalKey: `condition-${index}`, targetRef: "ref:entity:actor", channel: "social",
        label: "condition", description: "A grounded local condition", sourceRefs: [{ kind: "action", ref: "ref:action:action" }],
        conditionRef: { proposalKey: "condition-0" }, conditionProfileRef: null, durationProfileRef: "ref:mechanic:scene",
        access: { kind: "public" }, magnitude: "minor" } });
    const provider = new ScriptedModelProvider(() => ({ slots: [0, 1].map((slot) => ({ slot,
      result: { kind: "commit_plans", plans: [plan(slot)] } })) }), createTestModelCatalog(), false);
    const batch = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const result = await Promise.allSettled(["a", "b"].map((id) => batch.generateStructured({
      ...request(id, { value: id }), schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
    })));
    expect(provider.requests).toHaveLength(1);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const failure = result.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason.message).toContain("condition-0 is not declared");
  });

  it("repairs normalization and schema failures with only their owning slot's evidence", async () => {
    const draft = { kind: "commit_plans", plans: [{ proposalKey: "local-plan", actionRef: "ref:action:action",
      targetRefs: ["ref:entity:actor"], means: [], mode: "automatic", difficulty: null,
      actorRatingRef: null, factors: [], risk: "safe", baseEffect: "minor", visibility: "full",
      causes: [{ kind: "action", ref: "ref:action:action" }], secondaryEffect: null, threatenedEffect: null,
      primaryEffect: { kind: "condition", proposalKey: "declared", targetRef: "ref:entity:actor", channel: "social",
        label: "condition", description: "A grounded local condition", sourceRefs: [{ kind: "action", ref: "ref:action:action" }],
        conditionRef: { proposalKey: "undeclared" }, conditionProfileRef: null, durationProfileRef: "ref:mechanic:scene",
        access: { kind: "public" }, magnitude: "minor" } }] };
    const provider = new ScriptedModelProvider(() => ({ slots: [
      { slot: 0, result: draft }, { slot: 1, result: { kind: "commit_plans", plans: "invalid" } },
    ] }), createTestModelCatalog(), false);
    const batch = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const captures: unknown[] = [];
    await Promise.all(["a", "b"].map(async (id, index) => {
      await expect(runSemanticRepairLoop({ role: "truth-resolution", repairScope: "slot", targetIds: [id], maxRepairs: 1,
        invoke: async (context) => {
          if (context.attempt === 0) return batch.generateStructured({ ...request(id, { value: id }),
            schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema });
          captures[index] = context.issues;
          throw new ModelConfigurationError("captured local repair");
        }, classify: error => validationIssues(error).map(issue => semanticIssue(issue.code, issue.message,
          { path: issue.path, class: issue.class ?? "structure" })),
      })).rejects.toThrow("captured local repair");
    }));
    expect(captures[0]).toMatchObject([{ path: ["plans", 0, "primaryEffect", "conditionRef"],
      originalValue: { proposalKey: "undeclared" } }]);
    expect(captures[0]).toHaveLength(1);
    expect(captures[1]).toMatchObject([{ code: "invalid_type", path: ["plans"] }]);
    expect(captures[1]).toHaveLength(1);
    expect(JSON.stringify(captures)).not.toContain('"slots"');
    expect(provider.requests).toHaveLength(1);
  });

  it("retains valid slots after provider schema rejection and keeps direct repair audits compatible", async () => {
    const provider = new ScriptedModelProvider((input) => input.schemaName.endsWith("_batch")
      ? { slots: [{ slot: 0, result: { kind: "done" } }, { slot: 1, result: { kind: "invalid" } }] }
      : { kind: "done" }, createTestModelCatalog(), false);
    const batch = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const inputs = ["a", "b"].map((id) => ({ ...request(`component-${id}`, { value: id }),
      schemaName: "truth_resolution_continuation", schema: resolutionContinuationDirectiveSchema }));
    const results = await Promise.allSettled(inputs.map((input) => batch.generateStructured(input)));
    expect(provider.requests).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedIndex = results.findIndex((result) => result.status === "rejected");
    const failed = results[rejectedIndex] as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(ModelOutputError);
    const rejected = failed.reason as ModelOutputError;
    const input = inputs[rejectedIndex]!;
    expect(rejected.audit!.subjectId).toBe(input.subjectId);
    expect(rejected.audit!.promptVersion).toBe(input.promptVersion);
    const repaired = await batch.generateStructured({ ...input, modelInvocation: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(combineModelExecutionAudits([rejected.audit!, repaired.audit]).invocations).toHaveLength(2);
    const accepted = results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof batch.generateStructured>>>;
    expect(accepted.value.audit.invocations[0]!.id).toBe(rejected.audit!.invocations[0]!.id);
  });

  it("coalesces actual continuation names across independent assignments and restores every context", async () => {
    const provider = new ScriptedModelProvider((input) => ({
      slots: expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state)
        .map((_, slot) => ({ slot, result: { kind: "done" } })),
    }), createTestModelCatalog(), false);
    const batch = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    const requests = ["a", "b"].map((id) => ({
      ...request(`component-${id}`, {
        state: { canonicalTruth: { description: "world".repeat(2000) }, actionSet: { assigned: [id] } },
        task: { assignment: { targetHandles: [id] }, constraints: [], resolutionScope: { mode: "component", selectedActionRefs: [id] } },
      }), schemaName: "truth_resolution_continuation", schema: resolutionContinuationDirectiveSchema,
    }));
    const result = await Promise.all(requests.map((entry) => batch.generateStructured(entry)));
    expect(result.map((entry) => entry.value)).toEqual([{ kind: "done" }, { kind: "done" }]);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.schemaName).toBe("truth_resolution_continuation_batch");
    expect(expandSharedBatchContexts((provider.requests[0]!.context as { state: SharedBatchContext }).state))
      .toEqual(requests.map((entry) => entry.context));
  });

  it("keeps distinct cancellation lifetimes on separate physical requests", async () => {
    const provider = new ScriptedModelProvider(() => ({ kind: "done" }), createTestModelCatalog(), false);
    const batch = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC);
    await Promise.all(["a", "b"].map((id) => batch.generateStructured({
      ...request(id, {}), cancelPendingSignal: new AbortController().signal,
    })));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.every((entry) => entry.schemaName === "truth_resolution_directive")).toBe(true);
  });

  it("shares common context and preserves independent slot results", async () => {
    const provider = new ScriptedModelProvider(
      (input) => {
        const context = input.context as { state?: { slots?: Array<{ slot: number }> } };
        if (input.schemaName === "truth_resolution_batch") {
          return {
            slots: (context.state?.slots ?? []).map((slot) => ({
              slot: slot.slot,
              result: { kind: "done" },
            })),
          };
        }
        return { kind: "done" };
      },
      createTestModelCatalog(),
      false,
    );
    const batched = new TruthBatchCoordinator(provider, 12);
    const results = await Promise.all([
      batched.generateStructured(
        request("component-a", {
      contractVersion: 17,
          state: { canonicalTruth: { entities: { a: 1 } }, actionSet: { assigned: [{ actionRef: "a" }] } },
          task: { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [] },
        }),
      ),
      batched.generateStructured(
        request("component-b", {
      contractVersion: 17,
          state: { canonicalTruth: { entities: { a: 1 } }, actionSet: { assigned: [{ actionRef: "b" }] } },
          task: { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [] },
        }),
      ),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.value)).toBe(true);
    expect(results[0]!.audit).not.toBe(results[1]!.audit);
    expect(results[0]!.audit.invocations[0]!.id).toBe(results[1]!.audit.invocations[0]!.id);
    expect(provider.requests).toHaveLength(1);
    const envelope = provider.requests[0]!.context as {
      state: { slots: Array<{ slot: number; state: { canonicalTruth: unknown; actionSet: unknown } }> };
      task: { slots: Array<{ slot: number }> };
      referenceCatalog: { candidates: unknown[] };
      referenceCatalogs: Array<{ slot: number; catalog: unknown }>;
    };
    expect(envelope.state.slots.every((slot) => slot.state.canonicalTruth)).toBe(true);
    expect(envelope.state.slots.map((slot) => slot.state.actionSet)).toEqual([
      { assigned: [{ actionRef: "a" }] },
      { assigned: [{ actionRef: "b" }] },
    ]);
    expect(envelope.referenceCatalog.candidates).toHaveLength(0);
    expect(envelope.referenceCatalogs).toHaveLength(2);
  });

  it("keeps a tail singleton on the original provider path", async () => {
    const provider = new ScriptedModelProvider(
      (input) => input.schemaName === "truth_resolution_batch"
        ? {
          slots: ((input.context as { state: { slots: Array<{ slot: number }> } }).state.slots)
            .map((slot) => ({ slot: slot.slot, result: { kind: "done" } })),
        }
        : { kind: "done" },
      createTestModelCatalog(),
      false,
    );
    const batched = new TruthBatchCoordinator(provider, 2);
    await Promise.all([
      batched.generateStructured(request("component-a", { value: "a" })),
      batched.generateStructured(request("component-b", { value: "b" })),
      batched.generateStructured(request("component-c", { value: "c" })),
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.filter((entry) => entry.schemaName === "truth_resolution_batch")).toHaveLength(1);
    expect(provider.requests.filter((entry) => entry.schemaName === "truth_resolution_directive")).toHaveLength(1);
  });

  it("fails directly on a complete batch context overflow", async () => {
    const provider = new ScriptedModelProvider(
      () => ({ kind: "done" }),
      createTestModelCatalog(undefined, {
        maxInputBytes: 100,
      }),
      false,
    );
    const batched = new TruthBatchCoordinator(provider, 12);
    await expect(
      Promise.all([
        batched.generateStructured(
          request("component-a", { payload: "x".repeat(500) }),
        ),
        batched.generateStructured(
          request("component-b", { payload: "y".repeat(500) }),
        ),
      ]),
    ).rejects.toBeInstanceOf(ContextLimitExceededError);
    expect(provider.requests).toHaveLength(0);
  });

  it.each(["coverage", "syntax"].flatMap(failure => [undefined, "tail-v1" as const].map(placement => ({ failure, placement }))))("feeds the prior $failure failure through $placement with complete source scope", async ({ failure, placement }) => {
    const previousOutput = failure === "coverage"
      ? { slots: [{ slot: 0, result: { kind: "done" } }] }
      : '{"slots":[{"slot":0,"result":{"kind":"done"}}';
    let calls = 0;
    const provider = new ScriptedModelProvider(() => {
      if (++calls === 1) {
        if (failure === "syntax") throw new ModelOutputError("invalid JSON content at offset 46", undefined, { rawValue: previousOutput });
        return previousOutput;
      }
      return { slots: [0, 1].map((slot) => ({ slot, result: { kind: "done" } })) };
    }, createTestModelCatalog(), false);
    const physical = capturePhysicalRequests(provider);
    const batched = new TruthBatchCoordinator(provider, 12, 2, SHARED_BATCH_CONTEXT_CODEC, undefined, placement);
    const inputs = ["a", "b"].map((id) => request(`component-${id}`, { value: id }));
    const results = await Promise.all(inputs.map((input) => batched.generateStructured(input)));
    expect(results.map((result) => result.value)).toEqual([{ kind: "done" }, { kind: "done" }]);
    expect(provider.requests).toHaveLength(2);
    const first = provider.requests[0]!.context as Record<string, unknown>;
    const second = provider.requests[1]!.context as Record<string, unknown>;
    expect(first).not.toHaveProperty("batchRepair");
    expect(second.batchRepair).toMatchObject({ attempt: 1, expectedSlots: [0, 1], previousOutputAvailable: true,
      previousOutput, issues: [expect.objectContaining({ message: expect.any(String) })] });
    expect(expandSharedBatchContexts(second.state as SharedBatchContext)).toEqual(inputs.map((input) => input.context));
    const preserved = { ...second };
    delete preserved.batchRepair;
    expect(preserved).toEqual(first);
    expect(provider.requests[1]!.userPrompt).toContain("batchRepair.previousOutput");
    expect(physical[0]!.repairContextPlacement).toBeUndefined();
    expect(physical[1]!.repairContextPlacement).toBe(placement);
    if (placement) {
      const layout = repairPromptLayout(physical[1]!.userPrompt, JSON.stringify(canonicalize(second)), placement);
      expect(layout.userPrompt).toBe(physical[0]!.userPrompt);
      expect(layout.contextJson).toBe(JSON.stringify(canonicalize(first)));
      expect(JSON.parse(layout.tail.split("\n\n").at(-1)!)).toEqual({ batchRepair: second.batchRepair });
    }
  });

  it("retries structural output and then deterministically bisects", async () => {
    let slotCalls = 0;
    const provider = new ScriptedModelProvider(
      (input) => {
        if (input.schemaName === "truth_resolution_directive") {
          expect(input.context).not.toHaveProperty("batchRepair");
          slotCalls += 1;
          return { kind: "done" };
        }
        return { kind: "invalid" };
      },
      createTestModelCatalog(),
      false,
    );
    const batched = new TruthBatchCoordinator(provider, 12);
    await Promise.all([
      batched.generateStructured(request("component-a", { value: "a" })),
      batched.generateStructured(request("component-b", { value: "b" })),
    ]);
    expect(slotCalls).toBe(2);
    expect(provider.requests).toHaveLength(5);
  });
});
