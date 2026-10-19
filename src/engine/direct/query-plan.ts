import type { DecisionAnswerV2, DecisionQuestionV2 } from "../models/decision-v2";
import { contentHash } from "../models/model-audit";
import type { JsonValue } from "../runtime/json";

type Choice = Extract<DecisionQuestionV2, { type: "choice" }>;
export type WorldQueryGroup = {
  kind: "resource"; id: string; applicabilityId: string; amountId: string;
} | {
  kind: "perception"; id: string; deliveryId: string; visibilityId: string;
};
interface CompiledGroup {
  id: string;
  alternatives: Record<string, Record<string, string>>;
}
export const WORLD_QUERY_PLAN_VERSION = "world-query-plan-1";
const queryPolicies = {
  resource: "data.premises supplies the data for BOTH component instructions. Apply the complete authored rule once. Select not_applicable or unresolved for an inactive or uncertain rule. Only an operation satisfying queryPlan.applicable may select apply_<amount>, whose criterion defines its actual amount. apply_none means applicable with no quantity change. All source policies remain binding.",
  perception: "data.premises supplies the data for BOTH component instructions. Evaluate that event and recipient once; select independent delivery and actorVisibility results using queryPlan.dimensions. Sound through a wall can be delivered with the actor hidden; a visible actor can be inaudible. Every pair including uncertainty is available. This grants no name, hidden finding, belief, consent or response. Apply both source policies and all world rules.",
};

function choice(questions: Record<string, DecisionQuestionV2>, id: string): Choice {
  const value = questions[id];
  if (value?.type !== "choice") throw new Error(`World query plan requires a choice question: ${id}`);
  return value;
}

/** Compile only owner-declared relationships. No rule or candidate relevance is inferred. */
export function compileWorldQueryPlan(source: Record<string, DecisionQuestionV2>, groups: readonly WorldQueryGroup[]) {
  const questions = structuredClone(source), compiled: CompiledGroup[] = [];
  const policies: Record<string, string> = {};
  const claimed = new Set<string>(), physicalIds = new Set<string>();
  for (const group of groups) {
    const ids = group.kind === "resource" ? [group.applicabilityId, group.amountId] : [group.deliveryId, group.visibilityId];
    const physicalId = `query_${group.id}`;
    if (physicalIds.has(physicalId) || Object.hasOwn(source, physicalId)) throw new Error(`Duplicate world query identity: ${physicalId}`);
    physicalIds.add(physicalId);
    for (const id of ids) {
      if (claimed.has(id)) throw new Error(`Overlapping world query source: ${id}`);
      claimed.add(id);
    }
    const [left, right] = ids.map(id => choice(questions, id)) as [Choice, Choice];
    const leftData = (left.instructions as Record<string, JsonValue>).data;
    const rightData = (right.instructions as Record<string, JsonValue>).data;
    if (!leftData || !rightData || contentHash(leftData) !== contentHash(rightData)) {
      throw new Error(`World query components must share the same bound premises: ${group.id}`);
    }
    const alternatives: CompiledGroup["alternatives"] = {};
    const criteria: Choice["criteria"] = {};
    if (group.kind === "resource") {
      if (Object.keys(left.criteria).sort().join(",") !== "apply,none,unknown" || !Object.hasOwn(right.criteria, "none")) {
        throw new Error(`Incompatible resource rule query: ${group.id}`);
      }
      alternatives.not_applicable = { [ids[0]!]: "none", [ids[1]!]: "none" };
      criteria.not_applicable = left.criteria.none!;
      alternatives.unresolved = { [ids[0]!]: "unknown", [ids[1]!]: "none" };
      criteria.unresolved = left.criteria.unknown!;
      for (const [amount, meaning] of Object.entries(right.criteria)) {
        const key = `apply_${amount}`;
        alternatives[key] = { [ids[0]!]: "apply", [ids[1]!]: amount };
        criteria[key] = meaning;
      }
    } else {
      if (Object.keys(left.criteria).sort().join(",") !== "delivered,unavailable,unknown" ||
          Object.keys(right.criteria).sort().join(",") !== "hidden,unknown,visible") {
        throw new Error(`Incompatible perception query: ${group.id}`);
      }
      for (const delivery of Object.keys(left.criteria)) {
        for (const visibility of Object.keys(right.criteria)) {
          const key = `${delivery}_${visibility}`;
          alternatives[key] = { [ids[0]!]: delivery, [ids[1]!]: visibility };
          criteria[key] = { delivery, actorVisibility: visibility };
        }
      }
    }
    // Keep the complete original domain when composition exceeds the native choice contract.
    if (Object.keys(criteria).length > 255) continue;
    const sources = [...new Set([...left.sources ?? [], ...right.sources ?? []])];
    const components = [left, right].map(component => {
      const instructions = { ...component.instructions as Record<string, JsonValue> };
      delete instructions.data;
      return { version: component.version, instructions };
    });
    policies[group.kind] = queryPolicies[group.kind];
    questions[physicalId] = { type: "choice", version: WORLD_QUERY_PLAN_VERSION,
      instructions: {
        task: "Apply state.worldQueryPlan.policies[queryPlan.kind]. data.premises is shared by both component instructions.",
        data: { premises: leftData, sourceQuestionIds: ids },
        queryPlan: { version: WORLD_QUERY_PLAN_VERSION, kind: group.kind, components,
          ...(group.kind === "resource" ? { applicable: left.criteria.apply! }
            : { dimensions: { delivery: left.criteria, actorVisibility: right.criteria } }) },
      }, criteria, ...(sources.length ? { sources } : {}) };
    ids.forEach(id => delete questions[id]);
    compiled.push({ id: physicalId, alternatives });
  }
  const identity = { version: WORLD_QUERY_PLAN_VERSION, sourceHash: contentHash(source), groups, policies };
  return {
    questions,
    policies,
    hash: contentHash(identity),
    summary: { version: WORLD_QUERY_PLAN_VERSION, logicalQuestions: Object.keys(source).length,
      physicalQuestions: Object.keys(questions).length, compiledGroups: compiled.length } satisfies Record<string, JsonValue>,
    restore(physical: Record<string, DecisionAnswerV2>): Record<string, DecisionAnswerV2> {
      if (Object.keys(physical).length !== Object.keys(questions).length || Object.keys(questions).some(id => !Object.hasOwn(physical, id))) {
        throw new Error("World query result does not cover its complete dispatch");
      }
      const answers = { ...physical };
      for (const group of compiled) {
        const result = physical[group.id];
        const selected = result?.type === "choice" ? group.alternatives[result.choice] : undefined;
        if (!selected) throw new Error(`Invalid joint world query answer: ${group.id}`);
        delete answers[group.id];
        for (const [id, value] of Object.entries(selected)) {
          // The actual joint distribution remains in the audit, not as invented per-axis confidence.
          answers[id] = { type: "choice", choice: value, probabilities: null, confidence: null };
        }
      }
      return answers;
    },
  };
}
