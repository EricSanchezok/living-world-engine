import type { StructuredModelRequest } from "../../models/model-provider";
import { PERCEPTION_LAW_CONTEXT, perceptionLawContextRequest } from "./perception-law-context";
import { PERCEPTION_SOURCE_FIDELITY, perceptionSourceFidelityRequest } from "./perception-source-fidelity";

export const PERCEPTION_LAW_FIDELITY = `${PERCEPTION_LAW_CONTEXT}+${PERCEPTION_SOURCE_FIDELITY}`;

/** Explicit interaction experiment; both isolated adapters retain their guards. */
export function perceptionLawFidelityRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  const laws = perceptionLawContextRequest(request);
  const fidelity = perceptionSourceFidelityRequest(request);
  return { ...request, promptVersion: `${request.promptVersion}/${PERCEPTION_LAW_FIDELITY}`,
    jsonObjectPostlude: laws.jsonObjectPostlude! + fidelity.jsonObjectPostlude! };
}
