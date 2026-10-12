import { z } from "zod";
import type { SimulationState } from "../contracts/model";

export const eventModelProfilesSchema = z.object({
  decision: z.string().min(1), creation: z.string().min(1), fallback: z.string().min(1),
}).strict();
export type DecisionEventModels = z.infer<typeof eventModelProfilesSchema>;
export const eventModelOverridesSchema = z.object({
  decision: z.string().min(1).nullable(), creation: z.string().min(1).nullable(), fallback: z.string().min(1).nullable(),
}).strict();
export type DecisionEventModelOverrides = z.infer<typeof eventModelOverridesSchema>;
export const INHERIT_EVENT_MODELS: DecisionEventModelOverrides = Object.freeze({ decision: null, creation: null, fallback: null });

/** Null selects the script's pinned profile. Explicit experiment settings override that one capability. */
export function resolveEventModels(profiles: DecisionEventModels, overrides: DecisionEventModelOverrides): DecisionEventModels {
  return eventModelProfilesSchema.parse(Object.fromEntries(Object.entries(profiles).map(([role, profile]) =>
    [role, overrides[role as keyof DecisionEventModels] ?? profile])));
}
export function agentEventModels(state: Readonly<SimulationState>,
  control: { modelOverrides: DecisionEventModelOverrides }, ownerId: string): DecisionEventModels {
  const owner = state.agents[ownerId];
  if (!owner) throw new Error("model binding has no owning Agent");
  return resolveEventModels(owner.modelProfiles, control.modelOverrides);
}
