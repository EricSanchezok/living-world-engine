import { z } from "zod";
import type { AgentActionProposal, CausalAssertion, CausalRef, MechanicInvocation, SimulationState, WorldFact } from "../../contracts/model";
import type { TruthCandidateStage, TruthPreparationInput } from "../../algorithms/roles";
import { contentHash } from "../../models/model-audit";
import { runtimeId } from "../../runtime/runtime-id";
import { evaluateProposalCausality } from "../../mechanics/causality";
import { deriveResolutionReceipt, validateResolutionPlan, type ResolutionPlan } from "../../mechanics/resolution";
import { createCoreRulePackageRegistry, type RulePackageRegistry } from "../../mechanics/rule-package";
import { resolutionEvidenceIndex } from "../../mechanics/truth-engine";

export const EXECUTABLE_CAPABILITY_PREDICATE = "executable_interaction_capability_v1";
const baseCapability = z.strictObject({
  version: z.literal(1), actorEntityId: z.string().min(1), targetEntityId: z.string().min(1),
  actorPlacementId: z.string().nullable(), targetPlacementId: z.string().nullable(),
  durationSeconds: z.number().int().positive(), validFromSeconds: z.number().int().nonnegative(),
  validUntilSeconds: z.number().int().positive().nullable(),
});
export const executableCapabilitySchema = z.discriminatedUnion("kind", [
  baseCapability.extend({ kind: z.literal("message"), channel: z.enum(["local", "remote"]) }),
  baseCapability.extend({ kind: z.literal("observe_fact"), factIds: z.array(z.string()).min(1) }),
  baseCapability.extend({ kind: z.literal("transfer_quantity"), definitionId: z.string(), maxAmount: z.number().positive() }),
]);
export type ExecutableCapability = z.infer<typeof executableCapabilitySchema>;
const binding = { capabilityFactId: z.string().min(1), targetLocalId: z.string().min(1) };
export const interactionOperationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("residual"), reason: z.string().min(1) }),
  z.strictObject({ kind: z.literal("message"), ...binding, verbatimMessage: z.string().min(1) }),
  z.strictObject({ kind: z.literal("observe_fact"), ...binding, factId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("transfer_quantity"), ...binding, definitionId: z.string().min(1),
    amount: z.number().positive(), quotedAmount: z.string().min(1) }),
]);
export const interactionProgramSchema = z.strictObject({
  actionId: z.string().min(1),
  parts: z.array(z.strictObject({ pointer: z.string(), segments: z.array(z.strictObject({
    text: z.string().min(1), operation: interactionOperationSchema,
  })).min(1) })).min(1),
});
export type InteractionProgram = z.infer<typeof interactionProgramSchema>;
export interface BoundInteractionProgram {
  version: 1; worldHash: string; actionHash: string; program: InteractionProgram;
  sourceHashes: Record<string, string>; targets: Record<string, string>;
}

/** Complete current attempts; later conditions stay in their exact source text. */
export function currentInteractionParts(action: AgentActionProposal) {
  if (!action.rawText.startsWith("CURRENT_PARALLEL_ATTEMPTS_V1 ")) {
    return [{ pointer: "/rawText", text: action.rawText, targetIds: [...action.targetIds] }];
  }
  const parsed = z.strictObject({ attempts: z.array(z.strictObject({ text: z.string().min(1),
    targetIndices: z.array(z.number().int().nonnegative()),
  })).min(1) }).parse(JSON.parse(action.rawText.slice(action.rawText.indexOf("\n") + 1)));
  return parsed.attempts.map((part, index) => ({ pointer: `/attempts/${index}/text`, text: part.text,
    targetIds: part.targetIndices.map(i => {
      if (!action.targetIds[i]) throw new Error("parallel target index outside source");
      return action.targetIds[i];
    }) }));
}

const actionHash = (action: AgentActionProposal) => contentHash({ id: action.id, actorId: action.actorId,
  rawText: action.rawText, goal: action.goal, means: action.means, targetIds: action.targetIds });
export function authoredCapabilities(state: Readonly<SimulationState>) {
  return Object.values(state.truth.facts).flatMap(fact => {
    if (fact.predicate !== EXECUTABLE_CAPABILITY_PREDICATE || fact.value.kind !== "text" ||
      !fact.provenance.some(p => p.kind === "world_seed" && p.id === state.worldHash)) return [];
    try {
      const parsed = executableCapabilitySchema.safeParse(JSON.parse(fact.value.value));
      return parsed.success && parsed.data.actorEntityId === fact.subjectId
        ? [{ factId: fact.id, capability: parsed.data }] : [];
    } catch { return []; }
  });
}

/** Binding never evaluates natural-language equivalence or invents a missing capability. */
export function bindInteractionProgram(state: Readonly<SimulationState>, action: AgentActionProposal, raw: unknown): BoundInteractionProgram {
  const program = interactionProgramSchema.parse(raw), source = currentInteractionParts(action);
  if (program.actionId !== action.id || program.parts.length !== source.length ||
    program.parts.some((part, i) => part.pointer !== source[i].pointer || part.segments.map(s => s.text).join("") !== source[i].text)) {
    throw new Error("interaction program does not preserve the complete source partition");
  }
  const sourceHashes: Record<string, string> = {}, targets: Record<string, string> = {};
  const capabilities = new Map(authoredCapabilities(state).map(c => [c.factId, c.capability]));
  for (const [i, part] of program.parts.entries()) for (const { text, operation: op } of part.segments) {
    if (op.kind === "residual") continue;
    const cap = capabilities.get(op.capabilityFactId);
    const ids = state.agents[action.actorId]?.bindings[op.targetLocalId]?.canonicalEntityIds;
    if (!source[i].targetIds.includes(op.targetLocalId) || ids?.length !== 1 ||
      !cap || cap.kind !== op.kind || cap.actorEntityId !== state.agents[action.actorId]?.entityId || cap.targetEntityId !== ids[0]) {
      throw new Error("interaction target or authored capability is unbound");
    }
    targets[op.targetLocalId] = ids[0];
    sourceHashes[op.capabilityFactId] = contentHash(state.truth.facts[op.capabilityFactId]);
    if (op.kind === "message" && !text.includes(op.verbatimMessage)) throw new Error("message was not copied verbatim from its source segment");
    if (op.kind === "observe_fact") {
      const fact = state.truth.facts[op.factId];
      if (!fact || cap.kind !== "observe_fact" || !cap.factIds.includes(op.factId) || fact.subjectId !== ids[0]) {
        throw new Error("observation does not cite the capability's existing fact");
      }
      sourceHashes[op.factId] = contentHash(fact);
    }
    if (op.kind === "transfer_quantity" && (cap.kind !== "transfer_quantity" || cap.definitionId !== op.definitionId ||
      op.amount > cap.maxAmount || !text.includes(op.quotedAmount))) throw new Error("quantity exceeds the authored capability or source");
  }
  return { version: 1, worldHash: state.worldHash, actionHash: actionHash(action), program, sourceHashes, targets };
}

function readable(fact: WorldFact, actorId: string) {
  return fact.access.kind === "public" || fact.access.kind === "agents" && fact.access.agentIds.includes(actorId);
}

export function interactionGuard(input: TruthPreparationInput, action: AgentActionProposal, bound: BoundInteractionProgram): string[] {
  const { state, temporalBoundary: boundary } = input, issues: string[] = [];
  if (bound.version !== 1 || bound.worldHash !== state.worldHash || bound.actionHash !== actionHash(action)) return ["source-action-changed"];
  try {
    const rebound = bindInteractionProgram(state, action, bound.program);
    if (contentHash(rebound) !== contentHash(bound)) issues.push("capability-fact-or-target-changed");
  } catch (error) { issues.push(`binding-invalid: ${String(error)}`); }
  const activity = Object.values(state.truth.activities).find(a => a.sourceActionId === action.id);
  if (!activity || activity.status !== "active" || !boundary.dueActivityIds.includes(activity.id) ||
    activity.completionAtSeconds === null || activity.completionAtSeconds > boundary.toElapsedSeconds) issues.push("current-activity-not-complete");
  const caps = new Map(authoredCapabilities(state).map(c => [c.factId, c.capability]));
  for (const part of bound.program.parts) for (const { operation: op } of part.segments) {
    if (op.kind === "residual") { issues.push(`residual: ${op.reason}`); continue; }
    const cap = caps.get(op.capabilityFactId);
    if (!cap) { issues.push("authored-capability-missing"); continue; }
    if (state.truth.entities[cap.actorEntityId]?.lifecycle !== "active" || state.truth.entities[cap.targetEntityId]?.lifecycle !== "active") issues.push("inactive-endpoint");
    if ((state.truth.placements[cap.actorEntityId] ?? null) !== cap.actorPlacementId ||
      (state.truth.placements[cap.targetEntityId] ?? null) !== cap.targetPlacementId) issues.push("contact-placement-changed");
    if (cap.kind === "message" && cap.channel === "local" &&
      (!cap.actorPlacementId || cap.actorPlacementId !== cap.targetPlacementId)) issues.push("local-channel-endpoints-separated");
    if (!activity || !('startedAtSeconds' in activity) || activity.startedAtSeconds + cap.durationSeconds > boundary.toElapsedSeconds ||
      activity.startedAtSeconds < cap.validFromSeconds || cap.validUntilSeconds !== null && boundary.toElapsedSeconds > cap.validUntilSeconds) issues.push("channel-or-operation-not-due");
    if (op.kind === "message" && !Object.values(state.agents).some(a => a.entityId === cap.targetEntityId)) issues.push("recipient-has-no-agent-mind");
    if (op.kind === "observe_fact" && (!state.truth.facts[op.factId] || !readable(state.truth.facts[op.factId], action.actorId))) issues.push("fact-not-accessible");
    if (op.kind === "transfer_quantity") {
      const stock = Object.values(state.truth.quantities).find(q => q.holderId === cap.actorEntityId && q.definitionId === op.definitionId);
      if (!stock || stock.amount < op.amount) issues.push("insufficient-owned-quantity");
    }
  }
  return [...new Set(issues)];
}

/** Derive a candidate, never a commit. Original global review and commit remain mandatory. */
export function executeInteractionComponent(input: TruthPreparationInput, bindings: Readonly<Record<string, BoundInteractionProgram>>,
  registry: RulePackageRegistry = createCoreRulePackageRegistry()): TruthCandidateStage {
  const { state, initialActions: actions } = input;
  if (!actions.length) throw new Error("empty executable component");
  for (const action of actions) {
    const bound = bindings[action.id];
    const issues = bound ? interactionGuard(input, action, bound) : ["program-missing"];
    if (issues.length) throw new Error(`component requires residual adjudication: ${action.actorId}: ${issues.join(", ")}`);
  }
  const id = (kind: Parameters<typeof runtimeId>[0]["kind"], owner: string, ordinal: number) => runtimeId({
    worldHash: state.worldHash, revision: state.revision, kind, stage: "executable-interaction", owner, round: 0, ordinal,
  });
  const resolutionPlans: ResolutionPlan[] = actions.map((action, i) => ({
    id: id("resolution-plan", action.id, i), actionId: action.id, actorId: state.agents[action.actorId].entityId,
    targetIds: [...new Set(Object.values(bindings[action.id].targets))], goal: action.goal,
    means: Object.keys(bindings[action.id].sourceHashes).map(factId => ({ description: state.truth.facts[factId].description, source: { kind: "fact" as const, id: factId } })),
    mode: "automatic", difficulty: null, actorRatingId: null, factors: [], risk: "safe", baseEffect: "none",
    primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
    visibility: input.definition.disclosure.defaultCheckVisibility, causes: [{ kind: "action", id: action.id }],
  }));
  const index = resolutionEvidenceIndex(state, actions, input.definition.laws);
  resolutionPlans.forEach(plan => validateResolutionPlan(plan, index));
  const receipts = resolutionPlans.map((plan, i) => deriveResolutionReceipt({ receiptId: id("resolution-receipt", plan.actionId, i),
    plan, checkRequestId: null, check: null, result: null }));
  const invocations: MechanicInvocation[] = [];
  const events: TruthCandidateStage["resolution"]["proposal"]["events"] = [];
  const caps = new Map(authoredCapabilities(state).map(c => [c.factId, c.capability]));
  for (const action of actions) for (const part of bindings[action.id].program.parts) for (const segment of part.segments) {
    const op = segment.operation;
    if (op.kind === "residual") throw new Error("residual entered deterministic execution");
    const cap = caps.get(op.capabilityFactId)!;
    const causes: CausalRef[] = [{ kind: "action", id: action.id }, { kind: "fact", id: op.capabilityFactId }];
    const assertions: CausalAssertion[] = [{ kind: "fact_matches", factId: op.capabilityFactId, expected: state.truth.facts[op.capabilityFactId].value },
      { kind: "placement_equals", entityId: cap.actorEntityId, placementId: cap.actorPlacementId },
      { kind: "placement_equals", entityId: cap.targetEntityId, placementId: cap.targetPlacementId }];
    const from = state.truth.entities[cap.actorEntityId].name, to = state.truth.entities[cap.targetEntityId].name;
    let description: string;
    if (op.kind === "message") description = `${from}的原话已通过声明通道交付给${to}：“${op.verbatimMessage}”。这是发言记录，不证明内容真实、对方相信或服从。`;
    else if (op.kind === "observe_fact") {
      const fact = state.truth.facts[op.factId];
      causes.push({ kind: "fact", id: fact.id }); assertions.push({ kind: "fact_matches", factId: fact.id, expected: fact.value });
      description = `${from}经声明的访问方式观察到${to}的既存资料：${fact.description}`;
    } else {
      invocations.push({ id: id("mechanic", action.id, invocations.length), packageId: "core-resolution", ruleId: "transfer-quantity",
        input: { definitionId: op.definitionId, fromHolderId: cap.actorEntityId, toHolderId: cap.targetEntityId,
          amountSource: { kind: "explicit_action_amount", actionId: action.id, amount: op.amount, quotedText: op.quotedAmount } }, causes, assertions });
      description = `${from}向${to}转移了${op.amount} ${state.truth.mechanics.quantities[op.definitionId].unit}。`;
    }
    events.push({ id: id("event", action.id, events.length), step: state.step + 1, description, impact: "ordinary", causes, assertions });
  }
  for (const receipt of receipts) invocations.push({ id: id("mechanic", receipt.id, invocations.length), packageId: "core-resolution", ruleId: "apply-receipt",
    input: { receiptId: receipt.id }, causes: receipt.plan.causes, assertions: [
      { kind: "entity_lifecycle", entityId: receipt.plan.actorId, expected: "active" },
    ] });
  invocations.push({ id: id("mechanic", input.identityOwner, invocations.length), packageId: "core-resolution", ruleId: "advance-conditions",
    input: { seconds: input.temporalBoundary.deltaSeconds }, causes: actions.map(a => ({ kind: "action", id: a.id })), assertions: [
      { kind: "elapsed_seconds_compare", operator: "eq", value: state.truth.elapsedSeconds },
    ] });
  const mechanics = registry.resolve(input.definition.rulePackages, { state, actions, resolutionPlans, resolutionReceipts: receipts,
    checkRequests: [], checkResults: [], randomRequests: [], randomResults: [] }, invocations, []);
  const proposal: TruthCandidateStage["resolution"]["proposal"] = { baseRevision: state.revision,
    outcomes: actions.map((a, i) => ({ id: id("outcome", a.id, i), proposalId: a.id, status: "succeeded",
      summary: events.filter(e => e.causes.some(c => c.kind === "action" && c.id === a.id)).map(e => e.description).join(" "),
      causeRefs: [{ kind: "action", id: a.id }], assertions: [
        { kind: "entity_lifecycle", entityId: state.agents[a.actorId].entityId, expected: "active" },
      ], knownAlternatives: [] })),
    mechanicInvocations: mechanics.invocations, operations: [...mechanics.operations, { kind: "advance_time", seconds: input.temporalBoundary.deltaSeconds,
      causes: actions.map(a => ({ kind: "action", id: a.id })), assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: state.truth.elapsedSeconds }] }],
    events, observations: [], decisionRequests: [] };
  const causalAssertionResults = evaluateProposalCausality(state, [], [], proposal);
  const resolution = { proposal, initialActions: structuredClone(actions), actions: structuredClone(actions),
    reactionRequests: [], reactionDecisions: [], stimulusObservations: [], requests: [], checks: [], randomRequests: [], randomResults: [],
    commitmentRounds: [], resolutionPlans, resolutionReceipts: receipts, rng: structuredClone(state.truth.rng),
    mechanicResults: mechanics.results, causalAssertionResults, modelAudits: [], reactionModelAudits: [] };
  return { resolution, transitionAttempt: 0, reviewInvocationOffset: 0, reviewEvidence: {
    definition: input.definition, state, workset: { state: input.modelWorkset?.state ?? state, mode: "full",
      initialActions: input.modelWorkset?.initialActions ?? actions, availableActions: input.modelWorkset?.availableActions ?? actions,
      assignedActions: actions, availableDependencies: input.modelWorkset?.availableDependencies ?? input.groundings, assignedDependencies: input.groundings },
    checkRequests: [], checkResults: [], randomRequests: [], randomResults: [], commitmentRounds: [], resolutionPlans, resolutionReceipts: receipts,
    proposal, assertionResults: causalAssertionResults, mechanicResults: mechanics.results, previousReport: null,
    instanceId: "executable-interaction", advanceId: input.identityOwner,
    temporalEvidence: input.temporalBoundary, reactionDecisions: input.completedReactionDecisions,
    mechanicContracts: registry.promptContracts(input.definition.rulePackages), resolutionScope: input.resolutionScope,
  } };
}
