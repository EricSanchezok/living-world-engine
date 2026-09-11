import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { flatPlanBatchProvider } from "../../src/engine/mechanics/flat-resolution-plan-batch";
import { factorTypesProvider } from "../../src/engine/mechanics/resolution-factor-types";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { planChoiceDomains, sourceBoundPlanChoicesProvider } from "../../src/engine/mechanics/source-bound-plan-choices";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { loadPromptAsset } from "../../src/engine/prompts";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";
import { PHYSICAL_PLANNING_WORKLIST, physicalPlanningWorklistProvider, buildPhysicalPlanningWorklist, withoutPhysicalPlanningWorklist } from "../../src/engine/mechanics/physical-planning-worklist";
import { withoutProbeNamespace } from "./step-source-choices-probe";
import { prepareVisibleTargetProbe } from "./step-visible-target-probe";

const TRIAL = "probes-e2-worklist-01";
const SOURCE_TRIAL = "probes-e2-source-choices-01";
type Evidence = ReturnType<typeof admissionRequestEvidence>;
const adapt = (arm: string, inner: StructuredModelProvider) => factorTypesProvider(planSelectorProvider(flatPlanBatchProvider(sourceBoundPlanChoicesProvider(arm === "W" ? physicalPlanningWorklistProvider(inner) : inner))));

export function worklistDecision(rows: ProbeRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 2 || ["041", "007"].some(id => rows.filter(row => row.rootId === id && row.arm === "W").length !== 1) ||
    rows.some(row => row.httpCalls !== 1 || row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  return rows.every(row => row.complete && row.initialAdmittedActions === (row.rootId === "041" ? 41 : 7))
    ? "eligible-for-source-semantic-review-no-comparative-claim" : "failed-first-call-admission";
}


export function assertWorklistTransform(baseline: Evidence, candidate: Evidence, namespace: string): void {
  const before = withoutProbeNamespace(baseline, namespace), after = withoutProbeNamespace(candidate, namespace);
  const instruction = loadPromptAsset("shared/physical-planning-worklist.md"), worklist = buildPhysicalPlanningWorklist(before.context);
  const context = after.context as { task: { planningWorklist: unknown } };
  if (contentHash(context.task.planningWorklist) !== contentHash(worklist) ||
    contentHash(withoutPhysicalPlanningWorklist(after.context)) !== contentHash(before.context)) throw new Error("worklist source or projection mismatch");
  const independent = (value: Evidence) => ({ ...value, context: null, userPrompt: null, promptVersion: null });
  if (contentHash(independent(before)) !== contentHash(independent(after))) throw new Error("worklist changed output or generation contract");
  if (after.userPrompt !== `${before.userPrompt}\n\n${instruction}` ||
    after.promptVersion !== `${before.promptVersion}/${PHYSICAL_PLANNING_WORKLIST}@${contentHash({ instruction, worklist }).slice(0, 16)}`) throw new Error("worklist changed instructions beyond its exact projection contract");
}

export async function prepareWorklistProbe() {
  // Reconstruct the immutable original state directly; verify the complete
  // current foundation against its frozen physical request instead of rerunning
  // every intervening experiment's offline arm matrix.
  const prepared = await prepareVisibleTargetProbe(), { catalog, snapshot } = prepared;
  const directory = path.resolve(STEP_E2_PROTOCOL.root, "runs", SOURCE_TRIAL);
  const history = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (!history.commit.startsWith("8bbffc1") || history.catalogHash !== catalog.hash || history.registrySnapshotHash !== snapshot.hash) throw new Error("frozen source-choice foundation changed");
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh complete-source explicit worklist qualification" });
  const cases = [];
  for (const source of prepared.cases) {
    const prior = JSON.parse(gunzipSync(readFileSync(path.join(directory, `${source.id}-D-request-1.json.gz`))).toString("utf8")) as Evidence;
    const priorCase = history.cases.find((value: { rootId: string }) => value.rootId === source.id);
    if (priorCase?.sourceHash !== contentHash(source.source) || priorCase.initialRequestHashes.D !== contentHash(prior)) throw new Error("frozen source request mismatch");
    const initial: Record<string, Evidence> = {};
    for (const arm of ["B", "W"]) {
      const captures: Evidence[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline worklist capture"); } };
      await runResolutionAdmission(source.source, adapt(arm, offline), { candidate: true, includeActivityTemporalEvidence: true,
        contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: SHARED_STATE_FIRST_LAYOUT,
        maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("worklist capture failed or split");
      initial[arm] = captures[0]!;
    }
    if (contentHash(withoutProbeNamespace(initial.B!, cacheNamespace)) !== contentHash(withoutProbeNamespace(prior, history.cacheNamespace))) throw new Error("current source-choice foundation differs from its frozen request");
    assertWorklistTransform(initial.B!, initial.W!, cacheNamespace);
    cases.push({ ...source, initial });
  }
  const manifest = { ...prepared.manifest, trialId: TRIAL, sourceTrialId: SOURCE_TRIAL, sourceManifestHash: contentHash(history),
    order: cases.map(source => ({ rootId: source.id, arm: "W" })), cacheNamespace, maxHttp: 2, perArmRootMaxPhysicalRequests: 1,
    maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    worklistContract: PHYSICAL_PLANNING_WORKLIST, protocolHash: contentHash(STEP_E2_PROTOCOL),
    cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), slots: source.slots, actions: source.assigned,
      availableActions: source.source.actions.length, domains: planChoiceDomains(source.initial.W!.context),
      initialRequestHashes: Object.fromEntries(Object.entries(source.initial).map(([arm, request]) => [arm, contentHash(request)])),
      baselineContextUtf8Bytes: Buffer.byteLength(JSON.stringify(source.initial.B!.context)),
      contextUtf8Bytes: Buffer.byteLength(JSON.stringify(source.initial.W!.context)),
      wireSchemaUtf8Bytes: Object.fromEntries(Object.entries(source.initial).map(([arm, request]) => [arm, Buffer.byteLength(JSON.stringify(request.wireJsonSchema))])) })),
    acceptance: "Prospective candidate qualification on complete original 041/007 roots: two actual first calls, one per root, no paid baseline, repair, warmup, verifier, RNG or world commit. Offline B verifies the frozen source-choice foundation and is not an output comparison or response replay. W retains temporal evidence, factor types, selectors, dependent fields, flat output, bound choice schema, shared-json-v3, state-first, closer recovery and identical disabled-thinking Flash settings. It adds only the exact source-bound physical worklist and its static instruction. Full original action records,12/7 slots,41/7 assigned actions,all48 available actions and all232 target choices remain, along with all original context. Record additive worklist bytes and all actual token, cache, HTTP, latency and cost metrics; improvement is not assumed. Both W roots must fully admit with known usage to permit source semantic review. No response-dependent changes or extra requests. Historical differences do not establish causal gains, repair recovery, full runtime costs or general reliability. Check every source action's faithful intent, temporal boundary, factor authority and supported effects before a new full-world diagnostic. Mechanical admission alone does not certify semantics or continuous gameplay; final full-world trajectories and independent confirmation remain required.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({
  trialId: TRIAL, prepare: prepareWorklistProbe, decision: worklistDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
  adaptPhysicalProvider: adapt, activityTemporalEvidenceFor: () => true,
}).catch(error => { console.error(error); process.exitCode = 1; });
