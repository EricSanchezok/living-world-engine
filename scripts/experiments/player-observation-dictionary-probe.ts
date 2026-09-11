import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SimulationState } from "../../src/engine/contracts/model";
import type { ObservationRenderingInput } from "../../src/engine/algorithms/roles";
import type { WorldStepCandidate } from "../../src/engine/runtime/execution";
import { ObservationRenderer } from "../../src/engine/cognition/observation-renderer";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";
import { observationEvidenceProvider, OBSERVATION_EVIDENCE_LAYOUT } from "../../src/engine/mechanics/observation-evidence-layout";
import { SHARED_BATCH_CONTEXT_CODEC } from "../../src/engine/mechanics/shared-batch-context";
import { observationActionDictionaryRequest, OBSERVATION_ACTION_DICTIONARY } from "../../src/engine/benchmarks/step-efficiency/observation-action-dictionary";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../src/engine/runtime/observability";
import { bindSampledStructuredOutput, isContinuationRepair } from "./player-plan-continuation";
import { planStakesRequestEvidence, reconstructPreparedPlayerStep, type SourceExport } from "./player-plan-stakes-probe";

class ProbeStopped extends ModelConfigurationError {}
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const save = (directory: string, name: string, value: unknown) => writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
type Evidence = ReturnType<typeof planStakesRequestEvidence>;

/** Full observation entry point; the immutable accepted transition is imported, never recomputed or deployed. */
export async function runPlayerObservationDictionaryProbe(argv: string[]) {
  const [sourceFile, dataRoot, downstreamDirectory, output, mode = "preflight"] = argv;
  if (!sourceFile || !dataRoot || !downstreamDirectory || !output || argv.length > 5 || !["preflight", "run"].includes(mode)) throw new Error("Expected source-export data-root recorded-downstream-directory output-directory [preflight|run]");
  if (mode === "run" && execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Commit checked work before live probe");
  mkdirSync(output, { recursive: false });
  const source = read(sourceFile) as SourceExport;
  const downstreamManifest = read(path.join(downstreamDirectory, "manifest.json"));
  const downstreamResult = read(path.join(downstreamDirectory, "result.json"));
  const downstreamEvents = read(path.join(downstreamDirectory, "events.json")) as RuntimeEvent[];
  const { recorded, input, preparation, ref } = reconstructPreparedPlayerStep(source, true);
  if (downstreamManifest.protocol !== "sample-bound-review-repair-diagnostic-v1" || downstreamManifest.sourceHash !== contentHash(source) ||
    contentHash(downstreamManifest.algorithm) !== contentHash(ref) || downstreamResult.canonicalAcceptedInMemory !== true ||
    downstreamManifest.preparationHash !== contentHash(preparation)) throw new Error("Recorded transition source binding changed");
  const candidates = downstreamEvents.filter(event => event.event === "execution.candidate.persisted");
  if (candidates.length !== 1) throw new Error("Expected exactly one recorded candidate");
  const candidate = candidates[0]!.payload as WorldStepCandidate;
  const observationRows = (downstreamResult.requests as Array<{ ordinal: number; role: string }>).filter(row => row.role === "observation-renderer");
  const sourceRequests = observationRows.map(row => {
    const full = read(path.join(downstreamDirectory, `downstream-${row.ordinal}-request.json`));
    const evidence = Object.fromEntries(Object.entries(full).filter(([key]) => !["promptVersion", "subjectId", "correlation", "modelInvocationId"].includes(key))) as Evidence;
    return { full, evidence, events: downstreamEvents.filter(event => event.correlation?.modelInvocationId === full.modelInvocationId) };
  });
  const observerIds = sourceRequests.flatMap(({ full }) => full.schemaName === "observation_projection_batch"
    ? full.context.task.slots.map((slot: { observerBinding: { observerRef: string } }) => slot.observerBinding.observerRef)
    : full.context.state.observationSlots.map((slot: { observer: { agentRef: string } }) => slot.observer.agentRef))
    .map((id: string) => { if (!id.startsWith("ref:agent:")) throw new Error("Unknown observer reference"); return id.slice("ref:agent:".length); });
  if (sourceRequests.length !== 5 || sourceRequests.filter(row => row.full.schemaName === "observation_projection_batch").length !== 4 ||
    observerIds.length !== 49 || new Set(observerIds).size !== 49) throw new Error("Expected complete recorded 49-observer cohort");
  const observationInput: ObservationRenderingInput = { definition: input.definition,
    state: (preparation.payload as unknown as { planningState: SimulationState }).planningState,
    proposal: { ...structuredClone(candidate.resolution.proposal), observations: [] },
    actions: candidate.resolution.actions, observerIds, identityOwner: "step-final-observation-0", temporalState: candidate.temporalState };
  const observationRef = ref.children.observationRendering!, batching = observationRef.children.batching!;
  if (observationRef.id !== "source-bound-observation-rendering" || observationRef.config.evidenceLayout !== OBSERVATION_EVIDENCE_LAYOUT ||
    batching.config.maxSlots !== 12 || batching.config.contextCodec !== SHARED_BATCH_CONTEXT_CODEC ||
    batching.config.requestContract !== TRUTH_BATCH_REQUEST_CONTRACT || batching.config.repairPlacement !== "tail-v1") throw new Error("Registered observation producer changed");
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  if (catalog.hash !== downstreamManifest.catalogHash || catalog.hash !== recorded.modelCatalogHash) throw new Error("Model catalog drift");
  const registry = new ModelRegistry(catalog, dataRoot, { fetch: async () => { throw new ProbeStopped("Registry refresh disabled"); } });
  registry.snapshot(recorded.registrySnapshotHash);
  const network = createModelFetchResolver(process.env);
  save(output, "manifest.json", { protocol: "source-bound-observation-dictionary-v1", mode, order: ["B", "C"], maxNewHttp: 10, maxNewRepairHttp: 0,
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), runnerHash: contentHash(readFileSync(new URL(import.meta.url), "utf8")),
    sourceExecution: source.execution.id, sourceHash: contentHash(source), sourceManifestHash: contentHash(downstreamManifest),
    sourceEventsHash: contentHash(downstreamEvents), candidateHash: contentHash(candidate), observationInputHash: contentHash(observationInput),
    catalogHash: catalog.hash, registrySnapshotHash: recorded.registrySnapshotHash, algorithm: ref, candidate: OBSERVATION_ACTION_DICTIONARY,
    orderedSourceRequestHashes: sourceRequests.map(row => contentHash(JSON.stringify(row.evidence))),
    acceptance: "Two complete 49-observer arms through the original renderer, batching, materialization and information checks. No repair HTTP. Source transition and all upstream costs imported. Mechanical admission does not establish prose accuracy, player task completion, persisted gameplay or full action latency. One pair is a feasibility screen, not a stable success or latency estimate." });
  save(output, "observation-input.json", observationInput);
  let totalHttp = 0;
  for (const arm of ["B", "C"] as const) {
    const directory = path.join(output, arm); mkdirSync(directory);
    const observer = new RecordingRuntimeObserver({ mode: "full" }), pending = new Set<Promise<unknown>>();
    const seen = new Set<string>(), rows: unknown[] = [];
    const before = contentHash(observationInput), started = performance.now();
    let httpCount = 0, stopped = false, failure: string | null = null;
    const gateway = createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
      fetchForAccount: (id, account) => {
        const fetcher = network(id, account) ?? fetch;
        return async (resource, init) => {
          const request = new Request(resource, init), body = await request.clone().json();
          if (stopped || httpCount >= 5 || totalHttp >= 10 || body.model !== "deepseek-flash" || body.thinking?.type !== "disabled") throw new ProbeStopped("HTTP ceiling or inference drift");
          totalHttp++; httpCount++;
          save(directory, `http-${httpCount}-request.json`, { url: request.url, body });
          process.stdout.write(`${JSON.stringify({ arm, httpStarted: httpCount, elapsedMs: performance.now() - started })}\n`);
          return fetcher(resource, init);
        };
      } });
    const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
      generateStructured: async request => {
        request = { ...request, modelRegistrySnapshotHash: recorded.registrySnapshotHash };
        const historical = sourceRequests.find(row => row.full.subjectId === request.subjectId);
        if (stopped || isContinuationRepair(request) || !historical || seen.has(request.subjectId)) {
          stopped = true; save(directory, `blocked-${rows.length + 1}.json`, planStakesRequestEvidence(request));
          throw new ProbeStopped("Stop before repair, extra request or source drift");
        }
        seen.add(request.subjectId);
        const ordinal = sourceRequests.indexOf(historical) + 1;
        // Binding also proves that the old accepted raw semantics are preserved by the real decoder.
        let sampled;
        try { sampled = bindSampledStructuredOutput(request, historical.evidence, historical.events); }
        catch (error) { stopped = true; save(directory, `source-drift-${ordinal}.json`, planStakesRequestEvidence(request)); throw new ProbeStopped(String(error), { cause: error }); }
        const adapted = arm === "C" ? observationActionDictionaryRequest(request) : request;
        save(directory, `request-${ordinal}.json`, { ...planStakesRequestEvidence(adapted), promptVersion: adapted.promptVersion,
          subjectId: adapted.subjectId, modelInvocationId: adapted.modelInvocationId });
        const row = { ordinal, schemaName: request.schemaName, sourceMatched: true, elapsedMs: 0 };
        rows.push(row);
        if (mode === "preflight") return sampled;
        const callStart = performance.now(), call = gateway.generateStructured({ ...adapted, observer }); pending.add(call);
        try { return await call; }
        catch (error) { if (error instanceof ModelConfigurationError) stopped = true; throw error; }
        finally { row.elapsedMs = performance.now() - callStart; pending.delete(call); }
      } };
    const coordinator = new TruthBatchCoordinator(observationEvidenceProvider(provider), 12, 2,
      SHARED_BATCH_CONTEXT_CODEC, TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
    const renderer = new ObservationRenderer(coordinator, 2, true);
    let rendered;
    try {
      rendered = await renderer.render(observationInput, { workloadId: recorded.workloadId, batchId: recorded.batchId,
        modelRegistrySnapshotHash: recorded.registrySnapshotHash, observer,
        runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision } });
      save(directory, "observations.json", rendered);
    } catch (error) { failure = String(error); }
    await Promise.allSettled([...pending]);
    const events = observer.snapshot(); save(directory, "events.json", events);
    if (contentHash(observationInput) !== before) throw new Error("Renderer mutated frozen source");
    const packetHash = (packets: typeof candidate.resolution.proposal.observations) => contentHash([...packets].sort((a, b) => a.observerId.localeCompare(b.observerId) || a.id.localeCompare(b.id)));
    const historicalPacketsMatch = rendered ? packetHash(rendered.packets) === packetHash(candidate.resolution.proposal.observations) : false;
    const summary = { arm, mode, rows, httpCount, elapsedMs: performance.now() - started, failure,
      acceptedObservers: rendered?.packets.length ?? 0, historicalPacketsMatch, sourceUnchanged: true,
      issues: events.filter(event => ["model.structured_output.rejected", "model.semantic.rejected", "algorithm.observation.repair_fallback", "algorithm.observation.references_normalized"].includes(event.event)),
      audits: events.filter(event => event.event === "model.audit.persisted").map(event => event.payload) };
    save(directory, "result.json", summary);
    process.stdout.write(`${JSON.stringify({ arm, httpCount, acceptedObservers: summary.acceptedObservers, failure, historicalPacketsMatch, elapsedMs: summary.elapsedMs })}\n`);
    if (mode === "preflight" && (failure || seen.size !== 5 || !historicalPacketsMatch || totalHttp !== 0)) throw new Error("Recorded observation entry did not reproduce every source request and packet");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runPlayerObservationDictionaryProbe(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${String(error)}\n`); process.exitCode = 1;
});
