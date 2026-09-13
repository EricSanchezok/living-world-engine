import { expect, it } from "vitest";
import { contentHash } from "../../../models/model-audit";
import { perceptionAssignmentAccepted, perceptionObserverGroups } from "../perception-observer-groups";

it("partitions observer responsibilities without losing world evidence, splitting an observer or aliasing source state", () => {
  const targets = [
    { observerRef: "ref:entity:a", sourceActionRef: "ref:action:x", targetIndex: 0 },
    { observerRef: "ref:entity:b", sourceActionRef: "ref:action:y", targetIndex: 1 },
    { observerRef: "ref:entity:a", sourceActionRef: "ref:action:z", targetIndex: 2 },
    { observerRef: "ref:entity:c", sourceActionRef: "ref:action:x", targetIndex: 3 },
  ];
  const source = { state: { canonicalTruth: { private: "Complete evidence" }, actionSet: { available: ["x", "y", "z"] } },
    referenceCatalog: { candidates: [{ handle: "ref:entity:a", allowedUses: ["actor"] }] }, task: { assignment: { perceptionTargets: targets, other: "preserved" } } };
  const before = contentHash(source);
  const groups = perceptionObserverGroups(source, 2) as typeof source[];
  expect(groups).toHaveLength(2);
  expect(groups[0]!.task.assignment.perceptionTargets).toEqual(targets.slice(0, 3));
  expect(groups[1]!.task.assignment.perceptionTargets).toEqual(targets.slice(3));
  for (const group of groups) {
    expect(group.state).toEqual(source.state);
    expect(group.referenceCatalog).toEqual(source.referenceCatalog);
    const reports = group.task.assignment.perceptionTargets.map(row => ({ targetIndex: row.targetIndex }));
    expect(perceptionAssignmentAccepted(group, { kind: "done", reports })).toBe(true);
    expect(perceptionAssignmentAccepted(group, { kind: "done", reports: reports.slice(1) })).toBe(false);
    expect(perceptionAssignmentAccepted(group, { kind: "done", reports: [...reports, reports[0]] })).toBe(false);
  }
  const request = { actorRef: "ref:entity:a", causes: [{ kind: "action", ref: "ref:action:z" }] };
  expect(perceptionAssignmentAccepted(groups[0], { kind: "request_checks", requests: [request] })).toBe(true);
  expect(perceptionAssignmentAccepted(groups[1], { kind: "request_checks", requests: [request] })).toBe(false);
  groups[0]!.task.assignment.perceptionTargets[0]!.observerRef = "changed";
  groups[0]!.state.canonicalTruth.private = "changed";
  expect(contentHash(source)).toBe(before);
  expect(groups[1]!.state).toEqual(source.state);
  expect(() => perceptionObserverGroups({ ...source, task: { assignment: { perceptionTargets: [targets[0], targets[0]] } } }, 2)).toThrow();
});
