import { pathToFileURL } from "node:url";
import { SHARED_STATE_FIRST_LAYOUT } from "../../src/engine/prompts/context-layout";
import { prepareStatePrefixProbe, runSourceAdmissionProbe, type ProbeRow } from "./step-state-prefix-probe";

const TRIAL = "probes-e2-plan-evidence-01";

export function planEvidenceDecision(rows: ProbeRow[], incomplete: boolean) {
  if (incomplete || rows.length !== 2 || ["016", "017"].some(rootId => rows.filter(row => row.rootId === rootId && row.arm === "C").length !== 1) ||
    rows.some(row => row.totalTokens === null || row.documentedKnownNanoCny === null)) return "inconclusive";
  return rows.every(row => row.complete) ? "eligible-for-source-semantic-review" : "failed";
}

export async function preparePlanEvidenceProbe() {
  // Reconstruct through the same complete source binding and offline capture.
  // No historical response or trial is resumed or counted as a new request.
  const prepared = await prepareStatePrefixProbe();
  const cases = prepared.cases.map(value => ({ ...value, initial: { C: value.initial.L! } }));
  const manifest = { ...prepared.manifest, trialId: TRIAL,
    order: cases.map(value => ({ rootId: value.id, arm: "C" })), maxHttp: 6,
    maximumRunNanoCny: prepared.manifest.maximumRunNanoCny / 2,
    sharedFoundation: { ...prepared.manifest.sharedFoundation, planEvidenceContract: "8da469a", contextLayout: SHARED_STATE_FIRST_LAYOUT },
    cases: prepared.manifest.cases.map(value => ({ ...value, initialRequestHashes: { C: value.initialRequestHashes.L! } })),
    acceptance: "Source-bound candidate feasibility, not an A/B benefit estimate. Use the original 016/017 roots with full 12/8 slots, 38/10 assigned actions, all 48 available actions and unchanged state, action content, temporal boundary, candidate scopes and disabled-thinking Flash settings. Shared-json-v3, dependent fields, restricted unmatched-closer recovery and shared-state-first layout remain selected. The plan schema now advertises the materializer's existing action/event/fact/law cause restriction and exact per-action means inventory; repair preserves detailed diagnostics from either classifier or audit. No semantic filling or reference substitution. Reuse the previous layout trial's common cache namespace explicitly as a warm operational condition, with provider best-effort caching and actual hits recorded; never infer a causal cost benefit against its historical results. Each original root gets one fresh initial generation and at most two repairs, six HTTP total. No transport retries, verifier, RNG or world commit. Both roots must completely admit all assigned actions; report first-HTTP completeness and per-action results separately. Missing usage, interruption or incomplete scope is inconclusive. Failure stops this trial; no silent redraw. Passing only permits source-bound semantic review before a separately frozen full-world trial. No claim of smooth gameplay, broader reliability or calibrated semantic correctness.",
  };
  return { ...prepared, cases, manifest };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runSourceAdmissionProbe({
  trialId: TRIAL, prepare: preparePlanEvidenceProbe, decision: planEvidenceDecision, layoutFor: () => SHARED_STATE_FIRST_LAYOUT,
}).catch(error => { console.error(error); process.exitCode = 1; });
