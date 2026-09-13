import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Ajv from "ajv";
import { perceptionCheckDomainsSchema } from "../../src/engine/benchmarks/step-efficiency/perception-check-domains";
import { perceptionCatalogTransport, PERCEPTION_CATALOG_TRANSPORT } from "../../src/engine/benchmarks/step-efficiency/perception-catalog-transport";
import { perceptionDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelConfigurationError, ModelOutputError, modelInvocationIdentity, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../src/engine/runtime/observability";

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing source record");
  return value as Value;
};
const rows = (value: unknown): Value[] => {
  if (!Array.isArray(value)) throw new Error("Missing source rows");
  return value.map(record);
};
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (root: string, name: string, value: unknown) => writeFileSync(path.join(root, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

const visibilityBranches = `\n\nPerception decision table (apply independently to each assigned observer/source-action pair):
- Established sensory or informational access, with no required check: return perceived and its present observer-specific stimulus. Ordinary speech heard by its actual recipient is a stimulus even when noticing it is easy or certain. No check required does not mean no stimulus.
- Established absence of any route, or a failed required committed check: return no_stimulus. A plan to travel, send a message or meet later does not establish present access. Being assigned a pair does not establish access.
- Supported consequential uncertainty or an authored check requirement: request the justified check. Do not label uncertainty no_stimulus simply to finish, and do not roll for work quality or the action's eventual success.
When returning done, reports may mix perceived and no_stimulus; decide each pair from its own evidence. The outer done means no additional justified check is needed, not that every observer has the same perception status. Keep the observer, source actor and intended recipient distinct. All original schema fields, exact references, authored remote routes and local identity rules remain mandatory.`;

/** Complete initial perception source, B/C/C/B; no repair, continuation or world commit. */
export async function runPerceptionCheckProbe(argv: string[]) {
  const [sourceRoot, output, mode = "preflight", candidate = "check-domains"] = argv;
  if (!sourceRoot || !output || argv.length > 4 || !["preflight", "run"].includes(mode) ||
    !["check-domains", "visibility-branches", "catalog-records"].includes(candidate)) throw new Error("Expected source-player-directory output-directory [preflight|run] [check-domains|visibility-branches|catalog-records]");
  const codeRevision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const patch = execFileSync("git", ["diff", "--binary", "HEAD"], { encoding: "utf8" });
  const producerFiles = [process.argv[1]!, "src/engine/benchmarks/step-efficiency/perception-check-domains.ts", "package-lock.json",
    ...(candidate === "catalog-records" ? ["src/engine/benchmarks/step-efficiency/perception-catalog-transport.ts", "src/engine/mechanics/shared-catalog-records.ts"] : [])];
  const producerHashes = () => Object.fromEntries(producerFiles.map(file => [file, contentHash(readFileSync(file, "utf8"))]));
  const boundProducer = producerHashes();
  mkdirSync(output, { recursive: false });
  const events = read(path.join(sourceRoot, "run/ledger-events.json")) as Array<RuntimeEvent & { sequence: number }>;
  const input = record(events.find(event => event.event === "step.preparation.started")?.payload);
  if (Object.keys(record(record(input.state).agents)).length !== 49 ||
    Object.values(record(input.policyRoster)).filter(value => record(value).kind === "external").length !== 1) throw new Error("Expected complete 48 plus player source");
  const sources = events.filter(event => event.event === "model.context.serialized" && event.correlation?.modelRole === "truth-perception" &&
    (event.correlation.semanticRepairAttempt ?? 0) === 0).slice(0, 1).map(event => {
    const source = record(event.payload), id = event.correlation!.modelInvocationId;
    const transport = events.find(entry => entry.event === "model.transport.request.raw" && entry.correlation?.modelInvocationId === id);
    const parsed = events.find(entry => entry.event === "model.structured_output.parsed" && entry.correlation?.modelInvocationId === id);
    if (!transport || !parsed) throw new Error("Missing source request or parsed decision");
    const rawBody = record(transport.payload).body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    const user = rows(record(body).messages).find(message => message.role === "user");
    const encodedSchema = String(user?.content).match(/(?:^|\n)JSON Schema: ([^\n]+)/)?.[1];
    if (!encodedSchema) throw new Error("Missing source wire schema literal");
    const schema = JSON.parse(encodedSchema);
    if (contentHash(schema) !== contentHash(source.schema)) throw new Error("Source wire schema identity mismatch");
    // Ledger objects use canonical key ordering; the actual HTTP schema literal preserves its generation order.
    return { event, source: record({ ...source, schema }), body,
      targets: rows(record(record(record(source.context).task).assignment).perceptionTargets) };
  });
  if (sources.length !== 1) throw new Error("Missing initial perception source");
  const catalog = loadModelCatalog(path.join(sourceRoot, "models.yaml"));
  const registry = new ModelRegistry(catalog, path.join(sourceRoot, "data"));
  const network = createModelFetchResolver(process.env), captured = new Map<string, unknown>();
  let phase: "capture" | "run" = "capture", active = "", totalHttp = 0;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const gateway = createModelGateway(catalog, process.env, { registry: { catalog,
    capture: async hash => registry.snapshot(hash ?? String(sources[0]!.source.registrySnapshotHash)),
    refresh: async () => { throw new ModelConfigurationError("Frozen registry"); }, status: () => registry.status(),
  }, maxTransportAttempts: 1, fetchForAccount: (accountId, account) => {
    const send = network(accountId, account) ?? fetch;
    return async (input, init) => {
      const request = new Request(input, init);
      let body = await request.clone().json();
      if (accountId !== "deepseek-api" || body.model !== "deepseek-flash" || body.thinking?.type !== "disabled") throw new ModelConfigurationError("Inference drift");
      const arm = active.split("-")[1];
      if (arm === "C" && candidate === "catalog-records") {
        body = perceptionCatalogTransport(body, sources[0]!.source.context);
      }
      if (arm === "B" && contentHash(body) !== contentHash(sources[0]!.body)) {
        save(output, `${active}-source-body.json`, sources[0]!.body);
        save(output, `${active}-mismatch-body.json`, body);
        throw new ModelConfigurationError("Baseline HTTP differs from source");
      }
      if (phase === "capture") {
        captured.set(active, body);
        throw new ModelConfigurationError("Captured without network");
      }
      if (totalHttp >= 4 || contentHash(body) !== contentHash(captured.get(active))) throw new ModelConfigurationError("Request or call ceiling drift");
      if (contentHash(producerHashes()) !== contentHash(boundProducer)) throw new ModelConfigurationError("Frozen producer files changed");
      totalHttp++;
      // Preserve the account transport's original URL/init calling convention.
      return send(input, arm === "C" && candidate === "catalog-records" ? { ...init, body: JSON.stringify(body) } : init);
    };
  } });
  const requests = [["B", "C"], ["C", "B"]].flatMap((arms, ordinal) => arms.map(arm => {
    const row = sources[0]!;
    const p = row.source;
    if (p.modelCatalogHash !== catalog.hash || p.modelId !== "deepseek-flash") throw new Error("Source model binding drift");
    registry.snapshot(String(p.registrySnapshotHash));
    const workloadId = String(record(record(p.context).execution).instanceId), batchId = `perception-check-domains-${ordinal}-${arm}`;
    const identity = modelInvocationIdentity({ workloadId, batchId,
      runtimeIdentity: { worldHash: String(record(input.state).worldHash), revision: Number(record(input.state).revision) },
    }, "truth-perception", String(p.subjectId), 1);
    const request: StructuredModelRequest<unknown> = { role: "truth-perception", schemaName: "truth_perception_directive",
      workloadId, batchId, ...identity,
      subjectId: String(p.subjectId), profileId: String(p.profileId), modelRegistrySnapshotHash: String(p.registrySnapshotHash),
      system: String(p.system), userPrompt: String(p.userPrompt), context: p.context,
      promptVersion: String(p.promptVersion), schema: perceptionDirectiveSchema, wireJsonSchema: record(p.schema),
      jsonObjectPostlude: typeof p.jsonObjectPostlude === "string" ? p.jsonObjectPostlude : undefined,
      jsonSyntaxRecovery: p.jsonSyntaxRecovery as StructuredModelRequest<unknown>["jsonSyntaxRecovery"],
      ...(arm === "C" && candidate === "check-domains" ? { wireJsonSchema: perceptionCheckDomainsSchema(p.context, record(p.schema)),
        promptVersion: `${p.promptVersion}/perception-check-domains-v1@${contentHash(perceptionCheckDomainsSchema(p.context, record(p.schema))).slice(0, 16)}` } : {}),
      ...(arm === "C" && candidate === "visibility-branches" ? {
        jsonObjectPostlude: `${p.jsonObjectPostlude ?? ""}${visibilityBranches}`,
        promptVersion: `${p.promptVersion}/perception-visibility-branches-v1@${contentHash(visibilityBranches).slice(0, 16)}` } : {}),
      ...(arm === "C" && candidate === "catalog-records" ? { promptVersion: `${p.promptVersion}/${PERCEPTION_CATALOG_TRANSPORT}` } : {}),
    };
    return { id: `${ordinal}-${arm}`, ordinal, arm, request };
  }));
  for (const entry of requests) {
    active = entry.id;
    try { await gateway.generateStructured(entry.request); }
    catch (error) { if (!captured.has(active)) throw error; }
  }
  save(output, "manifest.json", { protocol: `perception-${candidate}-paired-v1`, candidate, mode,
    physicalTransportTransform: candidate === "catalog-records" ? PERCEPTION_CATALOG_TRANSPORT : null,
    requestAuditBoundary: "Saved *-http-request.json and requestHashes bind the actual transmitted body. Gateway request audits precede the experimental physical transform; canonical output validation retains the complete original source catalog.",
    codeRevision, producerHashes: boundProducer, sourcePatchHash: contentHash(patch),
    runnerHash: contentHash(readFileSync(new URL(import.meta.url), "utf8")), sourceEventsHash: contentHash(events),
    catalogHash: catalog.hash, sourceCohort: 49, perceptionTargets: sources[0]!.targets.length, repetitionsPerArm: 2, maxNewHttp: 4, maxRepairHttp: 0,
    order: requests.map(entry => entry.id), requestHashes: Object.fromEntries([...captured].map(([id, body]) => [id, contentHash(body)])),
    sourceInvocations: sources.map(row => ({ sequence: row.event.sequence, id: row.event.correlation?.modelInvocationId, subject: row.source.subjectId, targets: row.targets })),
    qualification: "Source-level schema/reference and compiled-relation screen only; justified uncertainty and report semantics require separate review. All upstream work is imported; no player latency, persisted action completion or independent intent qualification is established." });
  for (const [id, body] of captured) save(output, `${id}-http-request.json`, body);
  writeFileSync(path.join(output, "source.patch"), patch, { flag: "wx" });
  if (mode === "preflight") return { sourceMatched: true, perceptionTargets: sources[0]!.targets.length, newHttp: 0 };
  const validationSchema = JSON.parse(JSON.stringify(perceptionCheckDomainsSchema(sources[0]!.source.context, record(sources[0]!.source.schema))),
    (key, value) => key === "pattern" && typeof value === "string" && value.includes("\\p{") ? undefined : value);
  // The gateway keeps canonical Zod patterns; Ajv 6 checks the additional Draft-07 relations.
  const validateRelations = new Ajv({ schemaId: "auto", unknownFormats: "ignore" }).compile(validationSchema);
  phase = "run";
  const results = [];
  try {
    for (const entry of requests) {
      active = entry.id;
      const started = performance.now();
      let row: Value;
      try {
        const result = await gateway.generateStructured({ ...entry.request, observer });
        const decision = perceptionDirectiveSchema.parse(result.value);
        const relationAccepted = Boolean(validateRelations(decision));
        row = { id: active, subject: entry.request.subjectId, schemaAccepted: true, relationAccepted,
          issues: relationAccepted ? [] : structuredClone(validateRelations.errors),
          kind: decision.kind, checkCount: decision.kind === "request_checks" ? decision.requests.length : 0,
          output: decision, audit: result.audit, elapsedMs: performance.now() - started };
      } catch (error) {
        if (!(error instanceof ModelOutputError)) throw error;
        row = { id: active, subject: entry.request.subjectId, schemaAccepted: false, relationAccepted: false,
          error: String(error), output: error.rawValue, audit: error.audit, elapsedMs: performance.now() - started };
      }
      save(output, `${active}-result.json`, row); results.push(row);
      process.stdout.write(`${JSON.stringify({ id: active, schemaAccepted: row.schemaAccepted, relationAccepted: row.relationAccepted, elapsedMs: row.elapsedMs, totalHttp })}\n`);
    }
  } finally {
    save(output, "events.json", observer.snapshot());
    save(output, "result.json", { newHttp: totalHttp, completed: results.length === requests.length,
      results: results.map(({ output: _output, audit: _audit, ...row }) => { void _output; void _audit; return row; }), wholeGoalAchieved: false });
  }
  return { newHttp: totalHttp, completed: results.length === requests.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPerceptionCheckProbe(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
