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
import { prepareFactorTypesProbe } from "./step-factor-types-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest } from "./step-state-prefix-probe";
import { seededResponseFetch } from "./step-syntax-recovery-probe";

const TRIAL = "probes-e2-factor-recovery-01", SOURCE_TRIAL = "probes-e2-factor-types-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const adapt = (provider: StructuredModelProvider) => factorTypesProvider(planSelectorProvider(provider));
const frozen = {
  "041": { ordinal: 2, retained: 13, bodyHash: "6a6c85e57a29dcb085571764614ce21195e04002b1b2a0d43d6275b1fe69442d", rawHash: "d06b8a8418b36f7a175f66cf79e6cd6c9b7f4437323e8c95a07ca7620643e577" },
  "007": { ordinal: 3, retained: 7, bodyHash: "59b361771782a44ace7d790db69b2e10d9456cc5b1df473e4a7db6ad1a1f6354", rawHash: "3de7a618065154fdb4a3ed94f9803bde2d842ed264fda3f1d7643371dc4344f7" },
};
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

export function factorRecoveryDecision(rows: HistoricalRecoveryRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 2 || rows.some(row => row.unknownUsageRequests)) return "inconclusive";
  const control = rows.find(row => row.rootId === "007"), repaired = rows.find(row => row.rootId === "041");
  if (!control || !repaired || control.newHttp !== 0 || control.retainedFromHistoricalFirstResponse !== 7 ||
    repaired.retainedFromHistoricalFirstResponse !== 13 || repaired.newHttp < 1 || repaired.newHttp > 2) return "inconclusive";
  return control.complete && repaired.complete ? "eligible-for-source-semantic-review" : "failed";
}

export async function prepareFactorRecoveryProbe() {
  const prepared = await prepareFactorTypesProbe(), { catalog, snapshot, registry } = prepared;
  const sourceManifest = read(path.join(root, "runs", SOURCE_TRIAL, "manifest.json"));
  if (sourceManifest.commit !== "9ff48af" && !String(sourceManifest.commit).startsWith("9ff48af")) throw new Error("source trial commit changed");
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
      contentHash(requests[0]) !== sourceManifest.cases.find((value: { rootId: string }) => value.rootId === source.id).initialRequestHashes.F) throw new Error("source request or retained admission changed");
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
    acceptance: "Separate bounded recovery-feasibility trial after factor-types-01 failed its first-call gate; do not amend or restart that trial. Replay its unchanged F first responses through the actual gateway only after exact frozen HTTP body and response hashes match. First run the complete 7-action control for zero new HTTP, then the full 41-action/12-slot root, both retaining all 48 available actions and full state. Preserve historical first admissions 7/13; never recharge historical usage. The same temporal evidence, factor types, source selectors, dependent fields, shared-json-v3, state-first, closer recovery, thinking disabled and generation settings apply. The first new repair request is captured and frozen offline; its candidate and issues come from the replayed response. At most two new repair HTTP, the existing repair ceiling, no transport retries, verifier, RNG, world commit or redraw. Both roots must completely admit before source semantic review. Report historical first-response retention and usage separately from new repair HTTP/token/time/cost. This is neither fresh first-call success nor a paired causal improvement, and does not override the failed first-call trial. Any source, control or billing drift is inconclusive. Complete admission only permits review: original intent, temporal completion, meaningful effects, check stakes, authority, mode changes and unsupported harm/no-effect substitutions still require evidence. Do not promote based on schema success alone.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runHistoricalPlanRecovery(TRIAL, prepareFactorRecoveryProbe, {
  decision: factorRecoveryDecision, adaptPhysicalProvider: adapt, includeActivityTemporalEvidence: true,
}).catch(error => { console.error(error); process.exitCode = 1; });
