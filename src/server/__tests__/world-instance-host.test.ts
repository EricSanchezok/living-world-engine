import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EAGER_REFERENCE_CONFIG,
  EagerReferenceAlgorithm,
  FULL_CATALOG_EAGER_REFERENCE_CONFIG,
} from "../../engine/algorithms/eager-reference/eager-reference";
import {
  DEFAULT_ALGORITHM_REF,
  eagerReferenceAlgorithmRef,
  FULL_CATALOG_ALGORITHM_REF,
  registerBuiltinAlgorithms,
} from "../../engine/algorithms/registry";
import { AlgorithmExperimentRegistry, defineAlgorithmExperimentManifest } from "../../engine/runtime/experiments";
import {
  algorithmRef,
  defineAlgorithmManifest,
  WorldExecutionAlgorithmRegistry,
  type AlgorithmRef,
  type BootstrapCandidate,
  type BootstrapInput,
  type ExecutionContext,
  type WorldExecutionAlgorithm,
  type WorldStepCandidate,
  type WorldStepInput,
} from "../../engine/runtime/execution";
import { historyReplayBaseHash } from "../../engine/runtime/history-replay";
import { contentHash } from "../../engine/models/model-audit";
import { ModelTransportError } from "../../engine/models/model-provider";
import { promptBundle } from "../../engine/prompts";
import {
  createTestModelCatalog,
  DeterministicModelProvider,
  ScriptedModelProvider,
  deterministicActionCompilationBatch,
  deterministicInteractionDependency,
  deterministicModelOutput,
} from "../../engine/testing/model-provider";
import { referenceHandleFor } from "../../engine/contracts/model-context";
import { loadWorldScript } from "../../script/world-loader";
import { MemoryWorldRepository } from "../../script/world-repository";
import { debugCheckpointReplayValidationError } from "../debug-checkpoint-provider";
import { LocalDatabase } from "../local-database";
import { WorldHost, type WorldHostOptions } from "../world-host";
import { validateWorldInstanceDocument } from "../world-instance-store";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(input: {
  now?: () => Date;
  maxParticipants?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  runLeaseMaxCommits?: number;
  runLeaseMaxWallTimeMs?: number;
  algorithmRegistry?: WorldExecutionAlgorithmRegistry;
  defaultAlgorithmRef?: AlgorithmRef | null;
  experimentRegistry?: AlgorithmExperimentRegistry;
  actionCompilationRetrievalProvider?: WorldHostOptions["actionCompilationRetrievalProvider"];
  idFactory?: () => string;
} = {}) {
  const provider = new DeterministicModelProvider(createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 47,
    modelCatalog: provider.catalog,
  });
  const root = mkdtempSync(path.join(tmpdir(), "lwe-instance-host-"));
  roots.push(root);
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  let ordinal = 0;
  const repository = new MemoryWorldRepository({ [definition.id]: definition });
  const host = new WorldHost({
    repository,
    store: database,
    ledger: database,
    provider,
    now: input.now,
    idFactory: input.idFactory ?? (() => `id-${++ordinal}`),
    maxActiveParticipants: input.maxParticipants ?? 1,
    setTimer: input.setTimer,
    clearTimer: input.clearTimer,
    runLeaseMaxCommits: input.runLeaseMaxCommits,
    runLeaseMaxWallTimeMs: input.runLeaseMaxWallTimeMs,
    algorithmRegistry: input.algorithmRegistry,
    ...(input.defaultAlgorithmRef === null ? {} : { defaultAlgorithmRef: input.defaultAlgorithmRef ?? FULL_CATALOG_ALGORITHM_REF }),
    experimentRegistry: input.experimentRegistry,
    actionCompilationRetrievalProvider: input.actionCompilationRetrievalProvider,
  });
  return { database, definition, host, provider, repository };
}

const observerStart = {
  worldId: "open-world-fixture",
  start: { kind: "observer" as const },
};

const originStart = {
  worldId: "open-world-fixture",
  start: {
    kind: "origin" as const,
    originId: "courtyard-wanderer",
    displayName: "小明",
    appearance: "背着旧旅行包。",
    motivation: "找到石门后的道路。",
  },
};

async function waitForRevision(host: WorldHost, instanceId: string, revision: number) {
  let latest = host.instance(instanceId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = host.instance(instanceId);
    if (latest.summary.revision >= revision) return latest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `instance ${instanceId} did not reach revision ${revision}; ` +
    `latest revision=${latest.summary.revision}, run=${latest.run?.status}, reason=${latest.run?.stopReason}`,
  );
}

async function waitForRunStatus(host: WorldHost, instanceId: string, status: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const detail = host.instance(instanceId);
    if (detail.run?.status === status) return detail;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`instance ${instanceId} did not reach run status ${status}`);
}

function reactionHarness(input: {
  now?: () => Date;
  actionWindowMs?: number;
  reactionFallback?: "continue_if_valid" | "pause" | "cancel";
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
} = {}) {
  let keeperCompilations = 0;
  const travelerId = "courtyard-wanderer-1";
  const provider = new ScriptedModelProvider(({ role, profileId, context }) => {
    if (role === "action-compilation") {
      return deterministicActionCompilationBatch(profileId, context, (compilation, { action, temporalEvidence }) => {
        if (action.rawText.includes("100公里")) {
          const evidence = temporalEvidence.find((candidate) => candidate.kind === "quantity");
          if (!evidence) throw new Error("test action is missing quantity evidence");
          compilation.temporalPlan = {
            profileRef: referenceHandleFor("temporal_profile", "measured-travel"),
            basis: {
              kind: "action_text_evidence",
              evidenceKey: evidence.key,
            },
            description: "持续前往一百公里外",
            continuationAssertions: [],
            causes: [{ kind: "action", ref: referenceHandleFor("action", action.id) }],
          };
        }
        const isKeeper = action.actorId === "keeper";
        if (isKeeper) keeperCompilations += 1;
        compilation.interactionDependency = deterministicInteractionDependency({
          reads: [{ kind: "global", id: "world" }],
          writes: [{ kind: "global", id: "world" }],
          audienceAgentIds: isKeeper && keeperCompilations > 1
            ? ["keeper", travelerId]
            : [action.actorId],
          sharedResourceClaims: [],
        });
      });
    }
    return deterministicModelOutput(profileId, context);
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 47,
    modelCatalog: provider.catalog,
  });
  definition.runtimeDefaults.maxAutonomousSpanSeconds = 100_000;
  if (input.actionWindowMs !== undefined) definition.runtimeDefaults.actionWindowMs = input.actionWindowMs;
  const travel = definition.initialState.truth.mechanics.temporalProfiles["measured-travel"];
  if (!travel || travel.kind !== "rate") throw new Error("fixture travel profile is missing");
  travel.reactionFallback = input.reactionFallback ?? "continue_if_valid";
  definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
  const root = mkdtempSync(path.join(tmpdir(), "lwe-reaction-host-"));
  roots.push(root);
  const database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  let ordinal = 0;
  const repository = new MemoryWorldRepository({ [definition.id]: definition });
  const host = new WorldHost({
    repository,
    store: database,
    ledger: database,
    provider,
    now: input.now,
    setTimer: input.setTimer,
    clearTimer: input.clearTimer,
    idFactory: () => `reaction-id-${++ordinal}`,
    maxActiveParticipants: 1,
    defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
  });
  return { database, host, provider, repository };
}

describe("World Instance host", () => {
  it("keeps the execution open until an already-started sibling compilation records its audit", async () => {
    const { database, host, provider } = harness();
    const created = await host.createInstance(originStart);
    const stored = database.readInstance(created.summary.id);
    const document = structuredClone(stored.document);
    const keeperPolicy = document.policyBindings.keeper!;
    if (keeperPolicy.kind !== "model") throw new Error("fixture keeper must use the model policy");
    keeperPolicy.resumeFromRevision = document.state.revision;
    database.compareAndSwapInstance(created.summary.id, stored.generation, document);
    const before = contentHash(document.state);
    const generate = provider.generateStructured.bind(provider);
    let announceSibling!: () => void, releaseSibling!: () => void;
    const siblingStarted = new Promise<void>(resolve => { announceSibling = resolve; });
    const siblingGate = new Promise<void>(resolve => { releaseSibling = resolve; });
    let compilationCalls = 0, failureThrown = false, siblingFinished = false, siblingSettled = false;
    let siblingInvocationId: string | undefined;
    provider.generateStructured = async request => {
      if (request.role !== "action-compilation") return generate(request);
      if (++compilationCalls === 1) {
        await siblingStarted;
        failureThrown = true;
        throw new ModelTransportError("known compilation failed while its sibling was in flight");
      }
      announceSibling();
      await siblingGate;
      try {
        const result = await generate(request);
        siblingInvocationId = result.audit.invocations[0]!.id;
        siblingFinished = true;
        return result;
      } finally { siblingSettled = true; }
    };
    try {
      await host.submitAction(created.summary.id, created.participants[0]!.id, {
        submissionId: "parallel-failure", expectedRevision: created.summary.revision, text: "我观察石门。",
      });
      await expect.poll(() => failureThrown).toBe(true);
      await new Promise<void>(resolve => setImmediate(resolve));
      const execution = database.executions({ instanceId: created.summary.id }).at(-1)!;
      expect(execution.status).toBe("running");
      expect(siblingFinished).toBe(false);
      releaseSibling();
      await waitForRunStatus(host, created.summary.id, "failed");
      expect(siblingFinished).toBe(true);
      expect(compilationCalls).toBe(2);
      expect(contentHash(database.readInstance(created.summary.id).document.state)).toBe(before);
      const events = database.executionEvents(execution.id);
      const audit = events.find(event => event.event === "model.audit.persisted" && event.correlation?.modelInvocationId === siblingInvocationId);
      const terminal = events.find(event => event.event === "execution.failed");
      expect(audit).toBeDefined();
      expect(terminal!.sequence).toBeGreaterThan(audit!.sequence);
      expect(database.execution(execution.id)?.commitRevision).toBeUndefined();
    } finally {
      releaseSibling();
      await expect.poll(() => siblingSettled).toBe(true);
      await waitForRunStatus(host, created.summary.id, "failed");
      database.close();
    }
  }, 30_000);

  it("persists a terminal failed run when a model error has an empty message", async () => {
    const { host, database, provider } = harness();
    const created = await host.createInstance(observerStart);
    const before = database.readInstance(created.summary.id).document.state;
    provider.generateStructured = async () => { throw new ModelTransportError(""); };
    await host.advance(created.summary.id, { expectedRevision: before.revision, trigger: "batch", steps: 1 });
    await waitForRunStatus(host, created.summary.id, "failed");
    const after = database.readInstance(created.summary.id).document;
    expect(contentHash(after.state)).toBe(contentHash(before));
    expect(Object.values(after.runs).at(-1)).toMatchObject({ status: "failed", stopReason: "execution-failed", error: "ModelTransportError" });
    expect(database.executions({ instanceId: created.summary.id }).at(-1)?.status).toBe("failed");
    database.close();
  });

  it("pins the standard integrated composition through the ordinary host default", async () => {
    let preflightCalls = 0;
    const retrievalRuntime = {
      role: "candidate-selection" as const,
      version: "action-compilation-retrieval-runtime-v6",
      async retrieveBatch() { throw new Error("unused retrieval fixture"); },
    };
    const setup = harness({
      defaultAlgorithmRef: null,
      actionCompilationRetrievalProvider: {
        runtime: (ref) => ref.manifestHash === DEFAULT_ALGORITHM_REF.manifestHash
          ? retrievalRuntime
          : undefined,
        preflight: async (ref, input) => {
          expect(ref.manifestHash).toBe(DEFAULT_ALGORITHM_REF.manifestHash);
          expect(input.worldContentHash).toBe(setup.definition.contentHash);
          preflightCalls += 1;
        },
      },
    });
    try {
      const created = await setup.host.createInstance(observerStart);
      const stored = setup.database.readInstance(created.summary.id).document;
      expect(stored.executionAlgorithm).toEqual(DEFAULT_ALGORITHM_REF);
      expect(stored.executionAlgorithm.children.actionCompilation).toMatchObject({
        id: "represented-action-compilation", config: { representation: "AT", descriptionPolicy: "original-action-v1" },
      });
      expect(stored.executionAlgorithm.children.truthResolution).toMatchObject({
        id: "indexed-reviewed-truth-resolution", version: "5",
        children: { batching: { id: "shared-state-first-slot-batching", config: { flushBoundary: "post-promise-v1", planRepairBatching: "scoped-plans-v1" } } },
      });
      expect(stored.executionAlgorithm.children.observationRendering?.id).toBe("source-bound-observation-rendering");
      expect(setup.host.inspectorWindow(created.summary.id, { limit: 1 }).algorithmComposition.root).toEqual(DEFAULT_ALGORITHM_REF);
      expect(stored.executionAlgorithm.children.actionCompilation?.children.candidateSelection)
        .toMatchObject({
          role: "candidate-selection",
          id: "relational-rrf",
          version: "2",
          config: { budgetPolicy: "mandatory-floor-v1" },
          children: {
            ranking: { id: "typed-channel-rrf" },
            allocation: { id: "coverage-aware-joint-budget" },
          },
        });
      expect(preflightCalls).toBe(1);
    } finally {
      setup.database.close();
    }
  });

  it("runs ten headless eager steps through the same Ledger", async () => {
    const { database, host } = harness();
    try {
      const created = await host.createInstance(observerStart);
      const advanced = await host.advance(created.summary.id, {
        expectedRevision: created.summary.revision,
        trigger: "batch",
        steps: 10,
      });
      expect(advanced.summary).toMatchObject({ revision: 10, step: 10, participantCount: 0 });
      const stored = database.readInstance(created.summary.id).document;
      expect(stored).toMatchObject({ schemaVersion: 23, experimentEnrollment: null, experimentExclusion: { reason: "no-active-experiment" } });
      const inspector = host.inspectorWindow(created.summary.id, { limit: 24 });
      expect(inspector).toMatchObject({
        apiVersion: 13,
        algorithmComposition: {
          nodeCount: 23,
          root: {
            role: "world-execution",
            id: "eager-reference",
            version: "21",
            manifestHash: stored.executionAlgorithm.manifestHash,
          },
        },
      });
      expect(stored.state.history).toHaveLength(10);
      expect(Object.values(stored.runs)).toHaveLength(1);
      expect(Object.values(stored.policyBindings).every((binding) => binding.kind === "model")).toBe(true);
      expect(database.executions({ instanceId: created.summary.id })).toHaveLength(11);
    } finally {
      database.close();
    }
  }, 30_000);

  it("pauses a debug run between logical stages without committing early", async () => {
    let now = new Date("2026-08-29T08:00:00.000Z");
    const { database, host, provider } = harness({ now: () => now });
    try {
      const created = await host.createInstance(observerStart);
      const bootstrapRequestCount = provider.requests.length;
      const configured = await host.setDebugMode(created.summary.id, {
        enabled: true,
        expectedRevision: created.summary.revision,
      });
      expect(configured.summary.debugSteppingEnabled).toBe(true);
      const started = await host.advance(configured.summary.id, {
        expectedRevision: configured.summary.revision,
        trigger: "manual",
        steps: 1,
      });
      const paused = started.run?.status === "debug-paused"
        ? started
        : await waitForRunStatus(host, created.summary.id, "debug-paused");
      expect(paused.run?.debug).toMatchObject({ stageIndex: 0, stageCount: 10, canAdvance: true });
      expect(paused.summary.revision).toBe(0);
      expect(provider.requests).toHaveLength(bootstrapRequestCount);
      const initialExecutionId = database.readInstance(created.summary.id).document
        .runs[paused.run!.id]!.debugCheckpoint!.executionId;
      const initialStageEvents = database.executionEvents(initialExecutionId)
        .filter((event) => event.correlation?.logicalStageIndex === 0)
        .map((event) => event.event);
      expect(initialStageEvents).toContain("stage.started");
      expect(initialStageEvents).toContain("stage.paused");
      expect(initialStageEvents).not.toContain("stage.completed");
      await expect(host.pauseRun(created.summary.id, {
        runId: paused.run!.id,
        generation: paused.run!.generation,
      })).rejects.toThrow("single-step runs use next-step control");
      now = new Date(now.getTime() + 60_000);
      const next = await host.advanceDebugStep(created.summary.id, {
        runId: paused.run!.id,
        generation: paused.run!.generation,
        checkpointId: paused.run!.debug.checkpointId!,
        requestId: "debug-next-1",
      });
      const stageTwo = next.run?.status === "debug-paused"
        ? next
        : await waitForRunStatus(host, created.summary.id, "debug-paused");
      expect(stageTwo.run?.debug.stageIndex).toBe(1);
      expect(stageTwo.summary.revision).toBe(0);
      expect(stageTwo.run?.lease).toMatchObject({
        startedAt: paused.run?.lease?.startedAt,
        suspendedDurationMs: 60_000,
      });
      expect(provider.requests).toHaveLength(bootstrapRequestCount);
      const afterFirstStepEvents = database.executionEvents(initialExecutionId);
      expect(afterFirstStepEvents).toContainEqual(expect.objectContaining({
        event: "stage.completed",
        correlation: expect.objectContaining({ logicalStageIndex: 0 }),
      }));
      expect(afterFirstStepEvents).toContainEqual(expect.objectContaining({
        event: "stage.paused",
        correlation: expect.objectContaining({ logicalStageIndex: 1 }),
      }));
      expect(afterFirstStepEvents).not.toContainEqual(expect.objectContaining({
        event: "stage.started",
        correlation: expect.objectContaining({ logicalStageIndex: 1 }),
      }));

      let cursor = stageTwo;
      for (let stageIndex = 2; stageIndex < 10; stageIndex += 1) {
        const stepped = await host.advanceDebugStep(created.summary.id, {
          runId: cursor.run!.id,
          generation: cursor.run!.generation,
          checkpointId: cursor.run!.debug.checkpointId!,
          requestId: `debug-next-${stageIndex}`,
        });
        cursor = stepped.run?.status === "debug-paused"
          ? stepped
          : await waitForRunStatus(host, created.summary.id, "debug-paused");
        expect(cursor.run?.debug.stageIndex).toBe(stageIndex);
        expect(cursor.summary.revision).toBe(0);
        if (stageIndex === 2) {
          expect(provider.requests.length).toBeGreaterThan(bootstrapRequestCount);
          expect(host.inspectorModelInvocations(created.summary.id, { sort: "stage" }).items)
            .toContainEqual(expect.objectContaining({ logicalStageIndex: 1 }));
        }
      }

      const committed = await host.advanceDebugStep(created.summary.id, {
        runId: cursor.run!.id,
        generation: cursor.run!.generation,
        checkpointId: cursor.run!.debug.checkpointId!,
        requestId: "debug-next-commit",
      });
      expect(committed.summary.revision).toBe(0);
      const completed = await waitForRevision(host, created.summary.id, 1);
      expect(completed.summary.revision).toBe(1);
      const persisted = database.readInstance(created.summary.id).document;
      const executionId = persisted.runs[completed.run!.id]!.executionIds.at(-1)!;
      const requestCountBeforeReplay = provider.requests.length;
      const stateHashBeforeReplay = contentHash(persisted.state);
      const replay = host.inspectorReplay(created.summary.id, executionId);
      expect(replay).toMatchObject({ source: "checkpoint", executionId });
      expect(replay.frames).toHaveLength(10);
      expect(provider.requests).toHaveLength(requestCountBeforeReplay);
      expect(contentHash(database.readInstance(created.summary.id).document.state)).toBe(stateHashBeforeReplay);
    } finally {
      database.close();
    }
  }, 30_000);

  it("invalidates a damaged debug checkpoint instead of releasing the stage gate", async () => {
    const { database, host } = harness();
    try {
      const created = await host.createInstance(observerStart);
      await host.setDebugMode(created.summary.id, {
        enabled: true,
        expectedRevision: created.summary.revision,
      });
      const started = await host.advance(created.summary.id, {
        expectedRevision: created.summary.revision,
        trigger: "manual",
        steps: 1,
      });
      const paused = started.run?.status === "debug-paused"
        ? started
        : await waitForRunStatus(host, created.summary.id, "debug-paused");
      const stored = database.readInstance(created.summary.id);
      const damaged = structuredClone(stored.document);
      damaged.runs[paused.run!.id]!.debugCheckpoint!.artifactHash = "missing-debug-checkpoint";
      database.compareAndSwapInstance(created.summary.id, stored.generation, damaged);

      await expect(host.advanceDebugStep(created.summary.id, {
        runId: paused.run!.id,
        generation: paused.run!.generation,
        checkpointId: paused.run!.debug.checkpointId!,
        requestId: "damaged-checkpoint-next",
      })).rejects.toThrow("debug checkpoint artifact is missing");
      expect(host.instance(created.summary.id)).toMatchObject({
        summary: { revision: 0 },
        run: { status: "preparation-invalidated", stopReason: "debug-checkpoint-invalid" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      database.close();
    }
  }, 30_000);

  it("accepts a new participant action after a stale invalidated debug run", async () => {
    const { database, host } = harness();
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0]!;
      await host.setDebugMode(created.summary.id, {
        enabled: true,
        expectedRevision: created.summary.revision,
      });
      await host.submitAction(created.summary.id, participant.id, {
        submissionId: "first-debug-action",
        expectedRevision: created.summary.revision,
        text: "观察石门。",
      });
      const paused = await waitForRunStatus(host, created.summary.id, "debug-paused");
      const stored = database.readInstance(created.summary.id);
      const invalidated = structuredClone(stored.document);
      const run = invalidated.runs[paused.run!.id]!;
      run.status = "preparation-invalidated";
      run.stopReason = "debug-checkpoint-invalid";
      run.lease = null;
      run.error = "debug checkpoint continuation runtime does not match";
      if (!invalidated.actionWindow || invalidated.actionWindow.kind !== "decision") {
        throw new Error("expected the discarded debug run to own a decision window");
      }
      invalidated.actionWindow.status = "resolving";
      database.compareAndSwapInstance(created.summary.id, stored.generation, invalidated);

      const retried = await host.submitAction(created.summary.id, participant.id, {
        submissionId: "second-debug-action",
        expectedRevision: created.summary.revision,
        text: "沿着仓库外墙走一圈。",
      });
      expect(retried.summary.runStatus).toBe("queued");
      expect(retried.actionWindow).toMatchObject({ kind: "decision" });
      expect(retried.actionWindow?.submittedAgentIds).toContain(participant.agentId);
      const retriedPaused = await waitForRunStatus(host, created.summary.id, "debug-paused");
      expect(retriedPaused.summary.revision).toBe(created.summary.revision);
    } finally {
      database.close();
    }
  }, 30_000);

  it("recovers a debug continuation from recorded stage outputs after process restart", async () => {
    const { database, host, provider, repository } = harness();
    let reopened: LocalDatabase | undefined;
    try {
      const created = await host.createInstance(observerStart);
      await host.setDebugMode(created.summary.id, {
        enabled: true,
        expectedRevision: created.summary.revision,
      });
      await host.advance(created.summary.id, {
        expectedRevision: created.summary.revision,
        trigger: "manual",
        steps: 1,
      });
      const stageOne = await waitForRunStatus(host, created.summary.id, "debug-paused");
      await host.advanceDebugStep(created.summary.id, {
        runId: stageOne.run!.id,
        generation: stageOne.run!.generation,
        checkpointId: stageOne.run!.debug.checkpointId!,
        requestId: "before-restart-stage-one",
      });
      const stageTwo = await waitForRunStatus(host, created.summary.id, "debug-paused");
      expect(stageTwo.run?.debug.stageIndex).toBe(1);
      await host.advanceDebugStep(created.summary.id, {
        runId: stageTwo.run!.id,
        generation: stageTwo.run!.generation,
        checkpointId: stageTwo.run!.debug.checkpointId!,
        requestId: "before-restart-stage-two",
      });
      const stageThree = await waitForRunStatus(host, created.summary.id, "debug-paused");
      expect(stageThree.run?.debug.stageIndex).toBe(2);
      const liveRequestCount = provider.requests.length;
      const sourceExecutionId = database.readInstance(created.summary.id).document
        .runs[stageThree.run!.id]!.debugCheckpoint!.executionId;
      const sourceEvents = database.executionEvents(sourceExecutionId);
      expect(debugCheckpointReplayValidationError(sourceEvents, 1)).toBeNull();
      const damagedEvents = structuredClone(sourceEvents);
      const recordedOutput = damagedEvents.find((event) => event.event === "model.structured_output.parsed");
      expect(recordedOutput).toBeDefined();
      recordedOutput!.payload = { tampered: true };
      expect(debugCheckpointReplayValidationError(damagedEvents, 1))
        .toBe("debug checkpoint contains invalid recorded model continuation evidence");

      const databaseFile = database.file;
      database.close();
      reopened = new LocalDatabase(databaseFile, { heartbeat: false });
      const recoveredHost = new WorldHost({
        repository,
        store: reopened,
        ledger: reopened,
        provider,
      });
      const recovered = recoveredHost.instance(created.summary.id);
      expect(recovered.run).toMatchObject({
        status: "debug-paused",
        debug: { stageIndex: 2, canAdvance: true },
      });
      await recoveredHost.advanceDebugStep(created.summary.id, {
        runId: recovered.run!.id,
        generation: recovered.run!.generation,
        checkpointId: recovered.run!.debug.checkpointId!,
        requestId: "after-restart-stage-two",
      });
      const stageFour = await waitForRunStatus(recoveredHost, created.summary.id, "debug-paused");
      expect(stageFour.run?.debug.stageIndex).toBe(3);
      expect(stageFour.summary.revision).toBe(0);
      expect(provider.requests).toHaveLength(liveRequestCount);
      expect(reopened.execution(sourceExecutionId)?.status).toBe("failed");
    } finally {
      reopened?.close();
      database.close();
    }
  }, 30_000);

  it("creates Origin admission and Arrival with the instance and no orphan shell", async () => {
    const { database, host, provider } = harness();
    try {
      const created = await host.createInstance(originStart);
      expect(created.summary).toMatchObject({ revision: 1, participantCount: 1 });
      expect(created.controlledView).toMatchObject({
        agentId: "courtyard-wanderer-1",
        self: { name: "小明", location: { name: "石门前庭" } },
      });
      expect(created.conversation?.turns).toHaveLength(1);
      expect(created.conversation?.turns[0]).toMatchObject({
        status: "committed",
        response: { possibleNextActions: expect.any(Array) },
      });
      const stored = database.readInstance(created.summary.id).document;
      expect(stored.schemaVersion).toBe(23);
      expect(stored.experimentEnrollment).toBeNull();
      expect(stored.executionAlgorithm).toMatchObject({
        id: "eager-reference",
        version: "21",
        contractVersion: 7,
        config: {},
        children: {
          actionCompilation: {
            role: "action-compilation",
            children: { candidateSelection: { role: "candidate-selection", id: "full-catalog" } },
          },
        },
      });
      expect(stored.state.admissions).toHaveLength(1);
      expect(Object.values(stored.state.truth.meters)).toContainEqual(expect.objectContaining({
        entityId: "courtyard-wanderer-1",
        definitionId: "health",
        current: 20,
      }));
      expect(Object.values(stored.state.truth.ratings)).toContainEqual(expect.objectContaining({
        entityId: "courtyard-wanderer-1",
        definitionId: "resolve",
        value: 1,
      }));
      expect(Object.values(stored.state.truth.quantities)).toContainEqual(expect.objectContaining({
        holderId: "courtyard-wanderer-1",
        definitionId: "spirit-stone",
        amount: 1,
      }));
      expect(stored.participants[created.participants[0].id].arrival.scene).toBeTruthy();
      const manifests = database.executions({ instanceId: created.summary.id }).map((execution) => execution.manifest);
      expect(manifests).toContainEqual(expect.objectContaining({ kind: "algorithm", id: "eager-reference" }));
      expect(manifests).toContainEqual(expect.objectContaining({ kind: "engine-operation", id: "arrival-generator" }));
      expect(stored.policyBindings["courtyard-wanderer-1"]).toMatchObject({ kind: "external" });
      const arrivalRequest = provider.requests.find((request) => request.role === "arrival-generator");
      expect(arrivalRequest).toMatchObject({
        promptVersion: promptBundle("arrival-generator").version,
        context: {
          contractVersion: 17,
          roleContract: expect.objectContaining({ role: "arrival-generator" }),
          task: expect.objectContaining({ assignment: expect.any(Object) }),
          state: { perspective: expect.objectContaining({ agentRef: "ref:agent:courtyard-wanderer-1" }) },
          referenceCatalog: expect.objectContaining({ version: 2 }),
        },
      });
    } finally {
      database.close();
    }
  }, 30_000);

  it("turns one player message into exactly one advance and projects the durable conversation", async () => {
    const { database, host, provider } = harness();
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0];
      const accepted = await host.submitAction(created.summary.id, participant.id, {
        submissionId: "message-1",
        expectedRevision: created.summary.revision,
        text: "我观察石门和守门人。",
      });
      expect(accepted.summary.revision).toBe(created.summary.revision);
      expect(accepted.summary.runStatus).toBe("queued");
      const committed = await waitForRevision(host, created.summary.id, created.summary.revision + 1);
      expect(committed.actionWindow).not.toBeNull();
      expect(committed.conversation?.turns).toHaveLength(2);
      expect(committed.conversation?.turns[1]).toMatchObject({
        status: "committed",
        action: { submissionId: "message-1", text: "我观察石门和守门人。" },
        response: { text: expect.any(String) },
      });
      // The keeper's admission action is provably unaffected by the new
      // player's arrival, so the preparation resume wave is skipped. The
      // ordinary post-resolution mind update still runs once.
      expect(provider.requests.filter((request) => request.role === "agent-mind")).toHaveLength(1);
      const duplicate = await host.submitAction(created.summary.id, participant.id, {
        submissionId: "message-1",
        expectedRevision: created.summary.revision,
        text: "我观察石门和守门人。",
      });
      expect(duplicate.summary.revision).toBe(committed.summary.revision);
      expect(database.readInstance(created.summary.id).document.participantIntents).toHaveLength(1);
    } finally {
      database.close();
    }
  }, 30_000);

  it("persists a private reaction window and completes it in a child execution", async () => {
    const { database, host } = reactionHarness();
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0]!;
      await host.submitAction(created.summary.id, participant.id, {
        submissionId: "start-long-travel",
        expectedRevision: created.summary.revision,
        text: "我沿道路走向100公里外的城镇。",
      });

      const waiting = await waitForRunStatus(host, created.summary.id, "awaiting-reaction");
      expect(waiting.summary.revision).toBe(created.summary.revision + 1);
      expect(waiting.actionWindow).toMatchObject({
        kind: "reaction",
        baseRevision: waiting.summary.revision,
        submittedAgentIds: [],
        reaction: {
          preparedStepId: expect.any(String),
          stimulus: expect.any(String),
        },
      });
      const storedWaiting = database.readInstance(created.summary.id).document;
      const window = storedWaiting.actionWindow;
      if (!window || window.kind !== "reaction") throw new Error("reaction window was not persisted");
      const preparation = database.artifact(window.preparationArtifactHash);
      expect(preparation).toMatchObject({
        executionId: window.preparationExecutionId,
        value: { id: window.preparedStepId },
      });
      expect(database.execution(window.preparationExecutionId)).toMatchObject({ status: "succeeded" });
      expect(database.execution(window.preparationExecutionId)?.commitRevision).toBeUndefined();
      expect(Object.values(window.requests)[0]).toMatchObject({
        agentId: participant.agentId,
        originalIntent: { kind: "ongoing_activity" },
        basis: expect.any(Array),
      });
      expect(waiting.actionWindow).not.toHaveProperty("basis");
      expect(host.instance(created.summary.id, "observer-without-control").actionWindow).toMatchObject({
        kind: "reaction",
        requiredAgentIds: [],
        submittedAgentIds: [],
      });
      expect(host.instance(created.summary.id, "observer-without-control").actionWindow)
        .not.toHaveProperty("reaction");

      await expect(host.submitReaction(created.summary.id, participant.id, {
        submissionId: "stale-reaction",
        windowId: window.id,
        generation: window.generation + 1,
        preparedStepId: window.preparedStepId,
        expectedRevision: waiting.summary.revision,
        kind: "keep",
      })).rejects.toMatchObject({ status: 409 });

      await host.submitReaction(created.summary.id, participant.id, {
        submissionId: "keep-travelling",
        windowId: window.id,
        generation: window.generation,
        preparedStepId: window.preparedStepId,
        expectedRevision: waiting.summary.revision,
        kind: "keep",
      });
      const committed = await waitForRevision(host, created.summary.id, waiting.summary.revision + 1);
      expect(committed.summary.revision).toBe(waiting.summary.revision + 1);
      const children = database.executions({ parentExecutionId: window.preparationExecutionId });
      expect(children).toContainEqual(expect.objectContaining({
        status: "succeeded",
        commitRevision: committed.summary.revision,
      }));
      expect(database.readInstance(created.summary.id).document.reactionSubmissions)
        .toContainEqual(expect.objectContaining({
          submissionId: "keep-travelling",
          preparedStepId: window.preparedStepId,
          kind: "keep",
        }));
      const playerActivity = Object.values(database.readInstance(created.summary.id).document.state.truth.activities)
        .find((activity) => activity.actorId === participant.agentId &&
          activity.status !== "queued" && activity.status !== "ready" && activity.plan.mode === "rate")!;
      expect(playerActivity.status).toBe("active");
    } finally {
      database.close();
    }
  }, 30_000);

  it("invalidates a missing preparation without mutation and retries only on explicit resume", async () => {
    const { database, host, provider, repository } = reactionHarness();
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0]!;
      await host.submitAction(created.summary.id, participant.id, {
        submissionId: "travel-before-corruption",
        expectedRevision: created.summary.revision,
        text: "我沿道路走向100公里外的城镇。",
      });
      const waiting = await waitForRunStatus(host, created.summary.id, "awaiting-reaction");
      const stored = database.readInstance(created.summary.id);
      const corrupted = structuredClone(stored.document);
      const oldWindow = corrupted.actionWindow;
      if (!oldWindow || oldWindow.kind !== "reaction") throw new Error("reaction window was not persisted");
      oldWindow.preparationArtifactHash = "missing-preparation-artifact";
      database.compareAndSwapInstance(created.summary.id, stored.generation, corrupted);

      await host.submitReaction(created.summary.id, participant.id, {
        submissionId: "keep-after-corruption",
        windowId: oldWindow.id,
        generation: oldWindow.generation,
        preparedStepId: oldWindow.preparedStepId,
        expectedRevision: waiting.summary.revision,
        kind: "keep",
      });
      const invalidated = await waitForRunStatus(host, created.summary.id, "preparation-invalidated");
      expect(invalidated.summary.revision).toBe(waiting.summary.revision);
      expect(invalidated.actionWindow).toBeNull();
      const invalidatedRun = database.readInstance(created.summary.id).document.runs[invalidated.run!.id]!;
      expect(invalidatedRun).toMatchObject({
        status: "preparation-invalidated",
        stopReason: "step-preparation-invalidated",
        error: expect.stringContaining("no longer matches"),
      });

      const callsBeforeRestart = provider.requests.length;
      const recoveredHost = new WorldHost({
        repository,
        store: database,
        ledger: database,
        provider,
      });
      expect(recoveredHost.instance(created.summary.id).run?.status).toBe("preparation-invalidated");
      expect(provider.requests).toHaveLength(callsBeforeRestart);

      await recoveredHost.resumeRun(created.summary.id, {
        runId: invalidated.run!.id,
        generation: invalidated.run!.generation,
      });
      const retried = await waitForRunStatus(recoveredHost, created.summary.id, "awaiting-reaction");
      expect(retried.summary.revision).toBe(waiting.summary.revision);
      expect(retried.actionWindow).toMatchObject({ kind: "reaction" });
      expect(retried.actionWindow?.id).not.toBe(oldWindow.id);
      expect(provider.requests.length).toBeGreaterThan(callsBeforeRestart);
    } finally {
      database.close();
    }
  }, 30_000);

  it("retains a submitted reaction across restart and completes only after explicit resume", async () => {
    const { database, host, provider, repository } = reactionHarness();
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0]!;
      await host.submitAction(created.summary.id, participant.id, {
        submissionId: "travel-before-restart",
        expectedRevision: created.summary.revision,
        text: "我沿道路走向100公里外的城镇。",
      });
      const waiting = await waitForRunStatus(host, created.summary.id, "awaiting-reaction");
      const stored = database.readInstance(created.summary.id);
      const interrupted = structuredClone(stored.document);
      const window = interrupted.actionWindow;
      if (!window || window.kind !== "reaction") throw new Error("reaction window was not persisted");
      const run = Object.values(interrupted.runs)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0]!;
      const request = window.requests[participant.agentId]!;
      window.submissions[participant.agentId] = {
        submissionId: "keep-before-restart",
        requestId: request.id,
        agentId: participant.agentId,
        kind: "keep",
      };
      run.status = "queued";
      run.stopReason = null;
      run.lease = null;
      run.generation += 1;
      database.compareAndSwapInstance(created.summary.id, stored.generation, interrupted);

      const recoveredHost = new WorldHost({
        repository,
        store: database,
        ledger: database,
        provider,
      });
      const recovered = recoveredHost.instance(created.summary.id);
      expect(recovered).toMatchObject({
        summary: { revision: waiting.summary.revision },
        run: { status: "paused" },
        actionWindow: { kind: "reaction", submittedAgentIds: [participant.agentId] },
      });
      await recoveredHost.resumeRun(created.summary.id, {
        runId: recovered.run!.id,
        generation: recovered.run!.generation,
      });
      const committed = await waitForRevision(
        recoveredHost,
        created.summary.id,
        waiting.summary.revision + 1,
      );
      expect(committed.summary.revision).toBe(waiting.summary.revision + 1);
      expect(database.readInstance(created.summary.id).document.state.history.at(-1)?.reactionDecisions)
        .toContainEqual(expect.objectContaining({
          requestId: request.id,
          source: "external",
          kind: "keep",
        }));
    } finally {
      database.close();
    }
  }, 30_000);

  it("applies the Activity profile fallback when an external reaction times out", async () => {
    let now = new Date("2026-08-28T12:00:00.000Z");
    let timerOrdinal = 0;
    const timers = new Map<number, { callback: () => void | Promise<void>; delayMs: number }>();
    const { database, host } = reactionHarness({
      now: () => now,
      actionWindowMs: 100,
      reactionFallback: "pause",
      setTimer: (callback, delayMs) => {
        const id = ++timerOrdinal;
        timers.set(id, { callback, delayMs });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    });
    const runNext = async (predicate: (entry: { delayMs: number }) => boolean) => {
      const entry = [...timers.entries()].find(([, value]) => predicate(value));
      if (!entry) throw new Error("expected scheduled callback was not found");
      timers.delete(entry[0]);
      await entry[1].callback();
    };
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0]!;
      await host.submitAction(created.summary.id, participant.id, {
        submissionId: "travel-until-reaction-timeout",
        expectedRevision: created.summary.revision,
        text: "我沿道路走向100公里外的城镇。",
      });
      await runNext(({ delayMs }) => delayMs === 0);
      const waiting = host.instance(created.summary.id);
      expect(waiting.run?.status).toBe("awaiting-reaction");
      const requestId = waiting.actionWindow?.reaction?.requestId;
      expect(requestId).toBeTruthy();

      now = new Date(now.getTime() + 100);
      await runNext(({ delayMs }) => delayMs > 0);
      await runNext(({ delayMs }) => delayMs === 0);
      const committed = host.instance(created.summary.id);
      expect(committed.summary.revision).toBe(waiting.summary.revision + 1);
      const boundary = database.readInstance(created.summary.id).document.state.history
        .find((step) => step.revision === committed.summary.revision)!;
      expect(boundary.reactionDecisions).toContainEqual(expect.objectContaining({
        requestId,
        source: "profile_fallback",
        kind: "keep",
        ongoingActivityDisposition: "pause",
      }));
      const playerActivity = Object.values(boundary.temporalState.activities)
        .find((activity) => activity.actorId === participant.agentId &&
          activity.status !== "queued" && activity.status !== "ready" && activity.plan.mode === "rate")!;
      expect(playerActivity.status).toBe("paused");
      expect(boundary.decisionPoints).toContainEqual(expect.objectContaining({
        agentId: participant.agentId,
        activityId: playerActivity.id,
        reason: "activity_interrupted",
      }));
    } finally {
      database.close();
    }
  }, 30_000);

  it("collects two external policies in one ActionWindow", async () => {
    const { database, host } = harness({ maxParticipants: 2 });
    try {
      const firstView = await host.createInstance(originStart, "principal-a");
      const secondView = await host.transferControl(firstView.summary.id, {
        expectedRevision: firstView.summary.revision,
        target: { kind: "agent", agentId: "keeper" },
      }, "principal-b");
      const first = firstView.participants[0];
      const second = secondView.participants.find((participant) => participant.agentId === "keeper")!;

      const waiting = await host.submitAction(firstView.summary.id, first.id, {
        submissionId: "submission-a",
        expectedRevision: firstView.summary.revision,
        text: "观察石门。",
      }, "principal-a");
      expect(waiting.summary.revision).toBe(firstView.summary.revision);
      expect(waiting.actionWindow?.submittedAgentIds).toEqual(["courtyard-wanderer-1"]);

      const accepted = await host.submitAction(firstView.summary.id, second.id, {
        submissionId: "submission-b",
        expectedRevision: firstView.summary.revision,
        text: "继续看守石门。",
      }, "principal-b");
      expect(accepted.summary.revision).toBe(firstView.summary.revision);
      const committed = await waitForRevision(host, firstView.summary.id, firstView.summary.revision + 1);
      expect(committed.actionWindow).not.toBeNull();
      const stored = database.readInstance(firstView.summary.id).document;
      expect(stored.participantIntents).toHaveLength(2);
      expect(Object.values(stored.runs)).toHaveLength(2);
    } finally {
      database.close();
    }
  }, 30_000);

  it("atomically detaches and takes over any free living Agent", async () => {
    const { database, host } = harness();
    try {
      const created = await host.createInstance(originStart);
      const detached = await host.transferControl(created.summary.id, {
        expectedRevision: created.summary.revision,
        target: { kind: "observer" },
      });
      expect(detached.controlledView).toBeUndefined();
      const releasedPerspective = host.observer(created.summary.id, "courtyard-wanderer-1");
      expect(releasedPerspective.agents.map((agent) => agent.id)).toContain("keeper");
      expect(releasedPerspective.selected?.perspective).toEqual(created.controlledView);
      expect(database.readInstance(created.summary.id).document.policyBindings["courtyard-wanderer-1"])
        .toMatchObject({ kind: "model", resumeFromRevision: created.summary.revision });

      const keeperPerspective = host.observer(created.summary.id, "keeper").selected?.perspective;
      const taken = await host.transferControl(created.summary.id, {
        expectedRevision: detached.summary.revision,
        target: { kind: "agent", agentId: "keeper" },
      });
      expect(taken.controlledView?.agentId).toBe("keeper");
      expect(taken.controlledView).toEqual(keeperPerspective);
      expect(taken.conversation?.turns[0].response?.text).toBeTruthy();
      const stored = database.readInstance(created.summary.id).document;
      expect(Object.values(stored.participants).filter((participant) => participant.status === "active")).toHaveLength(1);
      expect(stored.policyBindings.keeper).toMatchObject({ kind: "external" });
    } finally {
      database.close();
    }
  }, 30_000);

  it("detaches at an open external decision boundary without mutating world time", async () => {
    const { database, host } = harness();
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0];
      await host.submitAction(created.summary.id, participant.id, {
        submissionId: "act-before-detach",
        expectedRevision: created.summary.revision,
        text: "我确认当前位置。",
      });
      const committed = await waitForRevision(host, created.summary.id, created.summary.revision + 1);
      expect(committed.actionWindow).not.toBeNull();
      expect(committed.run).toMatchObject({ status: "awaiting-decision" });
      const elapsedSeconds = committed.summary.elapsedSeconds;

      const detached = await host.transferControl(committed.summary.id, {
        expectedRevision: committed.summary.revision,
        target: { kind: "observer" },
      });

      expect(detached.controlledView).toBeUndefined();
      expect(detached.actionWindow).toBeNull();
      expect(detached.summary).toMatchObject({
        revision: committed.summary.revision,
        elapsedSeconds,
      });
      expect(detached.run).toMatchObject({ status: "completed", stopReason: "control-transferred" });
      expect(host.observer(created.summary.id).agents.map((agent) => agent.id)).toContain("keeper");
      validateWorldInstanceDocument(database.readInstance(created.summary.id).document);
    } finally {
      database.close();
    }
  }, 30_000);

  it("fences stale realtime callbacks and schedules only after commit", async () => {
    let now = new Date("2026-08-27T00:00:00.000Z");
    let timerId = 0;
    const timers = new Map<number, () => void | Promise<void>>();
    const { database, host } = harness({
      now: () => now,
      setTimer: (callback) => {
        const id = ++timerId;
        timers.set(id, async () => { timers.delete(id); await callback(); });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    });
    try {
      const created = await host.createInstance(observerStart);
      await host.setRealtime(created.summary.id, true);
      const stale = timers.get(timerId)!;
      await host.setRealtime(created.summary.id, false);
      await host.setRealtime(created.summary.id, true);
      const active = timers.get(timerId)!;
      await stale();
      expect(database.readInstance(created.summary.id).document.state.revision).toBe(0);
      now = new Date("2026-08-27T00:01:00.000Z");
      await active();
      expect(database.readInstance(created.summary.id).document.state.revision).toBe(1);
    } finally {
      database.close();
    }
  }, 30_000);

  it("pauses a queued run, fences its stale callback, and resumes with a new generation", async () => {
    let timerId = 0;
    const timers = new Map<number, () => void | Promise<void>>();
    const { database, host } = harness({
      setTimer: (callback) => {
        const id = ++timerId;
        timers.set(id, async () => { timers.delete(id); await callback(); });
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    });
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0];
      const accepted = await host.submitAction(created.summary.id, participant.id, {
        submissionId: "pause-me",
        expectedRevision: created.summary.revision,
        text: "观察石门。",
      });
      const stale = timers.get(timerId)!;
      const paused = await host.pauseRun(created.summary.id, {
        runId: accepted.run!.id,
        generation: accepted.run!.generation,
      });
      expect(paused.run).toMatchObject({ status: "paused", stopReason: "user-paused" });
      expect(paused.summary.revision).toBe(created.summary.revision);

      await stale();
      expect(host.instance(created.summary.id).summary.revision).toBe(created.summary.revision);
      const resumed = await host.resumeRun(created.summary.id, {
        runId: paused.run!.id,
        generation: paused.run!.generation,
      });
      expect(resumed.run).toMatchObject({ status: "queued" });
      const active = timers.get(timerId)!;
      await active();
      const committed = host.instance(created.summary.id);
      expect(committed.summary.revision).toBe(created.summary.revision + 1);
      expect(database.readInstance(created.summary.id).document.state.revision).toBe(committed.summary.revision);
    } finally {
      database.close();
    }
  }, 30_000);

  it("pauses at the dual-budget boundary and resumes with a fresh lease", async () => {
    const { database, host } = harness({ runLeaseMaxCommits: 1 });
    try {
      const created = await host.createInstance(observerStart);
      const first = await host.advance(created.summary.id, {
        expectedRevision: created.summary.revision,
        trigger: "batch",
        steps: 10,
      });
      expect(first.summary.revision).toBe(1);
      expect(first.run).toMatchObject({ status: "budget-paused", stopReason: "commit-budget-exhausted" });
      const firstLeaseStartedAt = first.run!.lease!.startedAt;
      const resumed = await host.resumeRun(created.summary.id, {
        runId: first.run!.id,
        generation: first.run!.generation,
      });
      expect(resumed.run).toMatchObject({ status: "queued", lease: null });
      const second = await waitForRevision(host, created.summary.id, 2);
      expect(second.run).toMatchObject({ status: "budget-paused" });
      expect(second.run!.lease!.startedAt).not.toBeUndefined();
      expect(second.run!.lease!.commitCount).toBe(1);
      expect(database.readInstance(created.summary.id).document.runs[first.run!.id].committedRevisions)
        .toEqual([1, 2]);
      expect(firstLeaseStartedAt).toBeTruthy();
    } finally {
      database.close();
    }
  }, 30_000);

  it("turns an inherited running lease into process-recovered pause without a model call", async () => {
    const timers = new Map<number, () => void | Promise<void>>();
    let timerId = 0;
    const { database, host, provider, repository } = harness({
      setTimer: (callback) => {
        const id = ++timerId;
        timers.set(id, callback);
        return id as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimer: (timer) => { timers.delete(timer as unknown as number); },
    });
    try {
      const created = await host.createInstance(originStart);
      const participant = created.participants[0];
      const accepted = await host.submitAction(created.summary.id, participant.id, {
        submissionId: "recover-me",
        expectedRevision: created.summary.revision,
        text: "观察石门。",
      });
      const stored = database.readInstance(created.summary.id);
      const running = structuredClone(stored.document);
      const run = running.runs[accepted.run!.id];
      run.status = "running";
      run.lease = {
        id: "inherited-lease",
        generation: run.generation,
        startedAt: "2026-08-27T00:00:00.000Z",
        maxCommits: 100,
        maxWallTimeMs: 900_000,
        commitCount: 0,
      };
      if (running.actionWindow) running.actionWindow.status = "resolving";
      database.compareAndSwapInstance(created.summary.id, stored.generation, running);
      const executionsBefore = database.executions({ instanceId: created.summary.id }).length;

      const recoveredHost = new WorldHost({ repository, store: database, ledger: database, provider });
      const recovered = recoveredHost.instance(created.summary.id);
      expect(recovered.run).toMatchObject({ status: "paused", stopReason: "process-recovered", lease: null });
      expect(recovered.summary.revision).toBe(created.summary.revision);
      expect(database.executions({ instanceId: created.summary.id })).toHaveLength(executionsBefore);
    } finally {
      database.close();
    }
  }, 30_000);

  it("rejects corrupt schema, policy and window data", async () => {
    const { database, host } = harness();
    try {
      const created = await host.createInstance(observerStart);
      const source = database.readInstance(created.summary.id).document;
      const legacy = structuredClone(source);
      (legacy as unknown as { schemaVersion: number }).schemaVersion = 17;
      expect(() => validateWorldInstanceDocument(legacy)).toThrow("world instance schema v23 required");

      const missingExperimentDecision = structuredClone(source);
      missingExperimentDecision.experimentEnrollment = null;
      missingExperimentDecision.experimentExclusion = null;
      expect(() => validateWorldInstanceDocument(missingExperimentDecision)).toThrow("must record experiment enrollment or exclusion");

      const invalidPolicy = structuredClone(source);
      (invalidPolicy.policyBindings.player as { kind: string }).kind = "unknown";
      expect(() => validateWorldInstanceDocument(invalidPolicy)).toThrow("unknown kind");

      const invalidWindow = structuredClone(source);
      invalidWindow.actionWindow = {
        kind: "decision",
        id: "window",
        generation: 1,
        baseRevision: source.state.revision,
        requiredAgentIds: ["player", "player"],
        submissions: {},
        deadlineAt: null,
        status: "open",
      };
      expect(() => validateWorldInstanceDocument(invalidWindow)).toThrow("duplicate required Agents");
    } finally {
      database.close();
    }
  });

  it("restores a non-default eager-reference configuration after host restart", async () => {
    const setup = harness();
    try {
      const configured = eagerReferenceAlgorithmRef({
        actionCompilationMaxSlots: 3,
        agentMindMaxSlots: 2,
        reactionMaxSlots: 8,
        groundingMaxSlots: 16,
        truthBatchMaxSlots: 12,
        candidateRetrieval: { mode: "off" },
      });
      const created = await setup.host.createInstance(observerStart, "local", configured);
      expect(setup.database.readInstance(created.summary.id).document.executionAlgorithm).toEqual(configured);

      const recovered = new WorldHost({
        repository: setup.repository,
        store: setup.database,
        ledger: setup.database,
        provider: setup.provider,
      });
      await recovered.advance(created.summary.id, {
        expectedRevision: created.summary.revision,
        trigger: "manual",
      });

      expect(setup.database.readInstance(created.summary.id).document.executionAlgorithm).toEqual(configured);
      expect(setup.database.executions({ instanceId: created.summary.id })
        .every((execution) => execution.manifest.hash === configured.manifestHash)).toBe(true);
    } finally {
      setup.database.close();
    }
  });

  it("persists immutable experiment enrollment when an eligible experiment is active", async () => {
    const provider = new DeterministicModelProvider(createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    const experiments = new AlgorithmExperimentRegistry(algorithms);
    const treatment = eagerReferenceAlgorithmRef({ ...FULL_CATALOG_EAGER_REFERENCE_CONFIG, actionCompilationMaxSlots: 1 });
    const manifest = defineAlgorithmExperimentManifest({
      id: "world-execution-fixture",
      version: "1",
      salt: "fixture",
      eligibility: { worldContentHashes: [definition.contentHash] },
      variants: [
        { id: "control", allocationBasisPoints: 7_000, algorithmRef: FULL_CATALOG_ALGORITHM_REF },
        { id: "treatment", allocationBasisPoints: 3_000, algorithmRef: treatment },
      ],
      activationEvidence: { artifactHash: `sha256:${"1".repeat(64)}`, verifier: "fixture" },
    });
    experiments.register(manifest);
    experiments.activate(manifest.id, manifest.version);
    let selectedInstanceId = "";
    for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
      const candidate = `experiment-instance-${ordinal}`;
      if (experiments.enrollment({
        instanceId: candidate,
        worldContentHash: definition.contentHash,
        defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
        explicitExecutionTuning: false,
      }).enrollment?.variantId === "treatment") {
        selectedInstanceId = candidate;
        break;
      }
    }
    expect(selectedInstanceId).not.toBe("");
    const setup = harness({
      algorithmRegistry: algorithms,
      experimentRegistry: experiments,
      idFactory: () => selectedInstanceId,
    });
    try {
      const created = await setup.host.createInstance(observerStart);
      const stored = setup.database.readInstance(created.summary.id).document;
      expect(stored.experimentEnrollment).toMatchObject({
        experimentId: manifest.id,
        experimentVersion: manifest.version,
        experimentManifestHash: manifest.hash,
        bucket: expect.any(Number),
        variantId: "treatment",
      });
      expect(stored.experimentExclusion).toBeNull();
      experiments.validateEnrollment(stored.id, stored.experimentEnrollment!);
    } finally {
      setup.database.close();
    }
  });

  it("stops new enrollment when a retrieval treatment has no runtime dependencies", async () => {
    const provider = new DeterministicModelProvider(createTestModelCatalog(undefined, { maxInputBytes: 1_048_576 }));
    const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 47, modelCatalog: provider.catalog });
    const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
    const treatment = eagerReferenceAlgorithmRef({
      ...DEFAULT_EAGER_REFERENCE_CONFIG,
    });
    const experiments = new AlgorithmExperimentRegistry(algorithms);
    const manifest = defineAlgorithmExperimentManifest({
      id: "missing-treatment-dependencies",
      version: "1",
      salt: "fixture",
      eligibility: { worldContentHashes: [definition.contentHash] },
      variants: [
        { id: "control", allocationBasisPoints: 7_000, algorithmRef: FULL_CATALOG_ALGORITHM_REF },
        { id: "treatment", allocationBasisPoints: 3_000, algorithmRef: treatment },
      ],
      activationEvidence: { artifactHash: `sha256:${"1".repeat(64)}`, verifier: "fixture" },
    });
    experiments.register(manifest);
    experiments.activate(manifest.id, manifest.version);
    let treatmentInstanceId = "";
    for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
      const candidate = `missing-runtime-instance-${ordinal}`;
      if (experiments.enrollment({
        instanceId: candidate,
        worldContentHash: definition.contentHash,
        defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
        explicitExecutionTuning: false,
      }).enrollment?.variantId === "treatment") {
        treatmentInstanceId = candidate;
        break;
      }
    }
    expect(treatmentInstanceId).not.toBe("");
    const setup = harness({
      algorithmRegistry: algorithms,
      experimentRegistry: experiments,
      idFactory: () => treatmentInstanceId,
    });
    try {
      await expect(setup.host.createInstance(observerStart)).rejects.toThrow("candidate retrieval dependencies are missing");
      expect(experiments.enrollmentStatus()).toMatchObject({ stopped: true });
      expect(setup.database.listInstances()).toHaveLength(0);
    } finally {
      setup.database.close();
    }
  });

  it("pins the selected algorithm across hosts and records the actual producer", async () => {
    const customManifest = defineAlgorithmManifest({
      id: "wrapped-eager",
      version: "1",
      config: {},
      children: {},
    });
    class WrappedEager implements WorldExecutionAlgorithm {
      readonly manifest = customManifest;
      constructor(private readonly delegate: EagerReferenceAlgorithm) {}
      bootstrap(input: Readonly<BootstrapInput>, context: ExecutionContext): Promise<BootstrapCandidate> {
        return this.delegate.bootstrap(input, context);
      }
      prepareStep(input: Readonly<WorldStepInput>, context: ExecutionContext) {
        return this.delegate.prepareStep(input, context);
      }
      completeStep(
        input: Readonly<WorldStepInput>,
        preparation: Readonly<import("../../engine/runtime/execution").WorldStepPreparation>,
        reactions: readonly import("../../engine/runtime/execution").ExternalReactionInput[],
        context: ExecutionContext,
      ): Promise<WorldStepCandidate> {
        return this.delegate.completeStep(input, preparation, reactions, context);
      }
    }
    const registry = new WorldExecutionAlgorithmRegistry();
    registry.register(customManifest, (services) =>
      new WrappedEager(new EagerReferenceAlgorithm(services.provider, services.rulePackages)));
    const setup = harness({ algorithmRegistry: registry, defaultAlgorithmRef: algorithmRef(customManifest) });
    try {
      const created = await setup.host.createInstance(observerStart);
      const stored = setup.database.readInstance(created.summary.id).document;
      expect(stored.executionAlgorithm).toEqual(algorithmRef(customManifest));

      const storedHash = contentHash(stored);
      expect(() => new WorldHost({
          repository: setup.repository,
          store: setup.database,
          ledger: setup.database,
          provider: setup.provider,
        }))
        .toThrow("execution algorithm is not registered: wrapped-eager@1");
      expect(contentHash(setup.database.readInstance(created.summary.id).document)).toBe(storedHash);

      const recovered = new WorldHost({
        repository: setup.repository,
        store: setup.database,
        ledger: setup.database,
        provider: setup.provider,
        algorithmRegistry: registry,
      });
      await recovered.advance(created.summary.id, {
        expectedRevision: created.summary.revision,
        trigger: "manual",
      });
      expect(setup.database.executions({ instanceId: created.summary.id })
        .map((execution) => execution.manifest)).toEqual([
        expect.objectContaining({ kind: "algorithm", id: "wrapped-eager", version: "1" }),
        expect.objectContaining({ kind: "algorithm", id: "wrapped-eager", version: "1" }),
      ]);
    } finally {
      setup.database.close();
    }
  });
});
