import { describe, expect, it } from "vitest";
import { executeDecisionV2, decisionOutputV2Schema, decisionPromptV2, validateDecisionBatchV2, type DecisionRequestV2 } from "../decision-v2";
import { contentHash } from "../model-audit";
import { directTestProvider, nativeChoice } from "../../testing/direct-provider";
import { ContextLimitExceededError, ModelOutputError } from "../model-provider";
import { loadModelCatalog } from "../model-catalog";

function request(): DecisionRequestV2 {
  const state = { observation: "The recipient has not replied." };
  return { workloadId: "direct", batchId: "direct-1", subjectId: "a", profileId: "decision-jev",
    runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 0 },
    batch: { version: 2, view: { kind: "agent", agentId: "a", projectionHash: contentHash(state) }, dependencies: { observation: 1 }, state,
      questions: {
        consent: { type: "choice", version: "1", instructions: { question: "Has the recipient accepted?", terms: ["pay", "deliver"] },
          criteria: { yes: { description: "Explicit acceptance" }, no: "Explicit refusal", unknown: null } },
        relevance: { type: "noul", version: "1", instructions: "Does this concern a negotiation?" },
        urgency: { type: "score", version: "1", instructions: "How urgent?", criteria: ["Low", "Medium", "High"] },
      } } };
}
function answers(questions: DecisionRequestV2["batch"]["questions"]) {
  return Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, q.type === "choice" ? nativeChoice(q, "unknown") : q.type === "noul"
    ? { type: "noul", noul: 0.9 } : { type: "score", score: 0.7, legend: { "0": "Low", "1": "Medium", "2": "High" },
      probabilities: { "0": 0.3, "1": 0.7, "2": 0 }, confidence: 0.3 }]));
}
describe("direct native decisions", () => {
  it.each([false, true])("pins a language-only inference override through native fallback: %s", async fallback => {
    const f = directTestProvider(wire => fallback && !wire.messages
      ? new Response('{"detail":"context token limit exceeded"}', { status: 422 }) : answers(wire.questions));
    const result = await executeDecisionV2(f.gateway, { ...request(),
      profileId: fallback ? "decision-jev" : "decision-deepseek", fallbackProfileId: "decision-deepseek",
      inferenceOverrides: { thinking: "disabled", effort: "auto", reasoning_budget_tokens: "auto" } });
    const wires = f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(wires.at(-1).thinking).toEqual({ type: "disabled" });
    if (fallback) expect(wires[0]).not.toHaveProperty("thinking");
    expect(result.answers.consent).toMatchObject({ choice: "unknown" });
    expect(f.transport).toHaveBeenCalledTimes(fallback ? 2 : 1);
  });
  it.each([false, true])("repairs only invalid language-model answers once, preserving independent values: fails=%s", async fails => {
    const f = directTestProvider((wire, call) => {
      if (call > 1) expect(Object.keys(wire.questions)).toEqual(["consent"]);
      const value = answers(wire.questions);
      if (call === 1 || fails) value.consent = { type: "choice", choice: "foreign-entity", probabilities: {}, confidence: 0 };
      return value;
    });
    const promise = executeDecisionV2(f.gateway, { ...request(), profileId: "decision-deepseek" });
    if (fails) await expect(promise).rejects.toBeInstanceOf(ModelOutputError);
    else {
      const result = await promise;
      expect(result.answers).toMatchObject({ consent: { choice: "unknown" }, relevance: { noul: 0.9 }, urgency: { score: 0.7 } });
      expect(result.audits).toHaveLength(2);
      expect(result.diagnostics).toContain("One format repair for: consent");
    }
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("uses bare values for language-model decisions and restores typed answers in code", async () => {
    const input = { ...request(), profileId: "decision-deepseek" };
    const schema = decisionOutputV2Schema(input.batch, false);
    expect(schema.parse({ answers: { consent: "unknown", relevance: 0.9, urgency: 0.7 } })).toBeDefined();
    expect(schema.safeParse({ answers: { consent: "invented", relevance: 0.9, urgency: 0.7 } }).success).toBe(false);
    expect(schema.safeParse({ answers: answers(input.batch.questions) }).success).toBe(false);
    const f = directTestProvider(wire => answers(wire.questions));
    const result = await executeDecisionV2(f.gateway, input);
    expect(result.answers).toEqual({ consent: { type: "choice", choice: "unknown", probabilities: null, confidence: null },
      relevance: { type: "noul", noul: 0.9 }, urgency: { type: "score", score: 0.7, probabilities: null, confidence: null, legend: null } });
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("sends three independent primitives with structured questions and no program binding", async () => {
    const f = directTestProvider(wire => {
      expect(wire.questions.consent!.instructions).toMatchObject({ task: { terms: ["pay", "deliver"] } });
      return answers(wire.questions);
    });
    const result = await executeDecisionV2(f.gateway, request());
    expect(result.answers.consent).toMatchObject({ type: "choice", choice: "unknown" });
    expect(result.answers.relevance).toEqual({ type: "noul", noul: 0.9 });
    expect(result.answers.urgency).toMatchObject({ type: "score", score: 0.7 });
    expect(result.audits).toHaveLength(1); expect(f.transport).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(f.transport.mock.calls[0]![1]!.body));
    expect(body.state).toEqual({ policy: decisionPromptV2().system, context: request().batch.state });
    expect(Object.keys(body.questions)).toEqual(Object.keys(request().batch.questions));
    for (const [id, question] of Object.entries(request().batch.questions)) {
      expect(body.questions[id].instructions.task).toEqual(question.instructions);
      expect(body.questions[id].instructions).not.toHaveProperty("policy");
      expect(body.questions[id].criteria).toEqual(question.criteria);
    }
    expect(String(f.transport.mock.calls[0]![1]!.body).split(JSON.stringify(decisionPromptV2().system)).length - 1).toBe(1);
  });
  it("records probability discrepancies without blocking a valid typed selection", async () => {
    const input = request(); input.batch.questions = { consent: input.batch.questions.consent! };
    const f = directTestProvider(() => ({ consent: { type: "choice", choice: "unknown", probabilities: { yes: 0.49, no: 0.03, unknown: 0.48 }, confidence: 0 } }));
    const result = await executeDecisionV2(f.gateway, input);
    expect(result.diagnostics).toHaveLength(1); expect(result.answers.consent).toMatchObject({ choice: "unknown" });
  });
  it("sends contexts larger than 32k UTF-8 bytes to the actual provider", async () => {
    const input = request(); input.batch.state = "English and Chinese 中文 ".repeat(1600); input.batch.view.projectionHash = contentHash(input.batch.state);
    const f = directTestProvider(wire => answers(wire.questions));
    await executeDecisionV2(f.gateway, input); expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("uses the production wire ceiling without confusing a 300 KB request with provider token overflow", async () => {
    const input = request(); input.batch.state = "已观察到的情境。".repeat(15000); input.batch.view.projectionHash = contentHash(input.batch.state);
    const maxInputBytes = loadModelCatalog().profile("decision-jev").max_input_bytes;
    expect(maxInputBytes).toBe(4_000_000);
    const f = directTestProvider(wire => answers(wire.questions), undefined, { maxInputBytes });
    await executeDecisionV2(f.gateway, input);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(String(f.transport.mock.calls[0]![1]!.body))).toBeGreaterThan(262_144);
  });
  it("falls back once with the complete batch after actual shared-state overflow", async () => {
    const f = directTestProvider(wire => wire.messages ? answers(wire.questions)
      : new Response('{"detail":"context token limit exceeded"}', { status: 422 }));
    const result = await executeDecisionV2(f.gateway, { ...request(), fallbackProfileId: "decision-deepseek" });
    expect(Object.keys(result.answers)).toHaveLength(3); expect(result.audits).toHaveLength(1);
    expect(result.dispatches).toEqual([
      { questionIds: ["consent", "relevance", "urgency"], profileId: "decision-jev", fallback: null },
      { questionIds: ["consent", "relevance", "urgency"], profileId: "decision-deepseek", fallback: "context-limit" },
    ]);
    expect(f.transport).toHaveBeenCalledTimes(2);
  });
  it("does not retry the same oversized shared state when no fallback is configured", async () => {
    const f = directTestProvider(() => new Response('{"detail":"context token limit exceeded"}', { status: 422 }));
    await expect(executeDecisionV2(f.gateway, request())).rejects.toThrow("actual context");
    expect(f.transport).toHaveBeenCalledTimes(1);
  });
  it("preserves the full batch in the existing fallback when memory preflight cannot fit native input", async () => {
    const input = request();
    input.batch.state = { observation: "已观察到且必须保留的事实。".repeat(1500) };
    input.batch.view.projectionHash = contentHash(input.batch.state);
    const f = directTestProvider(wire => answers(wire.questions), undefined, { maxInputBytes: 16_000 });
    const pressures: number[] = [];
    const result = await executeDecisionV2(f.gateway, { ...input, fallbackProfileId: "decision-deepseek", memory: {
      read: () => null,
      pressure: async (_owners, measurement) => {
        pressures.push(measurement.ratio);
        if (measurement.ratio >= 1) throw new ContextLimitExceededError("No eligible memory can make room");
      },
    } });
    expect(pressures[0]).toBeGreaterThan(1);
    expect(pressures[1]).toBeLessThan(1);
    expect(result.dispatches.map(dispatch => dispatch.profileId)).toEqual(["decision-jev", "decision-deepseek"]);
    expect(result.answers.consent).toMatchObject({ choice: "unknown" });
    expect(f.transport).toHaveBeenCalledTimes(1);
    const wire = JSON.parse(String(f.transport.mock.calls[0]![1]!.body));
    expect(wire.messages[1].content).toContain(JSON.stringify(input.batch.state));
    expect(result.dispatches[1]!.questionIds).toEqual(Object.keys(input.batch.questions));
  });
  it("rejects invalid choice domains, invalid values and foreign private owners", async () => {
    const f = directTestProvider(wire => ({ ...answers(wire.questions), relevance: { type: "noul", noul: 1.1 } }));
    await expect(executeDecisionV2(f.gateway, request())).rejects.toBeInstanceOf(ModelOutputError);
    await expect(executeDecisionV2(f.gateway, { ...request(), subjectId: "another" })).rejects.toThrow("own");
    const input = request(); input.batch.questions.urgency = { type: "score", version: "1", instructions: "Rate", criteria: ["Only"] };
    expect(() => validateDecisionBatchV2(input.batch)).toThrow();
  });
});
