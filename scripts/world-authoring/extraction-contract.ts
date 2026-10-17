import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";

const citation = z.strictObject({ paragraph: z.string(), anchor: z.string().min(4).max(100) });
const evidence = z.array(citation).min(1);
export const extractionSchema = z.strictObject({
  chapters: z.array(z.string()),
  objects: z.array(z.strictObject({
    label: z.string().min(1), kind: z.enum(["person", "place", "organization", "species", "item", "method", "rule", "resource"]),
    aliases: z.array(z.string()), description: z.string(), region: z.string(), evidence,
  })),
  facts: z.array(z.strictObject({
    subject: z.string().min(1), relation: z.string().min(1), related: z.array(z.string()), statement: z.string().min(1),
    basis: z.enum(["narration", "testimony", "inference"]),
    domain: z.enum(["geography", "cultivation", "society", "relationships", "history"]),
    validTime: z.string(), learnedTime: z.string(),
    opening: z.enum(["confirmed", "backprojection", "future", "unknown"]), openingReason: z.string().min(1),
    qualifications: z.array(z.string()), evidence,
  })),
  issues: z.array(z.strictObject({ subject: z.string(), description: z.string(), evidence: z.array(citation) })),
});

export type Extraction = z.infer<typeof extractionSchema>;
export interface SourceParagraph { id: string; chapterId: string; start: number; end: number; text: string; sha256: string; sourceVersion?: string }

export function validateExtraction(value: Extraction, paragraphs: SourceParagraph[], chapters: string[]): void {
  if (new Set(value.chapters).size !== value.chapters.length ||
    [...value.chapters].sort().join("|") !== [...new Set(chapters)].sort().join("|")) throw new Error("extraction chapter coverage mismatch");
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
  const failures: string[] = [];
  for (const item of [...value.objects, ...value.facts, ...value.issues]) {
    for (const ref of item.evidence) {
      const paragraph = byId.get(ref.paragraph);
      if (!paragraph || !paragraph.text.includes(ref.anchor)) failures.push(`unverifiable citation ${ref.paragraph}: ${ref.anchor}`);
    }
  }
  if (failures.length) throw new Error(failures.join("\n"));
}

/** Quotes stay in the local audit; maintained facts contain locators and hashes. */
export function materializeExtraction(batchId: string, value: Extraction, paragraphs: SourceParagraph[]) {
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
  const sourceRefs = (refs: z.infer<typeof citation>[]) => refs.map(ref => {
    const paragraph = byId.get(ref.paragraph)!;
    const start = paragraph.start + [...paragraph.text.slice(0, paragraph.text.indexOf(ref.anchor))].length;
    return { chapterId: paragraph.chapterId, paragraphId: paragraph.id, paragraphSha256: paragraph.sha256,
      start, end: start + [...ref.anchor].length, anchorSha256: contentHash(ref.anchor), sourceVersion: paragraph.sourceVersion ?? "candidate-2fc16984" };
  });
  const records = <T extends { evidence: z.infer<typeof citation>[] }>(items: T[], kind: string) => items.map((item, index) => ({
    ...item, id: `${batchId}-${kind}-${String(index + 1).padStart(4, "0")}`, evidence: sourceRefs(item.evidence),
    status: "machine-reviewed-needs-adjudication" as const,
  }));
  return { batchId, chapters: value.chapters, objects: records(value.objects, "object"), facts: records(value.facts, "fact"),
    issues: records(value.issues, "issue"), approvedForRuntime: false };
}
