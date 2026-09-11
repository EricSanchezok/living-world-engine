import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { transitionProposalSchema } from "../../src/engine/contracts/llm-schemas";
import { recordedContext } from "../../src/engine/benchmarks/step-efficiency/repair-tail";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError, type StructuredModelRequest } from "../../src/engine/models/model-provider";
import { ModelRegistry } from "../../src/engine/models/model-registry";
import { promptBundle } from "../../src/engine/prompts";
import { indexedReviewedPlanningProvider } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { OrderedRandomStream } from "../../src/engine/mechanics/ordered-random-stream";
import { TruthBatchCoordinator, TRUTH_BATCH_REQUEST_CONTRACT } from "../../src/engine/mechanics/truth-batch-provider";
import { withTruthRequestPolicy } from "../../src/engine/mechanics/truth-request-policy";
import { restoreTransitionWorklistContext } from "../../src/engine/mechanics/transition-evidence-worklist";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { countDeepSeekContext } from "./deepseek-context-admission";

/** Replays the recorded source contexts through the commitment-release boundary; never sends model HTTP. */
export async function prepareCanonicalSchedulingPreflight() {
  const root = path.resolve(STEP_E2_PROTOCOL.root), trial = "trajectory-e2-18";
  const history = JSON.parse(readFileSync(path.join(root, "runs", trial, "manifest.json"), "utf8"));
  if (contentHash(history) !== "08c8498fe04ab8256e1a8f677ff3a8571b04260b568bb190c8f0d4a33e024ddb") throw new Error("canonical scheduling source manifest changed");
  const source = Array.from({ length: 23 }, (_, index) => {
    const id = `${trial}-http-${String(index + 33).padStart(3, "0")}`;
    const request = JSON.parse(readFileSync(path.join(root, "http", id, "request.json"), "utf8"));
    if (request.id !== id || request.trial.id !== trial || contentHash(request.body) !== request.bodyHash) throw new Error("canonical source request mismatch");
    const context = recordedContext(request.body.messages.find((message: { role: string }) => message.role === "user").content).value as Record<string, unknown>;
    const task = context.task as { transitionWorklist?: { sourceContextHash: string }; stage: string };
    const sourceHash = task.transitionWorklist?.sourceContextHash;
    delete task.transitionWorklist;
    if (contentHash(context) !== sourceHash || task.stage !== "transition" || context.repair) throw new Error("canonical initial source cannot be restored exactly");
    return { id, context, sourceHash, bodyHash: request.bodyHash };
  });
  const catalog = loadModelCatalog(history.variant.catalogPath);
  if (catalog.hash !== history.catalogHash) throw new Error("canonical source catalog changed");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("offline registry refresh forbidden"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash), prompt = promptBundle("truth-transition");
  const treatments = [], bodies: unknown[] = [];
  try {
    for (const flushBoundary of [undefined, "post-promise-v1"] as const) {
      const captured: Array<{ schemaName: string; context: unknown }> = [], restoredHashes: string[] = [], rows: unknown[] = [];
      const stop = new ModelConfigurationError("offline canonical scheduling capture");
      const gateway = createModelGateway(catalog, { [catalog.account("deepseek-api").api_key_env]: "offline-only" }, {
        registry: { capture: async () => snapshot, catalog, refresh: async () => { throw new Error("offline refresh forbidden"); }, status: () => registry.status() },
        maxTransportAttempts: 1, fetchForAccount: () => async (_input, init) => {
          const body = JSON.parse(String(init?.body));
          if (body.model !== STEP_E2_PROTOCOL.model || body.thinking?.type !== "disabled") throw new Error("canonical model controls changed");
          const bodyHash = contentHash(body);
          if (!flushBoundary && !source.some(entry => entry.bodyHash === bodyHash)) throw new Error("offline baseline differs from actual recorded HTTP body");
          rows.push({ bodyHash, admission: await countDeepSeekContext(body) }); bodies.push({ flushBoundary: flushBoundary ?? "next-microtask", body });
          throw stop;
        },
      });
      const generate = gateway.generateStructured.bind(gateway);
      gateway.generateStructured = request => {
        captured.push({ schemaName: request.schemaName, context: request.context });
        if (request.schemaName === "truth_transition_batch") {
          const restored = restoreTransitionWorklistContext(request.context);
          restoredHashes.push(...expandSharedBatchContexts(restored.state as SharedBatchContext).map(contentHash));
        } else {
          const restored = structuredClone(request.context) as { task: { transitionWorklist?: unknown } };
          delete restored.task.transitionWorklist; restoredHashes.push(contentHash(restored));
        }
        return generate(request);
      };
      const coordinator = new TruthBatchCoordinator(withTruthRequestPolicy(indexedReviewedPlanningProvider(gateway), {
        contextLayout: "shared-state-first-v1", jsonSyntaxRecovery: "unmatched-closers-v1",
      }), 12, 2, "shared-json-v3", TRUTH_BATCH_REQUEST_CONTRACT, "tail-v1", flushBoundary);
      const rng = { seed: 47, state: 47, draws: 0 }, stream = new OrderedRandomStream(rng, source.length);
      const results = await Promise.allSettled(source.map(async (entry, index) => {
        await stream.finish(index, rng);
        const request: StructuredModelRequest<unknown> = { ...prompt, profileId: "truth-deepseek", role: "truth-transition",
          workloadId: history.trialId, batchId: "recorded-canonical-release", subjectId: entry.id, promptVersion: prompt.version,
          schemaName: "truth_transition", schema: transitionProposalSchema, context: entry.context,
          runtimeIdentity: { worldHash: history.retrievalPreflight.worldHash, revision: 0 } };
        return coordinator.generateStructured(request);
      }));
      const isCaptureStop = (error: unknown) => {
        for (let depth = 0; depth < 8; depth++) {
          if (error === stop) return true;
          if (!(error instanceof Error)) return false;
          error = error.cause;
        }
        return false;
      };
      const unexpected = results.find(result => result.status !== "rejected" || !isCaptureStop(result.reason));
      if (unexpected) throw new Error("capture failed before or after the intended offline boundary", {
        cause: unexpected.status === "rejected" ? unexpected.reason : new Error("unexpected successful model result"),
      });
      if (contentHash(restoredHashes.sort()) !== contentHash(source.map(entry => entry.sourceHash).sort())) throw new Error("canonical batch lost a complete source context");
      treatments.push({ flushBoundary: flushBoundary ?? "next-microtask", physicalRequests: captured.length, rows,
        restoredSourceHashes: restoredHashes, schemaNames: captured.map(request => request.schemaName) });
    }
    return { bodies, report: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceManifestHash: contentHash(history), source: source.map(({ id, sourceHash, bodyHash }) => ({ id, sourceHash, bodyHash })),
      actualHttp: 0, logicalRequests: source.length, treatments,
      limitations: "Recorded partial trajectory inputs replay the real ordered-promise release, not observed remote readiness timing or a completed world. Exact baseline HTTP bodies and complete source restoration are verified. No generated output, semantic, repair-rate or gameplay qualification." } };
  } finally { registry.stopBackgroundRefresh(); }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-canonical-scheduling-preflight.ts [prepare]");
  const result = await prepareCanonicalSchedulingPreflight();
  if (!process.argv[2]) {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked code before freezing scheduling evidence");
    const directory = path.resolve(STEP_E2_PROTOCOL.root, "evidence/canonical-scheduling-v1", result.report.commit); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "requests.json.gz"), gzipSync(JSON.stringify(result.bodies)), { flag: "wx" });
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(result.report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify(result.report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
