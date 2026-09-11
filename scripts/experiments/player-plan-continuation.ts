import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelExecutionAudit } from "../../src/engine/contracts/model";
import { conditionalPlanStakesRequest } from "../../src/engine/benchmarks/step-efficiency/conditional-plan-stakes";
import { effectProfileDomainsRequest } from "../../src/engine/benchmarks/step-efficiency/effect-profile-domains";
import { planningActionFramesRequest } from "../../src/engine/benchmarks/step-efficiency/planning-action-frames";
import { factorChoiceProductsRequest } from "../../src/engine/benchmarks/step-efficiency/factor-choice-products";
import { registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../src/engine/runtime/observability";
import { SimulationEngine } from "../../src/engine/runtime/simulation";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { planStakesRequestEvidence, reconstructPreparedPlayerStep, type SourceExport } from "./player-plan-stakes-probe";

const MAX_HTTP = 16;
class ContinuationStopped extends ModelConfigurationError {}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (directory: string, name: string, value: unknown) => writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
type RequestEvidence = ReturnType<typeof planStakesRequestEvidence>;

/** Reuse a sampled normalized result only at the exact model-visible boundary. */
export function bindSampledPlanning<T>(request: StructuredModelRequest<T>, evidence: RequestEvidence, events: readonly RuntimeEvent[]) {
  if (contentHash(JSON.stringify(planStakesRequestEvidence(request))) !== contentHash(JSON.stringify(evidence))) throw new Error("Sampled planning request drift");
  const parsed = events.filter(event => event.event === "model.structured_output.parsed");
  const audits = events.filter(event => event.event === "model.audit.persisted");
  if (parsed.length !== 1 || audits.length !== 1 || events.some(event => ["model.structured_output.rejected", "model.semantic.rejected"].includes(event.event))) throw new Error("Sample must contain exactly one accepted physical result");
  const audit = audits[0]!.payload as ModelExecutionAudit;
  const invocation = audit.invocations[0];
  const binding = { count: audit.invocations.length === 1, prompt: audit.promptVersion === request.promptVersion,
    subject: audit.subjectId === request.subjectId, profile: audit.profileId === request.profileId, role: audit.role === request.role,
    invocation: invocation?.id === request.modelInvocationId, registry: audit.registrySnapshotHash === request.modelRegistrySnapshotHash,
    model: audit.modelId === "deepseek-flash", thinking: audit.resolvedInference.thinking === "disabled" };
  if (!invocation || Object.values(binding).some(value => !value)) throw new Error(`Sample audit binding mismatch: ${Object.entries(binding).filter(([, valid]) => !valid).map(([key]) => key).join(", ")}`);
  const value = request.schema.parse(structuredClone(parsed[0]!.payload));
  const hash = contentHash(value);
  if (hash !== contentHash(parsed[0]!.payload) || hash !== invocation.responseHash || hash !== invocation.normalizedOutputHash ||
    parsed[0]!.hashes?.response !== hash || audits[0]!.hashes?.response !== hash) throw new Error("Sampled normalized output hash mismatch");
  return { value, audit: structuredClone(audit) };
}

/** Inspect task envelopes, including shared slot deltas, without reading world prose as control. */
export function isContinuationRepair(request: Pick<StructuredModelRequest<unknown>, "schemaName" | "context" | "correlation">): boolean {
  if (request.schemaName.includes("repair") || (request.correlation?.semanticRepairAttempt ?? 0) > 0 || request.correlation?.repairOf) return true;
  const envelope = (value: unknown): boolean => {
    if (!object(value)) return false;
    if (value.repair != null || value.batchRepair != null) return true;
    const state = object(value.state) ? value.state : {};
    if (object(state.shared) && envelope(state.shared)) return true;
    return [state.slots, object(value.task) ? value.task.slots : undefined].some(slots => Array.isArray(slots) && slots.some(slot =>
      object(slot) && (slot.repair != null || envelope(slot.context) || envelope(slot.delta))));
  };
  return envelope(request.context);
}

export async function runPlayerPlanContinuation(argv: string[]) {
  const [sourceFile, dataRoot, samplePrefix, output, mode = "preflight"] = argv;
  if (!sourceFile || !dataRoot || !samplePrefix || !output || !["preflight", "run"].includes(mode)) throw new Error("Expected source-export data-root sample-prefix output-directory [preflight|run]");
  if (mode === "run" && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked work before live continuation");
  mkdirSync(output, { recursive: false });
  const source = read(sourceFile) as SourceExport;
  const sampleEvents = read(`${samplePrefix}-events.json`) as RuntimeEvent[];
  const sampleRequest = read(`${samplePrefix}-request.json`) as RequestEvidence;
  const sampleResult = read(`${samplePrefix}-result.json`);
  const sampleManifest = read(path.join(path.dirname(samplePrefix), "manifest.json"));
  const { recorded, recordedPreparation, input, preparation, recordedRef, ref } = reconstructPreparedPlayerStep(source, true);
  if (sampleManifest.candidateMode !== "factor-products" || sampleManifest.sourceHash !== contentHash(source) ||
    contentHash(sampleManifest.manifest) !== contentHash(ref) || sampleResult.httpCount !== 1 || sampleResult.admittedSlots !== 11 ||
    sampleResult.issues.length || sampleManifest.candidateOrderedHash !== contentHash(JSON.stringify(sampleRequest))) throw new Error("Sample source, producer or admission mismatch");
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  if (catalog.hash !== recorded.modelCatalogHash || sampleManifest.catalogHash !== catalog.hash) throw new Error("Model catalog drift");
  const registry = new ModelRegistry(catalog, dataRoot, { fetch: async () => { throw new ContinuationStopped("Registry refresh disabled"); } });
  registry.snapshot(recorded.registrySnapshotHash);
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const network = createModelFetchResolver(process.env);
  const pending = new Set<Promise<unknown>>();
  const requests: Array<{ ordinal: number; schemaName: string; role: string; subjectId: string; startedMs: number; elapsedMs?: number; error?: string }> = [];
  const blocked: unknown[] = [];
  let httpCount = 0, reused = 0, stopped = false;
  const started = performance.now();
  const gateway = createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
    fetchForAccount: (id, account) => {
      const fetcher = network(id, account) ?? fetch;
      return async (resource, init) => {
        const request = new Request(resource, init), body = await request.clone().json();
        if (stopped || httpCount >= MAX_HTTP || body.model !== "deepseek-flash" || body.thinking?.type !== "disabled") throw new ContinuationStopped("HTTP ceiling, stop signal or inference mismatch");
        const ordinal = ++httpCount;
        save(output, `http-${ordinal}-request.json`, { url: request.url, body });
        process.stdout.write(`${JSON.stringify({ httpStarted: ordinal, elapsedMs: performance.now() - started })}\n`);
        return fetcher(resource, init);
      };
    },
  });
  const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async request => {
      // Some composed role scopes omit this optional transport field. Pin the
      // research gateway explicitly; never resolve a different current snapshot.
      if (request.modelRegistrySnapshotHash && request.modelRegistrySnapshotHash !== recorded.registrySnapshotHash) throw new ContinuationStopped("Downstream registry snapshot drift");
      request = { ...request, modelRegistrySnapshotHash: recorded.registrySnapshotHash };
      if (reused === 0 && request.schemaName === "truth_resolution_plan_commit_batch") {
        const adapted = factorChoiceProductsRequest(planningActionFramesRequest(effectProfileDomainsRequest(conditionalPlanStakesRequest(request))));
        save(output, "reconstructed-planning-request.json", planStakesRequestEvidence(adapted));
        let result;
        try { result = bindSampledPlanning(adapted, sampleRequest, sampleEvents); }
        catch (error) { save(output, "sample-binding-failure.json", { error: String(error) }); throw new ContinuationStopped(String(error), { cause: error }); }
        reused++;
        save(output, "reused-planning.json", { requestHash: contentHash(sampleRequest), orderedRequestHash: contentHash(JSON.stringify(sampleRequest)),
          sourceEventsHash: contentHash(sampleEvents), audit: result.audit, value: result.value, newHttpCount: 0 });
        return result;
      }
      const ordinal = requests.length + 1;
      save(output, `downstream-${ordinal}-request.json`, { ...planStakesRequestEvidence(request), promptVersion: request.promptVersion,
        subjectId: request.subjectId, correlation: request.correlation, modelInvocationId: request.modelInvocationId });
      const row = { ordinal, role: request.role, schemaName: request.schemaName, subjectId: request.subjectId, startedMs: performance.now() - started } as typeof requests[number];
      requests.push(row);
      if (mode !== "run" || stopped || reused !== 1 || isContinuationRepair(request) || requests.length > MAX_HTTP || request.schemaName.startsWith("truth_resolution_plan")) {
        stopped = true;
        blocked.push({ ...row, reason: mode !== "run" ? "offline preflight" : "repair, replacement planning or fixed call ceiling" });
        throw new ContinuationStopped("Continuation stopped before new HTTP");
      }
      const call = gateway.generateStructured({ ...request, observer });
      pending.add(call);
      try { return await call; }
      catch (error) { row.error = String(error); stopped = true; throw error; }
      finally { row.elapsedMs = performance.now() - started - row.startedMs; pending.delete(call); }
    } };
  const retrieval = createActionCompilationRetrievalRuntimeProvider();
  const algorithm = registerBuiltinAlgorithms().create(ref, { provider, resources: {
    resolve: <T>(kind: string) => (kind === "candidate-selection-runtime" ? retrieval.runtime(ref) : undefined) as T | undefined,
  } });
  save(output, "manifest.json", { protocol: "sample-bound-downstream-primary-v1", mode, maxNewHttp: MAX_HTTP,
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runnerHash: contentHash(readFileSync(new URL(import.meta.url), "utf8")),
    sourceExecution: source.execution.id, sourceHash: contentHash(source), sourceAlgorithm: recordedRef, algorithm: ref,
    sourcePreparationHash: contentHash(recordedPreparation), preparationHash: contentHash(preparation), catalogHash: catalog.hash,
    sampleRequestHash: contentHash(sampleRequest), sampleEventsHash: contentHash(sampleEvents), sampleManifestHash: contentHash(sampleManifest),
    historicalPlanningElapsedMs: sampleResult.elapsedMs, historicalPreparationAudits: preparation.modelAudits,
    acceptance: "Counterfactual prepared-boundary diagnostic; actual primary downstream requests only, stop before repair. Canonical validation runs in memory. No production persistence, full player-action latency or deployment certification." });
  save(output, "counterfactual-preparation.json", preparation);
  const before = contentHash({ input, preparation });
  const engine = new SimulationEngine(input.definition, algorithm, input.state);
  let failure: string | null = null, accepted = false;
  try {
    const result = await engine.completePreparedStep(input.policyRoster, input.request, preparation, [], { workloadId: recorded.workloadId, batchId: recorded.batchId,
      modelRegistrySnapshotHash: recorded.registrySnapshotHash, observer,
      runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision }, executionAlgorithmRef: ref });
    save(output, "canonical-result.json", result);
    accepted = true;
  } catch (error) { failure = String(error); }
  // Do not lose responses and billable usage from siblings already in flight.
  await Promise.allSettled([...pending]);
  if (contentHash({ input, preparation }) !== before || (!accepted && contentHash(engine.snapshot) !== contentHash(input.state))) throw new Error("Continuation mutated source or failed rollback");
  const events = observer.snapshot();
  save(output, "events.json", events);
  const newAudits = events.filter(event => event.event === "model.audit.persisted").map(event => event.payload as ModelExecutionAudit);
  const summary = { reusedPlanning: reused, newHttpCount: httpCount, elapsedMs: performance.now() - started, requests, blocked,
    newAudits, failure, canonicalAcceptedInMemory: accepted, productionStatePersisted: false, sourceUnchanged: true,
    issues: events.filter(event => ["model.structured_output.rejected", "model.semantic.rejected"].includes(event.event)).map(event => ({ correlation: event.correlation, payload: event.payload, error: event.error })) };
  save(output, "result.json", summary);
  process.stdout.write(`${JSON.stringify({ ...summary, requests: requests.map(({ schemaName, elapsedMs, error }) => ({ schemaName, elapsedMs, error })), newAudits: newAudits.length, issues: summary.issues.length })}\n`);
  if (mode === "preflight" && (reused !== 1 || requests[0]?.schemaName !== "resolution_plan_verification_batch" || httpCount !== 0)) throw new Error("Offline continuation did not reach independent plan review");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runPlayerPlanContinuation(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${String(error)}\n`); process.exitCode = 1;
});
