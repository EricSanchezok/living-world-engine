import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { ModelOutputError, type StructuredModelRequest } from "../../models/model-provider";
import { ScriptedModelProvider } from "../../testing/model-provider";
import { promptBundle } from "../../prompts";
import { logicalRepairContext } from "../../prompts/logical-repair-context";
import { TruthBatchCoordinator } from "../truth-batch-provider";
import { dependentFieldsProvider, dependentFieldsRequest, encodeResolutionDependentFields } from "../resolution-dependent-fields-codec";
import { expandSharedBatchContexts, factorSharedBatchContexts, type SharedBatchContext } from "../shared-batch-context";
import { planSelectorProvider, planSelectorRequest, stripPlanSelectorAnnotations } from "../plan-source-selectors";

const context = (id: string) => ({ contractVersion: 16, roleContract: { role: "truth-resolution" },
  execution: { worldId: "world", instanceId: "instance", advanceId: "step", revision: 0, step: 0 },
  task: { assignment: { targetHandles: [`ref:action:${id}`], availableHandles: [`ref:action:${id}`], allowedProposalKinds: [] }, constraints: [] },
  state: { text: "Do not rewrite e:123456789012 or ref:entity:invented in prose.", actionSet: { assigned: [{ actionRef: `ref:action:${id}`,
    rawText: "Wait for the gate to open, then carry two sacks inside.", allowedMeansSources: [
      { kind: "action", ref: `ref:action:${id}` }, { kind: "entity", ref: `ref:entity:${id}` }, { kind: "law", ref: "ref:law:shared" },
    ] }] } },
  referenceCatalog: { version: 2, hash: id, candidates: [
    { kind: "entity", handle: `ref:entity:${id}`, allowedUses: ["target", "source"] },
    { kind: "entity", handle: "ref:entity:shared", allowedUses: ["target"] },
    { kind: "entity", handle: "ref:entity:source-only", allowedUses: ["source"] },
    { kind: "fact", handle: "ref:fact:fact", allowedUses: ["source"] },
  ] }, repair: null as unknown });
const prompt = promptBundle("truth-resolution");
const request = (id: string): StructuredModelRequest<z.infer<typeof resolutionPlanCommitDirectiveSchema>> => ({
  profileId: "truth-engine", workloadId: "instance", batchId: "step", role: "truth-resolution", subjectId: id,
  schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
  promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt, context: context(id),
});
type Annotated = { repair: unknown; referenceCatalog: { candidates: { kind: string; handle: string; allowedUses: string[]; targetSelector?: string }[] }; state: {
  actionSet: { assigned: { allowedMeansSources: { kind: string; ref: string; sourceSelector: string }[] }[] } } };
const commit = (id: string) => ({ kind: "commit_plans", plans: [{ proposalKey: "plan", actionRef: `ref:action:${id}`,
  targetRefs: [`ref:entity:${id}`], means: [{ description: "Use the assigned action without changing its intent", source: { kind: "action", ref: `ref:action:${id}` } }],
  mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", baseEffect: "none",
  primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", ref: `ref:action:${id}` }] }] });
const wireCommit = (id: string, ctx: Annotated) => {
  const value = commit(id);
  return { ...value, plans: value.plans.map(plan => ({ ...plan, targetRefs: [ctx.referenceCatalog.candidates[0]!.targetSelector!],
    means: plan.means.map(means => ({ ...means, source: ctx.state.actionSet.assigned[0]!.allowedMeansSources[0]!.sourceSelector })) })) };
};

describe("source-bound plan selectors", () => {
  it("round trips every visible target and allowed means without altering source evidence or free text", () => {
    const original = request("a"), before = contentHash(original.context), next = planSelectorRequest(original);
    const annotated = next.context as Annotated;
    expect(contentHash(stripPlanSelectorAnnotations(annotated))).toBe(before);
    expect(contentHash(original.context)).toBe(before);
    expect(next.schema).toBe(original.schema);
    const wire = z.fromJSONSchema(next.wireJsonSchema!);
    for (const target of annotated.referenceCatalog.candidates.filter(value => value.targetSelector)) {
      for (const source of annotated.state.actionSet.assigned[0]!.allowedMeansSources) {
        const selected = wireCommit("a", annotated);
        selected.plans[0]!.targetRefs = [target.targetSelector!, target.targetSelector!];
        selected.plans[0]!.means[0]!.source = source.sourceSelector;
        expect(wire.safeParse(selected).success).toBe(true);
        const decoded = next.preprocessOutput!(selected).value;
        expect(original.schema.safeParse(decoded).success).toBe(true);
        expect(decoded).toEqual({ ...commit("a"), plans: [{ ...commit("a").plans[0], targetRefs: [target.handle, target.handle],
          means: [{ ...commit("a").plans[0]!.means[0], source: { kind: source.kind, ref: source.ref } }] }] });
      }
    }
    expect(annotated.referenceCatalog.candidates[2]!.targetSelector).toBeUndefined();
    expect(annotated.referenceCatalog.candidates[3]!.targetSelector).toBeUndefined();
    expect(wire.safeParse(commit("a")).success).toBe(false);
    expect(original.schema.safeParse(next.preprocessOutput!(commit("a")).value).success).toBe(false);
  });

  it.each(["shared-json-v2", "shared-json-v3"] as const)("binds and restores all %s contexts while preserving selector stability under reordering and singleton repair", codec => {
    const contexts = [context("a"), context("b")];
    const batch = { ...request("a"), context: { state: factorSharedBatchContexts(contexts, codec) } };
    const next = planSelectorRequest(batch);
    const annotated = expandSharedBatchContexts((next.context as { state: SharedBatchContext }).state);
    const restored = stripPlanSelectorAnnotations(next.context) as { state: SharedBatchContext };
    expect(contentHash(expandSharedBatchContexts(restored.state))).toBe(contentHash(contexts));
    expect(contentHash(annotated[1])).toBe(contentHash(planSelectorRequest(request("b")).context));
    const reverse = planSelectorRequest({ ...batch, context: { state: factorSharedBatchContexts([...contexts].reverse(), codec) } });
    expect(expandSharedBatchContexts((reverse.context as { state: SharedBatchContext }).state)[0]).toEqual(annotated[1]);
    (batch.context.state as SharedBatchContext).slots[1]!.contextHash = "wrong";
    expect(() => planSelectorRequest(batch)).toThrow("binding changed");
  });

  it("rejects cross-action, cross-slot, unknown and canonical bypass selections and preserves the raw invalid value for repair", () => {
    const a = planSelectorRequest(request("a")), b = planSelectorRequest(request("b"));
    const invalid = wireCommit("a", a.context as Annotated), foreign = wireCommit("b", b.context as Annotated);
    invalid.plans[0]!.means[0]!.source = foreign.plans[0]!.means[0]!.source;
    invalid.plans[0]!.targetRefs = foreign.plans[0]!.targetRefs;
    const rawHash = contentHash(invalid), decoded = a.preprocessOutput!(invalid).value;
    expect(resolutionPlanCommitDirectiveSchema.safeParse(decoded).success).toBe(false);
    expect(contentHash(invalid)).toBe(rawHash);
    const repair = request("a"), ctx = repair.context as ReturnType<typeof context>;
    ctx.repair = { previousOutput: decoded, issues: [{ message: "invalid selection" }] };
    const encoded = planSelectorRequest(repair).context as ReturnType<typeof context>;
    expect(encoded.repair).toEqual({ previousOutput: invalid, issues: [{ message: "invalid selection" }] });
    for (const value of ["m:000000000000", "ref:action:a"]) {
      invalid.plans[0]!.means[0]!.source = value;
      expect(resolutionPlanCommitDirectiveSchema.safeParse(a.preprocessOutput!(invalid).value).success).toBe(false);
    }
  });

  it("encodes canonical repair examples using exactly the current selectors", () => {
    const original = request("a"), ctx = original.context as ReturnType<typeof context>;
    ctx.repair = { previousOutput: commit("a"), issues: [] };
    const next = planSelectorRequest(original), annotated = next.context as Annotated;
    expect(annotated.repair).toEqual({ previousOutput: wireCommit("a", annotated), issues: [] });
    expect(ctx.repair).toEqual({ previousOutput: commit("a"), issues: [] });
    expect(planSelectorRequest({ ...request("a"), role: "truth-transition" }).wireJsonSchema).toBeUndefined();
    const absent = request("a"); absent.context = { referenceCatalog: { candidates: [] }, state: {} };
    expect(() => planSelectorRequest(absent)).toThrow("assigned action inventory");
  });

  it("keeps rejected candidate bindings local while encoding shared repair examples", () => {
    const originals = ["a", "b"].map(id => logicalRepairContext(context(id), {
      attempt: 1, scope: "slot", targetIds: [id], issues: [], previousOutput: commit(id), logicalInvocationId: id,
    }, contentHash(context(id)), "truth_resolution_plan_commit"));
    const next = planSelectorRequest({ ...request("a"), context: { state: factorSharedBatchContexts(originals, "shared-json-v3") } });
    const expanded = expandSharedBatchContexts((next.context as { state: SharedBatchContext }).state);
    for (const [index, id] of ["a", "b"].entries()) {
      const slot = expanded[index]! as unknown as Annotated;
      expect(slot.repair).toMatchObject({ previousOutput: wireCommit(id, slot),
        candidateBinding: { canonicalOutputHash: contentHash(commit(id)), sourceContextHash: contentHash(context(id)), logicalInvocationId: id } });
    }
  });

  it("uses the real physical coordinator to retain a valid slot despite another slot's invalid source and target", async () => {
    const captures: StructuredModelRequest<unknown>[] = [];
    const scripted = new ScriptedModelProvider(input => {
      const contexts = expandSharedBatchContexts((input.context as { state: SharedBatchContext }).state) as Annotated[];
      const valid = wireCommit("a", contexts[0]!), invalid = wireCommit("b", contexts[1]!);
      invalid.plans[0]!.targetRefs = valid.plans[0]!.targetRefs;
      invalid.plans[0]!.means[0]!.source = valid.plans[0]!.means[0]!.source;
      return { slots: [valid, invalid].map((result, slot) => ({ slot, result: encodeResolutionDependentFields(result) })) };
    });
    const generate = scripted.generateStructured.bind(scripted);
    scripted.generateStructured = input => { captures.push(input); return generate(input); };
    const coordinator = new TruthBatchCoordinator(dependentFieldsProvider(planSelectorProvider(scripted)), 12, 0, "shared-json-v3");
    const results = await Promise.allSettled(["a", "b"].map(id => coordinator.generateStructured(request(id))));
    expect(captures).toHaveLength(1);
    expect(results[0]!.status).toBe("fulfilled");
    if (results[0]!.status === "fulfilled") expect(results[0]!.value.value).toEqual(commit("a"));
    expect(results[1]!.status).toBe("rejected");
    if (results[1]!.status === "rejected") {
      expect(results[1]!.reason).toBeInstanceOf(ModelOutputError);
      expect(JSON.stringify(results[1]!.reason.rawValue)).toContain("unresolved-selection");
      expect(results[1]!.reason.audit.invocations).toHaveLength(1);
    }
    const singleton = planSelectorRequest(dependentFieldsRequest(request("b")));
    expect(singleton.preprocessOutput!(encodeResolutionDependentFields(wireCommit("b", singleton.context as Annotated))).value).toEqual(commit("b"));
  });
});
