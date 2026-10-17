import { z } from "zod";
import { semanticIdSchema } from "../engine/contracts/state-schemas";

export const durationUnitSchema = z.object({
  id: semanticIdSchema,
  terms: z.array(z.string().trim().min(1)).min(1),
  seconds: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  location_ids: z.array(semanticIdSchema).default([]),
}).strict();
