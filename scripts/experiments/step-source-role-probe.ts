import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import type { WorldStepPreparation } from "../../src/engine/runtime/execution";
import { bindResolutionAdmission, type ResolutionAdmissionSource } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { createTruthReferenceResolver } from "../../src/engine/contracts/prompts";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { stripPlanSelectorAnnotations } from "../../src/engine/mechanics/plan-source-selectors";
import { withoutPlanningIndices } from "../../src/engine/mechanics/source-indexed-planning";
import { withoutPhysicalPlanningWorklist } from "../../src/engine/mechanics/physical-planning-worklist";
import { indexedReviewedPlanningProvider } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { dependentFieldsRequest } from "../../src/engine/mechanics/resolution-dependent-fields-codec";
import { resolutionSourceRoleRequest, RESOLUTION_SOURCE_ROLE_INSTRUCTION } from "../../src/engine/mechanics/resolution-source-role-contract";
import { inspectResolutionPlanDrafts } from "../../src/engine/mechanics/truth-engine";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { promptBundle } from "../../src/engine/prompts";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { probeInferenceEvidence } from "./step-json-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";

const TRIAL = "probes-e2-source-role-01", root = path.resolve(STEP_E2_PROTOCOL.root);
const hashes = { input: "d56e1da6ec9a9a03fc0aee6e365f77b9ba05db3af84b26606600585da3941671", preparation: "af4186200577039f545ae85889fb5d3a6a93b27c40327055bee10e7427d7e725",
  request: "5adae19657edc775ca86a7a3ea1612fd7a0ba08915449fb83dac4d0d43e8bf98", rejected: "19caf2f9bcedb1ecc4cab45bc377031a219d688aa9c5099579ff751de15f1e3a", body: "9e08825633b06a6d0cd6d1cbd02476f1ac6ba5ebdc0430ded9f56a963329a036" };
export async function prepareSourceRoleProbe() {
  const artifact = <T>(hash: string): T => {
    const entry = JSON.parse(readFileSync(path.join(root, "evidence/source-role-diagnostic", `${hash}.json`), "utf8"));
    if (entry.hash !== hash || contentHash(entry.value) !== hash) throw new Error("source role artifact drift"); return entry.value as T;
  };
  const input = artifact<{ definition: ResolutionAdmissionSource["definition"] }>(hashes.input);
  const preparation = artifact<WorldStepPreparation>(hashes.preparation);
  const payload = preparation.payload as unknown as { planningState: ResolutionAdmissionSource["state"]; newActions: ResolutionAdmissionSource["actions"]; dependencyResults: Array<{ dependency: ResolutionAdmissionSource["groundings"][number] }> };
  if (preparation.preparedReactionDecisions.length !== 7 || preparation.preparedReactionDecisions.some(value => value.kind !== "keep" || value.ongoingActivityDisposition !== "continue")) throw new Error("source reactions changed");
  const recorded = artifact<ReturnType<typeof admissionRequestEvidence>>(hashes.request);
  const context = stripPlanSelectorAnnotations(withoutPhysicalPlanningWorklist(withoutPlanningIndices(recorded.context)));
  const source: ResolutionAdmissionSource = { definition: input.definition, state: payload.planningState, actions: payload.newActions, groundings: payload.dependencyResults.map(value => value.dependency), contexts: [context] };
  const [binding] = bindResolutionAdmission(source);
  if (!binding || binding.actions.length !== 1 || binding.actions[0]!.actorId !== "lord-octa") throw new Error("recorded repair scope changed");
  const identityOwner = recorded.subjectId.split(":plan-repair:")[0]!;
  const resolver = createTruthReferenceResolver({ state: source.state, definition: source.definition, actions: source.actions });
  const plans = (context as { state: { candidateResolutionPlans: Array<{ actionRef: string }>; committedCheckRequests: unknown[]; committedRandomRequests: unknown[] } }).state;
  if (plans.candidateResolutionPlans.length !== 5 || plans.committedCheckRequests.length || plans.committedRandomRequests.length) throw new Error("recorded pre-random component scope changed");
  const componentActionIds = plans.candidateResolutionPlans.map(plan => resolver.resolve(plan.actionRef, "source").engineId);
  if (new Set(componentActionIds).size !== 5 || identityOwner !== `component-${source.actions.filter(action => componentActionIds.includes(action.id)).map(action => action.actorId).sort().join("+")}`) throw new Error("component identity mismatch");
  const allowedCauses = { action: new Set(componentActionIds), check: new Set<string>(), random: new Set<string>(), event: new Set(source.state.truth.events.map(value => value.id)),
    fact: new Set(Object.keys(source.state.truth.facts)), law: new Set(source.definition.laws.map(value => value.id)), mechanic: new Set<string>() };
  const score = (value: unknown) => inspectResolutionPlanDrafts({ state: source.state, definition: source.definition, actions: binding.actions, groundings: binding.groundings,
    identityOwner, allowedCauses, drafts: resolutionPlanCommitDirectiveSchema.parse(value).plans });
  const historical = score(artifact(hashes.rejected));
  if (historical.valid || historical.issues.length !== 1 || !historical.issues[0]!.message.includes("factors[5].source (risk) conflicts with factors[1].source (permission)")) throw new Error("recorded materializer rejection not reproduced");
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-13/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/short-action-checkpoints-01/model-catalog.json"));
  if (catalog.hash !== history.catalogHash) throw new Error("model catalog drift");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("offline registry refresh forbidden"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash), profile = resolveModelProfile(catalog, snapshot, recorded.profileId);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled") throw new Error("inference drift");
  const registryBinding = { catalog, capture: async (hash?: string) => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
    refresh: (options: Parameters<ModelRegistry["refresh"]>[0]) => registry.refresh(options), status: () => registry.status() };
  let captured: StructuredModelRequest<unknown> | undefined;
  const pipeline = indexedReviewedPlanningProvider({ catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
    generateStructured: async request => { captured = request; throw new ModelConfigurationError("offline capture"); } });
  const prompt = promptBundle("truth-resolution");
  try { await pipeline.generateStructured(dependentFieldsRequest({ ...prompt, role: "truth-resolution", profileId: recorded.profileId, subjectId: recorded.subjectId,
    schemaName: "truth_resolution_plan_repair", jsonSyntaxRecovery: recorded.jsonSyntaxRecovery ?? undefined,
    context, schema: resolutionPlanCommitDirectiveSchema, promptVersion: prompt.version,
    workloadId: TRIAL, batchId: TRIAL, runtimeIdentity: { worldHash: source.state.worldHash, revision: source.state.revision }, modelRegistrySnapshotHash: snapshot.hash })); }
  catch (error) { if (!captured) throw error; }
  const original = captured!;
  if (["context", "system", "userPrompt"].some(key => contentHash(original[key as "context" | "system" | "userPrompt"]) !== contentHash(recorded[key as "context" | "system" | "userPrompt"])) || contentHash(original.wireJsonSchema) !== contentHash(recorded.schema)) throw new Error("complete request reconstruction mismatch");
  const requests = [original, resolutionSourceRoleRequest(original)], bodies: Array<{ messages: Array<{ content: string }> }> = [], admissions: Array<Awaited<ReturnType<typeof countDeepSeekContext>>> = [];
  for (const request of requests) {
    let seen = false;
    const gateway = createModelGateway(catalog, { [catalog.account("deepseek-api").api_key_env]: "offline-only" }, { maxTransportAttempts: 1, registry: registryBinding,
      fetchForAccount: () => async (_input, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); admissions.push(await countDeepSeekContext(body)); seen = true; throw new ModelConfigurationError("offline body capture"); } });
    try { await gateway.generateStructured(request); } catch (error) { if (!seen) throw error; }
  }
  const restored = structuredClone(bodies[1]!); restored.messages[0]!.content = restored.messages[0]!.content.replace(`\n\n${RESOLUTION_SOURCE_ROLE_INSTRUCTION}`, "");
  if (contentHash(bodies[0]) !== hashes.body || contentHash(restored) !== hashes.body) throw new Error("pair differs beyond the single source-role instruction");
  const maximumRunNanoCny = 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken);
  const manifest = { trialId: TRIAL, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashes: hashes, sourceHash: contentHash(source), historical,
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: profile.modelId, inference: profile.profile.inference, profileId: profile.profileId,
    contextBudgets: admissions, maximumRunNanoCny, instructionHash: contentHash(RESOLUTION_SOURCE_ROLE_INSTRUCTION), order: ["B", "T"], actualHttpMaximum: 2,
    interpretation: "Two independent one-call diagnostics of the complete recorded one-action targeted repair, not a smaller root batch. No retries, critic, stronger inference, automatic field changes or runtime promotion. Materializer acceptance is not semantic or gameplay qualification." };
  return { catalog, registry, registryBinding, requests, bodies, manifest, score };
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || extra.length) throw new Error("usage: step-source-role-probe.ts prepare|run");
  const design = await prepareSourceRoleProbe();
  if (command === "prepare") { design.registry.stopBackgroundRefresh(); console.log(JSON.stringify(design.manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked code before paid pair");
  const frozen = JSON.parse(readFileSync(path.join(root, "evidence/source-role-diagnostic/preflight.json"), "utf8"));
  if (contentHash(frozen) !== contentHash(design.manifest)) throw new Error("pair preflight drift");
  const directory = path.join(root, "runs", TRIAL), lock = path.join(root, "writer.lock");
  if (existsSync(directory)) throw new Error("closed pair cannot restart");
  closeSync(openSync(lock, "wx")); mkdirSync(directory, { recursive: true });
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, dispatches = 0, active = 0, stopped = false;
  const rows: Array<{ arm: string; score?: ReturnType<typeof design.score>; failure?: string; elapsedMs: number }> = [];
  const stop = () => { stopped = true; }, report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest, status, failure, rows, dispatches,
    budget: budget?.summary, updatedAt: new Date().toISOString(), semantics: "unassessed", stepCommitted: false }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const group = budget.summary.phaseBudgets.find(value => value.phases.includes("probes"))!;
    if (budget.summary.blockingUnknown.length || group.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0) + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > group.maximumNanoCny || budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("whole pair budget unavailable");
    const account = design.catalog.account("deepseek-api"); if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env)("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, requireThinkingDisabled: true,
      trialPattern: /^probes-e2-source-role-01$/u, priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const gateway = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1, registry: design.registryBinding,
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || active !== dispatches || budget!.summary.blockingUnknown.length) throw new ModelConfigurationError("pair dispatch stopped");
        const admission = await countDeepSeekContext(JSON.parse(String(init?.body)));
        if (stopped || admission.bodyHash !== design.manifest.contextBudgets[active]!.bodyHash) throw new ModelConfigurationError("actual body drift");
        writeFileSync(path.join(directory, `${active}-admission.json`), JSON.stringify(admission, null, 2), { flag: "wx" });
        const response = await transport.fetch(input, init), inference = probeInferenceEvidence(await response.clone().json(), "B");
        if (!inference.inferenceValid) throw new ModelConfigurationError("provider inference drift"); return response;
      } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest, phaseBudgetHash: budget.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "requests.json.gz"), gzipSync(JSON.stringify(design.bodies)), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    for (const [index, request] of design.requests.entries()) {
      active = index; const arm = index === 0 ? "B" : "T", started = performance.now();
      try {
        const result = await gateway.generateStructured(request), score = design.score(result.value);
        writeFileSync(path.join(directory, `${arm}-result.json.gz`), gzipSync(JSON.stringify({ result, score })), { flag: "wx" }); rows.push({ arm, score, elapsedMs: performance.now() - started });
      } catch (error) { rows.push({ arm, failure: String(error), elapsedMs: performance.now() - started }); if (!(error instanceof ModelOutputError)) throw error; }
      if (stopped || dispatches !== index + 1 || budget.summary.blockingUnknown.length) throw new Error("pair interrupted or billing uncertain"); report();
    }
    status = "paired-results-awaiting-source-review";
  } catch (error) { status = "stopped"; failure = String(error); }
  finally { report(); design.registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, dispatches, rows }));
  if (status === "stopped") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
