import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorldStepPreparation } from "../../src/engine/runtime/execution";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { bindResolutionAdmission, runResolutionAdmission, type ResolutionAdmissionSource } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { indexedReviewedPlanningProvider } from "../../src/engine/mechanics/indexed-reviewed-planning-pipeline";
import { assertIndexedPlanningContext } from "../../src/engine/mechanics/source-indexed-planning";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { admissionContextEvidence, admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";

const TRIAL = "probes-e2-condition-profile-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const sourceHashes = {
  input: "6c6adfec7076e62c1e069e9be97607c5ef833e216e4f19cfbeb891afa627cc8d",
  preparation: "9d1301572fb5ad5fd11511efb6ce55eb38ac6c1c34255350886d1d6ee84f1413",
  request: "c629cb56591f55a9b0fedfc5959fdbc14bb0c9429e6e977ca728ec3e8dc1160c",
};

export function conditionProfileProbeDecision(rows: Array<Pick<ProbeRow, "rootId" | "arm" | "complete" | "httpCalls" | "totalTokens" | "documentedKnownNanoCny"> &
  { admittedActions?: number; admittedSlots?: number }>, incomplete: boolean) {
  if (incomplete || rows.length !== 1 || rows[0]!.rootId !== "004" || rows[0]!.arm !== "I" ||
    !Number.isInteger(rows[0]!.httpCalls) || rows[0]!.httpCalls < 1 || rows[0]!.httpCalls > 2 ||
    rows[0]!.totalTokens === null || rows[0]!.documentedKnownNanoCny === null) return "inconclusive";
  return rows[0]!.complete && rows[0]!.admittedActions === 4 && rows[0]!.admittedSlots === 4
    ? "eligible-for-source-semantic-review-no-gameplay-claim" : "failed-full-root-admission";
}

export async function prepareConditionProfileProbe() {
  const artifact = <T>(hash: string): T => {
    const item = JSON.parse(readFileSync(path.join(root, "evidence/indexed-checkpoint-08/artifacts", `${hash}.json`), "utf8"));
    if (item.hash !== hash || contentHash(item.value) !== hash) throw new Error("condition-profile source artifact changed");
    return item.value as T;
  };
  const input = artifact<{ definition: ResolutionAdmissionSource["definition"]; state: ResolutionAdmissionSource["state"] }>(sourceHashes.input);
  const preparation = artifact<WorldStepPreparation>(sourceHashes.preparation);
  const payload = preparation.payload as unknown as { planningState: ResolutionAdmissionSource["state"]; newActions: ResolutionAdmissionSource["actions"];
    dependencyResults: Array<{ dependency: ResolutionAdmissionSource["groundings"][number] }>;
    temporalPlanning: Array<{ activity: { id: string } }> };
  const activityIds = payload.temporalPlanning.map(value => value.activity.id);
  if (Object.keys(input.state.truth.activities).length || new Set(activityIds).size !== 48 ||
    activityIds.length !== Object.keys(payload.planningState.truth.activities).length ||
    activityIds.some(id => !payload.planningState.truth.activities[id]) || preparation.pendingReactionRequests.length) throw new Error("original temporal state cannot be reconstructed");
  payload.planningState.truth.activities = Object.fromEntries(activityIds.map(id => [id, payload.planningState.truth.activities[id]!]));
  const original = artifact<{ context: { state: SharedBatchContext }; userPrompt: string; schema: unknown }>(sourceHashes.request);
  assertIndexedPlanningContext(original.context);
  const source: ResolutionAdmissionSource = { definition: input.definition, state: payload.planningState, actions: payload.newActions,
    groundings: payload.dependencyResults.map(value => value.dependency), contexts: expandSharedBatchContexts(original.context.state) };
  const bindings = bindResolutionAdmission(source);
  if (source.actions.length !== 48 || bindings.length !== 4 || bindings.some(binding => binding.actions.length !== 1) ||
    Object.keys(source.state.truth.entities).length !== 232) throw new Error("original four-slot root or complete available world changed");
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-08/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/short-action-checkpoints-01/model-catalog.json"));
  if (history.commit !== "3d30e819ebd2ecd44a24d9fe6f2d5c33e297c1b9" || history.catalogHash !== catalog.hash) throw new Error("historical model foundation changed");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const profile = resolveModelProfile(catalog, snapshot, input.definition.modelProfiles.resolution);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled") throw new Error("model binding changed");
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1 });
  const captures: Array<ReturnType<typeof admissionRequestEvidence>> = [];
  const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
    generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline condition-profile capture"); } };
  await runResolutionAdmission(source, indexedReviewedPlanningProvider(offline), { candidate: true, includeActivityTemporalEvidence: true,
    contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: "shared-state-first-v1", maxPhysicalRequests: 1,
    scope: { modelRegistrySnapshotHash: snapshot.hash } });
  if (captures.length !== 1) throw new Error("full original root split or failed capture");
  const captured = captures[0]!;
  assertIndexedPlanningContext(captured.context);
  const reconstructed = expandSharedBatchContexts((captured.context as { state: SharedBatchContext }).state);
  if (contentHash(reconstructed.map(admissionContextEvidence)) !== contentHash(source.contexts.map(admissionContextEvidence)) ||
    captured.userPrompt !== original.userPrompt || contentHash(captured.wireJsonSchema) !== contentHash(original.schema)) throw new Error("reconstructed source information or output contract changed");
  const maxHttp = 2;
  const manifest = { trialId: TRIAL, sourceTrialId: "trajectory-e2-08", sourceHashes, sourceManifestHash: contentHash(history),
    order: [{ rootId: "004", arm: "I" }], cacheNamespace, maxHttp, perArmRootMaxPhysicalRequests: maxHttp,
    maximumRunNanoCny: maxHttp * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    protocolHash: contentHash(STEP_E2_PROTOCOL), catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash, model: profile.modelId, inference: profile.profile.inference,
    stateHash: contentHash(source.state), sourceHash: contentHash(source), availableActions: 48, assignedActions: 4, slots: 4, entities: 232,
    cases: [{ rootId: "004", sourceHash: contentHash(source), initialRequestHashes: { I: contentHash(captured) } }],
    acceptance: "Bounded diagnostic on the original complete four-slot/four-action failed physical root, with all48 available actions,232 entities,full canonical state,groundings and temporal evidence retained. This is not a reduced gameplay batch or an independent world. Freeze one fresh initial request and at most one repair; all actual HTTP counts, no replay, warmup, verifier,RNG,commit,transport retry or redraw. Preserve the indexed/dependent/worklist generation contract and disabled-thinking Flash. Existing field-specific condition/duration profile diagnostics do not select a correction or remove an effect. Record initial and final admission separately. Failure stops this trial; full admission only permits source-bound semantic review, including prerequisite timing, affected subjects, unsupported receipt of messages, premature goal completion and no-effect substitutions. This unpaired feasibility trial cannot establish first-pass improvement, causal savings, general semantics or gameplay, and never overrides trajectory08 or earlier failed evidence.",
  };
  return { catalog, registry, snapshot, cases: [{ id: "004", source, initial: { I: captured } }], manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({ trialId: TRIAL,
  prepare: prepareConditionProfileProbe, decision: conditionProfileProbeDecision, layoutFor: () => "shared-state-first-v1",
  adaptPhysicalProvider: (_arm, provider) => indexedReviewedPlanningProvider(provider), activityTemporalEvidenceFor: () => true,
}).catch(error => { console.error(error); process.exitCode = 1; });
