import { describe, expect, it } from "vitest";
import type { DecisionAnswerV2, DecisionBatchV2, DecisionQuestionV2 } from "../../models/decision-v2";
import { restoreDecisionBatchV2, templateDecisionBatchV2 } from "../../models/decision-question-templates";
import { compileWorldQueryPlan, type WorldQueryGroup } from "../query-plan";

type Choice = Extract<DecisionQuestionV2, { type: "choice" }>;
const answer = (value: string): DecisionAnswerV2 => ({ type: "choice", choice: value, probabilities: { [value]: 1 }, confidence: 1 });
const question = (criteria: Choice["criteria"], rule: string, data = { actionId: "event", recipient: "listener", samePlace: false }): Choice => ({
  type: "choice", version: "source-1", instructions: { task: "Apply all world rules and the referenced policy", rule, data }, criteria,
});
const delivery = { delivered: "Words actually reach this recipient", unavailable: "Words do not reach this recipient", unknown: "Delivery is unresolved" };
const visibility = { visible: "The actor is actually visible", hidden: "The actor is hidden", unknown: "Sight is unresolved" };
const contact: WorldQueryGroup = { kind: "perception", id: "contact", deliveryId: "delivery", visibilityId: "sight" };
const resource: WorldQueryGroup = { kind: "resource", id: "cost", applicabilityId: "applies", amountId: "amount" };
function resourceQuestions(): Record<string, Choice> {
  return {
    applies: question({ apply: "This operation performs the authored rule", none: "This operation does not perform it", unknown: "Applicability is unresolved" }, "eligibility"),
    amount: question({ none: "No actual quantity change", n1: "One unit", n37: "Thirty-seven units" }, "quantity"),
  };
}
function contactQuestions(): Record<string, Choice> {
  return { delivery: question(delivery, "hearing"), sight: question(visibility, "vision") };
}
function choices(answers: Record<string, DecisionAnswerV2>) {
  return Object.fromEntries(Object.entries(answers).map(([id, value]) => [id, value.type === "choice" ? value.choice : value.type]));
}

describe("world query plans preserve effective semantic domains", () => {
  it("retains every independent hearing/sight pair, including uncertainty, without inventing axis confidence", () => {
    const plan = compileWorldQueryPlan(contactQuestions(), [contact]);
    expect(Object.keys((plan.questions.query_contact as Choice).criteria)).toHaveLength(9);
    for (const heard of Object.keys(delivery)) for (const seen of Object.keys(visibility)) {
      const restored = plan.restore({ query_contact: answer(`${heard}_${seen}`) });
      expect(choices(restored)).toEqual({ delivery: heard, sight: seen });
      expect(restored.delivery).toMatchObject({ probabilities: null, confidence: null });
      expect(restored.sight).toMatchObject({ probabilities: null, confidence: null });
    }
  });
  it("retains every actual resource effect and uncertainty while ignoring only inactive amounts", () => {
    const source = resourceQuestions(), plan = compileWorldQueryPlan(source, [resource]);
    const criteria = (plan.questions.query_cost as Choice).criteria;
    expect(Object.keys(criteria).sort()).toEqual(["apply_n1", "apply_n37", "apply_none", "not_applicable", "unresolved"]);
    for (const eligibility of Object.keys(source.applies!.criteria)) for (const amount of Object.keys(source.amount!.criteria)) {
      const physical = eligibility === "apply" ? `apply_${amount}` : eligibility === "none" ? "not_applicable" : "unresolved";
      const actual = choices(plan.restore({ query_cost: answer(physical) }));
      expect(actual).toEqual({ applies: eligibility, amount: eligibility === "apply" ? amount : "none" });
      const effect = (applies: string, quantity: string) => applies === "apply" && quantity !== "none" ? Number(quantity.slice(1)) : 0;
      expect(effect(actual.applies!, actual.amount!)).toBe(effect(eligibility, amount));
    }
    expect(criteria.apply_n37).toEqual(source.amount!.criteria.n37);
    expect(plan.questions.query_cost!.instructions).toMatchObject({ queryPlan: { applicable: source.applies!.criteria.apply } });
  });
  it("preserves ungrouped decisions, complete source policies and provenance without mutating the input", () => {
    const source: Record<string, Choice> = { ...contactQuestions(), other: question({ novel: "Open action needing expansion", unknown: "Insufficient evidence" }, "open") };
    source.delivery!.sources = ["law:wall", "event:one"];
    source.sight!.sources = ["law:light", "event:one"];
    const before = structuredClone(source), plan = compileWorldQueryPlan(source, [contact]);
    expect(source).toEqual(before);
    expect(plan.questions.other).toEqual(source.other);
    expect(plan.questions.query_contact!.sources).toEqual(["law:wall", "event:one", "law:light"]);
    const instructions = plan.questions.query_contact!.instructions as Record<string, unknown>;
    expect(instructions.data).toEqual({ premises: { actionId: "event", recipient: "listener", samePlace: false }, sourceQuestionIds: ["delivery", "sight"] });
    expect(instructions.queryPlan).toMatchObject({ components: [
      { version: "source-1", instructions: { rule: "hearing" } },
      { version: "source-1", instructions: { rule: "vision" } },
    ] });
    expect(instructions.queryPlan).toMatchObject({ dimensions: { delivery, actorVisibility: visibility } });
    const other = answer("novel");
    expect(plan.restore({ query_contact: answer("delivered_hidden"), other }).other).toBe(other);
    (plan.questions.other as Choice).criteria.novel = "changed detached output";
    expect(source).toEqual(before);
  });
  it("shares identical physical question templates while keeping each recipient's complete premises", () => {
    const source: Record<string, Choice> = {}, groups: WorldQueryGroup[] = [];
    for (let i = 0; i < 12; i++) {
      const data = { actionId: "event", recipient: `listener-${i}`, samePlace: i % 2 === 0 };
      source[`d${i}`] = question(delivery, "hearing", data); source[`s${i}`] = question(visibility, "vision", data);
      groups.push({ kind: "perception", id: `contact${i}`, deliveryId: `d${i}`, visibilityId: `s${i}` });
    }
    const plan = compileWorldQueryPlan(source, groups);
    const batch: DecisionBatchV2 = { version: 2, view: { kind: "world", projectionHash: "fixture" }, dependencies: {}, state: {}, questions: plan.questions };
    const wire = templateDecisionBatchV2(batch);
    expect(Object.keys(wire.questionTemplates)).toHaveLength(1);
    expect(wire.questions).toHaveLength(12);
    expect(restoreDecisionBatchV2(wire)).toEqual(batch);
  });
  it("retains the complete original resource questions when the fused domain exceeds 255 choices", () => {
    const source = resourceQuestions();
    source.amount!.criteria = { none: "None", ...Object.fromEntries(Array.from({ length: 254 }, (_, i) => [`n${i + 1}`, `${i + 1} units`])) };
    const plan = compileWorldQueryPlan(source, [resource]);
    expect(plan.questions).toEqual(source);
    expect(plan.summary).toMatchObject({ logicalQuestions: 2, physicalQuestions: 2, compiledGroups: 0 });
    expect(choices(plan.restore({ applies: answer("apply"), amount: answer("n254") }))).toEqual({ applies: "apply", amount: "n254" });
  });
  it("rejects incomplete, extra and invalid physical results instead of defaulting a semantic answer", () => {
    const plan = compileWorldQueryPlan(contactQuestions(), [contact]);
    expect(() => plan.restore({})).toThrow("complete dispatch");
    expect(() => plan.restore({ query_contact: answer("delivered_hidden"), extra: answer("visible") })).toThrow("complete dispatch");
    expect(() => plan.restore({ query_contact: answer("delivered") })).toThrow("Invalid joint");
    expect(() => plan.restore({ query_contact: { type: "noul", noul: 1 } })).toThrow("Invalid joint");
  });
  it("rejects ambiguous group ownership, incompatible domains and non-choice questions before dispatch", () => {
    const source = contactQuestions();
    expect(() => compileWorldQueryPlan(source, [contact, contact])).toThrow("Duplicate");
    expect(() => compileWorldQueryPlan(source, [contact, { ...contact, id: "overlap" }])).toThrow("Overlapping");
    expect(() => compileWorldQueryPlan({ ...source, query_contact: source.sight! }, [contact])).toThrow("Duplicate");
    expect(() => compileWorldQueryPlan({ delivery: source.delivery! }, [contact])).toThrow("requires a choice");
    expect(() => compileWorldQueryPlan({ ...source, sight: { type: "noul", version: "1", instructions: "unbounded" } }, [contact])).toThrow("requires a choice");
    expect(() => compileWorldQueryPlan({ ...source, sight: question({ ...visibility, named: "Recognized name" }, "vision") }, [contact])).toThrow("Incompatible");
  });
  it("rejects cross-event and cross-recipient sharing and invalidates the plan when source meanings change", () => {
    for (const data of [{ actionId: "other", recipient: "listener", samePlace: false }, { actionId: "event", recipient: "other", samePlace: false }]) {
      expect(() => compileWorldQueryPlan({ ...contactQuestions(), sight: question(visibility, "vision", data) }, [contact])).toThrow("same bound premises");
    }
    const source = contactQuestions(), first = compileWorldQueryPlan(source, [contact]);
    source.sight!.criteria.visible = "Different authored access condition";
    expect(compileWorldQueryPlan(source, [contact]).hash).not.toBe(first.hash);
  });
});
