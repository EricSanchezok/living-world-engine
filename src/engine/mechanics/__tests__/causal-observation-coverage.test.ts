import { expect, it } from "vitest";
import { prepareCausalObservationCoverage } from "../causal-observation-coverage";
import { contentHash } from "../../models/model-audit";

function source() {
  return { task: { constraints: ["preserve every source"] }, execution: { revision: 7 },
    state: { privateEvidence: { unavailable: null }, actionSet: { available: [
      { actionRef: "action:a", actorRef: "agent:a", rawText: "Ask B about the petition", targetRefs: ["local:b"] },
      { actionRef: "action:b", actorRef: "agent:b", rawText: "Inspect the gate" },
    ] }, candidate: { observations: [
      { observationRef: "obs:a", observerRef: "agent:a", sourceEventRefs: ["event:1"],
        apparentClaims: [{ subjectRef: "local:b", predicate: "proposed", value: "petition" }] },
      { observationRef: "obs:b", observerRef: "agent:b", sourceEventRefs: [], apparentClaims: [] },
    ], outcomes: [{ actionRef: "action:a", status: "continuing" }, { actionRef: "action:b", status: "continuing" }],
    events: [{ eventRef: "event:1", description: "A approached B" }], operations: [{ kind: "advance_time", seconds: 10 }] } },
    referenceCatalog: { candidates: [{ handle: "obs:a", label: "A observation", kind: "observation" },
      { handle: "obs:b", label: "B observation", kind: "observation" }, { handle: "local:b", label: "B", kind: "local_entity" },
      { handle: "action:a", label: "A asks", kind: "action" }] } };
}
it("retains the full source and separates action ownership from a claim's named subject", () => {
  const before = source(), prepared = prepareCausalObservationCoverage(before);
  const { observationReviewWorklist: view, ...task } = prepared.context.task;
  expect({ ...prepared.context, task }).toEqual(before);
  expect(view.sourceContextHash).toBe(contentHash(before));
  expect(view.rows[0]!.ownActions.map(x => x.actorRef)).toEqual(["agent:a"]);
  expect(view.rows[0]!.claimSubjects[0]!.catalogEntry?.label).toBe("B");
  expect(view.rows[1]!.ownActions.map(x => x.actorRef)).toEqual(["agent:b"]);
  expect(view.rows[0]!.explicitSourceEvents).toEqual(before.state.candidate.events);
  view.rows[0]!.ownActions[0]!.actorRef = "changed";
  expect(before.state.actionSet.available[0]!.actorRef).toBe("agent:a");
  expect(prepared.context.state.actionSet.available[0]!.actorRef).toBe("agent:a");
});
it("requires complete unique coverage, consistent verdicts and existing evidence", () => {
  const p = prepareCausalObservationCoverage(source());
  const a = { observationRef: "obs:a", verdict: "unsupported", issue: "actor-attribution", supportRefs: ["action:a"] };
  const b = { observationRef: "obs:b", verdict: "supported", issue: "none", supportRefs: [] };
  expect(p.validate({ checks: [a,b] }).checks).toHaveLength(2);
  for (const checks of [[a], [a,a], [a,{...b,observationRef:"unknown"}], [a,{...b,issue:"other"}], [{...a,supportRefs:["invented"]},b]]) {
    expect(() => p.validate({ checks })).toThrow();
  }
  expect(() => prepareCausalObservationCoverage(p.context)).toThrow("already attached");
  const duplicate=source();duplicate.state.candidate.observations[1]!.observationRef="obs:a";
  expect(() => prepareCausalObservationCoverage(duplicate)).toThrow("duplicate observation");
});
