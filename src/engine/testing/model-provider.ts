import { canonicalize, contentHash, measureModelContext } from "../models/model-audit";
import { expandSharedBatchContexts, isSharedBatchContext } from "../mechanics/shared-batch-context";
import { parseModelCatalog, type ModelCatalog } from "../models/model-catalog";
import {
  MODELS_DEV_API_URL,
  type ModelRegistryService,
  type ModelRegistrySnapshot,
} from "../models/model-registry";
import type {
  StructuredModelProvider,
  StructuredModelRequest,
  StructuredModelResult,
} from "../models/model-provider";
import type { ModelExecutionAudit } from "../contracts/model";
import { ContextLimitExceededError, modelInvocationIdentity, ModelOutputError } from "../models/model-provider";
import type { ActionCompilationDraft, FootprintRef } from "../runtime/execution";
import type { ActionTemporalEvidence } from "../mechanics/temporal";
import type { AgentMindDraftOutput } from "../contracts/llm-schemas";
import { structuredPromptBytes } from "../prompts";
import { actionCompilationCandidateKeyForHandle, referenceHandleFor, type ActionCompilationCandidateKey, type ExistingReferenceHandle } from "../contracts/model-context";

const TEST_PROFILE_IDS = [
  "truth-engine",
  "agent-default",
  "truth-deepseek",
  "agent-deepseek",
  "agent-openai",
  "agent-xai",
];

export function createTestModelCatalog(
  profileIds: readonly string[] = TEST_PROFILE_IDS,
  options: { maxInputBytes?: number } = {},
): ModelCatalog {
  return parseModelCatalog({
    schema_version: 3,
    scheduler: {
      global_concurrency: 16,
      max_queued_requests: 1024,
      queue_timeout_ms: 300_000,
    },
    registry: {
      refresh_interval_ms: 3_600_000,
      request_timeout_ms: 10_000,
      stale_after_ms: 86_400_000,
    },
    accounts: {
      "scripted-test": {
        channel: "api",
        region: "test",
        protocol: "openai-chat",
        dialect: "deepseek",
        models_dev_provider_id: "scripted-test",
        base_url: "https://test.invalid",
        api_key_env: "TEST_MODEL_API_KEY",
        max_concurrency: 16,
      },
    },
    profiles: Object.fromEntries(profileIds.map((profileId) => [profileId, {
      account_id: "scripted-test",
      selector: { kind: "exact", model_id: `scripted:${profileId}` },
      description: `Deterministic test profile ${profileId}`,
      allowed_roles: profileId.startsWith("truth-") || profileId === "truth-engine"
        ? [
            "truth-perception",
            "truth-reaction-routing",
            "truth-resolution",
            "truth-transition",
            "action-compilation",
            "action-grounding",
            "observation-renderer",
            "causal-verifier",
            "arrival-generator",
          ]
        : ["agent-bootstrap", "agent-mind", "agent-reaction"],
      request_timeout_ms: 10_000,
      max_output_tokens: 32_768,
      max_input_bytes: options.maxInputBytes ?? 262_144,
      inference: {
        thinking: "auto",
        effort: "auto",
        reasoning_budget_tokens: "auto",
        reasoning_summary: "auto",
        text_verbosity: "auto",
        temperature: "auto",
        top_p: "auto",
      },
    }])),
    model_overrides: {},
  });
}

export function createTestModelRegistrySnapshot(catalog: ModelCatalog): ModelRegistrySnapshot {
  const providers: ModelRegistrySnapshot["document"]["providers"] = {};
  for (const [profileId, profile] of Object.entries(catalog.profiles)) {
    const account = catalog.account(profile.account_id);
    const provider = providers[account.models_dev_provider_id] ??= {
      id: account.models_dev_provider_id,
      name: `Test provider ${account.models_dev_provider_id}`,
      models: {},
    };
    const modelId = profile.selector.kind === "exact"
      ? profile.selector.model_id
      : `test-latest:${profileId}`;
    provider.models[modelId] = {
      id: modelId,
      name: modelId,
      family: "test",
      status: null,
      disabled: false,
      reasoning: true,
      reasoningToggle: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      reasoningBudget: { min: 1, max: 1_000_000 },
      toolCall: true,
      structuredOutput: true,
      temperature: true,
      releaseDate: "2026-01-01",
      lastUpdated: "2026-01-01",
      modalities: { input: ["text"], output: ["text"] },
      limit: { context: 1_000_000, output: 1_000_000 },
      fieldSources: {},
    };
  }
  const document: ModelRegistrySnapshot["document"] = {
    schemaVersion: 1,
    source: MODELS_DEV_API_URL,
    providers,
  };
  return { hash: contentHash(document), document };
}

export function createTestModelRegistry(catalog: ModelCatalog): ModelRegistryService {
  const snapshot = createTestModelRegistrySnapshot(catalog);
  return {
    catalog,
    async capture(hash) {
      if (hash && hash !== snapshot.hash) throw new Error(`unknown test registry snapshot ${hash}`);
      return snapshot;
    },
    async refresh() {
      return {
        outcome: "unchanged",
        snapshot,
        checkedAt: "2026-01-01T00:00:00.000Z",
        error: null,
      };
    },
    status() {
      return {
        source: MODELS_DEV_API_URL,
        health: "fresh",
        refreshing: false,
        currentHash: snapshot.hash,
        checkedAt: "2026-01-01T00:00:00.000Z",
        ageMs: 0,
        stale: false,
        lastError: null,
      };
    },
  };
}

export function createTestModelAudit(
  role: ModelExecutionAudit["role"],
  subjectId: string,
  worldHash: string,
  revision = 0,
): ModelExecutionAudit {
  const catalog = createTestModelCatalog();
  const profileId = role.startsWith("agent-") ? "agent-default" : "truth-engine";
  const profile = catalog.profile(profileId);
  const account = catalog.account(profile.account_id);
  const modelId = profile.selector.kind === "exact" ? profile.selector.model_id : `scripted:${profileId}`;
  const registrySnapshotHash = contentHash({ testRegistry: catalog.hash });
  const modelMetadataHash = contentHash({ modelId, deterministic: true });
  const identity = modelInvocationIdentity({
    workloadId: "test-only-correlation",
    batchId: "test-only-correlation",
    runtimeIdentity: { worldHash, revision },
  }, role, subjectId, 1);
  return {
    role,
    subjectId,
    profileId,
    accountId: profile.account_id,
    accountChannel: account.channel,
    protocol: account.protocol,
    dialect: account.dialect,
    providerId: account.models_dev_provider_id,
    modelId,
    selector: structuredClone(profile.selector),
    registrySnapshotHash,
    modelMetadataHash,
    modelCatalogSchemaVersion: catalog.schemaVersion,
    modelCatalogHash: catalog.hash,
    promptVersion: "test-v1",
    requestedInference: structuredClone(profile.inference),
    resolvedInference: {
      thinking: null,
      effort: null,
      reasoningBudgetTokens: null,
      reasoningSummary: null,
      textVerbosity: null,
      temperature: null,
      topP: null,
    },
    structuredOutputMode: "deterministic-test",
    invocations: [{
      id: identity.modelInvocationId,
      ordinal: 1,
      requestHash: contentHash({ role, subjectId, revision, request: true }),
      responseHash: contentHash({ role, subjectId, revision, response: true }),
      requestUtf8Bytes: 1,
      responseUtf8Bytes: 1,
      context: {
        utf8Bytes: 1,
        sections: {},
        counts: { history: 0, events: 0, agents: 0, entities: 0, facts: 0, beliefs: 0, evidence: 0, observations: 0 },
      },
      transports: [{
        attempt: 1,
        queueWaitMs: 0,
        executionMs: 0,
        retryDelayMs: 0,
        status: "succeeded",
        errorName: null,
        statusCode: null,
      }],
      tokenUsage: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
      finishReason: "stop",
      providerRequestId: null,
      resultKind: "test-fixture",
      outputDisposition: "accepted",
      issues: [],
      normalization: {
        applied: false,
        modifiedFieldCount: 0,
        resolvedReferenceCount: 0,
        proposalCount: 0,
        deduplicatedCount: 0,
        symbolRepairCount: 0,
        symbolRepairAcceptedCount: 0,
        symbolRepairAmbiguousCount: 0,
        symbolRepairUnmatchedCount: 0,
        symbolRepairPostValidationRejectedCount: 0,
      },
      symbolRepairs: [],
      referenceCatalogVersion: 2,
      referenceCatalogHash: contentHash({}),
      rawOutputHash: contentHash({ role, subjectId, revision, response: true }),
      normalizedOutputHash: contentHash({ role, subjectId, revision, response: true }),
    }],
  };
}

export type ScriptedModelHandlerRequest = Omit<StructuredModelRequest<unknown>, "schema"> & {
  prompt: string;
};

export type ScriptedModelHandler = (
  request: ScriptedModelHandlerRequest,
) => unknown | Promise<unknown>;

/* Test fixtures may still destructure a section directly while they migrate
 * to the envelope. This projection exists only inside the scripted provider;
 * captured requests and production providers always retain the canonical
 * contract shape. */
function fixtureHandlerRequest(request: ScriptedModelHandlerRequest): ScriptedModelHandlerRequest {
  const context = request.context;
  if (!context || typeof context !== "object" || Array.isArray(context)) return request;
  const envelope = context as Record<string, unknown>;
  const state = envelope.state && typeof envelope.state === "object" && !Array.isArray(envelope.state)
    ? envelope.state as Record<string, unknown>
    : {};
  const task = envelope.task && typeof envelope.task === "object" && !Array.isArray(envelope.task)
    ? envelope.task as Record<string, unknown>
    : {};
  return { ...request, context: { ...envelope, ...state, ...task } };
}

function automaticPlanDirective(context: unknown): unknown {
  const input = context as {
    task?: { assignment?: { targetHandles?: string[] } };
    state?: { actionSet?: { assigned?: Array<{ actionRef: string; actorRef: string; goal: string }> }; actors?: Array<{ agentRef: string; entityRef: string }>; world?: { disclosure?: { defaultCheckVisibility?: "full" | "result_only" | "hidden" } } };
  };
  const actorEntity = new Map((input.state?.actors ?? []).map((actor) => [actor.agentRef, actor.entityRef]));
  return {
    kind: "commit_plans",
    plans: (input.state?.actionSet?.assigned ?? []).map((action, index) => {
      const actorEntityRef = actorEntity.get(action.actorRef);
      if (!actorEntityRef) throw new Error(`deterministic plan has no actor entity for ${action.actorRef}`);
      return {
        proposalKey: `plan-${index}`,
        actionRef: action.actionRef,
        targetRefs: [actorEntityRef],
        means: [],
        mode: "automatic",
        difficulty: null,
        actorRatingRef: null,
        factors: [],
        risk: "safe",
        baseEffect: "none",
        primaryEffect: null,
        secondaryEffect: null,
        threatenedEffect: null,
        visibility: input.state?.world?.disclosure?.defaultCheckVisibility ?? "full",
        causes: [{ kind: "action", ref: action.actionRef }],
      };
    }),
  };
}

function referenceSeed(reference: string, kind: string): string {
  return reference.replace(new RegExp(`^ref:${kind}:`, "u"), "");
}

function assignedModelActions(context: unknown): Array<{
  id: string;
  actorId: string;
  actionRef: string;
  actorRef: string;
  rawText: string;
  goal: string;
  means: string | null;
  targetIds: string[];
}> {
  const input = context as {
    state?: { actionSet?: { assigned?: Array<{ actionRef: string; actorRef: string; rawText: string; goal: string; means: string | null; targetRefs: string[] }> } };
  };
  return (input.state?.actionSet?.assigned ?? []).map((action) => ({
    id: referenceSeed(action.actionRef, "action"),
    actorId: referenceSeed(action.actorRef, "agent"),
    actionRef: action.actionRef,
    actorRef: action.actorRef,
    rawText: action.rawText,
    goal: action.goal,
    means: action.means,
    targetIds: action.targetRefs.map((target) => referenceSeed(target, "local_entity")),
  }));
}

/** Existing unit fixtures intentionally describe the internal plan shape. The
 * scripted provider is a test boundary, so normalize those fixtures into the
 * model-facing reference protocol before strict schema parsing. Production
 * providers never receive this adapter. */
/* eslint-disable @typescript-eslint/no-explicit-any -- legacy fixture adapter is isolated to tests. */
export function adaptScriptedResolutionOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const value = raw as { kind?: string; plans?: unknown[] };
  if (value.kind !== "commit_plans" || !Array.isArray(value.plans)) return raw;
  const ref = (kind: string, id: unknown): unknown =>
    typeof id === "string"
      ? id.startsWith("ref:") ? id : referenceHandleFor(kind as "action", id)
      : id;
  const source = (item: any): any => ({ kind: item.kind, ref: ref(item.kind, item.id) });
  const effect = (item: any, includeMagnitude = true): any => item === null ? null : item.kind === "meter" ? {
    kind: item.kind,
    proposalKey: item.proposalKey ?? item.id,
    targetRef: item.targetRef ?? ref("entity", item.targetId),
    channel: item.channel,
    label: item.label,
    description: item.description,
    sourceRefs: (item.sourceRefs ?? []).map(source),
    meterRef: item.meterRef ?? ref("meter", item.meterId),
    impactProfileRef: item.impactProfileRef ?? ref("mechanic", item.impactProfileId),
    ...(includeMagnitude ? { magnitude: item.magnitude } : {}),
  } : {
    kind: item.kind,
    proposalKey: item.proposalKey ?? item.id,
    targetRef: item.targetRef ?? ref("entity", item.targetId),
    channel: item.channel,
    label: item.label,
    description: item.description,
    sourceRefs: (item.sourceRefs ?? []).map(source),
    // A condition is derived from the effect proposal.  Reusing the effect's
    // key keeps the fixture in the same-object proposal namespace instead of
    // inventing an undeclared second condition record.
    conditionRef: item.conditionRef ?? { proposalKey: item.proposalKey ?? item.id },
    durationProfileRef: item.durationProfileRef ?? ref("mechanic", item.durationProfileId),
    conditionProfileRef: item.conditionProfileRef === null ? null : item.conditionProfileRef ?? ref("mechanic", item.conditionProfileId),
    access: item.access,
    ...(includeMagnitude ? { magnitude: item.magnitude } : {}),
  };
  const plan = (item: any): any => ({
    ...(Object.hasOwn(item, "additionalRandomness") ? { additionalRandomness: item.additionalRandomness } : {}),
    proposalKey: item.proposalKey ?? item.id,
    actionRef: item.actionRef ?? ref("action", item.actionId),
    targetRefs: item.targetRefs ?? (item.targetIds ?? []).map((id: string) => ref("entity", id)),
    means: (item.means ?? []).map((mean: any) => ({ ...mean, source: mean.source?.ref ? mean.source : source(mean.source) })),
    mode: item.mode,
    difficulty: item.difficulty === null ? null : item.difficulty ? item.difficulty.kind === "opposed"
      ? { kind: "opposed", targetRef: item.difficulty.targetRef ?? ref("entity", item.difficulty.targetId), ratingRef: item.difficulty.ratingRef ?? ref("rating", item.difficulty.ratingId), source: item.difficulty.source?.ref ? item.difficulty.source : source(item.difficulty.source) }
      : { kind: "environment", band: item.difficulty.band, source: item.difficulty.source?.ref ? item.difficulty.source : source(item.difficulty.source) }
      : null,
    actorRatingRef: item.actorRatingRef !== undefined
      ? item.actorRatingRef
      : item.actorRatingId == null ? null : ref("rating", item.actorRatingId),
    factors: (item.factors ?? []).map((factor: any) => ({ ...factor, source: factor.source?.ref ? factor.source : source(factor.source) })),
    risk: item.risk,
    baseEffect: item.baseEffect,
    primaryEffect: effect(item.primaryEffect),
    secondaryEffect: effect(item.secondaryEffect),
    threatenedEffect: effect(item.threatenedEffect, false),
    visibility: item.visibility,
    causes: (item.causes ?? []).map((cause: any) => ({ kind: cause.kind, ref: cause.ref ?? ref(cause.kind, cause.id) })),
  });
  return { ...value, plans: value.plans.map(plan) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* Unit fixtures may still use the persisted transition vocabulary. This
 * adapter is intentionally confined to ScriptedModelProvider; production
 * model providers are parsed directly against the semantic protocol. */
/* eslint-disable @typescript-eslint/no-explicit-any -- isolated fixture adapter. */
function adaptScriptedTransitionOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  if ("slots" in raw && Array.isArray(raw.slots)) {
    return {
      ...raw,
      slots: raw.slots.map((slot: any) => ({ ...slot, result: adaptScriptedTransitionOutput(slot.result) })),
    };
  }
  if ((raw as { kind?: string }).kind === "transition" && "proposal" in raw) {
    return adaptScriptedTransitionOutput((raw as { proposal: unknown }).proposal);
  }
  if ("invocation" in raw && raw.invocation && typeof raw.invocation === "object") {
    const adapted = adaptScriptedTransitionOutput({ mechanicInvocations: [raw.invocation] }) as { mechanicInvocations: unknown[] };
    return { invocation: adapted.mechanicInvocations[0] };
  }
  const value = raw as { outcomes?: any[]; mechanicInvocations?: any[]; operations?: any[]; events?: any[]; decisionRequests?: any[] };
  const createdEntityIds = new Set((value.operations ?? [])
    .filter((item) => item?.kind === "create_entity" && typeof item.entity?.id === "string")
    .map((item) => item.entity.id as string));
  const ref = (kind: string, id: unknown): unknown =>
    typeof id === "string"
      ? id.startsWith("ref:") ? id : referenceHandleFor(kind as "action", id)
      : id;
  const causal = (item: any): any => ({ kind: item.kind, ref: item.ref ?? ref(item.kind, item.id) });
  const assertion = (item: any): any => {
    switch (item.kind) {
      case "check_result": return { kind: item.kind, checkRef: ref("check", item.checkId), expected: item.expected };
      case "random_result": return { kind: item.kind, requestRef: ref("random", item.requestId), stepRef: ref("random", item.stepId), expected: item.expected };
      case "fact_matches": return { kind: item.kind, factRef: ref("fact", item.factId), expected: item.expected?.kind === "entity" ? { kind: "entity", entityRef: ref("entity", item.expected.entityId) } : item.expected };
      case "fact_absent": return { kind: item.kind, factRef: ref("fact", item.factId) };
      case "entity_absent": return { kind: item.kind, entityRef: { proposalKey: item.entityId } };
      case "entity_lifecycle": return { kind: item.kind, entityRef: createdEntityIds.has(item.entityId) ? { proposalKey: item.entityId } : ref("entity", item.entityId), expected: item.expected };
      case "placement_equals":
      case "placement_not_equals": return { kind: item.kind, entityRef: ref("entity", item.entityId), placementRef: item.placementId === null ? null : ref("placement", item.placementId) };
      case "shared_placement": return { kind: item.kind, leftEntityRef: ref("entity", item.leftEntityId), rightEntityRef: ref("entity", item.rightEntityId) };
      case "meter_compare": return { kind: item.kind, meterRef: ref("meter", item.meterId), operator: item.operator, value: item.value };
      case "quantity_compare": return { kind: item.kind, definitionRef: ref("quantity", item.definitionId), holderRef: ref("entity", item.holderId), operator: item.operator, value: item.value };
      case "rating_compare": return { kind: item.kind, ratingRef: ref("rating", item.ratingId), operator: item.operator, value: item.value };
      case "shared_resource_capacity_compare": return { kind: item.kind, poolRef: ref("shared_resource_pool", item.poolId), operator: item.operator, value: item.value };
      default: return item;
    }
  };
  const operation = (item: any): any => {
    const common = { causes: (item.causes ?? []).map(causal), assertions: (item.assertions ?? []).map(assertion) };
    switch (item.kind) {
      case "create_entity": return { kind: item.kind, entity: { proposalKey: item.entity.id, kind: item.entity.kind, name: item.entity.name, description: item.entity.description }, placementRef: item.placementId === null ? null : ref("placement", item.placementId), ...common };
      case "retire_entity": return { kind: item.kind, entityRef: ref("entity", item.entityId), ...common };
      case "place_entity": return { kind: item.kind, entityRef: ref("entity", item.entityId), placementRef: item.placementId === null ? null : ref("placement", item.placementId), ...common };
      case "set_fact": return { kind: item.kind, fact: { proposalKey: item.fact.id, subjectRef: ref("entity", item.fact.subjectId), predicate: item.fact.predicate, value: item.fact.value?.kind === "entity" ? { kind: "entity", entityRef: ref("entity", item.fact.value.entityId) } : item.fact.value, description: item.fact.description, access: item.fact.access }, ...common };
      case "create_agent": {
        const agent = item.agent ?? {};
        const reference = (kind: string, id: unknown): unknown =>
          typeof id === "string" ? (id.startsWith("ref:") ? id : referenceHandleFor(kind as "action", id)) : id;
        const evidenceRefs = (ids: unknown): unknown[] =>
          Array.isArray(ids) ? ids.map((id) => reference("evidence", id)) : [];
        const records = (value: unknown): any[] => {
          if (Array.isArray(value)) return value;
          if (!value || typeof value !== "object") return [];
          return Object.entries(value as Record<string, unknown>).map(([id, record]) => ({
            ...(record && typeof record === "object" ? record : {}),
            id,
          }));
        };
        const character = agent.character ?? {};
        const persona = character.persona ?? {};
        const facets = (value: unknown, defaults: Record<string, unknown>) => records(value).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          description: record.description ?? "未命名特征",
          strength: record.strength ?? 0,
          status: record.status ?? defaults.status,
          evidenceRefs: record.evidenceRefs ?? evidenceRefs(record.evidenceIds),
        }));
        const emotions = records(character.emotions).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          description: record.description ?? "未命名情绪",
          intensity: record.intensity ?? 0,
          status: record.status ?? "active",
          evidenceRefs: record.evidenceRefs ?? evidenceRefs(record.evidenceIds),
        }));
        const attitudes = records(character.attitudes).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          subjectRef: record.subjectRef ?? { proposalKey: record.subjectId ?? "self" },
          description: record.description ?? "未命名态度",
          intensity: record.intensity ?? 0,
          status: record.status ?? "active",
          evidenceRefs: record.evidenceRefs ?? evidenceRefs(record.evidenceIds),
        }));
        const goals = records(character.goals).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          description: record.description ?? "未命名目标",
          priority: record.priority ?? 0,
          progress: record.progress ?? 0,
          targetRefs: record.targetRefs ?? (record.targetIds ?? []).map((id: unknown) => ({ proposalKey: id })),
          parentGoalRef: record.parentGoalRef ?? (record.parentGoalId ? { proposalKey: record.parentGoalId } : null),
          motivatedByRefs: record.motivatedByRefs ?? (record.motivatedByIds ?? []).map((id: unknown) => ({ proposalKey: id })),
          status: record.status ?? "active",
          evidenceRefs: record.evidenceRefs ?? evidenceRefs(record.evidenceIds),
        }));
        const commitments = records(character.commitments).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          description: record.description ?? "未命名承诺",
          priority: record.priority ?? 0,
          subjectRefs: record.subjectRefs ?? (record.subjectIds ?? []).map((id: unknown) => ({ proposalKey: id })),
          status: record.status ?? "active",
          evidenceRefs: record.evidenceRefs ?? evidenceRefs(record.evidenceIds),
        }));
        const belief = agent.belief ?? {};
        const localEntities = records(belief.localEntities).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          name: record.name ?? record.id ?? "未命名实体",
          description: record.description ?? "",
          status: record.status ?? "observed",
        }));
        const claims = records(belief.claims).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          subjectRef: record.subjectRef ?? { proposalKey: record.subjectId ?? "self" },
          predicate: record.predicate ?? "unknown",
          value: record.value?.kind === "local_entity"
            ? { kind: "local_entity", entityRef: record.value.entityRef ?? { proposalKey: record.value.localEntityId } }
            : record.value ?? { kind: "none" },
          description: record.description ?? "",
          stance: record.stance ?? "believed",
          confidence: record.confidence ?? 0,
          evidenceRefs: record.evidenceRefs ?? evidenceRefs(record.evidenceIds),
        }));
        const evidence = records(belief.evidence).map((record: any) => ({
          proposalKey: record.proposalKey ?? record.id,
          kind: record.kind ?? "observation",
          description: record.description ?? "",
          sourceRef: record.sourceRef ?? (record.sourceId ? reference("event", record.sourceId) : null),
        }));
        const bindings = records(agent.bindings).map((record: any) => ({
          localEntityRef: record.localEntityRef ?? { proposalKey: record.localEntityId ?? record.id },
          canonicalEntityRefs: record.canonicalEntityRefs ?? (record.canonicalEntityIds ?? []).map((id: unknown) => ({ proposalKey: id })),
        }));
        return {
          kind: item.kind,
          agent: {
            proposalKey: agent.proposalKey ?? agent.id,
            entityRef: agent.entityRef ?? { proposalKey: agent.entityId },
            character: {
              persona: { summary: persona.summary ?? "", voice: persona.voice ?? "", evidenceRefs: persona.evidenceRefs ?? evidenceRefs(persona.evidenceIds) },
              traits: facets(character.traits, { status: "active" }),
              values: facets(character.values, { status: "active" }),
              emotions,
              attitudes,
              goals,
              commitments,
            },
            belief: { localEntities, claims, evidence },
            bindings,
          },
          ...common,
        };
      }
      case "remove_fact": return { kind: item.kind, factRef: ref("fact", item.factId), ...common };
      case "remove_agent": return { kind: item.kind, agentRef: ref("agent", item.agentId), ...common };
      default: return item;
    }
  };
  return {
    outcomes: (value.outcomes ?? []).map((item) => ({ proposalKey: item.proposalKey ?? item.id ?? item.proposalId, actionRef: item.actionRef ?? ref("action", item.proposalId), status: item.status, summary: item.summary, causes: (item.causes ?? item.causeRefs ?? []).map(causal), assertions: (item.assertions ?? []).map(assertion) })),
    mechanicInvocations: (value.mechanicInvocations ?? []).map((item) => ({
      proposalKey: item.proposalKey ?? item.id,
      mechanicRef: item.mechanicRef ?? (
        item.packageId && item.ruleId
          ? referenceHandleFor("mechanic", `${item.packageId}::${item.ruleId}`)
          : undefined),
      input: item.input,
      causes: (item.causes ?? []).map(causal),
      assertions: (item.assertions ?? []).map(assertion),
    })),
    operations: (value.operations ?? []).map(operation),
    events: (value.events ?? []).map((item) => ({ proposalKey: item.proposalKey ?? item.id, description: item.description, impact: item.impact, causes: (item.causes ?? []).map(causal), assertions: (item.assertions ?? []).map(assertion) })),
    decisionRequests: (value.decisionRequests ?? []).map((item) => ({ agentRef: item.agentRef ?? ref("agent", item.agentId), prompt: item.prompt, possibleNextActions: item.possibleNextActions ?? [] })),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* Normalize legacy verifier fixtures at the test provider boundary. */
/* eslint-disable @typescript-eslint/no-explicit-any -- isolated fixture adapter. */
function adaptScriptedVerifierOutput(raw: unknown, includeEvidenceHandles = false): unknown {
  if (!raw || typeof raw !== "object") return raw;
  if ("slots" in raw && Array.isArray(raw.slots)) {
    return {
      ...raw,
      slots: raw.slots.map((slot: any) => ({ ...slot, result: adaptScriptedVerifierOutput(slot.result, includeEvidenceHandles) })),
    };
  }
  const value = raw as { verdict?: string; findings?: any[] };
  if (!Array.isArray(value.findings)) return raw;
  return {
    ...value,
    findings: value.findings.map((finding) => {
      const { planId: legacyPlanId, target: legacyTarget, ...rest } = finding;
      const target = legacyTarget && typeof legacyTarget === "object"
        ? (() => {
          const { id: legacyTargetId, ref: legacyTargetRef, targetHandle, ...targetRest } = legacyTarget;
          return legacyTargetId !== undefined
            ? { ...targetRest, targetHandle: refForVerifier(legacyTarget.kind, legacyTargetId) }
            : { ...targetRest, targetHandle: targetHandle ?? legacyTargetRef };
        })()
        : legacyTarget;
      return {
        ...rest,
        ...(legacyPlanId !== undefined ? { planRef: refForVerifier("plan", legacyPlanId) } : {}),
        ...(target !== undefined ? { target } : {}),
        ...(includeEvidenceHandles ? {
          evidenceHandles: Array.isArray((finding as { evidenceHandles?: unknown }).evidenceHandles)
            ? (finding as { evidenceHandles: unknown[] }).evidenceHandles
            : [],
        } : {}),
      };
    }),
  };
}

/* Action compilation fixtures predate model-owned causal handles. Keep the
 * compatibility shim in the scripted provider only; production providers are
 * parsed directly against the semantic temporal-plan schema. */
/* eslint-disable @typescript-eslint/no-explicit-any -- isolated fixture adapter. */
function adaptScriptedCompilationOutput(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  if ("slots" in raw && Array.isArray(raw.slots)) {
    return {
      ...raw,
      slots: raw.slots.map((slot: any) => {
        const temporalPlan = slot.temporalPlan && typeof slot.temporalPlan === "object"
          ? {
            ...slot.temporalPlan,
            causes: Array.isArray(slot.temporalPlan.causes)
              ? slot.temporalPlan.causes.map((cause: any) => {
                const { id: _legacyId, ...rest } = cause;
                return {
                  kind: rest.kind,
                  ref: rest.ref ?? (typeof _legacyId === "string"
                    ? (_legacyId.startsWith("ref:") ? _legacyId : referenceHandleFor(rest.kind, _legacyId))
                    : rest.ref),
                };
              })
              : slot.temporalPlan.causes,
          }
          : slot.temporalPlan;
        return { ...slot, temporalPlan };
      }),
    };
  }
  return raw;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
function refForVerifier(kind: string, id: unknown): unknown {
  return typeof id === "string"
    ? id.startsWith("ref:") ? id : referenceHandleFor(kind as "action", id)
    : id;
}

export class ScriptedModelProvider implements StructuredModelProvider {
  readonly requests: ScriptedModelHandlerRequest[] = [];
  private pendingTransition: unknown;
  private pendingResolution: unknown;
  private pendingRouting: unknown;

  constructor(
    private readonly handler: ScriptedModelHandler,
    readonly catalog: ModelCatalog = createTestModelCatalog(),
    private readonly adaptTruthScenario = true,
    private readonly captureRequests = true,
  ) {}

  availableProfileSummaries(role?: Parameters<ModelCatalog["profileSummaries"]>[0]) {
    return this.catalog.profileSummaries(role);
  }

  async assertProfilesAvailable(profileIds: readonly string[]): Promise<void> {
    for (const profileId of profileIds) this.catalog.profile(profileId);
  }

  private async handlerValue(request: ScriptedModelHandlerRequest): Promise<unknown> {
    const batchContext = request.context as {
      contractVersion?: number;
      roleContract?: unknown;
      execution?: unknown;
      slots?: Array<{ slot: number; agentState?: Record<string, unknown>; task?: unknown; referenceCatalog?: unknown }>;
      task?: { slots?: Array<{ slot: number; assignment: unknown; constraints: readonly string[] }> };
      state?: { slots?: Array<{ slot: number; state: Record<string, unknown> }> };
      referenceCatalogs?: Array<{ slot: number; catalog: unknown }>;
    };
    const isAgentMindBatch = Array.isArray(batchContext?.slots) &&
      batchContext.slots.length > 0 && batchContext.slots.every((slot) =>
        slot.agentState !== undefined && slot.task !== undefined && slot.referenceCatalog !== undefined);
    const isGenericBatch = Boolean(batchContext?.state?.slots && batchContext.task?.slots);
    if ((request.schemaName.endsWith("_batch") || request.schemaName.endsWith("_batch_output")) &&
      (isAgentMindBatch || isGenericBatch)) {
      if (this.adaptTruthScenario && request.role === "causal-verifier" && batchContext.state?.slots) {
        return {
          slots: batchContext.state.slots.map((slot) => ({
            slot: slot.slot,
            result: { verdict: "accept", findings: [] },
          })),
        };
      }
      // Scripted fixtures receive the physical batch exactly once. Helpers
      // such as deterministicAgentMindBatch can then inspect every isolated
      // slot, while production providers never see this test-only adapter.
      return this.handler(fixtureHandlerRequest(request));
    }
    if (!this.adaptTruthScenario || !request.role.startsWith("truth-") && request.role !== "causal-verifier") {
      return this.handler(fixtureHandlerRequest(request));
    }
    if (request.role === "causal-verifier") return { verdict: "accept", findings: [] };
    if (request.role === "truth-transition" && this.pendingTransition !== undefined) {
      const value = this.pendingTransition;
      this.pendingTransition = undefined;
      return value;
    }
    if (request.role === "truth-resolution" && this.pendingResolution !== undefined) {
      const context = request.context as { state?: { committedResolutionPlans?: unknown[] } };
      if (!context.state?.committedResolutionPlans?.length) return automaticPlanDirective(request.context);
      const value = this.pendingResolution;
      this.pendingResolution = undefined;
      return value;
    }
    if (request.role === "truth-reaction-routing" && this.pendingRouting !== undefined) {
      const value = this.pendingRouting;
      this.pendingRouting = undefined;
      return value;
    }
    if (request.role === "truth-reaction-routing" &&
      (this.pendingResolution !== undefined || this.pendingTransition !== undefined)) {
      return { requests: [] };
    }
    if (request.role === "truth-resolution" && this.pendingTransition !== undefined) {
      const context = request.context as { state?: { committedResolutionPlans?: unknown[] } };
      return context.state?.committedResolutionPlans?.length ? { kind: "done" } : automaticPlanDirective(request.context);
    }

    const value = await this.handler(fixtureHandlerRequest(request)) as {
      kind?: string;
      requests?: Array<{ phase?: string }>;
      proposal?: unknown;
    };
    if (request.role === "truth-perception") {
      if (value.kind === "request_checks") return value;
      if (value.kind === "request_random") this.pendingResolution = value;
      if (value.kind === "request_reactions") this.pendingRouting = { requests: value.requests ?? [] };
      if (value.kind === "transition") this.pendingTransition = value.proposal;
      return { kind: "done" };
    }
    if (request.role === "truth-reaction-routing") {
      if (value.kind === "request_reactions") return { requests: value.requests ?? [] };
      if (value.kind === "request_checks" || value.kind === "request_random") this.pendingResolution = value;
      if (value.kind === "transition") this.pendingTransition = value.proposal;
      return { requests: [] };
    }
    if (request.role === "truth-resolution") {
      if (value.kind === "request_checks" || value.kind === "request_random") return value;
      if (value.kind === "commit_plans") return value;
      if (value.kind === "transition") {
        this.pendingTransition = value.proposal;
        const context = request.context as { state?: { committedResolutionPlans?: unknown[] } };
        return context.state?.committedResolutionPlans?.length ? { kind: "done" } : automaticPlanDirective(request.context);
      }
      return { kind: "done" };
    }
    if (value.kind === "transition") return value.proposal;
    return value;
  }

  async generateStructured<T>(request: StructuredModelRequest<T>): Promise<StructuredModelResult<T>> {
    this.catalog.assertProfile(request.profileId, request.role);
    const profile = this.catalog.profile(request.profileId);
    const account = this.catalog.account(profile.account_id);
    const modelId = profile.selector.kind === "exact"
      ? profile.selector.model_id
      : `scripted:${request.profileId}`;
    const context = canonicalize(request.context);
    const promptBytes = structuredPromptBytes({
      system: request.system,
      userPrompt: request.userPrompt,
      jsonObjectPostlude: request.jsonObjectPostlude,
      context,
      schema: request.schema,
      wireJsonSchema: request.wireJsonSchema,
    });
    if (promptBytes.requestUtf8Bytes > profile.max_input_bytes) {
      throw new ContextLimitExceededError(
        `model profile ${request.profileId} request is ${promptBytes.requestUtf8Bytes} bytes; ` +
        `maximum is ${profile.max_input_bytes} bytes`,
      );
    }
    const captured: ScriptedModelHandlerRequest = {
      profileId: request.profileId,
      workloadId: request.workloadId,
      batchId: request.batchId,
      role: request.role,
      subjectId: request.subjectId,
      promptVersion: request.promptVersion,
      schemaName: request.schemaName,
      system: request.system,
      userPrompt: request.userPrompt,
      context,
      prompt: promptBytes.userMessage,
      abortSignal: request.abortSignal,
      correlation: request.correlation,
      observer: request.observer,
      modelRegistrySnapshotHash: request.modelRegistrySnapshotHash,
      modelInvocationId: request.modelInvocationId,
      modelInvocation: request.modelInvocation,
    };
    if (this.captureRequests) this.requests.push(captured);
    if (request.abortSignal?.aborted) {
      const error = new Error("model request aborted");
      error.name = "AbortError";
      throw error;
    }
    const raw = await this.handlerValue(captured);
    const modelInvocation = request.modelInvocation ?? 1;
    const modelInvocationId = request.modelInvocationId ?? modelInvocationIdentity(
      request,
      request.role,
      request.subjectId,
      modelInvocation,
    ).modelInvocationId;
    const contextJson = promptBytes.contextJson;
    const requestDocument = { system: request.system, userPrompt: request.userPrompt, context,
      ...(request.jsonObjectPostlude !== undefined ? { jsonObjectPostlude: request.jsonObjectPostlude } : {}) };
    const responseJson = JSON.stringify(canonicalize(raw));
    const audit: StructuredModelResult<T>["audit"] = {
      role: request.role,
      subjectId: request.subjectId,
      profileId: request.profileId,
      accountId: profile.account_id,
      accountChannel: account.channel,
      protocol: account.protocol,
      dialect: account.dialect,
      providerId: account.models_dev_provider_id,
      modelId,
      selector: structuredClone(profile.selector),
      registrySnapshotHash: request.modelRegistrySnapshotHash ?? contentHash({ testRegistry: this.catalog.hash }),
      modelMetadataHash: contentHash({ modelId, deterministic: true }),
      modelCatalogSchemaVersion: this.catalog.schemaVersion,
      modelCatalogHash: this.catalog.hash,
      promptVersion: request.promptVersion,
      requestedInference: structuredClone(profile.inference),
      resolvedInference: {
        thinking: null,
        effort: null,
        reasoningBudgetTokens: null,
        reasoningSummary: null,
        textVerbosity: null,
        temperature: null,
        topP: null,
      },
      structuredOutputMode: "deterministic-test",
      invocations: [{
        id: modelInvocationId,
        ordinal: modelInvocation,
        requestHash: contentHash(requestDocument),
        responseHash: contentHash(raw),
        requestUtf8Bytes: promptBytes.requestUtf8Bytes,
        responseUtf8Bytes: Buffer.byteLength(responseJson, "utf8"),
        context: measureModelContext(context, contextJson),
        transports: [{
          attempt: 1,
          queueWaitMs: 0,
          executionMs: 0,
          retryDelayMs: 0,
          status: "succeeded",
          errorName: null,
          statusCode: null,
        }],
        tokenUsage: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
        finishReason: "stop",
        providerRequestId: null,
        resultKind: null,
        outputDisposition: "accepted",
        issues: [],
        normalization: {
          applied: false,
          modifiedFieldCount: 0,
          resolvedReferenceCount: 0,
          proposalCount: 0,
          deduplicatedCount: 0,
          symbolRepairCount: 0,
          symbolRepairAcceptedCount: 0,
          symbolRepairAmbiguousCount: 0,
          symbolRepairUnmatchedCount: 0,
          symbolRepairPostValidationRejectedCount: 0,
        },
        symbolRepairs: [],
        referenceCatalogVersion: (context as {
          referenceCatalog?: { version?: number };
          referenceCatalogs?: Array<{ slot: number; catalog?: { version?: number } }>;
          slots?: Array<{ slot: number; referenceCatalog?: { version?: number } }>;
        }).referenceCatalogs?.[0]?.catalog?.version
          ?? (context as { slots?: Array<{ referenceCatalog?: { version?: number } }> }).slots?.[0]?.referenceCatalog?.version
          ?? (context as { referenceCatalog?: { version?: number } }).referenceCatalog?.version ?? 1,
        referenceCatalogHash: (() => {
          const entry = context as {
            referenceCatalog?: { hash?: string };
            referenceCatalogs?: Array<{ slot: number; catalog?: { hash?: string } }>;
            slots?: Array<{ slot: number; referenceCatalog?: { hash?: string } }>;
          };
          if (entry.referenceCatalogs?.length) {
            return contentHash(entry.referenceCatalogs.map(({ slot, catalog }) => ({ slot, hash: catalog?.hash ?? null })));
          }
          if (entry.slots?.length) {
            return contentHash(entry.slots.map(({ slot, referenceCatalog }) => ({ slot, hash: referenceCatalog?.hash ?? null })));
          }
          return entry.referenceCatalog?.hash ?? contentHash(entry.referenceCatalog ?? null);
        })(),
        rawOutputHash: contentHash(raw),
        normalizedOutputHash: contentHash(raw),
      }],
    };
    const correlation = {
      ...request.correlation,
      ...(request.logicalStage ? {
        logicalStageIndex: request.logicalStage.index,
        logicalStageKey: request.logicalStage.key,
      } : {}),
      modelInvocationId,
      modelRole: request.role,
      modelSubject: request.subjectId,
      modelInvocation,
    };
    request.observer?.emit({
      event: "model.invocation.started",
      correlation,
      attributes: {
        profileId: request.profileId,
        accountId: profile.account_id,
        providerId: account.models_dev_provider_id,
        modelId,
        promptVersion: request.promptVersion,
        schemaName: request.schemaName,
      },
      hashes: { request: audit.invocations[0]!.requestHash },
    });
    let rejectedValue = raw;
    try {
      const normalizedRaw = request.schemaName.startsWith("truth_resolution") && !request.wireJsonSchema
        ? adaptScriptedResolutionOutput(raw)
          : request.schemaName.startsWith("truth_transition")
          ? adaptScriptedTransitionOutput(raw)
          : request.schemaName.startsWith("action_compilation")
            ? adaptScriptedCompilationOutput(raw)
          : request.schemaName.startsWith("resolution_plan_verification") || request.schemaName.startsWith("causal_verification")
            ? adaptScriptedVerifierOutput(raw, request.schemaName.startsWith("causal_verification"))
          : raw;
      const prepared = request.preprocessOutput?.(normalizedRaw) ?? { value: normalizedRaw, symbolRepairs: [] };
      // Match the real adapter: schema rejection carries the expanded value,
      // so batching can validate unaffected slots in their canonical schema.
      rejectedValue = prepared.value;
      const value = request.schema.parse(prepared.value);
      const normalizedResponseHash = contentHash(value);
      const symbolRepairs = [...prepared.symbolRepairs];
      const symbolRepairAcceptedCount = symbolRepairs.filter((repair) =>
        repair.status === "repaired" || repair.status === "normalized").length;
      const symbolRepairAmbiguousCount = symbolRepairs.filter((repair) => repair.status === "ambiguous").length;
      const symbolRepairUnmatchedCount = symbolRepairs.filter((repair) => repair.status === "unmatched").length;
      const symbolRepairPostValidationRejectedCount = symbolRepairs.filter((repair) =>
        repair.status === "postvalidation-rejected").length;
      audit.invocations[0]!.responseHash = normalizedResponseHash;
      audit.invocations[0]!.responseUtf8Bytes = Buffer.byteLength(
        JSON.stringify(canonicalize(value)),
        "utf8",
      );
      audit.invocations[0]!.normalizedOutputHash = normalizedResponseHash;
      audit.invocations[0]!.symbolRepairs = structuredClone(symbolRepairs);
      audit.invocations[0]!.normalization = {
        ...audit.invocations[0]!.normalization,
        applied: audit.invocations[0]!.normalization.applied || symbolRepairAcceptedCount > 0,
        modifiedFieldCount: audit.invocations[0]!.normalization.modifiedFieldCount + symbolRepairAcceptedCount,
        symbolRepairCount: symbolRepairs.length,
        symbolRepairAcceptedCount,
        symbolRepairAmbiguousCount,
        symbolRepairUnmatchedCount,
        symbolRepairPostValidationRejectedCount,
      };
      if (symbolRepairAcceptedCount > 0) audit.invocations[0]!.outputDisposition = "auto-normalized";
      request.observer?.emit({
        event: "model.structured_output.parsed",
        correlation,
        hashes: { request: audit.invocations[0]!.requestHash, response: normalizedResponseHash },
        payload: value,
      });
      request.observer?.emit({ event: "model.audit.persisted", correlation, payload: audit });
      request.observer?.flush?.();
      return { value, audit };
    } catch (error) {
      audit.invocations[0]!.outputDisposition = "rejected";
      audit.invocations[0]!.issues = [{ code: "schema_validation", class: "structure", path: [], message: error instanceof Error ? error.message : String(error) }];
      request.observer?.emit({
        event: "model.structured_output.rejected",
        level: "warn",
        correlation,
        hashes: { request: audit.invocations[0]!.requestHash, response: contentHash(raw) },
        payload: raw,
      });
      request.observer?.emit({ event: "model.audit.persisted", level: "warn", correlation, payload: audit });
      request.observer?.flush?.();
      throw new ModelOutputError("scripted model output failed schema validation", audit, {
        cause: error,
        rawValue: rejectedValue,
      });
    }
  }
}

interface DeterministicCompilationAction {
  id: string;
  actionRef?: string;
  actionCandidateKey?: string;
  actorId: string;
  rawText: string;
}

interface DeterministicCompilationContextAction {
  key?: string;
  id?: string;
  actionRef?: string;
  actorId?: string;
  actorRef?: string;
  rawText: string;
  actionCandidateKey?: string;
}

interface DeterministicCompilationSlot {
  slot: number;
  action: DeterministicCompilationAction;
  temporalEvidence: ActionTemporalEvidence[];
}

interface DeterministicActionReferenceContext {
  actionCandidateKey?: string;
  actor?: {
    agentCandidateKey?: string;
    boundEntityCandidateKey?: string;
  };
}

interface DeterministicBatchSlot {
  slot: number;
  action: DeterministicCompilationContextAction;
  actionReferences?: DeterministicActionReferenceContext;
  temporalEvidence?: ActionTemporalEvidence[];
  temporalProfileEligibility?: Array<{ profileRef?: string; eligible?: boolean }>;
}

export function deterministicInteractionDependency(
  input: {
    reads?: readonly FootprintRef[];
    writes?: readonly FootprintRef[];
    audienceAgentIds?: readonly string[];
    sharedResourceClaims?: Array<{ poolId: string; basis: ActionCompilationDraft["interactionDependency"]["sharedResourceClaims"][number]["basis"] }>;
  },
): ActionCompilationDraft["interactionDependency"] {
  const handle = (ref: FootprintRef): ExistingReferenceHandle => referenceHandleFor(
    ref.kind === "global" ? "world" : ref.kind,
    ref.id,
  );
  return {
    stateDependencies: {
      requiredExistingRefs: (input.reads ?? []).map(handle),
      potentiallyAffectedExistingRefs: (input.writes ?? []).map(handle),
    },
    audienceAgentRefs: (input.audienceAgentIds ?? []).map((id) => referenceHandleFor("agent", id)),
    sharedResourceClaims: (input.sharedResourceClaims ?? []).map((claim) => ({
      resourcePoolRef: referenceHandleFor("shared_resource_pool", claim.poolId),
      basis: structuredClone(claim.basis),
    })),
  };
}

interface DeterministicMindSlot {
  slot: number;
  state: {
    perspective: {
      agentRef: string;
      self: { name: string; location: { name: string } | null };
    };
  };
}

function deterministicActionCompilation(
  action: DeterministicCompilationAction,
  temporalProfiles: readonly { profileRef?: string; id?: string; kind?: string }[],
  eligibleProfileRefs?: ReadonlySet<string>,
): ActionCompilationDraft {
  const eligibleProfiles = eligibleProfileRefs && eligibleProfileRefs.size > 0
    ? temporalProfiles.filter((candidate) => {
        const profileRef = candidate.profileRef ?? (candidate.id ? referenceHandleFor("temporal_profile", candidate.id) : undefined);
        return profileRef !== undefined && eligibleProfileRefs.has(profileRef);
      })
    : temporalProfiles;
  const profile = eligibleProfiles.find((candidate) => candidate.kind !== "conditional") ?? eligibleProfiles[0] ??
    temporalProfiles.find((candidate) => candidate.kind !== "conditional") ?? temporalProfiles[0];
  if (!profile) throw new Error("deterministic action compiler has no temporal profile");
  const profileRef = profile.profileRef ?? (profile.id ? referenceHandleFor("temporal_profile", profile.id) : undefined);
  if (!profileRef) throw new Error("deterministic action compiler has no temporal profile reference");
  const compilation: ActionCompilationDraft = {
    temporalPlan: {
      profileRef: profileRef as ExistingReferenceHandle,
      basis: { kind: "profile" },
      description: action.rawText,
      continuationAssertions: [],
      causes: [{ kind: "action", ref: (action.actionCandidateKey as ExistingReferenceHandle | undefined)
        ?? (action.actionRef as ExistingReferenceHandle | undefined)
        ?? referenceHandleFor("action", action.id) }],
    },
    interactionDependency: {
      // Ordinary deterministic actions are sparse by default. Tests that
      // exercise world-wide semantics must opt in through the explicit global
      // helper below instead of making every fixture a single component.
      stateDependencies: {
        requiredExistingRefs: [],
        potentiallyAffectedExistingRefs: [],
      },
      audienceAgentRefs: [],
      sharedResourceClaims: [],
    },
  };
  return compilation;
}

function actionCompilationCandidateKey(value: string): ActionCompilationCandidateKey {
  return value.startsWith("candidate_") || /^r[0-9]{3,}$/u.test(value)
    ? value as ActionCompilationCandidateKey
    : actionCompilationCandidateKeyForHandle(value);
}

function toActionCompilationModelOutput(compilation: ActionCompilationDraft, actionCandidateKey?: string, actorCandidateKey?: string, actorEntityCandidateKey?: string): Record<string, unknown> {
  const profileRef = compilation.temporalPlan.profileRef;
  const currentActionKey = typeof actionCandidateKey === "string" ? actionCandidateKey : undefined;
  return {
    temporalPlan: {
      basis: structuredClone(compilation.temporalPlan.basis),
      description: compilation.temporalPlan.description,
      profileRef: actionCompilationCandidateKey(String(profileRef)),
      causes: compilation.temporalPlan.causes.map((cause) => ({
        ...cause,
        ref: cause.kind === "action" && currentActionKey
          ? currentActionKey
          : actionCompilationCandidateKey(String(cause.ref)),
      })),
      continuationAssertions: compilation.temporalPlan.continuationAssertions.map((assertion) => {
        const next = structuredClone(assertion) as Record<string, unknown>;
        for (const [key, value] of Object.entries(next)) {
          if (typeof value === "string" && value.startsWith("ref:")) next[key] = actionCompilationCandidateKey(value);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            const nested = value as Record<string, unknown>;
            for (const [nestedKey, nestedValue] of Object.entries(nested)) {
              if (typeof nestedValue === "string" && nestedValue.startsWith("ref:")) nested[nestedKey] = actionCompilationCandidateKey(nestedValue);
            }
          }
        }
        return next;
      }),
    },
    interactionDependency: {
      stateDependencies: {
        requiredExistingCandidateKeys: compilation.interactionDependency.stateDependencies.requiredExistingRefs
          .map((ref) => (String(ref) === "ref:entity:model-agent" || String(ref) === "ref:agent:model-agent" ||
            (actorCandidateKey && actionCompilationCandidateKey(String(ref)) === actorCandidateKey)) && actorEntityCandidateKey
            ? actorEntityCandidateKey as ActionCompilationCandidateKey
            : actionCompilationCandidateKey(String(ref))),
        potentiallyAffectedCandidateKeys: compilation.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs
          .map((ref) => (String(ref) === "ref:entity:model-agent" || String(ref) === "ref:agent:model-agent" ||
            (actorCandidateKey && actionCompilationCandidateKey(String(ref)) === actorCandidateKey)) && actorEntityCandidateKey
            ? actorEntityCandidateKey as ActionCompilationCandidateKey
            : actionCompilationCandidateKey(String(ref))),
      },
      audienceAgentCandidateKeys: compilation.interactionDependency.audienceAgentRefs
        .map((ref) => String(ref) === "ref:agent:model-agent" && actorCandidateKey
          ? actorCandidateKey as ActionCompilationCandidateKey
          : actionCompilationCandidateKey(String(ref))),
      sharedResourceClaims: compilation.interactionDependency.sharedResourceClaims.map((claim) => ({
        resourcePoolCandidateKey: actionCompilationCandidateKey(String(claim.resourcePoolRef)),
        basis: structuredClone(claim.basis),
      })),
    },
  };
}

export function deterministicGlobalActionCompilationBatch(
  profileId: string,
  context: unknown,
  customize?: (
    compilation: ActionCompilationDraft,
    slot: DeterministicCompilationSlot,
    context: unknown,
  ) => void,
): { slots: Array<ActionCompilationDraft & { slot: number }> } {
  return deterministicActionCompilationBatch(profileId, context, (compilation, slot) => {
      const envelope = context as {
      referenceCatalog?: { candidates?: Array<{ kind: string; label?: string; details?: unknown; handle?: string; candidateKey?: string }> };
      referenceCatalogs?: Array<{ slot: number; catalog?: { candidates?: Array<{ kind: string; label?: string; details?: unknown; handle?: string; candidateKey?: string }> } }>;
      sharedContext?: { referenceCatalog?: { candidates?: Array<{ kind: string; label?: string; details?: unknown; handle?: string; candidateKey?: string }> } };
    };
    const candidates = envelope.referenceCatalogs?.find((entry) => entry.slot === slot.slot)?.catalog?.candidates
      ?? envelope.referenceCatalog?.candidates
      ?? envelope.sharedContext?.referenceCatalog?.candidates
      ?? [];
    const worldCandidate = candidates.find((candidate) => candidate.kind === "world");
    const handle = (worldCandidate?.handle ?? worldCandidate?.candidateKey ?? "ref:world:world") as ExistingReferenceHandle;
    compilation.interactionDependency.stateDependencies.requiredExistingRefs = [handle];
    compilation.interactionDependency.stateDependencies.potentiallyAffectedExistingRefs = [handle];
    customize?.(compilation, slot, context);
  });
}

export function deterministicActionCompilationBatch(
  profileId: string,
  context: unknown,
  customize?: (
    compilation: ActionCompilationDraft,
    slot: DeterministicCompilationSlot,
    context: unknown,
  ) => void,
): { slots: Array<ActionCompilationDraft & { slot: number }> } {
  void profileId;
  const input = context as {
    task?: { slots?: Array<{ slot: number; assignment?: unknown; action?: DeterministicCompilationContextAction; actionReferences?: DeterministicActionReferenceContext; temporalEvidence?: ActionTemporalEvidence[] }> };
    referenceCatalog?: { candidates?: Array<{ kind: string; label?: string; details?: unknown; handle?: string; candidateKey?: string }> };
    slots?: DeterministicBatchSlot[];
    state?: { temporalProfiles?: Array<{ profileRef?: string; id?: string; kind?: string }>; slots?: DeterministicBatchSlot[] };
    sharedContext?: { state?: { temporalProfiles?: Array<{ profileRef?: string; id?: string; kind?: string }> } };
  };
  const slots: DeterministicBatchSlot[] | undefined = input.state?.slots ?? input.slots ?? input.task?.slots
    ?.filter((slot): slot is DeterministicBatchSlot => Boolean(slot.action));
  const temporalProfiles = input.state?.temporalProfiles ?? input.sharedContext?.state?.temporalProfiles ??
    input.referenceCatalog?.candidates
      ?.filter((entry) => entry.kind === "temporal_profile")
      .map((entry) => ({
        profileRef: entry.candidateKey ?? entry.handle,
        kind: entry.details && typeof entry.details === "object" && "kind" in entry.details
          ? String((entry.details as { kind?: unknown }).kind)
          : undefined,
      }));
  if (!slots || !temporalProfiles) {
    throw new Error("deterministic action compiler expected a slot batch");
  }
  return {
    slots: slots.map((slot) => {
      const actionReference = slot.action.id ?? slot.action.actionRef ?? slot.action.actionCandidateKey ?? slot.actionReferences?.actionCandidateKey;
      const actorReference = slot.action.actorId ?? slot.action.actorRef;
      const actorKey = slot.actionReferences?.actor?.agentCandidateKey;
      const catalogCandidates = (input.referenceCatalog?.candidates ?? []);
      const actorLabel = typeof actorKey === "string"
        ? catalogCandidates.find((candidate) => candidate.candidateKey === actorKey)?.label
        : undefined;
      const actionId = typeof actionReference === "string"
        ? actionReference.replace(/^ref:action:/u, "")
        : actionReference;
      const actorId = typeof actorReference === "string"
        ? actorReference.replace(/^ref:agent:/u, "")
        : actorLabel ?? actorReference ?? "model-agent";
      if (!actionId) throw new Error("deterministic action compiler requires an action reference");
      const fixtureSlot = {
        ...slot,
        action: {
          ...slot.action,
          id: actionId.startsWith("candidate_") ? "deterministic-action" : actionId,
          actionCandidateKey: actionReference && (actionReference.startsWith("candidate_") || /^r[0-9]{3,}$/u.test(actionReference)) ? actionReference : undefined,
          actorId,
        },
        temporalEvidence: structuredClone("temporalEvidence" in slot ? slot.temporalEvidence ?? [] : []),
      } as DeterministicCompilationSlot;
      const eligibleProfileRefs = new Set((slot.temporalProfileEligibility ?? [])
        .filter((entry) => entry.eligible === true && typeof entry.profileRef === "string")
        .map((entry) => entry.profileRef as string));
      const compilation = deterministicActionCompilation(fixtureSlot.action, temporalProfiles, eligibleProfileRefs.size > 0 ? eligibleProfileRefs : undefined);
      customize?.(compilation, fixtureSlot, context);
      const actionReferences = slot.actionReferences;
      const actorCandidateKey = typeof actionReferences?.actor?.agentCandidateKey === "string"
        ? actionReferences.actor.agentCandidateKey
        : undefined;
      const actorEntityCandidateKey = typeof actionReferences?.actor?.boundEntityCandidateKey === "string"
        ? actionReferences.actor.boundEntityCandidateKey
        : undefined;
      const output = { slot: fixtureSlot.slot, ...toActionCompilationModelOutput(compilation, fixtureSlot.action.actionCandidateKey, actorCandidateKey, actorEntityCandidateKey) } as never;
      return output;
    }),
  };
}

function deterministicAgentMindOutput(): AgentMindDraftOutput {
  return {
    beliefChanges: { operations: [] },
    characterChanges: { operations: [] },
    nextActionIntent: {
      rawText: "维持当前目标并观察世界",
      goal: "继续自主行动",
      means: null,
      targetHandles: [],
    },
  };
}

export function deterministicAgentMindBatch(
  context: unknown,
  customize?: (output: AgentMindDraftOutput, slot: DeterministicMindSlot) => void,
): unknown {
  const input = context as {
    slots?: Array<{ slot: number; agentState?: DeterministicMindSlot["state"]; state?: DeterministicMindSlot["state"] }>;
    state?: { slots?: Array<{ slot: number; state: DeterministicMindSlot["state"] }> };
  };
  const slots = input.slots?.map((entry) => ({
    slot: entry.slot,
    state: entry.agentState ?? entry.state,
  })).filter((entry): entry is DeterministicMindSlot => entry.state !== undefined) ??
    input.state?.slots?.map((entry) => ({ slot: entry.slot, state: entry.state }));
  if (!slots) throw new Error("deterministic AgentMind expected a slot batch");
  return {
    slots: slots.map((slot) => {
      const output = deterministicAgentMindOutput();
      customize?.(output, slot);
      return { slot: slot.slot, ...output };
    }),
  };
}

export function deterministicModelOutput(profileId: string, context: unknown): unknown {
      const sharedBatch = (context as { state?: unknown })?.state;
      if (isSharedBatchContext(sharedBatch)) {
        return { slots: expandSharedBatchContexts(sharedBatch).map((slotContext, slot) => ({
          slot, result: deterministicModelOutput(profileId, slotContext),
        })) };
      }
      const input = context as {
        execution?: { revision?: number; step?: number };
        agent?: { id: string };
        perspective?: {
          agentId: string;
          self: { name: string; location: { name: string } | null };
        };
        action?: { id: string; actorId: string; rawText: string };
        slots?: Array<DeterministicCompilationSlot | DeterministicMindSlot | {
          slot: number;
          agentState?: DeterministicMindSlot["state"];
          task?: unknown;
          referenceCatalog?: unknown;
        }>;
        entity?: { name: string; location: string | null };
        state?: {
          world?: { laws: Array<{ id: string }> };
          actors?: Record<string, unknown> | Array<{ agentRef: string; entityRef: string }>;
          canonicalTruth?: {
            activities?: Record<string, { sourceActionId?: string; sourceActionRef?: string; completionAtSeconds: number | null }>;
          };
          temporalBoundary?: { toElapsedSeconds: number };
          temporalProfiles?: Array<{ profileRef?: string; id?: string; kind: string; selection?: { evidenceRequirement?: string } }>;
          perspective?: { agentId: string; self: { name: string; location: { name: string } | null } };
          preparedAction?: unknown;
          stimulus?: unknown;
          entity?: { name: string; location: string | null };
          committedResolutionPlans?: unknown[];
          currentEvents?: Array<{ eventRef?: string; id?: string }>;
          slots?: Array<{ slot: number; action?: DeterministicCompilationContextAction; state?: DeterministicMindSlot["state"] }>;
          action?: DeterministicCompilationAction;
          actorPerspective?: unknown;
          observationSlots?: unknown[];
        };
        observationSlots?: Array<{ observer: { agentId: string } }>;
        currentEvents?: Array<{ eventRef?: string; id?: string }>;
        committedResolutionPlans?: unknown[];
        temporalProfiles?: Array<{ profileRef?: string; id?: string; kind: string; selection?: { evidenceRequirement?: string } }>;
        temporalBoundary?: { toElapsedSeconds: number };
        referenceCatalog?: { candidates: Array<{ kind: string; handle: string; statePath?: string }> };
        referenceCatalogs?: Array<{ slot: number; catalog: { candidates: Array<{ kind: string; handle: string; statePath?: string }> } }>;
        task?: { kind?: string; action?: DeterministicCompilationAction; stage?: "perception" | "reaction-routing" | "resolution" | "transition"; assignedActions?: unknown[]; committedResolutionPlans?: unknown[]; observationSlots?: unknown[]; slots?: Array<DeterministicCompilationSlot | DeterministicMindSlot> };
      };
      const directAgentMindSlots = input.slots?.filter((slot): slot is {
        slot: number;
        agentState: DeterministicMindSlot["state"];
        task?: unknown;
        referenceCatalog?: unknown;
      } => "agentState" in slot && slot.agentState !== undefined);
      if (directAgentMindSlots && directAgentMindSlots.length > 0 && directAgentMindSlots.length === input.slots?.length) {
        return deterministicAgentMindBatch({
          slots: directAgentMindSlots.map((slot) => ({ slot: slot.slot, agentState: slot.agentState })),
        });
      }
      const stateSection = input.state ?? {};
      const isPhysicalBatch = Array.isArray(input.state?.slots) &&
        input.state.slots.every((entry) => "state" in entry) && Boolean(input.task?.slots);
      if (isPhysicalBatch && input.state?.slots && input.task?.slots) {
        const batchSlots = [...input.state.slots].sort((left, right) => left.slot - right.slot) as Array<{ slot: number; state: Record<string, unknown> }>;
        const results = batchSlots.map((entry) => {
          const taskSlot = input.task?.slots?.find((slot) => slot.slot === entry.slot);
          const catalogSlot = input.referenceCatalogs?.find((slot) => slot.slot === entry.slot);
          const slotContext = {
            ...input,
            task: taskSlot,
            state: entry.state,
            referenceCatalog: catalogSlot?.catalog,
            referenceCatalogs: undefined,
          };
          return deterministicModelOutput(profileId, slotContext);
        });
        const isAgentMindBatch = batchSlots.every((entry) => Boolean((entry.state as { perspective?: unknown }).perspective));
        return {
          slots: batchSlots.map((entry, index) => isAgentMindBatch
            ? { slot: entry.slot, ...(results[index] as Record<string, unknown>) }
            : { slot: entry.slot, result: results[index] }),
        };
      }
      const stage = input.task?.stage;
      const baseRevision = input.execution?.revision;
      const step = input.execution?.step;
      const world = stateSection.world;
      const canonicalTruth = stateSection.canonicalTruth;
      const slots = stateSection.slots ?? input.task?.slots ?? input.slots;
      const temporalProfiles = stateSection.temporalProfiles ?? input.temporalProfiles;
      const hasTemporalProfileCandidates = input.referenceCatalog?.candidates
        .some((candidate) => candidate.kind === "temporal_profile") ?? false;
      const actionInput = stateSection.action ?? input.action ?? input.task?.action;
      if (stateSection.perspective && !input.task?.kind && !stateSection.preparedAction && !stateSection.stimulus && !actionInput) {
        return deterministicAgentMindOutput();
      }
      if (slots?.every((slot): slot is DeterministicCompilationSlot => "action" in slot) &&
        (temporalProfiles || hasTemporalProfileCandidates)) {
        return deterministicActionCompilationBatch(profileId, context);
      }
      if (slots?.every((slot): slot is DeterministicMindSlot => "state" in slot &&
        Boolean((slot as DeterministicMindSlot).state?.perspective))) {
        return deterministicAgentMindBatch(context);
      }
      if (actionInput && temporalProfiles) {
        return deterministicActionCompilation(actionInput, temporalProfiles);
      }
      if (actionInput) {
        const worldHandle = (input.referenceCatalog?.candidates as Array<{ kind: string; handle: string; statePath?: string }> | undefined)
          ?.find((candidate) => candidate.kind === "world")?.handle;
        if (!worldHandle) throw new Error("deterministic grounding requires a world reference handle");
        return {
          stateDependencies: {
            requiredExistingRefs: [worldHandle as ExistingReferenceHandle],
            potentiallyAffectedExistingRefs: [worldHandle as ExistingReferenceHandle],
          },
          audienceAgentRefs: [],
          sharedResourceClaims: [],
        };
      }
      if (stateSection.preparedAction && stateSection.stimulus) return { kind: "keep" };
      if (stateSection.perspective && (input.task?.kind === "arrival" || input.execution?.revision === undefined)) {
        return {
          title: `此刻，你是${stateSection.perspective.self.name}`,
          scene: stateSection.perspective.self.location
            ? `你在${stateSection.perspective.self.location.name}恢复了对周围的注意。`
            : "你恢复了对周围的注意，但还不能确定当前位置。",
          possibleNextActions: ["观察四周", "确认当前位置", "寻找可以交谈的人"],
        };
      }
      if (stateSection.entity) {
        return {
          title: `此刻，你是${stateSection.entity.name}`,
          scene: stateSection.entity.location
            ? `你在${stateSection.entity.location}恢复了对周围的注意。`
            : "你恢复了对周围的注意，但还不能确定当前位置。",
          possibleNextActions: ["观察四周", "确认当前位置", "寻找可以交谈的人"],
        };
      }
      const observationSlots = stateSection.observationSlots ?? input.task?.observationSlots;
      if (observationSlots) {
        return {
          summary: "世界继续变化。",
          introductions: [],
          apparentClaims: [],
          sourceEventRefs: (input.currentEvents ?? (stateSection.currentEvents as Array<{ eventRef?: string }> | undefined) ?? [])
            .map((event) => event.eventRef)
            .filter((handle): handle is string => Boolean(handle)),
        };
      }
      if (profileId.startsWith("truth-")) {
        if (stage === "perception") return { kind: "done" };
        if (stage === "reaction-routing") return { requests: [] };
        if (stage === "resolution") {
          return (stateSection.committedResolutionPlans ?? []).length ? { kind: "done" } : automaticPlanDirective(context);
        }
        const revision = baseRevision;
        const lawId = world?.laws?.[0]?.id;
        const lawRef = input.referenceCatalog?.candidates.find((candidate) => candidate.kind === "law")?.handle;
        const actions = assignedModelActions(context);
        if (step === undefined || revision === undefined || !lawId || !lawRef || !actions) {
          throw new Error("deterministic Truth Engine context is incomplete");
        }
        const nextStep = step + 1;
        return {
          kind: "transition",
          proposal: {
            outcomes: actions.map((action, index) => {
              const activity = Object.values(canonicalTruth?.activities ?? {})
                .find((candidate) => candidate.sourceActionId === action.id ||
                  candidate.sourceActionRef === `ref:action:${action.id}`);
              const continuing = Boolean(activity && (activity.completionAtSeconds === null ||
                activity.completionAtSeconds > (stateSection.temporalBoundary?.toElapsedSeconds ?? 0)));
              return {
              proposalKey: `outcome-${index}`,
              actionRef: action.actionRef,
              status: continuing ? "continuing" : "succeeded",
              summary: continuing ? "行动推进到下一个时间检查点。" : "模拟 Truth Engine 已联合裁决行动。",
              causes: [{ kind: "action", ref: action.actionRef }],
              assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
            }; }),
            mechanicInvocations: [],
            operations: [],
            events: [{
              proposalKey: `event-${nextStep}`,
              description: "模拟世界推进了一秒。",
              impact: "ordinary",
              causes: [{ kind: "law", ref: lawRef }],
              assertions: [{ kind: "elapsed_seconds_compare", operator: "gte", value: 0 }],
            }],
            decisionRequests: [],
          },
        };
      }
      const agentId = stateSection.perspective?.agentId;
      const revision = baseRevision;
      if (!agentId || revision === undefined) throw new Error("deterministic AgentMind context is incomplete");
      return deterministicAgentMindOutput();
}

export class DeterministicModelProvider extends ScriptedModelProvider {
  constructor(catalog = createTestModelCatalog(), captureRequests = true) {
    super(
      ({ profileId, context }) => deterministicModelOutput(profileId, context),
      catalog,
      true,
      captureRequests,
    );
  }
}
