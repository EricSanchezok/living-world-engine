import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError } from "../../src/engine/models/model-provider";
import { canonicalTransitionEvidenceRequest } from "../../src/engine/mechanics/transition-evidence-worklist";
import { canonicalSparseArraysRequest } from "../../src/engine/mechanics/canonical-sparse-arrays";
import { INDEXED_REVIEWED_PLANNING_PROMPT_VERSION } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { countDeepSeekContext } from "./deepseek-context-admission";
import { prepareTransitionCandidateProbe } from "./step-transition-candidate-probe";

export async function prepareCanonicalTransitionPreflight() {
  const source = await prepareTransitionCandidateProbe(), rows = [], bodies: unknown[] = [];
  try {
    for (const [kind, context] of [["initial", source.initialContext], ["repair", source.request.context]] as const) {
      const original = { ...source.request, context }, candidate = canonicalSparseArraysRequest(canonicalTransitionEvidenceRequest(original));
      const restored = structuredClone(candidate.context) as { task: { transitionWorklist?: unknown } };
      delete restored.task.transitionWorklist;
      if (contentHash(restored) !== contentHash(context)) throw new Error("canonical evidence changed its complete source");
      const admissions: Array<Awaited<ReturnType<typeof countDeepSeekContext>>> = [];
      for (const request of [original, candidate]) {
        let captured = false;
        const gateway = createModelGateway(source.catalog, { [source.catalog.account("deepseek-api").api_key_env]: "offline-only" }, {
          maxTransportAttempts: 1, registry: source.registryBinding, fetchForAccount: () => async (_input, init) => {
            const body = JSON.parse(String(init?.body)); bodies.push({ kind, treatment: request === candidate, body });
            admissions.push(await countDeepSeekContext(body)); captured = true;
            throw new ModelConfigurationError("offline canonical body captured");
          } });
        try { await gateway.generateStructured(request); } catch (error) { if (!captured) throw error; }
      }
      rows.push({ kind, sourceContextHash: contentHash(context), candidateContextHash: contentHash(candidate.context),
        schemaHash: contentHash(candidate.wireJsonSchema), admissions });
    }
    return { bodies, report: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      sourceBundleHash: source.manifest.sourceBundleHash, pipelineFingerprint: INDEXED_REVIEWED_PLANNING_PROMPT_VERSION,
      actualHttp: 0, actions: 24, logicalSlots: 1, sourceRestoredExactly: true, rows,
      semantics: "Only complete source restoration and actual HTTP-body admission are proven. No source-semantic or model reliability qualification; historical failures remain failed." } };
  } finally { source.registry.stopBackgroundRefresh(); }
}

async function main() {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "prepare")) throw new Error("usage: step-canonical-transition-preflight.ts [prepare]");
  const result = await prepareCanonicalTransitionPreflight();
  if (!process.argv[2]) {
    if (execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("commit checked code before freezing source evidence");
    const directory = path.resolve(STEP_E2_PROTOCOL.root, "evidence/canonical-transition-v1", result.report.commit); mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "requests.json.gz"), gzipSync(JSON.stringify(result.bodies)), { flag: "wx" });
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(result.report, null, 2), { flag: "wx" });
  }
  console.log(JSON.stringify(result.report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error); process.exitCode = 1; });
