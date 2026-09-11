import { expect, it } from "vitest";
import { z } from "zod";
import { resolutionPlanCommitDirectiveSchema, truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { factorSharedBatchContexts } from "../../mechanics/shared-batch-context";
import { contentHash } from "../../models/model-audit";
import { composeJsonObjectPrompt } from "../../prompts";
import { focusedTruthOutput } from "./focused-truth-output";
import { recordedContext } from "./repair-tail";
import type { TemporalProbeBody } from "./temporal-diagnostic";

it.each(["plan", "transition"] as const)("preserves all %s source records, rules and scope without an empty-output example", kind => {
  const contexts = [0, 1].map(slot => ({ state: { actionSet: { assigned: [{ actionRef: `ref:action:${slot}`, rawText: `Complete compound action ${slot}: first inspect, then report only confirmed evidence.`,
    allowedMeansSources: [{ kind: "action", ref: `ref:action:${slot}` }], additionalEvidence: { literal: null, preserve: [false, 0, ""] } }] } }, referenceCatalog: { candidates: [] } }));
  const context = { state: factorSharedBatchContexts(contexts) };
  const schema = kind === "transition" ? truthTransitionBatchSchema : z.strictObject({ slots: z.array(z.strictObject({ slot: z.number().int().nonnegative(), result: resolutionPlanCommitDirectiveSchema })) });
  const base: TemporalProbeBody = { model: "deepseek-v4-flash", max_tokens: 131072, thinking: { type: "disabled" }, response_format: { type: "json_object" }, messages: [
    { role: "system", content: "Complete immutable world rules." }, { role: "user", content: composeJsonObjectPrompt({
      userPrompt: "Resolve every numbered slot independently and return exactly one {slot,result} entry per slot in the supplied output schema.",
      contextJson: JSON.stringify(context), schemaJson: JSON.stringify(z.toJSONSchema(schema, { target: "draft-07" })), exampleJson: '{"slots":[]}', discriminator: "Use explicit kinds.",
    }) },
  ] };
  const before = structuredClone(base), result = focusedTruthOutput(base, kind);
  expect(base).toEqual(before);
  expect(result.body.messages[0]).toEqual(base.messages[0]);
  expect(result.body.thinking).toEqual({ type: "disabled" });
  expect(result.body.response_format).toEqual({ type: "text" });
  const message = result.body.messages[1]!.content;
  expect(recordedContext(message).value).toEqual(context);
  expect(message).not.toContain("Example YAML output shape");
  expect(message).not.toContain("Example columns only");
  const records = JSON.parse(message.slice(message.lastIndexOf("\n") + 1));
  expect(records).toEqual(contexts.map((c, slot) => ({ slot, actions: c.state.actionSet.assigned })));
  expect(result.recordsHash).toBe(contentHash(records));
  expect(result.actionCount).toBe(2);
  expect(() => result.codec.decode({ slots: [0, 0] })).toThrow();
});
