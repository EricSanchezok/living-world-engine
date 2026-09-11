import { z } from "zod";
import { FlatBatchArrayCodec } from "../../mechanics/flat-batch-arrays";
import { resolutionPlanCommitDirectiveSchema, truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { contentHash } from "../../models/model-audit";
import { recordedContext, type RepairTailKind } from "./repair-tail";
import type { TemporalProbeBody } from "./temporal-diagnostic";
import { expandSharedBatchContexts, type SharedBatchContext } from "../../mechanics/shared-batch-context";

type ObjectValue = Record<string, unknown>;
const planSchema = z.strictObject({ slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), result: resolutionPlanCommitDirectiveSchema })) });

export class FlatTruthBatchCodec extends FlatBatchArrayCodec<z.infer<typeof planSchema> | z.infer<typeof truthTransitionBatchSchema>> {
  constructor(kind: RepairTailKind, count: number) {
    super(kind === "plan" ? planSchema : truthTransitionBatchSchema, count);
  }

  body(source: TemporalProbeBody): TemporalProbeBody {
    if (source.thinking.type !== "disabled") throw new Error("flat batch keeps thinking disabled");
    const body = structuredClone(source), message = body.messages[1]!.content;
    const context = recordedContext(message).value;
    if (expandSharedBatchContexts(context.state as SharedBatchContext).length !== this.count) throw new Error("flat batch source slot count mismatch");
    const parts = message.split("\nJSON Schema: ");
    if (parts.length !== 2) throw new Error("unique source schema required");
    const end = parts[1]!.indexOf("\n");
    if (end < 0 || contentHash(JSON.parse(parts[1]!.slice(0, end))) !== contentHash(z.toJSONSchema(this.originalSchema, { target: "draft-07" }))) throw new Error("flat batch source schema mismatch");
    const suffix = parts[1]!.slice(end);
    if (!suffix.startsWith("\nExample JSON output shape: ") || suffix.indexOf("\n", 1) < 0) throw new Error("flat batch source example boundary mismatch");
    const afterExample = suffix.slice(suffix.indexOf("\n", 1));
    const instruction = "Resolve every numbered slot independently and return exactly one {slot,result} entry per slot in the supplied output schema.";
    const prefix = parts[0]!;
    if (prefix.split(instruction).length !== 2) throw new Error("source batch instruction mismatch");
    const emptyColumns = Object.fromEntries(this.columns.map((key) => [key, []]));
    const notice = `Output codec: list each original slot number exactly once in slots. Put ${this.columns.join(", ")} arrays at the root, not inside slot/result objects. Each array item keeps every original field and adds its owning slot number. A column with no rows for a slot means that slot's corresponding array is empty; all root columns are mandatory even when empty.${Object.keys(this.constants).length ? " Root kind applies the same required discriminator to every slot." : ""} Preserve each slot's assigned actions, scope, references and complete original task. Every assigned action still needs its required plan/outcome. Do not transfer rows between slots or replace actions with empty arrays. The decoder only groups explicit rows; it supplies no world facts, effects or semantic judgments.`;
    body.messages[1]!.content = `${prefix.replace(instruction, notice)}\nJSON Schema: ${JSON.stringify(this.wireSchema)}\nExample JSON output shape (columns only; real output must cover every assigned action): ${JSON.stringify({ slots: Array.from({ length: this.count }, (_, i) => i), ...this.constants, ...emptyColumns })}${afterExample}`;
    if (contentHash(recordedContext(body.messages[1]!.content).value) !== contentHash(recordedContext(message).value)) throw new Error("flat batch changed input context");
    return body;
  }
}
