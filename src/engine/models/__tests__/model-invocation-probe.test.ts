import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  arrivalDraftSchema,
} from "../../contracts/llm-schemas";
import {
  canonicalize,
  contentHash,
} from "../model-audit";
import {
  createTestModelCatalog,
  createTestModelRegistry,
  ScriptedModelProvider,
} from "../../testing/model-provider";
import { resolveModelProfile } from "../model-registry";
import type { DebugInspection } from "../../../shared/debug-api";
import {
  runInvocationProbe,
  loadInvocationProbeReport,
  sourceFromInspection,
  type InvocationProbeSource,
  type SerializedModelRequest,
} from "../model-invocation-probe";

async function source(): Promise<{ source: InvocationProbeSource; catalog: ReturnType<typeof createTestModelCatalog>; registry: ReturnType<typeof createTestModelRegistry> }> {
  const catalog = createTestModelCatalog();
  const registry = createTestModelRegistry(catalog);
  const snapshot = await registry.capture();
  const profileId = "truth-engine";
  const binding = resolveModelProfile(catalog, snapshot, profileId);
  const schema = canonicalize(z.toJSONSchema(arrivalDraftSchema, { target: "draft-07" }));
  const request: SerializedModelRequest = {
    modelCatalogHash: catalog.hash,
    workloadId: "probe-workload",
    batchId: "probe-batch",
    role: "arrival-generator",
    subjectId: "arrival-subject",
    profileId,
    profile: structuredClone(binding.profile),
    accountId: binding.accountId,
    providerId: binding.account.models_dev_provider_id,
    protocol: binding.account.protocol,
    dialect: binding.account.dialect,
    selector: structuredClone(binding.selector),
    registrySnapshotHash: snapshot.hash,
    modelId: binding.modelId,
    modelMetadataHash: binding.modelMetadataHash,
    resolvedInference: {
      thinking: null,
      effort: null,
      reasoningBudgetTokens: null,
      reasoningSummary: null,
      textVerbosity: null,
      temperature: null,
      topP: null,
    },
    promptVersion: "probe-v1",
    schemaName: "arrival",
    schema,
    system: "You are a test arrival narrator.",
    userPrompt: "Write the arrival.",
    context: { location: "harbor", weather: "clear" },
  };
  return {
    catalog,
    registry,
    source: {
      publicInvocationId: "execution-probe::source-invocation",
      executionId: "execution-probe",
      sourceInvocationId: "source-invocation",
      status: "rejected",
      issueCodes: ["runtime.model.output"],
      requestHash: contentHash(request),
      request,
      inspection: {} as DebugInspection,
    },
  };
}

describe("model invocation probe", () => {
  it("loads only an explicit v1 report and selects the requested trial", async () => {
    const fixture = await source();
    const root = mkdtempSync(path.join(tmpdir(), "lwe-probe-report-"));
    try {
      const report = {
        schemaVersion: 1,
        kind: "model-invocation-probe",
        probeId: "probe-report-test",
        networkAccessed: true,
        source: {
          publicInvocationId: fixture.source.publicInvocationId,
          executionId: fixture.source.executionId,
          sourceInvocationId: fixture.source.sourceInvocationId,
          status: fixture.source.status,
          issueCodes: fixture.source.issueCodes,
          requestHash: fixture.source.requestHash,
          modelCatalogHash: fixture.source.request.modelCatalogHash,
          registrySnapshotHash: fixture.source.request.registrySnapshotHash,
        },
        variant: null,
        profile: {
          sourceProfileId: fixture.source.request.profileId,
          effectiveProfileId: fixture.source.request.profileId,
          overridden: false,
          catalogHash: fixture.source.request.modelCatalogHash,
          registrySnapshotHash: fixture.source.request.registrySnapshotHash,
          drift: [],
        },
        request: {
          role: fixture.source.request.role,
          subjectId: fixture.source.request.subjectId,
          promptVersion: fixture.source.request.promptVersion,
          schemaName: fixture.source.request.schemaName,
          workloadId: fixture.source.request.workloadId,
          batchId: fixture.source.request.batchId,
          system: fixture.source.request.system,
          userPrompt: fixture.source.request.userPrompt,
          context: fixture.source.request.context,
          schema: fixture.source.request.schema,
        },
        trials: [1, 2].map((trial) => ({
          trial,
          status: "accepted" as const,
          requestHash: fixture.source.requestHash,
          requestExactMatch: true,
          request: {
            profileId: fixture.source.request.profileId,
            role: fixture.source.request.role,
            subjectId: fixture.source.request.subjectId,
            promptVersion: fixture.source.request.promptVersion,
            schemaName: fixture.source.request.schemaName,
            workloadId: fixture.source.request.workloadId,
            batchId: fixture.source.request.batchId,
            system: fixture.source.request.system,
            userPrompt: fixture.source.request.userPrompt,
            context: fixture.source.request.context,
          },
          requestDiff: { changed: false, changedFields: [], changes: [], truncated: false },
          output: { title: `trial-${trial}` },
          audit: { invocations: [{ id: `probe:${trial}`, requestHash: fixture.source.requestHash }] },
          events: [],
          engineSemantic: "not-run" as const,
        })),
        summary: { total: 2, accepted: 2, rejected: 0, transportFailed: 0, configurationFailed: 0, acceptRate: 1, normalizationRate: 0 },
      };
      const file = path.join(root, "report.json");
      writeFileSync(file, JSON.stringify(report), "utf8");
      const loaded = loadInvocationProbeReport(file, 2);
      expect(loaded.report.probeId).toBe("probe-report-test");
      expect(loaded.trial.trial).toBe(2);
      expect(loaded.reportHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(() => loadInvocationProbeReport(file, 3)).toThrow("trial not found");
      report.kind = "other";
      writeFileSync(file, JSON.stringify(report), "utf8");
      expect(() => loadInvocationProbeReport(file)).toThrow("schemaVersion/kind");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("replays a request through a variant without writing canonical state", async () => {
    const fixture = await source();
    fixture.source.request.inferenceOverrides = { thinking: "auto" };
    fixture.source.request.jsonExamplePolicy = "omit";
    const provider = new ScriptedModelProvider(() => ({
      title: "The harbor",
      scene: "A clear morning settles over the harbor.",
    }), fixture.catalog);

    const report = await runInvocationProbe({
      source: fixture.source,
      catalog: fixture.catalog,
      registry: fixture.registry,
      provider,
      repeat: 2,
      variant: {
        id: "shorter-prompt",
        transformRequest: () => ({ userPrompt: "Write a concise arrival." }),
      },
      variantMetadata: { id: "shorter-prompt", path: "/tmp/shorter-prompt.ts", hash: "variant-hash" },
    });

    expect(report.summary).toMatchObject({ total: 2, accepted: 2, rejected: 0 });
    expect(report.variant?.id).toBe("shorter-prompt");
    expect(report.trials.every((trial) => trial.requestDiff.changed)).toBe(true);
    expect(report.trials.every((trial) => trial.requestExactMatch === false)).toBe(true);
    expect(provider.requests).toHaveLength(2);
    expect(report.trials[0]?.request).toMatchObject({ inferenceOverrides: { thinking: "auto" }, jsonExamplePolicy: "omit" });
    expect(report.trials[0]?.engineSemantic).toBe("not-run");
  });

  it("extracts the exact request and persisted audit hash from debug evidence", () => {
    const request = {
      modelCatalogHash: "catalog",
      workloadId: "workload",
      batchId: "batch",
      role: "arrival-generator",
      subjectId: "subject",
      profileId: "profile",
      profile: {},
      accountId: "account",
      providerId: "provider",
      protocol: "openai-chat",
      dialect: "test",
      selector: { kind: "exact", model_id: "model" },
      registrySnapshotHash: "snapshot",
      modelId: "model",
      modelMetadataHash: "metadata",
      resolvedInference: {},
      promptVersion: "prompt",
      schemaName: "arrival",
      schema: {},
      system: "system",
      userPrompt: "user",
      context: { value: 1 },
    };
    const inspection = {
      id: "execution::invocation",
      apiVersion: 1,
      executionId: "execution",
      sourceInvocationId: "invocation",
      status: "rejected",
      firstSequence: 1,
      lastSequence: 2,
      eventCount: 2,
      retryCount: 0,
      issueCodes: ["runtime.model.output"],
      artifactHashes: [],
      lineage: [],
      events: [
        {
          sequence: 1,
          executionId: "execution",
          timestamp: "2026-01-01T00:00:00.000Z",
          eventName: "model.context.serialized",
          level: "info",
          traceId: "trace",
          spanId: "span-1",
          hasPayload: true,
          diagnosticCodes: [],
          payload: request,
        },
        {
          sequence: 2,
          executionId: "execution",
          timestamp: "2026-01-01T00:00:00.000Z",
          eventName: "model.audit.persisted",
          level: "warn",
          traceId: "trace",
          spanId: "span-2",
          hasPayload: true,
          diagnosticCodes: [],
          payload: { invocations: [{ id: "invocation", requestHash: "persisted-request-hash" }] },
        },
      ],
      diagnostics: [],
    } satisfies DebugInspection;

    const result = sourceFromInspection("execution::invocation", inspection);
    expect(result.request).toEqual(request);
    expect(result.requestHash).toBe("persisted-request-hash");
    expect(result.issueCodes).toEqual(["runtime.model.output"]);
  });
});
