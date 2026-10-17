import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { extractionSchema, materializeExtraction, type SourceParagraph } from "./extraction-contract";
import { sourceAdjudicationSchemaFor, validateSourceAdjudication, type SourceAdjudication } from "./source-adjudication";
import { createAdjudicationTransport } from "./adjudication-transport";

// Invented source text exercises code-point offsets without storing novel excerpts.
const text = "𠮷氏药铺😀记载：旧方用于止血，不代表人人适用。";
const secondText = "陈师傅说：旧方不是陈氏祖传，此说还须核实。";
const paragraphs: SourceParagraph[] = [
  { id: "chapter-a:12", chapterId: "chapter-a", start: 12, end: 12 + [...text].length,
    text, sha256: contentHash(text), sourceVersion: "working-v1" },
  { id: "chapter-b:9", chapterId: "chapter-b", start: 9, end: 9 + [...secondText].length,
    text: secondText, sha256: contentHash(secondText), sourceVersion: "working-v1" },
];
function report() {
  return materializeExtraction("batch-test", extractionSchema.parse({
    chapters: ["chapter-a", "chapter-b"],
    objects: [{ label: "旧药方", kind: "method", aliases: ["旧方"], description: "chapter-a:12 是描述内的文字。",
      region: "药铺", evidence: [{ paragraph: "chapter-a:12", anchor: "旧方用于止血" }] }],
    facts: [{ subject: "旧药方", relation: "适用", related: [], statement: "不适用于所有人。", basis: "narration", domain: "cultivation",
      validTime: "既有条件", learnedTime: "读到记录时", opening: "unknown", openingReason: "缺少年代", qualifications: ["不代表人人适用。"],
      evidence: [{ paragraph: "chapter-a:12", anchor: "不代表人人适用" }] }],
    issues: [{ subject: "传承", description: "证言与谱系尚未核实。", evidence: [{ paragraph: "chapter-b:9", anchor: "不是陈氏祖传" }] },
      { subject: "年代", description: "当前输入缺少年表。", evidence: [] }],
  }), paragraphs);
}
function review(): SourceAdjudication {
  const input = report();
  const record = { sourceClaim: "药方的适用条件存在限制。", verdict: "supported" as const, rationale: "原文直接限制适用范围。",
    correction: null, basis: "narration" as const, opening: "unknown" as const, validTime: "既有条件", learnedTime: "读到记录时",
    openingReason: "缺少年表", evidence: [{ paragraph: "chapter-a:12" }], existenceAtOpening: null };
  return { chapters: input.chapters, records: [{ id: input.objects[0]!.id, ...record,
    existenceAtOpening: { status: "unknown", reason: "不将读者获知等同诞生时间" } }, { id: input.facts[0]!.id, ...record }],
    aliases: [{ objectId: input.objects[0]!.id, alias: "旧方", verdict: "supported", rationale: "连续指称", evidence: [{ paragraph: "chapter-a:12" }] }],
    issues: input.issues.map(issue => ({ id: issue.id, status: "still-open", resolution: "还须跨章核对", evidence: [] })),
    omissions: [{ kind: "qualification", subject: "传承", description: "声称并非家传", evidence: [{ paragraph: "chapter-b:9" }] }],
    identities: [{ left: "旧药方", right: "陈氏药方", relation: "unresolved", rationale: "不得凭称谓合并", evidence: [{ paragraph: "chapter-b:9" }] }] };
}

function dereference(node: unknown, root: Record<string, unknown>): Record<string, unknown> {
  const value = node as Record<string, unknown>;
  if (typeof value.$ref !== "string") return value;
  const target = value.$ref.slice(2).split("/").reduce<unknown>((current, key) =>
    (current as Record<string, unknown>)[key], root);
  return dereference(target, root);
}

describe("source adjudication transport", () => {
  it("preserves complete source and every candidate field while recovering exact Unicode quote spans", () => {
    const input = report(), original = structuredClone(input), source = structuredClone(paragraphs);
    const transport = createAdjudicationTransport(input, paragraphs);
    expect(transport.paragraphs).toEqual([{ id: "p0", chapterId: "chapter-a", text }, { id: "p1", chapterId: "chapter-b", text: secondText }]);
    expect(transport.wireParagraphs).toEqual(paragraphs.map((paragraph, index) => ({ ...paragraph, id: `p${index}` })));
    for (const collection of ["objects", "facts", "issues"] as const) {
      input[collection].forEach((item, index) => {
        const fields = Object.fromEntries(Object.entries(item).filter(([key]) => key !== "evidence"));
        const wireFields = Object.fromEntries(Object.entries(transport.candidates[collection][index]!).filter(([key]) => key !== "evidence"));
        expect(wireFields).toEqual(fields);
      });
    }
    expect(transport.candidates.objects[0]!.evidence).toEqual([{ paragraph: "p0", quote: "旧方用于止血" }]);
    expect(transport.candidates.facts[0]!.evidence).toEqual([{ paragraph: "p0", quote: "不代表人人适用" }]);
    expect(transport.candidates.issues[0]!.evidence).toEqual([{ paragraph: "p1", quote: "不是陈氏祖传" }]);
    expect(transport.candidates.issues[1]!.evidence).toEqual([]);
    expect(input).toEqual(original);
    expect(paragraphs).toEqual(source);
  });

  it("rejects source drift, bad ranges and mismatched quote hashes before transport", () => {
    const mutations = [
      { paragraphId: "foreign:0" }, { chapterId: "chapter-b" }, { paragraphSha256: "bad" },
      { sourceVersion: "other-version" }, { start: 0 }, { end: paragraphs[0]!.end + 1 },
      { start: 18, end: 18 }, { start: 18.5 }, { anchorSha256: "bad" },
      { start: report().objects[0]!.evidence[0]!.start + 1 },
    ];
    for (const mutation of mutations) {
      const input = report();
      Object.assign(input.objects[0]!.evidence[0]!, mutation);
      expect(() => createAdjudicationTransport(input, paragraphs)).toThrow();
    }
    for (const mutation of [{ text: text + "错" }, { end: paragraphs[0]!.end + 1 }, { sha256: "bad" }]) {
      expect(() => createAdjudicationTransport(report(), [{ ...paragraphs[0]!, ...mutation }, paragraphs[1]!])).toThrow("paragraph drift");
    }
    expect(() => createAdjudicationTransport(report(), [paragraphs[0]!, paragraphs[0]!])).toThrow("duplicate");
  });

  it("round-trips nested repair evidence without changing canonical IDs, prose, quotes or hash locators", () => {
    const transport = createAdjudicationTransport(report(), paragraphs);
    const row = review().omissions[0]!;
    const value = { draft: review(), repair: { omissions: [{ index: 2, value: row }], identities: [{ index: 3, value: review().identities[0] }] },
      prose: "chapter-a:12 和 p0 是正文中的原样字符串。", paragraph: "chapter-a:12",
      evidence: [{ paragraph: "chapter-a:12", quote: "chapter-a:12" }, report().objects[0]!.evidence[0]!, { paragraph: "foreign:0" }] };
    const snapshot = structuredClone(value), encoded = transport.encode(value) as typeof value;
    expect(encoded.repair.omissions[0]!.value.evidence[0]!.paragraph).toBe("p1");
    expect(encoded.draft.records[0]!.id).toBe(value.draft.records[0]!.id);
    expect(encoded.prose).toBe(value.prose);
    expect(encoded.paragraph).toBe(value.paragraph);
    expect(encoded.evidence).toEqual([{ paragraph: "p0", quote: "chapter-a:12" }, value.evidence[1], { paragraph: "foreign:0" }]);
    expect(transport.decode(encoded)).toEqual(value);
    expect(value).toEqual(snapshot);
  });

  it("keeps unknown references available for canonical validation to reject", () => {
    const input = report(), transport = createAdjudicationTransport(input, paragraphs);
    const canonical = sourceAdjudicationSchemaFor(input, paragraphs), boundary = z.preprocess(transport.decode, canonical);
    const encoded = transport.encode(review());
    const decoded = boundary.parse(encoded);
    validateSourceAdjudication(decoded, input, paragraphs);
    for (const unknown of ["p999", "foreign:0"]) {
      const bad = structuredClone(encoded) as SourceAdjudication;
      bad.records[0]!.evidence[0]!.paragraph = unknown;
      expect((transport.decode(bad) as SourceAdjudication).records[0]!.evidence[0]!.paragraph).toBe(unknown);
      expect(boundary.safeParse(bad).success).toBe(false);
      expect(() => validateSourceAdjudication(transport.decode(bad) as SourceAdjudication, input, paragraphs)).toThrow("unknown adjudication");
    }
  });

  it("shortens evidence enums in shared schemas and patch values without modifying a shared prose enum", () => {
    const transport = createAdjudicationTransport(report(), paragraphs);
    const paragraph = z.enum(paragraphs.map(item => item.id));
    const citation = z.strictObject({ paragraph });
    const row = z.strictObject({ id: z.string(), evidence: z.array(citation) });
    const schema = z.strictObject({ prose: paragraph, sample: citation, records: z.array(row),
      omissions: z.array(z.strictObject({ index: z.number().int(), value: row })) });
    const original = schema.toJSONSchema(), wire = transport.jsonSchema(schema);
    const properties = wire.properties!;
    expect(dereference(properties.prose, wire).enum).toEqual(paragraphs.map(item => item.id));
    const sample = dereference(properties.sample, wire).properties as Record<string, unknown>;
    expect(dereference(sample.paragraph, wire).enum).toEqual(paragraphs.map(item => item.id));
    const records = dereference(properties.records, wire);
    const record = dereference(records.items, wire), rowProperties = record.properties as Record<string, unknown>;
    const evidence = dereference(rowProperties.evidence, wire), evidenceRow = dereference(evidence.items, wire);
    expect(dereference((evidenceRow.properties as Record<string, unknown>).paragraph, wire).enum).toEqual(["p0", "p1"]);
    const omission = dereference(dereference(properties.omissions, wire).items, wire);
    expect((omission.properties as Record<string, unknown>).value).toEqual(records.items);
    expect(wire.$defs).toBeDefined();
    expect(schema.toJSONSchema()).toEqual(original);
    expect(JSON.stringify(transport.jsonSchema(sourceAdjudicationSchemaFor(report(), paragraphs)))).not.toContain("chapter-a:12");
  });
});
