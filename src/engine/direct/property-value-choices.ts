import type { DecisionAnswerV2, DecisionQuestionV2 } from "../models/decision-v2";
import type { JsonValue } from "../runtime/json";

type ChoiceQuestion = Extract<DecisionQuestionV2, { type: "choice" }>;
type Entry = [string, ChoiceQuestion["criteria"][string]];
const limit = 255;
const inactive = "not_selected";

/** Keep every finite value in one batch without exceeding a choice question's wire limit. */
export function groupPropertyValueChoices(rootId: string, original: DecisionQuestionV2) {
  if (original.type !== "choice" || Object.keys(original.criteria).length <= limit) return undefined;
  const entries = Object.entries(original.criteria);
  const values = entries.filter(([key]) => /^v\d+$/u.test(key));
  const reserved = entries.filter(([key]) => !/^v\d+$/u.test(key));
  if (!reserved.some(([key]) => key === "unchanged") || reserved.some(([key]) => !["unchanged", "new_value"].includes(key))) {
    throw new Error(`Invalid property value choices ${rootId}`);
  }
  const questions: Record<string, ChoiceQuestion> = {};
  const children = new Map<string, Map<string, string>>();
  const buildGroups = (parentId: string, candidates: Entry[], capacity: number): Entry[] => {
    let span = limit - 1;
    while (Math.ceil(candidates.length / span) > capacity) span *= limit - 1;
    const groups: Entry[] = [];
    const descendants = new Map<string, string>();
    children.set(parentId, descendants);
    for (let start = 0; start < candidates.length; start += span) {
      const part = candidates.slice(start, start + span);
      const first = part[0]![0], last = part.at(-1)![0];
      const key = `group_${first}_${last}`, id = `${rootId}_values_${first}_${last}`;
      descendants.set(key, id);
      groups.push([key, { questionId: id, firstValueKey: first, lastValueKey: last,
        meaning: "Select this group only when its descendants contain the exact resulting finite value; answer that path in this same batch." }]);
      questions[id] = { type: "choice", version: original.version, instructions: {
        task: "Apply the root property question's meaning. This conditional question selects one exact existing finite value, never an additional effect. When the parent selects this group, select the matching value or subgroup. Otherwise select not_selected. Resolve all groups together in this batch; unrelated groups must remain not_selected.",
        propertyQuestionId: rootId, activeWhen: { questionId: parentId, choice: key },
      }, criteria: { [inactive]: "The parent did not select this group; this question makes no selection",
        ...Object.fromEntries(part.length <= limit - 1 ? part : buildGroups(id, part, limit - 1)) } };
    }
    return groups;
  };
  const groups = buildGroups(rootId, values, limit - reserved.length);
  questions[rootId] = { ...original, instructions: {
    ...original.instructions as Record<string, JsonValue>,
    valueSelection: "Every concrete value is present in the referenced conditional questions in this same batch. Choose unchanged, new_value, or exactly one group and its complete path. new_value still means no offered finite value expresses the result, not that its group is unselected. All groups outside the selected path must answer not_selected.",
  }, criteria: { ...Object.fromEntries(reserved), ...Object.fromEntries(groups) } };
  const decode = (answers: Record<string, DecisionAnswerV2>): string => {
    const choice = (id: string) => {
      const answer = answers[id];
      if (answer?.type !== "choice" || !Object.hasOwn(questions[id]!.criteria, answer.choice)) throw new Error(`Invalid property value selection ${id}`);
      return answer.choice;
    };
    let id = rootId, selected = choice(id);
    while (children.get(id)?.has(selected)) {
      id = children.get(id)!.get(selected)!;
      selected = choice(id);
      if (selected === inactive) throw new Error(`Selected property value group ${id} has no finite selection`);
    }
    return selected;
  };
  return { questions, decode };
}
