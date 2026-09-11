import type { StructuredModelProvider, StructuredModelRequest } from "../models/model-provider";
import { isSharedBatchContext } from "./shared-batch-context";

/** One request-policy boundary shared by source probes and registered playtests. */
export function withTruthRequestPolicy(provider: StructuredModelProvider, policy: {
  jsonSyntaxRecovery?: StructuredModelRequest<unknown>["jsonSyntaxRecovery"];
  contextLayout?: StructuredModelRequest<unknown>["contextLayout"];
}): StructuredModelProvider {
  if (!policy.jsonSyntaxRecovery && !policy.contextLayout) return provider;
  return { catalog: provider.catalog, availableProfileSummaries: role => provider.availableProfileSummaries(role),
    assertProfilesAvailable: ids => provider.assertProfilesAvailable(ids),
    generateStructured: request => provider.generateStructured({ ...request,
      ...(policy.jsonSyntaxRecovery ? { jsonSyntaxRecovery: policy.jsonSyntaxRecovery } : {}),
      ...(policy.contextLayout && isSharedBatchContext((request.context as { state?: unknown }).state) ? { contextLayout: policy.contextLayout } : {}),
    }),
  };
}
