import { capabilityModelsSchema, type CapabilityModels } from "../../src/engine/models/capability-bindings";

/** Bind operational profiles after literary approval, preserving every story field. */
export function bindRuntimeModels<T>(source: T, profiles: CapabilityModels): T {
  const selected = capabilityModelsSchema.parse(profiles);
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (key === "model_profiles") {
        capabilityModelsSchema.parse(item);
        return [key, structuredClone(selected)];
      }
      return [key, visit(item)];
    }));
  };
  return visit(source) as T;
}
