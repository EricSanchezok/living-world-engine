import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { createAdjudicationTransport } from "./adjudication-transport";
import { materializeSourceAdjudication, type SourceAdjudication } from "./source-adjudication";
import { recoverAdjudicationObjectSeparator, recoverRejectedAdjudication } from "./adjudication-syntax-recovery";

describe("source-only terminal separator recovery", () => {
  it("deletes exactly the observed structural characters and retains all string bytes", () => {
    const prose = '正文说：例子 ,"} 并不是分隔符；另含 😀、反斜线 \\ 与引号 "。';
    const value = { prose, a: { reason: "已经完成。" }, validTime: "本批时" };
    const valid = JSON.stringify(value), raw = valid.replace('"已经完成。"}', '"已经完成。","}');
    const start = raw.indexOf(',"}', raw.indexOf('"reason"'));
    const result = recoverAdjudicationObjectSeparator(raw)!;
    expect(result.value).toEqual(value);
    expect(result.text).toBe(valid);
    expect(result.removed).toEqual([{ start, end: start + 2, text: ',"' }]);
    expect(result.originalHash).toBe(contentHash(raw));
    expect(result.recoveredTextHash).toBe(contentHash(valid));
    expect(recoverAdjudicationObjectSeparator(valid)).toBeNull();
  });

  it.each([
    '{"a":{"reason":"x","},"a":2}',
    '{"a":{"reason":"x","},"\\u0061":2}',
    '{"a":{"reason":"x","},"b":{"reason":"y","}}',
    '{"a":{"reason":"x","},"b":',
    '{"a":{"reason":"x","}} {}',
    '{"a":{"reason":"x","}} trailing',
    'prefix {"a":{"reason":"x","}}',
    '[{"reason":"x","}]',
    '{"a":{"reason":"x","pending}}',
    '{"a":{"reason":"x"," }}',
    '{"a":{"reason":"x",}}',
    '{"a":{"reason":"x","},"b":"bad\\q"}',
    '{"a":{"reason":"x","},"b":01}',
    '{"a":{"reason":"x","} "b":2}',
    '{"a":{"reason":false,"}}',
    '{"a":{"reason":"x","}:"ambiguous"}}',
    '{"a":{"reason":"x","}}}',
    '{"prose":"literal ,\\"} is text", "unfinished":',
  ])("refuses other faults, duplicate keys, incomplete or multiple roots: %s", raw => {
    expect(recoverAdjudicationObjectSeparator(raw)).toBeNull();
  });
});

function fixture() {
  const text = "村医保存一份药方。";
  const paragraphs = [{ id: "chapter-a:0", chapterId: "chapter-a", text, start: 0, end: [...text].length,
    sha256: contentHash(text), sourceVersion: "test-source" }];
  const canonical: SourceAdjudication = { chapters: ["chapter-a"], records: [{ id: "object-1", sourceClaim: text,
    verdict: "supported", rationale: "正文叙述。", correction: null, basis: "narration", opening: "unknown",
    existenceAtOpening: { status: "unknown", reason: "年龄未知。" }, validTime: "本章", learnedTime: "本章",
    openingReason: "无年代证据。", evidence: [{ paragraph: "chapter-a:0" }] }], aliases: [], issues: [], omissions: [], identities: [] };
  const input = { chapters: canonical.chapters, objects: [{ id: "object-1", label: "村医", aliases: [],
    evidence: materializeSourceAdjudication(canonical, paragraphs).records[0]!.evidence }], facts: [], issues: [] };
  const raw = JSON.stringify(createAdjudicationTransport(input, paragraphs).encode(canonical)).replace('"年龄未知。"}', '"年龄未知。","}');
  const bindings = { identity: contentHash("identity"), sourceReportHash: contentHash(input), policyHash: contentHash("policy"), schemaHash: contentHash("schema") };
  const saved = { ...bindings, transportVersion: "paragraph-refs-targeted-repair-v2", mode: "complete-review", value: raw, wireValue: raw,
    rejected: true, audit: { invocations: [{ responseHash: contentHash(raw), rawOutputHash: contentHash(raw), outputDisposition: "rejected", finishReason: "stop" }] } };
  return { paragraphs, canonical, input, raw, bindings, saved };
}

describe("source recovery acceptance", () => {
  it("requires the original rejected response and full source validation without mutating it", () => {
    const f = fixture(), before = structuredClone(f.saved);
    const result = recoverRejectedAdjudication(f.saved, f.bindings, 0, f.input, f.paragraphs)!;
    expect(result.value).toEqual(f.canonical);
    expect(result.evidence).toMatchObject({ policy: "source-object-terminal-separator-v1", providerRejected: true,
      auditHash: contentHash(f.saved.audit), canonicalValueHash: contentHash(f.canonical),
      cache: { identity: f.bindings.identity, attempt: 0, contentHash: contentHash(f.saved) } });
    expect(f.saved).toEqual(before);
  });

  it("refuses partial patches, truncation, binding drift, or falsely accepted producer evidence", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.saved.mode = "targeted-repair"; },
      (f: ReturnType<typeof fixture>) => { f.saved.rejected = false; },
      (f: ReturnType<typeof fixture>) => { f.saved.identity = contentHash("other"); },
      (f: ReturnType<typeof fixture>) => { f.saved.wireValue += " "; },
      (f: ReturnType<typeof fixture>) => { f.saved.audit.invocations[0]!.finishReason = "length"; },
      (f: ReturnType<typeof fixture>) => { f.saved.audit.invocations[0]!.outputDisposition = "accepted"; },
      (f: ReturnType<typeof fixture>) => { f.saved.audit.invocations[0]!.rawOutputHash = contentHash("other"); },
      (f: ReturnType<typeof fixture>) => { f.paragraphs[0]!.sha256 = contentHash("other"); },
      (f: ReturnType<typeof fixture>) => { f.input.objects[0]!.label = "别的村医"; },
    ]) {
      const f = fixture(); mutate(f);
      expect(recoverRejectedAdjudication(f.saved, f.bindings, 0, f.input, f.paragraphs)).toBeNull();
    }
  });

  it("does not recover a syntactically repairable response with invalid schema, coverage, or citations", () => {
    for (const mutate of [
      (value: SourceAdjudication) => { value.records[0]!.id = "foreign"; },
      (value: SourceAdjudication) => { value.records.push(structuredClone(value.records[0]!)); },
      (value: SourceAdjudication) => { value.records[0]!.evidence = []; },
      (value: SourceAdjudication) => { value.records[0]!.evidence = [{ paragraph: "foreign:0" }]; },
      (value: SourceAdjudication) => { value.chapters = []; },
      (value: SourceAdjudication) => { Reflect.deleteProperty(value, "identities"); },
    ]) {
      const f = fixture(); mutate(f.canonical);
      f.saved.wireValue = f.saved.value = JSON.stringify(createAdjudicationTransport(f.input, f.paragraphs).encode(f.canonical))
        .replace('"年龄未知。"}', '"年龄未知。","}');
      f.saved.audit.invocations[0]!.rawOutputHash = f.saved.audit.invocations[0]!.responseHash = contentHash(f.saved.value);
      expect(recoverAdjudicationObjectSeparator(f.saved.value)).not.toBeNull();
      expect(recoverRejectedAdjudication(f.saved, f.bindings, 0, f.input, f.paragraphs)).toBeNull();
    }
  });
});
