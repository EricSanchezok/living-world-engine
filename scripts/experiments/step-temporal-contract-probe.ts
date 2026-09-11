import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { validateActionCompilationCapturedSource } from "../../src/engine/benchmarks/source-capture";
import type { GoalDiagnosticSource } from "../../src/engine/benchmarks/step-efficiency/goal-profile-diagnostic";
import type { SimulationState } from "../../src/engine/contracts/model";
import { shortlistEvidenceContext } from "../../src/engine/algorithms/eager-reference/candidate-retrieval/shortlist-evidence";
import { representedActionCompiler } from "../../src/engine/algorithms/eager-reference/represented-action-compiler";
import { structuredPromptBytes } from "../../src/engine/prompts";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { prepareSourceOwnedProbe, runPreparedCompilationProbe, sourceOwnedRequestHash, sourceScope, type PreparedCompilationProbe } from "./step-source-owned-probe";

const TRIAL = "probes-e2-temporal-contract-01";
const compiler = representedActionCompiler("AT", true, true, true, true);
const STOP = "named temporal offline provider boundary";
const ORDER = [3, 4, 0, 1, 2];

export async function prepareTemporalContractProbe(): Promise<PreparedCompilationProbe> {
  const base = await prepareSourceOwnedProbe();
  const file = path.join(base.design.root, "evidence/temporal-contract-01/source-events.json");
  const events = JSON.parse(readFileSync(file, "utf8")) as Array<{ sequence: number; payload: Record<string, unknown> }>;
  const captures = events.filter((event) => Array.isArray(event.payload.actions) && event.payload.actions.length === 12);
  if (captures.length !== 4) throw new Error("named temporal diagnostic requires all four original complete roots");
  const sources = captures.map((event, index) => {
    const raw = validateActionCompilationCapturedSource(event.payload);
    if (raw.sourceExecutionId !== "2aeea4a2-88ef-4f12-8f3e-84389a3d3cac" || raw.registrySnapshotHash !== base.snapshot.hash ||
      raw.modelCatalogHash !== base.design.catalog.hash || raw.profileId !== "truth-deepseek" || raw.modelId !== STEP_E2_PROTOCOL.model) throw new Error("fresh source provenance drift");
    const selectedKeysBySlot = event.payload.selectedKeysBySlot as Array<[number, string[]]>;
    const selectedSet = new Set(selectedKeysBySlot.flatMap(([, keys]) => keys));
    const keys = (raw.fullContext.referenceCatalog as { candidates: Array<{ candidateKey: string }> }).candidates
      .map((candidate) => candidate.candidateKey).filter((key) => selectedSet.has(key));
    const selectedContext = shortlistEvidenceContext(raw.fullContext, keys).context;
    if (contentHash(selectedContext) !== raw.modelContextHash) throw new Error("fresh shortlist evidence drift");
    const execution = raw.fullContext.execution as { instanceId: string; advanceId: string };
    const data = { state: raw.stateSnapshot as SimulationState, fullContext: raw.fullContext,
      selected: { modelContext: selectedContext, selectedKeysBySlot,
        diagnostics: { selectedCount: keys.length,
          visibleCount: (raw.fullContext.referenceCatalog as { candidates: unknown[] }).candidates.length } } };
    const proof = { stateHash: raw.stateHash, fullContextHash: raw.fullContextHash, modelContextHash: raw.modelContextHash! };
    const source: GoalDiagnosticSource = { actions: raw.actions, profileId: raw.profileId,
      scope: { workloadId: execution.instanceId, batchId: execution.advanceId },
      proof: { index, kind: "recorded-full-world-root", actionsHash: contentHash(raw.actions), arms: { B: proof, P: proof } },
      arms: { B: data, P: data } };
    return { source };
  });
  if (!sources[3]!.source.actions.some((action) => action.actorId === "player") ||
    !sources[3]!.source.actions.some((action) => action.actorId === "scytheback")) throw new Error("counterexample root order drift");
  sources.push({ source: base.design.sources[4]!.source });
  const roots: PreparedCompilationProbe["manifest"]["roots"] = [];
  for (const index of ORDER) {
    const source = sources[index]!.source;
    const captured: StructuredModelRequest<unknown>[] = [];
    const provider: StructuredModelProvider = { catalog: base.design.catalog, availableProfileSummaries: () => [],
      assertProfilesAvailable: async () => undefined,
      generateStructured: async (request) => { captured.push(request);throw new ModelConfigurationError(STOP); } };
    try { await compiler(provider, source.arms.P.state, source.actions, sourceScope(source, base.snapshot.hash), source.profileId, 12); }
    catch (error) { if (!(error instanceof ModelConfigurationError) || error.message !== STOP) throw error; }
    if (captured.length !== 1) throw new Error("named temporal source did not reach one complete physical boundary");
    const request = captured[0]!;
    const labels = index === 4 ? base.manifest.roots.find((root) => root.index === 4)!.labels
      : source.actions.flatMap((action) => {
        if (!["player", "scytheback", "archon-devers", "chief-kalfvald", "gmung", "high-captain-sinerian", "lord-maracan", "lord-varxis", "sapphire-enchantress"].includes(action.actorId)) return [];
        const label = { actionId: action.id, actionHash: contentHash(action), quote: action.rawText,
          requirement: "complete compound task cannot finish within ten seconds" };
        return action.actorId === "scytheback" ? [label, { ...label,
          requirement: "finite investigation without a source prerequisite must not gain continuation assertions" }] : [label];
      });
    roots.push({ index, sourceHash: contentHash(source), actionsHash: source.proof.actionsHash,
      stateHash: source.proof.arms.P.stateHash, rootContextHash: source.proof.arms.P.fullContextHash,
      requestHash: sourceOwnedRequestHash(request), requestUtf8Bytes: structuredPromptBytes(request).requestUtf8Bytes,
      labels, model: base.manifest.roots[0]!.model });
  }
  // Reserve each complete UTF-8 request plus body overhead. The shared runner
  // independently checks the actual root/repair bytes before every dispatch.
  const inputTokenCeiling = Math.ceil((Math.max(...roots.map((root) => root.requestUtf8Bytes)) + 16384) / 1000) * 1000;
  if (inputTokenCeiling > 350_000) throw new Error("named temporal full root exceeds existing input ceiling");
  return { design: { root: base.design.root, catalog: base.design.catalog, sources }, registry: base.registry, snapshot: base.snapshot,
    manifest: { ...base.manifest, trialId: TRIAL, kind: "named-temporal-contract-admission", roots, order: ORDER,
      sourceEventsHash: contentHash(events), parentTrial: "trajectory-e2-03", controlSourceHash: contentHash(sources[4]!.source),
      treatment: { ...base.manifest.treatment, temporalContractSelection: "named-operators-v1" },
      inputTokenCeiling, maxHttp: 15, maximumRunNanoCny: 15 * (inputTokenCeiling * 3520 + STEP_E2_PROTOCOL.outputTokenCeiling * 10560),
      acceptance: "Fresh named-operator candidate only: four recorded full12-action roots from trajectory-e2-03 plus the existing12-action brief utterance control. Order3,4,0,1,2; one complete sample each; same source text,state,shortlist,alias identities,thinking-disabled settings and bounded2repairs. Stop at the first formal/source-description/state or frozen temporal diagnostic failure; at most15HTTP; pre-reserve the complete worst-case run. No historical response counts as a new baseline sample and no paired efficacy is claimed. Named selectors preserve all authored kinds and conditions; contradictions cannot be normalized into successes. Pass every compound short-completion exclusion, reject invented continuation on the bound unconditional investigation, preserve brief controls. Full source review, new WorldHost trajectory and independent confirmation remain required." } };
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-temporal-contract-probe.ts [prepare]");
  const prepared = await prepareTemporalContractProbe();
  if (process.argv[2] === "prepare") { console.log(JSON.stringify(prepared.manifest, null, 2));return; }
  const frozen = JSON.parse(readFileSync(path.join(prepared.design.root, "evidence/temporal-contract-01/frozen-manifest.json"), "utf8"));
  if (contentHash(frozen) !== contentHash(prepared.manifest)) throw new Error("named temporal pre-dispatch protocol drift");
  await runPreparedCompilationProbe(prepared, compiler);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main().catch((error: unknown) => {
  console.error(error);process.exitCode = 1;
});
