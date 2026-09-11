import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { transitionProposalSchema } from "../../src/engine/contracts/llm-schemas";
import { validationIssues } from "../../src/engine/contracts/prompts";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { scoreRepairTail } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, modelInvocationIdentity, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { promptBundle } from "../../src/engine/prompts";
import { logicalRepairContext } from "../../src/engine/prompts/logical-repair-context";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { probeInferenceEvidence } from "./step-json-probe";

const TRIAL = "probes-e2-transition-candidate-02", PREVIOUS = "probes-e2-transition-candidate-01", root = path.resolve(STEP_E2_PROTOCOL.root);
const SOURCE_HASH = "32cc7cc854aa132880b8c46a003c674872be4385ced41fb0c53b75cba3b388e8";

export async function prepareTransitionCandidateProbe() {
  const bundle = JSON.parse(readFileSync(path.join(root, "evidence/transition-candidate-01/source.json"), "utf8"));
  if (contentHash(bundle) !== SOURCE_HASH || bundle.actions !== 24 || bundle.slot !== 1) throw new Error("frozen logical source changed");
  const { source, initialContext, candidate } = bundle;
  const historicalScore = scoreRepairTail(JSON.stringify({ slots: [{ slot: 0, result: candidate }] }), "transition", [initialContext]);
  if (historicalScore.schemaCoverageReferences || historicalScore.error !== "existing reference outside slot: factRef") throw new Error("historical rejected reference control changed");
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-11/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(history.variant.catalogPath);
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash), profile = resolveModelProfile(catalog, snapshot, source.profileId);
  const prompt = promptBundle("truth-transition");
  if (catalog.hash !== source.modelCatalogHash || snapshot.hash !== source.registrySnapshotHash || profile.accountId !== "deepseek-api" ||
    profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled" ||
    contentHash(profile.profile) !== contentHash(source.profile) || prompt.system !== source.system || prompt.userPrompt !== source.userPrompt) throw new Error("frozen generation contract changed");
  const context = logicalRepairContext(source.context, { attempt: 1, scope: "step", targetIds: [], issues: [], previousOutput: candidate,
    logicalInvocationId: "rt:model-audit:9bd395fc8bb2d2d5d14f77f1ce86e5f64504150ace263c0ab9cac268e2ce75fd",
    repairOf: "rt:model-audit:874abe6ec0ef9c9bb3d72cf807ef3299c3a77d89e537f8f68ecbbdd6fb35e388",
  }, contentHash(initialContext), "truth_transition");
  const firstRequest: StructuredModelRequest<unknown> = { ...prompt, promptVersion: prompt.version, role: "truth-transition", profileId: source.profileId,
    subjectId: source.subjectId, workloadId: PREVIOUS, batchId: PREVIOUS, runtimeIdentity: { worldHash: history.retrievalPreflight.worldHash, revision: 0 },
    modelRegistrySnapshotHash: snapshot.hash, context, schemaName: "truth_transition", schema: transitionProposalSchema,
    jsonSyntaxRecovery: "unmatched-closers-v1" };
  const previousResponse = JSON.parse(readFileSync(path.join(root, "http", `${PREVIOUS}-http-001/response.json`), "utf8"));
  if (previousResponse.rawHash !== "6268fa81787a0c418ac5abeac0cc8952c31b89619eae7ca76ebf6dce00092b4a" ||
    createHash("sha256").update(previousResponse.raw).digest("hex") !== previousResponse.rawHash) throw new Error("previous model response changed");
  const previousOutput = JSON.parse(JSON.parse(previousResponse.raw).choices[0].message.content);
  const parsed = transitionProposalSchema.safeParse(previousOutput);
  if (parsed.success || contentHash(parsed.error.issues.map(issue => issue.path)) !== contentHash([
    ["mechanicInvocations"], ["operations"], ["events"], ["decisionRequests"],
  ])) throw new Error("latest rejected schema control changed");
  const issues = validationIssues(parsed.error), retrySource = structuredClone(initialContext);
  retrySource.task.constraints = [...issues.map(issue => issue.message), ...retrySource.task.constraints];
  retrySource.repair = { target: null, issues: issues.map(issue => ({ code: issue.code, class: issue.class ?? "semantic", path: [...issue.path],
    originalValue: issue.originalValue ?? null, allowedHandles: [...(issue.allowedHandles ?? [])], reason: issue.message })) };
  const previousInvocationId = modelInvocationIdentity(firstRequest, firstRequest.role, firstRequest.subjectId, 1).modelInvocationId;
  const retryContext = logicalRepairContext(retrySource, { attempt: 2, scope: "step", targetIds: [], issues: [], previousOutput,
    logicalInvocationId: "rt:model-audit:9bd395fc8bb2d2d5d14f77f1ce86e5f64504150ace263c0ab9cac268e2ce75fd", repairOf: previousInvocationId,
  }, contentHash(initialContext), "truth_transition");
  const request = { ...firstRequest, workloadId: TRIAL, batchId: TRIAL, context: retryContext };
  const registryBinding = { catalog, capture: async (hash?: string) => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
    refresh: (options: Parameters<typeof registry.refresh>[0]) => registry.refresh(options), status: () => registry.status() };
  let contextBudget: Awaited<ReturnType<typeof countDeepSeekContext>> | undefined;
  const offline = createModelGateway(catalog, { [catalog.account("deepseek-api").api_key_env]: "offline-only" }, { maxTransportAttempts: 1,
    registry: registryBinding, fetchForAccount: () => async (_input, init) => {
      contextBudget = await countDeepSeekContext(JSON.parse(String(init?.body)));
      throw new ModelConfigurationError("offline complete-body admission; zero HTTP");
    } });
  try { await offline.generateStructured(request); } catch (error) { if (!contextBudget) throw error; }
  const manifest = { trialId: TRIAL, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceBundleHash: SOURCE_HASH,
    sourceTrialId: "trajectory-e2-11", previousRepairTrial: PREVIOUS, previousResponseHash: previousResponse.rawHash, repairAttempt: 2,
    sourceContextHash: contentHash(initialContext), candidateHash: contentHash(previousOutput), requestContextHash: contentHash(retryContext),
    actions: 24, logicalSlots: 1, maxHttp: 1, maximumRunNanoCny: STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken,
    contextBudget: contextBudget!, profile: profile.profile, model: profile.modelId, catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash,
    acceptance: "One new SECOND repair request within the existing two-repair limit for the complete historical24-action component. Preserve all original actions/state/candidate domain and Flash disabled-thinking settings; replace stale reference feedback with the four current schema errors and exact latest rejected output from candidate01. Do not fill its missing arrays in code or reuse the older flawed candidate. No new first response, automatic retry, critic, mechanics, world commit or resampling. Source/control integrity and full schema/coverage/reference admission precede independent semantic review; passing is bounded repair feasibility only, never gameplay or first-pass improvement. The closed first repair remains failed; all new HTTP and unknown billing remain in E2." };
  return { registry, registryBinding, catalog, initialContext, request, manifest };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-transition-candidate-probe.ts [prepare]");
  const directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("closed probe cannot restart");
  const design = await prepareTransitionCandidateProbe();
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(design.manifest, null, 2)); design.registry.stopBackgroundRefresh(); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit verified code before paid probe");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx")); mkdirSync(directory, { recursive: true });
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, dispatches = 0;
  const stop = () => { stopped = true; }, report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest,
    status, failure, dispatches, budget: budget?.summary, updatedAt: new Date().toISOString(), stepCommitted: false, semantics: "unassessed" }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = budget.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || used + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete probe budget unavailable");
    const account = design.catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env)("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, endpointPaths: ["/chat/completions"],
      trialPattern: /^probes-e2-transition-candidate-02$/u, requireThinkingDisabled: true, priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const gateway = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1, registry: design.registryBinding,
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches) throw new ModelConfigurationError("one-shot dispatch gate closed");
        const admission = await countDeepSeekContext(JSON.parse(String(init?.body)));
        if (stopped || admission.bodyHash !== design.manifest.contextBudget.bodyHash || admission.counterHash !== design.manifest.contextBudget.counterHash) throw new ModelConfigurationError("request or admission drift");
        writeFileSync(path.join(directory, "context-admission.json"), JSON.stringify(admission, null, 2), { flag: "wx" });
        const response = await transport.fetch(input, init), inference = probeInferenceEvidence(await response.clone().json(), "B");
        if (!inference.inferenceValid) throw new ModelConfigurationError(inference.inferenceError ?? "inference drift");
        return response;
      } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest, phaseBudgetHash: budget.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "context.json.gz"), gzipSync(JSON.stringify(design.request.context)), { flag: "wx" });
    transport.beginTrial(TRIAL, "probes"); status = "running"; report();
    const started = performance.now(), result = await gateway.generateStructured(design.request);
    const score = scoreRepairTail(JSON.stringify({ slots: [{ slot: 0, result: result.value }] }), "transition", [design.initialContext]);
    writeFileSync(path.join(directory, "result.json.gz"), gzipSync(JSON.stringify({ result, score, elapsedMs: performance.now() - started })), { flag: "wx" });
    if (stopped || dispatches !== 1 || budget.summary.blockingUnknown.length) throw new Error("interruption, dispatch or billing gate failed");
    status = score.schemaCoverageReferences ? "formal-complete-awaiting-source-review" : "failed-formal-admission";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); design.registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, dispatches }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
