import { describe, expect, it } from "vitest";
import { projectParticipantDiscourse, type PublishedDiscourseSource } from "../discourse";

function source(): PublishedDiscourseSource {
  const entities = [
    { localEntityId: "stranger-a", name: "灰衣旅人", description: "穿着灰色外衣。" },
    { localEntityId: "stranger-b", name: "蓝衣旅人", description: "穿着蓝色外衣。" },
  ];
  return { participantId: "reader", agentId: "observer", revision: 3,
    arrival: { id: "arrival", text: "你在港口。", entities }, unresolved: [],
    beats: [{ id: "beat-a", submissionId: "shout", requested: "谁在？", entities,
      paragraphs: [{ id: "paragraph-a", text: "一个灰衣旅人转过头，问道：“有事吗？”", mentions: [{ localEntityId: "stranger-a", surface: "一个灰衣旅人" }] }],
      speakers: [{ localEntityId: "stranger-a", label: "灰衣旅人", utterance: "有事吗？" }] }] };
}

describe("shared published discourse", () => {
  it("distinguishes known but unintroduced entities from actually published referents", () => {
    const input = source(), projected = projectParticipantDiscourse(input);
    expect(projected.entities.map(entity => entity.localEntityId)).toEqual(["stranger-a"]);
    expect(projected.entities[0]).toMatchObject({ firstMentionParagraphId: "paragraph-a", surfaces: ["一个灰衣旅人"] });
    expect(projected.exchanges[0]!.speakers).toEqual(input.beats[0]!.speakers);
    expect(projectParticipantDiscourse(JSON.parse(JSON.stringify(input)))).toEqual(projected);
  });
  it("keeps the same identity through name revelation and omits unpublished speech", () => {
    const input = source();
    input.beats.push({ ...input.beats[0]!, id: "beat-b", submissionId: "name", requested: "怎么称呼？",
      entities: [{ localEntityId: "stranger-a", name: "陆远", description: "穿着灰色外衣。" }],
      paragraphs: [{ id: "paragraph-b", text: "灰衣旅人告诉你：“叫我陆远就好。”", mentions: [{ localEntityId: "stranger-a", surface: "灰衣旅人" }] }],
      speakers: [{ localEntityId: "stranger-a", label: "陆远", utterance: "叫我陆远就好。" },
        { localEntityId: "stranger-b", label: "蓝衣旅人", utterance: "尚未公开的回复。" }] });
    const projected = projectParticipantDiscourse(input);
    expect(projected.entities).toHaveLength(1);
    expect(projected.entities[0]).toMatchObject({ label: "陆远", firstMentionParagraphId: "paragraph-a", lastMentionParagraphId: "paragraph-b" });
    expect(projected.exchanges[1]!.speakers).toHaveLength(1);
  });
  it("includes the arrival and coalesces published parts of one player request", () => {
    const input = source(); input.arrival.text = "灰衣旅人站在你身边。";
    input.beats.push({ ...input.beats[0]!, id: "beat-b", paragraphs: [{ id: "paragraph-b", text: "他又看了一眼海面。", mentions: [] }], speakers: [] });
    const projected = projectParticipantDiscourse(input);
    expect(projected.entities[0]!.firstMentionParagraphId).toBe("arrival");
    expect(projected.exchanges).toHaveLength(1); expect(projected.exchanges[0]!.paragraphs).toHaveLength(2);
    expect(projected.arrival.text).toBe(input.arrival.text);
  });
  it("rejects a reference without an authorized local identity", () => {
    const input = source(); input.beats[0]!.paragraphs[0]!.mentions[0]!.localEntityId = "other-minds-secret";
    expect(() => projectParticipantDiscourse(input)).toThrow("participant-local");
  });
});
