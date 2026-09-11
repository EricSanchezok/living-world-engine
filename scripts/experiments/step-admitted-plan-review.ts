import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, gunzipSync } from "node:zlib";
import { deepSeekExperimentUsage, ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { reviewAdmittedResolutionRequests } from "../../src/engine/benchmarks/step-efficiency/resolution-admission-review";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { resolveModelProfile } from "../../src/engine/models/model-registry";
import { ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { admissionRequestEvidence, prepareRuntimeAdmission } from "./step-runtime-admission-probe";

const TRIAL = "review-e2-admitted-plans-01";
const ROOT = path.resolve(STEP_E2_PROTOCOL.root);
const SOURCE_TRIAL = "probes-e2-runtime-admission-01";

export async function prepareAdmittedPlanReview() {
  const prepared = await prepareRuntimeAdmission();
  const { source, catalog, snapshot } = prepared;
  const directory = path.join(ROOT, "runs", SOURCE_TRIAL);
  const sourceManifest = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  const report = JSON.parse(readFileSync(path.join(directory, "report.json"), "utf8"));
  const admitted = JSON.parse(gunzipSync(readFileSync(path.join(directory, "C-result.json.gz"))).toString("utf8"));
  const response = JSON.parse(readFileSync(path.join(ROOT, "http", `${SOURCE_TRIAL}-http-001`, "response.json"), "utf8"));
  if (contentHash(response.raw) !== response.rawHash || sourceManifest.sourceHash !== contentHash(source) ||
    sourceManifest.initialRequestHashes.C !== prepared.manifest.initialRequestHashes.C ||
    report.status !== "completed" || report.decision !== "eligible-for-source-semantic-review" ||
    !admitted.result.firstHttpComplete || admitted.result.sourceHash !== contentHash(source)) throw new Error("source admission evidence mismatch");
  const wire = JSON.parse(JSON.parse(response.raw).choices[0].message.content);
  const requests: StructuredModelRequest<unknown>[] = [];
  let replays = 0;
  const replay = new ScriptedModelProvider(() => { if (++replays !== 1) throw new Error("only the original first response can replay"); return structuredClone(wire); }, catalog, false);
  const result = await runResolutionAdmission(source, replay, { candidate: true, maxPhysicalRequests: 1,
    scope: { modelRegistrySnapshotHash: snapshot.hash }, onVerifierRequest: (request, slot) => { requests[slot] = request; } });
  if (!result.firstHttpComplete || requests.length !== 12 || result.rows.some((row, slot) =>
    contentHash(row.verifierContext) !== contentHash(admitted.result.rows[slot].verifierContext))) throw new Error("replayed verifier context changed");
  const profile = resolveModelProfile(catalog, snapshot, source.definition.modelProfiles.causalVerifier);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled" ||
    profile.profile.max_output_tokens !== STEP_E2_PROTOCOL.outputTokenCeiling) throw new Error("review model binding changed");
  const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
  await reviewAdmittedResolutionRequests(requests, { catalog, availableProfileSummaries: role => catalog.profileSummaries(role),
    assertProfilesAvailable: async () => {}, generateStructured: async () => { throw new ModelConfigurationError("offline review capture"); } },
  { maxPhysicalRequests: 1, onPhysicalRequest: request => captures.push(admissionRequestEvidence(request)) });
  if (captures.length !== 1) throw new Error("review root batch changed");
  const manifest = { trialId: TRIAL, sourceTrialId: SOURCE_TRIAL, sourceManifestHash: contentHash(sourceManifest),
    sourceResponseHash: response.rawHash, sourceResultHash: contentHash(admitted), sourceHash: contentHash(source), stateHash: contentHash(source.state),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, profileId: profile.profileId, model: profile.modelId,
    inference: profile.profile.inference, slots: 12, actions: 43, maxHttp: 3,
    maximumRunNanoCny: 3 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    requestHashes: requests.map(request => contentHash(admissionRequestEvidence(request))), initialPhysicalRequestHash: contentHash(captures[0]),
    acceptance: "Existing runtime plan-review prompt and schema, captured by replaying the one immutable admitted wire response through actual TruthEngine. Replay performs no HTTP. Review all twelve original slots/43 plans in the unchanged full context, arm labels hidden. Fixed plans: no new planner call or semantic repair. Existing batch structural repair capped at three total HTTP; no transport retry, RNG or world commit. Out-of-slot findings, malformed/missing output and unresolved billing cannot pass. Any reject stops candidate admission; all accept only permits a fresh full-world diagnostic. Same-family uncalibrated reviewer is limited evidence, not a semantic proof or gameplay success. Specifically retain the all-automatic/no-receipt-effect risk in the final analysis; original prompts are not tuned against these outputs." };
  return { ...prepared, requests, manifest };
}

type ReviewPreparation = Pick<Awaited<ReturnType<typeof prepareAdmittedPlanReview>>, "catalog" | "registry" | "snapshot" | "requests"> & {
  manifest: Pick<Awaited<ReturnType<typeof prepareAdmittedPlanReview>>["manifest"], "trialId" | "maximumRunNanoCny" | "profileId" | "initialPhysicalRequestHash"> & Record<string, unknown>;
};

export async function runAdmittedPlanReview(spec: { trialId: string; prepare: () => Promise<ReviewPreparation> } = {
  trialId: TRIAL, prepare: prepareAdmittedPlanReview,
}, args = process.argv.slice(2)) {
  const trialId = spec.trialId;
  if (!/^[a-z0-9-]+$/u.test(trialId)) throw new Error("invalid review identifier");
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-admitted-plan-review.ts [prepare]");
  const { catalog, registry, snapshot, requests, manifest } = await spec.prepare();
  if (manifest.trialId !== trialId) throw new Error("prepared review identity mismatch");
  if (args[0] === "prepare") { console.log(JSON.stringify(manifest, null, 2)); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid review");
  const directory = path.join(ROOT, "runs", trialId), lock = path.join(ROOT, "writer.lock");
  if (existsSync(directory)) throw new Error("a frozen review cannot restart");
  closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, result: Awaited<ReturnType<typeof reviewAdmittedResolutionRequests>> | undefined;
  let stopped = false, status = "preparing", failure: string | undefined, dispatches = 0, physicalRequests = 0;
  const observer = new RecordingRuntimeObserver({ mode: "full" });
  const connections: unknown[] = [];
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, dispatches,
    verdict: status === "completed" ? result?.verdict : "unknown", rows: result?.rows.map(({ audit: _audit, ...row }) => row),
    budget: budget?.summary, updatedAt: new Date().toISOString(), connections }, null, 2));
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    mkdirSync(directory, { recursive: true });
    const ledger = new ExperimentBudget(path.join(ROOT, "budget.jsonl"), STEP_E2_BUDGET); budget = ledger;
    const phase = ledger.summary.phaseBudgets.find(group => group.phases.includes("review"))!;
    const used = phase.phases.reduce((sum, name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny, 0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("review forecast or unknown billing blocks dispatch");
    const account = catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: event => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(ledger, { root: ROOT, baseUrl: account.base_url,
      fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: new RegExp(`^${trialId}$`, "u"), requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const provider = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog, capture: async hash => { if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry drift"); return snapshot; },
        refresh: options => registry.refresh(options), status: () => registry.status() },
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches >= 3) throw new ModelConfigurationError("review HTTP gate stopped dispatch");
        try { const response = await transport.fetch(input, init); const value = await response.clone().json();
          if (value.model !== STEP_E2_PROTOCOL.model) throw new ModelConfigurationError("response model changed"); return response;
        } catch (error) { stopped = true; failure = String(error); throw error; }
      } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), phaseBudgetHash: ledger.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "logical-requests.json.gz"), gzipSync(JSON.stringify(requests.map(admissionRequestEvidence))), { flag: "wx" });
    transport.beginTrial(trialId, "review"); status = "running"; report();
    result = await reviewAdmittedResolutionRequests(requests.map(request => ({ ...request, observer })), provider,
      { maxPhysicalRequests: 3, onPhysicalRequest: request => {
        if (stopped || request.profileId !== manifest.profileId) throw new ModelConfigurationError("review scope stopped or changed");
        const evidence = admissionRequestEvidence(request);
        if (physicalRequests++ === 0 && contentHash(evidence) !== manifest.initialPhysicalRequestHash) throw new ModelConfigurationError("frozen review request changed");
        writeFileSync(path.join(directory, `request-${physicalRequests}.json.gz`), gzipSync(JSON.stringify(evidence)), { flag: "wx" });
      } });
    writeFileSync(path.join(directory, "result.json.gz"), gzipSync(JSON.stringify({ result, events: observer.events })), { flag: "wx" });
    if (stopped || ledger.summary.blockingUnknown.length) throw new Error(failure ?? "interruption or billing integrity failure");
    const costs = [];
    for (let i = 1; i <= dispatches; i++) {
      const http = path.join(ROOT, "http", `${trialId}-http-${String(i).padStart(3, "0")}`);
      const request = JSON.parse(readFileSync(path.join(http, "request.json"), "utf8"));
      const response = JSON.parse(readFileSync(path.join(http, "response.json"), "utf8"));
      const usage = deepSeekExperimentUsage(JSON.parse(response.raw));
      costs.push({ usage, ...documentedFlashCost(usage, request.startedAt, response.completedAt) });
    }
    writeFileSync(path.join(directory, "costs.json"), JSON.stringify(costs, null, 2), { flag: "wx" });
    status = "completed";
  } catch (error) { status = "stopped"; failure = String(error); }
  finally { report(); registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId, status, failure, verdict: status === "completed" ? result?.verdict : "unknown", dispatches,
    rows: result?.rows.map(row => ({ slot: row.slot, verdict: row.verdict, findings: row.review?.findings, error: row.error })) }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runAdmittedPlanReview().catch(error => { console.error(error); process.exitCode = 1; });
