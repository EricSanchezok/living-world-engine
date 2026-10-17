import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import type { SourceParagraph } from "./extraction-contract";
import { materializeSourceAdjudication, validateSourceAdjudication,
  sourceAdjudicationManifest, sourceAdjudicationSchemaFor, type AdjudicationInput, type SourceAdjudication } from "./source-adjudication";

const text = "村中老医师也叫陈伯，祖传药方已传了三代。";
const paragraphs: SourceParagraph[] = [{ id: "chapter-a:0", chapterId: "chapter-a", start: 0,
  end: [...text].length, text, sha256: contentHash(text), sourceVersion: "mixed-working-v1" }];
const evidence = [{ paragraph: "chapter-a:0" }];
const input: AdjudicationInput = { chapters: ["chapter-a"], objects: [{ id: "object-1", label: "老医师", aliases: ["陈伯"] }],
  facts: [{ id: "fact-1" }], issues: [{ id: "issue-1" }] };
function review(): SourceAdjudication {
  const record = { sourceClaim: "村中老医师别名陈伯，其家传药方已历三代。", verdict: "supported" as const, rationale: "直接叙述", correction: null,
    basis: "narration" as const, opening: "backprojection" as const, validTime: "三代传承时期", learnedTime: "本章叙述时",
    openingReason: "客观存在早于读者获知，具体开篇年代仍待跨章定位", evidence, existenceAtOpening: null };
  return { chapters: ["chapter-a"], records: [{ id: "object-1", ...record,
    existenceAtOpening: { status: "backprojection", reason: "祖传记载与当前人物存在须分别定位" } }, { id: "fact-1", ...record }],
    aliases: [{ objectId: "object-1", alias: "陈伯", verdict: "supported", rationale: "明确互指",
      evidence: [{ paragraph: "chapter-a:0" }] }],
    issues: [{ id: "issue-1", status: "needs-cross-batch", resolution: "本章未给开篇年表", evidence: [] }],
    omissions: [], identities: [] };
}

describe("source semantic adjudication evidence", () => {
  it("keeps complete source-bound judgments separate from runtime approval", () => {
    const value = review();
    validateSourceAdjudication(value, input, paragraphs);
    const result = materializeSourceAdjudication(value, paragraphs);
    expect(result.approvedForRuntime).toBe(false);
    expect(result.status).toBe("source-semantic-review-not-runtime-approval");
    expect(result.records[1]?.opening).toBe("backprojection");
    expect(result.records[1]?.evidence[0]?.sourceVersion).toBe("mixed-working-v1");
    expect(result.records[1]?.evidence[0]?.anchorSha256).toBe(contentHash(text));
    expect(JSON.stringify(result)).not.toContain('"anchor":');
  });

  it("rejects missing, duplicate, or foreign records and omitted aliases or issues", () => {
    for (const change of [
      (value: SourceAdjudication) => { value.records.pop(); },
      (value: SourceAdjudication) => { value.records[1]!.id = "object-1"; },
      (value: SourceAdjudication) => { value.records[1]!.id = "foreign"; },
      (value: SourceAdjudication) => { value.aliases = []; },
      (value: SourceAdjudication) => { value.issues = []; },
    ]) {
      const value = review();
      change(value);
      expect(() => validateSourceAdjudication(value, input, paragraphs)).toThrow("coverage mismatch");
    }
  });

  it("pins the four review inventories and reports every missing or foreign ID for repair", () => {
    expect(sourceAdjudicationManifest(input)).toMatchObject({ objectIds: ["object-1"], factIds: ["fact-1"],
      aliases: [{ objectId: "object-1", alias: "陈伯" }], issueIds: ["issue-1"], counts: { records: 2, aliases: 1, issues: 1 } });
    const missing = review();
    missing.records = [missing.records[0]!];
    expect(sourceAdjudicationSchemaFor(input, paragraphs).safeParse(missing).success).toBe(false);
    missing.records[0]!.id = "foreign";
    missing.aliases = [];
    try { validateSourceAdjudication(missing, input, paragraphs); }
    catch (error) {
      expect(String(error)).toContain('"missing":["object-1","fact-1"]');
      expect(String(error)).toContain('"unexpected":["foreign"]');
      expect(String(error)).toContain("alias coverage mismatch");
      return;
    }
    throw new Error("incomplete review was not rejected");
  });

  it("requires evidence for supported facts and resolved issues or identities", () => {
    const value = review();
    value.records[1]!.evidence = [];
    expect(() => validateSourceAdjudication(value, input, paragraphs)).toThrow("lacks evidence");
    const unresolved = review();
    unresolved.records[1]!.verdict = "ambiguous";
    unresolved.records[1]!.evidence = [];
    expect(() => validateSourceAdjudication(unresolved, input, paragraphs)).not.toThrow();
    unresolved.issues[0]!.status = "resolved-in-this-batch";
    expect(() => validateSourceAdjudication(unresolved, input, paragraphs)).toThrow("issue issue-1: resolved-in-this-batch requires source evidence");
    const identity = review();
    identity.identities.push({ left: "陈伯", right: "另一个陈伯", relation: "same-entity", rationale: "无证据不能合并", evidence: [] });
    expect(() => validateSourceAdjudication(identity, input, paragraphs)).toThrow("identity lacks evidence");
  });

  it("separates object existence from the later actions described in its candidate card", () => {
    const value = review();
    value.records[0]!.opening = "future";
    validateSourceAdjudication(value, input, paragraphs);
    expect(materializeSourceAdjudication(value, paragraphs).records[0]?.existenceAtOpening?.status).toBe("backprojection");
    value.records[0]!.existenceAtOpening = null;
    expect(() => validateSourceAdjudication(value, input, paragraphs)).toThrow("existence time");
    const fact = review();
    fact.records[1]!.existenceAtOpening = { status: "confirmed", reason: "wrong record kind" };
    expect(() => validateSourceAdjudication(fact, input, paragraphs)).toThrow("existence time");
  });

  it("selects only supplied paragraph IDs and materializes the complete original span", () => {
    const value = review(), schema = sourceAdjudicationSchemaFor(input, paragraphs);
    const result = materializeSourceAdjudication(schema.parse(value), paragraphs);
    expect(result.records[0]?.evidence[0]).toMatchObject({ start: 0, end: [...text].length,
      paragraphSha256: contentHash(text), anchorSha256: contentHash(text) });
    value.records[0]!.evidence[0]!.paragraph = "foreign:0";
    expect(schema.safeParse(value).success).toBe(false);
    expect(() => validateSourceAdjudication(value, input, paragraphs)).toThrow("unknown adjudication source paragraph");
    const fabricatedQuote = review();
    Reflect.set(fabricatedQuote.records[0]!.evidence[0]!, "anchor", "rewritten quotation");
    expect(schema.safeParse(fabricatedQuote).success).toBe(false);
  });
});
