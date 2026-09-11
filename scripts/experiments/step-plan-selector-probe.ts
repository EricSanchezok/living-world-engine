import { pathToFileURL } from "node:url";
import { STEP_E2_PROTOCOL, STEP_E2_BUDGET } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { planSelectorProvider, stripPlanSelectorAnnotations, PLAN_SOURCE_SELECTORS } from "../../src/engine/mechanics/plan-source-selectors";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe } from "./step-state-prefix-probe";
import { prepareVisibleTargetProbe, visibleTargetDecision } from "./step-visible-target-probe";

const TRIAL = "probes-e2-plan-selectors-01";
const adapt = (arm: string, provider: StructuredModelProvider) => arm === "C" ? planSelectorProvider(provider) : provider;

export function assertSelectorSourcePreserved(baseline: unknown, candidate: unknown): void {
  const original = baseline as { state: SharedBatchContext };
  const restored = stripPlanSelectorAnnotations(candidate) as { state: SharedBatchContext };
  if (contentHash(expandSharedBatchContexts(original.state)) !== contentHash(expandSharedBatchContexts(restored.state))) throw new Error("selectors changed complete initial source context");
  if (contentHash({ ...original, state: null }) !== contentHash({ ...restored, state: null })) throw new Error("selectors changed outer task or repair context");
}

export async function preparePlanSelectorProbe() {
  // Reuse the strictly bound post-onset source reconstruction, not its paid
  // outputs or its unsuccessful target-enumeration treatment.
  const prepared = await prepareVisibleTargetProbe();
  const { catalog, snapshot } = prepared;
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh paired source selector representation" });
  const cases = [];
  for (const source of prepared.cases) {
    const initial: Record<string, ReturnType<typeof admissionRequestEvidence>> = {};
    for (const arm of ["B", "C"]) {
      const captures: ReturnType<typeof admissionRequestEvidence>[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline plan selector capture"); } };
      await runResolutionAdmission(source.source, adapt(arm, offline), { candidate: true, contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1",
        contextLayout: SHARED_STATE_FIRST_LAYOUT, maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("selectors fragmented the complete physical root");
      initial[arm] = captures[0]!;
    }
    assertSelectorSourcePreserved(initial.B!.context, initial.C!.context);
    if (contentHash(initial.B!.context) !== contentHash(source.initial.B!.context)) throw new Error("baseline source context drift");
    const unaffected = (arm: string) => Object.fromEntries(Object.entries(initial[arm]!).filter(([key]) => !["context", "system", "wireJsonSchema", "promptVersion"].includes(key)));
    if (contentHash(unaffected("B")) !== contentHash(unaffected("C"))) throw new Error("selector arms differ beyond the frozen representation");
    cases.push({ ...source, initial });
  }
  const order = cases.flatMap(source => ["B", "C"].sort((a, b) => contentHash({ seed: 20260908, rootId: source.id, arm: a }).localeCompare(contentHash({ seed: 20260908, rootId: source.id, arm: b }))).map(arm => ({ rootId: source.id, arm })));
  const manifest = { ...prepared.manifest, trialId: TRIAL, order, cacheNamespace, representation: PLAN_SOURCE_SELECTORS,
    protocolHash: contentHash(STEP_E2_PROTOCOL), budgetHash: contentHash(STEP_E2_BUDGET),
    cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), sourceArtifact: source.sourceArtifact,
      slots: source.slots, actions: source.assigned, availableActions: source.source.actions.length, targetCount: source.targetCount,
      initialRequestHashes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, contentHash(value)])),
      contextBytes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, Buffer.byteLength(JSON.stringify(value.context))])),
      wireSchemaBytes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, Buffer.byteLength(JSON.stringify(value.wireJsonSchema))])) })),
    acceptance: "Fresh paired bounded development probe on both original post-onset planning roots, 12/7 slots and 41/7 assigned actions with all 48 available actions. B and C retain identical complete source snapshots, actions, candidate domains, model/generation settings, dependent fields, shared-json-v3, state-first layout, closer parser and repair limits. C adds only the source-bound target/means selection representation. Removing initial selector annotations must restore every source value and shared context binding. No target enumeration treatment from the earlier failed probe is active. Fixed order and a common fresh namespace apply; caching is best effort and measured. Each cell permits one initial plus at most two repair HTTP, twelve total. No verifier requests, transport retry, RNG, world commit or redraw. Candidate must complete both roots, retain at least B's first-call admitted action count, and not increase HTTP; when B completes both roots C must also reduce total tokens at least 10%. Missing usage/pairs is inconclusive. Price/cache/order differences alone cannot qualify a candidate. Passing permits source semantic review only, never gameplay or general semantic claims.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({ trialId: TRIAL,
  prepare: preparePlanSelectorProbe, decision: visibleTargetDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT, adaptPhysicalProvider: adapt,
}).catch(error => { console.error(error); process.exitCode = 1; });
