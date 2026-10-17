import { z } from "zod";
import type { ReadingBatch } from "./authoring-index";
import type { SourceParagraph } from "./extraction-contract";
import { buildSourceAdjudicationEvidence } from "./source-evidence";
import { sourceAdjudicationSchemaFor, validateSourceAdjudication, type AdjudicationInput } from "./source-adjudication";
import type { ReadRecoveryAttempt } from "./adjudication-syntax-recovery";

const storedRow = z.object({ evidence: z.array(z.object({ paragraphId: z.string() })) }).passthrough();
const storedReview = z.object({ policyHash: z.string(), chapters: z.array(z.string()),
  records: z.array(storedRow), aliases: z.array(storedRow), issues: z.array(storedRow),
  omissions: z.array(storedRow), identities: z.array(storedRow) });

/** Reuse preserves the original producer and requires current source and semantic contracts. */
export function validateReusableAdjudication(stored: unknown, report: AdjudicationInput, batch: ReadingBatch,
  paragraphs: SourceParagraph[], readChapter: (id: string) => string, policyHash: string, readRecoveryAttempt?: ReadRecoveryAttempt) {
  const saved = storedReview.parse(stored);
  if (saved.policyHash !== policyHash) throw new Error("source adjudication policy changed");
  buildSourceAdjudicationEvidence(stored, report, batch, readChapter,
    readRecoveryAttempt ? { paragraphs, readAttempt: readRecoveryAttempt } : undefined);
  const rows = (values: typeof saved.records) => values.map(row => ({ ...row,
    evidence: row.evidence.map(ref => ({ paragraph: ref.paragraphId })) }));
  const canonical = sourceAdjudicationSchemaFor(report, paragraphs).parse({ chapters: saved.chapters,
    records: rows(saved.records), aliases: rows(saved.aliases), issues: rows(saved.issues),
    omissions: rows(saved.omissions), identities: rows(saved.identities) });
  validateSourceAdjudication(canonical, report, paragraphs);
  return canonical;
}
