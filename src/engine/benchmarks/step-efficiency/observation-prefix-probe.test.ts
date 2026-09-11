import { expect, it } from "vitest";
import { scoreObservationPrefix } from "./observation-prefix-probe";

it("separates JSON validity from observer identity, coverage and semantic evidence", () => {
  const expected = [0, 1].map((slot) => ({ slot, observerRef: `ref:agent:${slot}`, localRefs: [`ref:local_entity:${slot}::self`], entityRefs: ["ref:entity:gate"], eventRefs: ["ref:event:arrival"] }));
  const output = { slots: expected.map((binding) => ({ slot: binding.slot, result: {
    summary: "A report whose prose is not a mechanical proof", introductions: [], sourceEventRefs: ["ref:event:arrival"],
    apparentClaims: [{ subjectRef: binding.localRefs[0]!, predicate: "heard", value: { kind: "text", value: "arrival" }, description: "Heard an arrival" }],
  } })) };
  expect(scoreObservationPrefix(JSON.stringify(output), expected)).toMatchObject({ rawJson: true, schemaCoverageReferences: true, fullSemantics: "unassessed" });
  for (const defect of ["cross-slot", "event", "duplicate-slot", "missing-slot"]) {
    const mutant = structuredClone(output);
    if (defect === "cross-slot") mutant.slots[0]!.result.apparentClaims[0]!.subjectRef = expected[1]!.localRefs[0]!;
    if (defect === "event") mutant.slots[0]!.result.sourceEventRefs = ["ref:event:invented"];
    if (defect === "duplicate-slot") mutant.slots[1]!.slot = 0;
    if (defect === "missing-slot") mutant.slots.pop();
    expect(scoreObservationPrefix(JSON.stringify(mutant), expected)).toMatchObject({ rawJson: true, schemaCoverageReferences: false });
  }
});

it("resolves new local identities only from this observer's declared introductions", () => {
  const binding = { slot: 0, observerRef: "ref:agent:viewer", localRefs: [], entityRefs: ["ref:entity:gate"], eventRefs: [] };
  const output = { slots: [{ slot: 0, result: { summary: "A gate", sourceEventRefs: [],
    introductions: [{ localEntity: { proposalKey: "seen-gate", name: "gate", description: "stone", status: "observed" }, canonicalEntityRef: "ref:entity:gate" }],
    apparentClaims: [{ subjectRef: { proposalKey: "seen-gate" }, predicate: "visible", value: { kind: "text", value: "yes" }, description: "visible gate" }],
  } }] };
  expect(scoreObservationPrefix(JSON.stringify(output), [binding]).schemaCoverageReferences).toBe(true);
  output.slots[0]!.result.apparentClaims[0]!.subjectRef.proposalKey = "undeclared";
  expect(scoreObservationPrefix(JSON.stringify(output), [binding]).schemaCoverageReferences).toBe(false);
});
