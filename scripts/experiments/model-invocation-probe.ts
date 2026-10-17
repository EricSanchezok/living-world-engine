import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactRuntimePayload } from "../../src/engine/runtime/observability";
import {
  loadInvocationSource,
  loadVariant,
  runInvocationProbe,
  type LoadInvocationSourceOptions,
} from "../../src/engine/models/model-invocation-probe";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";

interface ParsedArguments {
  invocationId: string;
  database: string;
  dataRoot: string;
  catalog: string;
  source: NonNullable<LoadInvocationSourceOptions["source"]>;
  apiUrl: string;
  profileId?: string;
  variantPath?: string;
  repeat: number;
  output?: string;
  allowDrift: boolean;
}

function usage(): string {
  return `Usage: npm run experiment:model-invocation -- <public-invocation-id> [options]

Options:
  --profile <id>             Use another profile (recorded profile is the default)
  --variant <file>           Load a request/output variant module
  --repeat <1..100>          Run independent trials (default: 1)
  --source auto|api|sqlite   Read source evidence (default: auto)
  --api-url <url>            Local workbench URL (default: http://127.0.0.1:3000)
  --database <sqlite>        Ledger path (default: .livingworld-v36/livingworld.sqlite)
  --catalog <yaml>           Model catalog path (default: config/models.yaml)
  --output <file>            Write the complete JSON report to a file
  --allow-drift              Allow a recorded-profile baseline to run after drift
  --help                     Show this help
`;
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function parseRepeat(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new Error("--repeat must be an integer from 1 through 100");
  }
  return parsed;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.includes("--help")) throw new Error(usage());
  const positional: string[] = [];
  let dataRoot = path.resolve(process.env.LIVINGWORLD_DATA_ROOT ?? ".livingworld-v36");
  let database = path.join(dataRoot, "livingworld.sqlite");
  let catalog = path.resolve(process.env.LIVINGWORLD_MODEL_CATALOG_PATH ?? "config/models.yaml");
  let source: ParsedArguments["source"] = "auto";
  let apiUrl = "http://127.0.0.1:3000";
  let profileId: string | undefined;
  let variantPath: string | undefined;
  let repeat = 1;
  let output: string | undefined;
  let allowDrift = false;
  let databaseExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (value === "--profile") profileId = requiredValue(argv, ++index, value);
    else if (value === "--variant") variantPath = path.resolve(requiredValue(argv, ++index, value));
    else if (value === "--repeat") repeat = parseRepeat(requiredValue(argv, ++index, value));
    else if (value === "--source") {
      const candidate = requiredValue(argv, ++index, value) as ParsedArguments["source"];
      if (!(candidate === "auto" || candidate === "api" || candidate === "sqlite")) {
        throw new Error("--source must be auto, api, or sqlite");
      }
      source = candidate;
    } else if (value === "--api-url") apiUrl = requiredValue(argv, ++index, value).replace(/\/$/u, "");
    else if (value === "--database") {
      database = path.resolve(requiredValue(argv, ++index, value));
      databaseExplicit = true;
    }
    else if (value === "--catalog") catalog = path.resolve(requiredValue(argv, ++index, value));
    else if (value === "--output") output = path.resolve(requiredValue(argv, ++index, value));
    else if (value === "--allow-drift") allowDrift = true;
    else throw new Error(`unknown option: ${value}`);
  }
  if (positional.length !== 1) throw new Error("exactly one public invocation id is required");
  if (databaseExplicit && !process.env.LIVINGWORLD_DATA_ROOT) dataRoot = path.dirname(database);
  return { invocationId: positional[0]!, database, dataRoot, catalog, source, apiUrl, profileId, variantPath, repeat, output, allowDrift };
}

function writeReport(report: unknown, output?: string): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, serialized, "utf8");
  else process.stdout.write(serialized);
}

function writeError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${JSON.stringify({ error: redactRuntimePayload(message) })}\n`);
}

export async function runModelInvocationProbe(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    if (error instanceof Error && error.message === usage()) {
      process.stdout.write(usage());
      return 0;
    }
    writeError(error);
    return 2;
  }
  try {
    const catalog = loadModelCatalog(parsed.catalog);
    const registry = new ModelRegistry(catalog, parsed.dataRoot);
    const source = await loadInvocationSource(parsed.invocationId, {
      database: parsed.database,
      source: parsed.source,
      apiUrl: parsed.apiUrl,
    });
    const loadedVariant = parsed.variantPath ? await loadVariant(parsed.variantPath) : undefined;
    const report = await runInvocationProbe({
      source,
      catalog,
      registry,
      profileId: parsed.profileId,
      variant: loadedVariant?.variant,
      variantMetadata: loadedVariant?.metadata ?? null,
      repeat: parsed.repeat,
      allowDrift: parsed.allowDrift,
    });
    writeReport(report, parsed.output);
    return 0;
  } catch (error) {
    writeError(error);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runModelInvocationProbe(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
