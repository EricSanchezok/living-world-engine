import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { extractionSchema, type Extraction, type SourceParagraph } from "./extraction-contract";

export const editorialCorrectionsSchema = z.strictObject({
  identity: z.string(),
  expectedDraftHash: z.string(),
  reviewer: z.string().min(1),
  scope: z.literal("targeted-corrections-not-runtime-approval"),
  corrections: z.array(z.strictObject({
    collection: z.enum(["objects", "facts", "issues"]),
    index: z.number().int().nonnegative(),
    expectedRecordHash: z.string(),
    fields: z.record(z.string(), z.unknown()),
    citations: z.array(z.strictObject({
      index: z.number().int().nonnegative(), paragraph: z.string(),
      start: z.number().int().nonnegative(), end: z.number().int().positive(),
    })),
    reason: z.string().min(1),
  })),
});

/** Pinned edits cannot silently apply to another draft or rewrite source text. */
export function applyEditorialCorrections(value: Extraction, identity: string, input: unknown, paragraphs: SourceParagraph[]): Extraction {
  const review = editorialCorrectionsSchema.parse(input);
  if (review.identity !== identity || review.expectedDraftHash !== contentHash(value)) throw new Error("stale editorial review");
  const result = structuredClone(value);
  const touched = new Set<string>();
  for (const correction of review.corrections) {
    const key = `${correction.collection}:${correction.index}`;
    if (touched.has(key)) throw new Error(`duplicate editorial correction ${key}`);
    touched.add(key);
    const record = result[correction.collection][correction.index];
    if (!record || contentHash(record) !== correction.expectedRecordHash) throw new Error(`editorial record mismatch ${key}`);
    if (Object.hasOwn(correction.fields, "evidence")) throw new Error("citation changes require source offsets");
    Object.assign(record, correction.fields);
    const citations = new Set<number>();
    for (const edit of correction.citations) {
      const paragraph = paragraphs.find(item => item.id === edit.paragraph);
      if (citations.has(edit.index) || !record.evidence[edit.index] || !paragraph || edit.start >= edit.end || edit.end > [...paragraph.text].length) {
        throw new Error(`invalid editorial citation ${key}`);
      }
      citations.add(edit.index);
      record.evidence[edit.index] = { paragraph: paragraph.id, anchor: [...paragraph.text].slice(edit.start, edit.end).join("") };
    }
  }
  return extractionSchema.parse(result);
}
