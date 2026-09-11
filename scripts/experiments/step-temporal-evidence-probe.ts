import { pathToFileURL } from "node:url";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { ACTIVITY_TEMPORAL_EVIDENCE, ACTIVITY_TEMPORAL_NOTICE } from "../../src/engine/contracts/activity-temporal-evidence";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { preparePlanSelectorProbe } from "./step-plan-selector-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";

const TRIAL = "probes-e2-temporal-evidence-01";
type Evidence = ReturnType<typeof admissionRequestEvidence>;

export function temporalEvidenceDecision(rows: ProbeRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 4 || ["041", "007"].some(id => ["B", "T"].some(arm => rows.filter(row => row.rootId === id && row.arm === arm).length !== 1)) ||
    rows.some(row => row.httpCalls !== 1 || row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  const candidate = rows.filter(row => row.arm === "T"), baseline = rows.filter(row => row.arm === "B");
  if (candidate.some(row => !row.complete)) return "failed-first-call-admission";
  const sum = (values: ProbeRow[]) => values.reduce((total, row) => total + row.initialAdmittedActions, 0);
  return sum(candidate) > sum(baseline) ? "eligible-for-source-semantic-review" : "eligible-for-source-semantic-review-no-first-call-gain";
}

export function assertTemporalSourcePreserved(baseline: Evidence, candidate: Evidence): void {
  if (contentHash({ ...baseline, context: null }) !== contentHash({ ...candidate, context: null })) throw new Error("temporal experiment changed request settings");
  const original = baseline.context as { state: SharedBatchContext }, next = candidate.context as { state: SharedBatchContext };
  if (contentHash({ ...original, state: null }) !== contentHash({ ...next, state: null })) throw new Error("temporal experiment changed outer task");
  const before = expandSharedBatchContexts(original.state), after = expandSharedBatchContexts(next.state);
  if (before.length !== after.length) throw new Error("temporal experiment changed slot count");
  for (const [index, value] of after.entries()) {
    const context = value as { state: { temporalExecution?: { contractVersion: string; sourceHash: string } }; task: { constraints: string[] } };
    if (context.state.temporalExecution?.contractVersion !== ACTIVITY_TEMPORAL_EVIDENCE || !context.state.temporalExecution.sourceHash ||
      context.task.constraints.pop() !== ACTIVITY_TEMPORAL_NOTICE) throw new Error("temporal evidence or interpretation missing");
    delete context.state.temporalExecution;
    if (contentHash(context) !== contentHash(before[index])) throw new Error("temporal evidence changed original source");
  }
}

export async function prepareTemporalEvidenceProbe() {
  const prepared = await preparePlanSelectorProbe(), { catalog, snapshot } = prepared;
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh paired temporal input completeness" });
  const cases = [];
  for (const source of prepared.cases) {
    const initial: Record<string, Evidence> = {};
    for (const arm of ["B", "T"]) {
      const captures: Evidence[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline temporal capture"); } };
      await runResolutionAdmission(source.source, planSelectorProvider(offline), { candidate: true, includeActivityTemporalEvidence: arm === "T",
        contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: SHARED_STATE_FIRST_LAYOUT,
        maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("temporal evidence split source root");
      initial[arm] = captures[0]!;
    }
    assertTemporalSourcePreserved(initial.B!, initial.T!);
    if (contentHash(initial.B!.context) !== contentHash(source.initial.C!.context)) throw new Error("selector baseline context drift");
    cases.push({ ...source, initial });
  }
  const order = cases.flatMap(source => ["B", "T"].sort((a, b) => contentHash({ seed: 20260908, rootId: source.id, arm: a })
    .localeCompare(contentHash({ seed: 20260908, rootId: source.id, arm: b }))).map(arm => ({ rootId: source.id, arm })));
  const manifest = { trialId: TRIAL, seed: 20260908, order, maxHttp: 4, perArmRootMaxPhysicalRequests: 1, cacheNamespace,
    maximumRunNanoCny: 4 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: prepared.manifest.model, inference: prepared.manifest.inference,
    protocolHash: contentHash(STEP_E2_PROTOCOL), temporalEvidenceContract: ACTIVITY_TEMPORAL_EVIDENCE,
    cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), stateHash: contentHash(source.source.state),
      slots: source.slots, actions: source.assigned, availableActions: source.source.actions.length,
      initialRequestHashes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, contentHash(value)])),
      contextUtf8Bytes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, Buffer.byteLength(JSON.stringify(value.context))])) })),
    acceptance: "First-call-only paired input-completeness development probe on the original full 41/7-action roots (12/7 logical slots), both retaining all 48 available actions and source state. B is the existing experimental selector representation, not the production baseline; T adds only source-bound activity temporal evidence and its interpretation to generation and review. Both share source selectors, dependent fields, shared-json-v3, state-first layout, closer recovery, thinking disabled and unchanged generation settings. One fresh actual HTTP per cell, four total, no paid repair, transport retry, warmup, verifier, RNG or world commit. This deliberately isolates first-call behavior and cannot estimate runtime final recovery rate or overall cost savings. Preserve all captured outputs and measure initial admissions, input/output tokens, cache, latency and costs in fixed seeded block order with one common fresh cache namespace. Both T roots must admit completely before source semantic review; report ties as no first-call gain. A mechanical pass is insufficient: inspect source intent, supported effects, temporal boundaries and ongoing work. Specifically reject substituting harm for luring or declaring future objectives completed merely to obtain a legal check. Partial effects before a checkpoint remain possible when source and rules support them. Missing billing or incomplete pairs is inconclusive. No source, prompt or parameter tuning within the trial. No candidate promotion or gameplay claim from this small source probe alone.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({
  trialId: TRIAL, prepare: prepareTemporalEvidenceProbe, decision: temporalEvidenceDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
  adaptPhysicalProvider: (_arm, provider) => planSelectorProvider(provider), activityTemporalEvidenceFor: arm => arm === "T",
}).catch(error => { console.error(error); process.exitCode = 1; });
