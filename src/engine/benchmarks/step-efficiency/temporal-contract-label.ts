type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value);

/** Render authored mechanics, never an estimated duration inferred from an
 * action. Explicit-duration profiles must not expose their default as a total. */
export function temporalContractLabel(details: unknown): string {
  if (!object(details) || !object(details.selection)) throw new Error("authored profile semantics missing");
  const positive = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error("invalid authored temporal value");
    return value;
  };
  switch (details.kind) {
    case "fixed":
      if (details.selection.evidenceRequirement === "explicit_duration") return "total_duration_from_action_text";
      return `whole_action_total_${positive(details.durationSeconds)}s`;
    case "conditional": return `until_success_check_every_${positive(details.checkEverySeconds)}s`;
    case "ongoing": return `no_automatic_completion_check_every_${positive(details.checkpointSeconds)}s`;
    case "rate":
      if (typeof details.unit !== "string" || !details.unit) throw new Error("authored rate unit missing");
      return `action_quantity_at_${positive(details.unitsPerPeriod)}_${details.unit}_per_${positive(details.periodSeconds)}s`;
    case "staged": {
      if (!Array.isArray(details.stages) || !details.stages.length || !details.stages.every(object)) throw new Error("authored stages missing");
      const total = details.stages.reduce((sum, stage) => sum + positive(stage.durationSeconds), 0);
      return `staged_work_total_${positive(total)}s`;
    }
    default: throw new Error("unsupported authored temporal kind");
  }
}
