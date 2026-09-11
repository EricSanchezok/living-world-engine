import type { StructuredModelProvider } from "../../models/model-provider";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../../mechanics/truth-batch-provider";

export const SHARED_GROUNDING_PROBE = "shared-grounding-probe-v1" as const;

/** Benchmark-only delivery; logical grounding still owns every semantic check.
 * @see ../../../../docs/specs/0119-shared-grounding-probe.md */
export function sharedGroundingProbeProvider(provider: StructuredModelProvider): StructuredModelProvider {
  return new TruthBatchCoordinator(provider, 12, 2, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT,
    "tail-v1", "post-promise-v1");
}
