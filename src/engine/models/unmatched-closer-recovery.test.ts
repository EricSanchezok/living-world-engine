import { expect, it } from "vitest";
import { recoverUnmatchedClosers } from "./unmatched-closer-recovery";
import { contentHash } from "./model-audit";

it("removes only unmatched closers while preserving strings, values and exact remaining bytes", () => {
  const source = ' {"plans":[{"text":"braces } ] and escaped \\\"quote\\\"","n":-2.5}}, {"text":"second","n":0}]} \n';
  const recovered = recoverUnmatchedClosers(source)!;
  expect(recovered.value).toEqual({ plans: [{ text: 'braces } ] and escaped "quote"', n: -2.5 }, { text: "second", n: 0 }] });
  expect(recovered.removed).toHaveLength(1);
  const offsets = new Set(recovered.removed.map(edit => edit.offset));
  expect(recovered.text).toBe(source.split("").filter((_, index) => !offsets.has(index)).join(""));
  expect(recoverUnmatchedClosers(recovered.text)).toBeNull();
});

it("retains each nested container and repeated keys in distinct objects", () => {
  const recovered = recoverUnmatchedClosers('{"slots":[{"slot":0,"result":{"plans":[{"id":"a"}}]}}},{"slot":1,"result":{"plans":[{"id":"b"}]}]}]}');
  expect(recovered?.value).toEqual({ slots: [{ slot: 0, result: { plans: [{ id: "a" }] } }, { slot: 1, result: { plans: [{ id: "b" }] } }] });
});

it.each([
  '{"a":[1}]} trailing', '{"a":[1}]} {"b":2}', '{"a":[1}]} }',
  '{"a":[1}', '{"a":["unfinished}]}', '{"a":1}}', '["a":1}]',
  '{"a":[1],"b":}', '{"a":[1}}],"b"}', '{"a":{"b":1}},"c":2}',
  '{"a":[1},2],"a":3}', '{"a":[1},2],"\\u0061":3}',
])("rejects incomplete, duplicate, multi-root or non-permitted edits: %s", source => {
  expect(recoverUnmatchedClosers(source)).toBeNull();
});

it("rejects the entire candidate when the deletion budget is exceeded", () => {
  const source = (count: number) => '{"a":["保留原文 🐉"' + '}'.repeat(count) + ']}';
  expect(recoverUnmatchedClosers(source(128))?.removed).toHaveLength(128);
  expect(recoverUnmatchedClosers(source(128))?.value).toEqual({ a: ["保留原文 🐉"] });
  expect(recoverUnmatchedClosers(source(129))).toBeNull();
});

it("preserves known data under recovered single-closer insertion corruptions", () => {
  const values = [{ a: { b: 1, c: 2 }, d: 3 }, [{ a: [1, 2] }, [3, { a: 4 }]],
    { a: [{ id: "a", text: '} ] \\" 🐉', n: -2 }, { id: "b", flag: false }], z: null }, [{ a: [] }, { a: {} }, [], [1]]];
  let recoveredCount = 0;
  for (const value of values) {
    const source = JSON.stringify(value);
    for (let offset = 0; offset <= source.length; offset++) for (const closer of ["}", "]"]) {
      const result = recoverUnmatchedClosers(source.slice(0, offset) + closer + source.slice(offset));
      if (result) { recoveredCount++; expect(contentHash(result.value)).toBe(contentHash(value)); }
    }
  }
  expect(recoveredCount).toBeGreaterThan(0);
});
