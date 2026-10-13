import { describe, expect, it } from "vitest";
import { completeParagraphs, renderNarrativeParagraph, requireDeliveredSpeech, narrativeFallback, narrativeEvidence, type ScenePacket } from "../world-narrative";

const source: ScenePacket = {
  participantId: "reader", agentId: "traveler", submissionId: "action", submittedAt: null, requestedAction: "问价",
  world: { name: "港口", language: "zh-CN", style: "具体自然" }, playerName: "旅人", location: "码头", memories: [], knownEntities: [],
  observations: [{ id: "heard", revision: 1, step: 1, worldTimeSeconds: 2, sourceEventIds: ["uttered"], summary: "听到报价",
    scene: { actionKind: "speak", status: "succeeded", actor: "店主", attempt: "", manner: null, outcome: "话语送达。", details: [], speech: { speaker: "店主", utterance: "三枚金币；我还没同意赊账。" } } }],
  speech: [{ id: "speech-ab12", speaker: "店主", utterance: "三枚金币；我还没同意赊账。" }],
};

describe("immutable narrative paragraphs", () => {
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
    expect(() => renderNarrativeParagraph("店主说：“我同意赊账。”", source)).toThrow("differs from delivered");
  });
  it("keeps factual speech when the prose service is unavailable", () => {
    expect(narrativeFallback(source)).toBe("店主说：“三枚金币；我还没同意赊账。”");
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
  it("does not repeat a scene tour after an already published prefix", () => {
    const detailed = structuredClone(source);
    detailed.observations[0]!.scene!.details = [{ label: "店门", description: "木门开着" }];
    detailed.observations[0]!.summary += "\n店门：木门开着\n店门：木门";
    expect(narrativeFallback(detailed, ["木门朝街道敞开。"])) .toBe("店主说：“三枚金币；我还没同意赊账。”");
  });
});
