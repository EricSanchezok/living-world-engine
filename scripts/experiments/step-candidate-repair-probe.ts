import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolutionPlanCommitDirectiveSchema } from "../../src/engine/contracts/llm-schemas";
import { STEP_E2_PROTOCOL } from "../../src/engine/benchmarks/step-efficiency/nonthinking-protocol";
import { planSelectorRequest, stripPlanSelectorAnnotations } from "../../src/engine/mechanics/plan-source-selectors";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../src/engine/mechanics/shared-batch-context";
import { contentHash } from "../../src/engine/models/model-audit";
import { logicalRepairContext, LOGICAL_CANDIDATE_REPAIR_VERSION } from "../../src/engine/prompts/logical-repair-context";
import { prepareHistoricalPlanRecovery, runHistoricalPlanRecovery } from "./step-check-feedback-probe";
import { admissionRequestEvidence } from "./step-runtime-admission-probe";

const TRIAL = "probes-e2-candidate-repair-01";
type Evidence = ReturnType<typeof admissionRequestEvidence>;
type Context = { task: { assignment: unknown }; repair: { candidateBinding: {
  contractVersion: string; schemaName: string; sourceContextHash: string; canonicalOutputHash: string;
  logicalInvocationId: string; previousInvocationId: string;
} } };

/** Bind output-relative feedback to the actual first decoded slot and unchanged source. */
export function assertCandidateRepairDelta(old: Evidence, next: Evidence, initial: Evidence, decoded: unknown): void {
  const previous = old.context as { state: SharedBatchContext }, actual = next.context as { state: SharedBatchContext };
  if (contentHash({ ...old, context: null }) !== contentHash({ ...next, context: null }) ||
    contentHash({ ...previous, state: null }) !== contentHash({ ...actual, state: null })) throw new Error("candidate repair metadata changed");
  const source = expandSharedBatchContexts((stripPlanSelectorAnnotations(initial.context) as { state: SharedBatchContext }).state);
  const before = expandSharedBatchContexts(previous.state), after = expandSharedBatchContexts(actual.state);
  const slots = (decoded as { slots: { slot: number; result: unknown }[] }).slots;
  if (before.length !== 2 || after.length !== before.length || !Array.isArray(slots) || slots.length !== source.length) throw new Error("candidate repair slot count changed");
  for (const [index, previousContext] of before.entries()) {
    const context = after[index]! as unknown as Context;
    const owner = source.map((entry, slot) => ({ entry, slot })).filter(({ entry }) =>
      contentHash((entry.task as { assignment: unknown }).assignment) === contentHash((previousContext.task as { assignment: unknown }).assignment));
    if (owner.length !== 1) throw new Error("candidate repair owner ambiguous");
    const original = owner[0]!, values = slots.filter(slot => slot.slot === original.slot);
    const binding = context.repair.candidateBinding;
    if (values.length !== 1 || !binding || binding.contractVersion !== LOGICAL_CANDIDATE_REPAIR_VERSION ||
      binding.schemaName !== "truth_resolution_plan_commit" || binding.sourceContextHash !== contentHash(original.entry) ||
      binding.canonicalOutputHash !== contentHash(values[0]!.result) || !binding.logicalInvocationId || !binding.previousInvocationId)
      throw new Error("candidate repair source/output binding changed");
    const canonical = logicalRepairContext(stripPlanSelectorAnnotations(previousContext), {
      attempt: 1, scope: "component", targetIds: [], issues: [], previousOutput: values[0]!.result,
      logicalInvocationId: binding.logicalInvocationId, repairOf: binding.previousInvocationId,
    }, contentHash(original.entry), binding.schemaName);
    const expected = planSelectorRequest({ profileId: "truth-engine", workloadId: "binding-check", batchId: "binding-check", role: "truth-resolution", subjectId: "binding-check",
      schemaName: binding.schemaName, schema: resolutionPlanCommitDirectiveSchema, promptVersion: "binding-check",
      system: "binding-check", userPrompt: "binding-check", context: canonical }).context;
    if (contentHash(expected) !== contentHash(context)) throw new Error("repair changed beyond exact bound candidate evidence");
  }
}

export async function prepareCandidateRepairProbe() {
  const result = await prepareHistoricalPlanRecovery({ trialId: TRIAL,
    previousRepairFile: path.resolve(STEP_E2_PROTOCOL.root, "runs/probes-e2-check-feedback-01/041-request-2.json.gz"),
    assertRepair: (old, next, initial, decoded) => {
      if (contentHash(old) !== "de2650e459b150dc90abe6388f5fdc857ba13f29a8060a23e61320cc6ecc078d") throw new Error("historical diagnostic request changed");
      assertCandidateRepairDelta(old, next, initial, decoded);
    },
    acceptance: "Frozen-response repair feasibility, not a fresh first-call or paired effectiveness estimate. Replay the exact original first HTTP responses for full 7/41-action planning roots with complete 48-action source state; verify historical actual request-body hashes, decoded candidate ownership, canonical source/output bindings and unchanged source fields. Only logical repair gains the complete last rejected candidate and its notice; normalization diagnostics remain slot-local. Preserve original first-response admission 7/29, selectors, dependent fields, source and root cardinality, thinking disabled, all generation settings and two-repair limit. Maximum two NEW HTTP total, zero for the valid control; no transport retry, verifier, RNG, world commit or redraw. Both roots must complete before source semantic review. Missing usage, control/source drift or interruption is inconclusive. Report candidate overhead, repair tokens/HTTP, cache, latency and cost separately from historical replay. Specifically review unchanged action intent, supported effects, ongoing activity and premature completion before any promotion.",
  });
  return { ...result, manifest: { ...result.manifest, repairEvidenceContract: LOGICAL_CANDIDATE_REPAIR_VERSION } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runHistoricalPlanRecovery(TRIAL, prepareCandidateRepairProbe).catch(error => { console.error(error); process.exitCode = 1; });
