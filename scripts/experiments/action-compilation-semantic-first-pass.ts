import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog, parseModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelOutputError } from "../../src/engine/models/model-provider";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { immutableExperimentJson as immutableJson, immutableExperimentText, lockExperiment } from "../../src/engine/benchmarks/action-compilation/experiment-artifacts";
import { readConstrainedFirstPassSources } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-sources";
import { AC_FP3_BUDGET, AC_FP3_PROTOCOL } from "../../src/engine/benchmarks/action-compilation/semantic-first-pass-protocol";
import { parseLosslessExperimentJson } from "../../src/engine/benchmarks/action-compilation/lossless-json";
import { assertCalibrationProofs, buildFp3Calibration, FP3_REVIEW_PROMPT, fp3ReviewResponseSchema,
  scoreFp3Calibration, validateFp3Review, visibleReviewPacket, type SemanticReviewPacket, type ValidatedReview } from "../../src/engine/benchmarks/action-compilation/semantic-first-pass-review";

const defaultRoot = path.resolve(AC_FP3_PROTOCOL.root);
const read = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error("git command failed");
  return result.stdout.trim();
}
function implementationHash(): string {
  const files = git(["ls-files", "src/engine/benchmarks/action-compilation/semantic-first-pass-*",
    "src/engine/benchmarks/action-compilation/experiment-*", "src/engine/benchmarks/action-compilation/lossless-json.ts", "src/engine/models", "src/engine/prompts",
    "scripts/experiments/action-compilation-semantic-first-pass.ts", "config/models.yaml", "package-lock.json"])
    .split("\n").filter(Boolean).sort();
  return contentHash(files.map((file) => ({ file, hash: contentHash(readFileSync(file, "utf8")) })));
}
function reviewCatalog() {
  const original = loadModelCatalog();
  const base = original.profile("truth-deepseek");
  if (base.account_id !== "deepseek-api" || base.selector.kind !== "exact" ||
    base.selector.model_id !== "deepseek-v4-flash" || base.inference.thinking !== "disabled" || base.max_output_tokens !== 131072) {
    throw new Error("compiler binding differs from approved AC-FP3 baseline");
  }
  return parseModelCatalog({ schema_version: original.schemaVersion, scheduler: original.scheduler, registry: original.registry,
    model_overrides: original.modelOverrides, accounts: original.accounts,
    profiles: { ...original.profiles, ...Object.fromEntries(AC_FP3_PROTOCOL.reviewers.map((reviewer) => [reviewer.profileId, {
      ...base, selector: { kind: "exact", model_id: reviewer.modelId }, description: "AC-FP3 offline semantic review",
      max_output_tokens: AC_FP3_PROTOCOL.review.maxOutputTokens,
    }])) } });
}

export function prepareSemanticFirstPass(root: string) {
  if (git(["status", "--porcelain"])) throw new Error("commit checked preparation before freezing");
  if (git(["branch", "--show-current"]) !== "synergy/ac-fp1-experiment") throw new Error("AC-FP3 requires the authorized current branch");
  const historical = readConstrainedFirstPassSources(path.resolve(".livingworld-benchmarks/experiments/ac-fp1/v1"));
  const catalog = reviewCatalog();
  const registry = new ModelRegistry(catalog, path.resolve(".livingworld-v23"), { fetch: async () => { throw new Error("no metadata refresh in experiment"); } });
  const registryHash = historical.sources[0]!.registrySnapshotHash;
  const snapshot = registry.snapshot(registryHash);
  const bindings = AC_FP3_PROTOCOL.reviewers.map((reviewer) => {
    const binding = resolveModelProfile(catalog, snapshot, reviewer.profileId);
    if (!process.env[binding.account.api_key_env]?.trim()) throw new Error("DeepSeek credential is not configured");
    if (binding.account.base_url !== "https://api.deepseek.com" || binding.account.protocol !== "openai-chat" ||
      binding.modelId !== reviewer.modelId || !binding.model.limit.context) throw new Error("reviewer account/model/context unavailable");
    return { id: reviewer.id, modelId: binding.modelId, metadataHash: binding.modelMetadataHash, inputCeiling: binding.model.limit.context };
  });
  const calibration = buildFp3Calibration();
  assertCalibrationProofs(calibration);
  const ordered = [...calibration.cases].sort((left, right) => contentHash({ seed: AC_FP3_PROTOCOL.seed, id: left.entry.id })
    .localeCompare(contentHash({ seed: AC_FP3_PROTOCOL.seed, id: right.entry.id })));
  const packets: SemanticReviewPacket[] = [];
  for (let offset = 0; offset < ordered.length; offset += AC_FP3_PROTOCOL.review.maxPacketEntries) {
    const packet = { state: calibration.state, rules: calibration.rules, entries: ordered.slice(offset, offset + AC_FP3_PROTOCOL.review.maxPacketEntries).map((item) => item.entry) };
    visibleReviewPacket(packet);
    packets.push(packet);
  }
  const manifest = { protocol: AC_FP3_PROTOCOL, budget: AC_FP3_BUDGET, reviewPrompt: FP3_REVIEW_PROMPT,
    calibrationHash: contentHash(calibration), packetsHash: contentHash(packets), catalogHash: catalog.hash, registryHash, bindings,
    sourceManifestHash: contentHash(historical.manifest), sourceHashes: historical.sources.map((source) => contentHash(source)),
    commit: git(["rev-parse", "HEAD"]), implementationHash: implementationHash(),
    calibrationScope: calibration.provenance, mainExperimentReady: false };
  immutableJson(path.join(root, "prepared", "calibration.json"), calibration);
  immutableJson(path.join(root, "prepared", "packets.json"), packets);
  immutableJson(path.join(root, "prepared", "manifest.json"), { manifest, hash: contentHash(manifest) });
  return { hash: contentHash(manifest), cases: calibration.cases.length, packets: packets.length, bindings, actualModelHttp: 0 };
}

interface Preparation {
  protocol: typeof AC_FP3_PROTOCOL; budget: typeof AC_FP3_BUDGET; reviewPrompt: typeof FP3_REVIEW_PROMPT;
  calibrationHash: string; packetsHash: string; catalogHash: string; registryHash: string;
  bindings: Array<{ id: string; modelId: string; metadataHash: string; inputCeiling: number }>;
  sourceManifestHash: string; sourceHashes: string[]; commit: string; implementationHash: string;
  calibrationScope: string; mainExperimentReady: boolean;
}
function environment(root: string) {
  const frame = read(path.join(root, "prepared", "manifest.json")) as { manifest: Preparation; hash: string };
  if (contentHash(frame.manifest) !== frame.hash || contentHash(frame.manifest.protocol) !== contentHash(AC_FP3_PROTOCOL) ||
    contentHash(frame.manifest.budget) !== contentHash(AC_FP3_BUDGET) || contentHash(frame.manifest.reviewPrompt) !== contentHash(FP3_REVIEW_PROMPT) ||
    frame.manifest.implementationHash !== implementationHash()) throw new Error("frozen preparation/protocol/code drift");
  const catalog = reviewCatalog();
  if (catalog.hash !== frame.manifest.catalogHash) throw new Error("model catalog drift");
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), AC_FP3_BUDGET);
  if (budget.summary.unsettled.length) throw new Error("unknown provider usage blocks further sends");
  return { frame, catalog, budget };
}

async function requestReviewModel(root: string, env: ReturnType<typeof environment>,
  reviewer: typeof AC_FP3_PROTOCOL.reviewers[number], phase: "probes" | "calibration",
  id: string, context: unknown, probe: boolean) {
  const file = path.join(root, phase, id, "result.json");
  const requestHash = contentHash({ reviewer, context, probe, frozenHash: env.frame.hash });
  if (existsSync(file)) {
    const previous = read(file) as { requestHash: string; result: unknown; resultHash: string; error: unknown };
    if (previous.requestHash !== requestHash || previous.resultHash !== contentHash(previous.result)) throw new Error("saved review evidence drift");
    return previous;
  }
  const started = path.join(root, phase, id, "started.json");
  if (existsSync(started)) throw new Error("interrupted review must not be redrawn: " + id);
  const binding = env.frame.manifest.bindings.find((row) => row.id === reviewer.id)!;
  const account = env.catalog.account("deepseek-api");
  const transport = new FirstPassExperimentTransport(env.budget, { root, baseUrl: account.base_url,
    inputTokenCeiling: binding.inputCeiling, outputTokenCeiling: AC_FP3_PROTOCOL.review.maxOutputTokens,
    trialPattern: /^(?:probes|calibration)-[a-z0-9-]+$/u, priceBinding: { accountId: "deepseek-api", modelId: reviewer.modelId, priceId: reviewer.id },
    fetch: createModelFetchResolver(process.env)("deepseek-api", account) ?? fetch });
  transport.beginTrial(id, phase);
  const registry = new ModelRegistry(env.catalog, path.resolve(".livingworld-v23"), { fetch: async () => { throw new Error("no metadata refresh"); } });
  const gateway = createModelGateway(env.catalog, process.env, { registry,
    fetchForAccount: (accountId) => accountId === "deepseek-api" ? transport.fetch : async () => { throw new Error("unapproved model account"); } });
  immutableJson(started, { requestHash, frozenHash: env.frame.hash, startedAt: new Date().toISOString() });
  let result: unknown = null, error: { name: string; message: string } | null = null;
  try {
    result = await gateway.generateStructured<unknown>({ profileId: reviewer.profileId, workloadId: "ac-fp3-review", batchId: id, subjectId: id,
      role: "action-compilation", modelRegistrySnapshotHash: env.frame.manifest.registryHash,
      runtimeIdentity: { worldHash: "sha256:" + contentHash(context), revision: 0 }, correlation: { executionId: "ac-fp3:" + id },
      system: probe ? "Return only the requested JSON object." : FP3_REVIEW_PROMPT.system,
      userPrompt: probe ? "Return {\"ok\":true} to confirm the model's structured interface is available." : FP3_REVIEW_PROMPT.userPrompt,
      promptVersion: "ac-fp3-review@" + contentHash(FP3_REVIEW_PROMPT), context,
      schema: probe ? z.strictObject({ ok: z.literal(true) }) : fp3ReviewResponseSchema,
      schemaName: probe ? "ac_fp3_availability" : "ac_fp3_semantic_review", structuredOutputMode: "json-object-zod" });
    const responseFile = path.join(root, "http", id + "-http-001", "response.json");
    const captured = read(responseFile) as { raw: string; rawHash: string };
    if (contentHash(captured.raw) !== captured.rawHash) throw new Error("raw response integrity failure");
    const wire = JSON.parse(captured.raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = wire.choices?.[0]?.message?.content;
    if (typeof text !== "string") throw new Error("missing raw reviewer text");
    const parsed = parseLosslessExperimentJson(text);
    const accepted = result as { value: unknown };
    if (contentHash(parsed.value) !== contentHash(accepted.value)) throw new Error("reviewer output required a content-changing recovery");
    result = { ...accepted, losslessRecovery: parsed.recovery };
  } catch (caught) {
    error = caught instanceof Error ? { name: caught.name, message: caught.message } : { name: "Error", message: String(caught) };
    if (caught instanceof ModelOutputError) result = { invalidModelOutput: true, rawValue: caught.rawValue ?? null, audit: caught.audit ?? null };
  }
  const saved = { requestHash, result, resultHash: contentHash(result), error };
  immutableJson(file, saved);
  if (transport.stopReason || env.budget.summary.unsettled.length) throw new Error("transport stopped with preserved evidence: " + (transport.stopReason ?? "unknown usage"));
  return saved;
}

export async function preflightSemanticFirstPass(root: string) {
  const env = environment(root);
  const rows = [];
  for (const reviewer of AC_FP3_PROTOCOL.reviewers) {
    const result = await requestReviewModel(root, env, reviewer, "probes", "probes-availability-" + reviewer.id, { purpose: "AC-FP3 reviewer availability" }, true);
    const value = result.result as { value?: { ok?: unknown } } | null;
    rows.push({ reviewer: reviewer.id, passed: !result.error && value?.value?.ok === true, error: result.error });
  }
  const outcome = { frozenHash: env.frame.hash, passed: rows.every((row) => row.passed), rows };
  immutableJson(path.join(root, "availability.json"), outcome);
  return outcome;
}

export async function calibrateSemanticFirstPass(root: string) {
  const env = environment(root);
  const availability = read(path.join(root, "availability.json")) as { frozenHash: string; passed: boolean };
  if (availability.frozenHash !== env.frame.hash || !availability.passed) throw new Error("reviewer availability gate failed");
  const calibration = read(path.join(root, "prepared", "calibration.json")) as ReturnType<typeof buildFp3Calibration>;
  const packets = read(path.join(root, "prepared", "packets.json")) as SemanticReviewPacket[];
  if (contentHash(calibration) !== env.frame.manifest.calibrationHash || contentHash(packets) !== env.frame.manifest.packetsHash) throw new Error("calibration holdout drift");
  const reviews: Record<string, ValidatedReview[]> = { flash: [], pro: [] };
  for (const [index, packet] of packets.entries()) for (const reviewer of AC_FP3_PROTOCOL.reviewers) {
    const ordered = { ...packet, entries: reviewer.id === "pro" ? [...packet.entries].reverse() : packet.entries };
    const id = "calibration-" + String(index).padStart(3, "0") + "-" + reviewer.id;
    const response = await requestReviewModel(root, env, reviewer, "calibration", id, visibleReviewPacket(ordered), false);
    const result = response.result as { value?: unknown } | null;
    reviews[reviewer.id]!.push(...validateFp3Review(response.error ? null : result?.value, ordered));
    process.stdout.write(id + " recorded; known peak CNY " + (env.budget.summary.estimatedPeakNanoCny / 1e9).toFixed(4) + "\n");
  }
  const scores = Object.fromEntries(AC_FP3_PROTOCOL.reviewers.map((reviewer) => [reviewer.id, scoreFp3Calibration(calibration, reviews[reviewer.id]!)]));
  const outcome = { frozenHash: env.frame.hash, passed: Object.values(scores).every((score) => score.calibrated), scores,
    claimBoundary: AC_FP3_PROTOCOL.review.limitation + " Controlled projection calibration is not full compiler-output semantic accuracy." };
  immutableJson(path.join(root, "calibration-summary.json"), outcome);
  return outcome;
}

export function reportSemanticFirstPass(root: string) {
  let budget: ExperimentBudget["summary"] | null = null, budgetError: string | null = null;
  try { budget = new ExperimentBudget(path.join(root, "budget.jsonl"), AC_FP3_BUDGET).summary; }
  catch (error) { budgetError = error instanceof Error ? error.message : String(error); }
  const calibration = existsSync(path.join(root, "calibration-summary.json"))
    ? read(path.join(root, "calibration-summary.json")) as Awaited<ReturnType<typeof calibrateSemanticFirstPass>> : null;
  const availability = existsSync(path.join(root, "availability.json"))
    ? read(path.join(root, "availability.json")) as Awaited<ReturnType<typeof preflightSemanticFirstPass>> : null;
  const completedPackets = existsSync(path.join(root, "calibration")) ? readdirSync(path.join(root, "calibration"))
    .filter((id) => existsSync(path.join(root, "calibration", id, "result.json"))).length : 0;
  const stops = existsSync(path.join(root, "stops")) ? readdirSync(path.join(root, "stops")).filter((file) => file.endsWith(".json"))
    .map((file) => read(path.join(root, "stops", file))) : [];
  const status = budgetError ? "stopped-budget-integrity" : budget!.unsettled.length ? "stopped-unknown-usage" : availability && !availability.passed ? "stopped-model-unavailable" :
    calibration ? calibration.passed ? "calibrated-main-not-ready" : "stopped-calibration-failed" :
      stops.length ? "stopped-preparation-or-integrity" : completedPackets ? "calibration-incomplete" : "preparation";
  const report = { protocolHash: contentHash(AC_FP3_PROTOCOL), status, completedPackets, plannedPackets: 42,
    mainExperimentStarted: false, mainExperimentComplete: false, compilationImprovementEstablished: false,
    availability, calibration, budget, budgetError, stops, limitation: AC_FP3_PROTOCOL.review.limitation };
  const directory = path.join(root, "reports", contentHash(report));
  immutableJson(path.join(directory, "report.json"), report);
  immutableExperimentText(path.join(directory, "report.md"),
    "# AC-FP3 " + status + "\n\n" + AC_FP3_PROTOCOL.review.limitation +
    "\n\nCalibration requests recorded: " + completedPackets + "/42. Main experiment has not started; no compilation improvement is established." +
    "\n\nKnown conservative CNY: " + (budget ? (budget.estimatedPeakNanoCny / 1e9).toFixed(6) : "unavailable") +
    "; unknown reserved CNY: " + (budget ? (budget.reservedNanoCny / 1e9).toFixed(6) : "unavailable") +
    (budgetError ? "\n\nBudget integrity error: " + budgetError : "") +
    "\n\n" + JSON.stringify(calibration ? Object.fromEntries(Object.entries(calibration.scores).map(([id, score]) => [id, { ...score, rows: undefined }])) : availability, null, 2) + "\n");
  return { directory, report };
}

async function main() {
  const command = process.argv[2], rootAt = process.argv.indexOf("--root");
  const root = rootAt >= 0 ? path.resolve(process.argv[rootAt + 1]!) : defaultRoot;
  if (!["prepare", "preflight", "calibrate", "report"].includes(command ?? "")) throw new Error("usage: experiment:action-compilation:v3 <prepare|preflight|calibrate|report> [--root directory]");
  const unlock = lockExperiment(root);
  try {
    if (command === "prepare") process.stdout.write(JSON.stringify(prepareSemanticFirstPass(root), null, 2) + "\n");
    else if (command === "preflight") process.stdout.write(JSON.stringify(await preflightSemanticFirstPass(root), null, 2) + "\n");
    else if (command === "calibrate") { const result = await calibrateSemanticFirstPass(root); process.stdout.write(JSON.stringify({ passed: result.passed }) + "\n"); }
  } catch (error) {
    const failure = { command, at: new Date().toISOString(), name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error) };
    immutableJson(path.join(root, "stops", contentHash(failure) + ".json"), failure);
    process.exitCode = 1;
    process.stderr.write(failure.message + "\n");
  } finally {
    try { const result = reportSemanticFirstPass(root); process.stdout.write(JSON.stringify({ status: result.report.status, report: result.directory }) + "\n"); }
    finally { unlock(); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(String(error) + "\n"); process.exitCode = 1; });
}
