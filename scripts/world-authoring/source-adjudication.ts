import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import type { SourceParagraph } from "./extraction-contract";

const citation = z.strictObject({ paragraph: z.string() });
const evidence = z.array(citation);
const verdict = z.enum(["supported", "unsupported", "ambiguous"]);
export const sourceAdjudicationSchema = z.strictObject({
  chapters: z.array(z.string()),
  records: z.array(z.strictObject({
    id: z.string(), sourceClaim: z.string().min(1), verdict, rationale: z.string().min(1), correction: z.string().nullable(),
    basis: z.enum(["narration", "testimony", "inference", "not-established"]),
    opening: z.enum(["confirmed", "backprojection", "future", "unknown"]),
    existenceAtOpening: z.strictObject({ status: z.enum(["confirmed", "backprojection", "future", "unknown"]),
      reason: z.string().min(1) }).nullable(),
    validTime: z.string().min(1), learnedTime: z.string().min(1), openingReason: z.string().min(1), evidence,
  })),
  aliases: z.array(z.strictObject({ objectId: z.string(), alias: z.string(), verdict, rationale: z.string().min(1), evidence })),
  issues: z.array(z.strictObject({ id: z.string(), status: z.enum(["resolved-in-this-batch", "needs-cross-batch", "still-open"]),
    resolution: z.string().min(1), evidence })),
  omissions: z.array(z.strictObject({ kind: z.enum(["object", "fact", "qualification", "time"]),
    subject: z.string().min(1), description: z.string().min(1), evidence: evidence.min(1) })),
  identities: z.array(z.strictObject({ left: z.string(), right: z.string(),
    relation: z.enum(["same-entity", "distinct-entity", "unresolved"]), rationale: z.string().min(1), evidence })),
});
export type SourceAdjudication = z.infer<typeof sourceAdjudicationSchema>;
export interface AdjudicationInput {
  chapters: string[];
  objects: Array<{ id: string; label: string; aliases: string[] }>;
  facts: Array<{ id: string }>;
  issues: Array<{ id: string }>;
}

function coverageProblem(actual: string[], expected: string[], label: string) {
  if (new Set(actual).size !== actual.length || [...actual].sort().join("\0") !== [...new Set(expected)].sort().join("\0")) {
    return `adjudication ${label} coverage mismatch: ${JSON.stringify({
      missing: expected.filter(id => !actual.includes(id)), unexpected: actual.filter(id => !expected.includes(id)),
      duplicated: [...new Set(actual.filter((id, index) => actual.indexOf(id) !== index))],
    })}`;
  }
  return null;
}

export function sourceAdjudicationManifest(input: AdjudicationInput) {
  const objectIds = input.objects.map(record => record.id), factIds = input.facts.map(record => record.id);
  const aliases = input.objects.flatMap(object => object.aliases.map(alias => ({ objectId: object.id, alias })));
  const issueIds = input.issues.map(issue => issue.id);
  return { chapters: input.chapters, objectIds, factIds, aliases, issueIds,
    counts: { objects: objectIds.length, facts: factIds.length, records: objectIds.length + factIds.length,
      aliases: aliases.length, issues: issueIds.length } };
}

export function sourceAdjudicationSchemaFor(input: AdjudicationInput, paragraphs: SourceParagraph[]) {
  const manifest = sourceAdjudicationManifest(input);
  if (!paragraphs.length) throw new Error("source adjudication requires complete source paragraphs");
  const selectedEvidence = z.array(z.strictObject({ paragraph: z.enum(paragraphs.map(paragraph => paragraph.id)) }));
  return sourceAdjudicationSchema.extend({
    chapters: sourceAdjudicationSchema.shape.chapters.length(manifest.chapters.length),
    records: z.array(sourceAdjudicationSchema.shape.records.element.extend({ evidence: selectedEvidence })).length(manifest.counts.records),
    aliases: z.array(sourceAdjudicationSchema.shape.aliases.element.extend({ evidence: selectedEvidence })).length(manifest.counts.aliases),
    issues: z.array(sourceAdjudicationSchema.shape.issues.element.extend({ evidence: selectedEvidence })).length(manifest.counts.issues),
    omissions: z.array(sourceAdjudicationSchema.shape.omissions.element.extend({ evidence: selectedEvidence.min(1) })),
    identities: z.array(sourceAdjudicationSchema.shape.identities.element.extend({ evidence: selectedEvidence })),
  });
}

/** Complete coverage and verbatim locators are prerequisites, not semantic proof. */
export function validateSourceAdjudication(value: SourceAdjudication, input: AdjudicationInput, paragraphs: SourceParagraph[]) {
  const errors: string[] = [coverageProblem(value.chapters, input.chapters, "chapter"),
    coverageProblem(value.records.map(record => record.id), [...input.objects, ...input.facts].map(record => record.id), "record"),
    coverageProblem(value.issues.map(issue => issue.id), input.issues.map(issue => issue.id), "issue"),
    coverageProblem(value.aliases.map(alias => `${alias.objectId}\0${alias.alias}`),
      input.objects.flatMap(object => object.aliases.map(alias => `${object.id}\0${alias}`)), "alias")].filter((error): error is string => error !== null);
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
  const objectIds = new Set(input.objects.map(object => object.id));
  for (const record of value.records) {
    if (objectIds.has(record.id) !== (record.existenceAtOpening !== null)) {
      errors.push(`object existence time must be separate from statement time: ${record.id}`);
    }
  }
  for (const record of [...value.records, ...value.aliases]) {
    if (record.verdict === "supported" && !record.evidence.length) errors.push("supported adjudication lacks evidence");
  }
  for (const identity of value.identities) {
    if (identity.relation !== "unresolved" && !identity.evidence.length) errors.push("resolved identity lacks evidence");
  }
  for (const issue of value.issues) {
    if (issue.status === "resolved-in-this-batch" && !issue.evidence.length) errors.push(`issue ${issue.id}: resolved-in-this-batch requires source evidence; procedural notes without a source-bound resolution must remain still-open`);
  }
  for (const record of [...value.records, ...value.aliases, ...value.issues, ...value.omissions, ...value.identities]) {
    for (const citation of record.evidence) {
      if (!byId.has(citation.paragraph)) {
        errors.push(`unknown adjudication source paragraph ${citation.paragraph}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
}

export function materializeSourceAdjudication(value: SourceAdjudication, paragraphs: SourceParagraph[]) {
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
  const refs = (citations: z.infer<typeof citation>[]) => citations.map(citation => {
    const paragraph = byId.get(citation.paragraph)!;
    return { chapterId: paragraph.chapterId, paragraphId: paragraph.id, paragraphSha256: paragraph.sha256,
      start: paragraph.start, end: paragraph.end, anchorSha256: contentHash(paragraph.text),
      sourceVersion: paragraph.sourceVersion ?? "candidate-2fc16984" };
  });
  const records = <T extends { evidence: z.infer<typeof citation>[] }>(values: T[]) => values.map(record => ({ ...record, evidence: refs(record.evidence) }));
  return { chapters: value.chapters, records: records(value.records), aliases: records(value.aliases),
    issues: records(value.issues), omissions: records(value.omissions), identities: records(value.identities),
    status: "source-semantic-review-not-runtime-approval" as const, approvedForRuntime: false as const };
}
