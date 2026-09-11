import type { StructuredModelRequest } from "../models/model-provider";
import { contentHash } from "../models/model-audit";
import { loadPromptAsset } from "../prompts";

export const RESOLUTION_SOURCE_ROLE_CONTRACT = "resolution-source-role-exclusivity-v1";
export const RESOLUTION_SOURCE_ROLE_INSTRUCTION = loadPromptAsset("shared/resolution-source-role-exclusivity.md");

/** Candidate clarification of an existing kernel rule; no output or state transformation. */
export function resolutionSourceRoleRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(RESOLUTION_SOURCE_ROLE_CONTRACT)) throw new Error("source role contract applied twice");
  const system = `${request.system}\n\n${RESOLUTION_SOURCE_ROLE_INSTRUCTION}`;
  return { ...request, system,
    promptVersion: `${request.promptVersion}/${RESOLUTION_SOURCE_ROLE_CONTRACT}@${contentHash(RESOLUTION_SOURCE_ROLE_INSTRUCTION).slice(0, 16)}` };
}
