import { expect, it } from "vitest";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { dependentFieldsRequest } from "../../src/engine/mechanics/resolution-dependent-fields-codec";
import { factorTypesRequest } from "../../src/engine/mechanics/resolution-factor-types";
import { promptBundle } from "../../src/engine/prompts";
import { assertFactorSourcePreserved, factorTypesDecision } from "./step-factor-types-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import type { ProbeRow } from "./step-state-prefix-probe";

it("requires fully accounted paired first-call admission and nonincreasing tokens before semantic review", () => {
  const rows: ProbeRow[] = ["041", "007"].flatMap(rootId => ["B", "F"].map(arm => ({ rootId, arm, complete: true,
    initialAdmittedActions: rootId === "041" ? 41 : 7, httpCalls: 1, totalTokens: 100, documentedKnownNanoCny: 1000 })));
  expect(factorTypesDecision(rows, false)).toBe("eligible-for-source-semantic-review-no-first-call-gain");
  rows[0]!.initialAdmittedActions = 26; rows[0]!.complete = false;
  expect(factorTypesDecision(rows, false)).toBe("eligible-for-source-semantic-review");
  rows[1]!.totalTokens = 101;
  expect(factorTypesDecision(rows, false)).toBe("failed-first-call-efficiency");
  rows[1]!.complete = false;
  expect(factorTypesDecision(rows, false)).toBe("failed-first-call-admission");
  expect(factorTypesDecision(rows, true)).toBe("inconclusive");
  expect(factorTypesDecision([rows[0]!, rows[0]!, ...rows.slice(2)], false)).toBe("inconclusive");
  for (const patch of [{ httpCalls: 0 }, { httpCalls: 2 }, { totalTokens: null }, { documentedKnownNanoCny: null }]) {
    expect(factorTypesDecision([{ ...rows[0]!, ...patch }, ...rows.slice(1)], false)).toBe("inconclusive");
  }
});

it("allows only the exact factor wire and instruction transformation while preserving full source input", () => {
  const prompt = promptBundle("truth-resolution");
  const source = dependentFieldsRequest({ profileId: "truth-engine", workloadId: "test", batchId: "test", role: "truth-resolution", subjectId: "test",
    schemaName: "truth_resolution_plan_commit", schema: resolutionPlanCommitDirectiveSchema, promptVersion: prompt.version, system: prompt.system,
    userPrompt: prompt.userPrompt, context: { state: { fact: "Guard until the convoy arrives", temporalExecution: { interval: [0, 10] } }, repair: null } });
  const baseline = admissionRequestEvidence(source), candidate = admissionRequestEvidence(factorTypesRequest(source));
  expect(() => assertFactorSourcePreserved(baseline, candidate)).not.toThrow();
  expect(() => assertFactorSourcePreserved(baseline, { ...candidate, context: {} })).toThrow("source or request settings");
  expect(() => assertFactorSourcePreserved(baseline, { ...candidate, system: candidate.system + "Skip waiting" })).toThrow("instructions");
  expect(() => assertFactorSourcePreserved(baseline, { ...candidate, wireJsonSchema: baseline.wireJsonSchema })).toThrow("exact transform");
  expect(() => assertFactorSourcePreserved(baseline, { ...candidate, schema: { ...candidate.schema, title: "changed" } })).toThrow("source or request settings");
});
