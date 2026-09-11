import { ModelConfigurationError } from "../../models/model-provider";
import { expandSharedCatalogPrefix } from "../../mechanics/shared-catalog-prefix";
import { expandSharedCatalogRecords } from "../../mechanics/shared-catalog-records";
import { expandRepairDiagnosticDomains } from "../../mechanics/repair-diagnostic-domains";
import { expandSharedBatchContexts } from "../../mechanics/shared-batch-context";

/** Restore and validate every logical source in the standard physical planning envelope. */
export function planningSourceContexts(context: unknown): Record<string, unknown>[] {
  if (!context || typeof context !== "object" || Array.isArray(context) || !("state" in context)) {
    throw new ModelConfigurationError("planning source context is missing its state");
  }
  return expandSharedBatchContexts(expandSharedCatalogPrefix(expandSharedCatalogRecords(expandRepairDiagnosticDomains(context.state))));
}
