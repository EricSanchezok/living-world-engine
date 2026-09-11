import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeterministicModelProvider } from "../../../engine/testing/model-provider";
import { FULL_CATALOG_ALGORITHM_REF } from "../../../engine/algorithms/registry";
import { ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION } from "../../../engine/algorithms/eager-reference/candidate-retrieval/runtime";
import { contentHash } from "../../../engine/models/model-audit";
import type { ModelRegistryDiagnostics } from "../../../engine/models/model-provider";
import { loadWorldScript } from "../../../script/world-loader";
import { MemoryWorldRepository } from "../../../script/world-repository";
import { LocalDatabase } from "../../../server/local-database";
import { WorldHost } from "../../../server/world-host";
import { POST as advanceInstance } from "../instances/[id]/advance/route";
import { GET as getInstanceEvents } from "../instances/[id]/events/route";
import { POST as submitAction } from "../instances/[id]/participants/[participantId]/actions/route";
import { POST as submitReaction } from "../instances/[id]/participants/[participantId]/reactions/route";
import { GET as getInstance } from "../instances/[id]/route";
import { GET as getObserver } from "../instances/[id]/observer/route";
import { POST as createInstance } from "../instances/route";
import { GET as getModelRegistry } from "../model-registry/route";
import { POST as refreshModelRegistry } from "../model-registry/refresh/route";
import { GET as getDebug } from "../debug/route";
import { GET as getDebugDoctor } from "../debug/doctor/route";
import { GET as getDebugArtifact } from "../debug/artifacts/[hash]/route";
import { GET as getDebugInvocation } from "../debug/invocations/[id]/route";

let root: string;
let database: LocalDatabase;
let registryRefreshCalls: number;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "lwe-instance-routes-"));
  registryRefreshCalls = 0;
  const baseProvider = new DeterministicModelProvider();
  const diagnostics: ModelRegistryDiagnostics = {
    catalog: { schemaVersion: 3, hash: baseProvider.catalog.hash },
    registry: {
      source: "https://models.dev/api.json",
      health: "fresh",
      refreshing: false,
      currentHash: "a".repeat(64),
      checkedAt: "2026-08-28T00:00:00.000Z",
      ageMs: 0,
      stale: false,
      lastError: null,
    },
    accounts: [],
    profiles: [],
  };
  const provider = Object.assign(baseProvider, {
    async modelRegistryDiagnostics() {
      return diagnostics;
    },
    async refreshModelRegistry() {
      registryRefreshCalls += 1;
      return {
        outcome: "unchanged" as const,
        checkedAt: "2026-08-28T00:00:00.000Z",
        error: null,
        diagnostics,
      };
    },
  });
  const definition = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 71,
    modelCatalog: provider.catalog,
  });
  database = new LocalDatabase(path.join(root, "livingworld.sqlite"), { heartbeat: false });
  WorldHost.setForTests(new WorldHost({
    repository: new MemoryWorldRepository({ [definition.id]: definition }),
    store: database,
    ledger: database,
    provider,
    defaultAlgorithmRef: FULL_CATALOG_ALGORITHM_REF,
    actionCompilationRetrievalProvider: {
      runtime: (ref) => ref.children.actionCompilation?.children.candidateSelection?.id === "relational-rrf"
        ? {
            role: "candidate-selection" as const,
            version: ACTION_COMPILATION_RETRIEVAL_RUNTIME_VERSION,
            async retrieveBatch({ fullContext, slotIndices }) {
              const candidates = (fullContext.referenceCatalog as {
                candidates: Array<{ candidateKey: string; scope?: { kind?: string; slot?: number } }>;
              }).candidates;
              const selectedKeysBySlot = new Map(slotIndices.map((slot) => [slot, candidates
                .filter((candidate) => candidate.scope?.kind !== "slot" || candidate.scope.slot === slot)
                .map((candidate) => candidate.candidateKey)]));
              const modelContext = structuredClone(fullContext) as Record<string, unknown>;
              return {
                modelContext,
                selectedKeysBySlot,
                fullContextHash: contentHash(fullContext),
                modelContextHash: contentHash(modelContext),
                shortlistHash: contentHash([...selectedKeysBySlot]),
                diagnostics: {
                  selectedCount: candidates.length,
                  visibleCount: candidates.length,
                  batchBudget: candidates.length,
                  batchShortlistRatio: 1,
                  prunedReferenceCount: 0,
                  anchorCount: 0,
                  budgetExceeded: false as const,
                  perSlotSelectedCount: Object.fromEntries([...selectedKeysBySlot]
                    .map(([slot, keys]) => [String(slot), keys.length])),
                  cache: {
                    passageHits: 0,
                    passageMisses: 0,
                    queryHits: 0,
                    queryMisses: 0,
                    readMs: 0,
                    passageEncodeMs: 0,
                    queryEncodeMs: 0,
                    queryBatchSize: 0,
                  },
                },
              };
            },
          }
        : undefined,
      preflight: async () => undefined,
    },
  }));
});

afterEach(() => {
  WorldHost.setForTests(undefined);
  database.close();
  rmSync(root, { recursive: true, force: true });
});

function jsonRequest(url: string, value: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

describe("World Instance Route Handlers", () => {
  it("returns safe model registry diagnostics and refreshes through the fixed route", async () => {
    const statusResponse = await getModelRegistry(new Request("http://local/api/model-registry"));
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({
      catalog: { schemaVersion: 3 },
      registry: { source: "https://models.dev/api.json", health: "fresh" },
      accounts: [],
      profiles: [],
    });

    const refreshResponse = await refreshModelRegistry(new Request(
      "http://local/api/model-registry/refresh",
      { method: "POST" },
    ));
    expect(refreshResponse.status).toBe(200);
    expect(await refreshResponse.json()).toMatchObject({ outcome: "unchanged" });
    expect(registryRefreshCalls).toBe(1);
  });

  it("uses the production observer and transactional Origin paths", async () => {
    const headlessResponse = await createInstance(jsonRequest("http://local/api/instances", {
      worldId: "open-world-fixture",
      seed: 71,
      executionTuning: { actionCompilationMaxSlots: 3, agentMindMaxSlots: 2 },
      start: { kind: "observer" },
    }));
    expect(headlessResponse.status).toBe(201);
    const headless = await headlessResponse.json();
    expect(headless).not.toHaveProperty("experimentEnrollment");
    expect(headless).not.toHaveProperty("experimentExclusion");
    expect(headless).not.toHaveProperty("executionAlgorithm");
    expect(database.readInstance(headless.summary.id).document.executionAlgorithm).toMatchObject({
      config: {},
      children: {
        agentCognition: { children: { batching: { config: { maxSlots: 2 } } } },
        actionCompilation: {
          children: {
            batching: { config: { maxSlots: 3 } },
            candidateSelection: {
              id: "relational-rrf",
              role: "candidate-selection",
              children: {
                ranking: { id: "typed-channel-rrf" },
                allocation: { id: "coverage-aware-joint-budget" },
              },
            },
          },
        },
      },
    });

    const advancedResponse = await advanceInstance(jsonRequest(
      `http://local/api/instances/${headless.summary.id}/advance`,
      { expectedRevision: 0, trigger: "manual" },
    ), { params: Promise.resolve({ id: headless.summary.id }) });
    expect(advancedResponse.status).toBe(200);
    expect(await advancedResponse.json()).toMatchObject({
      summary: { revision: 1, step: 1, participantCount: 0 },
    });

    const observerResponse = await getObserver(
      new Request(`http://local/api/instances/${headless.summary.id}/observer`),
      { params: Promise.resolve({ id: headless.summary.id }) },
    );
    expect(observerResponse.status).toBe(200);
    const observer = await observerResponse.json();
    expect(observer.agents).toHaveLength(2);
    expect(JSON.stringify(observer)).not.toContain("canonicalEntityIds");

    const originResponse = await createInstance(jsonRequest("http://local/api/instances", {
      worldId: "open-world-fixture",
      start: {
        kind: "origin",
        originId: "courtyard-wanderer",
        displayName: "小明",
        appearance: "背着旧旅行包。",
        motivation: "找到石门后的道路。",
      },
    }));
    expect(originResponse.status).toBe(201);
    const origin = await originResponse.json();
    expect(origin.controlledView.self).toMatchObject({ name: "小明", location: { name: "石门前庭" } });
    expect(origin.conversation.turns[0].response.possibleNextActions).toHaveLength(3);
    expect(JSON.stringify(origin)).not.toContain("canonicalEntityIds");

    const participant = origin.participants[0];
    const actionResponse = await submitAction(jsonRequest(
      `http://local/api/instances/${origin.summary.id}/participants/${participant.id}/actions`,
      {
        submissionId: "route-action",
        expectedRevision: origin.summary.revision,
        text: "我观察周围。",
      },
    ), { params: Promise.resolve({ id: origin.summary.id, participantId: participant.id }) });
    expect(actionResponse.status).toBe(200);
    const acted = await actionResponse.json();
    expect(acted.summary).toMatchObject({ revision: origin.summary.revision, runStatus: "queued" });
    expect(acted.conversation.turns).toHaveLength(2);

    let readResponse!: Response;
    let read!: { summary: { revision: number; participantCount: number } };
    for (let attempt = 0; attempt < 100; attempt += 1) {
      readResponse = await getInstance(
        new Request(`http://local/api/instances/${origin.summary.id}`),
        { params: Promise.resolve({ id: origin.summary.id }) },
      );
      read = await readResponse.clone().json();
      if (read.summary.revision >= origin.summary.revision + 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(readResponse.status).toBe(200);
    expect(read).toMatchObject({
      summary: { revision: origin.summary.revision + 1, participantCount: 1 },
    });
  }, 30_000);

  it("rejects malformed requests before they reach the host", async () => {
    const response = await createInstance(jsonRequest("http://local/api/instances", {
      worldId: "",
      start: { kind: "observer" },
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "worldId is required" });

    const invalidTuning = await createInstance(jsonRequest("http://local/api/instances", {
      worldId: "open-world-fixture",
      executionTuning: { actionCompilationMaxSlots: 65 },
      start: { kind: "observer" },
    }));
    expect(invalidTuning.status).toBe(400);
    expect(await invalidTuning.json()).toEqual({
      error: "actionCompilationMaxSlots must be an integer from 1 through 64",
    });

    const unknownTuning = await createInstance(jsonRequest("http://local/api/instances", {
      worldId: "open-world-fixture",
      executionTuning: { unexpected: 2 },
      start: { kind: "observer" },
    }));
    expect(unknownTuning.status).toBe(400);
    expect(await unknownTuning.json()).toEqual({ error: "unknown executionTuning field: unexpected" });

    const missingEvents = await getInstanceEvents(
      new Request("http://local/api/instances/missing/events"),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(missingEvents.status).toBe(404);
    expect(await missingEvents.json()).toEqual({ error: "world instance not found: missing" });

    const malformedReaction = await submitReaction(jsonRequest(
      "http://local/api/instances/instance/participants/participant/reactions",
      { submissionId: "reaction", kind: "replace" },
    ), { params: Promise.resolve({ id: "instance", participantId: "participant" }) });
    expect(malformedReaction.status).toBe(400);
    expect(await malformedReaction.json()).toEqual({ error: "invalid external reaction" });
  });

  it("resolves local debug evidence by execution and public invocation id", async () => {
    const response = await createInstance(jsonRequest("http://local/api/instances", {
      worldId: "open-world-fixture",
      seed: 71,
      start: { kind: "observer" },
    }));
    expect(response.status).toBe(201);
    const created = await response.json();
    const requestId = response.headers.get("x-lwe-request-id");
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(database.debugQuery({ requestId: requestId! }).invocations.length).toBeGreaterThan(0);
    const execution = database.executions({ instanceId: created.summary.id })[0];
    expect(execution).toBeDefined();
    const found = await getDebug(new Request(`http://local/api/debug?execution=${execution!.id}`));
    expect(found.status).toBe(200);
    expect(found.headers.get("x-lwe-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
    const result = await found.json();
    expect(result.executions[0].id).toBe(execution!.id);
    expect(result.invocations.length).toBeGreaterThan(0);
    const artifactHash = result.events.find((event: { artifactHash?: string }) => event.artifactHash)?.artifactHash as string | undefined;
    expect(artifactHash).toBeTruthy();
    const artifact = await getDebugArtifact(
      new Request(`http://local/api/debug/artifacts/${artifactHash}`),
      { params: Promise.resolve({ hash: artifactHash! }) },
    );
    expect(artifact.status).toBe(200);
    expect((await artifact.json()).hash).toBe(artifactHash);

    const invocationId = result.invocations[0].id as string;
    const detail = await getDebugInvocation(
      new Request(`http://local/api/debug/invocations/${encodeURIComponent(invocationId)}`),
      { params: Promise.resolve({ id: invocationId }) },
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).id).toBe(invocationId);

    const doctor = await getDebugDoctor(new Request("http://local/api/debug/doctor"));
    expect(doctor.status).toBe(200);
    expect((await doctor.json()).indexFresh).toBe(true);

    const invalidQuery = await getDebug(new Request("http://local/api/debug?limit=0"));
    expect(invalidQuery.status).toBe(400);
  }, 30_000);
});
