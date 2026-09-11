import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CompiledAction } from "../../src/engine/algorithms/roles";
import type { WorldStepPreparation } from "../../src/engine/runtime/execution";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { bindResolutionAdmission, runResolutionAdmission, type ResolutionAdmissionSource } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { interactionDependencyForActivity } from "../../src/engine/mechanics/action-dependency";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { visiblePlanTargetHandles, visiblePlanTargetProvider } from "../../src/engine/mechanics/visible-plan-target-vocabulary";
import { contentHash } from "../../src/engine/models/model-audit";
import { loadModelCatalog } from "../../src/engine/models/model-catalog";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { ModelRegistry, resolveModelProfile } from "../../src/engine/models/model-registry";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionContextEvidence, admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";

const TRIAL = "probes-e2-visible-target-01";
const root = path.resolve(STEP_E2_PROTOCOL.root);
const hashes = {
  input: "6d186b6c2e61950aa3a4dbfd48e935a336e3c8a64e568acf320ad88010d6dd5d",
  preparation: "90f32ce91e2c766c98b197c777a9d516452dbdfba4b02c226f24f7de5928174b",
  replacement: "f738c35c9aae976ece655358b5e8ed5854fbb67c3210561e335ab957a91b3712",
  roots: ["186ed9b681f1554d1ccff8c5310257c0fd3a8a6938af53573320e9516bbb05a0", "4cb920218ed86239ce6480a23f3c2219b7028a42c32324bb61543846a28c3f3e"],
};
type Payload = { planningState: ResolutionAdmissionSource["state"]; newActions: ResolutionAdmissionSource["actions"];
  dependencyResults: Array<{ dependency: ResolutionAdmissionSource["groundings"][number] }>;
  temporalPlanning: Array<Pick<CompiledAction, "plan" | "activity">>;
  reactionRequests: WorldStepPreparation["pendingReactionRequests"]; sharedResourceAdmissions: Array<{ kind: string }> };
const adapt = (arm: string, provider: StructuredModelProvider) => arm === "C" ? visiblePlanTargetProvider(provider) : provider;

export function visibleTargetDecision(rows: ProbeRow[], incomplete: boolean) {
  if (incomplete || rows.length !== 4 || ["041", "007"].some(id => ["B", "C"].some(arm => rows.filter(row => row.rootId === id && row.arm === arm).length !== 1)) ||
    rows.some(row => row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  const baseline = rows.filter(row => row.arm === "B"), candidate = rows.filter(row => row.arm === "C");
  if (candidate.some(row => !row.complete)) return "failed";
  const sum = (values: ProbeRow[], key: "httpCalls" | "totalTokens" | "initialAdmittedActions") => values.reduce((total, row) => total + row[key]!, 0);
  if (sum(candidate, "httpCalls") > sum(baseline, "httpCalls") || sum(candidate, "initialAdmittedActions") < sum(baseline, "initialAdmittedActions")) return "failed";
  return baseline.some(row => !row.complete) || sum(candidate, "totalTokens") <= sum(baseline, "totalTokens") * 0.9
    ? "eligible-for-source-semantic-review" : "failed";
}

export async function prepareVisibleTargetProbe() {
  const artifact = (hash: string): unknown => {
    const value = JSON.parse(readFileSync(path.join(root, "evidence/visible-target-01/ledger-artifacts", `${hash}.json`), "utf8"));
    if (value.hash !== hash || contentHash(value.value) !== hash) throw new Error("captured Truth source artifact drift");
    return value.value;
  };
  const input = artifact(hashes.input) as { definition: ResolutionAdmissionSource["definition"] };
  const preparation = artifact(hashes.preparation) as WorldStepPreparation;
  const payload = preparation.payload as unknown as Payload;
  const compilation = artifact(hashes.replacement) as { accepted: Array<{ key: string; result: CompiledAction }>; rejected: unknown[] };
  // Reproduce the one recorded prepared-action replacement using its accepted
  // compiled result and the production footprint derivation. Canonical Truth
  // projection equality below proves the resulting planning snapshot.
  if (preparation.pendingReactionRequests.length || payload.sharedResourceAdmissions.some(value => value.kind !== "granted") ||
    Object.keys(payload.planningState.truth.sharedActivityResourcePools).length || compilation.rejected.length || compilation.accepted.length !== 1 ||
    preparation.preparedReactionDecisions.some(decision => decision.kind === "keep" && decision.ongoingActivityDisposition !== "continue")) throw new Error("captured onset behavior differs from the frozen replacement case");
  const replacements = preparation.preparedReactionDecisions.filter(decision => decision.kind === "replace");
  if (replacements.length !== 1) throw new Error("frozen onset replacement count changed");
  const decision = replacements[0]!, original = payload.reactionRequests.find(request => request.id === decision.requestId)?.originalIntent;
  const accepted = compilation.accepted[0]!;
  if (original?.kind !== "prepared_action" || accepted.key !== decision.replacementAction.id ||
    contentHash(accepted.result.activity.sourceAction) !== contentHash(decision.replacementAction)) throw new Error("replacement action binding mismatch");
  const old = payload.temporalPlanning.find(value => value.plan.actionId === original.actionId)?.activity;
  if (!old || !payload.planningState.truth.activities[old.id]) throw new Error("original prepared activity missing");
  const next = accepted.result;
  next.activity.interactionFootprint = interactionDependencyForActivity(payload.planningState, next.activity, next.dependency);
  next.activity.sharedResourceClaims = structuredClone(next.activity.interactionFootprint.sharedResourceClaims);
  delete payload.planningState.truth.activities[old.id];
  payload.planningState.truth.activities[next.activity.id] = structuredClone(next.activity);
  payload.newActions = payload.newActions.filter(action => action.id !== original.actionId).concat(structuredClone(decision.replacementAction));
  payload.newActions.sort((a, b) => a.actorId.localeCompare(b.actorId) || a.id.localeCompare(b.id));
  payload.dependencyResults = payload.dependencyResults.filter(value => value.dependency.id !== original.actionId).concat({ dependency: next.dependency });
  payload.dependencyResults.sort((a, b) => a.dependency.id.localeCompare(b.dependency.id));
  const history = JSON.parse(readFileSync(path.join(root, "runs/trajectory-e2-06/manifest.json"), "utf8"));
  const catalog = loadModelCatalog(path.join(root, "variants/finite-work-goal-02/model-catalog.json"));
  if (catalog.hash !== history.catalogHash) throw new Error("frozen catalog changed");
  const registry = new ModelRegistry(catalog, history.dataRoot, { fetch: async () => { throw new Error("frozen registry cannot refresh"); } });
  const snapshot = registry.snapshot(history.registrySnapshotHash);
  const profile = resolveModelProfile(catalog, snapshot, input.definition.modelProfiles.resolution);
  if (profile.accountId !== "deepseek-api" || profile.modelId !== STEP_E2_PROTOCOL.model || profile.profile.inference.thinking !== "disabled") throw new Error("approved model settings changed");
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh paired physical target vocabulary" });
  const cases = [];
  for (const [index, hash] of hashes.roots.entries()) {
    const original = artifact(hash) as { context: { state: SharedBatchContext } };
    const contexts = expandSharedBatchContexts(original.context.state);
    const source: ResolutionAdmissionSource = { definition: input.definition, state: payload.planningState, actions: payload.newActions,
      groundings: payload.dependencyResults.map(value => value.dependency), contexts };
    const bindings = bindResolutionAdmission(source);
    const assigned = bindings.reduce((sum, value) => sum + value.actions.length, 0);
    if (bindings.length !== (index ? 7 : 12) || assigned !== (index ? 7 : 41) || source.actions.length !== 48) throw new Error("complete source root cardinality changed");
    const initial: Record<string, ReturnType<typeof admissionRequestEvidence>> = {};
    for (const arm of ["B", "C"]) {
      const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline target capture"); } };
      await runResolutionAdmission(source, adapt(arm, offline), { candidate: true, contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1",
        contextLayout: SHARED_STATE_FIRST_LAYOUT, maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("target vocabulary fragmented the physical batch");
      initial[arm] = captures[0]!;
      const restored = expandSharedBatchContexts((initial[arm]!.context as { state: SharedBatchContext }).state);
      if (restored.some((value, i) => admissionContextEvidence(value) !== admissionContextEvidence(contexts[i]))) throw new Error("source context changed beyond unordered inventories");
    }
    const comparable = (arm: string) => Object.fromEntries(Object.entries(initial[arm]!).filter(([key]) => key !== "promptVersion" && key !== "wireJsonSchema"));
    if (contentHash(comparable("B")) !== contentHash(comparable("C"))) throw new Error("target arms changed something besides wire schema and prompt identity");
    cases.push({ id: index ? "007" : "041", source, initial, assigned, slots: bindings.length,
      targetCount: visiblePlanTargetHandles(initial.C!.context).length, sourceArtifact: hash });
  }
  const order = cases.flatMap(value => ["B", "C"].sort((a, b) => contentHash({ seed: 20260908, rootId: value.id, arm: a }).localeCompare(contentHash({ seed: 20260908, rootId: value.id, arm: b }))).map(arm => ({ rootId: value.id, arm })));
  const manifest = { trialId: TRIAL, seed: 20260908, order, maxHttp: 12, perArmRootMaxPhysicalRequests: 3, cacheNamespace,
    maximumRunNanoCny: 12 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    hashes, stateHash: contentHash(payload.planningState), actionsHash: contentHash(payload.newActions), catalogHash: catalog.hash, registrySnapshotHash: snapshot.hash,
    model: profile.modelId, inference: profile.profile.inference, sourceTrialId: "trajectory-e2-06",
    cases: cases.map(value => ({ rootId: value.id, slots: value.slots, actions: value.assigned, availableActions: value.source.actions.length, targetCount: value.targetCount,
      sourceHash: contentHash(value.source), sourceArtifact: value.sourceArtifact, initialRequestHashes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, contentHash(request)])),
      wireSchemaBytes: Object.fromEntries(Object.entries(value.initial).map(([arm, request]) => [arm, Buffer.byteLength(JSON.stringify(request.wireJsonSchema))])) })),
    acceptance: "Fresh paired bounded development probe on both complete original planning roots (12/7 slots, 41/7 actions, all 48 actions available). Reconstruct the recorded onset replacement from its accepted compiled artifact and require canonical snapshot equality with every original logical context. B and C share fixed state, actions, references, dependent fields, shared-json-v3, state-first layout, restricted closer recovery, repair bounds and disabled-thinking Flash settings. C changes only the physical plan target wire vocabulary and its prompt identity; each slot retains all 232 target-eligible entities. A common fresh cache namespace and frozen order apply; provider caching is best effort, not guaranteed isolation. Each cell permits one fresh initial HTTP and at most two repairs, at most twelve actual HTTP in total. No verifier calls, RNG, world commit, transport retries or redraw. Candidate must fully admit both roots, not lose first-HTTP admitted actions or increase HTTP; if B also completes both roots require at least 10% fewer total tokens. Unknown usage or missing pairs are inconclusive. Record schema overhead, cache, cost, latency and failures. Passing permits source semantic review only, not gameplay or general reliability claims.",
  };
  return { catalog, registry, snapshot, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({ trialId: TRIAL,
  prepare: prepareVisibleTargetProbe, decision: visibleTargetDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT, adaptPhysicalProvider: adapt,
}).catch(error => { console.error(error); process.exitCode = 1; });
