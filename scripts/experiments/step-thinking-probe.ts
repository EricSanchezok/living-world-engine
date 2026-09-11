import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadStepCompilationProbeSources } from "./step-eligibility-probe";
import { loadTruthProbeSource, probeInferenceEvidence, scorePlanBatch } from "./step-json-probe";
import { ModelCatalog, type ModelCatalogDocument } from "../../src/engine/models/model-catalog";
import { openAIChatRequestPlan } from "../../src/engine/models/model-dialect";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { executeCompilationTrial } from "../../src/engine/benchmarks/action-compilation/first-pass-runner";
import { firstPassAlgorithmRef } from "../../src/engine/benchmarks/action-compilation/first-pass-protocol";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { STEP_E1_BUDGET, STEP_E1_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/protocol";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";

type Arm = "B" | "H" | "L";
/** Gateway construction resolves transports for all catalog accounts. Guard
 * actual sends, so an unused configured account cannot block initialization. */
export const thinkingProbeAccountFetch = (send: typeof fetch) => (id: string): typeof fetch => async (input, init) => {
  if (id !== "deepseek-api") throw new Error("unapproved account");
  return send(input, init);
};
export function thinkingProbeBody(body: Record<string, unknown>, arm: Arm) {
  const base = structuredClone(body);
  delete base.thinking;
  delete base.reasoning_effort;
  return openAIChatRequestPlan({ thinking: arm === "B" ? "disabled" : "enabled", effort: arm === "B" ? null : arm === "L" ? "low" : "high",
    reasoningBudgetTokens: null, reasoningSummary: null, textVerbosity: null, temperature: null, topP: null }).transformBody(base);
}
export function thinkingProbeEvidence(raw: unknown, arm: Arm) {
  if (arm === "B") return probeInferenceEvidence(raw, "B");
  const response = raw as { model?: string; choices?: Array<{ message?: { reasoning_content?: string } }>;
    usage?: { completion_tokens_details?: { reasoning_tokens?: number } } };
  const reasoningPresent = Boolean(response?.choices?.[0]?.message?.reasoning_content?.trim());
  const inferenceValid = response?.model === STEP_E1_PROTOCOL.model && reasoningPresent;
  return { inferenceValid, inferenceError: inferenceValid ? null : "enabled thinking/model could not be verified",
    reasoningPresent, reasoningTokens: response?.usage?.completion_tokens_details?.reasoning_tokens ?? null };
}
export function thinkingCatalog(catalog: ModelCatalog, effort: "high" | "low" = "high"): ModelCatalog {
  const profiles = { ...structuredClone(catalog.profiles) };
  profiles["truth-deepseek"] = { ...profiles["truth-deepseek"]!, inference: {
    ...profiles["truth-deepseek"]!.inference, thinking: "enabled", effort } };
  return new ModelCatalog({ schema_version: catalog.schemaVersion, scheduler: catalog.scheduler,
    registry: catalog.registry, accounts: catalog.accounts, profiles, model_overrides: catalog.modelOverrides } as ModelCatalogDocument);
}
function order(kind: "compile" | "truth", count: number, treatment: "H" | "L", repetitions: number) {
  return Array.from({ length: count }, (_, sourceIndex) => Array.from({ length: repetitions }, (_, repetition) =>
    (["B", treatment] as const).map((arm) => ({ kind, sourceIndex, sourceId: `${kind}-${sourceIndex}`, repetition, arm,
      id: `${kind}-${sourceIndex}-${repetition}-${arm}`, phase: "discovery" as const }))
      .sort((a, b) => contentHash({ seed: STEP_E1_PROTOCOL.seed, ...a }).localeCompare(contentHash({ seed: STEP_E1_PROTOCOL.seed, ...b }))))).flat(2);
}

export async function runThinkingStudy(study: { trialId: "probes-e1-thinking-02" | "probes-e1-low-01"; treatment: "H" | "L"; compileRepetitions: number; compileInputCeiling: number }) {
  const TRIAL = study.trialId;
  const effort = study.treatment === "L" ? "low" : "high";
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-thinking-probe.ts [prepare]");
  const root = path.resolve(STEP_E1_PROTOCOL.root), directory = path.join(root, "runs", TRIAL);
  const { sources, catalog, resources, registry } = await loadStepCompilationProbeSources();
  const treatmentCatalog = thinkingCatalog(catalog, effort);
  const treatmentRegistry = new ModelRegistry(treatmentCatalog, path.resolve(".livingworld-v23"), { fetch: async () => { throw new Error("probe cannot refresh metadata"); } });
  for (const [selected, selectedRegistry] of [[catalog, registry], [treatmentCatalog, treatmentRegistry]] as const) {
    createModelGateway(selected, process.env, { registry: selectedRegistry,
      fetchForAccount: thinkingProbeAccountFetch(async () => { throw new ModelConfigurationError("offline preparation forbids HTTP"); }) });
    for (const source of sources) {
      const binding = resolveModelProfile(selected, selectedRegistry.snapshot(source.registrySnapshotHash), source.profileId);
      if (binding.modelId !== source.modelId) throw new Error("offline model binding drift");
    }
  }
  const truthSources = ["017", "018"].map((ordinal) => loadTruthProbeSource(root, `discovery-e1-04-http-${ordinal}`));
  const schedule = [...order("compile", sources.length, study.treatment, study.compileRepetitions), ...order("truth", truthSources.length, study.treatment, 2)];
  const compileRootsPerArm = sources.length * study.compileRepetitions;
  const compileHttpCeiling = compileRootsPerArm * 2 * 3;
  const worstCase = compileHttpCeiling * (study.compileInputCeiling * 3520 + 131072 * 10560) + 8 * (1000000 * 3520 + 131072 * 10560);
  const manifest = { trialId: TRIAL, schedule, sourceHashes: sources.map(contentHash), truthSources: truthSources.map(({ id, bodyHash, expected }) => ({ id, bodyHash, expected })),
    catalogHashes: { B: catalog.hash, [study.treatment]: treatmentCatalog.hash }, protocolHash: contentHash(STEP_E1_PROTOCOL), budgetHash: contentHash(STEP_E1_BUDGET),
    intervention: `Only truth-deepseek inference thinking=enabled, effort=${effort}; B retains disabled/auto. Flash model, messages, T codec, R5, schemas, output limits and recovery unchanged. E is not enabled.`,
    worstCaseNanoCny: worstCase, maxHttp: { compile: compileHttpCeiling, truth: 8 }, compileInputCeiling: study.compileInputCeiling,
    acceptance: { compile: `${study.treatment} final ${compileRootsPerArm}/${compileRootsPerArm}; first >B unless both ${compileRootsPerArm}/${compileRootsPerArm}; HTTP<=B; total tokens<=1.10B; mean latency<=2B; no new determined semantic violation in source-bound inspection.`,
      truth: `${study.treatment} schema+assigned coverage>=3/4 with >=1/2 per source, strictly exceeds B; total tokens<=1.10B; same four HTTP; mean latency<=3B; inspect source-bound references and effects before prospective gameplay trial. No semantic certification.` } };
  // Use the actual compiler/retrieval boundary to verify all captured inputs.
  const boundary = { catalog: treatmentCatalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => undefined,
    generateStructured: async () => { throw new ModelConfigurationError("offline thinking boundary"); } };
  for (const [index, source] of sources.entries()) {
    registry.snapshot(source.registrySnapshotHash);treatmentRegistry.snapshot(source.registrySnapshotHash);
    const result = await executeCompilationTrial({ trial: schedule.find((row) => row.kind === "compile" && row.sourceIndex === index)!, source,
      provider: boundary, retrieval: resources.runtime(source.captureAlgorithmRef)!, compiler: representedActionCompiler("T"),
      algorithmRef: firstPassAlgorithmRef(source.captureAlgorithmRef, "T"), executionPrefix: TRIAL,
      expectedCatalogHash: treatmentCatalog.hash, expectedOutputMode: "json-object-zod" });
    if (result.calls.length !== 1 || result.error?.message !== "offline thinking boundary" || contentHash(result.calls[0]!.context) !== source.modelContextHash) throw new Error("thinking probe source drift");
  }
  if (process.argv[2] === "prepare") { console.log(JSON.stringify({ ...manifest, networkRequests: 0 })); return; }
  if (existsSync(path.join(directory, "manifest.json"))) throw new Error("frozen thinking probe cannot restart");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before thinking probe");
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E1_BUDGET);
  const group = STEP_E1_BUDGET.phaseBudgets!.find((entry) => entry.phases.includes("probes"))!;
  if (budget.summary.blockingUnknown.length || Date.now() >= Date.parse(STEP_E1_PROTOCOL.deadlineUtc) ||
    budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + worstCase > STEP_E1_BUDGET.maximumNanoCny ||
    group.phases.reduce((sum, phase) => sum + budget.summary.phases[phase].estimatedPeakNanoCny, 0) + budget.summary.reservedNanoCny + worstCase > group.maximumNanoCny) throw new Error("complete thinking probe does not fit budget/deadline");
  mkdirSync(directory, { recursive: true });
  const lock = path.join(root, "writer.lock");closeSync(openSync(lock, "wx"));
  let status = "preparing", failure: string | undefined, interrupted = false;
  const stop = () => { interrupted = true; };
  const rows: unknown[] = [];
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ trialId: TRIAL, status, failure, updatedAt: new Date().toISOString(), rows, budget: budget.summary }, null, 2));
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  const timer = setInterval(report, 10000);
  try {
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2), { flag: "wx" });
    const account = catalog.account("deepseek-api");
    const key = process.env[account.api_key_env];
    if (!key) throw new Error("DeepSeek credential unavailable");
    const accountFetch = createModelFetchResolver(process.env)("deepseek-api", account) ?? fetch;
    const makeTransport = (kind: "compile" | "truth") => {
      const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: accountFetch,
        inputTokenCeiling: kind === "compile" ? study.compileInputCeiling : 1000000, outputTokenCeiling: 131072,
        trialPattern: new RegExp(`^${TRIAL}-(compile|truth)$`, "u"),
        priceBinding: { accountId: "deepseek-api", modelId: STEP_E1_PROTOCOL.model, priceId: "flash" } });
      transport.beginTrial(`${TRIAL}-${kind}`, "probes");return transport;
    };
    const transports = { compile: makeTransport("compile"), truth: makeTransport("truth") };
    const counts = { compile: 0, truth: 0 };
    let activeArm: Arm = "B";
    const send = async (kind: "compile" | "truth", input: RequestInfo | URL, init?: RequestInit) => {
      if (interrupted || Date.now() >= Date.parse(STEP_E1_PROTOCOL.deadlineUtc) || ++counts[kind] > manifest.maxHttp[kind]) throw new Error("thinking probe stop boundary");
      const body = JSON.parse(String(init?.body));
      if (body.model !== STEP_E1_PROTOCOL.model || body.max_tokens !== 131072 ||
        body.thinking?.type !== (activeArm === "B" ? "disabled" : "enabled") ||
        (activeArm === "B" ? body.reasoning_effort !== undefined : body.reasoning_effort !== effort)) throw new Error("actual request inference mismatch");
      return transports[kind].fetch(input, init);
    };
    const treatmentProvider = createModelGateway(treatmentCatalog, process.env, { registry: treatmentRegistry, maxTransportAttempts: 1,
      fetchForAccount: thinkingProbeAccountFetch((input, init) => send("compile", input, init)) });
    const baselineProvider = createModelGateway(catalog, process.env, { registry, maxTransportAttempts: 1,
      fetchForAccount: thinkingProbeAccountFetch((input, init) => send("compile", input, init)) });
    status = "running";report();
    for (const trial of schedule) {
      activeArm = trial.arm;
      if (interrupted || Date.now() >= Date.parse(STEP_E1_PROTOCOL.deadlineUtc)) throw new Error("thinking probe interrupted/deadline");
      const before = counts[trial.kind], started = performance.now();
      let result: unknown;
      let score: Record<string, unknown>;
      if (trial.kind === "compile") {
        const source = sources[trial.sourceIndex]!;
        const selectedProvider = trial.arm === "B" ? baselineProvider : treatmentProvider;
        const compiled = await executeCompilationTrial({ trial, source, provider: selectedProvider, retrieval: resources.runtime(source.captureAlgorithmRef)!,
          compiler: representedActionCompiler("T"), algorithmRef: firstPassAlgorithmRef(source.captureAlgorithmRef, "T"),
          executionPrefix: TRIAL, expectedCatalogHash: selectedProvider.catalog.hash, expectedOutputMode: "json-object-zod" });
        result = compiled;
        const first = compiled.events.find((event) => event.event === "model.action_compilation.slots.validated" && (event.correlation?.semanticRepairAttempt ?? 0) === 0);
        score = { accepted: compiled.compilerAccepted, initialAccepted: first?.counts?.accepted ?? 0, initialRejected: first?.counts?.rejected ?? 12, error: compiled.error?.message, stateUnchanged: compiled.stateUnchanged };
      } else {
        const source = truthSources[trial.sourceIndex]!;
        const response = await send("truth", `${account.base_url}/chat/completions`, { method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(thinkingProbeBody(source.body, trial.arm)), signal: AbortSignal.timeout(300000) });
        const raw = await response.json();
        score = scorePlanBatch(raw.choices?.[0]?.message?.content ?? "", source.expected);
        result = { trial, score, sourceHash: source.bodyHash };
      }
      writeFileSync(path.join(directory, `${trial.id}.json`), JSON.stringify(result), { flag: "wx" });
      const http = readdirSync(path.join(root, "http")).filter((id) => id.startsWith(`${TRIAL}-${trial.kind}-http-`)).sort().slice(before).map((id) => {
        const response = JSON.parse(readFileSync(path.join(root, "http", id, "response.json"), "utf8"));const raw = JSON.parse(response.raw);
        return { id, usage: deepSeekExperimentUsage(raw), ...thinkingProbeEvidence(raw, trial.arm) };
      });
      const row = { trial, ...score, http, wallMs: performance.now() - started, evidenceHash: contentHash(result) };
      rows.push(row);report();console.log(JSON.stringify({ ...row, http: http.length, error: typeof score.error === "string" ? score.error.slice(0, 250) : null }));
      if (!http.length || http.some((entry) => !entry.inferenceValid) || budget.summary.blockingUnknown.length) throw new Error("thinking probe model controls or billing failure");
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { clearInterval(timer);report();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, completed: rows.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void runThinkingStudy({
  trialId: "probes-e1-thinking-02", treatment: "H", compileRepetitions: 2, compileInputCeiling: 300000 });
