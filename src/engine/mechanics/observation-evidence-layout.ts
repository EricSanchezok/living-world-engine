import { z } from "zod";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../models/model-provider";
import { promptBundle } from "../prompts";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";
import { observationSlotBinding } from "./truth-batch-provider";
import { observationClaimEncodingRequest } from "./observation-claim-encoding";

const contract = promptBundle("observation-renderer").system;
const heading = "\n\nFinal observation evidence contract: all complete original contexts, reference permissions and the schema above remain authoritative.\n";
const closing = "Return sourceEventRefs first, then introductions, apparentClaims and summary for every observation. Include every field even when its array is empty. Select only events this observer perceived; an empty sourceEventRefs does not forbid separately supported current appearances. Actions establish intentions, not occurrences. A continuing result or checkpoint alone does not prove a sub-action happened. Every apparentClaims predicate, value and description must preserve the same uncertainty as the summary. Do not replace unknown with a negative fact. Follow the complete output envelope shown in the schema.";
const fieldOrder = ["sourceEventRefs", "introductions", "apparentClaims", "summary"] as const;
export const OBSERVATION_EVIDENCE_LAYOUT = `source-evidence-first-v1@${contentHash({ contract, heading, closing, fieldOrder }).slice(0, 16)}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const invalid = (message: string): never => { throw new ModelConfigurationError(`observation evidence layout: ${message}`); };

/** Reorder schema properties only; all constraints and model-authored values survive. */
export function observationEvidenceRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "observation-renderer" || !["observation_render", "observation_projection_batch"].includes(request.schemaName)) return request;
  if (request.jsonObjectPostlude !== undefined || request.promptVersion.includes(OBSERVATION_EVIDENCE_LAYOUT)) return invalid("already applied");
  if (request.system !== contract) return invalid("registered observation contract changed");
  const context = request.context;
  if (!object(context) || !object(context.state)) return invalid("missing observation context");
  const sharedState = isSharedBatchContext(context.state) ? context.state : null;
  const shared = sharedState !== null;
  if ((request.schemaName === "observation_projection_batch") !== shared) return invalid("batch requires hash-verified shared contexts");
  const contexts = sharedState ? expandSharedBatchContexts(sharedState) : [context];
  const slots = object(context.task) ? context.task.slots : undefined;
  if (shared && (!Array.isArray(slots) || slots.length !== contexts.length)) return invalid("slot coverage differs");
  const evidence = contexts.map((logical, index) => {
    const binding = observationSlotBinding(logical);
    if (shared) {
      const outer = (slots as unknown[])[index];
      if (!object(outer) || outer.slot !== index || !object(outer.observerBinding) || contentHash(outer.observerBinding) !== contentHash(binding)) return invalid("outer observer binding differs");
    }
    if (!object(logical.state) || !Array.isArray(logical.state.currentEvents)) return invalid("missing current events");
    return { slot: index, observerBinding: binding, currentEvents: structuredClone(logical.state.currentEvents) };
  });
  const original = request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" });
  const wire = structuredClone(original);
  let result: Record<string, unknown> = wire;
  if (shared) {
    const schemaSlots = object(wire.properties) ? wire.properties.slots : undefined;
    const item = object(schemaSlots) ? schemaSlots.items : undefined;
    const nested = object(item) && object(item.properties) ? item.properties.result : undefined;
    if (!object(nested)) return invalid("missing batch observation schema");
    result = nested;
  }
  const fields = result.properties;
  if (!object(fields) || Object.keys(fields).sort().join(",") !== [...fieldOrder].sort().join(",") ||
    !Array.isArray(result.required) || [...result.required].sort().join(",") !== [...fieldOrder].sort().join(",") || result.additionalProperties !== false) return invalid("unexpected observation schema");
  result.properties = Object.fromEntries(fieldOrder.map(key => [key, fields[key]]));
  if (contentHash(wire) !== contentHash(original)) return invalid("schema constraints changed");
  const jsonObjectPostlude = heading + contract + "\n\nExact evidence copies, without inference or added access:\n" + JSON.stringify(evidence) + "\n\n" + closing;
  return { ...request, wireJsonSchema: wire, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${OBSERVATION_EVIDENCE_LAYOUT}@${contentHash(jsonObjectPostlude).slice(0, 16)}` };
}

/** Install below physical observation batching so repairs bind their own current slots. */
export function observationEvidenceProvider(inner: StructuredModelProvider, unconfirmedClaims = false): StructuredModelProvider {
  return { catalog: inner.catalog,
    availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids),
    ...(inner.modelRegistryDiagnostics ? { modelRegistryDiagnostics: () => inner.modelRegistryDiagnostics!() } : {}),
    ...(inner.refreshModelRegistry ? { refreshModelRegistry: () => inner.refreshModelRegistry!() } : {}),
    generateStructured: request => {
      const laidOut = observationEvidenceRequest(request);
      return inner.generateStructured(unconfirmedClaims ? observationClaimEncodingRequest(laidOut) : laidOut);
    } };
}
