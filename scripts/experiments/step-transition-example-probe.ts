import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { scoreRepairTail } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, ModelOutputError } from "../../src/engine/models/model-provider";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { probeInferenceEvidence } from "./step-json-probe";
import { prepareTransitionCandidateProbe } from "./step-transition-candidate-probe";

const TRIAL = "probes-e2-transition-example-01", root = path.resolve(STEP_E2_PROTOCOL.root);
type Arm = "B" | "T";

export async function prepareTransitionExampleProbe() {
  const base = await prepareTransitionCandidateProbe();
  const bodies: Record<string, unknown>[] = [], admissions: Array<Awaited<ReturnType<typeof countDeepSeekContext>>> = [];
  const requests = (["B", "T"] as const).map(arm => ({ ...base.request, workloadId: TRIAL, batchId: `${TRIAL}-${arm}`,
    ...(arm === "T" ? { jsonExamplePolicy: "omit" as const } : {}) }));
  for (const request of requests) {
    let captured = false;
    const offline = createModelGateway(base.catalog, { [base.catalog.account("deepseek-api").api_key_env]: "offline-only" }, {
      maxTransportAttempts: 1, registry: base.registryBinding, fetchForAccount: () => async (_input, init) => {
        const body = JSON.parse(String(init?.body)); bodies.push(body); admissions.push(await countDeepSeekContext(body)); captured = true;
        throw new ModelConfigurationError("offline paired request captured");
      } });
    try { await offline.generateStructured(request); } catch (error) { if (!captured) throw error; }
  }
  if (admissions[0]!.bodyHash !== base.manifest.contextBudget.bodyHash) throw new Error("historical control body changed");
  const normalized = structuredClone(bodies[0]) as { messages: Array<{ content: string }> };
  const example = '\nExample JSON output shape: {"outcomes":[],"mechanicInvocations":[],"operations":[],"events":[],"decisionRequests":[]}\nThe example is illustrative and non-normative; follow the task\'s explicit cardinality, coverage, and non-empty requirements over this example.';
  if (normalized.messages[1]!.content.split(example).length !== 2) throw new Error("exact empty example boundary changed");
  normalized.messages[1]!.content = normalized.messages[1]!.content.replace(example, "");
  if (contentHash(normalized) !== contentHash(bodies[1])) throw new Error("treatment changed more than the illustrative example");
  const manifest = { ...base.manifest, trialId: TRIAL, order: ["B", "T"], maxHttp: 2,
    maximumRunNanoCny: base.manifest.maximumRunNanoCny * 2, contextBudgets: admissions,
    acceptance: "A new paired one-response diagnostic, not a third gameplay repair. B and T use exactly the same frozen source and candidate02 input; only T omits the schema-derived empty example. No automatic retries or output transfer. Full formal coverage precedes source review; one pair cannot establish general reliability, semantics or gameplay success." };
  return { ...base, requests, manifest };
}

export async function runTransitionPairProbe(prepare: typeof prepareTransitionExampleProbe = prepareTransitionExampleProbe) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-transition-example-probe.ts [prepare]");
  const design = await prepare(), trialId = design.manifest.trialId;
  const directory = path.join(root, "runs", trialId);
  if (existsSync(directory)) throw new Error("closed probe cannot restart");
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(design.manifest, null, 2)); design.registry.stopBackgroundRefresh(); return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit verified code before paid probe");
  const lock = path.join(root, "writer.lock"); closeSync(openSync(lock, "wx")); mkdirSync(directory, { recursive: true });
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, dispatches = 0, active = 0;
  const rows: Array<{ arm: Arm; score?: unknown; failure?: string; elapsedMs: number }> = [];
  const stop = () => { stopped = true; }, report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest,
    status, failure, rows, dispatches, budget: budget?.summary, updatedAt: new Date().toISOString(), stepCommitted: false, semantics: "unassessed" }, null, 2));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = budget.summary.phaseBudgets.find(group => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || used + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete pair budget unavailable");
    const account = design.catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env)("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: async (input, init) => { dispatches++; report(); return send(input, init); },
      inputTokenCeiling: STEP_E2_PROTOCOL.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, endpointPaths: ["/chat/completions"],
      trialPattern: /^probes-e2-(transition-example|logical-tail)-01$/u, requireThinkingDisabled: true, priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const gateway = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1, registry: design.registryBinding,
      fetchForAccount: id => async (input, init) => {
        if (id !== "deepseek-api" || stopped || dispatches !== active || budget!.summary.blockingUnknown.length) throw new ModelConfigurationError("paired dispatch gate closed");
        const admission = await countDeepSeekContext(JSON.parse(String(init?.body)));
        if (stopped || admission.bodyHash !== design.manifest.contextBudgets[active]!.bodyHash ||
          admission.counterHash !== design.manifest.contextBudgets[active]!.counterHash) throw new ModelConfigurationError("request or admission drift");
        writeFileSync(path.join(directory, `${active}-context-admission.json`), JSON.stringify(admission, null, 2), { flag: "wx" });
        const response = await transport.fetch(input, init), inference = probeInferenceEvidence(await response.clone().json(), "B");
        if (!inference.inferenceValid) throw new ModelConfigurationError(inference.inferenceError ?? "inference drift");
        return response;
      } });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest, phaseBudgetHash: budget.summary.phaseBudgetHash }, null, 2), { flag: "wx" });
    writeFileSync(path.join(directory, "context.json.gz"), gzipSync(JSON.stringify(design.request.context)), { flag: "wx" });
    transport.beginTrial(trialId, "probes"); status = "running"; report();
    for (const [index, request] of design.requests.entries()) {
      active = index;
      const started = performance.now(), arm: Arm = index === 0 ? "B" : "T";
      try {
        const result = await gateway.generateStructured(request);
        const score = scoreRepairTail(JSON.stringify({ slots: [{ slot: 0, result: result.value }] }), "transition", [design.initialContext]);
        rows.push({ arm, score, elapsedMs: performance.now() - started });
        writeFileSync(path.join(directory, `${arm}-result.json.gz`), gzipSync(JSON.stringify({ result, score, elapsedMs: performance.now() - started })), { flag: "wx" });
      } catch (error) {
        rows.push({ arm, failure: error instanceof Error ? error.message : String(error), elapsedMs: performance.now() - started });
        if (!(error instanceof ModelOutputError)) throw error;
      }
      if (stopped || dispatches !== index + 1 || budget.summary.blockingUnknown.length) throw new Error("interruption, dispatch or billing gate failed");
      report();
    }
    status = "paired-results-awaiting-review";
  } catch (error) { status = "stopped"; failure = error instanceof Error ? error.message : String(error); }
  finally { report(); design.registry.stopBackgroundRefresh(); process.off("SIGINT", stop); process.off("SIGTERM", stop); unlinkSync(lock); }
  console.log(JSON.stringify({ trialId, status, failure, dispatches, rows }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runTransitionPairProbe().catch(error => { console.error(error); process.exitCode = 1; });
