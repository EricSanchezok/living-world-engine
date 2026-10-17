import { randomUUID } from "node:crypto";
import path from "node:path";
import { defineEngineOperationManifest } from "../../src/engine/runtime/execution";
import { contentHash } from "../../src/engine/models/model-audit";
import { LocalDatabase } from "../../src/server/local-database";
import { runtimeCodeIdentity } from "../../src/server/code-identity";
import { parseExperimentMatrix, runDeterministicExperiment } from "./experiment-core";

function extractDatabase(argv: readonly string[]): { database: string; matrixArgs: string[] } {
  let database = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v36", "livingworld.sqlite");
  const matrixArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--database") database = path.resolve(argv[++index] ?? "");
    else matrixArgs.push(argv[index]);
  }
  return { database, matrixArgs };
}

async function main(): Promise<void> {
  const input = extractDatabase(process.argv.slice(2));
  const matrix = parseExperimentMatrix(input.matrixArgs, { agents: [1, 10, 50, 1000], steps: [1] });
  const database = new LocalDatabase(input.database);
  const code = runtimeCodeIdentity();
  const parentExecutionId = randomUUID();
  const parentManifest = defineEngineOperationManifest({
    id: "deterministic-runtime-matrix",
    version: "2",
    config: matrix,
  });
  const trace = database.beginExecution({
    id: parentExecutionId,
    kind: "benchmark",
    manifest: parentManifest,
    worldHash: contentHash("test/fixtures/open-world-script"),
    codeRevision: code.revision,
    codeDirty: code.dirty,
    modelCatalogHash: contentHash("deterministic-test-catalog"),
    seed: 20260823,
    runtimeConfig: matrix,
  });
  try {
    trace.emit({ event: "benchmark.matrix.started", payload: matrix });
    const result = await runDeterministicExperiment({
      ...matrix,
      ledger: database,
      parentExecutionId,
    });
    trace.emit({ event: "benchmark.matrix.completed", payload: result.scenarios });
    database.finishExecution(parentExecutionId, {
      status: "succeeded",
      semanticHash: contentHash(result.scenarios),
    });
    process.stdout.write(`${JSON.stringify({ parentExecutionId, scenarios: result.scenarios }, null, 2)}\n`);
  } catch (error) {
    if (database.execution(parentExecutionId)?.status === "running") {
      database.finishExecution(parentExecutionId, { status: "failed", error });
    }
    throw error;
  } finally {
    database.close();
  }
}

void main().catch((error) => {
  process.stderr.write(`experiment failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
