import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentActionProposal, TransitionProposal } from "../../contracts/model";
import type { ObservationRenderingInput } from "../../algorithms/roles";
import { ObservationRenderer, normalizeObservationLocalReferences } from "../observation-renderer";
import { ScriptedModelProvider, createTestModelCatalog } from "../../testing/model-provider";
import { loadWorldScript } from "../../../script/world-loader";
import { validateAlgorithmTelemetryEvent, type RuntimeEventInput, type RuntimeObserver } from "../../runtime/observability";
import { createActivity, materializeTemporalPlan } from "../../mechanics/temporal";
import { observationEvidenceProvider } from "../../mechanics/observation-evidence-layout";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../../mechanics/truth-batch-provider";

function pendingInput(): ObservationRenderingInput {
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 4, modelCatalog: createTestModelCatalog(),
  });
  const state = structuredClone(definition.initialState);
  const action: AgentActionProposal = { id: `rt:action:${"0".repeat(64)}`, actorId: "player", baseRevision: state.revision,
    rawText: "与守门人讨论开门；先不付钱，也不要替对方答应。", goal: "协商通行", means: null, targetIds: [] };
  state.truth.mechanics.temporalProfiles.pending = { id: "pending", name: "Pending", kind: "fixed", durationSeconds: 60, checkpointSeconds: 30,
    selection: { semanticTags: ["pending"], evidenceRequirement: "none" }, interruptible: true, reactionFallback: "continue_if_valid", resourceClaims: [] };
  const plan = materializeTemporalPlan({ id: `rt:temporal-plan:${"0".repeat(64)}`, actionId: action.id, actorId: action.actorId,
    rawText: action.rawText, startsAtSeconds: 0,
    draft: { profileId: "pending", basis: { kind: "profile" }, description: action.rawText,
      continuationAssertions: [], causes: [{ kind: "action", id: action.id }] },
    profiles: state.truth.mechanics.temporalProfiles,
  });
  const activity = createActivity({ id: `rt:activity:${"0".repeat(64)}`, plan, sourceAction: action });
  return { definition, state, actions: [action], observerIds: ["player"], identityOwner: "pending-test",
    temporalState: { activities: { [activity.id]: activity }, timers: structuredClone(state.truth.timers) },
    proposal: { baseRevision: state.revision, operations: [{ kind: "advance_time", seconds: 1,
      causes: [{ kind: "action", id: action.id }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 0 }] }],
    events: [], mechanicInvocations: [], observations: [], decisionRequests: [], outcomes: [{ id: `rt:outcome:${"0".repeat(64)}`,
      proposalId: action.id, status: "continuing", summary: "The keeper agreed and the gate opened.",
      causeRefs: [{ kind: "action", id: action.id }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }], knownAlternatives: [] }] },
  };
}

describe("ObservationRenderer", () => {
  it.each(["private", "agents"] as const)("retains event provenance without granting %s fact access", async access => {
    const input = pendingInput();
    input.observerIds = ["player", "keeper"];
    const fact = input.state.truth.facts["key-authenticity"]!;
    fact.access = access === "private" ? { kind: "private" } : { kind: "agents", agentIds: ["keeper"] };
    input.state.truth.facts["unrelated-private-fact"] = { ...structuredClone(fact),
      id: "unrelated-private-fact", access: { kind: "private" } };
    const event = { id: `rt:event:${"1".repeat(64)}`, step: 1, description: "The keeper examines the key.",
      impact: "ordinary" as const, causes: [{ kind: "fact" as const, id: fact.id }],
      assertions: [{ kind: "elapsed_seconds_compare" as const, operator: "eq" as const, value: 1 }] };
    input.proposal.events = [event];
    const before = structuredClone(input);
    const provider = new ScriptedModelProvider(request => {
      const context = request.context as { referenceCatalog: { candidates: Array<{ handle: string }> };
        state: { canonicalTruth: { facts: Record<string, unknown> };
          currentEvents: Array<{ eventRef: string; causes: Array<{ kind: string; ref: string }> }>;
          observationSlots: Array<{ observer: { agentRef: string } }> } };
      const state = context.state;
      const owner = state.observationSlots[0]!.observer.agentRef === "ref:agent:keeper";
      expect(state.currentEvents[0]!.causes).toEqual([{ kind: "fact", ref: "ref:fact:key-authenticity" }]);
      expect(context.referenceCatalog.candidates.some(row => row.handle === "ref:fact:key-authenticity")).toBe(true);
      expect(context.referenceCatalog.candidates.some(row => row.handle === "ref:fact:unrelated-private-fact")).toBe(false);
      expect(Object.hasOwn(state.canonicalTruth.facts, "ref:fact:key-authenticity")).toBe(access === "agents" && owner);
      return { summary: "No new information is confirmed.", introductions: [], apparentClaims: [], sourceEventRefs: [] };
    }, createTestModelCatalog(), false);
    const result = await new ObservationRenderer(provider).render(input, { workloadId: "event-provenance", batchId: access,
      runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } });
    expect(result.packets.map(packet => packet.observerId)).toEqual(["player", "keeper"]);
    expect(provider.requests).toHaveLength(2);
    expect(input).toEqual(before);
  });

  it("rejects a nonexistent event cause before requesting an observation", async () => {
    const input = pendingInput();
    input.proposal.events = [{ id: `rt:event:${"2".repeat(64)}`, step: 1, description: "Unsupported event.",
      impact: "ordinary", causes: [{ kind: "fact", id: "nonexistent-fact" }],
      assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }] }];
    const provider = new ScriptedModelProvider(() => { throw new Error("must not dispatch"); }, createTestModelCatalog(), false);
    await expect(new ObservationRenderer(provider, 0).render(input, { workloadId: "event-provenance", batchId: "missing",
      runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } })).rejects.toThrow("No fact candidate");
    expect(provider.requests).toHaveLength(0);
  });

  it("preserves an explicitly unresolved perception through the loaded-world materializer", async () => {
    const input = pendingInput();
    input.feedbackByObserver = { player: ["Retain the unresolved proposition explicitly."] };
    const provider = new ScriptedModelProvider(request => {
      const context = request.context as { state: { observationSlots: Array<{ observer: { selfEntityRef: string;
        localEntities: Array<{ ref: string; canonicalEntityRefs: string[] }> } }> } };
      const observer = context.state.observationSlots[0]!.observer;
      const subjectRef = observer.localEntities.find(entity => entity.canonicalEntityRefs.includes(observer.selfEntityRef))!.ref;
      return { summary: "还不能确认守门人是否同意。", introductions: [], sourceEventRefs: [],
        apparentClaims: [{ epistemicStatus: "unconfirmed", subjectRef, predicate: "passage-agreed", description: "守门人是否同意放行。" }] };
    }, createTestModelCatalog(), false);
    const renderer = new ObservationRenderer(new TruthBatchCoordinator(observationEvidenceProvider(provider, true), 12, 0,
      "shared-json-v2", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1"), 0, true);
    const before = structuredClone(input);
    const result = await renderer.render(input, { workloadId: "pending-world", batchId: "unconfirmed",
      runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } });
    expect(provider.requests).toHaveLength(1);
    expect(result.packets[0]!.apparentClaims[0]).toMatchObject({ predicate: "passage-agreed",
      value: { kind: "text", value: "尚未确认：守门人是否同意放行。" }, description: "尚未确认：守门人是否同意放行。" });
    expect(input).toEqual(before);
  });

  it("projects only the owner's original pending intent without treating outcome narration as an event", async () => {
    const input = pendingInput();
    const provider = new ScriptedModelProvider(() => ({ summary: "Model observation", introductions: [], apparentClaims: [], sourceEventRefs: [] }), createTestModelCatalog(), false);
    const scope = { workloadId: "pending-world", batchId: "pending-step", runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } };
    const baseline = await new ObservationRenderer(provider).render(input, scope);
    expect(provider.requests).toHaveLength(1);
    const before = structuredClone(input);
    const projected = await new ObservationRenderer(provider, 2, true).render(input, scope);
    expect(provider.requests).toHaveLength(1);
    expect(projected.modelAudits).toEqual([]);
    expect(projected.batchCount).toBe(0);
    expect(projected.packets[0]).toMatchObject({ observerId: "player", apparentClaims: [], introductions: [], sourceEventIds: [] });
    expect(projected.packets[0]!.summary).toContain(JSON.stringify(input.actions[0]!.rawText));
    expect(projected.packets[0]!.summary).not.toContain("The keeper agreed");
    expect(baseline.packets[0]!.summary).toBe("Model observation");
    expect(input).toEqual(before);
  });

  it.each(["due", "owner", "source", "paused", "event", "write", "repair"] as const)("retains model observation for the %s boundary", async kind => {
    const input = pendingInput();
    const activity = structuredClone(Object.values(input.temporalState!.activities)[0]!);
    if (kind === "due" && "plan" in activity) {
      activity.nextBoundaryAtSeconds = 60;
      input.proposal.operations[0] = { ...input.proposal.operations[0]!, kind: "advance_time", seconds: 30 };
      input.proposal.outcomes[0]!.assertions = [{ kind: "elapsed_seconds_compare", operator: "eq", value: 30 }];
    }
    if (kind === "owner") activity.actorId = "keeper";
    if (kind === "source") input.actions[0]!.rawText = "A different intent";
    if (kind === "paused" && "plan" in activity) { activity.status = "paused"; activity.nextBoundaryAtSeconds = null; }
    input.temporalState = { ...input.temporalState!, activities: { [activity.id]: activity } };
    if (kind === "event") input.proposal.events.push({ id: `rt:event:${"0".repeat(64)}`, step: 1, description: "A sound is heard", impact: "ordinary",
      causes: [{ kind: "action", id: input.actions[0]!.id }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }] });
    if (kind === "write") input.proposal.operations.push({ kind: "place_entity", entityId: "key", placementId: "player",
      causes: [{ kind: "action", id: input.actions[0]!.id }], assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 0 }] });
    if (kind === "repair") input.feedbackByObserver = { player: ["An authorized perception is missing"] };
    const provider = new ScriptedModelProvider(() => ({ summary: "A model observation is required.", introductions: [], apparentClaims: [], sourceEventRefs: [] }), createTestModelCatalog(), false);
    const rendered = new ObservationRenderer(provider, 2, true).render(input, { workloadId: "pending-world", batchId: `pending-${kind}`,
      runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } });
    if (kind === "owner") {
      await expect(rendered).rejects.toThrow("invalid activity");
      expect(provider.requests).toHaveLength(0);
      return;
    }
    await rendered;
    expect(provider.requests).toHaveLength(1);
  });

  it("keeps observer coverage, action text and candidate state fixed across an in-flight repair", async () => {
    const catalog = createTestModelCatalog();
    let calls = 0;
    const provider = new ScriptedModelProvider(() => {
      if (calls++ === 0) {
        input.state.truth.elapsedSeconds = 100;
        input.actions[0]!.rawText = "A different action supplied after dispatch";
        input.observerIds = ["player", "keeper"];
        return {};
      }
      return { summary: "The surroundings remain visible.", introductions: [], apparentClaims: [], sourceEventRefs: [] };
    }, catalog, false);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 4, modelCatalog: catalog });
    const state = structuredClone(definition.initialState);
    const input: ObservationRenderingInput = { definition, state, observerIds: ["player"], identityOwner: "fixed-observation",
      actions: [{ id: "fixed-action", actorId: "player", baseRevision: state.revision,
        rawText: "Observe the courtyard", goal: "Look around", means: null, targetIds: [] }],
      proposal: { baseRevision: state.revision, outcomes: [], mechanicInvocations: [], events: [], observations: [], decisionRequests: [],
        operations: [{ kind: "advance_time", seconds: 1, causes: [{ kind: "action", id: "fixed-action" }],
          assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: state.truth.elapsedSeconds }] }] },
    };
    const result = await new ObservationRenderer(provider).render(input, {
      workloadId: "fixed-world", batchId: "fixed-step", runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
    });
    expect(result.packets.map(packet => packet.observerId)).toEqual(["player"]);
    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) expect(request.context).toMatchObject({ state: {
      canonicalTruth: { elapsedSeconds: 1 }, actionSet: { assigned: [{ rawText: "Observe the courtyard" }] },
    } });
  });

  it("reuses an observer's existing local alias for a known canonical Entity", () => {
    const catalog = createTestModelCatalog();
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 4,
      modelCatalog: catalog,
    });
    const normalized = normalizeObservationLocalReferences(definition.initialState, ["player"], [{
      summary: "门锁仍在原处。",
      introductions: [{
        localEntity: { id: "fresh-key-alias", name: "铜钥匙", description: "同一把铜钥匙", status: "observed" },
        canonicalEntityId: "key",
      }],
      apparentClaims: [{
        subjectId: "fresh-key-alias",
        predicate: "存在",
        value: { kind: "text", value: "铜钥匙" },
        description: "门锁存在",
      }],
      sourceEventIds: [],
    }]);
    expect(normalized.drafts[0]?.introductions).toEqual([]);
    expect(normalized.drafts[0]?.apparentClaims[0]?.subjectId).toBe("copper-key");
    expect(normalized.droppedIntroductions).toBe(1);
  });

  it("materializes ordinary progress once despite unrelated private scalars and cognition keys", async () => {
    const input = pendingInput();
    input.state.truth.facts["key-authenticity"]!.value = { kind: "text", value: "in-progress" };
    input.state.agents.keeper!.character.values.preservation = {
      ...structuredClone(Object.values(input.state.agents.keeper!.character.values)[0]!), id: "preservation",
    };
    const before = structuredClone(input);
    const provider = new ScriptedModelProvider(() => ({ summary: "preservation in-progress", introductions: [], sourceEventRefs: [],
      apparentClaims: [{ subjectRef: "ref:local_entity:player::self", predicate: "activity-state",
        value: { kind: "text", value: "in-progress" }, description: "我的行动仍在继续。" }] }), createTestModelCatalog(), false);
    const result = await new ObservationRenderer(provider, 0).render(input, { workloadId: "source-relation", batchId: "progress",
      runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } });
    expect(provider.requests).toHaveLength(1);
    expect(result.packets[0]!.apparentClaims).toMatchObject([{ subjectId: "self", predicate: "activity-state",
      value: { kind: "text", value: "in-progress" } }]);
    expect(input).toEqual(before);
  });

  it("repairs one observer that copies protected canonical truth", async () => {
    let calls = 0;
    const catalog = createTestModelCatalog();
    const provider = new ScriptedModelProvider(() => ({
      summary: calls++ === 0 ? "钥匙是仿制品，无法打开石门。" : "你仍只能依据商人的说法判断这把钥匙。",
      introductions: [],
      apparentClaims: [],
      sourceEventRefs: [],
    }), catalog, false);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 1,
      modelCatalog: catalog,
    });
    const state = definition.initialState;
    const action: AgentActionProposal = {
      id: "action-player",
      actorId: "player",
      baseRevision: state.revision,
      rawText: "观察钥匙",
      goal: "了解眼前物品",
      means: null,
      targetIds: ["copper-key"],
    };
    const proposal: TransitionProposal = {
      baseRevision: state.revision,
      outcomes: [],
      mechanicInvocations: [],
      operations: [{
        kind: "advance_time",
        seconds: 1,
        causes: [{ kind: "action", id: action.id }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: state.truth.elapsedSeconds }],
      }],
      events: [{ id: `rt:event:${"3".repeat(64)}`, step: 1, description: "The keeper examines the key.",
        impact: "ordinary", causes: [{ kind: "fact", id: "key-authenticity" }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }] }],
      observations: [],
      decisionRequests: [],
    };

    const rendered = await new ObservationRenderer(provider).render({
      definition,
      state,
      proposal,
      actions: [action],
      observerIds: ["player"],
      identityOwner: "component-player:transition-0",
    }, {
      workloadId: "instance-test",
      batchId: "advance-test",
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
    });

    expect(rendered.packets[0].summary).toBe("你仍只能依据商人的说法判断这把钥匙。");
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1].context).toMatchObject({
      repair: { issues: [{ reason: expect.stringContaining("protected information") }] },
    });
    for (const request of provider.requests) {
      expect(request.context).toMatchObject({ state: { currentEvents: [{
        causes: [{ kind: "fact", ref: "ref:fact:key-authenticity" }],
      }] } });
      const facts = (request.context as { state: { canonicalTruth: { facts: Record<string, unknown> } } })
        .state.canonicalTruth.facts;
      expect(facts).not.toHaveProperty("ref:fact:key-authenticity");
    }
    const context = provider.requests[0].context as {
      state: {
        canonicalTruth: { entities: Record<string, unknown>; facts: Record<string, unknown> };
        observationSlots: Array<{ observer: Record<string, unknown> }>;
      };
    };
    expect(Object.keys(context.state.canonicalTruth.entities)).toEqual(expect.arrayContaining([
      "ref:entity:courtyard",
      "ref:entity:key",
      "ref:entity:player",
    ]));
    expect(Object.keys(context.state.canonicalTruth.facts)).toEqual(expect.arrayContaining([
      "ref:fact:courtyard-sandy-ground",
      "ref:fact:gate-lock",
    ]));
    expect(context.state.observationSlots[0]?.observer).toMatchObject({
      agentRef: "ref:agent:player",
      selfEntityRef: "ref:entity:player",
      placementRef: "ref:placement:player",
      localEntities: expect.arrayContaining([
        expect.objectContaining({ ref: "ref:local_entity:player::copper-key", name: "铜钥匙" }),
      ]),
      privateFacts: [],
    });
    expect(context.state.observationSlots[0]?.observer).not.toHaveProperty("perspective");
    expect(context.state.observationSlots[0]?.observer).not.toHaveProperty("history");
    expect(context.state.observationSlots[0]?.observer).not.toHaveProperty("character");
  });

  it("repairs and falls back one observer without replaying another observer", async () => {
    const catalog = createTestModelCatalog();
    const calls = new Map<string, number>();
    const provider = new ScriptedModelProvider(({ context }) => {
      const observerRef = (context as {
        state: { observationSlots: Array<{ observer: { agentRef: string } }> };
      }).state.observationSlots[0]!.observer.agentRef;
      const observerId = observerRef.replace(/^ref:agent:/u, "");
      calls.set(observerId, (calls.get(observerId) ?? 0) + 1);
      if (observerId === "keeper") {
        return {
          summary: "缺少结构字段的观察。",
          introductions: [],
          sourceEventRefs: [],
        };
      }
      return {
        summary: "你观察到世界仍在变化。",
        introductions: [],
        apparentClaims: [],
        sourceEventRefs: [],
      };
    }, catalog, false);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 2,
      modelCatalog: catalog,
    });
    const state = definition.initialState;
    const actions = ["player", "keeper"].map((actorId): AgentActionProposal => ({
      id: `action-${actorId}`,
      actorId,
      baseRevision: state.revision,
      rawText: "观察",
      goal: "了解当前情况",
      means: null,
      targetIds: [],
    }));
    const proposal: TransitionProposal = {
      baseRevision: state.revision,
      outcomes: [],
      mechanicInvocations: [],
      operations: [{
        kind: "advance_time",
        seconds: 1,
        causes: actions.map((action) => ({ kind: "action" as const, id: action.id })),
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: state.truth.elapsedSeconds }],
      }],
      events: [],
      observations: [],
      decisionRequests: [],
    };

    const rendered = await new ObservationRenderer(provider).render({
      definition,
      state,
      proposal,
      actions,
      observerIds: ["player", "keeper"],
      identityOwner: "component-two:transition-0",
    }, {
      workloadId: "instance-test",
      batchId: "advance-test",
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
    });

    expect(rendered.packets.map((packet) => packet.observerId).sort()).toEqual(["keeper", "player"]);
    expect(rendered.packets.find((packet) => packet.observerId === "player")?.summary)
      .toBe("你观察到世界仍在变化。");
    expect(rendered.packets.find((packet) => packet.observerId === "keeper")?.summary)
      .toContain("没有形成其他可确认的观察");
    expect(calls).toEqual(new Map([["player", 1], ["keeper", 3]]));
    expect(rendered.batchCount).toBe(4);
    expect(provider.requests).toHaveLength(4);
    const invocationIds = rendered.modelAudits.flatMap((audit) => audit.invocations.map((invocation) => invocation.id));
    expect(new Set(invocationIds).size).toBe(invocationIds.length);
  });

  it("uses a typed uncertainty observation after singleton repair exhaustion", async () => {
    const catalog = createTestModelCatalog();
    const provider = new ScriptedModelProvider(() => ({}), catalog, false);
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
      seed: 3,
      modelCatalog: catalog,
    });
    const state = definition.initialState;
    const action: AgentActionProposal = {
      id: "action-player",
      actorId: "player",
      baseRevision: state.revision,
      rawText: "等待",
      goal: "保持安全",
      means: null,
      targetIds: [],
    };
    const proposal: TransitionProposal = {
      baseRevision: state.revision,
      outcomes: [],
      mechanicInvocations: [],
      operations: [{
        kind: "advance_time",
        seconds: 1,
        causes: [{ kind: "action", id: action.id }],
        assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: state.truth.elapsedSeconds }],
      }],
      events: [],
      observations: [],
      decisionRequests: [],
    };

    const algorithmEvents: RuntimeEventInput[] = [];
    const observer: RuntimeObserver = {
      mode: "metrics",
      degraded: false,
      emit(input) {
        if (input.event.startsWith("algorithm.")) validateAlgorithmTelemetryEvent(input);
        algorithmEvents.push(input);
        return undefined;
      },
    };

    const rendered = await new ObservationRenderer(provider).render({
      definition,
      state,
      proposal,
      actions: [action],
      observerIds: ["player"],
      identityOwner: "component-player:transition-0",
    }, {
      workloadId: "instance-test",
      batchId: "advance-test",
      runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
      observer,
    });

    expect(rendered.packets[0].summary).toContain("没有形成其他可确认的观察");
    expect(rendered.modelAudits[0].invocations).toHaveLength(3);
    expect(provider.requests).toHaveLength(3);
    expect(algorithmEvents).toContainEqual(expect.objectContaining({
      event: "algorithm.observation.repair_fallback",
      attributes: {
        phase: "observation",
        batch: "advance-test",
        policy: "typed-uncertainty-observation",
      },
      counts: { observationFallbacks: 1 },
    }));
  });
});
