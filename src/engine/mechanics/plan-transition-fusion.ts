import { z } from "zod";
import { transitionProposalSchema } from "../contracts/llm-schemas";
import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";
import { loadPromptAsset, promptBundle } from "../prompts";
import { declaredRandomPlanSchema } from "./plan-random-completion";
import { factorSharedBatchContexts } from "./shared-batch-context";

export const fusedPlanTransitionSchema = declaredRandomPlanSchema.extend({ provisionalTransition: transitionProposalSchema.nullable() });
export const PLAN_TRANSITION_FUSION_PROMPT = loadPromptAsset("shared/plan-transition-fusion.md");
export const PLAN_TRANSITION_FUSION = `reviewed-plan-transition-fusion-v1@${contentHash({
  prompt: PLAN_TRANSITION_FUSION_PROMPT, transition: promptBundle("truth-transition").version,
  schema: z.toJSONSchema(fusedPlanTransitionSchema, { target: "draft-07" }),
}).slice(0, 16)}`;

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelConfigurationError("fusion source must be a context object");
  return value as Record<string, unknown>;
};

/** Co-generation preserves both complete sources; it conveys no semantic guarantee.
 * @see ../../../docs/decisions/0225-co-generate-uncommitted-plan-and-transition-candidates.md */
export function planTransitionFusionContext(planning: unknown, transition: unknown): unknown {
  const before = object(planning), after = object(transition), state = object(before.state);
  const catalog = object(before.referenceCatalog), laterCatalog = object(after.referenceCatalog);
  const candidates = new Map<string, unknown>();
  for (const value of [...catalog.candidates as unknown[], ...laterCatalog.candidates as unknown[]]) {
    const candidate = object(value), key = candidate.handle;
    if (typeof key !== "string") throw new ModelConfigurationError("fusion candidate lacks an existing handle");
    const previous = candidates.get(key);
    if (previous && contentHash(previous) !== contentHash(value)) throw new ModelConfigurationError("fusion catalogs disagree on a reference");
    candidates.set(key, structuredClone(value));
  }
  const combined = [...candidates.values()];
  return { ...structuredClone(before), state: { actionSet: structuredClone(state.actionSet),
    stageContexts: factorSharedBatchContexts([before, after]) },
    referenceCatalog: { ...structuredClone(catalog), candidates: combined, hash: contentHash(combined) } };
}

export function fusionPlanningDirective(value: unknown) {
  const parsed = fusedPlanTransitionSchema.safeParse(value);
  return parsed.success ? { kind: parsed.data.kind, plans: parsed.data.plans } : value;
}
