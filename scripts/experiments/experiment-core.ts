import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createEagerReferenceManifest,
  DEFAULT_EAGER_REFERENCE_CONFIG,
  FULL_CATALOG_EAGER_REFERENCE_CONFIG,
  EagerReferenceAlgorithm,
} from "../../src/engine/algorithms/eager-reference/eager-reference";
import { historyReplayBaseHash } from "../../src/engine/runtime/history-replay";
import type { ModelProviderAdapter } from "../../src/engine/models/model-adapter";
import type { ModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelGateway } from "../../src/engine/models/model-gateway";
import type { AgentState, ModelExecutionAudit, ModelInvocationAudit } from "../../src/engine/contracts/model";
import { contentHash } from "../../src/engine/models/model-audit";
import { summarizeModelExecutionAudit } from "../../src/engine/models/model-provider";
import {
  RecordingRuntimeObserver,
  type RuntimeEvent,
  type RuntimeEventInput,
  type RuntimeObserver,
} from "../../src/engine/runtime/observability";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import {
  createTestModelCatalog,
  createTestModelRegistry,
  deterministicModelOutput,
} from "../../src/engine/testing/model-provider";
import type { WorldDefinition } from "../../src/engine/runtime/world-definition";
import { loadWorldScript } from "../../src/script/world-loader";
import { runtimeCodeIdentity } from "../../src/server/code-identity";
import type { ExecutionLedger } from "../../src/server/execution-ledger";

export interface ExperimentOptions {
  agents: number[];
  steps: number[];
  actionCompilationSlots?: number[];
  agentMindSlots?: number[];
  truthBatchSlots?: number[];
  write?: (record: ExperimentRecord) => void;
  ledger?: ExecutionLedger;
  parentExecutionId?: string;
}

export interface ExperimentRecord {
  schemaVersion: 3;
  sequence: number;
  event: string;
  [key: string]: unknown;
}

export interface ExperimentResult {
  records: ExperimentRecord[];
  scenarios: Array<{
    agents: number;
    steps: number;
    actionCompilationMaxSlots: number;
    agentMindMaxSlots: number;
    truthBatchMaxSlots: number;
    averageActionCompilationSlots: number;
    averageAgentMindSlots: number;
    rolePhysicalCalls: Record<string, number>;
    roleConcurrencyWaves: Record<string, number>;
    tokenUsage: {
      input: number | null;
      output: number | null;
      reasoning: number | null;
      cacheRead: number | null;
      cacheWrite: number | null;
    };
    repairCalls: number;
    batchSplits: number;
    partialFailureSlots: number;
    mindFallbacks: number;
    truthLogicalSlots: number;
    truthPhysicalCalls: number;
    truthRepairCalls: number;
    truthBatchSplits: number;
    stepWallMs: number;
    successRate: number;
    cumulativeInputBytes: number;
    modelInvocations: number;
    instanceDocumentBytes: number;
    ledgerEventCount: number;
    ledgerArtifactRawBytes: number;
    ledgerArtifactStoredBytes: number;
    ledgerSqliteWriteMs: number;
  }>;
}

const deterministicAdapter: ModelProviderAdapter = {
  accountId: "scripted-test",
  protocol: "openai-chat",
  dialect: "deepseek",
  describe() {
    return {
      structuredOutputMode: "deterministic-test",
      resolvedInference: {
        thinking: null,
        effort: null,
        reasoningBudgetTokens: null,
        reasoningSummary: null,
        textVerbosity: null,
        temperature: null,
        topP: null,
      },
      jsonRecovery: "strict",
    };
  },
  async generate(binding, request, contextJson) {
    const context = JSON.parse(contextJson);
    const generateOne = (slotContext: unknown): unknown => {
      if (request.role === "causal-verifier") return { verdict: "accept", findings: [] };
      if (request.role === "truth-perception") return { kind: "done" };
      if (request.role === "truth-resolution") return deterministicModelOutput(request.profileId, slotContext);
      if (request.role === "truth-reaction-routing") return { requests: [] };
      if (request.role === "truth-transition") {
        const generated = deterministicModelOutput(request.profileId, slotContext) as {
          kind: "transition";
          proposal: unknown;
        };
        return generated.proposal;
      }
      return deterministicModelOutput(request.profileId, slotContext);
    };
    const batch = context as {
      sharedContext?: Record<string, unknown>;
      slots?: Array<{ slot: number; context: Record<string, unknown> }>;
    };
    const value = request.schemaName.endsWith("_batch") && batch.sharedContext && batch.slots
      ? {
          slots: batch.slots.map((slot) => ({
            slot: slot.slot,
            result: generateOne({ ...structuredClone(batch.sharedContext), ...structuredClone(slot.context) }),
          })),
        }
      : generateOne(context);
    return {
      value,
      rawValueHash: contentHash(value),
      symbolRepairs: [],
      responseId: request.modelInvocationId ?? "experiment-model-invocation",
      responseModelId: binding.modelId,
      finishReason: "stop",
      tokenUsage: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null },
      resolvedInference: this.describe(binding, request).resolvedInference,
      structuredOutputMode: "deterministic-test",
      jsonRecovery: "strict",
    };
  },
};

class ExperimentObserver implements RuntimeObserver {
  readonly mode = "full" as const;
  readonly degraded = false;
  readonly critical = true;

  constructor(
    private readonly durable: RuntimeObserver,
    private readonly recording: RecordingRuntimeObserver,
  ) {}

  emit(input: RuntimeEventInput): RuntimeEvent | undefined {
    const persisted = this.durable.emit(input);
    this.recording.emit(input);
    return persisted;
  }

  flush(): void {
    this.durable.flush?.();
  }
}

function experimentCredentials(catalog: ModelCatalog): Record<string, string> {
  return Object.fromEntries(Object.values(catalog.accounts).map((account) => [
    account.api_key_env,
    "deterministic-experiment-boundary",
  ]));
}

function positiveMatrix(values: readonly number[], label: string): number[] {
  const unique = [...new Set(values)];
  if (unique.length === 0 || unique.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new Error(`${label} must contain positive safe integers`);
  }
  return unique.sort((left, right) => left - right);
}

function eagerSlotMatrix(values: readonly number[], label: string): number[] {
  const matrix = positiveMatrix(values, label);
  if (matrix.some((value) => value > 64)) throw new Error(`${label} must contain integers from 1 through 64`);
  return matrix;
}

export function parseExperimentMatrix(
  argv: readonly string[],
  defaults: { agents: number[]; steps: number[] } = { agents: [1, 10, 50], steps: [1, 10, 100] },
): { agents: number[]; steps: number[]; actionCompilationSlots: number[]; agentMindSlots: number[]; truthBatchSlots: number[] } {
  const values: {
    agents?: string;
    steps?: string;
    actionCompilationSlots?: string;
    agentMindSlots?: string;
    truthBatchSlots?: string;
  } = {};
  const argumentKeys = {
    agents: "agents",
    steps: "steps",
    "action-compilation-slots": "actionCompilationSlots",
    "agent-mind-slots": "agentMindSlots",
    "truth-batch-slots": "truthBatchSlots",
  } as const;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const match = /^--(agents|steps|action-compilation-slots|agent-mind-slots|truth-batch-slots)(?:=(.*))?$/.exec(argument);
    if (!match) throw new Error(`unknown experiment argument: ${argument}`);
    const argumentName = match[1] as keyof typeof argumentKeys;
    const key = argumentKeys[argumentName];
    if (values[key] !== undefined) throw new Error(`duplicate experiment argument: --${argumentName}`);
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`--${argumentName} requires a comma-separated value`);
    values[key] = value;
  }
  const parse = (raw: string | undefined, fallback: number[], label: string): number[] =>
    positiveMatrix(raw === undefined ? fallback : raw.split(",").map(Number), label);
  return {
    agents: parse(values.agents, defaults.agents, "agents"),
    steps: parse(values.steps, defaults.steps, "steps"),
    actionCompilationSlots: eagerSlotMatrix(parse(
      values.actionCompilationSlots,
      [DEFAULT_EAGER_REFERENCE_CONFIG.actionCompilationMaxSlots],
      "action-compilation-slots",
    ), "action-compilation-slots"),
    agentMindSlots: eagerSlotMatrix(parse(
      values.agentMindSlots,
      [DEFAULT_EAGER_REFERENCE_CONFIG.agentMindMaxSlots],
      "agent-mind-slots",
    ), "agent-mind-slots"),
    truthBatchSlots: eagerSlotMatrix(parse(
      values.truthBatchSlots,
      [DEFAULT_EAGER_REFERENCE_CONFIG.truthBatchMaxSlots],
      "truth-batch-slots",
    ), "truth-batch-slots"),
  };
}

function scaledDefinition(base: WorldDefinition, agentCount: number): WorldDefinition {
  const definition = structuredClone(base);
  definition.participation = null;
  const template = Object.values(definition.initialState.agents)[0];
  if (!template) throw new Error("experiment fixture requires one Agent template");
  const templateEntity = definition.initialState.truth.entities[template.entityId];
  const templatePlacement = definition.initialState.truth.placements[template.entityId] ?? null;
  for (const agent of Object.values(definition.initialState.agents)) {
    if (agent.id !== template.id) {
      delete definition.initialState.agents[agent.id];
    }
  }
  for (let index = 1; index < agentCount; index += 1) {
    const id = `experiment-agent-${String(index + 1).padStart(4, "0")}`;
    const agent: AgentState = structuredClone(template);
    agent.id = id;
    agent.entityId = id;
    agent.nextAction = null;
    agent.bindings = Object.fromEntries(Object.entries(agent.bindings).map(([localId, binding]) => [localId, {
      ...binding,
      canonicalEntityIds: binding.canonicalEntityIds.map((entityId) =>
        entityId === template.entityId ? id : entityId),
    }]));
    definition.initialState.agents[id] = agent;
    definition.initialState.truth.entities[id] = {
      ...structuredClone(templateEntity),
      id,
      name: `实验 Agent ${index + 1}`,
      description: "用于可重复执行实验的确定性 Agent。",
    };
    definition.initialState.truth.placements[id] = templatePlacement;
  }
  definition.historyBaseHash = historyReplayBaseHash(definition.initialState);
  return definition;
}

function invocationSummary(audits: readonly ModelExecutionAudit[]) {
  const invocations = audits.flatMap((audit) => audit.invocations);
  const tokenTotal = (field: keyof ModelInvocationAudit["tokenUsage"]): number | null => {
    const values = invocations.map((invocation) => invocation.tokenUsage[field]);
    return values.every((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  };
  return {
    invocations: invocations.length,
    repairs: audits.reduce((sum, audit) => sum + summarizeModelExecutionAudit(audit).repairAttempts, 0),
    transportRetries: audits.reduce((sum, audit) => {
      const summary = summarizeModelExecutionAudit(audit);
      return sum + Math.max(0, summary.transportAttempts - summary.invocations);
    }, 0),
    inputBytes: invocations.reduce((sum, invocation) => sum + invocation.requestUtf8Bytes, 0),
    tokenUsage: {
      input: tokenTotal("input"),
      output: tokenTotal("output"),
      reasoning: tokenTotal("reasoning"),
      cacheRead: tokenTotal("cacheRead"),
      cacheWrite: tokenTotal("cacheWrite"),
    },
  };
}

function mergeTokenUsage(
  left: ReturnType<typeof invocationSummary>["tokenUsage"],
  right: ReturnType<typeof invocationSummary>["tokenUsage"],
) {
  return Object.fromEntries((Object.keys(left) as Array<keyof typeof left>).map((key) => [
    key,
    left[key] === null && right[key] === null ? null : (left[key] ?? 0) + (right[key] ?? 0),
  ])) as typeof left;
}

function rolePhysicalCalls(audits: readonly ModelExecutionAudit[]): Record<string, number> {
  return Object.fromEntries([...audits.reduce((counts, audit) => {
    counts.set(audit.role, (counts.get(audit.role) ?? 0) + audit.invocations.length);
    return counts;
  }, new Map<string, number>()).entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function roleConcurrencyWaves(events: readonly RuntimeEvent[]): Record<string, number> {
  const completed = new Map(events.filter((event) => event.event === "model.transport.completed")
    .map((event) => [
      `${event.correlation?.modelInvocationId}:${event.correlation?.transportAttempt ?? 1}`,
      event.sequence,
    ]));
  const intervals = events.filter((event) => event.event === "model.transport.started")
    .flatMap((event) => {
      const role = event.correlation?.modelRole;
      const invocationId = event.correlation?.modelInvocationId;
      if (!role || !invocationId) return [];
      const end = completed.get(`${invocationId}:${event.correlation?.transportAttempt ?? 1}`);
      return end === undefined ? [] : [{ role, start: event.sequence, end }];
    });
  const grouped = Map.groupBy(intervals, (interval) => interval.role);
  return Object.fromEntries([...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([role, values]) => {
      let waves = 0;
      let waveEnd = -1;
      for (const interval of values.sort((left, right) => left.start - right.start)) {
        if (interval.start > waveEnd) {
          waves += 1;
          waveEnd = interval.end;
        } else {
          waveEnd = Math.max(waveEnd, interval.end);
        }
      }
      return [role, waves];
    }));
}

function eagerBatchSummary(events: readonly RuntimeEvent[]) {
  const batches = events.filter((event) => event.event === "algorithm.eager_reference.slot_batch_completed");
  const phase = (name: string) => batches.filter((event) => event.attributes?.phase === name);
  const count = (eventsForPhase: readonly RuntimeEvent[], key: string) =>
    eventsForPhase.reduce((sum, event) => sum + (event.counts?.[key] ?? 0), 0);
  const action = phase("action-compilation");
  const mind = batches.filter((event) => String(event.attributes?.phase).startsWith("agent-"));
  const truth = batches.filter((event) => String(event.attributes?.phase).startsWith("truth-") ||
    event.attributes?.phase === "observation");
  const average = (values: readonly RuntimeEvent[]) => {
    const calls = count(values, "physicalCalls");
    return calls === 0 ? 0 : Number((count(values, "submittedSlots") / calls).toFixed(3));
  };
  return {
    averageActionCompilationSlots: average(action),
    averageAgentMindSlots: average(mind),
    repairCalls: count(batches, "repairCalls"),
    batchSplits: count(batches, "batchSplits"),
    partialFailureSlots: count(batches, "partialFailureSlots"),
    mindFallbacks: events.filter((event) => event.event === "algorithm.agent_mind.repair_fallback")
      .reduce((sum, event) => sum + (event.counts?.mindFallbacks ?? 0), 0),
    truthLogicalSlots: count(truth, "logicalSlots"),
    truthPhysicalCalls: count(truth, "physicalCalls"),
    truthRepairCalls: count(truth, "repairCalls"),
    truthBatchSplits: count(truth, "batchSplits"),
  };
}

function roleContext(invocations: readonly ModelInvocationAudit[]) {
  return {
    totalUtf8Bytes: invocations.reduce((sum, invocation) => sum + invocation.context.utf8Bytes, 0),
    counts: invocations.reduce((totals, invocation) => {
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) totals[key] += invocation.context.counts[key];
      return totals;
    }, { history: 0, events: 0, agents: 0, entities: 0, facts: 0, beliefs: 0, evidence: 0, observations: 0 }),
  };
}

function ledgerMeasurement(ledger: ExecutionLedger | undefined, executionId: string | undefined) {
  const events = ledger && executionId ? ledger.executionEvents(executionId) : [];
  return {
    eventCount: events.length,
    artifactRawBytes: events.reduce((sum, event) => sum + (event.measurements?.ledgerArtifactRawBytes ?? 0), 0),
    artifactStoredBytes: events.reduce((sum, event) => sum + (event.measurements?.ledgerArtifactStoredBytes ?? 0), 0),
    sqliteWriteMs: Number(events.reduce(
      (sum, event) => sum + (event.measurements?.ledgerSqliteWriteMs ?? 0),
      0,
    ).toFixed(3)),
  };
}

export async function runDeterministicExperiment(options: ExperimentOptions): Promise<ExperimentResult> {
  const records: ExperimentRecord[] = [];
  const scenarios: ExperimentResult["scenarios"] = [];
  let sequence = 0;
  const write = (record: Omit<ExperimentRecord, "schemaVersion" | "sequence">): void => {
    const complete = { schemaVersion: 3 as const, sequence: ++sequence, ...record } as ExperimentRecord;
    records.push(complete);
    options.write?.(complete);
  };
  // Fixed Truth batches retain complete candidate truth; keep the deterministic
  // scale experiment above the reference world's largest twelve-slot request.
  const catalog = createTestModelCatalog(undefined, { maxInputBytes: 8 * 1024 * 1024 });
  const fixture = loadWorldScript(path.resolve("test/fixtures/open-world-script"), {
    seed: 20260823,
    modelCatalog: catalog,
  });

  const actionCompilationSlots = eagerSlotMatrix(
    options.actionCompilationSlots ?? [DEFAULT_EAGER_REFERENCE_CONFIG.actionCompilationMaxSlots],
    "action-compilation-slots",
  );
  const agentMindSlots = eagerSlotMatrix(
    options.agentMindSlots ?? [DEFAULT_EAGER_REFERENCE_CONFIG.agentMindMaxSlots],
    "agent-mind-slots",
  );
  const truthBatchSlots = eagerSlotMatrix(
    options.truthBatchSlots ?? [DEFAULT_EAGER_REFERENCE_CONFIG.truthBatchMaxSlots],
    "truth-batch-slots",
  );
  for (const agentCount of positiveMatrix(options.agents, "agents")) {
    for (const stepCount of positiveMatrix(options.steps, "steps")) {
      for (const actionCompilationMaxSlots of actionCompilationSlots) {
        for (const agentMindMaxSlots of agentMindSlots) {
          for (const truthBatchMaxSlots of truthBatchSlots) {
      const algorithmConfig = {
        actionCompilationMaxSlots,
        agentMindMaxSlots,
        reactionMaxSlots: DEFAULT_EAGER_REFERENCE_CONFIG.reactionMaxSlots,
        groundingMaxSlots: DEFAULT_EAGER_REFERENCE_CONFIG.groundingMaxSlots,
        truthBatchMaxSlots,
        candidateRetrieval: FULL_CATALOG_EAGER_REFERENCE_CONFIG.candidateRetrieval,
      };
      const algorithmManifest = createEagerReferenceManifest(algorithmConfig);
      const definition = scaledDefinition(fixture, agentCount);
      const instanceId = `experiment-${agentCount}-${stepCount}-ac${actionCompilationMaxSlots}-am${agentMindMaxSlots}-tb${truthBatchMaxSlots}`;
      const trialId = options.ledger ? randomUUID() : undefined;
      const recording = new RecordingRuntimeObserver({ mode: options.ledger ? "full" : "metrics" });
      const code = runtimeCodeIdentity();
      const durable = trialId ? options.ledger!.beginExecution({
        id: trialId,
        kind: "benchmark",
        parentExecutionId: options.parentExecutionId,
        instanceId,
        step: 0,
        manifest: algorithmManifest,
        worldHash: definition.initialState.worldHash,
        codeRevision: code.revision,
        codeDirty: code.dirty,
        modelCatalogHash: catalog.hash,
        seed: definition.initialState.truth.rng.seed,
        runtimeConfig: {
          agents: agentCount,
          steps: stepCount,
          deterministic: true,
          participants: 0,
          ...algorithmConfig,
        },
      }) : undefined;
      const observer: RuntimeObserver = durable ? new ExperimentObserver(durable, recording) : recording;
      const provider = new ModelGateway(catalog, experimentCredentials(catalog), {
        registry: createTestModelRegistry(catalog),
        observer,
        maxTransportAttempts: 1,
        adapters: new Map([["scripted-test", deterministicAdapter]]),
      });
      const engine = new SimulationEngine(definition, new EagerReferenceAlgorithm(provider, undefined, algorithmConfig));
      const semanticHashes: string[] = [];
      const scenarioAudits: ModelExecutionAudit[] = [];
      let totalStepWallMs = 0;
      try {
        write({ event: "experiment.scenario.started", agents: agentCount, steps: stepCount, ...algorithmConfig });
        await engine.bootstrapAgents({
          workloadId: instanceId,
          batchId: `bootstrap:${instanceId}`,
          correlation: { instanceId, revision: 0, step: 0, executionId: trialId },
          observer,
        });
        scenarioAudits.push(...engine.bootstrapModelAudits);
        const bootstrapSummary = invocationSummary(engine.bootstrapModelAudits);
        let cumulativeInputBytes = bootstrapSummary.inputBytes;
        let modelInvocations = bootstrapSummary.invocations;
        let cumulativeTokenUsage = bootstrapSummary.tokenUsage;
        write({
          event: "experiment.bootstrap",
          agents: agentCount,
          targetSteps: stepCount,
          ...algorithmConfig,
          ...bootstrapSummary,
          cumulativeInputUtf8Bytes: cumulativeInputBytes,
        });

        for (let index = 0; index < stepCount; index += 1) {
          const source = engine.snapshot;
          const advanceId = `advance:${instanceId}:${index + 1}`;
          const roster = Object.fromEntries(Object.values(source.agents).map((agent) => [agent.id, {
            kind: "model" as const,
            agentId: agent.id,
            profiles: structuredClone(agent.modelProfiles),
          }]));
          const startedAt = performance.now();
          const result = await engine.step(roster, {
            expectedRevision: source.revision,
            trigger: "batch",
            externalActions: [],
          }, {
            workloadId: instanceId,
            batchId: advanceId,
            correlation: {
              instanceId,
              advanceId,
              advanceAttempt: 1,
              revision: source.revision,
              step: source.step + 1,
              executionId: trialId,
            },
            observer,
          });
          semanticHashes.push(result.committed.semanticHash);
          const summary = invocationSummary(result.modelAudits);
          scenarioAudits.push(...result.modelAudits);
          cumulativeInputBytes += summary.inputBytes;
          modelInvocations += summary.invocations;
          cumulativeTokenUsage = mergeTokenUsage(cumulativeTokenUsage, summary.tokenUsage);
          const stepWallMs = Number((performance.now() - startedAt).toFixed(3));
          totalStepWallMs += stepWallMs;
          write({
            event: "experiment.step",
            agents: agentCount,
            targetSteps: stepCount,
            step: result.state.step,
            ...algorithmConfig,
            ...summary,
            cumulativeInputUtf8Bytes: cumulativeInputBytes,
            stepWallMs,
            instanceDocumentBytes: Buffer.byteLength(JSON.stringify(result.state), "utf8"),
          });
          const byRole = new Map<string, ModelInvocationAudit[]>();
          for (const audit of result.modelAudits) {
            const values = byRole.get(audit.role) ?? [];
            values.push(...audit.invocations);
            byRole.set(audit.role, values);
          }
          for (const [role, invocations] of byRole) {
            write({
              event: "experiment.context",
              phase: "step",
              agents: agentCount,
              step: result.state.step,
              role,
              ...roleContext(invocations),
            });
          }
        }

        const finalState = engine.snapshot;
        if (trialId) options.ledger!.finishExecution(trialId, {
          status: "succeeded",
          semanticHash: contentHash(semanticHashes),
          stateHash: contentHash(finalState),
          commitRevision: finalState.revision,
        });
        const ledger = ledgerMeasurement(options.ledger, trialId);
        const batch = eagerBatchSummary(recording.events);
        const physicalCalls = rolePhysicalCalls(scenarioAudits);
        const concurrencyWaves = roleConcurrencyWaves(recording.events);
        const scenario = {
          agents: agentCount,
          steps: stepCount,
          ...algorithmConfig,
          ...batch,
          rolePhysicalCalls: physicalCalls,
          roleConcurrencyWaves: concurrencyWaves,
          tokenUsage: cumulativeTokenUsage,
          stepWallMs: Number(totalStepWallMs.toFixed(3)),
          successRate: 1,
          cumulativeInputBytes,
          modelInvocations,
          instanceDocumentBytes: Buffer.byteLength(JSON.stringify(finalState), "utf8"),
          ledgerEventCount: ledger.eventCount,
          ledgerArtifactRawBytes: ledger.artifactRawBytes,
          ledgerArtifactStoredBytes: ledger.artifactStoredBytes,
          ledgerSqliteWriteMs: ledger.sqliteWriteMs,
        };
        scenarios.push(scenario);
        write({ event: "experiment.scenario.completed", ...scenario, observabilityEventCount: recording.events.length });
      } catch (error) {
        if (trialId && options.ledger!.execution(trialId)?.status === "running") {
          options.ledger!.finishExecution(trialId, { status: "failed", error });
        }
        throw error;
      }
        }
          }
      }
    }
  }
  write({ event: "experiment.summary", kind: "deterministic-eager-reference", scenarios });
  return { records, scenarios };
}
