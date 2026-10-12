import { describe, expect, it } from "vitest";
import { containsStandaloneExplicitNumber, explicitNumberQuotes, parseExplicitNumber } from "../explicit-number";

describe("explicit written quantity evidence", () => {
  it("offers exact number quotes without classifiers, units, partial phrases or invented spellings", () => {
    expect(explicitNumberQuotes("交给对方一个组件、两升水和 2.5 kg 食物。 Give twenty-one coins and one hundred and two chips.")).toEqual([
      { quotedText: "一", amount: 1 }, { quotedText: "两", amount: 2 }, { quotedText: "2.5", amount: 2.5 },
      { quotedText: "twenty-one", amount: 21 }, { quotedText: "one hundred and two", amount: 102 },
    ]);
    expect(explicitNumberQuotes("Use -1, 1e3, x2, 一万, someone, one two or one point ten.")).toEqual([]);
    expect(explicitNumberQuotes("Take one and leave. Take one again.")).toEqual([{ quotedText: "one", amount: 1 }]);
  });
  it.each([
    ["one", 1], ["two", 2], ["nineteen", 19], ["twenty", 20], ["Twenty-one", 21], ["ninety nine", 99],
    ["one hundred", 100], ["two hundred and thirty-four", 234], ["one thousand and five", 1005],
    ["twelve thousand three hundred forty-five", 12345], ["one million two hundred thousand three", 1200003],
    ["one point five", 1.5], ["zero point zero five", 0.05], ["2.5", 2.5], ["两", 2], ["二十三", 23],
  ])("parses %s with code", (text, expected) => expect(parseExplicitNumber(String(text))).toBe(expected));

  it.each(["one two", "one hundred hundred", "twenty zero", "zero hundred", "one thousand thousand", "one thousand million",
    "one hundred and", "one point ten", "one piece", "several", "-1", "1e3", "NaN", "Infinity", ""]) (
    "rejects ambiguous or unsupported number text %s", text => expect(parseExplicitNumber(text)).toBeNull());

  it.each([
    ["Hand over one sealed component.", "one", true], ["Transfer Two energy cells.", "Two", true],
    ["Transfer two energy cells.", "Two", false], ["someone asks for help", "one", false],
    ["twenty-one components", "one", false], ["one hundred components", "one", false],
    ["one hundred and two components", "two", false], ["two thousand components", "two", false],
    ["Pay twenty-one coins", "twenty-one", true], ["Use 12 cells", "2", false], ["Use -1 cells", "1", false],
    ["Use 2.5 litres", "2", false], ["Use 一万 tokens", "一", false], ["Give 两个电池", "两", true],
  ])("binds %s to the complete verbatim number %s", (source, quote, expected) => {
    expect(containsStandaloneExplicitNumber(String(source), String(quote))).toBe(expected);
  });
});
