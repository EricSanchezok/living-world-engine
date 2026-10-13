import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregateMetricPoints, deriveExecutionWork, EXECUTION_METRICS } from "../../src/engine/runtime/execution-metrics";
import { contentHash } from "../../src/engine/models/model-audit";
import { LocalDatabase } from "../../src/server/local-database";
import type { DebugOutputFormat, DebugQuery, DebugSearchResult } from "../../src/shared/debug-api";
import { DEBUG_API_VERSION } from "../../src/shared/debug-api";

type ParsedArguments = {
  command: string;
  query: DebugQuery;
  format: DebugOutputFormat;
  database: string;
  output?: string;
  includePayload: boolean;
  rebuildIndex: boolean;
  positional: string[];
  probeReport?: string;
  trial: number;
};

function usage(): string {
  return `Usage: npm run debug -- <command> [options]

Commands:
  find       Search durable debug evidence
  inspect    Inspect one logical model invocation
  lineage    Show parent, repair, retry, and child relations
  events     List indexed runtime events
  artifact   Read one complete recorded artifact
  explain    Explain a diagnostic code and its owning source
  doctor     Check Ledger and debug-index integrity
  replay     Replay one execution using recorded model outputs (optionally one probe overlay)
  compare    Compare two executions by semantic partitions
  export     Export one execution, events, artifacts, and metrics

Identifier options:
  --invocation <public-id> --source-invocation <id> --execution <id>
  --instance <id> --request <id> --trace <id> --span <id>
  --event <sequence> --artifact <hash> --issue <code>

Common options:
  --database <sqlite> --format json|ndjson|table --output <file>
  --limit <1..100> --cursor <cursor> --from <ISO> --to <ISO>
  --component <name> --operation <name> --event-name <name> --payload
  replay options: --probe-report <report.json> --trial <n>
`;
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function integer(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer`);
  return parsed;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0] ?? "";
  const query: DebugQuery = {};
  const positional: string[] = [];
  let format: DebugOutputFormat = "json";
  let database = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v25", "livingworld.sqlite");
  let output: string | undefined;
  let includePayload = false;
  let rebuildIndex = false;
  let probeReport: string | undefined;
  let trial = 1;
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (value === "--help") throw new Error(usage());
    if (value === "--payload" || value === "--include-payload") { includePayload = true; continue; }
    if (value === "--rebuild-index") { rebuildIndex = true; continue; }
    if (value === "--database") { database = path.resolve(requiredValue(argv, ++index, value)); continue; }
    if (value === "--output") { output = path.resolve(requiredValue(argv, ++index, value)); continue; }
    if (value === "--probe-report") { probeReport = path.resolve(requiredValue(argv, ++index, value)); continue; }
    if (value === "--trial") {
      trial = integer(requiredValue(argv, ++index, value), value);
      if (trial < 1) throw new Error("--trial must be a positive integer");
      continue;
    }
    if (value === "--format") {
      const candidate = requiredValue(argv, ++index, value) as DebugOutputFormat;
      if (!new Set<DebugOutputFormat>(["json", "ndjson", "table"]).has(candidate)) throw new Error("--format must be json, ndjson, or table");
      format = candidate;
      continue;
    }
    const stringOptions: Record<string, keyof DebugQuery> = {
      "--invocation": "invocationId",
      "--source-invocation": "sourceInvocationId",
      "--execution": "executionId",
      "--instance": "instanceId",
      "--request": "requestId",
      "--trace": "traceId",
      "--span": "spanId",
      "--artifact": "artifactHash",
      "--issue": "diagnosticCode",
      "--component": "component",
      "--operation": "operation",
      "--event-name": "eventName",
      "--from": "from",
      "--to": "to",
      "--cursor": "cursor",
    };
    const key = stringOptions[value];
    if (key) {
      if (key === "component") {
        const component = requiredValue(argv, ++index, value);
        if (!new Set(["http", "world-host", "scheduler", "simulation", "algorithm", "model", "persistence", "inspector", "cli", "ui"]).has(component)) {
          throw new Error("--component must be a known debug component");
        }
        (query as Record<string, unknown>)[key] = component;
        continue;
      }
      (query as Record<string, unknown>)[key] = requiredValue(argv, ++index, value);
      continue;
    }
    if (value === "--event") { query.eventSequence = integer(requiredValue(argv, ++index, value), value); continue; }
    if (value === "--limit") {
      query.limit = integer(requiredValue(argv, ++index, value), value);
      if (query.limit < 1 || query.limit > 100) throw new Error("--limit must be from 1 through 100");
      continue;
    }
    throw new Error(`unknown option: ${value}`);
  }
  query.includePayload = includePayload;
  return { command, query, format, database, output, includePayload, rebuildIndex, positional, probeReport, trial };
}

function idFromQuery(result: DebugSearchResult, query: DebugQuery): string | undefined {
  if (query.invocationId) return query.invocationId;
  return result.invocations[0]?.id;
}

function tableOutput(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map((entry) => JSON.stringify(entry)).join("\n");
  const record = value as Record<string, unknown>;
  const rows = [record];
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return `${keys.join("\t")}\n${keys.map((key) => JSON.stringify(record[key] ?? "")).join("\t")}`;
}

function writeOutput(value: unknown, parsed: ParsedArguments): void {
  const serialized = parsed.format === "table"
    ? tableOutput(value)
    : parsed.format === "ndjson" && Array.isArray(value)
      ? value.map((entry) => JSON.stringify(entry)).join("\n")
      : JSON.stringify(value, null, 2);
  if (parsed.output) writeFileSync(parsed.output, `${serialized}\n`, "utf8");
  else process.stdout.write(`${serialized}\n`);
}

function commandError(error: unknown): { apiVersion: typeof DEBUG_API_VERSION; error: { code: string; message: string; retryability: "not_retryable" | "retryable" | "unknown"; suggestedCommands: string[] } } {
  const message = error instanceof Error ? error.message : String(error);
  const code = message.includes("not found")
    ? "debug.not_found"
    : message.includes("schema") || message.includes("index") || message.includes("integrity") ||
        message.includes("probe report") || message.includes("probe trial") || message.includes("probe request") ||
        message.includes("probe overlay") || message.includes("probe target")
      ? "debug.integrity"
      : message.includes("requires") || message.includes("unknown option") || message.includes("must be") || message.includes("invalid") ||
          message.includes("supported only")
        ? "debug.invalid_arguments"
        : "debug.command_failed";
  return {
    apiVersion: DEBUG_API_VERSION,
    error: {
      code,
      message,
      retryability: code === "debug.command_failed" ? "unknown" : "not_retryable",
      suggestedCommands: code === "debug.not_found" ? ["npm run debug -- doctor", "npm run debug -- find --execution <execution-id>"] : ["npm run debug -- --help"],
    },
  };
}

export async function runDebugCommand(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help")) {
    process.stdout.write(usage());
    return 0;
  }
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
    if (!parsed.command) throw new Error(usage());
    if (parsed.command !== "replay" && (parsed.probeReport || parsed.trial !== 1)) {
      throw new Error("--probe-report/--trial are supported only by replay");
    }
  } catch (error) {
    writeOutput(commandError(error), { command: "", query: {}, format: "json", database: "", includePayload: false, rebuildIndex: false, positional: [], trial: 1 });
    return 3;
  }

  let database: LocalDatabase | undefined;
  try {
    const needsWriter = parsed.command === "replay" || (parsed.command === "doctor" && parsed.rebuildIndex);
    const store = new LocalDatabase(parsed.database, { heartbeat: false, readOnly: !needsWriter });
    database = store;
    if (parsed.command === "doctor") {
      if (parsed.rebuildIndex) store.debugRebuildIndex();
      const report = store.debugDoctor();
      writeOutput(report, parsed);
      return report.indexFresh ? 0 : 4;
    }
    if (parsed.command === "explain") {
      const code = parsed.positional[0] ?? parsed.query.diagnosticCode;
      if (!code) throw new Error("explain requires a diagnostic code");
      writeOutput(store.debugExplain(code), parsed);
      return 0;
    }
    if (parsed.command === "artifact") {
      const hash = parsed.query.artifactHash ?? parsed.positional[0];
      if (!hash) throw new Error("artifact requires --artifact <hash>");
      const artifact = store.debugArtifact(hash);
      if (!artifact) throw new Error(`artifact not found: ${hash}`);
      writeOutput(artifact, parsed);
      return 0;
    }
    if (parsed.command === "inspect" || parsed.command === "lineage") {
      let invocationId = parsed.query.invocationId;
      if (!invocationId) invocationId = idFromQuery(store.debugQuery(parsed.query), parsed.query);
      if (!invocationId) throw new Error("model invocation not found");
      const inspection = store.debugInspect(invocationId, parsed.includePayload);
      if (!inspection) throw new Error(`model invocation not found: ${invocationId}`);
      writeOutput(parsed.command === "lineage" ? {
        apiVersion: inspection.apiVersion,
        id: inspection.id,
        lineage: inspection.lineage,
        related: inspection.lineage.map((relation) => relation.id),
      } : inspection, parsed);
      return 0;
    }
    if (parsed.command === "find" || parsed.command === "events") {
      const query = parsed.command === "events" ? { ...parsed.query, includePayload: parsed.includePayload } : parsed.query;
      const result = store.debugQuery(query);
      writeOutput(parsed.command === "events" ? result.events : result, parsed);
      return result.total > 0 ? 0 : 2;
    }
    if (parsed.command === "replay" || parsed.command === "compare" || parsed.command === "export") {
      const ids = parsed.positional.length > 0 ? parsed.positional : [parsed.query.executionId].filter((value): value is string => Boolean(value));
      if ((parsed.command === "replay" || parsed.command === "export") && ids.length !== 1) throw new Error(`${parsed.command} requires one execution id`);
      if (parsed.command === "compare" && ids.length !== 2) throw new Error("compare requires two execution ids");
      const executionIds = ids;
      const executions = executionIds.map((id) => store.execution(id));
      if (executions.some((execution) => !execution)) throw new Error("one or more executions not found");
      if (parsed.command === "export") {
        const execution = executions[0]!;
        const events = store.executionEvents(execution.id);
        const artifactHashes = [...new Set(events.flatMap((event) => event.payload === undefined ? [] : [contentHash(event.payload)]))];
        writeOutput({
          schemaVersion: 1,
          execution,
          events,
          artifacts: artifactHashes.flatMap((hash) => {
            const artifact = store.artifact(hash);
            return artifact ? [{ hash: artifact.hash, executionId: artifact.executionId, kind: artifact.kind, mediaType: artifact.mediaType, encoding: artifact.encoding, rawBytes: artifact.rawBytes, storedBytes: artifact.storedBytes, createdAt: artifact.createdAt }] : [];
          }),
          metrics: aggregateMetricPoints(EXECUTION_METRICS.derive(events)),
          work: deriveExecutionWork(events),
        }, parsed);
        return 0;
      }
      if (parsed.command === "compare") {
        const { candidatePartitions } = await import("./execution-command");
        const partitions = executionIds.map((id) => candidatePartitions(store.executionEvents(id)));
        const names = [...new Set([...Object.keys(partitions[0]!), ...Object.keys(partitions[1]!)])].sort();
        writeOutput({
          left: { id: executions[0]!.id, semanticHash: executions[0]!.semanticHash },
          right: { id: executions[1]!.id, semanticHash: executions[1]!.semanticHash },
          partitions: Object.fromEntries(names.map((name) => {
            const left = partitions[0]![name as keyof typeof partitions[0]] ?? null;
            const right = partitions[1]![name as keyof typeof partitions[1]] ?? null;
            return [name, { equal: contentHash(left) === contentHash(right), leftHash: contentHash(left), rightHash: contentHash(right) }];
          })),
        }, parsed);
        return 0;
      }
      const { replayThroughAlgorithm } = await import("./execution-command");
      const { loadInvocationProbeReport } = await import("../../src/engine/models/model-invocation-probe");
      const original = executions[0]!;
      if (!parsed.probeReport && parsed.trial !== 1) throw new Error("--trial requires --probe-report");
      const probe = parsed.probeReport ? loadInvocationProbeReport(parsed.probeReport, parsed.trial) : undefined;
      const result = await replayThroughAlgorithm(store, original, store.executionEvents(original.id), undefined, { probe });
      const output = {
        executionId: original.id,
        recordedSemanticHash: original.semanticHash,
        recordedStateHash: original.stateHash,
        ...result,
        semanticMatch: result.semanticHash !== undefined && original.semanticHash === result.semanticHash,
        stateMatch: result.stateHash !== undefined && original.stateHash === result.stateHash,
        semanticHashComparison: {
          original: original.semanticHash ?? null,
          replay: result.semanticHash ?? null,
          equal: result.semanticHash !== undefined && original.semanticHash === result.semanticHash,
        },
        stateHashComparison: {
          original: original.stateHash ?? null,
          replay: result.stateHash ?? null,
          equal: result.stateHash !== undefined && original.stateHash === result.stateHash,
        },
        networkAccessed: false,
        replayNetworkAccessed: false,
        probeNetworkAccessed: Boolean(probe),
      };
      writeOutput(output, parsed);
      if (probe) return 0;
      return output.semanticMatch && output.stateMatch ? 0 : 4;
    }
    throw new Error(`unknown debug command: ${parsed.command}`);
  } catch (error) {
    writeOutput(commandError(error), parsed);
    const code = commandError(error).error.code;
    return code === "debug.not_found" ? 2 : code === "debug.invalid_arguments" ? 3 : code === "debug.integrity" ? 4 : 5;
  } finally {
    database?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runDebugCommand(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
