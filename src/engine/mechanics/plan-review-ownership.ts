import { contentHash } from "../models/model-audit";
import type { StructuredModelProvider, StructuredModelRequest } from "../models/model-provider";
import { loadPromptAsset } from "../prompts";

export function sourceIntentReviewRequest<T>(request: StructuredModelRequest<T>): StructuredModelRequest<T> {
  if (request.role !== "causal-verifier" || request.schemaName !== "resolution_plan_verification") throw new Error("source intent review requires a logical plan verifier");
  const state = (request.context as { state: { candidateResolutionPlans: Array<{ actionRef: string; goal: string }>;
    actionSet: { assigned: Array<{ actionRef: string; goal: string }> } } }).state;
  const actions = new Map(state.actionSet.assigned.map(action => [action.actionRef, action]));
  if (!state.candidateResolutionPlans.length || state.candidateResolutionPlans.some(plan =>
    !actions.has(plan.actionRef) || actions.get(plan.actionRef)!.goal !== plan.goal)) throw new Error("plan goal is not the exact source-owned intent");
  const instruction = loadPromptAsset("shared/plan-review-source-intent.md");
  return { ...request, system: [request.system, instruction].join("\n\n"),
    promptVersion: `${request.promptVersion}:source-intent-${contentHash(instruction).slice(0, 16)}` };
}

export function sourceIntentReviewProvider(inner: StructuredModelProvider): StructuredModelProvider {
  return { catalog: inner.catalog, availableProfileSummaries: role => inner.availableProfileSummaries(role),
    assertProfilesAvailable: ids => inner.assertProfilesAvailable(ids), generateStructured: request => inner.generateStructured(
      request.role === "causal-verifier" && request.schemaName === "resolution_plan_verification" ? sourceIntentReviewRequest(request) : request) };
}
