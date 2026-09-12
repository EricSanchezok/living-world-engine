import path from "node:path";
import { buildWorldDefinition, loadWorldTemplate, parseWorldTemplate } from "../../../script/world-loader";
import type { AgentActionProposal } from "../../contracts/model";
import { resolutionPlanVerificationSchema } from "../../contracts/llm-schemas";
import { buildResolutionPlanVerificationContext } from "../../contracts/prompts";
import type { InteractionDependency } from "../../runtime/execution";
import { contentHash } from "../../models/model-audit";
import type { ModelCatalog } from "../../models/model-catalog";
import type { StructuredModelRequest } from "../../models/model-provider";
import { deriveResolutionReceipt, validateResolutionPlan, type ResolutionPlan } from "../../mechanics/resolution";
import { advanceTemporalState, createActivity, materializeTemporalPlan, selectTemporalBoundary } from "../../mechanics/temporal";
import { promptBundle } from "../../prompts";

/** Independent authored diagnostic worlds, not a sample of player gameplay. */
export function createPlanReviewControls(catalog: ModelCatalog) {
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  template.mechanics.temporal_profiles.push({ id: "investigation", name: "Unfinished investigation", kind: "goal", check_every_seconds: 60,
    selection: { semantic_tags: ["investigation"], evidence_requirement: "none" }, interruptible: true,
    reaction_fallback: "continue_if_valid", resource_claims: [{ resource_id: "foreground", amount: 1 }] });
  template.laws.laws.push({ id: "conclusive-evidence", severity: "hard", text: "Examining the gate is permitted while a question is unresolved. No conclusive result or discovery can be established before the analysis-ready fact becomes true. Starting an inspection does not change analysis-ready. The current interval does not complete the investigation." });
  template.entities.find(entity => entity.id === "gate")!.facts.push({ id: "analysis-ready", predicate: "analysis-ready",
    value: { kind: "boolean", value: false }, description: "The required analysis is unfinished; no conclusive result is available.", access: { kind: "public" } });
  const definition = buildWorldDefinition(parseWorldTemplate(template), { seed: 91, modelCatalog: catalog });
  const topics = ["whether the gate's inscription is authentic", "whether the gate conceals an exit", "whether the lock has been altered",
    "whether the visible mark is a warning", "whether the gate belongs to the old enclosure", "whether the surface pattern identifies its maker"];
  const ordered = topics.flatMap((topic, index) => [false, true].map(negative => ({ topic, index, negative })))
    .sort((a, b) => contentHash({ seed: 20260908, ...a }).localeCompare(contentHash({ seed: 20260908, ...b })));
  return ordered.map(({ topic, index, negative }, ordinal) => {
    const state = structuredClone(definition.initialState);
    const action: AgentActionProposal = { id: `review-control-action-${ordinal}`, actorId: "player", baseRevision: 0,
      rawText: `Begin examining the visible gate markings to determine ${topic}. Keep the question unresolved until the required analysis is ready.`,
      goal: `Determine ${topic}.`, means: "Begin a visual inspection without claiming a conclusive finding.", targetIds: ["gate"] };
    const temporalPlan = materializeTemporalPlan({ id: `review-control-temporal-${ordinal}`, actionId: action.id, actorId: action.actorId,
      rawText: action.rawText, startsAtSeconds: 0, profiles: state.truth.mechanics.temporalProfiles,
      draft: { profileId: "investigation", basis: { kind: "profile" }, description: action.rawText,
        continuationAssertions: [], causes: [{ kind: "action", id: action.id }] } });
    const activity = createActivity({ id: `review-control-activity-${ordinal}`, plan: temporalPlan, sourceAction: action });
    state.truth.activities[activity.id] = activity;
    const temporalEvidence = selectTemporalBoundary({ elapsedSeconds: 0, maxAutonomousSpanSeconds: 10,
      activities: state.truth.activities, timers: {}, conditionExpiries: {} });
    if (advanceTemporalState({ boundary: temporalEvidence, activities: state.truth.activities, timers: {} }).activities[activity.id]!.status !== "active") throw new Error("control task completed before its evidence");
    const effect = negative && index < 3;
    const plan: ResolutionPlan = { id: `review-control-plan-${ordinal}`, actionId: action.id, actorId: state.agents.player!.entityId,
      targetIds: ["gate"], goal: action.goal,
      means: [{ description: negative && !effect ? `The inspection has already conclusively established ${topic}; that result is now certain.`
        : "Begin examining the visible markings; the question remains unresolved at this boundary.", source: { kind: "action", id: action.id } }],
      mode: "automatic", difficulty: null, actorRatingId: null, factors: [], risk: "safe", baseEffect: effect ? "minor" : "none",
      primaryEffect: effect ? { id: `review-control-effect-${ordinal}`, kind: "condition", targetId: "gate", channel: "information",
        label: "Conclusive finding", description: `At this boundary the inspection conclusively establishes ${topic}; the result is certain.`,
        magnitude: "minor", conditionId: `review-control-result-${ordinal}`, conditionProfileId: null, durationProfileId: "ongoing",
        access: { kind: "public" }, sourceRefs: [{ kind: "action", id: action.id }] } : null,
      secondaryEffect: null, threatenedEffect: null, visibility: "full", causes: [{ kind: "action", id: action.id }] };
    validateResolutionPlan(plan, { actions: new Set([action.id]), entities: new Set(Object.keys(state.truth.entities)),
      facts: new Set(Object.keys(state.truth.facts)), conditions: new Set(), conditionOwners: new Map(),
      laws: new Set(definition.laws.map(law => law.id)), placements: new Set(Object.keys(state.truth.placements)),
      ratingOwners: new Map(), ratingValues: new Map() });
    const receipt = deriveResolutionReceipt({ receiptId: `review-control-receipt-${ordinal}`, plan, checkRequestId: null, check: null, result: null });
    if (!effect && receipt.effects.length) throw new Error("null-effect control changed mechanical consequences");
    const dependency: InteractionDependency = { kind: "action", id: action.id, actorId: action.actorId, reads: [], writes: [],
      audienceAgentIds: [], sharedResourceClaims: [], globalFallback: false };
    const context = buildResolutionPlanVerificationContext({ definition, state, temporalBoundary: temporalEvidence,
      workset: { state, mode: "full", initialActions: [action], availableActions: [action], assignedActions: [action],
        availableDependencies: [dependency], assignedDependencies: [dependency] },
      plans: [plan], commitmentRounds: [], instanceId: "plan-review-controls", advanceId: "review-controls-01", issues: [], temporalEvidence });
    const prompt = promptBundle("resolution-plan-verifier");
    const request: StructuredModelRequest<unknown> = { workloadId: "plan-review-controls", batchId: "review-controls-01",
      profileId: definition.modelProfiles.causalVerifier, role: "causal-verifier", subjectId: `case-${ordinal}`,
      schemaName: "resolution_plan_verification", schema: resolutionPlanVerificationSchema,
      promptVersion: prompt.version, system: prompt.system, userPrompt: prompt.userPrompt, context };
    return { id: ordinal, expected: negative ? "reject" as const : "accept" as const,
      violation: negative ? effect ? "effect-asserts-unavailable-result" : "means-asserts-unavailable-result" : null,
      stateHash: contentHash(state), sourceHash: contentHash({ definition, state, action, plan }), request };
  });
}
