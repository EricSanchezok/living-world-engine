import { describe, expect, it } from "vitest";
import { ExperimentBudgetError } from "../../benchmarks/action-compilation/experiment-budget";
import { ModelTransportError } from "../model-provider";
import { modelServicePause } from "../service-failure";

describe("model service availability classification", () => {
  it("retains the specific limit through provider wrappers", () => {
    const original = new ExperimentBudgetError("phase HTTP budget exhausted", "request-limit");
    const wrapped = new ModelTransportError(original.message, { cause: new Error("adapter failed", { cause: original }) });
    expect(modelServicePause(wrapped)).toMatchObject({ code: "request-limit", retry: "after-service-change" });
    expect(modelServicePause(wrapped)?.message).toContain("调用次数");
    expect(modelServicePause(wrapped)?.message).not.toContain("预算已用完");
    expect(modelServicePause(new ExperimentBudgetError("reserve", "spending-limit"))?.message).toContain("费用额度");
  });
  it("does not classify narrative content or arbitrary error strings as quota evidence", () => {
    expect(modelServicePause("phase HTTP budget exhausted")).toBeNull();
    expect(modelServicePause(new Error("phase HTTP budget exhausted"))).toBeNull();
    expect(modelServicePause({ name: "ExperimentBudgetError", limitCode: "request-limit" })).toBeNull();
    const cyclic = new Error("cyclic"); cyclic.cause = cyclic;
    expect(modelServicePause(cyclic)).toBeNull();
  });
});
