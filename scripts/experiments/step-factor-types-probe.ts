import { pathToFileURL } from "node:url";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { factorTypesProvider, RESOLUTION_FACTOR_TYPES, resolutionFactorTypesWireSchema } from "../../src/engine/mechanics/resolution-factor-types";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { loadPromptAsset } from "../../src/engine/prompts";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";
import { prepareTemporalEvidenceProbe } from "./step-temporal-evidence-probe";

const TRIAL = "probes-e2-factor-types-01";
type Evidence = ReturnType<typeof admissionRequestEvidence>;
const adapt = (arm: string, inner: StructuredModelProvider) => arm === "F" ? factorTypesProvider(planSelectorProvider(inner)) : planSelectorProvider(inner);

export function factorTypesDecision(rows: ProbeRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 4 || ["041", "007"].some(id => ["B", "F"].some(arm => rows.filter(row => row.rootId === id && row.arm === arm).length !== 1)) ||
    rows.some(row => row.httpCalls !== 1 || row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  const candidate = rows.filter(row => row.arm === "F"), baseline = rows.filter(row => row.arm === "B");
  if (candidate.some(row => !row.complete)) return "failed-first-call-admission";
  const sum = (values: ProbeRow[], key: "initialAdmittedActions" | "totalTokens") => values.reduce((total, row) => total + row[key]!, 0);
  if (sum(candidate, "totalTokens") > sum(baseline, "totalTokens") || sum(candidate, "initialAdmittedActions") < sum(baseline, "initialAdmittedActions")) return "failed-first-call-efficiency";
  return sum(candidate, "initialAdmittedActions") > sum(baseline, "initialAdmittedActions") ? "eligible-for-source-semantic-review" : "eligible-for-source-semantic-review-no-first-call-gain";
}

export function assertFactorSourcePreserved(baseline: Evidence, candidate: Evidence): void {
  const independent = (value: Evidence) => ({ ...value, system: null, promptVersion: null, wireJsonSchema: null });
  if (contentHash(independent(baseline)) !== contentHash(independent(candidate))) throw new Error("factor experiment changed source or request settings");
  const suffix = `\n\n${loadPromptAsset("shared/resolution-factor-types.md")}`;
  if (candidate.system.split(suffix).length !== 2 || candidate.system.replace(suffix, "") !== baseline.system ||
    !candidate.promptVersion.includes(`/${RESOLUTION_FACTOR_TYPES}@`)) throw new Error("factor experiment changed instructions beyond its codec");
  if (!baseline.wireJsonSchema || contentHash(resolutionFactorTypesWireSchema(baseline.wireJsonSchema)) !== contentHash(candidate.wireJsonSchema)) throw new Error("factor wire schema changed beyond its exact transform");
}

export async function prepareFactorTypesProbe() {
  const prepared = await prepareTemporalEvidenceProbe(), { catalog, snapshot } = prepared;
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh paired factor representation" });
  const cases = [];
  for (const source of prepared.cases) {
    const initial: Record<string, Evidence> = {};
    for (const arm of ["B", "F"]) {
      const captures: Evidence[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline factor capture"); } };
      await runResolutionAdmission(source.source, adapt(arm, offline), { candidate: true, includeActivityTemporalEvidence: true,
        contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: SHARED_STATE_FIRST_LAYOUT,
        maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("factor representation split source root");
      initial[arm] = captures[0]!;
    }
    assertFactorSourcePreserved(initial.B!, initial.F!);
    if (contentHash(initial.B!.context) !== contentHash(source.initial.T!.context)) throw new Error("temporal input baseline drift");
    cases.push({ ...source, initial });
  }
  const order = cases.flatMap(source => ["B", "F"].sort((a, b) => contentHash({ seed: 20260908, rootId: source.id, arm: a })
    .localeCompare(contentHash({ seed: 20260908, rootId: source.id, arm: b }))).map(arm => ({ rootId: source.id, arm })));
  const manifest = { ...prepared.manifest, trialId: TRIAL, seed: 20260908, order, cacheNamespace, maxHttp: 4, perArmRootMaxPhysicalRequests: 1,
    maximumRunNanoCny: 4 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    factorRepresentation: RESOLUTION_FACTOR_TYPES,
    cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), stateHash: contentHash(source.source.state),
      slots: source.slots, actions: source.assigned, availableActions: source.source.actions.length,
      initialRequestHashes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, contentHash(value)])),
      contextUtf8Bytes: Buffer.byteLength(JSON.stringify(source.initial.B!.context)),
      wireSchemaUtf8Bytes: Object.fromEntries(Object.entries(source.initial).map(([arm, value]) => [arm, Buffer.byteLength(JSON.stringify(value.wireJsonSchema))])) })),
    acceptance: "Prospective first-call-only development comparison, not a production baseline or gameplay claim. B retains the failed experimental temporal-evidence input plus source selectors, dependent fields, shared-json-v3, state-first and closer recovery; F changes only the explicit reversible factor wire representation. Both keep the original 041/007 roots, 12/7 slots, 41/7 assigned actions, all 48 available actions, full canonical state and identical non-thinking generation settings. Same fresh cache namespace, fixed seeded block order, one fresh actual HTTP per cell, four maximum. No paid repair, warmup, verifier, RNG or world commit; do not replay historical responses. Both F roots must admit fully, retain at least as many initial actions as B, and consume no more total tokens to permit source semantic review. Equal initial counts must be reported as no first-call gain. Record actual cache, HTTP, latency and both cost measures; tariff/cache differences cannot establish intrinsic algorithm savings. Missing billing or incomplete pairs are inconclusive. Review every source action for timing, meaningful effects, numeric factor authority and scope, unchanged intent and unsupported no-effect or harm substitutions before any further promotion consideration. This small probe cannot estimate final repair recovery, full runtime costs or general reliability; passing does not certify the temporal foundation, production superiority or continuous gameplay. No within-trial source, prompt, parameter or candidate tuning.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({
  trialId: TRIAL, prepare: prepareFactorTypesProbe, decision: factorTypesDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
  adaptPhysicalProvider: adapt, activityTemporalEvidenceFor: () => true,
}).catch(error => { console.error(error); process.exitCode = 1; });
