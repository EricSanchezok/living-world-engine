import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorldStepPreparation } from "../../src/engine/runtime/execution";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { bindResolutionAdmission, runResolutionAdmission, type ResolutionAdmissionSource } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { worklistPlanningProvider } from "../../src/engine/mechanics/worklist-planning-pipeline";
import { SOURCE_INDEXED_PLANNING, sourceIndexedPlanningProvider, assertIndexedPlanningContext, withoutPlanningIndices } from "../../src/engine/mechanics/source-indexed-planning";
import { assertPhysicalPlanningWorklist } from "../../src/engine/mechanics/physical-planning-worklist";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionContextEvidence, admissionRequestEvidence } from "./step-runtime-admission-probe";
import { withoutProbeNamespace } from "./step-source-choices-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";

const TRIAL = "probes-e2-indexed-planning-01", SOURCE_TRIAL = "trajectory-e2-07";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const hashes = {
  input: "7b4156a95dc5b608a53e00671bb14d45fcc2264a493ca8d490b8ab80a07422bc",
  preparation: "fcdd0d77c9109b663c402be46e719e0ce9b8fe2ae0aab5f3661e29ab80658975",
  roots: ["069ee59f3fe977123de2987b9f6cf3a981303e5d139f7c2c726d45c4c1c81450", "76f37c1e0b377771e61f5791421886216e1cf3a4622110ed4863c7afc5f14b00"],
  sources: ["4a6c43753c374f12bdb84fc3a168058e0bb16014084890ab832bbbedd8571a30", "8a94e796ac0561c9c64bb2394660a1a2ad88d1cf9432cd4dbfcbb346b9f91c6d"],
};
type Evidence = ReturnType<typeof admissionRequestEvidence>;
const adapt = (arm: string, inner: StructuredModelProvider) => worklistPlanningProvider(arm === "I" ? sourceIndexedPlanningProvider(inner) : inner);

export function indexedPlanningDecision(rows: ProbeRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 2 || ["045", "003"].some(id => rows.filter(row => row.rootId === id && row.arm === "I").length !== 1) ||
    rows.some(row => !Number.isInteger(row.httpCalls) || row.httpCalls < 1 || row.httpCalls > 3 || row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  return rows.every(row => row.complete) ? "eligible-for-source-semantic-review-no-comparative-claim" : "failed-full-root-admission";
}

export async function prepareIndexedPlanningProbe() {
  const artifact = <T>(hash: string): T => {
    const value = JSON.parse(readFileSync(path.join(root, "evidence/worklist-trajectory-07/ledger-artifacts", `${hash}.json`), "utf8"));
    if (value.hash !== hash || contentHash(value.value) !== hash) throw new Error("indexed planning source artifact drift");
    return value.value as T;
  };
  const input = artifact<{ definition: ResolutionAdmissionSource["definition"]; state: ResolutionAdmissionSource["state"] }>(hashes.input);
  const preparation = artifact<WorldStepPreparation>(hashes.preparation);
  const payload = preparation.payload as unknown as { planningState: ResolutionAdmissionSource["state"]; newActions: ResolutionAdmissionSource["actions"];
    dependencyResults: Array<{ dependency: ResolutionAdmissionSource["groundings"][number] }>; sharedResourceAdmissions: Array<{ kind: string }>;
    temporalPlanning: Array<{ activity: { id: string } }> };
  if (preparation.pendingReactionRequests.length || preparation.preparedReactionDecisions.length !== 6 ||
    preparation.preparedReactionDecisions.some(value => value.kind !== "keep" || value.ongoingActivityDisposition !== "continue") ||
    payload.sharedResourceAdmissions.some(value => value.kind !== "granted") || Object.keys(payload.planningState.truth.sharedActivityResourcePools).length) throw new Error("frozen onset behavior changed");
  // This first-step source starts with no activities. Preparation inserts the
  // compiled temporalPlanning list in order; preserve that recorded order for
  // the temporal evidence's array-bound hash after Ledger object serialization.
  const activityIds = payload.temporalPlanning.map(value => value.activity.id);
  if (Object.keys(input.state.truth.activities).length || new Set(activityIds).size !== 48 ||
    activityIds.length !== Object.keys(payload.planningState.truth.activities).length ||
    activityIds.some(id => !payload.planningState.truth.activities[id])) throw new Error("frozen activity insertion order cannot be reconstructed");
  payload.planningState.truth.activities = Object.fromEntries(activityIds.map(id => [id, payload.planningState.truth.activities[id]!]));
  const history = JSON.parse(readFileSync(path.join(root, "runs", SOURCE_TRIAL, "manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/finite-work-goal-02/model-catalog.json"));
  if (!history.commit.startsWith("cdcd4c3") || catalog.hash !== history.catalogHash) throw new Error("frozen model foundation changed");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const profile = resolveModelProfile(catalog, snapshot, input.definition.modelProfiles.resolution);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled") throw new Error("approved model settings changed");
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh complete 45/3 source-index qualification with bounded recovery" });
  const cases = [];
  for (const [index, hash] of hashes.roots.entries()) {
    const original = artifact<{ context: { state: SharedBatchContext }; schema: unknown; system: string; userPrompt: string; promptVersion: string }>(hash);
    const source: ResolutionAdmissionSource = { definition: input.definition, state: payload.planningState, actions: payload.newActions,
      groundings: payload.dependencyResults.map(value => value.dependency), contexts: expandSharedBatchContexts(original.context.state) };
    const bindings = bindResolutionAdmission(source), assigned = bindings.reduce((sum, binding) => sum + binding.actions.length, 0);
    if (contentHash(source) !== hashes.sources[index] || source.actions.length !== 48 || assigned !== (index ? 3 : 45) || bindings.length !== (index ? 3 : 12)) throw new Error("complete source root changed");
    const initial: Record<string, Evidence> = {};
    for (const arm of ["B", "I"]) {
      const captures: Evidence[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline indexed capture"); } };
      await runResolutionAdmission(source, adapt(arm, offline), { candidate: true, includeActivityTemporalEvidence: true,
        contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: SHARED_STATE_FIRST_LAYOUT,
        maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("indexed capture failed or split");
      initial[arm] = captures[0]!;
    }
    // Ledger objects have canonical key ordering. Re-rendering their state can
    // reorder set-like inventories, so compare those inventories as evidence;
    // freeze the newly rendered order identically for B and I below.
    assertPhysicalPlanningWorklist(original.context); assertPhysicalPlanningWorklist(initial.B!.context);
    const reconstructed = expandSharedBatchContexts((initial.B!.context as { state: SharedBatchContext }).state);
    if (contentHash(reconstructed.map(admissionContextEvidence)) !== contentHash(source.contexts.map(admissionContextEvidence)) ||
      initial.B!.userPrompt !== original.userPrompt || withoutProbeNamespace(initial.B!, cacheNamespace).system !== original.system ||
      contentHash(initial.B!.wireJsonSchema) !== contentHash(original.schema)) throw new Error("baseline no longer reconstructs the captured source and planning contract");
    assertIndexedPlanningContext(initial.I!.context);
    if (contentHash(withoutPlanningIndices(initial.I!.context)) !== contentHash(initial.B!.context)) throw new Error("indexed context loses original source");
    if ((initial.I!.context as { task: { planningIndices: { targetCount: number } } }).task.planningIndices.targetCount !== 232) throw new Error("complete target inventory changed");
    cases.push({ id: index ? "003" : "045", source, assigned, slots: bindings.length, initial });
  }
  const maxHttp = 6;
  const manifest = { trialId: TRIAL, sourceTrialId: SOURCE_TRIAL, sourceManifestHash: contentHash(history), hashes,
    order: cases.map(value => ({ rootId: value.id, arm: "I" })), cacheNamespace, maxHttp, perArmRootMaxPhysicalRequests: 3,
    maximumRunNanoCny: maxHttp * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    codec: SOURCE_INDEXED_PLANNING, protocolHash: contentHash(STEP_E2_PROTOCOL), catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash,
    model: profile.modelId, inference: profile.profile.inference,
    stateHash: contentHash(payload.planningState), actionsHash: contentHash(payload.newActions),
    cases: cases.map(value => ({ rootId: value.id, sourceHash: contentHash(value.source), assignedActions: value.assigned, slots: value.slots, availableActions: value.source.actions.length,
      initialRequestHashes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, contentHash(request)])),
      contextUtf8Bytes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, Buffer.byteLength(JSON.stringify(request.context))])),
      wireSchemaUtf8Bytes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, Buffer.byteLength(JSON.stringify(request.wireJsonSchema))])) })),
    acceptance: "Prospective bounded candidate qualification on the latest failed complete 045/003 roots. Offline B reconstructs original source information and planning schema/instructions, not a paid comparison or response replay. Ledger canonical object ordering can reorder set-like catalogs, action-owned source inventories and bound-entity lists on re-rendering; the shared admission evidence normalizer verifies equality only for comparison. Freeze the actual rendered B order and require I to preserve that entire context exactly after removing its annotations. I changes only the source-indexed wire and its explicit source annotations/instructions. All48 actions,232 targets,original12/3 slots,45/3 assigned actions,groundings,canonical truth,temporal evidence,factor/dependent fields,means selectors,shared-json-v3,state-first,closer recovery and disabled-thinking Flash remain. Each root gets one fresh initial HTTP and at most2 recovery HTTP,6 total; no warmup, verifier, RNG, commit, transport retry, or response-dependent retuning. Preserve retained valid slots and report first-response versus final admission separately. Both complete roots with known usage are necessary for source semantic review; historical output differences cannot establish causal savings, general reliability or gameplay. Failed roots stop promotion. All actual HTTP,usage,cache,latency,conservative budget and official CNY tariff estimates remain separately recorded.",
  };
  return { catalog, registry, snapshot, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({ trialId: TRIAL,
  prepare: prepareIndexedPlanningProbe, decision: indexedPlanningDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
  adaptPhysicalProvider: adapt, activityTemporalEvidenceFor: () => true,
}).catch(error => { console.error(error); process.exitCode = 1; });
