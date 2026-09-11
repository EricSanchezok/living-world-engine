import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  agentMindOutputSchema,
  actionGroundingSchema,
  arrivalDraftSchema,
  causalVerificationSchema,
  observationBatchSchema,
  perceptionDirectiveSchema,
  reactionDecisionDraftSchema,
  reactionRoutingOutputSchema,
  resolutionContinuationDirectiveSchema,
  resolutionDirectiveSchema,
  resolutionPlanCommitDirectiveSchema,
  resolutionPlanVerificationSchema,
  transitionProposalSchema,
  observationRenderSchema,
} from "../llm-schemas";

const causalSource = {
  causes: [{ kind: "law" as const, ref: "ref:law:world-law" }],
  assertions: [{ kind: "elapsed_seconds_compare" as const, operator: "gte" as const, value: 0 }],
};

const emptyCharacter = {
  persona: { summary: "新生主体", voice: "平静", evidenceRefs: [] },
  traits: [],
  values: [],
  emotions: [],
  attitudes: [],
  goals: [],
  commitments: [],
};

function transitionWith(operation?: unknown) {
  return {
    outcomes: [],
    mechanicInvocations: [],
    operations: operation === undefined ? [] : [operation],
    events: [{
      proposalKey: "event-local",
      description: "候选内事件。",
      impact: "ordinary",
      ...causalSource,
    }],
    decisionRequests: [],
  };
}

describe("LLM output field ownership", () => {
  it("generates strict JSON Schema for every model role without reintroducing owned fields", () => {
    const schemas = {
      perception: z.toJSONSchema(perceptionDirectiveSchema, { target: "draft-07" }),
      reactionRouting: z.toJSONSchema(reactionRoutingOutputSchema, { target: "draft-07" }),
      resolution: z.toJSONSchema(resolutionDirectiveSchema, { target: "draft-07" }),
      resolutionPlanVerifier: z.toJSONSchema(resolutionPlanVerificationSchema, { target: "draft-07" }),
      transition: z.toJSONSchema(transitionProposalSchema, { target: "draft-07" }),
      observation: z.toJSONSchema(observationBatchSchema, { target: "draft-07" }),
      causalVerifier: z.toJSONSchema(causalVerificationSchema, { target: "draft-07" }),
      agentMind: z.toJSONSchema(agentMindOutputSchema, { target: "draft-07" }),
      agentReaction: z.toJSONSchema(reactionDecisionDraftSchema, { target: "draft-07" }),
      actionGrounding: z.toJSONSchema(actionGroundingSchema, { target: "draft-07" }),
    };
    for (const schema of Object.values(schemas)) {
      expect(schema).toHaveProperty("$schema", "http://json-schema.org/draft-07/schema#");
    }
    expect(JSON.stringify(schemas.perception)).not.toContain('"phase"');
    expect(JSON.stringify(schemas.resolution)).not.toContain('"phase"');
    expect(JSON.stringify(schemas.resolution)).not.toContain('"dc"');
    expect(JSON.stringify(schemas.resolution)).not.toContain('"modifier"');
    const transitionSchema = JSON.stringify(schemas.transition);
    expect(transitionSchema).not.toContain('"knownAlternatives"');
    for (const field of [
      "baseRevision",
      "createdAtStep",
      "updatedAtStep",
      "provenance",
      "firedThresholdIds",
      "modelProfiles",
      "nextAction",
    ]) {
      expect(transitionSchema).not.toContain(`"${field}"`);
    }
    expect(JSON.stringify(schemas.agentMind)).not.toContain('"step"');
    expect(JSON.stringify(schemas.actionGrounding)).not.toContain('"actionId"');
    expect(JSON.stringify(schemas.actionGrounding)).not.toContain('"actorId"');
    const observation = {
      summary: "看见庭院中的变化。",
      introductions: [],
      apparentClaims: [],
      sourceEventRefs: [],
    };
    expect(observationBatchSchema.safeParse({ observations: [observation] }).success).toBe(true);
    expect(observationBatchSchema.safeParse({
      observations: [{ ...observation, id: "forged", observerId: "agent", step: 1, kind: "outcome" }],
    }).success).toBe(false);
    const grounding = {
      stateDependencies: { requiredExistingRefs: [], potentiallyAffectedExistingRefs: [] },
      audienceAgentRefs: [],
      sharedResourceClaims: [],
    };
    expect(actionGroundingSchema.safeParse(grounding).success).toBe(true);
    expect(actionGroundingSchema.safeParse({ ...grounding, requiresWorldWideArbitration: true }).success).toBe(false);
    expect(actionGroundingSchema.safeParse({
      ...grounding,
      stateDependencies: {
        requiredExistingRefs: ["ref:world:world"],
        potentiallyAffectedExistingRefs: ["ref:world:world"],
      },
    }).success).toBe(true);
    expect(actionGroundingSchema.safeParse({
      ...grounding,
      stateDependencies: { requiredExistingRefs: ["forged"], potentiallyAffectedExistingRefs: [] },
    }).success).toBe(false);
    expect(actionGroundingSchema.safeParse({
      ...grounding,
      reads: [],
      writes: [],
    }).success).toBe(false);
    expect(observationRenderSchema.safeParse({ ...observation, canonicalEntityId: "key" }).success).toBe(false);
    expect(arrivalDraftSchema.safeParse({
      title: "进入世界",
      scene: "你在庭院中恢复了注意。",
      suggestions: ["观察"],
      possibleNextActions: ["观察", "等待", "离开"],
    }).success).toBe(false);
  });

  it("keeps Agent-private alternatives out of canonical transition output", () => {
    const transition = transitionWith();
    const outcome = {
      proposalKey: "outcome-local",
      actionRef: "ref:action:action-local",
      status: "succeeded" as const,
      summary: "The action is resolved.",
      causes: [{ kind: "action" as const, ref: "ref:action:action-local" }],
      assertions: [{ kind: "elapsed_seconds_compare" as const, operator: "gte" as const, value: 0 }],
    };
    expect(transitionProposalSchema.safeParse({ ...transition, outcomes: [outcome] }).success).toBe(true);
    expect(transitionProposalSchema.safeParse({
      ...transition,
      outcomes: [{
        ...outcome,
        knownAlternatives: [{
          description: "A private interpretation.",
          evidenceRefs: ["ref:fact:canonical-truth"],
        }],
      }],
    }).success).toBe(false);
  });

  it("keeps check aliases semantic while the engine owns phase", () => {
    const request = {
      proposalKey: "check-local",
      actorRef: "ref:entity:agent-xiaoming",
      targetRef: null,
      ratingRef: null,
      difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:world-law" } },
      mode: "normal",
      stakes: "判断是否成功。",
      visibility: "result_only",
      causes: [{ kind: "law", ref: "ref:law:world-law" }],
    };
    expect(perceptionDirectiveSchema.safeParse({ kind: "request_checks", requests: [request] }).success)
      .toBe(true);
    expect(perceptionDirectiveSchema.safeParse({
      kind: "request_checks",
      requests: [{ ...request, phase: "perception" }],
    }).success).toBe(false);
  });

  it("expresses resolution-mode legality in the model output schema", () => {
    const plan = {
      proposalKey: "plan-local",
      actionRef: "ref:action:action-local",
      targetRefs: ["ref:entity:actor-local"],
      means: [],
      mode: "automatic" as const,
      difficulty: null,
      actorRatingRef: null,
      factors: [],
      risk: "safe" as const,
      baseEffect: "none" as const,
      primaryEffect: null,
      secondaryEffect: null,
      threatenedEffect: null,
      visibility: "full" as const,
      causes: [{ kind: "action" as const, ref: "ref:action:action-local" }],
    };
    expect(resolutionDirectiveSchema.safeParse({ kind: "commit_plans", plans: [plan] }).success).toBe(true);
    expect(resolutionPlanCommitDirectiveSchema.safeParse({ kind: "commit_plans", plans: [plan] }).success).toBe(true);
    expect(resolutionContinuationDirectiveSchema.safeParse({ kind: "commit_plans", plans: [plan] }).success).toBe(false);
    expect(resolutionPlanCommitDirectiveSchema.safeParse({ kind: "done" }).success).toBe(false);
    expect(resolutionContinuationDirectiveSchema.safeParse({ kind: "done" }).success).toBe(true);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{ ...plan, targetRefs: ["ref:local_entity:actor-local"] }],
    }).success).toBe(false);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{
        ...plan,
        means: [{ description: "mismatched kind", source: { kind: "entity", ref: "ref:fact:actor-local" } }],
      }],
    }).success).toBe(false);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{ ...plan, causes: [{ kind: "action", ref: "ref:fact:actor-local" }] }],
    }).success).toBe(false);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{
        ...plan,
        difficulty: { kind: "environment", band: "easy", source: { kind: "law", ref: "ref:law:world-law" } },
      }],
    }).success).toBe(false);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{ ...plan, causes: [{ kind: "entity", ref: "ref:entity:actor-local" }] }],
    }).success).toBe(false);
    const factor = {
      source: { kind: "entity" as const, ref: "ref:entity:actor-local" },
      role: "permission" as const,
      direction: "neutral" as const,
      steps: 0 as const,
      authority: "semantic" as const,
      channel: "perception",
      explanation: "The actor is present and permitted to observe.",
    };
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{ ...plan, factors: [factor] }],
    }).success).toBe(true);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{ ...plan, factors: [{ ...factor, direction: "helpful" }] }],
    }).success).toBe(false);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{
        ...plan,
        factors: [{
          ...factor,
          role: "potency",
          direction: "helpful",
          steps: 2,
          authority: "authored",
          source: { kind: "law", ref: "ref:law:world-law" },
        }],
      }],
    }).success).toBe(true);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{
        ...plan,
        factors: [{
          ...factor,
          role: "potency",
          direction: "helpful",
          steps: 2,
          authority: "authored",
        }],
      }],
    }).success).toBe(false);
    expect(resolutionDirectiveSchema.safeParse({
      kind: "commit_plans",
      plans: [{
        ...plan,
        factors: [{
          ...factor,
          role: "potency",
          direction: "helpful",
          steps: 2,
        }],
      }],
    }).success).toBe(false);
  });

  it("lets reaction routing describe private semantics without assigning runtime identities", () => {
    const request = {
      agentRef: "ref:agent:agent-xiaoming",
      sourceActionRef: "ref:action:action-local",
      stimulus: {
        summary: "有人在呼唤。",
        introductions: [],
        apparentClaims: [{
          subjectRef: "ref:local_entity:speaker-local",
          predicate: "utterance",
          value: { kind: "text", value: "hello" },
          description: "听见一句话。",
        }],
        sourceEventRefs: [],
      },
      basis: [{ kind: "fact", factRef: "ref:fact:audible-channel" }],
    };
    expect(reactionRoutingOutputSchema.safeParse({ requests: [request] }).success).toBe(true);
    expect(reactionRoutingOutputSchema.safeParse({
      requests: [{
        ...request,
        stimulus: {
          ...request.stimulus,
          id: "forged-stimulus",
          apparentClaims: [{ ...request.stimulus.apparentClaims[0], id: "forged-claim" }],
        },
      }],
    }).success).toBe(false);
  });

  it("keeps semantic world ids and proposal aliases while rejecting engine-owned transition fields", () => {
    const semanticOperations = [
      {
        kind: "create_entity",
        entity: {
          proposalKey: "xiaoming-body",
          kind: "person",
          name: "小明",
          description: "一个新出现的人。",
        },
        placementRef: null,
        ...causalSource,
      },
      {
        kind: "set_fact",
        fact: {
          proposalKey: "xiaoming-is-awake",
          subjectRef: { proposalKey: "xiaoming-body" },
          predicate: "awake",
          value: { kind: "boolean", value: true },
          description: "小明醒着。",
          access: { kind: "public" },
        },
        ...causalSource,
      },
      {
        kind: "create_agent",
        agent: {
          proposalKey: "agent-xiaoming",
          entityRef: { proposalKey: "xiaoming-body" },
          character: emptyCharacter,
          belief: {
            localEntities: [{ proposalKey: "self", name: "我", description: "小明自己", status: "observed" }],
            claims: [],
            evidence: [],
          },
          bindings: [{ localEntityRef: { proposalKey: "self" }, canonicalEntityRefs: [{ proposalKey: "xiaoming-body" }] }],
        },
        ...causalSource,
      },
    ];

    for (const operation of semanticOperations) {
      expect(transitionProposalSchema.safeParse(transitionWith(operation)).success).toBe(true);
    }
    for (const operation of [
      { kind: "set_meter", meter: { id: "health:xiaoming", definitionId: "health", entityId: "xiaoming-body", current: 10 } },
      { kind: "adjust_meter", meterId: "health:xiaoming", amount: -5 },
      { kind: "set_rating", rating: { id: "force:xiaoming", definitionId: "force", entityId: "xiaoming-body", value: 2 } },
      { kind: "transfer_quantity", definitionId: "coin", fromHolderId: "a", toHolderId: "b", amount: 2 },
      { kind: "set_condition", condition: { id: "burning", magnitude: "major" } },
      { kind: "set_shared_activity_resource_capacity", poolId: "rt:shared-resource-pool:forged", capacity: 99 },
    ]) {
      expect(transitionProposalSchema.safeParse(transitionWith({ ...operation, ...causalSource })).success).toBe(false);
    }
    expect(transitionProposalSchema.safeParse({ ...transitionWith(), mechanicInvocations: [{
        proposalKey: "invoke",
        packageId: "core-resolution",
        ruleId: "transfer-quantity",
        input: {},
        ...causalSource,
      }] }).success).toBe(false);
    expect(transitionProposalSchema.safeParse({ ...transitionWith(), mechanicInvocations: [{
        proposalKey: "invoke",
        mechanicRef: "ref:mechanic:core-resolution-transfer-quantity",
        input: {},
        ...causalSource,
      }] }).success).toBe(true);

    const base = transitionWith();
    expect(transitionProposalSchema.safeParse({ ...base, baseRevision: 9 }).success).toBe(false);
    expect(transitionProposalSchema.safeParse({
      ...base,
      events: [{ ...base.events[0], step: 1 }],
    }).success).toBe(false);
    expect(transitionProposalSchema.safeParse({
      ...base,
      observations: [],
    }).success).toBe(false);
    expect(transitionProposalSchema.safeParse(transitionWith({
      ...semanticOperations[0],
      entity: { ...(semanticOperations[0] as { entity: object }).entity, lifecycle: "active", createdAtStep: 1 },
    })).success).toBe(false);
    expect(transitionProposalSchema.safeParse(transitionWith({
      ...semanticOperations[1],
      fact: { ...(semanticOperations[1] as { fact: object }).fact, provenance: [] },
    })).success).toBe(false);
    expect(transitionProposalSchema.safeParse(transitionWith({
      ...semanticOperations[2],
      agent: {
        ...(semanticOperations[2] as { agent: object }).agent,
        modelProfiles: { bootstrap: "forged", mind: "forged", reaction: "forged" },
        nextAction: null,
      },
    })).success).toBe(false);
  });

  it("lets AgentMind name evidence while the engine owns its step", () => {
    const output = {
      beliefChanges: {
        operations: [{
          kind: "upsert_evidence",
          evidence: {
            proposalKey: "heard-the-bell",
            kind: "observation",
            description: "我听见钟声。",
            sourceRef: null,
          },
        }],
      },
      characterChanges: { operations: [] },
      nextActionIntent: { rawText: "寻找钟声来源", goal: "调查", means: null, targetHandles: [] },
    };
    expect(agentMindOutputSchema.safeParse(output).success).toBe(true);
    expect(agentMindOutputSchema.safeParse({
      ...output,
      beliefPatch: {
        operations: [{
          ...output.beliefChanges.operations[0],
          evidence: { ...output.beliefChanges.operations[0].evidence, step: 1 },
        }],
      },
    }).success).toBe(false);
    expect(agentMindOutputSchema.safeParse({
      ...output,
      beliefChanges: {
        operations: [{ kind: "remove_local_entity", localEntityId: "old-id" }],
      },
    }).success).toBe(false);
  });
});
