import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { z } from "zod";
import { prepareGoalProbe } from "./step-goal-profile-probe";
import { createHash } from "node:crypto";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { ExperimentBudget } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { actionCompilationMandatoryKeys } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/runtime";
import type { ActionCompilationCapability, CandidateSelectionResult } from "../../src/engine/algorithms/roles";
import { bindGoalDiagnostic, type GoalDiagnosticSource } from "../../src/engine/benchmarks/step-efficiency/goal-profile-diagnostic";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { composeJsonObjectPrompt, discriminatorInstruction, structuredPromptBytes } from "../../src/engine/prompts";

const TRIAL = "probes-e2-source-owned-03";
const INPUT_CEILING = 350_000;
const ORDER = [2, 4, 1, 0, 3];
const DISTANCE_RULE = "travel-time location must not authorize exact duration";
const MAX_HTTP = 15;
const OFFLINE = "source-owned offline provider boundary";
const compiler = representedActionCompiler("AT", true, true, true);

export function sourceOwnedRequestHash(request: StructuredModelRequest<unknown>) {
  const bytes = structuredPromptBytes(request);
  const schema = z.toJSONSchema(request.schema, { target: "draft-07" });
  return contentHash({ profileId: request.profileId, role: request.role, system: request.system, userPrompt: request.userPrompt,
    promptVersion: request.promptVersion, schemaName: request.schemaName, context: request.context,
    schema, transportPrompt: composeJsonObjectPrompt({ userPrompt: request.userPrompt, contextJson: bytes.contextJson,
      schemaJson: JSON.stringify(schema), discriminator: discriminatorInstruction(request.schemaName) }) });
}

export function sourceScope(source: GoalDiagnosticSource, snapshotHash: string, observer?: RecordingRuntimeObserver, signal?: AbortSignal) {
  const { data, selected } = bindGoalDiagnostic(source, "P");
  return { ...source.scope, modelRegistrySnapshotHash: snapshotHash, observer, abortSignal: signal,
    runtimeIdentity: { worldHash: data.state.worldHash, revision: data.state.revision },
    actionCompilationRetrieval: { version: "frozen-goal-root-source-v1", role: "candidate-selection" as const,
      retrieveBatch: async (request: { fullContext: Readonly<Record<string, unknown>>; slotIndices: readonly number[] }) => {
        if (contentHash(request.fullContext) !== source.proof.arms.P.fullContextHash || request.slotIndices.length !== 12) {
          throw new ModelConfigurationError("frozen original root context drift or unexpected repair retrieval");
        }
        const visibleCount = data.selected.diagnostics.visibleCount;
        return { modelContext: structuredClone(data.selected.modelContext), selectedKeysBySlot: new Map(selected),
          fullContextHash: source.proof.arms.P.fullContextHash, modelContextHash: source.proof.arms.P.modelContextHash,
          shortlistHash: contentHash({ source: contentHash(source), selectedBySlot: [...selected] }),
          diagnostics: { ...data.selected.diagnostics, batchBudget: Math.min(Math.floor(visibleCount * .2), Math.ceil(visibleCount * .2) - 1),
            batchShortlistRatio: data.selected.diagnostics.selectedCount / visibleCount, prunedReferenceCount: 0, budgetExceeded: false,
            anchorCount: new Set([...selected.keys()].flatMap((slot) => actionCompilationMandatoryKeys(request.fullContext, slot))).size,
            perSlotSelectedCount: Object.fromEntries([...selected].map(([slot, keys]) => [String(slot), keys.length])),
            // Selection was prepared with the real retriever. This run reuses
            // it and must not report the preparation's encoder cache counts.
            cache: { passageHits: 0, passageMisses: 0, queryHits: 0, queryMisses: 0, readMs: 0,
              passageEncodeMs: 0, queryEncodeMs: 0, queryBatchSize: 0 } },
        } satisfies CandidateSelectionResult;
      },
    },
  };
}

export async function prepareSourceOwnedProbe() {
  const design = prepareGoalProbe("variants/finite-work-goal-02");
  const binding = JSON.parse(readFileSync(path.join(design.variant, "implementation-binding.json"), "utf8"));
  const hashFile = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (hashFile(path.join(design.variant, "manifest.json")) !== binding.preparedManifestFileSha256 ||
    hashFile(path.resolve("src/engine/mechanics/temporal-evidence.ts")) !== binding.temporalEvidenceFileSha256) throw new Error("distance correction source binding drift");
  const history = JSON.parse(readFileSync(path.join(design.root, "runs/trajectory-e2-02/manifest.json"), "utf8"));
  if (history.catalogHash !== design.catalog.hash) throw new Error("frozen nonthinking catalog drift");
  const registry = new ModelRegistry(design.catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh over network"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const roots = [];
  for (const index of ORDER) {
    const item = design.sources[index]!, source = item.source;
    const binding = resolveModelProfile(design.catalog, snapshot, source.profileId);
    if (binding.accountId !== "deepseek-api" || binding.modelId !== STEP_E2_PROTOCOL.model || binding.profile.inference.thinking !== "disabled" ||
      binding.profile.max_output_tokens !== STEP_E2_PROTOCOL.outputTokenCeiling) throw new Error("nonthinking source model binding drift");
    const captured: StructuredModelRequest<unknown>[] = [];
    const offline: StructuredModelProvider = { catalog: design.catalog, availableProfileSummaries: () => [], assertProfilesAvailable: async () => undefined,
      generateStructured: async (request) => { captured.push(request);throw new ModelConfigurationError(OFFLINE); } };
    try { await compiler(offline, source.arms.P.state, source.actions, sourceScope(source, snapshot.hash), source.profileId, 12); }
    catch (error) { if (!(error instanceof ModelConfigurationError) || error.message !== OFFLINE) throw error; }
    if (captured.length !== 1) throw new Error("offline root did not reach exactly one real compiler provider boundary");
    const request = captured[0]!, bytes = structuredPromptBytes(request);
    if (bytes.requestUtf8Bytes + 8192 > INPUT_CEILING) throw new Error("complete root request exceeds conservative token reservation");
    const labels = [...item.labels];
    if (index === 2) {
      const action = source.actions.find((action) => action.actorId === "sigrun-the-boneless");
      if (!action?.rawText.includes("半天路程")) throw new Error("recorded distance counterexample drift");
      labels.push({ actionId: action.id, actionHash: contentHash(action), quote: "半天路程", requirement: DISTANCE_RULE });
    }
    roots.push({ index, sourceHash: contentHash(source), actionsHash: source.proof.actionsHash,
      stateHash: source.proof.arms.P.stateHash, rootContextHash: source.proof.arms.P.fullContextHash,
      requestHash: sourceOwnedRequestHash(request), requestUtf8Bytes: bytes.requestUtf8Bytes, labels,
      model: { profileId: source.profileId, modelId: binding.modelId, inference: binding.profile.inference,
        metadataHash: binding.modelMetadataHash } });
  }
  const manifest = { trialId: TRIAL, kind: "profile-choice-admission", roots, order: ORDER,
    pricingReviewHash: contentHash(JSON.parse(readFileSync(path.join(design.root, "evidence/pricing-20260908/review.json"), "utf8"))),
    implementationBindingHash: contentHash(binding),
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    sourcePreparationHash: contentHash(design.manifest), registrySnapshotHash: snapshot.hash, catalogHash: design.catalog.hash,
    treatment: { representation: "AT", eligibleProfilesOnly: true, sourceOwnedDescription: true, profileChoiceEvidence: "visible-schema-v1", exactRequestCardinality: true, generatedCompilationExample: false, frozenRootSelection: true,
      worldVariant: "finite-work-goal-02", maxSlots: 12, maxRepairs: 2, exhaustion: "fail-step", thinking: "disabled" },
    inputTokenCeiling: INPUT_CEILING, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, maxHttp: MAX_HTTP,
    maximumRunNanoCny: MAX_HTTP * (INPUT_CEILING * 3520 + STEP_E2_PROTOCOL.outputTokenCeiling * 10560),
    acceptance: "Five new complete12-action samples through the actual compiler and gateway, order2,4,1,0,3 fixed before dispatch. Sources0-3 are48 original actions;source4 is12 synthetic brief-act controls. Preserve exact source descriptions, state and candidate selection; pass every existing source-bound compound-task exclusion and the corrected spatial-duration exclusion. Controls must remain brief. All requests use thinking disabled,maxRepairs2,fail-step;max15 HTTP and the full conservative reservation must fit before starting. Stop after the first failed root,unknown billing,drift or cap;never restart. No historical replay counts as a fresh sample. The intervention includes exact batch cardinality,omission of generated examples,and an opt-in schema layout repeating visible temporal profile evidence. It does not isolate those components or establish paired efficacy/full semantic correctness. Actual WorldHost commits,source review,durable replay and fresh confirmation remain required.",
  };
  return { design, registry, snapshot, manifest };
}

type OriginalPreparation = Awaited<ReturnType<typeof prepareSourceOwnedProbe>>;
export type PreparedCompilationProbe = {
  design: Pick<OriginalPreparation["design"], "root" | "catalog"> & { sources: Array<{ source: GoalDiagnosticSource }> };
  registry: OriginalPreparation["registry"];
  snapshot: OriginalPreparation["snapshot"];
  manifest: Pick<OriginalPreparation["manifest"], "roots" | "trialId" | "inputTokenCeiling" | "maxHttp" | "maximumRunNanoCny"> & Record<string, unknown>;
};

export async function runPreparedCompilationProbe(prepared: PreparedCompilationProbe, compile: ActionCompilationCapability = compiler) {
  const { design, registry, snapshot, manifest } = prepared;
  const trial = manifest.trialId, inputCeiling = manifest.inputTokenCeiling, maxHttp = manifest.maxHttp;
  if (!/^probes-e2-[a-z0-9-]+$/u.test(trial) || !Number.isSafeInteger(maxHttp) || maxHttp < 1 ||
    !Number.isSafeInteger(inputCeiling) || inputCeiling < 1 ||
    manifest.maximumRunNanoCny !== maxHttp * (inputCeiling * 3520 + STEP_E2_PROTOCOL.outputTokenCeiling * 10560)) throw new Error("invalid frozen compilation probe limits");
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid experiment");
  const directory = path.join(design.root, "runs", trial), lock = path.join(design.root, "writer.lock");
  if (existsSync(directory)) throw new Error("source-owned trial cannot restart");
  closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, dispatches = 0, rootDispatches = 0;
  const controller = new AbortController(), rows: unknown[] = [], connections: unknown[] = [];
  const stop = () => controller.abort(new Error("operator stopped source-owned diagnostic"));
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...manifest, status, failure, rows,
    dispatches, updatedAt: new Date().toISOString(), budget: budget?.summary, connections }, null, 2));
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  try {
    mkdirSync(directory, { recursive: true });
    budget = new ExperimentBudget(path.join(design.root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = budget.summary.phaseBudgets!.find((group) => group.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || used + budget.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete diagnostic budget or billing gate failed");
    const account = design.catalog.account("deepseek-api");
    if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env, { onConnectionEvent: (event) => connections.push(event) })("deepseek-api", account)!;
    const transport = new FirstPassExperimentTransport(budget, { root: design.root, baseUrl: account.base_url, fetch: send,
      inputTokenCeiling: inputCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling, requireThinkingDisabled: true,
      endpointPaths: ["/chat/completions"], trialPattern: new RegExp(`^${trial}$`, "u"),
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    const provider = createModelGateway(design.catalog, process.env, { maxTransportAttempts: 1,
      registry: { catalog: design.catalog, capture: async (hash) => {
        if (hash && hash !== snapshot.hash) throw new ModelConfigurationError("registry snapshot drift");return snapshot;
      }, refresh: (options) => registry.refresh(options), status: () => registry.status() },
      fetchForAccount: (id) => async (input, init) => {
        if (id !== "deepseek-api" || dispatches >= maxHttp || rootDispatches >= 3) throw new ModelConfigurationError("source-owned HTTP account or call cap");
        const request = new Request(input instanceof Request ? input.clone() : input, init);
        controller.signal.throwIfAborted();
        if (Buffer.byteLength(await request.clone().text(), "utf8") + 8192 > inputCeiling) throw new ModelConfigurationError("actual request exceeds conservative token reservation");
        dispatches++;rootDispatches++;
        return transport.fetch(input, { ...init, signal: AbortSignal.any([request.signal, controller.signal, AbortSignal.timeout(300_000)]) });
      },
    });
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim() }, null, 2), { flag: "wx" });
    transport.beginTrial(trial, "probes");status = "running";report();
    for (const frozen of manifest.roots) {
      controller.signal.throwIfAborted();
      rootDispatches = 0;
      const item = design.sources[frozen.index]!, source = item.source, observer = new RecordingRuntimeObserver({ mode: "full" });
      let modelCalls = 0, result, error: string | undefined;
      const started = performance.now(), beforeCost = budget.summary.estimatedPeakNanoCny;
      const bound: StructuredModelProvider = { catalog: provider.catalog,
        availableProfileSummaries: (role) => provider.availableProfileSummaries(role), assertProfilesAvailable: (ids) => provider.assertProfilesAvailable(ids),
        generateStructured: (request) => {
          if (++modelCalls > 3 || request.profileId !== source.profileId || request.role !== "action-compilation") throw new ModelConfigurationError("source-owned logical call drift");
          if (modelCalls === 1 && sourceOwnedRequestHash(request) !== frozen.requestHash) throw new ModelConfigurationError("frozen root request drift");
          return provider.generateStructured(request);
        },
      };
      try { result = await compile(bound, source.arms.P.state, source.actions,
        sourceScope(source, snapshot.hash, observer, controller.signal), source.profileId, 12); }
      catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
      const plans = result?.compilations.map((entry) => entry.plan) ?? [];
      const violations = frozen.labels.flatMap((label) => {
        const plan = plans.find((plan) => plan.actionId === label.actionId);
        const brief = plan?.mode === "fixed" && plan.completionAtSeconds !== null && plan.completionAtSeconds - plan.startsAtSeconds <= 10;
        const violated = label.requirement === DISTANCE_RULE ? plan?.basis.kind === "explicit_duration"
          : label.requirement === "finite investigation without a source prerequisite must not gain continuation assertions" ? Boolean(plan?.continuationAssertions.length)
          : frozen.index === 4 ? !brief : brief;
        return !plan || violated ? [{ ...label, reason: !plan ? "no materialized plan" : "temporal exclusion violated" }] : [];
      });
      const sourceTextPreserved = plans.length === 12 && plans.every((plan) => plan.description === source.actions.find((action) => action.id === plan.actionId)?.rawText);
      const stateUnchanged = contentHash(source.arms.P.state) === frozen.stateHash;
      const row = { source: frozen.index, formalPassed: Boolean(result), sourceTextPreserved, stateUnchanged, violations,
        diagnosticPassed: Boolean(result) && sourceTextPreserved && stateUnchanged && violations.length === 0,
        modelCalls, httpCalls: rootDispatches, elapsedMs: performance.now() - started,
        peakNanoCny: budget.summary.estimatedPeakNanoCny - beforeCost, plans, metrics: result?.metrics,
        error, fullSemantics: "unassessed" };
      writeFileSync(path.join(directory, `source-${frozen.index}.json.gz`), gzipSync(JSON.stringify({ row, result, events: observer.events })), { flag: "wx" });
      rows.push(row);report();console.log(JSON.stringify({ ...row, plans: undefined, error: error?.slice(0, 500) }));
      if (!row.diagnosticPassed) throw new Error("source-owned functional admission failed; no next root");
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { report();registry.stopBackgroundRefresh();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId: trial, status, failure, completed: rows.length, dispatches }));
}
async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-source-owned-probe.ts [prepare]");
  const prepared = await prepareSourceOwnedProbe();
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(prepared.manifest, null, 2));return; }
  await runPreparedCompilationProbe(prepared);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
