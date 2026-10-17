import { contentHash } from "../../src/engine/models/model-audit";
import { extractionSchema, type SourceParagraph } from "./extraction-contract";

export interface CitationRelocation {
  collection: "objects" | "facts" | "issues";
  index: number;
  citationIndex: number;
  fromParagraph: string;
  toParagraph: string;
  anchorSha256: string;
}

export function uniqueCitationParagraph(anchor: string, paragraphs: SourceParagraph[]): string | null {
  const matches = paragraphs.filter(paragraph => paragraph.text.includes(anchor));
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  return match.text.indexOf(anchor) === match.text.lastIndexOf(anchor) ? match.id : null;
}

/** Only a unique verbatim anchor can repair an incorrectly named paragraph. */
export function relocateUniqueCitations(input: unknown, paragraphs: SourceParagraph[]) {
  const value = extractionSchema.parse(structuredClone(input));
  const byId = new Map(paragraphs.map(paragraph => [paragraph.id, paragraph]));
  const relocations: CitationRelocation[] = [];
  for (const collection of ["objects", "facts", "issues"] as const) {
    for (const [index, record] of value[collection].entries()) {
      for (const [citationIndex, citation] of record.evidence.entries()) {
        if (byId.get(citation.paragraph)?.text.includes(citation.anchor)) continue;
        const target = uniqueCitationParagraph(citation.anchor, paragraphs);
        if (!target) continue;
        relocations.push({ collection, index, citationIndex, fromParagraph: citation.paragraph,
          toParagraph: target, anchorSha256: contentHash(citation.anchor) });
        citation.paragraph = target;
      }
    }
  }
  return { value, relocations };
}
