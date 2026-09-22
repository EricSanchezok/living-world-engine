import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { buildWorldDefinition, loadWorldTemplate } from "../../../script/world-loader";
import { createTestModelCatalog, deterministicActionCompilationBatch,
  deterministicModelOutput, deterministicOnsetReports, ScriptedModelProvider } from "../../testing/model-provider";
import { contentHash } from "../../models/model-audit";
import { createActivity, type TemporalPlan } from "../../mechanics/temporal";
import type { AgentActionProposal, SimulationState } from "../../contracts/model";
import type { TruthPreparationInput } from "../../algorithms/roles";
import { bindInteractionProgram, executeInteractionComponent, interactionGuard, EXECUTABLE_CAPABILITY_PREDICATE,
  type ExecutableCapability, type InteractionProgram } from "./executable-interaction";
import { executablePlayerAlgorithmRef, interactionCompilerSources } from "./executable-interaction-algorithm";
import { registerIntegratedPlayerAlgorithm } from "./integrated-player-algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { replaySimulationState } from "../../runtime/transaction";
import { CachedPassageEncoder } from "../../algorithms/eager-reference/candidate-retrieval/embedding-cache";
import { MULTILINGUAL_E5_BASE_ASSET } from "../../algorithms/eager-reference/candidate-retrieval/model-assets";
import { actionCompilationPassagesForState } from "../../algorithms/eager-reference/candidate-retrieval/warmup";
import { createActionCompilationRetrievalRuntimeProvider } from "../../../server/action-compilation-retrieval-runtime";
import { AGENT_INTENT_CONTROL } from "./agent-intent-control";
import { RecordingRuntimeObserver } from "../../runtime/observability";

function fixture(catalog = createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 })) {
  const template = loadWorldTemplate(path.resolve("test/fixtures/open-world-script"));
  for (const entity of template.entities.filter(e => e.agent)) {
    const cap: ExecutableCapability = { version: 1, kind: "message", channel: "local", actorEntityId: entity.id,
      targetEntityId: entity.id, actorPlacementId: "courtyard", targetPlacementId: "courtyard", durationSeconds: 1,
      validFromSeconds: 0, validUntilSeconds: null };
    entity.facts.push({ id: `cap-${entity.id}`, predicate: EXECUTABLE_CAPABILITY_PREDICATE,
      value: { kind: "text", value: JSON.stringify(cap) }, description: "作者声明：本角色可以在庭院用一秒向自己说话。", access: { kind: "public" } });
  }
  return buildWorldDefinition(template, { seed: 47, modelCatalog: catalog });
}

function scenario() {
  const definition = fixture(), state = structuredClone(definition.initialState);
  const action: AgentActionProposal = { id: "test-action", actorId: "keeper", baseRevision: 0,
    rawText: "我对自己说：钥匙是真的。", goal: "说出这句话", means: "开口说话", targetIds: ["self"] };
  const plan: TemporalPlan = { id: "plan", actionId: action.id, actorId: action.actorId, profileId: "brief-action",
    mode: "fixed", description: action.rawText, basis: { kind: "profile", profileId: "brief-action" }, startsAtSeconds: 0,
    completionAtSeconds: 1, checkpointSeconds: 1, progress: null, stages: [], continuationAssertions: [],
    interruptible: true, resourceClaims: [{ resourceId: "foreground", amount: 1 }], causes: [{ kind: "action", id: action.id }] };
  state.truth.activities.a = createActivity({ id: "a", plan, sourceAction: action });
  const input: TruthPreparationInput = { definition, state, initialActions: [action], identityOwner: "test", groundings: [],
    temporalBoundary: { fromElapsedSeconds: 0, toElapsedSeconds: 1, deltaSeconds: 1,
      reasons: [], dueActivityIds: ["a"], dueTimerIds: [], dueConditionIds: [] } };
  const program: InteractionProgram = { actionId: action.id, parts: [{ pointer: "/rawText", segments: [{ text: action.rawText,
    operation: { kind: "message", capabilityFactId: "cap-keeper", targetLocalId: "self", verbatimMessage: "钥匙是真的。" } }] }] };
  return { input, action, program };
}

it("materializes a verbatim lie without changing canonical facts or beliefs", () => {
  const { input, action, program } = scenario(), before = contentHash(input.state);
  const bound = bindInteractionProgram(input.state, action, program);
  const stage = executeInteractionComponent(input, { [action.id]: bound });
  expect(stage.resolution.proposal.events[0]!.description).toContain("钥匙是真的。");
  expect(stage.resolution.proposal.operations.map(op => op.kind)).toEqual(["advance_time"]);
  expect(stage.resolution.resolutionReceipts).toHaveLength(1);
  expect(stage.resolution.causalAssertionResults.every(result => result.passed)).toBe(true);
  expect(contentHash(input.state)).toBe(before);
});

it.each([
  ["interruption", (state: SimulationState) => { state.truth.activities.a!.status = "paused"; }],
  ["absent recipient", (state: SimulationState) => { state.truth.entities.keeper!.lifecycle = "retired"; }],
  ["changed position", (state: SimulationState) => { state.truth.placements.keeper = "gate"; }],
  ["ambiguous identity", (state: SimulationState) => { state.agents.keeper!.bindings.self!.canonicalEntityIds.push("player"); }],
  ["changed capability", (state: SimulationState) => { state.truth.facts["cap-keeper"]!.description += " changed"; }],
])("rejects the entire component after %s", (_name, mutate) => {
  const { input, action, program } = scenario();
  const bound = bindInteractionProgram(input.state, action, program);
  mutate(input.state);
  expect(() => executeInteractionComponent(input, { [action.id]: bound })).toThrow("requires residual adjudication");
});

it("rejects omitted parallel work, stale reaction bindings, undelivered remote messages and partial programs", () => {
  const { input, action, program } = scenario(), original = bindInteractionProgram(input.state, action, program);
  expect(interactionGuard(input, { ...action, id: "reaction-replacement" }, original)).toContain("source-action-changed");
  const parallel = { ...action, rawText: `CURRENT_PARALLEL_ATTEMPTS_V1 (all members are attempted together; no success is assumed):\n${JSON.stringify({ attempts: [
    { text: action.rawText, targetIndices: [0] }, { text: "同时确认对方相信我。", targetIndices: [0] },
  ] })}` };
  expect(() => bindInteractionProgram(input.state, parallel, program)).toThrow("complete source partition");
  program.parts[0]!.segments[0]!.operation = { kind: "residual", reason: "No delivery evidence" };
  expect(() => executeInteractionComponent(input, { [action.id]: bindInteractionProgram(input.state, action, program) })).toThrow("residual");
  const remote = JSON.parse((input.state.truth.facts["cap-keeper"]!.value as { value: string }).value);
  remote.channel = "remote"; remote.durationSeconds = 10;
  input.state.truth.facts["cap-keeper"]!.value = { kind: "text", value: JSON.stringify(remote) };
  const rebound = bindInteractionProgram(input.state, action, original.program);
  expect(interactionGuard(input, action, rebound)).toContain("channel-or-operation-not-due");
});

it("resolves a conserved transfer through the real rule package and rejects hidden observation", () => {
  const { input, action, program } = scenario();
  action.rawText = "我向旅人转移2枚灵石。"; action.targetIds = ["traveler"];
  const cap = JSON.parse((input.state.truth.facts["cap-keeper"]!.value as { value: string }).value);
  delete cap.channel; Object.assign(cap, { kind: "transfer_quantity", targetEntityId: "player", definitionId: "spirit-stone", maxAmount: 3 });
  input.state.truth.facts["cap-keeper"]!.value = { kind: "text", value: JSON.stringify(cap) };
  program.parts[0]!.segments = [{ text: action.rawText, operation: { kind: "transfer_quantity", capabilityFactId: "cap-keeper",
    targetLocalId: "traveler", definitionId: "spirit-stone", amount: 2, quotedAmount: "2" } }];
  const bound = bindInteractionProgram(input.state, action, program);
  const stage = executeInteractionComponent(input, { [action.id]: bound });
  expect(stage.resolution.proposal.operations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "transfer_quantity", amount: 2 })]));
  Object.values(input.state.truth.quantities).find(q => q.holderId === "keeper")!.amount = 1;
  expect(interactionGuard(input, action, bound)).toContain("insufficient-owned-quantity");
  // A fact's presence in server truth does not grant an actor access.
  input.state.agents.keeper!.bindings.traveler!.canonicalEntityIds = ["key"];
  delete cap.definitionId; delete cap.maxAmount;
  Object.assign(cap, { kind: "observe_fact", targetEntityId: "key", targetPlacementId: "player", factIds: ["key-authenticity"] });
  input.state.truth.facts["cap-keeper"]!.value = { kind: "text", value: JSON.stringify(cap) };
  program.parts[0]!.segments[0]!.operation = { kind: "observe_fact", capabilityFactId: "cap-keeper", targetLocalId: "traveler", factId: "key-authenticity" };
  expect(interactionGuard(input, action, bindInteractionProgram(input.state, action, program))).toContain("fact-not-accessible");
  input.state.truth.facts["key-authenticity"]!.access = { kind: "agents", agentIds: ["keeper"] };
  expect(executeInteractionComponent(input, { [action.id]: bindInteractionProgram(input.state, action, program) }).resolution.proposal.events[0]!.description).toContain("仿制品");
});

it.each(["keep", "replace"] as const)("restores, commits and replays the diagnostic root with %s reactions without duplicate effects", async reaction => {
  const root = mkdtempSync(path.join(tmpdir(), "executable-interaction-"));
  const provider = new ScriptedModelProvider(request => {
    if (request.role === "truth-perception") return { kind: "done", reports: deterministicOnsetReports(request.context) };
    if (request.role === "agent-reaction") return reaction === "keep" ? { kind: "keep" } : {
      kind: "replace", replacementAction: { rawText: "我再次对自己说：钥匙是真的。", goal: "说出这句话", means: null,
        targetHandles: ["ref:local_entity:self"] },
    };
    const output = request.role === "action-compilation"
      ? deterministicActionCompilationBatch(request.profileId, request.context, compilation => {
        const candidates = (request.context as { referenceCatalog: { candidates: Array<{ kind: string; candidateKey: string }> } }).referenceCatalog.candidates;
        compilation.interactionDependency.audienceAgentRefs = candidates.filter(candidate => candidate.kind === "agent")
          .map(candidate => candidate.candidateKey as typeof compilation.interactionDependency.audienceAgentRefs[number]);
      }) : deterministicModelOutput(request.profileId, request.context);
    if (request.promptVersion.includes(AGENT_INTENT_CONTROL)) {
      for (const slot of (output as { slots: Array<{ nextActionIntent: unknown }> }).slots) slot.nextActionIntent = {
        kind: "replace", program: { kind: "attempt", text: "我对自己说：钥匙是真的。", targetHandles: ["ref:local_entity:self"] },
      };
    }
    if (request.role !== "action-compilation") return output;
    const sources = (request.context as { executableInteraction: { sources: ReturnType<typeof interactionCompilerSources> } }).executableInteraction.sources;
    return { ordinary: output, programs: sources.map(source => ({ actionId: source.actionId,
      parts: source.parts.map(part => ({ pointer: part.pointer, segments: [{ text: part.text, operation: {
        kind: "message", capabilityFactId: `cap-${source.actorEntityId}`, targetLocalId: "self", verbatimMessage: "钥匙是真的。",
      } }] })) })) };
  }, createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  const generate = provider.generateStructured.bind(provider);
  // Test the execution boundary with canonical fixtures; representation codecs
  // have independent wire tests. The joint envelope still passes its schema.
  provider.generateStructured = request => request.promptVersion.includes(AGENT_INTENT_CONTROL) ? generate(request) : generate({
    ...request, wireJsonSchema: undefined, preprocessOutput: value => {
      const fill = (node: unknown): void => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) { node.forEach(fill); return; }
        const row = node as Record<string, unknown>;
        if (row.kind === "commit_plans") for (const plan of row.plans as Array<Record<string, unknown>>) plan.additionalRandomness ??= "none";
        Object.values(row).forEach(fill);
      };
      fill(value); return { value, symbolRepairs: [] };
    },
  });
  const definition = fixture(provider.catalog), ref = executablePlayerAlgorithmRef();
  const encoder = { modelId: MULTILINGUAL_E5_BASE_ASSET.modelId, modelHash: MULTILINGUAL_E5_BASE_ASSET.directorySha256,
    dimensions: 2, encodeBatch: async (texts: readonly string[]) => texts.map(text => [text.length % 7, 1]) };
  const cache = new CachedPassageEncoder(encoder, MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint, root);
  await cache.encodePassages({ worldContentHash: definition.contentHash, passages: actionCompilationPassagesForState(definition.initialState), allowWrite: true });
  cache.close();
  const retrieval = createActionCompilationRetrievalRuntimeProvider({ cacheRoot: root, encoder, fingerprint: () => MULTILINGUAL_E5_BASE_ASSET.encoderFingerprint });
  const algorithm = () => registerIntegratedPlayerAlgorithm().create(ref, { provider, resources: {
    resolve: <T,>(kind: string) => kind === "candidate-selection-runtime" ? retrieval.runtime(ref) as T : undefined,
  } });
  try {
    const engine = new SimulationEngine(definition, algorithm()); await engine.bootstrapAgents();
    const source = engine.snapshot, observer = new RecordingRuntimeObserver({ mode: "full" });
    const roster = Object.fromEntries(Object.values(source.agents).map(a => [a.id, { kind: "model" as const, agentId: a.id, profiles: a.modelProfiles }]));
    const request = { expectedRevision: source.revision, trigger: "manual" as const, externalActions: [] };
    const scope = { workloadId: "executable-test", batchId: "executable-test", observer };
    const prepared = await engine.prepareStep(roster, request, scope);
    expect(Object.keys(prepared.executionState!.data.executableInteractions!)).toHaveLength(2);
    expect(prepared.reactionRequests).toHaveLength(2);
    const frozenHash = contentHash(prepared);
    const restarted = new SimulationEngine(definition, algorithm(), source);
    const result = await restarted.completePreparedStep(roster, request, JSON.parse(JSON.stringify(prepared)), [], scope);
    expect(result.state.executionState).toEqual(prepared.executionState);
    expect(contentHash(prepared)).toBe(frozenHash);
    expect(result.committed.reactionDecisions.every(decision => decision.kind === reaction)).toBe(true);
    expect(observer.snapshot().some(e => e.event === "algorithm.executable_interaction.executed")).toBe(true);
    expect(observer.snapshot().filter(e => e.event === "algorithm.executable_interaction.fallback")).toEqual([]);
    expect(result.state.truth.events.filter(e => e.description.includes("钥匙是真的"))).toHaveLength(2);
    expect(result.state.truth.facts["key-authenticity"]!.value).toEqual({ kind: "text", value: "fake" });
    expect(contentHash(replaySimulationState(result.state))).toBe(contentHash(result.state));
    expect(provider.requests.filter(r => r.role === "action-compilation")).toHaveLength(reaction === "replace" ? 2 : 1);
    expect(provider.requests.some(r => r.schemaName.startsWith("causal_verification"))).toBe(true);
    const committed = contentHash(restarted.snapshot);
    await expect(restarted.completePreparedStep(roster, request, prepared, [], scope)).rejects.toThrow();
    expect(contentHash(restarted.snapshot)).toBe(committed);
    const next = await restarted.step(roster, { ...request, expectedRevision: result.state.revision }, scope);
    expect(next.state.truth.events.filter(e => e.description.includes("钥匙是真的"))).toHaveLength(4);
    expect(provider.requests.filter(r => r.role === "action-compilation")).toHaveLength(reaction === "replace" ? 4 : 2);
    expect(contentHash(replaySimulationState(next.state))).toBe(contentHash(next.state));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
