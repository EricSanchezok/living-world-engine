import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runConditionalCompletionScenario } from "../../src/engine/benchmarks/step-efficiency/conditional-scenario";
import { transitionEvidenceRequest } from "../../src/engine/benchmarks/step-efficiency/transition-evidence-codec";
import { transitionAssertionPrompt } from "../../src/engine/benchmarks/step-efficiency/transition-assertion-prompt";
import { conditionalCompletionPrompt } from "../../src/engine/benchmarks/step-efficiency/conditional-completion-prompt";
import { evaluateCommittedBehaviorOracle } from "../../src/engine/benchmarks/step-efficiency/behavior-oracle";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { FairModelScheduler } from "../../src/engine/models/model-scheduler";
import type { StructuredModelRequest } from "../../src/engine/models/model-provider";
import { replaySimulationState } from "../../src/engine/runtime/transaction";

import { transitionEffectsFirst } from "../../src/engine/benchmarks/step-efficiency/transition-effects-first";

import { sharedSchemaRequest } from "../../src/engine/benchmarks/step-efficiency/shared-json-schema";

const INPUT_RESERVE = 250_000;
type TrialKind = "completion" | "stages" | "evidence" | "effects" | "schema";
function trialPrompts(request: StructuredModelRequest<unknown>, kind: TrialKind, arm: "B" | "P") {
  if (kind === "completion") return { system: request.system, userPrompt: arm === "P" ? conditionalCompletionPrompt(request.userPrompt) : request.userPrompt };
  const userPrompt = conditionalCompletionPrompt(request.userPrompt);
  return arm === "P" ? transitionAssertionPrompt(userPrompt, request.system) : { userPrompt, system: request.system };
}
function trialRequest<T>(request: StructuredModelRequest<T>, kind: TrialKind, arm: "B" | "P"): StructuredModelRequest<T> {
  const prompts = (kind === "evidence" || kind === "effects" || kind === "schema") ? transitionAssertionPrompt(conditionalCompletionPrompt(request.userPrompt), request.system) : trialPrompts(request, kind, arm);
  const prepared = { ...request, ...prompts };
  if (kind === "schema") return arm === "P" ? sharedSchemaRequest(prepared) : prepared;
  if (kind === "effects") {
    const baseline = transitionEvidenceRequest(prepared);
    return arm === "P" ? transitionEffectsFirst(baseline) : baseline;
  }
  return kind === "evidence" && arm === "P" ? transitionEvidenceRequest(prepared) : prepared;
}
function fingerprint(request: StructuredModelRequest<unknown>) {
  return contentHash({ system: request.system, userPrompt: request.userPrompt, context: request.context,
    schema: request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }) });
}

export async function conditionalCompletionDesign(kind: TrialKind = "completion") {
  const sources = [];
  for (const scenario of ["continuing", "arrived", "invalid"] as const) {
    const calls: Array<{ subject: string; fingerprint: string; treatmentRequestHash: string; baselineRequestHash: string }> = [];
    const control = await runConditionalCompletionScenario(scenario, async (request, fallback) => {
      calls.push({ subject: request.subjectId, fingerprint: fingerprint(request), treatmentRequestHash: fingerprint(trialRequest(request, kind, "P")), baselineRequestHash: fingerprint(trialRequest(request, kind, "B")) });
      return fallback();
    }, true);
    const verdict = evaluateCommittedBehaviorOracle({ source: control.source, action: control.action, checkpoint: control.result.state, oracle: control.oracle });
    if (verdict.verdict !== "passed" || calls.length !== (scenario === "continuing" ? 1 : 2)) throw new Error("controlled source failed offline admission");
    sources.push({ scenario, calls, sourceStateHash: contentHash(control.source), actionHash: contentHash(control.action),
      worldHash: control.source.worldHash, oracle: control.oracle, controlTruthHash: contentHash(control.result.state.truth) });
  }
  const order = sources.flatMap(({ scenario }) => Array.from({ length: 3 }, (_, repetition) =>
    (["B", "P"] as const).map((arm) => ({ scenario, repetition, arm })).sort((a, b) =>
      contentHash({ seed: STEP_E2_PROTOCOL.seed, ...a }).localeCompare(contentHash({ seed: STEP_E2_PROTOCOL.seed, ...b }))))).flat();
  const maxHttp = order.length * 2;
  return { trialId: kind === "schema" ? "probes-e2-conditional-schema-05" : kind === "effects" ? "probes-e2-conditional-effects-04" : kind === "evidence" ? "probes-e2-conditional-evidence-03" : kind === "stages" ? "probes-e2-conditional-stages-02" : "probes-e2-conditional-completion-01", kind, sources, order, maxHttp, inputTokenCeiling: INPUT_RESERVE,
    maximumRunNanoCny: maxHttp * (INPUT_RESERVE * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    acceptance: "P must commit and pass the independent state oracle and canonical replay on all 9 controlled roots, with no regression against B and no more than 110% of B total tokens. Zero paid repairs: each distinct local/global transition subject can send once, at most two HTTP per root. A failure does not resample that root. Results only admit the clarified conditional prompt to a separately frozen complete-world diagnostic; surrounding roles are scripted and this cannot certify gameplay or full semantics.",
    fixed: { model: STEP_E2_PROTOCOL.model, thinking: "disabled", profile: "truth-deepseek", outputTokens: STEP_E2_PROTOCOL.outputTokenCeiling,
      promptComparison: kind === "schema" ? "B=conditional completion and accurate assertion-stage clarification with original typed output (no evidence selectors); P=B with byte-identical repeated JSON Schema subtrees factored into standard draft-07 definitions references. All context, system/user instructions, schema language, actions, rules, generated values and validation remain unchanged. Exact schema expansion, including object order and literal data, is checked before every dispatch. No scope-changing id/anchor schemas permitted." : kind === "effects" ? "B=prior snapshot-bound evidence selector candidate; P=B with schema object properties ordered operations/mechanicInvocations/events/outcomes/decisionRequests and an explicit instruction that the model must propose justified writes while the engine validates and applies them. Original schema value language, state, actions, selectors, rules and output fields remain identical. No extra model planning or repair." : kind === "evidence" ? "B=conditional and assertion-stage clarification; P=B plus snapshot-bound typed input-fact selectors for operation/invocation assertions and explicit operation-effect witnesses for event/outcome assertions. Supported effect shorthand covers place_entity and retire_entity only; every ordinary typed assertion remains available. Raw choices are retained; selectors expand without adding effects, causes or statuses." : kind === "stages" ? "B=conditional clarification; P=B plus explicit operation/invocation/event/outcome assertion evaluation states in system and user prompts" : "B=original; P=conditional clarification",
      initialAgents: 2, initialEntities: 5, paidRole: "truth-transition", fixture: "test/fixtures/open-world-script", authoredTiming: true,
      scope: "Controlled boundary validation, not a reduced-batch full-game cost comparison", rootDeadlineMs: 600_000,
      dynamicInputs: "Initial contexts are hash-bound to the frozen scenario; subsequent global reconciliation inputs follow actual candidate effects through the real engine and are recorded separately." } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["prepare", "stages", "evidence", "effects", "schema"].includes(arg)) || new Set(args).size !== args.length) throw new Error("usage: step-conditional-completion-probe.ts [stages|evidence|effects|schema] [prepare]");
  if (args.filter((arg) => arg !== "prepare").length > 1) throw new Error("choose one frozen controlled design");
  const design = await conditionalCompletionDesign(args.includes("schema") ? "schema" : args.includes("effects") ? "effects" : args.includes("evidence") ? "evidence" : args.includes("stages") ? "stages" : "completion"), TRIAL = design.trialId;
  if (args.includes("prepare")) { console.log(JSON.stringify(design, null, 2));return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const root = path.resolve(STEP_E2_PROTOCOL.root), directory = path.join(root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("frozen trial cannot restart");
  const catalog = loadModelCatalog(path.join(STEP_E2_PROTOCOL.sourceRoot, "variants/shared-inventory-observation-v6/model-catalog.json"));
  const account = catalog.account("deepseek-api"), profile = catalog.profile("truth-deepseek");
  if (!process.env[account.api_key_env] || profile.inference.thinking !== "disabled") throw new Error("non-thinking account/profile unavailable");
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, "writer.lock");closeSync(openSync(lock, "wx"));
  const registry = new ModelRegistry(catalog, path.join(root, "conditional-registry"));
  let budget: ExperimentBudget | undefined, transport: FirstPassExperimentTransport | undefined;
  let status = "preparing", failure: string | undefined, stopped = false;
  const rows: unknown[] = [], connectionEvents: unknown[] = [];
  let active: unknown;
  const stop = () => { stopped = true; };
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design, status, failure, active,
    updatedAt: new Date().toISOString(), rows, connectionEvents, budget: budget?.summary }, null, 2));
  try {
    mkdirSync(directory, { recursive: true });
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = STEP_E2_BUDGET.phaseBudgets!.find((entry) => entry.phases.includes("probes"))!;
    const prior = phase.phases.reduce((sum, key) => sum + budget!.summary.phases[key].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || prior + design.maximumRunNanoCny > phase.maximumNanoCny ||
      budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + design.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("full trial reservation blocked");
    const snapshot = await registry.capture(), binding = resolveModelProfile(catalog, snapshot, "truth-deepseek");
    if (binding.accountId !== "deepseek-api" || binding.modelId !== STEP_E2_PROTOCOL.model) throw new Error("actual model binding drift");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design, catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2), { flag: "wx" });
    const send = createModelFetchResolver(process.env, { onConnectionEvent: (event) => connectionEvents.push(event) })("deepseek-api", account)!;
    transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: send, inputTokenCeiling: INPUT_RESERVE,
      outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, endpointPaths: ["/chat/completions"], trialPattern: new RegExp(`^${TRIAL}$`, "u"),
      requireThinkingDisabled: true, priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    transport.beginTrial(TRIAL, "probes");
    const gateway = createModelGateway(catalog, process.env, { maxTransportAttempts: 1,
      registry: { capture: async (hash) => hash ? registry.snapshot(hash) : snapshot, catalog,
        refresh: (options) => registry.refresh(options), status: () => registry.status() },
      scheduler: new FairModelScheduler({ globalConcurrency: 1, maxQueuedRequests: 10, queueTimeoutMs: 300_000, providerConcurrency: { "deepseek-api": 1 } }),
      fetchForAccount: (id) => async (input, init) => {
        if (id !== "deepseek-api" || stopped || typeof init?.body !== "string" || Buffer.byteLength(init.body) + 8192 > INPUT_RESERVE) throw new Error("controlled HTTP authorization or byte reservation failed");
        try { return await transport!.fetch(input, init); } finally { report(); }
      },
    });
    status = "running";report();
    for (const row of design.order) {
      if (stopped || transport.stopReason || budget.summary.blockingUnknown.length) throw new Error(transport.stopReason ?? "controlled trial stopped");
      const source = design.sources.find((entry) => entry.scenario === row.scenario)!;
      const start = performance.now(), before = budget.summary, seen = new Set<string>();
      const calls: unknown[] = [];active = { ...row, calls };report();
      let result: unknown;
      try {
        const world = await runConditionalCompletionScenario(row.scenario, async (request) => {
          if (performance.now() - start > design.fixed.rootDeadlineMs || seen.has(request.subjectId) || seen.size >= 2) {
            const evidenceFile = `${row.scenario}-${row.repetition}-${row.arm}-blocked-request.json`;
            writeFileSync(path.join(directory, evidenceFile), JSON.stringify({ ...request, schema: z.toJSONSchema(request.schema, { target: "draft-07" }) }), { flag: "wx" });
            calls.push({ subject: request.subjectId, inputFingerprint: fingerprint(request), blocked: true, evidenceFile });report();
            throw new Error("paid repair or extra transition subject is not admitted");
          }
          if (!seen.size && fingerprint(request) !== source.calls[0]!.fingerprint) throw new Error("initial source context changed");
          seen.add(request.subjectId);
          const dispatched = trialRequest(request, design.kind, row.arm);
          const generated = await gateway.generateStructured({ ...dispatched, profileId: "truth-deepseek", modelRegistrySnapshotHash: snapshot.hash,
            promptVersion: `${dispatched.promptVersion}/E2-${design.kind}-${row.arm}@${fingerprint(dispatched).slice(0, 16)}` });
          calls.push({ subject: request.subjectId, inputFingerprint: fingerprint(request), wireInputFingerprint: fingerprint(dispatched), audit: generated.audit });report();
          return generated;
        }, true);
        if (contentHash(world.source) !== source.sourceStateHash || contentHash(world.action) !== source.actionHash || contentHash(world.oracle) !== contentHash(source.oracle)) throw new Error("controlled world binding changed");
        const verdict = evaluateCommittedBehaviorOracle({ source: world.source, action: world.action, checkpoint: world.result.state, oracle: source.oracle });
        const truthHash = contentHash(world.result.state.truth), replayHash = contentHash(replaySimulationState(world.result.state).truth);
        result = { committed: true, passed: verdict.verdict === "passed" && truthHash === replayHash, verdict, truthHash, replayHash };
        writeFileSync(path.join(directory, `${row.scenario}-${row.repetition}-${row.arm}-state.json`), JSON.stringify(world.result.state), { flag: "wx" });
      } catch (error) { result = { committed: false, passed: false, error: error instanceof Error ? error.message : String(error) }; }
      const completed = { ...row, result, calls, elapsedMs: performance.now() - start,
        http: budget.summary.phases.probes.httpRequests - before.phases.probes.httpRequests,
        knownNanoCny: budget.summary.estimatedPeakNanoCny - before.estimatedPeakNanoCny };
      rows.push(completed);active = undefined;report();console.log(JSON.stringify({ ...completed, calls: calls.length }));
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error);process.exitCode = 1; }
  finally { report();registry.stopBackgroundRefresh();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
