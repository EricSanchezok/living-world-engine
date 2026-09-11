import { expect, it } from "vitest";
import { unwrapExperimentDocument } from "./document-wrapper";
import { parseYamlTruthOutput, scoreWrappedTruthOutput } from "./yaml-truth-output";

it("uses identical complete-wrapper recovery while preserving meaningful YAML trailing newlines", () => {
  const yaml = "summary: |+\n  exact text\n\n";
  const wrapped = `\x60\x60\x60yaml\n${yaml}\x60\x60\x60`;
  expect(unwrapExperimentDocument(wrapped)).toEqual({ text: yaml, recovery: "wrapper" });
  expect(parseYamlTruthOutput(unwrapExperimentDocument(wrapped).text)).toEqual(parseYamlTruthOutput(yaml));
  expect(unwrapExperimentDocument(yaml)).toEqual({ text: yaml, recovery: "strict" });
  expect(unwrapExperimentDocument('\x60\x60\x60json\n{"slots":[]}\n\x60\x60\x60').text).toBe('{"slots":[]}\n');
  expect(unwrapExperimentDocument('explanation\n\x60\x60\x60json\n{}\n\x60\x60\x60').recovery).toBe("strict");
});
it("separates raw and recovered formats and never salvages invalid punctuation, indentation or nonfinite values", () => {
  const cases = [
    ["json", '\x60\x60\x60json\n{"slots":[}}\n\x60\x60\x60'],
    ["yaml", '\x60\x60\x60yaml\nx: [1,2\n\x60\x60\x60'],
    ["json", '{"slots":[],"value":1e999}'],
  ] as const;
  for (const [format, text] of cases) expect(scoreWrappedTruthOutput(text, format, "transition", []).recoveredFormatPassed).toBe(false);
  const result = scoreWrappedTruthOutput('\x60\x60\x60yaml\nslots: []\n\x60\x60\x60', "yaml", "transition", [{}]);
  expect(result.rawFormatPassed).toBe(false);
  expect(result.recoveredFormatPassed).toBe(true);
  expect(result.schemaCoverageReferences).toBe(false);
  expect(result.wrapperRecovery).toBe("wrapper");
});
