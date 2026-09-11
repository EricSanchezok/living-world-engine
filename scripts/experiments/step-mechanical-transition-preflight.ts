import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { transitionProposalSchema } from "../../src/engine/contracts/llm-schemas";
import { scoreRepairTail } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { indexedReviewedPlanningProvider, INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { restoreTransitionWorklistContext } from "../../src/engine/mechanics/transition-evidence-worklist";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { promptBundle } from "../../src/engine/prompts";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { loadFrozenTransitionSource } from "./step-indexed-transition-probe";

/** Historical model text is a mechanical fixture, never a new inference or semantic pass. */
export async function prepareMechanicalTransitionPreflight() {
  const source = loadFrozenTransitionSource(), root = path.resolve(STEP_E2_PROTOCOL.root);
  const fixture = JSON.parse(readFileSync(path.join(root, "http/probes-e2-transition-worklist-05-http-001/response.json"), "utf8"));
  const raw = JSON.parse(fixture.raw), canonical = source.codec.decode(JSON.parse(raw.choices[0].message.content));
  if (contentHash(canonical) !== "ae90d7f4fbbaa8b3246b35c722683bba7ecd54932b1c74782f2fc8db65303ef4") throw new Error("canonical historical fixture changed");
  let fixtureCalls = 0, captured: ReturnType<typeof admissionRequestEvidence> | undefined, contextBudget: Awaited<ReturnType<typeof countDeepSeekContext>> | undefined;
  const gateway = createModelGateway(source.catalog, { [source.catalog.account("deepseek-api").api_key_env]: "offline-fixture-only" }, {
    maxTransportAttempts: 1, registry: { catalog: source.catalog, capture: async hash => {
      if (hash && hash !== source.snapshot.hash) throw new ModelConfigurationError("offline registry drift"); return source.snapshot;
    }, refresh: options => source.registry.refresh(options), status: () => source.registry.status() },
    fetchForAccount: () => async (_input, init) => {
      if (++fixtureCalls !== 1) throw new ModelConfigurationError("offline fixture required another request");
      contextBudget = await countDeepSeekContext(JSON.parse(String(init?.body)));
      return new Response(fixture.raw, { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const terminal: StructuredModelProvider = { catalog: source.catalog,
    availableProfileSummaries: role => source.catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
    generateStructured: request => {
      captured = admissionRequestEvidence(request);
      if (contentHash(restoreTransitionWorklistContext(request.context)) !== contentHash(source.codec.context(source.source.context)) ||
        request.promptVersion.includes("research-interval") || request.userPrompt.includes("synthetic demonstrations")) throw new Error("mechanical source or interface drift");
      return gateway.generateStructured(request);
    } };
  try {
    const coordinator = new TruthBatchCoordinator(indexedReviewedPlanningProvider(terminal), 12, 2, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1");
    const prompt = promptBundle("truth-transition");
    const results = await Promise.all(source.contexts.map((context, slot) => coordinator.generateStructured({ ...prompt,
      role: "truth-transition", profileId: source.source.profileId, subjectId: `source-slot-${String(slot).padStart(2, "0")}`,
      workloadId: "offline-mechanical", batchId: "offline-mechanical", runtimeIdentity: source.runtimeIdentity,
      modelRegistrySnapshotHash: source.snapshot.hash, promptVersion: prompt.version, context, schema: transitionProposalSchema,
      schemaName: "truth_transition", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1" })));
    const result = { slots: results.map((entry, slot) => ({ slot, result: entry.value })) };
    const score = scoreRepairTail(JSON.stringify(result), "transition", source.contexts);
    if (!captured || !contextBudget || fixtureCalls !== 1 || !score.schemaCoverageReferences || contentHash(result) !== contentHash(canonical)) throw new Error("complete mechanical fixture failed");
    return { request: captured, report: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceHash: source.sourceHash, sourceContextHash: source.codec.sourceHash, pipelineFingerprint: INDEXED_REVIEWED_PLANNING_PROMPT_VERSION,
      slots: 12, actions: 43, canonicalHash: contentHash(result), requestHash: contentHash(captured), contextBudget,
      fixtureCalls, actualHttp: 0, fixtureAuditUsageDiscarded: true, mechanicalOnly: true, researchInterval: false,
      semantics: "Historical worklist05 remains rejected. This fixture certifies source/field preservation only; real verifier, repair and final source review remain required." } };
  } finally { source.registry.stopBackgroundRefresh(); }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-mechanical-transition-preflight.ts [prepare]");
  const result = await prepareMechanicalTransitionPreflight();
  if (!process.argv[2]) {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked integration before freezing its evidence");
    const directory = path.resolve(STEP_E2_PROTOCOL.root, "evidence/mechanical-transition-v2", result.report.commit); mkdirSync(directory);
    writeFileSync(path.join(directory, "request.json.gz"), gzipSync(JSON.stringify(result.request)), { flag: "wx" });
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(result.report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify(result.report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
