import { describe, expect, it } from "vitest";
import { ModelTransportError } from "../../src/engine/models/model-provider";
import { sourceRunnerAccountBlock } from "./source-runner-failure";

describe("source runner account blocking", () => {
  it("retains HTTP account failure evidence through wrappers", () => {
    const payment = new ModelTransportError("provider payment required", { statusCode: 402 });
    expect(sourceRunnerAccountBlock(new Error("gateway", { cause: payment }))).toBe("payment-required");
    expect(sourceRunnerAccountBlock(new ModelTransportError("forbidden", { statusCode: 403 }))).toBe("account-unavailable");
  });
  it("does not confuse semantic text, rate limits or server failures with an account block", () => {
    expect(sourceRunnerAccountBlock(new Error("Insufficient Balance"))).toBeNull();
    expect(sourceRunnerAccountBlock(new ModelTransportError("rate limit", { statusCode: 429 }))).toBeNull();
    expect(sourceRunnerAccountBlock(new ModelTransportError("temporary", { statusCode: 503 }))).toBeNull();
    const cyclic = new Error("cycle"); cyclic.cause = cyclic;
    expect(sourceRunnerAccountBlock(cyclic)).toBeNull();
  });
});
