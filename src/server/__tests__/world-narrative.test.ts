import { describe, expect, it } from "vitest";
import { completeParagraphs, renderNarrativeParagraph, narrativeFallback, type ScenePacket } from "../world-narrative";

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
});
