import type { ModelExecutionAudit, SimulationState } from "../contracts/model";
import { contentHash } from "../models/model-audit";
import type { ModelExecutionScope, StructuredModelProvider } from "../models/model-provider";
import type { WorldRuntimeContract } from "../runtime/world-definition";
import { worldProgramDuration } from "./adjudication";
import { compileWorldProgram } from "./compiler";
import { WorldProgramLibrary } from "./library";
import { EventScheduler } from "./scheduler";
import { collectDecisionAudits, sealDecisionEventState, type DecisionEventState } from "./runtime-state";
import { worldProgramSources, worldResources } from "./resources";

/** Compile or bind only previously unhandled attempts. A failed input waits for an actual physical dependency change. */
export async function prepareProgramWorldWork(provider: StructuredModelProvider, definition: WorldRuntimeContract,
  state: Readonly<SimulationState>, initial: DecisionEventState, scope: ModelExecutionScope,
  nextInvocation: (subjectId: string, slots?: number) => number) {
  if (provider.catalog.hash !== initial.modelCatalogHash) throw new Error("world program model binding changed");
  const control = structuredClone(initial), library = new WorldProgramLibrary(control.worldLibrary);
  const resources = worldResources(state, definition, control.worldResources), sources = worldProgramSources(definition, state);
  const scheduler = new EventScheduler(state.truth.elapsedSeconds, control.scheduler), audits: ModelExecutionAudit[] = [];
  const physicalHash = contentHash({ sources, resources: Object.fromEntries(Object.entries(resources)
    .filter(([key]) => key !== "clock" && key !== "events" && key !== "rng" && !key.startsWith("random:"))) });
  scope = { ...scope, modelRegistrySnapshotHash: control.registryHash, runtimeIdentity: { worldHash: state.worldHash, revision: state.revision } };
  const results = await Promise.allSettled(control.pending.map(async pending => {
    if (pending.bound && pending.failure === null) return;
    if (pending.failure && pending.dependencyHash === physicalHash) return;
    pending.dependencyHash = physicalHash;
    if (pending.failure) pending.attempt.startedAtSeconds = state.truth.elapsedSeconds;
    const cached = library.lookup(pending.attempt, sources, new Set(Object.keys(state.truth.entities)), resources);
    if (cached) { pending.bound = cached; pending.failure = null; }
    else {
      const result = await compileWorldProgram(provider, { ...scope, profileId: control.models.creation,
        invocationBase: nextInvocation("world", 2), definition, state, resources, attempt: pending.attempt, reason: "new-intent" });
      if (result.audit) audits.push(result.audit);
      if (result.status === "failed") {
        pending.failure = result.reason; pending.bound = null; pending.atSeconds = null;
        control.failures.push({ ownerId: pending.attempt.actorId, phase: "world-rule", inputHash: physicalHash, reason: result.reason, recoverable: true });
        return;
      }
      library.add(result); pending.bound = result.bound; pending.failure = null;
    }
    pending.atSeconds = pending.attempt.startedAtSeconds + worldProgramDuration(pending.bound, resources);
    if (pending.atSeconds <= state.truth.elapsedSeconds) throw new Error("pending program action has missed its execution boundary");
  }));
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, "world program preparation failed");
  // Canonical insertion order is independent of model response arrival order.
  for (const pending of control.pending.filter(value => value.bound && !value.failure && value.atSeconds !== null)
    .sort((a, b) => a.atSeconds! - b.atSeconds! || a.attempt.id.localeCompare(b.attempt.id))) {
    const payload = { attemptId: pending.attempt.id };
    scheduler.schedule({ atSeconds: pending.atSeconds!, subjectId: null, kind: "world",
      inputHash: contentHash({ attempt: pending.attempt, program: pending.bound!.program.hash }), payload });
  }
  control.worldResources = resources; control.worldLibrary = library.snapshot(); control.scheduler = scheduler.snapshot();
  control.failures.sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.inputHash.localeCompare(b.inputHash));
  return { control: sealDecisionEventState(control), modelAudits: collectDecisionAudits(audits) };
}
