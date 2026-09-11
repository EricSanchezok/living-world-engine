import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { ExperimentBudget, deepSeekExperimentUsage } from "../../src/engine/benchmarks/action-compilation/experiment-budget";
import { FirstPassExperimentTransport } from "../../src/engine/benchmarks/action-compilation/experiment-transport";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { documentedFlashCost } from "../../src/engine/benchmarks/step-efficiency/documented-pricing";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { createModelGateway } from "../../src/engine/models/model-gateway";
import { createModelFetchResolver } from "../../src/engine/models/model-network";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { RecordingRuntimeObserver } from "../../src/engine/runtime/observability";
import { preparePlanSelectorProbe } from "./step-plan-selector-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest } from "./step-state-prefix-probe";
import { seededResponseFetch } from "./step-syntax-recovery-probe";

const TRIAL = "probes-e2-check-feedback-01", SOURCE_TRIAL = "probes-e2-plan-selectors-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
type RequestEvidence = ReturnType<typeof admissionRequestEvidence>;
export type HistoricalRecoveryRow = { rootId: string; complete: boolean; retainedFromHistoricalFirstResponse: number; newHttp: number; unknownUsageRequests: number };
type Row = HistoricalRecoveryRow;
const read = (file: string) => JSON.parse(readFileSync(file, "utf8"));

export function checkFeedbackDecision(rows: Row[], incomplete: boolean) {
  if (incomplete || rows.length !== 2 || rows.some(row => row.unknownUsageRequests)) return "inconclusive";
  const control = rows.find(row => row.rootId === "007"), repaired = rows.find(row => row.rootId === "041");
  if (!control || !repaired || control.newHttp !== 0 || control.retainedFromHistoricalFirstResponse !== 7 || repaired.retainedFromHistoricalFirstResponse !== 29 || repaired.newHttp < 1 || repaired.newHttp > 2) return "inconclusive";
  return control.complete && repaired.complete ? "eligible-for-source-semantic-review" : "failed";
}

/** The first repair changes only the two known missing-stakes diagnostics. */
export function assertCheckRepairDelta(old: RequestEvidence, next: RequestEvidence): void {
  const previous = old.context as { state: SharedBatchContext }, corrected = next.context as { state: SharedBatchContext };
  if (contentHash({ ...old, context: null }) !== contentHash({ ...next, context: null }) ||
    contentHash({ ...previous, state: null }) !== contentHash({ ...corrected, state: null })) throw new Error("repair metadata changed");
  const expected = expandSharedBatchContexts(previous.state), actual = expandSharedBatchContexts(corrected.state);
  if (expected.length !== 2) throw new Error("frozen repair slot count changed");
  for (const slot of expected) {
    const value = slot as { repair: { issues: Array<{ code: string; class: string; path: (string | number)[]; originalValue: unknown; allowedHandles: unknown[]; reason: string }> }; task: { constraints: string[] } };
    const issue = value.repair.issues[0];
    if (value.repair.issues.length !== 1 || !issue || issue.code !== "Error" || issue.class !== "semantic" || issue.originalValue !== null ||
      issue.allowedHandles.length || issue.path.length !== 2 || issue.path[0] !== "plans" || !issue.reason.endsWith("requires a non-none primary effect") ||
      contentHash(value.task.constraints) !== contentHash([issue.reason])) throw new Error("historical missing-effect diagnostic changed");
    const reason = issue.reason.replace("requires a non-none primary effect", "has no failure threat");
    value.repair.issues = [{ ...issue, code: "resolution_check_primary_effect", path: [...issue.path, "primaryEffect"] },
      { ...issue, code: "resolution_check_threatened_effect", path: [...issue.path, "threatenedEffect"], reason }];
    value.task.constraints.push(reason);
  }
  if (contentHash(expected) !== contentHash(actual)) throw new Error("repair changed beyond the exact missing-effect diagnostics");
}

export async function prepareCheckFeedbackProbe() {
  return prepareHistoricalPlanRecovery({ trialId: TRIAL, previousRepairFile: path.join(root, "runs", SOURCE_TRIAL, "041-C-request-2.json.gz"),
    assertRepair: (old, next) => assertCheckRepairDelta(old, next) });
}

export async function prepareHistoricalPlanRecovery(options: {
  trialId: string;
  previousRepairFile: string;
  assertRepair: (old: RequestEvidence, next: RequestEvidence, initial: RequestEvidence, decoded: unknown) => void;
  acceptance?: string;
}) {
  const prepared = await preparePlanSelectorProbe(), { catalog, snapshot, registry } = prepared;
  const sourceManifest = read(path.join(root, "runs", SOURCE_TRIAL, "manifest.json"));
  const cases = [];
  for (const source of prepared.cases) {
    const sourceHttp = `${SOURCE_TRIAL}-http-00${source.id === "041" ? 4 : 8}`;
    const request = read(path.join(root, "http", sourceHttp, "request.json")), response = read(path.join(root, "http", sourceHttp, "response.json"));
    if (contentHash(request.body) !== request.bodyHash || contentHash(response.raw) !== response.rawHash) throw new Error("historical HTTP evidence changed");
    const replay = { bodyHash: request.bodyHash as string, response: response as { raw: string; rawHash: string; status: number } };
    const seeded = seededResponseFetch(replay, 0, async () => { throw new Error("offline cannot send"); });
    const account = catalog.account("deepseek-api");
    let replayCount = 0;
    const gateway = createModelGateway(catalog, { [account.api_key_env]: "offline-preflight" }, { maxTransportAttempts: 1,
      registry: { catalog, capture: async () => snapshot, refresh: async () => { throw new Error("offline registry"); }, status: () => registry.status() },
      fetch: async (input, init) => { const result = await seeded(input, init); replayCount++; return result; } });
    const requests: RequestEvidence[] = [];
    let decodedFirst: unknown;
    const capture: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
      generateStructured: request => { const namespaced = cacheNamespaceRequest(request, sourceManifest.cacheNamespace); requests.push(admissionRequestEvidence(namespaced));
        if (requests.length > 1) throw new ModelConfigurationError("offline repair captured"); return gateway.generateStructured(namespaced).then(result => { decodedFirst = structuredClone(result.value); return result; }); } };
    const result = await runResolutionAdmission(source.source, planSelectorProvider(capture), { candidate: true, contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1",
      contextLayout: "shared-state-first-v1", maxPhysicalRequests: 2, scope: { modelRegistrySnapshotHash: snapshot.hash } });
    const retained = result.rows.filter(row => row.admittedFromPhysicalRequest === 1).reduce((sum,row) => sum + row.actions, 0);
    if (replayCount !== 1 || requests.length !== (source.id === "041" ? 2 : 1) || retained !== (source.id === "041" ? 29 : 7) ||
      contentHash(requests[0]) !== sourceManifest.cases.find((value: { rootId: string }) => value.rootId === source.id).initialRequestHashes.C) throw new Error("historical source or initial retention changed");
    if (source.id === "041") options.assertRepair(JSON.parse(gunzipSync(readFileSync(options.previousRepairFile)).toString()), requests[1]!, requests[0]!, decodedFirst);
    else if (!result.complete) throw new Error("valid control regressed");
    cases.push({ ...source, sourceHttp, replay, requests, retained, seededUsage: deepSeekExperimentUsage(JSON.parse(response.raw)) });
  }
  const manifest = { trialId: options.trialId, sourceTrialId: SOURCE_TRIAL, sourceManifestHash: contentHash(sourceManifest), order: ["007", "041"],
    cacheNamespace: sourceManifest.cacheNamespace as string, maxNewHttp: 2,
    maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: prepared.manifest.model, inference: prepared.manifest.inference,
    protocolHash: contentHash(STEP_E2_PROTOCOL), cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source),
      stateHash: contentHash(source.source.state), sourceHttp: source.sourceHttp, sourceRequestHash: source.replay.bodyHash, sourceResponseHash: source.replay.response.rawHash,
      slots: source.slots, actions: source.assigned, availableActions: source.source.actions.length, retainedFromHistoricalFirstResponse: source.retained,
      requestHashes: source.requests.map(contentHash), seededUsage: source.seededUsage })),
    acceptance: options.acceptance ?? "Frozen-response diagnostic recovery feasibility, not a paired effectiveness or fresh first-call estimate. First replay the valid 7-action control, then the complete 12-slot/41-action failed root; both retain all 48 available actions and full source state. Verify actual first request-body hashes before returning immutable historical responses locally. Do not recharge or resample them. The first repair differs only in the exact two check-plan primary/threatened-effect diagnostics and matching task constraints; later repair exposes complete alternative failure grouping without choosing a correction. Keep source selectors, dependent fields, full contexts, model settings, thinking disabled and two-repair limit fixed. At most two new HTTP total, zero for the control, no transport retry, verifier, RNG, world commit or redraw. Preserve historical first-response admissions 7/29 and require both roots complete before source semantic review. Record historical usage/replays separately from new HTTP, tokens, latency and cost. Any source/control/billing drift is inconclusive. Complete admission does not prove semantics; specifically inspect unsupported effects, premature completion and mode changes against original actions and temporal boundaries.",
  };
  return { ...prepared, cases, manifest };
}

function newUsage(trialId: string, first: number, last: number) {
  let input = 0, output = 0, cacheHit = 0, unknown = 0, documented = 0;
  for (let i = first; i <= last; i++) try {
    const directory = path.join(root, "http", `${trialId}-http-${String(i).padStart(3,"0")}`), request = read(path.join(directory,"request.json")), response = read(path.join(directory,"response.json"));
    const usage = deepSeekExperimentUsage(JSON.parse(response.raw)); input += usage.input; output += usage.output; cacheHit += usage.cacheHit;
    documented += documentedFlashCost(usage,request.startedAt,response.completedAt).dispatchEstimateNanoCny;
  } catch { unknown++; }
  return { newUsage: { input, output, cacheHit }, newTotalTokens: unknown ? null : input + output, unknownUsageRequests: unknown,
    documentedNewNanoCny: unknown ? null : documented, providerBilledNanoCny: null };
}

export async function runHistoricalPlanRecovery(trialId: string, prepare: typeof prepareCheckFeedbackProbe, options: {
  decision?: (rows: Row[], incomplete: boolean) => string;
  adaptPhysicalProvider?: (provider: StructuredModelProvider) => StructuredModelProvider;
  includeActivityTemporalEvidence?: boolean;
} = {}) {
  const decision = options.decision ?? checkFeedbackDecision;
  if (!/^probes-e2-[a-z0-9-]+$/u.test(trialId)) throw new Error("invalid recovery trial id");
  const args = process.argv.slice(2), directory = path.join(root,"runs",trialId);
  if (args.length > 1 || args.some(arg => arg !== "prepare")) throw new Error("usage: step-check-feedback-probe.ts [prepare]");
  if (existsSync(directory)) throw new Error("frozen diagnostic probe cannot restart");
  const { catalog, registry, snapshot, cases, manifest } = await prepare();
  if (manifest.trialId !== trialId) throw new Error("prepared trial identity mismatch");
  if (args[0] === "prepare") { registry.stopBackgroundRefresh(); console.log(JSON.stringify(manifest,null,2)); return; }
  if (execFileSync("git",["status","--porcelain"],{encoding:"utf8"}).trim()) throw new Error("commit checked work before paid probe");
  const lock = path.join(root,"writer.lock"); closeSync(openSync(lock,"wx"));
  let budget: ExperimentBudget | undefined, status = "preparing", failure: string | undefined, stopped = false, dispatches = 0;
  const rows: Row[] = [], connections: unknown[] = [], stop = () => { stopped = true; };
  const report = () => writeFileSync(path.join(directory,"report.json"),JSON.stringify({ ...manifest, status, failure, rows,
    decision: decision(rows,status !== "completed"), newHttp: dispatches, budget: budget?.summary, connections, updatedAt: new Date().toISOString() },null,2));
  process.on("SIGINT",stop); process.on("SIGTERM",stop);
  try {
    mkdirSync(directory,{recursive:true}); const ledger = new ExperimentBudget(path.join(root,"budget.jsonl"),STEP_E2_BUDGET); budget = ledger;
    const phase = ledger.summary.phaseBudgets.find(value => value.phases.includes("probes"))!;
    const used = phase.phases.reduce((sum,name) => sum + ledger.summary.phases[name].estimatedPeakNanoCny,0);
    if (ledger.summary.blockingUnknown.length || used + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > phase.maximumNanoCny ||
      ledger.summary.estimatedPeakNanoCny + ledger.summary.reservedNanoCny + manifest.maximumRunNanoCny > STEP_E2_BUDGET.maximumNanoCny) throw new Error("complete recovery budget or unknown billing blocks dispatch");
    const account = catalog.account("deepseek-api"); if (!process.env[account.api_key_env]) throw new Error("configured credential unavailable");
    const send = createModelFetchResolver(process.env,{onConnectionEvent:event=>connections.push(event)})("deepseek-api",account)!;
    const transport = new FirstPassExperimentTransport(ledger,{root,baseUrl:account.base_url,fetch:async(input,init)=>{dispatches++;report();return send(input,init);},
      inputTokenCeiling:STEP_E2_PROTOCOL.inputTokenCeiling,outputTokenCeiling:STEP_E2_PROTOCOL.outputTokenCeiling,endpointPaths:["/chat/completions"],
      trialPattern:new RegExp(`^${trialId}$`, "u"),requireThinkingDisabled:true,priceBinding:{accountId:"deepseek-api",modelId:STEP_E2_PROTOCOL.model,priceId:"flash"}});
    writeFileSync(path.join(directory,"manifest.json"),JSON.stringify({...manifest,commit:execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim(),phaseBudgetHash:ledger.summary.phaseBudgetHash},null,2),{flag:"wx"});
    transport.beginTrial(trialId,"probes"); status="running"; report();
    for (const rootId of manifest.order) {
      if (stopped || ledger.summary.blockingUnknown.length) throw new Error("interruption or unknown billing stops next source");
      const selected = cases.find(value=>value.id===rootId)!, observer = new RecordingRuntimeObserver({mode:"full"});
      const beforeHttp=dispatches,beforeCost=ledger.summary.estimatedPeakNanoCny,started=performance.now();
      let physical=0;
      const replayFetch = seededResponseFetch(selected.replay,rootId==="007"?0:2,async(input,init)=>{
        if(stopped||dispatches>=manifest.maxNewHttp)throw new ModelConfigurationError("diagnostic recovery HTTP gate stopped");
        try { const response=await transport.fetch(input,init),value=await response.clone().json(); if(value.model!==STEP_E2_PROTOCOL.model)throw new ModelConfigurationError("response model changed"); return response; }
        catch(error){stopped=true;failure=String(error);throw error;}
      });
      const gateway=createModelGateway(catalog,process.env,{maxTransportAttempts:1,
        registry:{catalog,capture:async hash=>{if(hash&&hash!==snapshot.hash)throw new ModelConfigurationError("registry drift");return snapshot;},refresh:options=>registry.refresh(options),status:()=>registry.status()},
        fetchForAccount:id=>async(input,init)=>{if(id!=="deepseek-api"||stopped)throw new ModelConfigurationError("unexpected account or stopped probe");return replayFetch(input,init);}});
      const verifierRequests: Array<{slot:number;request:RequestEvidence}>=[];
      const capture:StructuredModelProvider={catalog,availableProfileSummaries:role=>catalog.profileSummaries(role),assertProfilesAvailable:ids=>gateway.assertProfilesAvailable(ids),
        generateStructured:request=>{const namespaced=cacheNamespaceRequest(request,manifest.cacheNamespace),evidence=admissionRequestEvidence(namespaced);physical++;
          if(stopped||(physical<=selected.requests.length&&contentHash(evidence)!==contentHash(selected.requests[physical-1]))){stopped=true;throw new ModelConfigurationError("frozen source or repair changed");}
          writeFileSync(path.join(directory,`${rootId}-request-${physical}.json.gz`),gzipSync(JSON.stringify(evidence)),{flag:"wx"});return gateway.generateStructured(namespaced);}};
      const result=await runResolutionAdmission(selected.source,options.adaptPhysicalProvider?.(capture) ?? planSelectorProvider(capture),{candidate:true,contextCodec:"shared-json-v3",jsonSyntaxRecovery:"unmatched-closers-v1",contextLayout:"shared-state-first-v1",
        includeActivityTemporalEvidence: options.includeActivityTemporalEvidence,
        maxPhysicalRequests:rootId==="007"?1:3,scope:{modelRegistrySnapshotHash:snapshot.hash,observer},onVerifierRequest:(request,slot)=>verifierRequests.push({slot,request:admissionRequestEvidence(request)})});
      const row={rootId,complete:result.complete,retainedFromHistoricalFirstResponse:result.rows.filter(value=>value.admittedFromPhysicalRequest===1).reduce((sum,value)=>sum+value.actions,0),
        admittedActions:result.rows.filter(value=>value.admitted).reduce((sum,value)=>sum+value.actions,0),newHttp:dispatches-beforeHttp,localInitialResponseReplays:1,
        seededUsage:selected.seededUsage,physicalRequests:result.physicalRequests,elapsedReplayAndRepairMs:performance.now()-started,newPeakNanoCny:ledger.summary.estimatedPeakNanoCny-beforeCost,
        ...newUsage(trialId,beforeHttp+1,dispatches),semanticVerdict:result.semanticVerdict,stepCommitted:false};
      writeFileSync(path.join(directory,`${rootId}-result.json.gz`),gzipSync(JSON.stringify({row,result,verifierRequests,events:observer.events})),{flag:"wx"});rows.push(row);report();console.log(JSON.stringify(row));
      if(stopped||ledger.summary.blockingUnknown.length||row.retainedFromHistoricalFirstResponse!==selected.retained||(rootId==="007"&&(!row.complete||row.newHttp!==0)))throw new Error(failure??"source, control or billing drift");
    }
    status="completed";
  } catch(error){status="stopped";failure=String(error);}
  finally{report();registry.stopBackgroundRefresh();process.off("SIGINT",stop);process.off("SIGTERM",stop);unlinkSync(lock);}
  console.log(JSON.stringify({trialId,status,failure,newHttp:dispatches,decision:decision(rows,status!=="completed")}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runHistoricalPlanRecovery(TRIAL,prepareCheckFeedbackProbe).catch(error=>{console.error(error);process.exitCode=1;});
