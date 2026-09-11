import { describe, expect, it } from "vitest";
import { completeDeepSeekJsonStream } from "../deepseek-json-stream";
import { deepSeekStreamFixture } from "../../testing/deepseek-stream";

describe("complete DeepSeek JSON stream", () => {
  it("preserves content and final usage through native comment and delta framing", () => {
    const fixture = deepSeekStreamFixture();
    expect(completeDeepSeekJsonStream(fixture.raw)).toMatchObject({
      id: "stream-response", model: "deepseek-v4-flash", usage: fixture.usage,
      choices: [{ message: { content: '{"answer":"行动自由 🐉"}', reasoning_content: "" }, finish_reason: "stop" }],
    });
    expect(() => completeDeepSeekJsonStream(fixture.raw, "another-model")).toThrow("model differs");
  });
  it.each(["missing-done", "missing-usage", "identity", "choice", "usage", "duplicate-finish", "trailing", "partial-trailing", "malformed"])("rejects incomplete or inconsistent evidence: %s", kind => {
    const fixture = deepSeekStreamFixture();
    let raw = fixture.raw;
    if (kind === "missing-done") raw = raw.replace("data: [DONE]\r\n\r\n", "");
    if (kind === "missing-usage") raw = raw.replace(`,"usage":${JSON.stringify(fixture.usage)}`, "");
    if (kind === "identity") raw = raw.replace('"id":"stream-response"', '"id":"other"');
    if (kind === "choice") raw = raw.replace('"index":0', '"index":1');
    if (kind === "usage") raw = raw.replace('"total_tokens":23', '"total_tokens":24');
    if (kind === "duplicate-finish") raw = raw.replace("data: [DONE]", `data: ${JSON.stringify(fixture.frames[2])}\r\n\r\ndata: [DONE]`);
    if (kind === "trailing") raw += "data: {}\r\n\r\n";
    if (kind === "partial-trailing") raw += "data: {";
    if (kind === "malformed") raw = raw.replace('"id":"stream-response"', '"id":');
    expect(() => completeDeepSeekJsonStream(raw)).toThrow();
  });
});
