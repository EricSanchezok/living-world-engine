import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { STEP_E2_BUDGET, STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { runResolutionAdmission } from "../../src/engine/benchmarks/step-efficiency/resolution-admission";
import { flatPlanBatchProvider } from "../../src/engine/mechanics/flat-resolution-plan-batch";
import { factorTypesProvider } from "../../src/engine/mechanics/resolution-factor-types";
import { planSelectorProvider } from "../../src/engine/mechanics/plan-source-selectors";
import { planChoiceDomains, sourceBoundPlanChoicesProvider, sourceBoundPlanChoiceSchema, SOURCE_BOUND_PLAN_CHOICES } from "../../src/engine/mechanics/source-bound-plan-choices";
import { contentHash } from "../../src/engine/models/model-audit";
import { ModelConfigurationError, type StructuredModelProvider } from "../../src/engine/models/model-provider";
import { loadPromptAsset } from "../../src/engine/prompts";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";
import { cacheNamespaceRequest, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";
import { prepareVisibleTargetProbe } from "./step-visible-target-probe";

const TRIAL = "probes-e2-source-choices-01";
const SOURCE_TRIAL = "probes-e2-flat-plans-01";
type Evidence = ReturnType<typeof admissionRequestEvidence>;
const adapt = (arm: string, inner: StructuredModelProvider) => factorTypesProvider(planSelectorProvider(flatPlanBatchProvider(arm === "D" ? sourceBoundPlanChoicesProvider(inner) : inner)));

export function sourceChoicesDecision(rows: ProbeRow[], incomplete: boolean): string {
  if (incomplete || rows.length !== 2 || ["041", "007"].some(id => rows.filter(row => row.rootId === id && row.arm === "D").length !== 1) ||
    rows.some(row => row.httpCalls !== 1 || row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  return rows.every(row => row.complete && row.initialAdmittedActions === (row.rootId === "041" ? 41 : 7))
    ? "eligible-for-source-semantic-review-no-comparative-claim" : "failed-first-call-admission";
}

export function withoutProbeNamespace(evidence: Evidence, namespace: string): Evidence {
  const prefix = `[Transport cache namespace: ${namespace}; this identifier carries no world facts or action instructions.]\n\n`;
  const suffix = `/cache-namespace-${namespace}`;
  if (!evidence.system.startsWith(prefix) || !evidence.promptVersion.endsWith(suffix)) throw new Error("frozen namespace mismatch");
  return { ...evidence, system: evidence.system.slice(prefix.length), promptVersion: evidence.promptVersion.slice(0, -suffix.length) };
}

export function assertSourceChoiceTransform(baseline: Evidence, candidate: Evidence, namespace: string): void {
  const before = withoutProbeNamespace(baseline, namespace), after = withoutProbeNamespace(candidate, namespace);
  const independent = (value: Evidence) => ({ ...value, userPrompt: null, promptVersion: null, wireJsonSchema: null });
  if (contentHash(independent(before)) !== contentHash(independent(after))) throw new Error("choice schema changed source or generation contract");
  if (!before.wireJsonSchema) throw new Error("missing baseline wire schema");
  const instruction = loadPromptAsset("shared/source-bound-plan-choices.md"), domains = planChoiceDomains(before.context);
  const wire = sourceBoundPlanChoiceSchema(before.wireJsonSchema, domains);
  if (after.userPrompt !== `${before.userPrompt}\n\n${instruction}` ||
    after.promptVersion !== `${before.promptVersion}/${SOURCE_BOUND_PLAN_CHOICES}@${contentHash({ instruction, wire, domains }).slice(0, 16)}` ||
    contentHash(after.wireJsonSchema) !== contentHash(wire)) throw new Error("choice transform differs from the exact bound schema and instruction");
}

export async function prepareSourceChoicesProbe() {
  // Reconstruct the immutable original state directly; verify the complete
  // current foundation against its frozen physical request instead of rerunning
  // every intervening experiment's offline arm matrix.
  const prepared = await prepareVisibleTargetProbe(), { catalog, snapshot } = prepared;
  const directory = path.resolve(STEP_E2_PROTOCOL.root, "runs", SOURCE_TRIAL);
  const history = JSON.parse(readFileSync(path.join(directory, "manifest.json"), "utf8"));
  if (!history.commit.startsWith("97c0809") || history.catalogHash !== catalog.hash || history.registrySnapshotHash !== snapshot.hash) throw new Error("frozen flat foundation changed");
  const cacheNamespace = contentHash({ trialId: TRIAL, version: 1, purpose: "fresh complete-source choice qualification" });
  const cases = [];
  for (const source of prepared.cases) {
    const prior = JSON.parse(gunzipSync(readFileSync(path.join(directory, `${source.id}-L-request-1.json.gz`))).toString("utf8")) as Evidence;
    const priorCase = history.cases.find((value: { rootId: string }) => value.rootId === source.id);
    if (priorCase?.sourceHash !== contentHash(source.source) || priorCase.initialRequestHashes.L !== contentHash(prior)) throw new Error("frozen source request mismatch");
    const initial: Record<string, Evidence> = {};
    for (const arm of ["B", "D"]) {
      const captures: Evidence[] = [];
      const offline: StructuredModelProvider = { catalog, availableProfileSummaries: role => catalog.profileSummaries(role), assertProfilesAvailable: async () => {},
        generateStructured: async request => { captures.push(admissionRequestEvidence(cacheNamespaceRequest(request, cacheNamespace))); throw new ModelConfigurationError("offline source choice capture"); } };
      await runResolutionAdmission(source.source, adapt(arm, offline), { candidate: true, includeActivityTemporalEvidence: true,
        contextCodec: "shared-json-v3", jsonSyntaxRecovery: "unmatched-closers-v1", contextLayout: SHARED_STATE_FIRST_LAYOUT,
        maxPhysicalRequests: 1, scope: { modelRegistrySnapshotHash: snapshot.hash } });
      if (captures.length !== 1) throw new Error("source choice capture failed or split");
      initial[arm] = captures[0]!;
    }
    if (contentHash(withoutProbeNamespace(initial.B!, cacheNamespace)) !== contentHash(withoutProbeNamespace(prior, history.cacheNamespace))) throw new Error("current flat foundation differs from its frozen request");
    assertSourceChoiceTransform(initial.B!, initial.D!, cacheNamespace);
    cases.push({ ...source, initial });
  }
  const manifest = { ...prepared.manifest, trialId: TRIAL, sourceTrialId: SOURCE_TRIAL, sourceManifestHash: contentHash(history),
    order: cases.map(source => ({ rootId: source.id, arm: "D" })), cacheNamespace, maxHttp: 2, perArmRootMaxPhysicalRequests: 1,
    maximumRunNanoCny: 2 * (STEP_E2_PROTOCOL.inputTokenCeiling * STEP_E2_BUDGET.inputMissNanoCnyPerToken + STEP_E2_PROTOCOL.outputTokenCeiling * STEP_E2_BUDGET.outputNanoCnyPerToken),
    choiceSchema: SOURCE_BOUND_PLAN_CHOICES, protocolHash: contentHash(STEP_E2_PROTOCOL),
    cases: cases.map(source => ({ rootId: source.id, sourceHash: contentHash(source.source), slots: source.slots, actions: source.assigned,
      availableActions: source.source.actions.length, domains: planChoiceDomains(source.initial.D!.context),
      initialRequestHashes: Object.fromEntries(Object.entries(source.initial).map(([arm, request]) => [arm, contentHash(request)])),
      contextUtf8Bytes: Buffer.byteLength(JSON.stringify(source.initial.D!.context)),
      wireSchemaUtf8Bytes: Object.fromEntries(Object.entries(source.initial).map(([arm, request]) => [arm, Buffer.byteLength(JSON.stringify(request.wireJsonSchema))])) })),
    acceptance: "Prospective candidate qualification on the original complete 041/007 source roots. Two actual first-call requests, one per root, no paid baseline, repair, warmup, verifier, RNG or world commit. The offline B exists only to verify unchanged source and prior flat foundation; its output is not measured or replayed. D retains temporal evidence, factor types, source selectors, dependent fields, flat plan grouping, shared-json-v3, state-first, closer recovery and identical disabled-thinking Flash settings. Only the exact source-bound action/target choice schema and its instruction change. Full 12/7 slots, 41/7 assigned actions, all48 available actions and all232 target choices remain. Both candidate roots must fully admit with known usage to permit source semantic review. Failure stops this candidate's qualification; no response-dependent tuning or extra requests. Report all HTTP, token, cache, latency and cost measurements. There is no prospective efficacy comparison; historical outcomes do not establish causal gains, final repair recovery, runtime costs or general reliability. Review every source action for timing, faithful intent, effect support and factor authority before a new full-world diagnostic. Mechanical admission does not certify open semantics or gameplay. This narrower development gate replaces another paid B/L comparison, not the final continuous-gameplay acceptance criteria.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({
  trialId: TRIAL, prepare: prepareSourceChoicesProbe, decision: sourceChoicesDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
  adaptPhysicalProvider: adapt, activityTemporalEvidenceFor: () => true,
}).catch(error => { console.error(error); process.exitCode = 1; });
