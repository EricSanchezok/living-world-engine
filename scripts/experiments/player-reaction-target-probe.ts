import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { reactionTargetWireSchema } from "../../src/engine/algorithms/eager-reference/agent-mind";
import { reactionDecisionDraftSchema } from "../../src/engine/contracts/llm-schemas";
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

/** Project the existing materializer domain from a recorded private envelope. */
export function recordedReactionTargets(context: unknown): string[] {
  const source = record(context), state = record(source.state), perspective = record(state.perspective);
  const known = new Set([
    ...rows(record(perspective.knowledge).entities).map(entity => entity.entityRef),
    ...rows(record(state.stimulus).introductions).map(entity => entity.localEntityRef),
  ]);
  if ([...known].some(handle => typeof handle !== "string")) throw new Error("Invalid local identity projection");
  const candidates = rows(record(source.referenceCatalog).candidates);
  const handles = candidates.filter(candidate => candidate.kind === "local_entity" && known.has(candidate.handle) &&
    Array.isArray(candidate.allowedUses) && candidate.allowedUses.includes("target")).map(candidate => String(candidate.handle));
  if (new Set(handles).size !== handles.length || handles.length !== known.size) throw new Error("Incomplete recorded local target domain");
  return handles;
}

/** Same complete first-reaction cohort in both arms; no repair, replay or world commit. */
export async function runReactionTargetProbe(argv: string[]) {
  const [sourceRoot, output, mode = "preflight"] = argv;
  if (!sourceRoot || !output || argv.length > 3 || !["preflight", "run"].includes(mode)) throw new Error("Expected source-player-directory output-directory [preflight|run]");
  if (mode === "run" && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked code before paid comparison");
  mkdirSync(output, { recursive: false });
  const events = read(path.join(sourceRoot, "run/ledger-events.json")) as Array<RuntimeEvent & { sequence: number }>;
  const input = record(events.find(event => event.event === "step.preparation.started")?.payload);
  if (Object.keys(record(record(input.state).agents)).length !== 49 ||
    Object.values(record(input.policyRoster)).filter(value => record(value).kind === "external").length !== 1) throw new Error("Expected complete 48 plus player source");
  const sources = events.filter(event => event.event === "model.context.serialized" && event.correlation?.modelRole === "agent-reaction" &&
    (event.correlation.semanticRepairAttempt ?? 0) === 0).map(event => {
    const source = record(event.payload), id = event.correlation!.modelInvocationId;
    const transport = events.find(entry => entry.event === "model.transport.request.raw" && entry.correlation?.modelInvocationId === id);
    const parsed = events.find(entry => entry.event === "model.structured_output.parsed" && entry.correlation?.modelInvocationId === id);
    if (!transport || !parsed) throw new Error("Missing source request or parsed decision");
    const rawBody = record(transport.payload).body;
    const body = typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody;
    if (contentHash(source.schema) !== contentHash(z.toJSONSchema(reactionDecisionDraftSchema, { target: "draft-07" }))) throw new Error("Source reaction schema drift");
    return { event, source, body, targets: recordedReactionTargets(source.context), original: parsed.payload };
  });
  if (!sources.length || new Set(sources.map(row => row.source.subjectId)).size !== sources.length) throw new Error("Ambiguous first-reaction cohort");
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
      const request = new Request(input, init), body = await request.clone().json();
      if (accountId !== "deepseek-api" || body.model !== "deepseek-flash" || body.thinking?.type !== "disabled") throw new ModelConfigurationError("Inference drift");
      const [ordinal, arm] = active.split("-");
      if (arm === "B" && contentHash(body) !== contentHash(sources[Number(ordinal)]!.body)) throw new ModelConfigurationError("Baseline HTTP differs from source");
      if (phase === "capture") {
        captured.set(active, body);
        throw new ModelConfigurationError("Captured without network");
      }
      if (totalHttp >= sources.length * 2 || contentHash(body) !== contentHash(captured.get(active))) throw new ModelConfigurationError("Request or call ceiling drift");
      totalHttp++;
      return send(input, init);
    };
  } });
  const requests = sources.flatMap((row, ordinal) => (ordinal % 2 ? ["C", "B"] : ["B", "C"]).map(arm => {
    const p = row.source;
    if (p.modelCatalogHash !== catalog.hash || p.modelId !== "deepseek-flash") throw new Error("Source model binding drift");
    registry.snapshot(String(p.registrySnapshotHash));
    const workloadId = String(record(record(p.context).execution).instanceId), batchId = `reaction-domain-${ordinal}-${arm}`;
    const identity = modelInvocationIdentity({ workloadId, batchId,
      runtimeIdentity: { worldHash: String(record(input.state).worldHash), revision: Number(record(input.state).revision) },
    }, "agent-reaction", String(p.subjectId), 1);
    const request: StructuredModelRequest<unknown> = { role: "agent-reaction", schemaName: "agent_reaction_decision",
      workloadId, batchId, ...identity,
      subjectId: String(p.subjectId), profileId: String(p.profileId), modelRegistrySnapshotHash: String(p.registrySnapshotHash),
      system: String(p.system), userPrompt: String(p.userPrompt), context: p.context,
      promptVersion: String(p.promptVersion), schema: reactionDecisionDraftSchema,
      jsonSyntaxRecovery: p.jsonSyntaxRecovery as StructuredModelRequest<unknown>["jsonSyntaxRecovery"],
      ...(arm === "C" ? { wireJsonSchema: reactionTargetWireSchema(row.targets),
        promptVersion: `${p.promptVersion}/reaction-target-domain-v1@${contentHash(reactionTargetWireSchema(row.targets)).slice(0, 16)}` } : {}),
    };
    return { id: `${ordinal}-${arm}`, ordinal, arm, request };
  }));
  for (const entry of requests) {
    active = entry.id;
    try { await gateway.generateStructured(entry.request); }
    catch (error) { if (!captured.has(active)) throw error; }
  }
  save(output, "manifest.json", { protocol: "reaction-target-domain-paired-v1", mode,
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runnerHash: contentHash(readFileSync(new URL(import.meta.url), "utf8")), sourceEventsHash: contentHash(events),
    catalogHash: catalog.hash, cohort: sources.length, maxNewHttp: sources.length * 2, maxRepairHttp: 0,
    order: requests.map(entry => entry.id), requestHashes: Object.fromEntries([...captured].map(([id, body]) => [id, contentHash(body)])),
    sourceInvocations: sources.map(row => ({ sequence: row.event.sequence, id: row.event.correlation?.modelInvocationId, subject: row.source.subjectId, targets: row.targets })),
    qualification: "Source-level target and schema screen only. All upstream work is imported; no player latency, persisted action completion or independent intent qualification is established." });
  for (const [id, body] of captured) save(output, `${id}-http-request.json`, body);
  if (mode === "preflight") return { sourceMatched: true, cohort: sources.length, newHttp: 0 };
  phase = "run";
  const results = [];
  try {
    for (const entry of requests) {
      active = entry.id;
      const started = performance.now();
      let row: Value;
      try {
        const result = await gateway.generateStructured({ ...entry.request, observer });
        const decision = reactionDecisionDraftSchema.parse(result.value), targets = sources[entry.ordinal]!.targets;
        const invalidTargets = decision.kind === "replace" ? decision.replacementAction.targetHandles.filter(handle => !targets.includes(handle)) : [];
        row = { id: active, subject: entry.request.subjectId, schemaAccepted: true, targetDomainAccepted: !invalidTargets.length,
          invalidTargets, output: decision, audit: result.audit, elapsedMs: performance.now() - started };
      } catch (error) {
        if (!(error instanceof ModelOutputError)) throw error;
        row = { id: active, subject: entry.request.subjectId, schemaAccepted: false, targetDomainAccepted: false,
          error: String(error), output: error.rawValue, audit: error.audit, elapsedMs: performance.now() - started };
      }
      save(output, `${active}-result.json`, row); results.push(row);
      process.stdout.write(`${JSON.stringify({ id: active, schemaAccepted: row.schemaAccepted, targetDomainAccepted: row.targetDomainAccepted, elapsedMs: row.elapsedMs, totalHttp })}\n`);
    }
  } finally {
    save(output, "events.json", observer.snapshot());
    save(output, "result.json", { newHttp: totalHttp, completed: results.length === requests.length,
      results: results.map(({ output: _output, audit: _audit, ...row }) => { void _output; void _audit; return row; }), wholeGoalAchieved: false });
  }
  return { newHttp: totalHttp, completed: results.length === requests.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runReactionTargetProbe(process.argv.slice(2)).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${String(error)}\n`); process.exitCode = 1; });
}
