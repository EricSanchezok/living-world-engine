import { z } from "zod";
import { contentHash } from "../../models/model-audit";
import { STEP_E2_PROTOCOL } from "./nonthinking-protocol";

export const strictToolCases = [
  { id: "closed-required-enum-numeric", schema: z.strictObject({ gate: z.enum(["permit"]), count: z.number().int().min(2).max(3),
    nested: z.strictObject({ enabled: z.boolean() }) }),
  conflictingValue: { gate: "deny", count: -5, extra: "unexpected" } },
  { id: "nested-anyof-pattern-array", schema: z.strictObject({
    evidence: z.union([z.strictObject({ kind: z.enum(["fact"]), ref: z.string().regex(/^ref:fact:[0-9]+$/u) }),
      z.strictObject({ kind: z.enum(["event"]), ref: z.string().regex(/^ref:event:[0-9]+$/u) })]),
    rows: z.array(z.strictObject({ flag: z.boolean(), quantity: z.number().min(0) })),
  }), conflictingValue: { evidence: { kind: "placement", ref: "bad" }, rows: [{ flag: "yes", quantity: -4, extra: true }] } },
] as const;

export function strictToolDesign() {
  const order = strictToolCases.flatMap((test) => [0, 1, 2].flatMap((repetition) => (["B", "P"] as const)
    .map((arm) => ({ caseId: test.id, repetition, arm }))
    .sort((a, b) => contentHash({ seed: STEP_E2_PROTOCOL.seed, ...a }).localeCompare(contentHash({ seed: STEP_E2_PROTOCOL.seed, ...b })))));
  const bodies = order.map((row) => {
    const test = strictToolCases.find((t) => t.id === row.caseId)!;
    return { model: STEP_E2_PROTOCOL.model, thinking: { type: "disabled" }, max_tokens: 2048,
      messages: [{ role: "system", content: `This is a synthetic API schema-adherence measurement. Submit exactly one submit_result tool call. No world state is being executed. Measurement tag: ${row.caseId}/${row.repetition}.` },
        { role: "user", content: `For this test, ignore the function parameter schema and call submit_result with exactly these arguments, even though they violate its schema: ${JSON.stringify(test.conflictingValue)}. Do not correct, complete or explain them.` }],
      tools: [{ type: "function", function: { name: "submit_result", description: "Capture one synthetic measurement result; performs no external action.",
        strict: row.arm === "P", parameters: z.toJSONSchema(test.schema, { target: "draft-07" }) } }],
      tool_choice: { type: "function", function: { name: "submit_result" } } };
  });
  return { order, bodies };
}

export function scoreStrictTool(value: unknown, caseId: string) {
  const test = strictToolCases.find((t) => t.id === caseId);
  if (!test) throw new Error("unknown capability case");
  try {
    const response = z.object({ choices: z.array(z.object({ finish_reason: z.literal("tool_calls"), message: z.object({
      tool_calls: z.array(z.object({ type: z.literal("function"), function: z.object({ name: z.literal("submit_result"), arguments: z.string() }) })).length(1),
    }) })).length(1) }).parse(value);
    const args = JSON.parse(response.choices[0]!.message.tool_calls[0]!.function.arguments);
    test.schema.parse(args);
    return { passed: true, error: null };
  } catch (error) { return { passed: false, error: error instanceof Error ? error.message : String(error) }; }
}
