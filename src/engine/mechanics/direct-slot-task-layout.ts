import { z } from "zod";
import { expandSharedBatchContexts, isSharedBatchContext } from "./shared-batch-context";

export const DIRECT_SLOT_TASK_NOTICE = "The final task.slots index directly repeats each slot's original task fields, assignedActions and assignedDependencies from its hash-bound reconstructed context. Return one plan for each assignedActions actionRef in that slot; all other shared context remains available under the existing reconstruction rules, and another slot's records do not extend this slot's responsibility or references.";

/** Read-only task excerpts near the output contract; see decision 0108. */
export function directSlotTaskLayout(value: unknown): Record<string, unknown> {
  const envelope = z.object({ task: z.record(z.string(), z.unknown()), state: z.unknown() }).passthrough().parse(value);
  if (!isSharedBatchContext(envelope.state)) throw new Error("direct task layout requires a shared slot context");
  const batch = envelope.state;
  const slots = expandSharedBatchContexts(batch).map((context, slot) => {
    const original = z.object({ task: z.record(z.string(), z.unknown()), state: z.object({
      actionSet: z.object({ assigned: z.array(z.unknown()) }), dependencySet: z.object({ assigned: z.array(z.unknown()) }),
    }) }).parse(context);
    return { ...structuredClone(original.task), slot, contextHash: batch.slots[slot]!.contextHash,
      assignedActions: structuredClone(original.state.actionSet.assigned),
      assignedDependencies: structuredClone(original.state.dependencySet.assigned) };
  });
  return { ...structuredClone(envelope), task: { ...structuredClone(envelope.task), slots } };
}
