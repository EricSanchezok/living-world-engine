import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { requestPressure, estimateTokens } from "../context-budget";
import { directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { resolveModelProfile } from "../model-registry";
import { structuredPromptBytes } from "../../prompts";
import { contentHash } from "../model-audit";
import { executeDecisionV2, type DecisionBatchV2 } from "../decision-v2";

it("estimates multilingual tokens without mistaking bytes or characters for exact token counts", () => {
  expect(estimateTokens("你好")).toBe(4);
  expect(estimateTokens("ordinary ".repeat(100))).toBeGreaterThan(200);
});
describe("complete native request pressure", () => {
  it("does not lower calibration when parallel token-usage reports finish out of order", async () => {
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
    const f = directTestProvider(async (wire, call) => {
      if (call === 1) await firstGate;
      if (call === 2) await secondGate;
      return Response.json({ model: wire.model,
        answers: Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q)])),
        usage: { input_tokens: call === 1 ? 3000 : 10, output_tokens: 10 } });
    });
    await f.registry.capture();
    const estimates: number[] = [], state = { subject: "keeper" };
    const run = (modelInvocation: number) => executeDecisionV2(f.gateway, { workloadId: "parallel-memory", batchId: "calibration", modelInvocation,
      runtimeIdentity: { worldHash: "sha256:" + "a".repeat(64), revision: 1 }, subjectId: "keeper", profileId: "decision-jev",
      memory: { read: () => null, pressure: async (_ids, measure) => { estimates.push(measure.estimatedInputTokens); } },
      batch: { version: 2, view: { kind: "agent", agentId: "keeper", projectionHash: contentHash(state) }, state, dependencies: {},
        questions: { a: { type: "choice", version: "1", instructions: "Recall", criteria: { yes: "yes", no: "no" } } } } });
    const first = run(1), second = run(2);
    await vi.waitFor(() => expect(f.transport).toHaveBeenCalledTimes(2));
    releaseFirst(); await first; releaseSecond(); await second;
    await run(3);
    expect(estimates[2]).toBeGreaterThanOrEqual(3150);
  });
  it("accounts for every question and the largest state-plus-question independently", async () => {
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q)])));
    const binding = resolveModelProfile(f.catalog, await f.registry.capture(), "decision-jev");
    binding.profile = { ...binding.profile, max_input_tokens: 64000, max_question_tokens: 32000 };
    binding.model.limit.context = 64000;
    const state = { history: "长期经历。".repeat(1000) };
    const batch: DecisionBatchV2 = { version: 2, state, dependencies: {}, view: { kind: "agent", agentId: "keeper", projectionHash: contentHash(state) }, questions: {
      a: { type: "choice", version: "1", instructions: "task ".repeat(100), criteria: { yes: "yes", no: "no" } },
    } };
    const context = { decision: batch }, prompt = { system: "system", ...structuredPromptBytes({ system: "system", userPrompt: "user", context, schema: z.object({}) }) };
    const single = requestPressure(binding, context, prompt);
    batch.questions.b = batch.questions.a!;
    const multiple = requestPressure(binding, context, prompt);
    expect(multiple.estimatedInputTokens).toBeGreaterThan(single.estimatedInputTokens);
    expect(multiple.estimatedQuestionTokens).toBe(single.estimatedQuestionTokens);
    expect(multiple.ratio).toBe(Math.max(multiple.estimatedInputTokens / 64000, multiple.estimatedQuestionTokens! / 32000));
  });
  it("runs pressure checks before HTTP and sends the actual model-visible memory version", async () => {
    const f = directTestProvider(wire => Object.fromEntries(Object.entries(wire.questions).map(([id, q]) => [id, nativeAnswer(q)])));
    await f.registry.capture();
    const state = { perspective: { agentId: "keeper", memory: { version: 3, summary: "remember" } } };
    const batch: DecisionBatchV2 = { version: 2, state, dependencies: {}, view: { kind: "agent", agentId: "keeper", projectionHash: contentHash(state) },
      questions: { a: { type: "choice", version: "1", instructions: "Recall", criteria: { yes: "yes", no: "no" } } } };
    await expect(executeDecisionV2(f.gateway, { workloadId: "test", batchId: "memory", runtimeIdentity: { worldHash: "sha256:" + "a".repeat(64), revision: 1 }, subjectId: "keeper", profileId: "decision-jev", batch,
      memory: { read: () => null, pressure: async (ids, measure, _signal, versions) => {
        expect(ids).toEqual(["keeper"]); expect(versions).toEqual({ keeper: 3 }); expect(measure.estimatedInputTokens).toBeGreaterThan(0);
        throw new Error("wait for memory");
      } } })).rejects.toThrow("wait for memory");
    expect(f.transport).not.toHaveBeenCalled();
  });
});
