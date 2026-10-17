import { z } from "zod";
import { contentHash } from "../../src/engine/models/model-audit";
import { duplicateJsonKeys } from "../../src/engine/models/json-duplicate-keys";
import type { SourceParagraph } from "./extraction-contract";
import { createAdjudicationTransport } from "./adjudication-transport";
import { materializeSourceAdjudication, sourceAdjudicationSchemaFor, validateSourceAdjudication,
  type AdjudicationInput, type SourceAdjudication } from "./source-adjudication";

const policy = "source-object-terminal-separator-v1" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const localSyntaxRecoverySchema = z.strictObject({
  policy: z.literal(policy), providerRejected: z.literal(true), offsetEncoding: z.literal("utf-16-code-units"),
  removed: z.tuple([z.strictObject({ start: z.number().int().nonnegative(), end: z.number().int().positive(), text: z.literal(',"') })]),
  originalHash: hash, recoveredTextHash: hash, canonicalValueHash: hash, auditHash: hash,
  cache: z.strictObject({ identity: hash, attempt: z.number().int().nonnegative(), contentHash: hash }),
});
export type LocalSyntaxRecovery = z.infer<typeof localSyntaxRecoverySchema>;

/** Scan strict JSON grammar, permitting exactly one observed dangling ," before an
 * object closer after a string value. No regex replacement inside prose, second
 * fault, alternate edit, partial root, insertion, or value-token change is allowed. */
export function recoverAdjudicationObjectSeparator(source: string) {
  try { JSON.parse(source); return null; } catch { /* Only malformed JSON is eligible. */ }
  let cursor = 0;
  const removed: Array<{ start: number; end: number; text: ',"' }> = [];
  const fail = (): never => { throw new Error("outside the source separator recovery grammar"); };
  const whitespace = () => { while (/[\t\n\r ]/u.test(source[cursor] ?? "")) cursor++; };
  function string() {
    if (source[cursor] !== '"') fail();
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") cursor += 2;
      else if (source[cursor++] === '"') { JSON.parse(source.slice(start, cursor)); return; }
    }
    fail();
  }
  function value(depth: number): void {
    if (depth > 128) fail();
    whitespace();
    const opening = source[cursor];
    if (opening === '"') { string(); return; }
    if (opening === "{" || opening === "[") {
      const object = opening === "{", closer = object ? "}" : "]";
      cursor++; whitespace();
      if (source[cursor] === closer) { cursor++; return; }
      for (;;) {
        if (object) { string(); whitespace(); if (source[cursor++] !== ":") fail(); whitespace(); }
        const stringValue = source[cursor] === '"';
        value(depth + 1); whitespace();
        if (object && stringValue && source.slice(cursor, cursor + 3) === ',"}') {
          if (removed.length) fail();
          removed.push({ start: cursor, end: cursor + 2, text: ',"' });
          cursor += 2;
        }
        if (source[cursor] === closer) { cursor++; return; }
        if (source[cursor++] !== ",") fail();
        whitespace();
      }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(cursor));
    if (!token) fail();
    cursor += token![0].length;
  }
  try {
    whitespace();
    if (source[cursor] !== "{") return null;
    value(0); whitespace();
    if (cursor !== source.length || removed.length !== 1) return null;
    const edit = removed[0]!, text = source.slice(0, edit.start) + source.slice(edit.end);
    const result: unknown = JSON.parse(text);
    if (duplicateJsonKeys(text)) return null;
    return { value: result, text, removed: [edit] as [typeof edit], originalHash: contentHash(source), recoveredTextHash: contentHash(text) };
  } catch { return null; }
}

const rejectedAttempt = z.object({
  identity: hash, sourceReportHash: hash, policyHash: hash, schemaHash: hash,
  transportVersion: z.literal("paragraph-refs-targeted-repair-v2"), mode: z.literal("complete-review"),
  value: z.string(), wireValue: z.string(), rejected: z.literal(true),
  audit: z.object({ invocations: z.tuple([z.object({
    responseHash: hash, rawOutputHash: hash, outputDisposition: z.literal("rejected"), finishReason: z.literal("stop"),
  }).passthrough()]) }).passthrough(),
}).passthrough();
type Bindings = { identity: string; sourceReportHash: string; policyHash: string; schemaHash: string };

/** A provider rejection stays a rejection. A derived report is available only
 * after the complete source contract passes; raw attempts are never rewritten. */
export function recoverRejectedAdjudication(saved: unknown, bindings: Bindings, attempt: number,
  input: AdjudicationInput, paragraphs: SourceParagraph[]): { value: SourceAdjudication; evidence: LocalSyntaxRecovery } | null {
  try {
    const raw = rejectedAttempt.parse(saved);
    if (!Number.isSafeInteger(attempt) || attempt < 0 || raw.value !== raw.wireValue ||
      Object.entries(bindings).some(([key, expected]) => raw[key] !== expected) ||
      contentHash(input) !== bindings.sourceReportHash) return null;
    const recovered = recoverAdjudicationObjectSeparator(raw.wireValue);
    if (!recovered || raw.audit.invocations.some(invocation => invocation.responseHash !== recovered.originalHash ||
      invocation.rawOutputHash !== recovered.originalHash)) return null;
    const transport = createAdjudicationTransport(input, paragraphs);
    const value = sourceAdjudicationSchemaFor(input, paragraphs).parse(transport.decode(recovered.value));
    validateSourceAdjudication(value, input, paragraphs);
    const evidence: LocalSyntaxRecovery = { policy, providerRejected: true, offsetEncoding: "utf-16-code-units",
      removed: recovered.removed, originalHash: recovered.originalHash, recoveredTextHash: recovered.recoveredTextHash,
      canonicalValueHash: contentHash(value), auditHash: contentHash(raw.audit),
      cache: { identity: raw.identity, attempt, contentHash: contentHash(saved) } };
    return { value, evidence };
  } catch { return null; }
}

export type ReadRecoveryAttempt = (identity: string, attempt: number) => unknown;

/** Reuse replays the derivation against the immutable local source cache. Missing
 * cache evidence fails closed; the persisted report keeps hashes, never raw text. */
export function validateLocalSyntaxRecovery(stored: unknown, input: AdjudicationInput,
  access?: { paragraphs: SourceParagraph[]; readAttempt: ReadRecoveryAttempt }) {
  const present = z.object({ localSyntaxRecovery: z.unknown().optional(), audits: z.array(z.unknown()) }).parse(stored);
  if (present.localSyntaxRecovery === undefined) {
    const audit = present.audits.at(-1) as { invocations?: Array<{ outputDisposition?: string }> } | undefined;
    if (audit?.invocations?.at(-1)?.outputDisposition === "rejected") throw new Error("rejected source response requires local derivation evidence");
    return;
  }
  const report = z.object({ identity: hash, sourceReportHash: hash, policyHash: hash, schemaHash: z.string(),
    localSyntaxRecovery: localSyntaxRecoverySchema, audits: z.array(z.unknown()) }).passthrough().parse(stored);
  if (!access) throw new Error("local syntax recovery requires its original source cache");
  const { paragraphs, readAttempt } = access;
  const evidence = report.localSyntaxRecovery;
  const raw = readAttempt(evidence.cache.identity, evidence.cache.attempt);
  const { identity, sourceReportHash, policyHash, schemaHash } = report;
  const replay = recoverRejectedAdjudication(raw, { identity, sourceReportHash, policyHash, schemaHash }, evidence.cache.attempt, input, paragraphs);
  if (!replay || contentHash(replay.evidence) !== contentHash(evidence) ||
    !report.audits.some(audit => contentHash(audit) === evidence.auditHash)) {
    throw new Error("local syntax recovery evidence drift");
  }
  const materialized = materializeSourceAdjudication(replay.value, paragraphs);
  if (["chapters", "records", "aliases", "issues", "omissions", "identities"].some(key =>
    contentHash(report[key]) !== contentHash(Reflect.get(materialized, key)))) throw new Error("local syntax recovery result drift");
}
