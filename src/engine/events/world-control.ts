import type { RulePackageRegistry } from "../mechanics/rule-package";
import type { ModelExecutionAudit, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { ModelExecutionScope, StructuredModelProvider } from "../models/model-provider";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { worldProgramDuration } from "./adjudication";
import { compileWorldProgram } from "./compiler";
import { WorldProgramLibrary } from "./library";
import { EventScheduler } from "./scheduler";
import { collectDecisionAudits, sealDecisionEventState, type DecisionEventState } from "./runtime-state";
import { worldProgramSources, worldResources, programWorldResources } from "./resources";
import { deferWorldAttempt, worldInputUnchanged, worldRecoveryInput } from "./world-recovery";
import { DecisionRuntime } from "../programs/decision-runtime";
import { admitProgramActivities } from "./activities";

/** Compile or bind only previously unhandled attempts. A failed input waits for an actual physical dependency change. */
export async function prepareProgramWorldWork(provider: StructuredModelProvider, definition: WorldRuntimeContract,
  state: Readonly<SimulationState>, initial: DecisionEventState, scope: ModelExecutionScope,
  nextInvocation: (subjectId: string, slots?: number) => number, reason: "initial-coverage" | "new-intent" = "new-intent", rulePackages?: RulePackageRegistry) {
  if (provider.catalog.hash !== initial.modelCatalogHash) throw new Error("world program model binding changed");
  const control = structuredClone(initial), library = new WorldProgramLibrary(control.worldLibrary);
  const resources = worldResources(state, definition, control.worldResources), sources = worldProgramSources(definition, state);
  const scheduler = new EventScheduler(state.truth.elapsedSeconds, control.scheduler), audits: ModelExecutionAudit[] = [];
  scope = { ...scope, modelRegistrySnapshotHash: control.registryHash, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const results = await Promise.allSettled(control.pending.map(async pending => {
    if (pending.bound && pending.failure === null) return;
    const dependency = worldRecoveryInput(pending, resources, sources);
    const revisionUsed = pending.recovery?.revisedInputs.some(input => worldInputUnchanged(input, resources, sources)) ?? false;
    if (pending.failure && pending.dependencyHash === dependency.hash &&
      (pending.recovery?.disposition !== "expand" || revisionUsed)) return;
    const rejection = pending.failure ? { reason: pending.failure, program: pending.bound,
      evidenceHashes: pending.recovery?.evidenceHashes ?? [] } : undefined;
    const expanding = pending.recovery?.disposition === "expand";
    // An unchanged input gets at most one targeted semantic revision, including
    // revisions whose newly generated read declaration differs from the old one.
    if (expanding && revisionUsed) return;
    if (expanding) pending.recovery!.revisedInputs.push({ reads: dependency.reads, sourceHashes: dependency.sourceHashes });
    pending.dependencyHash = dependency.hash;
    if (pending.failure) pending.attempt.startedAtSeconds = state.truth.elapsedSeconds;
    const cached = library.lookup(pending.attempt, sources, new Set(Object.keys(state.truth.entities)), resources);
    if (cached && !pending.recovery?.rejectedProgramHashes.includes(cached.program.hash)) { pending.bound = cached; pending.failure = null; }
    else {
      const result = await compileWorldProgram(provider, { ...scope, profileId: control.models.creation,
        invocationBase: nextInvocation("world", 2), definition, state, resources, rulePackages, attempt: pending.attempt,
        reason: rejection ? "revision" : reason, ...(rejection ? { rejection } : {}) });
      if (result.audit) audits.push(result.audit);
      if (result.status === "failed") {
        pending.bound = null;
        deferWorldAttempt(pending, resources, sources, result.reason, null);
        control.failures.push({ ownerId: pending.attempt.actorId, phase: "world-rule", inputHash: dependency.hash, reason: result.reason, recoverable: true });
        return;
      }
      library.add(result); pending.bound = result.bound; pending.failure = null;
    }
    pending.atSeconds = pending.attempt.startedAtSeconds + worldProgramDuration(pending.bound, resources);
    if (pending.atSeconds <= state.truth.elapsedSeconds) throw new Error("pending program action has missed its execution boundary");
  }));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "world program preparation failed");
  const activityAdmissionInput = structuredClone(control.pending);
  const runtime = new DecisionRuntime(provider, control.decisionCache ?? undefined);
  const admission = await admitProgramActivities(runtime, state, definition, resources, control.pending, control.activities, {
    ...scope, profileId: control.models.decision, fallbackProfileId: control.models.fallback, nextInvocation: () => nextInvocation("world"),
  });
  control.pending = admission.pending; control.activities = admission.activities;
  for (const pending of control.pending) if (pending.failure && activityAdmissionInput.find(value => value.attempt.id === pending.attempt.id)?.failure !== pending.failure) {
    control.failures.push({ ownerId: pending.attempt.actorId, phase: "activity", inputHash: pending.dependencyHash, reason: pending.failure, recoverable: true });
  }
  control.decisionCache = runtime.snapshot() as unknown as import("../runtime/json").JsonObject;
  audits.push(...admission.calls.filter(call => !call.reused).map(call => call.result.audit));
  for (const queued of scheduler.snapshot().pending) if (queued.kind === "world" && !control.pending.some(pending =>
    pending.attempt.id === (queued.payload as { attemptId: string }).attemptId && !pending.failure && pending.atSeconds === queued.atSeconds)) scheduler.cancel(queued.id);
  // Canonical insertion order is independent of model response arrival order.
  for (const pending of control.pending.filter(value => value.bound && !value.failure && value.atSeconds !== null)
    .sort((a, b) => a.atSeconds! - b.atSeconds! || a.attempt.id.localeCompare(b.attempt.id))) {
    const payload = { attemptId: pending.attempt.id };
    scheduler.schedule({ atSeconds: pending.atSeconds!, subjectId: null, kind: "world",
      inputHash: contentHash({ attempt: pending.attempt, program: pending.bound!.program.hash }), payload });
  }
  control.worldResources = programWorldResources(state, definition, control.activities, initial.worldResources);
  control.worldLibrary = library.snapshot(); control.scheduler = scheduler.snapshot();
  control.failures.sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.inputHash.localeCompare(b.inputHash));
  return { control: sealDecisionEventState(control), modelAudits: collectDecisionAudits(audits), decisions: admission.calls, activityAdmissionInput };
}
