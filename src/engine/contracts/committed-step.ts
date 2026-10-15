import type { CommittedStep, ReferenceCommittedStep } from "./model";

/** Reference algorithms and probes cannot consume another protocol's history. */
export function requireReferenceStep(step: CommittedStep): ReferenceCommittedStep {
  if (step.directEvent) throw new Error("reference execution cannot consume Direct history");
  return step;
}
