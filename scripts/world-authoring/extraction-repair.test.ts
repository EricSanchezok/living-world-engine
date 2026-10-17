import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { validateExtraction, type SourceParagraph } from "./extraction-contract";
import { relocateUniqueCitations } from "./extraction-repair";

const paragraphs: SourceParagraph[] = [
  { id: "chapter-a:0", chapterId: "chapter-a", start: 0, end: 12, text: "这是甲方的唯一原文。", sha256: contentHash("这是甲方的唯一原文。") },
  { id: "chapter-b:0", chapterId: "chapter-b", start: 0, end: 12, text: "这是乙方的唯一原文。", sha256: contentHash("这是乙方的唯一原文。") },
];
const draft = (anchor: string) => ({ chapters: ["chapter-a", "chapter-b"], objects: [
  { label: "甲方", kind: "person", aliases: [], description: "原文的人物", region: "未知",
    evidence: [{ paragraph: "wrong:0", anchor }] },
], facts: [], issues: [] });

describe("source citation relocation", () => {
  it("relocates a unique verbatim anchor and preserves content and input", () => {
    const input = draft("甲方的唯一原文");
    const repaired = relocateUniqueCitations(input, paragraphs);
    validateExtraction(repaired.value, paragraphs, input.chapters);
    expect(repaired.value.objects[0]?.evidence).toEqual([{ paragraph: "chapter-a:0", anchor: "甲方的唯一原文" }]);
    expect(repaired.relocations).toEqual([{ collection: "objects", index: 0, citationIndex: 0,
      fromParagraph: "wrong:0", toParagraph: "chapter-a:0", anchorSha256: contentHash("甲方的唯一原文") }]);
    expect(input.objects[0]?.evidence[0]?.paragraph).toBe("wrong:0");
  });

  it("keeps ambiguous and paraphrased anchors rejected", () => {
    for (const anchor of ["的唯一原文", "甲方唯一原文"]) {
      const repaired = relocateUniqueCitations(draft(anchor), paragraphs);
      expect(repaired.relocations).toEqual([]);
      expect(() => validateExtraction(repaired.value, paragraphs, ["chapter-a", "chapter-b"])).toThrow("unverifiable citation");
    }
  });

  it("does not move already valid evidence or choose a repeated occurrence", () => {
    const input = draft("甲方的唯一原文");
    input.objects[0]!.evidence[0]!.paragraph = "chapter-a:0";
    expect(relocateUniqueCitations(input, paragraphs).relocations).toEqual([]);
    const repeated = { ...paragraphs[0]!, text: "甲方的唯一原文。甲方的唯一原文。" };
    expect(relocateUniqueCitations(draft("甲方的唯一原文"), [repeated]).relocations).toEqual([]);
  });
});
