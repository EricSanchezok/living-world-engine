import { expect, it } from "vitest";
import { parseLosslessExperimentJson } from "./lossless-json";

it("removes only complete wrappers while preserving typed values", () => {
  const json = '{"n":3,"label":"3","flag":false,"empty":null,"items":[]}';
  const fence = String.fromCharCode(96).repeat(3);
  expect(parseLosslessExperimentJson(json)).toEqual({ value: JSON.parse(json), recovery: "strict" });
  expect(parseLosslessExperimentJson("\uFEFF" + fence + "json\n" + json + "\n" + fence)).toEqual({ value: JSON.parse(json), recovery: "wrapper" });
});
it("does not synthesize missing structure or select among alternative answers", () => {
  for (const input of ['{"n":3', '{n:3}', '{"n":3,}', '{"n":3} {"n":13}', 'Answer: {"n":3}', '{"broken": [{"n":3}']) {
    expect(() => parseLosslessExperimentJson(input)).toThrow();
  }
});
