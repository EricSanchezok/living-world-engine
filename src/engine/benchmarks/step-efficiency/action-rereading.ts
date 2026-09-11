import { temporalProbeContext, type TemporalProbeBody } from "./temporal-diagnostic";

/** RE2-inspired input repetition. No query rewriting, output fields, planning
 * pass, schema change or action truncation is introduced. */
export function rereadActionBody(source: TemporalProbeBody): TemporalProbeBody {
  const records = temporalProbeContext(source).task.slots.map(({ slot, action }) => ({ slot, action }));
  const body = structuredClone(source), user = body.messages.find((message) => message.role === "user")!;
  user.content += "\n\nRead the same complete source action records again. These are identical input data, not additional actions or evidence that any requested work has already been completed. Compile the full original scope using the JSON Schema above.\n" + JSON.stringify(records);
  return body;
}
