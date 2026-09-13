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
