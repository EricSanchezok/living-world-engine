import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { loadOfficialSourceShard } from "./refresh-action-compilation-reference";
import { AC_FP1_ARMS, AC_FP1_PROTOCOL, AC_FP1_SOURCES, firstPassAlgorithmRef, firstPassSchedule, orderedFirstPassSources } from "../../src/engine/benchmarks/action-compilation/first-pass-protocol";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { createActionCompilationRetrievalRuntimeProvider } from "../../src/server/action-compilation-retrieval-runtime";
import { compileActions } from "../../src/engine/algorithms/eager-reference/action-compiler";
import { ActionCompilationCodec, actionCompilationProfileKinds } from "../../src/engine/algorithms/eager-reference/action-compilation-representation";
import { representedActionCompilationPrompt } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { registerBuiltinAlgorithms } from "../../src/engine/algorithms/registry";
import { WorldExecutionAlgorithmRegistry } from "../../src/engine/runtime/execution";
import type { SimulationState } from "../../src/engine/contracts/model";
import { AC_FP1_BUDGET, ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { structuredPromptBytes } from "../../src/engine/prompts";
import { immutableExperimentJson as immutableJson, immutableExperimentText, lockExperiment } from "../../src/engine/benchmarks/action-compilation/experiment-artifacts";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { bindFirstPassOracle, intentVerdictSchema } from "../../src/engine/benchmarks/action-compilation/first-pass-oracle";
import { executeFirstPassTrial, type FirstPassTrialEvidence } from "../../src/engine/benchmarks/action-compilation/first-pass-runner";
import { confirmFirstPass, firstPassReviewEntries, scoreFirstPassTrial, selectFirstPassWinner, summarizeFirstPass, type FirstPassHttpEvidence } from "../../src/engine/benchmarks/action-compilation/first-pass-scoring";
import { validateActionCompilationCapturedSource } from "../../src/engine/benchmarks/source-capture";

const defaultRoot = path.resolve(".livingworld-benchmarks/experiments/ac-fp1/v1");

export async function preflightFirstPass(root: string) {
  const sources = orderedFirstPassSources(loadOfficialSourceShard(path.join(root, "source-staging")));
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  const modelRegistry = new ModelRegistry(catalog, path.resolve(".livingworld-v23"), {
    fetch: async () => { throw new Error("offline preflight cannot refresh model metadata"); },
  });
  const algorithms = registerBuiltinAlgorithms(new WorldExecutionAlgorithmRegistry());
  const resources = createActionCompilationRetrievalRuntimeProvider();
  const rows: unknown[] = [];
  mkdirSync(root, { recursive: true });
  const staging = mkdtempSync(path.join(root, "preflight-"));
  for (const [sourceIndex, source] of sources.entries()) {
    const id = AC_FP1_SOURCES[sourceIndex]!.id;
    if (catalog.hash !== source.modelCatalogHash) throw new Error(`${id}: captured model catalog drift`);
    modelRegistry.snapshot(source.registrySnapshotHash);
    const state = structuredClone(source.stateSnapshot) as SimulationState;
    const execution = source.fullContext.execution as { instanceId: string; advanceId: string };
    let context: unknown;
    let retrievalCalls = 0;
    let providerBoundaries = 0;
    const runtime = resources.runtime(source.captureAlgorithmRef);
    if (!runtime) throw new Error(`${id}: R5 retrieval resource is missing`);
    const provider: StructuredModelProvider = {
      catalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => undefined,
      generateStructured: async (request) => {
        providerBoundaries += 1;
        context = request.context;
        throw new ModelConfigurationError("AC-FP1 offline provider boundary");
      },
    };
    let shortlistHash: string | undefined;
    try {
      await compileActions(provider, state, source.actions, {
        workloadId: execution.instanceId, batchId: execution.advanceId,
        runtimeIdentity: { worldHash: state.worldHash, revision: state.revision },
        modelRegistrySnapshotHash: source.registrySnapshotHash,
        executionAlgorithmRef: source.captureAlgorithmRef,
        actionCompilationRetrieval: { ...runtime, retrieveBatch: async (input) => {
          retrievalCalls += 1;
          if (contentHash(input.fullContext) !== source.fullContextHash) throw new ModelConfigurationError(`${id}: full context drift`);
          const selected = await runtime.retrieveBatch(input);
          if (selected.modelContextHash !== source.modelContextHash || selected.shortlistHash !== source.shortlistHash) {
            throw new ModelConfigurationError(`${id}: R5 model context/shortlist drift`);
          }
          shortlistHash = selected.shortlistHash;
          return selected;
        } },
      }, source.profileId, source.actions.length);
      throw new Error("offline compiler unexpectedly crossed the provider boundary");
    } catch (error) {
      if (!(error instanceof ModelConfigurationError) || error.message !== "AC-FP1 offline provider boundary") throw error;
    }
    if (providerBoundaries !== 1 || retrievalCalls !== 1 || contentHash(state) !== source.stateHash) {
      throw new Error(`${id}: physical batch or source state changed in preflight`);
    }
    const arms = AC_FP1_ARMS.map((arm) => {
      const ref = firstPassAlgorithmRef(source.captureAlgorithmRef, arm);
      algorithms.validateExperimentComposition(ref);
      const codec = new ActionCompilationCodec(arm, context, source.fullContext, actionCompilationProfileKinds(state));
      const prompt = representedActionCompilationPrompt(arm);
      const schema = codec.wireSchema(context);
      const wireContext = codec.encodeContext(context);
      const measured = structuredPromptBytes({ ...prompt, context: wireContext, schema });
      const bytes = { requestUtf8Bytes: measured.requestUtf8Bytes, contextUtf8Bytes: Buffer.byteLength(JSON.stringify(wireContext), "utf8") };
      if (bytes.requestUtf8Bytes > catalog.profile(source.profileId).max_input_bytes) throw new Error(`${id}/${arm}: treatment splits the initial batch`);
      immutableJson(path.join(staging, `${id}-${arm}.json`), {
        algorithmRef: ref, prompt, schema: z.toJSONSchema(schema, { target: "draft-07" }),
        dictionary: [...codec.aliases], dictionaryHash: codec.dictionaryHash,
        context: wireContext, canonicalModelContextHash: contentHash(context),
      });
      return { arm, manifestHash: ref.manifestHash, dictionaryHash: codec.dictionaryHash,
        visibleKeys: codec.rootVisibleKeyCount, reservedKeys: codec.aliases.size - codec.rootVisibleKeyCount, bytes, contextHash: contentHash(wireContext) };
    });
    const row = { id, sourceHash: contentHash(source), modelContextHash: contentHash(context), shortlistHash, slots: source.actions.length, arms };
    rows.push(row);
    immutableJson(path.join(staging, `${id}-source.json`), source);
    process.stdout.write(`${JSON.stringify({ preflight: id, slots: source.actions.length, providerRequests: 0, arms })}\n`);
  }
  const result = { version: 1, sourceRows: rows, schedule: firstPassSchedule("discovery"), budget: AC_FP1_BUDGET,
    providerRequests: 0, networkRequests: 0, worldMutations: 0, artifactDirectory: staging,
    status: "source-preflight-passed-offline-gates-pending" };
  immutableJson(path.join(staging, "manifest.json"), result);
  return result;
}

function git(args: string[]): string {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed`);
  return result.stdout.trim();
}

export function firstPassCodeFingerprint(): string {
  const files = git(["ls-files", "src/engine", "src/script", "src/server/action-compilation-retrieval-runtime.ts",
    "scripts/experiments/action-compilation-first-pass.ts", "scripts/experiments/refresh-action-compilation-reference.ts",
    "scripts/experiments/ac-fp1-mechanisms.config.ts", "scripts/experiments/ac-fp1-mechanisms.setup.ts", "test/fixtures/open-world-script", "test/setup.ts",
    "docs/specs/0023-action-compilation-first-pass-experiment.md",
    "config/models.yaml", "package.json", "package-lock.json", "experiments/action-compilation/ac-fp1"])
    .split("\n").filter(Boolean).sort();
  return contentHash(files.map((file) => ({ file, hash: contentHash(readFileSync(file, "utf8")) })));
}

const verificationCommands = [
  ["run", "check:fast"],
  ["exec", "--", "vitest", "run", "--config", "scripts/experiments/ac-fp1-mechanisms.config.ts"],
  ["run", "benchmark:verify:action-compilation-reference"],
  ["run", "benchmark:verify:relational-rrf"],
  ["run", "world:validate", "--", "worlds/blackmarsh/world"],
  ["run", "build"],
] as const;

function verifyFirstPass(root: string) {
  if (git(["status", "--porcelain"])) throw new Error("commit verified work units before sealing AC-FP1 checks");
  const codeHash = firstPassCodeFingerprint();
  const file = path.join(root, "verified", `${codeHash}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const checks = verificationCommands.map((args) => {
    process.stdout.write(`VERIFY npm ${args.join(" ")}\n`);
    const result = spawnSync("npm", [...args], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    return { command: ["npm", ...args], exitCode: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  });
  const evidence = { codeHash, commit: git(["rev-parse", "HEAD"]), checks, passed: checks.every((check) => check.exitCode === 0), completedAt: new Date().toISOString() };
  if (!evidence.passed || firstPassCodeFingerprint() !== codeHash) {
    immutableJson(path.join(root, "failed-verification", `${contentHash(evidence)}.json`), evidence);
    throw new Error("AC-FP1 offline verification failed; evidence retained, live is blocked");
  }
  immutableJson(file, evidence);
  return { codeHash, passed: true, file };
}

interface FrozenManifest {
  version: 1;
  codeHash: string;
  protocolHash: string;
  oracleHash: string;
  budgetHash: string;
  verificationHash: string;
  files: Array<{ file: string; hash: string }>;
  schedule: ReturnType<typeof firstPassSchedule>;
  authorization: "approved-spec-0023-cny-1000";
  frozenAt: string;
}

export function readFrozenFirstPass(root: string) {
  const directory = path.join(root, "frozen");
  const frame = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8")) as { manifest: FrozenManifest; hash: string };
  const manifest = frame.manifest;
  if (frame.hash !== contentHash(manifest) || manifest.version !== 1 ||
    manifest.codeHash !== firstPassCodeFingerprint() || manifest.protocolHash !== contentHash(AC_FP1_PROTOCOL) || manifest.budgetHash !== contentHash(AC_FP1_BUDGET) ||
    manifest.authorization !== "approved-spec-0023-cny-1000" ||
    contentHash(manifest.schedule) !== contentHash(firstPassSchedule("discovery"))) throw new Error("frozen AC-FP1 manifest/code/budget drift");
  for (const entry of manifest.files) {
    if (!/^(?:P0[1-4]-(?:B1|A|T|AT|source)|oracle|verification|protocol)\.json$/u.test(entry.file)) throw new Error("invalid frozen artifact path");
    const value = JSON.parse(readFileSync(path.join(directory, entry.file), "utf8"));
    if (contentHash(value) !== entry.hash) throw new Error(`frozen artifact checksum mismatch: ${entry.file}`);
  }
  if (manifest.files.length !== 23 || new Set(manifest.files.map((entry) => entry.file)).size !== 23) throw new Error("incomplete frozen artifact set");
  const sources = orderedFirstPassSources(AC_FP1_SOURCES.map(({ id }) => validateActionCompilationCapturedSource(JSON.parse(readFileSync(path.join(directory, `${id}-source.json`), "utf8")))));
  const oracle = JSON.parse(readFileSync(path.join(directory, "oracle.json"), "utf8"));
  if (contentHash(oracle) !== manifest.oracleHash) throw new Error("frozen intent oracle drift");
  const verification = JSON.parse(readFileSync(path.join(directory, "verification.json"), "utf8"));
  if (contentHash(verification) !== manifest.verificationHash || !verification.passed || verification.codeHash !== manifest.codeHash ||
    contentHash(verification.checks.map((check: { command: string[] }) => check.command)) !== contentHash(verificationCommands.map((args) => ["npm", ...args])) ||
    verification.checks.some((check: { exitCode: number }) => check.exitCode !== 0)) throw new Error("invalid frozen verification evidence");
  return { directory, manifest, hash: frame.hash, sources, oracle };
}

async function freezeFirstPass(root: string) {
  if (existsSync(path.join(root, "frozen"))) return { frozen: true, hash: readFrozenFirstPass(root).hash };
  if (git(["status", "--porcelain"])) throw new Error("commit implementation before freezing AC-FP1");
  const codeHash = firstPassCodeFingerprint();
  const verificationFile = path.join(root, "verified", `${codeHash}.json`);
  if (!existsSync(verificationFile)) throw new Error("run AC-FP1 verify for this exact code before freeze");
  const verification = JSON.parse(readFileSync(verificationFile, "utf8"));
  if (!verification.passed || verification.codeHash !== codeHash) throw new Error("offline verification is not valid for current code");
  const sources = orderedFirstPassSources(loadOfficialSourceShard(path.join(root, "source-staging")));
  const oracle = bindFirstPassOracle(JSON.parse(readFileSync("experiments/action-compilation/ac-fp1/v1/intent-oracle.json", "utf8")), sources);
  const preflight = await preflightFirstPass(root);
  const stage = mkdtempSync(path.join(root, "freeze-staging-"));
  const files: FrozenManifest["files"] = [];
  for (const file of readdirSync(preflight.artifactDirectory).filter((file) => file !== "manifest.json").sort()) {
    const value = JSON.parse(readFileSync(path.join(preflight.artifactDirectory, file), "utf8"));
    immutableJson(path.join(stage, file), value);
    files.push({ file, hash: contentHash(value) });
  }
  for (const [file, value] of [["oracle.json", oracle], ["verification.json", verification], ["protocol.json", AC_FP1_PROTOCOL]] as const) {
    immutableJson(path.join(stage, file), value);
    files.push({ file, hash: contentHash(value) });
  }
  if (firstPassCodeFingerprint() !== codeHash) throw new Error("code changed during source preflight");
  const manifest: FrozenManifest = { version: 1, codeHash, protocolHash: contentHash(AC_FP1_PROTOCOL), oracleHash: contentHash(oracle), budgetHash: contentHash(AC_FP1_BUDGET),
    verificationHash: contentHash(verification), files: files.sort((left, right) => left.file.localeCompare(right.file)),
    schedule: firstPassSchedule("discovery"), authorization: "approved-spec-0023-cny-1000", frozenAt: new Date().toISOString() };
  immutableJson(path.join(stage, "manifest.json"), { manifest, hash: contentHash(manifest) });
  renameSync(stage, path.join(root, "frozen"));
  return { frozen: true, hash: readFrozenFirstPass(root).hash, providerRequests: 0 };
}

export interface FirstPassArgs { command: "preflight" | "verify" | "freeze" | "run" | "score" | "report"; root: string; live: boolean; authorization?: string; phase: "discovery" | "confirmation" }
export function parseFirstPassArgs(argv: readonly string[]): FirstPassArgs {
  const [command] = argv;
  if (!["preflight", "verify", "freeze", "run", "score", "report"].includes(command ?? "")) throw new Error("usage: experiment:action-compilation <preflight|verify|freeze|run|score|report> [--root <path>] [--phase discovery|confirmation] [--live --authorization approved-spec-0023-cny-1000]");
  const args: FirstPassArgs = { command: command as FirstPassArgs["command"], root: defaultRoot, live: false, phase: "discovery" };
  for (let index = 1; index < argv.length; index++) {
    const option = argv[index]!;
    if (option === "--live") { args.live = true; continue; }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (option === "--root") args.root = path.resolve(value);
    else if (option === "--authorization") args.authorization = value;
    else if (option === "--phase" && (value === "discovery" || value === "confirmation")) args.phase = value;
    else throw new Error(`unsupported AC-FP1 option: ${option}`);
  }
  return args;
}

async function runFirstPass(args: FirstPassArgs) {
  const frozen = readFrozenFirstPass(args.root);
  if (!args.live) return { live: false, phase: args.phase, frozenHash: frozen.hash, providerRequests: 0 };
  if (args.authorization !== frozen.manifest.authorization) throw new Error("live run requires the recorded Spec/budget authorization argument");
  let schedule = frozen.manifest.schedule;
  if (args.phase === "confirmation") {
    schedule = firstPassSchedule("confirmation", readFirstPassWinner(args.root, frozen.hash));
  }
  const catalog = loadModelCatalog(path.resolve("config/models.yaml"));
  const source = frozen.sources[0]!;
  if (catalog.hash !== source.modelCatalogHash) throw new Error("captured catalog changed");
  const profile = catalog.profile(source.profileId);
  const account = catalog.account(profile.account_id);
  if (!process.env[account.api_key_env]?.trim()) throw new Error("captured provider credential is not configured in the process environment");
  const modelRegistry = new ModelRegistry(catalog, path.resolve(".livingworld-v23"), { fetch: async () => { throw new Error("experiment model registry cannot access the network"); } });
  const snapshot = modelRegistry.snapshot(source.registrySnapshotHash);
  const metadata = snapshot.document.providers[account.models_dev_provider_id]?.models[source.modelId];
  if (!metadata?.limit.context || !profile.max_output_tokens) throw new Error("captured provider has no trusted token ceiling");
  const budget = new ExperimentBudget(path.join(args.root, "budget.jsonl"));
  if (budget.summary.unsettled.length) throw new Error("unsettled provider usage blocks live resume");
  const delegatedFetch = createModelFetchResolver(process.env)(profile.account_id, account) ?? fetch;
  const transport = new FirstPassExperimentTransport(budget, { root: args.root, baseUrl: account.base_url,
    inputTokenCeiling: metadata.limit.context, outputTokenCeiling: profile.max_output_tokens, fetch: delegatedFetch });
  const provider = createModelGateway(catalog, process.env, { registry: modelRegistry, fetchForAccount: (id) => {
    if (id !== profile.account_id) return async () => { throw new Error("unapproved model account in AC-FP1"); };
    return transport.fetch;
  } });
  const resources = createActionCompilationRetrievalRuntimeProvider();
  for (const trial of schedule) {
    const directory = path.join(args.root, "trials", trial.id);
    const resultFile = path.join(directory, "result.json");
    if (existsSync(resultFile)) {
      const recorded = JSON.parse(readFileSync(resultFile, "utf8"));
      if (recorded.frozenHash !== frozen.hash || contentHash(recorded.evidence) !== recorded.hash) throw new Error("recorded trial hash drift");
      if (recorded.stopReason) throw new Error(`interrupted experiment requires evidence reconciliation: ${recorded.stopReason}`);
      continue;
    }
    if (existsSync(path.join(directory, "started.json"))) throw new Error(`interrupted trial requires evidence reconciliation; never redraw ${trial.id}`);
    if (firstPassCodeFingerprint() !== frozen.manifest.codeHash) throw new Error("implementation drift during live execution");
    transport.beginTrial(trial.id, trial.phase);
    immutableJson(path.join(directory, "started.json"), { trial, frozenHash: frozen.hash, startedAt: new Date().toISOString() });
    process.stdout.write(`RUN ${trial.id}\n`);
    const selectedSource = frozen.sources[trial.sourceIndex]!;
    const retrieval = resources.runtime(selectedSource.captureAlgorithmRef);
    if (!retrieval) throw new Error("captured R5 runtime missing");
    const beforeHttp = budget.summary.phases[trial.phase].httpRequests;
    const evidence = await executeFirstPassTrial({ trial, source: selectedSource, provider, retrieval });
    const stopReason = transport.stopReason ?? (budget.summary.phases[trial.phase].httpRequests === beforeHttp ? "trial ended without an actual provider send" : null);
    immutableJson(resultFile, { frozenHash: frozen.hash, evidence, hash: contentHash(evidence), budget: budget.summary, stopReason });
    process.stdout.write(`${JSON.stringify({ trial: trial.id, compilerAccepted: evidence.compilerAccepted, calls: evidence.calls.length, wallMs: evidence.wallMs, error: evidence.error, budget: budget.summary })}\n`);
    if (budget.summary.unsettled.length) throw new Error("provider usage is unknown; further live requests are blocked");
    if (stopReason) throw new Error(`experiment-incomplete: ${stopReason}`);
    if (evidence.calls.length === 0) throw new Error("trial failed before provider; investigate before continuing");
  }
  return { phase: args.phase, completed: schedule.length, budget: budget.summary, semanticEvaluation: "requires sealed intent verdicts, not just compiler acceptance" };
}

function readFirstPassWinner(root: string, frozenHash: string): "A" | "T" | "AT" {
  const { hash, ...winner } = JSON.parse(readFileSync(path.join(root, "discovery-winner.json"), "utf8"));
  if (hash !== contentHash(winner) || winner.frozenHash !== frozenHash || winner.status !== "eligible" || !["A", "T", "AT"].includes(winner.arm) ||
    !/^[0-9a-f]{64}$/u.test(winner.scoreHash)) throw new Error("confirmation requires an eligible sealed semantic winner");
  const score = JSON.parse(readFileSync(path.join(root, "scores", winner.scoreHash, "metrics.json"), "utf8"));
  if (contentHash(score) !== winner.scoreHash || score.selection?.status !== "eligible" || score.selection.arm !== winner.arm || !score.complete) throw new Error("sealed winner has no complete score evidence");
  return winner.arm;
}

function scoreFirstPass(args: FirstPassArgs) {
  const frozen = readFrozenFirstPass(args.root);
  const winner = args.phase === "confirmation" ? readFirstPassWinner(args.root, frozen.hash) : undefined;
  const schedule = firstPassSchedule(args.phase, winner);
  const verdictFile = path.join(args.root, "semantic-verdicts.jsonl");
  const verdictText = existsSync(verdictFile) ? readFileSync(verdictFile, "utf8") : "";
  if (verdictText && !verdictText.endsWith("\n")) throw new Error("incomplete semantic verdict record");
  const verdicts = verdictText.trim().split("\n").filter(Boolean).map((line) => intentVerdictSchema.parse(JSON.parse(line)));
  if (verdicts.some((verdict) => verdict.oracleHash !== frozen.manifest.oracleHash)) throw new Error("verdict belongs to another intent oracle");
  const safetyFile = path.join(args.root, "semantic-safety-review.json");
  const safetyReview = existsSync(safetyFile) ? z.strictObject({ frozenHash: z.literal(frozen.hash), verdictsHash: z.literal(contentHash(verdicts)),
    noNewProtocolFailureMechanisms: z.boolean(), findings: z.array(z.string().min(1)).min(1), reviewer: z.string().min(1) }).parse(JSON.parse(readFileSync(safetyFile, "utf8"))) : null;
  const scores: ReturnType<typeof scoreFirstPassTrial<import("../../src/engine/benchmarks/action-compilation/first-pass-protocol").FirstPassTrial>>[] = [];
  const reviewEntries = new Map<string, ReturnType<typeof firstPassReviewEntries>[number]>();
  const missing: string[] = [];
  const interrupted: Array<{ trialId: string; reason: string }> = [];
  const unknownUsage: Array<{ id: string; reason: string }> = [];
  const resultHashes: Array<{ trialId: string; hash: string }> = [];
  for (const trial of schedule) {
    const file = path.join(args.root, "trials", trial.id, "result.json");
    if (!existsSync(file)) { missing.push(trial.id); continue; }
    const recorded = JSON.parse(readFileSync(file, "utf8")) as { frozenHash: string; evidence: FirstPassTrialEvidence; hash: string; stopReason?: string | null };
    if (recorded.frozenHash !== frozen.hash || recorded.hash !== contentHash(recorded.evidence) || contentHash(recorded.evidence.trial) !== contentHash(trial)) throw new Error("trial result identity/hash drift");
    resultHashes.push({ trialId: trial.id, hash: recorded.hash });
    if (recorded.stopReason) interrupted.push({ trialId: trial.id, reason: recorded.stopReason });
    const source = frozen.sources[trial.sourceIndex]!;
    const httpRoot = path.join(args.root, "http");
    const http: FirstPassHttpEvidence[] = (existsSync(httpRoot) ? readdirSync(httpRoot) : []).filter((id) => id.startsWith(`${trial.id}-http-`)).sort().flatMap((id) => {
      const directory = path.join(httpRoot, id);
      const request = JSON.parse(readFileSync(path.join(directory, "request.json"), "utf8"));
      if (!existsSync(path.join(directory, "response.json"))) { unknownUsage.push({ id, reason: "response artifact unavailable" }); return []; }
      const response = JSON.parse(readFileSync(path.join(directory, "response.json"), "utf8"));
      if (request.id !== id || request.trial.id !== trial.id || request.bodyHash !== contentHash(request.body) || response.id !== id || response.rawHash !== contentHash(response.raw)) throw new Error("HTTP evidence checksum/identity mismatch");
      let body; let usage;
      try { body = JSON.parse(response.raw); usage = deepSeekExperimentUsage(body); }
      catch { unknownUsage.push({ id, reason: "provider usage unavailable or does not reconcile" }); return []; }
      const optionalCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
      return [{ id, ...usage, elapsedMs: response.elapsedMs,
        reasoning: optionalCount(body.usage?.completion_tokens_details?.reasoning_tokens), cacheWrite: null }];
    });
    scores.push(scoreFirstPassTrial({ evidence: recorded.evidence, source, oracleHash: frozen.manifest.oracleHash, verdicts, http }));
    for (const entry of firstPassReviewEntries(recorded.evidence, source, frozen.manifest.oracleHash)) reviewEntries.set(entry.reviewId, entry);
  }
  const budget = new ExperimentBudget(path.join(args.root, "budget.jsonl")).summary;
  const phaseBudget = budget.phases[args.phase];
  const combined = summarizeFirstPass(scores);
  const complete = !missing.length && !interrupted.length && !unknownUsage.length && !budget.unsettled.length && scores.every((score) => score.http > 0) && combined.http === phaseBudget.httpRequests && combined.tokens === phaseBudget.knownTokens;
  const groups = Object.fromEntries(AC_FP1_ARMS.filter((arm) => scores.some((score) => score.trial.arm === arm)).map((arm) => [arm, summarizeFirstPass(scores.filter((score) => score.trial.arm === arm))]));
  const strata = Object.fromEntries(AC_FP1_SOURCES.map(({ id }) => [id, Object.fromEntries(Object.keys(groups).map((arm) => [arm, summarizeFirstPass(scores.filter((score) => score.trial.arm === arm && score.trial.sourceId === id))]))]));
  const selection = complete && args.phase === "discovery" ? selectFirstPassWinner(scores, safetyReview?.noNewProtocolFailureMechanisms) : null;
  const confirmation = complete && winner ? confirmFirstPass(scores, winner, safetyReview?.noNewProtocolFailureMechanisms) : null;
  const metrics = { version: 1, frozenHash: frozen.hash, phase: args.phase, complete, missing, interrupted, unknownUsage, resultHashes, verdictsHash: contentHash(verdicts),
    safetyReview, budget, combined, groups, strata, scores, selection, confirmation, productionPromotion: false };
  const scoreHash = contentHash(metrics);
  const directory = path.join(args.root, "scores", scoreHash);
  immutableJson(path.join(directory, "metrics.json"), metrics);
  immutableJson(path.join(directory, "review-pack.json"), { oracleHash: frozen.manifest.oracleHash,
    reviewInstructions: "Use frozen/oracle.json and the exact source state. Arm, token cost and historical success are intentionally omitted. Do not treat schema acceptance or a second LLM opinion as an intent gold label. Unresolved remains unresolved.",
    entries: [...reviewEntries.values()].sort((a, b) => a.reviewId.localeCompare(b.reviewId)) });
  const report = ["# AC-FP1 experiment report", "", `Phase: ${args.phase}. Complete accounting/schedule: ${complete}.`,
    `Frozen manifest: ${frozen.hash}. Code: ${frozen.manifest.codeHash}.`, "",
    "Formal compiler acceptance is not semantic success. Unresolved intent outputs do not count as passes. All known failed-call usage remains in cost totals. If usage is unknown, the displayed token/cost sums are lower bounds, not zero-cost failed requests.", "",
    "| Arm | Batches | Formal first | Formal final | Semantic first | Unresolved outputs | Input | Output | Total | HTTP | Repair calls | P50 / P95 ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |",
    ...Object.entries(groups).map(([arm, group]) => `| ${arm} | ${group.batches} | ${group.firstFormal} | ${group.finalFormal} | ${group.firstSemantic} | ${group.unresolvedOutputs} | ${group.input} | ${group.output} | ${group.tokens} | ${group.http} | ${group.repairCalls} | ${group.p50WallMs?.toFixed(0)} / ${group.p95WallMs?.toFixed(0)} |`),
    "", `Peak-rate estimated spend (not an account statement): CNY ${(budget.estimatedPeakNanoCny / 1e9).toFixed(4)}.`,
    `Selection: ${selection?.status ?? "not evaluated"}. Confirmation: ${confirmation?.status ?? "not executed"}.`,
    `Missing scheduled trials: ${missing.length}. Unsettled sends: ${budget.unsettled.length}. Unknown usage artifacts: ${unknownUsage.length}.`, "",
    "The fixed four sources share one captured world state. Repeated requests are not additional worlds. Offline reversible-codec/mechanics tests do not establish live-world semantic realism by themselves.",
    "No production default is changed. See metrics.json for per-source counts, cache accounting, raw/normalized semantic metrics, intervals and gates; review-pack.json contains arm-blinded canonical evidence.", ""].join("\n");
  immutableExperimentText(path.join(directory, "report.md"), report);
  immutableJson(path.join(directory, "checksums.json"), { metrics: scoreHash, report: contentHash(report), reviewPack: contentHash(JSON.parse(readFileSync(path.join(directory, "review-pack.json"), "utf8"))) });
  if (selection?.status === "eligible") {
    const sealed = { frozenHash: frozen.hash, scoreHash, status: selection.status, arm: selection.arm };
    immutableJson(path.join(args.root, "discovery-winner.json"), { ...sealed, hash: contentHash(sealed) });
  }
  return { phase: args.phase, complete, directory, groups, selection: selection?.status, confirmation: confirmation?.status,
    reviewEntries: reviewEntries.size, budget, missing: missing.length };
}

export async function main(argv: readonly string[]): Promise<void> {
  const args = parseFirstPassArgs(argv);
  const unlock = lockExperiment(args.root);
  try {
    let result: unknown;
    if (args.command === "run") result = await runFirstPass(args);
    else {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => { throw new Error("AC-FP1 offline command attempted a network request"); };
      try {
        result = args.command === "score" || args.command === "report" ? scoreFirstPass(args) : args.command === "verify" ? verifyFirstPass(args.root)
          : args.command === "freeze" ? await freezeFirstPass(args.root) : await preflightFirstPass(args.root);
      } finally { globalThis.fetch = previousFetch; }
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { unlock(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
