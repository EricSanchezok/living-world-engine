import { expect, it } from "vitest";
import { parseLastJsonValueWithRecovery } from "./model-adapter";
import { contentHash } from "./model-audit";
import { recoverTerminalRootCloser, TERMINAL_ROOT_CLOSER_RECOVERY } from "./terminal-root-closer-recovery";
import { UNMATCHED_CLOSER_RECOVERY } from "./unmatched-closer-recovery";

it.each([
  { reports: [{ name: '保留 🐉 } ] " \\', value: -2.5 }, { name: "second", value: null }] },
  [{ a: [] }, { a: {} }, [false, 0, ""]], {}, [],
])("retains the complete root, exact text and original UTF-16 evidence", value => {
  const strict = JSON.stringify(value), closer = strict.at(-1)!;
  const source = ` \n${strict} \t${closer} \r\n`;
  const expected = ` \n${strict} \t \r\n`;
  const recovered = recoverTerminalRootCloser(source)!;
  expect(recovered.text).toBe(expected);
  expect(recovered.value).toEqual(value);
  expect(recovered.removed).toEqual([{ offset: source.lastIndexOf(closer), character: closer }]);
  expect(recovered.sourceHash).toBe(contentHash(source));
  expect(recovered.recoveredTextHash).toBe(contentHash(expected));
  const original = `\uFEFF \t${source}`;
  const result = parseLastJsonValueWithRecovery(original, TERMINAL_ROOT_CLOSER_RECOVERY);
  expect(result.value).toEqual(value);
  expect(result.recovery).toBe(TERMINAL_ROOT_CLOSER_RECOVERY);
  expect(result.evidence).toEqual({ policy: TERMINAL_ROOT_CLOSER_RECOVERY,
    sourceHash: contentHash(original), recoveredTextHash: contentHash(`\uFEFF \t${expected}`),
    removed: [{ offset: original.lastIndexOf(closer), character: closer }] });
  for (const policy of [undefined, UNMATCHED_CLOSER_RECOVERY]) {
    expect(() => parseLastJsonValueWithRecovery(original, policy)).toThrow("after the root value");
  }
  expect(recoverTerminalRootCloser(strict)).toBeNull();
  expect(parseLastJsonValueWithRecovery(strict, TERMINAL_ROOT_CLOSER_RECOVERY)).toEqual({ value, recovery: "strict" });
});

it.each([
  '{"a":1,"a":2}}', '{"a":1,"\\u0061":2}}', '{"a":[{"b":1,"b":2}]}}',
  '{"a":1}}}', '{"a":1}]', '[1]}}', '[1]]]', '{"a":1}} trailing',
  '{"a":1},"b":2}', '{"a":1} "b": []}', '{"a":1} {"b":2}}',
  '{"a":1} null}', '{"a":1,"b":}', '{"a":[1}]}', '{"a":"unfinished}}',
  '{"a":1', '"scalar"}', '1]', 'null}', 'true}', 'prefix {"a":1}}', '',
])("declines duplicates, missing structure or additional content: %s", source => {
  expect(recoverTerminalRootCloser(source)).toBeNull();
});

it.each(['{"a":1}}}', '{"a":1}]', '{"a":1},"b":2}', '{"a":1} "b": []}', '{"a":1,"a":2}}'])
  ("retains the continuation guard when the candidate declines: %s", source => {
    expect(() => parseLastJsonValueWithRecovery(source, TERMINAL_ROOT_CLOSER_RECOVERY)).toThrow("after the root value");
  });

it("preserves the independently identified complete-correction behavior", () => {
  expect(parseLastJsonValueWithRecovery('{"a":1}\nCorrection:\n{"a":2}', TERMINAL_ROOT_CLOSER_RECOVERY))
    .toEqual({ value: { a: 2 }, recovery: "top-level-correction" });
});
