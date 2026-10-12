import { describe, expect, it } from "vitest";
import type { ModelInvocationAudit } from "../../contracts/model";
import { estimateModelCost } from "../model-cost";

describe("model cost evidence", () => {
  const invocation = { tokenUsage: { input: 1000, output: 100, cacheRead: 200, cacheWrite: null, reasoning: null },
    transports: [{ status: "succeeded" }] } as ModelInvocationAudit;
  it("counts supplied input, cached input and output using the pinned schedule", () => {
    expect(estimateModelCost({ accountId: "deepseek-api", modelId: "deepseek-flash" }, invocation).estimateCny).toBeCloseTo(0.0028896);
    expect(estimateModelCost({ accountId: "typesafe-api", modelId: "jev-1.13.0" }, invocation).estimateCny).toBe(0.000336);
  });
  it("retains unknown model prices, usage and failed transport exposure", () => {
    expect(estimateModelCost({ accountId: "test", modelId: "test" }, invocation).estimateCny).toBeNull();
    expect(estimateModelCost({ accountId: "deepseek-api", modelId: "deepseek-flash" },
      { ...invocation, tokenUsage: { ...invocation.tokenUsage, input: null } }).estimateCny).toBeNull();
    expect(estimateModelCost({ accountId: "typesafe-api", modelId: "jev-1.13.0" },
      { ...invocation, transports: [{ ...invocation.transports[0]!, status: "failed" }] }).unknownTransportUsage).toBe(true);
  });
});
