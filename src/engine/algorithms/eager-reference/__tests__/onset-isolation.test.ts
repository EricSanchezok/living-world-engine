import path from "node:path";
import { expect, it } from "vitest";
import { loadWorldScript } from "../../../../script/world-loader";
import { contentHash } from "../../../models/model-audit";
import { historyReplayBaseHash } from "../../../runtime/history-replay";
import { SimulationEngine } from "../../../runtime/simulation";
import type { WorldExecutionAlgorithm, WorldStepCandidate, WorldStepPreparation } from "../../../runtime/execution";
import { ScriptedModelProvider, deterministicActionCompilationBatch, deterministicInteractionDependency,
  deterministicModelOutput, deterministicOnsetReports } from "../../../testing/model-provider";
import { EagerReferenceAlgorithm } from "../eager-reference";

type Mode = "silent" | "occluded" | "friend" | "unrelated" | "visible" | "remote" | "introduction" | "existing-identities" | "missing" | "incomplete";
async function fixture(mode: Mode, secret = "PRIVATE_ALPHA", forge = false, externalKeeper = false) {
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") return deterministicActionCompilationBatch(profileId, context, compilation => {
      compilation.interactionDependency = deterministicInteractionDependency({ reads: [{ kind: "global", id: "world" }],
        writes: [{ kind: "global", id: "world" }], audienceAgentIds: ["keeper", "player"], sharedResourceClaims: [] });
    });
    if (role === "truth-perception") {
      if (mode === "missing") return { kind: "done" };
      if (mode === "incomplete") return { kind: "done", reports: [] };
      const targets = (context as { task: { assignment: { perceptionTargets: Array<{ observerRef: string }> } } }).task.assignment.perceptionTargets;
      const actors = (context as { state: { actors: Array<{ entityRef: string; localEntityBindings: Array<{ localEntityRef: string; canonicalEntityRefs: string[] }> }> } }).state.actors;
      const traveler = actors.find(actor => actor.entityRef === "ref:entity:keeper")?.localEntityBindings
        .find(binding => binding.canonicalEntityRefs.includes("ref:entity:player"))?.localEntityRef;
      return { kind: "done", reports: deterministicOnsetReports(context, "no_stimulus").map(report =>
        ["visible", "remote", "introduction", "existing-identities"].includes(mode) && targets[report.targetIndex]!.observerRef === "ref:entity:keeper"
          ? { ...report, kind: "perceived", reason: "The current raised hand is perceptible through the authored channel; private plans are not.",
              evidence: [{ kind: "law", ref: "ref:law:onset-channel" }],
              stimulus: { summary: "You see the traveler raise a hand.", sourceEventRefs: [],
                introductions: mode === "introduction" ? [{ canonicalEntityRef: "ref:entity:player", localEntity: {
                  proposalKey: "traveler-seen", name: "A traveler", description: "A person raising a hand", status: "observed",
                } }] : [],
                apparentClaims: mode === "introduction" ? [{ subjectRef: { proposalKey: "traveler-seen" }, predicate: "gesture",
                  value: { kind: "text", value: "raised hand" }, description: "The traveler raises a hand." }]
                  : mode === "existing-identities" ? [{ subjectRef: traveler, predicate: "gesture",
                    value: { kind: "text", value: "raised hand" }, description: "The traveler raises a hand." }] : [] } }
          : { ...report, reason: "The authored sensory boundary supplies no observable onset.",
              evidence: [{ kind: "law", ref: "ref:law:onset-channel" }] }) };
    }
    if (role === "agent-reaction") return { kind: "keep" };
    if (role === "causal-verifier") return { verdict: "accept", findings: [] };
    return deterministicModelOutput(profileId, context);
  }, undefined, false);
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
  const initial = definition.initialState;
  initial.truth.facts = {};
  const separated = ["friend", "unrelated", "remote"].includes(mode);
  initial.truth.placements.keeper = separated ? "gate" : "courtyard";
  if (mode === "friend") initial.truth.facts.friendship = { id: "friendship", subjectId: "player", predicate: "friend-of",
    value: { kind: "entity", entityId: "keeper" }, access: { kind: "public" },
    description: "They are friends; this does not provide communication or perception.", provenance: [{ kind: "world_seed", id: initial.worldHash }] };
  definition.laws.push({ id: "onset-channel", severity: "hard", text: mode === "remote"
    ? "An active scrying channel lets the keeper see the traveler's current hand gesture across locations, without a check. Silent thoughts remain private."
    : ["visible", "introduction", "existing-identities"].includes(mode) ? "The keeper can clearly see the traveler's current hand gesture in the open courtyard, without a check. Silent thoughts remain private."
      : "The private thought is silent and never communicated. An opaque barrier hides any gesture, even in the same courtyard. Different locations are isolated from sound, sight, telepathy and relays. Friendship grants no channel." });
  initial.lawIds.push("onset-channel");
  definition.historyBaseHash = historyReplayBaseHash(initial);
  const delegate = new EagerReferenceAlgorithm(provider);
  let candidate: WorldStepCandidate | undefined;
  const algorithm: WorldExecutionAlgorithm = { manifest: delegate.manifest,
    bootstrap: (input, context) => delegate.bootstrap(input, context),
    prepareStep: (input, context) => delegate.prepareStep(input, context),
    completeStep: async (input, preparation, reactions, context) => {
      candidate = await delegate.completeStep(input, preparation, reactions, context);
      if (forge) {
        const receipt = candidate.onsetPerception.receipts.find(receipt => receipt.kind === "perceived")!;
        if (receipt.kind !== "perceived") throw new Error("fixture needs a perceived onset");
        receipt.stimulus.summary = "Forged content after the preparation was frozen.";
        const { contentHash: _hash, ...body } = receipt; void _hash;
        receipt.contentHash = contentHash(body);
        const reaction = candidate.resolution.reactionRequests.find(request => request.agentId === receipt.observerId)!;
        reaction.stimulus = structuredClone(receipt.stimulus); reaction.perceptionReceiptHash = receipt.contentHash;
        // Even coordinated candidate/preparation edits cannot modify the kernel's frozen copy.
        preparation.onsetPerception.receipts = structuredClone(candidate.onsetPerception.receipts);
        preparation.reactionRequests.splice(0, preparation.reactionRequests.length, ...structuredClone(candidate.resolution.reactionRequests));
      }
      return candidate;
    },
  };
  const engine = new SimulationEngine(definition, algorithm);
  await engine.bootstrapAgents();
  const source = engine.snapshot;
  const roster = { player: { kind: "external" as const, agentId: "player", participantId: "player-test" },
    keeper: externalKeeper ? { kind: "external" as const, agentId: "keeper", participantId: "keeper-test" }
      : { kind: "model" as const, agentId: "keeper", profiles: structuredClone(source.agents.keeper!.modelProfiles) } };
  const request = { expectedRevision: source.revision, trigger: "participant_action" as const, externalActions: [
    { submissionId: "onset", agentId: "player", rawText: `${mode === "silent" ? "I stand still" : "I raise a hand"}. I silently recall ${secret} and plan a delivery tomorrow. Neither thought nor plan is spoken or signalled.`,
      goal: "Think privately", means: null, targetIds: [] },
    ...(externalKeeper ? [{ submissionId: "keeper-action", agentId: "keeper", rawText: "I watch the courtyard.", goal: "Remain alert", means: null, targetIds: [] }] : []),
  ] };
  return { provider, definition, algorithm, engine, source, roster, request, candidate: () => candidate };
}

it.each(["silent", "occluded", "friend", "unrelated"] as const)("does not pass an unobservable %s onset into actual AgentMind", async mode => {
  const test = await fixture(mode), before = contentHash(test.source);
  const preparation = await test.engine.prepareStep(test.roster, test.request);
  expect(preparation.onsetPerception.targets.length).toBeGreaterThan(0);
  expect(preparation.onsetPerception.receipts).toHaveLength(preparation.onsetPerception.targets.length);
  expect(preparation.onsetPerception.receipts.every(receipt => receipt.kind === "no_stimulus")).toBe(true);
  expect(preparation.reactionRequests).toEqual([]);
  expect(test.provider.requests.filter(request => request.role === "truth-perception")).toHaveLength(1);
  expect(test.provider.requests.filter(request => request.role === "agent-reaction")).toEqual([]);
  expect(test.provider.requests.filter(request => request.role === "truth-reaction-routing")).toEqual([]);
  expect(contentHash(test.engine.snapshot)).toBe(before);
});

it("keeps private-only source changes out of actual reaction entry", async () => {
  for (const secret of ["PRIVATE_ALPHA", "PRIVATE_BETA"]) {
    const test = await fixture("silent", secret);
    await test.engine.prepareStep(test.roster, test.request);
    expect(test.provider.requests.some(request => request.role === "truth-perception" && JSON.stringify(request.context).includes(secret))).toBe(true);
    expect(test.provider.requests.filter(request => request.role === "agent-reaction")).toEqual([]);
  }
});

it.each(["missing", "incomplete"] as const)("rejects %s reports through the real model boundary before any Agent reaction", async mode => {
  const test = await fixture(mode), before = contentHash(test.engine.snapshot);
  await expect(test.engine.prepareStep(test.roster, test.request)).rejects.toThrow();
  expect(test.provider.requests.filter(request => request.role === "truth-perception")).toHaveLength(3);
  expect(test.provider.requests.filter(request => request.role === "agent-reaction")).toEqual([]);
  expect(contentHash(test.engine.snapshot)).toBe(before);
});

it.each(["visible", "remote"] as const)("delivers only the adjudicated %s stimulus without adding checks or a routing call", async mode => {
  const test = await fixture(mode);
  const preparation = await test.engine.prepareStep(test.roster, test.request);
  expect(preparation.onsetPerception.requests).toEqual([]);
  const calls = test.provider.requests.filter(request => request.role === "agent-reaction");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.subjectId).toBe("keeper");
  expect(JSON.stringify(calls[0]!.context)).toContain("You see the traveler raise a hand.");
  expect(JSON.stringify(calls[0]!.context)).not.toMatch(/PRIVATE_ALPHA|delivery tomorrow/);
  expect(test.provider.requests.filter(request => request.role === "truth-perception")).toHaveLength(1);
  expect(test.provider.requests.some(request => request.role === "truth-reaction-routing")).toBe(false);
});

it("rejects coherently rehashed candidate receipts and an attempted preparation mutation before committing", async () => {
  const test = await fixture("visible", "PRIVATE_ALPHA", true), before = contentHash(test.engine.snapshot);
  await expect(test.engine.step(test.roster, test.request)).rejects.toThrow("frozen onset preparation");
  expect(test.candidate()).toBeDefined();
  expect(contentHash(test.engine.snapshot)).toBe(before);
});

it("keeps a new introduction local in AgentMind while committing its binding on the server", async () => {
  const test = await fixture("introduction");
  const result = await test.engine.step(test.roster, test.request);
  const call = test.provider.requests.find(request => request.role === "agent-reaction")!;
  expect(JSON.stringify(call.context)).toContain("A traveler");
  expect(JSON.stringify(call.context)).not.toMatch(/canonicalEntityId|canonicalEntityRef|ref:entity:player|PRIVATE_ALPHA/);
  const intro = result.committed.reactionRequests[0]!.stimulus.introductions[0]!;
  expect(result.state.agents.keeper!.bindings[intro.localEntity.id]!.canonicalEntityIds).toContain("player");
});

it("delivers claims about an existing local identity through actual AgentMind without replacing that identity", async () => {
  const test = await fixture("existing-identities"), before = contentHash(test.engine.snapshot);
  const preparation = await test.engine.prepareStep(test.roster, test.request);
  const stimulus = preparation.reactionRequests.find(request => request.agentId === "keeper")!.stimulus;
  expect(stimulus.introductions).toEqual([]);
  expect(stimulus.apparentClaims[0]!.subjectId).toBe("traveler");
  const call = test.provider.requests.find(request => request.role === "agent-reaction")!;
  expect(JSON.stringify(call.context)).toContain("ref:local_entity:traveler");
  expect(JSON.stringify(call.context)).not.toMatch(/canonicalEntityId|canonicalEntityRef|ref:entity:player|keeper::traveler|PRIVATE_ALPHA/);
  expect(contentHash(test.engine.snapshot)).toBe(before);
});

it("restores an external reaction from the same serialized receipt without another perception call", async () => {
  const test = await fixture("visible", "PRIVATE_ALPHA", false, true);
  const preparation = await test.engine.prepareStep(test.roster, test.request);
  expect(preparation.pendingReactionRequests).toHaveLength(1);
  const persisted = JSON.parse(JSON.stringify(preparation)) as WorldStepPreparation;
  const restored = new SimulationEngine(test.definition, test.algorithm, test.source);
  const count = test.provider.requests.filter(request => request.role === "truth-perception").length;
  const result = await restored.completePreparedStep(test.roster, test.request, persisted,
    persisted.pendingReactionRequests.map(request => ({ submissionId: "kept", requestId: request.id, agentId: request.agentId, kind: "keep" })));
  expect(test.provider.requests.filter(request => request.role === "truth-perception")).toHaveLength(count);
  expect(result.committed.reactionRequests).toEqual(persisted.reactionRequests);
  expect(result.state.revision).toBe(test.source.revision + 1);
});
