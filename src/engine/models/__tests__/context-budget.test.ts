import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { requestPressure, estimateTokens, TokenCalibration, tokenLanguageBand } from "../context-budget";
import { directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { resolveModelProfile } from "../model-registry";
import { structuredPromptBytes } from "../../prompts";
import { contentHash } from "../model-audit";
import { executeDecisionV2, type DecisionBatchV2 } from "../decision-v2";

it("estimates multilingual tokens without mistaking bytes or characters for exact token counts", () => {
  expect(estimateTokens("你好")).toBe(4);
  expect(estimateTokens("ordinary ".repeat(100))).toBeGreaterThan(200);
});
it("learns downward only from repeated usage, raises immediately, and ages samples by dispatch order", () => {
  const calibration = new TokenCalibration();
  expect(calibration.factor("native:decision:zh")).toBe(1);
  for (let i = 0; i < 3; i++) calibration.observe("native:decision:zh", calibration.next(), 5000, 3000);
  expect(calibration.factor("native:decision:zh")).toBeCloseTo(0.66);
  expect(calibration.factor("generative:speech:en")).toBe(1);
  const late = calibration.next();
  calibration.observe("native:decision:zh", calibration.next(), 5000, 6000);
  calibration.observe("native:decision:zh", late, 5000, 1000);
  expect(calibration.factor("native:decision:zh")).toBeCloseTo(1.32);
  for (let i = 0; i < 32; i++) calibration.observe("native:decision:zh", calibration.next(), 5000, 3000);
  calibration.observe("native:decision:zh", late, 5000, 10000);
  expect(calibration.factor("native:decision:zh")).toBeCloseTo(0.66);
  calibration.observe("native:decision:zh", calibration.next(), 5000, null);
  expect(calibration.factor("native:decision:zh")).toBeCloseTo(0.66);
  expect(tokenLanguageBand("English conversation")).not.toBe(tokenLanguageBand("中文对话和长期记忆"));
});
describe("complete native request pressure", () => {
  it("learns from existing gateway usage without sharing Agent and world calibration or making extra calls", async () => {
    const f = directTestProvider(wire => Response.json({ model: wire.model,
      answers: Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeAnswer(question)])),
      usage: { input_tokens: 1000, output_tokens: 10 } }));
    await f.registry.capture();
    const estimates: number[] = [], state = { history: "Ordinary private observations. ".repeat(200) };
    const run = (kind: "agent" | "world") => executeDecisionV2(f.gateway, { workloadId: "calibration", batchId: "existing-usage",
      runtimeIdentity: { worldHash: "sha256:" + "a".repeat(64), revision: 1 }, subjectId: "keeper", profileId: "decision-jev",
      memory: { read: () => null, pressure: async (_ids, measurement) => { estimates.push(measurement.estimatedInputTokens); } },
      batch: { version: 2, view: kind === "agent" ? { kind, agentId: "keeper", projectionHash: contentHash(state) }
        : { kind, projectionHash: contentHash(state) }, state, dependencies: {},
        questions: { a: { type: "choice", version: "1", instructions: "Recall", criteria: { yes: "yes", no: "no" } } } } });
    await run("agent"); await run("agent"); await run("agent"); await run("agent"); await run("world");
    expect(estimates[3]).toBeCloseTo(1100, -1);
    expect(estimates[3]).toBeLessThan(estimates[0]!);
    expect(estimates[4]).toBe(estimates[0]);
    expect(f.transport).toHaveBeenCalledTimes(5);
  });
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
    const estimates: number[] = [], state = { subject: "keeper", memory: "Ordinary history. ".repeat(50) };
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
    const calibrated = requestPressure(binding, context, prompt, 0.6);
    expect(calibrated.estimatedInputTokens).toBe(Math.ceil(multiple.estimatedInputTokens * 0.6));
    expect(calibrated.estimatedQuestionTokens).toBe(Math.ceil(multiple.estimatedQuestionTokens! * 0.6));
    binding.profile.max_question_tokens = calibrated.estimatedQuestionTokens! - 1;
    expect(requestPressure(binding, context, prompt, 0.6).ratio).toBeGreaterThan(1);
    binding.profile.max_question_tokens = 32000;
    binding.profile.max_input_bytes = calibrated.requestUtf8Bytes - 1;
    expect(requestPressure(binding, context, prompt, 0.6).ratio).toBeGreaterThan(1);
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
