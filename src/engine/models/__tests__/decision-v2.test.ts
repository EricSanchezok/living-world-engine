import { describe, expect, it } from "vitest";
import { executeDecisionV2, decisionOutputV2Schema, validateDecisionBatchV2, type DecisionRequestV2 } from "../decision-v2";
import { contentHash } from "../model-audit";
import { directTestProvider, nativeChoice } from "../../testing/direct-provider";
import { ModelOutputError } from "../model-provider";
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
  it("splits only after an actual provider overflow and counts every dispatch", async () => {
    const f = directTestProvider(wire => Object.keys(wire.questions).length > 1
      ? new Response('{"detail":"context token limit exceeded"}', { status: 422 }) : answers(wire.questions));
    const result = await executeDecisionV2(f.gateway, request());
    expect(Object.keys(result.answers)).toHaveLength(3); expect(result.audits).toHaveLength(3);
    expect(result.dispatches).toHaveLength(5); expect(f.transport).toHaveBeenCalledTimes(5);
    expect(result.dispatches.every(dispatch => dispatch.fallback === null)).toBe(true);
  });
  it("rejects invalid choice domains, invalid values and foreign private owners", async () => {
    const f = directTestProvider(wire => ({ ...answers(wire.questions), relevance: { type: "noul", noul: 1.1 } }));
    await expect(executeDecisionV2(f.gateway, request())).rejects.toBeInstanceOf(ModelOutputError);
    await expect(executeDecisionV2(f.gateway, { ...request(), subjectId: "another" })).rejects.toThrow("own");
    const input = request(); input.batch.questions.urgency = { type: "score", version: "1", instructions: "Rate", criteria: ["Only"] };
    expect(() => validateDecisionBatchV2(input.batch)).toThrow();
  });
});
