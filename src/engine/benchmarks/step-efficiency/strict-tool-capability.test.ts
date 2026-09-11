import { expect, it } from "vitest";
import { scoreStrictTool, strictToolDesign } from "./strict-tool-capability";

function response(args: unknown) {
  return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "submit_result", arguments: JSON.stringify(args) } }] } }] };
}
it("compares identical synthetic requests with only the strict flag changed and thinking disabled", () => {
  const { order, bodies } = strictToolDesign();
  expect(order).toHaveLength(12);
  for (let i = 0; i < order.length; i += 2) {
    const pair = bodies.slice(i, i + 2).map((body) => { const v = structuredClone(body);v.tools[0]!.function.strict = false;return v; });
    expect(pair[0]).toEqual(pair[1]);
    expect(pair[0]!.thinking).toEqual({ type: "disabled" });
  }
});
it("scores actual strict tool arguments rather than HTTP success or a model compliance claim", () => {
  expect(scoreStrictTool(response({ gate: "permit", count: 2, nested: { enabled: false } }), "closed-required-enum-numeric").passed).toBe(true);
  expect(scoreStrictTool(response({ gate: "deny", count: -5 }), "closed-required-enum-numeric").passed).toBe(false);
  expect(scoreStrictTool(response({ evidence: { kind: "fact", ref: "ref:fact:12" }, rows: [{ flag: false, quantity: 0 }] }), "nested-anyof-pattern-array").passed).toBe(true);
  expect(scoreStrictTool(response({ evidence: { kind: "fact", ref: "ref:event:12" }, rows: [] }), "nested-anyof-pattern-array").passed).toBe(false);
  expect(scoreStrictTool({ choices: [{ message: { content: "I followed all schema constraints" } }] }, "closed-required-enum-numeric").passed).toBe(false);
  const doubled = response({ gate: "permit", count: 2, nested: { enabled: false } });
  doubled.choices[0]!.message.tool_calls.push(doubled.choices[0]!.message.tool_calls[0]!);
  expect(scoreStrictTool(doubled, "closed-required-enum-numeric").passed).toBe(false);
});
