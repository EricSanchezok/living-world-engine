import { describe, expect, it } from "vitest";
import { editorialModuleSnapshot, editorialOpeningSnapshot, validateRegionalProposal } from "./regional-proposals";
const tasks = [{ moduleId: "north", candidateId: "object-1", sourceChapterIds: ["chapter-1"] }];
const paragraphs = [{ id: "chapter-1:0", chapterId: "chapter-1", start: 0, end: 2, text: "正文", sha256: "hash" }];
const time = { status: "unknown", reason: "只知后期，尚需前史" };
const row = { moduleId: "north", candidateId: "object-1", recommendation: "defer", sourceClaim: "已有古令，未载取得年", reason: "需作者补写当前状态", targetIds: [], destinationModule: null, existenceAtOpening: time, statementAtOpening: time, learnedTime: "后期读者得知", conflicts: [], missingContent: ["取得年"], evidence: [{ paragraph: "chapter-1:0" }] };
const check = (records: unknown[]) => validateRegionalProposal({ records }, tasks, paragraphs, new Set(["token"]), new Set(["north", "south"]));
describe("regional preliminary opinions", () => {
  it("preserves explicit missing content without approving runtime", () => expect(check([row]).records[0]!.recommendation).toBe("defer"));
  it("rejects missing, duplicate, and foreign candidates", () => {
    expect(() => check([])).toThrow("missing regional");
    expect(() => check([row, row])).toThrow("duplicate regional");
    expect(() => check([{ ...row, candidateId: "other" }])).toThrow("unexpected regional");
  });
  it("rejects invented targets and unsupported accept", () => {
    expect(() => check([{ ...row, targetIds: ["invented"] }])).toThrow("unknown proposal target");
    expect(() => check([{ ...row, recommendation: "accept", targetIds: ["token"] }])).toThrow("existing complete targets");
  });
  it("rejects citation and transfer drift", () => {
    expect(() => check([{ ...row, evidence: [{ paragraph: "chapter-1:55" }] }])).toThrow("unknown proposal paragraph");
    expect(() => check([{ ...row, recommendation: "transfer", destinationModule: "unknown" }])).toThrow("unknown proposal destination");
  });
  it("requires evidence in the actual candidate chapter", () => {
    expect(() => validateRegionalProposal({ records: [row] }, [{ ...tasks[0]!, sourceChapterIds: ["other"] }], paragraphs, new Set(), new Set())).toThrow("original candidate source");
  });
});

describe("editorial module input", () => {
  it("includes the base world's existing people and claims with a full input binding", () => {
    const opening = { template: { entities: [{ id: "han-li", name: "韩立", agent: { secret: true } }], laws: { laws: [] }, mechanics: { quantities: [] }, participation: { origins: [] } } };
    const snapshot = editorialOpeningSnapshot(opening, [{ id: "han-household" }]);
    expect(snapshot.entities).toEqual([{ id: "han-li", name: "韩立" }]);
    expect(snapshot.claims[0]!.id).toBe("han-household");
    expect(editorialOpeningSnapshot({ ...opening, provenance: { "entity:han-li": ["han-household"] } }, [{ id: "han-household" }]).hash).not.toBe(snapshot.hash);
  });
  it("includes completed rule-only modules without a subject index", () => {
    const snapshot = editorialModuleSnapshot({ entities: [], laws: [{ id: "law", text: "rule" }] }, [{ id: "claim", statement: "source" }]);
    expect(snapshot.subjects).toEqual([]); expect(snapshot.claims).toHaveLength(1); expect(snapshot.laws).toHaveLength(1);
  });
  it("binds the complete current module while sending canonical facts", () => {
    const region = { entities: [{ id: "person", facts: ["fact"], agent: { belief: "private belief" } }] };
    const snapshot = editorialModuleSnapshot(region, []);
    expect(snapshot.entities[0]).toEqual({ id: "person", facts: ["fact"] });
    expect(editorialModuleSnapshot({ ...region, laws: ["new rule"] }, []).hash).not.toBe(snapshot.hash);
  });
});
