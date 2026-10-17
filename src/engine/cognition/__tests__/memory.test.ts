import path from "node:path";
import { describe, it, expect } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { createTestModelCatalog } from "../../testing/model-provider";
import { memorySource, finishMemory, readAgentMemory, type AgentMemory } from "../memory";
import { privateActionView } from "../../direct/views";
import { cognitiveQuestions, cognitiveUpdate } from "../../direct/cognition";

function fixture() {
  const state = structuredClone(loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 7, modelCatalog: createTestModelCatalog() }).initialState);
  const agent = state.agents.keeper!;
  agent.belief.evidence = {}; agent.belief.claims = {};
  const add = (from: number, count: number) => {
    for (let i = from; i < from + count; i++) agent.belief.evidence[`e${i}`] = { id: `e${i}`, kind: "testimony", step: i,
      sourceId: null, description: i === 0 ? "林舟救过我，约定三日后归还 17 枚银币，暗号为青鹭归巢。" : `经历 ${i}：${"今天又有人来往，谈论普通天气。".repeat(30)}` };
  };
  add(0, 20); return { state, agent, add };
}

describe("private rolling Agent memory", () => {
  it("retains important records exactly across three compactions, including late appends and revised beliefs", () => {
    const { state, agent, add } = fixture();
    agent.belief.claims.debt = { id: "debt", subjectId: "self", predicate: "debt", value: { kind: "number", value: 17 }, description: "欠款 17 枚", stance: "believed", confidence: 1, evidenceIds: ["e0"] };
    agent.belief.claims.weather = { id: "weather", subjectId: "self", predicate: "weather", value: { kind: "text", value: "晴" }, description: "从前的普通天气", stance: "believed", confidence: 1, evidenceIds: ["e1"] };
    let checkpoint: AgentMemory | null = null;
    for (let round = 0; round < 3; round++) {
      const source = memorySource(state, agent.id, checkpoint)!;
      expect(JSON.stringify(source.input)).not.toContain("PRIVATE-OTHER-SECRET");
      // Both new higher-step observations and late delivery with an old step survive publication.
      add(20 + round * 15, 15);
      agent.belief.evidence[`late${round}`] = { id: `late${round}`, kind: "observation", sourceId: null, step: 0, description: `压缩期间收到的新线索 ${round}` };
      if (round === 0) {
        agent.belief.claims.debt!.description = "欠款已确认是 19 枚，原来的 17 枚有误";
        agent.belief.claims.debt!.value = { kind: "number", value: 19 };
      }
      checkpoint = finishMemory(source, { summary: `守门人经历了一些普通交谈。第 ${round + 1} 次整理。`,
        retainEvidenceIds: round === 0 ? ["e0"] : [], retainClaimIds: round === 0 ? ["debt"] : [] }, `execution-${round}`);
      const view = readAgentMemory(state, agent, checkpoint);
      expect(view.important.find(item => item.evidence.id === "e0")!.evidence.description).toBe("林舟救过我，约定三日后归还 17 枚银币，暗号为青鹭归巢。");
      expect(view.evidence.some(item => item.id === `late${round}`)).toBe(true);
      expect(view.evidence.some(item => item.id === `e${34 + round * 15}`)).toBe(true);
      expect(view.claims.find(item => item.id === "debt")!.description).toContain("19 枚");
      expect(JSON.stringify(cognitiveQuestions(state, agent.id, view.claims))).not.toContain("从前的普通天气");
      const questions = cognitiveQuestions(state, agent.id, view.claims);
      const updates = cognitiveUpdate(state, agent.id, view.claims, Object.fromEntries(Object.keys(questions)
        .map(id => [id, { type: "choice" as const, choice: "unchanged", probabilities: null, confidence: null }])));
      expect(Object.keys(updates.beliefs)).toEqual(["debt"]);
      expect(checkpoint.version).toBe(round + 1);
    }
    const view = privateActionView(state, agent.id, null, { read: () => checkpoint, pressure: async () => {} }).state;
    expect(JSON.stringify(view)).toContain("青鹭归巢");
    expect((view as unknown as { knowledge: { evidence: unknown[] } }).knowledge.evidence.length).toBeLessThan(Object.keys(agent.belief.evidence).length);
    expect(Object.keys(agent.belief.evidence)).toContain("e0");
  });
  it("keeps goals, commitments and referenced evidence and rejects invented references or no reduction", () => {
    const { state, agent } = fixture();
    agent.character.commitments.promise = { id: "promise", description: "明天归还铜钥匙", priority: 1, subjectIds: [], status: "active", createdAtStep: 0, updatedAtStep: 0, evidenceIds: ["e1"] };
    const source = memorySource(state, agent.id)!;
    expect(source.protectedEvidenceIds).toContain("e1");
    expect(() => finishMemory(source, { summary: "简要经历", retainEvidenceIds: ["alien"], retainClaimIds: [] }, null)).toThrow("unknown source");
    expect(() => finishMemory(source, { summary: "x".repeat(100000), retainEvidenceIds: [], retainClaimIds: [] }, null)).toThrow("did not reduce");
    const checkpoint = finishMemory(source, { summary: "普通往来。", retainEvidenceIds: [], retainClaimIds: [] }, null);
    expect(readAgentMemory(state, agent, checkpoint).important.some(item => item.evidence.id === "e1")).toBe(true);
    expect(readAgentMemory(state, state.agents.player!, checkpoint).version).toBe(0);
    expect(agent.character.commitments.promise.status).toBe("active");
  });
});
