import { resolutionEvidenceIndex } from "../mechanics/resolution-evidence";
import type { D20CheckRequest, D20CheckResult, SimulationState } from "../contracts/model";
import { resolutionPlanSchema } from "../contracts/llm-schemas";
import { deriveCheck, deriveResolutionReceipt, validateResolutionPlan, type ResolutionPlan, type ResolutionReceipt } from "../mechanics/resolution";
import type { ProgramResources } from "../programs/definition";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { runtimeId } from "../runtime/runtime-id";
import { worldProvenance, type BoundWorldProgram } from "./adjudication";
import { evaluateWorldValue } from "./world-program";


export function materializeWorldResolutions(state: Readonly<SimulationState>, definition: WorldRuntimeContract,
  resources: ProgramResources, bound: BoundWorldProgram, revision = state.revision) {
  const evidence = resolutionEvidenceIndex(state, [{ id: bound.attempt.id }], definition.laws);
  return bound.program.definition.resolutions.map((declaration, ordinal) => {
    const fields = evaluateWorldValue(declaration.plan, bound.parameters, resources, bound.attempt);
    if (!fields || typeof fields !== "object" || Array.isArray(fields)) throw new Error("named resolution plan must be an object");
    if (["id", "actionId", "actorId", "causes"].some(key => Object.hasOwn(fields, key))) throw new Error("resolution identity, ownership and causes belong to the kernel");
    const plan = resolutionPlanSchema.parse({ ...fields,
      id: runtimeId({ worldHash: state.worldHash, revision, kind: "resolution-plan", stage: "world-program",
        owner: [bound.attempt.id, bound.program.hash, declaration.id], round: 0, ordinal }),
      actionId: bound.attempt.id, actorId: bound.attempt.actorEntityId, causes: worldProvenance(bound).causes,
    });
    validateResolutionPlan(plan, evidence);
    const visibility = ["hidden", "result_only", "full"];
    if (visibility.indexOf(plan.visibility) > visibility.indexOf(definition.disclosure.defaultCheckVisibility)) throw new Error("resolution exceeds the authored disclosure policy");
    for (const effect of [plan.primaryEffect, plan.secondaryEffect, plan.threatenedEffect]) {
      if (!effect) continue;
      if (effect.kind === "meter") {
        const meter = state.truth.meters[effect.meterId], profile = state.truth.mechanics.impactProfiles[effect.impactProfileId];
        if (!meter || meter.entityId !== effect.targetId || !profile || profile.meterDefinitionId !== meter.definitionId) throw new Error("resolution meter, target or impact profile mismatch");
      } else if (!state.truth.mechanics.durationProfiles[effect.durationProfileId] ||
        effect.conditionProfileId && !state.truth.mechanics.conditionProfiles[effect.conditionProfileId]) throw new Error("resolution requires actual duration and condition profiles");
    }
    const check: D20CheckRequest | null = plan.mode === "check" ? {
      id: runtimeId({ worldHash: state.worldHash, revision, kind: "check", stage: "world-program", owner: plan.id, round: 0, ordinal }),
      actorId: plan.actorId, targetId: plan.difficulty?.kind === "opposed" ? plan.difficulty.targetId : plan.primaryEffect?.targetId ?? plan.targetIds[0] ?? null,
      ratingId: plan.actorRatingId, modifierSources: plan.actorRatingId ? [{ kind: "rating", id: plan.actorRatingId, amount: deriveCheck(plan, evidence).modifier }] : [],
      ...deriveCheck(plan, evidence), stakes: `${plan.risk}: ${plan.primaryEffect?.description ?? plan.goal}`,
      visibility: plan.visibility, phase: "resolution", causes: structuredClone(plan.causes),
    } : null;
    return { key: declaration.id, plan, check };
  });
}

export function worldResolutionReceipt(state: Readonly<SimulationState>, definition: WorldRuntimeContract, plan: ResolutionPlan,
  request: D20CheckRequest | null, result: D20CheckResult | null, ordinal: number, revision = state.revision): ResolutionReceipt {
  if (request && result?.requestId !== request.id) throw new Error("named resolution has no committed D20 result");
  return deriveResolutionReceipt({
    receiptId: runtimeId({ worldHash: state.worldHash, revision, kind: "resolution-receipt", stage: "world-program", owner: plan.id, round: 0, ordinal }),
    plan, checkRequestId: request?.id ?? null,
    check: request ? deriveCheck(plan, resolutionEvidenceIndex(state, [{ id: plan.actionId }], definition.laws)) : null, result,
  });
}
