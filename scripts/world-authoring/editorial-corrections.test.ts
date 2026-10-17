import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { applyEditorialCorrections } from "./editorial-corrections";
import { extractionSchema, validateExtraction } from "./extraction-contract";

describe("pinned editorial corrections", () => {
  const source = "他自称是门主的后人，众人并未查证。";
  const paragraphs = [{ id: "ch:0", chapterId: "ch", start: 0, end: source.length, text: source, sha256: contentHash(source) }];
  const draft = extractionSchema.parse({ chapters: ["ch"], objects: [], issues: [], facts: [{
    subject: "来客", relation: "身份", related: [], statement: "来客是门主的后人。", basis: "narration", domain: "relationships",
    validTime: "当时", learnedTime: "当时", opening: "confirmed", openingReason: "现场自述。", qualifications: [],
    evidence: [{ paragraph: "ch:0", anchor: "他就是门主的后人" }],
  }] });
  const review = () => ({ identity: "source-v1", expectedDraftHash: contentHash(draft), reviewer: "source-comparison",
    scope: "targeted-corrections-not-runtime-approval", corrections: [{ collection: "facts", index: 0,
      expectedRecordHash: contentHash(draft.facts[0]), fields: { basis: "testimony", statement: "来客自称是门主后人，尚未核实。" },
      citations: [{ index: 0, paragraph: "ch:0", start: 0, end: 9 }], reason: "原文只支持自述。" }] });
  it("fixes a citation using source coordinates and retains the original draft", () => {
    const corrected = applyEditorialCorrections(draft, "source-v1", review(), paragraphs);
    validateExtraction(corrected, paragraphs, ["ch"]);
    expect(corrected.facts[0]!.basis).toBe("testimony");
    expect(draft.facts[0]!.basis).toBe("narration");
  });
  it.each(["source", "draft", "record", "range", "raw-evidence", "duplicate"])("rejects invalid %s correction", scenario => {
    const input = review();
    if (scenario === "source") input.identity = "another-version";
    if (scenario === "draft") input.expectedDraftHash = "changed";
    if (scenario === "record") input.corrections[0]!.expectedRecordHash = "changed";
    if (scenario === "range") input.corrections[0]!.citations[0]!.end = 999;
    if (scenario === "raw-evidence") Object.assign(input.corrections[0]!.fields, { evidence: [] });
    if (scenario === "duplicate") input.corrections.push(input.corrections[0]!);
    expect(() => applyEditorialCorrections(draft, "source-v1", input, paragraphs)).toThrow();
  });
});
