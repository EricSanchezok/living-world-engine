import { describe, expect, it } from "vitest";
import { directLayoutBody, probeInferenceEvidence, responsesBody, scorePlanBatch } from "./step-json-probe";
import { factorSharedBatchContexts } from "../../src/engine/mechanics/shared-batch-context";
import { composeJsonObjectPrompt } from "../../src/engine/prompts";

function result(actionRef: string) {
  return { kind: "commit_plans", plans: [{ proposalKey: "plan", actionRef, targetRefs: [], means: [], factors: [],
    risk: "safe", baseEffect: "none", primaryEffect: null, secondaryEffect: null, threatenedEffect: null,
    visibility: "full", causes: [{ kind: "action", ref: actionRef }], mode: "automatic", difficulty: null, actorRatingRef: null }] };
}
describe("frozen full-context JSON probe", () => {
  it("changes only the task layout while retaining actual transport settings and the exact output contract", () => {
    const state = factorSharedBatchContexts(["a", "b"].map((id) => ({ task: { assignment: id }, state: {
      actionSet: { assigned: [{ actionRef: id }] }, dependencySet: { assigned: [{ actionRef: id }] },
    } })));
    const prompt = composeJsonObjectPrompt({ userPrompt: "Original complete task.", contextJson: JSON.stringify({ task: { slots: [] }, state }),
      schemaJson: '{"type":"object"}', exampleJson: "{}", discriminator: "Exact original discriminator." });
    const body = { model: "deepseek-v4-flash" as const, max_tokens: 131072 as const, thinking: { type: "disabled" as const }, response_format: { type: "json_object" as const },
      messages: [{ role: "system" as const, content: "Original authority." }, { role: "user" as const, content: prompt }] };
    const revised = directLayoutBody(body);
    expect({ ...revised, messages: undefined }).toEqual({ ...body, messages: undefined });
    expect(revised.messages[0]).toEqual(body.messages[0]);
    const marker = "Return exactly one JSON object";
    expect(revised.messages[1]!.content.slice(revised.messages[1]!.content.indexOf(marker))).toBe(prompt.slice(prompt.indexOf(marker)));
    expect(body.messages[1]!.content).toBe(prompt);
    expect(revised.messages[1]!.content).toContain('"assignedActions":[{"actionRef":"a"}]');
  });
  it("keeps message authority and exact text while translating transport fields", () => {
    const messages = [{ role: "system" as const, content: "system\n\nexact" }, { role: "user" as const, content: "task\n{完整上下文}" }];
    const body = responsesBody({ model: "deepseek-v4-flash", max_tokens: 131072, thinking: { type: "disabled" }, response_format: { type: "json_object" }, messages });
    expect(body.input).toEqual(messages.map((message) => ({ role: message.role, content: [{ type: "input_text", text: message.content }] })));
    expect(body).toMatchObject({ max_output_tokens: 131072, reasoning: { effort: "none" }, text: { format: { type: "json_object" } } });
    expect(body).not.toHaveProperty("thinking");
  });
  it("rejects silently ignored thinking controls using actual response evidence", () => {
    const enabled = { model: "deepseek-v4-flash", reasoning: { effort: null }, usage: { output_tokens_details: { reasoning_tokens: 6143 } }, output: [{ type: "reasoning" }, { type: "message" }] };
    expect(probeInferenceEvidence(enabled, "R").inferenceValid).toBe(false);
    const disabled = { model: "deepseek-v4-flash", reasoning: { effort: "none" }, usage: { output_tokens_details: { reasoning_tokens: 0 } }, output: [{ type: "message" }] };
    expect(probeInferenceEvidence(disabled, "R").inferenceValid).toBe(true);
    expect(probeInferenceEvidence({ ...disabled, usage: {} }, "R").inferenceValid).toBe(false);
    expect(probeInferenceEvidence({ ...disabled, model: "deepseek-v4-pro" }, "R").inferenceValid).toBe(false);
    expect(probeInferenceEvidence({ model: "deepseek-v4-flash", usage: {}, choices: [{ message: { reasoning_content: "unexpected thinking" } }] }, "B").inferenceValid).toBe(false);
  });
  it("checks the real plan schema and each original action slot, not just valid JSON", () => {
    const slots = [{ slot: 0, result: result("ref:action:first") }, { slot: 1, result: result("ref:action:second") }];
    const expected = [["ref:action:first"], ["ref:action:second"]];
    expect(scorePlanBatch(JSON.stringify({ slots }), expected).schemaAndCoverage).toBe(true);
    expect(scorePlanBatch(JSON.stringify({ slots: [slots[1], slots[0]] }), expected).schemaAndCoverage).toBe(true);
    expect(scorePlanBatch(JSON.stringify({ slots: [slots[0], slots[0]] }), expected).schemaAndCoverage).toBe(false);
    expect(scorePlanBatch(JSON.stringify({ slots }), [...expected].reverse()).schemaAndCoverage).toBe(false);
    expect(scorePlanBatch(JSON.stringify({ slots: [{ slot: 0, result: {} }] }), [["ref:action:first"]]).schemaAndCoverage).toBe(false);
  });
  it("counts complete fences separately and never repairs missing internal punctuation", () => {
    const value = JSON.stringify({ slots: [{ slot: 0, result: result("ref:action:first") }] });
    expect(scorePlanBatch(`\x60\x60\x60json\n${value}\n\x60\x60\x60`, [["ref:action:first"]])).toMatchObject({ rawJson: false, losslessJson: true, recovery: "wrapper", schemaAndCoverage: true });
    expect(scorePlanBatch(value.slice(0, -1), [["ref:action:first"]])).toMatchObject({ rawJson: false, losslessJson: false, schemaAndCoverage: false });
  });
});
