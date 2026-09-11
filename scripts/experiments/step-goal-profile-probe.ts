import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { goalDiagnosticBody, scoreGoalDiagnostic, type GoalDiagnosticSource } from "../../src/engine/benchmarks/step-efficiency/goal-profile-diagnostic";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { loadWorldScript } from "../../src/script/world-loader";
import { assertNonthinkingWorld } from "../../src/engine/benchmarks/step-efficiency/nonthinking-world";

const TRIAL = "probes-e2-goal-profile-01";
const INPUT_CEILING = 350_000;
const VARIANT = "variants/finite-work-goal-01";
const exclusions: Readonly<Record<string, string>> = {
  "autarch-elana": "各 commanders 单独会面",
  "chief-bjarni": "加固船体、加大盐鱼储备",
  "egil-longhair": "派两艘小船沿湾岸再次确认",
  "king-neptar": "Finish the funeral rites, then hold a closed council",
  "king-ragnar": "questioning the oldest survivors of the raid and tracing",
  "kinkaris": "Rewrite the tribute ledger",
  "player": "先到港区水手酒馆和仓库区打听",
  "sapphire-enchantress": "最近五轮月贝岛的采集与满月转化记录",
  "scytheback": "亲自沿失踪子代最后猎路的西北方向飞行侦察",
  "sir-autse-darkheart": "更新并加固 0918 外围哨位",
  "lord-varxis": "先护送最西矿井的夜班返村",
  "matthew-thanes": "亲自沿北路前往最后一处接应点",
  "mayor-holbein-redleaf": "明天一早我亲自带 constable",
};

export function goalProbeOrder() {
  return [{ source: 4, repetition: 0 }, ...[0, 1, 2, 3].map((source) => ({ source, repetition: 0 })), { source: 4, repetition: 1 }]
    .flatMap((block) => (["B", "P"] as const).map((arm) => ({ ...block, arm }))
      .sort((a, b) => contentHash({ seed: STEP_E2_PROTOCOL.seed, ...a }).localeCompare(contentHash({ seed: STEP_E2_PROTOCOL.seed, ...b }))));
}

export function prepareGoalProbe(variantPath = VARIANT) {
  const root = path.resolve(STEP_E2_PROTOCOL.root), variant = path.join(root, variantPath);
  const variantManifest = JSON.parse(readFileSync(path.join(variant, "manifest.json"), "utf8"));
  if (variantManifest.agents !== 48 || variantManifest.entities !== 232 || variantManifest.paidHttp !== 0) throw new Error("full-world preparation mismatch");
  const catalog = loadModelCatalog(path.join(variant, "model-catalog.json"));
  const world = loadWorldScript(path.join(variant, "worlds/blackmarsh/world"), { seed: STEP_E2_PROTOCOL.seed, modelCatalog: catalog });
  assertNonthinkingWorld(world, catalog);
  if (world.contentHash !== variantManifest.worldHash || contentHash(world.initialState) !== variantManifest.worldStateHash) throw new Error("candidate world artifact drift");
  const sources = Array.from({ length: 5 }, (_, index) => {
    const source = JSON.parse(gunzipSync(readFileSync(path.join(variant, `source-${index}.json.gz`))).toString()) as GoalDiagnosticSource;
    if (source.proof.index !== index || contentHash(source.proof) !== contentHash(variantManifest.proofs[index])) throw new Error("prepared source manifest mismatch");
    const b = source.arms.B.state, p = source.arms.P.state, normalized = structuredClone(p);
    const profileId = "work-until-objective";
    if (b.truth.mechanics.temporalProfiles[profileId] || p.worldHash !== world.contentHash ||
      contentHash(p.truth.mechanics.temporalProfiles[profileId]) !== contentHash(world.initialState.truth.mechanics.temporalProfiles[profileId]) ||
      contentHash(p.truth.mechanics.temporalCalibrations) !== contentHash(world.initialState.truth.mechanics.temporalCalibrations)) throw new Error("goal rule overlay mismatch");
    delete normalized.truth.mechanics.temporalProfiles[profileId];
    normalized.truth.mechanics.temporalCalibrations = structuredClone(b.truth.mechanics.temporalCalibrations);
    normalized.worldHash = b.worldHash;
    if (contentHash(normalized) !== contentHash(b)) throw new Error("goal rule overlay changed other source state");
    const labels = source.actions.flatMap((action) => {
      const quote = index === 4 ? "I say the single word 'ready' once, now." : exclusions[action.actorId];
      if (!quote) return [];
      if (!action.rawText.includes(quote)) throw new Error("independent action exclusion source drift");
      return [{ actionId: action.id, actionHash: contentHash(action), quote,
        requirement: index === 4 ? "one utterance must use an authored fixed profile of at most ten seconds" : "complete compound task cannot finish within ten seconds" }];
    });
    if ((index === 4 && labels.length !== 12) || (index < 4 && labels.length < 3)) throw new Error("missing source-bound diagnostic cases");
    const bodies = { B: goalDiagnosticBody(source, "B"), P: goalDiagnosticBody(source, "P") };
    for (const body of Object.values(bodies)) if (Buffer.byteLength(JSON.stringify(body), "utf8") + 8192 > INPUT_CEILING) {
      throw new Error("complete request exceeds conservative byte-based token reservation");
    }
    return { source, labels, bodies, hash: contentHash(source) };
  });
  const order = goalProbeOrder();
  const manifest = { trialId: TRIAL, variantHash: contentHash(variantManifest), catalogHash: catalog.hash,
    preparationSourceHash: contentHash(readFileSync(path.join(variant, "preparation-source.mts.txt"), "utf8")),
    preparationEvidenceHash: contentHash(JSON.parse(readFileSync(path.join(variant, "preparation-evidence.json"), "utf8"))),
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET), inputTokenCeiling: INPUT_CEILING,
    outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, maxHttp: order.length,
    maximumRunNanoCny: order.length * (INPUT_CEILING * 3520 + STEP_E2_PROTOCOL.outputTokenCeiling * 10560), order,
    sources: sources.map(({ source, labels, bodies, hash }) => ({ index: source.proof.index, sourceHash: hash, proof: source.proof, labels,
      bodyHashes: { B: contentHash(bodies.B), P: contentHash(bodies.P) } })),
    acceptance: "Twelve actual HTTP in six seed20260907 paired blocks: four original12-action batches once per arm, and a separate12-action single-utterance control twice per arm, control first and last. Both arms use the current600789b compiler prompt/T schema and thinking disabled. P adds only the authored goal profile/coverage/calibration to the complete source-world snapshot and runs unchanged production retrieval under the strict20percent root budget; candidate shortlist changes are recorded and are part of this world-candidate comparison, not a pure naming effect. P must pass all6 complete format/schema/scoped-reference/onset/materialization batches, every bound false-short-completion exclusion and all24 short-control actions, and improve bound exclusions over B; total input+output tokens<=1.10B and HTTP equal. Any P formal or bound behavior diagnostic failure stops. Record latency/cost/cache without inferring full-step gains from this sample. No repair, resampling, completion-time invention or omitted action. All48 real P actions still require independent source-bound review before candidate-world diagnostics; this cannot prove arbitrary semantics or gameplay acceptance.",
  };
  return { root, variant, catalog, sources, manifest, order };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-goal-profile-probe.ts [prepare]");
  const design = prepareGoalProbe();
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(design.manifest, null, 2));return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid experiment");
  const directory = path.join(design.root, "runs", TRIAL);
  if (existsSync(directory)) throw new Error("frozen goal trial cannot restart");
  const lock = path.join(design.root, "writer.lock");closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false;
  const stop = () => { stopped = true; }, rows: unknown[] = [], connectionEvents: unknown[] = [];
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest,
    status, failure, rows, connectionEvents, updatedAt: new Date().toISOString(), budget: budget?.summary }, null, 2));
  try {
    mkdirSync(directory, { recursive: true });
    budget = new ExperimentBudget(path.join(design.root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = budget.summary.phaseBudgets!.find((group) => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || used + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + design.manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("full trial budget or unresolved billing prevents dispatch");
    const account = design.catalog.account("deepseek-api"), credential = process.env[account.api_key_env];
    if (!credential) throw new Error("configured model credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: (event) => connectionEvents.push(event) })("deepseek-api", account)!;
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2), { flag: "wx" });
    const transport = new FirstPassExperimentTransport(budget, { root: design.root, baseUrl: account.base_url, fetch: send,
      inputTokenCeiling: INPUT_CEILING, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-goal-profile-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    transport.beginTrial(TRIAL, "probes");status = "running";report();
    for (const row of design.order) {
      if (stopped) throw new Error("operator stopped before next request");
      const item = design.sources[row.source]!, started = performance.now();
      const response = await transport.fetch(`${account.base_url}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(item.bodies[row.arm]), signal: AbortSignal.timeout(300_000) });
      const raw = await response.json(), usage = deepSeekExperimentUsage(raw), output = raw.choices?.[0]?.message?.content;
      const elapsedMs = performance.now() - started;
      const scored = await scoreGoalDiagnostic(typeof output === "string" ? output : "", item.source, row.arm, design.catalog);
      const violations = item.labels.flatMap((label) => {
        const plan = scored.plans.find((plan) => plan.actionId === label.actionId);
        if (!plan) return [{ ...label, reason: "no materialized plan" }];
        const brief = plan.mode === "fixed" && plan.completionAtSeconds !== null && plan.completionAtSeconds - plan.startsAtSeconds <= 10;
        return (row.source === 4 ? !brief : brief) ? [{ ...label, reason: row.source === 4 ? "short control was extended" : "unsupported complete short schedule" }] : [];
      });
      const result = { ...row, usage, elapsedMs, ...scored, checkedActions: item.labels.length, violations,
        diagnosticPassed: scored.formalPassed && violations.length === 0,
        peakNanoCny: (usage.input - usage.cacheHit) * 3520 + usage.cacheHit * 112 + usage.output * 10560 };
      rows.push(result);report();console.log(JSON.stringify({ ...result, plans: undefined, error: result.error?.slice(0, 350) }));
      if (row.arm === "P" && !result.diagnosticPassed) throw new Error("frozen goal diagnostic gate is unattainable; no next request");
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { report();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: TRIAL, status, failure, completed: rows.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
