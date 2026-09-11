import { expect, it } from "vitest";
import { strictToolControlSchedule, scoreStrictToolControl } from "./deepseek-strict-tools-readiness";

const response = (value: unknown, name = "report_probe", finish = "tool_calls") => ({ choices: [{ finish_reason: finish,
  message: { tool_calls: [{ type: "function", function: { name, arguments: JSON.stringify(value) } }] } }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0, completion_tokens_details: { reasoning_tokens: 0 } } });

it("keeps paired requests identical except for strict and fixes all eight controls before dispatch", () => {
  const schedule = strictToolControlSchedule(); expect(schedule).toHaveLength(8);
  for (const [first, second] of [[schedule[0]!, schedule[1]!], [schedule[2]!, schedule[3]!]]) {
    const baseline = structuredClone(first.body); baseline.tools[0]!.function.strict = true;
    expect(second.body).toEqual(baseline);
  }
  expect(new Set(schedule.map(row => row.id)).size).toBe(8);
});

it("rejects the supplied invalid argument objects independently of HTTP success or finish reason", () => {
  for (const trial of strictToolControlSchedule()) {
    const invalid = JSON.parse(trial.body.messages[1]!.content);
    expect(scoreStrictToolControl(trial.control, response(invalid))).toMatchObject({ completed: true, jsonParsed: true, valid: false });
  }
  const valid = { audience: "agent-A", state: "entity-A" };
  expect(scoreStrictToolControl("field-membership", response(valid))).toMatchObject({ valid: true, usage: { input: 100, output: 20, reasoning: 0 } });
  expect(scoreStrictToolControl("field-membership", response(valid, "other"))).toMatchObject({ completed: false, valid: false });
  expect(scoreStrictToolControl("field-membership", response(valid, "length"))).toMatchObject({ completed: false, valid: false });
  const missingUsage = { ...response(valid), usage: undefined };
  expect(() => scoreStrictToolControl("field-membership", missingUsage)).toThrow();
});
