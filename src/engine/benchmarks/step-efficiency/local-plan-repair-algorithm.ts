import { defineAlgorithmRef } from "../../algorithms/composition";
import { standardEagerReferenceAlgorithmRef } from "../../algorithms/standard-composition";
import { MECHANICAL_PLAN_REPAIR } from "../../mechanics/mechanical-plan-repair";

/** Isolate mechanical replacement scope; initial requests keep standard scope. */
export function localPlanRepairAlgorithmRef() {
  const base = standardEagerReferenceAlgorithmRef();
  const truth = base.children.truthResolution!;
  return defineAlgorithmRef({ ...base, children: { ...base.children,
    truthResolution: defineAlgorithmRef({ ...truth, config: { ...truth.config, mechanicalPlanRepair: MECHANICAL_PLAN_REPAIR } }),
  } });
}
