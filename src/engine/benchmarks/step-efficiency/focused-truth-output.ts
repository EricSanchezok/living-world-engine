import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { ActionOwnedPlanCodec } from "./action-owned-plan";
import { FlatTruthBatchCodec } from "./flat-truth-batch";
import { recordedContext, type RepairTailKind } from "./repair-tail";
import { physicalRequestContract } from "./physical-request-contract";
import { flatYamlTruthBody, yamlTruthBody } from "./yaml-truth-output";
import type { TemporalProbeBody } from "./temporal-diagnostic";

export const FOCUSED_TRUTH_VERSION = "source-records-owned-plan-flat-transition-yaml-v1";

/** A prospectively measured composite. Repeated data does not replace the
 * original context or authorize one slot to use another slot's references. */
export function focusedTruthOutput(source: TemporalProbeBody, kind: RepairTailKind) {
  const binding = physicalRequestContract(source, kind);
  const context = recordedContext(source.messages[1]!.content).value;
  const codec = kind === "plan" ? new ActionOwnedPlanCodec(context, true) : new FlatTruthBatchCodec(kind, binding.expanded.length);
  const body = codec instanceof ActionOwnedPlanCodec ? yamlTruthBody(codec.body(source)) : flatYamlTruthBody(source, codec);
  const parts = body.messages[1]!.content.split("\nExample YAML output shape:\n");
  if (parts.length !== 2) throw new Error("unique generated YAML example required");
  const records = binding.expanded.map((value, slot) => ({ slot, actions: z.object({ state: z.object({ actionSet: z.object({
    assigned: z.array(z.object({ actionRef: z.string().min(1) }).passthrough()).min(1),
  }) }) }).parse(value).state.actionSet.assigned }));
  const count = records.reduce((sum, row) => sum + row.actions.length, 0);
  const notice = `Complete work index: ${records.length} slots, ${count} assigned actions. The following records are copied exactly from each original slot's state.actionSet.assigned. Read every record and return its complete required plan/outcome in that slot. They are repeated source data, not new actions, completed work, or replacement world evidence. Keep the original per-slot reference scope and all rules above. allowedMeansSources retains its original means-only meaning; all factor types and other fields must still satisfy the output schema. Do not stop after the first slot or replace a compound action with one convenient subaction.`;
  body.messages[1]!.content = `${parts[0]!.replace("\nExample columns only; real output must cover every assigned action.", "")}\n\n${notice}\n${JSON.stringify(records)}`;
  if (contentHash(recordedContext(body.messages[1]!.content).value) !== binding.contextHash) throw new Error("focused output changed original context");
  for (const [slot, value] of binding.expanded.entries()) {
    if (contentHash((value as { state: { actionSet: { assigned: unknown } } }).state.actionSet.assigned) !== contentHash(records[slot]!.actions)) throw new Error("focused source record changed");
  }
  return { ...binding, body, codec, recordsHash: contentHash(records), actionCount: count, wireSchemaHash: contentHash(codec.wireSchema) };
}
