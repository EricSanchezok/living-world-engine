import { describe, expect, it } from "vitest";
import { contentHash } from "../../src/engine/models/model-audit";
import { createAdjudicationRepair } from "./adjudication-repair";
import type { SourceParagraph } from "./extraction-contract";
import { materializeSourceAdjudication, sourceAdjudicationSchemaFor, validateSourceAdjudication,
  type AdjudicationInput, type SourceAdjudication } from "./source-adjudication";

const text = "村中老医师也叫陈伯，家中药方已传三代。";
const paragraphs: SourceParagraph[] = [{ id: "chapter-a:0", chapterId: "chapter-a", start: 0, end: [...text].length,
  text, sha256: contentHash(text), sourceVersion: "working-v1" }];
const input: AdjudicationInput = { chapters: ["chapter-a"], objects: [{ id: "object-1", label: "老医师", aliases: ["陈伯"] }],
  facts: [{ id: "fact-1" }, { id: "fact-2" }], issues: [{ id: "issue-1" }] };
function review(): SourceAdjudication {
  const evidence = [{ paragraph: "chapter-a:0" }];
  const fact = { sourceClaim: "陈伯家中药方已传三代。", verdict: "supported" as const, rationale: "正文直接叙述。", correction: null,
    basis: "narration" as const, opening: "backprojection" as const, existenceAtOpening: null,
    validTime: "三代传承期间", learnedTime: "本章叙述时", openingReason: "传承早于本章，具体年代待核。", evidence };
  return structuredClone({ chapters: ["chapter-a"], records: [{ id: "object-1", ...fact,
    existenceAtOpening: { status: "unknown" as const, reason: "本段未给老医师年龄。" } }, { id: "fact-1", ...fact }, { id: "fact-2", ...fact }],
  aliases: [{ objectId: "object-1", alias: "陈伯", verdict: "supported" as const, rationale: "明确互指。", evidence }],
  issues: [{ id: "issue-1", status: "needs-cross-batch" as const, resolution: "需要年龄证据。", evidence: [] }],
  omissions: [{ kind: "qualification" as const, subject: "药方", description: "传承年代不等于老医师的年龄。", evidence },
    { kind: "time" as const, subject: "老医师", description: "年龄仍需跨章核定。", evidence }],
  identities: [{ left: "老医师", right: "陈伯", relation: "same-entity" as const, rationale: "明确别名。", evidence },
    { left: "陈伯", right: "另一陈姓人", relation: "unresolved" as const, rationale: "本批未提供互指。", evidence: [] }] });
}

describe("localized source adjudication repair", () => {
  it("repairs missing records and identifiable bad fields while preserving every valid row and full-scan result", () => {
    const baseline = review(), draft = review();
    draft.records[0]!.existenceAtOpening = null;
    Reflect.deleteProperty(draft.records[1]!, "sourceClaim");
    draft.records.pop();
    const before = structuredClone(draft), repair = createAdjudicationRepair(draft, input, paragraphs)!;
    expect(repair).toBeDefined();
    const patch = { records: [...baseline.records].reverse() };
    expect(Object.keys(repair.schema.toJSONSchema().properties ?? {})).toEqual(["records"]);
    expect(repair.context).toMatchObject({ targets: [{ collection: "records", rows: [
      { id: "object-1" }, { id: "fact-1" }, { id: "fact-2", previous: null },
    ] }] });
    const merged = repair.merge(patch) as SourceAdjudication;
    expect(merged).toEqual(baseline);
    expect(draft).toEqual(before);
    expect(patch.records).toEqual([...baseline.records].reverse());
    validateSourceAdjudication(merged, input, paragraphs);
    expect(materializeSourceAdjudication(merged, paragraphs).approvedForRuntime).toBe(false);
  });

  it("repairs supported judgments without evidence and unknown citations by stable record and alias keys", () => {
    const draft = review(), baseline = review();
    draft.records[1]!.evidence = [];
    draft.aliases[0]!.evidence = [{ paragraph: "invented:0" }];
    const repair = createAdjudicationRepair(draft, input, paragraphs)!;
    const patch = { records: [baseline.records[1]], aliases: baseline.aliases };
    const merged = repair.merge(patch) as SourceAdjudication;
    expect(merged).toEqual(baseline);
    expect(merged.records[0]).toEqual(draft.records[0]);
    expect(merged.records[2]).toEqual(draft.records[2]);
    expect(() => repair.merge({ ...patch, records: [...patch.records, baseline.records[0]] })).toThrow();
    expect(() => repair.merge({ ...patch, aliases: [{ ...baseline.aliases[0], alias: "另一称呼" }] })).toThrow();
    expect(() => repair.merge({ ...patch, issues: baseline.issues })).toThrow();
  });

  it("repairs issues and invalid open-ended rows without replacing or deleting valid omissions and identities", () => {
    const draft = review(), baseline = review();
    draft.issues[0]!.status = "resolved-in-this-batch";
    draft.omissions[1]!.evidence = [];
    draft.identities[1]!.relation = "distinct-entity";
    const repair = createAdjudicationRepair(draft, input, paragraphs)!;
    expect(repair.context).toMatchObject({ targets: [
      { collection: "issues", rows: [{ id: "issue-1" }] },
      { collection: "omissions", rows: [{ index: 1 }] },
      { collection: "identities", rows: [{ index: 1 }] },
    ] });
    const patch = { issues: baseline.issues, omissions: [{ index: 1, value: baseline.omissions[1] }],
      identities: [{ index: 1, value: baseline.identities[1] }] };
    expect(repair.merge(patch)).toEqual(baseline);
    expect(() => repair.merge({ ...patch, omissions: [] })).toThrow();
    expect(() => repair.merge({ ...patch, omissions: [{ index: 0, value: baseline.omissions[1] }] })).toThrow();
    expect(() => repair.merge({ ...patch, identities: [{ index: 1, value: null }] })).toThrow();
    expect(() => repair.merge({ ...patch, identities: [...patch.identities, ...patch.identities] })).toThrow();
  });

  it("rejects incomplete, duplicate and extra patch rows instead of accepting array length alone", () => {
    const draft = review(), baseline = review();
    draft.records[1]!.evidence = [];
    draft.records[2]!.evidence = [];
    const repair = createAdjudicationRepair(draft, input, paragraphs)!;
    for (const records of [[], [baseline.records[1]], [baseline.records[1], baseline.records[1]],
      [baseline.records[1], baseline.records[0]], [baseline.records[1], { ...baseline.records[2], id: "foreign" }]]) {
      expect(repair.schema.safeParse({ records }).success).toBe(false);
      expect(() => repair.merge({ records })).toThrow();
    }
    expect(repair.merge({ records: baseline.records.slice(1) })).toEqual(baseline);
  });

  it("runs the complete original validator after structural patch validation", () => {
    const draft = review();
    draft.records[0]!.existenceAtOpening = null;
    draft.records[1]!.existenceAtOpening = { status: "confirmed", reason: "a fact is not an object" };
    const repair = createAdjudicationRepair(draft, input, paragraphs)!;
    const structurallyValid = { records: draft.records.slice(0, 2) };
    expect(repair.schema.safeParse(structurallyValid).success).toBe(true);
    expect(() => repair.merge(structurallyValid)).toThrow("existence time");
    const noEvidence = { records: review().records.slice(0, 2).map(row => ({ ...row, evidence: [] })) };
    expect(() => repair.merge(noEvidence)).toThrow("lacks evidence");
    const unknownEvidence = { records: review().records.slice(0, 2).map(row => ({ ...row, evidence: [{ paragraph: "foreign:0" }] })) };
    expect(repair.schema.safeParse(unknownEvidence).success).toBe(false);
    const corrected = repair.merge({ records: review().records.slice(0, 2) });
    expect(sourceAdjudicationSchemaFor(input, paragraphs).safeParse(corrected).success).toBe(true);
  });

  it("repairs chapters independently and retains valid evidence even when the chapter list is absent", () => {
    const draft = review();
    Reflect.deleteProperty(draft, "chapters");
    const repair = createAdjudicationRepair(draft, input, paragraphs)!;
    expect(Object.keys(repair.schema.toJSONSchema().properties ?? {})).toEqual(["chapters"]);
    expect(repair.merge({ chapters: input.chapters })).toEqual(review());
    for (const chapters of [[], ["foreign"], ["chapter-a", "chapter-a"]]) {
      expect(() => repair.merge({ chapters })).toThrow();
    }
    expect(() => repair.merge({ chapters: input.chapters, records: review().records })).toThrow();
  });

  it("retains stable alias pairing when one object has several aliases", () => {
    const expanded = structuredClone(input);
    expanded.objects[0]!.aliases.push("老陈");
    const draft = review(), repair = createAdjudicationRepair(draft, expanded, paragraphs)!;
    const replacement = { ...draft.aliases[0]!, alias: "老陈", verdict: "ambiguous", rationale: "本段未见此别名。", evidence: [] };
    expect(repair.context).toMatchObject({ targets: [{ collection: "aliases", rows: [{ objectId: "object-1", alias: "老陈", previous: null }] }] });
    const result = repair.merge({ aliases: [replacement] }) as SourceAdjudication;
    expect(result.aliases).toEqual([...draft.aliases, replacement]);
    expect(() => repair.merge({ aliases: [draft.aliases[0]] })).toThrow();
  });

  it("falls back for ambiguous identities, damaged inventories and incomplete initial scans", () => {
    for (const change of [
      (draft: SourceAdjudication) => { draft.records[1]!.id = "object-1"; },
      (draft: SourceAdjudication) => { draft.records[1]!.id = "foreign"; },
      (draft: SourceAdjudication) => { Reflect.deleteProperty(draft.records[1]!, "id"); },
      (draft: SourceAdjudication) => { Reflect.set(draft, "records", "broken"); },
      (draft: SourceAdjudication) => { Reflect.deleteProperty(draft, "omissions"); },
      (draft: SourceAdjudication) => { Reflect.deleteProperty(draft, "identities"); },
      (draft: SourceAdjudication) => { Reflect.set(draft, "unexpected", []); },
    ]) {
      const draft = review();
      change(draft);
      expect(createAdjudicationRepair(draft, input, paragraphs)).toBeUndefined();
    }
    expect(createAdjudicationRepair("truncated", input, paragraphs)).toBeUndefined();
    expect(createAdjudicationRepair(review(), input, [])).toBeUndefined();
    expect(createAdjudicationRepair(review(), input, paragraphs)).toBeUndefined();
  });

  it("snapshots the draft and source contract so caller mutations cannot alter retained rows or validation", () => {
    const draft = review(), expected = review(), mutableInput = structuredClone(input), mutableSources = structuredClone(paragraphs);
    draft.records.pop();
    const repair = createAdjudicationRepair(draft, mutableInput, mutableSources)!;
    draft.omissions = [];
    mutableInput.facts = [];
    mutableSources[0]!.id = "changed:0";
    const merged = repair.merge({ records: [expected.records[2]] }) as SourceAdjudication;
    expect(merged).toEqual(expected);
    merged.identities = [];
    expect(repair.merge({ records: [expected.records[2]] })).toEqual(expected);
  });
});
