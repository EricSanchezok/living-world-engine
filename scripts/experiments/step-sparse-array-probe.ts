import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { scoreRepairTail } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { transitionProposalSchema } from "../../src/engine/contracts/llm-schemas";
import { canonicalSparseArraysRequest } from "../../src/engine/mechanics/canonical-sparse-arrays";
import { canonicalTransitionEvidenceRequest } from "../../src/engine/mechanics/transition-evidence-worklist";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, ModelOutputError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { promptBundle } from "../../src/engine/prompts";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { probeInferenceEvidence } from "./step-json-probe";

const TRIAL = "probes-e2-sparse-arrays-01", root = path.resolve(STEP_E2_PROTOCOL.root);
const hashes = { request: "d366fb28ec95953a8c4dcfce65078c1e7b79af4684166e1e9b3ea16bd94b70de",
  rejected: "d444aa61fe19c5c5b3d4e235f2faf7cd43924c46eabac1358acf6e7d8e85bd3d",
  body: "512b28ea1a4e769dd5bfe5e77e4a04bb8603754a6303d894ffee03efff17b355" };
type SourceContext = { task: { transitionWorklist?: unknown }; repair: unknown; state: { actionSet: { assigned: Array<{ actionRef: string }> } } };
type RecordedRequest = { context: SourceContext; profileId: string; system: string; userPrompt: string; promptVersion: string;
  modelCatalogHash: string; registrySnapshotHash: string; profile: unknown; schema: Record<string, unknown>; jsonSyntaxRecovery: string };

export async function prepareSparseArrayProbe() {
  const artifact = <T>(hash: string): T => {
    const entry = JSON.parse(readFileSync(path.join(root, "evidence/sparse-arrays-01", `${hash}.json`), "utf8"));
    if (entry.hash !== hash || contentHash(entry.value) !== hash) throw new Error("sparse source artifact drift"); return entry.value as T;
  };
  const recorded = artifact<RecordedRequest>(hashes.request), rejected = artifact<unknown>(hashes.rejected);
  const parsed = transitionProposalSchema.safeParse(rejected);
  if (parsed.success || contentHash(parsed.error.issues.map(issue => issue.path)) !== contentHash([
    ["mechanicInvocations"], ["operations"], ["events"], ["decisionRequests"],
  ])) throw new Error("historical missing-array rejection changed");
  const context = structuredClone(recorded.context); delete context.task.transitionWorklist;
  if (context.repair !== null || context.state.actionSet.assigned.length !== 1 ||
    context.state.actionSet.assigned[0]!.actionRef !== "ref:action:rt:action:aae32547635-aa31a2e8") throw new Error("original initial component scope changed");
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-14/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/short-action-checkpoints-01/model-catalog.json"));
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("offline registry refresh forbidden"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash), profile = resolveModelProfile(catalog, snapshot, recorded.profileId);
  if (catalog.hash !== recorded.modelCatalogHash || snapshot.hash !== recorded.registrySnapshotHash || contentHash(profile.profile) !== contentHash(recorded.profile) ||
    profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled") throw new Error("inference drift");
  const registryBinding = { catalog, capture: async (hash?: string) => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
    refresh: (options: Parameters<ModelRegistry["refresh"]>[0]) => registry.refresh(options), status: () => registry.status() };
  const prompt = promptBundle("truth-transition");
  const original = canonicalTransitionEvidenceRequest({ ...prompt, promptVersion: prompt.version, role: "truth-transition", profileId: recorded.profileId,
    workloadId: TRIAL, batchId: TRIAL, subjectId: "component-kostbera", runtimeIdentity: { worldHash: history.retrievalPreflight.worldHash, revision: 0 },
    modelRegistrySnapshotHash: snapshot.hash, context, schemaName: "truth_transition", schema: transitionProposalSchema, jsonSyntaxRecovery: "unmatched-closers-v1" });
  if (recorded.jsonSyntaxRecovery !== original.jsonSyntaxRecovery || recorded.promptVersion !== original.promptVersion ||
    ["context", "system", "userPrompt"].some(key => contentHash(original[key as "context" | "system" | "userPrompt"]) !== contentHash(recorded[key as "context" | "system" | "userPrompt"])) ||
    contentHash(original.wireJsonSchema) !== contentHash(recorded.schema)) throw new Error("complete canonical request reconstruction mismatch");
  const requests: StructuredModelRequest<unknown>[] = [original, canonicalSparseArraysRequest(original)];
  const bodies: Array<{ messages: Array<{ content: string }> }> = [], admissions: Array<Awaited<ReturnType<typeof countDeepSeekContext>>> = [];
  for (const request of requests) {
    let seen = false;
    const gateway = createModelGateway(catalog, { [catalog.account("deepseek-api").api_key_env]: "offline-only" }, { maxTransportAttempts: 1, registry: registryBinding,
      fetchForAccount: () => async (_input, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); admissions.push(await countDeepSeekContext(body)); seen = true; throw new ModelConfigurationError("offline body capture"); } });
    try { await gateway.generateStructured(request); } catch (error) { if (!seen) throw error; }
  }
  const restored = structuredClone(bodies[1]!), baselineMessage = bodies[0]!.messages[1]!.content;
  const schemaLine = (message: string) => {
    const parts = message.split("\nJSON Schema: "); if (parts.length !== 2) throw new Error("unique output schema boundary required");
    return parts[1]!.split("\n")[0]!;
  };
  if (contentHash(JSON.parse(schemaLine(baselineMessage))) !== contentHash(original.wireJsonSchema) ||
    contentHash(JSON.parse(schemaLine(restored.messages[1]!.content))) !== contentHash(requests[1]!.wireJsonSchema)) throw new Error("actual wire schema mismatch");
  restored.messages[1]!.content = restored.messages[1]!.content.replace(requests[1]!.userPrompt, original.userPrompt)
    .replace(schemaLine(restored.messages[1]!.content), schemaLine(baselineMessage));
  if (contentHash(bodies[0]) !== hashes.body || contentHash(restored) !== hashes.body) throw new Error("pair differs beyond the declared schema and instruction");
  const score = (value: unknown) => scoreRepairTail(JSON.stringify({ slots: [{ slot: 0, result: value }] }), "transition", [context]);
  const maximumRunNanoCny = 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken);
  const manifest = { trialId: TRIAL, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceHashes: hashes,
    sourceContextHash: contentHash(context), originalContextHash: contentHash(recorded.context), sourceTrial: "trajectory-e2-14", sourceHttp: 45,
    sourceInvocation: "rt:model-audit:eb09465e85936857388d1ca432e805e089943ec7343a60dc5a31c19f976523d4",
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    specificationHash: contentHash(readFileSync("docs/specs/0066-sparse-transition-array-diagnostic.md", "utf8")),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: profile.modelId, inference: profile.profile.inference, profileId: profile.profileId,
    contextBudgets: admissions, maximumRunNanoCny, promptVersions: requests.map(request => request.promptVersion),
    schemaHashes: requests.map(request => contentHash(request.wireJsonSchema)), order: ["B", "T"], actualHttpMaximum: 2, actions: 1,
    interpretation: "Two independent one-call diagnostics of the complete original INITIAL canonical component, not a reduced root. Only the declared empty-array wire contract differs. No repairs, retries, critic, stronger inference or runtime promotion. Historical failures remain failed. Formal schema/coverage/reference admission cannot establish action semantics, required effects or gameplay; source review remains required." };
  return { catalog, registry, registryBinding, requests, bodies, manifest, score };
}

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!["prepare", "run"].includes(command ?? "") || extra.length) throw new Error("usage: step-sparse-array-probe.ts prepare|run");
  const design = await prepareSparseArrayProbe();
  if (command === "prepare") { design.registry.stopBackgroundRefresh(); console.log(JSON.stringify(design.manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked code before paid pair");
  const frozen = JSON.parse(readFileSync(path.join(root, "evidence/sparse-arrays-01/preflight.json"), "utf8"));
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
      trialPattern: /^probes-e2-sparse-arrays-01$/u, priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const gateway = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1, registry: design.registryBinding,
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || active !== dispatches || budget!.summary.blockingUnknown.length) throw new ModelConfigurationError("pair dispatch stopped");
        const admission = await countDeepSeekContext(JSON.parse(String(init?.body)));
        if (stopped || contentHash(admission) !== contentHash(design.manifest.contextBudgets[active])) throw new ModelConfigurationError("actual body drift");
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
