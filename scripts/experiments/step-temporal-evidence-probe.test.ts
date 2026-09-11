import { expect, it } from "vitest";
import { ACTIVITY_TEMPORAL_EVIDENCE, ACTIVITY_TEMPORAL_NOTICE } from "../../src/engine/contracts/activity-temporal-evidence";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { factorSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import type { ProbeRow } from "./step-state-prefix-probe";
import { assertTemporalSourcePreserved, temporalEvidenceDecision } from "./step-temporal-evidence-probe";

const rows = (): ProbeRow[] => ["041", "007"].flatMap(rootId => ["B", "T"].map(arm => ({ rootId, arm,
  complete: true, initialAdmittedActions: rootId === "041" ? 41 : 7, httpCalls: 1, totalTokens: 100, documentedKnownNanoCny: 1000 })));

it("requires four fully accounted first-call cells and never promotes an incomplete candidate", () => {
  const complete = rows();
  expect(temporalEvidenceDecision(complete, false)).toBe("eligible-for-source-semantic-review-no-first-call-gain");
  const improved = rows(); improved[0]!.complete = false; improved[0]!.initialAdmittedActions = 29;
  expect(temporalEvidenceDecision(improved, false)).toBe("eligible-for-source-semantic-review");
  improved[1]!.complete = false; improved[1]!.initialAdmittedActions = 40;
  expect(temporalEvidenceDecision(improved, false)).toBe("failed-first-call-admission");
  expect(temporalEvidenceDecision(complete, true)).toBe("inconclusive");
  expect(temporalEvidenceDecision(complete.slice(1), false)).toBe("inconclusive");
  expect(temporalEvidenceDecision([complete[0]!, complete[0]!, ...complete.slice(2)], false)).toBe("inconclusive");
  for (const patch of [{ httpCalls: 0 }, { httpCalls: 2 }, { totalTokens: null }, { documentedKnownNanoCny: null }]) {
    expect(temporalEvidenceDecision([{ ...complete[0]!, ...patch }, ...complete.slice(1)], false)).toBe("inconclusive");
  }
});

it("preserves source and request settings exactly while binding only the additional evidence", () => {
  const original = ["a", "b"].map(id => ({ state: { actor: id, fact: "The convoy has not arrived", actions: ["Guard until arrival"] },
    task: { constraints: ["Keep all action intent"] } }));
  const augmented = original.map(context => ({ ...context, state: { ...context.state,
    temporalExecution: { contractVersion: ACTIVITY_TEMPORAL_EVIDENCE, sourceHash: "bound-source", boundary: { fromTime: 0, toTime: 10 } } },
    task: { constraints: [...context.task.constraints, ACTIVITY_TEMPORAL_NOTICE] } }));
  const evidence = (contexts: unknown[]) => admissionRequestEvidence({ profileId: "truth-engine", workloadId: "instance", batchId: "step",
    role: "truth-resolution", subjectId: "test", schemaName: "truth_resolution_plan_commit_batch", schema: resolutionPlanCommitDirectiveSchema,
    promptVersion: "test", system: "test", userPrompt: "test", context: { task: { cardinality: contexts.length }, state: factorSharedBatchContexts(contexts, "shared-json-v3") } });
  const baseline = evidence(original), candidate = evidence(augmented), saved = structuredClone(candidate);
  expect(() => assertTemporalSourcePreserved(baseline, candidate)).not.toThrow();
  expect(candidate).toEqual(saved);
  expect(() => assertTemporalSourcePreserved(baseline, { ...candidate, system: "changed settings" })).toThrow("request settings");
  const changedFact = structuredClone(augmented); changedFact[0]!.state.fact = "The convoy arrived";
  expect(() => assertTemporalSourcePreserved(baseline, evidence(changedFact))).toThrow("original source");
  const missingNotice = structuredClone(augmented); missingNotice[1]!.task.constraints.pop();
  expect(() => assertTemporalSourcePreserved(baseline, evidence(missingNotice))).toThrow("interpretation missing");
  const unbound = structuredClone(augmented); unbound[0]!.state.temporalExecution.sourceHash = "";
  expect(() => assertTemporalSourcePreserved(baseline, evidence(unbound))).toThrow("evidence or interpretation missing");
  expect(() => assertTemporalSourcePreserved(baseline, evidence([...augmented, augmented[0]!]))).toThrow("outer task");
  const mismatchedSlots = evidence([...augmented, augmented[0]!]);
  (mismatchedSlots.context as { task: { cardinality: number } }).task.cardinality = 2;
  expect(() => assertTemporalSourcePreserved(baseline, mismatchedSlots)).toThrow("slot count");
});
