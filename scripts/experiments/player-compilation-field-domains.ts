import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadOfficialSourceShard } from "./refresh-action-compilation-reference";
import { defineAlgorithmRef } from "../../src/engine/algorithms/composition";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { compilationFieldDomains, compilationFieldDomainsRequest, COMPILATION_FIELD_DOMAINS } from "../../src/engine/benchmarks/step-efficiency/compilation-field-domains";
import { TypedCompilationAliases, TYPED_COMPILATION_ALIASES } from "../../src/engine/benchmarks/step-efficiency/typed-compilation-aliases";
import { completeDeepSeekJsonStream } from "../../src/engine/models/deepseek-json-stream";
import { parseLastJsonValueWithRecovery } from "../../src/engine/models/model-adapter";
import { executeCompilationTrial, type CompilationTrialIdentity, type FirstPassTrialEvidence } from "../../src/engine/benchmarks/action-compilation/first-pass-runner";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import type { RuntimeEvent } from "../../src/engine/runtime/observability";
import type { SimulationState } from "../../src/engine/contracts/model";

const baseProtocol = { id: "player-compilation-field-domains-v1", sourceExecution: "051ff12c-b99e-47a1-aef1-1d4d647c6cb5",
  sourceSizes: [4, 9, 12, 12, 12], arms: ["B", "C"], maxHttp: 10, maxDispatchMs: 600_000,
  model: "deepseek-flash", thinking: "disabled", candidate: COMPILATION_FIELD_DOMAINS,
  acceptance: "Replay all five original first responses offline through the actual gateway and compiler. B HTTP bodies must match historical source bytes; C retains identical context, canonical schema and original output processing. Complete original 49 actions and physical batch cardinalities in each arm. Freeze both requests before HTTP. One fresh primary per source and arm, alternating arm order; block all repairs and retries before network. Preserve initial rejection, blocked recovery, raw response, normalization, input/output/cache usage and wall time separately. No imported bootstrap cost is counted as new; no world commit or player latency claim. Require C all 49 first-pass and complete source-semantic review before any full-player diagnostic; single paired cohort cannot estimate reliability or isolate cache effects. Failed or missing usage stops later dispatch; never redraw." } as const;
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (directory: string, file: string, value: unknown) => writeFileSync(path.join(directory, file), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const codeHashes = () => Object.fromEntries(["scripts/experiments/player-compilation-field-domains.ts",
  "src/engine/benchmarks/step-efficiency/compilation-field-domains.ts", "src/engine/prompts/shared/compilation-field-domains.md",
  "src/engine/benchmarks/step-efficiency/typed-compilation-aliases.ts", "src/engine/prompts/shared/typed-compilation-aliases.md",
  "src/engine/benchmarks/action-compilation/first-pass-runner.ts", "src/engine/algorithms/eager-reference/represented-action-compiler.ts",
].map(file => [file, contentHash(readFileSync(file, "utf8"))]));

/** Reframe a complete recorded answer solely for offline representation replay. */
export function typedAliasReplay(raw: string, codec: TypedCompilationAliases,
  policy?: Parameters<typeof parseLastJsonValueWithRecovery>[1]) {
  const original = completeDeepSeekJsonStream(raw), text = original.choices[0]!.message.content;
  const parsed = parseLastJsonValueWithRecovery(text, policy), value = parsed.value;
  const encoded = codec.encodeOutput(value);
  if (contentHash(codec.decodeOutput(encoded)) !== contentHash(value)) throw new Error("Historical alias round-trip differs");
  const frame = { id: original.id, model: original.model, object: "chat.completion.chunk", created: 0,
    choices: [{ index: 0, delta: { role: "assistant", content: JSON.stringify(encoded) }, finish_reason: original.choices[0]!.finish_reason }], usage: original.usage };
  return { body: `data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`,
    proof: { originalValueHash: contentHash(value), originalTextHash: contentHash(text), originalRecovery: parsed.recovery,
      encodedValueHash: contentHash(encoded), dictionaryHash: codec.dictionaryHash,
      roundTripEqual: true, responseOrigin: "offline-reencoded-historical-response", usageOrigin: "historical; no new inference" } };
}

export async function compilationFieldDomainsProbe(mode: "prepare" | "run", root: string, sourceRoot: string,
  candidate: "field-domains" | "typed-aliases" = "field-domains") {
  const protocol = candidate === "field-domains" ? baseProtocol : { ...baseProtocol, id: "player-compilation-typed-aliases-v1",
    candidate: TYPED_COMPILATION_ALIASES, acceptance: `${baseProtocol.acceptance} C instead changes only exact catalog-typed aliases in declared reference fields and their wire descriptions. Historical C replay re-encodes the original complete response, proves exact round-trip and identical canonical validation/materialization. Raw wire hashes intentionally differ; no completion is imported into a live game.` };
  const sources = loadOfficialSourceShard(path.join(root, "source"));
  if (JSON.stringify(sources.map(source => source.actions.length).sort((a, b) => a - b)) !== JSON.stringify(protocol.sourceSizes) ||
    sources.some(source => source.sourceExecutionId !== protocol.sourceExecution || source.modelId !== protocol.model) ||
    new Set(sources.flatMap(source => source.actionIds)).size !== 49) throw new Error("Complete original 49-action source required");
  const catalog = loadModelCatalog(path.join(sourceRoot, "models.yaml")), registry = new ModelRegistry(catalog, path.join(sourceRoot, "data"));
  if (sources.some(source => source.modelCatalogHash !== catalog.hash)) throw new Error("Captured catalog drift");
  for (const source of sources) registry.snapshot(source.registrySnapshotHash);
  const originalState = read(path.join(sourceRoot, "run/initial-instance.json")).state as SimulationState;
  if (sources.some(source => source.stateHash !== contentHash(originalState))) throw new Error("Original ordered state differs from captured source");
  const binding = { protocol, codeHashes: codeHashes(), sourceHash: contentHash(sources), catalogHash: catalog.hash,
    originalStateOrderHash: contentHash(JSON.stringify(originalState)) };
  if (mode === "run") {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked code before live calls");
    if (contentHash(read(path.join(root, "manifest.json")).binding) !== contentHash(binding)) throw new Error("Frozen probe drift");
  }
  const directory = path.join(root, mode === "prepare" ? "preflight" : "run"); mkdirSync(directory, { recursive: false });
  save(directory, "binding.json", { ...binding, codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), mode });
  const ledger: RuntimeEvent[] = read(path.join(sourceRoot, "run/ledger-events.json"));
  const retrievalResources = createActionCompilationRetrievalRuntimeProvider();
  const network = createModelFetchResolver(process.env), started = performance.now();
  let totalHttp = 0, stopped: string | undefined;
  const rows: Array<{ source: string; arm: string; evidence: FirstPassTrialEvidence<CompilationTrialIdentity>; http: number }> = [];
  const stop = () => { stopped ??= "Operator stopped later dispatch"; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    for (const [sourceIndex, source] of sources.entries()) {
      const historical = (event: string) => {
        const found = ledger.filter(entry => entry.event === event && entry.correlation?.modelInvocationId === source.sourceInvocationId);
        if (found.length !== 1 || !found[0]!.payload) throw new Error(`Missing unique historical ${event}`);
        return found[0]!.payload as { body: string; status?: number };
      };
      const oldRequest = historical("model.transport.request.raw"), oldResponse = historical("model.transport.response.raw");
      const retrieval = retrievalResources.runtime(source.captureAlgorithmRef);
      if (!retrieval) throw new Error("Missing captured retrieval resources");
      const outputs: FirstPassTrialEvidence<CompilationTrialIdentity>[] = [];
      for (const arm of sourceIndex % 2 ? ["C", "B"] : ["B", "C"]) {
        if (stopped) throw new Error(stopped);
        const trialId = `source-${sourceIndex}-${arm}`, trialDirectory = path.join(directory, trialId);
        mkdirSync(trialDirectory, { recursive: false });
        let sends = 0, providerCalls = 0, newHttp = 0;
        let typed: TypedCompilationAliases | undefined;
        let replaySyntaxPolicy: Parameters<typeof parseLastJsonValueWithRecovery>[1];
        const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
          registry: { catalog, capture: async hash => registry.snapshot(hash ?? source.registrySnapshotHash),
            refresh: async () => { throw new ModelConfigurationError("Frozen registry refresh disabled"); }, status: () => registry.status() },
          fetchForAccount: (id, account) => {
            const send = network(id, account) ?? fetch;
            return async (input, init) => {
              const request = new Request(input, init), body = await request.clone().text(), parsed = JSON.parse(body);
              if (++sends !== 1 || id !== "deepseek-api" || parsed.model !== protocol.model || parsed.thinking?.type !== "disabled") throw new ModelConfigurationError("Primary-only model binding drift");
              save(trialDirectory, "request.json", { url: request.url, body: parsed, orderedBodyHash: contentHash(body) });
              if (mode === "prepare") {
                if (arm === "B" && body !== oldRequest.body) throw new ModelConfigurationError("Historical B request bytes differ");
                const replay = typed ? typedAliasReplay(oldResponse.body, typed, replaySyntaxPolicy) : undefined;
                if (replay) save(trialDirectory, "representation-replay.json", replay.proof);
                return new Response(replay?.body ?? oldResponse.body, { status: oldResponse.status ?? 200, headers: { "content-type": "text/event-stream" } });
              }
              const frozen = read(path.join(root, "preflight", trialId, "request.json"));
              if (frozen.orderedBodyHash !== contentHash(body)) throw new ModelConfigurationError("Frozen live request bytes differ");
              if (stopped || totalHttp >= protocol.maxHttp || performance.now() - started >= protocol.maxDispatchMs) throw new ModelConfigurationError("Dispatch ceiling reached");
              totalHttp++; newHttp++;
              save(trialDirectory, "dispatch.json", { ordinal: totalHttp, at: new Date().toISOString(), historical: false });
              const start = performance.now();
              try {
                const response = await send(input, init), text = await response.clone().text();
                save(trialDirectory, "response.json", { body: text, status: response.status, elapsedMs: performance.now() - start });
                return response;
              } catch (error) {
                stopped = error instanceof Error ? error.message : String(error);
                save(trialDirectory, "transport-error.json", { error: stopped, elapsedMs: performance.now() - start });
                throw error;
              }
            };
          } });
        const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => gateway.availableProfileSummaries(role),
          assertProfilesAvailable: ids => gateway.assertProfilesAvailable(ids), generateStructured: async request => {
            if (++providerCalls > 1 || (request.correlation?.semanticRepairAttempt ?? 0) > 0) {
              save(trialDirectory, `blocked-${providerCalls}.json`, { schemaName: request.schemaName, context: request.context, correlation: request.correlation });
              throw new ModelConfigurationError("Primary-only screen blocks repair before HTTP");
            }
            if (arm === "C" && candidate === "typed-aliases") {
              typed = new TypedCompilationAliases(request.context, request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }));
              replaySyntaxPolicy = request.jsonSyntaxRecovery;
            }
            const adapted = arm === "C" ? typed?.request(request) ?? compilationFieldDomainsRequest(request) : request;
            if (mode === "prepare") save(trialDirectory, "domains.json", { sourceContextHash: contentHash(request.context),
              adaptedContextHash: contentHash(adapted.context), domains: compilationFieldDomains(request.context),
              originalSchemaBytes: Buffer.byteLength(JSON.stringify(z.toJSONSchema(request.schema, { target: "draft-07" }))),
              candidateSchemaBytes: Buffer.byteLength(JSON.stringify(adapted.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }))) });
            return gateway.generateStructured(adapted);
          } };
        const algorithmRef = defineAlgorithmRef({ ...source.captureAlgorithmRef, id: `compilation-${candidate}-diagnostic`, version: "1",
          config: { arm, candidate: protocol.candidate, capturedProducer: source.captureAlgorithmManifestHash } });
        const represented = representedActionCompiler("AT", true, true, true);
        const evidence = await executeCompilationTrial({ source, provider, retrieval, algorithmRef,
          compiler: async (model, state, ...args) => {
            // Preserve independently recorded key order for JSON-in-description
            // strings and reference-choice ordering; all state values must match.
            if (contentHash(state) !== contentHash(originalState)) throw new ModelConfigurationError("Recorded source state values differ");
            const replayState = structuredClone(originalState);
            try { return await represented(model, replayState, ...args); }
            finally { if (contentHash(replayState) !== source.stateHash) throw new Error("Compiler mutated replay source"); }
          },
          executionPrefix: `compilation-${candidate}`, expectedCatalogHash: catalog.hash, expectedOutputMode: "json-object-zod",
          trial: { id: trialId, phase: "discovery", sourceId: source.sourceInvocationId, sourceIndex, repetition: 0, arm } });
        outputs.push(evidence);
        const row = { source: source.sourceInvocationId, arm, evidence, http: newHttp };
        rows.push(row); save(trialDirectory, "result.json", { ...row, responseOrigin: mode === "prepare" ? "replayed-historical-response" : "new-model-http" });
        const audit = evidence.calls[0]?.audit?.invocations[0];
        process.stdout.write(`${JSON.stringify({ mode, trialId, actions: source.actions.length, accepted: evidence.compilerAccepted,
          providerCalls, totalHttp, wallMs: evidence.wallMs, error: evidence.error?.message, audited: Boolean(audit) })}\n`);
        if (sends !== 1 || !audit || !Number.isFinite(audit.tokenUsage.input) || !Number.isFinite(audit.tokenUsage.output) ||
          audit.tokenUsage.reasoning !== 0) throw new Error("Missing first send, complete usage or nonthinking audit; later dispatch stopped");
        if (mode === "prepare") {
          // The initial persisted gateway audit precedes canonical compiler
          // materialization. Compare the final normalization at the same boundary.
          const normalized = ledger.filter(entry => entry.event === "model.output.normalized" && entry.correlation?.modelInvocationId === source.sourceInvocationId).at(-1);
          const oldAudit = ledger.find(entry => entry.event === "model.audit.persisted" && entry.correlation?.modelInvocationId === source.sourceInvocationId)
            ?.payload as { invocations?: Array<{ normalizedOutputHash?: string | null; rawOutputHash?: string | null }> } | undefined;
          if ((normalized?.hashes?.normalizedOutput ?? oldAudit?.invocations?.[0]?.normalizedOutputHash) !== audit.normalizedOutputHash ||
            (!typed && (normalized?.hashes?.rawOutput ?? oldAudit?.invocations?.[0]?.rawOutputHash) !== audit.rawOutputHash)) throw new Error("Historical normalized output differs");
          const validations = (events: RuntimeEvent[]) => events.filter(entry => entry.event === "model.action_compilation.slots.validated" &&
            entry.correlation?.modelInvocationId === source.sourceInvocationId).map(entry => entry.payload);
          if (validations(ledger).length !== 1 || contentHash(validations(ledger)) !== contentHash(validations(evidence.events))) throw new Error("Historical slot materialization or rejection changed");
        }
      }
      if (mode === "prepare" && (outputs[0]!.compilerAccepted !== outputs[1]!.compilerAccepted ||
        contentHash(outputs[0]!.result?.compilations ?? null) !== contentHash(outputs[1]!.result?.compilations ?? null) ||
        outputs[0]!.calls[0]!.audit!.invocations[0]!.normalizedOutputHash !== outputs[1]!.calls[0]!.audit!.invocations[0]!.normalizedOutputHash)) {
        throw new Error("Historical output processing or materialization changed");
      }
    }
    const summary = { mode, binding, totalHttp, completedTrials: rows.length, wallMs: performance.now() - started,
      sourceUnchanged: sources.every(source => contentHash(source.stateSnapshot) === source.stateHash), runtimePromoted: false,
      candidateFirstBatches: rows.filter(row => row.arm === "C" && row.evidence.compilerAccepted).length,
      semantics: "unassessed; mechanical acceptance only permits full source review", wholeGoalAchieved: false };
    save(directory, "summary.json", summary);
    if (mode === "prepare") save(root, "manifest.json", { binding, preflightHash: contentHash(summary), totalHttp: 0 });
    return summary;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [mode, root, sourceRoot, candidate = "field-domains"] = process.argv.slice(2);
  if ((mode !== "prepare" && mode !== "run") || !root || !sourceRoot || (candidate !== "field-domains" && candidate !== "typed-aliases")) throw new Error("Usage: prepare|run <probe-root> <original-integrated-root> [field-domains|typed-aliases]");
  compilationFieldDomainsProbe(mode, path.resolve(root), path.resolve(sourceRoot), candidate).then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.stack : error}\n`); process.exitCode = 1; });
}
