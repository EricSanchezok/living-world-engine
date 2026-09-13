import { expect, it } from "vitest";
import { contentHash } from "../../../models/model-audit";
import { perceptionAssignedSourcesContext, perceptionAssignmentAccepted, perceptionObserverGroups } from "../perception-observer-groups";

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

it("aligns responsibilities to source actions while retaining cross-action dependencies and all available evidence", () => {
  const actions = ["x", "y", "z"].map(id => ({ actionRef: `ref:action:${id}`, actorRef: `ref:entity:${id}`, rawText: `Attempt ${id}` }));
  const dependencies = actions.map(action => ({ kind: "action", ref: action.actionRef, requiredExistingRefs: ["ref:entity:shared"] }));
  const source = {
    task: { stage: "perception", assignment: { targetHandles: actions.map(action => action.actionRef), availableHandles: actions.map(action => action.actionRef),
      perceptionTargets: [{ observerRef: "ref:entity:observer", sourceActionRef: "ref:action:z", targetIndex: 17 },
        { observerRef: "ref:entity:observer", sourceActionRef: "ref:action:x", targetIndex: 3 }] } },
    state: { actionSet: { assigned: actions, available: structuredClone(actions) }, dependencySet: { assigned: dependencies, available: structuredClone(dependencies) },
      canonicalTruth: { secret: "Complete evidence" }, checkResults: [{ checkRef: "fixed", total: 15 }] },
    referenceCatalog: { candidates: [{ handle: "ref:entity:shared" }] },
  };
  const before = contentHash(source), projected = perceptionAssignedSourcesContext(source) as typeof source;
  expect(projected.task.assignment.targetHandles).toEqual(["ref:action:x", "ref:action:z"]);
  expect(projected.state.actionSet.assigned).toEqual([actions[0], actions[2]]);
  expect(projected.state.dependencySet.assigned).toEqual([dependencies[0], dependencies[2]]);
  const restored = structuredClone(projected);
  restored.task.assignment.targetHandles = source.task.assignment.targetHandles;
  restored.state.actionSet.assigned = source.state.actionSet.assigned;
  restored.state.dependencySet.assigned = source.state.dependencySet.assigned;
  expect(restored).toEqual(source);
  expect(perceptionAssignedSourcesContext(projected)).toEqual(projected);
  for (const mutate of [
    (copy: typeof source) => { copy.task.assignment.perceptionTargets[0]!.sourceActionRef = "ref:action:absent"; },
    (copy: typeof source) => { copy.task.assignment.targetHandles[0] = "ref:action:absent"; },
    (copy: typeof source) => { copy.state.actionSet.available[2]!.actorRef = "ref:entity:wrong"; },
    (copy: typeof source) => { copy.state.actionSet.available.push(copy.state.actionSet.available[2]!); },
    (copy: typeof source) => { copy.state.dependencySet.available[2]!.requiredExistingRefs = []; },
  ]) {
    const broken = structuredClone(source); mutate(broken);
    expect(() => perceptionAssignedSourcesContext(broken)).toThrow("inconsistent perception assigned source join");
  }
  projected.state.actionSet.available[0]!.rawText = "changed";
  expect(contentHash(source)).toBe(before);
});
