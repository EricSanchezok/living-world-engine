import { z } from "zod";
import { accessSchema, factValueSchema, semanticIdSchema } from "../engine/contracts/state-schemas";

export const periodicPropertySchema = z.strictObject({
  id: semanticIdSchema,
  subject_id: semanticIdSchema,
  predicate: z.string().trim().min(1),
  access: accessSchema,
  period_seconds: z.number().int().positive().safe(),
  initial_phase_seconds: z.number().int().nonnegative().safe(),
  phases: z.array(z.strictObject({
    starts_at_seconds: z.number().int().nonnegative().safe(),
    value: factValueSchema,
    description: z.string().trim().min(1),
  })).min(2),
});
