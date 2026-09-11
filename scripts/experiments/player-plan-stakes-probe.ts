import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { conditionalPlanStakesRequest, CONDITIONAL_PLAN_STAKES } from "../../src/engine/benchmarks/step-efficiency/conditional-plan-stakes";
import { effectProfileDomainsRequest, EFFECT_PROFILE_DOMAINS } from "../../src/engine/benchmarks/step-efficiency/effect-profile-domains";
import { planningActionFramesRequest, PLANNING_ACTION_FRAMES } from "../../src/engine/benchmarks/step-efficiency/planning-action-frames";
import { planningDecisionOrderRequest, PLANNING_DECISION_ORDER } from "../../src/engine/benchmarks/step-efficiency/planning-decision-order";
import { DEFAULT_ALGORITHM_REF, registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { algorithmRef, type AlgorithmManifest, type WorldStepInput, type WorldStepPreparation } from "../../src/engine/runtime/execution";
import { RecordingRuntimeObserver, type RuntimeEvent } from "../../src/engine/runtime/observability";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";

interface SourceExport {
  execution: { id: string; instanceId: string; manifest: AlgorithmManifest };
  events: Array<RuntimeEvent & { sequence: number }>;
}
interface SourceRequest {
  workloadId: string; batchId: string; registrySnapshotHash: string; modelCatalogHash: string;
  profileId: string; modelId: string; resolvedInference: { thinking: string };
  context: unknown; schema: unknown; system: string; userPrompt: string;
}
class ProbeStopped extends ModelConfigurationError {}
const save = (directory: string, name: string, value: unknown) => writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

export function planStakesRequestEvidence(request: StructuredModelRequest<unknown>) {
  return { role: request.role, schemaName: request.schemaName, profileId: request.profileId,
    context: request.context, system: request.system, userPrompt: request.userPrompt,
    schema: request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }),
    jsonExamplePolicy: request.jsonExamplePolicy, jsonObjectPostlude: request.jsonObjectPostlude,
    contextLayout: request.contextLayout, jsonSyntaxRecovery: request.jsonSyntaxRecovery };
}

/** Real prepared-step reconstruction, bounded at the first physical planning request.
 * Every subsequent call is captured and stopped before HTTP or canonical commit. */
export async function runPlayerPlanStakesProbe(argv: string[]) {
  const [sourcePath, dataRoot, output, mode = "preflight", candidateMode = "stakes"] = argv;
  if (!sourcePath || !dataRoot || !output || !["preflight", "run"].includes(mode) || !["stakes", "profile-domains", "action-frames", "decision-order"].includes(candidateMode)) throw new Error("Expected source-export data-root output-directory [preflight|run] [stakes|profile-domains|action-frames|decision-order]");
  mkdirSync(output, { recursive: false });
  const source: SourceExport = JSON.parse(readFileSync(sourcePath, "utf8"));
  const first = source.events.find(event => event.event === "model.context.serialized" &&
    (event.payload as { schemaName?: string })?.schemaName === "truth_resolution_plan_commit_batch");
  if (!first) throw new Error("Source has no first physical planning request");
  const recorded = first.payload as SourceRequest;
  const recordedInput = source.events.find(event => event.event === "step.preparation.started")?.payload as WorldStepInput;
  const recordedPreparation = source.events.filter(event => event.event === "execution.preparation.persisted" && event.sequence < first.sequence).at(-1)?.payload as WorldStepPreparation;
  if (!recordedInput || !recordedPreparation || Object.keys(recordedInput.state.agents).length !== 49 || Object.values(recordedInput.policyRoster).filter(policy => policy.kind === "external").length !== 1) throw new Error("Expected a complete 48 NPC plus one player source");
  const input = structuredClone(recordedInput), preparation = structuredClone(recordedPreparation);
  const recordedRef = algorithmRef(source.execution.manifest);
  const ref = candidateMode === "decision-order" ? DEFAULT_ALGORITHM_REF : recordedRef;
  // This explicitly selected research boundary imports prepared canonical evidence
  // into the current producer. It is not a replay, save migration or world commit.
  if (candidateMode === "decision-order") {
    preparation.algorithmManifestHash = ref.manifestHash;
    const restored = { ...preparation, algorithmManifestHash: recordedPreparation.algorithmManifestHash };
    if (contentHash(restored) !== contentHash(recordedPreparation)) throw new Error("Counterfactual preparation changed more than its producer binding");
    save(output, "counterfactual-preparation.json", { sourceAlgorithm: recordedRef, algorithm: ref,
      sourcePreparationHash: contentHash(recordedPreparation), preparationHash: contentHash(preparation), preparation });
  }
  // Ledger object serialization sorts map keys. Restore the source's recorded
  // catalog order before projections that expose insertion order to the model.
  const catalogOrder = (recorded.context as { state: { catalogOrderPrefix: string[] } }).state.catalogOrderPrefix;
  const payload = preparation.payload as unknown as { planningState: WorldStepInput["state"]; temporalPlanning: Array<{ activity: { id: string } }> };
  const orderMap = <T>(values: Record<string, T>, ids: string[]) => Object.fromEntries([
    ...ids.filter(id => Object.hasOwn(values, id)), ...Object.keys(values).filter(id => !ids.includes(id)),
  ].map(id => [id, values[id]!])) as Record<string, T>;
  for (const state of [input.state, payload.planningState]) {
    state.agents = orderMap(state.agents, catalogOrder.filter(handle => handle.startsWith("ref:agent:")).map(handle => handle.slice("ref:agent:".length)));
    state.truth.entities = orderMap(state.truth.entities, catalogOrder.filter(handle => handle.startsWith("ref:entity:")).map(handle => handle.slice("ref:entity:".length)));
    state.truth.activities = orderMap(state.truth.activities, payload.temporalPlanning.map(row => row.activity.id));
  }
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  if (catalog.hash !== recorded.modelCatalogHash || recorded.modelId !== "deepseek-flash" || recorded.resolvedInference.thinking !== "disabled") throw new Error("Source model/profile differs from the authorized baseline");
  const registry = new ModelRegistry(catalog, dataRoot, { fetch: async () => { throw new ProbeStopped("Registry refresh disabled"); } });
  registry.snapshot(recorded.registrySnapshotHash);
  const retrieval = createActionCompilationRetrievalRuntimeProvider();
  let frozen: ReturnType<typeof planStakesRequestEvidence> | undefined;
  let candidate: ReturnType<typeof planStakesRequestEvidence> | undefined;
  const run = async (label: string, arm: "B" | "C", live: boolean) => {
    const observer = new RecordingRuntimeObserver({ mode: "full" });
    let calls = 0, httpCount = 0;
    const blocked: Array<{ role: string; schemaName: string; subjectId: string; context: unknown }> = [];
    const requestBodies: unknown[] = [];
    const network = createModelFetchResolver(process.env);
    const gateway = createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
      fetchForAccount: (id, account) => {
        const fetcher = network(id, account) ?? fetch;
        return async (resource, init) => {
          const request = new Request(resource, init);
          const body = await request.clone().json();
          if (++httpCount > 1 || body.model !== "deepseek-flash" || body.thinking?.type !== "disabled") throw new ProbeStopped("Unexpected HTTP count or model settings");
          requestBodies.push(body);
          save(output, `${label}-http-request.json`, { url: request.url, body });
          return fetcher(resource, init);
        };
      },
    });
    const provider: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
      assertProfilesAvailable: async () => {}, generateStructured: async request => {
        if (request.schemaName !== "truth_resolution_plan_commit_batch" || calls++) {
          blocked.push({ role: request.role, schemaName: request.schemaName, subjectId: request.subjectId, context: request.context });
          throw new ProbeStopped("First-response scope complete; no repair, review, continuation or transition HTTP");
        }
        const conditional = candidateMode === "stakes" ? request : conditionalPlanStakesRequest(request);
        const profiled = ["action-frames", "decision-order"].includes(candidateMode) ? effectProfileDomainsRequest(conditional) : conditional;
        const control = candidateMode === "decision-order" ? planningActionFramesRequest(profiled) : profiled;
        const baseline = planStakesRequestEvidence(control);
        if (frozen && contentHash(JSON.stringify(baseline)) !== contentHash(JSON.stringify(frozen))) throw new Error("Reconstructed baseline request drift");
        frozen ??= baseline;
        const adapted = arm === "C" ? (candidateMode === "decision-order" ? planningDecisionOrderRequest(control)
          : candidateMode === "action-frames" ? planningActionFramesRequest(control)
          : candidateMode === "profile-domains" ? effectProfileDomainsRequest(control) : conditionalPlanStakesRequest(control)) : control;
        if (arm === "C") {
          const evidence = planStakesRequestEvidence(adapted);
          if (candidate && contentHash(JSON.stringify(evidence)) !== contentHash(JSON.stringify(candidate))) throw new Error("Reconstructed candidate request drift");
          candidate ??= evidence;
        }
        save(output, `${label}-request.json`, planStakesRequestEvidence(adapted));
        if (!live) throw new ProbeStopped("Offline request captured");
        return gateway.generateStructured({ ...adapted, observer });
      } };
    const algorithm = registerBuiltinAlgorithms().create(ref, { provider, resources: {
      resolve: <T>(kind: string) =>
        (kind === "candidate-selection-runtime" ? retrieval.runtime(ref) : undefined) as T | undefined,
    } });
    const before = contentHash({ input, preparation });
    const started = performance.now();
    let error: string | null = null;
    try {
      await algorithm.completeStep(input, preparation, [], { modelScope: {
        workloadId: recorded.workloadId, batchId: recorded.batchId, modelRegistrySnapshotHash: recorded.registrySnapshotHash,
        observer, runtimeIdentity: { worldHash: input.state.worldHash, revision: input.state.revision }, executionAlgorithmRef: ref,
      }, instrumentation: { emit: () => undefined } });
      throw new Error("Probe crossed its stop boundary");
    } catch (caught) { error = String(caught); }
    if (contentHash({ input, preparation }) !== before) throw new Error("Probe modified source state");
    const events = observer.snapshot();
    save(output, `${label}-events.json`, events);
    save(output, `${label}-blocked.json`, blocked);
    const row = { label, arm, live, calls, httpCount, elapsedMs: performance.now() - started,
      admittedReviewRequests: blocked.filter(request => request.schemaName === "resolution_plan_verification_batch").length,
      admittedSlots: blocked.filter(request => request.schemaName === "resolution_plan_verification_batch")
        .reduce((sum, request) => sum + ((request.context as { state?: { slots?: unknown[] } }).state?.slots?.length ?? 0), 0),
      repairRequests: blocked.filter(request => request.role === "truth-resolution").length,
      audit: events.filter(event => event.event === "model.audit.persisted").map(event => event.payload),
      issues: events.filter(event => ["model.structured_output.rejected", "model.semantic.rejected"].includes(event.event)).map(event => ({ correlation: event.correlation, error: event.error, payload: event.payload })),
      requestBodyHashes: requestBodies.map(contentHash), error, sourceUnchanged: true, semanticVerdict: "unassessed", stepCommitted: false };
    save(output, `${label}-result.json`, row);
    process.stdout.write(`${JSON.stringify({ label, httpCount, elapsedMs: row.elapsedMs, admittedSlots: row.admittedSlots, repairRequests: row.repairRequests, error })}\n`);
    return row;
  };
  await run("preflight-B", "B", false);
  await run("preflight-C", "C", false);
  if (!frozen || !candidate) throw new Error("Failed to capture both complete requests");
  const baseline = frozen as ReturnType<typeof planStakesRequestEvidence>;
  const treatment = candidate as ReturnType<typeof planStakesRequestEvidence>;
  const firstResponsePlan: readonly ("B" | "C")[] = candidateMode === "decision-order" ? ["B", "C"] : ["B", "C", "C", "B", "B", "C"];
  const restored = structuredClone(treatment.context) as { task: Record<string, unknown> };
  if (candidateMode === "action-frames") delete restored.task.planningActionFrames;
  if (contentHash(restored) !== contentHash(baseline.context)) throw new Error("Candidate changed original source context");
  if (candidateMode === "decision-order" && contentHash(baseline.schema) !== contentHash(treatment.schema)) throw new Error("Decision order changed schema predicates");
  save(output, "manifest.json", { protocol: candidateMode === "decision-order" ? PLANNING_DECISION_ORDER : candidateMode === "action-frames" ? PLANNING_ACTION_FRAMES : candidateMode === "profile-domains" ? EFFECT_PROFILE_DOMAINS : CONDITIONAL_PLAN_STAKES, candidateMode,
    codeRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runnerHash: contentHash(readFileSync(new URL(import.meta.url), "utf8")),
    sourceExecution: source.execution.id, sourceInstance: source.execution.instanceId, sourceEvent: first.sequence,
    sourceHash: contentHash(source), sourceAlgorithm: recordedRef, manifest: ref, catalogHash: catalog.hash, sourceRequestHash: contentHash(recorded),
    reconstruction: candidateMode === "decision-order" ? "counterfactual-prepared-boundary" : "registered-source-producer",
    sourcePreparationHash: contentHash(recordedPreparation), preparationHash: contentHash(preparation),
    baselineHash: contentHash(baseline), candidateHash: contentHash(treatment), sourceContextEqual: contentHash(recorded.context) === contentHash(baseline.context),
    baselineOrderedHash: contentHash(JSON.stringify(baseline)), candidateOrderedHash: contentHash(JSON.stringify(treatment)),
    contextEqual: contentHash(baseline.context) === contentHash(treatment.context),
    originalContextPreserved: true,
    order: firstResponsePlan, maxHttp: firstResponsePlan.length, mode, acceptance: "Complete first-response mechanical admission followed by independent source-semantic review; no gameplay or latency certification from this probe" });
  if (mode === "run") for (const [index, arm] of firstResponsePlan.entries()) {
    const row = await run(`${index + 1}-${arm}`, arm, true);
    if (row.httpCount !== 1 || !row.audit.length) throw new Error("Transport or usage incomplete; stop without redrawing");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runPlayerPlanStakesProbe(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${String(error)}\n`); process.exitCode = 1;
});
