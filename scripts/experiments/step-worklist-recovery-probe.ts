import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { factorTypesProvider } from "../../src/engine/mechanics/resolution-factor-types";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { runHistoricalPlanRecovery, type HistoricalRecoveryRow } from "./step-check-feedback-probe";
import { prepareVisibleTargetProbe } from "./step-visible-target-probe";
import { flatPlanBatchProvider } from "../../src/engine/mechanics/flat-resolution-plan-batch";
import { sourceBoundPlanChoicesProvider } from "../../src/engine/mechanics/source-bound-plan-choices";
import { physicalPlanningWorklistProvider } from "../../src/engine/mechanics/physical-planning-worklist";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest } from "./step-state-prefix-probe";
import { seededResponseFetch } from "./step-syntax-recovery-probe";

const TRIAL = "probes-e2-worklist-recovery-01", SOURCE_TRIAL = "probes-e2-worklist-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const adapt = (provider: StructuredModelProvider) => factorTypesProvider(planSelectorProvider(flatPlanBatchProvider(sourceBoundPlanChoicesProvider(physicalPlanningWorklistProvider(provider)))));
const frozen = {
  "041": { ordinal: 1, retained: 40, bodyHash: "956293c2e22b57700f09f94300a749337efb191c3648a4288f7556e323638eba", rawHash: "0df3d8ca99e9f7c8529b16baf54857434d91100ec97524b95ce3f2e98a993d2c" },
  "007": { ordinal: 2, retained: 7, bodyHash: "df1e912ad72ce066974819f3b4df1f0f6e0b0249c96adfd99c878195ee1431c7", rawHash: "3d7c553e5c2ef0208475ed426087b1800ee2db6ac59324c2c02912e57c2c1cb3" },
};
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

export function worklistRecoveryDecision(rows: HistoricalRecoveryRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 2 || rows.some(row => row.unknownUsageRequests)) return "inconclusive";
  const control = rows.find(row => row.rootId === "007"), repaired = rows.find(row => row.rootId === "041");
  if (!control || !repaired || control.newHttp !== 0 || control.retainedFromHistoricalFirstResponse !== 7 ||
    repaired.retainedFromHistoricalFirstResponse !== 40 || repaired.newHttp < 1 || repaired.newHttp > 2) return "inconclusive";
  return control.complete && repaired.complete ? "eligible-for-source-semantic-review" : "failed";
}

export async function prepareWorklistRecoveryProbe() {
  const prepared = await prepareVisibleTargetProbe(), { catalog, snapshot, registry } = prepared;
  const sourceManifest = read(path.join(root, "runs", SOURCE_TRIAL, "manifest.json"));
  if (sourceManifest.commit !== "e03bef3" && !String(sourceManifest.commit).startsWith("e03bef3")) throw new Error("source trial commit changed");
  const cases = [];
  for (const source of prepared.cases) {
    const binding = frozen[source.id as keyof typeof frozen];
    if (!binding) throw new Error("unexpected recovery source");
    const sourceHttp = `${SOURCE_TRIAL}-http-${String(binding.ordinal).padStart(3, "0")}`;
    const request = read(path.join(root, "http", sourceHttp, "request.json")), response = read(path.join(root, "http", sourceHttp, "response.json"));
    if (request.bodyHash !== binding.bodyHash || contentHash(request.body) !== binding.bodyHash || response.rawHash !== binding.rawHash || contentHash(response.raw) !== binding.rawHash) throw new Error("frozen source HTTP changed");
    const replay = { bodyHash: binding.bodyHash, response: response as { raw: string; rawHash: string; status: number } };
    const seeded = seededResponseFetch(replay, 0, async () => { throw new Error("offline cannot send"); });
    const account = catalog.account("deepseek-api"); let replayCount = 0;
    const gateway = createModelGateway(catalog, { [account.api_key_env]: "offline-preflight" }, { maxTransportAttempts: 1,
      registry: { catalog, capture: async () => snapshot, refresh: async () => { throw new Error("offline registry"); }, status: () => registry.status() },
      fetch: async (input, init) => { const response = await seeded(input, init); replayCount++; return response; } });
    const requests: Array<ReturnType<typeof admissionRequestEvidence>> = [];
    const capture: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
      generateStructured: request => {
        const namespaced = cacheNamespaceRequest(request, sourceManifest.cacheNamespace); requests.push(admissionRequestEvidence(namespaced));
        if (requests.length > 1) throw new ModelConfigurationError("offline recovery request captured");
        return gateway.generateStructured(namespaced);
      } };
    const result = await runResolutionAdmission(source.source, adapt(capture), { candidate: true, includeActivityTemporalEvidence: true,
      contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1", maxPhysicalRequests: 2,
      scope: { modelRegistrySnapshotHash: snapshot.hash } });
    const retained = result.rows.filter(row => row.admittedFromPhysicalRequest === 1).reduce((sum, row) => sum + row.actions, 0);
    if (replayCount !== 1 || requests.length !== (source.id === "041" ? 2 : 1) || retained !== binding.retained ||
      contentHash(requests[0]) !== sourceManifest.cases.find((value: { rootId: string }) => value.rootId === source.id).initialRequestHashes.W) throw new Error("source request or retained admission changed");
    if (source.id === "007" && !result.complete) throw new Error("valid control regressed");
    cases.push({ ...source, sourceHttp, replay, requests, retained, seededUsage: deepSeekExperimentUsage(JSON.parse(response.raw)) });
  }
  const manifest = { trialId: TRIAL, sourceTrialId: SOURCE_TRIAL, sourceManifestHash: contentHash(sourceManifest), order: ["007", "041"],
    cacheNamespace: sourceManifest.cacheNamespace as string, maxNewHttp: 2,
    maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: prepared.manifest.model, inference: prepared.manifest.inference,
    protocolHash: contentHash(STEP_E2_PROTOCOL), cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), stateHash: contentHash(source.source.state),
      sourceHttp: source.sourceHttp, sourceRequestHash: source.replay.bodyHash, sourceResponseHash: source.replay.response.rawHash,
      slots: source.slots, actions: source.assigned, availableActions: source.source.actions.length, retainedFromHistoricalFirstResponse: source.retained,
      requestHashes: source.requests.map(contentHash), seededUsage: source.seededUsage })),
    acceptance: "Separate bounded recovery feasibility after worklist-01 failed first-call qualification. Preserve that failed result. Locally replay its immutable W responses only after exact original HTTP body and raw response hashes match; never bill them again or redraw them. The complete 7-action control must retain 7 admissions with no new HTTP. The full 41-action/12-slot source retains 40 first admissions; only the failed original slot enters the existing targeted repair path, with all original available actions and allowed targets preserved. The worklist, source-bound choices, flat output, factor types, selectors, temporal evidence, dependent fields, shared-json-v3, state-first and closer recovery remain identical; Flash thinking remains disabled with unchanged parameters. Freeze the first new repair request offline before dispatch. At most two new repair HTTP, no transport retry, critic, RNG, world commit or parameter adjustment. Report historical first usage and retention separately from new repair tokens, cache, time and charges. Both roots must completely admit before source semantic review. This is not fresh first-call success, a causal comparison, a promotion or proof of gameplay. Review every original action's intent, time boundary, targets, means authority and effects, including automatic/no-effect mode, before a new full-world diagnostic.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHistoricalPlanRecovery(TRIAL, prepareWorklistRecoveryProbe, {
  decision: worklistRecoveryDecision, adaptPhysicalProvider: adapt, includeActivityTemporalEvidence: true,
}).catch(error => { console.error(error); process.exitCode = 1; });
