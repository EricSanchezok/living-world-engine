import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { compactSharedCatalogPrefix, expandSharedCatalogPrefix } from "./shared-catalog-prefix";
import { compactSharedCatalogRecords, expandSharedCatalogRecords } from "./shared-catalog-records";
import { compactRepairDiagnosticDomains, expandRepairDiagnosticDomains } from "./repair-diagnostic-domains";

const instruction = loadPromptAsset("shared/planning-catalog-encoding.md");
export const PLANNING_CATALOG_ENCODING = `shared-planning-catalog-v2@${contentHash(instruction).slice(0, 16)}`;
const schemas: Readonly<Record<string, string>> = {
  truth_resolution_plan_commit_batch: "truth-resolution",
  truth_resolution_continuation_batch: "truth-resolution",
  resolution_plan_verification_batch: "causal-verifier",
};

/** Reuse exact catalog records below physical batching without changing output contracts. */
export function planningCatalogEncodingRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (schemas[request.schemaName] !== request.role) return request;
  if (request.promptVersion.includes(PLANNING_CATALOG_ENCODING)) throw new ModelConfigurationError("planning catalog encoding already applied");
  const context = request.context as Record<string, unknown>;
  if (!context || typeof context !== "object" || Array.isArray(context)) throw new ModelConfigurationError("planning catalog encoding missing context");
  const state = compactRepairDiagnosticDomains(compactSharedCatalogRecords(compactSharedCatalogPrefix(context.state)));
  const restored = expandSharedCatalogPrefix(expandSharedCatalogRecords(expandRepairDiagnosticDomains(state)));
  if (contentHash(restored) !== contentHash(context.state)) throw new ModelConfigurationError("planning catalog encoding source mismatch");
  const userPrompt = [request.userPrompt, instruction].join("\n\n");
  return { ...request, context: { ...context, state }, userPrompt,
    promptVersion: `${request.promptVersion}/${PLANNING_CATALOG_ENCODING}` };
}

export function planningCatalogEncodingProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog,
    availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => inner.generateStructured(planningCatalogEncodingRequest(request)) };
}
