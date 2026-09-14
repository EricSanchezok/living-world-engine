import { contentHash } from "../models/model-audit";
import { ModelConfigurationError, type StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";
import { sourceIndexedPlanningInstruction, SOURCE_INDEXED_PLAN_MEANS } from "./source-indexed-planning";
import { SourceIndexedPlanCauseCodec, SOURCE_INDEXED_PLAN_CAUSES } from "./source-indexed-plan-causes";

const heading = "\n\nFinal physical planning contract (all original state, actions and schema above remain authoritative):\n";
const coverage = "Return exactly one complete plan for every listed actionIndex in one commit_plans result. These are all assigned actions across all original slots, not examples or background actions. Preserve every original action and its constraints. Before returning, verify the complete index set.";
const causes = "For this candidate the supplied schema names causeIndices, not causes. Select each causeIndex from task.planCauseChoices.choices within the original source slot; the code restores its exact kind/ref. Include the plan's own action as an explicit selected cause. Never emit causes or entity sources in that list.";
export const planningContractTailCauseInstruction = (): string => causes;
const intent = loadPromptAsset("shared/planning-intent-preservation.md");
export const PLANNING_CONTRACT_TAIL = `indexed-planning-contract-tail-v1@${contentHash({ heading, coverage, causes, intent,
  indexed: sourceIndexedPlanningInstruction(true), causeContract: SOURCE_INDEXED_PLAN_CAUSES }).slice(0, 16)}`;

/** Repeat the current owned contract after the schema; never replace source content. */
export function planningContractTailRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "truth-resolution" || !["truth_resolution_plan_commit", "truth_resolution_plan_repair", "truth_resolution_plan_commit_batch"].includes(request.schemaName)) return request;
  if (request.jsonObjectPostlude !== undefined || request.promptVersion.includes(PLANNING_CONTRACT_TAIL)) throw new ModelConfigurationError("planning contract tail already applied");
  const source = structuredClone(request.context) as { task?: Record<string, unknown> };
  if (!source.task || (source.task.planningIndices as { meansContract?: string } | undefined)?.meansContract !== SOURCE_INDEXED_PLAN_MEANS) {
    throw new ModelConfigurationError("planning contract tail requires action-local means positions");
  }
  delete source.task.planCauseChoices;
  const codec = new SourceIndexedPlanCauseCodec(source);
  if (contentHash(codec.project()) !== contentHash(request.context)) throw new ModelConfigurationError("planning contract tail cause binding changed");
  const jsonObjectPostlude = heading + sourceIndexedPlanningInstruction(true) + "\n\n" + JSON.stringify({
    requiredPlanCount: codec.actions.length, requiredActionIndices: codec.actions.map((_, i) => i),
  }) + "\n" + coverage + "\n\n" + intent + "\n" + causes;
  return { ...request, jsonObjectPostlude,
    promptVersion: `${request.promptVersion}/${PLANNING_CONTRACT_TAIL}@${contentHash(jsonObjectPostlude).slice(0, 16)}` };
}
