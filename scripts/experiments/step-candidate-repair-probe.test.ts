import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { planSelectorRequest } from "../../src/engine/mechanics/plan-source-selectors";
import { factorSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { logicalRepairContext } from "../../src/engine/prompts/logical-repair-context";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { assertCandidateRepairDelta } from "./step-candidate-repair-probe";

it("rejects candidate, source and binding drift while allowing only exact repair evidence", () => {
  const sources = ["a", "b"].map(id => ({ task: { assignment: { targetHandles: [id] }, constraints: [] as string[] },
    state: { fact: `source-${id}`, actionSet: { assigned: [{ actionRef: `ref:action:${id}`, allowedMeansSources: [{ kind: "action", ref: `ref:action:${id}` }] }] } },
    referenceCatalog: { candidates: [{ handle: `ref:entity:${id}`, kind: "entity", allowedUses: ["target"] }] }, repair: null as unknown }));
  const decoded = { slots: ["a", "b"].map((id, slot) => ({ slot, result: { kind: "commit_plans", plans: [{
    actionRef: `ref:action:${id}`, targetRefs: [`ref:entity:${id}`], means: [{ source: { kind: "action", ref: `ref:action:${id}` } }],
  }] } })) };
  const request = (context: unknown) => ({ profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution" as const, subjectId: "test",
    schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema, promptVersion: "test", system: "test", userPrompt: "test", context });
  const encode = (context: unknown) => planSelectorRequest(request(context)).context;
  const evidence = (contexts: unknown[]) => admissionRequestEvidence(request({ state: factorSharedBatchContexts(contexts, "shared-json-v3") }));
  const previous = sources.map(source => ({ ...structuredClone(source), repair: { issues: [{ path: ["plans", 0], reason: "missing effect" }] } }));
  const current = previous.map((context, slot) => encode(logicalRepairContext(context, {
    attempt: 1, scope: "component", targetIds: [], issues: [], previousOutput: decoded.slots[slot]!.result,
    logicalInvocationId: `logical-${slot}`, repairOf: `previous-${slot}`,
  }, contentHash(sources[slot]), "truth_resolution_plan_commit"))) as Array<{ repair: { previousOutput: unknown; candidateBinding: { sourceContextHash: string } }; state: { fact: string } }>;
  const old = evidence(previous.map(encode)), initial = evidence(sources.map(encode));
  expect(() => assertCandidateRepairDelta(old, evidence(current), initial, decoded)).not.toThrow();
  const missing = structuredClone(current); missing[0]!.repair.previousOutput = { kind: "commit_plans", plans: [] };
  expect(() => assertCandidateRepairDelta(old, evidence(missing), initial, decoded)).toThrow("exact bound");
  const foreign = structuredClone(current); foreign[0]!.repair = foreign[1]!.repair;
  expect(() => assertCandidateRepairDelta(old, evidence(foreign), initial, decoded)).toThrow("binding changed");
  const sourceDrift = structuredClone(current); sourceDrift[0]!.state.fact = "unrecorded";
  expect(() => assertCandidateRepairDelta(old, evidence(sourceDrift), initial, decoded)).toThrow("exact bound");
  const bindingDrift = structuredClone(current); bindingDrift[0]!.repair.candidateBinding.sourceContextHash = "wrong";
  expect(() => assertCandidateRepairDelta(old, evidence(bindingDrift), initial, decoded)).toThrow("binding changed");
});
