import { z } from "zod";
import type { SimulationState } from "../contracts/model";

export const capabilityModelsSchema = z.object({ decision: z.string().min(1), creation: z.string().min(1), fallback: z.string().min(1) }).strict();
export type CapabilityModels = z.infer<typeof capabilityModelsSchema>;
export type CapabilityModelOverrides = { decision: string | null; creation: string | null; fallback: string | null };

/** Null inherits the script's pinned capability; a comparison may override decisions alone. */
export function resolveCapabilityModels(profiles: CapabilityModels, overrides: CapabilityModelOverrides): CapabilityModels {
  return capabilityModelsSchema.parse(Object.fromEntries(Object.entries(profiles).map(([role, profile]) =>
    [role, overrides[role as keyof CapabilityModels] ?? profile])));
}
export function agentCapabilityModels(state: Readonly<SimulationState>, control: { modelOverrides: CapabilityModelOverrides }, ownerId: string): CapabilityModels {
  const owner = state.agents[ownerId]; if (!owner) throw new Error("model binding has no owning Agent");
  return resolveCapabilityModels(owner.modelProfiles, control.modelOverrides);
}
