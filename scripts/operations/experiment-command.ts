import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { WorldExecutionAlgorithmRegistry, type AlgorithmRef } from "../../src/engine/runtime/execution";
import { loadAlgorithmExperimentRegistry } from "../../src/server/experiment-catalog";
import { verifyExperimentActivationEvidence } from "../../src/server/experiment-activation";
import { LocalDatabase } from "../../src/server/local-database";

type Operation = "preflight" | "report";

interface Options {
  operation: Operation;
  experimentId: string;
  version?: string;
  catalog: string;
  database: string;
}

function required(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function usage(): string {
  return "usage: experiment-command <preflight|report> --experiment <id> [--version <version>] [--catalog <json>] [--database <sqlite>]";
}

function parseArgs(argv: readonly string[]): Options {
  const operation = argv[0] as Operation | undefined;
  if (operation !== "preflight" && operation !== "report") throw new Error(usage());
  let experimentId = "";
  let version: string | undefined;
  let catalog = path.resolve(process.env.LIVINGWORLD_EXPERIMENT_CATALOG_PATH ?? "config/experiments.json");
  let database = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v23", "livingworld.sqlite");
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--experiment") experimentId = required(argv, ++index, argument);
    else if (argument === "--version") version = required(argv, ++index, argument);
    else if (argument === "--catalog") catalog = path.resolve(required(argv, ++index, argument));
    else if (argument === "--database") database = path.resolve(required(argv, ++index, argument));
    else if (argument === "--help" || argument === "-h") throw new Error(usage());
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!experimentId) throw new Error("--experiment is required");
  return { operation, experimentId, ...(version ? { version } : {}), catalog, database };
}

function registry(options: Options) {
  const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
  return loadAlgorithmExperimentRegistry(algorithms, options.catalog);
}

function selectedManifest(options: Options) {
  const matches = registry(options).all().filter((manifest) => manifest.id === options.experimentId && (!options.version || manifest.version === options.version));
  if (matches.length !== 1) throw new Error(`expected exactly one experiment manifest for ${options.experimentId}${options.version ? `@${options.version}` : ""}, got ${matches.length}`);
  return matches[0]!;
}

function actionCompilationCohort(ref: AlgorithmRef): "fullcatalog-control" | "retrieval-treatment" {
  return ref.children.actionCompilation?.children.candidateSelection?.id === "full-catalog"
    ? "fullcatalog-control"
    : "retrieval-treatment";
}

export function buildExperimentReport(options: Pick<Options, "experimentId" | "version" | "database">): Record<string, unknown> {
  const database = new LocalDatabase(options.database, { readOnly: true });
  try {
    const instances = database.listInstances().filter(({ document }) => {
      const enrollment = document.experimentEnrollment;
      return enrollment?.experimentId === options.experimentId && (!options.version || enrollment.experimentVersion === options.version);
    });
    const variants: Record<string, {
      cohort: "fullcatalog-control" | "retrieval-treatment";
      instances: number;
      actionCompilationInvocations: number;
      actionCompilationSlots: number;
      initialRejectedSlots: number;
      repairRecoveredSlots: number;
      terminalFailureSlots: number;
      retrievalFailures: number;
      outOfShortlistReferences: number;
      logicalProviderCalls: number;
      transportAttempts: number;
      inputTokens: number;
      outputTokens: number;
      providerExecutionMs: number;
      fullCatalogCandidatesObserved: number;
      modelCatalogCandidatesObserved: number;
      batchShortlistRatioSum: number;
      passageCacheHits: number;
      passageCacheMisses: number;
      queryCacheHits: number;
      queryCacheMisses: number;
      cacheReadMs: number;
      queryEncodeMs: number;
    }> = {};
    for (const { document } of instances) {
      const enrollment = document.experimentEnrollment!;
      const cohortKind = actionCompilationCohort(enrollment.algorithmRef);
      const cohort = variants[enrollment.variantId] ?? {
        cohort: cohortKind,
        instances: 0,
        actionCompilationInvocations: 0,
        actionCompilationSlots: 0,
        initialRejectedSlots: 0,
        repairRecoveredSlots: 0,
        terminalFailureSlots: 0,
        retrievalFailures: 0,
        outOfShortlistReferences: 0,
        logicalProviderCalls: 0,
        transportAttempts: 0,
        inputTokens: 0,
        outputTokens: 0,
        providerExecutionMs: 0,
        fullCatalogCandidatesObserved: 0,
        modelCatalogCandidatesObserved: 0,
        batchShortlistRatioSum: 0,
        passageCacheHits: 0,
        passageCacheMisses: 0,
        queryCacheHits: 0,
        queryCacheMisses: 0,
        cacheReadMs: 0,
        queryEncodeMs: 0,
      };
      if (cohort.cohort !== cohortKind) throw new Error(`experiment variant ${enrollment.variantId} changed cohort semantics`);
      cohort.instances += 1;
      for (const execution of database.executions({ instanceId: document.id })) {
        const events = database.executionEvents(execution.id);
        let executionInitialRejectedSlots = 0;
        let executionTerminalFailureSlots = 0;
        for (const event of events) {
          if (event.event !== "model.action_compilation.context.captured") continue;
          cohort.actionCompilationInvocations += 1;
          cohort.actionCompilationSlots += event.counts?.slots ?? 0;
          cohort.fullCatalogCandidatesObserved += event.counts?.visibleCandidates ?? 0;
          cohort.modelCatalogCandidatesObserved += event.counts?.selectedCandidates ?? 0;
          cohort.batchShortlistRatioSum += event.measurements?.batchShortlistRatio ?? 0;
          cohort.passageCacheHits += event.counts?.passageCacheHits ?? 0;
          cohort.passageCacheMisses += event.counts?.passageCacheMisses ?? 0;
          cohort.queryCacheHits += event.counts?.queryCacheHits ?? 0;
          cohort.queryCacheMisses += event.counts?.queryCacheMisses ?? 0;
          cohort.cacheReadMs += event.measurements?.cacheReadMs ?? 0;
          cohort.queryEncodeMs += event.measurements?.queryEncodeMs ?? 0;
        }
        for (const event of events) {
          if (event.event === "model.semantic.rejected" && event.correlation?.modelRole === "action-compilation" &&
            (event.correlation.semanticRepairAttempt ?? 0) === 0) {
            const rejected = event.counts?.validationIssues ?? 1;
            cohort.initialRejectedSlots += rejected;
            executionInitialRejectedSlots += rejected;
          }
          if (event.event === "algorithm.eager_reference.slot_batch_completed" && event.attributes?.phase === "action-compilation") {
            const failed = event.counts?.singletonFailures ?? 0;
            cohort.terminalFailureSlots += failed;
            executionTerminalFailureSlots += failed;
          }
          if (event.event === "model.action_compilation.retrieval_failed") cohort.retrievalFailures += 1;
          if (event.event === "model.action_compilation.out_of_shortlist") cohort.outOfShortlistReferences += event.counts?.references ?? 0;
          if (event.correlation?.modelRole === "action-compilation") {
            if (event.event === "model.invocation.started") cohort.logicalProviderCalls += 1;
            if (event.event === "model.transport.completed") {
              cohort.transportAttempts += 1;
              cohort.providerExecutionMs += event.measurements?.executionMs ?? event.durationMs ?? 0;
            }
            if (event.event === "model.structured_output.parsed" || event.event === "model.structured_output.rejected") {
              cohort.inputTokens += event.measurements?.inputTokens ?? 0;
              cohort.outputTokens += event.measurements?.outputTokens ?? 0;
            }
          }
        }
        cohort.repairRecoveredSlots += Math.max(0, executionInitialRejectedSlots - executionTerminalFailureSlots);
      }
      variants[enrollment.variantId] = cohort;
    }
    const controls = Object.values(variants).filter((cohort) => cohort.cohort === "fullcatalog-control");
    const treatments = Object.values(variants).filter((cohort) => cohort.cohort === "retrieval-treatment");
    const control = controls.length === 1 ? controls[0] : undefined;
    const treatment = treatments.length === 1 ? treatments[0] : undefined;
    const experimentVersions = [...new Set([
      ...(options.version ? [options.version] : []),
      ...instances.map(({ document }) => document.experimentEnrollment!.experimentVersion),
    ])].sort();
    const enrollmentStops = Object.fromEntries(experimentVersions.flatMap((version) => {
      const reason = database.readExperimentEnrollmentStop(options.experimentId, version);
      return reason ? [[version, reason]] : [];
    }));
    const variantReports = Object.fromEntries(Object.entries(variants).map(([id, cohort]) => {
      const { batchShortlistRatioSum, ...visible } = cohort;
      return [id, {
        ...visible,
        averageBatchShortlistRatio: cohort.actionCompilationInvocations === 0
          ? null
          : batchShortlistRatioSum / cohort.actionCompilationInvocations,
      }];
    }));
    const rejectionComparison = control && treatment && control.actionCompilationSlots > 0 && treatment.actionCompilationSlots > 0
      ? (() => {
          const controlRate = control.terminalFailureSlots / control.actionCompilationSlots;
          const treatmentRate = treatment.terminalFailureSlots / treatment.actionCompilationSlots;
          const difference = treatmentRate - controlRate;
          const standardError = Math.sqrt(
            treatmentRate * (1 - treatmentRate) / treatment.actionCompilationSlots +
            controlRate * (1 - controlRate) / control.actionCompilationSlots,
          );
          const oneSided95LowerBound = difference - 1.6448536269514722 * standardError;
          return {
            controlRate,
            treatmentRate,
            difference,
            oneSided95LowerBound,
            stopNewEnrollment: control.actionCompilationSlots >= 100 && treatment.actionCompilationSlots >= 100 && oneSided95LowerBound > 0.02,
          };
        })()
      : null;
    return {
      experimentId: options.experimentId,
      version: options.version ?? null,
      database: options.database,
      readOnly: true,
      instances: instances.length,
      enrollmentStops,
      variants: variantReports,
      minimumActionCompilationSlotsPerVariant: 100,
      enoughEvidence: Object.values(variants).length >= 2 && Object.values(variants).every((cohort) => cohort.actionCompilationSlots >= 100),
      rejectionComparison,
      comparisonAvailable: controls.length === 1 && treatments.length === 1,
      safetyViolation: Object.values(variants).some((cohort) => cohort.retrievalFailures > 0),
    };
  } finally {
    database.close();
  }
}

async function main(argv: readonly string[]): Promise<number> {
  try {
    const options = parseArgs(argv);
    const result = options.operation === "preflight"
      ? { manifest: selectedManifest(options), evidence: verifyExperimentActivationEvidence(selectedManifest(options)) }
      : buildExperimentReport(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("usage:")) { process.stdout.write(`${message}\n`); return 0; }
    process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
