import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import type { SimulationState } from "../../src/engine/contracts/model";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog, parseModelCatalog, type ModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, ModelOutputError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { structuredPromptBytes } from "../../src/engine/prompts";
import { registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { WorldExecutionAlgorithmRegistry } from "../../src/engine/runtime/execution";
import { deterministicActionCompilationBatch, ScriptedModelProvider } from "../../src/engine/testing/model-provider";
import { constrainedActionCompiler } from "../../src/engine/algorithms/eager-reference/constrained-action-compiler";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { AC_FP2_ARMS, AC_FP2_BUDGET, AC_FP2_PROTOCOL, constrainedArmOptions, constrainedFirstPassAlgorithmRef, constrainedFirstPassSchedule, type ConstrainedFirstPassCandidate, type ConstrainedFirstPassTrial } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-protocol";
import { readConstrainedFirstPassSources, readConstrainedHistoricalReviews } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-sources";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { reconcileNotSentTrial, verifiedNotSentHttp } from "../../src/engine/benchmarks/action-compilation/experiment-reconciliation";
import { immutableExperimentJson as immutableJson, immutableExperimentText, lockExperiment } from "../../src/engine/benchmarks/action-compilation/experiment-artifacts";
import { executeCompilationTrial, type FirstPassTrialEvidence } from "../../src/engine/benchmarks/action-compilation/first-pass-runner";
import { firstPassReviewEntries, scoreFirstPassTrial, summarizeFirstPass, type FirstPassHttpEvidence } from "../../src/engine/benchmarks/action-compilation/first-pass-scoring";
import { confirmConstrainedWinner, selectConstrainedWinner, type ConstrainedTrialScore } from "../../src/engine/benchmarks/action-compilation/constrained-first-pass-scoring";
import { buildSemanticCalibration, mergeBlindReviews, REVIEW_PROTOCOL, semanticReviewSchema, unresolvedSemanticReview, validateSemanticReview } from "../../src/engine/benchmarks/action-compilation/constrained-semantic-review";
import { auditSemanticObservability, type BlindCompilationReview } from "../../src/engine/benchmarks/action-compilation/semantic-observability-audit";

const historicalRoot = path.resolve(".livingworld-benchmarks/experiments/ac-fp1/v1");
const defaultRoot = path.resolve(".livingworld-benchmarks/experiments/ac-fp2/v7");
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));
function git(args: string[]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}
function codeFingerprint() {
  const files = git(["ls-files", "src/engine", "src/script", "src/server/action-compilation-retrieval-runtime.ts", "scripts/experiments",
    "config/models.yaml", "package.json", "package-lock.json", "docs/specs/0024-action-compilation-constrained-first-pass-experiment.md"])
    .split("\n").filter(Boolean).sort();
  return contentHash(files.map((file) => ({ file, hash: contentHash(readFileSync(file, "utf8")) })));
}

// This narrowly scoped operational repair cannot authorize changes to treatments,
// prompts, models, source inputs, selection gates or semantic evaluation.
const operationalPaths = new Set([
  "scripts/experiments/action-compilation-constrained-first-pass.ts",
  "src/engine/benchmarks/action-compilation/experiment-transport.ts",
  "src/engine/benchmarks/action-compilation/experiment-transport.test.ts",
  "src/engine/benchmarks/action-compilation/experiment-reconciliation.ts",
  "src/engine/benchmarks/action-compilation/experiment-reconciliation.test.ts",
]);
function assertOperationalLineage(root: string, frozen: { hash: string; manifest: { codeHash: string; commit: string } }) {
  const current = codeFingerprint();
  if (current === frozen.manifest.codeHash) return current;
  const receipt = read(path.join(root, "operational-continuations", `${current}.json`));
  const changed = git(["diff", "--name-only", frozen.manifest.commit, receipt.commit]).split("\n").filter(Boolean).sort();
  if (receipt.frozenHash !== frozen.hash || receipt.previousCodeHash !== frozen.manifest.codeHash || receipt.codeHash !== current ||
    contentHash(changed) !== receipt.changedPathsHash || !changed.length || changed.some((file) => !operationalPaths.has(file))) {
    throw new Error("unapproved operational continuation or treatment drift");
  }
  return current;
}

function registerOperationalContinuation(root: string) {
  if (git(["status", "--porcelain"])) throw new Error("commit checked operational work before registering continuation");
  const frozen = read(path.join(root, "frozen.json"));
  if (frozen.hash !== contentHash(frozen.manifest)) throw new Error("frozen manifest drift");
  const changed = git(["diff", "--name-only", frozen.manifest.commit, "HEAD"]).split("\n").filter(Boolean).sort();
  if (!changed.length || changed.some((file) => !operationalPaths.has(file))) throw new Error("continuation includes non-operational changes");
  const receipt = { frozenHash: frozen.hash, previousCodeHash: frozen.manifest.codeHash, codeHash: codeFingerprint(),
    commit: git(["rev-parse", "HEAD"]), changedPaths: changed, changedPathsHash: contentHash(changed),
    authorization: "user-authorized autonomous operational adjustment; no model-visible or experiment gate change",
    reason: "Proven TCP preconnect reconciliation, unique attempt IDs and read-only provenance-aware scoring" };
  immutableJson(path.join(root, "operational-continuations", `${receipt.codeHash}.json`), receipt);
  assertOperationalLineage(root, frozen);
  return receipt;
}

/** Preserve unknown preflight usage at its full reserved upper bound, never as zero usage. */
export function constrainedBudgetPolicy(preparationDirectory = path.resolve(".livingworld-benchmarks/experiments/ac-fp2")) {
  const priorRoot = path.join(preparationDirectory, "v4");
  const journal = path.join(priorRoot, "budget.jsonl");
  const previous = new ExperimentBudget(journal, AC_FP2_BUDGET).summary;
  const carryUpperBoundNanoCny = previous.estimatedPeakNanoCny + previous.reservedNanoCny;
  const previousPolicy = { ...AC_FP2_BUDGET, maximumNanoCny: AC_FP2_BUDGET.maximumNanoCny - carryUpperBoundNanoCny,
    priorPreparation: { root: priorRoot, journalHash: existsSync(journal) ? contentHash(readFileSync(journal, "utf8")) : null,
      knownEstimatedNanoCny: previous.estimatedPeakNanoCny, unresolvedReservedNanoCny: previous.reservedNanoCny,
      carryUpperBoundNanoCny, unresolved: previous.unsettled } };
  const nextRoot = path.join(preparationDirectory, "v5"), nextJournal = path.join(nextRoot, "budget.jsonl");
  const next = new ExperimentBudget(nextJournal, previousPolicy).summary;
  const nextUpperBound = next.estimatedPeakNanoCny + next.reservedNanoCny;
  const nextPolicy = { ...AC_FP2_BUDGET, maximumNanoCny: previousPolicy.maximumNanoCny - nextUpperBound,
    priorPreparation: { sources: [previousPolicy.priorPreparation, { root: nextRoot,
      journalHash: existsSync(nextJournal) ? contentHash(readFileSync(nextJournal, "utf8")) : null,
      knownEstimatedNanoCny: next.estimatedPeakNanoCny, unresolvedReservedNanoCny: next.reservedNanoCny,
      carryUpperBoundNanoCny: nextUpperBound, unresolved: next.unsettled }],
      carryUpperBoundNanoCny: carryUpperBoundNanoCny + nextUpperBound } };
  const lastRoot = path.join(preparationDirectory, "v6"), lastJournal = path.join(lastRoot, "budget.jsonl");
  const last = new ExperimentBudget(lastJournal, nextPolicy).summary;
  const lastUpperBound = last.estimatedPeakNanoCny + last.reservedNanoCny;
  return { ...AC_FP2_BUDGET, maximumNanoCny: nextPolicy.maximumNanoCny - lastUpperBound,
    priorPreparation: { sources: [...nextPolicy.priorPreparation.sources, { root: lastRoot,
      journalHash: existsSync(lastJournal) ? contentHash(readFileSync(lastJournal, "utf8")) : null,
      knownEstimatedNanoCny: last.estimatedPeakNanoCny, unresolvedReservedNanoCny: last.reservedNanoCny,
      carryUpperBoundNanoCny: lastUpperBound, unresolved: last.unsettled }],
      carryUpperBoundNanoCny: nextPolicy.priorPreparation.carryUpperBoundNanoCny + lastUpperBound } };
}

export function constrainedCatalog(original: ModelCatalog, mode: "chat" | "responses" | "review") {
  if (mode === "chat") return original;
  const accountId = original.profile("truth-deepseek").account_id;
  return parseModelCatalog({ schema_version: original.schemaVersion, scheduler: original.scheduler, registry: original.registry,
    model_overrides: original.modelOverrides,
    profiles: mode === "review" ? { ...original.profiles, [REVIEW_PROTOCOL.profile]: { ...original.profile("truth-deepseek"),
      description: "Offline blinded compilation review; never runtime repair", max_output_tokens: REVIEW_PROTOCOL.maximumOutputTokens,
      max_input_bytes: 3_000_000 } } : original.profiles,
    accounts: { ...original.accounts, [accountId]: { ...original.account(accountId), protocol: "openai-responses" } } });
}

/** Offline calls retain canonical world identity without participating in a game execution. */
export function constrainedOfflineScope(state: Pick<SimulationState, "worldHash" | "revision">, id: string) {
  return { workloadId: "ac-fp2-offline", batchId: id, subjectId: id,
    runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
    correlation: { executionId: `ac-fp2:${id}`, revision: state.revision } };
}

/** Each derived catalog owns its registry service, while reading the same pinned snapshot files. */
export function createConstrainedGateways(catalog: ModelCatalog, env: Readonly<Record<string, string | undefined>>, registryRoot: string, experimentFetch: typeof fetch) {
  const accountId = catalog.profile("truth-deepseek").account_id;
  return Object.fromEntries((["chat", "responses", "review"] as const).map((mode) => {
    const variant = constrainedCatalog(catalog, mode);
    const registry = new ModelRegistry(variant, registryRoot, { fetch: async () => { throw new Error("experiment cannot refresh model metadata"); } });
    return [mode, createModelGateway(variant, env, { registry,
      fetchForAccount: (id) => id === accountId ? experimentFetch : async () => { throw new Error("unapproved experiment account"); } })];
  }));
}

export async function prepareConstrained(root: string) {
  if (git(["status", "--porcelain"])) throw new Error("commit checked work units before freezing AC-FP2");
  const initialCodeHash = codeFingerprint();
  const frozen = readConstrainedFirstPassSources(historicalRoot);
  const history = readConstrainedHistoricalReviews(historicalRoot, frozen);
  const catalog = loadModelCatalog();
  const registry = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
  const resources = createActionCompilationRetrievalRuntimeProvider();
  const rows: unknown[] = [];
  for (const [sourceIndex, source] of frozen.sources.entries()) {
    if (source.modelCatalogHash !== catalog.hash) throw new Error("captured catalog drift");
    const sourceId = AC_FP2_PROTOCOL.sources[sourceIndex]!.id;
    const retrieval = resources.runtime(source.captureAlgorithmRef);
    if (!retrieval) throw new Error("captured R5 resources missing");
    for (const arm of AC_FP2_ARMS) {
      const ref = constrainedFirstPassAlgorithmRef(source.captureAlgorithmRef, arm);
      registry.validateExperimentComposition(ref);
      let artifact: unknown;
      const provider: StructuredModelProvider = { catalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => undefined,
        generateStructured: async (request) => {
          const bytes = structuredPromptBytes(request);
          if (bytes.requestUtf8Bytes > catalog.profile(source.profileId).max_input_bytes) throw new Error("treatment exceeds original physical request byte ceiling");
          artifact = { algorithmRef: ref, promptVersion: request.promptVersion, schemaName: request.schemaName, system: request.system,
            userPrompt: request.userPrompt, context: request.context, schema: request.wireJsonSchema ?? z.toJSONSchema(request.schema, { target: "draft-07" }),
            structuredOutputMode: request.structuredOutputMode, requestUtf8Bytes: bytes.requestUtf8Bytes };
          throw new ModelConfigurationError("AC-FP2 offline provider boundary");
        } };
      const trial: ConstrainedFirstPassTrial = { id: `discovery-${sourceId}-00-${arm}`, phase: "discovery", sourceId, sourceIndex, repetition: 0, arm };
      const evidence = await executeCompilationTrial({ trial, source, provider, retrieval, compiler: constrainedActionCompiler(constrainedArmOptions(arm)),
        algorithmRef: ref, executionPrefix: "ac-fp2", expectedCatalogHash: catalog.hash, expectedOutputMode: constrainedArmOptions(arm).structuredOutputMode });
      if (evidence.error?.message !== "AC-FP2 offline provider boundary" || evidence.calls.length !== 1 || !artifact) throw new Error(`${sourceId}/${arm}: preflight failed: ${JSON.stringify(evidence.error)}`);
      immutableJson(path.join(root, "prepared", `${sourceId}-${arm}.json`), artifact);
      rows.push({ sourceId, arm, sourceHash: contentHash(source), artifactHash: contentHash(artifact) });
    }
    process.stdout.write(`PREPARED ${sourceId} all six arms; no provider requests\n`);
  }
  const calibration = buildSemanticCalibration(history.entries);
  if (new Set(calibration.cases.map((item) => item.entry.actionId)).size !== 43) throw new Error("calibration lacks original actions");
  immutableJson(path.join(root, "prepared", "calibration.json"), calibration);
  const manifest = { protocol: AC_FP2_PROTOCOL, budget: constrainedBudgetPolicy(), review: REVIEW_PROTOCOL, calibrationHash: contentHash(calibration),
    historicalManifestHash: AC_FP2_PROTOCOL.sourceManifestHash, oracleHash: frozen.manifest.oracleHash,
    rows, codeHash: initialCodeHash, commit: git(["rev-parse", "HEAD"]), schedule: constrainedFirstPassSchedule("discovery"),
    catalogHashes: { chat: catalog.hash, responses: constrainedCatalog(catalog, "responses").hash, review: constrainedCatalog(catalog, "review").hash },
    authorization: "approved-spec-0024-protocol-2-cny-950" };
  if (codeFingerprint() !== initialCodeHash || git(["status", "--porcelain"])) throw new Error("implementation changed during offline preparation; cannot freeze");
  immutableJson(path.join(root, "frozen.json"), { manifest, hash: contentHash(manifest) });
  return { hash: contentHash(manifest), preparedArms: rows.length, calibrationCases: calibration.cases.length };
}

export async function dryRunConstrained(root: string) {
  const initialCodeHash = codeFingerprint();
  const runId = contentHash({ initialCodeHash, startedAt: new Date().toISOString() });
  const sources = readConstrainedFirstPassSources(historicalRoot);
  const catalog = loadModelCatalog();
  const resources = createActionCompilationRetrievalRuntimeProvider();
  const rows: Array<{ id: string; accepted: boolean; calls: number; evidenceHash: string; error: unknown }> = [];
  for (const trial of [...constrainedFirstPassSchedule("discovery"), ...constrainedFirstPassSchedule("confirmation", "SCF")]) {
    const source = sources.sources[trial.sourceIndex]!;
    const options = constrainedArmOptions(trial.arm);
    const provider = new ScriptedModelProvider(({ profileId, context }) => {
      const canonical = deterministicActionCompilationBatch(profileId, context);
      if (!options.capabilities) return canonical;
      return { ...canonical, slots: Object.fromEntries(canonical.slots.map(({ slot, ...value }) => [String(slot), value])) };
    }, catalog, false, false);
    const retrieval = resources.runtime(source.captureAlgorithmRef);
    if (!retrieval) throw new Error("dry-run lacks real R5 resources");
    const evidence = await executeCompilationTrial({ trial, source, provider, retrieval, compiler: constrainedActionCompiler(options),
      algorithmRef: constrainedFirstPassAlgorithmRef(source.captureAlgorithmRef, trial.arm), executionPrefix: "ac-fp2-dry-run",
      expectedCatalogHash: catalog.hash, expectedOutputMode: "deterministic-test" });
    rows.push({ id: trial.id, accepted: evidence.compilerAccepted, calls: evidence.calls.length, evidenceHash: contentHash(evidence), error: evidence.error ?? null });
    immutableJson(path.join(root, "dry-runs", runId, `${trial.id}.json`), rows.at(-1));
    if (rows.length % 24 === 0) process.stdout.write(`DRY-RUN ${rows.length}/272 real compiler roots; provider HTTP=0\n`);
    if (!evidence.compilerAccepted) throw new Error(`dry-run compiler failure ${trial.id}: ${JSON.stringify(evidence.error)}`);
  }
  const result = { codeHash: initialCodeHash, codeUnchanged: codeFingerprint() === initialCodeHash, actualProviderRequests: 0, rows, discovery: 144, syntheticConfirmation: 128,
    note: "Deterministic expensive-boundary fixture; synthetic confirmation does not authorize live confirmation or imply model success." };
  immutableJson(path.join(root, "dry-runs", `${contentHash(result)}.json`), result);
  if (!result.codeUnchanged) throw new Error("dry-run implementation changed while running; diagnostic retained but acceptance invalidated");
  return { passed: true, roots: rows.length, actualProviderRequests: 0 };
}

function environment(root: string) {
  const frozen = read(path.join(root, "frozen.json"));
  assertOperationalLineage(root, frozen);
  if (contentHash(frozen.manifest) !== frozen.hash ||
    contentHash(frozen.manifest.protocol) !== contentHash(AC_FP2_PROTOCOL) || contentHash(frozen.manifest.budget) !== contentHash(constrainedBudgetPolicy())) throw new Error("AC-FP2 frozen implementation/protocol drift");
  const sources = readConstrainedFirstPassSources(historicalRoot);
  const catalog = loadModelCatalog();
  const profile = catalog.profile("truth-deepseek"), account = catalog.account(profile.account_id);
  if (!process.env[account.api_key_env]?.trim()) throw new Error("captured credential is not configured in the process environment");
  const modelRegistry = new ModelRegistry(catalog, path.resolve(".livingworld-v23"), { fetch: async () => { throw new Error("experiment cannot refresh model metadata"); } });
  const snapshot = modelRegistry.snapshot(sources.sources[0]!.registrySnapshotHash);
  const ceiling = snapshot.document.providers[account.models_dev_provider_id]?.models[AC_FP2_PROTOCOL.fixed.model]?.limit.context;
  if (!ceiling) throw new Error("missing pinned input token ceiling");
  const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), frozen.manifest.budget);
  if (budget.summary.unsettled.length) throw new Error("unknown provider usage requires reconciliation before sends");
  const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, inputTokenCeiling: ceiling,
    outputTokenCeiling: profile.max_output_tokens, allowLowerOutputLimit: true, endpointPaths: ["/chat/completions", "/responses"],
    trialPattern: /^(?:discovery|confirmation|probes|calibration|review)-[a-zA-Z0-9-]+$/u,
    fetch: createModelFetchResolver(process.env)(profile.account_id, account) ?? fetch });
  const providers = createConstrainedGateways(catalog, process.env, path.resolve(".livingworld-v23"), transport.fetch);
  for (const [mode, provider] of Object.entries(providers)) if (provider.catalog.hash !== frozen.manifest.catalogHashes[mode]) throw new Error("pinned experiment catalog drift");
  return { frozen, sources, catalog, budget, transport, providers };
}

function httpEvidence(root: string, trialId: string): FirstPassHttpEvidence[] {
  const directory = path.join(root, "http");
  return (existsSync(directory) ? readdirSync(directory) : []).filter((id) => id.startsWith(`${trialId}-http-`) && !verifiedNotSentHttp(root, id)).sort().map((id) => {
    const request = read(path.join(directory, id, "request.json"));
    const response = read(path.join(directory, id, "response.json"));
    if (contentHash(request.body) !== request.bodyHash || contentHash(response.raw) !== response.rawHash) throw new Error("HTTP evidence hash drift");
    const raw = JSON.parse(response.raw);
    return { id, ...deepSeekExperimentUsage(raw), elapsedMs: response.elapsedMs,
      reasoning: raw.usage?.output_tokens_details?.reasoning_tokens ?? raw.usage?.completion_tokens_details?.reasoning_tokens ?? null, cacheWrite: null };
  });
}

export async function runConstrainedPhase(root: string, phase: "discovery" | "confirmation", winner?: ConstrainedFirstPassCandidate) {
  const env = environment(root);
  const resources = createActionCompilationRetrievalRuntimeProvider();
  for (const trial of constrainedFirstPassSchedule(phase, winner)) {
    const directory = path.join(root, "trials", trial.id), file = path.join(directory, "result.json");
    if (existsSync(file)) {
      const frame = read(file);
      if (frame.frozenHash !== env.frozen.hash || frame.hash !== contentHash(frame.evidence) || frame.stopReason) throw new Error("recorded trial incomplete or hash drift");
      continue;
    }
    if (existsSync(path.join(directory, "started.json"))) throw new Error(`interrupted trial must not be redrawn: ${trial.id}`);
    const executionCodeHash = assertOperationalLineage(root, env.frozen);
    env.transport.beginTrial(trial.id, trial.phase);
    const beforeHttp = env.budget.summary.phases[trial.phase].httpRequests;
    immutableJson(path.join(directory, "started.json"), { trial, frozenHash: env.frozen.hash, startedAt: new Date().toISOString() });
    process.stdout.write(`RUN ${trial.id}\n`);
    const source = env.sources.sources[trial.sourceIndex]!;
    const provider = env.providers[trial.arm === "B" ? "chat" : "responses"]!;
    const retrieval = resources.runtime(source.captureAlgorithmRef);
    if (!retrieval) throw new Error("missing captured R5 resources");
    const evidence = await executeCompilationTrial({ trial, source, provider, retrieval, compiler: constrainedActionCompiler(constrainedArmOptions(trial.arm)),
      algorithmRef: constrainedFirstPassAlgorithmRef(source.captureAlgorithmRef, trial.arm), executionPrefix: "ac-fp2",
      expectedCatalogHash: provider.catalog.hash, expectedOutputMode: constrainedArmOptions(trial.arm).structuredOutputMode });
    const stopReason = env.transport.stopReason ?? (env.budget.summary.phases[trial.phase].httpRequests > beforeHttp ? null : "no actual provider send");
    immutableJson(file, { frozenHash: env.frozen.hash, executionCodeHash, evidence, hash: contentHash(evidence), stopReason });
    process.stdout.write(`${JSON.stringify({ trial: trial.id, accepted: evidence.compilerAccepted, calls: evidence.calls.length,
      wallMs: evidence.wallMs, error: evidence.error, estimatedCny: env.budget.summary.estimatedPeakNanoCny / 1e9 })}\n`);
    if (stopReason || env.budget.summary.unsettled.length) throw new Error(`experiment interrupted: ${stopReason}`);
  }
}

export function scoreConstrained(root: string, phase: "discovery" | "confirmation", winner?: ConstrainedFirstPassCandidate) {
  const frozen = read(path.join(root, "frozen.json"));
  const sources = readConstrainedFirstPassSources(historicalRoot);
  const semanticFile = path.join(root, `semantic-${phase}.json`);
  const semantic = existsSync(semanticFile) ? read(semanticFile) as { frozenHash: string; rows: Array<{ reviewId: string; verdict: "pass" | "fail" | "unresolved" }> } : null;
  if (semantic && semantic.frozenHash !== frozen.hash) throw new Error("semantic review manifest drift");
  const rows: ConstrainedTrialScore[] = [], entries = new Map<string, BlindCompilationReview>();
  const missing: string[] = [];
  for (const trial of constrainedFirstPassSchedule(phase, winner)) {
    const file = path.join(root, "trials", trial.id, "result.json");
    if (!existsSync(file)) { missing.push(trial.id); continue; }
    const frame = read(file) as { evidence: FirstPassTrialEvidence<ConstrainedFirstPassTrial>; frozenHash: string; hash: string; stopReason: string | null };
    if (frame.frozenHash !== frozen.hash || frame.hash !== contentHash(frame.evidence) || contentHash(frame.evidence.trial) !== contentHash(trial)) throw new Error("scored trial identity/hash drift");
    if (frame.stopReason) { missing.push(trial.id); continue; }
    const source = sources.sources[trial.sourceIndex]!;
    const trialEntries = firstPassReviewEntries(frame.evidence, source, sources.manifest.oracleHash);
    const verdicts = trialEntries.map((entry) => ({ oracleHash: entry.oracleHash, stateHash: entry.stateHash, actionId: entry.actionId,
      canonicalCompilationHash: entry.canonicalCompilationHash, verdict: semantic?.rows.find((row) => row.reviewId === entry.reviewId)?.verdict ?? "unresolved",
      evidenceKind: "model-assisted", mustFindings: ["Grounded seven-dimension reviews, with deterministic violations dominant; not human gold."],
      forbiddenFindings: ["Disagreement and unavailable evidence remain unresolved."], evidenceArtifacts: [semanticFile], reviewer: "ac-fp2-two-blind-requests" }));
    rows.push(scoreFirstPassTrial({ evidence: frame.evidence, source, oracleHash: sources.manifest.oracleHash, verdicts, http: httpEvidence(root, trial.id) }));
    trialEntries.forEach((entry) => entries.set(entry.reviewId, entry));
  }
  const selection = !missing.length && phase === "discovery" ? selectConstrainedWinner(rows) : null;
  const confirmation = !missing.length && phase === "confirmation" ? confirmConstrainedWinner(rows, winner!) : null;
  const report = { frozenHash: frozen.hash, phase, complete: !missing.length, missing, rows, selection, confirmation,
    groups: Object.fromEntries([...new Set(rows.map((row) => row.trial.arm))].map((arm) => [arm, summarizeFirstPass(rows.filter((row) => row.trial.arm === arm))])),
    semanticStatus: semantic ? "model-assisted-evidence-not-human-gold" : "pending-independent-review-not-zero-semantic-accuracy" };
  const directory = path.join(root, "scores", contentHash(report));
  immutableJson(path.join(directory, "metrics.json"), report);
  immutableJson(path.join(directory, "review-pack.json"), [...entries.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId)));
  immutableExperimentText(path.join(directory, "report.md"), `# AC-FP2 ${phase}\n\nEngineering metrics only; semantic evidence is separate.\n\n${JSON.stringify(report.groups, null, 2)}\n\nMissing: ${missing.length}. Selection: ${selection?.status ?? "not applicable"}.\n`);
  if (selection) {
    const selectionFile = path.join(root, "discovery-selection.json");
    if (existsSync(selectionFile)) {
      const previous = read(selectionFile);
      if (previous.winner !== selection.winner || previous.frozenHash !== frozen.hash) throw new Error("post-review engineering winner drift");
    } else immutableJson(selectionFile, { ...selection, frozenHash: frozen.hash, reportHash: contentHash(report) });
  }
  return { directory, report, entries: [...entries.values()] };
}

async function reviewPacket(root: string, env: ReturnType<typeof environment>, phase: "calibration" | "review", entries: BlindCompilationReview[], packet: string) {
  const responses: ReturnType<typeof validateSemanticReview>[] = [];
  const assess = (value: unknown) => {
    try { return validateSemanticReview(value, entries); }
    catch (error) { return unresolvedSemanticReview(entries, `Review output was not independently usable: ${error instanceof Error ? error.message : String(error)}`); }
  };
  for (const order of [0, 1]) {
    const id = `${phase}-${packet}-${order}`, file = path.join(root, phase, id, "result.json");
    if (existsSync(file)) {
      const frame = read(file);
      if (frame.entriesHash !== contentHash(entries) || frame.frozenHash !== env.frozen.hash || frame.hash !== contentHash(frame.result)) throw new Error("review resume identity drift");
      responses.push(assess(frame.result?.value)); continue;
    }
    if (existsSync(path.join(root, phase, id, "started.json"))) throw new Error("interrupted review cannot be silently redrawn");
    const source = env.sources.sources.find((source) => source.actions.some((action) => action.id === entries[0]!.actionId))!;
    const context = { entries: (order ? [...entries].reverse() : entries).map(({ reviewId, action, compilation }) => ({ reviewId, source: action, output: compilation })),
      truth: (source.stateSnapshot as SimulationState).truth, rules: env.sources.oracle };
    env.transport.beginTrial(id, phase);
    immutableJson(path.join(root, phase, id, "started.json"), { entriesHash: contentHash(entries), frozenHash: env.frozen.hash });
    let result: unknown = null, error: unknown = null;
    try { result = await env.providers.review!.generateStructured({ ...constrainedOfflineScope(source.stateSnapshot as SimulationState, id), profileId: REVIEW_PROTOCOL.profile,
      role: "action-compilation", modelRegistrySnapshotHash: source.registrySnapshotHash,
      system: REVIEW_PROTOCOL.system, userPrompt: REVIEW_PROTOCOL.userPrompt,
      context, schema: semanticReviewSchema, schemaName: "offline_semantic_review_v1", promptVersion: `ac-fp2-review@${contentHash(REVIEW_PROTOCOL)}`,
      structuredOutputMode: "json-schema-strict" }); }
    catch (caught) {
      error = caught instanceof Error ? { name: caught.name, message: caught.message } : String(caught);
      if (caught instanceof ModelOutputError) result = { value: caught.rawValue ?? null, audit: caught.audit ?? null, invalidModelOutput: true };
    }
    immutableJson(file, { entriesHash: contentHash(entries), frozenHash: env.frozen.hash, executionCodeHash: codeFingerprint(), result, hash: contentHash(result), error });
    if (env.transport.stopReason || env.budget.summary.unsettled.length) throw new Error("review transport requires usage reconciliation before further sends");
    responses.push(assess((result as { value?: unknown } | null)?.value));
    process.stdout.write(`REVIEW ${id}: ${entries.length} entries; estimated CNY ${(env.budget.summary.estimatedPeakNanoCny / 1e9).toFixed(3)}\n`);
  }
  return mergeBlindReviews(responses[0]!, responses[1]!);
}

export async function calibrateConstrained(root: string) {
  const env = environment(root);
  const calibration = read(path.join(root, "prepared", "calibration.json")) as ReturnType<typeof buildSemanticCalibration>;
  if (contentHash(calibration) !== env.frozen.manifest.calibrationHash) throw new Error("calibration label drift");
  const entries = calibration.cases.map((item) => item.entry).sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  const reviews: Awaited<ReturnType<typeof reviewPacket>> = [];
  for (let index = 0; index < entries.length; index += REVIEW_PROTOCOL.maximumPacketEntries) {
    reviews.push(...await reviewPacket(root, env, "calibration", entries.slice(index, index + REVIEW_PROTOCOL.maximumPacketEntries), String(index).padStart(4, "0")));
  }
  const outcomes = calibration.cases.map((item) => {
    const row = reviews.find((row) => row.reviewId === item.entry.reviewId)!;
    const first = row.first.checks.find((check) => check.dimension === item.dimension)!.verdict;
    const second = row.second.checks.find((check) => check.dimension === item.dimension)!.verdict;
    return { reviewId: item.entry.reviewId, dimension: item.dimension, expected: item.expected, first, second, agreement: first === second,
      correct: first === item.expected && second === item.expected };
  });
  const accuracy = (expected: string) => { const rows = outcomes.filter((item) => item.expected === expected); return rows.filter((item) => item.correct).length / rows.length; };
  const sensitivity = accuracy("fail"), specificity = accuracy("pass");
  const result = { frozenHash: env.frozen.hash, sensitivity, specificity, calibrated: sensitivity >= .9 && specificity >= .9,
    agreement: outcomes.filter((row) => row.agreement).length / outcomes.length, outcomes,
    claimBoundary: "Dimension-specific authored fixtures, not whole-output human gold or long-horizon realism" };
  immutableJson(path.join(root, "calibration-summary.json"), result);
  return result;
}

export async function reviewConstrained(root: string, entries: BlindCompilationReview[], label: string) {
  const env = environment(root);
  const sorted = [...entries].sort((a, b) => a.reviewId.localeCompare(b.reviewId));
  const reviews: Awaited<ReturnType<typeof reviewPacket>> = [];
  for (let index = 0; index < sorted.length; index += REVIEW_PROTOCOL.maximumPacketEntries) {
    reviews.push(...await reviewPacket(root, env, "review", sorted.slice(index, index + REVIEW_PROTOCOL.maximumPacketEntries), `${label}-${String(index).padStart(4, "0")}`));
  }
  const deterministic = auditSemanticObservability(env.sources.oracle, entries);
  const calibration = read(path.join(root, "calibration-summary.json"));
  const rows = reviews.map((row) => ({ ...row, verdict: deterministic.rows.find((item) => item.reviewId === row.reviewId)!.findings.some((finding) => finding.verdict === "fail") ? "fail" : calibration.calibrated ? row.verdict : "unresolved" }));
  const result = { label, frozenHash: env.frozen.hash, calibration, rows,
    counts: { pass: rows.filter((row) => row.verdict === "pass").length, fail: rows.filter((row) => row.verdict === "fail").length, unresolved: rows.filter((row) => row.verdict === "unresolved").length },
    evidenceKind: "model-assisted-plus-deterministic-not-human-gold", worldRealismProven: false };
  immutableJson(path.join(root, `semantic-${label}.json`), result);
  return result;
}

export async function probeConstrained(root: string) {
  const env = environment(root);
  for (const arm of ["R", "S", "SC", "SF", "SCF"] as const) {
    const file = path.join(root, "probes", `${arm}.json`);
    if (existsSync(file)) {
      const previous = read(file);
      if (previous.frozenHash !== env.frozen.hash || !previous.supported) throw new Error(`recorded capability failure or provenance drift: ${arm}`);
      continue;
    }
    const prepared = read(path.join(root, "prepared", `P04-${arm}.json`));
    env.transport.beginTrial(`probes-${arm}`, "probes");
    let result: unknown, failure: unknown;
    try {
      result = await env.providers.responses!.generateStructured({ ...constrainedOfflineScope(env.sources.sources[3]!.stateSnapshot as SimulationState, `probe-${arm}`), profileId: "truth-deepseek",
        role: "action-compilation", modelRegistrySnapshotHash: env.sources.sources[3]!.registrySnapshotHash,
        ...prepared, schema: z.fromJSONSchema(prepared.schema), wireJsonSchema: prepared.schema });
    } catch (error) {
      if (error instanceof ModelOutputError && error.audit) result = { semanticOrSchemaFailure: error.message, audit: error.audit };
      else failure = error instanceof Error ? { name: error.name, message: error.message } : String(error);
    }
    const supported = !failure && !env.transport.stopReason && httpEvidence(root, `probes-${arm}`).length > 0;
    immutableJson(file, { supported, result, failure: failure ?? null, frozenHash: env.frozen.hash });
    process.stdout.write(`PROBE ${arm}: ${supported ? "endpoint/schema path returned audited output" : "FAILED"}\n`);
    if (!supported) throw new Error(`capability probe failed: ${arm}: ${JSON.stringify(failure)}`);
  }
}

async function main() {
  const command = process.argv[2] ?? "prepare", root = path.resolve(process.argv[3] ?? defaultRoot);
  if (!["prepare", "validate", "dry-run-all", "probe", "calibrate", "run-all", "resume", "score", "report", "publish", "continue-operational", "reconcile-not-sent"].includes(command)) throw new Error("unknown experiment command");
  const unlock = lockExperiment(root);
  try {
    if (command === "prepare") { process.stdout.write(`${JSON.stringify(await prepareConstrained(root))}\n`); return; }
    if (command === "continue-operational") { process.stdout.write(`${JSON.stringify(registerOperationalContinuation(root))}\n`); return; }
    if (command === "reconcile-not-sent") {
      const frozen = read(path.join(root, "frozen.json"));
      assertOperationalLineage(root, frozen);
      const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), frozen.manifest.budget);
      process.stdout.write(`${JSON.stringify(reconcileNotSentTrial(root, process.argv[4] ?? "", budget))}\n`); return;
    }
    if (command === "validate") {
      const frame = read(path.join(root, "frozen.json"));
      if (frame.hash !== contentHash(frame.manifest)) throw new Error("frozen identity drift");
      assertOperationalLineage(root, frame);
      readConstrainedFirstPassSources(historicalRoot);
      const budget = new ExperimentBudget(path.join(root, "budget.jsonl"), frame.manifest.budget);
      process.stdout.write(`${JSON.stringify({ frozenHash: frame.hash, budget: budget.summary, providerRequests: 0 })}\n`); return;
    }
    if (command === "dry-run-all") { process.stdout.write(`${JSON.stringify(await dryRunConstrained(root))}\n`); return; }
    if (command === "probe") { await probeConstrained(root); return; }
    if (command === "calibrate") { await calibrateConstrained(root); return; }
    if (["score", "report", "publish"].includes(command)) {
      const scored = scoreConstrained(root, "discovery");
      if (command === "publish") {
        const packet = { notionPage: "3d3d59e8-6a74-8137-936a-f730e0798293", reportDirectory: scored.directory,
          metricsHash: contentHash(scored.report), publication: "connector-owned; this offline command prepares the verified packet and never reruns a model" };
        immutableJson(path.join(root, "publication", `${contentHash(packet)}.json`), packet);
      }
      process.stdout.write(`${JSON.stringify({ directory: scored.directory, groups: scored.report.groups })}\n`); return;
    }
    const completionFile = path.join(root, "completed.json");
    if (existsSync(completionFile)) {
      const completion = read(completionFile), frozen = read(path.join(root, "frozen.json"));
      if (completion.frozenHash !== frozen.hash || frozen.hash !== contentHash(frozen.manifest)) throw new Error("completed experiment provenance drift");
      process.stdout.write(`${JSON.stringify(completion)}\n`); return;
    }
    await probeConstrained(root);
    await calibrateConstrained(root);
    await runConstrainedPhase(root, "discovery");
    const discovery = scoreConstrained(root, "discovery");
    const winner = discovery.report.selection?.winner;
    if (winner) await runConstrainedPhase(root, "confirmation", winner);
    await reviewConstrained(root, discovery.entries, "discovery");
    const finalDiscovery = scoreConstrained(root, "discovery");
    let finalConfirmation = null;
    if (winner) {
      const confirmation = scoreConstrained(root, "confirmation", winner); await reviewConstrained(root, confirmation.entries, "confirmation");
      finalConfirmation = scoreConstrained(root, "confirmation", winner).directory;
    }
    immutableJson(completionFile, { frozenHash: read(path.join(root, "frozen.json")).hash, executionCodeHash: codeFingerprint(), discovery: 144, confirmation: winner ? 128 : 0, winner: winner ?? null,
      discoveryReport: finalDiscovery.directory, confirmationReport: finalConfirmation,
      confirmationReason: winner ? "engineering gate passed" : "no candidate passed fixed discovery gates", completedAt: new Date().toISOString(), productionPromotion: false });
    process.stdout.write("AC-FP2 fixed experiment and independent reviews completed; production unchanged.\n");
  } finally { unlock(); }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
