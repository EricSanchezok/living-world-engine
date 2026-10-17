import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWorldScript } from "../../../script/world-loader";
import { directCreationContext, directTestProvider, nativeAnswer } from "../../testing/direct-provider";
import { DirectWorldAlgorithm } from "../algorithm";
import { SimulationEngine } from "../../runtime/simulation";
import { historyReplayBaseHash } from "../../runtime/history-replay";
import { replaySimulationState, applyWorldDeltaOperation } from "../../runtime/transaction";
import { readDirectState } from "../state";
import { settlePreparedActions } from "../settlement";
import { sourceFor } from "../world";
import type { PolicyBinding } from "../../runtime/execution";
import type { DecisionQuestionV2 } from "../../models/decision-v2";

const original = "08:00，记录人亲见阀座渗水，尚未更换。";
const first = `${original}\n08:15，按本人现场记录，更换一只适配阀；保压未见外漏。具体压力读数未记录。`;
const second = `${first}\n08:30，空载检查已完成；带负载持续试验未做。`;

async function fixture(options: { missingProperty?: boolean; reject?: boolean; mixed?: boolean; quoted?: boolean; current?: boolean;
  oldVisibility?: "visible" | "hidden" | "examined" | "retained"; newVisibility?: "visible" | "hidden" | "examined" | "retained";
  discoverable?: boolean; pendingDebit?: boolean } = {}) {
  let turn = 0;
  const requests: Record<string, unknown>[] = [];
  const created = { description: "把本次检修情况记在页上", applicability: "作者能操作此页", effectDescription: "记录本次检修情况",
    effects: [{ kind: "fact", subject: "target", predicate: "entries", value: first, description: "可读的记录正文" }] };
  const f = directTestProvider(wire => {
    if (!wire.questions) {
      const context = directCreationContext(wire);
      if (context.chosenDirection) return { attempt: context.currentPlayerRequest, utterance: null, manner: null };
      if (context.propertyValueRequest) {
        const request = context.propertyValueRequest as { properties: Array<{ key: string; currentValue: { value: string } }> };
        requests.push(context);
        expect(JSON.stringify(context)).toContain("WITNESSED-REPAIR");
        expect(JSON.stringify(context)).not.toContain("UNOBSERVED-CODE");
        expect(JSON.stringify(context)).not.toContain("OTHER-MIND");
        return { values: Object.fromEntries(request.properties.map(property => [property.key,
          options.reject ? "已记录，保留原文并追加实际结果。" : turn === 0 ? first : turn === 1 ? second : turn === 2 ? "复核更正：压力读数未记录。" : ""])),
        capability: options.mixed ? { description: "标注已处理的页面", applicability: "已获准操作此页", effectDescription: "留下一个可见折角",
          effects: [{ kind: "fact", subject: "target", predicate: "folded-corner", value: true, description: "页角被折起。" }] } : null };
      }
      return created;
    }
    const perspective = Boolean((wire.state as { perspective?: unknown }).perspective);
    return Object.fromEntries(Object.entries(wire.questions).map(([id, question]) => {
      const instructions = question.instructions as { data?: { factId?: string; fact?: { id: string; predicate: string } }; task?: { data?: { factId?: string; fact?: { id: string; predicate: string } } } };
      const data = (instructions.task ?? instructions).data, fact = data?.fact;
      let value: string | number = id === "operation" ? "use" : id === "target" ? "record" : id === "timing" ? "default"
        : id === "interaction" ? "world_action" : id === "expression" ? 0 : "none";
      if (id.endsWith("_outcome")) value = "succeeded";
      if (id.endsWith("_player_authorization")) value = "authorized";
      if (id.endsWith("_duration")) value = options.pendingDebit ? "s60" : "s1";
      if (options.pendingDebit && id.includes("_resource")) value = id.endsWith("_applies") ? "apply" : "n1";
      if (id.includes("visible")) value = (fact?.id ?? data?.factId) === "unobserved-code" ? "hidden" : "visible";
      if (id.includes("visible") && (fact?.id ?? data?.factId) === "work-entries") value = /_value\d+_visible$/u.test(id)
        ? options.newVisibility ?? "visible" : options.oldVisibility ?? "visible";
      if (options.discoverable && question.type === "choice" && ["examined", "retained"].includes(String(value)) && !(value in question.criteria)) value = "visible";
      if (id.includes("actor_visibility")) value = "visible";
      if (id.includes("delivery")) value = "delivered";
      if (id.endsWith("_request_progress") || id.startsWith("progress_")) value = "complete";
      if (id.endsWith("_expression")) value = options.missingProperty && turn === 0 || options.mixed ? "expand" : "existing";
      if (/_fact\d+$/u.test(id)) {
        value = fact?.predicate === "entries" ? "new_value" : "unchanged";
        if (fact?.predicate === "entries" && options.quoted && turn === 1 && question.type === "choice") {
          value = Object.entries(question.criteria).find(([, item]) => (item as { value?: string })?.value === "明确替换的正文")?.[0] ?? "new_value";
        }
        if (fact?.predicate === "entries" && options.current && turn === 2 && question.type === "choice") {
          value = Object.entries(question.criteria).find(([, item]) => (item as { value?: string })?.value === second)?.[0] ?? "new_value";
        }
        if (fact?.predicate === "checked" && question.type === "choice") value = Object.entries(question.criteria)
          .find(([, item]) => (item as { value?: boolean })?.value === true)?.[0] ?? "unchanged";
      }
      if (/^a\d+_value\d+$/u.test(id)) value = options.reject ? "reject" : "accept";
      if (id.includes("capability")) value = perspective && question.type === "choice"
        ? Object.keys(question.criteria).find(key => key.startsWith("capability-")) ?? "none" : "apply";
      if (/_entity\d+_name$/u.test(id)) value = "named";
      if (/_entity\d+$/u.test(id)) value = "visible";
      if (id.includes("goal_status") || id.includes("belief_status")) value = "unchanged";
      return [id, nativeAnswer(question as DecisionQuestionV2, value)];
    }));
  });
  const world = loadWorldScript(path.resolve("test/fixtures/open-world-script"), { seed: 1, modelCatalog: f.catalog });
  const state = world.initialState, actor = state.agents.player!;
  actor.belief.localEntities.record = { id: "record", name: "检修簿", description: "可续写的本地检修簿", status: "observed" };
  actor.bindings.record = { localEntityId: "record", canonicalEntityIds: ["gate"] };
  actor.belief.evidence["own-work"] = { id: "own-work", kind: "observation", description: "WITNESSED-REPAIR：本人更换一只适配阀并保压，未见外漏，未记下数值。", sourceId: "own-work", step: 0 };
  state.agents.keeper!.character.persona.summary = "OTHER-MIND：秘密计划";
  const provenance = state.truth.facts["gate-lock"]!.provenance;
  if (!options.missingProperty) state.truth.facts["work-entries"] = { id: "work-entries", subjectId: "gate", predicate: "entries",
    value: { kind: "text", value: original }, description: "正文内容本身", access: options.discoverable
      ? { kind: "discoverable", condition: "The treated ink can be written normally but its current contents require an actual examination through the reading lens." }
      : { kind: "agents", agentIds: ["player"] }, provenance };
  state.truth.facts["work-checked"] = { id: "work-checked", subjectId: "gate", predicate: "checked", value: { kind: "boolean", value: false },
    description: "本页检查状态", access: { kind: "public" }, provenance };
  state.truth.facts["unobserved-code"] = { id: "unobserved-code", subjectId: "gate", predicate: "secret", value: { kind: "text", value: "UNOBSERVED-CODE" },
    description: "UNOBSERVED-CODE", access: { kind: "agents", agentIds: ["keeper"] }, provenance };
  if (options.pendingDebit) state.truth.timers["before-writing-finishes"] = { id: "before-writing-finishes", description: "An earlier independent boundary",
    createdAtSeconds: 0, dueAtSeconds: 1, status: "scheduled", wakeAgentIds: [], causes: [{ kind: "mechanic", id: "direct-world-clock" }],
    assertions: [{ kind: "elapsed_seconds_compare", operator: "eq", value: 1 }] };
  world.historyBaseHash = historyReplayBaseHash(state);
  await f.registry.capture();
  const algorithm = new DirectWorldAlgorithm(f.gateway, { decision: "decision-jev", creation: "creation-deepseek", fallback: "decision-deepseek", creationEnabled: true });
  const engine = new SimulationEngine(world, algorithm);
  const roster: Record<string, PolicyBinding> = { player: { kind: "external", agentId: "player", participantId: "human" }, keeper: { kind: "idle", agentId: "keeper", reason: "explicit" } };
  await engine.bootstrapAgents();
  const act = async (text: string) => {
    const beforeCalls = f.transport.mock.calls.length;
    const result = await engine.step(roster, { expectedRevision: engine.snapshot.revision, trigger: "participant_action",
      externalActions: [{ agentId: "player", submissionId: `write-${turn}`, rawText: text, goal: text, means: null, targetIds: [] }] });
    const control = readDirectState(result.state.executionState!, result.state);
    expect(control.intents.player!.failure).toBeNull();
    expect(replaySimulationState(result.state)).toEqual(result.state);
    turn++;
    return { ...result, calls: f.transport.mock.calls.length - beforeCalls, control,
      entries: Object.values(result.state.truth.facts).find(fact => fact.subjectId === "gate" && fact.predicate === "entries")! };
  };
  return { ...f, act, requests };
}

describe("action-bound property values through the model HTTP and simulation entry", () => {
  it("writes actual contents, retains an append, permits a correction and does not learn any of those values", async () => {
    const f = await fixture();
    const one = await f.act("把刚才亲见的换阀情况追加到检修簿，并核对本页。");
    expect(one.entries.value).toEqual({ kind: "text", value: first });
    expect(one.entries.description).toContain(first);
    expect(one.committed.observations.find(item => item.observerId === "player")!.summary).toContain(first);
    expect(Object.values(one.state.agents.player!.belief.claims).find(claim => claim.predicate === "entries")!.description).toContain(first);
    expect(JSON.stringify(one.state.agents.player!.belief.evidence)).toContain(JSON.stringify(first).slice(1, -1));
    expect(one.state.truth.facts["work-checked"]!.value).toEqual({ kind: "boolean", value: true });
    const two = await f.act("再追加空载检查已完成、负载试验未做。");
    expect(two.entries.value).toEqual({ kind: "text", value: second });
    const three = await f.act("删除原条目，仅保留更正：压力读数未记录。");
    expect(three.entries.value).toEqual({ kind: "text", value: "复核更正：压力读数未记录。" });
    const four = await f.act("清空这页正文，留下空白。");
    expect(four.entries.value).toEqual({ kind: "text", value: "" });
    expect([one.calls, two.calls, three.calls, four.calls]).toEqual([4, 4, 4, 4]);
    expect(four.control.capabilities).toEqual([]);
    expect(JSON.stringify(f.requests[1])).toContain(JSON.stringify(first).slice(1, -1));
    expect(JSON.stringify(f.requests[2])).toContain(JSON.stringify(second).slice(1, -1));
  });

  it("does not let a learned literal effect overwrite a new value on a second edit", async () => {
    const f = await fixture({ missingProperty: true });
    const one = await f.act("在这页上建立一份检修正文。");
    expect(one.entries.value).toEqual({ kind: "text", value: first });
    expect(one.control.capabilities).toHaveLength(1);
    const two = await f.act("在已有正文后追加空载检查，保留前面的观察。");
    expect(two.entries.value).toEqual({ kind: "text", value: second });
    expect(two.control.capabilities).toEqual(one.control.capabilities);
    expect([one.calls, two.calls]).toEqual([4, 4]);
  });

  it("gives an explicit finite text choice precedence over a learned literal effect", async () => {
    const f = await fixture({ missingProperty: true, quoted: true });
    await f.act("在这页上建立一份检修正文。");
    const two = await f.act("把这页正文替换成“明确替换的正文”。");
    expect(two.entries.value).toEqual({ kind: "text", value: "明确替换的正文" });
    expect(two.calls).toBe(2);
  });

  it("preserves an explicitly selected current text despite a stale learned literal effect", async () => {
    const f = await fixture({ missingProperty: true, current: true });
    await f.act("在这页上建立一份检修正文。");
    await f.act("追加空载检查，保留前面的记录。");
    const three = await f.act("保留当前这条正文不改，只核对本页。");
    expect(three.entries.value).toEqual({ kind: "text", value: second });
    expect(three.calls).toBe(2);
  });

  it("does not expose a hidden replacement through visibility of the old value", async () => {
    const f = await fixture({ oldVisibility: "visible", newVisibility: "hidden" });
    const result = await f.act("把刚才的检修结果写入记录。");
    expect(result.entries.value).toEqual({ kind: "text", value: first });
    expect(result.committed.outcomes[0]!.status).toBe("succeeded");
    expect(Object.values(result.state.agents.player!.belief.claims)).not.toContainEqual(expect.objectContaining({ predicate: "entries" }));
    expect(JSON.stringify(result.committed.observations.filter(item => item.observerId === "player"))).not.toContain(JSON.stringify(first).slice(1, -1));
    expect(JSON.stringify(result.state.agents.player!.belief.evidence)).not.toContain(JSON.stringify(first).slice(1, -1));
  });

  it("does not expose the hidden old value through a rejected candidate's visibility", async () => {
    const f = await fixture({ reject: true, oldVisibility: "hidden", newVisibility: "visible" });
    const result = await f.act("把刚才的检修结果写入记录。");
    expect(result.entries.value).toEqual({ kind: "text", value: original });
    expect(result.committed.outcomes[0]!.status).toBe("blocked");
    expect(Object.values(result.state.agents.player!.belief.claims)).not.toContainEqual(expect.objectContaining({ predicate: "entries" }));
    expect(JSON.stringify(result.committed.observations.filter(item => item.observerId === "player"))).not.toContain(original);
    expect(JSON.stringify(result.state.agents.player!.belief.evidence)).not.toContain(original);
  });

  it("refreshes a discoverable replacement only through a fresh examination, preserving the previous finding on recall", async () => {
    const mutable: Parameters<typeof fixture>[0] = { discoverable: true, oldVisibility: "retained", newVisibility: "examined" };
    const f = await fixture(mutable);
    const examined = await f.act("写入亲见的检修结果，再用阅片镜实际核读墨迹，暂不向旁人报告。");
    const priorFinding = Object.values(examined.state.agents.player!.belief.claims).find(claim => claim.predicate === "entries")!;
    expect(examined.entries.value).toEqual({ kind: "text", value: first });
    expect(priorFinding).toMatchObject({ value: { kind: "text", value: first } });
    expect(examined.committed.observations.find(item => item.observerId === "player")!.summary).toContain(first);
    expect(JSON.stringify(examined.state.agents.keeper!.belief)).not.toContain(JSON.stringify(first).slice(1, -1));
    mutable.newVisibility = "retained";
    const recalled = await f.act("按亲见记录再追加空载检查；只回想上次读到的正文，不用阅片镜重新核读。");
    expect(recalled.entries.value).toEqual({ kind: "text", value: second });
    expect(recalled.entries.access).toEqual(examined.entries.access);
    expect(Object.values(recalled.state.agents.player!.belief.claims).filter(claim => claim.predicate === "entries")).toEqual([priorFinding]);
    expect(JSON.stringify(recalled.committed.observations)).not.toContain(JSON.stringify(second).slice(1, -1));
    expect(JSON.stringify(recalled.state.agents.player!.belief.evidence)).not.toContain(JSON.stringify(second).slice(1, -1));
    expect(JSON.stringify(recalled.state.agents.keeper!.belief)).not.toContain(JSON.stringify(second).slice(1, -1));
    expect([examined.calls, recalled.calls]).toEqual([4, 4]);
  });

  it.each(["visible", "hidden", "examined", "retained"] as const)("binds visibility to the original value after a later settlement debit conflict: %s", async oldVisibility => {
    const discoverable = ["examined", "retained"].includes(oldVisibility);
    const expectedVisible = ["visible", "examined"].includes(oldVisibility);
    const f = await fixture({ pendingDebit: true, discoverable, oldVisibility,
      newVisibility: discoverable ? oldVisibility === "examined" ? "retained" : "examined" : oldVisibility === "visible" ? "hidden" : "visible" });
    const pending = await f.act("花一枚灵石记录检修结果，写满一分钟。");
    expect(pending.state.truth.elapsedSeconds).toBe(1);
    expect(pending.committed.outcomes).toEqual([]);
    expect(pending.control.version).toBe(6);
    const control = JSON.parse(JSON.stringify(pending.control)) as typeof pending.control;
    const frame = control.activities[0]!;
    expect(control.prepared[frame.id]!.propertyVisibility).toHaveLength(1);
    const later = structuredClone(pending.state);
    const stock = Object.values(later.truth.quantities).find(item => item.holderId === frame.actorEntityId && item.definitionId === "spirit-stone")!;
    const source = sourceFor(frame), lawId = later.truth.mechanics.quantities[stock.definitionId]!.consumptionLawIds[0]!;
    applyWorldDeltaOperation(later, { kind: "consume_quantity", definitionId: stock.definitionId, holderId: stock.holderId, amount: stock.amount,
      lawId, ...source, causes: [...source.causes, { kind: "law", id: lawId }] });
    const settled = settlePreparedActions(later, control, [frame]).settlements[0]!;
    expect(settled.outcome.status).toBe("blocked");
    expect(settled.operations).toEqual([]);
    expect(later.truth.facts["work-entries"]!.value).toEqual({ kind: "text", value: original });
    expect(settled.visibleFacts.filter(fact => fact.id === "work-entries").map(fact => fact.value)).toEqual(expectedVisible ? [{ kind: "text", value: original }] : []);
    expect(pending.calls).toBe(4);
  });

  it("rejects a placeholder in the full world decision without committing it", async () => {
    const f = await fixture({ reject: true });
    const result = await f.act("追加刚才的检修结果。");
    expect(result.entries.value).toEqual({ kind: "text", value: original });
    expect(result.committed.outcomes[0]!.status).toBe("blocked");
    expect(result.control.capabilities).toEqual([]);
    expect(result.calls).toBe(4);
  });

  it("shares one creation call for a missing concept and separate concrete property values", async () => {
    const f = await fixture({ mixed: true });
    const result = await f.act("追加实际检修结果并折起页角。");
    expect(result.entries.value).toEqual({ kind: "text", value: first });
    expect(Object.values(result.state.truth.facts)).toContainEqual(expect.objectContaining({ predicate: "folded-corner", value: { kind: "boolean", value: true } }));
    expect(result.control.capabilities).toHaveLength(1);
    expect(JSON.stringify(result.control.capabilities)).not.toContain(JSON.stringify(first).slice(1, -1));
    expect(result.calls).toBe(4);
  });
});
