import { describe, expect, it } from "vitest";
import { decisionPromptV2 } from "../../engine/models/decision-v2";
import { completeParagraphs, renderNarrativeSegment, continueNarrativeSegment, narrativeContinuation, requireDeliveredSpeech, assertSpeechMultiplicity, assertSpeechOrder, narrativeFallback, narrativeRepair, deliveredDialogue, checkNarrativeGrounding, narrativeGroundingChoices, narrativeOutputSchema } from "../narrative/publication";
import { narrativeEvidence, narrativeTask, narrativeDiscourse } from "../narrative/scene";
import { earlierRequestReceipts } from "../narrative/outbox";
import { type ScenePacket } from "../narrative/contracts";
import type { ParticipantDiscourse } from "../../engine/contracts/discourse";
import { directTestProvider, nativeChoice } from "../../engine/testing/direct-provider";

const renderNarrativeParagraph = (text: string, scene: ScenePacket) => renderNarrativeSegment(text, scene).text;

const source: ScenePacket = {
  participantId: "reader", agentId: "traveler", submissionId: "action", submittedAt: null, requestedAction: "问价",
  world: { name: "港口", language: "zh-CN", style: "具体自然" }, playerName: "旅人", location: "码头", memories: [], knownEntities: [],
  boundary: { revision: 1, step: 1, worldTimeSeconds: 2 }, reply: null,
  elapsedUnits: { 小时: 3600, 时辰: 7200 },
  observations: [{ id: "heard", revision: 1, step: 1, worldTimeSeconds: 2, sourceEventIds: ["uttered"], summary: "听到报价",
    scene: { actionKind: "speak", status: "succeeded", actor: "店主", attempt: "", manner: null, outcome: "话语送达。", details: [], speech: { speaker: "店主", utterance: "三枚金币；我还没同意赊账。" } } }],
  speech: [{ id: "speech-ab12", speaker: "店主", utterance: "三枚金币；我还没同意赊账。" }],
};

describe("immutable narrative paragraphs", () => {
  it.each([
    ["旅人[[entity:subject|旅人]]站在石阶旁。", "旅人站在石阶旁。"],
    ["旧木雨棚[[entity:subject|雨棚]]挡住了雨。", "旧木雨棚挡住了雨。"],
    ["[[entity:subject|旅人]]旅人站在石阶旁。", "旅人站在石阶旁。"],
    ["旅人[[entity:subject|旅人]]旅人站在石阶旁。", "旅人站在石阶旁。"],
    ["The guard[[entity:subject|guard]] waits.", "The guard waits."],
    ["The [[entity:subject|guard]]guard waits.", "The guard waits."],
    ["The blackguard[[entity:subject|guard]] waits.", "The blackguardguard waits."],
    ["[[entity:subject|guard]]guardhouse", "guardguardhouse"],
    ["人人都认识[[entity:subject|爸爸]]。", "人人都认识爸爸。"],
    ["旅人旅人，看看[[entity:subject|雨棚]]。", "旅人旅人，看看雨棚。"],
    ["[[entity:subject|爸]]爸", "爸爸"],
  ])("renders an entity annotation once without rewriting unannotated prose: %s", (draft, expected) => {
    const scene = structuredClone(source);
    scene.knownEntities = [{ localEntityId: "subject", name: "眼前的对象", description: "已观察到。" }];
    const result = renderNarrativeSegment(draft, scene);
    expect(result.text).toBe(expected);
    expect(result.mentions).toEqual([{ localEntityId: "subject", surface: draft.match(/\|([^\]]+)\]\]/u)![1] }]);
  });
  it("keeps separate adjacent identities even when their visible labels match", () => {
    const scene = structuredClone(source);
    scene.knownEntities = ["first", "second"].map(localEntityId => ({ localEntityId, name: "旅人", description: "站在路旁。" }));
    expect(renderNarrativeSegment("[[entity:first|旅人]][[entity:second|旅人]]", scene)).toMatchObject({ text: "旅人旅人", mentions: [
      { localEntityId: "first", surface: "旅人" }, { localEntityId: "second", surface: "旅人" },
    ] });
  });
  it("shares complete publication evidence across all paragraph checks in one real gateway request", async () => {
    const scene = structuredClone(source);
    scene.observations[0]!.scene!.manner = "退后一步";
    const provider = directTestProvider(wire => {
      expect(wire.state).toMatchObject({ publicationInstruction: expect.any(String), publicationTask: {
        newReceipts: [{ actor: "店主", manner: "退后一步", currentMethodOrAttention: null, actualResult: "话语送达。" }],
      } });
      expect(Object.keys(wire.questions)).toHaveLength(12);
      for (const question of Object.values(wire.questions)) {
        expect(question.instructions).toMatchObject({ index: expect.any(Number), focus: expect.any(String) });
        expect(question.instructions).not.toHaveProperty("executedNow");
        expect(question.instructions).not.toHaveProperty("executionBoundary");
        expect(question.instructions).not.toHaveProperty("task");
      }
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeChoice(question, "grounded")]));
    });
    const result = await checkNarrativeGrounding(provider.gateway, {
      workloadId: "narrative", batchId: "publication", runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 1 },
    }, scene, ["店主退后一步。", "报价已传到你耳中。"].map(text => renderNarrativeSegment(text, scene)), "decision-deepseek", "decision-deepseek", 1);
    expect(narrativeGroundingChoices(result.answers, 2)).toEqual(["grounded", "grounded"]);
    expect(result.audits[0]!.requestedInference).toEqual(provider.catalog.profile("decision-deepseek").inference);
    expect(provider.transport).toHaveBeenCalledTimes(1);
  });
  const discourse: ParticipantDiscourse = { version: 1, participantId: "reader", agentId: "traveler", asOfRevision: 1,
    arrival: { id: "arrival", text: "码头在眼前。" }, entities: [{ localEntityId: "shopkeeper", label: "店主", description: "木门旁的人",
      firstMentionParagraphId: "first", lastMentionParagraphId: "first", surfaces: ["店主"] }],
    exchanges: [{ id: "first", submissionId: "previous", requested: "拿起木箱再问价", paragraphs: [{ id: "p1", text: "店主在木门旁。", mentions: [] }], speakers: [] }],
    unresolved: [{ submissionId: "previous", requested: "拿起木箱再问价", status: "pending", receipts: ["没有拿起木箱。"] }], hash: "discourse" };
  it("retains published antecedents without passing historic requests as execution evidence", () => {
    const projected = narrativeDiscourse(discourse);
    expect(projected.exchanges[0]).not.toHaveProperty("requested");
    expect(projected.unresolved[0]).not.toHaveProperty("requested");
    expect(projected.exchanges[0]!.paragraphs).toEqual(discourse.exchanges[0]!.paragraphs);
    expect(discourse.exchanges[0]!.requested).toBe("拿起木箱再问价");
    expect(narrativeTask(source).responseTo).toBeNull();
  });
  it("keeps earlier delivered refusals available when a later wait has no new dialogue", async () => {
    const scene = structuredClone(source);
    scene.speech = [];
    scene.observations[0]!.scene = { actionKind: "wait", status: "succeeded", actor: "你", actorLocalId: "self",
      attempt: "安静等候", manner: null, outcome: "等候已过去。", details: [], speech: null };
    const history = structuredClone(discourse);
    history.exchanges[0]!.speakers = [{ localEntityId: "shopkeeper", label: "店主", utterance: "我不能帮你。" }];
    const provider = directTestProvider(wire => {
      expect(wire.state).toMatchObject({ scene: { speech: [] }, publicationTask: { newSpeech: [],
        newReceipts: [{ operation: "wait", actualResult: "等候已过去。" }] },
        discourse: { exchanges: [{ speakers: [{ localEntityId: "shopkeeper", label: "店主", utterance: "我不能帮你。" }] }] } });
      expect(Object.keys(wire.questions)).toHaveLength(12);
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeChoice(question,
        id === "paragraph1_evidence" ? "contradiction" : "grounded")]));
    });
    const result = await checkNarrativeGrounding(provider.gateway, { workloadId: "narrative", batchId: "later-wait",
      runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 2 } }, scene,
      ["店主先前已拒绝帮忙，你又等了一阵。", "店主从来没有回应过你。"].map(text => renderNarrativeSegment(text, scene)), "decision-deepseek", "decision-deepseek", 1, history);
    expect(narrativeGroundingChoices(result.answers, 2)).toEqual(["grounded", "contradiction"]);
    expect(provider.transport).toHaveBeenCalledTimes(1);
  });
  it("renders delivered words of an introduced speaker directly with stable identity", () => {
    const scene = structuredClone(source);
    scene.observations[0]!.scene!.actorLocalId = "shopkeeper";
    scene.speech[0]!.speakerLocalId = "shopkeeper";
    scene.knownEntities = [{ localEntityId: "shopkeeper", name: "店主", description: "木门旁的人" }];
    expect(deliveredDialogue(scene, discourse)).toEqual([{ text: "店主：“三枚金币；我还没同意赊账。”", mentions: [{ localEntityId: "shopkeeper", surface: "店主" }] }]);
    expect(deliveredDialogue(scene, { ...discourse, entities: [] })).toBeNull();
    scene.observations[0]!.scene!.manner = "退后一步";
    expect(deliveredDialogue(scene, discourse)).toBeNull();
    scene.observations[0]!.scene!.manner = null;
    scene.observations[0]!.scene!.details.push({ localEntityId: "shopkeeper", label: "店主", description: "衣服已经湿透" });
    expect(deliveredDialogue(scene, discourse)).toBeNull();
  });
  it("attributes standalone delivered dialogue before publication without certifying its claim", async () => {
    const scene = structuredClone(source);
    scene.speech = [{ id: "speech-ab12", speaker: "门外的声音", speakerLocalId: "voice", utterance: "我要把你的钱拿走。" }];
    scene.knownEntities = [{ localEntityId: "voice", name: "门外的声音", description: "只听见说话声，身份未知。" }];
    scene.observations[0]!.scene!.speech = scene.speech[0]!;
    const rendered = renderNarrativeSegment('  “[[speech-ab12]]”  ', scene);
    expect(rendered.text).toBe("门外的声音：“我要把你的钱拿走。”");
    expect(rendered.mentions).toEqual([{ localEntityId: "voice", surface: "门外的声音" }]);
    const provider = directTestProvider(wire => {
      expect(wire.state).toMatchObject({ paragraphs: ["门外的声音：“我要把你的钱拿走。”"],
        paragraphRendering: [{ parts: [{ kind: "narration", text: "门外的声音：" },
          { kind: "delivered_speech", text: "“我要把你的钱拿走。”", speechId: "speech-ab12", speaker: "门外的声音", speakerLocalId: "voice", utterance: "我要把你的钱拿走。" }] }],
        publicationTask: { newSpeech: [{ speaker: "门外的声音", utterance: "我要把你的钱拿走。" }] } });
      expect(Object.keys(wire.questions)).toHaveLength(6);
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeChoice(question, "grounded")]));
    });
    await checkNarrativeGrounding(provider.gateway, {
      workloadId: "attributed-speech", batchId: "publication", runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 1 },
    }, scene, [rendered], "decision-deepseek", "decision-deepseek", 1);
    expect(provider.transport).toHaveBeenCalledTimes(1);
    expect(scene.observations[0]!.scene!.actionKind).toBe("speak");
    expect(renderNarrativeParagraph("门外的声音回答：[[speech-ab12]]", scene)).toBe("门外的声音回答：“我要把你的钱拿走。”");
  });
  it("keeps an unsupported action outside the delivered quote in the complete publication check", async () => {
    const rendered = renderNarrativeSegment("店主没有离开门框。[[speech-ab12]]", source);
    const provider = directTestProvider(wire => {
      expect(wire.state).toMatchObject({ paragraphs: [rendered.text], paragraphRendering: [{ parts: [
        { kind: "narration", text: "店主没有离开门框。" },
        { kind: "delivered_speech", text: "“三枚金币；我还没同意赊账。”", speechId: "speech-ab12", speaker: "店主" },
      ] }] });
      expect(rendered.parts.map(part => part.text).join("")).toBe(rendered.text);
      expect(Object.keys(wire.questions)).toHaveLength(6);
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeChoice(question,
        id.endsWith("_agency") || id.endsWith("_material") ? "added_content" : "grounded")]));
    });
    const result = await checkNarrativeGrounding(provider.gateway, {
      workloadId: "unsupported-prose", batchId: "publication", runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 1 },
    }, source, [rendered], "decision-deepseek", "decision-deepseek", 1);
    expect(narrativeGroundingChoices(result.answers, 1)).toEqual(["added_content"]);
    expect(provider.transport).toHaveBeenCalledTimes(1);
  });
  it("marks only resolved references, preserving literal quotes and distinct identical speech events", () => {
    const quote = `“${source.speech[0]!.utterance}”`;
    const literal = renderNarrativeSegment(`店主说：${quote}${quote}`, source);
    expect(literal.parts).toEqual([{ kind: "narration", text: literal.text }]);
    expect(literal.text).toBe(`店主说：${quote}${quote}`);
    const duplicate = renderNarrativeSegment(`店主说：${quote} [[speech-ab12]]`, source);
    expect(duplicate.parts).toMatchObject([{ kind: "narration", text: "店主说：" }, { kind: "delivered_speech", speechId: "speech-ab12", text: quote }]);
    expect(duplicate.parts.map(part => part.text).join("")).toBe(duplicate.text);
    const scene = structuredClone(source);
    scene.speech.push({ ...scene.speech[0]!, id: "speech-second", speaker: "旅人" });
    const repeated = renderNarrativeSegment("[[speech-ab12]][[speech-second]]", scene);
    expect(repeated.parts).toMatchObject([{ kind: "delivered_speech", speechId: "speech-ab12" }, { kind: "delivered_speech", speechId: "speech-second" }]);
    expect(repeated.text).toBe(quote + quote);
  });
  it("trims continuation text and reference provenance together without certifying a partial quote", () => {
    const segment = renderNarrativeSegment("旧段落。店主说：[[speech-ab12]] 后文。", source);
    const continuation = continueNarrativeSegment(segment, ["旧段落。"]);
    expect(continuation.text).toBe("店主说：“三枚金币；我还没同意赊账。” 后文。");
    expect(continuation.parts).toMatchObject([{ kind: "narration", text: "店主说：" }, { kind: "delivered_speech", speechId: "speech-ab12" }, { kind: "narration", text: " 后文。" }]);
    expect(continuation.parts.map(part => part.text).join("")).toBe(continuation.text);
    const partial = continueNarrativeSegment(segment, ["旧段落。店主说：“三枚金币；"]);
    expect(partial.text).toBe("我还没同意赊账。” 后文。");
    expect(partial.parts.every(part => part.kind === "narration")).toBe(true);
    expect(partial.parts.map(part => part.text).join("")).toBe(partial.text);
    expect(continueNarrativeSegment(segment, [segment.text])).toEqual({ text: "", parts: [], mentions: [] });
  });
  it("anchors a paraphrased first appearance through the exact delivered voice", () => {
    const scene = structuredClone(source);
    scene.knownEntities = [{ localEntityId: "shopkeeper", name: "戴旧帽子的商人", description: "一位戴旧帽子的人。" }];
    scene.speech[0]!.speakerLocalId = "shopkeeper";
    for (const text of ["门边有位戴旧帽子的人，开口道：[[speech-ab12]]", "门边有位戴旧帽子的人，开口道：“三枚金币；我还没同意赊账。”"]) {
      expect(renderNarrativeSegment(text, scene).mentions).toEqual([
        { localEntityId: "shopkeeper", surface: "“三枚金币；我还没同意赊账。”" },
      ]);
    }
    scene.speech.push({ id: "speech-other", speaker: "另一个声音", speakerLocalId: "other", utterance: scene.speech[0]!.utterance });
    scene.knownEntities.push({ localEntityId: "other", name: "另一个声音", description: "只听见声音" });
    expect(renderNarrativeSegment("有人说：“三枚金币；我还没同意赊账。”", scene).mentions).toEqual([]);
    expect(renderNarrativeSegment("门旁的人说：[[speech-ab12]]", scene).mentions[0]?.localEntityId).toBe("shopkeeper");
  });
  it("keeps literal player dialogue but sends stage directions, recovery and physical scenes to narration", () => {
    const scene = structuredClone(source);
    scene.observations[0]!.scene!.actor = "你";
    scene.requestedAction = scene.observations[0]!.scene!.speech!.utterance;
    scene.speech[0]!.speaker = "你";
    expect(deliveredDialogue(scene, discourse)?.[0]!.text).toBe(`你：“${scene.requestedAction}”`);
    scene.requestedAction = `大声说：${scene.requestedAction}`;
    expect(deliveredDialogue(scene, discourse)).toBeNull();
    scene.requestedAction = scene.observations[0]!.scene!.speech!.utterance;
    scene.observations[0]!.scene!.actionKind = "transfer";
    expect(deliveredDialogue(scene, discourse)).toBeNull();
    scene.observations[0]!.scene!.actionKind = "speak";
    scene.reply = { kind: "recovery", agentId: "traveler", submissionId: "action", requested: "问价", focusLocalEntityId: null, reason: "Interrupted" };
    expect(deliveredDialogue(scene, discourse)).toBeNull();
  });
  it("limits an own-speech packet without treating an absent listener receipt as a reaction", () => {
    const scene = structuredClone(source);
    scene.observations[0]!.scene!.actor = "你";
    expect(narrativeTask(scene)).toMatchObject({ ownSpeechOnly: true });
    scene.observations.push(structuredClone(source.observations[0]!));
    expect(narrativeTask(scene)).toMatchObject({ ownSpeechOnly: false });
    scene.observations = [];
    expect(narrativeTask(scene)).toMatchObject({ ownSpeechOnly: false });
  });
  it("makes recovery's unexecuted request distinct from actual event receipts", () => {
    const scene = structuredClone(source);
    scene.observations = []; scene.speech = [];
    scene.reply = { agentId: scene.agentId, submissionId: "action", kind: "recovery", requested: "等五秒", focusLocalEntityId: null, reason: "Processing failed before the wait executed." };
    expect(narrativeTask(scene)).toMatchObject({ kind: "recovery", newReceipts: [], executionBoundary: {
      newPhysicalEffects: false, elapsedWorldTime: false, newSpeech: false, originalRequest: "等五秒", earlierObservedEvents: [],
    } });
  });
  it("keeps a completed wait distinct from the failed inspection in the same request", () => {
    const scene = structuredClone(source); scene.observations = []; scene.speech = [];
    scene.reply = { agentId: scene.agentId, submissionId: "action", kind: "recovery", requested: "等五秒再看", focusLocalEntityId: null, reason: "The later inspection was interrupted." };
    scene.priorObservedReceipts = [{ ...source.observations[0]!, requestRelation: "participant_step", summary: "等待已经完成。", worldTimeSeconds: 5,
      scene: { ...source.observations[0]!.scene!, actor: "你", actionKind: "wait", speech: null, outcome: "等待已经完成。",
        action: { target: null, tool: null, resource: null, durationSeconds: 5, addressing: "none" } } }];
    expect(narrativeTask(scene)).toMatchObject({ newReceipts: [], newSpeech: [], executionBoundary: {
      originalRequest: "等五秒再看", earlierObservedEvents: [{ operation: "wait", status: "succeeded", worldTimeSeconds: 5,
        action: { durationSeconds: 5 }, actualResult: "等待已经完成。" }],
    } });
  });
  it("freezes ordered same-request receipts without another participant's or controlled subject's evidence", () => {
    const scene = structuredClone(source);
    const early = { ...structuredClone(scene.observations[0]!), id: "reply-early", worldTimeSeconds: 2, sourceEventIds: ["reply-event"] };
    const late = { ...structuredClone(early), id: "later", revision: 2, worldTimeSeconds: 5, sourceEventIds: ["later-event"] };
    const beat = { participantId: scene.participantId, agentId: scene.agentId, submissionId: scene.submissionId,
      source: { ...scene, observations: [late, early, { ...early, id: "same-event-alias" }] } };
    const privateReceipt = { ...early, id: "private", summary: "private evidence", sourceEventIds: ["private-event"] };
    const other = { ...beat, source: { ...scene, observations: [privateReceipt] } };
    const receipts = earlierRequestReceipts([beat, { ...other, participantId: "other" }, { ...other, agentId: "other-subject" },
      { ...other, submissionId: "other-request" }, { ...beat, source: { ...scene, observations: [early] } }],
      scene.participantId, scene.agentId, scene.submissionId);
    expect(receipts.map(receipt => receipt.id)).toEqual(["reply-early", "later"]);
    expect(earlierRequestReceipts([beat], scene.participantId, scene.agentId, null)).toEqual([]);
    expect(earlierRequestReceipts([beat], scene.participantId, scene.agentId, scene.submissionId, 1).map(receipt => receipt.id)).toEqual(["reply-early"]);
    receipts[0]!.summary = "changed copy";
    expect(early.summary).not.toBe("changed copy");
  });
  it("gives an ordinary wait continuation and recovery the same earlier refusal, separate from new speech", () => {
    const scene = structuredClone(source);
    scene.priorObservedReceipts = [{ ...source.observations[0]!, requestRelation: "caused_response", worldTimeSeconds: 2,
      scene: { ...source.observations[0]!.scene!, outcome: "拒绝已送达。", speech: { speaker: "店主", utterance: "我不能帮你。" } } }];
    scene.observations = [{ ...source.observations[0]!, id: "later-wait", worldTimeSeconds: 5, scene: {
      actionKind: "wait", status: "succeeded", actor: "你", attempt: "等候答复", manner: null,
      outcome: "等候已过去。", speech: null, details: [], action: { target: null, tool: null, resource: null, durationSeconds: 5, addressing: "none" } } }];
    scene.speech = [];
    const ordinary = narrativeTask(scene);
    expect(ordinary).toMatchObject({ alreadyObservedForThisRequest: [{ operation: "speak", worldTimeSeconds: 2,
      deliveredSpeech: { speaker: "店主", utterance: "我不能帮你。" } }], newReceipts: [{ operation: "wait", worldTimeSeconds: 5 }], newSpeech: [] });
    scene.reply = { agentId: scene.agentId, submissionId: "action", kind: "recovery", requested: "等候后查看", focusLocalEntityId: null, reason: "The next step was interrupted." };
    const recovery = narrativeTask(scene);
    expect(recovery.alreadyObservedForThisRequest).toEqual(ordinary.alreadyObservedForThisRequest);
    expect(recovery.executionBoundary?.earlierObservedEvents).toEqual(ordinary.alreadyObservedForThisRequest);
  });
  it("retains concrete inspection findings if prose generation cannot finish", () => {
    const scene = structuredClone(source); scene.speech = [];
    scene.observations[0]!.summary = "你查看了眼前的情况。\n水管：接合处有水滴。";
    scene.observations[0]!.scene = { ...scene.observations[0]!.scene!, actionKind: "observe", speech: null,
      outcome: "你查看了眼前的情况。", action: { target: { localEntityId: "pipe", label: "水管" }, tool: null, resource: null, durationSeconds: 1, addressing: "none" } };
    expect(narrativeFallback(scene)).toContain("接合处有水滴");
  });
  it("binds a harmless marker-format variation only to an exact authorized local name", () => {
    const scene = structuredClone(source);
    scene.knownEntities = [{ localEntityId: "pipe", name: "水管", description: "旧水管" }];
    expect(renderNarrativeSegment("[[水管:水管|旧水管]]", scene)).toMatchObject({ text: "旧水管", mentions: [{ localEntityId: "pipe", surface: "旧水管" }] });
    expect(() => renderNarrativeSegment("[[不存在:陌生人|他]]", scene)).toThrow("unknown local entity");
    scene.knownEntities.push({ localEntityId: "other-pipe", name: "水管", description: "另一根水管" });
    expect(() => renderNarrativeSegment("[[水管:水管|旧水管]]", scene)).toThrow("unknown local entity");
  });
  it("anchors a new handover to its current receipt and self-holdings instead of a preceding spoken promise", () => {
    const scene = structuredClone(source);
    scene.requestedAction = "按说好的办";
    scene.speech = [];
    scene.currentHoldings = { coverage: "complete-current-self-holdings", quantities: [{ name: "铜币", unit: "枚", amount: 0 }] };
    Object.assign(scene.observations[0]!.scene!, { actor: "你", actorLocalId: "self", actionKind: "transfer", speech: null, outcome: "交付完成。" });
    scene.observations[0]!.summary = "你尝试付款。\n我向店主转移了3枚铜币。";
    expect(narrativeTask(scene)).toMatchObject({ newReceipts: [{ actor: "你", operation: "transfer", actualResult: "交付完成。\n我向店主转移了3枚铜币。" }], newSpeech: [] });
    expect(narrativeEvidence(scene).currentHoldings).toEqual(scene.currentHoldings);
  });
  it("retains participant-local references while inserting literal speech without interpreting its markup", () => {
    const scene = structuredClone(source);
    scene.knownEntities = [{ localEntityId: "local-person", name: "附近的人", description: "站在木门旁。" }];
    scene.speech[0]!.utterance = "旅人旅人，标记写的是[[entity:untrusted|某人]]，不是我的名字。";
    expect(renderNarrativeSegment("[[entity:local-person|木门旁有个人]]说：[[speech-ab12]]", scene)).toMatchObject({
      text: "木门旁有个人说：“旅人旅人，标记写的是[[entity:untrusted|某人]]，不是我的名字。”",
      mentions: [{ localEntityId: "local-person", surface: "木门旁有个人" }],
    });
    expect(() => renderNarrativeSegment("[[entity:someone-else|他]]", scene)).toThrow();
    expect(() => renderNarrativeSegment("[[entity:local-person|]]", scene)).toThrow();
  });
  it("uses a closed evidence policy for prose, separate from common-sense world adjudication", () => {
    const publication = decisionPromptV2("publication"), world = decisionPromptV2();
    expect(publication.system).toContain("closed record");
    expect(publication.system).toContain("may lie");
    expect(world.system).toContain("contextual common sense");
    expect(publication.version).not.toBe(world.version);
  });
  it("requires each independent factual focus without additional publication requests", () => {
    const answers = Object.fromEntries(["continuity", "material", "agency", "evidence", "speech", "reference"].map(axis => [`paragraph0_${axis}`, { type: "choice", choice: "grounded" }]));
    expect(narrativeGroundingChoices(answers, 1)).toEqual(["grounded"]);
    answers.paragraph0_continuity!.choice = "redundant";
    expect(narrativeGroundingChoices(answers, 1)).toEqual(["redundant"]);
    answers.paragraph0_continuity!.choice = "grounded";
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
  it("losslessly normalizes nested paragraph arrays with the same streamed ordering", () => {
    const value = { paragraphs: ["第一段。", ["第二段。", ["第三段。"]], "第四段。"] };
    const parsed = narrativeOutputSchema.parse(value);
    expect(parsed.paragraphs).toEqual(["第一段。", "第二段。", "第三段。", "第四段。"]);
    expect(completeParagraphs(JSON.stringify(value))).toEqual(parsed.paragraphs);
    expect(completeParagraphs('{"paragraphs":["第一段。",["第二段。","还没')).toEqual(["第一段。", "第二段。"]);
    expect(() => narrativeOutputSchema.parse({ paragraphs: ["文字", [27]] })).toThrow();
    expect(() => narrativeOutputSchema.parse({ paragraphs: ["文字", { text: "不得猜测对象格式" }] })).toThrow();
    expect(narrativeOutputSchema.parse({ paragraphs: [] }).paragraphs).toEqual([]);
  });
  it("inserts the exact delivered utterance and refuses unknown speech references", () => {
    expect(renderNarrativeParagraph("店主回答：[[speech-ab12]]", source)).toBe("店主回答：“三枚金币；我还没同意赊账。”");
    expect(renderNarrativeParagraph('店主回答：“[[speech-ab12]]”', source)).toBe("店主回答：“三枚金币；我还没同意赊账。”");
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
  it("checks literal delivery multiplicity across accepted and recovered paragraphs", () => {
    const quoted = renderNarrativeParagraph("[[speech-ab12]]", source);
    expect(() => assertSpeechMultiplicity(source, [quoted, `店主又说：${quoted}`])).toThrow("already been published");
    const repeated = structuredClone(source); repeated.speech.push({ ...source.speech[0]!, id: "speech-ab13" });
    expect(() => assertSpeechMultiplicity(repeated, [quoted, quoted])).not.toThrow();
    const short = structuredClone(source); short.speech[0]!.utterance = "好";
    expect(() => assertSpeechMultiplicity(short, ["“好”", "状态还好。"])) .not.toThrow();
  });
  it("keeps streamed questions before answers and continues from an immutable prefix", () => {
    const scene = structuredClone(source);
    scene.speech.unshift({ id: "speech-question", speaker: "你", utterance: "多少钱？" });
    expect(narrativeTask(scene).speechOrder).toEqual([
      { reference: "[[speech-question]]", speaker: "你" }, { reference: "[[speech-ab12]]", speaker: "店主" },
    ]);
    expect(() => assertSpeechOrder(scene, ["店主说：“三枚金币；我还没同意赊账。”"])) .toThrow("before the later reply");
    expect(() => assertSpeechOrder(scene, ["店主说：“三枚金币；我还没同意赊账。”你问：“多少钱？”"])) .toThrow("before its later replies");
    expect(() => assertSpeechOrder(scene, ["你问：“多少钱？”"])) .not.toThrow();
    expect(() => assertSpeechOrder(scene, ["你问：“多少钱？”", "店主说：“三枚金币；我还没同意赊账。”"])) .not.toThrow();
    const identical = structuredClone(scene); identical.speech[1]!.utterance = "多少钱？";
    expect(() => assertSpeechOrder(identical, ["你问：“多少钱？”", "他重复了一遍：“多少钱？”"])) .not.toThrow();
    expect(() => assertSpeechOrder({ ...scene, speech: [] }, ["告示上写着“多少钱？”"])) .not.toThrow();
  });
  it("keeps only new continuation text after an exact echo of already published paragraphs", () => {
    expect(narrativeContinuation("价钱已经说清。 “三枚金币。”", ["价钱已经说清。"])) .toBe("“三枚金币。”");
    expect(narrativeContinuation("价钱已经说清。", ["价钱已经说清。"])) .toBe("");
    expect(narrativeContinuation("他又说了一遍价钱。", ["价钱已经说清。"])) .toBe("他又说了一遍价钱。");
  });
  it("keeps factual speech when the prose service is unavailable", () => {
    expect(narrativeFallback(source)).toBe("店主说：“三枚金币；我还没同意赊账。”");
  });
  it("replaces a wholly rejected draft and continues only an actually published prefix", () => {
    const scene = structuredClone(source);
    scene.speech.unshift({ id: "speech-question", speaker: "你", utterance: "多少钱？" });
    expect(narrativeRepair(scene, [], "Unsupported gesture")).toMatchObject({
      mode: "replace_unpublished", immutablePublishedParagraphs: [], unpublishedSpeech: scene.speech,
    });
    expect(narrativeRepair(scene, ["你问：“多少钱？”"], "Unsupported gesture")).toMatchObject({
      mode: "continue_published", immutablePublishedParagraphs: ["你问：“多少钱？”"], unpublishedSpeech: [scene.speech[1]],
    });
  });
  it("accounts for identical delivered lines separately in repair, completion and fallback", () => {
    const scene = structuredClone(source);
    scene.speech.push({ ...scene.speech[0]!, id: "speech-repeat" });
    scene.observations.push({ ...structuredClone(scene.observations[0]!), id: "heard-again" });
    const prefix = ["店主说：“三枚金币；我还没同意赊账。”"];
    expect(narrativeRepair(scene, prefix, null).unpublishedSpeech).toEqual([scene.speech[1]]);
    expect(() => requireDeliveredSpeech(scene, prefix)).toThrow("missing delivered");
    expect(narrativeFallback(scene, prefix)).toBe(prefix[0]);
    const complete = [...prefix, narrativeFallback(scene, prefix)];
    expect(() => requireDeliveredSpeech(scene, complete)).not.toThrow();
    expect(() => assertSpeechMultiplicity(scene, complete)).not.toThrow();
    expect(narrativeFallback(scene, complete)).toBe("");
  });
  it("keeps an executed delivery gesture and introduces the visible speaker before their reply", () => {
    const scene = structuredClone(source);
    const own = { ...structuredClone(scene.observations[0]!), id: "question", summary: "话语送达。" };
    Object.assign(own.scene!, { actor: "你", manner: "抬手招呼", speech: { speaker: "你", utterance: "有人吗？" } });
    scene.observations.unshift(own);
    scene.speech.unshift({ id: "speech-question", ...own.scene!.speech! });
    scene.observations[1]!.scene!.details = [{ localEntityId: "shopkeeper", label: "门边的人", description: "他穿着一件旧外衣。" }];
    const fallback = narrativeFallback(scene);
    expect(fallback).toContain("你抬手招呼：“有人吗？”");
    expect(fallback.indexOf("你注意到门边的人。他穿着一件旧外衣。")).toBeLessThan(fallback.indexOf("店主说"));
    expect(() => assertSpeechOrder(scene, [fallback])).not.toThrow();
    expect(() => requireDeliveredSpeech(scene, [fallback])).not.toThrow();
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
  it("does not turn a spoken payment intention or its memory into an executed transfer", () => {
    const scene = structuredClone(source);
    scene.observations[0]!.summary = "你尝试了取出两枚金币交给店主。你说：请收下。\n随身物资：2枚金币。";
    scene.observations[0]!.scene!.attempt = "取出两枚金币交给店主";
    scene.memories = [{ kind: "observation", description: "尝试将物品交付", executedDescription: "说了交付的意向。" }];
    const projected = narrativeEvidence(scene);
    expect(projected.observations[0]!.summary).toBe("话语送达。\n随身物资：2枚金币。");
    expect(projected.observations[0]!.scene!.attempt).toBeNull();
    expect(projected.memories).toEqual([]);
    scene.reply = { kind: "clarification", agentId: "traveler", submissionId: "action", requested: "刚才付款了吗？", focusLocalEntityId: null, reason: "Explain the recorded progress." };
    expect(narrativeEvidence(scene).memories).toEqual([{ kind: "observation", description: "说了交付的意向。" }]);
    expect(scene.observations[0]!.summary).toContain("尝试了取出");
    expect(scene.memories[0]!.description).toBe("尝试将物品交付");
  });
  it("keeps blocked observation, actual quantities and latest properties as the prose evidence", () => {
    const scene = structuredClone(source);
    Object.assign(scene.observations[0]!.scene!, { actionKind: "observe", status: "blocked", attempt: "查看店内", outcome: "目前无法看清店内。", speech: null });
    scene.observations[0]!.summary = "你尝试了查看店内。\n随身物资：2枚金币。";
    scene.observedProperties = [{ subject: "泵", subjectLocalId: "pump", predicate: "seal", value: { kind: "text", value: "sealed" }, stance: "believes", description: "已封闭", evidenceBoundary: null }];
    const projected = narrativeEvidence(scene);
    expect(projected.observations[0]!.scene).toMatchObject({ actionKind: "observe", status: "blocked", attempt: "查看店内" });
    expect(projected.observations[0]!.summary).toBe("目前无法看清店内。\n随身物资：2枚金币。");
    expect(projected.observedProperties).toEqual(scene.observedProperties);
  });
  it("keeps observed state and resource changes when narration fails", () => {
    const scene = structuredClone(source);
    scene.speech = [];
    scene.observations[0]!.scene!.speech = null;
    scene.observations[0]!.scene!.outcome = "操作已经结束。";
    scene.observations[0]!.summary = "操作已经结束。\n设备：当前状态：稳定。\n本次操作消耗了2升液体。";
    expect(narrativeFallback(scene)).toBe("操作已经结束。\n设备：当前状态：稳定。\n本次操作消耗了2升液体。");
  });
  it("retains the first factual line when an observation omits its generic completion text", () => {
    const scene = structuredClone(source);
    scene.speech = [];
    Object.assign(scene.observations[0]!.scene!, { actionKind: "observe", speech: null, outcome: "你查看了随身物资。" });
    scene.observations[0]!.summary = "随身物资：2枚金币。";
    expect(narrativeFallback(scene)).toBe("你查看了随身物资。\n随身物资：2枚金币。");
  });
  it("retains a new first-line finding ahead of older properties in creation, publication and fallback", async () => {
    const scene = structuredClone(source);
    scene.speech = [];
    Object.assign(scene.observations[0]!.scene!, { actionKind: "observe", status: "succeeded", speech: null,
      outcome: "你查看了眼前的情况。", attempt: "辨认窗外的天色", action: { target: null, tool: null, resource: null, durationSeconds: 10, addressing: "none" } });
    scene.observations[0]!.summary = "阵室：当地正值日间。";
    scene.observedProperties = [{ subject: "阵室", subjectLocalId: "room", predicate: "daylight", value: { kind: "text", value: "day" },
      stance: "believed", description: "日间", evidenceBoundary: scene.boundary },
    { subject: "曾到过的庭院", subjectLocalId: "courtyard", predicate: "daylight", value: { kind: "text", value: "night" },
      stance: "believed", description: "夜间", evidenceBoundary: { revision: 0, step: 0, worldTimeSeconds: 0 } }];
    const resultText = "你查看了眼前的情况。\n阵室：当地正值日间。";
    expect(narrativeEvidence(scene).observations[0]!.summary).toBe(resultText);
    expect(narrativeTask(scene).newReceipts[0]!.actualResult).toBe(resultText);
    expect(narrativeFallback(scene)).toBe(resultText);
    const provider = directTestProvider(wire => {
      expect(wire.state).toMatchObject({ publicationTask: { time: { elapsedUnits: { 小时: 3600, 时辰: 7200 } },
        newReceipts: [{ actualResult: resultText }], propertyHistory: { observations: scene.observedProperties } } });
      expect(Object.keys(wire.questions)).toHaveLength(6);
      return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => [id, nativeChoice(question, "grounded")]));
    });
    await checkNarrativeGrounding(provider.gateway, { workloadId: "narrative", batchId: "current-light",
      runtimeIdentity: { worldHash: `sha256:${"a".repeat(64)}`, revision: 1 } }, scene, [renderNarrativeSegment("窗外已经是日间。", scene)], "decision-deepseek", "decision-deepseek", 1);
    expect(provider.transport).toHaveBeenCalledTimes(1);
  });
  it("renders a factual fallback handover in natural language with its exact amount", () => {
    const scene = structuredClone(source);
    scene.observations[0]!.scene!.speech = null;
    scene.observations[0]!.scene!.outcome = "行动已完成。";
    scene.observations[0]!.summary = "行动已完成。\n我向店主转移了2枚金币。\n店主向我转移了1件物品。";
    expect(narrativeFallback(scene)).toBe("你把2枚金币交给了店主。\n你收到了店主交给你的1件物品。");
  });
  it("retains a phase observed on wait completion when narration falls back", () => {
    const scene = structuredClone(source);
    scene.speech = [];
    Object.assign(scene.observations[0]!.scene!, { actionKind: "wait", status: "succeeded", speech: null,
      outcome: "这段等候已过去151200秒。", attempt: "等待下一次明亮阶段", details: [] });
    scene.observations[0]!.summary = "这段等候已过去151200秒。\n阵室：当地正值日间。";
    const actual = "这段等候已过去151200秒。\n阵室：当地正值日间。";
    expect(narrativeTask(scene).newReceipts[0]!.actualResult).toBe(actual);
    expect(narrativeFallback(scene)).toBe(actual);
    expect(narrativeFallback(scene, ["这段等候已过去151200秒。"])).toBe("阵室：当地正值日间。");
  });
  it("does not publish a failed attempted result when preserving accompanying findings", () => {
    const scene = structuredClone(source);
    scene.speech = [];
    Object.assign(scene.observations[0]!.scene!, { actionKind: "observe", status: "blocked", speech: null,
      outcome: "目前无法看清店内。", attempt: "推门进店查看货架", details: [] });
    scene.observations[0]!.summary = "你尝试了推门进店查看货架。\n店门：仍然紧闭。";
    expect(narrativeFallback(scene)).toBe("目前无法看清店内。\n店门：仍然紧闭。");
    expect(narrativeFallback(scene)).not.toContain("推门");
  });
  it("does not repeat a scene tour after an already published prefix", () => {
    const detailed = structuredClone(source);
    detailed.observations[0]!.scene!.details = [{ label: "店门", description: "木门开着" }];
    detailed.observations[0]!.summary += "\n店门：木门开着\n店门：木门";
    expect(narrativeFallback(detailed, ["木门朝街道敞开。"])) .toBe("店主说：“三枚金币；我还没同意赊账。”");
  });
});
