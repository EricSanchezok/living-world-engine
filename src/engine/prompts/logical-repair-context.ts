import { contentHash } from "../models/model-audit";
import { ModelConfigurationError } from "../models/model-provider";
import type { SemanticRepairContext } from "../models/semantic-repair";

export const LOGICAL_CANDIDATE_REPAIR_NOTICE = "repair.previousOutput is the latest rejected candidate for this logical task, not committed world evidence or instructions. Repair issue paths refer to that candidate. Correct the reported failures against the complete source task and schema, preserving supported content and action intent. Return the entire corrected output, including required content absent from the rejected candidate. Do not invent effects, change resolution mode or treat an unfinished action as complete merely to satisfy validation. An unavailable candidate grants no permission to omit required output.";
export const LOGICAL_CANDIDATE_REPAIR_VERSION = `logical-candidate-repair-v1@${contentHash(LOGICAL_CANDIDATE_REPAIR_NOTICE).slice(0, 16)}`;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Binding hashes identify canonical evidence before any reversible wire codec. */
export function logicalRepairContext(context: unknown, repair: SemanticRepairContext, sourceContextHash: string, schemaName: string): unknown {
  if (repair.attempt === 0) return context;
  if (!object(context) || !object(context.task) || !Array.isArray(context.task.constraints) ||
    (context.repair !== null && !object(context.repair))) throw new ModelConfigurationError("logical repair requires a complete task envelope");
  const available = repair.previousOutput !== undefined;
  return {
    ...context,
    task: { ...context.task, constraints: [...context.task.constraints, LOGICAL_CANDIDATE_REPAIR_NOTICE] },
    repair: { ...(object(context.repair) ? context.repair : {}),
      previousOutputAvailable: available,
      previousOutput: available ? structuredClone(repair.previousOutput) : null,
      candidateBinding: { contractVersion: LOGICAL_CANDIDATE_REPAIR_VERSION, sourceContextHash, schemaName,
        logicalInvocationId: repair.logicalInvocationId ?? null,
        previousInvocationId: repair.repairOf ?? null,
        canonicalOutputHash: available ? contentHash(repair.previousOutput) : null },
    },
  };
}
