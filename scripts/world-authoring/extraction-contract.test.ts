import { describe, expect, it } from "vitest";
import { extractionSchema, materializeExtraction, validateExtraction } from "./extraction-contract";
import { contentHash } from "../../src/engine/models/model-audit";

describe("source-grounded authoring candidates", () => {
  const text = "三年前，镇上的老药铺已经关门。现在只是有人传说它会重开。";
  const paragraphs = [{ id: "chapter-1:p1", chapterId: "chapter-1", start: 20, end: 20 + text.length, text, sha256: contentHash(text) }];
  const value = () => extractionSchema.parse({ chapters: ["chapter-1"], objects: [{ label: "老药铺", kind: "place", aliases: [],
    description: "已经关闭的药铺。", region: "镇上", evidence: [{ paragraph: "chapter-1:p1", anchor: "老药铺已经关门" }] }], facts: [], issues: [] });
  it("retains exact source offsets without shipping quotes or pretending approval", () => {
    const input = value();
    validateExtraction(input, paragraphs, ["chapter-1"]);
    const result = materializeExtraction("batch-1", input, paragraphs);
    expect(result.approvedForRuntime).toBe(false);
    const ref = result.objects[0]!.evidence[0]!;
    expect(text.slice(ref.start - 20, ref.end - 20)).toBe("老药铺已经关门");
    expect(ref.anchorSha256).toBe(contentHash("老药铺已经关门"));
    expect(JSON.stringify(result)).not.toContain('"anchor":');
  });
  it.each(["missing-chapter", "fabricated-quote", "foreign-paragraph"])("rejects %s", scenario => {
    const input = value();
    if (scenario === "missing-chapter") input.chapters = [];
    if (scenario === "fabricated-quote") input.objects[0]!.evidence[0]!.anchor = "药铺仍在营业";
    if (scenario === "foreign-paragraph") input.objects[0]!.evidence[0]!.paragraph = "chapter-2:p1";
    expect(() => validateExtraction(input, paragraphs, ["chapter-1"])).toThrow();
  });
});
