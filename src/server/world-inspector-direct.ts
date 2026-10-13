import type { CommittedStep, SimulationState } from "../engine/contracts/model";
import type { DirectRuntimeState } from "../engine/direct/contracts";
import { estimateModelCost } from "../engine/models/model-cost";

/** Trusted local audit projection. Private views remain absent from ordinary client DTOs. */
export function inspectDirectRuntime(before: SimulationState, step: CommittedStep) {
  if (!step.directEvent) return undefined;
  const record = step.directEvent, control = record.control;
  const prior = before.executionState?.data.kind === "direct-world" ? before.executionState.data as unknown as DirectRuntimeState : before.bootstrapDirect?.control;
  return { models: control.models, intents: control.intents, activities: control.activities, actions: record.frames, capabilities: control.capabilities,
    wakes: Object.entries(prior?.intents ?? {}).filter(([, intent]) => intent.status === "ready").map(([ownerId, intent]) => ({ ownerId, reasons: intent.wakeReasons })),
    decisions: record.decisions.map(use => ({ view: use.batch.view, questions: use.batch.questions, answers: use.result.answers,
      reused: use.reused, inputHash: use.result.inputHash, dependencies: use.batch.dependencies, diagnostics: use.result.diagnostics, dispatches: use.result.dispatches })),
    calls: record.modelAudits.map(audit => ({ subjectId: audit.subjectId, role: audit.role, model: audit.modelId,
      invocations: audit.invocations.map(invocation => ({ id: invocation.id, disposition: invocation.outputDisposition, usage: invocation.tokenUsage,
        transports: invocation.transports.length, cost: estimateModelCost(audit, invocation) })) })),
    completedActionIds: record.completedActionIds, reads: record.reads,
  };
}
