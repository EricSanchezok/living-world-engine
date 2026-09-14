import type { StructuredModelRequest } from "../models/model-provider";
import { contentHash } from "../models/model-audit";
import { loadPromptAsset } from "../prompts";

export const RESOLUTION_SOURCE_ROLE_CONTRACT = "resolution-source-role-exclusivity-v2";
export const RESOLUTION_SOURCE_ROLE_INSTRUCTION = loadPromptAsset("shared/resolution-source-role-exclusivity.md");

/** Share the kernel ownership contract across base prompts and physical planning representations. */
export function resolutionSourceRoleRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.promptVersion.includes(RESOLUTION_SOURCE_ROLE_CONTRACT)) throw new Error("source role contract applied twice");
  const parts = [request.system];
  if (!request.system.includes(RESOLUTION_SOURCE_ROLE_INSTRUCTION)) parts.push(RESOLUTION_SOURCE_ROLE_INSTRUCTION);
  const system = parts.join("\n\n");
  return { ...request, system,
    promptVersion: `${request.promptVersion}/${RESOLUTION_SOURCE_ROLE_CONTRACT}@${contentHash(RESOLUTION_SOURCE_ROLE_INSTRUCTION).slice(0, 16)}` };
}
