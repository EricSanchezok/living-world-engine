import { describe, expect, it } from "vitest";
import { decisionPromptV2 } from "../../engine/models/decision-v2";
import { completeParagraphs, renderNarrativeParagraph, narrativeContinuation, requireDeliveredSpeech, narrativeFallback, narrativeEvidence, narrativeGroundingChoices, type ScenePacket } from "../world-narrative";

const source: ScenePacket = {
  participantId: "reader", agentId: "traveler", submissionId: "action", submittedAt: null, requestedAction: "问价",
  world: { name: "港口", language: "zh-CN", style: "具体自然" }, playerName: "旅人", location: "码头", memories: [], knownEntities: [],
  observations: [{ id: "heard", revision: 1, step: 1, worldTimeSeconds: 2, sourceEventIds: ["uttered"], summary: "听到报价",
    scene: { actionKind: "speak", status: "succeeded", actor: "店主", attempt: "", manner: null, outcome: "话语送达。", details: [], speech: { speaker: "店主", utterance: "三枚金币；我还没同意赊账。" } } }],
  speech: [{ id: "speech-ab12", speaker: "店主", utterance: "三枚金币；我还没同意赊账。" }],
};

describe("immutable narrative paragraphs", () => {
  it("uses a closed evidence policy for prose, separate from common-sense world adjudication", () => {
    const publication = decisionPromptV2("publication"), world = decisionPromptV2();
    expect(publication.system).toContain("closed record");
    expect(publication.system).toContain("may lie");
    expect(world.system).toContain("contextual common sense");
    expect(publication.version).not.toBe(world.version);
  });
  it("requires each independent factual focus without additional publication requests", () => {
    const answers = Object.fromEntries(["material", "agency", "evidence", "speech"].map(axis => [`paragraph0_${axis}`, { type: "choice", choice: "grounded" }]));
    expect(narrativeGroundingChoices(answers, 1)).toEqual(["grounded"]);
    answers.paragraph0_agency!.choice = "contradiction";
    expect(narrativeGroundingChoices(answers, 1)).toEqual(["contradiction"]);
    answers.paragraph0_agency!.choice = "grounded";
    delete answers.paragraph0_speech;
    expect(narrativeGroundingChoices(answers, 1)).toEqual(["added_content"]);
  });
  it("publishes only completed strings across escaped quotes and chunk boundaries", () => {
    expect(completeParagraphs('{"paragraphs":["雨停了。", "他举起')).toEqual(["雨停了。"]);
    expect(completeParagraphs('{"paragraphs":["他说：\\"等等\\"。","仍在\\n等待。"]}')).toEqual(['他说："等等"。', "仍在\n等待。"]);
    expect(completeParagraphs('{"paragraphs":["unfinished\\"')).toEqual([]);
    expect(completeParagraphs('{"paragraphs":["第一段。\\n\\n第二段尚未结束')).toEqual(["第一段。"]);
    expect(completeParagraphs('{"paragraphs":["第一段。\\n\\n第二段。"]}')).toEqual(["第一段。", "第二段。"]);
  });
  it("inserts the exact delivered utterance and refuses unknown speech references", () => {
    expect(renderNarrativeParagraph("店主回答：[[speech-ab12]]", source)).toBe("店主回答：“三枚金币；我还没同意赊账。”");
    expect(() => renderNarrativeParagraph("[[speech-ffff]]", source)).toThrow("undelivered");
    expect(() => renderNarrativeParagraph("[[invalid]]", source)).toThrow("unresolved");
    expect(() => requireDeliveredSpeech(source, [renderNarrativeParagraph("店主说：“我同意赊账。”", source)]))
      .toThrow("missing delivered");
    expect(renderNarrativeParagraph("店主说：“三枚金币；我还没同意赊账。”[[speech-ab12]]", source))
      .toBe("店主说：“三枚金币；我还没同意赊账。”");
    expect(renderNarrativeParagraph("店主说：三枚金币；我还没同意赊账。 [[speech-ab12]]", source))
      .toBe("店主说：“三枚金币；我还没同意赊账。”");
    const repeated = structuredClone(source); repeated.speech.push({ ...source.speech[0]!, id: "speech-ab13" });
    expect(renderNarrativeParagraph("[[speech-ab12]][[speech-ab13]]", repeated))
      .toBe("“三枚金币；我还没同意赊账。”“三枚金币；我还没同意赊账。”");
  });
  it("keeps only new continuation text after an exact echo of already published paragraphs", () => {
    expect(narrativeContinuation("价钱已经说清。 “三枚金币。”", ["价钱已经说清。"])) .toBe("“三枚金币。”");
    expect(narrativeContinuation("价钱已经说清。", ["价钱已经说清。"])) .toBe("");
    expect(narrativeContinuation("他又说了一遍价钱。", ["价钱已经说清。"])) .toBe("他又说了一遍价钱。");
  });
  it("keeps factual speech when the prose service is unavailable", () => {
    expect(narrativeFallback(source)).toBe("店主说：“三枚金币；我还没同意赊账。”");
  });
  it("allows observed signs and remembered literal text without treating them as new speech", () => {
    const scene = structuredClone(source);
    scene.observations[0]!.summary = "木箱上写着「公用——擦手擦鞋，勿取走」。";
    expect(renderNarrativeParagraph("你看清木箱上的字：「公用——擦手擦鞋，勿取走」。", scene)).toContain("勿取走");
    scene.requestedAction = "我希望告示写着「全部免费带走」。";
    // Factual checks happen at the publication boundary, not by matching typography.
    expect(renderNarrativeParagraph("眼前这份“公用”的意思已经清楚。", scene)).toContain("公用");
    expect(() => requireDeliveredSpeech(scene, ["你看清了告示。"])) .toThrow("missing delivered");
  });
  it("requires the actual delivered words before completing a beat", () => {
    expect(() => requireDeliveredSpeech(source, ["店主报了一个价。"])) .toThrow("missing delivered");
    expect(() => requireDeliveredSpeech(source, ["店主说：“三枚金币；我还没同意赊账。”"])) .not.toThrow();
  });
  it("keeps the raw requested action in the audit but out of the prose evidence", () => {
    expect(narrativeEvidence(source)).not.toHaveProperty("requestedAction");
    expect(narrativeEvidence(source).speech).toEqual(source.speech);
    expect(source.requestedAction).toBe("问价");
  });
  it("keeps observed state and resource changes when narration fails", () => {
    const scene = structuredClone(source);
    scene.speech = [];
    scene.observations[0]!.scene!.speech = null;
    scene.observations[0]!.scene!.outcome = "操作已经结束。";
    scene.observations[0]!.summary = "操作已经结束。\n设备：当前状态：稳定。\n本次操作消耗了2升液体。";
    expect(narrativeFallback(scene)).toBe("操作已经结束。\n设备：当前状态：稳定。\n本次操作消耗了2升液体。");
  });
  it("does not repeat a scene tour after an already published prefix", () => {
    const detailed = structuredClone(source);
    detailed.observations[0]!.scene!.details = [{ label: "店门", description: "木门开着" }];
    detailed.observations[0]!.summary += "\n店门：木门开着\n店门：木门";
    expect(narrativeFallback(detailed, ["木门朝街道敞开。"])) .toBe("店主说：“三枚金币；我还没同意赊账。”");
  });
});
