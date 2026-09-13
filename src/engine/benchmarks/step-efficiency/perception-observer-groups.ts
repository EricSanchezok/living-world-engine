import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError } from "../../models/model-provider";

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("missing perception group source");
  return value as Value;
};
export function perceptionObserverGroups(context: unknown, maxObservers: number): Value[] {
  if (!Number.isSafeInteger(maxObservers) || maxObservers < 1) throw new ModelConfigurationError("invalid perception observer group size");
  const source = record(context), assignment = record(record(source.task).assignment);
  if (!Array.isArray(assignment.perceptionTargets)) throw new ModelConfigurationError("missing assigned perception targets");
  const targets = assignment.perceptionTargets.map(record), observers = new Map<string, Value[]>(), indices = new Set<number>();
  for (const target of targets) {
    if (typeof target.observerRef !== "string" || typeof target.sourceActionRef !== "string" ||
      !Number.isSafeInteger(target.targetIndex) || indices.has(target.targetIndex as number)) throw new ModelConfigurationError("invalid or duplicate perception assignment");
    indices.add(target.targetIndex as number);
    const group = observers.get(target.observerRef) ?? [];
    group.push(target); observers.set(target.observerRef, group);
  }
  const observerIds = [...observers.keys()], contexts: Value[] = [];
  for (let offset = 0; offset < observerIds.length; offset += maxObservers) {
    const copy = structuredClone(source);
    const members = new Set(observerIds.slice(offset, offset + maxObservers));
    record(record(copy.task).assignment).perceptionTargets = structuredClone(targets.filter(target => members.has(String(target.observerRef))));
    const restored = structuredClone(copy);
    record(record(restored.task).assignment).perceptionTargets = targets;
    if (contentHash(restored) !== contentHash(source)) throw new ModelConfigurationError("perception partition changed source data");
    contexts.push(copy);
  }
  return contexts;
}

export function perceptionAssignedSourcesContext(context: unknown): Value {
  const source = record(context), task = record(source.task), assignment = record(task.assignment), state = record(source.state);
  const actionSet = record(state.actionSet), dependencySet = record(state.dependencySet);
  if (task.stage !== "perception" || !Array.isArray(assignment.perceptionTargets) || !Array.isArray(assignment.targetHandles) ||
    !Array.isArray(actionSet.assigned) || !Array.isArray(actionSet.available) ||
    !Array.isArray(dependencySet.assigned) || !Array.isArray(dependencySet.available)) throw new ModelConfigurationError("missing perception assignment source fields");
  const targets = assignment.perceptionTargets.map(record), handles = assignment.targetHandles;
  const actions = actionSet.assigned.map(record), dependencies = dependencySet.assigned.map(record);
  const refs = new Set(targets.map(target => target.sourceActionRef));
  const availableActions = actionSet.available.map(record), availableDependencies = dependencySet.available.map(record);
  if (!targets.length || [...refs].some(ref => typeof ref !== "string") ||
    actions.some(action => typeof action.actionRef !== "string") ||
    new Set(actions.map(action => action.actionRef)).size !== actions.length ||
    new Set(availableActions.map(action => action.actionRef)).size !== availableActions.length ||
    new Set(handles).size !== actions.length || handles.length !== actions.length ||
    actions.some(action => !handles.includes(action.actionRef)) ||
    [...refs].some(ref => actions.filter(action => action.actionRef === ref).length !== 1) ||
    actions.some(action => availableActions.filter(available => available.actionRef === action.actionRef && contentHash(available) === contentHash(action)).length !== 1) ||
    dependencies.some(dependency => dependency.kind !== "action" || !actions.some(action => action.actionRef === dependency.ref) ||
      availableDependencies.filter(available => available.kind === dependency.kind && available.ref === dependency.ref && contentHash(available) === contentHash(dependency)).length !== 1) ||
    new Set(dependencies.map(dependency => dependency.ref)).size !== dependencies.length) throw new ModelConfigurationError("inconsistent perception assigned source join");
  const copy = structuredClone(source), copyState = record(copy.state);
  record(record(copy.task).assignment).targetHandles = handles.filter(ref => refs.has(ref));
  record(copyState.actionSet).assigned = structuredClone(actions.filter(action => refs.has(action.actionRef)));
  record(copyState.dependencySet).assigned = structuredClone(dependencies.filter(dependency => refs.has(dependency.ref)));
  const restored = structuredClone(copy), restoredState = record(restored.state);
  record(record(restored.task).assignment).targetHandles = assignment.targetHandles;
  record(restoredState.actionSet).assigned = actionSet.assigned;
  record(restoredState.dependencySet).assigned = dependencySet.assigned;
  if (contentHash(restored) !== contentHash(source)) throw new ModelConfigurationError("perception source alignment changed available evidence");
  return copy;
}

export function perceptionAssignmentAccepted(context: unknown, decision: unknown): boolean {
  const assignment = record(record(record(context).task).assignment), output = record(decision);
  if (!Array.isArray(assignment.perceptionTargets)) return false;
  const targets = assignment.perceptionTargets.map(record);
  if (output.kind === "done" && Array.isArray(output.reports)) {
    const actual = output.reports.map(value => record(value).targetIndex);
    return actual.length === targets.length && new Set(actual).size === targets.length &&
      targets.every(target => actual.includes(target.targetIndex));
  }
  return output.kind === "request_checks" && Array.isArray(output.requests) && output.requests.every(value => {
    const check = record(value);
    return targets.some(target => target.observerRef === check.actorRef && Array.isArray(check.causes) &&
      check.causes.some(value => { const cause = record(value); return cause.kind === "action" && cause.ref === target.sourceActionRef; }));
  });
}
