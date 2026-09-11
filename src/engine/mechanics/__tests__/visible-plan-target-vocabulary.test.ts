import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import type { StructuredModelRequest } from "../../models/model-provider";
import { ScriptedModelProvider } from "../../testing/model-provider";
import { promptBundle } from "../../prompts";
import { TruthBatchCoordinator } from "../truth-batch-provider";
import { dependentFieldsProvider, encodeResolutionDependentFields } from "../resolution-dependent-fields-codec";
import { factorSharedBatchContexts } from "../shared-batch-context";
import { visiblePlanTargetHandles, visiblePlanTargetProvider, visiblePlanTargetRequest } from "../visible-plan-target-vocabulary";

const candidate = (id: string, kind = "entity", allowedUses = ["target"]) => ({ handle: `ref:${kind}:${id}`, kind, allowedUses });
const context = (id: string) => ({ contractVersion: 17, roleContract: { role: "truth-resolution" },
  execution: { worldId: "world", instanceId: "instance", advanceId: "step", revision: 0, step: 0 },
  task: { assignment: { targetHandles: [], availableHandles: [], allowedProposalKinds: [] }, constraints: [] },
  state: { text: "ref:entity:invented-in-prose" }, referenceCatalog: { version: 2, hash: id,
    candidates: [candidate(id), candidate("shared"), candidate("audience", "agent"), candidate("source-only", "entity", ["source"])] }, repair: null });
const prompt = promptBundle("truth-resolution");
const request = (id: string): StructuredModelRequest<z.infer<typeof resolutionPlanCommitDirectiveSchema>> => ({
  profileId: "truth-engine", workloadId: "instance", batchId: "step", role: "truth-resolution", subjectId: id,
  schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema,
  promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt, context: context(id),
});
const plan = (target: string) => ({ proposalKey: "plan", actionRef: "ref:action:act", targetRefs: [target], means: [],
  mode: "automatic", difficulty: null, actorRatingRef: null, factors: [], risk: "safe", baseEffect: "none",
  primaryEffect: null, secondaryEffect: null, threatenedEffect: null, visibility: "full",
  causes: [{ kind: "action", ref: "ref:action:act" }] });
const commit = (target: string) => ({ kind: "commit_plans", plans: [plan(target)] });

describe("visible plan target vocabulary", () => {
  it.each(["shared-json-v2", "shared-json-v3"] as const)("preserves each legal slot choice and source binding with %s", codec => {
    const contexts = [context("a"), context("b")];
    const shared = { state: factorSharedBatchContexts(contexts, codec) };
    const hash = contentHash(shared);
    expect(visiblePlanTargetHandles(shared)).toEqual(["ref:entity:a", "ref:entity:b", "ref:entity:shared"]);
    expect(contentHash(shared)).toBe(hash);
    // A physical union is a vocabulary, never a replacement slot catalog.
    expect(visiblePlanTargetHandles(contexts[0])).not.toContain("ref:entity:b");
    shared.state.slots[1]!.contextHash = "invalid";
    expect(() => visiblePlanTargetHandles(shared)).toThrow("binding changed");
  });

  it("enumerates only canonical plan target arrays while retaining schema, output and context ownership", () => {
    const original = request("a"), hash = contentHash(original.context);
    const next = visiblePlanTargetRequest(original);
    expect(next.schema).toBe(original.schema);
    expect(next.context).toBe(original.context);
    expect(next.preprocessOutput).toBe(original.preprocessOutput);
    expect(next.system).toBe(original.system);
    expect(next.userPrompt).toBe(original.userPrompt);
    expect(next.wireJsonSchema).toBeDefined();
    const wire = z.fromJSONSchema(next.wireJsonSchema!);
    for (const target of visiblePlanTargetHandles(original.context)) expect(wire.safeParse(commit(target)).success).toBe(true);
    expect(wire.safeParse({ kind: "commit_plans", plans: [{ ...plan("ref:entity:a"), targetRefs: [] }] }).success).toBe(true);
    const invented = commit("ref:entity:hamlet-fortress"), valueHash = contentHash(invented);
    expect(wire.safeParse(invented).success).toBe(false);
    expect(original.schema.safeParse(invented).success).toBe(true); // The existing resolver owns catalog membership.
    expect(contentHash(invented)).toBe(valueHash);
    expect(wire.safeParse(commit("ref:entity:source-only")).success).toBe(false);
    expect(contentHash(original.context)).toBe(hash);
    const transition = { ...original, role: "truth-transition" as const };
    expect(visiblePlanTargetRequest(transition)).toBe(transition);
    const unrelated = { ...original, schemaName: "truth_resolution_random" };
    expect(visiblePlanTargetRequest(unrelated)).toBe(unrelated);
  });

  it("retains the empty target choice and refuses missing or inconsistent catalogs", () => {
    const empty = request("a");
    empty.context = { referenceCatalog: { candidates: [] } };
    const wire = z.fromJSONSchema(visiblePlanTargetRequest(empty).wireJsonSchema!);
    expect(wire.safeParse({ kind: "commit_plans", plans: [{ ...plan("ref:entity:a"), targetRefs: [] }] }).success).toBe(true);
    expect(wire.safeParse(commit("ref:entity:a")).success).toBe(false);
    expect(() => visiblePlanTargetHandles({ referenceCatalog: {} })).toThrow("complete catalog");
    expect(() => visiblePlanTargetHandles({ referenceCatalog: { candidates: [{ ...candidate("a"), handle: "ref:agent:a" }] } })).toThrow("kind mismatch");
  });

  it("preserves one physical batch, slot results and dependent decoding for different logical target catalogs", async () => {
    const captured: StructuredModelRequest<unknown>[] = [];
    const scripted = new ScriptedModelProvider(input => {
      const slots = (input.context as { task: { slots: Array<{ slot: number }> } }).task.slots;
      return { slots: slots.map(({ slot }) => ({ slot, result: encodeResolutionDependentFields(commit(`ref:entity:${slot ? "b" : "a"}`)) })) };
    });
    const generate = scripted.generateStructured.bind(scripted);
    scripted.generateStructured = value => { captured.push(value); return generate(value); };
    const coordinator = new TruthBatchCoordinator(dependentFieldsProvider(visiblePlanTargetProvider(scripted)), 12, 2, "shared-json-v3");
    const roots = [request("a"), request("b")], before = roots.map(value => contentHash(value.context));
    const results = await Promise.all(roots.map(value => coordinator.generateStructured(value)));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.schemaName).toBe("truth_resolution_plan_commit_batch");
    expect(JSON.stringify(captured[0]!.wireJsonSchema)).toContain('"enum":["ref:entity:a","ref:entity:b","ref:entity:shared"]');
    expect(JSON.stringify(captured[0]!.wireJsonSchema)).toContain("Optional exact copy");
    expect(results.map(value => value.value.plans[0]!.baseEffect)).toEqual(["none", "none"]);
    expect(results.map(value => value.value.plans[0]!.targetRefs)).toEqual([["ref:entity:a"], ["ref:entity:b"]]);
    expect(roots.map(value => contentHash(value.context))).toEqual(before);
  });
});
