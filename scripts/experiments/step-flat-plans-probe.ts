import { pathToFileURL } from "node:url";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { factorTypesProvider } from "../../src/engine/mechanics/resolution-factor-types";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { loadPromptAsset } from "../../src/engine/prompts";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";
import { prepareFactorTypesProbe } from "./step-factor-types-probe";
import { FLAT_RESOLUTION_PLAN_BATCH, flatPlanBatchProvider, flatResolutionPlanWireSchema, planSlotBinding } from "../../src/engine/mechanics/flat-resolution-plan-batch";
import { SHARED_SLOT_RESULT_INSTRUCTION } from "../../src/engine/mechanics/truth-batch-provider";

const TRIAL = "probes-e2-flat-plans-01";
type Evidence = ReturnType<typeof admissionRequestEvidence>;
const adapt = (arm: string, inner: StructuredModelProvider) => factorTypesProvider(planSelectorProvider(arm === "L" ? flatPlanBatchProvider(inner) : inner));

export function flatPlansDecision(rows: ProbeRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 4 || ["041", "007"].some(id => ["B", "L"].some(arm => rows.filter(row => row.rootId === id && row.arm === arm).length !== 1)) ||
    rows.some(row => row.httpCalls !== 1 || row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  const candidate = rows.filter(row => row.arm === "L"), baseline = rows.filter(row => row.arm === "B");
  if (candidate.some(row => !row.complete)) return "failed-first-call-admission";
  const sum = (values: ProbeRow[], key: "initialAdmittedActions" | "totalTokens") => values.reduce((total, row) => total + row[key]!, 0);
  if (sum(candidate, "totalTokens") > sum(baseline, "totalTokens") || sum(candidate, "initialAdmittedActions") < sum(baseline, "initialAdmittedActions")) return "failed-first-call-efficiency";
  return sum(candidate, "initialAdmittedActions") > sum(baseline, "initialAdmittedActions") ? "eligible-for-source-semantic-review" : "eligible-for-source-semantic-review-no-first-call-gain";
}

export function assertFlatSourcePreserved(baseline: Evidence, candidate: Evidence): void {
  const independent = (value: Evidence) => ({ ...value, userPrompt: null, promptVersion: null, wireJsonSchema: null });
  if (contentHash(independent(baseline)) !== contentHash(independent(candidate))) throw new Error("flat experiment changed source or request settings");
  const instruction = loadPromptAsset("shared/flat-resolution-plan-batch.md");
  if (!baseline.wireJsonSchema) throw new Error("missing baseline wire schema");
  const binding = planSlotBinding(baseline.context), wire = flatResolutionPlanWireSchema(baseline.wireJsonSchema, binding);
  const namespaceAt = baseline.promptVersion.indexOf("/cache-namespace-");
  const baseVersion = namespaceAt < 0 ? baseline.promptVersion : baseline.promptVersion.slice(0, namespaceAt);
  const suffix = namespaceAt < 0 ? "" : baseline.promptVersion.slice(namespaceAt);
  if (baseline.userPrompt.split(SHARED_SLOT_RESULT_INSTRUCTION).length !== 2 ||
    candidate.userPrompt !== baseline.userPrompt.replace(SHARED_SLOT_RESULT_INSTRUCTION, instruction) ||
    candidate.promptVersion !== `${baseVersion}/${FLAT_RESOLUTION_PLAN_BATCH}@${contentHash({ instruction, wire, binding }).slice(0, 16)}${suffix}`) throw new Error("flat experiment changed instructions beyond its codec");
  if (contentHash(wire) !== contentHash(candidate.wireJsonSchema)) throw new Error("flat wire schema changed beyond its exact transform");
}

export async function prepareFlatPlansProbe() {
  const prepared = await prepareFactorTypesProbe(), { catalog, snapshot } = prepared;
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh paired flat plan representation" });
  const cases = [];
  for (const source of prepared.cases) {
    const initial: Record<string, Evidence> = {};
    for (const arm of ["B", "L"]) {
      const captures: Evidence[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline flat capture"); } };
      await runResolutionAdmission(source.source, adapt(arm, offline), { candidate: true, includeActivityTemporalEvidence: true,
        contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: SHARED_STATE_FIRST_LAYOUT,
        maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("flat representation split source root");
      initial[arm] = captures[0]!;
    }
    assertFlatSourcePreserved(initial.B!, initial.L!);
    if (contentHash(initial.B!.context) !== contentHash(source.initial.F!.context)) throw new Error("factor input baseline drift");
    cases.push({ ...source, initial });
  }
  const order = cases.flatMap(source => ["B", "L"].sort((a, b) => contentHash({ seed: 20260908, rootId: source.id, arm: a })
    .localeCompare(contentHash({ seed: 20260908, rootId: source.id, arm: b }))).map(arm => ({ rootId: source.id, arm })));
  const manifest = { ...prepared.manifest, trialId: TRIAL, seed: 20260908, order, cacheNamespace, maxHttp: 4, perArmRootMaxPhysicalRequests: 1,
    maximumRunNanoCny: 4 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    flatPlanRepresentation: FLAT_RESOLUTION_PLAN_BATCH,
    cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), stateHash: contentHash(source.source.state),
      slots: source.slots, actions: source.assigned, availableActions: source.source.actions.length,
      initialRequestHashes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, contentHash(value)])),
      contextUtf8Bytes: Buffer.byteLength(JSON.stringify(source.initial.B!.context)),
      wireSchemaUtf8Bytes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, Buffer.byteLength(JSON.stringify(value.wireJsonSchema))])) })),
    acceptance: "Prospective first-call development comparison, not a production baseline or gameplay claim. B retains experimental temporal evidence, factor types, source selectors, dependent fields, shared-json-v3, state-first and closer recovery; L changes only the flat physical plan output and exact source-bound wrapper restoration. Both retain the original 041/007 roots, 12/7 slots, 41/7 assigned actions, all 48 available actions, full canonical state and identical non-thinking generation settings. Same fresh cache namespace, fixed seeded block order, one fresh actual HTTP per cell, four maximum. No paid repair, warmup, verifier, RNG or world commit; no historical response replay. Both L roots must admit fully, retain at least as many initial actions as B, and consume no more total tokens to permit source semantic review. Equal initial counts are explicitly no first-call gain. Record actual cache, HTTP, latency and both cost measures; tariff/cache differences cannot establish intrinsic savings. Missing billing or incomplete pairs are inconclusive. Review every source action for timing, meaningful effects, numeric factor authority and scope, unchanged intent and unsupported no-effect or harm substitutions before promotion. Unknown, missing or duplicate action ownership rejects a whole physical output rather than salvaging partial slots, a declared tradeoff. This small probe cannot establish final repair recovery, runtime costs, general reliability or continuous gameplay. No within-trial source, prompt, parameter or candidate tuning.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({
  trialId: TRIAL, prepare: prepareFlatPlansProbe, decision: flatPlansDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
  adaptPhysicalProvider: adapt, activityTemporalEvidenceFor: () => true,
}).catch(error => { console.error(error); process.exitCode = 1; });
