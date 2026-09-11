import type { RuntimeAttribute, RuntimeEvent } from "./observability";

export type MetricAggregation = "sum" | "max" | "last" | "count";

export interface MetricDefinition {
  name: string;
  unit: "1" | "By" | "ms" | "s" | "token";
  aggregation: MetricAggregation;
  source: {
    field: "counts" | "measurements";
    key: string;
    eventNames?: readonly string[];
  } | { field: "event"; name: string };
  allowedDimensions: readonly string[];
}

export interface MetricPoint {
  name: string;
  value: number;
  unit: MetricDefinition["unit"];
  dimensions: Readonly<Record<string, RuntimeAttribute>>;
}

export interface ExecutionWorkSummary {
  spanCount: number;
  maxSpanDepth: number;
  executionWallMs: number;
  modelSpanCount: number;
  modelExecutionMs: number;
  modelQueueMs: number;
  modelRetryDelayMs: number;
  rollbackCount: number;
}

export function deriveExecutionWork(events: readonly RuntimeEvent[]): ExecutionWorkSummary {
  const spans = new Map<string, { parent?: string; durationMs: number; model: boolean }>();
  for (const event of events) {
    if (!event.spanId) continue;
    const current = spans.get(event.spanId) ?? {
      parent: event.parentSpanId,
      durationMs: 0,
      model: false,
    };
    current.parent ??= event.parentSpanId;
    current.durationMs = Math.max(current.durationMs, event.durationMs ?? 0);
    current.model ||= event.correlation?.modelInvocationId !== undefined;
    spans.set(event.spanId, current);
  }
  const depthMemo = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (spanId: string): number => {
    const cached = depthMemo.get(spanId);
    if (cached !== undefined) return cached;
    if (visiting.has(spanId)) return 1;
    visiting.add(spanId);
    const span = spans.get(spanId)!;
    const value = span.parent && spans.has(span.parent) ? depth(span.parent) + 1 : 1;
    visiting.delete(spanId);
    depthMemo.set(spanId, value);
    return value;
  };
  const values = [...spans.entries()];
  const measurementSum = (key: string, eventNames: readonly string[]): number => events.reduce((sum, event) =>
    sum + (eventNames.includes(event.event) ? event.measurements?.[key] ?? 0 : 0), 0);
  const eventTimes = events
    .map((event) => Date.parse(event.timestamp))
    .filter(Number.isFinite);
  const observedWallMs = eventTimes.length > 1
    ? Math.max(...eventTimes) - Math.min(...eventTimes)
    : 0;
  const terminalWallMs = Math.max(0, ...events
    .filter((event) => [
      "step.committed",
      "step.rolled_back",
      "instance.bootstrap.committed",
      "instance.bootstrap.rolled_back",
      "benchmark.matrix.completed",
    ].includes(event.event))
    .map((event) => event.durationMs ?? 0));
  return {
    spanCount: spans.size,
    maxSpanDepth: values.length > 0 ? Math.max(...values.map(([id]) => depth(id))) : 0,
    executionWallMs: Math.max(observedWallMs, terminalWallMs),
    modelSpanCount: values.filter(([, span]) => span.model).length,
    modelExecutionMs: measurementSum("executionMs", ["model.transport.completed", "model.transport.failed"]),
    modelQueueMs: measurementSum("queueWaitMs", ["model.queue.completed", "model.queue.failed"]),
    modelRetryDelayMs: measurementSum("retryDelayMs", ["model.transport.retry_wait"]),
    rollbackCount: events.filter((event) => event.event.endsWith(".rolled_back")).length,
  };
}

const forbiddenDimensionPattern = /(agent|session|run|event|component|invocation).*id$/i;

export class MetricDefinitionRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();

  register(definition: MetricDefinition): void {
    if (this.definitions.has(definition.name)) throw new Error(`metric is already registered: ${definition.name}`);
    for (const dimension of definition.allowedDimensions) {
      if (forbiddenDimensionPattern.test(dimension)) {
        throw new Error(`high-cardinality metric dimension is forbidden: ${dimension}`);
      }
    }
    this.definitions.set(definition.name, definition);
  }

  definition(name: string): MetricDefinition {
    const definition = this.definitions.get(name);
    if (!definition) throw new Error(`metric is not registered: ${name}`);
    return definition;
  }

  derive(events: readonly RuntimeEvent[]): MetricPoint[] {
    const points: MetricPoint[] = [];
    for (const definition of this.definitions.values()) {
      for (const event of events) {
        if (definition.source.field !== "event" && definition.source.eventNames &&
          !definition.source.eventNames.includes(event.event)) continue;
        const value = definition.source.field === "event"
          ? event.event === definition.source.name ? 1 : undefined
          : event[definition.source.field]?.[definition.source.key];
        if (value === undefined || value === null) continue;
        const dimensions = Object.fromEntries(definition.allowedDimensions.flatMap((dimension) => {
          const candidate = event.attributes?.[dimension] ??
            (dimension === "modelRole" ? event.correlation?.modelRole : undefined);
          return candidate === undefined ? [] : [[dimension, candidate]];
        }));
        points.push({ name: definition.name, value, unit: definition.unit, dimensions });
      }
    }
    return points;
  }
}

export type AggregatedMetricPoint = MetricPoint & { samples: number };

export function aggregateMetricPoints(
  points: readonly MetricPoint[],
  registry: MetricDefinitionRegistry = EXECUTION_METRICS,
): AggregatedMetricPoint[] {
  const values = new Map<string, AggregatedMetricPoint>();
  for (const point of points) {
    const key = `${point.name}\u0000${JSON.stringify(point.dimensions)}`;
    const definition = registry.definition(point.name);
    const current = values.get(key);
    if (!current) {
      values.set(key, {
        ...point,
        value: definition.aggregation === "count" ? 1 : point.value,
        samples: 1,
      });
      continue;
    }
    current.samples += 1;
    if (definition.aggregation === "sum") current.value += point.value;
    else if (definition.aggregation === "count") current.value += 1;
    else if (definition.aggregation === "max") current.value = Math.max(current.value, point.value);
    else current.value = point.value;
  }
  return [...values.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || JSON.stringify(left.dimensions).localeCompare(JSON.stringify(right.dimensions)));
}

const commonDimensions = ["phase", "policy", "providerId", "modelId", "modelRole", "status"] as const;

export const EXECUTION_METRICS = new MetricDefinitionRegistry();

function registerNumericFields(
  field: "counts" | "measurements",
  eventNames: readonly string[] | undefined,
  definitions: ReadonlyArray<readonly [
    string,
    string,
    MetricDefinition["unit"],
    MetricAggregation,
  ]>,
): void {
  for (const [name, key, unit, aggregation] of definitions) {
    EXECUTION_METRICS.register({
      name,
      unit,
      aggregation,
      source: { field, key, eventNames },
      allowedDimensions: commonDimensions,
    });
  }
}

registerNumericFields("counts", ["algorithm.activation.completed"], [
  ["lwe.agent.persistent", "persistentAgents", "1", "last"],
  ["lwe.agent.eligible", "eligibleAgents", "1", "last"],
  ["lwe.agent.activated", "activatedAgents", "1", "sum"],
  ["lwe.agent.skipped", "skippedAgents", "1", "sum"],
  ["lwe.agent.reused", "reusedAgents", "1", "sum"],
  ["lwe.agent.noop", "noopAgents", "1", "sum"],
  ["lwe.agent.external", "externalAgents", "1", "sum"],
]);

registerNumericFields("counts", ["algorithm.candidate.completed"], [
  ["lwe.agent.updated", "updatedAgents", "1", "sum"],
  ["lwe.agent.observed", "observedAgents", "1", "sum"],
  ["lwe.output.actions", "actions", "1", "sum"],
  ["lwe.output.reactions", "reactions", "1", "sum"],
  ["lwe.output.checks", "checks", "1", "sum"],
  ["lwe.output.random", "randomResults", "1", "sum"],
  ["lwe.output.resolution_plans", "resolutionPlans", "1", "sum"],
  ["lwe.output.resolution_receipts_settled", "settledResolutionReceipts", "1", "sum"],
  ["lwe.output.resolution_receipts_deferred", "deferredResolutionReceipts", "1", "sum"],
  ["lwe.output.mechanic_invocations", "mechanicInvocations", "1", "sum"],
  ["lwe.output.mechanic_results", "mechanicResults", "1", "sum"],
  ["lwe.output.outcomes", "outcomes", "1", "sum"],
  ["lwe.output.operations", "operations", "1", "sum"],
  ["lwe.output.events", "events", "1", "sum"],
  ["lwe.output.observations", "observations", "1", "sum"],
  ["lwe.output.mind_commits", "mindCommits", "1", "sum"],
  ["lwe.temporal.plans", "temporalPlans", "1", "sum"],
  ["lwe.temporal.active_activities", "activeActivities", "1", "last"],
  ["lwe.temporal.activity_transitions", "activityTransitions", "1", "sum"],
  ["lwe.temporal.due_activities", "dueActivities", "1", "sum"],
  ["lwe.temporal.due_timers", "dueTimers", "1", "sum"],
  ["lwe.temporal.due_conditions", "dueConditions", "1", "sum"],
  ["lwe.temporal.decision_points", "decisionPoints", "1", "sum"],
  ["lwe.temporal.delta", "temporalDeltaSeconds", "s", "sum"],
  ["lwe.agent.mind_fallbacks", "mindFallbacks", "1", "sum"],
  ["lwe.dependency.nodes", "dependencyNodes", "1", "sum"],
  ["lwe.dependency.edges", "dependencyEdges", "1", "sum"],
  ["lwe.dependency.components", "dependencyComponents", "1", "sum"],
  ["lwe.dependency.max_component", "maxDependencyComponent", "1", "max"],
  ["lwe.dependency.global_dependencies", "globalDependencies", "1", "sum"],
  ["lwe.dependency.global_readjudications", "globalReadjudications", "1", "sum"],
  ["lwe.dependency.footprint_cardinality", "footprintCardinality", "1", "sum"],
  ["lwe.dependency.audience_cardinality", "audienceCardinality", "1", "sum"],
]);

registerNumericFields("counts", ["algorithm.grounding.global_fallback"], [
  ["lwe.normalization.grounding_fields", "normalizedGroundingFields", "1", "sum"],
]);

registerNumericFields("counts", ["algorithm.observation.references_normalized"], [
  ["lwe.normalization.observation_event_references", "droppedObservationEventReferences", "1", "sum"],
  ["lwe.normalization.observation_claims", "droppedObservationClaims", "1", "sum"],
  ["lwe.normalization.observation_introductions", "droppedObservationIntroductions", "1", "sum"],
  ["lwe.normalization.observation_bindings", "clearedObservationCanonicalBindings", "1", "sum"],
]);

registerNumericFields("counts", ["algorithm.observation.batch_split", "algorithm.observation.repair_fallback"], [
  ["lwe.observation.batch_splits", "observationBatchSplits", "1", "sum"],
  ["lwe.observation.fallbacks", "observationFallbacks", "1", "sum"],
]);

registerNumericFields("counts", ["algorithm.outcome.alternative_evidence_normalized"], [
  ["lwe.normalization.outcome_alternative_evidence", "droppedOutcomeAlternativeEvidenceReferences", "1", "sum"],
  ["lwe.normalization.outcome_alternatives", "droppedOutcomeAlternatives", "1", "sum"],
]);

registerNumericFields("counts", ["model.invocation.provider_completed", "model.invocation.failed"], [
  ["lwe.model.transport_attempts", "transportAttempts", "1", "sum"],
]);

registerNumericFields("counts", ["model.output.normalized"], [
  ["lwe.model.symbol_repair.attempts", "symbolRepairAttempts", "1", "sum"],
  ["lwe.model.symbol_repair.accepted", "symbolRepairAccepted", "1", "sum"],
  ["lwe.model.symbol_repair.ambiguous", "symbolRepairAmbiguous", "1", "sum"],
  ["lwe.model.symbol_repair.unmatched", "symbolRepairUnmatched", "1", "sum"],
  ["lwe.model.symbol_repair.post_validation_rejected", "symbolRepairPostValidationRejected", "1", "sum"],
]);

registerNumericFields("counts", ["model.action_compilation.context.captured"], [
  ["lwe.model.candidate_retrieval.full_catalog_candidates", "visibleCandidates", "1", "sum"],
  ["lwe.model.candidate_retrieval.model_catalog_candidates", "selectedCandidates", "1", "sum"],
  ["lwe.model.candidate_retrieval.passage_cache_hits", "passageCacheHits", "1", "sum"],
  ["lwe.model.candidate_retrieval.passage_cache_misses", "passageCacheMisses", "1", "sum"],
  ["lwe.model.candidate_retrieval.query_cache_hits", "queryCacheHits", "1", "sum"],
  ["lwe.model.candidate_retrieval.query_cache_misses", "queryCacheMisses", "1", "sum"],
  ["lwe.model.candidate_retrieval.query_batch_size", "queryBatchSize", "1", "sum"],
]);

registerNumericFields("measurements", ["model.action_compilation.context.captured"], [
  ["lwe.model.candidate_retrieval.batch_shortlist_ratio", "batchShortlistRatio", "1", "last"],
  ["lwe.model.candidate_retrieval.cache_read", "cacheReadMs", "ms", "sum"],
  ["lwe.model.candidate_retrieval.passage_encode", "passageEncodeMs", "ms", "sum"],
  ["lwe.model.candidate_retrieval.query_encode", "queryEncodeMs", "ms", "sum"],
]);

registerNumericFields("counts", ["model.action_compilation.out_of_shortlist"], [
  ["lwe.model.candidate_retrieval.out_of_shortlist_references", "references", "1", "sum"],
]);

EXECUTION_METRICS.register({
  name: "lwe.model.candidate_retrieval.failures",
  unit: "1",
  aggregation: "count",
  source: { field: "event", name: "model.action_compilation.retrieval_failed" },
  allowedDimensions: ["modelRole"],
});

registerNumericFields("counts", ["step.rolled_back", "instance.bootstrap.rolled_back"], [
  ["lwe.waste.discarded_calls", "discardedModelCalls", "1", "sum"],
  ["lwe.waste.rollbacks", "rollbacks", "1", "sum"],
]);

registerNumericFields("measurements", ["model.structured_output.parsed", "model.structured_output.rejected"], [
  ["lwe.model.input_tokens", "inputTokens", "token", "sum"],
  ["lwe.model.output_tokens", "outputTokens", "token", "sum"],
  ["lwe.model.reasoning_tokens", "reasoningTokens", "token", "sum"],
  ["lwe.model.cache_read_tokens", "cacheReadTokens", "token", "sum"],
  ["lwe.model.cache_write_tokens", "cacheWriteTokens", "token", "sum"],
]);

registerNumericFields("measurements", ["execution.resources.sampled"], [
  ["lwe.system.cpu_user", "cpuUserMs", "ms", "sum"],
  ["lwe.system.cpu_system", "cpuSystemMs", "ms", "sum"],
  ["lwe.system.rss", "rssBytes", "By", "max"],
  ["lwe.system.heap_used", "heapUsedBytes", "By", "max"],
  ["lwe.system.heap_total", "heapTotalBytes", "By", "max"],
  ["lwe.system.event_loop_active", "eventLoopActiveMs", "ms", "sum"],
  ["lwe.system.event_loop_idle", "eventLoopIdleMs", "ms", "sum"],
  ["lwe.system.event_loop_utilization", "eventLoopUtilization", "1", "max"],
]);

registerNumericFields("measurements", ["persistence.atomic_commit"], [
  ["lwe.persistence.document_bytes", "documentUtf8Bytes", "By", "last"],
  ["lwe.persistence.sqlite_write", "sqliteWriteMs", "ms", "sum"],
]);

registerNumericFields("measurements", undefined, [
  ["lwe.ledger.artifact_raw_bytes", "ledgerArtifactRawBytes", "By", "sum"],
  ["lwe.ledger.artifact_stored_bytes", "ledgerArtifactStoredBytes", "By", "sum"],
  ["lwe.ledger.sqlite_write", "ledgerSqliteWriteMs", "ms", "sum"],
]);

registerNumericFields("measurements", ["step.rolled_back", "instance.bootstrap.rolled_back"], [
  ["lwe.waste.discarded_input_tokens", "discardedInputTokens", "token", "sum"],
  ["lwe.waste.discarded_output_tokens", "discardedOutputTokens", "token", "sum"],
  ["lwe.waste.discarded_reasoning_tokens", "discardedReasoningTokens", "token", "sum"],
  ["lwe.waste.discarded_model_execution", "discardedModelExecutionMs", "ms", "sum"],
]);

for (const definition of [
  {
    name: "lwe.model.context_bytes",
    unit: "By" as const,
    key: "contextUtf8Bytes",
    eventNames: ["model.context.serialized"],
  },
  {
    name: "lwe.model.request_bytes",
    unit: "By" as const,
    key: "requestUtf8Bytes",
    eventNames: ["model.context.serialized"],
  },
  {
    name: "lwe.model.system_prompt_bytes",
    unit: "By" as const,
    key: "systemPromptUtf8Bytes",
    eventNames: ["model.context.serialized"],
  },
  {
    name: "lwe.model.user_prompt_bytes",
    unit: "By" as const,
    key: "userPromptUtf8Bytes",
    eventNames: ["model.context.serialized"],
  },
  {
    name: "lwe.model.response_bytes",
    unit: "By" as const,
    key: "responseUtf8Bytes",
    eventNames: ["model.structured_output.parsed", "model.structured_output.rejected"],
  },
  {
    name: "lwe.model.queue_time",
    unit: "ms" as const,
    key: "queueWaitMs",
    eventNames: ["model.queue.completed", "model.queue.failed"],
  },
  {
    name: "lwe.model.execution_time",
    unit: "ms" as const,
    key: "executionMs",
    eventNames: ["model.transport.completed", "model.transport.failed"],
  },
  {
    name: "lwe.model.retry_delay",
    unit: "ms" as const,
    key: "retryDelayMs",
    eventNames: ["model.transport.retry_wait"],
  },
] as const) {
  EXECUTION_METRICS.register({
    name: definition.name,
    unit: definition.unit,
    aggregation: "sum",
    source: { field: "measurements", key: definition.key, eventNames: definition.eventNames },
    allowedDimensions: commonDimensions,
  });
}

EXECUTION_METRICS.register({
  name: "lwe.model.logical_calls",
  unit: "1",
  aggregation: "count",
  source: { field: "event", name: "model.invocation.started" },
  allowedDimensions: ["providerId", "modelId", "modelRole"],
});

EXECUTION_METRICS.register({
  name: "lwe.model.semantic_repairs",
  unit: "1",
  aggregation: "count",
  source: { field: "event", name: "model.semantic.rejected" },
  allowedDimensions: ["phase"],
});

for (const definition of [
  {
    name: "lwe.temporal.boundary_reasons",
    event: "temporal.boundary.reason",
    dimension: "reasonKind",
  },
  {
    name: "lwe.temporal.activity_transition_kinds",
    event: "temporal.activity.transition",
    dimension: "transitionKind",
  },
  {
    name: "lwe.resolution.outcome_statuses",
    event: "resolution.outcome.recorded",
    dimension: "outcomeStatus",
  },
  {
    name: "lwe.resolution.operation_kinds",
    event: "resolution.operation.recorded",
    dimension: "operationKind",
  },
] as const) {
  EXECUTION_METRICS.register({
    name: definition.name,
    unit: "1",
    aggregation: "count",
    source: { field: "event", name: definition.event },
    allowedDimensions: [definition.dimension],
  });
}
