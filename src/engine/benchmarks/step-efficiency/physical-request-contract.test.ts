import { expect, it } from "vitest";
import { z } from "zod";
import { truthTransitionBatchSchema } from "../../contracts/llm-schemas";
import { bindTruthBatchCardinality } from "../../mechanics/truth-batch-provider";
import { factorSharedBatchContexts } from "../../mechanics/shared-batch-context";
import { composeJsonObjectPrompt } from "../../prompts";
import type { TemporalProbeBody } from "./temporal-diagnostic";
import { physicalRequestContract } from "./physical-request-contract";

function fixture() {
  const contexts = [0, 1].map((slot) => ({ referenceCatalog: { candidates: [{ handle: `ref:action:${slot}` }] }, state: { literal: `Complete source ${slot}`, actionSet: { assigned: [{ actionRef: `ref:action:${slot}` }] } } }));
  const common = { userPrompt: "Execute all assigned actions.", contextJson: JSON.stringify({ state: factorSharedBatchContexts(contexts) }), discriminator: "Preserve explicit kinds." };
  const base: TemporalProbeBody = { model: "deepseek-v4-flash", max_tokens: 131072, thinking: { type: "disabled" }, response_format: { type: "json_object" }, messages: [
    { role: "system", content: "Complete world rules." },
    { role: "user", content: composeJsonObjectPrompt({ ...common, schemaJson: JSON.stringify(z.toJSONSchema(truthTransitionBatchSchema, { target: "draft-07" })), exampleJson: '{"slots":[]}' }) },
  ] };
  return { base, common, contexts };
}

it("matches runtime prompt rendering byte-for-byte while preserving complete source and settings", () => {
  const { base, common, contexts } = fixture(), before = structuredClone(base);
  const result = physicalRequestContract(base, "transition");
  expect(result.expanded).toEqual(contexts);
  const runtime = composeJsonObjectPrompt({ ...common, schemaJson: JSON.stringify(z.toJSONSchema(bindTruthBatchCardinality(truthTransitionBatchSchema, 2), { target: "draft-07" })) });
  expect(result.body.messages[1]!.content).toBe(runtime);
  result.body.messages[1]!.content = base.messages[1]!.content;
  expect(result.body).toEqual(base);
  expect(base).toEqual(before);
});

it("rejects changed schema/example and thinking settings instead of adapting the historical source", () => {
  const { base } = fixture();
  const altered = structuredClone(base);altered.messages[1]!.content += "Additional instruction";
  expect(() => physicalRequestContract(altered, "transition")).toThrow(/drift/u);
  expect(() => physicalRequestContract(base, "plan")).toThrow(/drift/u);
  base.thinking.type = "enabled";
  expect(() => physicalRequestContract(base, "transition")).toThrow(/nonthinking/u);
});
