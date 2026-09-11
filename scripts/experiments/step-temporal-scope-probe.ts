import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { bindTemporalExclusions, scoreTemporalDiagnostic, temporalDiagnosticBody, temporalProbeBodySchema, temporalProbeContext,
  type TemporalExclusion } from "../../src/engine/benchmarks/step-efficiency/temporal-diagnostic";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { loadPromptAsset } from "../../src/engine/prompts";
import { SemanticProfileSelectors, semanticProfileDiagnosticBody, scoreSemanticProfileDiagnostic } from "../../src/engine/benchmarks/step-efficiency/semantic-profile-selectors";
import { coherentTemporalDiagnosticBody } from "../../src/engine/benchmarks/step-efficiency/action-compilation-coherence";
import { referenceDiagnosticBody } from "../../src/engine/benchmarks/step-efficiency/reference-diagnostic";

import { ActionOnsetFacts, scoreActionOnsetFacts } from "../../src/engine/benchmarks/step-efficiency/action-onset-facts";
import { shortlistEvidenceBody } from "../../src/engine/benchmarks/step-efficiency/shortlist-evidence";
import { rereadActionBody } from "../../src/engine/benchmarks/step-efficiency/action-rereading";

const TRIAL = "probes-e2-temporal-scope-01";
const ACCEPTANCE = "Diagnostic only: P must remove both unsupported brief cross-location completion profiles on every repeat, improve on B unless B already removes both, and have >=11/12 schema/reference-valid batches with no regression against B. Passing permits controlled behavior tests, never production promotion or full semantic certification. Other temporal interpretations remain unlabelled.";

export function temporalScopeProbeDesign(kind: "scope" | "references" | "layout" | "semantic" | "reread" | "evidence" | "facts" | "contracts" = "scope") {
  const usesFacts = kind === "facts" || kind === "contracts";
  const freshSource = kind === "reread" || kind === "evidence" || usesFacts;
  const trialId = kind === "contracts" ? "probes-e2-temporal-contracts-01" : kind === "facts" ? "probes-e2-actor-onset-facts-01" : kind === "evidence" ? "probes-e2-shortlist-evidence-01" : kind === "reread" ? "probes-e2-action-reread-01" : kind === "scope" ? TRIAL : kind === "semantic" ? "probes-e2-semantic-profile-01" : kind === "layout" ? "probes-e2-action-layout-01" : "probes-e2-reference-scope-01";
  const arms = kind === "scope" || kind === "semantic" || freshSource ? ["B", "P"] as const : kind === "layout" ? ["B", "P", "A"] as const : ["B", "P", "A", "AP"] as const;
  const inputTokenCeiling = freshSource ? 350_000 : kind === "scope" ? STEP_E2_PROTOCOL.inputTokenCeiling : kind === "layout" || kind === "semantic" ? 310_000 : 300_000;
  const clarification = loadPromptAsset("shared/action-completion-scope.md");
  const sources = (kind === "contracts" ? ["010", "007", "008", "009"] : ["007", "008", "009", "010"]).map((ordinal) => {
    const id = `${freshSource ? "trajectory-e2-01" : "trajectory-e1-15"}-http-${ordinal}`;
    const evidence = JSON.parse(readFileSync(path.join(freshSource ? STEP_E2_PROTOCOL.root : STEP_E2_PROTOCOL.sourceRoot, "http", id, "request.json"), "utf8"));
    if (contentHash(evidence.body) !== evidence.bodyHash) throw new Error("source HTTP hash mismatch");
    const original = temporalProbeBodySchema.parse(evidence.body);
    const body = temporalDiagnosticBody(original), context = temporalProbeContext(body);
    if (context.task.slots.length !== 12 || new Set(context.task.slots.map((slot) => slot.slot)).size !== 12) throw new Error("full 12-slot batch required");
    const exclusions: TemporalExclusion[] = ordinal !== "010" ? [] : (freshSource ? [
      { slot: 0, quote: "骑马去 Blackoak 找 Sinerian", reason: "Full personal preparation and travel cannot collapse into a completed short announcement." },
      { slot: 2, quote: "再走一遍西南下风坡", reason: "A route survey with marking and returning to write instructions cannot collapse into one short interaction." },
      { slot: 3, quote: "按年排成表，先找出可重复的规律", reason: "Record preparation and analysis must not be assumed already done before selecting only the final oral interaction." },
    ] : [
      { slot: 0, quote: "再带上这份逐户清单去 Blackoak 见 Sinerian", reason: "Personal record preparation and travel from Ashdown to Blackoak cannot be replaced by announcing the task." },
      { slot: 3, quote: "然后带着这份记录去和 Wizard 谈一次明确的界限", reason: "Personal preparation and travel from Azure Hall to Wizard cannot be replaced by announcing the task." },
    ]).map((entry) => ({ slot: entry.slot, actionHash: contentHash(context.task.slots.find((slot) => slot.slot === entry.slot)!.action),
      sourceQuote: entry.quote, rationale: entry.reason,
      forbiddenProfileKeys: context.referenceCatalog.candidates.filter((candidate) => candidate.kind === "temporal_profile" &&
        candidate.details?.kind === "fixed" && typeof candidate.details.durationSeconds === "number" && candidate.details.durationSeconds <= 10)
        .map((candidate) => candidate.candidateKey),
    }));
    bindTemporalExclusions(context, exclusions);
    const treatment = temporalDiagnosticBody(original, clarification);
    const coherent = kind === "semantic" || kind === "reread" || usesFacts ? coherentTemporalDiagnosticBody(original, false) : undefined;
    const bodies = { B: coherent ?? body, P: kind === "reread" ? rereadActionBody(coherent!) : coherent ? semanticProfileDiagnosticBody(coherent) : kind === "layout" ? coherentTemporalDiagnosticBody(original, false) : treatment, A: kind === "layout" ? coherentTemporalDiagnosticBody(original, true) : referenceDiagnosticBody(original, "AT"),
      AP: referenceDiagnosticBody(original, "AT", clarification) };
    let evidenceBinding: Record<string, unknown> | undefined;
    let onset: { codec: ActionOnsetFacts; context: ReturnType<typeof temporalProbeContext>; wireSchema: ReturnType<ActionOnsetFacts["body"]>["wireSchema"] } | undefined;
    if (kind === "evidence" || usesFacts) {
      const captured = JSON.parse(readFileSync(path.join(STEP_E2_PROTOCOL.root, "evidence/shortlist-pruning-01", `${ordinal}.json`), "utf8"));
      const capture = captured.capture;
      if (contentHash(capture) !== captured.artifactHash || contentHash(capture.fullContext) !== capture.fullContextHash ||
        contentHash(capture.stateSnapshot) !== capture.stateHash) throw new Error("Ledger source evidence hash mismatch");
      const restored = shortlistEvidenceBody(usesFacts ? coherent! : body, capture.fullContext, capture.modelContextHash);
      bodies.B = body; bodies.P = restored.body;
      if (usesFacts) {
        bodies.B = restored.body;
        const onsetContext = temporalProbeContext(restored.body), codec = new ActionOnsetFacts(onsetContext, capture.fullContext, capture.stateHash);
        const encoded = codec.body(restored.body); bodies.P = encoded.body;
        onset = { codec, context: onsetContext, wireSchema: encoded.wireSchema };
        if (kind === "contracts") { bodies.B = encoded.body; bodies.P = semanticProfileDiagnosticBody(encoded.body, "execution_contract"); }
      }
      evidenceBinding = { invocationId: captured.invocationId, sequence: captured.sequence, artifactHash: captured.artifactHash,
        fullContextHash: capture.fullContextHash, stateHash: capture.stateHash, selectedSourceHash: restored.selectedSourceHash,
        restoredReferenceCount: restored.restoredReferenceCount,
        ...(onset ? { onsetContextHash: onset.codec.contextHash, onsetFactsHash: contentHash(onset.codec.facts), onsetFactCount: onset.codec.facts.length } : {}) };
    }
    if (kind !== "scope" && Object.values(bodies).some((value) => Buffer.byteLength(JSON.stringify(value), "utf8") + 8192 > inputTokenCeiling)) {
      throw new Error("frozen complete request exceeds conservative byte-based reservation");
    }
    return { onset, evidenceBinding, id, originalHash: evidence.bodyHash as string, body, context, exclusions, treatment, bodies };
  });
  const order = sources.flatMap((source) => Array.from({ length: 3 }, (_, repetition) =>
    arms.map((arm) => ({ source: source.id, repetition, arm })).sort((a, b) =>
      contentHash({ seed: STEP_E2_PROTOCOL.seed, ...a }).localeCompare(contentHash({ seed: STEP_E2_PROTOCOL.seed, ...b }))))).flat();
  const maximumRunNanoCny = order.length * (inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken +
    STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken);
  return { sources, order, manifest: { trialId, order, inputTokenCeiling,
    acceptance: kind === "contracts" ? "Four unchanged full source batches of 12 actions, B/P each three repeats, 24 HTTP in fixed interleaved order, with the known source-scope diagnostic block first for prospective early stopping. Both arms use the experimental coherent T + shortlist evidence + actor-onset-fact representation from e4d58fd. The only P change is reversible temporal-profile selector spelling derived from authored execution mechanics: whole-action fixed totals, conditional success checkpoints, ongoing checkpoints without automatic completion, authored staged totals, or quantity/explicit-duration evidence. Original profile names, all mechanics, candidate scope, actions and output fields remain intact after exact inverse mapping. P must have >=9/12 formal/reference-valid batches and no regression against B; all three source-bound short/instant exclusions must hold on all targeted repeats, with an improvement over B unless B already passes all. Total tokens and mean HTTP latency <=1.10B. Wrong scope, any definite new semantic violation or indiscriminate long-profile selection vetoes admission. Passing still requires grounded short-action controls and independently reviewed full-world trajectories before gameplay acceptance. Stop once remaining repetitions cannot meet the frozen admission gate; settle in-flight usage and retain partial evidence." : kind === "facts" ? "Fresh four full 12-action batches, B/P each three repetitions, 24 actual HTTP. Both arms use coherent T instructions and the source-bound shortlist evidence representation from d841861, still experimental. P adds source-bound per-slot current-actor-active fact selectors as an optional shorter form of existing continuation assertions; original arbitrary assertions remain legal. No new reasoning field, stronger model, batch reduction, critic or repair. P must reach >=11/12 formal/reference-valid batches without regression against B; all three original-action short/instant exclusions must pass on all targeted repetitions. Total tokens and mean HTTP latency each <=1.10B. All-same-long-profile behavior, wrong slot/snapshot selection, changed intent, or any definite source-scope violation veto admission. Source-bound review and a separately grounded short-action control remain required before any full-world candidate is frozen. This only tests a syntax-burden hypothesis and does not itself prove gameplay or semantic correctness." : kind === "evidence" ? "Four fresh full-world source batches of 12, B/P each three repeats, 24 HTTP in frozen interleaved order. B is the recorded T request. P restores exact selected candidate facts from hash-bound pre-pruning Ledger context; out-of-shortlist references become non-selectable typed snapshot evidence, preserving identity, labels, scope and actual null/array values. Selectable keys, slots, actions, output schema and generation settings stay fixed. Exact inverse proof and source hash binding are mandatory. Admission to controlled full-world testing requires at least as many formal/reference-valid batches as B, no snapshot key/object accepted as an output reference, no regression in source-scope exclusions, total tokens <=1.10B and mean HTTP latency <=1.10B. Independently review all 48 source actions across P outputs for newly introduced definite semantic violations; any violation vetoes admission. This repairs a demonstrated input defect, does not claim complete action semantics, and does not waive source-bound trajectory vetoes or fresh confirmation." : kind === "reread" ? "Fresh full-world source batches from trajectory-e2-01, four batches of 12 actions, B/P each three repeats (24 HTTP). B uses coherent T and full-scope instructions; P only repeats identical complete action records at the end of the input (RE2-inspired), without rewriting, adding output fields, or thinking. P must have >=11/12 formal/reference-valid batches with no regression against B; all three full-scope short/instant exclusions must hold on every targeted repetition. No short-action gold label is assigned: canonical inspection found the apparent sealed-index control requires cross-location interpretation; a separate grounded short-action control and independent semantic review are mandatory before admission. P must improve exclusions unless B already passes all, with total tokens <=1.10B and mean HTTP latency <=1.10B. Passing permits independent source-bound review and controlled execution only, not production or gameplay certification. No extra planner, voting, repair or resampling." : kind === "semantic" ? "B=coherent T instruction/scope candidate from the prior failed trial; P=B with reversible request-local temporal selectors containing existing visible profile names. Only typed profile keys and their schema enums change, with matching key-copy instructions. Profile definitions, eligibility, actions, context values and candidate scope are preserved after inverse mapping. P must achieve >=11/12 schema/reference-valid batches with no regression against B and exclude both known false brief completions on all 3 targeted repeats, improving over B unless B already passes all. Report total tokens, actual HTTP and cold/warm cache costs; total tokens must be <=1.10B. Passing admits only independent world-behavior validation, not gameplay acceptance; scope preservation and appropriate short-action controls require source review. Unknown aliases, raw canonical keys, changed root identities or repair contexts fail rather than being guessed." : kind === "layout" ? "B=original T; P=T with coherent nonempty user instruction and full-action scope clarification that separates valid-execution guards from completion; A=P plus reversible action/profile context layout. Schema, candidate set, slots, actions, generation settings and maximum HTTP remain unchanged. P or A must achieve >=11/12 schema/reference-valid batches with no regression against B, and exclude both known false brief completions on all 3 targeted repeats with improvement over B unless B already excludes all. Report P-B as combined instruction repair and A-P as pure layout effect. An admitted candidate proceeds only to independent world-behavior validation, not production or semantic certification. Choose by valid batches, exclusions, tokens, then fixed P/A order; no passing candidate means stop this trial." : kind === "scope" ? ACCEPTANCE : "Frozen 2x2 diagnostic: B=T, P=T+scope, A=AT, AP=AT+scope. A candidate must pass source-bound exclusions on all 3 targeted repeats and >=11/12 schema/reference batches, with no schema/reference regression against B and more exclusion passes than B unless B passes all. For the alias factor, report A-B and AP-P; an alias gain requires >=2 additional valid batches unless its matched T arm is already 12/12. Rank eligible candidates by valid batch count, exclusion passes, total tokens, HTTP count, then fixed A/P/AP order. At most one candidate advances to independent controlled world-behavior validation; no production promotion or semantic certification. Cache cold/warm costs remain separate.",
    reservationBasis: kind !== "scope" ? "Every complete serialized request plus 8192 bytes is below the declared inputTokenCeiling; reserve one input token per byte plus overhead, retaining the provider's unchanged context/output settings." : "model context maximum",
    maxHttp: order.length, maximumRunNanoCny, clarificationHash: contentHash(clarification),
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    sources: sources.map(({ id, originalHash, body, context, exclusions, treatment, bodies, evidenceBinding }) => ({ id, originalHash,
      evidenceBinding, bodyHash: contentHash(body), treatmentHash: contentHash(treatment), contextHash: contentHash(context), exclusions,
      arms: Object.fromEntries(arms.map((arm) => [arm, { bodyHash: contentHash(bodies[arm]), requestBytes: Buffer.byteLength(JSON.stringify(bodies[arm]), "utf8") }])),
      limitation: "Independent source-bound rejection diagnostic, not a complete or uniquely correct temporal label. State-effect verification remains required." })),
  } };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "prepare" && arg !== "references" && arg !== "layout" && arg !== "semantic" && arg !== "reread" && arg !== "evidence" && arg !== "facts" && arg !== "contracts") || new Set(args).size !== args.length) throw new Error("usage: step-temporal-scope-probe.ts [references|layout|semantic|reread|evidence|facts|contracts] [prepare]");
  if (args.filter((arg) => arg !== "prepare").length > 1) throw new Error("choose one frozen design");
  const kind = args.includes("contracts") ? "contracts" : args.includes("facts") ? "facts" : args.includes("evidence") ? "evidence" : args.includes("reread") ? "reread" : args.includes("semantic") ? "semantic" : args.includes("layout") ? "layout" : args.includes("references") ? "references" : "scope";
  const design = temporalScopeProbeDesign(kind);
  const trialId = design.manifest.trialId;
  if (args.includes("prepare")) { console.log(JSON.stringify(design.manifest, null, 2));return; }
  if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked work before paid probe");
  const root = path.resolve(STEP_E2_PROTOCOL.root), directory = path.join(root, "runs", trialId);
  if (existsSync(directory)) throw new Error("frozen trial cannot restart");
  const catalog = loadModelCatalog(path.join(STEP_E2_PROTOCOL.sourceRoot, "variants/shared-inventory-observation-v6/model-catalog.json"));
  const account = catalog.account("deepseek-api");
  const credential = process.env[account.api_key_env];
  if (!credential) throw new Error("configured DeepSeek credential unavailable");
  const connectionEvents: unknown[] = [];
  const send = createModelFetchResolver(process.env, { onConnectionEvent: (event) => connectionEvents.push(event) })("deepseek-api", account)!;
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, "writer.lock");closeSync(openSync(lock, "wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false;
  const rows: unknown[] = [], stop = () => { stopped = true; };
  let treatmentFormalFailures = 0;
  process.on("SIGINT", stop);process.on("SIGTERM", stop);
  const report = () => writeFileSync(path.join(directory, "report.json"), JSON.stringify({ ...design.manifest, status, failure,
    updatedAt: new Date().toISOString(), rows, connectionEvents, budget: budget?.summary }, null, 2));
  try {
    mkdirSync(directory, { recursive: true });
    budget = new ExperimentBudget(path.join(root, "budget.jsonl"), STEP_E2_BUDGET);
    const phase = STEP_E2_BUDGET.phaseBudgets!.find((group) => group.phases.includes("probes"))!;
    const prior = phase.phases.reduce((sum, name) => sum + budget!.summary.phases[name].estimatedPeakNanoCny, 0);
    if (budget.summary.blockingUnknown.length || prior + design.manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      design.manifest.maximumRunNanoCny + budget.summary.estimatedPeakNanoCny + budget.summary.reservedNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("full trial reservation or unresolved billing blocks probe");
    writeFileSync(path.join(directory, "manifest.json"), JSON.stringify({ ...design.manifest,
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), accountCatalogHash: catalog.hash }, null, 2), { flag: "wx" });
    const transport = new FirstPassExperimentTransport(budget, { root, baseUrl: account.base_url, fetch: send,
      inputTokenCeiling: design.manifest.inputTokenCeiling, outputTokenCeiling: STEP_E2_PROTOCOL.outputTokenCeiling,
      endpointPaths: ["/chat/completions"], trialPattern: /^probes-e2-(temporal-scope|reference-scope|action-layout|semantic-profile|action-reread|shortlist-evidence|actor-onset-facts|temporal-contracts)-01$/u, requireThinkingDisabled: true,
      priceBinding: { accountId: "deepseek-api", modelId: STEP_E2_PROTOCOL.model, priceId: "flash" } });
    transport.beginTrial(trialId, "probes");status = "running";report();
    for (const row of design.order) {
      if (stopped) throw new Error("operator stopped; no next request");
      const source = design.sources.find((entry) => entry.id === row.source)!;
      const started = performance.now();
      const response = await transport.fetch(`${account.base_url}/chat/completions`, { method: "POST",
        headers: { authorization: `Bearer ${credential}`, "content-type": "application/json" },
        body: JSON.stringify(source.bodies[row.arm]), signal: AbortSignal.timeout(300_000) });
      const raw = await response.json(), usage = deepSeekExperimentUsage(raw), output = raw.choices?.[0]?.message?.content;
      const result = { ...row, usage, elapsedMs: performance.now() - started,
        peakNanoCny: (usage.input - usage.cacheHit) * 3520 + usage.cacheHit * 112 + usage.output * 10560,
        ...((kind === "facts" || kind === "contracts") && (row.arm === "P" || kind === "contracts") ? scoreActionOnsetFacts(typeof output === "string" ? output : "", source.onset!.codec, source.onset!.wireSchema, source.onset!.context, source.exclusions, kind === "contracts" && row.arm === "P" ? (raw) => new SemanticProfileSelectors(source.onset!.context, "execution_contract").output(raw) : undefined) : kind === "semantic" && row.arm === "P" ? scoreSemanticProfileDiagnostic(typeof output === "string" ? output : "", source.context, source.exclusions) : scoreTemporalDiagnostic(typeof output === "string" ? output : "", source.context, source.exclusions, kind === "references" && (row.arm === "A" || row.arm === "AP") ? "AT" : "T")) };
      rows.push(result);report();console.log(JSON.stringify({ ...result, selectedProfiles: undefined, error: result.error?.slice(0, 250) }));
      if (kind === "contracts" && row.arm === "P") {
        if (!result.schemaAndReferences) treatmentFormalFailures += 1;
        if (treatmentFormalFailures > 3 || (result.checkedActions > 0 && !result.excludedCompletionPassed)) {
          throw new Error("frozen contract admission gate is unattainable; no next request");
        }
      }
    }
    status = "completed";
  } catch (error) { status = "stopped";failure = error instanceof Error ? error.message : String(error); }
  finally { report();process.off("SIGINT", stop);process.off("SIGTERM", stop);unlinkSync(lock); }
  console.log(JSON.stringify({ trialId, status, failure, completed: rows.length }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
