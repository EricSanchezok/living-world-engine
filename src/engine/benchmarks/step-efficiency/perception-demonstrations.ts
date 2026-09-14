import { contentHash } from "../../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../../models/model-provider";
import { loadPromptAsset } from "../../prompts";

export const PERCEPTION_DEMONSTRATIONS_TEXT = loadPromptAsset("shared/perception-paired-demonstrations.md");
export const PERCEPTION_DEMONSTRATIONS = `perception-paired-demonstrations-v1@${contentHash(PERCEPTION_DEMONSTRATIONS_TEXT).slice(0, 16)}`;

/** Benchmark-only semantic demonstrations; rationale and provenance: decision 0208. */
export function perceptionDemonstrationsRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-perception" || request.schemaName !== "truth_perception_directive") return request;
  if (request.promptVersion.includes("perception-paired-demonstrations-v1") || request.system.includes(PERCEPTION_DEMONSTRATIONS_TEXT)) {
    throw new ModelConfigurationError("Perception demonstrations require an unadapted request");
  }
  return { ...request, system: [request.system, PERCEPTION_DEMONSTRATIONS_TEXT].join("\n\n"),
    promptVersion: `${request.promptVersion}/${PERCEPTION_DEMONSTRATIONS}` };
}

/** Check the full physical intervention, including context, schema and inference parameters. */
export function verifyOnlyPerceptionDemonstrationsAdded(baseline: unknown, treatment: unknown): void {
  if (!baseline || typeof baseline !== "object" || !("messages" in baseline) || !Array.isArray(baseline.messages)) {
    throw new ModelConfigurationError("Missing baseline messages");
  }
  const expected = { ...structuredClone(baseline), messages: structuredClone(baseline.messages) };
  const systems = expected.messages.filter((row: unknown) => row !== null && typeof row === "object" && "role" in row && row.role === "system");
  if (systems.length !== 1 || typeof systems[0].content !== "string") throw new ModelConfigurationError("Expected one system message");
  systems[0].content += `\n\n${PERCEPTION_DEMONSTRATIONS_TEXT}`;
  if (contentHash(expected) !== contentHash(treatment)) throw new ModelConfigurationError("Perception treatment changed more than demonstrations");
}
